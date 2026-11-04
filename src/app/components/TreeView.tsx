"use client";

import { useState, useEffect, useMemo, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
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

  // 世代标尺点击定位的逐世轮转记忆（depth -> 下一位下标）；数据变化时清空
  const genCycleRef = useRef<Map<number, number>>(new Map());
  useEffect(() => {
    genCycleRef.current.clear();
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

  // —— 世代标尺点击定位：逐个轮转本世当前已渲染的成员 ——
  // 顺序按布局横坐标 cx 升序（槽位从左到右），即从离标尺最近的一位开始；
  // 被折叠隐藏的成员不在 layout.nodes 里，天然不参与轮转。
  // 轮转下标按世代分别记在 genCycleRef 里，手动拖动/缩放不会重置（ref 不随渲染变），
  // 点到末位后绕回第一位（下标对成员数取模）。
  const FOCUS_FLASH_MS = 1200; // 定位高亮时长，与搜索用的 2 秒区分
  const focusNextInGeneration = (depth: number) => {
    const box = scrollRef.current;
    if (!box) return;
    const members = layoutRef.current.nodes
      .filter((n) => n.depth === depth)
      .sort((a, b) => a.cx - b.cx);
    if (!members.length) return;
    const idx = (genCycleRef.current.get(depth) ?? 0) % members.length;
    genCycleRef.current.set(depth, idx + 1);
    const node = members[idx];
    const s = zoomRef.current;
    // 居中公式与 applyZoomAt 的滚动换算同属一个坐标系：内容点 (cx, cy) 在滚动
    // 内容中的位置 = pad + coord * zoom（pad 为四周补偿边距），让它落到视口正中，
    // 即 scroll = pad + coord * zoom - 视口尺寸 / 2。pad 有一整屏大小，目标滚动量
    // 恒在可达范围内，不会被浏览器截断，居中不会偏。
    // 目标点再过一遍边界钳制（见 clampScroll）：按包围盒几何，成员居中目标恒在
    // 界内（横向余量 >= 88*s + vw/2 - mx > 0，纵向 >= 64*s + vh/2 - my > 0），
    // 这里只是防御性收口，实际不会改动落点。
    const [fl, ft] = clampScroll(
      padRef.current.l + node.cx * s - box.clientWidth / 2,
      padRef.current.t + (node.top + NODE_H / 2) * s - box.clientHeight / 2,
      s
    );
    box.scrollTo({ left: fl, top: ft, behavior: 'smooth' });
    setFlashId(node.id);
    window.setTimeout(() => setFlashId((cur) => (cur === node.id ? null : cur)), FOCUS_FLASH_MS);
  };

  // 标尺标签可点击后，从标签上起手的拖动不能丢：标签自己接管指针，
  // 位移超过阈值就把拖动转发成图框滚动（等价于在图上拖动平移），
  // 按下-抬起位移 < 8px 才算一次点击、触发定位。
  const labelDragRef = useRef<{ depth: number; x: number; y: number; sl: number; st: number; panning: boolean } | null>(null);
  const onLabelPointerDown = (e: ReactPointerEvent<HTMLElement>, depth: number) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const box = scrollRef.current;
    if (!box) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    labelDragRef.current = { depth, x: e.clientX, y: e.clientY, sl: box.scrollLeft, st: box.scrollTop, panning: false };
  };
  const onLabelPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = labelDragRef.current;
    const box = scrollRef.current;
    if (!d || !box) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.panning && Math.hypot(dx, dy) > 4) d.panning = true;
    if (d.panning) {
      const [cl, ct] = clampScroll(d.sl - dx, d.st - dy, zoomRef.current);
      box.scrollLeft = cl;
      box.scrollTop = ct;
    }
  };
  const onLabelPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = labelDragRef.current;
    labelDragRef.current = null;
    if (!d) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) focusNextInGeneration(d.depth);
  };
  const onLabelPointerCancel = () => {
    labelDragRef.current = null;
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
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const labelInnerRef = useRef<HTMLDivElement>(null);
  // 世代标尺冻结在图框左缘：横向滚动不带走它，纵向位置随画布滚动/缩放同步
  const syncLabels = () => {
    const box = scrollRef.current;
    const inner = labelInnerRef.current;
    const layer = labelLayerRef.current;
    if (!box || !inner || !layer) return;
    const sc = zoomRef.current;
    inner.style.transform = `translateY(${padRef.current.t - box.scrollTop}px) scale(${sc})`;
    layer.style.width = `${Math.max(GUTTER * sc, 40)}px`;
  };
  const dragRef = useRef<{ x: number; y: number; sl: number; st: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // —— 滚动边界约束：内容不许被拖/滚出整屏空白 ——
  // 不变量：任意滚动/缩放状态下，已渲染节点包围盒与图框视口在横、纵两轴上的
  // 重叠都不小于 min(160px, 视口该轴长的 1/3)。pad 仍保留一整屏（缩放锚点
  // 需要，见 applyZoomAt），但所有写 scrollLeft/scrollTop 的路径都先过这里钳制，
  // 另有 onScroll 安全网兜住原生触摸/键盘滚动。到达边界硬停，无橡皮筋动画。
  // 钳制对缩放锚点的影响：只要缩放前视图满足不变量（本钳制归纳保证），光标
  // 落在真实内容上时理想滚动量恒在界内、锚点精确零截断；仅当光标悬在内容外
  // 的空白边距上时理想量才可能越界被钳，单步偏差 <= (轴长 - m) * (s1/s0 - 1)，
  // 且每步都从实际滚动位置重新算锚点，偏差不累积。
  const OVERLAP_MIN = 160;
  const clampScroll = (sl: number, st: number, s: number): [number, number] => {
    const box = scrollRef.current;
    const nodes = layoutRef.current.nodes;
    if (!box || !nodes.length) return [sl, st];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    nodes.forEach((n) => {
      x0 = Math.min(x0, n.cx - NODE_W / 2);
      x1 = Math.max(x1, n.cx + NODE_W / 2);
      y0 = Math.min(y0, n.top);
      y1 = Math.max(y1, n.top + NODE_H);
    });
    const vw = box.clientWidth;
    const vh = box.clientHeight;
    const mx = Math.min(OVERLAP_MIN, vw / 3);
    const my = Math.min(OVERLAP_MIN, vh / 3);
    const pl = padRef.current.l;
    const pt = padRef.current.t;
    // 视口左沿在 sl 时，横向重叠 = min(pl + x1*s, sl + vw) - max(pl + x0*s, sl)。
    // 令重叠 >= mx：内容左沿滑出右侧时 sl >= pl + x0*s + mx - vw（下限），
    // 内容右沿滑出左侧时 sl <= pl + x1*s - mx（上限）。纵向同理。
    // 因 mx <= 轴长/3，下限恒 <= 上限，钳制区间永不为空。
    const slMin = pl + x0 * s + mx - vw;
    const slMax = pl + x1 * s - mx;
    const stMin = pt + y0 * s + my - vh;
    const stMax = pt + y1 * s - my;
    return [
      Math.max(slMin, Math.min(sl, slMax)),
      Math.max(stMin, Math.min(st, stMax)),
    ];
  };
  // 安全网：把当前滚动位置拉回界内（只在越界时写，写后必收敛，不会循环）
  const applyClamp = () => {
    const box = scrollRef.current;
    if (!box) return;
    const [cl, ct] = clampScroll(box.scrollLeft, box.scrollTop, zoomRef.current);
    if (cl !== box.scrollLeft) box.scrollLeft = cl;
    if (ct !== box.scrollTop) box.scrollTop = ct;
  };

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
    // 写入前按新缩放比钳制：锚点在内容上时恒不触发（见 clampScroll 注释），
    // 只有锚点落在内容外空白边距时才以边界优先，保证缩放后不留整屏空白。
    const [zl, zt] = clampScroll(pl + cx * s1 - vx, pt + cy * s1 - vy, s1);
    box.scrollLeft = zl;
    box.scrollTop = zt;
    syncLabels();
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

    // 标尺标签可点击后，滚轮落在标签上不再透传到图框（标签开始拦截指针事件）：
    // 在标尺层加原生滚轮监听，按与图框滚轮完全相同的公式把缩放转发过去
    //（标尺层与图框左上角重合，视口坐标换算一致）。标签之外的标尺区域仍是
    // pointer-events:none，滚轮会直接落到图框，走原有监听，不会重复触发。
    const layer = labelLayerRef.current;
    const onLayerWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = box.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp(-e.deltaY * unit * 0.0016);
      applyZoomAt(zoomRef.current * factor, e.clientX - rect.left, e.clientY - rect.top);
    };
    if (layer) layer.addEventListener('wheel', onLayerWheel, { passive: false });

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
    applyClamp();
    syncLabels();
    const ro = new ResizeObserver(() => {
      applyPad();
      applyClamp();
      syncLabels();
    });
    ro.observe(box);

    return () => {
      ro.disconnect();
      box.removeEventListener('wheel', onWheel);
      box.removeEventListener('touchstart', onTouchStart);
      box.removeEventListener('touchmove', onTouchMove);
      box.removeEventListener('touchend', onTouchEnd);
      box.removeEventListener('touchcancel', onTouchEnd);
      box.removeEventListener('gesturestart', onGestureStart);
      if (layer) layer.removeEventListener('wheel', onLayerWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // 布局变化（展开/折叠）会改变包围盒，旧滚动位置可能越出新边界，先钳回再同步标尺
    applyClamp();
    syncLabels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

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
        const seen = new Set<string>();
        while (cur && !seen.has(cur)) {
          // 防环：数据被改出父子环时也不能死循环（服务端另有结构校验，这里是前端兜底）
          seen.add(cur);
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
          世系树：同一代的人在同一行，始祖固定在左上，支系只向右展开；点节点下方圆钮展开/收起支系（+N 为子辈人数）。共 {model.byId.size} 人，当前显示 {layout.totalShown} 人。在图上滚轮或双指捏合可放大缩小（15%–300%），按住拖动平移（有边界，不会拖出整屏空白）；左侧世代标尺固定不动，横向滑远了也能对照世代，点击标尺上的某个世代会逐个定位到本世成员（再点一次跳到下一位）；信息显示不全的卡片，悬停或点按可看全文气泡。
        </p>
        <div className="relative">
        <div
          className="tree-hscroll rounded-md cursor-grab active:cursor-grabbing select-none"
          ref={scrollRef}
          onScroll={() => { applyClamp(); syncLabels(); }}
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
              const [cl, ct] = clampScroll(d.sl - dx, d.st - dy, zoomRef.current);
              box.scrollLeft = cl;
              box.scrollTop = ct;
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
        <div
          ref={labelLayerRef}
          className="pointer-events-none absolute left-0 top-0 bottom-0 overflow-hidden border-r border-gray-100 bg-white/95"
          style={{ width: GUTTER }}
        >
          <div ref={labelInnerRef} className="relative" style={{ transformOrigin: '0 0', width: GUTTER, height: layout.height }}>
            {layout.rowLabels.map((rl) => (
              <button
                key={rl.depth}
                type="button"
                title="点击定位本世成员，再点跳下一位"
                className="pointer-events-auto touch-none absolute text-left text-[11px] leading-tight text-gray-400 pr-1 cursor-pointer hover:text-blue-600"
                style={{ left: 0, top: TOP_PAD + rl.depth * ROW_H + 6, width: GUTTER - 10 }}
                onPointerDown={(e) => onLabelPointerDown(e, rl.depth)}
                onPointerMove={onLabelPointerMove}
                onPointerUp={onLabelPointerUp}
                onPointerCancel={onLabelPointerCancel}
              >
                <span className="line-clamp-2">{rl.title}</span>
              </button>
            ))}
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
