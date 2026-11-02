"use client";

import { useState, useEffect, useMemo, useRef } from 'react';
import { FamilyData, Person } from '@/types/family';
import { highlightMatch } from '@/utils/search';
import { ANIMATION_DELAYS, CSS_CLASSES } from '@/utils/constants';

interface TreeViewProps {
  data: FamilyData;
  searchTerm?: string;
  searchInInfo?: boolean;
}

// 检查是否匹配搜索条件
const isPersonMatch = (person: Person, searchTerm: string, searchInInfo: boolean): boolean => {
  if (!searchTerm) return false;

  const lowerSearchTerm = searchTerm.toLowerCase();
  const nameMatch = person.name.toLowerCase().includes(lowerSearchTerm);
  const infoMatch = searchInInfo && person.info && person.info.toLowerCase().includes(lowerSearchTerm);
  const yearMatch = (person.birthYear?.toString().includes(lowerSearchTerm) || false) ||
                   (person.deathYear?.toString().includes(lowerSearchTerm) || false);

  return nameMatch || !!infoMatch || yearMatch;
};

// —— 树状图布局常量 ——
const NODE_W = 176;          // 节点卡片宽
const NODE_H = 128;          // 节点卡片高（含 info 区）
const SLOT_W = 196;          // 每个叶子占的水平槽宽
const ROW_H = 184;           // 每代（行）高度，含连线区
const GUTTER = 96;           // 左侧世代标签栏宽
const TOP_PAD = 10;
const DEFAULT_EXPAND_DEPTH = 6; // 默认展开到第几层（0 起），更深的支系先折叠

interface TreeModel {
  byId: Map<string, Person>;
  childrenOf: Map<string, string[]>;
  parentOf: Map<string, string>;
  roots: string[];
  depthOf: Map<string, number>;
  descCount: Map<string, number>;
  genTitles: string[];
  initialCollapsed: Set<string>;
}

function buildModel(data: FamilyData): TreeModel {
  const byId = new Map<string, Person>();
  data.generations.forEach((g) => {
    g.people.forEach((p) => {
      if (p.id && !byId.has(p.id)) byId.set(p.id, p);
    });
  });

  const childrenOf = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  byId.forEach((_, id) => childrenOf.set(id, []));
  const roots: string[] = [];
  data.generations.forEach((g) => {
    g.people.forEach((p) => {
      if (!p.id || byId.get(p.id) !== p) return;
      const fid = p.fatherId;
      if (fid && fid !== p.id && byId.has(fid)) {
        childrenOf.get(fid)!.push(p.id);
        parentOf.set(p.id, fid);
      } else {
        roots.push(p.id);
      }
    });
  });

  const depthOf = new Map<string, number>();
  const descCount = new Map<string, number>();
  const calc = (id: string, depth: number, guard: Set<string>): number => {
    if (guard.has(id)) return 0;
    guard.add(id);
    depthOf.set(id, depth);
    let total = 0;
    childrenOf.get(id)!.forEach((cid) => {
      total += 1 + calc(cid, depth + 1, guard);
    });
    descCount.set(id, total);
    return total;
  };
  roots.forEach((r) => calc(r, 0, new Set()));

  const initialCollapsed = new Set<string>();
  byId.forEach((_, id) => {
    if ((childrenOf.get(id)?.length ?? 0) > 0 && (depthOf.get(id) ?? 0) >= DEFAULT_EXPAND_DEPTH) {
      initialCollapsed.add(id);
    }
  });

  return {
    byId,
    childrenOf,
    parentOf,
    roots,
    depthOf,
    descCount,
    genTitles: data.generations.map((g) => g.title),
    initialCollapsed,
  };
}

interface PlacedNode {
  id: string;
  person: Person;
  depth: number;
  cx: number;   // 中心 x
  top: number;  // 卡片 top
  hasChildren: boolean;
  childCount: number;
  descCount: number;
  expanded: boolean;
}

export default function TreeView({ data, searchTerm, searchInInfo }: TreeViewProps) {
  const model = useMemo(() => buildModel(data), [data]);
  const [collapsed, setCollapsed] = useState<Set<string>>(model.initialCollapsed);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [firstMatchId, setFirstMatchId] = useState<string | null>(null);

  // 数据变化时重置折叠状态
  useEffect(() => {
    setCollapsed(model.initialCollapsed);
  }, [model]);

  // 整齐树布局：叶子按顺序占槽，父节点居中于其所有子节点之上
  const layout = useMemo(() => {
    const placed = new Map<string, PlacedNode>();
    let maxDepth = 0;
    const place = (id: string, leftSlot: number, depth: number): number => {
      const kids = model.childrenOf.get(id) ?? [];
      const expanded = kids.length > 0 && !collapsed.has(id);
      maxDepth = Math.max(maxDepth, depth);
      let widthSlots: number;
      // 左对齐：父节点永远位于其支系最左槽的正上方（与原版逐层右移的排法一致），
      // 展开任何支系只会把右侧内容推远，左侧已排好的部分纹丝不动。
      const cx = GUTTER + (leftSlot + 0.5) * SLOT_W;
      if (!expanded) {
        widthSlots = 1;
      } else {
        let cur = leftSlot;
        kids.forEach((cid) => {
          cur += place(cid, cur, depth + 1);
        });
        widthSlots = Math.max(1, cur - leftSlot);
      }
      placed.set(id, {
        id,
        person: model.byId.get(id)!,
        depth,
        cx,
        top: TOP_PAD + depth * ROW_H,
        hasChildren: kids.length > 0,
        childCount: kids.length,
        descCount: model.descCount.get(id) ?? 0,
        expanded,
      });
      return widthSlots;
    };
    let left = 0;
    model.roots.forEach((rid, i) => {
      if (i > 0) left += 1; // 多个根之间留一槽间隔
      left += place(rid, left, 0);
    });
    const width = GUTTER + left * SLOT_W + 24;
    const height = TOP_PAD + (maxDepth + 1) * ROW_H + 8;

    // 连线（族谱折线：父节点向下引线，横贯各子节点中心，再分别垂直到子节点）
    const paths: string[] = [];
    placed.forEach((node) => {
      if (!node.expanded) return;
      const kids = (model.childrenOf.get(node.id) ?? [])
        .map((cid) => placed.get(cid))
        .filter((k): k is PlacedNode => !!k);
      if (!kids.length) return;
      const y0 = node.top + NODE_H;
      const midY = y0 + (ROW_H - NODE_H) / 2;
      let d = `M ${node.cx} ${y0} V ${midY}`;
      if (kids.length > 1) {
        d += ` M ${kids[0].cx} ${midY} H ${kids[kids.length - 1].cx}`;
      }
      kids.forEach((k) => {
        d += ` M ${k.cx} ${midY} V ${k.top}`;
      });
      paths.push(d);
    });

    // 每行的世代标签
    const rowLabels: { depth: number; title: string }[] = [];
    for (let dpt = 0; dpt <= maxDepth; dpt++) {
      rowLabels.push({ depth: dpt, title: model.genTitles[dpt] || `第${dpt + 1}层` });
    }

    return { nodes: Array.from(placed.values()), paths, width, height, maxDepth, rowLabels, totalShown: placed.size };
  }, [model, collapsed]);

  const toggleNode = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const scrollToId = (id: string) => {
    window.setTimeout(() => {
      const el = document.getElementById(`tree-node-${id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        setFlashId(id);
        window.setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), ANIMATION_DELAYS.HIGHLIGHT_DURATION);
      }
    }, 80);
  };

  // —— 缩放（命令式同步实现，手势事件里直接落 DOM，保证跟手）——
  // 旧实现把缩放值放在 React 状态里、靠渲染后 effect 回调滚动位置对锚点；
  // 双指连续手势下状态与滚动互相追赶，锚点算错，整图乱跑。现改为：
  // 每次手势事件内同步完成「算锚点 → 改 transform/占位尺寸 → 改滚动位置」，无异步环节。
  const MIN_SCALE = 0.15;
  const MAX_SCALE = 3;
  const scrollRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const pctRef = useRef<HTMLSpanElement>(null);
  const zoomRef = useRef(1);
  const padRef = useRef({ l: 0, t: 0 });
  const dragRef = useRef<{ x: number; y: number; sl: number; st: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const applyZoomAt = (next: number, vx: number, vy: number) => {
    const box = scrollRef.current;
    const size = sizeRef.current;
    const cv = canvasRef.current;
    if (!box || !size || !cv) return;
    const s0 = zoomRef.current;
    const s1 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    if (s1 === s0) return;
    // 锚点：当前视口点 (vx, vy) 下的图内坐标，缩放前后必须仍落在该视口点。
    // 图内坐标在滚动内容中的位置要加上四周的补偿边距 pad（见下方边距初始化），
    // 否则贴边时理想滚动量超出可滚范围被浏览器截断，锚点就会漂移。
    const pl = padRef.current.l;
    const pt = padRef.current.t;
    const cx = (box.scrollLeft + vx - pl) / s0;
    const cy = (box.scrollTop + vy - pt) / s0;
    zoomRef.current = s1;
    cv.style.transform = `scale(${s1})`;
    size.style.width = `${layoutRef.current.width * s1}px`;
    size.style.height = `${layoutRef.current.height * s1}px`;
    box.scrollLeft = pl + cx * s1 - vx;
    box.scrollTop = pt + cy * s1 - vy;
    if (pctRef.current) pctRef.current.textContent = `${Math.round(s1 * 100)}%`;
  };

  const zoomStep = (factor: number) => {
    const box = scrollRef.current;
    if (!box) return;
    applyZoomAt(zoomRef.current * factor, box.clientWidth / 2, box.clientHeight / 2);
  };

  const resetZoom = () => {
    const box = scrollRef.current;
    if (!box) return;
    applyZoomAt(1, box.clientWidth / 2, box.clientHeight / 2);
  };

  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = box.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp(-e.deltaY * unit * 0.0016);
      applyZoomAt(zoomRef.current * factor, e.clientX - rect.left, e.clientY - rect.top);
    };

    let pinch: { d0: number; s0: number } | null = null;
    const touchDist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinch = { d0: touchDist(e.touches), s0: zoomRef.current };
        e.preventDefault();
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const rect = box.getBoundingClientRect();
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
        applyZoomAt(pinch.s0 * (touchDist(e.touches) / pinch.d0), mx, my);
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    const onGestureStart = (e: Event) => e.preventDefault();

    box.addEventListener('wheel', onWheel, { passive: false });
    box.addEventListener('touchstart', onTouchStart, { passive: false });
    box.addEventListener('touchmove', onTouchMove, { passive: false });
    box.addEventListener('touchend', onTouchEnd);
    box.addEventListener('touchcancel', onTouchEnd);
    box.addEventListener('gesturestart', onGestureStart);

    // 四周补偿边距：给缩放后的画布外围留一整屏空白，
    // 这样手指/光标贴到图的任一边角时，理想滚动位置都不会被截断。
    const size = sizeRef.current;
    let padInit = false;
    const applyPad = () => {
      if (!size) return;
      const nl = box.clientWidth;
      const nt = box.clientHeight;
      const ol = padRef.current.l;
      const ot = padRef.current.t;
      if (nl === ol && nt === ot && padInit) return;
      size.style.padding = `${nt}px ${nl}px ${nt}px ${nl}px`;
      if (!padInit) {
        padRef.current = { l: nl, t: nt };
        box.scrollLeft = nl;
        box.scrollTop = nt;
        padInit = true;
      } else {
        padRef.current = { l: nl, t: nt };
        box.scrollLeft += nl - ol;
        box.scrollTop += nt - ot;
      }
    };
    applyPad();
    const ro = new ResizeObserver(applyPad);
    ro.observe(box);

    return () => {
      ro.disconnect();
      box.removeEventListener('wheel', onWheel);
      box.removeEventListener('touchstart', onTouchStart);
      box.removeEventListener('touchmove', onTouchMove);
      box.removeEventListener('touchend', onTouchEnd);
      box.removeEventListener('touchcancel', onTouchEnd);
      box.removeEventListener('gesturestart', onGestureStart);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 全文气泡：卡片 info 被截断（显示不全）时才出现；能完整显示的不出 ——
  const [pop, setPop] = useState<{
    id: string; name: string; gen: string; years: string; info: string;
    x: number; y: number; above: boolean; pinned: boolean;
  } | null>(null);

  // 返回是否真的打开了气泡（未截断则不开）。气泡渲染在缩放画布之外、按视口坐标定位，不随缩放变形。
  const openPop = (
    e: { currentTarget: HTMLElement },
    node: { id: string; person: Person; depth: number },
    pinned: boolean
  ): boolean => {
    const card = e.currentTarget;
    const infoEl = card.querySelector('[data-info]') as HTMLElement | null;
    if (!infoEl) return false;
    if (infoEl.scrollHeight <= infoEl.clientHeight + 1) return false; // 显示得下，不出气泡
    const person = node.person;
    const rect = card.getBoundingClientRect();
    const half = 168;
    const x = Math.min(Math.max(rect.left + rect.width / 2, half + 8), window.innerWidth - half - 8);
    const above = rect.top > 300;
    setPop({
      id: person.id,
      name: person.name,
      gen: model.genTitles[node.depth] || '',
      years:
        person.birthYear || person.deathYear
          ? `${person.birthYear || ''}${person.birthYear && person.deathYear ? ' - ' : ''}${person.deathYear || ''}`
          : '',
      info: person.info || '',
      x,
      y: above ? rect.top - 8 : rect.bottom + 8,
      above,
      pinned,
    });
    return true;
  };

  // 气泡打开期间：滚动/缩放/改窗口/Esc 都会让位置失效，直接关闭；钉住的气泡点别处也关
  useEffect(() => {
    if (!pop) return;
    const close = () => setPop(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-pop]') || t.closest(`#tree-node-${pop.id}`)) return;
      close();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('wheel', close, { capture: true, passive: true });
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    if (pop.pinned) window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('wheel', close, { capture: true });
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [pop]);

  // 搜索：按世代顺序找第一个匹配项，展开其全部祖先并滚动定位
  useEffect(() => {
    if (!searchTerm) {
      setFirstMatchId(null);
      return;
    }
    let found: string | null = null;
    outer: for (const g of data.generations) {
      for (const p of g.people) {
        if (p.id && isPersonMatch(p, searchTerm, searchInInfo || false)) {
          found = p.id;
          break outer;
        }
      }
    }
    setFirstMatchId(found);
    if (found) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        let cur = model.parentOf.get(found!);
        while (cur) {
          next.delete(cur);
          cur = model.parentOf.get(cur);
        }
        next.delete(found!);
        return next;
      });
      scrollToId(found);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, searchInInfo, data, model]);

  return (
    <div className="max-w-7xl mx-auto px-4">
      <div className="bg-white rounded-lg shadow-sm p-6">
        <div className="flex flex-wrap items-center gap-3 mb-1">
          <h2 className="text-xl font-bold text-gray-800">家族树状图</h2>
          <div className="flex flex-wrap gap-2 ml-auto items-center">
            <div className="flex items-center rounded-md border border-gray-200 overflow-hidden">
              <button
                type="button"
                onClick={() => zoomStep(1 / 1.25)}
                className="px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                title="缩小"
              >
                −
              </button>
              <button
                type="button"
                onClick={resetZoom}
                className="px-2 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 border-x border-gray-200 min-w-12"
                title="恢复 100%"
              >
                <span ref={pctRef}>100%</span>
              </button>
              <button
                type="button"
                onClick={() => zoomStep(1.25)}
                className="px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                title="放大"
              >
                +
              </button>
            </div>
            <button
              type="button"
              onClick={() => setCollapsed(new Set())}
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-200 text-gray-700 hover:bg-gray-50"
            >
              展开全部
            </button>
            <button
              type="button"
              onClick={() => setCollapsed(model.initialCollapsed)}
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-200 text-gray-700 hover:bg-gray-50"
            >
              收起深层支系
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-400 mb-4">
          世系树：同一代的人在同一行，始祖固定在左上，支系只向右展开；点节点下方圆钮展开/收起支系（+N 为子辈人数）。共 {model.byId.size} 人，当前显示 {layout.totalShown} 人。在图上滚轮或双指捏合可放大缩小（15%–300%），按住拖动平移；信息显示不全的卡片，悬停或点按可看全文气泡。
        </p>
        <div
          className="tree-hscroll rounded-md cursor-grab active:cursor-grabbing select-none"
          ref={scrollRef}
          style={{ height: 'min(80vh, 1200px)' }}
          onPointerDown={(e) => {
            if (e.pointerType !== 'mouse' || e.button !== 0) return;
            const box = scrollRef.current;
            if (!box) return;
            dragRef.current = { x: e.clientX, y: e.clientY, sl: box.scrollLeft, st: box.scrollTop, moved: false };
          }}
          onPointerMove={(e) => {
            const d = dragRef.current;
            const box = scrollRef.current;
            if (!d || !box) return;
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;
            if (!d.moved && Math.hypot(dx, dy) > 4) d.moved = true;
            if (d.moved) {
              box.scrollLeft = d.sl - dx;
              box.scrollTop = d.st - dy;
            }
          }}
          onPointerUp={() => {
            if (dragRef.current?.moved) suppressClickRef.current = true;
            dragRef.current = null;
          }}
          onPointerCancel={() => {
            dragRef.current = null;
          }}
          onClickCapture={(e) => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false;
              e.stopPropagation();
              e.preventDefault();
            }
          }}
        >
          <div ref={sizeRef} className="relative" style={{ width: layout.width * zoomRef.current, height: layout.height * zoomRef.current }}>
            <div
              ref={canvasRef}
              className="relative"
              style={{ width: layout.width, height: layout.height, transform: `scale(${zoomRef.current})`, transformOrigin: '0 0' }}
            >
            <svg
              className="absolute left-0 top-0 pointer-events-none"
              width={layout.width}
              height={layout.height}
              aria-hidden="true"
            >
              {layout.paths.map((d, i) => (
                <path key={i} d={d} fill="none" stroke="#cbd5e1" strokeWidth="1.5" />
              ))}
            </svg>
            {layout.rowLabels.map((rl) => (
              <div
                key={rl.depth}
                className="absolute text-[11px] leading-tight text-gray-400 pr-1"
                style={{ left: 0, top: TOP_PAD + rl.depth * ROW_H + 6, width: GUTTER - 10 }}
                title={rl.title}
              >
                <span className="line-clamp-2">{rl.title}</span>
              </div>
            ))}
            {layout.nodes.map((node) => {
              const isFlash = node.id === flashId || node.id === firstMatchId;
              return (
                <div
                  key={node.id}
                  id={`tree-node-${node.id}`}
                  className={`absolute bg-white border rounded-lg shadow-sm px-2 py-1.5 text-center transition-all duration-300 ${
                    isFlash
                      ? `${CSS_CLASSES.HIGHLIGHT.RING} ${CSS_CLASSES.HIGHLIGHT.RING_COLOR} ${CSS_CLASSES.HIGHLIGHT.BACKGROUND}`
                      : 'border-gray-200'
                  }`}
                  style={{ left: node.cx - NODE_W / 2, top: node.top, width: NODE_W, height: NODE_H }}
                  onMouseEnter={(e) => {
                    if (dragRef.current) return;
                    openPop(e, node, false);
                  }}
                  onMouseLeave={() => {
                    setPop((cur) => (cur && !cur.pinned && cur.id === node.id ? null : cur));
                  }}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('button')) return; // 折叠圆钮不触发气泡
                    if (pop && pop.pinned && pop.id === node.id) {
                      setPop(null);
                      return;
                    }
                    openPop(e, node, true);
                  }}
                >
                  <div className="font-medium text-gray-800 text-sm leading-5 line-clamp-2">
                    <span dangerouslySetInnerHTML={{
                      __html: searchTerm ? highlightMatch(node.person.name, searchTerm) : highlightMatch(node.person.name, '')
                    }} />
                  </div>
                  {(node.person.birthYear || node.person.deathYear) && (
                    <div className="text-[11px] text-gray-400 leading-4">
                      {node.person.birthYear}
                      {node.person.birthYear && node.person.deathYear && ' - '}
                      {node.person.deathYear && (node.person.birthYear ? node.person.deathYear : ` - ${node.person.deathYear}`)}
                    </div>
                  )}
                  {node.person.info && (
                    <div data-info className="text-[11px] text-gray-500 leading-4 mt-1 pt-1 border-t border-gray-100 line-clamp-4 whitespace-pre-line text-left">
                      <span dangerouslySetInnerHTML={{
                        __html: (searchTerm && searchInInfo) ? highlightMatch(node.person.info, searchTerm) : highlightMatch(node.person.info, '')
                      }} />
                    </div>
                  )}
                  {node.hasChildren && (
                    <button
                      type="button"
                      onClick={() => toggleNode(node.id)}
                      title={node.expanded ? '收起支系' : `展开支系（后代共 ${node.descCount} 人）`}
                      className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 h-5 min-w-5 px-1 rounded-full border border-gray-300 bg-white text-[10px] leading-none text-gray-600 shadow-sm hover:bg-blue-50 hover:text-blue-700 z-10"
                    >
                      {node.expanded ? '−' : `+${node.childCount}`}
                    </button>
                  )}
                </div>
              );
            })}
            </div>
          </div>
        </div>
      </div>

      {pop && (
        <div
          data-pop
          className="fixed z-50 w-[320px] max-w-[86vw] rounded-xl border border-amber-200 bg-white p-3 shadow-xl text-left"
          style={{
            left: pop.x,
            top: pop.y,
            transform: `translate(-50%, ${pop.above ? '-100%' : '0'})`,
            pointerEvents: pop.pinned ? 'auto' : 'none',
          }}
          onClick={() => setPop(null)}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-bold text-gray-900">{pop.name}</span>
            {pop.gen && (
              <span className="shrink-0 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-700">{pop.gen}</span>
            )}
          </div>
          {pop.years && <div className="mt-0.5 text-[11px] text-gray-500">{pop.years}</div>}
          <p className="mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-gray-700">
            {pop.info}
          </p>
          {pop.pinned && <div className="mt-1.5 text-right text-[10px] text-gray-400">点任意处关闭</div>}
        </div>
      )}
    </div>
  );
}
