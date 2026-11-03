import { NextResponse } from 'next/server';
import { ADMIN_COOKIE } from '@/utils/admin';
import { revokeToken } from '@/utils/auth';

// 管理员退出：把当前管理员令牌写入吊销表，成功后才清除管理员会话 Cookie；
// 吊销存储故障时明确报 500 且不清除 Cookie，不让用户误以为已退出
export async function POST(request: Request) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=([^;]+)`));
  const result = revokeToken(m ? decodeURIComponent(m[1]) : null);
  if (result === 'failed') {
    return NextResponse.json(
      { success: false, message: '退出失败，请重试' },
      { status: 500 }
    );
  }
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
