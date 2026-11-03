import { NextResponse } from 'next/server';
import { isAdminRequest } from '@/utils/admin';
import { getFamilyName, isRegistrationOpen, setRegistrationOpen } from '@/utils/users';
import { readJsonBody } from '@/utils/auth';

// 查询注册开关状态
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      { success: false, message: '未登录管理员账号' },
      { status: 401 }
    );
  }
  return NextResponse.json({
    success: true,
    registrationOpen: isRegistrationOpen(),
    familyName: getFamilyName(),
  });
}

// 打开/关闭注册（写入设置文件，即时生效，无需重启）
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
      { success: false, message: '请求体过大' },
      { status: 413 }
    );
  }
  const body = parsed.body;
  if (typeof body?.open !== 'boolean') {
    return NextResponse.json(
      { success: false, message: '参数不正确' },
      { status: 400 }
    );
  }
  setRegistrationOpen(body.open);
  // 返回实际生效状态：环境变量 REGISTRATION_OPEN=false 时强制关闭，面板写入的值不会生效
  return NextResponse.json({ success: true, registrationOpen: isRegistrationOpen() });
}
