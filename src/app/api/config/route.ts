import { NextResponse } from 'next/server';
import { getAuthConfigOnServer, getFamilyDataOnServer } from '@/utils/config';
import { extractToken, verifyToken } from '@/utils/auth';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const configType = url.searchParams.get('type');

    const authConfig = await getAuthConfigOnServer();

    // 公共配置（姓氏、是否需要登录）可以匿名获取，不含任何敏感信息
    if (configType === 'auth') {
      return NextResponse.json({
        familyName: authConfig.familyName,
        requireAuth: authConfig.requireAuth
      });
    }

    if (configType === 'family') {
      // 族谱数据必须通过鉴权（签名令牌）
      if (authConfig.requireAuth && !verifyToken(extractToken(request))) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const familyData = await getFamilyDataOnServer();
      return NextResponse.json(familyData);
    }

    return NextResponse.json({ error: 'Invalid config type' }, { status: 400 });
  } catch (error) {
    console.error('获取配置时出错:', error);
    return NextResponse.json({ error: 'Failed to load config' }, { status: 500 });
  }
}
