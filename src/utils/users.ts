import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// 账号存储（仅服务端使用）：JSON 文件保存账号名 + scrypt 口令哈希，绝不存明文口令。
// 文件位置：USERS_FILE 环境变量，或 DATA_DIR/users.json（Docker 里 DATA_DIR=/app/data，独立可写卷）。
export interface UserRecord {
  username: string;
  salt: string;
  hash: string;
  createdAt: number;
}

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

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function findUser(username: string): UserRecord | undefined {
  const normalized = normalizeUsername(username);
  return loadUsers().find((u) => u.username === normalized);
}

export function createUser(username: string, password: string): UserRecord {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const record: UserRecord = {
    username: normalizeUsername(username),
    salt,
    hash,
    createdAt: Date.now(),
  };
  const users = loadUsers();
  users.push(record);
  saveUsers(users);
  return record;
}

export function verifyUserPassword(username: string, password: string): boolean {
  const user = findUser(username);
  if (!user) {
    // 账号不存在时也做一次等价计算，避免用响应时间泄露账号是否已注册
    crypto.scryptSync(password, '0'.repeat(32), 64);
    return false;
  }
  const candidate = crypto.scryptSync(password, user.salt, 64);
  const stored = Buffer.from(user.hash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

export function isRegistrationOpen(): boolean {
  // 后台设置优先（即时生效），未设置时回退到环境变量 REGISTRATION_OPEN
  const settings = loadSettings();
  if (typeof settings.registrationOpen === 'boolean') return settings.registrationOpen;
  return process.env.REGISTRATION_OPEN !== 'false';
}

export function setRegistrationOpen(open: boolean): void {
  const settings = loadSettings();
  settings.registrationOpen = open;
  saveSettings(settings);
}

export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9_一-龥]{2,32}$/.test(username.trim());
}

export function deleteUser(username: string): boolean {
  const normalized = normalizeUsername(username);
  const users = loadUsers();
  const next = users.filter((u) => u.username !== normalized);
  if (next.length === users.length) return false;
  saveUsers(next);
  return true;
}

export function setUserPassword(username: string, password: string): boolean {
  const normalized = normalizeUsername(username);
  const users = loadUsers();
  const user = users.find((u) => u.username === normalized);
  if (!user) return false;
  user.salt = crypto.randomBytes(16).toString('hex');
  user.hash = crypto.scryptSync(password, user.salt, 64).toString('hex');
  saveUsers(users);
  return true;
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
