"use client";

import { useState, useEffect, useMemo } from 'react';
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
const NODE_W = 132;          // 节点卡片宽
const NODE_H = 56;           // 节点卡片高
const SLOT_W = 150;          // 每个叶子占的水平槽宽
const ROW_H = 112;           // 每代（行）高度，含连线区
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
      let cx: number;
      if (!expanded) {
        widthSlots = 1;
        cx = GUTTER + (leftSlot + 0.5) * SLOT_W;
      } else {
        let cur = leftSlot;
        kids.forEach((cid) => {
          cur += place(cid, cur, depth + 1);
        });
        widthSlots = Math.max(1, cur - leftSlot);
        cx = GUTTER + (leftSlot + widthSlots / 2) * SLOT_W;
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
          <div className="flex gap-2 ml-auto">
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
          自上而下的世系树：点节点下方圆钮展开/收起支系（+N 为子辈人数）。共 {model.byId.size} 人，当前显示 {layout.totalShown} 人；图太宽时可拖动底部横向滚动条。
        </p>
        <div className="tree-hscroll pb-3">
          <div className="relative" style={{ width: layout.width, height: layout.height }}>
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
                  title={node.person.name}
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
  );
}
