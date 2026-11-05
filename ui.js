/* 族谱编写 - 界面逻辑 */
(function () {
  'use strict';
  var C = window.FTCore;
  var APP_VERSION = '1.1.0'; /* 顶栏显示的版本号只在此处维护一处；壳的版本点位（win/android 构建脚本）另行同步 */
  var LS_KEY = 'ft-editor-draft-v1';
  var NODE_W = 176, NODE_H = 128, SLOT_W = 196, ROW_H = 184, PAD_LEFT = 68, PAD_TOP = 18;

  var data = null;
  var pristineSample = false; /* 冷启动无草稿时自动载入的内置示例：不是用户数据，覆盖它不需确认；一经编辑/保存即失效 */
  var mode = 'edit';
  var viewTab = 'tree';
  var collapsed = new Set();
  var genFold = new Set(); /* 世代折叠状态（按世代序号）：查看列表与编辑列表共用一份；默认全展开，
     切换树图/列表、开气泡都不重置，仅载入新数据（setData）时清空 */
  var editQuery = ''; /* 编辑态搜索关键词：仅显示层过滤，不动数据与 genFold */
  var highlightIds = new Set();
  var pan = { x: 10, y: 10 };
  var zoom = 1;
  var genFocusCount = {}; /* 世代标尺轮转定位：row -> 已定位次数（按世分别记忆，拖动/缩放不重置） */
  var panAnim = null; /* 标尺定位的平滑平移动画句柄（rAF）；手势开始时立即取消接管 */
  var flashTimer = null; /* 定位高亮闪烁的清除计时器 */
  var treeBBox = null; /* 当前布局的节点包围盒（布局坐标）：{minX,maxX,minY,maxY}，供平移钳制 */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /* 世代标号显示规范化：标题恰为「第<中文数字>世」纯标号时，显示成阿拉伯数字（第1世、第31世）。
     只做显示层转换——数据里存的标题与导出文件逐字不变；带自定义文字的标题（如「受姓始祖」）原样。
     core.js 的 genTitle 仍生成中文标号（core 不动），新建世代改走下面的 newGenTitle 直接生成阿拉伯版。 */
  var CN_NUM = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  function cnToArabic(s) {
    var total = 0, pending = null, matched = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (Object.prototype.hasOwnProperty.call(CN_NUM, ch)) { pending = CN_NUM[ch]; matched = true; }
      else if (ch === '十') { total += (pending === null ? 1 : pending) * 10; pending = null; matched = true; }
      else if (ch === '百') { total += (pending === null ? 1 : pending) * 100; pending = null; matched = true; }
      else return null;
    }
    if (!matched) return null;
    if (pending !== null) total += pending;
    return total;
  }
  function dispTitle(title) {
    if (typeof title !== 'string') return title;
    var m = /^第([一二三四五六七八九十百零]+)世$/.exec(title);
    if (!m) return title;
    var n = cnToArabic(m[1]);
    return (n === null || n <= 0) ? title : '第' + n + '世';
  }
  function newGenTitle(n) { return '第' + n + '世'; }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2600);
  }
  function yearsText(p) {
    if (p.birthYear && p.deathYear) return p.birthYear + '—' + p.deathYear;
    if (p.birthYear) return p.birthYear + '—';
    if (p.deathYear) return '—' + p.deathYear;
    return '';
  }
  function personRec(id) { return data ? C.buildIndex(data).get(id) : null; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------------- 确认弹窗 ---------------- */
  var confirmCb = null;
  function confirmAction(title, text, onYes, danger) {
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('btnConfirmYes').className = danger ? 'danger' : 'primary';
    confirmCb = onYes;
    $('confirmModal').classList.remove('hidden');
  }

  /* ---------------- 数据生命周期 ---------------- */
  function setData(d, keepView) {
    data = d;
    genFocusCount = {};
    cancelPanAnim();
    collapsed = C.defaultCollapsed(data, 6);
    genFold = new Set();
    editQuery = '';
    if ($('editSearchInput')) $('editSearchInput').value = '';
    if ($('editSearchInfo')) $('editSearchInfo').textContent = '';
    highlightIds = new Set();
    $('searchInput').value = '';
    $('searchInfo').textContent = '';
    $('searchChips').innerHTML = '';
    saveDraft();
    showApp();
    if (!keepView) { mode = 'edit'; syncModeUI(); }
    renderAll();
  }
  function saveDraft() {
    if (!data) return;
    pristineSample = false; /* 任何经保存的改动都使数据成为用户数据 */
    try { localStorage.setItem(LS_KEY, C.toExportJSON(data)); } catch (e) { /* 存储不可用时静默 */ }
  }
  function showApp() {
    $('startScreen').classList.add('hidden');
    syncModeUI();
  }
  function showStart() {
    $('startScreen').classList.remove('hidden');
    $('editView').classList.add('hidden');
    $('viewView').classList.add('hidden');
  }
  function syncModeUI() {
    $('btnModeEdit').classList.toggle('active', mode === 'edit');
    $('btnModeView').classList.toggle('active', mode === 'view');
    $('editView').classList.toggle('hidden', mode !== 'edit' || !data);
    $('viewView').classList.toggle('hidden', mode !== 'view' || !data);
    /* 数据类按钮（新建/导入/粘贴导入/导出/复制）只在编辑状态显示；查看时整组隐藏，不留空行。
       编辑工具栏（按钮行+搜索行）同在 #editToolbar 内，一并切换 */
    $('topActions').classList.toggle('hidden', mode === 'view');
    $('editToolbar').classList.toggle('hidden', mode === 'view');
    /* 查看工具栏位于绿色顶栏内，仅查看状态显示 */
    $('viewToolbar').classList.toggle('hidden', mode !== 'view' || !data);
  }
  function setMode(m) {
    if (!data) { toast('先新建、载入示例或导入一份族谱数据'); return; }
    mode = m;
    syncModeUI();
    if (m === 'view') renderView();
    if (m === 'edit') renderEdit(); /* 与 view 侧对称：切回来按当前数据与 genFold 重渲染，避免看到旧 DOM */
  }
  function renderAll() {
    if (!data) return;
    renderEdit();
    renderValidation();
    if (mode === 'view') renderView();
  }
  function afterChange() {
    saveDraft();
    renderEdit();
    renderValidation();
    if (mode === 'view') renderView();
  }

  /* ---------------- 编辑模式渲染 ----------------
     世代可折叠：genFold（与查看列表共用）里的世代只渲染世代头、不渲染成员区；
     搜索态（editQuery 非空）：只显示命中成员（按世代分组、无命中的世代整世不渲染、
     命中世代一律展开），过滤纯属显示层——成员卡一律按 data-id 定位数据本体，
     genFold 不被搜索改动，清空搜索即恢复原折叠状态。 */
  function renderEdit() {
    var idx = C.buildIndex(data);
    var match = editQuery.trim() ? new Set(C.searchPeople(data, editQuery)) : null;
    var html = '';
    data.generations.forEach(function (g, gi) {
      if (match && !g.people.some(function (p) { return match.has(p.id); })) return;
      var folded = !match && genFold.has(gi);
      var shown = match ? g.people.filter(function (p) { return match.has(p.id); }).length : g.people.length;
      html += '<section class="gen-section' + (folded ? ' folded' : '') + '" data-gen="' + gi + '">';
      html += '<div class="gen-head">';
      /* 标题行独立成行（nowrap）：折叠钮/标题/人数/＋成员恒在同一行，宽度靠标题输入框收缩腾挪；
         「删除本世」恒在标题行之下的第二行（见 style.css .gen-head-main） */
      html += '<div class="gen-head-main">';
      html += '<button type="button" class="gen-fold-btn" data-act="fold" data-gi="' + gi + '" title="折叠/展开本世">' + (folded ? '▸' : '▾') + '</button>';
      html += '<input class="gen-title" data-gi="' + gi + '" value="' + esc(g.title) + '" aria-label="世代标题">';
      html += '<span class="gen-count">' + (match ? '命中 ' + shown + ' / ' + g.people.length + ' 人' : g.people.length + ' 人') + '</span>';
      html += '<span class="spacer"></span>';
      html += '<button type="button" data-act="add-person" data-gi="' + gi + '">＋ 成员</button>';
      html += '</div>';
      html += '<button type="button" data-act="del-gen" data-gi="' + gi + '"' + (g.people.length ? ' disabled title="只能删除空世代"' : '') + '>删除本世</button>';
      html += '</div>';
      if (folded) { html += '</section>'; return; }
      html += '<div class="gen-people">';
      if (!g.people.length) html += '<div class="gen-empty">本世暂无成员，点「＋ 成员」添加</div>';
      g.people.forEach(function (p, oi) {
        if (match && !match.has(p.id)) return;
        var fRec = p.fatherId ? idx.get(p.fatherId) : null;
        html += '<div class="person-card" data-id="' + esc(p.id) + '">';
        html += '<div class="p-main">';
        html += '<div class="p-name">' + esc(p.name || '（未命名）') + (yearsText(p) ? '<span class="p-years">' + esc(yearsText(p)) + '</span>' : '') + '</div>';
        if (p.info) html += '<div class="p-info">' + esc(p.info) + '</div>';
        html += '<div class="p-father">' + (fRec ? '父亲：' + esc(fRec.person.name) : (gi === 0 ? '始祖（无父亲）' : '父亲：未设置')) + (p.spouse ? '　配偶：' + esc(p.spouse) : '') + '</div>';
        html += '</div><div class="p-actions">';
        html += '<button type="button" data-act="edit" data-id="' + esc(p.id) + '">编辑</button>';
        html += '<button type="button" data-act="add-child" data-id="' + esc(p.id) + '">＋子女</button>';
        html += '<button type="button" data-act="up" data-id="' + esc(p.id) + '"' + (oi === 0 ? ' disabled' : '') + '>↑ 上移</button>';
        html += '<button type="button" data-act="down" data-id="' + esc(p.id) + '"' + (oi === g.people.length - 1 ? ' disabled' : '') + '>↓ 下移</button>';
        html += '<button type="button" data-act="del" data-id="' + esc(p.id) + '">删除</button>';
        html += '</div></div>';
      });
      html += '</div></section>';
    });
    if (match && !html) html = '<div class="gen-empty">没有找到匹配的成员，换个关键词试试</div>';
    $('genList').innerHTML = html;
    var esInfo = $('editSearchInfo');
    if (esInfo) esInfo.textContent = match ? '找到 ' + match.size + ' 人' : '';
  }

  function renderValidation() {
    var v = C.validateData(data);
    var html = '';
    if (!v.errors.length && !v.warnings.length) {
      html = '<div class="valid-ok">✓ 校验通过：' + C.countPeople(data) + ' 人 / ' + data.generations.length + ' 世，数据可直接用于网站</div>';
    }
    if (v.errors.length) {
      html += '<div class="valid-group errs"><h4>错误（' + v.errors.length + '）</h4>';
      v.errors.forEach(function (e) {
        html += '<div class="valid-item err" data-pid="' + esc(e.personId || '') + '">' + esc(e.msg) + '</div>';
      });
      html += '</div>';
    }
    if (v.warnings.length) {
      html += '<div class="valid-group warns"><h4>提示（' + v.warnings.length + '）</h4>';
      v.warnings.forEach(function (w) {
        html += '<div class="valid-item warn" data-pid="' + esc(w.personId || '') + '">' + esc(w.msg) + '</div>';
      });
      html += '</div>';
    }
    $('validBody').innerHTML = html;
    Array.prototype.forEach.call($('validBody').querySelectorAll('.valid-item'), function (el) {
      el.addEventListener('click', function () {
        var pid = el.getAttribute('data-pid');
        if (pid && personRec(pid)) openPerson(pid, false);
      });
    });
  }

  /* ---------------- 编辑操作 ---------------- */
  function newPersonObj(fatherId) {
    var p = { id: C.genId(C.allIds(data)), name: '' };
    if (fatherId) p.fatherId = fatherId;
    return p;
  }
  function addPersonFlow(gi, fatherId) {
    var p = newPersonObj(fatherId || null);
    data.generations[gi].people.push(p);
    genFold.delete(gi); /* 新成员所在世代若折叠着，先展开免得加完看不见 */
    afterChange();
    openPerson(p.id, true);
  }
  function addChildFlow(id) {
    var rec = personRec(id);
    if (!rec) return;
    var target = rec.genIndex + 1;
    if (target >= data.generations.length) {
      data.generations.push({ title: newGenTitle(data.generations.length + 1), people: [] });
    }
    addPersonFlow(target, id);
    toast('已在' + dispTitle(data.generations[target].title) + '新建成员，请填写姓名');
  }
  function deletePersonFlow(id) {
    var rec = personRec(id);
    if (!rec) return;
    var kids = [];
    data.generations.forEach(function (g) {
      g.people.forEach(function (p) { if (p.fatherId === id) kids.push(p); });
    });
    var name = rec.person.name || '（未命名）';
    var text = kids.length
      ? '确定删除「' + name + '」吗？他/她有 ' + kids.length + ' 名子女，删除后这些子女的父亲将被清空（变为无父亲），需要你再手动指定。'
      : '确定删除「' + name + '」吗？';
    confirmAction('删除成员', text, function () {
      kids.forEach(function (k) { delete k.fatherId; });
      var arr = data.generations[rec.genIndex].people;
      arr.splice(arr.indexOf(rec.person), 1);
      closePersonModal();
      afterChange();
      toast('已删除「' + name + '」');
    }, true);
  }
  function movePerson(id, dir) {
    var rec = personRec(id);
    if (!rec) return;
    var arr = data.generations[rec.genIndex].people;
    var i = arr.indexOf(rec.person), j = i + dir;
    if (j < 0 || j >= arr.length) return;
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    afterChange();
  }

  /* ---------------- 成员表单 ---------------- */
  var editingId = null, editingIsNew = false;
  function fatherOptionsHtml(genIndex, filter, currentFather) {
    var idx = C.buildIndex(data);
    var html = '<option value="">无（始祖）</option>';
    var q = (filter || '').trim();
    for (var gi = 0; gi < genIndex; gi++) {
      var g = data.generations[gi];
      var items = g.people.filter(function (p) { return !q || (p.name && p.name.indexOf(q) !== -1); });
      if (!items.length) continue;
      html += '<optgroup label="' + esc(dispTitle(g.title)) + '">';
      items.forEach(function (p) {
        html += '<option value="' + esc(p.id) + '"' + (p.id === currentFather ? ' selected' : '') + '>' + esc(p.name || '（未命名）') + '（' + esc(dispTitle(g.title)) + '）</option>';
      });
      html += '</optgroup>';
    }
    return html;
  }
  function openPerson(id, isNew) {
    var rec = personRec(id);
    if (!rec) return;
    editingId = id; editingIsNew = !!isNew;
    var p = rec.person;
    $('personModalTitle').textContent = isNew ? '新增成员' : '编辑成员';
    $('fName').value = p.name || '';
    $('fInfo').value = p.info || '';
    $('fBirth').value = (typeof p.birthYear === 'number') ? p.birthYear : '';
    $('fDeath').value = (typeof p.deathYear === 'number') ? p.deathYear : '';
    $('fSpouse').value = p.spouse || '';
    $('fId').textContent = p.id;
    $('formError').classList.add('hidden');
    var genSel = $('fGen');
    genSel.innerHTML = data.generations.map(function (g, gi) {
      return '<option value="' + gi + '"' + (gi === rec.genIndex ? ' selected' : '') + '>' + esc(dispTitle(g.title)) + '</option>';
    }).join('');
    $('fFatherSearch').value = '';
    $('fFather').innerHTML = fatherOptionsHtml(rec.genIndex, '', p.fatherId || '');
    $('fFather').value = p.fatherId || '';
    $('personModal').classList.remove('hidden');
    setTimeout(function () { $('fName').focus(); }, 30);
  }
  function closePersonModal() {
    if (editingId && editingIsNew) {
      var rec = personRec(editingId);
      if (rec && !rec.person.name && !rec.person.info) {
        var arr = data.generations[rec.genIndex].people;
        arr.splice(arr.indexOf(rec.person), 1);
        afterChange();
      }
    }
    editingId = null; editingIsNew = false;
    $('personModal').classList.add('hidden');
  }
  function savePerson(ev) {
    ev.preventDefault();
    var rec = personRec(editingId);
    if (!rec) { closePersonModal(); return; }
    var name = $('fName').value.trim();
    if (!name) {
      $('formError').textContent = '姓名不能为空';
      $('formError').classList.remove('hidden');
      return;
    }
    var p = rec.person;
    p.name = name;
    var info = $('fInfo').value.trim();
    if (info) p.info = info; else delete p.info;
    var b = $('fBirth').value.trim(), d = $('fDeath').value.trim();
    if (b !== '' && isFinite(Number(b))) p.birthYear = Number(b); else delete p.birthYear;
    if (d !== '' && isFinite(Number(d))) p.deathYear = Number(d); else delete p.deathYear;
    var sp = $('fSpouse').value.trim();
    if (sp) p.spouse = sp; else delete p.spouse;
    var fid = $('fFather').value;
    if (fid && fid !== p.id) p.fatherId = fid; else delete p.fatherId;
    var newGen = Number($('fGen').value);
    if (newGen !== rec.genIndex) {
      var arr = data.generations[rec.genIndex].people;
      arr.splice(arr.indexOf(p), 1);
      data.generations[newGen].people.push(p);
    }
    editingIsNew = false;
    $('personModal').classList.add('hidden');
    editingId = null;
    afterChange();
    toast('已保存「' + name + '」');
  }

  /* ---------------- 查看：树图 ---------------- */
  function nodePos(layout, id) {
    var n = layout.nodes.get(id);
    if (!n) return null;
    return { x: PAD_LEFT + n.slot * SLOT_W, y: PAD_TOP + n.row * ROW_H, slot: n.slot, row: n.row, info: n };
  }
  function renderTree() {
    if (!data) return;
    var layout = C.layoutTree(data, collapsed);
    var idx = C.buildIndex(data);
    var W = PAD_LEFT + layout.cols * SLOT_W + 30;
    var H = PAD_TOP + data.generations.length * ROW_H + 40;
    treeBBox = null;
    if (layout.nodes.size) {
      var mnS = Infinity, mxS = -Infinity, mnR = Infinity, mxR = -Infinity;
      layout.nodes.forEach(function (n) {
        if (n.slot < mnS) mnS = n.slot;
        if (n.slot > mxS) mxS = n.slot;
        if (n.row < mnR) mnR = n.row;
        if (n.row > mxR) mxR = n.row;
      });
      treeBBox = {
        minX: PAD_LEFT + mnS * SLOT_W, maxX: PAD_LEFT + mxS * SLOT_W + NODE_W,
        minY: PAD_TOP + mnR * ROW_H, maxY: PAD_TOP + mxR * ROW_H + NODE_H
      };
    }
    var canvas = $('treeCanvas');
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    var svg = $('treeSvg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    var paths = '';
    layout.edges.forEach(function (e) {
      var a = nodePos(layout, e.from), b = nodePos(layout, e.to);
      if (!a || !b) return;
      var x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H;
      var x2 = b.x + NODE_W / 2, y2 = b.y;
      var midY = y1 + Math.max(14, (y2 - y1) / 2);
      paths += '<path d="M ' + x1 + ' ' + y1 + ' L ' + x1 + ' ' + midY + ' L ' + x2 + ' ' + midY + ' L ' + x2 + ' ' + y2 + '" fill="none" stroke="#b3a67f" stroke-width="1.6"/>';
    });
    svg.innerHTML = paths;
    var html = '';
    layout.nodes.forEach(function (n, id) {
      var rec = idx.get(id);
      if (!rec) return;
      var p = rec.person;
      var pos = nodePos(layout, id);
      html += '<div class="tnode' + (highlightIds.has(id) ? ' highlight' : '') + '" data-id="' + esc(id) + '" style="left:' + pos.x + 'px;top:' + pos.y + 'px">';
      html += '<div class="t-name">' + esc(p.name || '（未命名）') + '</div>';
      if (yearsText(p)) html += '<div class="t-years">' + esc(yearsText(p)) + '</div>';
      if (p.info) html += '<div class="t-info">' + esc(p.info) + '</div>';
      if (n.childCount > 0) {
        html += '<button type="button" class="t-badge" data-badge="' + esc(id) + '">' + (n.collapsed ? '+' + n.hiddenCount + ' 人' : '收起') + '</button>';
      }
      html += '</div>';
    });
    $('treeNodes').innerHTML = html;
    hideNodePop();
    applyTransform();
    syncExpandBtn();
  }
  /* 「展开全部 / 只看前六世」合并为一个开关按钮：当前已渲染节点里只要还有被折叠的分支，
     按钮就是「展开全部」；全部展开（无任何已渲染分支被折叠）时就是「只看前六世」。
     每次 renderTree 后同步文案，用户手动逐个展开/收起支系时文案也实时对应。 */
  function anyCollapsedBranch() {
    if (!data) return false;
    var found = false;
    C.layoutTree(data, collapsed).nodes.forEach(function (n) { if (n.collapsed) found = true; });
    return found;
  }
  function syncExpandBtn() {
    var btn = $('btnExpandAll');
    if (!btn) return;
    btn.textContent = anyCollapsedBranch() ? '展开全部' : '只看前六世';
  }
  function renderRuler() {
    if (!data) return;
    var html = '';
    for (var gi = 0; gi < data.generations.length; gi++) {
      html += '<div class="ruler-label" data-row="' + gi + '" title="点击定位本世成员，再点跳下一位">' + esc(dispTitle(data.generations[gi].title)) + '</div>';
    }
    $('treeRulerInner').innerHTML = html;
    positionRuler();
  }
  function positionRuler() {
    Array.prototype.forEach.call($('treeRulerInner').children, function (el) {
      var row = Number(el.getAttribute('data-row'));
      el.style.top = ((PAD_TOP + row * ROW_H + NODE_H / 2) * zoom + pan.y) + 'px';
    });
  }
  /* 平移边界钳制（硬边界、无回弹）：屏幕坐标 = 内容×zoom + pan。任意时刻、横纵两轴独立满足
     「内容与视口的重叠 >= keep」。keep 的演进：1.0.5 为 160/轴长 1/3；1.0.6 按用户反馈收紧到
     横 80/1/6、纵 32/1/15；1.0.7 用户看过 15% 缩放拖到角落的实际观感后要求再加强，改为按视口
     比例兜底：keepX = max(80, round(视口宽×0.6))、keepY = max(32, round(视口高×0.6))，
     即任一轴拖到极限至少 60% 视口仍是内容、空白最多 40%；再与内容该轴屏幕长取 min
     （内容比 keep 还小时取内容全长，等于要求内容整段留在视口内，自动靠拢）。
     所有改动 pan/zoom 的入口（单指拖动、双指捏合、滚轮/工具栏 zoomAt、搜索 focusNode、
     标尺定位 animatePanTo 的每一帧、缩放按钮/重置、每次 renderTree）最终都汇到 applyTransform，
     钳制写在这里就是唯一收口，任何入口都绕不过；zoom 变化的当帧即按新 zoom 重新钳制。 */
  var PAN_KEEP_X = 80, PAN_KEEP_Y = 32, PAN_KEEP_FRAC = 0.6;
  function clampPanAxis(p, minC, maxC, viewLen, keepPx) {
    if (!viewLen || viewLen <= 0) return p; /* 视口不可见（宽高 0）时不钳，等可见时下一次 applyTransform 再钳 */
    var len = (maxC - minC) * zoom;
    var keep = Math.min(Math.max(keepPx, Math.round(viewLen * PAN_KEEP_FRAC)), len);
    var lo = keep - maxC * zoom;
    var hi = viewLen - keep - minC * zoom;
    if (p < lo) return lo;
    if (p > hi) return hi;
    return p;
  }
  function clampPan() {
    if (!treeBBox) return;
    var wrap = $('treeWrap');
    pan.x = clampPanAxis(pan.x, treeBBox.minX, treeBBox.maxX, wrap.clientWidth, PAN_KEEP_X);
    pan.y = clampPanAxis(pan.y, treeBBox.minY, treeBBox.maxY, wrap.clientHeight, PAN_KEEP_Y);
  }
  /* 气泡拖动吸附的帧间记账：lastPan 记上一次 applyTransform 落定（钳制后）的 pan，帧间差就是
     内容（卡片）本帧的实际位移；popDragFrame 由单指拖动的 pointermove 分支在调 applyTransform
     前置位、本函数消费复位，用来区分「用户拖动帧」（气泡走中心吸附）与程序化平移/缩放帧
     （气泡按锚定规则重定位、等效 1:1 跟随）。popAnchor/popPos 在下方气泡一节声明（var 提升） */
  var lastPan = { x: pan.x, y: pan.y };
  var popDragFrame = false;
  function applyTransform() {
    clampPan();
    var fdx = pan.x - lastPan.x, fdy = pan.y - lastPan.y;
    lastPan.x = pan.x; lastPan.y = pan.y;
    $('treeCanvas').style.transform = 'translate(' + pan.x + 'px,' + pan.y + 'px) scale(' + zoom + ')';
    $('btnZoomReset').textContent = Math.round(zoom * 100) + '%';
    positionRuler();
    if (popAnchor) placeNodePop(popDragFrame ? { dx: fdx, dy: fdy } : null);
    popDragFrame = false;
  }
  function zoomAt(mx, my, factor) {
    var nz = Math.min(3, Math.max(0.15, zoom * factor));
    if (nz === zoom) return;
    pan.x = mx - (mx - pan.x) * (nz / zoom);
    pan.y = my - (my - pan.y) * (nz / zoom);
    zoom = nz;
    applyTransform();
  }
  function focusNode(id) {
    C.ancestorsOf(data, id).forEach(function (a) { collapsed.delete(a); });
    collapsed.delete(id);
    renderTree();
    var el = $('treeNodes').querySelector('[data-id="' + CSS.escape(id) + '"]');
    if (!el) return;
    var wrap = $('treeWrap');
    pan.x = wrap.clientWidth / 2 - (el.offsetLeft + NODE_W / 2) * zoom;
    pan.y = wrap.clientHeight / 2 - (el.offsetTop + NODE_H / 2) * zoom;
    applyTransform();
    showNodePop(id);
  }

  /* 平滑平移：用 rAF 逐帧写 pan（与手势的 transform 直写同一通道，不用 CSS transition 以免打架）；
     用户一旦开始拖动/捏合/滚轮，pointerdown/wheel 里会 cancelPanAnim 立即接管。 */
  function animatePanTo(tx, ty) {
    cancelPanAnim();
    var sx = pan.x, sy = pan.y;
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    var DUR = 280;
    var stepFn = function (t) {
      var k = Math.min(1, (t - t0) / DUR);
      var e = 1 - Math.pow(1 - k, 3); /* easeOutCubic */
      pan.x = sx + (tx - sx) * e;
      pan.y = sy + (ty - sy) * e;
      applyTransform();
      panAnim = k < 1 ? requestAnimationFrame(stepFn) : null;
    };
    panAnim = requestAnimationFrame(stepFn);
  }
  function cancelPanAnim() {
    if (panAnim !== null && panAnim !== undefined) { cancelAnimationFrame(panAnim); panAnim = null; }
  }
  function flashNode(id) {
    var prev = $('treeNodes').querySelector('.tnode.focus-flash');
    if (prev) prev.classList.remove('focus-flash');
    var el = $('treeNodes').querySelector('[data-id="' + CSS.escape(id) + '"]');
    if (!el) return;
    el.classList.add('focus-flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { el.classList.remove('focus-flash'); }, 1250);
  }
  /* 点击世代标尺：轮转定位本世下一位「当前已渲染」成员（按布局槽位从左到右，越界绕回首位）。
     计数按世代分别记忆，手动拖动/缩放不重置；被折叠藏起来的成员不在布局里、不参与轮转。 */
  function focusNextInRow(row) {
    if (!data) return;
    var layout = C.layoutTree(data, collapsed);
    var members = [];
    layout.nodes.forEach(function (n, id) { if (n.row === row) members.push({ id: id, slot: n.slot }); });
    if (!members.length) return; /* 本世当前无已渲染成员（防御）：不做任何事 */
    members.sort(function (a, b) { return a.slot - b.slot; });
    var cnt = genFocusCount[row] || 0;
    genFocusCount[row] = cnt + 1;
    var target = members[cnt % members.length];
    var pos = nodePos(layout, target.id);
    var wrap = $('treeWrap');
    animatePanTo(
      wrap.clientWidth / 2 - (pos.x + NODE_W / 2) * zoom,
      wrap.clientHeight / 2 - (pos.y + NODE_H / 2) * zoom
    );
    flashNode(target.id);
  }

  /* 节点弹层（人物详情气泡）。现行规则（用户最终澄清版；取代 1.0.8 的全程锚定跟随，
     以及中间短暂试过的「点开自动居中」「气泡罩卡正中」——后者均已被用户改回）：
     1) 点开与 1.0.8 完全一致：气泡锚定卡片——水平与卡片居中、垂直优先下方（间距 8）、
        下方放不下翻到上方、再放不下贴合钳入视口，保证四边距 ≥8px 完整可见；
        点开不做任何自动居中。再点已打开的同一张卡 = 关气泡。
     2) 限高限宽：maxHeight = 画布高 × 55%（POP_MAXH_FRAC；原为视口高−16，长气泡仍接近
        整屏高、挡住菜单与标尺，1.0.8 真机反馈后压到 55%），超长内容由 .np-info 在气泡
        内部纵向滚动读全（CSS flex 列：标题/元信息/按钮行固定，只有简介区伸缩滚动）；
        maxWidth ≤280 且 ≤视口宽−16。
     3) 程序化平移/缩放（标尺定位、搜索定位、滚轮/捏合、工具栏缩放、重置）：气泡按 1) 的
        锚定规则逐帧重定位，等效 1:1 跟随卡片、偏移不变；吸附规则不套到这些路径上。
     4) 用户单指拖动：中心吸附（棘轮）。横、纵两轴各自独立，记 d = 卡片中心 − 气泡中心
        （屏幕坐标）：卡片向气泡中心靠拢（|d| 缩小）时气泡在该轴不动；到达或穿过中心后
        锁定 d = 0 跟随；远离时气泡立即跟随、保持原偏移。即单次拖动内每轴 |d| 只减不增，
        跨拖动以当时实际偏移为新上限、永不回涨——反复拖动多次后卡片终将到达气泡正中并锁定。
        气泡的视口贴合钳制（四边 ≥8）是更外层的硬约束，与吸附冲突时以不越界优先。
     5) 气泡内的触摸/滚轮不被画布抢走：wrap 的 pointerdown/wheel 对气泡内目标放行，
        .np-info 显式 touch-action:pan-y 保证真机原生滚动。
     实现：打开时把节点布局坐标存入 popAnchor；placeNodePop(null) 按锚定规则定位并记入
     popPos（浮点落位状态）；拖动帧由 applyTransform 传入本帧实际位移，placeNodePop 改走
     adsorbDelta 逐轴从 popPos 更新。renderTree 会先 hideNodePop 清锚，折叠/重渲染即关闭。 */
  var popAnchor = null; /* {id, x, y}（布局坐标）；null 表示气泡未打开 */
  var popPos = null; /* 气泡当前落位 {x, y}（浮点，视口坐标）；null 表示尚未落位。
     必须用浮点状态记账、不能回读 offsetLeft/offsetTop：那是取整后的整数，拖动时逐帧
     「读整数 + 加位移 + 写回」会把每帧的亚像素误差累积成可见的偏移漂移（实测长拖后 |d| 回涨数 px） */
  var POP_MAXH_FRAC = 0.55; /* 气泡最大高度 = 画布（#treeWrap）高的 55% */
  function hideNodePop() { popAnchor = null; popPos = null; $('nodePop').classList.add('hidden'); }
  /* 单轴吸附：delta 为本帧卡片的实际位移，dNow 为「卡片已移动、气泡未动」时的偏移
     （卡片中心 − 气泡中心），帧前偏移 dPrev = dNow − delta。返回气泡本帧在该轴应移动的量：
     dPrev = 0（已锁定）-> 随卡片同量移动，d 保持 0；
     同号且 |dNow| <= |dPrev|（靠拢，含恰好到达 0）-> 不动，|d| 自然缩小；
     同号且 |dNow| > |dPrev|（远离）-> 随卡片同量移动，d 保持 dPrev；
     异号（穿过中心）-> 只跟随过零的溢出部分，本帧 d 归 0、此后锁定。 */
  function adsorbDelta(delta, dNow) {
    var dPrev = dNow - delta;
    if (dPrev === 0) return delta;
    if (dNow === 0) return 0;
    if ((dNow > 0) === (dPrev > 0)) return Math.abs(dNow) <= Math.abs(dPrev) ? 0 : delta;
    return dNow;
  }
  function placeNodePop(dragDelta) {
    var pop = $('nodePop');
    if (!popAnchor || pop.classList.contains('hidden')) return;
    var wrap = $('treeWrap');
    var vw = wrap.clientWidth, vh = wrap.clientHeight;
    if (!vw || !vh) return; /* 视口不可见时不定位，等下一次 applyTransform */
    var M = 8; /* 气泡与视口四边的最小边距 */
    pop.style.maxWidth = Math.max(120, Math.min(280, vw - 2 * M)) + 'px';
    pop.style.maxHeight = Math.round(vh * POP_MAXH_FRAC) + 'px';
    var pw = pop.offsetWidth, ph = pop.offsetHeight;
    if (!pw || !ph) return;
    var nx = pan.x + popAnchor.x * zoom, ny = pan.y + popAnchor.y * zoom;
    var nw = NODE_W * zoom, nh = NODE_H * zoom;
    var left, top;
    if (dragDelta && popPos) {
      /* 用户拖动帧：从气泡当前落位（浮点状态）出发，横纵两轴各自按吸附规则更新，再套视口钳制 */
      left = popPos.x + adsorbDelta(dragDelta.dx, (nx + nw / 2) - (popPos.x + pw / 2));
      top = popPos.y + adsorbDelta(dragDelta.dy, (ny + nh / 2) - (popPos.y + ph / 2));
      left = Math.max(M, Math.min(left, vw - M - pw));
      top = Math.max(M, Math.min(top, vh - M - ph));
    } else {
      /* 锚定定位（打开瞬间与一切程序化平移/缩放）：水平与卡片居中钳入；
         垂直优先下方（间距 M）、放不下翻上方、再放不下贴合钳入 */
      left = Math.max(M, Math.min(nx + nw / 2 - pw / 2, vw - M - pw));
      var topBelow = ny + nh + M;
      if (topBelow + ph <= vh - M) top = topBelow;
      else {
        var topAbove = ny - M - ph;
        top = topAbove >= M ? topAbove : Math.max(M, Math.min(topBelow, vh - M - ph));
      }
    }
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    popPos = { x: left, y: top };
  }
  function showNodePop(id) {
    var rec = personRec(id);
    if (!rec) return;
    /* 气泡已开在同一个人身上时再点该卡 = 关气泡；打开/切换到其他人则就地按锚定规则弹出，
       点开不做任何自动居中（与 1.0.8 一致） */
    if (popAnchor && popAnchor.id === id && !$('nodePop').classList.contains('hidden')) { hideNodePop(); return; }
    var p = rec.person;
    var idx = C.buildIndex(data);
    var fRec = p.fatherId ? idx.get(p.fatherId) : null;
    var layout = C.layoutTree(data, collapsed);
    var pos = nodePos(layout, id);
    var html = '<h4>' + esc(p.name || '（未命名）') + '</h4>';
    html += '<div class="np-meta">';
    if (yearsText(p)) html += '生卒：' + esc(yearsText(p)) + '<br>';
    html += '世代：' + esc(dispTitle(data.generations[rec.genIndex].title));
    if (p.spouse) html += '<br>配偶：' + esc(p.spouse);
    if (fRec) html += '<br>父亲：' + esc(fRec.person.name);
    html += '</div>';
    if (p.info) html += '<div class="np-info">' + esc(p.info) + '</div>';
    html += '<div class="np-btns">';
    var n = layout.nodes.get(id);
    if (n && n.childCount > 0) html += '<button type="button" id="npToggle">' + (n.collapsed ? '展开支系' : '折叠支系') + '</button>';
    html += '<button type="button" id="npEdit">在编辑中打开</button>';
    html += '<button type="button" id="npClose">关闭</button></div>';
    var pop = $('nodePop');
    pop.innerHTML = html;
    pop.classList.remove('hidden');
    popAnchor = { id: id, x: pos.x, y: pos.y };
    placeNodePop();
    var tgl = $('npToggle');
    if (tgl) tgl.addEventListener('click', function () { toggleCollapse(id); });
    $('npEdit').addEventListener('click', function () {
      /* 跳编辑态定位此人：所在世代若折叠着先自动展开，并把成员卡滚进可视区，再开编辑弹窗 */
      var rec2 = personRec(id);
      if (rec2) genFold.delete(rec2.genIndex);
      setMode('edit');
      renderEdit();
      var card = $('genList').querySelector('.person-card[data-id="' + CSS.escape(id) + '"]');
      if (card && card.scrollIntoView) { try { card.scrollIntoView({ block: 'center' }); } catch (e) { /* 忽略 */ } }
      openPerson(id, false);
    });
    $('npClose').addEventListener('click', hideNodePop);
  }
  function toggleCollapse(id) {
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    renderTree();
  }

  /* ---------------- 查看：列表 ----------------
     每一世可折叠：点标题行切换该世成员显示/隐藏，折叠时只剩标题行（仍带人数）；
     状态存 genFold（与编辑列表共用），切换树图/列表、开气泡都不重置。 */
  function renderList() {
    var idx = C.buildIndex(data);
    var html = '';
    data.generations.forEach(function (g, gi) {
      var folded = genFold.has(gi);
      html += '<div class="list-gen' + (folded ? ' folded' : '') + '"><h3 class="list-gen-head" data-lfold="' + gi + '" title="点击折叠/展开本世">' + esc(dispTitle(g.title)) + '（' + g.people.length + ' 人）</h3>';
      if (!folded) {
        html += '<table><thead><tr><th>姓名</th><th>生卒</th><th>配偶</th><th>父亲</th><th>简介</th></tr></thead><tbody>';
        g.people.forEach(function (p) {
          var fRec = p.fatherId ? idx.get(p.fatherId) : null;
          html += '<tr><td class="name-cell"><strong>' + esc(p.name || '（未命名）') + '</strong></td><td class="years-cell">' + esc(yearsText(p)) + '</td><td class="spouse-cell">' + esc(p.spouse || '') + '</td><td class="father-cell">' + esc(fRec ? fRec.person.name : '') + '</td><td class="info-cell">' + esc(p.info || '') + '</td></tr>';
        });
        html += '</tbody></table>';
      }
      html += '</div>';
    });
    $('listView').innerHTML = html;
  }
  function renderView() {
    $('btnTreeTab').classList.toggle('active', viewTab === 'tree');
    $('btnListTab').classList.toggle('active', viewTab === 'list');
    var empty = !data || C.countPeople(data) === 0;
    $('viewEmpty').classList.toggle('hidden', !empty);
    $('treeWrap').classList.toggle('hidden', empty || viewTab !== 'tree');
    $('searchChips').classList.toggle('hidden', empty || viewTab !== 'tree');
    $('listView').classList.toggle('hidden', empty || viewTab !== 'list');
    if (empty) return;
    if (viewTab === 'tree') { renderTree(); renderRuler(); }
    else renderList();
  }

  /* ---------------- 搜索 ---------------- */
  function doSearch() {
    var q = $('searchInput').value;
    var matches = C.searchPeople(data, q);
    highlightIds = new Set(matches);
    if (!q.trim()) {
      $('searchInfo').textContent = '';
      $('searchChips').innerHTML = '';
      if (viewTab === 'tree') renderTree();
      return;
    }
    matches.forEach(function (id) {
      C.ancestorsOf(data, id).forEach(function (a) { collapsed.delete(a); });
      collapsed.delete(id);
    });
    var idx = C.buildIndex(data);
    $('searchInfo').textContent = '找到 ' + matches.length + ' 人';
    $('searchChips').innerHTML = matches.map(function (id) {
      var rec = idx.get(id);
      return '<button type="button" class="chip" data-focus="' + esc(id) + '">' + esc(rec ? rec.person.name : id) + '</button>';
    }).join('');
    Array.prototype.forEach.call($('searchChips').querySelectorAll('[data-focus]'), function (el) {
      el.addEventListener('click', function () { focusNode(el.getAttribute('data-focus')); });
    });
    if (viewTab === 'tree') renderTree();
  }

  /* ---------------- 导入 / 导出 ---------------- */
  function handleImportText(text) {
    var r = C.parseImport(text);
    if (!r.ok) {
      var list = $('importErrorList');
      list.innerHTML = r.errors.slice(0, 40).map(function (e) { return '<li>' + esc(e.msg) + '</li>'; }).join('') +
        (r.errors.length > 40 ? '<li>……共 ' + r.errors.length + ' 处问题</li>' : '');
      $('importErrorModal').classList.remove('hidden');
      return;
    }
    setData(r.data);
    var msg = '导入成功：' + C.countPeople(r.data) + ' 人 / ' + r.data.generations.length + ' 世';
    if (r.warnings && r.warnings.length) msg += '（有 ' + r.warnings.length + ' 条提示，见校验面板）';
    toast(msg);
  }
  function guardReplace(action) {
    if (data && !pristineSample && C.countPeople(data) > 0) {
      confirmAction('覆盖当前数据？', '当前正在编辑的族谱（' + C.countPeople(data) + ' 人）将被替换，确定继续吗？', action, true);
    } else action();
  }
  function doExport() {
    if (!data) { toast('还没有数据可导出'); return; }
    var v = C.validateData(data);
    var go = function () {
      var json = C.toExportJSON(data);
      if (window.NativeBridge && typeof window.NativeBridge.saveJson === 'function') {
        window.NativeBridge.saveJson(json);
        toast('已请求保存 family-data.json（见手机提示）');
        return;
      }
      var blob = new Blob([json], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'family-data.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
      toast('已导出 family-data.json');
    };
    if (v.errors.length) {
      confirmAction('数据还有 ' + v.errors.length + ' 处错误', '带错误导出后，网站可能拒绝使用这份数据。建议先按校验面板修好。仍要导出吗？', go, true);
    } else go();
  }
  function doCopy() {
    if (!data) { toast('还没有数据可复制'); return; }
    var json = C.toExportJSON(data);
    function done() { toast('JSON 已复制到剪贴板'); }
    if (window.NativeBridge && typeof window.NativeBridge.copyText === 'function') {
      window.NativeBridge.copyText(json); done(); return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(done, function () { fallbackCopy(json); done(); });
    } else { fallbackCopy(json); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
    ta.remove();
  }
  function freshData() {
    return { generations: [{ title: newGenTitle(1), people: [] }] };
  }
  function startNewFlow() {
    guardReplace(function () {
      var d = freshData();
      setData(d);
      addPersonFlow(0, null);
    });
  }
  function startSampleFlow() {
    guardReplace(function () {
      setData(clone(window.FT_SAMPLE_DATA));
      toast('已载入示例：' + C.countPeople(data) + ' 人，去「查看」看看树图效果');
    });
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    $('btnModeEdit').addEventListener('click', function () { setMode('edit'); });
    $('btnModeView').addEventListener('click', function () { setMode('view'); });
    $('btnNew').addEventListener('click', startNewFlow);
    $('startNew').addEventListener('click', startNewFlow);
    $('startSample').addEventListener('click', startSampleFlow);
    $('btnImport').addEventListener('click', function () { $('fileInput').click(); });
    $('startImport').addEventListener('click', function () { $('fileInput').click(); });
    $('btnPaste').addEventListener('click', function () { $('pasteText').value = ''; $('pasteError').classList.add('hidden'); $('pasteModal').classList.remove('hidden'); });
    $('startPaste').addEventListener('click', function () { $('pasteText').value = ''; $('pasteError').classList.add('hidden'); $('pasteModal').classList.remove('hidden'); });
    $('btnExport').addEventListener('click', doExport);
    $('btnCopy').addEventListener('click', doCopy);
    $('fileInput').addEventListener('change', function () {
      var f = $('fileInput').files[0];
      $('fileInput').value = '';
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { guardReplace(function () { handleImportText(String(reader.result)); }); };
      reader.onerror = function () { toast('读取文件失败'); };
      reader.readAsText(f);
    });
    $('btnPasteCancel').addEventListener('click', function () { $('pasteModal').classList.add('hidden'); });
    $('btnPasteGo').addEventListener('click', function () {
      var text = $('pasteText').value;
      if (!text.trim()) {
        $('pasteError').textContent = '先把 JSON 文本粘贴进来';
        $('pasteError').classList.remove('hidden');
        return;
      }
      $('pasteModal').classList.add('hidden');
      guardReplace(function () { handleImportText(text); });
    });
    $('btnImportErrorOk').addEventListener('click', function () { $('importErrorModal').classList.add('hidden'); });
    $('btnConfirmNo').addEventListener('click', function () { $('confirmModal').classList.add('hidden'); confirmCb = null; });
    $('btnConfirmYes').addEventListener('click', function () {
      $('confirmModal').classList.add('hidden');
      var cb = confirmCb; confirmCb = null;
      if (cb) cb();
    });

    /* 编辑区事件委托 */
    $('genList').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn || btn.disabled) return;
      var act = btn.getAttribute('data-act');
      var gi = Number(btn.getAttribute('data-gi'));
      var id = btn.getAttribute('data-id');
      if (act === 'fold') {
        if (genFold.has(gi)) genFold.delete(gi); else genFold.add(gi);
        renderEdit();
      }
      else if (act === 'add-person') addPersonFlow(gi, null);
      else if (act === 'del-gen') {
        confirmAction('删除世代', '确定删除空的「' + dispTitle(data.generations[gi].title) + '」吗？', function () {
          data.generations.splice(gi, 1);
          afterChange();
        }, true);
      }
      else if (act === 'edit') openPerson(id, false);
      else if (act === 'add-child') addChildFlow(id);
      else if (act === 'up') movePerson(id, -1);
      else if (act === 'down') movePerson(id, 1);
      else if (act === 'del') deletePersonFlow(id);
    });
    $('genList').addEventListener('change', function (e) {
      if (e.target.classList.contains('gen-title')) {
        var gi = Number(e.target.getAttribute('data-gi'));
        var val = e.target.value.trim();
        data.generations[gi].title = val || newGenTitle(gi + 1);
        afterChange();
      }
    });
    $('btnAddGen').addEventListener('click', function () {
      data.generations.push({ title: newGenTitle(data.generations.length + 1), people: [] });
      afterChange();
      toast('已新增' + dispTitle(data.generations[data.generations.length - 1].title));
    });

    /* 编辑态搜索：输入即过滤（仅显示层，见 renderEdit）。
       搜索框在顶栏内、无数据（启动页）时也可能被输入，此时无数据可渲染、直接忽略 */
    $('editSearchInput').addEventListener('input', function () {
      editQuery = this.value;
      if (data) renderEdit();
    });

    /* 查看列表：点世代标题行折叠/展开本世 */
    $('listView').addEventListener('click', function (e) {
      var h = e.target.closest('[data-lfold]');
      if (!h) return;
      var gi = Number(h.getAttribute('data-lfold'));
      if (genFold.has(gi)) genFold.delete(gi); else genFold.add(gi);
      renderList();
    });

    /* 成员表单 */
    $('personForm').addEventListener('submit', savePerson);
    $('btnCancelPerson').addEventListener('click', closePersonModal);
    $('btnDeletePerson').addEventListener('click', function () { if (editingId) deletePersonFlow(editingId); });
    $('fGen').addEventListener('change', function () {
      var rec = personRec(editingId);
      var cur = $('fFather').value;
      $('fFather').innerHTML = fatherOptionsHtml(Number($('fGen').value), $('fFatherSearch').value, cur);
      if (Array.prototype.some.call($('fFather').options, function (o) { return o.value === cur; })) $('fFather').value = cur;
      else $('fFather').value = '';
      if (rec) { /* 保持当前选择逻辑即可 */ }
    });
    $('fFatherSearch').addEventListener('input', function () {
      var cur = $('fFather').value;
      $('fFather').innerHTML = fatherOptionsHtml(Number($('fGen').value), $('fFatherSearch').value, cur);
      if (Array.prototype.some.call($('fFather').options, function (o) { return o.value === cur; })) $('fFather').value = cur;
    });

    /* 查看工具栏 */
    $('btnTreeTab').addEventListener('click', function () { viewTab = 'tree'; renderView(); });
    $('btnListTab').addEventListener('click', function () { viewTab = 'list'; renderView(); });
    $('searchInput').addEventListener('input', doSearch);
    $('btnExpandAll').addEventListener('click', function () {
      if (!data) return;
      if (anyCollapsedBranch()) collapsed = new Set(); /* 还有折叠分支 -> 展开全部 */
      else collapsed = C.defaultCollapsed(data, 6);    /* 已全展开 -> 回到只看前 6 世 */
      renderTree();
    });
    $('btnZoomIn').addEventListener('click', function () { var r = $('treeWrap').getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.25); });
    $('btnZoomOut').addEventListener('click', function () { var r = $('treeWrap').getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 0.8); });
    $('btnZoomReset').addEventListener('click', function () { cancelPanAnim(); zoom = 1; pan = { x: 10, y: 10 }; applyTransform(); });
    /* 树图交互：手势统一由画布容器（#treeWrap）处理——点按 / 单指平移 / 双指捏合 / 滚轮缩放。
       人物卡片不挂任何手势处理、也不截断 pointerdown；落点只在按下时记录，
       供抬起时做点按判定（<8px 且 <300ms）：标尺世代 -> 轮转定位本世成员，
       徽标 -> 展开/折叠，卡片 -> 简介气泡，空白 -> 关气泡；从标尺起手拖动同样只平移、不触发定位。 */
    var wrap = $('treeWrap');
    var pointers = new Map(); /* pointerId -> {x, y}（client 坐标） */
    var gesture = null; /* {mode:'pan', lastX, lastY} | {mode:'pinch', dist, cx, cy} */
    var downInfo = null; /* 单指按下时的点按判定信息 */
    var TAP_MAX_DIST = 8, TAP_MAX_MS = 300;
    wrap.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('#nodePop')) return; /* 弹层内有自己的按钮与滚动，不参与画布手势 */
      cancelPanAnim(); /* 手势接管：标尺定位的平滑平移动画立即让位 */
      try { wrap.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件等场景忽略 */ }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        var badge = e.target.closest('[data-badge]');
        var node = e.target.closest('.tnode');
        var rulerLabel = e.target.closest('.ruler-label');
        downInfo = {
          sx: e.clientX, sy: e.clientY, time: Date.now(), moved: false,
          badgeId: badge ? badge.getAttribute('data-badge') : null,
          nodeId: node ? node.getAttribute('data-id') : null,
          rulerRow: rulerLabel ? Number(rulerLabel.getAttribute('data-row')) : null
        };
        gesture = { mode: 'pan', lastX: e.clientX, lastY: e.clientY };
      } else if (pointers.size === 2) {
        var pts = Array.from(pointers.values());
        gesture = {
          mode: 'pinch',
          dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
          cx: (pts[0].x + pts[1].x) / 2, cy: (pts[0].y + pts[1].y) / 2
        };
        downInfo = null; /* 进入捏合后取消点按判定 */
      }
    });
    wrap.addEventListener('click', function (e) {
      /* 仅兜底键盘触发（detail===0）的徽标激活；鼠标/触摸的点按已在 pointerup 判定，避免重复触发 */
      if (e.detail !== 0) return;
      var badge = e.target.closest('[data-badge]');
      if (badge) toggleCollapse(badge.getAttribute('data-badge'));
    });
    wrap.addEventListener('pointermove', function (e) {
      if (!pointers.has(e.pointerId) || !gesture) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (gesture.mode === 'pan' && pointers.size === 1) {
        if (downInfo && Math.hypot(e.clientX - downInfo.sx, e.clientY - downInfo.sy) >= TAP_MAX_DIST) downInfo.moved = true;
        pan.x += e.clientX - gesture.lastX;
        pan.y += e.clientY - gesture.lastY;
        gesture.lastX = e.clientX;
        gesture.lastY = e.clientY;
        popDragFrame = true; /* 本帧由用户单指拖动触发：气泡走中心吸附规则（见 placeNodePop） */
        applyTransform();
      } else if (gesture.mode === 'pinch' && pointers.size === 2) {
        var pts = Array.from(pointers.values());
        var dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        var cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
        var rect = wrap.getBoundingClientRect();
        pan.x += cx - gesture.cx; /* 两指中点位移 -> 平移 */
        pan.y += cy - gesture.cy;
        if (gesture.dist > 0 && dist > 0) {
          zoomAt(cx - rect.left, cy - rect.top, dist / gesture.dist); /* 以中点为锚点缩放，复用滚轮的 zoomAt；其内部已 applyTransform */
        } else {
          applyTransform();
        }
        gesture.dist = dist; gesture.cx = cx; gesture.cy = cy;
      }
    });
    function endPointer(e, cancelled) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (!cancelled && downInfo && pointers.size === 0) {
        var quick = Date.now() - downInfo.time < TAP_MAX_MS;
        var still = !downInfo.moved && Math.hypot(e.clientX - downInfo.sx, e.clientY - downInfo.sy) < TAP_MAX_DIST;
        if (quick && still) {
          if (downInfo.rulerRow !== null && downInfo.rulerRow !== undefined) focusNextInRow(downInfo.rulerRow);
          else if (downInfo.badgeId) toggleCollapse(downInfo.badgeId);
          else if (downInfo.nodeId) showNodePop(downInfo.nodeId);
          else hideNodePop();
        }
      }
      if (pointers.size === 0) {
        gesture = null;
        downInfo = null;
      } else if (pointers.size === 1) {
        /* 捏合中抬起一指：以剩余指的当前位置重设基准，切回单指平移，不跳变 */
        var rest = Array.from(pointers.values())[0];
        gesture = { mode: 'pan', lastX: rest.x, lastY: rest.y };
        downInfo = null;
      }
    }
    wrap.addEventListener('pointerup', function (e) { endPointer(e, false); });
    wrap.addEventListener('pointercancel', function (e) { endPointer(e, true); });
    wrap.addEventListener('wheel', function (e) {
      if (e.target.closest && e.target.closest('#nodePop')) return; /* 气泡内滚轮留给简介区内部滚动，不缩放画布 */
      e.preventDefault();
      cancelPanAnim();
      var rect = wrap.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 0.89);
    }, { passive: false });
    window.addEventListener('resize', function () { if (data && viewTab === 'tree') applyTransform(); });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    var av = $('appVersion');
    if (av) av.textContent = 'v' + APP_VERSION;
    bind();
    /* 启动默认进入「查看」：有本机草稿就看草稿，没有就载入内置示例直接看树图 */
    var loaded = false, fromDraft = false;
    try {
      var draft = localStorage.getItem(LS_KEY);
      if (draft) {
        var r = C.parseImport(draft);
        if (r.ok && r.data.generations.length) {
          data = r.data;
          collapsed = C.defaultCollapsed(data, 6);
          loaded = true; fromDraft = true;
        }
      }
    } catch (e) { /* 忽略损坏草稿 */ }
    if (!loaded && window.FT_SAMPLE_DATA) {
      data = clone(window.FT_SAMPLE_DATA);
      collapsed = C.defaultCollapsed(data, 6);
      pristineSample = true; /* 示例未写入草稿存储，覆盖它不需确认 */
      loaded = true;
    }
    if (loaded) {
      mode = 'view';
      showApp();
      renderAll();
      if (fromDraft) toast('已恢复上次编辑的草稿（' + C.countPeople(data) + ' 人）');
    } else {
      showStart();
      syncModeUI();
    }
    if ('serviceWorker' in navigator) {
      try { navigator.serviceWorker.register('sw.js').catch(function () { /* 壳环境注册失败静默 */ }); }
      catch (e) { /* 静默兜底 */ }
    }
  }
  document.addEventListener('DOMContentLoaded', init);
})();
