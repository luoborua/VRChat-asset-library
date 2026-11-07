/*
 * 85-tools.js  —  批量操作 / 整理辅助 / 快捷工具
 *
 * 负责：多选后的批量改分类、加标签、加角色、隐藏、删除、导出，
 *       以及目录结构建议、磁盘对账、批量更新商品信息、批量抓订单更新、批量下载缺失文件。
 * 与谁交互：App / Store / FS.host / DLQueue；落盘一律经后端，不自己写文件。
 * 边界：只处理选中的素材，不碰库外文件；删除条目时不动磁盘上的内容。
 */

var Tools = {

  /** 建议目录结构 */
  structurePlan: function () {
    var assets = App.filtered();
    if (!assets.length) { Toast.warn('当前没有可整理的素材'); return; }
    var rootIn = el('input', { class: 'input mono', value: App.libraryRoot() });   // 默认填当前生效的素材库根
    var pre = el('pre', { class: 'tree-pre' });
    var plan = null;
    function build() {
      plan = FS.buildStructurePlan(assets, rootIn.value.trim() || '素材库');
      pre.textContent = plan.text;
    }
    rootIn.addEventListener('input', debounce(build, 250));
    build();

    var h = Modal.open({
      title: '建议目录结构（分类 / 支持角色 两级）', size: 'lg',
      body: [
        el('div', { class: 'field-hint', text: '按「分类 → 支持角色」两级组织，可复制结构或下载一键创建文件夹的批处理脚本。仅创建目录，不会移动你的任何文件；真实整理 / 归档请交给程序后端或资源管理器执行。' }),
        Field.row('根目录', rootIn),
        pre
      ],
      footer: [
        el('button', { class: 'btn', onclick: function () { copyText(pre.textContent).then(function () { Toast.ok('结构已复制'); }); } }, ICONS.label('\u{1F4CB} 复制结构')),
        el('button', { class: 'btn', onclick: function () {
          var blob = new Blob(['\uFEFF' + plan.bat], { type: 'text/plain;charset=utf-8' });
          downloadBlob(blob, '创建素材库目录.bat');
          Toast.ok('已下载批处理脚本，双击运行即可创建目录');
        } }, ICONS.label('\u2B07 下载 .bat 创建脚本')),
        el('button', { class: 'btn btn-primary', onclick: function () { Modal.close(h); } }, '关闭')
      ]
    });
  },

  /* ---------------- 素材库体检（磁盘对账） ----------------
   * 真去扫存储目录，分三类：路径扫不到 / 库里有记录但磁盘缺失 / 磁盘有文件但库里没记录。 */
  pathAudit: function () {
    var logBox = el('div', { class: 'audit-log' });
    var reportBox = el('div', {});
    var startBtn = el('button', { class: 'btn btn-primary' }, ICONS.label('\u{1F50E} 开始扫描磁盘'));
    var running = false, cancelled = false;
    function log(t) { logBox.appendChild(el('div', { class: 'field-hint', text: t })); logBox.scrollTop = logBox.scrollHeight; }
    function itemBtn(a, extra) {
      return el('button', { class: 'audit-item', onclick: function () { Modal.closeTop(); Modals.detail(a.id); } },
        (a.title || a.originalTitle || '(未命名)') + '  —  ' + App.categoryLabel(a.category) + (extra ? '  ' + extra : ''));
    }
    function listOf(arr) {
      if (!arr.length) return el('div', { class: 'multi-empty', text: '无' });
      return el('div', { class: 'audit-list' }, arr.slice(0, 200).map(function (x) { return x.node; }));
    }
    var h = Modal.open({
      title: '素材库体检（磁盘对账）', size: 'md',
      body: [
        el('div', { class: 'notice' }, [
          el('p', { text: '对照「素材库记录」与「存储目录里的真实文件」：找出路径失效、记录里有但磁盘缺失、磁盘上有但库里没登记的文件。' }),
          el('p', { text: '联网列出需要「内置联网」模式（设置 → 联网与抓取）；离线模式下只能列出未关联路径的素材。' })
        ]),
        logBox, reportBox
      ],
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '关闭'),
        // 素材多时串行扫描很久，给一个能随时停下的取消
        el('button', { class: 'btn', onclick: function () { if (running) { cancelled = true; Toast.info('已请求停止扫描（当前素材跑完就停）'); } } }, '停止扫描'),
        startBtn
      ]
    });
    startBtn.onclick = function () {
      if (running) return;
      cancelled = false;
      running = true; startBtn.disabled = true; ICONS.apply(startBtn, ('\u23F3 扫描中 …'));
      logBox.innerHTML = ''; reportBox.innerHTML = '';
      var noPath = App.assets.filter(function (a) { return !App.primaryLocalPath(a); });
      var targets = App.assets.filter(function (a) { return !!App.primaryLocalPath(a); });
      log('未关联本地路径：' + noPath.length + ' 个；有本地路径：' + targets.length + ' 个，开始逐个扫描 …');
      var scanned = [], i = 0;
      var chain = Promise.resolve();
      targets.forEach(function (a) {
        chain = chain.then(function () {
          if (cancelled) return null;
          return App.localFileAudit(a).then(function (st) {
            i++;
            if (i % 25 === 0) log('已扫描 ' + i + '/' + targets.length + ' …');
            scanned.push({ a: a, st: st });
          });
        });
      });
      chain.then(function () {
        var offline = scanned.filter(function (x) { return x.st.error === 'offline' || x.st.error === 'no-host'; });
        var badDir = scanned.filter(function (x) { return x.st.error === 'missing-dir'; });
        var miss = scanned.filter(function (x) { return x.st.missing && x.st.missing.length; });
        var extra = scanned.filter(function (x) { return x.st.extra && x.st.extra.length; });
        var missFiles = miss.reduce(function (n, x) { return n + x.st.missing.length; }, 0);
        var extraFiles = extra.reduce(function (n, x) { return n + x.st.extra.length; }, 0);
        log((cancelled ? '已停止，' : '') + '扫描完成：' + scanned.length + ' 个素材。');
        reportBox.appendChild(el('h3', { text: '未关联本地路径（' + noPath.length + '）' }));
        reportBox.appendChild(listOf(noPath.map(function (a) { return { node: itemBtn(a) }; })));
        reportBox.appendChild(el('h3', { text: '存储目录不存在 / 扫不到（' + badDir.length + '）' }));
        reportBox.appendChild(listOf(badDir.map(function (x) { return { node: itemBtn(x.a, '— ' + x.st.dir) }; })));
        reportBox.appendChild(el('h3', { text: '库里有记录但磁盘缺失（' + miss.length + ' 个素材 / ' + missFiles + ' 个文件）' }));
        reportBox.appendChild(listOf(miss.map(function (x) {
          return { node: itemBtn(x.a, '— 缺 ' + x.st.missing.length + ' 个：' + x.st.missing.slice(0, 3).join('、') + (x.st.missing.length > 3 ? ' …' : '')) };
        })));
        reportBox.appendChild(el('h3', { text: '磁盘上有文件但库里没登记（' + extra.length + ' 个素材 / ' + extraFiles + ' 个文件）' }));
        if (!extra.length) reportBox.appendChild(el('div', { class: 'multi-empty', text: '无' }));
        else {
          // 光发现没用：每个未登记文件给「登记」与「删除」两个动作，删除要二次确认
          var extraBox = el('div', { class: 'audit-list' });
          extra.slice(0, 60).forEach(function (x) {
            x.st.extra.slice(0, 8).forEach(function (nm) {
              var full = joinWinPath(x.st.dir, [nm]);
              extraBox.appendChild(el('div', { class: 'link-row' }, [
                el('code', { class: 'path', title: full }, (x.a.title || x.a.originalTitle || '(未命名)') + ' — ' + nm),
                el('button', { class: 'btn btn-xs', title: '把它登记为该素材已下载的文件（不删文件）', onclick: function () {
                  x.a.downloadedFiles = uniq((x.a.downloadedFiles || []).concat([nm]));
                  App.save(x.a).then(function () { Toast.ok('已登记：' + nm); });
                } }, '登记'),
                el('button', { class: 'btn btn-xs btn-danger-ghost', title: '删除磁盘上的这个文件（不可撤销）', onclick: function () {
                  Modal.confirm('删除磁盘上的文件「' + nm + '」？此操作不可撤销。', { okText: '删除' }).then(function (ok) {
                    if (!ok) return;
                    FS.host.remove(full).then(function () { Toast.ok('已删除：' + nm); }, function (e) { Toast.err('删除失败：' + ((e && e.message) || e)); });
                  });
                } }, '删除')
              ]));
            });
          });
          reportBox.appendChild(extraBox);
        }
        var noCover = App.assets.filter(function (a) { return !a.hasCover && !a.coverURL; });
        reportBox.appendChild(el('h3', { text: '缺少封面图（' + noCover.length + '）' }));
        reportBox.appendChild(listOf(noCover.map(function (a) { return { node: itemBtn(a) }; })));
        if (offline.length) reportBox.appendChild(el('div', { class: 'field-hint', text: '⚠ ' + offline.length + ' 个素材未能扫描：后端调用失败（这些素材没被判定为缺失）。' }));
        startBtn.disabled = false; ICONS.apply(startBtn, ('\u{1F50E} 重新扫描')); running = false;
      }).catch(function (e) {
        log('扫描中断：' + (e && e.message ? e.message : e));
        startBtn.disabled = false; ICONS.apply(startBtn, ('\u{1F50E} 重新扫描')); running = false;
      });
    };
  },

  importCSVHelp: function () {
    Modal.open({
      title: 'CSV 导入说明', size: 'md', body: [
        el('p', { text: '导出的 CSV 主要用于在 Excel / WPS 中比对本地文件，不作为回填格式。若需批量导入，请使用 JSON 备份格式（导出→编辑→导入），字段结构如下：' }),
        el('pre', { class: 'tree-pre', text: JSON.stringify({
          app: APP.name, version: APP.version,
          assets: [{
            id: 'as_xxx', title: '自定义标题', originalTitle: '原标题',
            source: 'booth', links: [{ url: 'https://…', label: '商品页' }],
            category: 'clothing', tags: ['连衣裙', '冬季'], avatars: ['chiffon'],
            paths: [{ path: '<素材库根>\\衣装\\戚风\\冬季毛衣', note: '' }],   // 示例路径，中性写法
            downloaded: true, downloadedAt: '2024-01-01T00:00:00.000Z',
            coverURL: '', note: '备注'
          }]
        }, null, 2) }),
        el('p', { class: 'field-hint', text: '分类内部标识：' + CATEGORIES.map(function (c) { return c.id + '=' + c.label; }).join('，') }),
        el('p', { class: 'field-hint', text: '来源内部标识：' + SOURCES.map(function (c) { return c.id + '=' + c.label; }).join('，') })
      ]
    });
  },

  /* ---------------- 批量操作 ---------------- */
  /** 按分类整理素材目录：先列清单，确认后逐个把库内文件夹搬到对应分类目录 */
  categoryCleanup: function () {
    var plan = App.planCategoryCleanup();
    if (!plan.length) { Toast.info('没有需要整理的素材：库内素材都已经在对应分类目录里', 4200); return; }
    var rows = [];
    var shown = plan.slice(0, 200);
    shown.forEach(function (it) {
      rows.push(el('div', { class: 'link-row', style: { alignItems: 'flex-start' } }, [
        el('code', { class: 'path', style: { whiteSpace: 'normal', wordBreak: 'break-all' }, text: it.from + '  →  ' + it.to })
      ]));
    });
    if (plan.length > shown.length) rows.push(el('div', { class: 'field-hint', text: '…… 还有 ' + (plan.length - shown.length) + ' 项，确认后一并处理' }));
    var tip = el('div', { class: 'field-hint', text: '共 ' + plan.length + ' 项。只处理库内路径，库外登记的素材不碰；目标已有同名文件夹的会跳过并列出来。' });
    var running = false;
    var runBtn = el('button', { class: 'btn btn-primary', onclick: function () {
      if (running) return;
      running = true;
      runBtn.disabled = true;
      ICONS.apply(runBtn, '\u23F3 整理中 …');
      App.runCategoryCleanup(plan, function (i, n) { ICONS.apply(runBtn, '\u23F3 整理中 ' + i + '/' + n); }).then(function (res) {
        Modal.close(mh);
        UI.renderAll();
        if (res.failed.length) {
          Toast.warn('已移动 ' + res.moved + ' 项，' + res.failed.length + ' 项没搬成（多为目标同名或后端未就绪）：' + res.failed.slice(0, 3).map(function (f) { return f.name; }).join('、'), 8200);
        } else {
          Toast.ok('已整理 ' + res.moved + ' 项素材目录', 5200);
        }
      }).catch(function (e) {
        runBtn.disabled = false;
        ICONS.apply(runBtn, '\u{1F5C2} 开始整理');
        Toast.err('整理失败：' + ((e && e.message) || e), 7200);
      });
    } }, ICONS.label('\u{1F5C2} 开始整理'));
    var mh = Modal.open({
      title: '按分类整理素材目录（' + plan.length + ' 项）', size: 'lg',
      body: [el('div', { class: 'detail-stack' }, [tip].concat(rows))],
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(mh); } }, '取消'),
        runBtn
      ]
    });
  },
  bulkSetCategory: function () {
    var ids = App.selectedIds();
    if (!ids.length) { Toast.warn('请先选择素材'); return; }
    var sel = el('select', { class: 'input' }, App.allCategories().map(function (c) {
      return el('option', { value: c.id }, c.label);
    }));
    var h = Modal.open({
      title: '批量设置分类（' + ids.length + ' 项）', size: 'sm',
      body: [sel],
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '取消'),
        el('button', { class: 'btn btn-primary', onclick: function () {
          var list = App.assets.filter(function (a) { return ids.indexOf(a.id) >= 0; });
          var oldCats = list.map(function (a) { return a.category; });
          list.forEach(function (a) { a.category = sel.value; });
          Store.putAssets(list).then(function () {
            /* 库内文件夹跟着搬到新分类目录 */
            var chain = Promise.resolve();
            list.forEach(function (a, i) { chain = chain.then(function () { return App.relocateToCategory(a, oldCats[i]).catch(function () {}); }); });
            return chain;
          }).then(function () { Modal.close(h); UI.renderAll(); Toast.ok('已更新 ' + list.length + ' 项'); });
        } }, '应用')
      ]
    });
  },

  bulkAddTag: function () {
    var ids = App.selectedIds();
    if (!ids.length) { Toast.warn('请先选择素材'); return; }
    Modal.prompt('输入要批量添加的标签（逗号分隔可多个）：', '', { title: '批量添加标签' }).then(function (v) {
      if (!v || !v.trim()) return;
      var tags = v.split(/[,\uFF0C]/).map(function (s) { return s.trim(); }).filter(Boolean);
      var list = App.assets.filter(function (a) { return ids.indexOf(a.id) >= 0; });
      list.forEach(function (a) { a.tags = uniq((a.tags || []).concat(tags)); });
      Store.putAssets(list).then(function () { UI.renderAll(); Toast.ok('已为 ' + list.length + ' 项添加标签'); });
    });
  },

  bulkAddAvatar: function () {
    var ids = App.selectedIds();
    if (!ids.length) { Toast.warn('请先选择素材'); return; }
    var picker = Field.avatars([]);
    var h = Modal.open({
      title: '批量设置支持角色（' + ids.length + ' 项）', size: 'md',
      body: [el('div', { class: 'field-hint', text: '选中的角色会追加到所选素材上。' }), picker],
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '取消'),
        el('button', { class: 'btn btn-primary', onclick: function () {
          var avs = picker.getValue();
          if (!avs.length) { Toast.warn('请至少选择一个角色'); return; }
          var list = App.assets.filter(function (a) { return ids.indexOf(a.id) >= 0; });
          list.forEach(function (a) { a.avatars = uniq((a.avatars || []).concat(avs)); });
          Store.putAssets(list).then(function () { Modal.close(h); UI.renderAll(); Toast.ok('已更新 ' + list.length + ' 项'); });
        } }, '应用')
      ]
    });
  },

  bulkMarkDownloaded: function (flag) {
    var ids = App.selectedIds();
    if (!ids.length) { Toast.warn('请先选择素材'); return; }
    var list = App.assets.filter(function (a) { return ids.indexOf(a.id) >= 0; });
    list.forEach(function (a) { a.downloaded = flag; a.downloadedAt = flag ? nowISO() : ''; });
    Store.putAssets(list).then(function () { UI.renderAll(); Toast.ok('已标记 ' + list.length + ' 项为' + (flag ? '已下载' : '未下载')); });
  },

  /** 重新扫描磁盘状态：对选中素材跑磁盘对账，汇报正常 / 缺文件 / 路径失效 / 仅远端。 */
  rescanDiskState: function () {
    var ids = App.selectedIds();
    if (!ids.length) { Toast.warn('请先选择素材'); return; }
    var list = App.assets.filter(function (a) { return ids.indexOf(a.id) >= 0; });
    /* 只读对账：后端不可用也不该早退 —— App.localFileAudit 会降级到库根句柄（FSA）枚举。
     * 只有「后端离线且没有可用句柄」才如实说拿不到数字，不可判定不等于没有文件。 */
    FS.hostEnsure().then(function (hostOk) {
      var okN = 0, missN = 0, missFiles = 0, badN = 0, fsaN = 0, unverifiedN = 0;
      var chain = Promise.resolve();
      list.forEach(function (a) {
        chain = chain.then(function () {
          return App.localFileAudit(a).then(function (st) {
            if (st.error === 'offline' || st.error === 'no-host') { unverifiedN++; return; }   // 第三档：不可判定
            if (st.error) { badN++; return; }
            if (st.via === 'fsa') fsaN++;
            if (st.missing && st.missing.length) { missN++; missFiles += st.missing.length; } else okN++;
          });
        });
      });
      return chain.then(function () {
        if (!hostOk && !fsaN && unverifiedN) {
          Toast.warn('磁盘状态：后端不可用，且没有可用的素材库目录句柄，暂时无法核对磁盘（到「设置 → 本地库目录」选择一次即可）。共 ' + list.length + ' 个素材'
            + '。', 7600);
          return;
        }
        var how = hostOk ? '' : '（浏览器库目录校验）';
        Toast.ok('磁盘状态' + how + '：正常 ' + okN + ' 个；缺文件 ' + missN + ' 个（共 ' + missFiles + ' 个文件）；路径失效 ' + badN + ' 个'
          + (unverifiedN ? '；另有 ' + unverifiedN + ' 个暂时无法核对' : ''), 7600);
      });
    }).catch(function (e) { Toast.err('扫描失败：' + ((e && e.message) || e)); });
  },

  bulkToggleHidden: function (flag) {
    var ids = App.selectedIds();
    if (!ids.length) { Toast.warn('请先选择素材'); return; }
    var list = App.assets.filter(function (a) { return ids.indexOf(a.id) >= 0; });
    list.forEach(function (a) { a.hidden = flag; });
    Store.putAssets(list).then(function () { UI.renderAll(); Toast.ok((flag ? '已隐藏 ' : '已取消隐藏 ') + list.length + ' 项'); });
  },

  bulkDelete: function () {
    var ids = App.selectedIds();
    if (!ids.length) { Toast.warn('请先选择素材'); return; }
    /* 批量删除要列清对象：选中状态不随筛选变化清空，最容易误删到屏幕外的项。 */
    var list = App.assets.filter(function (a) { return ids.indexOf(a.id) >= 0; });
    var visible = Object.create(null);
    try { App.filtered().forEach(function (a) { visible[a.id] = 1; }); } catch (e) {}
    var offScreen = list.filter(function (a) { return !visible[a.id]; }).length;
    var names = list.slice(0, 10).map(function (a) { return '· ' + (a.title || a.originalTitle || '(未命名)'); }).join('\n');
    var msg = '确定删除选中的 ' + ids.length + ' 项素材吗？删掉的记录会进回收站，48 小时内可以找回。\n\n' + names
      + (list.length > 10 ? '\n… 另有 ' + (list.length - 10) + ' 项' : '')
      + (offScreen ? '\n\n⚠ 其中 ' + offScreen + ' 项不在当前筛选结果里（可能是选完又改了筛选/翻页）' : '');
    Modal.confirm(msg, { okText: '删除' }).then(function (ok) {
      if (!ok) return;
      var chain = Promise.resolve();
      ids.forEach(function (id) { chain = chain.then(function () { return App.remove(id); }); });
      chain.then(function () {
        App.clearSelection(); UI.renderAll();
        App.deletedToast(list);      // 一批只弹一个提示，撤回一次全回来
      });
    });
  },

  bulkExport: function () {
    var ids = App.selectedIds();
    var list = ids.length ? App.assets.filter(function (a) { return ids.indexOf(a.id) >= 0; }) : App.filtered();
    FS.downloadCSV(list);
  },

  /* ---------------- 批量粘贴链接快速建库 ---------------- */
  quickAdd: function () {
    var ta = el('textarea', { class: 'input textarea mono', rows: 8, placeholder: '每行一个商品链接，例如：\nhttps://booth.pm/ja/items/1234567\nhttps://xxx.booth.pm/items/7654321' });
    var logBox = el('div', { class: 'fetch-log', style: { display: 'none' } });
    var autoFetch = el('input', { type: 'checkbox', checked: true });
    function log(m) { logBox.style.display = ''; logBox.appendChild(el('div', { class: 'log-line', text: m })); logBox.scrollTop = logBox.scrollHeight; }

    var busy = false;
    var runBtn = null;
    var h = Modal.open({
      title: '批量添加（粘贴多个链接）', size: 'md',
      body: [
        el('div', { class: 'field-hint', text: '每行一个链接。工具会为每个链接创建一条素材记录（标题先占位，可稍后逐条补全）。' }),
        el('div', { class: 'notice' + (Net.networkAllowed() ? '' : ' notice-warn') }, [
          el('p', { text: Net.networkAllowed()
            ? '当前为联网抓取模式，将依次尝试获取标题、封面与标签；命中本地缓存的链接不会重复请求。数量多时耗时较长。'
            : '当前为「手动粘贴源码」模式（离线）：这里只会创建占位记录，不会联网。之后可逐条打开编辑页粘贴源码补全，或到「设置 → 联网与抓取」切换抓取方式。' })
        ]),
        ta,
        el('label', { class: 'check check-row' }, [autoFetch, el('span', { text: '同时联网抓取信息（需先在「设置 → 联网与抓取」选「内置联网」）' })]),
        logBox
      ],
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '取消'),
        (runBtn = el('button', { class: 'btn btn-primary', onclick: run }, ICONS.label('\u25B6 开始')))
      ]
    });

    function run() {
      if (busy) return;
      var urls = ta.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(isHttpUrl);
      if (!urls.length) { Toast.warn('请至少输入一个有效链接'); return; }
      busy = true;
      if (runBtn) { runBtn.disabled = true; ICONS.apply(runBtn, ('\u23F3 处理中 …')); }
      log('共 ' + urls.length + ' 个链接，开始处理 …');
      var chain = Promise.resolve(), done = 0;
      urls.forEach(function (url, i) {
        chain = chain.then(function () {
          var host = hostOf(url);
          var f = Fetchers.detect(url);
          var a = Store.normalizeAsset({
            title: '[待填写]' + host + ' #' + (i + 1),
            source: f.sourceId || 'other',
            links: [{ url: url, label: host }]
          });
          if (!autoFetch.checked || !Net.networkAllowed()) {
            return App.save(a).then(function () { done++; log('\u2714 已创建占位记录：' + url); });
          }
          log('\u23F3 [' + (i + 1) + '/' + urls.length + '] 获取 ' + url);
          return Fetchers.fetchInfo(url, { onLog: function () {} }).then(function (info) {
            if (info && !info.__failed) {
              a.originalTitle = info.originalTitle || '';
              a.title = (info.originalTitle || a.title).slice(0, 80);
              a.author = info.author || info.shop || '';
              a.shop = info.shop || '';
              a.shopUrl = info.shopUrl || '';
              a.itemId = info.itemId || '';
              a.description = info.description || '';
              a.images = (info.images || []).slice();
              /* 不把商品价写进 price / priceValue / isFree：它会被当成「是否免费」的依据，
               * 把买了但商品页标了免费变体的素材误判成免费。留空，交给变体价 / 购买价现算。 */
              a.rawTags = uniq((info.tags || []).map(String));
              a.tags = App.settings.autoTranslateTags ? Smart.translateTags(a.rawTags) : a.rawTags.slice();
              a.category = Smart.guessCategory(info);
              if (App.settings.autoDetectAvatar && a.category !== 'avatar') a.avatars = Smart.detectAvatars(info);
              a.coverURL = info.coverURL || '';
              if (info.sourceId) a.source = info.sourceId;
              log('\u2714 [' + (i + 1) + '] ' + (a.originalTitle || '(无标题)'));
              if (App.settings.autoFetchCover && App.isGitHubSource(a) && (info.images || []).length) {
                // GitHub 素材抓取时就把 README 图片下载到本地（封面 + 图集）
                return App.ghLocalizeImages(a, info, { log: log }).catch(function () {}).then(function () { return App.save(a); });
              }
              if (App.settings.autoFetchCover && a.coverURL) {
                return Net.fetchBlob(a.coverURL, {}).then(function (b) {
                  if (!b) return;
                  return compressImage(b, App.settings.imageMaxWidth, App.settings.imageQuality).then(function (s) {
                    a.hasCover = true;
                    return Store.putCover(a.id, s);
                  });
                }).catch(function () {}).then(function () { return App.save(a); });
              }
            } else {
              log('\u2716 [' + (i + 1) + '] 抓取失败，已创建空白记录：' + url);
            }
            return App.save(a);
          }).then(function () { done++; UI.renderAll(); });
        });
      });
      chain.then(function () {
        log('—— 完成，共处理 ' + done + ' 条 ——');
        UI.renderAll();
        Toast.ok('批量添加完成：' + done + ' 条');
      }).catch(function (e) {
        log('\u2716 中断：' + (e && e.message));
        Toast.err('批量添加中断：' + (e && e.message));
      }).then(function () {
        busy = false;
        if (runBtn) { runBtn.disabled = false; ICONS.apply(runBtn, ('\u25B6 开始')); }
      });
    }
  },

  /** 随机推荐（找灵感） */
  randomPick: function () {
    var list = App.filtered();
    if (!list.length) { Toast.warn('库中没有素材'); return; }
    var a = list[Math.floor(Math.random() * list.length)];
    Modals.detail(a.id);
  },

  /** 批量获取更新：把所有「有订单链接的已购版本」的订单页重解析一遍，刷新下载文件列表。 */
  bulkOrderUpdate: function () {
    var targets = App.assets.filter(function (a) {
      return (a.versions || []).some(function (v) { return v.orderUrl && String(v.orderUrl).trim() && !v.special; });
    });
    var logBox = el('div', { class: 'audit-log' });
    var startBtn = el('button', { class: 'btn btn-primary' }, ICONS.label('\u{1F504} 开始获取更新'));
    var running = false, cancelled = false;   // 可随时停下
    function log(t) { logBox.appendChild(el('div', { class: 'field-hint', text: t })); logBox.scrollTop = logBox.scrollHeight; }
    var h = Modal.open({
      title: '批量获取更新（订单文件）', size: 'md',
      body: [
        el('div', { class: 'notice' }, [
          el('p', { text: '对每个「有订单链接的已购版本」重新抓订单页，刷新它的下载文件（名称 / 链接 / 大小）。只动下载文件，不覆盖价格、标签等其它字段。' }),
          el('p', { text: '需要先在「设置 → 联网与抓取」选择「内置联网」。' })
        ]),
        logBox
      ],
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '关闭'),
        el('button', { class: 'btn', onclick: function () { if (running) { cancelled = true; log('已请求停止（当前素材跑完就停）'); } } }, '停止'),
        startBtn
      ]
    });
    startBtn.onclick = function () {
      if (running) return;
      if (!Net.networkAllowed()) { log('\u2716 当前为「手动粘贴源码」（不联网）。请先在「联网与抓取」中选择「内置联网」。'); return; }
      cancelled = false;
      running = true; startBtn.disabled = true; ICONS.apply(startBtn, ('\u23F3 更新中 …'));
      log('共 ' + targets.length + ' 个素材有订单链接，开始逐个获取更新 …');
      var addedAll = 0, changedAll = 0, okAssets = 0, failedUrls = 0, done = 0;
      var chain = Promise.resolve();
      targets.forEach(function (a) {
        chain = chain.then(function () {
          if (cancelled) return null;
          var vers = (a.versions || []).filter(function (v) { return v.orderUrl && String(v.orderUrl).trim() && !v.special; });
          var urls = uniq(vers.map(function (v) { return String(v.orderUrl); }));
          return Promise.all(urls.map(function (url) {
            return Net.fetchText(url, { forceNetwork: true, onLog: function () {} }).then(function (r) {
              if (!r || !r.ok || !r.text) return { url: url, item: null };
              var parsed = Importer.parseOrderPage(url, r.text);
              var items = parsed.items || [];
              if (!items.length) return { url: url, item: null };
              return { url: url, item: items.find(function (x) { return String(x.itemId) === String(a.itemId || ''); }) || items[0] };
            }).catch(function () { return { url: url, item: null }; });
          })).then(function (results) {
            var byUrl = Object.create(null);
            results.forEach(function (r) { if (r && r.item) byUrl[r.url] = r.item; else failedUrls++; });
            var added = 0, changed = 0;
            vers.forEach(function (v) {
              var it = byUrl[String(v.orderUrl)];
              if (!it) return;
              var before = JSON.stringify((v.files || []).map(function (f) { return [f.name, f.url, f.size || 0]; }));
              var n = Importer.applyOrderFilesToVersion(it, v);
              if (!n) return;
              var after = JSON.stringify((v.files || []).map(function (f) { return [f.name, f.url, f.size || 0]; }));
              if (before === '[]') added += n; else if (before !== after) changed++;
            });
            done++;
            if (added || changed) {
              okAssets++; addedAll += added; changedAll += changed;
              log('\u2714 [' + done + '/' + targets.length + '] ' + (a.title || a.originalTitle || a.id) + '：新增 ' + added + ' 个文件' + (changed ? '、刷新 ' + changed + ' 个版本' : ''));
              return App.save(a);
            }
            if (done % 20 === 0) log('… 已处理 ' + done + '/' + targets.length);
          });
        });
      });
      chain.then(function () {
        log('—— ' + (cancelled ? '已停止：' : '完成：') + okAssets + ' 个素材有更新（新增 ' + addedAll + ' 个文件、刷新 ' + changedAll + ' 个版本）' + (failedUrls ? '；' + failedUrls + ' 个订单页取不到（可能需要 Cookie / 链接已过期）' : '') + ' ——');
        if (okAssets) App.reload().then(function () { UI.renderAll(); });
        running = false; startBtn.disabled = false; ICONS.apply(startBtn, ('\u{1F504} 再次获取更新'));
      }).catch(function (e) {
        log('\u2716 中断：' + (e && e.message ? e.message : e));
        running = false; startBtn.disabled = false; ICONS.apply(startBtn, ('\u{1F504} 再次获取更新'));
      });
    };
  },

  /* ---------------- 批量更新商品信息 ----------------
   * 与「批量获取更新（订单文件）」分工：那边只碰版本 / 下载文件，这边只碰商品页上的信息。
   * 两者都不动自定义标题、本地文件、购买价与备注。 */

  /** 挑一个「商品页」链接来抓：优先 /items/<id>、/l/<code> 这种商品页；
   *  其次第一条 http 链接；都没有则用 BOOTH 商品号拼一个。返回空串表示这条没得抓。 */
  shopLinkOf: function (a) {
    var urls = (a.links || []).map(function (l) { return String((l && l.url) || l || '').trim(); }).filter(isHttpUrl);
    var itemPage = urls.filter(function (u) { return /\/items\/\d+|\/l\/[A-Za-z0-9]+/i.test(u); })[0];
    if (itemPage) return itemPage;
    if (urls[0]) return urls[0];
    var iid = String(a.itemId || '').trim();
    return /^\d+$/.test(iid) ? 'https://booth.pm/ja/items/' + iid : '';
  },

  /** 把一次商品页抓取结果并进素材，返回 { changed: [字段名], skipped: [字段名] }。
   *  规则：
   *  - 字段级锁定沿用表单那套：a.userEdited[k] 为真时不动（force 时放开）；
   *  - 自定义标题、角色三语名永不覆盖（自定义标题仅在空着时用原标题兜底）；
   *  - 标签 / 图集只增不减：用户自己补的内容不能被商店侧覆盖掉；
   *  - 分类只在当前是「其他」时按商店分类补上，不抢用户分好的类。 */
  applyShopInfo: function (a, info, force) {
    var changed = [], skipped = [];
    a.autoFilled = a.autoFilled || {};
    a.userEdited = a.userEdited || {};
    function hit(k, label) {
      a.autoFilled[k] = true;
      if (changed.indexOf(label) < 0) changed.push(label);
    }
    function miss(label) { if (skipped.indexOf(label) < 0) skipped.push(label); }
    function locked(k) { return !force && !!a.userEdited[k]; }

    var title = String(info.originalTitle || info.title || '').trim();
    if (title) {
      if (locked('titleOrig')) miss('原标题');
      else if (String(a.originalTitle || '').trim() !== title) { a.originalTitle = title; hit('titleOrig', '原标题'); }
      /* 自定义标题只做兜底：空着时用商店标题填上，用户起过名字的一律不动 */
      if (!String(a.title || '').trim()) {
        a.title = title.slice(0, 60); hit('title', '自定义标题（原为空）');
      }
    }
    var shopUrlNow = String(info.shopUrl || a.shopUrl || '');
    var author = Store.cleanShopField(info.author || info.shop || '', shopUrlNow);
    if (author && !locked('author') && author !== String(a.author || '')) { a.author = author; hit('author', '作者'); }
    var shop = Store.cleanShopField(info.shop || '', shopUrlNow);
    if (shop && !locked('shop') && shop !== String(a.shop || '')) { a.shop = shop; hit('shop', '店铺'); }
    if (info.itemId && String(info.itemId) !== String(a.itemId || '')) {
      if (locked('itemId')) miss('商品 ID');
      else { a.itemId = String(info.itemId); hit('itemId', '商品 ID'); }
    }
    if (info.shopUrl && String(info.shopUrl) !== String(a.shopUrl || '')) {
      if (locked('shopUrl')) miss('店铺链接');
      else { a.shopUrl = String(info.shopUrl); hit('shopUrl', '店铺链接'); }
    }
    if (info.description) {
      var desc = Smart.pickChinese(info.description);
      if (desc && desc !== String(a.description || '')) {
        if (locked('desc')) miss('商品简介');
        else { a.description = desc; hit('desc', '商品简介'); }
      }
    }
    if (info.tags && info.tags.length) {
      var rawNew = uniq(info.tags.map(String)).filter(Boolean);
      var rawAll = uniq((a.rawTags || []).concat(rawNew)).filter(Boolean);
      var zhNew = Smart.purgeAvatarTags((App.settings && App.settings.autoTranslateTags && Smart.translateTags)
        ? Smart.translateTags(rawNew.slice()) : rawNew.slice());
      var tagAll = uniq((a.tags || []).concat(zhNew)).filter(Boolean);
      var addTag = tagAll.length - (a.tags || []).length;
      if (addTag > 0) {
        a.tags = tagAll; a.rawTags = rawAll;
        hit('tags', '标签 +' + addTag); a.autoFilled.raws = true;
      }
    }
    if (info.images && info.images.length) {
      var imgs = uniq((a.images || []).concat(info.images.map(String))).filter(Boolean);
      var addImg = imgs.length - (a.images || []).length;
      if (addImg > 0) { a.images = imgs; hit('images', '图集 +' + addImg); }
    }
    /* 封面外链只补空：有本地封面或用户清过封面的，一律不碰 */
    if (info.coverURL && !a.hasCover && !a.coverCleared && String(info.coverURL) !== String(a.coverURL || '')) {
      a.coverURL = String(info.coverURL); hit('cover', '封面外链');
    }
    if (info.publishedAt && String(info.publishedAt) !== String(a.publishedAt || '')) {
      if (locked('publishedAt')) miss('上架日期');
      else { a.publishedAt = String(info.publishedAt); hit('publishedAt', '上架日期'); }
    }
    if (info.shopUpdatedAt && String(info.shopUpdatedAt) !== String(a.shopUpdatedAt || '')) {
      if (locked('shopUpdatedAt')) miss('商品更新日期');
      else { a.shopUpdatedAt = String(info.shopUpdatedAt); hit('shopUpdatedAt', '商品更新日期'); }
    }
    if (String(a.category || 'other') === 'other') {
      var guess = Smart.guessCategory(info);
      if (guess && guess !== 'other') { a.category = guess; hit('category', '分类'); }
    }
    if (App.settings && App.settings.autoDetectAvatar && a.category !== 'avatar') {
      var avs = Smart.detectAvatars(info) || [];
      var avAll = uniq((a.avatars || []).concat(avs)).filter(Boolean);
      var addAv = avAll.length - (a.avatars || []).length;
      if (addAv > 0) { a.avatars = avAll; hit('avatars', '支持角色 +' + addAv); }
    }
    /* 下架状态跟着抓取结果走：404/410 标记、能抓到就清除（与编辑页手动联网的行为一致） */
    if (info.delisted) {
      if (!a.delisted) { a.delisted = true; changed.push('标记「已下架」'); }
    } else if (a.delisted) {
      a.delisted = false; changed.push('清除「已下架」');
    }
    return { changed: changed, skipped: skipped };
  },

  /** 多选浮动区「更新商品信息」：对选中素材逐个重抓商品页（手动触发，不走缓存） */
  bulkRefreshInfo: function () {
    var ids = App.selectedIds();
    if (!ids.length) { Toast.warn('先勾选要更新信息的素材'); return; }
    var list = (App.assets || []).filter(function (a) { return ids.indexOf(a.id) >= 0; });
    var targets = [], noLink = 0;
    list.forEach(function (a) {
      var url = Tools.shopLinkOf(a);
      if (url) targets.push({ a: a, url: url }); else noLink++;
    });

    var logBox = el('div', { class: 'fetch-log', style: { display: 'none' } });
    function log(t) { logBox.style.display = ''; logBox.appendChild(el('div', { class: 'log-line', text: t })); logBox.scrollTop = logBox.scrollHeight; }
    var forceCk = el('input', { type: 'checkbox' });
    var runBtn = null;
    var running = false, cancelled = false;
    var netOk = (typeof Net !== 'undefined' && Net.networkAllowed());

    var h = Modal.open({
      title: '更新商品信息（重新抓取商品页）', size: 'md',
      body: [
        el('div', { class: 'field-hint', text: '对选中的素材重新请求一次商品页，把商店侧的最新信息刷进来；每个素材只请求一次，并顺手刷新本地解析缓存。' }),
        el('div', { class: 'notice' + (netOk ? '' : ' notice-warn') }, [
          el('p', { text: '会刷新的字段：原标题、作者 / 店铺、商品简介、标签（只增不减）、图集（只增不减）、封面外链（仅无本地封面时）、上架 / 更新时间、分类（仅当前为「其他」时）、支持角色（按标签识别）、已下架标记。' }),
          el('p', { text: '不会改动：自定义标题、角色名、本地文件与路径、购买价、备注、版本与下载文件 —— 那部分请用「批量获取更新（订单文件）」。' }),
          el('p', { text: netOk ? '当前为内置联网模式。'
            : '当前是「手动粘贴源码」模式：点「开始」仍会按你这次点击联网抓取一次，不会在后台自己发请求。' })
        ]),
        el('div', { class: 'field-hint', text: '已选 ' + list.length + ' 项：' + targets.length + ' 项能定位到商品链接'
          + (noLink ? '；' + noLink + ' 项没有链接（跳过，可先在编辑页补上链接）' : '') + '。' }),
        el('label', { class: 'check check-row' }, [forceCk,
          el('span', { text: '覆盖我手动改过的字段（原标题、作者、简介、标签、日期等；自定义标题与角色名始终保留）' })]),
        logBox
      ],
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '关闭'),
        el('button', { class: 'btn', onclick: function () { if (running) { cancelled = true; log('已请求停止（当前素材跑完就停）'); } } }, '停止'),
        (runBtn = el('button', { class: 'btn btn-primary', onclick: run }, ICONS.label('\u{1F504} 开始更新')))
      ]
    });

    function run() {
      if (running) return;
      if (!targets.length) { Toast.warn('选中的素材都没有可抓的商品链接'); return; }
      running = true; cancelled = false;
      runBtn.disabled = true; ICONS.apply(runBtn, ('\u23F3 更新中 …'));
      var force = !!forceCk.checked;
      var okN = 0, chgN = 0, failN = 0, done = 0;
      log('共 ' + targets.length + ' 个素材待更新，开始逐个抓取 …');
      var chain = Promise.resolve();
      targets.forEach(function (t, i) {
        chain = chain.then(function () {
          if (cancelled) return null;
          var a = t.a;
          var name = a.title || a.originalTitle || a.id;
          return Fetchers.fetchInfo(t.url, { forceNetwork: true, noCache: true, onLog: function () {} }).then(function (info) {
            done++;
            if (!info || info.__failed) {
              failN++;
              var why = info && (info.reason === 'no-channel' ? '程序后端未就绪' : (info.reason
                || (info.tried && info.tried[0] && info.tried[0].error))) || '抓取失败';
              log('\u2716 [' + done + '/' + targets.length + '] ' + name + '：' + why);
              if (Fetchers.looksDelisted(info) && !a.delisted) {
                a.delisted = true;
                log('   └ 返回 404 / 410，已标记「已下架」');
                return App.save(a);
              }
              return null;
            }
            var res = Tools.applyShopInfo(a, info, force);
            if (!res.changed.length) { okN++; log('\u00B7 [' + done + '/' + targets.length + '] ' + name + '：无变化'); return null; }
            return App.save(a).then(function () {
              okN++; chgN++;
              var head = res.changed.slice(0, 7).join('、');
              log('\u2714 [' + done + '/' + targets.length + '] ' + name + '：' + head
                + (res.changed.length > 7 ? ' 等 ' + res.changed.length + ' 项' : '')
                + (res.skipped.length ? '（跳过 ' + res.skipped.join('、') + '）' : ''));
            });
          }).catch(function (e) {
            failN++;
            log('\u2716 ' + name + '：' + ((e && e.message) || e));
          });
        }).then(function () {
          /* 串行 + 220ms 间隔：一次刷几十个商品页时不至于把站点打急 */
          if (!cancelled && i < targets.length - 1) return new Promise(function (r) { setTimeout(r, 220); });
        });
      });
      chain.then(function () {
        log('—— ' + (cancelled ? '已停止：' : '完成：') + '成功 ' + okN + ' 个（其中 ' + chgN + ' 个有更新），失败 ' + failN + ' 个。 ——');
        if (chgN) App.reload().then(function () { UI.renderAll(); });
        running = false; runBtn.disabled = false; ICONS.apply(runBtn, ('\u{1F504} 再次更新'));
      }).catch(function (e) {
        log('\u2716 中断：' + ((e && e.message) || e));
        running = false; runBtn.disabled = false; ICONS.apply(runBtn, ('\u{1F504} 再次更新'));
      });
    }
  },

  /** 批量下载缺失文件：把「库里有记录但磁盘上没有」的文件全部入队 */
  bulkDownloadMissing: function () {
    var ids = App.selectedIds();
    if (!ids.length) { Toast.warn('请先选择素材'); return; }
    var list = App.assets.filter(function (a) { return ids.indexOf(a.id) >= 0; });
    Toast.info('正在扫描所选素材的存储目录 …', 2400);
    FS.hostEnsure().then(function (ok) {
      if (!ok) { Toast.warn('程序后端未就绪：无法扫描磁盘、也无法下载。请重启程序。', 5600); return null; }
      var queued = 0, noUrl = 0, missingTotal = 0, noPath = 0;
      var chain = Promise.resolve();
      list.forEach(function (a) {
        chain = chain.then(function () {
          return App.localFileAudit(a).then(function (st) {
            if (st.error === 'no-path') { noPath++; return; }
            if (st.error || !st.missing || !st.missing.length) return;
            var byName = Object.create(null);
            (a.versions || []).forEach(function (v) {
              (v.files || []).forEach(function (f) { if (f && f.name) byName[String(f.name).toLowerCase()] = f; });
            });
            (a.downloadLinks || []).forEach(function (d) {
              if (d && d.url) byName[String(d.label || '').toLowerCase()] = { name: d.label || '下载文件', url: d.url, size: 0 };
            });
            st.missing.forEach(function (name) {
              missingTotal++;
              var f = byName[String(name).toLowerCase()];
              if (!f || !isHttpUrl(f.url)) { noUrl++; return; }
              DLQueue.enqueue({ url: f.url, name: name, dst: joinWinPath(st.dir, [name]), assetId: a.id, expectSize: f.size || 0 });
              queued++;
            });
          });
        });
      });
      return chain.then(function () {
        Toast.ok('已把 ' + queued + ' 个缺失文件加入下载队列（共发现 ' + missingTotal + ' 个）' +
          (noUrl ? '；' + noUrl + ' 个没有可用下载链接（先去详情页点「获取更新」解析订单页）' : '') +
          (noPath ? '；' + noPath + ' 个素材没有本地路径（会跳过）' : ''), 6800);
      });
    }).catch(function (e) { Toast.err('下载缺失文件失败：' + (e && e.message ? e.message : e)); });
  },
};

