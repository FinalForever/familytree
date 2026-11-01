import crypto from 'crypto';

// 服务端会话令牌工具（仅在服务端使用）：HMAC-SHA256 签名，防伪造。
// 密钥与口令均只从服务端环境变量读取，绝不下发到客户端。

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function getSecret(): string {
  return process.env.AUTH_SECRET || '';
}

export function isAuthConfigured(): boolean {
  // 邮箱账号登录只需要签名密钥；FAMILY_PASSWORD 是旧口令登录的遗留，不再必需
  return Boolean(getSecret());
}

export function checkPassword(input: string): boolean {
  const expected = process.env.FAMILY_PASSWORD || '';
  if (!expected || !input) return false;
  const a = Buffer.from(input, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function issueToken(subject = 'family'): string {
  const payload = { sub: subject, exp: Date.now() + TOKEN_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token: string | null | undefined): boolean {
  if (!token || !getSecret()) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && Date.now() < payload.exp;
  } catch {
    return false;
  }
}

export function extractToken(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)ft_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// 登录限流（内存滑动窗口）：同一来源 10 分钟内最多 10 次尝试
const attempts = new Map<string, number[]>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function recentAttempts(key: string): number[] {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, list);
  return list;
}

export function loginRateLimited(key: string): boolean {
  return recentAttempts(key).length >= MAX_ATTEMPTS;
}

export function recordLoginAttempt(key: string): void {
  recentAttempts(key).push(Date.now());
}

export function clientKey(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0].trim() : '') || 'local';
}

// 验签并取出令牌主体（账号名或管理员标识），无效返回 null
export function getTokenSubject(token: string | null | undefined): string | null {
  if (!token || !getSecret()) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || Date.now() >= payload.exp) return null;
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

// —— 前台登录失败锁定：10 分钟内失败 5 次 → 锁定该来源 30 分钟（与后台同款规则）——
const LOGIN_FAIL_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCK_MS = 30 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const loginFailures = new Map<string, number[]>();
const loginLockedUntil = new Map<string, number>();

export function loginLockedOut(key: string): boolean {
  const until = loginLockedUntil.get(key) || 0;
  if (Date.now() < until) return true;
  if (until) loginLockedUntil.delete(key);
  return false;
}

export function recordLoginFailure(key: string): void {
  const now = Date.now();
  const list = (loginFailures.get(key) || []).filter((t) => now - t < LOGIN_FAIL_WINDOW_MS);
  list.push(now);
  loginFailures.set(key, list);
  console.warn(`前台登录失败：来源 ${key}，近 10 分钟失败 ${list.length} 次`);
  if (list.length >= LOGIN_MAX_FAILURES) {
    loginLockedUntil.set(key, now + LOGIN_LOCK_MS);
    loginFailures.set(key, []);
    console.warn(`前台登录失败过多：来源 ${key} 已锁定 30 分钟`);
  }
}

export function clearLoginFailures(key: string): void {
  loginFailures.delete(key);
}
