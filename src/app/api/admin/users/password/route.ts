import { NextResponse } from 'next/server';
import { isAdminRequest } from '@/utils/admin';
import { MAX_PASSWORD_LENGTH, setUserPassword } from '@/utils/users';
import { readJsonBody } from '@/utils/auth';

// 为指定账号重置密码
export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      { success: false, message: '未登录管理员账号' },
      { status: 401 }
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
  try {
    if (!username || !(await setUserPassword(username, password))) {
      return NextResponse.json(
        { success: false, message: '账号不存在' },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    // 账号存储故障（文件损坏等）时 loadUsers 抛错：回 500，绝不带病写盘
    console.error('管理员改密失败:', error);
    return NextResponse.json(
      { success: false, message: '账号存储故障，请稍后再试' },
      { status: 500 }
    );
  }
}
