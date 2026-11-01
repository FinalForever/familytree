import { NextResponse } from 'next/server';
import { getAuthConfigOnServer } from '@/utils/config';
import {
  checkPassword,
  clientKey,
  isAuthConfigured,
  issueToken,
  loginRateLimited,
  recordLoginAttempt,
} from '@/utils/auth';

// 口令登录：口令只存于服务端环境变量 FAMILY_PASSWORD；
// 成功后签发 HMAC 签名令牌，并同时写入 HttpOnly Cookie。
export async function POST(request: Request) {
  try {
    const authConfig = await getAuthConfigOnServer();

    // 未开启鉴权时直接放行
    if (!authConfig.requireAuth) {
      return NextResponse.json({ success: true });
    }

    // 开启了鉴权但服务端没配好口令/密钥：失败关闭，不放行
    if (!isAuthConfigured()) {
      console.error('鉴权已开启但未配置 FAMILY_PASSWORD / AUTH_SECRET，拒绝登录');
      return NextResponse.json(
        { success: false, message: '服务器未完成安全配置，请联系管理员' },
        { status: 500 }
      );
    }

    const key = clientKey(request);
    if (loginRateLimited(key)) {
      return NextResponse.json(
        { success: false, message: '尝试次数过多，请 10 分钟后再试' },
        { status: 429 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const password = typeof body?.password === 'string' ? body.password : '';

    recordLoginAttempt(key);

    if (!checkPassword(password)) {
      return NextResponse.json(
        { success: false, message: '口令不正确' },
        { status: 401 }
      );
    }

    const token = issueToken();
    const res = NextResponse.json({ success: true, token });
    res.cookies.set('ft_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 24 * 60 * 60,
    });
    return res;
  } catch (error) {
    console.error('验证过程中出错:', error);
    return NextResponse.json(
      { success: false, message: '验证失败，请重试' },
      { status: 500 }
    );
  }
}
