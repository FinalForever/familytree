import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// 服务端会话令牌工具（仅在服务端使用）：HMAC-SHA256 签名，防伪造。
// 密钥与口令均只从服务端环境变量读取，绝不下发到客户端。

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function getSecret(): string {
  // 两端空白不算密钥内容：一律先 trim，避免"   "这类值被当成已配置
  return (process.env.AUTH_SECRET || '').trim();
}

// 签名密钥最小长度：太短或占位值形同虚设，按未配置处理（登录会明确 500，而不是签出弱令牌）
const MIN_SECRET_LENGTH = 16;

export function isAuthConfigured(): boolean {
  // 邮箱账号登录只需要签名密钥；FAMILY_PASSWORD 是旧口令登录的遗留，不再必需
  return getSecret().length >= MIN_SECRET_LENGTH;
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

export interface TokenPayload {
  sub: string;
  exp: number;
  ver: number;
}

function hmac(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

// —— 退出吊销表（落盘持久化）：注销时把令牌指纹记到它的过期时间为止，验签前先查 ——
// 无状态令牌本身无法撤销，这张表让「退出」对被复制走的令牌同样生效。
// 存储与 users.json 同一套路（data 卷上的 JSON 文件、原子写）：进程重启后吊销仍然有效；
// 清理只删已过期项，绝不淘汰未过期的吊销记录。注：文件是单实例存储，多实例部署需换共享存储。
const revokedTokens = new Map<string, number>();
let revokedLoaded = false;

function revokedFile(): string {
  const dir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dir, 'revoked-tokens.json');
}

function loadRevoked(): Map<string, number> {
  if (!revokedLoaded) {
    revokedLoaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(revokedFile(), 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const now = Date.now();
        for (const [fp, exp] of Object.entries(parsed)) {
          if (typeof exp === 'number' && exp > now) revokedTokens.set(fp, exp);
        }
      }
    } catch {
      // 文件不存在或损坏：按空表处理
    }
  }
  return revokedTokens;
}

function persistRevoked(): void {
  try {
    const now = Date.now();
    for (const [fp, exp] of revokedTokens) if (exp <= now) revokedTokens.delete(fp);
    const file = revokedFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(revokedTokens)), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    console.error('吊销表落盘失败（本次吊销仅在内存生效）:', error);
  }
}

function tokenFingerprint(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function revokeToken(token: string | null | undefined): void {
  if (!token) return;
  let expMs = Date.now() + TOKEN_TTL_MS;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
    if (typeof payload?.exp === 'number') expMs = payload.exp;
  } catch {
    // 载荷读不出就按默认时长记
  }
  loadRevoked().set(tokenFingerprint(token), expMs);
  persistRevoked();
}

function parseToken(token: string | null | undefined, secret: string): TokenPayload | null {
  if (!token || !secret) return null;
  if (loadRevoked().has(tokenFingerprint(token))) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const a = Buffer.from(sig);
  const b = Buffer.from(hmac(body, secret));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload?.sub !== 'string' || typeof payload?.exp !== 'number') return null;
    if (Date.now() >= payload.exp) return null;
    return { sub: payload.sub, exp: payload.exp, ver: typeof payload.ver === 'number' ? payload.ver : 0 };
  } catch {
    return null;
  }
}

function mintToken(subject: string, version: number, secret: string): string {
  const payload = { sub: subject, exp: Date.now() + TOKEN_TTL_MS, ver: version };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(body, secret)}`;
}

// 签发普通账号令牌：version 取账号当前的 tokenVersion，改密后版本递增、旧令牌随即失效
export function issueToken(subject = 'family', version = 0): string {
  return mintToken(subject, version, getSecret());
}

export function verifyToken(token: string | null | undefined): boolean {
  return parseToken(token, getSecret()) !== null;
}

export function extractToken(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)ft_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// 限流 Map 的兜底清理：键只进不清会随来源数量线性涨，超上限时先删全过期的键，仍超就丢最早的键
const MAX_TRACKED_KEYS = 5000;
export function sweepMap(map: Map<string, number[]>, windowMs: number): void {
  if (map.size <= MAX_TRACKED_KEYS) return;
  const now = Date.now();
  for (const [key, list] of map) {
    if (!list.some((t) => now - t < windowMs)) map.delete(key);
  }
  while (map.size > MAX_TRACKED_KEYS) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
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
  sweepMap(attempts, WINDOW_MS);
}

export function clientKey(request: Request): string {
  // 来源标识只取可信代理给出的值：Cloudflare 的 CF-Connecting-IP 由 CF 边缘写入、访客无法伪造；
  // 没有时退回 X-Forwarded-For 的最后一跳（离应用最近的可信代理追加的那一项）。
  // 绝不能取 XFF 第一项——那是访客自己可控的内容，用它做限流键等于没有限流。
  const cf = request.headers.get('cf-connecting-ip');
  if (cf && cf.trim()) return cf.trim();
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) {
    const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return 'local';
}

// 请求体上限（字节）：登录/注册等 JSON 接口只接受小请求体，超限直接拒绝，
// 避免超大请求体白白占用解析与口令哈希资源
export function requestBodyTooLarge(request: Request, limit = 16384): boolean {
  const len = Number(request.headers.get('content-length') || 0);
  return Number.isFinite(len) && len > limit;
}

// 读 JSON 请求体并按实际字节数限流：只看 Content-Length 挡不住分块传输的大请求，
// 这里边读边计数。结果三态分明，不再把读失败/格式错误混同为空请求体：
//   过大 → 413；JSON 格式错误 → 400；读取中断 → 400；空体 → {} 放行（由字段校验兜底）
// 注：Next standalone 会先把请求体收完再进 handler（裸 socket 实测），所以「读取时限」
// 在应用层无从生效——慢速滴流由 Node 服务层/前置代理的超时兜底，这里不写假超时。
export type JsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; message: string };

export async function readJsonBody(request: Request, limit = 16384): Promise<JsonBodyResult> {
  if (requestBodyTooLarge(request, limit)) {
    return { ok: false, status: 413, message: '请求体过大' };
  }
  const stream = request.body;
  if (!stream) return { ok: true, body: {} };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > limit) {
          return { ok: false, status: 413, message: '请求体过大' };
        }
        chunks.push(value);
      }
    }
  } catch {
    return { ok: false, status: 400, message: '请求读取失败' };
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  if (!text) return { ok: true, body: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return { ok: true, body: parsed as Record<string, unknown> };
    }
    return { ok: false, status: 400, message: '请求格式不正确' };
  } catch {
    return { ok: false, status: 400, message: '请求格式不正确' };
  }
}

// 验签并取出令牌主体（账号名），无效返回 null
export function getTokenSubject(token: string | null | undefined): string | null {
  const payload = parseToken(token, getSecret());
  return payload ? payload.sub : null;
}

// 验签并取出完整载荷（含版本号，页面据此与账号当前 tokenVersion 比对），无效返回 null
export function getTokenPayload(token: string | null | undefined): TokenPayload | null {
  return parseToken(token, getSecret());
}

// —— 管理员令牌：签名密钥掺入管理员口令 ——
// 轮换 ADMIN_PASSWORD 后，旧密钥随之改变，此前签发的所有管理员令牌立即失效。
function adminSecret(): string {
  const base = getSecret();
  if (!base) return '';
  return crypto.createHmac('sha256', base).update(`admin:${process.env.ADMIN_PASSWORD || ''}`).digest('base64url');
}

export function issueAdminToken(subject: string): string {
  return mintToken(subject, 0, adminSecret());
}

export function getAdminTokenSubject(token: string | null | undefined): string | null {
  const secret = adminSecret();
  if (!secret) return null;
  const payload = parseToken(token, secret);
  return payload ? payload.sub : null;
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
  sweepMap(loginFailures, LOGIN_FAIL_WINDOW_MS);
  console.warn(`前台登录失败：来源 ${key}，近 10 分钟失败 ${list.length} 次`);
  if (list.length >= LOGIN_MAX_FAILURES) {
    loginLockedUntil.set(key, now + LOGIN_LOCK_MS);
    // 锁定到期表也要有界：写入时顺带清掉已过期的锁，避免只进不出
    if (loginLockedUntil.size > 1000) {
      for (const [k, until] of loginLockedUntil) if (until <= now) loginLockedUntil.delete(k);
    }
    loginFailures.set(key, []);
    console.warn(`前台登录失败过多：来源 ${key} 已锁定 30 分钟`);
  }
}

export function clearLoginFailures(key: string): void {
  loginFailures.delete(key);
}
