import { NextResponse } from 'next/server';

// 退出登录：清除会话 Cookie
export async function POST() {
  const res = NextResponse.json({ success: true });
  res.cookies.set('ft_session', '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
