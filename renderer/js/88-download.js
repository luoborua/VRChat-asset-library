/* ============ 88-download.js ============ */
/* =====================================================================
 * 88-download.js  —  下载队列 + 下载任务悬浮窗（v2.3.4）
 *   · 并发执行：同时下载的文件数可设置（1~8，默认 4），单文件 ≥16MB 且支持 Range 时后端还会分段下载
 *   · 队列落盘：vrclib-data\download-queue.json，刷新 / 重开后恢复未完成任务
 *   · 悬浮窗：可拖动；拖到屏幕边缘自动吸附并折叠成竖条，鼠标移入展开、移出收起
 * ===================================================================== */

var DLQueue = (function () {
  var tasks = [];
  var polls = Object.create(null);   // v2.3.13：每个任务各自的进度轮询（并发时不能共用一个），id -> interval
  var seq = 0;
  var listeners = [];
  /** 同时下载的文件数：settings.dlConcurrency（1~8，默认 4） */
  function maxParallel() {
    var n = Number((typeof App !== 'undefined' && App.settings && App.settings.dlConcurrency) || 4);
    if (!isFinite(n) || n < 1) n = 1;
    return Math.max(1, Math.min(8, Math.round(n)));
  }
  function runningCount() { return tasks.filter(function (t) { return t.state === 'running'; }).length; }
  function stopPoll(id) { var p = polls[id]; if (p) { clearInterval(p); delete polls[id]; } }

  function nid() { return 'dlq_' + Date.now().toString(36) + '_' + (++seq); }
  /* v4.3.2：进度轮询每 600ms × 每个并发任务各触发一次 notify，
   * 而监听方是整个任务列表重绘 + 页面上所有下载按钮的 SVG 重建。
   * 同时下 4 个文件时约 7 次/秒全量重绘，滚动和输入都发涩。
   * 这里合并到 150ms 一次，尾随的那次一定会补上，不会漏掉最终状态。 */
  var notifyTimer = 0;
  var notifyAgain = false;
  function notifyNow() { listeners.forEach(function (f) { try { f(tasks); } catch (e) {} }); }
  function notify() {
    if (notifyTimer) { notifyAgain = true; return; }
    notifyTimer = setTimeout(function () {
      notifyTimer = 0;
      var again = notifyAgain; notifyAgain = false;
      notifyNow();
      if (again) notify();
    }, 150);
  }
  /** 需要立刻看到结果的地方（移除 / 清空 / 状态翻转）用它，绕过节流 */
  function notifySync() {
    if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = 0; notifyAgain = false; }
    notifyNow();
  }
  function onChange(f) { listeners.push(f); }
  function list() { return tasks; }
  function activeCount() { return tasks.filter(function (t) { return t.state === 'pending' || t.state === 'running'; }).length; }
  function findByDst(dst) { return tasks.filter(function (t) { return t.dst === dst && t.state !== 'failed'; })[0]; }

  /** 落盘（只存未完成与失败的；后端离线时静默跳过） */
  function persist() {
    try {
      if (typeof Store === 'undefined' || !Store.local) return;
      var keep = tasks.filter(function (t) { return t.state !== 'done'; });
      /* v2.5.3：失败项只保留最近 50 条。原来失败项永不清除（clearDone 只清 done、findByDst 又跳过 failed），
       * 批量下载遇死链时 download-queue.json 只增不减。 */
      var failedList = keep.filter(function (t) { return t.state === 'failed'; });
      if (failedList.length > 50) {
        var dropIds = {};
        failedList.slice(0, failedList.length - 50).forEach(function (t) { dropIds[t.id] = 1; });
        keep = keep.filter(function (t) { return !dropIds[t.id]; });
      }
      keep = keep.map(function (t) {
        return { id: t.id, url: t.url, name: t.name, dst: t.dst, assetId: t.assetId,
          overwrite: !!t.overwrite, expectSize: t.expectSize || 0,
          state: t.state === 'running' ? 'pending' : t.state, error: t.error || '',
          addedAt: t.addedAt, received: t.received || 0, total: t.total || 0 };
      });
      Store.local.saveQueue(keep);
    } catch (e) {}
  }

  function enqueue(opts) {
    var dup = findByDst(opts.dst);
    // v2.5.0：重新下载——同名任务若已完成 / 失败，就地重置重跑（普通入队仍去重，避免重复下载）
    if (dup && dup.state === 'running') return dup;   // v2.5.1（P1）：正在下载的同名任务绝不重置——否则同一文件会并发下两次
    if (dup && dup.state !== 'done' && dup.state !== 'failed' && !opts.overwrite) return dup;
    if (dup) {
      dup.url = opts.url; dup.name = opts.name; if (opts.assetId) dup.assetId = opts.assetId;
      dup.state = 'pending'; dup.received = 0; dup.total = 0; dup.speed = 0; dup.attempt = 0; dup.error = '';
      dup.overwrite = !!opts.overwrite; dup.expectSize = opts.expectSize || 0;
      dup.addedAt = new Date().toISOString();
      persist(); notify(); kick();
      return dup;
    }
    var t = { id: nid(), url: opts.url, name: opts.name, dst: opts.dst, assetId: opts.assetId || '',
      overwrite: !!opts.overwrite, expectSize: opts.expectSize || 0,
      state: 'pending', received: 0, total: 0, speed: 0, attempt: 0, error: '', addedAt: new Date().toISOString() };
    tasks.push(t);
    persist(); notify(); kick();
    return t;
  }

  /**
   * 空闲时同步启动。两个要点：
   *  · 不用 setTimeout：后台标签页会把定时器钳到 1 秒，首个任务会被拖延；
   *  · 自愈：running 为真但队列里已没有任何 running 任务（任务被移除 / 上一次执行异常中断），
   *    说明这个标志被占住了，必须复位，否则后续任务永远排队不动。
   */
  /** 有空位就开新任务（并发上限 = settings.dlConcurrency） */
  function kick() {
    var max = maxParallel();
    for (var guard = 0; guard < 64; guard++) {
      if (runningCount() >= max) break;
      var next = tasks.filter(function (x) { return x.state === 'pending'; })[0];
      if (!next) break;
      start(next);
    }
    if (!tasks.some(function (t) { return t.state === 'running' || t.state === 'pending'; })) { notify(); persist(); }
  }

  function start(t) {
    t.state = 'running'; t.error = ''; t.received = 0; t.speed = 0; t.attempt = 0; t.segments = 1;
    notify(); persist();
    var jobId = 'dl_' + t.id;
    stopPoll(t.id);
    polls[t.id] = setInterval(function () {
      FS.host.downloadProgress(jobId).then(function (j) {
        if (!j || !j.ok) return;
        t.received = j.received || 0; t.total = j.total || 0; t.speed = j.speed || 0;
        t.attempt = j.attempt || 0; t.segments = j.segments || 1;
        if (j.error) t.error = j.error;
        notify();
      }).catch(function () {});
    }, 600);
    FS.downloadToPath(t.url, t.dst, null, jobId, !!t.overwrite).then(function (res) {
      stopPoll(t.id);
      /* v4.3.2：任务已被用户移除 / 取消 → 不弹提示、不改素材、不写队列，直接收尾 */
      if (t.state === 'cancelled' || !tasks.some(function (x) { return x.id === t.id; })) {
        tasks = tasks.filter(function (x) { return x.id !== t.id; });
        notify(); persist(); kick();
        return;
      }
      if (!res) { t.state = 'failed'; t.error = t.error || '下载失败（后端离线或链接无效）'; }
      else if (t.total > 0 && res.size && res.size !== t.total) {
        // v2.5.0（S6）：与服务器 Content-Length 不符 = 下载被截断 → 标失败可重试
        t.state = 'failed';
        t.error = '下载不完整：实际 ' + fmtSize(res.size) + ' / 服务器 ' + fmtSize(t.total);
      }
      else {
        t.state = 'done'; t.received = res.size || t.received; t.total = t.total || t.received; t.speed = 0;
        // v2.5.0（S6）：与订单页【记录】的大小不同不算失败（可能是作者更新了文件），只提示
        t.sizeWarn = (t.expectSize && res.size && res.size !== t.expectSize)
          ? '与订单页记录的大小不同（实际 ' + fmtSize(res.size) + ' / 记录 ' + fmtSize(t.expectSize) + '），可能是作者更新了文件，可点「获取更新」刷新记录'
          : '';
        if (t.assetId) {
          var a = (App.assets || []).filter(function (x) { return x.id === t.assetId; })[0];
          if (a) {
            a.downloadedFiles = uniq((a.downloadedFiles || []).concat([String(t.name)]));
            if (!a.downloaded) { a.downloaded = true; a.downloadedAt = new Date().toISOString(); }
            App.save(a);
          }
        }
        Toast.ok((t.overwrite ? '已重新下载：' : '已下载：') + t.name + (t.overwrite ? '（已覆盖旧文件）' : (res.exists ? '（同名已存在，跳过）' : '')), 3600);
        if (t.sizeWarn) Toast.warn(t.name + '：' + t.sizeWarn, 6800);
      }
      notify(); persist(); kick();
    }).catch(function (e) {
      stopPoll(t.id);
      if (t.state === 'cancelled' || !tasks.some(function (x) { return x.id === t.id; })) {
        tasks = tasks.filter(function (x) { return x.id !== t.id; });
        notify(); persist(); kick();
        return;
      }
      t.state = 'failed'; t.error = (e && e.message ? e.message : String(e));
      notify(); persist(); kick();
    });
  }

  function retry(id) {
    var t = tasks.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    t.state = 'pending'; t.error = ''; t.received = 0;
    persist(); notify(); kick();
  }
  function remove(id) {
    var t = tasks.filter(function (x) { return x.id === id; })[0];
    stopPoll(id);
    /* v4.3.2：正在跑的任务不能只是从列表里删掉 —— 后端那边还在下，
     * 会继续占着「同一文件正在下载中」的互斥表，用户马上重下就直接失败；
     * 下完还会给一个已经不存在于队列的任务弹「已下载」提示。
     * 现在先标记 cancelled 并让后端真正中断，等后端回调收尾时再移除。 */
    if (t && t.state === 'running') {
      t.state = 'cancelled';
      try { if (FS.host && FS.host.downloadCancel) FS.host.downloadCancel('dl_' + t.id).catch(function () {}); } catch (e) {}
      persist(); notifySync(); kick();
      return;
    }
    tasks = tasks.filter(function (x) { return x.id !== id; });
    persist(); notifySync(); kick();
  }
  function clearDone() {
    tasks = tasks.filter(function (x) { return x.state !== 'done' && x.state !== 'cancelled'; });
    persist(); notifySync();
  }
  /** v2.5.1（F1）：把已完成的任务就地重下（队列面板里的「重下」按钮） */
  function reenqueue(id) {
    var t = tasks.filter(function (x) { return x.id === id; })[0];
    if (!t) return null;
    if (t.state === 'running') return t;
    t.state = 'pending'; t.received = 0; t.total = 0; t.speed = 0; t.attempt = 0; t.error = ''; t.overwrite = true;
    persist(); notify(); kick();
    return t;
  }
  function retryAllFailed() {
    tasks.forEach(function (t) { if (t.state === 'failed') { t.state = 'pending'; t.error = ''; } });
    persist(); notify(); kick();
  }
  /** 启动时恢复未完成任务（running 视为 pending 重跑） */
  function restore() {
    if (typeof Store === 'undefined' || !Store.local) return Promise.resolve(0);
    return Store.local.loadQueue().then(function (saved) {
      if (!saved.length) return 0;
      saved.forEach(function (s) {
        if (!s || !s.url || !s.dst) return;
        /* v2.5.3：原来一律以 pending 压回，于是**上次失败的任务每次开页面都自动重跑一遍**。
         * 现在失败项按 failed 恢复（仍然看得见、可用「重试」按钮手动重跑），未完成项照旧续跑。 */
        tasks.push({ id: s.id || nid(), url: s.url, name: s.name || '下载文件', dst: s.dst, assetId: s.assetId || '',
          overwrite: !!s.overwrite, expectSize: s.expectSize || 0,
          state: (s.state === 'failed') ? 'failed' : 'pending', received: 0, total: s.total || 0, speed: 0, attempt: 0,
          error: s.error || '', addedAt: s.addedAt || new Date().toISOString() });
      });
      notify(); kick();
      return tasks.length;
    }).catch(function () { return 0; });
  }

  return { enqueue: enqueue, retry: retry, reenqueue: reenqueue, remove: remove, clearDone: clearDone, retryAllFailed: retryAllFailed,
    restore: restore, list: list, onChange: onChange, activeCount: activeCount };
})();

/* v2.3.10：队列状态一变，就把页面上带 data-dl-url 的下载按钮刷成真实状态
 * （此前按钮只在点击那一刻改字：正在下载也显示「排队中」，关掉详情再打开又变回「下载」） */
DLQueue.onChange(function (tasks) {
  try { if (typeof App !== 'undefined' && App.syncDownloadButtons) App.syncDownloadButtons(tasks); } catch (e) {}
});

/* ---------------- 下载任务悬浮窗 ---------------- */
var DLPanel = (function () {
  var root = null, bodyEl = null, headEl = null, badgeEl = null;
  var st = { y: null, dock: '' };

  function sz(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
  function loadState() {
    var s = (App.settings && App.settings.dlPanel) || {};
    st.y = (typeof s.y === 'number') ? s.y : null;
    /* v6.9：只贴右边。左边是页签栏，吸附过去会压住导航，所以干脆不给这个能力；
     * 老配置里存的 dock:'left' 与 x 一律忽略（下次保存就被覆盖掉）。 */
    st.dock = 'right';
  }
  function saveState() {
    App.settings.dlPanel = { y: st.y, dock: 'right' };
    App.saveSettings();
  }
  function place() {
    if (!root) return;
    root.style.left = 'auto';
    root.style.right = '0px';
    var h = root.offsetHeight || 80;
    var y = (st.y == null) ? 96 : st.y;
    root.style.top = Math.max(0, Math.min(window.innerHeight - h, y)) + 'px';
  }
  function applyDock() {
    root.classList.add('dl-docked-right');
    root.classList.remove('dl-docked-left');
    root.classList.add('dl-collapsed');
  }
  /** 显示悬浮窗（v2.3.12：隐藏态已随「关闭」按钮一起移除） */
  function show() { if (!root) return; root.style.display = ''; }

  function build() {
    headEl = el('div', { class: 'dl-head' }, [
      el('span', { class: 'dl-title'}, ICONS.label('\u2B07 下载任务')),
      badgeEl = el('span', { class: 'dl-badge', text: '0' }),
      el('span', { class: 'dl-spacer' }),
      el('button', { class: 'dl-btn', title: '重试全部失败项', onclick: function () { DLQueue.retryAllFailed(); } }, ICONS.label('\u21BB')),
      el('button', { class: 'dl-btn', title: '清空已完成', onclick: function () { DLQueue.clearDone(); } }, ICONS.label('\u{1F5D1}'))
    ]);   // v2.3.8：去掉「折叠 / 展开」与「关闭」按钮——贴边即折叠、鼠标移入展开
    bodyEl = el('div', { class: 'dl-body' });
    root = el('div', { class: 'dl-panel', id: 'dlPanel' }, [headEl, bodyEl]);
    document.body.appendChild(root);

    /* v6.9：只能在右边。按住标题栏只剩下上下拖，横向锁死在右边缘——
     * 以前松手会按水平中心吸附左/右，拖到左半边就贴在页签栏上盖住导航，很碍事。 */
    headEl.addEventListener('mousedown', function (ev) {
      if (ev.target && ev.target.tagName === 'BUTTON') return;
      var r = root.getBoundingClientRect();
      var oy = ev.clientY - r.top;
      root.classList.add('dl-dragging');
      root.classList.remove('dl-collapsed');
      function mv(e) {
        st.y = Math.max(0, Math.min(window.innerHeight - r.height, e.clientY - oy));
        place();
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        root.classList.remove('dl-dragging');
        applyDock(); place(); saveState();
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
      ev.preventDefault();
    });
    // 贴边后：移入展开、移出收起
    root.addEventListener('mouseenter', function () { if (st.dock) root.classList.remove('dl-collapsed'); });
    root.addEventListener('mouseleave', function () { if (st.dock) root.classList.add('dl-collapsed'); });
    window.addEventListener('resize', function () { place(); });
  }

  function render(tasks) {
    if (!root) return;
    tasks = tasks || [];
    var act = DLQueue.activeCount();
    badgeEl.textContent = String(act);
    bodyEl.innerHTML = '';
    if (!tasks.length) {
      bodyEl.appendChild(el('div', { class: 'dl-empty', text: '队列为空。在详情页点「\u2B07 下载」就会排到这里。' }));
      return;
    }
    tasks.slice().reverse().forEach(function (t) {
      var pct = (t.total > 0) ? Math.min(100, Math.floor(t.received / t.total * 100)) : (t.state === 'done' ? 100 : 0);
      var stat = t.state === 'done' ? ICONS.label('\u2714 已完成')
        : t.state === 'failed' ? ICONS.label('\u2716 ' + (t.error || '失败'))
        : t.state === 'running' ? ICONS.label('\u23F3 下载中 ' + (t.total > 0 ? pct + '%' : sz(t.received)) + (t.speed ? ' · ' + sz(t.speed) + '/s' : '') + (t.segments > 1 ? ' · 分段×' + t.segments : '') + (t.attempt > 1 ? ' · 第 ' + t.attempt + ' 次' : ''))
        : '排队中';
      bodyEl.appendChild(el('div', { class: 'dl-task dl-' + t.state }, [
        el('div', { class: 'dl-name', title: t.dst || t.name }, t.name),
        el('div', { class: 'dl-bar' }, [el('i', { style: { width: pct + '%' } })]),
        el('div', { class: 'dl-stat' }, [
          /* v3.0.2 修复（用户截图：这里显示 `[object HTMLSpanElement],[object Text]`）：
           * stat 是 ICONS.label() 的**节点数组**（如 [SVG, 文本节点]）或纯字符串 '排队中'；
           * 写成 `text: stat` 会走 node.textContent = v ⇒ String(数组) 变成 "[object …],[object …]"。
           * 正确做法是当作 **children** 传（el() 的 appendChildren 会展平数组、并把字符串转成文本节点）。 */
          el('span', { class: 'dl-state' }, stat),
          el('span', { class: 'dl-spacer' }),
          t.state === 'failed' ? el('button', { class: 'dl-btn', onclick: function () { DLQueue.retry(t.id); } }, '重试') : null,
          t.state === 'done' ? el('button', { class: 'dl-btn', title: '重新下载（覆盖这个文件）', onclick: function () { DLQueue.reenqueue(t.id); } }, '重下') : null,
          t.state !== 'running' ? el('button', { class: 'dl-btn', onclick: function () { DLQueue.remove(t.id); } }, '移除') : null
        ])
      ]));
    });
  }

  function init() {
    loadState();
    build();
    applyDock(); place();
    DLQueue.onChange(render);
    render(DLQueue.list());
  }
  return { init: init, show: show, render: render, isDocked: function () { return !!st.dock; } };
})();


