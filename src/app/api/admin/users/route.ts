import { NextResponse } from 'next/server';
import { isAdminRequest } from '@/utils/admin';
import {
  createUser,
  deleteUser,
  findUser,
  isValidUsername,
  loadUsers,
  MAX_PASSWORD_LENGTH,
} from '@/utils/users';

function unauthorized() {
  return NextResponse.json(
    { success: false, message: '未登录管理员账号' },
    { status: 401 }
  );
}

// 账号列表（只回账号名与创建时间，不回哈希）
export async function GET(request: Request) {
  if (!isAdminRequest(request)) return unauthorized();
  const users = loadUsers().map((u) => ({
    username: u.username,
    createdAt: u.createdAt,
  }));
  return NextResponse.json({ success: true, users });
}

// 指定账号密码新建账号
export async function POST(request: Request) {
  if (!isAdminRequest(request)) return unauthorized();
  const body = await request.json().catch(() => ({}));
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
  if (findUser(username)) {
    return NextResponse.json(
      { success: false, message: '该账号已存在' },
      { status: 409 }
    );
  }

  const user = createUser(username, password);
  return NextResponse.json({ success: true, username: user.username });
}

// 删除账号
export async function DELETE(request: Request) {
  if (!isAdminRequest(request)) return unauthorized();
  const body = await request.json().catch(() => ({}));
  const username = typeof body?.username === 'string' ? body.username : '';
  if (!username || !deleteUser(username)) {
    return NextResponse.json(
      { success: false, message: '账号不存在' },
      { status: 404 }
    );
  }
  return NextResponse.json({ success: true });
}
