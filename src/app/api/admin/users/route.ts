import { NextResponse } from 'next/server';
import { isAdminRequest } from '@/utils/admin';
import { readJsonBody } from '@/utils/auth';
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

// 账号存储故障（文件损坏/不可写等）：loadUsers 会抛错，这里统一转成 500，绝不带病写盘
function storeError(error: unknown) {
  console.error('账号管理操作失败:', error);
  return NextResponse.json(
    { success: false, message: '账号存储故障，请稍后再试' },
    { status: 500 }
  );
}

// 账号列表（只回账号名与创建时间，不回哈希）
export async function GET(request: Request) {
  if (!isAdminRequest(request)) return unauthorized();
  try {
    const users = loadUsers().map((u) => ({
      username: u.username,
      createdAt: u.createdAt,
    }));
    return NextResponse.json({ success: true, users });
  } catch (error) {
    return storeError(error);
  }
}

// 指定账号密码新建账号
export async function POST(request: Request) {
  if (!isAdminRequest(request)) return unauthorized();
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
  try {
    if (findUser(username)) {
      return NextResponse.json(
        { success: false, message: '该账号已存在' },
        { status: 409 }
      );
    }

    const user = await createUser(username, password);
    if (!user) {
      return NextResponse.json(
        { success: false, message: '该账号已存在' },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: true, username: user.username });
  } catch (error) {
    return storeError(error);
  }
}

// 删除账号
export async function DELETE(request: Request) {
  if (!isAdminRequest(request)) return unauthorized();
  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return NextResponse.json(
      { success: false, message: parsed.message },
      { status: parsed.status }
    );
  }
  const body = parsed.body;
  const username = typeof body?.username === 'string' ? body.username : '';
  try {
    if (!username || !(await deleteUser(username))) {
      return NextResponse.json(
        { success: false, message: '账号不存在' },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return storeError(error);
  }
}
