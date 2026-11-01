import crypto from 'crypto';
import { getTokenSubject } from './auth';

// 管理后台（仅服务端）：管理员口令只存环境变量 ADMIN_PASSWORD；
// 管理员会话用独立 Cookie ft_admin，令牌主体固定为下面的标识，与普通账号会话区分。
export const ADMIN_SUBJECT = 'admin:panel';
export const ADMIN_COOKIE = 'ft_admin';

export function isAdminConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD);
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
  return getTokenSubject(decodeURIComponent(m[1])) === ADMIN_SUBJECT;
}
