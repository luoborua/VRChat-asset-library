/* 渲染层的启动装配与全局交互：
 * 负责首屏装载顺序、工具栏 / 搜索 / 多选事件、快捷键、滚轮手感、页签切换与诊断面板。
 * 依赖 App、UI、Store、FS 等全局模块，只做接线与调度，不实现具体渲染与读写。
 * 不负责数据模型、磁盘操作与业务弹窗，遇到这些一律转交对应模块。
 */

(function () {

  /* 顶栏 / 工具栏 / 空状态的静态图标统一换成同一套 SVG：
   * 纯图标按钮清空后填入，带文字的按钮插到文字前。 */
  function swapStaticIcons() {
    var map = [
      ['.brand-main .logo', 'parcel', true, 'ico-em'],
      ['#btnSidebar', 'menu', true],
      ['.search-ico', 'search', true],
      ['#searchClear', 'close', true],
      ['[data-view="grid"]', 'grid', true],
      ['[data-view="list"]', 'list', true],
      ['#emptyState .emoji', 'parcel', true, 'ico-em'],
      ['#btnSelectMode', 'checkbox', false],
      ['#btnImport', 'importIn', false],
      ['#btnAdd', 'plus', false],
      ['#btnSettings', 'settings', false],
      ['#btnP2PRecv', 'link', true],
      ['#emptyAdd', 'plus', false],
      ['#emptyDemo', 'flask', false],
      /* 左侧页签栏图标 */
      ['#tabLibrary .ico', 'parcel', true],
      ['#tabWorkbench .ico', 'importIn', true],
      ['#tabTrash .ico', 'trash', true],
      /* 多选浮动区的按钮图标：纯文字堆在右下角时难以区分 */
      ['#fabP2P', 'link', false],
      ['#fabExportPack', 'parcel', false],
      ['#fabImportUnity', 'box', false],
      ['#bulkExit', 'close', false]
    ];
    map.forEach(function (it) {
      var node = document.querySelector(it[0]);
      if (!node) return;
      var ico = ICONS.make(it[1], it[2] ? { size: 16, class: it[3] || '' } : { size: 15, class: 'ico-pre' });
      /* 只剥掉开头的图标字符，保留同一文本节点里的文案：
       * 整段移除会把「添加第一个素材」这类按钮的文字一起删掉。 */
      var first = node.firstChild;
      if (first && first.nodeType === 3) {
        var sp = ICONS.splitPrefix(first.nodeValue || '');
        first.nodeValue = sp ? sp.rest : first.nodeValue;
      }
      // 纯图标容器：剥掉图标后只剩空白文本节点的一并清掉，否则会和新图标并排留出空隙
      while (node.firstChild && node.firstChild.nodeType === 3 && !String(node.firstChild.nodeValue || '').trim()) node.removeChild(node.firstChild);
      // 纯图标按钮（图标后面没有文案）不需要前缀间距——带着 5px 右边距会让图标看着不居中
      if (!String(node.textContent || '').trim()) ico.classList.remove('ico-pre');
      node.insertBefore(ico, node.firstChild);
    });
  }

  /* 侧栏收起要让宽度真正归零：内联样式兜底 CSS 优先级，
 * .sidebar 有宽度过渡，收回时内容区同步变宽。bindEvents 与 boot 都会调用，放在顶层。 */
function applySidebarState(open) {
  document.body.classList.toggle('sidebar-hidden', !open);
  var sb = document.querySelector('.sidebar');
  if (!sb) return;
  sb.style.width = open ? '' : '0px';
  sb.style.flexBasis = open ? '' : '0px';
  sb.style.paddingLeft = open ? '' : '0px';
  sb.style.paddingRight = open ? '' : '0px';
  sb.style.overflow = open ? '' : 'hidden';
  sb.style.minWidth = open ? '' : '0px';
}

/** 绑定工具栏、搜索、多选、拖选与全局快捷键 */
function bindEvents() {
    // 搜索
    var search = $('#searchInput');
    search.addEventListener('input', debounce(function () {
      App.filters.q = search.value;
      App.page = 1;
      UI.renderMain();
      UI.scrollTopInstant();                 // 搜索后瞬间回顶部，否则会停在旧位置
    }, 180));
    /* 卡片范围内任意点击都记为「活跃」（显示卡片选中效果），弹窗内点击一律拦截，
     * 多选模式下的勾选不算卡片交互。挂 #grid 捕获阶段：卡片内部元素都 stopPropagation，冒泡收不到。 */
    var gridEl = $('#grid');
    if (gridEl) {
      gridEl.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('.modal')) return;                                  // 弹窗内 → 拦截
        var card = t.closest('.card');
        if (!card || !card.dataset || !card.dataset.id) return;
        var interactive = t.closest('.chip, .tag, .price-ribbon, .badge, .fav-btn');
        if (App.selectMode && !interactive) return;                       // 多选勾选 → 不算
        App.activeAssetId = card.dataset.id;
        UI.flashCard(card.dataset.id);
      }, true);
    }
    $('#searchClear').addEventListener('click', function () {
      /* 搜索框本就为空时点 × 只把焦点放回去：重排会白跳一次页码、白播一遍入场动画 */
      if (search.value === '' && !App.filters.q) { search.focus(); return; }
      search.value = ''; App.filters.q = ''; UI.renderAll(); UI.scrollTopInstant(); search.focus();
    });
    // 模糊搜索开关（搜索框右侧）
    var btnFuzzy = $('#btnFuzzy');
    function syncFuzzyBtn() {
      if (!btnFuzzy) return;
      var on = !!App.settings.fuzzySearch;
      btnFuzzy.classList.toggle('btn-primary', on);
      btnFuzzy.title = on
        ? '模糊搜索：已开启（同义词 / 俗称 + 错别字容错），点击关闭'
        : '模糊搜索：已关闭，点击开启（需先在 设置 → AI 翻译 生成词表）';
    }
    syncFuzzyBtn();
    if (btnFuzzy) btnFuzzy.addEventListener('click', function () {
      App.settings.fuzzySearch = !App.settings.fuzzySearch;
      App.saveSettings(); syncFuzzyBtn();
      /* 没有搜索词时开关只改设置：此时重排没有意义 */
      if (String(App.filters.q || '').trim()) UI.renderMain();
      Toast.info(App.settings.fuzzySearch ? '模糊搜索已开启（同义词 + 错别字容错）' : '模糊搜索已关闭');
    });

    // 顶部按钮
    $('#btnAdd').addEventListener('click', function () { Modals.edit(null); });
    $('#btnSettings').addEventListener('click', function () { Settings.open(); });
    swapStaticIcons();
    var brandVersion = $('#brandVersion');
    if (brandVersion) {
      brandVersion.textContent = '本地素材管理 · v' + APP.version;
      // 点版本号打开更新日志
      brandVersion.title = '查看更新日志';
      brandVersion.addEventListener('click', function () { Modals.changelog(); });
    }
    $('#btnTheme').addEventListener('click', function () {
      /* 按 THEMES 顺序循环，最后一档是跟随系统 */
      var order = THEMES.map(function (t) { return t.id; });
      var i = order.indexOf(App.settings.theme);
      App.settings.theme = order[(i + 1) % order.length];
      App.applyTheme(); App.saveSettings();
      Toast.info('主题：' + themeMeta(App.settings.theme).label);
    });

    $('#btnSidebar').addEventListener('click', function () {
      App.settings.sidebarOpen = document.body.classList.contains('sidebar-hidden');
      applySidebarState(App.settings.sidebarOpen);
      App.saveSettings();
      UI.renderMain();
    });
    $('#btnImport').addEventListener('click', function () { openImportMenu(); });

    // 排序 / 视图
    /* 排序用按钮轮换而不是原生下拉框：select 弹层在 WebView2 里打开一次的合成开销明显，
     * 顺序同 SORTS，按钮文字由 UI.syncSortButton() 写。 */
    $('#btnSort').addEventListener('click', function () {
      var i = -1;
      for (var k = 0; k < SORTS.length; k++) if (SORTS[k].id === App.settings.sort) { i = k; break; }
      App.settings.sort = SORTS[(i + 1) % SORTS.length].id;
      App.page = 1; App.saveSettings(); UI.renderMain();
      UI.syncSortButton();
      Toast.info('排序：' + UI.sortLabel(), 2000);
    });
    /* 网格按钮兼任卡片大小开关：已在网格时按 中 → 大 → 小 循环，列表视图下只切回网格。
     * 侧栏收起/展开不碰这个预设。 */
    function sizeLabel(x) { return ({ s: '小', m: '中', l: '大' })[x] || '中'; }
    function cycleCardSize() {
      var order = ['m', 'l', 's'];
      var i = order.indexOf(App.settings.cardSize || 'm');
      App.settings.cardSize = order[(i + 1) % 3];
      App.page = 1;
      /* 换了尺寸，「一屏能放几张」必须重新量 —— 但这里不清零：先按旧张数画一帧，
       * fitGrid 量完新行高会自动把 App.fitPageSize 校正过来。
       * 清零的话首帧会按兜底的 24 张画一遍，一眼就能看出闪。 */
      App.saveSettings();
      UI.renderMain();
      UI.scrollTopInstant();
      /* 量完再报数：在 renderMain 之前读到的是上一轮的数字 */
      setTimeout(function () {
        Toast.info('卡片大小：' + sizeLabel(App.settings.cardSize) + '（每屏 ' + App.pageSizeFor() + ' 个）', 2500);
      }, 150);
    }
    $$('.view-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.view === 'grid' && App.settings.view === 'grid') { cycleCardSize(); return; }
        App.settings.view = b.dataset.view; App.page = 1; App.saveSettings(); UI.renderMain();
      UI.scrollTopInstant();                 // 切换视图后瞬间回顶部
      });
    });

    /* 刷新按钮：重新从磁盘读一遍素材库再重画 */
    var btnRefresh = $('#btnRefresh');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', function () {
        if (btnRefresh.classList.contains('spinning')) return;
        btnRefresh.classList.add('spinning');
        Promise.resolve(App.reload())
          .then(function () { UI.renderAll(); Toast.ok('已刷新'); })
          .catch(function (e) { Toast.err('刷新失败：' + ((e && e.message) || e)); })
          .then(function () { setTimeout(function () { btnRefresh.classList.remove('spinning'); }, 720); });
      });
    }

    // 多选模式
    $('#btnSelectMode').addEventListener('click', function () {
      App.selectMode = !App.selectMode;
      if (!App.selectMode) App.clearSelection();
      $('#btnSelectMode').classList.toggle('active', App.selectMode);
      UI.renderAll();
    });
    $('#bulkSelectAll').addEventListener('click', function () {
      App.filtered().forEach(function (a) { App.selection[a.id] = true; });
      UI.renderMain();
    });
    $('#bulkNone').addEventListener('click', function () { App.clearSelection(); UI.renderMain(); });
    $('#bulkCategory').addEventListener('click', function () { Tools.bulkSetCategory(); });
    $('#bulkTag').addEventListener('click', function () { Tools.bulkAddTag(); });
    $('#bulkAvatar').addEventListener('click', function () { Tools.bulkAddAvatar(); });
    $('#bulkDownloaded').addEventListener('click', function () { Tools.rescanDiskState(); });
    $('#bulkHide').addEventListener('click', function () { Tools.bulkToggleHidden(true); });
    $('#bulkExport').addEventListener('click', function () { Tools.bulkExport(); });
    $('#fabImportUnity').addEventListener('click', function () {
      var ids = App.selectedIds();
      if (!ids.length) { Toast.err('先勾选要导入的素材'); return; }
      var list = ids.map(function (id) { return App.assets.find(function (a) { return a.id === id; }); }).filter(Boolean);
      if (window.WB && WB.importToUnity) WB.importToUnity(list);
      else Toast.err('「导入与工程」页还没加载，稍后再试');
    });
    /* P2P：把勾选的素材直接传给好友（点对点，不落服务器） */
    $('#fabP2P').addEventListener('click', function () {
      var ids = App.selectedIds();
      if (!ids.length) { Toast.warn('先勾选要传的素材'); return; }
      var list = (App.assets || []).filter(function (a) { return ids.indexOf(a.id) >= 0; });
      P2P.collectItems(list).then(function (items) {
        if (!items.length) { Toast.err('这些素材没有可读的本地文件'); return; }
        P2PUI.openSendDialog(items);
      }).catch(function (e) { Toast.err(e.message || String(e)); });
    });
    $('#btnP2PRecv').addEventListener('click', function () {
      P2PUI.openReceiveDialog();
    });

    /* 把选中的素材连同文件打包成 .vrcpack（标准 zip），发给别人导入 */
    $('#fabExportPack').addEventListener('click', function () {
      var ids = App.selectedIds();
      if (!ids.length) { Toast.warn('先勾选要导出的素材'); return; }
      var list = (App.assets || []).filter(function (a) { return ids.indexOf(a.id) >= 0; });
      Packer.exportDialog(list);
    });
    /* 对选中素材重抓一次商品页（标题 / 作者 / 简介 / 标签 / 图集等） */
    $('#bulkRefreshInfo').addEventListener('click', function () { Tools.bulkRefreshInfo(); });
  $('#bulkDownloadMissing').addEventListener('click', function () { Tools.bulkDownloadMissing(); });
    $('#bulkDelete').addEventListener('click', function () { Tools.bulkDelete(); });
    $('#bulkExit').addEventListener('click', function () {
      App.selectMode = false; App.clearSelection();
      $('#btnSelectMode').classList.remove('active');
      UI.renderAll();
    });

    /* 多选模式下按住卡片拖动 = 连选（画刷）：按下那张决定这次是选中还是取消，
       之后滑过的卡刷成同一状态。
       直接改 App.selection 并就地更新勾选，不整格重绘 —— 重绘会换掉正在拖的 DOM 节点，拖动当场断掉。 */
    (function () {
      var paint = null;

      function paintCard(card) {
        var id = card.dataset.id;
        if (!id || paint.done[id]) return;
        paint.done[id] = 1;
        App.selection[id] = paint.want;
        App._suppressClick = true;      // 别让随后的 click 再翻一次
        UI.markCard(card, paint.want);
        UI.syncBulkCount();             // 只更新计数，不重绘网格
      }
      document.addEventListener('pointerdown', function (e) {
        if (!App.selectMode || e.button !== 0) return;
        var card = e.target.closest ? e.target.closest('.card[data-id]') : null;
        if (!card) return;
        if (e.target.closest('button, a, input, select, textarea')) return;
        var id = card.dataset.id;
        App._paintActive = true;
        paint = { want: !App.selection[id], done: Object.create(null) };
        paintCard(card);
        e.preventDefault();             // 不触发文字选择与原生拖拽
      }, true);
      document.addEventListener('pointermove', function (e) {
        if (!paint) return;
        var hit = document.elementFromPoint(e.clientX, e.clientY);
        var card = hit && hit.closest ? hit.closest('.card[data-id]') : null;
        if (card) paintCard(card);
      }, true);
      ['pointerup', 'pointercancel'].forEach(function (ev) {
        document.addEventListener(ev, function () {
          var wasPainting = !!paint;
          paint = null;
          App._paintActive = false;
          /* click 会派发到公共祖先（卡片收不到），所以在这里统一复位，别吞掉下一次点击 */
          setTimeout(function () { App._suppressClick = false; }, 0);
          if (wasPainting) UI.renderToolbar();
        }, true);
      });
    })();

    // 空状态按钮
    $('#emptyAdd').addEventListener('click', function () { Modals.edit(null); });
    $('#emptyDemo').addEventListener('click', function () { seedDemo(); });

    // 快捷键
    /* 空白处禁止浏览器默认右键菜单：输入框、可选中文本、卡片自带菜单这些区域放行 */
document.addEventListener('contextmenu', function (e) {
  var t = e.target;
  if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"], .card, .menu, .detail, .note-box, .fetch-log, .log-line, .path-copy, .modal-body')) return;
  e.preventDefault();
});
document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      var mod = e.ctrlKey || e.metaKey || e.altKey;
      var onLib = !(window.AppTab && typeof AppTab.current === 'function') || AppTab.current() === 'library';
      if (e.key === 'Escape') {
        if (Modal.stack.length) { Modal.closeByEsc(); return; }
        if (App.selectMode) { $('#bulkExit').click(); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        if (Modal.stack.length) return;   // 弹窗开着时别把焦点抢到遮罩后面
        e.preventDefault(); $('#searchInput').focus(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); FS.downloadJSON(true); return; }
      if (typing || Modal.stack.length || mod) return;
      if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); }
      else if (e.key.toLowerCase() === 'n') { e.preventDefault(); Modals.edit(null); }
      else if (onLib && e.key.toLowerCase() === 'g') {
        App.settings.view = App.settings.view === 'grid' ? 'list' : 'grid';
        App.saveSettings(); UI.renderMain();
      } else if (e.key.toLowerCase() === 't') { $('#btnTheme').click(); }
      else if (e.key.toLowerCase() === 'r') { Tools.randomPick(); }
      else if (onLib && e.key === 'ArrowRight') {
        var pi = App.pageInfo();
        if (pi.page < pi.pages) { App.page = pi.page + 1; UI.renderMain(); }
      } else if (onLib && e.key === 'ArrowLeft') {
        var pj = App.pageInfo();
        if (pj.page > 1) { App.page = pj.page - 1; UI.renderMain(); }
      }
    });

    // 程序后端检测：离线时页面照常打开，只提示一次（短时，避免挡住后续操作提示）
    setTimeout(function () {
      FS.hostEnsure().then(function (ok) {
        if (!ok) Toast.warn('程序后端未就绪：文件打开/联网等功能受限，请重启程序。', 3000);
      });
    }, 1600);

    // 全局捕获：阻止 file:// 页面被拖拽内容导航（Unsafe attempt to load URL 的根源）
    window.addEventListener('dragover', function (e) { e.preventDefault(); }, true);
    window.addEventListener('drop', function (e) { e.preventDefault(); }, true);

    /* .vrcpack / .zip 拖进窗口即可导入（拖拽 → 清单预览 → 确认解包）。
     * 覆盖层的显隐与 dragleave 判定统一交给 Packer：此处另挂 dragleave 会在鼠标移入子元素时误清掉提示层。 */
    if (typeof Packer !== 'undefined' && Packer.installDropZone) Packer.installDropZone();

    // 窗口尺寸变化时重新分栏 / 重算一屏容量（防抖）
    /* 高度变了也要重算：一屏放几行是按内容区高度算的，只看列数会让窗口拉高后仍按旧行数分页 */
    var resizeTimer = null;
    var lastCols = UI.masonryColumnCount();
    var lastMainH = (document.querySelector('.main') || {}).clientHeight || 0;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        var cols = UI.masonryColumnCount();
        var h = (document.querySelector('.main') || {}).clientHeight || 0;
        /* 高度差异小于 24px 不会跨行，没必要重绘整页 */
        if (cols === lastCols && Math.abs(h - lastMainH) < 24) return;
        lastCols = cols;
        lastMainH = h;
        UI.renderMain();
      }, 150);
    });

    /* 分页条要跟着「卡片区」居中。侧栏收放走的是 CSS 过渡（宽度 220ms 动画），
     * 中途不会触发 resize 也不重绘，所以单独盯 .main 的尺寸 —— 每帧只写一个 CSS 变量。 */
    var mainEl = document.querySelector('.main');
    if (mainEl) {
      UI.syncPagerX();
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(function () { UI.syncPagerX(); }).observe(mainEl);
      }
    }
  }

  /** 导入方式选择菜单 */
  function openImportMenu() {
    function item(iconName, title, desc, fn) {
      return el('button', { class: 'menu-item', onclick: function () { Modal.closeTop(); fn(); } }, [
        ICONS.make(iconName, { size: 22 }),
        el('div', { class: 'menu-item-body' }, [el('b', { text: title }), el('span', { text: desc })])
      ]);
    }
    Modal.open({
      title: '导入素材', size: 'md',
      body: [el('div', { class: 'menu-list' }, [
        item('folder', '从文件夹导入已下载的素材',
          '扫描本地文件夹：每个子文件夹识别为一个素材，压缩包按版本号归并为「版本」，图片自动作为封面，.url 文件里的链接自动识别为商店链接；可选复制进素材库。',
          function () { Importer.folderWizard(); }),
        item('download', '从用户脚本导入已购素材（推荐）',
          '用随附的 vrc-library-bridge 用户脚本，在你已登录的 BOOTH / Gumroad 页面导出「已购列表 + 下载直链」，再粘贴进来。不需要提供账号密码。',
          function () { Importer.bridgeImportDialog(); }),
        item('version', '同步我的 BOOTH 已购（需程序后端）',
          '已保存 booth.pm Cookie 且程序后端在线时，由后端自动翻页同步购买记录与下载直链。',
          function () { Importer.syncLibraryDialog(); }),
        item('star', '导入 BOOTH 心愿单（需程序后端）',
          '读取你全部 BOOTH 心愿单，逐项抓取商品信息入库，并打上「心愿单」标记；已存在的商品只追加标记。',
          function () { Importer.wishlistDialog(); }),
        item('link', '粘贴多个商品链接批量添加',
          '每行一个商品链接，快速建立占位记录，之后再逐条补全信息。',
          function () { Tools.quickAdd(); }),
        item('box', '从素材包导入（.vrcpack）',
          '读取别人打包给你的素材包：带文件的导入即可用，只有清单的会显示成「未下载」素材。也可以直接把 .vrcpack / .zip 拖进窗口。',
          function () { Packer.importDialog(); }),
        item('file', '从文件导入（zip / unitypackage / 任意素材）',
          '选一个或多个素材文件，预览里可以改标题、选分类，再复制或移动进素材库。zip、unitypackage、rar、7z、fbx、blend、psd、文件夹都可以直接拖进窗口。',
          function () { DropImport.pickFiles(); }),
        item('search', '对比对方的清单（找出他没有的）',
          '对方导出一份「他库里已有什么」的清单给你，这里读进来做反向对比：列出你有、他清单里没有的素材，勾选后直接打包装箱发给他。不会修改你的库。',
          function () { Packer.compareDialog(); }),
        item('box', '从备份文件恢复',
          '导入之前用本工具导出的完整备份 JSON（可含封面图）。',
          function () { Settings.open('data'); })
      ])]
    });
  }

  /** 演示数据（帮助用户快速理解结构，可一键清空） */
  function seedDemo() {
    var demos = [
      {
        title: '冬季厚毛衣套装', originalTitle: '【シフォン用】ふわもこニットセット',
        source: 'booth', category: 'clothing',
        links: [{ url: 'https://booth.pm/ja/items/0000001', label: '商品页' }],
        tags: ['毛衣', '冬季', '可爱'], rawTags: ['ニット', '冬', 'かわいい'],
        avatars: ['chiffon'], author: 'サンプル工房', price: '¥1,500', itemId: '0000001',
        description: '示例：戚风专用的冬季针织套装，含毛衣、围巾与短裙三件，已适配 PhysBone。',
        images: [],
        note: '示例数据：依赖 lilToon 着色器，需先导入 Modular Avatar。',
        paths: [{ path: joinWinPath(App.libraryRoot(), ['衣装', '戚风', '冬季厚毛衣']), note: '' }],   // 示例路径挂在当前库根目录下，不写死本机路径
        downloaded: true, downloadedAt: nowISO(), rating: 5, favorite: true
      },
      {
        title: '双马尾长发（物理骨骼）', originalTitle: 'ツインテールロングヘア PhysBone対応',
        source: 'booth', category: 'hair',
        tags: ['发型', 'PhysBone', '双马尾'], rawTags: ['髪型', 'PhysBone', 'ツインテール'],
        avatars: ['manuka', 'shinano'], author: 'Sample Hair Studio', price: '¥800', rating: 4
      },
      {
        title: '万能表情菜单组件', originalTitle: 'Expression Menu Utility Pack',
        source: 'gumroad', category: 'gimmicks',
        tags: ['功能组件', '表情', '工具'], rawTags: ['gimmick', 'expression', 'tool'],
        avatars: ['universal'], author: 'SampleDev', price: '$5', rating: 4,
        note: '示例数据：支持一键生成手势菜单。'
      },
      {
        title: 'lilToon 着色器（收藏）', originalTitle: 'lilToon',
        source: 'booth', category: 'shaders',
        tags: ['着色器', '免费'], rawTags: ['シェーダー', '無料'],
        avatars: ['universal'], author: 'lilxyzw', price: '0', rating: 5, favorite: true, downloaded: true, downloadedAt: nowISO(),
        description: '示例：免费着色器，价格为 0 时会被自动识别为「免费」，可用价格维度筛选。'
      },
      {
        title: '闲鱼收的整合改模包', originalTitle: '',
        source: 'xianyu', category: 'avatar',
        tags: ['整合包', '角色模型'], avatars: ['moe'],
        note: '示例数据：来源为闲鱼购买，注意甄别版权风险。', rating: 3
      },
      {
        title: '好友分享的皮肤贴图', originalTitle: '',
        source: 'friend', category: 'textures',
        tags: ['纹理贴图', '皮肤'], avatars: ['lime'], rating: 3,
        paths: [{ path: joinWinPath(App.libraryRoot(), ['纹理贴图', '莱姆', '皮肤']), note: '未整理' }]
      }
    ];
    var list = demos.map(function (d) { return Store.normalizeAsset(d); });
    Store.putAssets(list).then(function () { return App.reload(); }).then(function () {
      UI.renderAll(); Toast.ok('已载入 ' + list.length + ' 条示例素材，可随时在设置中清空');
    });
  }

  /* ---------------- 布局调试用示例素材 ---------------- */
  /* 12 条差异化样例：短标题/超长标题、0~8 个标签、0~3 个角色、免费/付费/未购买、六种分类。
   * 封面用 canvas 现场画渐变图，走 Store.putCover 存进封面库（和手动补封面同一条路）。 */
  function sampleAssetList() {
    var mk = function (t, cat, tags, avs, price, extra) {
      var o = {
        title: t, category: cat, source: 'booth',
        tags: tags || [], rawTags: tags || [], avatars: avs || [],
        author: '示例工房', itemId: '', price: price || '',
        description: '示例素材，用于查看卡片布局与筛选效果，可以随时删除。',
        links: [{ url: 'https://booth.pm/ja/items/0000000', label: '商品页' }]
      };
      if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
      return o;
    };
    return [
      mk('毛绒围巾', 'clothing', [], [], ''),
      mk('【シフォン用】ふわもこニットセット', 'clothing', ['毛衣', '冬季', '可爱'], ['chiffon'], '¥1,500', { originalTitle: 'ふわもこニットセット' }),
      mk('超长标题测试：这一条故意写得很长，用来观察两行截断之后是否会把分类和标签顶下去，[加上一个方括号前缀]', 'clothing', ['长标题', '两行', '截断'], ['manuka', 'shinano'], '¥2,800'),
      mk('八标签测试', 'textures', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], [], ''),
      mk('三角色适配', 'gimmicks', ['表情', '菜单'], ['moe', 'rurune', 'lime'], ''),
      mk('lilToon 着色器', 'shaders', ['着色器', '免费'], ['universal'], '0'),
      mk('双马尾长发（PhysBone）', 'hair', ['发型', 'PhysBone'], ['manuka'], '¥800'),
      mk('技能图标一套 24 枚', 'textures', ['图标', 'UI'], [], '¥500'),
      mk('通用改模工具合集', 'gimmicks', ['工具', '合集', '通用', '免费', '常用'], [], '0'),
      mk('冬季短裙', 'clothing', ['裙子', '冬季'], ['chiffon'], '¥1,200'),
      mk('表情菜单组件', 'gimmicks', ['表情'], ['universal'], '¥300'),
      mk('头像用整体改模', 'avatar', ['整合', '角色模型', '进阶'], ['moe'], '¥6,000')
    ];
  }
  /** 现场生成一张渐变封面，作为示例素材的占位图 */
  function sampleCover(a, i) {
    return new Promise(function (resolve) {
      try {
        var c = document.createElement('canvas');
        c.width = 600; c.height = 450;
        var g = c.getContext('2d');
        var hue = (i * 41) % 360;
        var lg = g.createLinearGradient(0, 0, 600, 450);
        lg.addColorStop(0, 'hsl(' + hue + ',70%,74%)');
        lg.addColorStop(1, 'hsl(' + ((hue + 38) % 360) + ',64%,52%)');
        g.fillStyle = lg; g.fillRect(0, 0, 600, 450);
        g.globalAlpha = .16; g.fillStyle = '#fff';
        g.beginPath(); g.arc(475, 105, 150, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(120, 380, 110, 0, Math.PI * 2); g.fill();
        g.globalAlpha = .92; g.fillStyle = '#fff';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.font = '600 168px system-ui, "Microsoft YaHei", sans-serif';
        g.fillText(String(a.title || '?').slice(0, 1), 300, 235);
        g.globalAlpha = .6; g.font = '500 26px system-ui, "Microsoft YaHei", sans-serif';
        g.fillText('示例封面', 300, 392);
        if (c.toBlob) c.toBlob(function (b) { resolve(b); }, 'image/png');
        else resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  /** 批量写入示例素材并为每条生成封面，串行写以免一次性占满 */
  function seedSamples() {
    var list = sampleAssetList().map(function (d) { return Store.normalizeAsset(d); });
    var chain = Promise.resolve();
    list.forEach(function (a, i) {
      chain = chain.then(function () {
        return sampleCover(a, i).then(function (b) {
          if (!b) return null;
          a.hasCover = true;
          return Store.putCover(a.id, b);
        });
      });
    });
    return chain
      .then(function () { return Store.putAssets(list); })
      .then(function () { return App.reload(); })
      .then(function () { UI.renderAll(); Toast.ok('已加入 ' + list.length + ' 条示例素材（含封面），可逐条删除'); })
      .catch(function (e) { Toast.err('加入示例失败：' + ((e && e.message) || e)); });
  }

  /* ---------------- 启动 ---------------- */
  /** 装载数据与设置，渲染首屏，再挂接事件与延迟任务 */
  function boot() {
    /* 启动分段计时，事后可在控制台 __bootPerf 查看：优化启动要有据可依 */
    var bt0 = (window.performance && performance.now) ? performance.now() : 0;
    var bootPerf = window.__bootPerf = { marks: {} };
    function bmark(k) { bootPerf.marks[k] = Math.round(((window.performance && performance.now) ? performance.now() : 0) - bt0); }
    /* 首屏之后再做的写盘 / 封面补写 / 图集缓存整理，都会拖住启动屏退场 */
    function afterPaint(fn) {
      if (window.requestIdleCallback) requestIdleCallback(function () { fn(); }, { timeout: 1200 });
      else setTimeout(fn, 16);
    }
    Store.open().then(function (ok) {
      if (!ok) Toast.warn('IndexedDB 不可用，已降级为 LocalStorage 模式（容量较小）', 5000);
      return App.loadSettings();
    }).then(function () {
      bmark('settings');
      try { if (typeof P2PUI !== 'undefined') P2PUI.init(); } catch (e) { console.warn('[p2p] init', e); }
      // 每次刷新都重置筛选状态与搜索框（浏览器可能恢复输入框旧值）
      App.filters = { q: '', categories: [], sources: [], avatars: [], tags: [], tagsNot: [], status: 'all', price: 'all', r18: false, delisted: false, wishlist: false };
      App.page = 1;
      UI.promotedFilters = Object.create(null);
      var searchReset = $('#searchInput'); if (searchReset) searchReset.value = '';
      App.applyTheme();
      AI.normalizeConfig();
      applySidebarState(App.settings.sidebarOpen !== false);
      UI.syncSortButton();
      /* 每页数量跟着卡片大小走，不单独提供设置 */
      return App.bootLocalData();
    }).then(function () {
      bmark('localData');
      return App.reload();
    }).then(function () {
      bmark('reload');
      /* 首屏画完就顺手预热工作台的工程列表与导入队列（空闲回调，不挡启动），
       * 否则首次进入会先闪「没有配置工程」，导入入口也要多等一次磁盘读。 */
      afterPaint(function () {
        if (window.WB && WB.preload) { try { WB.preload(); } catch (e) {} }
      });
      /* 回收站到期清理：等首屏画完再起，之后每 30 分钟扫一次，分批删 */
      afterPaint(function () {
        try { if (App.startTrashSweep) App.startTrashSweep(); } catch (e) {}
      });
      /* 视图状态存取：刷新后恢复滚动位置、页码与筛选 */
      function saveView() {
        try {
          sessionStorage.setItem('vrclib_view_v1', JSON.stringify({
            y: Math.round(UI.sY()),
            page: App.page || 1,
            filters: App.filters || null,
            active: App.activeAssetId || '',
            sort: App.settings.sort || '',
            t: Date.now()
          }));
        } catch (e) {}
      }
      /** 把存下来的视图状态应用回页面；刷新恢复不做滚动动画，直接到位 */
      function applyViewState(v, opts) {
        if (!v) return false;
        opts = opts || {};
        try {
          if (v.filters && typeof v.filters === 'object') App.filters = Object.assign({}, App.filters, v.filters);
          if (v.page) App.page = v.page;
          if (v.active) App.activeAssetId = v.active;
          if (v.sort && SORTS.some(function (s2) { return s2.id === v.sort; })) App.settings.sort = v.sort;
        } catch (e) { return false; }
        if (opts.scroll !== false && v.y) {
          requestAnimationFrame(function () { UI.scrollTo(v.y); });
          setTimeout(function () { UI.scrollTo(v.y); }, 160);    // 图片加载后再无声兜一次
        }
        return true;
      }
      function loadView() {
        try {
          // 用 sessionStorage：仅同一会话内刷新可恢复，关掉即失效
          var v = JSON.parse(sessionStorage.getItem('vrclib_view_v1') || 'null');
          return v || null;
        } catch (e) { return null; }
      }
      if (App.localReadOnly && App.localOffline) App.showLocalBanner();
      if (App.localReadBroken) App.showReadBrokenBanner();   // 数据文件读不出来时给出红色告警
      bindEvents();
      Tab.init();
      /* 刷新后恢复上次的筛选 / 页码 / 当前素材，再渲染，最后还原滚动位置 */
      var savedView = loadView();
      if (savedView) {
        try { App.applyViewState(savedView, { scroll: false }); syncFilterUI(); } catch (e) {}
      }
      /* 分步渲染：先同步渲出首屏首批卡片（启动屏随即撤下），其余按时间片分帧续渲。
       * 分栏走同一段 renderOne 与同一个 bottoms 数组，最终布局与一次性渲染一致；
       * App.ready 仍表示「全部渲染完成」。 */
      UI.renderAll({
        progressive: true,
        firstChunk: 24,
        budgetMs: 12,
        onFirstPaint: function () {
          bootPerf.marks.firstPaint = Math.round(((window.performance && performance.now) ? performance.now() : 0) - bt0);
          bootPerf.marks.firstPaintCards = document.querySelectorAll('#grid .card').length;
          $('#bootScreen').classList.add('done');
        },
        onDone: finishBoot
      });

      var bootDone = false;
      function finishBoot() {
        if (bootDone) return;                 // 幂等：分步渲染与用户中途重渲染竞态时只收尾一次
        bootDone = true;
        bmark('render');
        /* 卡顿取证：主线程停顿 >800ms 时记一笔（多久、滚到哪、屏上几张卡），
         * 只留在 window.__stalls（最多 20 条）并在控制台 warn，不打扰用户。 */
        (function () {
          var hits = window.__stalls = window.__stalls || [];
          var last = (window.performance && performance.now) ? performance.now() : Date.now();
          setInterval(function () {
            var now = (window.performance && performance.now) ? performance.now() : Date.now();
            var gap = now - last; last = now;
            if (gap > 800) {
              hits.push({ at: Math.round(now), gap: Math.round(gap), y: Math.round(UI.sY()),
                          cards: document.querySelectorAll('#grid .card').length });
              if (hits.length > 20) hits.shift();
              try { console.warn('[stall] ' + Math.round(gap) + 'ms'); } catch (e) {}
            }
          }, 200);
        })();
        /* 滚动期间冻结卡片 hover 动效：滚轮扫过一排卡会接连触发 transform + box-shadow 过渡，
         * 等于不断新建合成任务；停滚 150ms 后恢复。 */
        (function () {
          var el = UI.scrollEl();               // 文档滚动时为空，退回 window
          var target = el || window;
          var t = null;
          target.addEventListener('scroll', function () {
            if (document.body && !document.body.classList.contains('scrolling')) {
              document.body.classList.add('scrolling');
            }
            if (t) clearTimeout(t);
            t = setTimeout(function () {
              if (document.body) document.body.classList.remove('scrolling');
            }, 150);
          }, { passive: true });
        })();

        /* ==================== 滚轮自己的短缓动 ====================
         * 原生滚轮平滑滚动每格要驱动十几帧，滚动路径会堵住窗口线程；关掉后一格 120px 硬跳，手感差。
         * 这里接管滚轮做短缓动：比硬跳顺，又只有系统那套的六成成本。
         * 「元素自己能不能滚」的判断缓存祖先 overflow 样式：逐事件走 getComputedStyle 是高频样式解析；
         * scrollHeight 则每次现读（内容会长，缓存会过期）。
         * 让路：Ctrl/Shift 滚轮、弹窗滚动锁定、自带滚动条的容器。 */
        (function () {
          /* Electron 壳用 Chromium 原生平滑滚动：这里连监听都不注册。
           * 非被动 wheel 会让整条滚动路径等主线程，交还合成器更稳。 */
          if (window.vrcElectron && window.vrcElectron.shell === 'electron') return;
          /* 滚轮三档（设置 → 外观 → 滚轮手感）：system 跟系统最稳但一格硬跳，
           * fine 接管且步子减半，smooth 接管并缓动、最顺但代价最高。
           * 代价与每格滚轮驱动的帧数成正比，动画帧和滚轮事件重叠就容易停顿，只能交给用户选。 */
          var STEP_MAX = 300;       // 单次上限，防高精度滚轮/触控板一下跳太远
          var EASE = 0.26;          // smooth 档的每帧收敛比（约 15 帧）
          var target = 0, cur = 0, raf = 0, active = false;
          var styleCache = new WeakMap();

          function wheelMode() { return (App.settings && App.settings.wheelMode) || 'fine'; }
          function maxY() {
            return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
          }
          function locked() {
            return !!(document.body && (document.body.classList.contains('modal-open') ||
                                        document.body.classList.contains('wb-open')));
          }
          /* 祖先里有没有「自己带滚动条、且确实溢出」的容器。overflow 样式是静态的，缓存起来；
           * scrollHeight/clientHeight 每次现读（内容会长，缓存会过期）。 */
          function ownScroller(el) {
            for (var n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
              var hasStyle = styleCache.get(n);
              if (hasStyle === undefined) {
                var oy = getComputedStyle(n).overflowY;
                hasStyle = (oy === 'auto' || oy === 'scroll' || oy === 'overlay');
                styleCache.set(n, hasStyle);
              }
              if (hasStyle && n.scrollHeight > n.clientHeight + 2) return true;
            }
            return false;
          }
          function tick() {
            var diff = target - cur;
            if (Math.abs(diff) < 0.6) { cur = target; window.scrollTo(0, cur); raf = 0; active = false; return; }
            cur += diff * EASE;
            window.scrollTo(0, cur);
            raf = requestAnimationFrame(tick);
          }

          window.addEventListener('wheel', function (e) {
            if (e.ctrlKey || e.shiftKey || e.defaultPrevented) return;     // 缩放 / 横向，交回系统
            if (UI.scrollEl()) return;                                     // 滚动容器不是文档
            var m = wheelMode();
            if (m === 'system') return;                                    // 跟系统：完全不接管
            if (locked() || ownScroller(e.target)) return;
            var my = maxY();
            if (my < 4) return;                                            // 页面本来就没得滚
            var d = e.deltaY;
            if (e.deltaMode === 1) d *= 40;                                // 按行
            else if (e.deltaMode === 2) d *= window.innerHeight;           // 按页
            if (m === 'fine') d *= 0.55;                                   // 细密档：步子减半
            d = Math.max(-STEP_MAX, Math.min(STEP_MAX, d));
            e.preventDefault();
            if (m === 'smooth') {
              if (!active) { cur = window.scrollY; target = cur; active = true; }
              target = Math.max(0, Math.min(my, target + d));
              if (!raf) raf = requestAnimationFrame(tick);
            } else {
              var y = Math.max(0, Math.min(my, window.scrollY + d));
              if (y !== window.scrollY) window.scrollTo(0, y);
            }
          }, { passive: false });
        })();

        if (savedView && savedView.y) {
          var wantY = savedView.y;
          requestAnimationFrame(function () { UI.scrollTo(wantY); });      // 先直接落位，别让用户看到页面顶部
          setTimeout(function () { UI.scrollTo(wantY); }, 160);   // 图片加载后再无声兜一次（刷新恢复不使用滚动动画）
        }
        App.applyViewState = applyViewState;
        App.saveViewState = saveView;
        App.loadViewState = loadView;
        window.addEventListener('beforeunload', saveView);
        /* 关窗时把还在 1.2s 防抖里的设置/素材补写一次，别让最后一次改动停在内存里 */
        function flushOnHide() { try { if (App.flushFileSync) App.flushFileSync(); } catch (e) {} }
        window.addEventListener('beforeunload', flushOnHide);
        window.addEventListener('pagehide', flushOnHide);
        var viewTimer = null;
        /* scroll 事件不冒泡到 window，必须挂到真正的滚动容器（拿不到才退回 window），
         * 否则滚动中不会自动保存视图位置。 */
        var viewScrollEl = UI.scrollEl();
        (viewScrollEl || window).addEventListener('scroll', function () {
          if (viewTimer) clearTimeout(viewTimer);
          viewTimer = setTimeout(saveView, 260);
        }, viewScrollEl ? { passive: true } : false);
        DLPanel.init();          // 下载任务悬浮窗
        DLQueue.restore();       // 恢复上次未完成的下载队列
        App.ready = true;
        bmark('ready');
        $('#bootScreen').classList.add('done');
        setTimeout(function () { var b = $('#bootScreen'); if (b) b.remove(); }, 400);
        /* ---- 首屏已可见：下面这些都不影响你看到素材，放到空闲时再做 ---- */
        afterPaint(function () {
          var t1 = (window.performance && performance.now) ? performance.now() : 0;
          if (App.localCacheNewer) Toast.info('检测到浏览器缓存比 ' + App.localDir + ' 里的数据更新，已按缓存为准并回写文件', 5200);
          /* F5 / F11 / Ctrl+Shift+I / Ctrl+O 由 Electron 主进程的 before-input-event 统一处理 */
          /* 判定运行载体（桌面版 / 网页版）并打上 body.desk-mode，
           * 同一份 HTML 的 CSS 与文案据此给出不同布局。 */
          try {
            var isDesk = !!(FS.host && FS.host.desk && FS.host.desk());
            App.mode = isDesk ? 'desk' : 'web';
            if (document.body) document.body.classList[isDesk ? 'add' : 'remove']('desk-mode');
            if (isDesk) {
              var bm = document.querySelector('.brand-main');
              if (bm && !bm.querySelector('.chip-desk')) {
                bm.appendChild(el('span', { class: 'chip chip-desk', title: 'Electron 桌面版：程序后端随窗口启动，无需任何外部程序' }, '桌面版'));
              }
            }
          } catch (e) {}
          /* 首次运行询问「数据放哪」：放在首屏之后不拖慢启动，已有库会静默跳过 */
          setTimeout(function () {
            try { Settings.askDataDirIfNeeded(); } catch (e) {}
          }, 700);
          /* 只有启动清洗确实改过数据、或判定「缓存比文件新」时才补写：
           * 无条件调用等于每次开机重写整份 assets.json，而那条「已按缓存为准」的提示也要求真的回写。 */
          if (App._lastReloadChanged
              || (App.needSyncAfterBoot && (App.assets || []).length)) App.scheduleFileSync('assets');
          /* 每轮补写 120 个封面：带游标续跑，下次开机接着来；批量太小会让磁盘封面长期落后于缓存 */
        if (!App.localReadOnly) App.syncCoverFiles(120);     // 顺带把只在缓存里的封面补写到磁盘
          if (!App.localReadOnly) App.migrateGalleryCache();   // 浏览器图集缓存转 PNG 落盘后清空
          bootPerf.marks.deferred = Math.round(((window.performance && performance.now) ? performance.now() : 0) - t1);
        });
      }
      if (window.matchMedia) {
        try {
          window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () {
            if (App.settings.theme === 'auto') App.applyTheme();
          });
        } catch (e) {}
      }
    }).catch(function (e) {
      console.error(e);
      var b = $('#bootScreen');
      if (b) b.innerHTML = '<div class="boot-err">启动失败：' + esc(e.message || e) + '</div>';
    });
  }

  /* =====================================================================
   * 左侧页签（素材库 / 导入与工程）
   *
   * 两者是并列页签而不是互斥浮层：body.tab-workbench 只让工作台浮层让出页签栏宽度，
   * 素材库的筛选栏与网格原封不动留在下面，切回来不用重建。
 */
  var Tab = (function () {
    var cur = 'library';

    function apply(name) {
      document.body.classList.toggle('tab-workbench', name === 'workbench');
      document.body.classList.toggle('tab-trash', name === 'trash');
      var btns = document.querySelectorAll('.tabrail-btn');
      Array.prototype.forEach.call(btns, function (b) {
        b.classList.toggle('active', b.dataset.tab === name);
      });
    }

    function set(name) {
      name = (name === 'workbench' || name === 'trash') ? name : 'library';
      if (name === cur) return;
      cur = name;
      apply(name);
      if (window.WB) {
        if (name === 'workbench') WB.show ? WB.show() : WB.open();
        else if (WB.hide) WB.hide();
      }
      if (window.TrashUI) {
        if (name === 'trash') TrashUI.show();
        else TrashUI.hide();
      }
    }

    function current() { return cur; }

    function init() {
      var rail = document.getElementById('tabRail');
      if (!rail) return;
      rail.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('.tabrail-btn') : null;
        if (btn) set(btn.dataset.tab);
      });
      apply(cur);
    }

    return { set: set, current: current, init: init };
  })();
  window.AppTab = Tab;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 自绘窗口按钮（最小化 / 最大化 / 关闭）与双击顶栏切换最大化 */
  (function () {
    var bar = document.getElementById('winControls');
    if (!bar) return;
    var api = window.vrcElectron;
    if (!api || typeof api.winAction !== 'function') { bar.style.display = 'none'; return; }
    var bMin = document.getElementById('winMin');
    var bMax = document.getElementById('winMax');
    var bClose = document.getElementById('winClose');
    if (bMin) bMin.onclick = function () { api.winAction('min'); };
    if (bMax) bMax.onclick = function () { api.winAction('max'); };
    if (bClose) bClose.onclick = function () { api.winAction('close'); };
    if (bMax && typeof api.onWinState === 'function') {
      api.onWinState(function (m) {
        bMax.textContent = m ? '\uE923' : '\uE922';   /* ❐ 还原 / □ 最大化：Windows 标题栏同款字形 */
        bMax.title = m ? '还原' : '最大化';
        bar.classList.toggle('is-max', !!m);
      });
    }
    var top = document.querySelector('.topbar');
    if (top) top.addEventListener('dblclick', function (e) {
      if (e.target.closest('.win-controls, button, input, select, a, .chip')) return;
      api.winAction('max');
    });
  })();

  window.VRCLib = { App: App, UI: UI, Store: Store, FS: FS, Fetchers: Fetchers, Smart: Smart, Tools: Tools, seedDemo: seedDemo, seedSamples: seedSamples };
})();

/* ==================== 卡顿 / 未响应取证（F9 开关） ====================
 * 记两样互相独立的证据：rAF 帧间隔（窗口线程或合成器堵塞）、longtask（主线程被 JS 占住）。
 * 帧间隔有大空档而 longtask 干净，说明瓶颈不在页面脚本，不必再往 CSS/JS 上找。
 * 数据留在 window.__jank，按 F9 在右上角看实时汇总。
 */
(function () {
  var J = window.__jank = { gaps: [], tasks: [], fps: 0, steps: [] };
  var last = 0, frames = 0, fpsT = 0, lastY = 0, running = false, observed = false;
  function tick(t) {
    if (!running) return;
    if (last) {
      var gap = t - last;
      frames++;
      if (!fpsT) fpsT = t;
      if (t - fpsT >= 500) { J.fps = Math.round(frames * 1000 / (t - fpsT)); frames = 0; fpsT = t; }
      if (gap > 80) {
        J.gaps.push({ gap: Math.round(gap), y: Math.round(window.scrollY || 0) });
        if (J.gaps.length > 40) J.gaps.shift();
      }
      /* 记录滚动位移是否均匀：fps 与帧间隔都正常却仍觉卡顿时，
       * 剩下的可能就是每帧 scrollY 增量在跳（缓动按 60Hz 插值，高刷下会走成锯齿）。 */
      var y = window.scrollY || 0;
      if (document.body && document.body.classList.contains('scrolling')) {
        J.steps.push(Math.abs(Math.round(y - lastY)));
        if (J.steps.length > 240) J.steps.shift();
      }
      lastY = y;
    }
    last = t;
    requestAnimationFrame(tick);
  }
  /* 默认不采样：只有 ?debug=1 或按过 F9（HUD 打开期间）才起，避免每帧都占一次调度 */
  function start() {
    if (running) return;
    running = true; last = 0; frames = 0; fpsT = 0;
    requestAnimationFrame(tick);
    if (observed) return;
    observed = true;
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          J.tasks.push({ d: Math.round(e.duration), at: Math.round(e.startTime) });
          if (J.tasks.length > 40) J.tasks.shift();
        });
      }).observe({ type: 'longtask' });
    } catch (e) {}
  }
  var DEBUG = (location.search || '').indexOf('debug=1') >= 0;
  if (DEBUG) start();

  var box = null;
  /* 判断是否真在走显卡：WebView2 拿不到 chrome://gpu，改用 WebGL 的 UNMASKED_RENDERER。
   * 软件渲染会写 SwiftShader / Software —— 这类机器「被别的窗口盖住就不卡」是典型表现。 */
  function gpuInfo() {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return 'WebGL 不可用（多半是软件渲染）';
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '拿不到渲染器信息';
    } catch (e) { return 'WebGL 探测失败: ' + e.message; }
  }
  var GPU = '';
  function summary() {
    if (!GPU) GPU = gpuInfo();      // 探测要建 WebGL 上下文，别在启动时就做
    var g = J.gaps.slice(-12), t = J.tasks.slice(-6);
    var worst = g.reduce(function (m, x) { return Math.max(m, x.gap); }, 0);
    var taskWorst = t.reduce(function (m, x) { return Math.max(m, x.d); }, 0);
    var lines = [];
    lines.push('渲染器：' + GPU);
    lines.push('窗口 ' + window.innerWidth + '×' + window.innerHeight + ' ｜ DPR ' + (window.devicePixelRatio || 1) +
               ' ｜ 实际像素 ' + Math.round(window.innerWidth * (window.devicePixelRatio || 1)) + '×' +
               Math.round(window.innerHeight * (window.devicePixelRatio || 1)));
    lines.push('rAF 帧间隔 >80ms：' + J.gaps.length + ' 次，最坏 ' + worst + 'ms');
    lines.push('  最近几次：' + (g.length ? g.map(function (x) { return x.gap; }).join(' / ') : '无'));
    lines.push('主线程 longtask：' + J.tasks.length + ' 次，最坏 ' + taskWorst + 'ms');
    lines.push('  最近几次：' + (t.length ? t.map(function (x) { return x.d; }).join(' / ') : '无'));
    lines.push('当前 ' + J.fps + ' fps ｜ 卡片 ' + document.querySelectorAll('#grid .card').length +
               ' 张 ｜ scrolling=' + (document.body.classList.contains('scrolling') ? '1' : '0'));
    /* 每帧位移统计：均匀 = 呈现节奏问题；锯齿（很多 0 夹着大跳）= 滚动动画在按 60Hz 走 */
    var s = J.steps.slice(-120);
    if (s.length) {
      var sum = s.reduce(function (a, b) { return a + b; }, 0);
      var zeros = s.filter(function (x) { return x === 0; }).length;
      var mx = s.reduce(function (a, b) { return Math.max(a, b); }, 0);
      lines.push('每帧位移：均 ' + Math.round(sum / s.length) + 'px ｜ 最大 ' + mx + 'px ｜ 0 位移帧 ' +
                 zeros + '/' + s.length + '（' + Math.round(zeros * 100 / s.length) + '%）');
      lines.push('  最近 24 帧：' + s.slice(-24).join(' '));
    } else {
      lines.push('每帧位移：还没有样本（滚一下再看）');
    }
    lines.push('');
    lines.push('判读：fps 高 + 帧间隔空 = 页面没问题；位移锯齿（0 与大跳交替）= 滚动动画节奏问题。');
    return lines.join('\n');
  }
  function ensure() {
    if (box) return box;
    box = document.createElement('pre');
    box.id = 'jankHud';
    box.style.cssText = 'position:fixed;right:12px;top:66px;z-index:99999;margin:0;padding:10px 12px;' +
      'max-width:460px;white-space:pre-wrap;font:12px/1.55 Consolas,monospace;color:#e6e9ef;' +
      'background:rgba(12,14,18,.92);border:1px solid #3a4353;border-radius:10px;pointer-events:none';
    document.body.appendChild(box);
    return box;
  }
  var hudTimer = null;
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'F9') return;
    e.preventDefault();
    if (box) {
      box.remove(); box = null;
      if (!DEBUG) running = false;
      if (hudTimer) { clearInterval(hudTimer); hudTimer = null; }
      return;
    }
    start();
    var b = ensure();
    b.textContent = summary();
    if (hudTimer) clearInterval(hudTimer);
    hudTimer = setInterval(function () { if (box) box.textContent = summary(); }, 400);
  }, true);
  window.__jankReset = function () { J.gaps = []; J.tasks = []; };
})();
