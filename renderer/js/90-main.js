/* ============ 90-main.js ============ */
/* =====================================================================
 * 90-main.js  —  启动、事件绑定、快捷键
 * ===================================================================== */

(function () {

  /* v2.3.27：顶栏 / 工具栏 / 空状态的静态图标改为内联 SVG。
   * index.html 里原本是 HTML 实体或 emoji（\u{1F4E6} \u2630 \u{1F50D} \u2715 \u2611 \u{1F4E5} \u2795 \u2699 \u25A6 \u2261 \u{1F9EA}），
   * 启动时替换成同一套描摹图标：纯图标按钮清空后填入，带文字的按钮插到文字前。 */
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
      ['#emptyAdd', 'plus', false],
      ['#emptyDemo', 'flask', false]
    ];
    map.forEach(function (it) {
      var node = document.querySelector(it[0]);
      if (!node) return;
      var ico = ICONS.make(it[1], it[2] ? { size: 16, class: it[3] || '' } : { size: 15, class: 'ico-pre' });
      /* v2.4.0：只剥掉开头的【图标字符】，保留同一个文本节点里的文案。
       * 原来是 `while (firstChild.nodeType === 3) removeChild`——把「➕ 添加第一个素材」「🧪 载入示例数据」
       * 这种「实体图标 + 文案写在同一个文本节点」的按钮文案整段删掉，空状态里只剩两个光秃秃的图标按钮
       * （实测：textContent 为空、宽度 48px）。DOM 里带 <span class="label"> 的按钮不受影响。 */
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

  /* v5.1：侧栏收起 = 宽度真的归零（内联样式兜底，避免样式表优先级打架）；
 * .sidebar 上有 width/flex-basis 的过渡，所以是平滑收回、内容区同时变宽。
 * 放在顶层：bindEvents() 和 boot() 都要用。 */
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

function bindEvents() {
    // 搜索
    var search = $('#searchInput');
    search.addEventListener('input', debounce(function () {
      App.filters.q = search.value;
      App.page = 1;
      UI.renderMain();
      UI.scrollTopInstant();                 // v2.5.9（用户要求）：搜索 → 瞬间回顶部
    }, 180));
    /* v2.5.10（用户要求）：**卡片范围内任意点击**都记为该卡「活跃」（显示 .card-active 选中效果），
     * 不只是鼠标悬浮；**弹窗（详情/编辑/设置）里的点击一律拦截**；**多选模式下的勾选不算卡片交互**
     * （只有点卡片上的 chip / 标签 / 丝带 / 角标 / ★ 才算）。
     * 挂在 #grid 上并用**捕获阶段**：卡片内的元素都调了 stopPropagation，冒泡阶段收不到。 */
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
      /* v5.2（用户要求）：搜索框本来就是空的时，点 × 只是把焦点放回去，
       * 不重排卡片、不动页码、不触发入场动画。 */
      if (search.value === '' && !App.filters.q) { search.focus(); return; }
      search.value = ''; App.filters.q = ''; UI.renderAll(); UI.scrollTopInstant(); search.focus();
    });
    // v2.2.12 模糊搜索开关（搜索框右侧）
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
      /* v5.2（用户要求）：没有搜索词时，模糊开关只改设置，不重排卡片。 */
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
      // v2.3.20：点版本号看更新日志
      brandVersion.title = '查看更新日志';
      brandVersion.addEventListener('click', function () { Modals.changelog(); });
    }
    $('#btnTheme').addEventListener('click', function () {
      /* v4.5：五档循环：暗色 → 亮色 → 樱粉马卡龙 → 天际蓝 → 跟随系统 */
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
    $('#sortSelect').addEventListener('change', function () {
      App.settings.sort = this.value; App.page = 1; App.saveSettings(); UI.renderMain();
      UI.scrollTopInstant();                 // v2.5.9（用户要求）：排序 → 瞬间回顶部
    });
    /* v5.0：网格按钮兼任卡片大小开关 —— 已在网格视图时点它，按 中 → 大 → 小 循环；
     * 在列表视图时点它只切回网格（大小不变）。侧栏收起/展开不碰这个预设。 */
    function sizeLabel(x) { return ({ s: '小', m: '中', l: '大' })[x] || '中'; }
    function cycleCardSize() {
      var order = ['m', 'l', 's'];
      var i = order.indexOf(App.settings.cardSize || 'm');
      App.settings.cardSize = order[(i + 1) % 3];
      App.page = 1;
      App.saveSettings();
      UI.renderMain();
      UI.scrollTopInstant();
      Toast.info('卡片大小：' + sizeLabel(App.settings.cardSize) + '（每页 ' + App.pageSizeFor() + ' 个）', 2500);
    }
    $$('.view-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.view === 'grid' && App.settings.view === 'grid') { cycleCardSize(); return; }
        App.settings.view = b.dataset.view; App.page = 1; App.saveSettings(); UI.renderMain();
      UI.scrollTopInstant();                 // v2.5.9（用户要求）：网格/列表切换 → 瞬间回顶部
      });
    });

    /* v5.2（用户要求）：网格按钮右边加一个刷新按钮 —— 重新从磁盘读一遍素材库再重画。 */
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
    $('#bulkDownloaded').addEventListener('click', function () { Tools.rescanDiskState(); });   // v2.5.1（P5）：原来是只写个 UI 无入口字段的「标记已下载」
    $('#bulkHide').addEventListener('click', function () { Tools.bulkToggleHidden(true); });
    $('#bulkExport').addEventListener('click', function () { Tools.bulkExport(); });
    /* v4.2.0：把选中的素材连文件一起打成 .vrcpack（标准 zip），发给别人导入 */
    $('#bulkExportPack').addEventListener('click', function () {
      var ids = App.selectedIds();
      if (!ids.length) { Toast.warn('先勾选要导出的素材'); return; }
      var list = (App.assets || []).filter(function (a) { return ids.indexOf(a.id) >= 0; });
      Packer.exportDialog(list);
    });
  $('#bulkDownloadMissing').addEventListener('click', function () { Tools.bulkDownloadMissing(); });   // v2.5.0（S4）
    $('#bulkDelete').addEventListener('click', function () { Tools.bulkDelete(); });
    $('#bulkExit').addEventListener('click', function () {
      App.selectMode = false; App.clearSelection();
      $('#btnSelectMode').classList.remove('active');
      UI.renderAll();
    });

    // 空状态按钮
    $('#emptyAdd').addEventListener('click', function () { Modals.edit(null); });
    $('#emptyDemo').addEventListener('click', function () { seedDemo(); });

    // 快捷键
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      if (e.key === 'Escape') {
        if (Modal.stack.length) { Modal.closeTop(); return; }
        if (App.selectMode) { $('#bulkExit').click(); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#searchInput').focus(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); FS.downloadJSON(true); return; }
      if (typing || Modal.stack.length) return;
      if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); }
      else if (e.key.toLowerCase() === 'n') { e.preventDefault(); Modals.edit(null); }
      else if (e.key.toLowerCase() === 'g') {
        App.settings.view = App.settings.view === 'grid' ? 'list' : 'grid';
        App.saveSettings(); UI.renderMain();
      } else if (e.key.toLowerCase() === 't') { $('#btnTheme').click(); }
      else if (e.key.toLowerCase() === 'r') { Tools.randomPick(); }
      else if (e.key === 'ArrowRight') {
        var pi = App.pageInfo();
        if (pi.page < pi.pages) { App.page = pi.page + 1; UI.renderMain(); }
      } else if (e.key === 'ArrowLeft') {
        var pj = App.pageInfo();
        if (pj.page > 1) { App.page = pj.page - 1; UI.renderMain(); }
      }
    });

    // 内置宿主检测：离线时页面照常打开，只提示一次（短时，避免挡住后续操作提示）
    setTimeout(function () {
      FS.hostEnsure().then(function (ok) {
        if (!ok) Toast.warn('内置宿主未就绪：文件打开/联网等功能受限，请重启程序。', 3000);
      });
    }, 1600);

    // 全局捕获：阻止 file:// 页面被拖拽内容导航（Unsafe attempt to load URL 的根源）
    window.addEventListener('dragover', function (e) { e.preventDefault(); }, true);
    window.addEventListener('drop', function (e) { e.preventDefault(); }, true);

    /* v4.2.1：把 .vrcpack / .zip 直接拖进窗口就能导入（拖拽 → 清单预览 → 确认解包）。
     * 覆盖层的显隐与 dragleave 判定都在 Packer 内部统一处理，
     * 这里不再单独监听 dragleave —— 那样会在鼠标移入子元素时误清掉提示层。 */
    if (typeof Packer !== 'undefined' && Packer.installDropZone) Packer.installDropZone();

    // 窗口宽度变化时按新宽度重新分栏（防抖）
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { UI.renderMain(); }, 150);
    });
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
        item('version', '同步我的 BOOTH 已购（需内置宿主）',
          '已保存 booth.pm Cookie 且内置宿主在线时，由宿主自动翻页同步购买记录与下载直链。',
          function () { Importer.syncLibraryDialog(); }),
        item('star', '导入 BOOTH 心愿单（需内置宿主）',
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
        paths: [{ path: joinWinPath(App.libraryRoot(), ['衣装', '戚风', '冬季厚毛衣']), note: '' }],   // v3.0.4：示例数据不再写死个人路径
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

  /* ---------------- v5.0：布局调试用示例素材 ---------------- */
  /* 12 条差异化的样例：短标题/超长标题、0~8 个标签、0~3 个角色、免费/付费/未购买、六种分类。
   * 封面用 canvas 现场画一张渐变图，走 Store.putCover 存进封面库（和手动补封面同一条路）。 */
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
  function boot() {
    /* v2.3.27：启动分段计时，事后可查（控制台 `__bootPerf` 或 `?debug=1`）——优化启动速度要有据可依 */
    var bt0 = (window.performance && performance.now) ? performance.now() : 0;
    var bootPerf = window.__bootPerf = { marks: {} };
    function bmark(k) { bootPerf.marks[k] = Math.round(((window.performance && performance.now) ? performance.now() : 0) - bt0); }
    /* 首屏之后再做：写盘 / 封面补写 / 图集缓存迁移都不影响你看到素材卡片，
     * 以前它们排在 renderAll 之前，会一直挡住启动屏退场（封面最多写 20 张，迁移要扫整个图集缓存）。 */
    function afterPaint(fn) {
      if (window.requestIdleCallback) requestIdleCallback(function () { fn(); }, { timeout: 1200 });
      else setTimeout(fn, 16);
    }
    Store.open().then(function (ok) {
      if (!ok) Toast.warn('IndexedDB 不可用，已降级为 LocalStorage 模式（容量较小）', 5000);
      return App.loadSettings();
    }).then(function () {
      bmark('settings');
      // 每次刷新都重置筛选状态与搜索框（浏览器可能恢复输入框旧值）
      App.filters = { q: '', categories: [], sources: [], avatars: [], tags: [], tagsNot: [], status: 'all', price: 'all', r18: false, delisted: false, wishlist: false };
      App.page = 1;
      UI.promotedFilters = Object.create(null);
      var searchReset = $('#searchInput'); if (searchReset) searchReset.value = '';
      App.applyTheme();
      AI.normalizeConfig();
      applySidebarState(App.settings.sidebarOpen !== false);
      var ss = $('#sortSelect');
      SORTS.forEach(function (s) {
        ss.appendChild(el('option', { value: s.id, selected: App.settings.sort === s.id }, s.label));
      });
      /* v5.0：每页数量不再由用户选 —— 跟着卡片大小走（App.pageSizeFor()） */
      return App.bootLocalData();
    }).then(function () {
      bmark('localData');
      return App.reload();
    }).then(function () {
      bmark('reload');
      /* v2.5.2：视图状态存取（与使用处同一作用域——上次放到上一个 then 里导致启动失败，这里修正） */
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
      /** v2.5.2：把存下来的视图状态应用回页面。刷新恢复**不做滚动动画**——直接瞬间到位 */
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
          // v2.5.2（用户批复）：改用 sessionStorage —— 同一浏览器会话内刷新就恢复，关掉浏览器即失效
          var v = JSON.parse(sessionStorage.getItem('vrclib_view_v1') || 'null');
          return v || null;
        } catch (e) { return null; }
      }
      if (App.localReadOnly && App.localOffline) App.showLocalBanner();
      if (App.localReadBroken) App.showReadBrokenBanner();   // v2.3.11：数据文件读不出来 → 红色告警
      bindEvents();
      /* v2.5.2：浏览器刷新后回到原位置——先恢复上次的筛选 / 页码 / 当前素材，再渲染，最后还原滚动位置 */
      var savedView = loadView();
      if (savedView) {
        try { App.applyViewState(savedView, { scroll: false }); syncFilterUI(); } catch (e) {}
      }
      /* v2.5.13（性能复查第 2 轮 · 「快速开机」）：**分步渲染**——先同步渲出首屏首批卡片（启动屏随即撤下），
       * 其余卡片按时间片分帧续渲。分栏走的是同一段 renderOne / 同一个 bottoms 数组，
       * 所以最终布局与「一次性渲染」逐字一致；App.ready 语义不变（= 全部渲染完成），
       * 冒烟与探针的等待条件（等 App.ready）不受影响。 */
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
        if (savedView && savedView.y) {
          var wantY = savedView.y;
          requestAnimationFrame(function () { UI.scrollTo(wantY); });      // 先直接落位，别让用户看到页面顶部
          setTimeout(function () { UI.scrollTo(wantY); }, 160);   // 图片加载后再无声兜一次（刷新恢复不使用滚动动画）
        }
        App.applyViewState = applyViewState;
        App.saveViewState = saveView;
        App.loadViewState = loadView;
        window.addEventListener('beforeunload', saveView);
        var viewTimer = null;
        /* v3.0.0 修复：v2.5.16 起滚动容器是 .layout（body overflow:hidden）——scroll 事件不冒泡到 window，
         * 挂 window 等于**永不触发**，只剩 beforeunload 一次机会（滚动中不再自动保存视图位置）。
         * 这里挂到真正的滚动容器上（拿不到才退回 window，行为与改前一致）。 */
        var viewScrollEl = UI.scrollEl();
        (viewScrollEl || window).addEventListener('scroll', function () {
          if (viewTimer) clearTimeout(viewTimer);
          viewTimer = setTimeout(saveView, 260);
        }, viewScrollEl ? { passive: true } : false);
        DLPanel.init();          // v2.3.4 下载任务悬浮窗
        DLQueue.restore();       // 恢复上次未完成的下载队列
        App.ready = true;
        bmark('ready');
        $('#bootScreen').classList.add('done');
        setTimeout(function () { var b = $('#bootScreen'); if (b) b.remove(); }, 400);
        /* ---- 首屏已可见：下面这些都不影响你看到素材，放到空闲时再做 ---- */
        afterPaint(function () {
          var t1 = (window.performance && performance.now) ? performance.now() : 0;
          if (App.localCacheNewer) Toast.info('检测到浏览器缓存比 ' + App.localDir + ' 里的数据更新，已按缓存为准并回写文件', 5200);
          /* v4.1.0：F5 / F11 / Ctrl+Shift+I / Ctrl+O 由 Electron 主进程的 before-input-event 统一处理，
           * 旧 WebView2 壳那套 postMessage 转发已随桌面版移除（同一份 HTML 不再需要双载体兼容）。 */
          /* v2.5.16（双板兼容 · 用户要求）：判定当前运行载体 —— 桌面版壳 / 网页版。
           * 打上 body.desk-mode，CSS 与各处文案可据此给出不同的内容与布局（同一份 HTML）。 */
          try {
            var isDesk = !!(FS.host && FS.host.desk && FS.host.desk());
            App.mode = isDesk ? 'desk' : 'web';
            if (document.body) document.body.classList[isDesk ? 'add' : 'remove']('desk-mode');
            if (isDesk) {
              var bm = document.querySelector('.brand-main');
              if (bm && !bm.querySelector('.chip-desk')) {
                bm.appendChild(el('span', { class: 'chip chip-desk', title: 'Electron 桌面版：内置宿主随窗口启动，无需任何外部程序' }, '桌面版'));
              }
            }
          } catch (e) {}
          /* v4.3.2：只有启动清洗确实改了数据才补写。
           * 原先是无条件调用，等于每次开机都重写一遍整份 assets.json。 */
          if (App._lastReloadChanged) App.scheduleFileSync('assets');
          /* v2.5.14：每轮补写批量 20 → 120（游标续跑，下次开机接着上次位置；只写浏览器里已有 blob 的封面，不联网）。
         * 真实库实测 310 条 hasCover 而 covers 目录只有 84 个文件，20/轮要 15 次开机才轮完。 */
        if (!App.localReadOnly) App.syncCoverFiles(120);     // 顺带把只在缓存里的封面补写到磁盘
          if (!App.localReadOnly) App.migrateGalleryCache();   // v2.3.6：浏览器里的旧图集缓存转 PNG 迁到磁盘后清空
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* v4.9：自绘窗口按钮（最小化 / 最大化 / 关闭）+ 双击顶栏切换最大化 */
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

