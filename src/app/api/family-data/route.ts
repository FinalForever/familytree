import { NextResponse } from 'next/server';

// 族谱数据已改为服务端渲染注入页面，不再提供 JSON 数据接口（防批量爬取）。
// 保留此路由仅为让旧调用方明确得到 404，而不是暴露任何数据。
export async function GET() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}
