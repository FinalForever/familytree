import { NextResponse } from 'next/server';
import { isAdminRequest } from '@/utils/admin';
import { getFamilyName, setFamilyName } from '@/utils/users';
import { readJsonBody } from '@/utils/auth';

// 修改家族姓氏（写入设置文件，全站即时生效，无需重新构建）
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
  const familyName = typeof body?.familyName === 'string' ? body.familyName : '';
  if (!setFamilyName(familyName)) {
    return NextResponse.json(
      { success: false, message: '姓氏需为 1-4 个汉字或字母' },
      { status: 400 }
    );
  }
  return NextResponse.json({ success: true, familyName: getFamilyName() });
}
