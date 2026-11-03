import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'node:util';

// 口令哈希用异步 scrypt：同步版会整段堵住事件循环，登录高峰或被刷时拖垮全站
const scryptAsync = promisify(crypto.scrypt) as unknown as (
  password: string,
  salt: string,
  keylen: number
) => Promise<Buffer>;

// 账号存储（仅服务端使用）：JSON 文件保存账号名 + scrypt 口令哈希，绝不存明文口令。
// 文件位置：USERS_FILE 环境变量，或 DATA_DIR/users.json（Docker 里 DATA_DIR=/app/data，独立可写卷）。
export interface UserRecord {
  // 账号世代 id：创建时随机生成、永不复用。令牌绑定它之后，删号再重建同名账号也不会让旧令牌复活
  // （只绑用户名+版本号时，新账号版本从 0 开始会与旧令牌重新匹配）。老记录无此字段，加载时自动补齐
  id?: string;
  username: string;
  salt: string;
  hash: string;
  createdAt: number;
  // 会话令牌版本：签发令牌时写入载荷，改密时递增，此前签发的令牌随即失效。老记录无此字段按 0 处理
  tokenVersion?: number;
}

// 口令长度上限：scrypt 对超长输入同样要整段处理，无上限等于把拒绝服务面留给访客
export const MAX_PASSWORD_LENGTH = 128;

function usersFile(): string {
  if (process.env.USERS_FILE) return process.env.USERS_FILE;
  const dir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dir, 'users.json');
}

// 加载账号表，三态严格区分（数据保护优先）：
//   文件不存在 → 空表（首次运行）；
//   损坏 / 不是数组 / 读取失败 → 抛错。绝不能把损坏当空表：后续注册、建号会把
//   「空表+新账号」整个写回去，把原账号文件冲掉。抛错后各入口统一回 5xx、拒绝写盘，
//   等人工修复文件；文件恢复后下一次加载即自愈，不必重启。
export function loadUsers(): UserRecord[] {
  const file = usersFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    console.error('账号文件读取失败，拒绝一切账号读写（保护原文件不被覆盖）:', error);
    throw new Error('账号存储读取失败');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('账号文件 JSON 损坏，拒绝一切账号读写（保护原文件不被覆盖），请修复 users.json');
    throw new Error('账号存储已损坏');
  }
  if (!Array.isArray(parsed)) {
    console.error('账号文件格式异常（不是数组），拒绝一切账号读写（保护原文件不被覆盖）');
    throw new Error('账号存储已损坏');
  }
  const seenNames = new Set<string>();
  for (const u of parsed) {
    if (!isValidUserRecord(u)) {
      console.error('账号文件中有结构不完整的记录，拒绝一切账号读写（保护原文件不被覆盖），请修复 users.json');
      throw new Error('账号存储已损坏');
    }
    // 规范化后唯一：两条归一同名的记录，查找永远只命中第一条，另一条等于被埋掉，
    // 写操作还会把这局面原样落盘固化——按损坏处理，不自动改名、不改写原文件
    const key = normalizeUsername(u.username);
    if (seenNames.has(key)) {
      console.error('账号文件中有规范化后重名的账号，拒绝一切账号读写（保护原文件不被覆盖），请修复 users.json');
      throw new Error('账号存储已损坏');
    }
    seenNames.add(key);
  }
  ensureUserIds(parsed);
  return parsed;
}

// 单条记录的结构校验：只验顶层是数组还不够——字段缺失的记录混在表里，轻则该账号永远
// 登不上、注册等写操作还会把坏数据原样落盘，重则记录是 null 时读到就抛错。任何一条
// 不合格都按文件损坏处理。只查必填字段与类型，不拒绝未知的新字段（向后兼容）。
// 用户名还须符合注册规则且已是规范形态：查找与查重都按 normalizeUsername（去空格+小写）
// 比对，文件里若躺着「Alice」，它既登不上、又会放行再注册一个「alice」把局面固化。
// 数值须有限：JSON 的 1e400 会被解析成 Infinity（typeof 仍是 number），签发令牌序列化时
// 又变回 null——校验页面按 0 比对永远对不上，表现为登录成功却进不了首页。
function isValidUserRecord(u: unknown): u is UserRecord {
  if (!u || typeof u !== 'object') return false;
  const r = u as Record<string, unknown>;
  return (
    typeof r.username === 'string' &&
    isValidUsername(r.username) &&
    r.username === normalizeUsername(r.username) &&
    typeof r.salt === 'string' &&
    r.salt.length > 0 &&
    typeof r.hash === 'string' &&
    r.hash.length > 0 &&
    typeof r.createdAt === 'number' &&
    Number.isFinite(r.createdAt) &&
    (r.id === undefined || (typeof r.id === 'string' && r.id.length > 0)) &&
    (r.tokenVersion === undefined ||
      (typeof r.tokenVersion === 'number' && Number.isSafeInteger(r.tokenVersion) && r.tokenVersion >= 0))
  );
}

// 老账号记录补 id：每次加载都检查，不能用进程级一次性标志——若进程跑起来后恢复了一份
// 旧格式备份，已「迁移过」的标志会让新记录永远补不上 id，签发的令牌没 uid、首页必然拒绝
// （表现为登录 200 却进不去）。加载全程同步、无 await，两次加载不会交错生成两批 id；
// 扫描只是对小数组做一次 filter，成本可忽略。写回失败直接抛错（由 loadUsers 的调用方回
// 5xx）：若带着内存里临时生成的 id 继续签发 Cookie，后续请求重新加载时生成的又是另一批
// id，会话永远验不过——宁可明确报错，不发假会话。
function ensureUserIds(users: UserRecord[]): void {
  const missing = users.filter((u) => !u.id);
  if (missing.length === 0) return;
  for (const u of missing) u.id = crypto.randomUUID();
  try {
    saveUsers(users);
  } catch (error) {
    console.error('账号 id 迁移写回失败，拒绝本次账号读写:', error);
    throw new Error('账号存储写入失败');
  }
}

function saveUsers(users: UserRecord[]): void {
  const file = usersFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 账号文件的「读-改-写」必须串行：口令哈希是异步的，等待期间并发请求会拿着旧列表互相覆盖
// （改密存回旧表冲掉刚注册的账号、同名并发注册双双成功）。这把进程内互斥锁把查重与写入
// 放进同一临界区；多进程部署时单进程锁不够、需换支持事务的存储——当前单实例部署与文件存储模型一致。
let usersWriteChain: Promise<unknown> = Promise.resolve();
function withUsersLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = usersWriteChain.then(fn, fn);
  usersWriteChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function findUser(username: string): UserRecord | undefined {
  const normalized = normalizeUsername(username);
  return loadUsers().find((u) => u.username === normalized);
}

export async function createUser(username: string, password: string): Promise<UserRecord | null> {
  // 查重与写入在同一把锁内：账号已存在返回 null（调用方回 409）
  return withUsersLock(async () => {
    const normalized = normalizeUsername(username);
    const users = loadUsers();
    if (users.some((u) => u.username === normalized)) return null;
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scryptAsync(password, salt, 64)).toString('hex');
    const record: UserRecord = {
      id: crypto.randomUUID(),
      username: normalized,
      salt,
      hash,
      createdAt: Date.now(),
      tokenVersion: 0,
    };
    users.push(record);
    saveUsers(users);
    return record;
  });
}

// 验证成功返回「实际验证过的那份账号记录」（含哈希与 tokenVersion 快照），失败返回 null。
// 登录路由签发前会拿快照与当前记录比对：验证期间管理员改密/删号，哈希或版本一变就拒绝签发，
// 避免旧密码蹭到改密后的新版本令牌。
export async function verifyUserPassword(username: string, password: string): Promise<UserRecord | null> {
  // 超长口令直接判失败，不进 scrypt（合法口令在注册/改密时已被上限拦住）
  if (!password || password.length > MAX_PASSWORD_LENGTH) return null;
  const user = findUser(username);
  if (!user) {
    // 账号不存在时也做一次等价计算，避免用响应时间泄露账号是否已注册
    await scryptAsync(password, '0'.repeat(32), 64);
    return null;
  }
  const candidate = await scryptAsync(password, user.salt, 64);
  const stored = Buffer.from(user.hash, 'hex');
  const ok = candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
  return ok ? user : null;
}

export function isRegistrationOpen(): boolean {
  // 环境变量明确设为 false 时强制关闭、压过后台设置——部署方收口的开关不能被面板翻开；
  // 其余情况后台设置优先（即时生效），再未设置时默认开放
  if (process.env.REGISTRATION_OPEN === 'false') return false;
  const settings = loadSettings();
  if (typeof settings.registrationOpen === 'boolean') return settings.registrationOpen;
  return true;
}

export function setRegistrationOpen(open: boolean): void {
  const settings = loadSettings();
  settings.registrationOpen = open;
  saveSettings(settings);
}

export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9_一-龥]{2,32}$/.test(username.trim());
}

export async function deleteUser(username: string): Promise<boolean> {
  return withUsersLock(async () => {
    const normalized = normalizeUsername(username);
    const users = loadUsers();
    const next = users.filter((u) => u.username !== normalized);
    if (next.length === users.length) return false;
    saveUsers(next);
    return true;
  });
}

export async function setUserPassword(username: string, password: string): Promise<boolean> {
  return withUsersLock(async () => {
    const normalized = normalizeUsername(username);
    const users = loadUsers();
    const user = users.find((u) => u.username === normalized);
    if (!user) return false;
    user.salt = crypto.randomBytes(16).toString('hex');
    user.hash = (await scryptAsync(password, user.salt, 64)).toString('hex');
    // 改密即让此前签发的所有会话令牌失效
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    saveUsers(users);
    return true;
  });
}

// 站点设置（存 DATA_DIR/settings.json，后台可改、即时生效）
interface SiteSettings {
  registrationOpen?: boolean;
  familyName?: string;
}

function settingsFile(): string {
  const dir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dir, 'settings.json');
}

export function loadSettings(): SiteSettings {
  try {
    const file = settingsFile();
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveSettings(settings: SiteSettings): void {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 家族姓氏：后台设置优先（即时生效），其次构建时环境变量 NEXT_PUBLIC_FAMILY_NAME，默认「白」
export function getFamilyName(): string {
  const settings = loadSettings();
  if (settings.familyName && settings.familyName.trim()) return settings.familyName.trim();
  return process.env.NEXT_PUBLIC_FAMILY_NAME || '白';
}

export function setFamilyName(name: string): boolean {
  const trimmed = name.trim();
  if (!/^[一-龥A-Za-z]{1,4}$/.test(trimmed)) return false;
  const settings = loadSettings();
  settings.familyName = trimmed;
  saveSettings(settings);
  return true;
}
