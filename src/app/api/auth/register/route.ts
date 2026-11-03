import { NextResponse } from 'next/server';
import {
  createUser,
  findUser,
  isRegistrationOpen,
  isValidUsername,
  MAX_PASSWORD_LENGTH,
} from '@/utils/users';
import {
  clientKey,
  isAuthConfigured,
  issueToken,
  loginRateLimited,
  recordLoginAttempt,
  readJsonBody,
} from '@/utils/auth';

// 账号注册：受 REGISTRATION_OPEN 开关控制（设为 false 即关闭注册，改环境变量后重启容器生效）。
// 注册成功即自动登录（下发会话 Cookie）。
export async function POST(request: Request) {
  try {
    if (!isRegistrationOpen()) {
      return NextResponse.json(
        { success: false, message: '注册已关闭' },
        { status: 403 }
      );
    }

    if (!isAuthConfigured()) {
      console.error('鉴权未配置 AUTH_SECRET，拒绝注册');
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

    const parsed = await readJsonBody(request);
    if (!parsed.ok) {
      return NextResponse.json(
        { success: false, message: parsed.message },
        { status: parsed.status }
      );
    }
    const body = parsed.body;
    const username = typeof body?.username === 'string' ? body.username : '';
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!isValidUsername(username)) {
      return NextResponse.json(
        { success: false, message: '账号需为 2-32 位字母、数字、下划线或汉字' },
        { status: 400 }
      );
    }
    if (password.length < 8) {
      return NextResponse.json(
        { success: false, message: '密码至少 8 位' },
        { status: 400 }
      );
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      return NextResponse.json(
        { success: false, message: `密码最长 ${MAX_PASSWORD_LENGTH} 位` },
        { status: 400 }
      );
    }

    recordLoginAttempt(key);

    if (findUser(username)) {
      return NextResponse.json(
        { success: false, message: '该账号已注册，请直接登录' },
        { status: 409 }
      );
    }

    const user = await createUser(username, password);
    if (!user) {
      // 锁内查重命中：并发注册同名，只有一个能成功
      return NextResponse.json(
        { success: false, message: '该账号已注册，请直接登录' },
        { status: 409 }
      );
    }
    const token = issueToken(user.username, user.tokenVersion ?? 0);
    const res = NextResponse.json({ success: true });
    res.cookies.set('ft_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 24 * 60 * 60,
    });
    return res;
  } catch (error) {
    console.error('注册过程中出错:', error);
    return NextResponse.json(
      { success: false, message: '注册失败，请重试' },
      { status: 500 }
    );
  }
}
