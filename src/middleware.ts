import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// 全站限速：同一 IP 每分钟最多 60 次请求，抑制批量抓取/扫描。
// 计数只存内存（单实例部署足够），重启即清零。
const WINDOW_MS = 60 * 1000;
const MAX_REQ = 60;
const hits = new Map<string, number[]>();

export function middleware(request: NextRequest) {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);

  if (list.length > MAX_REQ) {
    return new NextResponse('Too Many Requests', { status: 429 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
