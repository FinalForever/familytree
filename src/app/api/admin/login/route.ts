import { NextResponse } from 'next/server';
import {
  ADMIN_COOKIE,
  ADMIN_SUBJECT,
  checkAdminPassword,
  isAdminConfigured,
} from '@/utils/admin';
import {
  clientKey,
  issueToken,
  loginRateLimited,
  recordLoginAttempt,
} from '@/utils/auth';

// 管理员登录：口令只存服务端环境变量 ADMIN_PASSWORD，成功后下发独立的管理员会话 Cookie
export async function POST(request: Request) {
  try {
    if (!isAdminConfigured()) {
      return NextResponse.json(
        { success: false, message: '后台未配置管理员口令（ADMIN_PASSWORD）' },
        { status: 500 }
      );
    }

    const key = `admin:${clientKey(request)}`;
    if (loginRateLimited(key)) {
      return NextResponse.json(
        { success: false, message: '尝试次数过多，请 10 分钟后再试' },
        { status: 429 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const password = typeof body?.password === 'string' ? body.password : '';
    recordLoginAttempt(key);

    if (!checkAdminPassword(password)) {
      return NextResponse.json(
        { success: false, message: '管理员口令不正确' },
        { status: 401 }
      );
    }

    const token = issueToken(ADMIN_SUBJECT);
    const res = NextResponse.json({ success: true });
    res.cookies.set(ADMIN_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 12 * 60 * 60,
    });
    return res;
  } catch (error) {
    console.error('管理员登录出错:', error);
    return NextResponse.json(
      { success: false, message: '登录失败，请重试' },
      { status: 500 }
    );
  }
}
