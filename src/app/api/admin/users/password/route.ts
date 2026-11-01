import { NextResponse } from 'next/server';
import { isAdminRequest } from '@/utils/admin';
import { setUserPassword } from '@/utils/users';

// 为指定账号重置密码
export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      { success: false, message: '未登录管理员账号' },
      { status: 401 }
    );
  }
  const body = await request.json().catch(() => ({}));
  const username = typeof body?.username === 'string' ? body.username : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (password.length < 8) {
    return NextResponse.json(
      { success: false, message: '密码至少 8 位' },
      { status: 400 }
    );
  }
  if (!username || !setUserPassword(username, password)) {
    return NextResponse.json(
      { success: false, message: '账号不存在' },
      { status: 404 }
    );
  }
  return NextResponse.json({ success: true });
}
