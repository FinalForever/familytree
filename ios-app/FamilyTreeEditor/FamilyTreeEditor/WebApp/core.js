/*
 * 族谱编写 - 核心逻辑（纯函数，无 DOM 依赖）
 * 浏览器通过 window.FTCore 使用；Node 测试通过 require 使用。
 * 数据格式与 familytree 网站 config/family-data.json 完全一致。
 */
(function (global) {
  'use strict';

  var ALLOWED_KEYS = ['id', 'name', 'info', 'birthYear', 'deathYear', 'spouse', 'fatherId'];

  /* ---------------- 中文数字 ---------------- */
  var CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  function chineseNumeral(n) {
    if (n <= 0) return String(n);
    if (n < 10) return CN_DIGITS[n];
    if (n < 100) {
      var tens = Math.floor(n / 10), ones = n % 10;
      return (tens === 1 ? '' : CN_DIGITS[tens]) + '十' + (ones ? CN_DIGITS[ones] : '');
    }
    if (n < 1000) {
      var h = Math.floor(n / 100), rest = n % 100;
      var s = CN_DIGITS[h] + '百';
      if (rest === 0) return s;
      if (rest < 10) return s + '零' + CN_DIGITS[rest];
      return s + chineseNumeral(rest);
    }
    return String(n);
  }
  function genTitle(n) { return '第' + chineseNumeral(n) + '世'; }

  /* ---------------- id 生成 ---------------- */
  var idSeq = 0;
  function genId(existingIds) {
    var id;
    do {
      idSeq += 1;
      id = 'p-' + Date.now().toString(36) + '-' + idSeq.toString(36) + Math.floor(Math.random() * 1296).toString(36);
    } while (existingIds && existingIds.has(id));
    return id;
  }

  /* ---------------- 索引 ---------------- */
  function buildIndex(data) {
    var map = new Map();
    (data.generations || []).forEach(function (g, gi) {
      (g.people || []).forEach(function (p, oi) {
        if (p && typeof p.id === 'string' && !map.has(p.id)) {
          map.set(p.id, { person: p, genIndex: gi, order: oi });
        }
      });
    });
    return map;
  }
  function allIds(data) { return new Set(buildIndex(data).keys()); }
  function countPeople(data) {
    return (data.generations || []).reduce(function (s, g) { return s + (g.people ? g.people.length : 0); }, 0);
  }
  function childrenMap(data) {
    var idx = buildIndex(data);
    var map = new Map();
    idx.forEach(function (rec, id) {
      var f = rec.person.fatherId;
      if (typeof f === 'string' && f && idx.has(f) && f !== id) {
        if (!map.has(f)) map.set(f, []);
        map.get(f).push(id);
      }
    });
    map.forEach(function (list) {
      list.sort(function (a, b) {
        var ra = idx.get(a), rb = idx.get(b);
        return ra.genIndex - rb.genIndex || ra.order - rb.order;
      });
    });
    return map;
  }
  function sortedByGenOrder(idx) {
    return function (a, b) {
      var ra = idx.get(a), rb = idx.get(b);
      return ra.genIndex - rb.genIndex || ra.order - rb.order;
    };
  }

  /* ---------------- 校验（与网站 validateFamilyData 对齐，并细化报错） ---------------- */
  function validateData(data) {
    var errors = [], warnings = [];
    if (!data || typeof data !== 'object' || !Array.isArray(data.generations)) {
      errors.push({ type: 'structure', msg: '数据结构不对：缺少 generations 数组' });
      return { errors: errors, warnings: warnings };
    }
    var ids = new Set(), parentOf = new Map(), idx = new Map();
    data.generations.forEach(function (g, gi) {
      if (!g || !Array.isArray(g.people)) {
        errors.push({ type: 'structure', genIndex: gi, msg: '第 ' + (gi + 1) + ' 世的 people 不是数组' });
        return;
      }
      g.people.forEach(function (p, oi) {
        if (!p || typeof p !== 'object') {
          errors.push({ type: 'structure', genIndex: gi, msg: '第 ' + (gi + 1) + ' 世第 ' + (oi + 1) + ' 人不是对象' });
          return;
        }
        if (typeof p.id !== 'string' || !p.id) {
          errors.push({ type: 'id', genIndex: gi, msg: '第 ' + (gi + 1) + ' 世有一名成员缺少 id' });
          return;
        }
        if (ids.has(p.id)) {
          errors.push({ type: 'dup-id', personId: p.id, genIndex: gi, msg: 'id 重复：' + p.id + '（' + (p.name || '') + '）' });
        }
        ids.add(p.id);
        if (!idx.has(p.id)) idx.set(p.id, { person: p, genIndex: gi, order: oi });
        if (typeof p.name !== 'string') {
          errors.push({ type: 'name', personId: p.id, genIndex: gi, msg: '成员 ' + p.id + ' 的姓名不是字符串' });
        } else if (!p.name.trim()) {
          errors.push({ type: 'name', personId: p.id, genIndex: gi, msg: '有一名成员姓名为空（id: ' + p.id + '）' });
        }
        if (typeof p.fatherId === 'string' && p.fatherId) {
          if (p.fatherId === p.id) {
            errors.push({ type: 'father-self', personId: p.id, genIndex: gi, msg: (p.name || p.id) + ' 的父亲指向了自己' });
          } else {
            parentOf.set(p.id, p.fatherId);
          }
        }
      });
    });
    // 父亲不存在 + 世代错位警告
    parentOf.forEach(function (fid, id) {
      var rec = idx.get(id);
      if (!ids.has(fid)) {
        errors.push({ type: 'father-missing', personId: id, genIndex: rec ? rec.genIndex : 0, msg: (rec && rec.person.name || id) + ' 的父亲 id「' + fid + '」在数据中不存在' });
        return;
      }
      var frec = idx.get(fid);
      if (rec && frec && rec.genIndex !== frec.genIndex + 1) {
        warnings.push({ type: 'gen-mismatch', personId: id, genIndex: rec.genIndex, msg: (rec.person.name || id) + ' 在第 ' + (rec.genIndex + 1) + ' 世，但其父 ' + (frec.person.name || fid) + ' 在第 ' + (frec.genIndex + 1) + ' 世（不是父的下一世）' });
      }
    });
    // 父链成环
    parentOf.forEach(function (_f, id) {
      var seen = new Set([id]);
      var cur = parentOf.get(id);
      while (cur && parentOf.has(cur)) {
        if (seen.has(cur)) {
          var rec = idx.get(id);
          errors.push({ type: 'cycle', personId: id, genIndex: rec ? rec.genIndex : 0, msg: '父链成环：从 ' + (rec && rec.person.name || id) + ' 沿父亲向上会绕回' });
          break;
        }
        seen.add(cur);
        cur = parentOf.get(cur);
      }
    });
    return { errors: errors, warnings: warnings };
  }

  /* 与网站 validateFamilyData 完全等价的布尔校验 */
  function validateLikeWebsite(data) {
    if (!data || typeof data !== 'object') return false;
    var generations = data.generations;
    if (!Array.isArray(generations)) return false;
    var ids = new Set(), parentOf = new Map();
    for (var gi = 0; gi < generations.length; gi++) {
      var g = generations[gi];
      if (!g || !Array.isArray(g.people)) return false;
      for (var oi = 0; oi < g.people.length; oi++) {
        var p = g.people[oi];
        if (!p || typeof p.id !== 'string' || !p.id || typeof p.name !== 'string') return false;
        if (ids.has(p.id)) return false;
        ids.add(p.id);
        if (typeof p.fatherId === 'string' && p.fatherId && p.fatherId !== p.id) parentOf.set(p.id, p.fatherId);
      }
    }
    for (var entries = Array.from(parentOf.keys()), k = 0; k < entries.length; k++) {
      var seen = new Set([entries[k]]);
      var cur = parentOf.get(entries[k]);
      while (cur && parentOf.has(cur)) {
        if (seen.has(cur)) return false;
        seen.add(cur);
        cur = parentOf.get(cur);
      }
    }
    return true;
  }

  /* ---------------- 导入解析（不合规给出明确错误，不静默） ---------------- */
  function parseImport(text) {
    var raw;
    try { raw = JSON.parse(text); }
    catch (e) { return { ok: false, errors: [{ type: 'json', msg: 'JSON 解析失败：' + e.message }] }; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, errors: [{ type: 'structure', msg: '文件内容不是一个 JSON 对象' }] };
    }
    if (!Array.isArray(raw.generations)) {
      return { ok: false, errors: [{ type: 'structure', msg: '缺少 generations 数组，这不是族谱数据文件' }] };
    }
    var problems = [];
    var data = { generations: [] };
    raw.generations.forEach(function (g, gi) {
      if (!g || typeof g !== 'object' || !Array.isArray(g.people)) {
        problems.push({ type: 'structure', genIndex: gi, msg: '第 ' + (gi + 1) + ' 世结构不对：people 必须是数组' });
        data.generations.push({ title: genTitle(gi + 1), people: [] });
        return;
      }
      var gen = { title: (typeof g.title === 'string' && g.title) ? g.title : genTitle(gi + 1), people: [] };
      g.people.forEach(function (p, oi) {
        var clean = cleanPerson(p, gi, oi, problems);
        if (clean) gen.people.push(clean);
      });
      data.generations.push(gen);
    });
    var v = validateData(data);
    var all = problems.concat(v.errors);
    if (all.length) return { ok: false, errors: all, data: data, warnings: v.warnings };
    return { ok: true, data: data, warnings: v.warnings };
  }
  function cleanPerson(p, gi, oi, problems) {
    var where = '第 ' + (gi + 1) + ' 世第 ' + (oi + 1) + ' 人';
    if (!p || typeof p !== 'object') { problems.push({ type: 'structure', msg: where + '不是对象，已跳过' }); return null; }
    if (typeof p.id !== 'string' || !p.id) { problems.push({ type: 'id', msg: where + '（' + (p.name || '无名') + '）缺少合法 id，无法导入' }); return null; }
    if (typeof p.name !== 'string') { problems.push({ type: 'name', msg: where + '（id: ' + p.id + '）姓名缺失或不是字符串' }); return null; }
    var out = { id: p.id, name: p.name };
    if (typeof p.info === 'string' && p.info) out.info = p.info;
    ['birthYear', 'deathYear'].forEach(function (key) {
      var val = p[key];
      if (val === undefined || val === null || val === '') return;
      var num = (typeof val === 'number') ? val : (typeof val === 'string' && val.trim() !== '' ? Number(val) : NaN);
      if (typeof num === 'number' && isFinite(num)) out[key] = num;
      else problems.push({ type: 'year', personId: p.id, msg: (p.name || p.id) + ' 的 ' + key + ' 不是数字：' + JSON.stringify(val) });
    });
    if (typeof p.spouse === 'string' && p.spouse) out.spouse = p.spouse;
    if (typeof p.fatherId === 'string' && p.fatherId) out.fatherId = p.fatherId;
    return out;
  }

  /* ---------------- 导出序列化（键集合严格限定，不带多余键） ---------------- */
  function serialize(data) {
    var out = { generations: [] };
    (data.generations || []).forEach(function (g, gi) {
      var gen = { title: (typeof g.title === 'string' && g.title) ? g.title : genTitle(gi + 1), people: [] };
      (g.people || []).forEach(function (p) {
        var o = { id: p.id, name: p.name };
        if (typeof p.info === 'string' && p.info) o.info = p.info;
        if (typeof p.birthYear === 'number' && isFinite(p.birthYear)) o.birthYear = p.birthYear;
        if (typeof p.deathYear === 'number' && isFinite(p.deathYear)) o.deathYear = p.deathYear;
        if (typeof p.spouse === 'string' && p.spouse) o.spouse = p.spouse;
        if (typeof p.fatherId === 'string' && p.fatherId) o.fatherId = p.fatherId;
        gen.people.push(o);
      });
      out.generations.push(gen);
    });
    return out;
  }
  function toExportJSON(data) { return JSON.stringify(serialize(data), null, 2); }

  /* ---------------- 亲属关系 ---------------- */
  function descendantCount(data, id) {
    var kids = childrenMap(data), count = 0, stack = (kids.get(id) || []).slice(), seen = new Set();
    while (stack.length) {
      var cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur); count++;
      (kids.get(cur) || []).forEach(function (c) { stack.push(c); });
    }
    return count;
  }
  function ancestorsOf(data, id) {
    var idx = buildIndex(data), out = [], seen = new Set([id]);
    var cur = idx.get(id);
    while (cur && typeof cur.person.fatherId === 'string' && cur.person.fatherId && idx.has(cur.person.fatherId)) {
      var f = cur.person.fatherId;
      if (seen.has(f)) break;
      seen.add(f); out.push(f);
      cur = idx.get(f);
    }
    return out;
  }
  function searchPeople(data, query) {
    var q = String(query || '').trim();
    if (!q) return [];
    var out = [];
    (data.generations || []).forEach(function (g) {
      (g.people || []).forEach(function (p) {
        if ((p.name && p.name.indexOf(q) !== -1) || (p.info && p.info.indexOf(q) !== -1)) out.push(p.id);
      });
    });
    return out;
  }

  /* ---------------- 树布局（纯函数） ----------------
   * 整齐树：子女按 fatherId 归组并按（世代序, 世内序）排列；
   * 每个可见叶子占一个槽位，父节点 x = 其最左可见子孙的槽位；行 = 所在世代序。
   * collapsed: Set<id> 被折叠的节点（其子孙不出现，节点本身按叶子占槽）。
   */
  function layoutTree(data, collapsed) {
    collapsed = collapsed || new Set();
    var idx = buildIndex(data);
    var kids = childrenMap(data);
    var cmp = sortedByGenOrder(idx);
    var roots = [];
    idx.forEach(function (rec, id) {
      var f = rec.person.fatherId;
      if (!(typeof f === 'string' && f && idx.has(f) && f !== id)) roots.push(id);
    });
    roots.sort(cmp);
    var nodes = new Map();   // id -> {slot, row, collapsed, hiddenCount}
    var edges = [];          // {from, to}
    var visited = new Set();
    var excluded = new Set(); // 被折叠祖先藏起来的人：不参与布局，也不能被兜底逻辑当成根
    var nextSlot = 0;
    function countDesc(id) {
      var c = 0, st = (kids.get(id) || []).slice(), sn = new Set();
      while (st.length) { var x = st.pop(); if (sn.has(x)) continue; sn.add(x); c++; (kids.get(x) || []).forEach(function (y) { st.push(y); }); }
      return c;
    }
    function visit(id, parentId) {
      if (visited.has(id)) return -1;
      visited.add(id);
      var rec = idx.get(id);
      var childIds = kids.get(id) || [];
      var isCollapsed = collapsed.has(id) && childIds.length > 0;
      if (isCollapsed) {
        var st = childIds.slice(), sn = new Set();
        while (st.length) {
          var x = st.pop();
          if (sn.has(x)) continue;
          sn.add(x); excluded.add(x);
          (kids.get(x) || []).forEach(function (y) { st.push(y); });
        }
      }
      var mySlot;
      if (isCollapsed || childIds.length === 0) {
        mySlot = nextSlot++;
      } else {
        var firstSlot = -1;
        childIds.forEach(function (cid) {
          var s = visit(cid, id);
          if (firstSlot === -1 && s !== -1) firstSlot = s;
        });
        mySlot = firstSlot === -1 ? nextSlot++ : firstSlot;
      }
      nodes.set(id, {
        slot: mySlot,
        row: rec.genIndex,
        collapsed: isCollapsed,
        childCount: childIds.length,
        hiddenCount: isCollapsed ? countDesc(id) : 0
      });
      if (parentId) edges.push({ from: parentId, to: id });
      return mySlot;
    }
    roots.forEach(function (r) { visit(r, null); });
    // 兜底：未被访问且不是被折叠藏起来的人（例如其父链断裂成孤岛）按序追加为根
    var rest = [];
    idx.forEach(function (_rec, id) { if (!visited.has(id) && !excluded.has(id)) rest.push(id); });
    rest.sort(cmp);
    rest.forEach(function (r) { visit(r, null); });
    return { nodes: nodes, edges: edges, rows: (data.generations || []).length, cols: nextSlot };
  }

  /* 默认展开深度：返回应折叠的节点集合（深度 > maxDepth 的子孙藏起来的边界节点不折叠，
     而是把“深度 == maxDepth 且有子女”的节点折叠） */
  function defaultCollapsed(data, maxDepth) {
    var idx = buildIndex(data);
    var kids = childrenMap(data);
    var depth = new Map();
    var roots = [];
    idx.forEach(function (rec, id) {
      var f = rec.person.fatherId;
      if (!(typeof f === 'string' && f && idx.has(f) && f !== id)) roots.push(id);
    });
    var queue = roots.map(function (id) { return { id: id, d: 1 }; });
    roots.forEach(function (id) { depth.set(id, 1); });
    var seen = new Set(roots);
    while (queue.length) {
      var item = queue.shift();
      (kids.get(item.id) || []).forEach(function (c) {
        if (!seen.has(c)) { seen.add(c); depth.set(c, item.d + 1); queue.push({ id: c, d: item.d + 1 }); }
      });
    }
    var collapsed = new Set();
    depth.forEach(function (d, id) {
      if (d === maxDepth && (kids.get(id) || []).length > 0) collapsed.add(id);
    });
    return collapsed;
  }

  var FTCore = {
    ALLOWED_KEYS: ALLOWED_KEYS,
    chineseNumeral: chineseNumeral,
    genTitle: genTitle,
    genId: genId,
    buildIndex: buildIndex,
    allIds: allIds,
    countPeople: countPeople,
    childrenMap: childrenMap,
    validateData: validateData,
    validateLikeWebsite: validateLikeWebsite,
    parseImport: parseImport,
    serialize: serialize,
    toExportJSON: toExportJSON,
    descendantCount: descendantCount,
    ancestorsOf: ancestorsOf,
    searchPeople: searchPeople,
    layoutTree: layoutTree,
    defaultCollapsed: defaultCollapsed
  };
  global.FTCore = FTCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = FTCore;
})(typeof window !== 'undefined' ? window : globalThis);
