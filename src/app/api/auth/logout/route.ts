import { NextResponse } from 'next/server';
import { extractToken, revokeToken } from '@/utils/auth';

// 退出登录：把当前令牌加入吊销表（被复制走的令牌退出后同样失效），并清除会话 Cookie
export async function POST(request: Request) {
  revokeToken(extractToken(request));
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
