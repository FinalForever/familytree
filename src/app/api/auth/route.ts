import { NextResponse } from 'next/server';
import { findUser, normalizeUsername, verifyUserPassword } from '@/utils/users';
import {
  clearLoginFailures,
  clientKey,
  isAuthConfigured,
  issueToken,
  loginLockedOut,
  loginRateLimited,
  recordLoginAttempt,
  recordLoginFailure,
  readJsonBody,
} from '@/utils/auth';

// 账号 + 密码登录：口令以 scrypt 哈希存于服务端账号文件，校验通过后
// 签发 HMAC 签名会话令牌，并写入 HttpOnly Cookie。
export async function POST(request: Request) {
  try {
    if (!isAuthConfigured()) {
      console.error('鉴权未配置 AUTH_SECRET，拒绝登录');
      return NextResponse.json(
        { success: false, message: '服务器未完成安全配置，请联系管理员' },
        { status: 500 }
      );
    }

    const key = clientKey(request);
    if (loginLockedOut(key)) {
      return NextResponse.json(
        { success: false, message: '失败次数过多，该来源已被临时锁定，请 30 分钟后再试' },
        { status: 429 }
      );
    }
    if (loginRateLimited(key)) {
      return NextResponse.json(
        { success: false, message: '尝试次数过多，请 10 分钟后再试' },
        { status: 429 }
      );
    }

    const parsed = await readJsonBody(request);
    if (!parsed.ok) {
      return NextResponse.json(
        { success: false, message: '请求体过大' },
        { status: 413 }
      );
    }
    const body = parsed.body;
    const username = typeof body?.username === 'string' ? body.username : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!username || !password) {
      return NextResponse.json(
        { success: false, message: '请输入账号和密码' },
        { status: 400 }
      );
    }
    // 账号合法长度至多 32 位，超长直接按登录失败处理，不进后续校验
    if (username.length > 64) {
      return NextResponse.json(
        { success: false, message: '账号或密码不正确' },
        { status: 401 }
      );
    }

    recordLoginAttempt(key);

    if (!(await verifyUserPassword(username, password))) {
      recordLoginFailure(key);
      return NextResponse.json(
        { success: false, message: '账号或密码不正确' },
        { status: 401 }
      );
    }

    clearLoginFailures(key);

    const user = findUser(username);
    const token = issueToken(user?.username ?? normalizeUsername(username), user?.tokenVersion ?? 0);
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
    console.error('登录过程中出错:', error);
    return NextResponse.json(
      { success: false, message: '登录失败，请重试' },
      { status: 500 }
    );
  }
}
