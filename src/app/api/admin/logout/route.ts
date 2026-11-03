import { NextResponse } from 'next/server';
import { ADMIN_COOKIE } from '@/utils/admin';

// 管理员退出：清除管理员会话 Cookie
export async function POST() {
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
