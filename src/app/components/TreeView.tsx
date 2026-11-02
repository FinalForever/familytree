"use client";

import { useState, useEffect, useMemo } from 'react';
import { FamilyData, Person } from '@/types/family';
import { ChevronDownIcon, ChevronRightIcon, UserIcon, CalendarIcon } from '@heroicons/react/24/outline';
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

interface BandPerson {
  person: Person;
  father?: Person;
  childCount: number;
  sortKey: number[];
  dataIndex: number;
}

interface Band {
  title: string;
  people: BandPerson[];
}

const cmpKey = (a: number[], b: number[]): number => {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
};

// 世系表式排版：按数据里的「世」分带（同一世的人聚在一起），
// 世内按支系路径排序——从始祖出发、沿每代兄弟序号组成的路径比较，
// 保证同父的兄弟相邻、同一支系的人聚拢、长幼有序。
// 旧做法是深度优先的嵌套列表：幼子要排在其兄长全部后代之后，
// 人一多，第二世的幼子会被挤到上千人之后，看起来像排错了世。
function buildBands(data: FamilyData): { bands: Band[]; genOf: Map<string, number> } {
  const byId = new Map<string, Person>();
  const genOf = new Map<string, number>();
  const dataIndexOf = new Map<string, number>();
  let di = 0;
  data.generations.forEach((g, gi) => {
    g.people.forEach((p) => {
      if (p.id && !byId.has(p.id)) {
        byId.set(p.id, p);
        genOf.set(p.id, gi);
        dataIndexOf.set(p.id, di++);
      }
    });
  });

  const childrenOf = new Map<string, string[]>();
  byId.forEach((_, id) => childrenOf.set(id, []));
  const roots: string[] = [];
  data.generations.forEach((g) => {
    g.people.forEach((p) => {
      if (!p.id || byId.get(p.id) !== p) return;
      const fid = p.fatherId;
      if (fid && fid !== p.id && byId.has(fid)) {
        childrenOf.get(fid)!.push(p.id);
      } else {
        roots.push(p.id);
      }
    });
  });

  // 从根出发给每个人算一条支系路径（每代的兄弟序号）
  const keyOf = new Map<string, number[]>();
  const visited = new Set<string>();
  const walk = (id: string, path: number[]) => {
    if (visited.has(id)) return;
    visited.add(id);
    keyOf.set(id, path);
    childrenOf.get(id)!.forEach((cid, k) => walk(cid, [...path, k]));
  };
  roots.forEach((rid, r) => walk(rid, [r]));

  const bands: Band[] = data.generations.map((g) => {
    const seen = new Set<string>();
    const people: BandPerson[] = [];
    g.people.forEach((p) => {
      if (!p.id || seen.has(p.id)) return;
      seen.add(p.id);
      const father = p.fatherId && p.fatherId !== p.id ? byId.get(p.fatherId) : undefined;
      people.push({
        person: p,
        father,
        childCount: childrenOf.get(p.id)?.length ?? 0,
        sortKey: keyOf.get(p.id) ?? [Number.MAX_SAFE_INTEGER, dataIndexOf.get(p.id) ?? 0],
        dataIndex: dataIndexOf.get(p.id) ?? 0,
      });
    });
    people.sort((a, b) => cmpKey(a.sortKey, b.sortKey) || a.dataIndex - b.dataIndex);
    return { title: g.title, people };
  });

  return { bands, genOf };
}

export default function TreeView({ data, searchTerm, searchInInfo }: TreeViewProps) {
  const { bands, genOf } = useMemo(() => buildBands(data), [data]);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [firstMatchId, setFirstMatchId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);

  // 按世从早到晚找第一个搜索匹配项
  useEffect(() => {
    if (!searchTerm) {
      setFirstMatchId(null);
      return;
    }
    let found: string | null = null;
    for (const band of bands) {
      for (const bp of band.people) {
        if (isPersonMatch(bp.person, searchTerm, searchInInfo || false)) {
          found = bp.person.id || null;
          break;
        }
      }
      if (found) break;
    }
    setFirstMatchId(found);
  }, [searchTerm, searchInInfo, bands]);

  const scrollToId = (id: string, genIdx?: number) => {
    if (genIdx !== undefined) {
      setCollapsed((prev) => {
        if (!prev.has(genIdx)) return prev;
        const next = new Set(prev);
        next.delete(genIdx);
        return next;
      });
    }
    window.setTimeout(() => {
      const el = document.getElementById(`tree-person-${id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setFlashId(id);
        window.setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), ANIMATION_DELAYS.HIGHLIGHT_DURATION);
      }
    }, 60);
  };

  // 第一个匹配项自动滚动定位
  useEffect(() => {
    if (firstMatchId) {
      scrollToId(firstMatchId, genOf.get(firstMatchId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstMatchId]);

  const toggleBand = (gi: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(gi)) next.delete(gi);
      else next.add(gi);
      return next;
    });
  };

  return (
    <div className="max-w-7xl mx-auto px-4">
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-xl font-bold text-gray-800">家族树状图</h2>
        <p className="text-xs text-gray-400 mt-1 mb-4">
          按世排列：同一世的人聚在一起，世内按支系长幼排序；点击「父：某」可跳到父亲所在行。
        </p>
        <div className="tree-hscroll pb-3">
          <div className="w-max min-w-full" style={{ minWidth: '760px' }}>
            {bands.map((band, gi) => (
              <div key={gi} className="mb-2">
                <button
                  type="button"
                  onClick={() => toggleBand(gi)}
                  className="flex items-center gap-2 w-full text-left py-2 border-b border-gray-200 hover:bg-gray-50 rounded-md px-1"
                >
                  {collapsed.has(gi) ? (
                    <ChevronRightIcon className="h-4 w-4 text-gray-400" />
                  ) : (
                    <ChevronDownIcon className="h-4 w-4 text-gray-400" />
                  )}
                  <span className="font-bold text-gray-800">{band.title}</span>
                  <span className="text-xs text-gray-400">{band.people.length} 人</span>
                </button>
                {!collapsed.has(gi) &&
                  band.people.map((bp) => {
                    const person = bp.person;
                    const isFirst = person.id === firstMatchId;
                    const isFlash = person.id === flashId || isFirst;
                    return (
                      <div
                        key={person.id}
                        id={`tree-person-${person.id}`}
                        className={`flex items-start py-2 px-1 rounded-md transition-all duration-300 ${
                          isFlash
                            ? `${CSS_CLASSES.HIGHLIGHT.RING} ${CSS_CLASSES.HIGHLIGHT.RING_COLOR} ${CSS_CLASSES.HIGHLIGHT.BACKGROUND}`
                            : ''
                        }`}
                      >
                        <div className="bg-blue-50 p-1 rounded-md mr-2 mt-0.5 shrink-0">
                          <UserIcon className="h-4 w-4 text-blue-600" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                            <span className="font-medium text-gray-800">
                              <span dangerouslySetInnerHTML={{
                                __html: searchTerm ? highlightMatch(person.name, searchTerm) : highlightMatch(person.name, '')
                              }} />
                            </span>
                            {bp.father && (
                              <button
                                type="button"
                                onClick={() => bp.father!.id && scrollToId(bp.father!.id, genOf.get(bp.father!.id))}
                                className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
                              >
                                父：{bp.father.name}
                              </button>
                            )}
                            {bp.childCount > 0 && (
                              <span className="text-xs text-green-600">子嗣 {bp.childCount} 人</span>
                            )}
                            {(person.birthYear || person.deathYear) && (
                              <span className="inline-flex items-center gap-1 text-gray-500 text-xs">
                                <CalendarIcon className="h-3 w-3" />
                                <span>
                                  {person.birthYear}
                                  {person.birthYear && person.deathYear && ' - '}
                                  {person.deathYear && (person.birthYear ? person.deathYear : ` - ${person.deathYear}`)}
                                </span>
                              </span>
                            )}
                          </div>
                          {person.info && (
                            <p className="text-gray-600 text-sm mt-0.5 max-w-3xl whitespace-pre-line">
                              <span dangerouslySetInnerHTML={{
                                __html: (searchTerm && searchInInfo) ? highlightMatch(person.info, searchTerm) : highlightMatch(person.info, '')
                              }} />
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
