import { NextResponse } from 'next/server';
import { getAuthConfigOnServer } from '@/utils/config';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const configType = url.searchParams.get('type');

    // 仅保留公共配置（姓氏、是否需要登录），不含任何敏感信息
    if (configType === 'auth') {
      const authConfig = await getAuthConfigOnServer();
      return NextResponse.json({
        familyName: authConfig.familyName,
        requireAuth: authConfig.requireAuth
      });
    }

    // 族谱数据不再经接口下发（已改为服务端渲染注入页面，防爬取）
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  } catch (error) {
    console.error('获取配置时出错:', error);
    return NextResponse.json({ error: 'Failed to load config' }, { status: 500 });
  }
}
