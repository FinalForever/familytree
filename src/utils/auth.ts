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
  // 账号世代 id（普通用户令牌才有）：与账号记录的随机 id 比对，删号重建同名也不能让旧令牌复活。
  // 本字段上线前签发的老令牌没有 uid，校验时一律不认（部署后需重新登录一次）
  uid?: string;
}

function hmac(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

// —— 退出吊销表（落盘持久化 + fail-closed）：注销时把令牌指纹记到它的过期时间为止，验签前先查 ——
// 无状态令牌本身无法撤销，这张表让「退出」对被复制走的令牌同样生效。
// 存储与 users.json 同一套路（data 卷上的 JSON 文件、原子写）：进程重启后吊销仍然有效；
// 清理只删已过期项，绝不淘汰未过期的吊销记录。注：文件是单实例存储，多实例部署需换共享存储。
// fail-closed 原则：吊销文件「不存在」可以按空表启动；但「损坏/不可读」绝不能当空表放行——
// 那等于让所有已吊销令牌复活。故障时宁可全员会话验证失败（掉线可恢复，吊销失效不可恢复）。
const revokedTokens = new Map<string, number>();
let revokedLoaded = false;
let revokedStoreBroken = false;
const MAX_REVOKED_ENTRIES = 10000;

function revokedFile(): string {
  const dir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dir, 'revoked-tokens.json');
}

function loadRevoked(): Map<string, number> {
  if (!revokedLoaded) {
    revokedLoaded = true;
    let raw: string;
    try {
      raw = fs.readFileSync(revokedFile(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return revokedTokens; // 文件不存在：首次运行，空表正常
      }
      revokedStoreBroken = true;
      console.error('吊销表读取失败（非文件不存在），进入 fail-closed：所有会话验证将被拒绝，请检查 data 卷与 revoked-tokens.json:', error);
      return revokedTokens;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('吊销表不是 JSON 对象');
      const now = Date.now();
      let live = 0;
      for (const [fp, exp] of Object.entries(parsed)) {
        // 条目格式也要验：指纹必须是 sha256 的 64 位十六进制、过期值必须是有效数字，
        // 对不上说明文件不是本程序写的（损坏或被篡改），按损坏走 fail-closed，不静默吞
        if (!/^[0-9a-f]{64}$/.test(fp) || typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) {
          throw new Error('吊销表条目格式无效');
        }
        if (exp > now) {
          revokedTokens.set(fp, exp);
          live += 1;
        }
      }
      // 上限在加载时的语义（与新增吊销的运行时口径配套，边界已由冒烟钉死）：
      // 恰好 10000 条是程序自身写路径可达成的合法状态（第 10000 条在「还差一条才满」时
      // 写入并落盘），启动时放行、会话照常可用；超过 10000 条只可能来自篡改或损坏，
      // 按损坏走 fail-closed。运行时满 10000 后再新增吊销，则拒绝并进入故障态。
      if (live > MAX_REVOKED_ENTRIES) {
        throw new Error(`吊销表有效条目 ${live} 条，超过上限 ${MAX_REVOKED_ENTRIES} 条`);
      }
    } catch (error) {
      revokedStoreBroken = true;
      console.error('吊销表文件损坏，进入 fail-closed：所有会话验证将被拒绝，请修复或删除 revoked-tokens.json 后重启:', error);
    }
  }
  return revokedTokens;
}

function persistRevoked(): boolean {
  try {
    const now = Date.now();
    for (const [fp, exp] of revokedTokens) if (exp <= now) revokedTokens.delete(fp);
    const file = revokedFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(revokedTokens)), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    console.error('吊销表落盘失败:', error);
    return false;
  }
}

function tokenFingerprint(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// 吊销存储是否健康：签发新令牌的入口（登录/注册/管理员登录）先查这里——
// 存储故障时全员会话本来就验不过，再发 Cookie 只会让用户误以为登录成功，不如直接报服务错误
export function revocationStoreHealthy(): boolean {
  loadRevoked();
  return !revokedStoreBroken;
}

// 吊销一个令牌。只登记「签名有效且未过期」的令牌（普通与管理员令牌都认）：
//   'revoked' 已落盘吊销；'invalid' 令牌本身无效/已过期，无需吊销；
//   'failed' 存储故障或已达上限——调用方（注销接口）必须报错，不能假装退出成功。
export function revokeToken(token: string | null | undefined): 'revoked' | 'invalid' | 'failed' {
  if (!token) return 'invalid';
  loadRevoked();
  if (revokedStoreBroken) return 'failed';
  const payload = parseToken(token, getSecret()) ?? parseToken(token, adminSecret());
  if (!payload) return 'invalid';
  const fp = tokenFingerprint(token);
  if (revokedTokens.has(fp)) return 'revoked';
  const now = Date.now();
  for (const [k, exp] of revokedTokens) if (exp <= now) revokedTokens.delete(k);
  if (revokedTokens.size >= MAX_REVOKED_ENTRIES) {
    // 达上限与写失败同口径：进入全局故障态——吊销存储已不可信，继续签发新会话只会扩大不一致
    revokedStoreBroken = true;
    console.error(`吊销表已达硬上限 ${MAX_REVOKED_ENTRIES} 条，进入 fail-closed 故障态（不淘汰未过期记录）：会话验证全部拒绝、登录/注册返回 503，请排查异常注销流量并重启服务`);
    return 'failed';
  }
  revokedTokens.set(fp, payload.exp);
  if (!persistRevoked()) {
    revokedTokens.delete(fp); // 回滚内存登记，保持与磁盘一致
    revokedStoreBroken = true; // 写盘失败即进故障态：会话验证全部拒绝、签发入口统一 503，直到重启恢复
    console.error('吊销表写盘失败，进入 fail-closed 故障态：会话验证全部拒绝、登录/注册返回 503，请检查 data 卷后重启服务');
    return 'failed';
  }
  return 'revoked';
}

function parseToken(token: string | null | undefined, secret: string): TokenPayload | null {
  if (!token || !secret) return null;
  loadRevoked();
  if (revokedStoreBroken) return null; // fail-closed：吊销存储故障时不验证任何会话
  if (revokedTokens.has(tokenFingerprint(token))) return null;
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
    return {
      sub: payload.sub,
      exp: payload.exp,
      ver: typeof payload.ver === 'number' ? payload.ver : 0,
      // uid 必须原样带回：页面校验靠它绑账号世代，漏了会把所有正常会话误拒
      ...(typeof payload.uid === 'string' ? { uid: payload.uid } : {}),
    };
  } catch {
    return null;
  }
}

function mintToken(subject: string, version: number, secret: string, userId?: string): string {
  const payload: TokenPayload = { sub: subject, exp: Date.now() + TOKEN_TTL_MS, ver: version };
  if (userId) payload.uid = userId;
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(body, secret)}`;
}

// 签发普通账号令牌：version 取账号当前的 tokenVersion，改密后版本递增、旧令牌随即失效
export function issueToken(subject = 'family', version = 0, userId?: string): string {
  return mintToken(subject, version, getSecret(), userId);
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

// 锁定到期表的有界管理：先清已到期的锁；仍超硬上限时淘汰「最早到期」的那几条
// （让步最小：被提前释放的也只是锁定剩余时间最短的来源），保证表总有上限
export function capExpiryMap(map: Map<string, number>, cap: number): void {
  if (map.size <= 1000) return;
  const now = Date.now();
  for (const [k, until] of map) if (until <= now) map.delete(k);
  while (map.size > cap) {
    let oldestKey: string | undefined;
    let oldestVal = Infinity;
    for (const [k, until] of map) {
      if (until < oldestVal) {
        oldestVal = until;
        oldestKey = k;
      }
    }
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
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
  // 部署方可用 TRUSTED_IP_HEADER 指定唯一可信的来源 IP 头（小写头名，如 cf-connecting-ip /
  // x-forwarded-for）：设了就只认该头——仅在反代确实会覆写/净化该头时才该设，乱设等于把
  // 限流键交给访客伪造。指定头缺失时回退 'local'，不回退到其他可伪造的头。
  // 与 src/middleware.ts 的限流键规则保持一致，改一处必须同步另一处。
  const trusted = process.env.TRUSTED_IP_HEADER?.trim().toLowerCase();
  if (trusted) {
    const v = request.headers.get(trusted);
    if (v && v.trim()) {
      if (trusted === 'x-forwarded-for') {
        const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
        if (parts.length) return parts[parts.length - 1];
      } else {
        return v.trim();
      }
    }
    return 'local';
  }
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
  // 写接口的同源校验（CSRF 纵深防御，不单靠 Cookie 的 SameSite=Lax）：
  // 请求带 Origin 头时，必须与本站 origin 一致，否则 403——跨站表单/脚本冒名提交会被挡下；
  // 不带 Origin 的非浏览器客户端放行（其请求不靠 Cookie 维持会话的跨站语境）。
  const origin = request.headers.get('origin');
  if (origin) {
    // 配置了 APP_ORIGIN 时以它为准（精确匹配）：某些隧道/边缘代理会把到达应用的
    // Host 改写成内部名，此时任何由请求头推导的 origin 都对不上浏览器地址栏，
    // 只能由部署方把对外 origin 写死。未配置时走下面的候选集推导。
    const configured = process.env.APP_ORIGIN?.trim().replace(/\/+$/, '');
    if (configured) {
      if (origin !== configured) {
        return { ok: false, status: 403, message: '请求来源不被允许' };
      }
    } else {
    // 本站 origin 的候选集（任一命中即放行）：直连时是 request.url 的 origin；
    // 经反代/隧道时 request.url 是内网地址，浏览器地址栏的 origin 要靠代理覆写的
    // X-Forwarded-Host/Proto 还原——浏览器脚本无法伪造这两个头，跨站请求带不过来。
    // 另加主机名兜底：Origin 的 host 与 Host/X-Forwarded-Host 任一相等也放行，
    // 防代理少传协议头时误伤自家请求（校验目标是「来自本站页面」，主机名是其实质）。
    const candidates = new Set<string>();
    const hosts = new Set<string>();
    try {
      const u = new URL(request.url);
      candidates.add(u.origin);
      hosts.add(u.host);
    } catch { /* 解析不出就只剩代理头候选 */ }
    const fwdHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    const reqHost = request.headers.get('host')?.trim();
    if (reqHost) hosts.add(reqHost);
    if (fwdHost) {
      hosts.add(fwdHost);
      const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
      candidates.add(`${proto}://${fwdHost}`);
    }
    let originHost = '';
    try { originHost = new URL(origin).host; } catch { /* 保持空串，不会命中 */ }
    if (!candidates.has(origin) && !(originHost && hosts.has(originHost))) {
      return { ok: false, status: 403, message: '请求来源不被允许' };
    }
    }
  }
  // Content-Type 若存在必须是 application/json（允许 ;charset 等参数），挡掉 text/plain 等
  // 「简单请求」绕过预检的提交方式。
  const contentType = request.headers.get('content-type');
  if (contentType && contentType.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return { ok: false, status: 415, message: '请求须为 application/json' };
  }
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
    capExpiryMap(loginLockedUntil, 10000);
    loginFailures.set(key, []);
    console.warn(`前台登录失败过多：来源 ${key} 已锁定 30 分钟`);
  }
}

export function clearLoginFailures(key: string): void {
  loginFailures.delete(key);
}
