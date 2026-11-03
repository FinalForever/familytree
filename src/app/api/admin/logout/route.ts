import { NextResponse } from 'next/server';
import { ADMIN_COOKIE } from '@/utils/admin';
import { revokeToken } from '@/utils/auth';

// 管理员退出：把当前管理员令牌加入吊销表，并清除管理员会话 Cookie
export async function POST(request: Request) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=([^;]+)`));
  if (m) revokeToken(decodeURIComponent(m[1]));
  const res = NextResponse.json({ success: true });
  res.cookies.set(ADMIN_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
