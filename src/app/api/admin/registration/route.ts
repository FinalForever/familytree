import { NextResponse } from 'next/server';
import { isAdminRequest } from '@/utils/admin';
import { isRegistrationOpen, setRegistrationOpen } from '@/utils/users';

// 查询注册开关状态
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      { success: false, message: '未登录管理员账号' },
      { status: 401 }
    );
  }
  return NextResponse.json({ success: true, registrationOpen: isRegistrationOpen() });
}

// 打开/关闭注册（写入设置文件，即时生效，无需重启）
export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      { success: false, message: '未登录管理员账号' },
      { status: 401 }
    );
  }
  const body = await request.json().catch(() => ({}));
  if (typeof body?.open !== 'boolean') {
    return NextResponse.json(
      { success: false, message: '参数不正确' },
      { status: 400 }
    );
  }
  setRegistrationOpen(body.open);
  return NextResponse.json({ success: true, registrationOpen: body.open });
}
