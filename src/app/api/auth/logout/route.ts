import { NextResponse } from 'next/server';

// 退出登录：清除会话 Cookie
export async function POST() {
  const res = NextResponse.json({ success: true });
  res.cookies.set('ft_session', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
