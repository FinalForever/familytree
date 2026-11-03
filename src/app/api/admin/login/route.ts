import { NextResponse } from 'next/server';
import {
  ADMIN_COOKIE,
  ADMIN_SUBJECT,
  adminLockedOut,
  adminRateLimited,
  checkAdminPassword,
  clearAdminFailures,
  isAdminConfigured,
  recordAdminAttempt,
  recordAdminFailure,
} from '@/utils/admin';
import { clientKey, isAuthConfigured, issueAdminToken, readJsonBody } from '@/utils/auth';

// 管理员登录：口令只存服务端环境变量 ADMIN_PASSWORD，成功后下发独立的管理员会话 Cookie。
// 防爆破：按来源限流 5 次/10 分钟；10 分钟内失败 5 次锁定该来源 30 分钟；失败尝试记入日志。
export async function POST(request: Request) {
  try {
    if (!isAdminConfigured()) {
      return NextResponse.json(
        { success: false, message: '后台未配置管理员口令（ADMIN_PASSWORD）' },
        { status: 500 }
      );
    }
    // 管理员令牌同样靠 AUTH_SECRET 签名：缺了它登录会「成功」却发出永远验不过的 Cookie，必须在这里拦下
    if (!isAuthConfigured()) {
      console.error('鉴权未配置 AUTH_SECRET，拒绝管理员登录');
      return NextResponse.json(
        { success: false, message: '服务器未完成安全配置（缺少 AUTH_SECRET），请联系管理员' },
        { status: 500 }
      );
    }

    const key = `admin:${clientKey(request)}`;

    if (adminLockedOut(key)) {
      return NextResponse.json(
        { success: false, message: '失败次数过多，该来源已被临时锁定，请 30 分钟后再试' },
        { status: 429 }
      );
    }
    if (adminRateLimited(key)) {
      return NextResponse.json(
        { success: false, message: '尝试次数过多，请 10 分钟后再试' },
        { status: 429 }
      );
    }

    const parsed = await readJsonBody(request);
    if (!parsed.ok) {
      return NextResponse.json(
        { success: false, message: parsed.message },
        { status: parsed.status }
      );
    }
    const body = parsed.body;
    const password = typeof body?.password === 'string' ? body.password : '';
    recordAdminAttempt(key);

    if (!checkAdminPassword(password)) {
      recordAdminFailure(key);
      return NextResponse.json(
        { success: false, message: '管理员口令不正确' },
        { status: 401 }
      );
    }

    clearAdminFailures(key);
    const token = issueAdminToken(ADMIN_SUBJECT);
    const res = NextResponse.json({ success: true });
    res.cookies.set(ADMIN_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
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
