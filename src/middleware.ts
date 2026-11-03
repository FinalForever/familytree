import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// 全站限速：同一 IP 每分钟最多 60 次请求，抑制批量抓取/扫描。
// 计数只存内存（单实例部署足够），重启即清零。
const WINDOW_MS = 60 * 1000;
const MAX_REQ = 60;
const hits = new Map<string, number[]>();

export function middleware(request: NextRequest) {
  // 与 utils/auth.ts 的 clientKey 同规则：优先 CF-Connecting-IP，否则取 XFF 最后一跳；
  // XFF 第一项是访客可控的，不能用作限流键
  const ip =
    request.headers.get('cf-connecting-ip')?.trim() ||
    request.headers.get('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean).pop() ||
    'local';
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  // 兜底清理：键只进不清会随来源数量线性涨，超上限时删全过期的键，仍超就丢最早的键
  if (hits.size > 5000) {
    for (const [key, l] of hits) {
      if (!l.some((t) => now - t < WINDOW_MS)) hits.delete(key);
    }
    while (hits.size > 5000) {
      const first = hits.keys().next().value;
      if (first === undefined) break;
      hits.delete(first);
    }
  }

  if (list.length > MAX_REQ) {
    return new NextResponse('Too Many Requests', { status: 429 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
