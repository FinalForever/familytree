import { NextResponse } from 'next/server';
import { extractToken, revokeToken } from '@/utils/auth';

// 退出登录：把当前令牌写入吊销表（被复制走的令牌退出后同样失效），成功后才清除会话 Cookie；
// 吊销存储故障时明确报 500 且不清除 Cookie，不让用户误以为已退出
export async function POST(request: Request) {
  const result = revokeToken(extractToken(request));
  if (result === 'failed') {
    return NextResponse.json(
      { success: false, message: '退出失败，请重试' },
      { status: 500 }
    );
  }
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
