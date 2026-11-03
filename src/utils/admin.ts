import crypto from 'crypto';
import { getAdminTokenSubject, sweepMap } from './auth';

// 管理后台（仅服务端）：管理员口令只存环境变量 ADMIN_PASSWORD；
// 管理员会话用独立 Cookie ft_admin，令牌主体固定为下面的标识，与普通账号会话区分。
export const ADMIN_SUBJECT = 'admin:panel';
export const ADMIN_COOKIE = 'ft_admin';

export function isAdminConfigured(): boolean {
  // 全空白不算配置了口令
  return Boolean(process.env.ADMIN_PASSWORD?.trim());
}

export function checkAdminPassword(input: string): boolean {
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected || !input) return false;
  const a = Buffer.from(input, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function isAdminRequest(request: Request): boolean {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=([^;]+)`));
  if (!m) return false;
  return getAdminTokenSubject(decodeURIComponent(m[1])) === ADMIN_SUBJECT;
}

// —— 管理员登录防爆破（内存实现，单实例部署足够；计数按来源 IP，容器重启清零）——
// 两道闸：①任意尝试限流（默认 5 次/10 分钟）；②失败锁定（默认 10 分钟内失败 5 次 → 锁定该来源 30 分钟）。
// 阈值可用环境变量 ADMIN_MAX_ATTEMPTS / ADMIN_MAX_FAILURES 覆盖。
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 30 * 60 * 1000;
const adminAttempts = new Map<string, number[]>();
const adminFailures = new Map<string, number[]>();
const adminLockedUntil = new Map<string, number>();

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function recent(map: Map<string, number[]>, key: string, windowMs: number): number[] {
  const now = Date.now();
  const list = (map.get(key) || []).filter((t) => now - t < windowMs);
  map.set(key, list);
  return list;
}

export function adminRateLimited(key: string): boolean {
  return recent(adminAttempts, key, ATTEMPT_WINDOW_MS).length >= envInt('ADMIN_MAX_ATTEMPTS', 5);
}

export function recordAdminAttempt(key: string): void {
  recent(adminAttempts, key, ATTEMPT_WINDOW_MS).push(Date.now());
  sweepMap(adminAttempts, ATTEMPT_WINDOW_MS);
}

export function adminLockedOut(key: string): boolean {
  const until = adminLockedUntil.get(key) || 0;
  if (Date.now() < until) return true;
  if (until) adminLockedUntil.delete(key);
  return false;
}

export function recordAdminFailure(key: string): void {
  const list = recent(adminFailures, key, FAIL_WINDOW_MS);
  list.push(Date.now());
  sweepMap(adminFailures, FAIL_WINDOW_MS);
  console.warn(`管理员登录失败：来源 ${key}，近 10 分钟失败 ${list.length} 次`);
  if (list.length >= envInt('ADMIN_MAX_FAILURES', 5)) {
    adminLockedUntil.set(key, Date.now() + LOCK_MS);
    // 锁定到期表也要有界：写入时顺带清掉已过期的锁，避免只进不出
    if (adminLockedUntil.size > 1000) {
      const now = Date.now();
      for (const [k, until] of adminLockedUntil) if (until <= now) adminLockedUntil.delete(k);
    }
    adminFailures.set(key, []);
    console.warn(`管理员登录失败过多：来源 ${key} 已锁定 30 分钟`);
  }
}

export function clearAdminFailures(key: string): void {
  adminFailures.delete(key);
}
