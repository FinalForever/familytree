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

export function loadUsers(): UserRecord[] {
  try {
    const file = usersFile();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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

export async function verifyUserPassword(username: string, password: string): Promise<boolean> {
  // 超长口令直接判失败，不进 scrypt（合法口令在注册/改密时已被上限拦住）
  if (!password || password.length > MAX_PASSWORD_LENGTH) return false;
  const user = findUser(username);
  if (!user) {
    // 账号不存在时也做一次等价计算，避免用响应时间泄露账号是否已注册
    await scryptAsync(password, '0'.repeat(32), 64);
    return false;
  }
  const candidate = await scryptAsync(password, user.salt, 64);
  const stored = Buffer.from(user.hash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
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
