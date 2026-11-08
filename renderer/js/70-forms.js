/* 素材详情视图与新增 / 编辑表单：
 * 负责详情弹窗的组装、字段编辑、封面与图集处理，以及信息抓取与填充交互。
 * 依赖 App / Store / FS / Importer / Fetchers 等全局模块，自身不直接读写磁盘。
 * 抓取默认「手动粘贴源码」，即零外部请求；联网动作一律交给后端与 Fetchers。
 */

var Modals = {

  /** 详情页「版本与下载」上次停在哪个切页（true=本地文件）：原地刷新时回到那一页，不把人甩回「链接」 */
  _localTab: false,

  /**
   * 素材变更后的统一刷新入口：
   * 能原地刷新就只换目标卡片，否则整页重渲染并重新定位；同时负责关闭或重开详情。
   */
  refreshAfterChange: function (target, opts) {
    opts = opts || {};
    /* 只要目标还在当前页就静默刷新，不换页、不滚动 —— 重渲染后从头定位会抢走视线。
     * 只有被筛掉或被排到别的页时，才走 revealAsset 把它找出来。 */
    var wasOnPage = !!(target && target.id && document.querySelector('.card[data-id="' + target.id + '"]'));
    /* 编辑一条素材时，只要那张卡还在屏幕上，就只换这一张，不动整页 */
    if (wasOnPage && !opts.keepModal && target && target.id && UI.refreshCard && UI.refreshCard(target.id)) {
      /* 只换卡片也要关掉编辑弹窗；底下若还压着这条素材的详情，也要跟着重建，
       * 否则详情里看到的仍是改名前的路径。 */
      Modal.closeTop();
      if (App.refreshAssetView) App.refreshAssetView(target);
      return;
    }
    var keepY = (typeof window !== 'undefined') ? (UI.sY()) : 0;   // 重渲染前记住滚动位置
    UI.renderAll();
    var stillOnPage = !!(target && target.id && document.querySelector('.card[data-id="' + target.id + '"]'));
    /* 只有「原地不动」时才做 140ms 后的滚动兜底：
     * 目标被筛掉或被排到别的页时要走 revealAsset 定位，这个定时器会把定位结果拽回旧位置。 */
    var willReveal = !opts.keepModal && !!(target && target.id) && !(wasOnPage && stillOnPage);
    if (typeof window !== 'undefined' && keepY) {
      UI.scrollTo(keepY);                                                                        // 渲染后立刻还原
      if (!willReveal) setTimeout(function () { UI.scrollTo(keepY); }, 140);                      // 卡片/封面加载后文档变高，再无声兜一次（否则可能被钳到顶部）
    }
    if (opts.keepModal) {
      /* 原地刷新只允许更新「用户当前正在看的那一条」的详情弹窗。
       * 后台任务完成时若只看栈顶，会把用户正看着的 B 换成 A —— 必须素材 id 一致，
       * 否则只保留上面已完成的网格刷新，绝不碰别人的弹窗。 */
      var top = Modal.stack && Modal.stack.length ? Modal.stack[Modal.stack.length - 1] : null;
      var sameDetail = !!(top && top.kind === 'detail' && target && target.id && App.detailAssetId === target.id);
      if (sameDetail) Modals.detail(target.id, top, { noAutoEnrich: true, keepTab: true });
      return;
    }
    if (target && target.id) {
      if (wasOnPage && stillOnPage) UI.flashCard(target.id);        // 原位静默：只闪一下表示已更新
      else UI.revealAsset(target.id);                              // 换页/被筛掉才重新定位
    }
    Modal.closeTop();
    /* 同上：整页重渲染的路径里，压在编辑弹窗下面的详情页也要重建一次 */
    if (target && target.id && App.refreshAssetView) App.refreshAssetView(target);
    if (opts.reopenDetail && target && target.id) Modals.detail(target.id);
  },

  /** 同步「当前详情弹窗展示的是哪一条素材」到 App.detailAssetId（栈顶往下第一个详情弹窗）。
   *  没有详情弹窗时置空；这是 refreshAfterChange 判断能否原地复用的唯一依据。 */
  syncDetailId: function () {
    var h = null;
    if (Modal.stack) {
      for (var i = Modal.stack.length - 1; i >= 0; i--) {
        if (Modal.stack[i] && Modal.stack[i].kind === 'detail') { h = Modal.stack[i]; break; }
      }
    }
    App.detailAssetId = (h && h.assetId) || '';
    return App.detailAssetId;
  },

  /** 更新日志（点顶栏版本号打开），按次版本号聚合展示 */
  changelog: function () {
    var RECENT = 3;   // 默认展开最近 3 个「次版本」，更早的折起来
    var rows = (typeof CHANGELOG !== 'undefined' ? CHANGELOG : []);
    var series = APP.version.split('.').slice(0, 2).join('.');   // 2.3.21 → 2.3
    function rowNode(row) {
      var items = Array.isArray(row[1]) ? row[1] : [row[1]];
      var body = el('div', { class: 'cl-text' }, items.map(function (t) {
        return el('div', { class: 'cl-item' + (/^修复/.test(String(t)) ? ' cl-fix' : ''), text: '· ' + t });
      }));
      return el('div', { class: 'cl-row' + (row[0] === series ? ' cl-current' : '') }, [
        el('div', { class: 'cl-ver' }, [
          el('b', { text: 'v' + row[0] }),
          row[0] === series ? el('span', { class: 'chip chip-ok cl-badge' }, '当前系列') : null
        ]),
        body
      ]);
    }
    var recent = rows.slice(0, RECENT).map(rowNode);
    var older = rows.slice(RECENT).map(rowNode);
    var olderBox = el('div', { class: 'cl-older', style: { display: 'none' } }, older);
    var olderBtn = older.length ? el('button', {
      class: 'btn btn-sm cl-toggle', onclick: function () {
        var open = olderBox.style.display !== 'none';
        olderBox.style.display = open ? 'none' : '';
        olderBtn.textContent = open ? ('展开更早的 ' + older.length + ' 个版本') : '收起更早版本';
      }
    }, '展开更早的 ' + older.length + ' 个版本') : null;
    Modal.open({
      title: '更新日志',
      size: 'md',
      body: [el('div', { class: 'changelog' }, [
        el('p', { class: 'field-hint', text: '当前版本 v' + APP.version + '（属于 v' + series + ' 系列）。日志只在次版本号变动时新增一条，同一系列内的补丁合并进该条；完整逐版本记录见 docs/技术手册.md §51。' })
      ].concat(recent, olderBtn ? [olderBtn, olderBox] : []))],
      footer: [el('button', { class: 'btn btn-primary', onclick: function () { Modal.closeTop(); } }, '知道了')]
    });
  },

  /* ------------------------------------------------------------------
   * 素材详情
   * ------------------------------------------------------------------ */
  /** 打开或原地重建一条素材的详情弹窗 */
  detail: function (id, targetHandle, opts) {
    opts = opts || {};   // noAutoEnrich：本条重渲染不再触发自动补全，避免「刷新 → 判定 → 再补全」
    var a = App.assets.find(function (x) { return x.id === id; });
    if (!a) { Toast.err('未找到该素材'); return; }
    /* 打开详情就顺手把封面补写到磁盘（covers 目录 + 素材文件夹），缺哪补哪、静默，不阻塞界面 */
    try { App.ensureCoverOnDisk(a, { quiet: true, allowFetch: true }); } catch (e) {}

    /** 标题清洗：去掉「- 店名 - BOOTH」类站点后缀 */
    function cleanTitle(s) {
      return String(s || '').trim()
        .replace(/\s*[-–—|]\s*(BOOTH|Gumroad|pixiv)\s*$/i, '')
        .replace(/\s*[-–—|]\s*[^|]{2,40}\s*[-–—|]\s*BOOTH\s*$/i, '')
        .trim();
    }
    var title = cleanTitle(a.title || a.originalTitle) || '（未命名）';
    var orig = cleanTitle(a.originalTitle) || '';
    var isAvatar = a.category === 'avatar';

    function kv(label, node) {
      if (node === null || node === undefined || node === '') return null;
      return el('div', { class: 'kv' }, [
        el('div', { class: 'kv-k', text: label }),
        el('div', { class: 'kv-v' }, typeof node === 'string' ? [document.createTextNode(node)] : [node])
      ]);
    }
    // section 支持标题右侧的动作节点（如「版本与下载」旁的「重新解析」）
    function section(title, content, rightNode) {
      if (!content && !rightNode) return null;
      return el('section', { class: 'detail-section' }, [
        el('div', { class: 'detail-section-title' }, [
          ICONS.make('folder', { size: 14 }), el('span', { text: title }),
          rightNode ? el('span', { class: 'grow' }) : null,
          rightNode || null
        ]),
        content ? el('div', { class: 'detail-section-body' }, [content]) : null
      ]);
    }

    /* ---------- 左列：封面 + 操作 ---------- */
    var cover = el('div', { class: 'detail-cover' }, [
      el('div', { class: 'cover-ph big' }, [App.categoryIcon(a.category, { size: 64 })])
    ]);
    App.coverURLFor(a).then(function (url) {
      if (!url) return;
      cover.innerHTML = '';
      cover.appendChild(el('img', { src: url, alt: title }));
    });
    // 应用内没有封面时，按商品 ID 从素材本地路径认领（命中即当封面显示并写入封面缓存）
    if (!a.hasCover && !a.coverURL) {
      App.adoptDiskCover(a).then(function (hit) {
        if (!hit) return;
        App.coverURLFor(a).then(function (url) {
          if (!url) return;
          cover.innerHTML = '';
          cover.appendChild(el('img', { src: url, alt: title }));
          // 只补这一张卡片的封面：整列表重渲染会打断滚动，也让人以为又刷新了一次
          var card = document.querySelector('.card[data-id="' + a.id + '"]');
          if (card) {
            var cv = card.querySelector('.card-cover');
            if (cv && !cv.querySelector('img.cover-img')) {
              cv.classList.add('has-img');
              var im = new Image();
              im.className = 'cover-img'; im.alt = title; im.loading = 'lazy';
              im.onerror = function () { cv.classList.remove('has-img'); };
              im.src = url;
              cv.appendChild(im);
            }
          }
        });
      });
    }

    /** 无存储路径时先静默创建，再通过后端直接下载；不再跳转打开下载页面 */
    function ensureAndDownload(url, name, btn, opts) {
      opts = opts || {};
      if (!isHttpUrl(url)) { Toast.warn('下载链接无效'); return; }
      function labelNode() { return btn ? (btn.querySelector('.dl-label') || btn) : null; }
      var origLabel = labelNode() ? String(labelNode().textContent || '') : '';
      function setLabel(txt) { var t = labelNode(); if (t) ICONS.apply(t, txt); }
      if (btn) { btn.disabled = true; setLabel('\u23F3 下载中 …'); }
      function restore() { if (btn) { btn.disabled = false; setLabel(origLabel || '\u2B07 下载'); } }
      // 统一走下载队列（进度见悬浮窗，可并发），不直接发起下载
      Importer.ensureStoragePathQuiet(a).then(function (folderPath) {
        if (!folderPath) { Toast.err('无法创建存储路径，已取消下载。请检查「设置 → 本地库与整理」的素材库根目录与程序后端状态。', 6200); restore(); return; }
        var dst = joinWinPath(folderPath, [name || 'download']);
        var queued = DLQueue.enqueue({ url: url, name: name || '下载文件', dst: dst, assetId: a.id,
          overwrite: !!opts.overwrite, expectSize: opts.expectSize || 0 });
        if (queued && queued.state === 'running') {   // 正在下载的文件不重复入队
          Toast.info('该文件正在下载中，稍后再点「重新下载」', 3600);
          restore();
          return;
        }
        // 入队后按队列真实状态刷新（排队中 → 下载中 xx%），不写死「排队中」
        if (btn) { btn.disabled = true; }
        App.syncDownloadButtons();
        Toast.info((opts.overwrite ? '已加入下载队列（重新下载，将覆盖旧文件）：' : '已加入下载队列：') + (name || '下载文件') + '（进度见右下「下载任务」悬浮窗）', 3600);
      }).catch(function () { restore(); });
    }

    var primaryBtn;
    if ((a.paths || []).length) {
      primaryBtn = el('button', { class: 'btn btn-primary btn-lg', onclick: function () { FS.openPath(a.paths[0].path); } },
        [ICONS.make('folder', { size: 17 }), document.createTextNode('打开文件')]);
    } else if ((a.downloadLinks || []).length) {
      primaryBtn = el('button', {
        class: 'btn btn-primary btn-lg', dataset: { dlUrl: a.downloadLinks[0].url || '' },
        onclick: function () {
          var d = a.downloadLinks[0];
          ensureAndDownload(d.url, d.label || '下载文件', primaryBtn);
        }
      }, [ICONS.make('download', { size: 17 }), el('span', { class: 'dl-label' }, '下载文件 / 导入')]);
    } else {
      primaryBtn = el('button', { class: 'btn btn-primary btn-lg', onclick: function () { Modal.closeTop(); Modals.edit(a.id, { focusDownload: true }); } },
        [ICONS.make('link', { size: 17 }), document.createTextNode('填写下载链接 / 导入')]);
    }

    // 头部右侧按钮：隐藏 / 收藏 左对齐，删除 右对齐
    var favBtn = el('button', { class: 'btn' + (a.favorite ? ' btn-warn' : ''), onclick: function () {
      a.favorite = !a.favorite;
      App.save(a).then(function () { UI.renderAll(); Modal.closeTop(); Modals.detail(a.id); });
    } }, [ICONS.make('star', { size: 15 }), document.createTextNode(a.favorite ? '取消喜欢' : '喜欢')]);
    var hideBtn = el('button', { class: 'btn', onclick: function () {
      a.hidden = !a.hidden;
      App.save(a).then(function () { UI.renderAll(); Modal.closeTop(); Toast.ok(a.hidden ? '已隐藏该素材' : '已取消隐藏'); });
    } }, [ICONS.make(a.hidden ? 'eye' : 'eyeOff', { size: 15 }), document.createTextNode(a.hidden ? '显示' : '隐藏')]);
    var editBtn = el('button', { class: 'btn', onclick: function () { Modal.closeTop(); Modals.edit(a.id); } },
      [ICONS.make('edit', { size: 15 }), document.createTextNode('编辑')]);
    var deleteBtn = el('button', {
      class: 'btn btn-danger-ghost', onclick: function () {
        var doDel = function () {
          App.remove(a.id).then(function (asset) {
            Modal.closeTop(); UI.renderAll();
            App.deletedToast([asset || a]);      // 10 秒内可撤回，错过就在左侧「回收站」里找回
          });
        };
        if (App.settings.confirmDelete) Modal.confirm('确定要删除「' + title + '」吗？\n\n删掉的记录会进回收站，48 小时内可以找回。', { okText: '删除' }).then(function (ok) { if (ok) doDel(); });
        else doDel();
      }
    }, [ICONS.make('trash', { size: 15 }), document.createTextNode('删除')]);

    /* ---------- 右列：标题 / 徽章 / 分区 ---------- */
    var friendDetail = App.isFriend(a);
    var epDetail = App.effectivePrice(a);
    var chips = el('div', { class: 'detail-chips' }, [
      el('span', { class: 'chip chip-cat' }, [App.categoryIcon(a.category, { size: 14 }), document.createTextNode(App.categoryLabel(a.category))])
    ].concat(App.sourceEntries(a).map(function (se) {
      var label = (se.source === 'other' && se.sourceCustom) ? se.sourceCustom : App.sourceLabel({ source: se.source, sourceCustom: se.sourceCustom });
      return el('span', { class: 'chip chip-source', style: { borderColor: App.sourceColor(se.source) }, title: '来源：' + label },
        [App.sourceIcon(se.source, { size: 14 }), document.createTextNode(label)]);
    })).concat([
      a.gifted ? el('span', { class: 'chip chip-gift' }, '获赠')
        : friendDetail ? el('span', { class: 'chip chip-share' }, '分享')
        : App.isGitHubSource(a) ? el('span', { class: 'chip chip-oss', title: '开源素材（GitHub 仓库）' }, '开源')
        : null,
      (a.extra && a.extra.wishlist && !App.isPurchased(a)) ? el('span', { class: 'chip chip-wish', title: '来自 BOOTH 心愿单（已购买的素材不再显示）' }, '心愿单') : null,
      a.delisted ? el('span', { class: 'chip chip-dim', title: '商品已下架 / 无法获取信息' }, '已下架') : null,
      a.hidden ? el('span', { class: 'chip' }, '已隐藏') : null
    ]));

    /* 这行提示解释的是上方主按钮，所以要贴着按钮放、并以 * 起头 */
    var hint = el('div', { class: 'action-hint', text: '* ' +
      ((a.paths || []).length ? '已关联本地路径，点击「打开文件」定位。'
      : ((a.downloadLinks || []).length ? '尚未关联本地路径——先去下载，下载后请登记路径或使用「文件夹导入」。'
      : '尚未关联本地路径，也没有下载链接——先补充下载链接（也可直接手动导入本地文件）。')) });

    // 标签 / 角色 / 链接 / 版本 / 路径节点
    var tagChips = App.displayTags(a).length ? el('div', { class: 'chip-wrap' }, App.displayTags(a).map(function (t) {
      var tstate = UI.tagFilterState(t);
      return el('span', { class: 'tag tag-click' + (Smart.isUntranslated(t) ? ' tag-untrans' : '') + UI.tagFilterClass(tstate),
        title: UI.tagFilterTitle(t, tstate),
        /* 详情页标签同样走三态：默认 → 必须包含 → 排除 → 默认 */
        onclick: function () { Modal.closeTop(); UI.cycleTagFilter(t); } },
        t + (Smart.isUntranslated(t) ? '（待翻译）' : ''));
    })) : null;

    var avatarChips = !isAvatar && App.filterAvatars(a).length ? el('div', { class: 'chip-wrap' },
      App.filterAvatars(a).map(function (v) { return el('span', { class: 'chip chip-av' }, App.avatarLabel(v)); })) : null;

    /** BOOTH 商品链接统一显示中文页，两条硬规则：
     *   · 主域名必须带语言段：/items/xxx → 404，/zh-cn/items/xxx → 200
     *   · 自定义店铺反而不能带语言段：<店铺>.booth.pm/zh-cn/items/xxx → 404
     *   所以只给主域名加 zh-cn，自定义店铺保持原样。 */
    function boothZhUrl(url) {
      var u = String(url || '');
      var m = u.match(/^(https?:\/\/)(?:www\.)?([^\/]*booth\.pm)\/(?:(?:ja|zh-cn|en|ko)\/)?(items\/.*)$/i);
      if (!m) return u;
      var custom = !/^booth\.pm$/i.test(m[2]);
      return m[1] + (custom ? m[2] : 'booth.pm') + '/' + (custom ? '' : 'zh-cn/') + m[3];
    }
    var linksNode = (a.links || []).length ? el('div', { class: 'link-list' }, a.links.map(function (l) {
      var linkUrl = boothZhUrl(l.url);
      return el('div', { class: 'link-row' }, [
        el('a', { href: linkUrl, target: '_blank', rel: 'noopener', class: 'link', title: linkUrl }, l.label || linkUrl),
        el('button', { class: 'btn btn-xs', onclick: function () { copyText(linkUrl).then(function () { Toast.ok('链接已复制'); }); } }, '复制')
      ]);
    })) : null;

    // 已购买 = 该版本有 BOOTH / Gumroad 订单（下载页）链接；许可证/readme 等免费特殊变体单独展示在已购与未购买之间
    function isPurchasedVer(v) { return !!(v.orderUrl && v.orderUrl.trim()) && !v.special; }
    var purchasedVer = (a.versions || []).filter(isPurchasedVer);
    /* 本地登记的版本（拖进卡片 / 手动放入）没有订单链接，不能被列成「未购买」——
     * 那是商品侧的概念，混进来会让人以为还要去买一份。 */
    var unpurchasedVer = (a.versions || []).filter(function (v) { return !isPurchasedVer(v) && !v.special && !v.local; });
    function purchasedPriceLabel(sum, cur) {
      if (!sum) return '';
      var sym = cur === 'JPY' ? '\u00A5' : (cur === 'USD' ? '$' : (cur === 'EUR' ? '\u20AC' : '\u00A5'));
      return sym + ' ' + sum.toLocaleString('ja-JP');
    }
    function purchasedTotalText() {
      var sum = 0, cur = '';
      purchasedVer.forEach(function (v) {
        var pd = derivePrice(v.price);
        if (pd.value != null) { sum += pd.value; cur = pd.currency || cur; }
      });
      return purchasedVer.length
        ? ('已购买 ' + purchasedVer.length + ' 个版本' + (sum ? '，合计 ' + purchasedPriceLabel(sum, cur) : '') + '；灰色 = 未购买，不计价')
        : '未解析到已购买版本（灰色 = 未购买），价格记为 0';
    }
    // 商品价统一看变体价，详情页不再单列合计行
    var activeTotalNode = null;

    // 「获取更新」：解析已购版本订单页里的下载文件（订单链接存在但 files 尚未解析时补充）
    // 与批量获取更新共用同一份应用逻辑
    function orderFilesFromItem(it, v) { return Importer.applyOrderFilesToVersion(it, v); }
    // 「获取更新」常驻：先补缺失文件，之后用来刷新已解析文件（含作者新上传的）
    /** 抓商品页：BOOTH 走公开 JSON，Gumroad 走商品页 data-page，抓不到返回 null */
    function fetchItemInfo() {
      var itemId = String(a.itemId || '').trim();
      if (a.source === 'booth' && itemId) {
        var url = 'https://booth.pm/ja/items/' + itemId + '.json';
        return Net.fetchText(url, { forceNetwork: true, onLog: function () {} }).then(function (r) {
          if (!r || !r.ok || !r.text) return null;
          return Fetchers.parsePasted(r.text, url);
        }).catch(function () { return null; });
      }
      var link = (a.links || []).filter(function (l) { return isHttpUrl(l.url); })[0];
      if (link && a.source === 'gumroad') {
        return Fetchers.fetchInfo(link.url, { forceNetwork: true, noCache: true }).then(function (info) {
          return (info && !info.__failed) ? info : null;
        }).catch(function () { return null; });
      }
      return Promise.resolve(null);
    }
    /* 只要这条素材还能抓到商品页 / 订单页，就给「获取更新」入口：
     * 免费素材没有已购变体，同样需要刷新文件。 */
    var canUpdate = purchasedVer.length > 0
      || !!(a.itemId && String(a.itemId).trim())
      || (a.links || []).some(function (l) { return isHttpUrl(l.url); });
    var fetchOrderBtn = canUpdate ? el('button', {
      class: 'btn btn-xs btn-parse', type: 'button',
      title: '重新解析这条素材的商品页与订单页（刷新变体文件 / 未购价 / 新变体），并重新对账本地目录（缺失的移除、多出来的记进额外 DLC）',
      onclick: function () {
        var targets = purchasedVer.slice();
        fetchOrderBtn.disabled = true; ICONS.apply(fetchOrderBtn, ('\u23F3 获取更新 …'));
        /* 本地目录也要一起对账：文件早被移动 / 删掉了，光刷链接会得到一份「记录里有、磁盘上没有」的假清单。
         * 不深入扫描，只读顶层文件名。失败（离线 / 盘不在）不影响联网那半。 */
        var localP = rescanLocal({ force: true }).catch(function () {
          return { ok: false, error: '对账失败', added: 0, removed: 0, missing: [], baseN: 0, extraN: 0 };
        });
        var urls = uniq(targets.map(function (v) { return v.orderUrl; }).filter(Boolean));
        var orderP = Promise.all(urls.map(function (url) {
          return Net.fetchText(url, { forceNetwork: true, onLog: function () {} }).then(function (r) {
            if (!r || !r.ok || !r.text) return { url: url, item: null };
            var parsed = Importer.parseOrderPage(url, r.text);
            var items = parsed.items;
            if (!items.length) return { url: url, item: null };
            /* 不无脑取第一条：那会把别的商品的条目并进来，表现成「详情页变成另一个商品」。
             * 只接受 itemId 对得上、订单页只有一条、或条目没带 itemId 的情况。 */
            var myIid = String(a.itemId || '');
            function normU(u) { return String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase(); }
            var myUrls = Object.create(null);
            (a.links || []).forEach(function (l) { if (l && l.url) myUrls[normU(l.url)] = 1; });
            if (a.sourceURL) myUrls[normU(a.sourceURL)] = 1;
            if (myIid) myUrls[normU('https://booth.pm/ja/items/' + myIid)] = 1;
            function sameItem(x) {
              if (!x) return false;
              if (myIid && String(x.itemId || '') === myIid) return true;                       // ① 商品 ID
              var xu = normU(x.url || (x.itemId ? 'https://booth.pm/ja/items/' + x.itemId : ''));
              if (xu && myUrls[xu]) return true;                                                // ② 商店链接
              return false;
            }
            var mine = items.filter(sameItem)[0];
            if (!mine && items.length === 1) mine = items[0];                                    // ③ 单条目订单页
            if (!mine && items.every(function (x) { return !String(x.itemId || ''); })) mine = items[0];
            return { url: url, item: mine || null };
          }).catch(function () { return { url: url, item: null }; });
        }));
        // 订单页（已购变体的文件）+ 商品页（免费变体文件 / 未购当前价 / 新变体 / 公开下载链接）+ 本地目录对账 一起处理
        Promise.all([orderP, fetchItemInfo(), localP]).then(function (pack3) {
          var results = pack3[0] || [], info = pack3[1], lres = pack3[2] || null;
          var shop = info ? Importer.mergeItemInfo(a, info) : null;
          var byUrl = Object.create(null), failed = 0;
          results.forEach(function (r) { if (r && r.item) byUrl[r.url] = r.item; else failed++; });
          var added = 0, changed = 0, touched = 0;
          targets.forEach(function (v) {
            var it = byUrl[v.orderUrl];
            if (!it) return;
            var before = JSON.stringify((v.files || []).map(function (f) { return [f.name, f.url, f.size || 0]; }));
            var n = orderFilesFromItem(it, v);                 // 覆盖式写入（订单页为准）
            if (!n) return;
            touched++;
            var after = JSON.stringify((v.files || []).map(function (f) { return [f.name, f.url, f.size || 0]; }));
            if (before === '[]') added += n;
            else if (before !== after) changed++;
          });
          var back = function () { fetchOrderBtn.disabled = false; ICONS.apply(fetchOrderBtn, ('\u{1F504} 获取更新')); };
          var shopN = shop ? (shop.files + shop.priced + shop.added + shop.links) : 0;
          var localTxt = '';
          if (lres && lres.ok) {
            localTxt = (lres.added || lres.removed)
              ? ('；本地：新增 ' + lres.added + ' 个文件、移除 ' + lres.removed + ' 条失效记录')
              : ('；本地已核对（本体 ' + lres.baseN + '、DLC ' + lres.extraN + '）');
            if (lres.missing && lres.missing.length) localTxt += '；本体缺失 ' + lres.missing.length + ' 个';
          }
          var localChanged = !!(lres && lres.ok && (lres.added || lres.removed));
          if (!touched && !shopN && !localChanged) {
            back();
            Toast.err(targets.length
              ? '未解析到更新：订单页可能需要已登录的 Cookie（设置 → 联网与抓取），或该 Gumroad 下载链接已过期。'
              : '未解析到更新：抓不到商品页（检查联网状态 / 链接是否有效）。', 5600);
            return;
          }
          if (!added && !changed && !shopN) {
            back();
            Toast.info('没有发现更新' + (failed ? '（' + failed + ' 个订单页取不到）' : '') + localTxt, 4600);
            return;
          }
          return App.save(a).then(function () {
            try { App.ensureCoverOnDisk(a, { quiet: true, allowFetch: true }); } catch (e) {}   // 解析完顺手补写封面
            Modals.refreshAfterChange(a, { keepModal: true });   // 原地静默刷新，不关弹窗、不跳列表
            var shopTxt = shop
              ? ((shop.files ? '；刷新 ' + shop.files + ' 个变体文件' : '') + (shop.priced ? '；未购价 ' + shop.priced + ' 个' : '')
                + (shop.added ? '；新增变体 ' + shop.added + ' 个' : '') + (shop.links ? '；新增下载链接 ' + shop.links + ' 条' : ''))
              : '';
            Toast.ok('已更新：新增 ' + added + ' 个文件' + (changed ? '、刷新 ' + changed + ' 个版本' : '') +
              (failed ? '；' + failed + ' 个订单页取不到' : '') + shopTxt + localTxt, 5600);
          });
        });
      }
    }, ICONS.label('\u{1F504} 重新解析')) : null;
    var verSectionNode = purchasedVer.length ? el('div', { class: 'ver-section' }, [
      el('div', { class: 'ver-list' }, purchasedVer.map(function (v) {
        return el('div', { class: 'ver-item on' }, [
          el('div', { class: 'ver-main' }, [
            el('b', { text: v.name || v.fileName || '（未命名版本）' }),
            el('span', { class: 'grow' }),   // 撑开占位，价格与订单链接靠右
            el('div', { class: 'field-hint mono' }, [
              el('a', { href: v.orderUrl, target: '_blank', rel: 'noopener', title: v.orderUrl }, '订单链接')
            ])
          ])
        ]);
      }))
    ]) : null;
    // 统一的「已下载」检测：详情页所有下载按钮共用，按同名文件在存储目录下探测。
    // 存储目录优先取 note=存储路径 的那条，不能只认 paths[0]。
    function storageDirOf() {
      var ps = a.paths || [];
      var local = ps.filter(function (x) { return x && x.path; });
      var hit = local.filter(function (x) { return x.note === '存储路径'; })[0] || local[0];
      return hit && hit.path;
    }
    function localKnown(name) {
      return (a.downloadedFiles || []).some(function (x) { return String(x) === String(name); });
    }
    function markLocalDownloaded(name) {
      if (!name) return;
      a.downloadedFiles = uniq((a.downloadedFiles || []).concat([String(name)]));
    }
    /** 磁盘上已有该文件 → 按钮变浅红「重新下载」（点击时后端覆盖旧文件） */
    function markRedownload(btn, dst, why) {
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-redl');
      btn.dataset.redl = '1';
      btn.disabled = false;
      ICONS.apply(btn, ('\u21BB 重新下载'));
      btn.title = (why || '文件已在存储路径') + (dst ? '：' + dst : '') + '（点击重新下载，会覆盖这个文件）';
    }
    function markPlainDownload(btn) {
      btn.classList.remove('btn-redl');
      btn.classList.add('btn-primary');
      delete btn.dataset.redl;
      btn.disabled = false;
      ICONS.apply(btn, ('\u2B07 下载'));
      btn.title = '';
    }
    /**
     * 统一的「已下载」标记：先按本地记录乐观标记，再用磁盘结果权威覆盖。
     * 不能只等权威结果：后端刚掉线时 FS.hostEnsure() 会因短时缓存先返回 true，
     * 随后的真实请求失败若被吞掉，按钮就会错误地回到「⬇ 下载」。
     */
    function markDownloaded(btn, name) {
      if (!btn || !name) return;
      var known = localKnown(name);
      /* 三档判定：
       *   ① 后端可用 → FS.host.exists（权威）
       *   ② 后端离线但浏览器有库根句柄且能读 → FS.diskFileState 内部走 relativePathExists（权威）
       *   ③ 都判定不了 → 静默保持乐观标记，绝不能把「无法判定」当成「没下载」。 */
      if (known) markRedownload(btn, '', '此前成功下载过；当前无法确认文件是否还在磁盘上');
      var dir = storageDirOf();
      if (!dir || !FS.diskFileState) return;
      var dst = joinWinPath(dir, [String(name)]);
      var rel = (typeof FS.relPathFromLibrary === 'function') ? FS.relPathFromLibrary(dir, name) : '';
      FS.diskFileState(dst, rel).then(function (st) {
        if (!st || !st.known) return;                               // 第三档：无法判定 → 静默保持乐观标记（不额外标注）
        if (st.exists) {
          markRedownload(btn, dst, st.via === 'fsa' ? '浏览器库目录里已存在（后端离线，已校验）' : '');
          return;
        }
        markPlainDownload(btn);                                     // 权威结论：磁盘上没有 → 回到「⬇ 下载」
      }).catch(function () {
        if (known) markRedownload(btn, '', '此前成功下载过；校验请求失败，未能确认文件是否还在磁盘上');
      });
    }
    // ---- 下载链接：按变体分组 ----
    // 一个变体一个分组、组内挂它自己的文件、历史版本默认折叠、同一 URL 全局只出现一次；许可证 / readme 单独成框。
    function isLicenseName(n) {
      return /(^|[_\-\s（(])(licen[cs]e|copyright|readme|利用規約|規約|ライセンス|説明書?|取扱説明|はじめに|注意事項)/i.test(String(n || ''));
    }
    // 从文件名识别版本号：xxx_v1.0.zip / xxx_v02 / xxx v1.0.6.1 → 同组的不同历史版本
    function verNumsOf(n) {
      var m = String(n || '').match(/^(.*?)[_\-\s]*v(\d+(?:[._]\d+)*)(\.[A-Za-z0-9]+)?$/i);
      if (!m) return null;
      return { base: (m[1] + (m[3] || '')).toLowerCase(), nums: m[2].split(/[._]/).map(function (x) { return Number(x) || 0; }) };
    }
    function cmpNums(a, b) {
      var n = Math.max(a.length, b.length);
      for (var i = 0; i < n; i++) { var x = a[i] || 0, y = b[i] || 0; if (x !== y) return x - y; }
      return 0;
    }
    /** 同一变体内：同名不同版本归一组，只留最新一个在明面，其余进「历史版本」 */
    function splitHistory(files) {
      var groups = Object.create(null), order = [];
      files.forEach(function (f) {
        var k = verNumsOf(f.name);
        var key = k ? k.base : ('\u0000' + f.name);
        if (!groups[key]) { groups[key] = []; order.push(key); }
        groups[key].push({ f: f, nums: k ? k.nums : null });
      });
      var latest = [], hist = [];
      order.forEach(function (key) {
        var g = groups[key];
        if (g.length > 1) g.sort(function (x, y) { return cmpNums(y.nums || [], x.nums || []); });
        g.forEach(function (it, i) { (i === 0 ? latest : hist).push(it.f); });
      });
      return { latest: latest, hist: hist };
    }
    function fileRow(f) {
      var btn = el('button', { class: 'btn btn-xs btn-primary', dataset: { dlUrl: f.url || '' } }, ICONS.label('\u2B07 下载'));
      var row = el('div', { class: 'link-row' }, [
        el('code', { class: 'path', title: f.name }, f.name + (f.size ? '  ·  ' + fmtSize(f.size) : '')),
        f.url ? btn : null
      ]);
      if (f.url) {
        btn.onclick = function () { ensureAndDownload(f.url, f.name, btn, { overwrite: btn.dataset.redl === '1', expectSize: f.size || 0 }); };
        markDownloaded(btn, f.name);
      }
      return row;
    }
    function histNode(hist) {
      if (!hist.length) return null;
      var box = el('div', { class: 'link-list' }, hist.map(fileRow));
      box.style.display = 'none';
      var tg = el('button', { class: 'btn btn-xs' }, ICONS.label('\u25B8 历史版本 (' + hist.length + ')'));
      tg.onclick = function () {
        var open = box.style.display !== 'none';
        box.style.display = open ? 'none' : '';
        ICONS.apply(tg, (open ? '\u25B8 ' : '\u25BE ') + '历史版本 (' + hist.length + ')');
      };
      return el('div', { class: 'dl-hist' }, [tg, box]);
    }
    // 全局按 URL 去重：同一 URL 只归给第一个遇到的分组
    var seenUrl = Object.create(null);
    function takeFiles(list) {
      var out = [];
      (list || []).forEach(function (f) {
        if (!f || !f.url || seenUrl[f.url]) return;
        seenUrl[f.url] = 1;
        out.push(f);
      });
      return out;
    }
    var licenseFiles = [], dlGroups = [];
    // 1) 变体分组：已购优先 → 免费/特殊 → 其他；只保留真正带文件的变体
    (a.versions || []).slice().sort(function (x, y) {
      var rank = function (v) { return isPurchasedVer(v) ? 0 : (v.special ? 1 : 2); };
      return rank(x) - rank(y);
    }).forEach(function (v) {
      var fs = takeFiles((v.files || []).map(function (f) { return { name: f.name, url: f.url, size: f.size }; }));
      if (!fs.length) return;
      licenseFiles = licenseFiles.concat(fs.filter(function (f) { return isLicenseName(f.name); }));
      var rest = fs.filter(function (f) { return !isLicenseName(f.name); });
      if (!rest.length) return;
      var sp = splitHistory(rest);
      dlGroups.push({ name: v.name || '（默认）', special: !!v.special, purchased: isPurchasedVer(v), latest: sp.latest, hist: sp.hist });
    });
    // 2) 不属于任何变体的直链 → 末尾「其他下载链接」
    var orphanLinks = takeFiles((a.downloadLinks || []).map(function (l) { return { name: l.label || l.url, url: l.url, size: 0 }; }));
    if (orphanLinks.length) dlGroups.push({ name: '其他下载链接', orph: true, latest: orphanLinks, hist: [] });
    var dlNode = dlGroups.length ? el('div', { class: 'ver-special' }, [el('div', { class: 'ver-unpurchased-head', text: '下载链接' })].concat(dlGroups.map(function (g) {
      return el('div', { class: 'dl-group' }, [
        el('div', { class: 'chip-wrap chip-wrap-sm' }, [
          el('span', { class: 'chip ' + (g.special ? 'chip-ver-free' : 'chip-ver-off'), title: g.name }, g.name),
          el('span', { class: 'field-hint', text: '（' + (g.latest.length + g.hist.length) + ' 个文件）' })
        ]),
        el('div', { class: 'link-list' }, g.latest.map(fileRow)),
        histNode(g.hist)
      ]);
    }))) : null;
    var licenseNode = licenseFiles.length ? el('div', { class: 'ver-license' }, [
      el('div', { class: 'ver-unpurchased-head', text: '许可证 / readme（' + licenseFiles.length + '）' }),
      el('div', { class: 'link-list' }, licenseFiles.map(fileRow))
    ]) : null;
    // 未购买变体：保留名称 + 价格，尽量小（标签样式），灰色框 + “未购买”标题；点击前往商品页购买
    var unpurchasedNode = unpurchasedVer.length ? el('div', { class: 'ver-unpurchased' }, [
      el('div', { class: 'ver-unpurchased-head', text: '未购买（点击可前往购买）' }),
      el('div', { class: 'chip-wrap chip-wrap-sm' }, unpurchasedVer.map(function (v) {
        // 未购价也带字母币种（JPY 500），避免 ¥ 的 JPY/CNY 歧义
        /* 抓取可能只给裸数字价，空币种不能默认成 CNY：按商店来源兜底（BOOTH=JPY / Gumroad=USD），
         * 0 价直接显示「免费」。 */
        var vpdU = derivePrice(String(v.price || ''));
        var vShopCodeU = App.sourceCurrency(a);
        var vPriceU = (vpdU && vpdU.value != null)
          ? (vpdU.value === 0 ? '免费' : App.codePriceText(vpdU.value, vpdU.currency || vShopCodeU))
          : (v.price || '');
        var txt = (v.name || '（未命名版本）') + (vPriceU ? ' · ' + vPriceU : '');
        var buyUrl = '';
        var firstLink = (a.links || []).filter(function (l) { return isHttpUrl(l.url); })[0];
        if (firstLink) buyUrl = boothZhUrl(firstLink.url);
        else if (a.itemId && a.source === 'booth') buyUrl = 'https://booth.pm/zh-cn/items/' + a.itemId;
        return buyUrl
          ? el('button', { class: 'chip chip-ver-off chip-buy', title: '前往购买：' + txt, onclick: function () { FS.openExternal(buyUrl); } }, txt)
          : el('span', { class: 'chip chip-ver-off', title: txt }, txt);
      }))
    ]) : null;

    var pathNode = (a.paths || []).length ? el('div', { class: 'link-list' }, a.paths.map(function (p) {
      return el('div', { class: 'link-row' }, [
        el('code', { class: 'path path-copy', title: '点击复制：' + p.path, onclick: function () { copyText(p.path).then(function () { Toast.ok('路径已复制'); }); } }, p.path + (p.note ? '  （' + p.note + '）' : '')),
        el('button', { class: 'btn btn-xs', onclick: function () { FS.openPath(p.path); } }, ICONS.label('\u{1F4C2} 打开'))
      ]);
    })) : null;

    // 店铺名：URL / 站点根地址不能当作者名
    var shopName = a.author || a.shop || '';
    if (/^https?:\/\//i.test(shopName)) shopName = '';
    var shopHost = '';
    if (a.shopUrl) {
      var h = hostOf(a.shopUrl);
      if (h && !/^(booth\.pm|gumroad\.com)$/i.test(h)) shopHost = h.replace(/\.booth\.pm$|\.gumroad\.com$/i, '');
    }
    if (!shopName) shopName = shopHost;
    var shopKV = shopName ? (a.shopUrl
      ? el('a', { href: a.shopUrl, target: '_blank', rel: 'noopener', title: '打开店铺主页' }, shopName)
      : shopName) : '';

    // 商品 ID 只作文本展示：商品页入口已由「商店链接」提供
    var idKV = a.itemId ? el('span', { text: a.itemId }) : '';
    // 网盘：http(s) 链接可点，其它按纯文本展示
    var cloudKV = a.cloudUrl
      ? (/^https?:\/\//i.test(a.cloudUrl)
        ? el('a', { href: a.cloudUrl, target: '_blank', rel: 'noopener', title: '打开网盘链接' }, a.cloudUrl)
        : el('span', { class: 'mono', text: a.cloudUrl }))
      : '';

    // 商品图集：头部缩略条浏览 + 预览窗口（上一张/下一张/设为封面）
    // 图集本地化：外链图下载后转 PNG 存 vrclib-data\gallery\<商品ID>\，之后离线也能浏览
    var galleryImages = (a.images || []).slice();   // 缓存与预览覆盖全部图集，不截断
    var galleryLocal = Object.create(null);
    var galleryDisposed = false;   // 本轮已回收：原地刷新/关闭后，异步预加载不得再产 blob URL
    /** 回收本轮图集 blob。原地刷新必须先回收上一轮 —— 那条路径会提前 return，
     *  只在 onClose 回收会让整册 objectURL 变成永久孤儿。 */
    function revokeGallery() {
      galleryDisposed = true;
      Object.keys(galleryLocal).forEach(function (u) {
        var v = galleryLocal[u];
        if (v && String(v).slice(0, 5) === 'blob:') { try { URL.revokeObjectURL(v); } catch (e) {} }
        delete galleryLocal[u];
      });
    }
    /* 缩略图只加载一次：渲染时不设 src，等预加载判定完（磁盘命中 → blob，未命中 → 外链）一次性设定，
     * 否则图会先以「外链」出现、随后又被 blob 覆盖一遍。 */
    var galleryThumbs = [];
    function applyThumbSrc() {
      if (galleryDisposed) return;
      galleryThumbs.forEach(function (t) {
        if (t.decided) return;
        t.decided = true;
        t.img.src = galleryLocal[t.url] || t.url;
      });
    }
    App.galleryPreload(a, galleryImages).then(function (items) {
      if (galleryDisposed) return;   // 本轮已回收 → 不能再建 blob URL
      (items || []).forEach(function (it) {
        if (it && it.blob) galleryLocal[it.url] = URL.createObjectURL(it.blob);
      });
      applyThumbSrc();
    }).catch(function () { applyThumbSrc(); });

    function ensureGalleryLocal(i) {
      var u = galleryImages[i];
      if (!u) return Promise.resolve(null);
      if (galleryLocal[u]) return Promise.resolve(galleryLocal[u]);
      function adopt(blob) {
        if (galleryDisposed) return '';   // 本轮已回收 → 丢弃迟到的异步下载结果
        var objectURL = URL.createObjectURL(blob);
        galleryLocal[u] = objectURL;
        // 只补「还没决定 src」的缩略图；已按外链加载过的不再换源 —— 换源等于同一张图加载两次
        galleryThumbs.forEach(function (t) { if (t.url === u && !t.decided) t.img.src = objectURL; });
        return objectURL;
      }
      // 先看磁盘缓存（vrclib-data\gallery\<商品ID>\），没有才联网下载并转 PNG 落盘
      return App.galleryFromDisk(a, i).then(function (hit) {
        if (hit && hit.blob) return adopt(hit.blob);
        return Net.fetchBlob(u, {}).then(function (b) {
          if (!b) return null;
          return toPngBlob(b, App.settings.imageMaxWidth).then(function (png) {
            return App.galleryToDisk(a, i, u, png).then(function (p) {
              if (p) return adopt(png);
              // 后端离线等写不了盘：退回浏览器缓存兜底，等后续同步再搬到磁盘（不会白抓一次）
              return Store.galleryAdd(a.id, { url: u, blob: png }).then(function () { return adopt(png); })
                .catch(function () { return adopt(png); });
            });
          });
        });
      }).catch(function () { return null; });
    }

    function setCoverFromURL(u) {
      Toast.info('正在下载该图并设为封面 …');
      return ensureGalleryLocal(galleryImages.indexOf(u) >= 0 ? galleryImages.indexOf(u) : -1).then(function () {
        var blobURL = galleryLocal[u];
        if (!blobURL) {
          return Net.fetchBlob(u, {}).then(function (b) {
            if (!b) { a.coverURL = u; a.hasCover = false; App.dropCover(a.id); return App.save(a); }
            return compressImage(b, App.settings.imageMaxWidth, App.settings.imageQuality).then(function (s) {
              a.hasCover = true; a.coverCleared = false; App.dropCover(a.id);
              return Store.putCover(a.id, s).then(function () { return App.saveCoverToPath(a, s); }).then(function () { return App.save(a); });
            });
          });
        }
        return fetch(blobURL).then(function (r) { return r.blob(); }).then(function (b) {
          a.hasCover = true; a.coverCleared = false; App.dropCover(a.id);
          return Store.putCover(a.id, b).then(function () { return App.saveCoverToPath(a, b); }).then(function () { return App.save(a); });
        });
      }).then(function () { UI.renderAll(); Toast.ok('封面已更新'); })
        .catch(function (e) { Toast.err('设置封面失败：' + (e.message || e)); });
    }

    /* 图集预览：整条缩略图（与详情页同款，可点选、自动滚到可见）+ 左右 1/3 热区循环翻页，
     * 支持删除当前图与缓存全部图集。 */
    function openGalleryViewer(idx) {
      var cur = Math.max(0, Math.min(galleryImages.length - 1, idx || 0));
      var img = el('img', { class: 'viewer-img', alt: '商品图预览' });
      var counter = el('span', { class: 'viewer-counter', text: (cur + 1) + ' / ' + galleryImages.length });
      var thumbs = [];
      function syncStrip() {
        thumbs.forEach(function (b, i) { b.classList.toggle('on', i === cur); });
        var act = thumbs[cur];
        if (act && act.scrollIntoView) { try { act.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {} }
        if (stripNode && stripNode.__syncGalleryEnd) stripNode.__syncGalleryEnd();
      }
      function show() {
        var u = galleryImages[cur];
        img.src = galleryLocal[u] || u;
        counter.textContent = (cur + 1) + ' / ' + galleryImages.length;
        // 迟到的本地化回调只在「仍停在同一张」时才替换 src，否则快速翻页会把图串掉
        ensureGalleryLocal(cur).then(function (localURL) { if (localURL && galleryImages[cur] === u) { img.src = localURL; scheduleNavSize(); } });
        syncStrip();
        scheduleNavSize();
      }
      var stripNode = galleryImages.length ? el('div', { class: 'detail-gallery-strip viewer-strip' }, galleryImages.map(function (u, i) {
        var im = el('img', { alt: '', loading: 'lazy', src: galleryLocal[u] || u });
        im.onerror = function () { im.classList.add('img-failed'); };
        var b = el('button', { class: 'gallery-item', type: 'button', title: (i + 1) + ' / ' + galleryImages.length + '　点击查看这一张', onclick: function () { cur = i; show(); } }, [im]);
        thumbs.push(b);
        return b;
      })) : null;
      function navTo(step) { cur = (cur + step + galleryImages.length) % galleryImages.length; show(); }   // 循环：末张→首张
      var imgWrap = el('div', { class: 'viewer-imgwrap' }, [img]);
      /* 箭头用定尺寸内联 SVG，不用字体字符 '‹'：字符墨迹只有字号的约 0.35，
       * 且墨迹中心 ≠ 行盒中心，靠 line-height 永远居中不准；SVG 放在 flex 容器里是几何居中。 */
      var SVG_NS = 'http://www.w3.org/2000/svg';
      function navArrow(dir) {
        var svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('class', 'viewer-nav-ico');
        svg.setAttribute('aria-hidden', 'true');
        var p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('d', dir === 'prev' ? 'M16 2.5 6.5 12 16 21.5' : 'M8 2.5 17.5 12 8 21.5');
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke', 'currentColor');
        p.setAttribute('stroke-width', '3');
        p.setAttribute('stroke-linecap', 'round');
        p.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(p);
        return svg;
      }
      /* 翻页热区按舞台左右各 1/3 划分，与图片尺寸无关；鼠标进入整条带内即显示箭头。
       * 所以热区挂在 stage 上，不挂图片。 */
      var prevZone = null, nextZone = null;
      if (galleryImages.length > 1) {
        prevZone = el('div', { class: 'viewer-navzone viewer-navzone-prev', title: '上一张（可循环）', onclick: function () { navTo(-1); } }, [
          el('span', { class: 'viewer-nav' }, [navArrow('prev')])
        ]);
        nextZone = el('div', { class: 'viewer-navzone viewer-navzone-next', title: '下一张（可循环）', onclick: function () { navTo(1); } }, [
          el('span', { class: 'viewer-nav' }, [navArrow('next')])
        ]);
      }
      /* 箭头尺寸取图片显示高度的 1/7，夹在 36~200px，正方形以保证圆形光晕不被压扁；
       * 图片加载 / 换图 / 窗口缩放时重算。 */
      function sizeNav() {
        /* 量 imgWrap 而不是 img：图片还没排版时 img 会量到 0，之后不一定有机会重量。 */
        var r = (imgWrap || img).getBoundingClientRect();
        var base = r.height || 0;                      // 纵向（高度）
        if (!base) {   // 图片还没加载出来（外链被墙/加载中）：退而用舞台尺寸，别让箭头停在默认小尺寸
          var sr = (stage && stage.getBoundingClientRect) ? stage.getBoundingClientRect() : { width: 0, height: 0 };
          base = Math.max(0, Math.min(sr.width || 0, sr.height || 0) * 0.9);
        }
        if (!base) return;
        var h = Math.max(36, Math.min(200, Math.round(base / 7)));
        /* 热区挂在 stage 上，而 CSS 变量沿 DOM 继承：变量必须写在热区的父级 stage 上，
         * 写在 imgWrap 上热区收不到。imgWrap 也写一份，兼容其它使用方。 */
        var host = (stage && stage.style) ? stage : imgWrap;
        host.style.setProperty('--nav-h', h + 'px');
        host.style.setProperty('--nav-w', h + 'px');
        var gap = Math.max(8, Math.round(h * 0.18));
        host.style.setProperty('--nav-gap', gap + 'px');
        if (host !== imgWrap) {
          imgWrap.style.setProperty('--nav-h', h + 'px');
          imgWrap.style.setProperty('--nav-w', h + 'px');
          imgWrap.style.setProperty('--nav-gap', gap + 'px');
        }
        /* 热区 = 舞台左右各 1/3，几何全在 CSS 里，JS 只负责箭头尺寸。 */
      }
      /* 换图后立刻 getBoundingClientRect() 会强制同步排版：
       * 改成 rAF 合帧，一帧最多量一次，连点翻页也只算一次。 */
      var navRaf = 0;
      function scheduleNavSize() {
        if (navRaf) return;
        navRaf = requestAnimationFrame(function () {           // 双帧：等布局稳定后再量，单帧会量到未落定的高度
          navRaf = requestAnimationFrame(function () { navRaf = 0; sizeNav(); });
        });
      }
      img.addEventListener('load', scheduleNavSize);
      window.addEventListener('resize', scheduleNavSize);
      /* 图片渲染尺寸会随弹窗 / 图集条 / 滚动条变化，load 之后仍会变；
       * 只靠 load + resize 会量到过期高度，用 ResizeObserver 盯住 img 自身，关弹窗时断开。 */
      var navRO = (typeof ResizeObserver === 'function') ? new ResizeObserver(function () { scheduleNavSize(); }) : null;
      if (navRO) { try { navRO.observe(img); } catch (e) {} }
      /* 首次打开时图片往往还没排版，sizeNav 会走舞台兜底值，之后不会再量第二次。
       * 这里补有限次稳定重测（有界、不常驻），关弹窗时全部清掉。 */
      var navSettleTimers = [80, 240, 600, 1200].map(function (ms) {
        return setTimeout(function () { scheduleNavSize(); }, ms);
      });
      var stage = el('div', { class: 'viewer-stage' }, [imgWrap, prevZone, nextZone]);
      /* 热区 mousedown 阻止默认的文本选择，但不影响随后的 click 导航 */
      stage.addEventListener('mousedown', function (e) { e.preventDefault(); });
      try { img.setAttribute('draggable', 'false'); } catch (e) {}
      var cacheAllBtn = el('button', { class: 'btn', onclick: function () {
        cacheAllBtn.disabled = true; ICONS.apply(cacheAllBtn, '\u23F3 缓存图集 0/' + galleryImages.length);
        var okN = 0, failN = 0, done = 0;
        var chain = Promise.resolve();
        galleryImages.forEach(function (u, i) {
          chain = chain.then(function () {
            done++;
            ICONS.apply(cacheAllBtn, '\u23F3 缓存图集 ' + done + '/' + galleryImages.length);
            if (galleryLocal[u]) { okN++; return null; }            // 已经是本地 blob，不用重复抓
            return ensureGalleryLocal(i).then(function (r) { if (r) okN++; else failN++; });
          });
        });
        chain.then(function () {
          cacheAllBtn.disabled = false; ICONS.apply(cacheAllBtn, ('\u{1F4BE} 缓存全部图集'));
          if (!failN) Toast.ok('图集已全部本地化（' + okN + ' 张）');
          else Toast.warn('已本地化 ' + okN + ' 张，' + failN + ' 张没抓到（多为外链防盗链或未联网；可在「设置 → 联网与抓取」检查抓取方式）', 5200);
        }).catch(function (e) {
          cacheAllBtn.disabled = false; ICONS.apply(cacheAllBtn, ('\u{1F4BE} 缓存全部图集'));
          Toast.err('缓存图集失败：' + (e && e.message ? e.message : e));
        });
      } }, ICONS.label('\u{1F4BE} 缓存全部图集'));
      var delBtn = el('button', { class: 'btn btn-danger-ghost', onclick: function () {
        var u = galleryImages[cur];
        Modal.confirm('从图集里删除这一张？（第 ' + (cur + 1) + ' 张）\n\n只删素材库里的这条记录与本地缓存，不影响 BOOTH 上的原图；删错了可以用「重新获取」再抓回来。', { okText: '删除' }).then(function (ok) {
          if (!ok) return;
          a.images = (a.images || []).filter(function (x) { return x !== u; });
          return App.save(a).then(function (saved) {
            Modal.close(vh);
            Modals.refreshAfterChange(saved, { keepModal: true });   // 详情页原地刷新（不会重新触发自动补全）
            Toast.ok('已从图集删除该图（剩 ' + ((saved.images || []).length) + ' 张）');
          });
        });
      } }, ICONS.label('\u{1F5D1} 删除这张'));
      var vh = Modal.open({
        title: '商品图集预览', size: 'lg',
        onClose: function () {   // 关弹窗时收掉窗口监听、合帧回调、尺寸观察与重测定时器
        window.removeEventListener('resize', scheduleNavSize);
        if (navRaf) { cancelAnimationFrame(navRaf); navRaf = 0; }
        if (navRO) { try { navRO.disconnect(); } catch (e) {} navRO = null; }
        (navSettleTimers || []).forEach(function (t) { try { clearTimeout(t); } catch (e) {} });
        navSettleTimers = [];
      },
        body: stripNode ? [stage, el('div', { class: 'detail-gallery-slot viewer-strip-slot' }, [stripNode])] : [stage],
        footer: [
          counter,
          el('span', { class: 'grow' }),
          delBtn,
          cacheAllBtn,
          el('button', { class: 'btn btn-primary', onclick: function () { setCoverFromURL(galleryImages[cur]); } }, ICONS.label('\u{1F5BC} 设为封面')),
          el('button', { class: 'btn', onclick: function () { Modal.close(vh); } }, '关闭')
        ]
      });
      if (stripNode) attachStripScroll(stripNode);
      show();
    }
    var galleryStripMax = 24;   // 缩略条只画前 24 张，但预览/缓存覆盖全部
    var galleryNode = galleryImages.length
      ? el('div', { class: 'detail-gallery-strip' }, galleryImages.slice(0, galleryStripMax).map(function (u, i) {
          // alt 留空（无 src 时不会渲染出「图片缺失」文字）；加载失败也不隐藏，隐藏会让后面的图左移、像重新排序
          var im = el('img', { alt: '', loading: 'lazy', title: '浏览并设为封面' });   // src 由 applyThumbSrc 一次性设定
          im.onerror = function () { im.classList.add('img-failed'); };
          galleryThumbs.push({ url: u, img: im });
          return el('button', { class: 'gallery-item', onclick: function () { openGalleryViewer(i); } }, [im]);
        }))
      : el('div', { class: 'detail-gallery-strip empty' }, [el('span', { text: '暂无商品图集' })]);

    /* 图集固定一行：滚轮转成横向滚动，两侧虚化提示还有更多，滚到底虚化消失。
     * 这样详情页头部高度由封面决定，不被图集撑高；预览页底部那行复用同一套。 */
    function attachStripScroll(node) {
      function slotEl() { return node.closest ? node.closest('.detail-gallery-slot') : null; }
      function syncEnd() {
        var slot = slotEl();
        if (!slot) return;
        var max = node.scrollWidth - node.clientWidth;
        slot.classList.toggle('no-overflow', max <= 2);
        slot.classList.toggle('at-start', node.scrollLeft <= 2);            // 起点：左侧不虚化
        slot.classList.toggle('at-end', max > 2 && node.scrollLeft >= max - 2);
      }
      node.addEventListener('wheel', function (e) {
        var max = node.scrollWidth - node.clientWidth;
        if (max <= 0) return;                                  // 没溢出就让页面正常滚动
        var d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        var next = Math.max(0, Math.min(max, node.scrollLeft + d));
        if (next !== node.scrollLeft) { e.preventDefault(); node.scrollLeft = next; }
      }, { passive: false });
      node.addEventListener('scroll', syncEnd);
      node.__syncGalleryEnd = syncEnd;
      setTimeout(syncEnd, 80);
      return syncEnd;
    }
    if (galleryImages.length) attachStripScroll(galleryNode);

    /* 图集右上角「重新获取」：重新联网抓商品页图集，整列表换成网页端当前的样子，
     * 用于剔除重复 / 陈旧图。 */
    var refetchGalleryBtn = el('button', {
      // 样式与「隐藏 / 喜欢 / 删除」一致（统一用 .btn），文案为「重新获取图集」
      class: 'btn gallery-refetch', type: 'button',   // 不占用 .btn-parse：那个类名被「版本与下载 → 重新解析」与冒烟夹具锚定
      title: '重新联网获取商品页图集：整列表替换为网页端当前的样子（自动去重），用于剔除重复 / 陈旧图',
      onclick: function () {
        var link = (a.links || []).filter(function (l) { return isHttpUrl(l.url); })[0];
        var url = link ? link.url : (a.itemId ? 'https://booth.pm/ja/items/' + a.itemId : '');
        if (!url) { Toast.warn('这条素材没有商店链接，无法重新获取图集'); return; }
        refetchGalleryBtn.disabled = true; ICONS.apply(refetchGalleryBtn, '\u23F3 获取中 …');
        Fetchers.fetchInfo(url, { forceNetwork: true, noCache: true }).then(function (info) {
          var fresh = (info && !info.__failed && Array.isArray(info.images)) ? info.images.filter(Boolean) : null;
          if (!fresh || !fresh.length) { Toast.warn('没抓到图集（商品页可能取不到，或需要先登录）'); return null; }
          var before = (a.images || []).length;
          a.images = fresh.slice();                    // 整列表替换：以网页端为准（保存时由 Store 去重）
          a.autoFilled = a.autoFilled || {};
          a.autoFilled.images = true;                  // 标记：别让「仅在为空时补图」的自动填充再插旧图回来
          return App.save(a).then(function (saved) {
            Modals.refreshAfterChange(saved, { keepModal: true });
            Toast.ok('图集已重新获取：' + before + ' → ' + ((saved.images || []).length) + ' 张');
          });
        }).catch(function (e) {
          Toast.err('重新获取图集失败：' + (e && e.message ? e.message : e));
        }).then(function () {
          refetchGalleryBtn.disabled = false; ICONS.apply(refetchGalleryBtn, '\u{1F504} 重新获取图集');
        });
      }
    }, ICONS.label('\u{1F504} 重新获取图集'));

    // 打开详情后后台逐个缓存图集，已缓存则跳过；完成后按真实结果提示
    var galleryPrefetch = Promise.resolve(), galleryPreOk = 0, galleryPreFail = 0;
    galleryImages.slice(0, galleryStripMax).forEach(function (u, i) {
      galleryPrefetch = galleryPrefetch.then(function () {
        return ensureGalleryLocal(i).then(function (r) { if (r) galleryPreOk++; else galleryPreFail++; });
      });
    });
    galleryPrefetch.then(function () {
      if (galleryImages.length && !galleryPreFail) Toast.info('商品图集已本地化缓存（' + galleryPreOk + ' 张）', 2000);
      if (galleryImages.length && galleryNode.__syncGalleryEnd) galleryNode.__syncGalleryEnd();   // 懒加载后宽度会变
    }).catch(function () {});

    var descBlock = a.description ? el('div', {}, [
      el('div', { class: 'note-box desc-box' }, [el('span', { text: a.description })]),
      !Smart.hasChinese(a.description) ? el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn btn-sm', onclick: function () {
          Toast.info('AI 翻译简介中 …');
          AI.translateText(a.description, function (m) { console.log('[AI]', m); }).then(function (zh) {
            if (!zh) return;
            a.description = zh;
            App.save(a).then(function () { Modal.closeTop(); Modals.detail(a.id); Toast.ok('简介已汉化'); });
          }).catch(function (e) { Toast.err(e.message || 'AI 翻译失败'); });
        } }, ICONS.label('\u{1F916} AI 翻译简介'))
      ]) : null
    ]) : null;

    var shopPriceDetail = (a.shopPriceValue != null && isFinite(Number(a.shopPriceValue)))
      ? App.codePriceText(a.shopPriceValue, a.shopPriceCurrency) : (a.shopPrice || '');
    var meta = el('div', { class: 'kv-list' }, [
      !isAvatar ? kv('支持角色', avatarChips || '未指定')
                : kv('角色名', [a.charNameZh, a.charNameJa, a.charNameEn].filter(Boolean).join(' / ') || ''),
      // 价格看变体，不再单列商品价
      kv('商店链接', linksNode || '无'),
      kv('作者 / 店铺', shopKV),
      kv('素材编号', el('span', { class: 'mono', title: '好友导出/导入时按它判定是不是同一份素材' }, App.fileIdOf(a) || '—')),
      kv('商品 ID', idKV),
      kv('网盘', cloudKV),
      kv('原始标签', (a.rawTags || []).length ? (a.rawTags || []).join(' / ') : ''),
      kv('上架日期', a.publishedAt ? fmtDate(a.publishedAt) : ''),
      kv('商品更新日期', a.shopUpdatedAt ? fmtDate(a.shopUpdatedAt) : ''),
      kv('本地添加', fmtDate(a.createdAt, true)),
      kv('本地修改', fmtDate(a.updatedAt, true))
    ]);

    /* 标题可就地改：点一下变输入框，回车 / 失焦保存，Esc 取消。
     * 存的是「素材名字」（a.title）；商店原标题（a.originalTitle）永远不动。
     * 改名会连带重命名素材目录（App.save 里做），重名会被拒绝并提示。 */
    var titleNode = el('h3', { class: 'detail-title detail-title-edit', title: '点击修改素材名字', text: title });
    titleNode.addEventListener('click', function () { startTitleEdit(); });
    function startTitleEdit() {
      if (titleNode.querySelector('input')) return;
      var before = String(a.title || '');
      var input = el('input', { class: 'input detail-title-input', value: before, placeholder: '素材名字' });
      titleNode.textContent = '';
      titleNode.appendChild(input);
      try { input.focus(); input.select(); } catch (e) {}
      var done = false;
      function restore(text) {
        titleNode.textContent = cleanTitle(text) || '（未命名）';
        try { titleNode.title = '点击修改素材名字'; } catch (e) {}
      }
      function finish(save) {
        if (done) return;
        done = true;
        var v = String(input.value || '').replace(/\s+/g, ' ').trim();
        if (!save || !v || v === before) { restore(a.title || before); return; }
        titleNode.textContent = v;
        /* 必须传一份「副本」给 App.save：它靠 old.folderName 与新的比对来决定是否改目录、
         * 查不查重名。直接改 a 再存时新旧是同一个对象，比对永远相等 —— 目录不会改名，
         * 重名也拦不住。 */
        var draft = Object.assign({}, a, { title: v });
        App.save(draft).then(function (saved) {
          Toast.ok('已改名为「' + (saved.title || v) + '」', 3200);
          Modals.refreshAfterChange(saved, { keepModal: true });   // 卡片 + 详情（路径可能跟着目录改名变）
        }).catch(function (e) {
          a.title = before;
          restore(before);
          Toast.err('改名失败：' + ((e && e.message) || e), 6400);
        });
      }
      input.addEventListener('keydown', function (e) {
        e.stopPropagation();                       // Esc 不要冒泡去关弹窗
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', function () { finish(true); });
    }

    var head = el('div', { class: 'detail-head' }, [
      el('div', { class: 'detail-head-cover' }, [cover]),
      el('div', { class: 'detail-head-info' }, [
        titleNode,
        orig ? el('div', { class: 'detail-subtitle', title: a.originalTitle }, orig) : null,
        chips,
        el('div', { class: 'detail-gallery-slot' }, [galleryNode]),
        el('div', { class: 'detail-tools' }, [
          hideBtn, favBtn,
          el('span', { class: 'tool-sep' }),
          refetchGalleryBtn,
          el('span', { class: 'grow' }),
          deleteBtn
        ]),
        el('div', { class: 'detail-actions' }, [
          el('div', { class: 'detail-actions-cell' }, [primaryBtn, hint]),
          el('div', { class: 'detail-actions-cell' }, [editBtn])
        ])
      ])
    ]);

    /* 从商品链接补充信息：粘贴商品页 / 只填商品 ID → 补全链接 → 解析 → 预览 → 应用 */
    function linkEnrichBlock() {
      var input = el('input', {
        class: 'input', type: 'text',
        placeholder: '粘贴商品链接，或只填 BOOTH 商品 ID（如 8562330）'
      });
      var tip = el('div', { class: 'wb-hint', text: '只填数字商品 ID 也行，点「解析并补充」会自动补成完整商品页再解析。' });
      var btn = el('button', {
        class: 'btn btn-sm', type: 'button', text: '解析并补充',
        onclick: function () {
          var raw = String(input.value || '').trim();
          var cands = (typeof Fetchers.productCandidates === 'function') ? Fetchers.productCandidates(raw) : [];
          if (!cands.length) { tip.textContent = '填商品 ID（纯数字）或完整的 http(s) 商品链接'; return; }
          /* 自己拼出来的候选要更严：BOOTH 的 404 页也是 HTTP 200，只能靠标题判断 */
          var strict = !/^https?:\/\//i.test(raw);
          function usable(info) {
            if (!info || info.__failed) return false;
            if (!strict) return true;
            return !!info.originalTitle
              && !/(^|\s)(404|not found|page not found|不存在)(\s|$)/i.test(info.originalTitle)
              && info.originalTitle.toLowerCase() !== 'gumroad';
          }
          /* 后端的 reason 是内部代号（host-failed / host-offline），别直接丢给用户看 */
          function reasonText(r) {
            if (!r) return '链接无效或需要登录';
            if (r === 'host-failed') return '页面打不开，可能已下架或被删除';
            if (r === 'host-offline') return '程序后端没就绪，重启程序再试';
            if (r === 'timeout') return '请求超时';
            return r;
          }
          btn.disabled = true; btn.textContent = '解析中…'; tip.textContent = '';
          function next(i) {
            if (i >= cands.length) {
              btn.disabled = false; btn.textContent = '解析并补充';
              tip.textContent = '抓不到这个商品：编号可能写错、已下架，或需要登录后才能看。';
              return;
            }
            var url = cands[i];
            /* 带超时：编号写错时后端可能一直不返回，不能让按钮停在「解析中…」 */
            Fetchers.fetchInfoTimed(url, { forceNetwork: true, noCache: true }, 10000).then(function (info) {
              if (info && info.__failed && info.reason === 'timeout') {
                btn.disabled = false; btn.textContent = '解析并补充';
                tip.textContent = '请求超时了（10 秒没有响应），检查一下网络后重试。';
                return;
              }
              if (!usable(info) && i + 1 < cands.length) return next(i + 1);
              btn.disabled = false; btn.textContent = '解析并补充';
              if (!usable(info)) {
                tip.textContent = strict
                  ? '抓不到这个商品：编号可能写错、已下架，或需要登录后才能看。'
                  : '抓不到这个页面：' + reasonText(info && info.reason);
                return;
              }
              /* 只填了 ID 时把补全后的链接回填到输入框，用户能看清解析的是哪一页 */
              if (url !== raw) { input.value = url; tip.textContent = '已补全为 ' + url; }
              previewApply(info, url);
            }, function (e) {
              if (i + 1 < cands.length) return next(i + 1);
              btn.disabled = false; btn.textContent = '解析并补充';
              tip.textContent = '解析失败：' + ((e && e.message) || e);
            });
          }
          next(0);
        }
      });
      return section('从商品链接补充信息', el('div', { class: 'detail-stack' }, [
        el('div', { class: 'detail-enrich' }, [input, btn]),
        tip
      ]));
    }

    /** 链接比对用的键：去掉 query / hash / 末尾斜杠后再比。
     *  **别用 `normU`** —— 那个只在详情页「同商品检测」的局部作用域里定义过，
     *  在这里是未定义标识符；而且 `Array.prototype.some` 的会调它，只要素材已有一条链接就抛
     *  ReferenceError（旧版「应用」后既不提示也不刷新就是这个原因）。 */
    function urlKey(u) {
      return String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
    }

    /** 「解析并补充」的计划：**预览列什么、应用就写什么**，两边共用这一份 ——
     *  规则：只补空白字段（已有值不动）；标签 / 图集只增不减；
     *  商品价只在完全没有商品价时写，而且**永远不写 0**（0 会被当成「免费」，见 Store.deriveAssetIsFree）。 */
    function enrichPlan(info, url) {
      var plan = [];
      var S = (typeof Smart !== 'undefined') ? Smart : null;
      function add(label, cur, next, apply) {
        if (cur != null && String(cur).trim() !== '') return;
        if (next == null || String(next).trim() === '') return;
        plan.push({ label: label, cur: String(cur || ''), next: String(next), apply: apply });
      }
      function short(t, n) {
        var s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
        return s.length > n ? s.slice(0, n) + '…' : s;
      }

      var nextTitle = info.originalTitle || info.title || '';
      /* 原标题与自定义标题分开算：作者改了名，原标题照样该补上（旧版就是这个语义，别合在一起）。 */
      add('原标题', a.originalTitle, nextTitle, function () { if (!a.originalTitle) a.originalTitle = nextTitle; });
      if (!a.title || /^未命名/.test(a.title)) {
        add('标题', a.title, nextTitle ? ((cleanTitle && cleanTitle(nextTitle)) || nextTitle) : '', function () {
          a.title = (cleanTitle && cleanTitle(nextTitle)) || nextTitle;
        });
      }
      add('店铺', a.shop, info.shop, function () { a.shop = info.shop; });
      add('作者', a.author, info.author, function () { a.author = info.author; });
      add('商品 ID', a.itemId, info.itemId, function () { a.itemId = String(info.itemId); });
      add('店铺链接', a.shopUrl, info.shopUrl, function () { a.shopUrl = info.shopUrl; });

      /* 标签：翻译 + 去角色名 + 去黑名单后，算出「真正会新增几个」再列出来，
       * 免得预览说新增 12 个、应用后一个都没多（全被角色名过滤掉了）。 */
      var rawNew = (info.tags || []).map(function (t) { return String(t || '').trim(); }).filter(Boolean)
        .filter(function (t) { return (a.rawTags || []).map(String).indexOf(t) < 0; });
      if (rawNew.length) {
        var shownAll = [];
        try {
          var rawAll = uniq((a.rawTags || []).concat(info.tags || []).map(function (t) { return String(t || '').trim(); }).filter(Boolean));
          var tr = (App.settings.autoTranslateTags !== false && S && S.translateTags) ? S.translateTags(rawAll) : rawAll.slice();
          if (S && S.purgeAvatarTags) {
            try { tr = S.purgeAvatarTags(tr, { shop: a.shop || info.shop, author: a.author || info.author, url: url }) || tr; } catch (e) {}
          }
          if (S && S.filterBlacklist) tr = S.filterBlacklist(tr);
          shownAll = uniq(tr);
        } catch (e) { shownAll = []; }
        var shownNew = shownAll.filter(function (t) { return (a.tags || []).indexOf(t) < 0; });
        if (shownNew.length) {
          plan.push({
            label: '标签',
            cur: (a.tags || []).length ? '已有 ' + (a.tags || []).length + ' 个' : '',
            next: '新增 ' + shownNew.length + ' 个：' + shownNew.slice(0, 10).join(' / ') + (shownNew.length > 10 ? ' …' : ''),
            apply: function () {
              a.rawTags = uniq((a.rawTags || []).concat(info.tags || []).map(function (t) { return String(t || '').trim(); }).filter(Boolean));
              a.tags = uniq((a.tags || []).concat(shownNew));
            }
          });
        }
      }

      /* 支持角色：按标签识别，只在现在一个都没有时补 */
      if (!(a.avatars || []).length && S && S.detectAvatars) {
        var av = [];
        try { av = (S.detectAvatars(info) || []).slice(); } catch (e) { av = []; }
        add('支持角色', '', av.map(function (v) { return App.avatarLabel(v); }).join('、'), function () { a.avatars = av.slice(); });
      }

      /* 分类：只在当前是「其他」时补，别抢用户分好的类 */
      if (!a.category || a.category === 'other') {
        var guess = '';
        try { guess = (S && S.guessCategory) ? S.guessCategory(info) : ''; } catch (e) { guess = ''; }
        if (guess && guess !== 'other') add('分类', '', App.categoryLabel(guess), function () { a.category = guess; });
      }

      var desc = '';
      if (!a.description && info.description) {
        try { desc = (S && S.pickChinese) ? (S.pickChinese(info.description) || info.description) : info.description; } catch (e) { desc = info.description; }
      }
      add('简介', a.description, desc ? short(desc, 90) : '', function () { a.description = desc; });

      var imgsNew = (info.images || []).filter(function (u) { return u && (a.images || []).indexOf(u) < 0; });
      if (imgsNew.length) {
        plan.push({
          label: '图集',
          cur: (a.images || []).length ? '已有 ' + (a.images || []).length + ' 张' : '',
          next: '新增 ' + imgsNew.length + ' 张',
          apply: function () { a.images = uniq((a.images || []).concat(imgsNew)); }
        });
      }
      if (!a.coverURL && !a.hasCover && info.coverURL) {
        add('封面', '', '1 张外链（保存后会下载到本地）', function () { a.coverURL = info.coverURL; });
      }

      /* 商品价：只写非 0 的数字，0 一律不碰（0 = 免费，会改变整条素材的判定） */
      if (!a.shopPrice && info.price != null) {
        var pnum = Number(String(info.price).replace(/[^\d.]/g, '')) || 0;
        if (pnum > 0) add('商品价', '', short(info.price, 24), function () { a.shopPrice = String(info.price); });
      }
      add('上架日期', a.publishedAt ? fmtDate(a.publishedAt) : '', info.publishedAt ? fmtDate(info.publishedAt) : '',
        function () { a.publishedAt = info.publishedAt; });

      if (!(a.versions || []).length && (info.versions || []).length) {
        plan.push({
          label: '版本',
          cur: '',
          next: (info.versions || []).length + ' 个：' + (info.versions || []).slice(0, 4).map(function (v) { return (v && v.name) || '未命名'; }).join(' / '),
          apply: function () { a.versions = (info.versions || []).slice(); }
        });
      }
      if (!(a.downloadLinks || []).length && (info.downloadLinks || []).length) {
        plan.push({
          label: '下载链接',
          cur: '',
          next: (info.downloadLinks || []).length + ' 条',
          apply: function () { a.downloadLinks = (info.downloadLinks || []).slice(); }
        });
      }
      return plan;
    }

    /** 预览并应用：只列会变的字段，点「应用」才写库 */
    function previewApply(info, url) {
      var plan = enrichPlan(info, url);
      var rows = plan.map(function (p) {
        return kv(p.label, el('span', {}, [
          el('span', { class: 'dim', text: (p.cur || '（空）') + ' → ' }),
          el('b', { text: p.next })
        ]));
      });
      if (!rows.length) rows.push(kv('结果', '没有比现在更新的信息'));
      var modal = Modal.open({
        title: '补充信息预览',
        size: 'md',
        body: [el('div', { class: 'detail-stack' }, [
          /* 把规则写在最上面：用户才知道为什么有些字段没出现在列表里 */
          el('div', { class: 'field-hint', text: plan.length
            ? '将补充 ' + plan.length + ' 项。只填空缺字段，已有的值一律不动；标签与图集会合并，不会清掉你原来补的。'
            : '这条素材的商品信息已经齐了，没有需要补充的字段。' })
        ].concat(rows))],
        footer: [
          el('button', { class: 'btn', onclick: function () { Modal.close(modal); } }, '取消'),
          el('button', { class: 'btn btn-primary', onclick: function () {
            Modal.close(modal);
            applyInfo(info, url, plan);
          } }, '应用')
        ]
      });
    }

    /** 写库：跑计划里的每一项，再补上不显示在预览里的关联动作（存链接、认来源） */
    function applyInfo(info, url, plan) {
      /* 改动前的副本：这里的 a 就是库里那条对象，直接改完再 save，App.save 比不出
       * 「标题 / 商品 ID / 分类变了」，磁盘上的文件夹因此不会改名字、也不会跟着分类搬走
       * （用户看到的就是「分类换了，文件还在老目录，新分类下只多了个封面」）。 */
      var before = null;
      try { before = JSON.parse(JSON.stringify(a)); } catch (e) { before = null; }
      (plan || []).forEach(function (p) { try { p.apply(); } catch (e) { console.warn('补充字段失败：' + p.label, e); } });
      if (/gumroad/i.test(url)) a.source = 'gumroad';
      else if (/booth/i.test(url)) a.source = 'booth';
      else if (info.sourceId && !a.source) a.source = info.sourceId;
      if (!a.links) a.links = [];
      if (!a.links.some(function (l) { return urlKey(l.url) === urlKey(url); })) {
        a.links.push({ url: url, label: info.shop || '商品页' });
      }
      App.save(a, { prev: before || undefined }).then(function (saved) {
        var names = (plan || []).map(function (p) { return p.label; });
        Toast.ok(names.length
          ? '已补充 ' + names.length + ' 项：' + names.slice(0, 5).join('、') + (names.length > 5 ? ' 等' : '')
          : '没有需要补充的字段', 4200);
        /* 原地换掉这一条详情 + 刷新卡片：别用 Modals.detail(a.id) ——
         * 不带 handle 调用会再压一层新弹窗，回来时看到两个详情叠在一起。 */
        try { Modals.refreshAfterChange(saved || a, { keepModal: true }); }
        catch (e) { try { Modals.detail(a.id); } catch (e2) {} }
      }, function (e) { Toast.err('保存失败：' + ((e && e.message) || e)); });
    }

    /* 「版本与下载」分两个切页：链接（远端，保持原样）/ 本地文件（磁盘实况）。
     * 素材以本地文件为主时，这一块原本只剩一两行路径，等于看不到自己手上有哪些文件。
     * 本地页按「本体 / 额外文件（DLC）」分两组：素材以本地为主，分不清哪个是本体等于没法用；
     * 图片一律不列（封面 / 预览图不是素材文件，删一张图也不该报「本体缺失」）。 */
    var localState = { dir: '', files: null, error: '', scanned: false };   // files=null 表示还没扫过
    var localScanP = null;
    var localDrag = '';   // 正在从哪一行拖起：拖到另一组就改判本体 / DLC
    var localPane = el('div', { class: 'detail-stack', style: { display: 'none' } });
    var localLoaded = false;
    var localNum = el('span', { class: 'detail-tab-num', text: '' });
    var linkFileCount = Object.keys(seenUrl).length;
    var linkNum = el('span', { class: 'detail-tab-num', text: String(linkFileCount) });
    var tabLink = el('button', { class: 'detail-tab', type: 'button' }, ['链接', linkNum]);
    var tabLocal = el('button', { class: 'detail-tab', type: 'button' }, ['本地文件', localNum]);
    var linkPane = el('div', { class: 'detail-stack' }, [activeTotalNode, verSectionNode, dlNode, licenseNode, unpurchasedNode, pathNode]);
    /* 本体缺失提示挂在两个切页之上：停在「链接」页也看得见，不能把问题藏起来 */
    var missBox = el('div', { class: 'local-miss-box', style: { display: 'none' } });

    function pickTab(local) {
      tabLink.classList.toggle('on', !local);
      tabLocal.classList.toggle('on', local);
      linkPane.style.display = local ? 'none' : '';
      localPane.style.display = local ? '' : 'none';
      Modals._localTab = !!local;      // 原地刷新（重新解析后重建详情）回到原来那一页
      if (local) loadLocalPane();
    }
    tabLink.addEventListener('click', function () { pickTab(false); });
    tabLocal.addEventListener('click', function () { pickTab(true); });

    /* ---------------- 本地文件：扫描 / 对账 ---------------- */

    /** 只读顶层文件（App.localScanFiles）。结果写进 localState，失败也写（error），
     *  调用方据此决定要不要落库 —— 读不到目录时绝不能把「文件都没了」当成事实写进去。 */
    function scanLocalDir() {
      localState.dir = App.primaryLocalPath(a);
      return App.localScanFiles(a).then(function (r) {
        localState.dir = r.dir || localState.dir;
        localState.files = r.error ? null : (r.files || []);
        localState.error = r.error ? ({
          'no-path': '这条素材还没有本地路径',
          'offline': '程序后端未就绪，暂时读不到本地文件',
          'missing-dir': '目录不存在（可能被移动或删除了）'
        }[r.error] || ('读取失败：' + r.error)) : '';
        localState.scanned = true;
        return localState;
      });
    }

    /**
     * 一次对账：扫磁盘 → App.localFileApply（缺的删、多的登记成 DLC）→ 需要时落库 → 重画。
     * opts.force=true 无视缓存重扫；opts.save=false 只改界面不落库（打开详情时用）。
     * 读不到目录（后端离线 / 盘符不在）时一律不落库，避免把一次失败的扫描当成「文件都没了」。
     */
    function rescanLocal(opts) {
      opts = opts || {};
      var p = opts.force ? scanLocalDir()
        : (localState.scanned ? Promise.resolve(localState) : (localScanP || (localScanP = scanLocalDir())));
      return p.then(function (st) {
        var fail = function () {
          localNum.textContent = st.dir ? '\u2014' : '0';
          renderMissing([]);
          if (localLoaded) renderLocal(null);
          return { ok: false, error: st.error || (st.dir ? '读不到目录' : '这条素材还没有本地路径'),
            added: 0, removed: 0, missing: [], baseN: 0, extraN: 0, changed: false };
        };
        if (st.error || !st.files) return fail();
        var plan = App.localFileApply(a, st.files);
        var after = function () {
          localNum.textContent = String(plan.base.length + plan.extra.length);
          renderMissing(plan.missing);
          if (localLoaded) renderLocal(plan);
          return { ok: true, error: '', added: plan.added, removed: plan.removed, missing: plan.missing,
            baseN: plan.base.length, extraN: plan.extra.length, changed: plan.changed };
        };
        if (!plan.changed || opts.save === false) return after();
        return App.save(a).then(after, after);
      });
    }

    /* ---------------- 本体文件缺失：列出 + 快速补充 ---------------- */

    function renderMissing(missing) {
      missBox.innerHTML = '';
      missing = (missing || []).filter(function (m) { return m && m.name; });
      if (!missing.length) { missBox.style.display = 'none'; return; }
      missBox.style.display = '';
      missBox.appendChild(el('div', { class: 'local-miss-title' }, [
        ICONS.make('warning', { size: 14 }),
        el('span', { text: '本体文件缺失 ' + missing.length + ' 个：磁盘上找不到，可能被移动或删除了' })
      ]));
      missBox.appendChild(el('div', { class: 'local-miss-list' }, missing.map(function (m) {
        return el('div', { class: 'local-miss-row' }, [
          el('span', { class: 'local-miss-ver', title: m.version ? String(m.version.name || '') : '',
            text: (m.version && m.version.name) || '本体' }),
          el('code', { class: 'local-miss-name', title: m.name, text: m.name }),
          el('button', {
            class: 'btn btn-xs local-miss-del', type: 'button',
            title: '不再记录这个文件（只改库里的记录，磁盘上的文件不会被动）',
            onclick: function () { removeMissing([m]); }
          }, '移除记录')
        ]);
      })));
      missBox.appendChild(el('div', { class: 'local-miss-actions' }, [
        el('button', { class: 'btn btn-xs btn-primary', onclick: function () { openBaseFill(missing); } },
          ICONS.label('\u{1F4C2} 快速补充本体文件')),
        missing.length > 1
          ? el('button', { class: 'btn btn-xs', type: 'button', onclick: function () { removeMissing(missing); } }, '全部移除记录')
          : null,
        el('span', { class: 'local-miss-hint', text: '选一个文件即可：会放进素材目录并记回对应版本，不用重新导入整条素材。' })
      ]));
    }

    /** 把文件名从版本 / 下载记录 / 额外文件里全部摘掉。
     *  只改库里的记录，一个字节都不碰磁盘 —— 这些文件本来就找不到了。
     *  本地导入的版本本身就是一个文件，记录摘空后版本也跟着收掉（否则留下一个空版本）。 */
    function stripFileRecord(names) {
      var low = Object.create(null);
      (names || []).forEach(function (n) {
        var s = String(n || '').trim().toLowerCase();
        if (s) low[s] = 1;
      });
      if (!Object.keys(low).length) return false;
      var droppedLatest = false;
      (a.versions || []).forEach(function (v) {
        if (!v) return;
        if (v.fileName && low[String(v.fileName).toLowerCase()]) v.fileName = '';
        if (Array.isArray(v.files)) {
          v.files = v.files.filter(function (f) { return !low[String((f && f.name) || '').toLowerCase()]; });
        }
      });
      a.versions = (a.versions || []).filter(function (v) {
        var empty = !!(v && v.local && !v.fileName && !((v.files || []).length));
        if (empty && v.isLatest) droppedLatest = true;
        return !empty;
      });
      if (droppedLatest) {
        /* 收掉的那个是「最新版本」，就把剩下的最后一个本地版本顶上去，别让版本区一个都不标最新 */
        var next = (a.versions || []).filter(function (v) { return v && v.local; })[0];
        if (next) next.isLatest = true;
      }
      a.downloadedFiles = (a.downloadedFiles || []).filter(function (n) { return !low[String(n || '').toLowerCase()]; });
      a.extraFiles = (a.extraFiles || []).filter(function (e) { return !low[String((e && e.name) || '').toLowerCase()]; });
      return true;
    }

    /** 手动移除缺失记录：先确认再改库。文件本来就不在了，这只影响「还提不提示」。 */
    function removeMissing(list) {
      list = (list || []).filter(function (m) { return m && m.name; });
      if (!list.length) return;
      var names = list.map(function (m) { return String(m.name); });
      var one = list.length === 1;
      var what = one
        ? '「' + names[0] + '」' + (list[0].version && list[0].version.name ? '（' + list[0].version.name + '）' : '')
        : names.length + ' 个文件';
      Modal.confirm('不再记录 ' + what + '？\n\n'
        + (one ? '这个文件在库里登记过，但磁盘上已经找不到。移除记录后不再提示缺失，版本里也不再登记它。'
          : '这些文件在库里登记过，但磁盘上已经找不到。移除记录后不再提示缺失，版本里也不再登记它们。')
        + '\n\n只改库里的记录，不会删除任何文件。'
        + (one ? '如果文件只是被挪走了，用「快速补充本体文件」把它指回来更好。'
          : '如果文件只是被挪走了，用「快速补充本体文件」把它们指回来更好。'),
        { okText: '移除记录' }).then(function (ok) {
        if (!ok) return;
        if (!stripFileRecord(names)) return;
        App.save(a).then(function () {
          Modals.refreshAfterChange(a, { keepModal: true });   // 原地重建详情：版本区 / 缺失提示一起刷新
          Toast.ok('已移除 ' + names.length + ' 条缺失记录', 4200);
        }).catch(function (e) { Toast.err('移除失败：' + ((e && e.message) || e)); });
      });
    }

    /** 快速补充：列出每个缺失的本体，逐个「选择文件」；只有一个缺失时直接弹选文件。 */
    function openBaseFill(missing) {
      if (missing.length === 1) { pickAndBind(missing[0], null); return; }
      var rows = missing.map(function (m) {
        var btn = el('button', { class: 'btn btn-xs' }, ICONS.label('选择文件 …'));
        btn.onclick = function () { pickAndBind(m, btn); };
        return el('div', { class: 'local-fill-row' }, [
          el('div', { class: 'local-fill-info' }, [
            el('b', { text: (m.version && m.version.name) || '本体' }),
            el('code', { class: 'path', title: m.name, text: m.name })
          ]),
          btn
        ]);
      });
      var h = Modal.open({
        title: '补充本体文件（' + missing.length + ' 个）', size: 'md',
        body: [el('div', { class: 'detail-stack' }, [
          el('div', { class: 'field-hint', text: '选中的文件会复制进这条素材的目录（源文件保留），并登记为该版本的本体文件。' })
        ].concat(rows))],
        footer: [el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '关闭')]
      });
    }

    function pickAndBind(m, btn) {
      var PICK = '\u{1F4C2} 选择文件 …';
      if (btn) { btn.disabled = true; ICONS.apply(btn, '\u23F3 选择中 …'); }
      FS.hostEnsure().then(function (ok) {
        if (!ok) throw new Error('程序后端未就绪，无法选择文件');
        return FS.host.pickFiles();
      }).then(function (r) {
        var list = Array.isArray(r) ? r : ((r && r.paths) || []);
        if (!list.length) { if (btn) { btn.disabled = false; ICONS.apply(btn, PICK); } return null; }
        return bindBaseFile(m, list[0]);
      }).then(function (done) {
        if (!done) return;
        if (btn) { btn.disabled = false; ICONS.apply(btn, PICK); }
        Toast.ok('已补回本体文件：' + done);
        try { UI.renderAll(); } catch (e) {}
        return rescanLocal({ force: true });
      }).catch(function (e) {
        if (btn) { btn.disabled = false; ICONS.apply(btn, PICK); }
        Toast.err('补回失败：' + ((e && e.message) || e), 7000);
      });
    }

    /** 把选中的文件放进素材目录并登记成该版本的本体；目录里已有同名文件就直接复用，不重复复制 */
    function bindBaseFile(m, srcPath) {
      var dir = localState.dir || App.primaryLocalPath(a);
      if (!dir) return Promise.reject(new Error('这条素材还没有存储目录'));
      var name = String(srcPath || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      if (!name) return Promise.reject(new Error('读不到文件名'));
      var size = 0;
      return FS.host.stat(srcPath).then(function (st) { size = Number(st && st.size) || 0; })
        .then(function () { return FS.host.exists(joinWinPath(dir, [name])); })
        .then(function (kind) {
          if (kind === 'file') return null;
          return FS.host.copy(srcPath, joinWinPath(dir, [name]));
        })
        .then(function () {
          var v = m.version;
          var oldName = v ? String(v.fileName || '') : '';
          if (v) {
            v.fileName = name;
            if (size) v.size = size;
          }
          /* 旧名字（缺的那个）从下载记录里摘掉，否则下一次扫描还会报同一个缺失 */
          var df = (a.downloadedFiles || []).filter(function (x) {
            return String(x).toLowerCase() !== oldName.toLowerCase();
          });
          if (df.every(function (x) { return String(x).toLowerCase() !== name.toLowerCase(); })) df.push(name);
          a.downloadedFiles = df;
          a.downloaded = true;
          a.downloadedAt = nowISO();
          if (size) a.fileSize = (Number(a.fileSize) || 0) + size;
          return App.save(a).then(function () { return name; });
        });
    }

    /**
     * 把某个文件在本体 / DLC 之间改判（把行拖到另一组时调用）。
     * 归本体 = 从 extraFiles 摘掉 + 记进 downloadedFiles（判据③）；归 DLC = 记进 extraFiles（优先级最高）。
     * 不删 downloadedFiles：那是「这个文件下载过」的事实，删了下载按钮会变回「下载」，
     * 而分类只看 extraFiles，留着不会让分类回弹。
     */
    function reclassifyLocal(name, toBase) {
      var nm = String(name || '').trim();
      if (!nm) return Promise.resolve();
      var low = nm.toLowerCase();
      if (toBase) {
        a.extraFiles = (a.extraFiles || []).filter(function (e) {
          return String((e && e.name) || '').toLowerCase() !== low;
        });
        var df = (a.downloadedFiles || []).slice();
        if (!df.some(function (x) { return String(x || '').toLowerCase() === low; })) df.push(nm);
        a.downloadedFiles = df;
      } else {
        var ex = (a.extraFiles || []).slice();
        if (!ex.some(function (e) { return String((e && e.name) || '').toLowerCase() === low; })) {
          var hit = (localState.files || []).filter(function (f) { return String(f.name).toLowerCase() === low; })[0];
          ex.push({ name: nm, size: (hit && hit.size) || 0, addedAt: nowISO(), note: '手动归为 DLC' });
        }
        a.extraFiles = ex;
      }
      return App.save(a).then(function () {
        return rescanLocal({ force: true, save: false });   // 已经保存过，这里只重画
      }).then(function () {
        Toast.ok((toBase ? '已归为本体：' : '已归为 DLC：') + nm, 3000);
      }, function (e) {
        Toast.err('改判失败：' + ((e && e.message) || e), 6000);
      });
    }

    /**
     * 删掉一个「错误添加」的本地文件（拖错了 / 把 DLC 当成本体了 / 下错了版本）。
     * 两道闸：先确认，再移进系统回收站；回收站不可用时再问一次才永久删除。
     * 删完把它从版本 / 下载记录 / 额外文件里一起摘掉（否则下次扫描会报「本体缺失」），
     * 然后原地重建详情。**只碰这一个文件**，素材记录、目录里其它文件都不动。
     */
    function deleteLocalFile(name, size, full, isBase) {
      var nm = String(name || '');
      if (!nm || !full) return;
      var sizeTxt = size ? '（' + fmtSize(size) + '）' : '';
      var tail = isBase
        ? '\n\n删掉本体后，如果这条素材还有商品链接，可以在「链接」页重新下载。'
        : '';
      var via = '';
      Modal.confirm('从素材目录里删除「' + nm + '」' + sizeTxt + '？\n\n位置：' + full + '\n\n'
        + '会移进 Windows 回收站（可以还原），并把这条文件从「本体 / DLC」记录里去掉；'
        + '素材本身、以及目录里的其它文件都不动。' + tail,
        { okText: '删除文件', title: '删除本地文件' }).then(function (ok) {
        if (!ok) return null;
        /* 回收站通道不存在（网页载体）或系统不让用 → 再问一次，绝不默默永久删 */
        var trashP = (FS.host && typeof FS.host.trash === 'function')
          ? FS.host.trash(full)
          : Promise.reject(new Error('当前载体没有回收站'));
        return trashP.then(function () { via = 'trash'; return true; }, function (e) {
          var msg = (e && e.message) || String(e);
          return Modal.confirm('没能移进回收站：' + msg + '\n\n要直接永久删除吗？这一步不能撤回。',
            { okText: '永久删除', title: '回收站不可用' }).then(function (yes) {
            if (!yes) return Promise.reject({ cancelled: true });
            return FS.host.remove(full).then(function () { via = 'delete'; return true; });
          });
        });
      }).then(function (done) {
        if (!done) return;
        stripFileRecord([nm]);
        /* 素材体积是累加的：删掉一个就减掉它，否则卡片上的占用会一直虚高 */
        var had = Number(a.fileSize) || 0;
        if (size && had >= size) a.fileSize = had - size;
        return App.save(a).then(function () {
          try { Modals.refreshAfterChange(a, { keepModal: true }); } catch (e) { try { UI.renderAll(); } catch (e2) {} }
          Toast.ok((via === 'trash' ? '已移进回收站：' : '已永久删除：') + nm, 4600);
        }, function (e) {
          Toast.warn('文件已删除，但记录没更新成功：' + ((e && e.message) || e) + '（点「重新扫描」再试一次）', 7600);
        });
      }).catch(function (e) {
        if (e && e.cancelled) return;
        Toast.err('删除失败：' + ((e && e.message) || e), 7000);
      });
    }

    /* ---------------- 本地文件：渲染 ---------------- */
    /** plan 由 App.localFileApply 算出；null = 读不到目录，只显示失败原因 */
    function renderLocal(plan) {
      localPane.innerHTML = '';
      var dir = localState.dir;
      if (!dir) {
        localNum.textContent = '0';
        localPane.appendChild(el('div', { class: 'multi-empty', text: '这条素材还没有本地路径。用编辑页的「导入已有文件 / 文件夹」补一份，或把文件拖到卡片上。' }));
        return;
      }
      if (localState.error || !localState.files) {
        localNum.textContent = '\u2014';
        localPane.appendChild(el('div', { class: 'field-hint', text: '读取失败：' + (localState.error || '后端未就绪') }));
        return;
      }
      if (!plan) plan = App.localFileApply(a, localState.files);
      localNum.textContent = String(plan.base.length + plan.extra.length);

      /* 顶部：目录 + 重新扫描（只对账，不联网） */
      var scanBtn = el('button', { class: 'btn btn-xs', title: '重新读一遍这个目录：删掉已经不存在的记录，多出来的文件补进额外 DLC' },
        ICONS.label('\u21BB 重新扫描'));
      scanBtn.onclick = function () {
        if (scanBtn.disabled) return;
        scanBtn.disabled = true; ICONS.apply(scanBtn, '\u23F3 扫描中 …');
        rescanLocal({ force: true }).then(function (r) {
          scanBtn.disabled = false; ICONS.apply(scanBtn, '\u21BB 重新扫描');
          if (!r.ok) { Toast.warn('读不到本地目录：' + r.error, 6200); return; }
          Toast.ok('已按磁盘更新：本体 ' + r.baseN + ' 个、DLC ' + r.extraN + ' 个'
            + (r.added ? '；新增 ' + r.added : '') + (r.removed ? '；移除 ' + r.removed : ''), 4600);
        });
      };
      localPane.appendChild(el('div', { class: 'local-head' }, [
        el('code', { class: 'path local-dir', title: dir, text: dir }),
        scanBtn,
        el('button', { class: 'btn btn-xs', onclick: function () { FS.openPath(dir); } }, ICONS.label('\u{1F4C2} 打开文件夹'))
      ]));

      function row(name, size, verName, kind) {
        var full = joinWinPath(dir, [name]);
        var node = el('div', { class: 'link-row local-file-row', draggable: 'true',
          title: '拖动到另一个分组，可改判「本体 / DLC」' }, [
          el('code', { class: 'path local-name', title: name, text: name }),
          verName ? el('span', { class: 'local-ver', title: '版本：' + verName, text: verName }) : null,
          el('span', { class: 'local-size', text: size ? fmtSize(size) : '' }),
          el('button', { class: 'btn btn-xs local-open', title: '在文件夹中显示：' + full,
            onclick: function () { FS.openPath(full); } }, ICONS.label('显示')),
          /* 删错文件（拖错了、把 DLC 当成本体了）的出口：只删这一个文件，跟着把记录摘掉 */
          el('button', {
            class: 'btn btn-xs btn-danger-ghost local-del', type: 'button',
            title: '把这个文件移进回收站，并从「本体 / DLC」记录里去掉',
            onclick: function (e) {
              if (e && e.stopPropagation) e.stopPropagation();
              deleteLocalFile(name, size, full, kind === 'base');
            }
          }, ICONS.label('\u{1F5D1} 删除'))
        ]);
        node.addEventListener('dragstart', function (e) {
          localDrag = name;
          node.classList.add('drag-src');
          try { e.dataTransfer.setData('text/plain', name); e.dataTransfer.effectAllowed = 'move'; } catch (x) {}
        });
        node.addEventListener('dragend', function () {
          localDrag = '';
          node.classList.remove('drag-src');
          Array.prototype.forEach.call(localPane.querySelectorAll('.drop-ok'), function (n) { n.classList.remove('drop-ok'); });
        });
        return node;
      }

      /** 一个分组 = 标题 + 列表；整块都是放置区（拖到另一组 = 改判本体 / DLC） */
      function groupBox(kind, title, hint, rows, emptyText) {
        var box = el('div', { class: 'local-group-box', dataset: { kind: kind } });
        box.appendChild(el('div', { class: 'local-group' + (kind === 'extra' ? ' local-group-sep' : '') }, [
          el('span', { class: 'local-group-name', text: title }),
          el('span', { class: 'local-group-num', text: String(rows.length) }),
          el('span', { class: 'grow' }),
          el('span', { class: 'local-group-hint', text: hint })
        ]));
        if (!rows.length) box.appendChild(el('div', { class: 'field-hint', text: emptyText }));
        else box.appendChild(el('div', { class: 'link-list' }, rows));
        function kindOf(nm) {
          var low = String(nm || '').toLowerCase();
          if (plan.base.some(function (f) { return f.name.toLowerCase() === low; })) return 'base';
          if (plan.extra.some(function (f) { return f.name.toLowerCase() === low; })) return 'extra';
          return '';
        }
        function okHere() {
          var from = kindOf(localDrag);
          return !!from && from !== kind;
        }
        box.addEventListener('dragover', function (e) {
          if (!okHere()) return;
          e.preventDefault();
          e.stopPropagation();
          try { e.dataTransfer.dropEffect = 'move'; } catch (x) {}
          box.classList.add('drop-ok');
        });
        box.addEventListener('dragleave', function (e) {
          if (e.relatedTarget && box.contains(e.relatedTarget)) return;
          box.classList.remove('drop-ok');
        });
        box.addEventListener('drop', function (e) {
          if (!okHere()) return;
          e.preventDefault();
          e.stopPropagation();
          box.classList.remove('drop-ok');
          var nm = localDrag || (e.dataTransfer ? e.dataTransfer.getData('text/plain') : '');
          localDrag = '';
          if (nm) reclassifyLocal(nm, kind === 'base');
        });
        return box;
      }

      /* 本体：版本里登记过、磁盘上确实存在的那个主文件 */
      localPane.appendChild(groupBox('base', '本体文件', '版本里登记的主文件',
        plan.base.map(function (f) { return row(f.name, f.size, f.version ? String(f.version.name || '') : '', 'base'); }),
        '没有识别到本体文件：版本里还没登记过下载 / 导入的文件，或它们已被删掉。'));

      /* 额外文件：磁盘上多出来、不属于本体的那些（DLC / 补丁 / 说明书） */
      localPane.appendChild(groupBox('extra', '额外文件 · DLC', 'DLC / 补丁 / 说明书，图片不计',
        plan.extra.map(function (f) { return row(f.name, f.size, '', 'extra'); }),
        '没有额外文件。把 DLC 拖到卡片上选「作为附加文件」就会出现在这里。'));

      var total = plan.base.concat(plan.extra).reduce(function (s, f) { return s + (f.size || 0); }, 0);
      localPane.appendChild(el('div', { class: 'field-hint', text: '共 ' + (plan.base.length + plan.extra.length)
        + ' 个文件，合计 ' + fmtSize(total) + '；图片不统计。把这行文件拖到另一组，即可改判本体 / DLC；'
        + '行尾「删除」把错放的文件移进回收站。' }));
    }

    function loadLocalPane(force) {
      if (localLoaded && !force) return;
      localLoaded = true;
      if (!localState.scanned) {
        localPane.innerHTML = '';
        localPane.appendChild(el('div', { class: 'field-hint', text: '正在读取 ' + (App.primaryLocalPath(a) || '素材目录') + ' …' }));
      }
      /* 只画界面、不落库：打开详情不该悄悄改记录。要落库走「重新扫描」或「重新解析」。 */
      rescanLocal({ save: false });
    }

    var versionsPane = el('div', { class: 'detail-stack' }, [
      el('div', { class: 'detail-tabs' }, [tabLink, tabLocal]),
      missBox, linkPane, localPane
    ]);
    /* 默认页：原地刷新（opts.keepTab）回到上次那一页；一条链接都没有、但有本地路径 → 直接停在「本地文件」 */
    if (opts.keepTab ? !!Modals._localTab : (!linkFileCount && (a.paths || []).length)) pickTab(true);
    else tabLink.classList.add('on');
    /* 打开就先静默对一次账：本体文件被删了要在「打开的时候」就提示出来。
     * 只改界面不落库（落库留给显式的「重新扫描 / 重新解析」），避免扫错一次就被当成事实写进库。 */
    if (App.primaryLocalPath(a)) rescanLocal({ save: false });

    var content = el('div', { class: 'detail-content-wrap' }, [
      el('div', { class: 'detail-content-head' }, [ICONS.make('box', { size: 15 }), el('span', { text: '详细信息' })]),
      linkEnrichBlock(),
      el('div', { class: 'detail-content' }, [
        // 左栏：标签 + 商品信息 + 商品描述（平衡两栏内容量）
        el('div', { class: 'detail-col' }, [
          section('标签', tagChips),
          section('商品信息', meta),
          section('商品简介', descBlock)
        ]),
        // 右栏：版本与下载 + 图集 + 备注
        el('div', { class: 'detail-col' }, [
          section('版本与下载', versionsPane, fetchOrderBtn),
          section('备注', a.note ? el('div', { class: 'note-box' }, [el('span', { text: a.note })]) : null)
        ])
      ])
    ]);

    var body = el('div', { class: 'detail detail-v2' }, [head, content]);

    // BOOTH / Gumroad 源缺少有效变体时打开详情自动获取一次（免费素材不需要购买变体，直接跳过；成功刷新并锁定，失败保持原样）
    var epAuto = App.effectivePrice(a);
    // BOOTH「未购买」素材的商品价按模型就是 0（= 没有任何已购变体），不能因此当免费而跳过补全，
    // 否则变体 / 价格永远补不上。
    var unpurchasedAsset = App.purchaseState(a) === 'unpurchased';
    var freeAsset = !unpurchasedAsset && (a.isFree === true || !!(epAuto && epAuto.value === 0));
    var needsVariantAuto = !freeAsset && !a.delisted && !Importer.autoEnrichBusy() &&
      (a.source === 'booth' || a.source === 'gumroad') &&
      !(a.autoFilled && a.autoFilled.versions) &&
      !(a.versions || []).some(function (v) { return v.orderUrl && v.orderUrl.trim() && !v.special; }) &&
      (((a.links || []).some(function (l) { return isHttpUrl(l.url); })) || a.itemId);
    /* 自动补全先过限流闸（`Importer.autoEnrichGate`）：设置关掉、该站没存 Cookie、或这条素材还在
     * 冷却里，就静静跳过 —— 不能让「点开详情」变成对 BOOTH 的连续请求。 */
    var autoGate = (needsVariantAuto && !opts.noAutoEnrich) ? Importer.autoEnrichGate(a) : { ok: false, why: 'skip' };
    if (autoGate.ok) {
      Toast.info('正在自动获取版本 / 变体 …', 2000);
      var enrichFn = a.source === 'gumroad' ? Importer.autoEnrichGumroadAsset : Importer.autoEnrichBoothAsset;
      enrichFn(a).then(function (saved) {
        if (!saved || saved.delisted) return;
        /* 补全可能「放弃」：返回同一个对象 = 什么都没改（ID 不符 / 抓取失败 / 无可解析订单链接）。
         * 此时既不能刷新详情也不能提示已补全 —— 刷新会重跑本段判定，形成每轮一对 Toast 的死循环，
         * 页面的重渲染一律走 opts.noAutoEnrich。 */
        var locked = !!(saved.autoFilled && saved.autoFilled.versions);
        if (saved === a && !locked) { console.warn('[enrich] 本次未补全，保持原样（下次打开详情会再试一次）'); return; }
        Modals.refreshAfterChange(saved, { keepModal: true });
        if (locked) Toast.ok('已自动补全版本 / 变体信息');
        try { App.ensureCoverOnDisk(saved, { quiet: true, allowFetch: true }); } catch (e) {}   // 补全后顺手补写封面
      });
    }

    if (targetHandle && targetHandle.body) {
      // 原地刷新前先回收上一轮图集 blob，否则每刷新一次就泄漏一整册
      if (typeof targetHandle._revokeGallery === 'function') { try { targetHandle._revokeGallery(); } catch (e) {} }
      targetHandle._revokeGallery = revokeGallery;
      targetHandle.kind = 'detail';
      targetHandle.assetId = id;              // 原地刷新也要钉住「这个弹窗属于谁」
      Modals.syncDetailId();
      targetHandle.body.innerHTML = '';
      appendChildren(targetHandle.body, body);
      return targetHandle;
    }
    var h = Modal.open({
      title: '素材详情', size: 'lg', body: [body],
      /* 关闭时清空归属记录：Modal.close() 先把 handle 移出栈再回调，
       * 这里扫到的是「剩下还在的详情弹窗」（没有则置空）。
       * 顺带收掉卡片上的「正在看」高亮；原地刷新时 detailAssetId 还在，不清。 */
      onClose: function () {
        revokeGallery();
        Modals.syncDetailId();
        if (!App.detailAssetId) {
          App.activeAssetId = '';
          $$('#grid .card.card-active').forEach(function (c) { c.classList.remove('card-active'); });
        }
      }
    });
    h._revokeGallery = revokeGallery;   // 原地刷新时用它回收上一轮图集 blob
    App.syncDownloadButtons();   // 重开详情按下载队列的真实状态显示按钮
    h.kind = 'detail';
    h.assetId = id;   // 弹窗归属的素材 id：refreshAfterChange keepModal 的判断依据
    Modals.syncDetailId();
    return h;
  },

  /* ------------------------------------------------------------------
   * 新增 / 编辑表单
   * ------------------------------------------------------------------ */
  /** 打开新增 / 编辑表单；id 为空表示新增 */
  edit: function (id, opts) {
    opts = opts || {};
    var isNew = !id;
    var a = isNew ? Store.normalizeAsset({ source: 'booth' }) : App.assets.find(function (x) { return x.id === id; });
    if (!a) { Toast.err('未找到该素材'); return; }
    a = JSON.parse(JSON.stringify(a));

    var coverState = { blob: null, url: a.coverURL || '', hasCover: !!a.hasCover, removed: false };
    var manualCoverEdit = false;   // 用户本地上传 / 粘贴封面 URL / 清除封面后置 true，重新抓取不覆盖
    var coverAutoApplied = false;  // 封面由本次抓取自动写入（或自动下载）时置 true
    var galleryImages = (a.images || []).slice();

    /* ---------------- 信息获取区 ---------------- */
    var fetchInput = el('input', {
      class: 'input',
      placeholder: '粘贴 BOOTH / Gumroad 等商品链接，例如 https://booth.pm/ja/items/1234567',
      value: !isNew && (a.links || []).length ? a.links[0].url : ''
    });
    var logBox = el('div', { class: 'fetch-log', style: { display: 'none' } });
    function log(msg) {
      logBox.style.display = '';
      logBox.appendChild(el('div', { class: 'log-line', text: msg }));
      logBox.scrollTop = logBox.scrollHeight;
    }

    function currentMode() { return App.settings.fetchMode || 'paste'; }
    function modeLabel() {
      var m = FETCH_MODES.find(function (x) { return x.id === currentMode(); });
      return m ? m.label : currentMode();
    }

    // 「重新抓取不覆盖手动修改」保护：
    // orig = 打开编辑页时的原始值；autoBase = 上一次自动填充写入的值。
    // 当前值 !== 基线（优先 autoBase，其次 orig）就认为是手动改过，本次抓取跳过该字段。
    var autoBase = {};
    var orig = {
      title: a.title, titleOrig: a.originalTitle, author: a.author || a.shop,
      purchasePrice: (a.purchasePrice == null ? '' : String(a.purchasePrice)), purchaseCurrency: a.purchaseCurrency || '',
      shopPrice: a.shopPrice || '',
      desc: a.description, category: a.category, source: a.source, sourceCustom: a.sourceCustom,
      tags: JSON.stringify(a.tags || []), raws: JSON.stringify(a.rawTags || []),
      avatars: JSON.stringify(a.avatars || []), shopUrl: a.shopUrl, itemId: a.itemId,
      publishedAt: a.publishedAt, shopUpdatedAt: a.shopUpdatedAt,
      images: JSON.stringify(a.images || []), dls: JSON.stringify(a.downloadLinks || []),
      versions: JSON.stringify(a.versions || []),
      cover: a.hasCover ? '[local]' : (a.coverURL || ''), note: a.note, gifted: !!a.gifted
    };
    function baseOf(key, norm) { return Object.prototype.hasOwnProperty.call(autoBase, key) ? autoBase[key] : norm(orig[key]); }
    function dirtyScalar(key, getter) { return String(getter() || '') !== String(baseOf(key, function (v) { return v || ''; })); }
    function dirtyList(key, getter) { return JSON.stringify(getter()) !== baseOf(key, function (v) { return v; }); }
    function dirtyHidden(key) { return String(a[key] || '') !== String(baseOf(key, function (v) { return v || ''; })); }
    function setScalarBase(key, v) { autoBase[key] = String(v || ''); }
    function setListBase(key, v) { autoBase[key] = JSON.stringify(v); }
    function setHiddenBase(key, v) { autoBase[key] = String(v || ''); }

    function applyInfo(info, force) {
      if (!info || info.__failed) return false;
      force = !!force;
      var skipped = [];
      function skip(name) { if (skipped.indexOf(name) < 0) skipped.push(name); }
      function verKey(v) {
        // 同一订单页可能包含多个已购变体：orderUrl 相同时必须用 variationId 区分
        if (v.orderUrl && v.orderUrl.trim()) {
          return v.orderUrl.trim() + (v.variationId ? '#vid:' + v.variationId : '');
        }
        return v.variationId ? 'vid:' + v.variationId : ('name:' + (v.name || ''));
      }
      function purchasedPrice(versions) {
        var sum = 0, cur = '';
        (versions || []).forEach(function (v) {
          if (!v.orderUrl || !v.orderUrl.trim() || v.special) return;   // 许可证/readme 等免费特殊变体不计入商品价
          var pd = derivePrice(v.price);
          if (pd.value != null) { sum += pd.value; cur = pd.currency || cur; }
        });
        return { sum: sum, cur: cur };
      }
      // 字段级锁定：userEdited=true（用户改过）永远不被覆盖；autoFilled=true 后正常抓取不再更新。
      // 强制刷新时除保护字段（自定义标题/原标题/角色三语名）外全部覆盖。
      var FORCE_PROTECTED = ['title', 'titleOrig', 'charNameZh', 'charNameJa', 'charNameEn'];
      function liveDirty(key) {
        switch (key) {
          case 'title': return dirtyScalar('title', function () { return titleInput.value; });
          case 'titleOrig': return dirtyScalar('titleOrig', function () { return titleOrig.value; });
          case 'author': return dirtyScalar('author', function () { return authorInput.value; });
          case 'desc': return dirtyScalar('desc', function () { return descInput.value; });
          case 'category': return dirtyScalar('category', function () { return catSelect.value; });
          case 'source': return dirtyScalar('source', function () { return srcSelect.value; });
          case 'sourceCustom': return dirtyScalar('sourceCustom', function () { return srcCustom.value; });
          case 'cover': return dirtyScalar('cover', function () { return coverState.removed ? '[removed]' : (coverState.blob ? '[local]' : coverState.url); });
          case 'shopUrl': return dirtyHidden('shopUrl');
          case 'itemId': return dirtyHidden('itemId');
          case 'publishedAt': return dirtyHidden('publishedAt');
          case 'shopUpdatedAt': return dirtyHidden('shopUpdatedAt');
          case 'tags': return dirtyList('tags', function () { return tagEditor.getValue(); });
          case 'raws': return dirtyList('raws', function () { return tagEditor.getRaw(); });
          case 'avatars': return dirtyList('avatars', function () { return avatarPicker.getValue(); });
          case 'images': return JSON.stringify(galleryImages) !== String(baseOf('images', function (v) { return v; }));
          case 'dls': return dirtyList('dls', function () { return dlEditor.getValue(); });
          case 'versions': return dirtyList('versions', function () { return versionEditor.getValue(); });
          default: return false;
        }
      }
      function canAuto(key) {
        if (force) return FORCE_PROTECTED.indexOf(key) < 0;
        // 支持角色被用户清空后允许自动填回：空选择视为没有自定义内容，
        // 不受 userEdited.avatars / 本会话 liveDirty 的阻断。
        if (key === 'avatars' && !(avatarPicker.getValue() || []).length) return true;
        if (a.userEdited[key]) return false;
        if (liveDirty(key)) return false;   // 本会话内刚手动改过也视为自定义
        return !a.autoFilled[key];
      }
      function markAuto(key) { a.autoFilled = a.autoFilled || {}; a.autoFilled[key] = true; }

      /* 抓到的标题优先写「原标题」：解析器有的给 originalTitle、有的只给 title，两个都要认；
         原标题为空时即使字段被标记过也补一次，否则永远空着。 */
      var infoTitle = info.originalTitle || info.title || '';
      if (infoTitle) {
        if (canAuto('titleOrig') || !String(titleOrig.value || '').trim()) {
          titleOrig.value = infoTitle; setScalarBase('titleOrig', infoTitle); markAuto('titleOrig');
        } else skip('原标题');
        // 自定义标题只在本来为空时用原标题兜底
        if (!titleInput.value.trim() && canAuto('title')) {
          titleInput.value = infoTitle.slice(0, 60); setScalarBase('title', infoTitle.slice(0, 60)); markAuto('title');
        }
      }
      if (info.author || info.shop) {
        if (canAuto('author')) {
          authorInput.value = info.author || info.shop; setScalarBase('author', info.author || info.shop); markAuto('author');
        } else skip('作者 / 店铺');
      }
      if (info.shopUrl && canAuto('shopUrl')) { a.shopUrl = info.shopUrl; setHiddenBase('shopUrl', info.shopUrl); markAuto('shopUrl'); } else if (info.shopUrl) skip('店铺链接');
      if (info.itemId && canAuto('itemId')) { a.itemId = info.itemId; setHiddenBase('itemId', info.itemId); markAuto('itemId'); } else if (info.itemId) skip('商品 ID');
      // 商品价（只读）：统一存成「币种符号 + 数值」，避免页面 JSON-LD 带来的 “USD 15” 双前缀。
      // 价格一律按变体价现算，这里不再写入素材。
      if (false && info.price && canAuto('shopPrice')) {
        var spd = (info.priceValue != null && isFinite(Number(info.priceValue)))
          ? { value: Number(info.priceValue), currency: info.currency || '' }
          : derivePrice(info.price);
        var spText = App.priceText(spd.value, spd.currency) || String(info.price);
        a.shopPrice = spText;
        a.shopPriceValue = spd.value;
        a.shopPriceCurrency = spd.currency;
        setScalarBase('shopPrice', spText); markAuto('shopPrice');
      } else if (info.price) skip('商品价');
      if (info.description) {
        var zhDesc = Smart.pickChinese(info.description);
        if (canAuto('desc')) {
          descInput.value = zhDesc; setScalarBase('desc', zhDesc); markAuto('desc');
          log(Smart.hasChinese(info.description) ? '\u2714 简介含简体中文，已优先截取中文部分' : '\u26A0 简介暂无中文，可点「AI 翻译简介」汉化');
        } else skip('简介');
      }
      if (info.tags && info.tags.length) {
        var rawTags = uniq(info.tags.map(String));
        var translatedTags = Smart.purgeAvatarTags(App.settings.autoTranslateTags ? Smart.translateTags(rawTags) : rawTags.slice());
        rawTags = Smart.purgeAvatarTags(rawTags);
        if (canAuto('tags') && canAuto('raws')) {
          tagEditor.setValue(force ? translatedTags : uniq(tagEditor.getValue().concat(translatedTags)), rawTags);
          setListBase('tags', tagEditor.getValue()); setListBase('raws', tagEditor.getRaw());
          markAuto('tags'); markAuto('raws');
          log('\u2714 已获取 ' + rawTags.length + ' 个标签' + (App.settings.autoTranslateTags ? '（已自动翻译为中文，角色名已剔除）' : ''));
        } else skip('标签');
      }
      var guess = Smart.guessCategory(info);
      if (guess && guess !== 'other') {
        if (canAuto('category')) {
          catSelect.value = guess; setScalarBase('category', guess); markAuto('category');
          onCategoryChange();   // 抓到角色模型时立即切出「角色名」区块，不必手动改一次类型
          log('\u2714 分类：' + App.categoryLabel(guess) + (info.categoryId || info.category ? '（来自 BOOTH 站方分类：' + (info.category || '') + '）' : ''));
        } else skip('分类');
      }
      if (info.publishedAt && canAuto('publishedAt')) { a.publishedAt = info.publishedAt; setHiddenBase('publishedAt', info.publishedAt); markAuto('publishedAt'); log('\u2714 上架日期：' + fmtDate(info.publishedAt)); }
      else if (info.publishedAt) skip('上架日期');
      if (info.shopUpdatedAt && canAuto('shopUpdatedAt')) { a.shopUpdatedAt = info.shopUpdatedAt; setHiddenBase('shopUpdatedAt', info.shopUpdatedAt); markAuto('shopUpdatedAt'); log('\u2714 商品更新日期：' + fmtDate(info.shopUpdatedAt)); }
      else if (info.shopUpdatedAt) skip('商品更新日期');
      if (info.r18 === true && !(a.extra && a.extra.r18)) {
        a.extra = a.extra || {}; a.extra.r18 = true;
        log('\u26A0 识别为成人向素材（R-18），已追加 R18 特殊标签');
      } else if (info.r18 === false && (a.extra && a.extra.r18) && canAuto('r18')) {
        delete a.extra.r18;   // 简介写「允许用于 R-18 作品」不代表商品本身成人向，这里清掉误判
        markAuto('r18');
        log('\u2714 已清除误判的 R18 标签（商品本身非成人向）');
      }
      // 注意事项：从简介中提取并追加到备注（不覆盖已有备注）
      if (info.description) {
        var notes = Smart.extractNotes(info.description);
        if (notes && noteInput.value.indexOf(notes) < 0) {
          noteInput.value = [noteInput.value.trim(), notes].filter(Boolean).join('\n\n');
          setScalarBase('note', noteInput.value);
          log('\u2714 从简介中提取到注意事项（追加到备注）');
        }
      }
      if (App.settings.autoDetectAvatar && catSelect.value !== 'avatar') {
        var avs = Smart.detectAvatars(info);
        if (avs.length) {
          if (canAuto('avatars')) {
            var mergedAvs = force ? avs : uniq(avatarPicker.getValue().concat(avs));
            // 「通用/多角色」只是备选：本次解析到了具体支持角色时，把旧的通用选中移除
            if (avs.some(function (id) { return id !== 'universal'; })) {
              mergedAvs = mergedAvs.filter(function (id) { return id !== 'universal'; });
            }
            avatarPicker.setValue(mergedAvs);
            setListBase('avatars', mergedAvs);
            markAuto('avatars');
            log('\u2714 识别到支持角色：' + avs.map(App.avatarLabel).join('、'));
          } else skip('支持角色');
        }
      }
      if (info.sourceId) {
        if (canAuto('source') && canAuto('sourceCustom')) {
          srcSelect.value = info.sourceId; onSourceChange(); setScalarBase('source', info.sourceId); setScalarBase('sourceCustom', srcCustom.value);
          markAuto('source'); markAuto('sourceCustom');
        } else skip('来源');
      }
      if (info.images && info.images.length) {
        if (canAuto('images')) {
          galleryImages = force ? uniq(info.images) : uniq(galleryImages.concat(info.images));
          setListBase('images', galleryImages); markAuto('images');
          renderGallery();
          log('\u2714 获取到 ' + info.images.length + ' 张商品图');
        } else skip('图集');
      }
      if (Array.isArray(info.downloadLinks) && info.downloadLinks.length) {
        if (canAuto('dls')) {
          var mergedDls = force ? info.downloadLinks.slice() : uniqBy(dlEditor.getValue().concat(info.downloadLinks), function (l) { return l.url; });
          dlEditor.setValue(mergedDls);
          setListBase('dls', mergedDls); markAuto('dls');
          log('\u2714 已合并 ' + info.downloadLinks.length + ' 条下载链接（按地址去重）');
        } else skip('下载链接');
      }
      // 版本信息：保留全部新变体；无名称变体显示「（默认）」；只清旧的无订单链接变体，新抓到的未购买变体保留
      var allOrderVersions = Array.isArray(info.orderVersions) ? info.orderVersions.slice() : [];
      var lastPurchasedIdx = -1;
      allOrderVersions.forEach(function (o, i) { if (o.orderUrl) lastPurchasedIdx = i; });
      var infoVersions = allOrderVersions.map(function (o, i) {
        var files = (o.files || []).map(function (f) { return { name: f.name, url: f.url, size: f.size || 0, source: o.special ? 'public' : 'order' }; });
        return {
          id: 'ver_order_' + (o.variationId || o.name || i) + '_' + Date.now().toString(36),
          name: o.name || '（默认）',
          variationId: o.variationId || '',
          orderUrl: o.orderUrl || '',
          price: o.special ? '0' : (o.price || ''),
          purchasePrice: (o.orderPriceValue != null && isFinite(Number(o.orderPriceValue))) ? Number(o.orderPriceValue) : null,
          purchaseCurrency: o.orderPriceCurrency || '',
          special: !!o.special,
          isLatest: !!o.orderUrl && !o.special && i === lastPurchasedIdx,
          fileName: files.length ? files[0].name : '',
          url: files.length ? files[0].url : '',
          size: files.reduce(function (s, f) { return s + (f.size || 0); }, 0),
          files: files
        };
      });
      var versionsProcessed = false;
      if (infoVersions.length) {
        if (canAuto('versions')) {
          if (force) {
            versionEditor.setValue(infoVersions);
          } else {
            var existing = versionEditor.getValue();
            var byKey = {};
            var byName = {};
            var incomingKey = {};
            infoVersions.forEach(function (v) { incomingKey[verKey(v)] = 1; if (v.variationId) incomingKey['vid:' + v.variationId] = 1; if (v.name) incomingKey['name:' + v.name] = 1; });
            // 剔除旧数据里没有订单链接、且与新变体不匹配的无效版本
            existing = existing.filter(function (v) {
              if (v.orderUrl && v.orderUrl.trim()) return true;
              if (v.variationId && incomingKey['vid:' + v.variationId]) return true;
              if (v.name && incomingKey['name:' + v.name]) return true;
              return false;
            });
            existing.forEach(function (v, i) {
              byKey[verKey(v)] = i;
              if (v.name) byName[v.name] = i;
            });
            infoVersions.forEach(function (v) {
              var k = verKey(v);
              if (byKey[k] !== undefined) {
                v.id = existing[byKey[k]].id;
                existing[byKey[k]] = v;
              } else if (v.name && byName[v.name] !== undefined) {
                v.id = existing[byName[v.name]].id;
                existing[byName[v.name]] = v;
              } else {
                existing.push(v);
              }
            });
            versionEditor.setValue(existing);
          }
          setListBase('versions', versionEditor.getValue()); markAuto('versions');
          versionsProcessed = true;
          var boughtCount = versionEditor.getValue().filter(function (v) { return v.orderUrl && v.orderUrl.trim(); }).length;
          log('\u2714 已识别 ' + versionEditor.getValue().length + ' 个版本/变体（已购买 ' + boughtCount + ' 个；未购买灰色显示、不计价）');
        } else skip('版本 / 变体');
      } else if ((Array.isArray(info.versions) && info.versions.length) || (info.description ? Smart.extractVersionsFromText(info.description).length : 0)) {
        var fallbackVersions = (Array.isArray(info.versions) && info.versions.length)
          ? info.versions
          : Smart.extractVersionsFromText(info.description);
        if (canAuto('versions')) {
          var have = {};
          versionEditor.getValue().forEach(function (v) { have[verKey(v)] = 1; if (v.name) have['name:' + v.name] = 1; });
          var merged = force ? fallbackVersions.slice() : versionEditor.getValue().concat(fallbackVersions.filter(function (v) { return !have[verKey(v)] && !have['name:' + (v.name || '')]; }));
          versionEditor.setValue(merged);
          setListBase('versions', versionEditor.getValue());
          // 仅简介/JSON 兜底版本不算“变体识别完成”，不锁定，下次仍可再尝试识别已购变体
          versionsProcessed = true;
          log('\u2714 获取到 ' + fallbackVersions.length + ' 个版本 / 变体（兜底，未锁定）');
        } else skip('版本 / 变体');
      }
      // BOOTH 商品价 = 已购变体计算价（无已购买 = 0）；Gumroad 等来源沿用上面抓取到的商店价（只读展示）
      var isBoothSource = (info.sourceId || srcSelect.value) === 'booth';
      var isGumroadSource = (info.sourceId || srcSelect.value) === 'gumroad';
      if (isBoothSource && versionsProcessed && (canAuto('shopPrice') || a.autoFilled.shopPrice)) {
        var pp = purchasedPrice(versionEditor.getValue());
        var ptext = '0';
        if (pp.sum) {
          var psym = pp.cur === 'JPY' ? '\u00A5' : (pp.cur === 'USD' ? '$' : (pp.cur === 'EUR' ? '\u20AC' : '\u00A5'));
          ptext = psym + ' ' + pp.sum.toLocaleString('ja-JP');
        }
        a.shopPrice = ptext;
        a.shopPriceValue = pp.sum;
        a.shopPriceCurrency = pp.cur;
        setScalarBase('shopPrice', ptext); markAuto('shopPrice');
        log(pp.sum ? ('\u2714 BOOTH 商品价已按已购买版本计算：' + ptext) : '\u2714 BOOTH 商品价已按已购买版本计算：0（未购买任何变体）');
      }
      if (info.coverURL) {
        var curCover = coverState.removed ? '[removed]' : (coverState.blob ? '[local]' : coverState.url);
        if (!manualCoverEdit && canAuto('cover')) {
          coverState.url = info.coverURL; coverState.removed = false;
          coverAutoApplied = true;
          setScalarBase('cover', info.coverURL); markAuto('cover');
          renderCover();
          if (App.settings.autoFetchCover && App.isGitHubSource(a) && (info.images || []).length) {
            // GitHub README 图抓到即本地化：首图失败顺延下一张，全失败保留仓库头像外链
            log('正在下载 README 图片（封面 + 图集）…');
            App.ghLocalizeImages(a, info, { log: log }).then(function (r) {
              if (!r || !r.cover) { log('\u26A0 README 图片均未能下载，封面继续使用仓库头像外链'); return; }
              coverState.blob = r.coverBlob; coverState.url = r.coverURL; coverState.removed = false;
              coverAutoApplied = true;
              setScalarBase('cover', '[local]');
              renderCover();
            }).catch(function (e) { log('\u26A0 README 图片本地化失败：' + ((e && e.message) || e)); });
          } else if (App.settings.autoFetchCover) {
            log('正在下载封面图 …');
            Net.fetchBlob(info.coverURL, { onLog: log }).then(function (b) {
              if (!b) { log('\u26A0 封面图下载失败，将以外链方式显示'); return; }
              return compressImage(b, App.settings.imageMaxWidth, App.settings.imageQuality).then(function (small) {
                coverState.blob = small; coverState.removed = false;
                coverAutoApplied = true;
                setScalarBase('cover', '[local]');
                log('\u2714 封面已压缩至 ' + fmtSize(small.size));
                renderCover();
              }).catch(function (e) { log('\u26A0 封面压缩失败：' + e.message); });
            });
          }
        } else skip('封面');
      }
      if (skipped.length) log('\u26A0 以下字段已被用户自定义 / 自动获取锁定，本次抓取未覆盖：' + skipped.join('、'));
      syncFileId();   // 抓取可能写入商品号，编号要立刻变成锁定态
      return true;
    }

    /** 当前表单里的 BOOTH 商品号：抓取写进 a.itemId，或链接里带 /items/<数字> */
    function boothIdNow() {
      var links = [];
      try { links = linkEditor.getValue() || []; } catch (e) { links = []; }
      var pasted = String(fetchInput.value || '').trim();
      if (isHttpUrl(pasted)) links = links.concat([{ url: pasted }]);
      return Store.boothIdOf({ itemId: a.itemId, links: links });
    }

    /** 按当前链接刷新编号显示：有 BOOTH 商品号就显示它，否则显示存着的自动编号 */
    function syncFileId() {
      var booth = boothIdNow();
      var saved = String(a.fileId || '').trim();
      if (booth) {
        fileIdInput.value = booth;
        fileIdHint.textContent = 'BOOTH 商品编号。编号固定不变，好友导入时按它判定同一份';
        fileIdBox.title = '已填 BOOTH 链接：编号即商品编号 ' + booth + '，只读。要换编号只能换素材链接。';
        return;
      }
      fileIdInput.value = saved;
      fileIdHint.textContent = saved
        ? '自动生成、固定不变的编号，好友导出/导入时按它判定同一份'
        : '新建素材保存时自动生成（V 开头），之后不再变化';
      fileIdBox.title = '素材唯一编号，只读。好友导出/导入时靠它判定是不是同一份素材';
    }

    function rememberLink() {
      var url = fetchInput.value.trim();
      if (!isHttpUrl(url)) return url;
      var cur = linkEditor.getValue();
      if (!cur.some(function (l) { return l.url === url; })) {
        linkEditor.setValue(cur.concat([{ url: url, label: hostOf(url) }]));
      }
      return url;
    }

    /* ---- 手动粘贴源码（离线解析） ---- */
    var pasteArea = el('textarea', {
      class: 'input textarea mono', rows: 6,
      placeholder: '在此粘贴页面源码；或 BOOTH items/<商品ID>.json、GitHub api.github.com/repos/<owner>/<repo> 的整页返回内容（JSON 识别率最高）'
    });
    var pasteHint = el('div', { class: 'field-hint' });
    var pasteHintLink = el('div', { class: 'field-hint' });
    var fetchHint = el('div', { class: 'field-hint', text: '提示：可粘贴完整商品链接；也可以只输入 BOOTH 数字商品 ID（如 8404988）或 Gumroad 短链接 ID，点「强制联网填充」会自动补全为完整链接并写入下方「商店链接」。' });
    function updateFetchHint() {
      var raw = fetchInput.value.trim();
      if (!raw) {
        fetchHint.textContent = '提示：可粘贴完整商品链接；也可以只输入 BOOTH 数字商品 ID（如 8404988）或 Gumroad 短链接 ID，点「强制联网填充」会自动补全为完整链接并写入下方「商店链接」。';
      } else if (/^\d{4,15}$/.test(raw)) {
        fetchHint.textContent = '已识别为 BOOTH 商品 ID：点「强制联网填充」会自动补全为完整商品链接，并写入「商店链接」。';
      } else if (!isHttpUrl(raw) && /^[A-Za-z0-9][A-Za-z0-9_.=-]{0,100}$/.test(raw)) {
        fetchHint.textContent = '已识别为商品 ID / 短链接：点「强制联网填充」会先尝试补全为完整链接（BOOTH 优先），成功后写入「商店链接」。';
      } else {
        fetchHint.textContent = '完整商品链接：点「强制联网填充」抓取信息，并自动写入「商店链接」。';
      }
    }
    function updatePasteHint() {
      var url = fetchInput.value.trim();
      pasteHint.textContent = '操作步骤：① 在浏览器打开商品页 / 仓库页 → ② 按 Ctrl+U 查看网页源代码 → ③ Ctrl+A 全选、Ctrl+C 复制 → ④ 粘贴到下方文本框 → ⑤ 点击「解析粘贴内容」。全过程不产生任何外部请求。';
      pasteHintLink.innerHTML = '';
      // 任何有 jsonURL 的来源都给出「直接打开 JSON」入口，识别率最高（BOOTH / GitHub 通用）
      var f = isHttpUrl(url) ? Fetchers.detect(url) : null;
      var jurl = (f && f.jsonURL) ? (f.jsonURL(url) || '') : '';
      if (jurl) {
        pasteHintLink.appendChild(document.createTextNode((f.name || '该站点') + '更省事的做法（识别率最高）：直接打开 '));
        pasteHintLink.appendChild(el('a', { href: jurl, target: '_blank', rel: 'noopener' }, jurl));
        pasteHintLink.appendChild(document.createTextNode(' ，复制整页 JSON 粘贴到下方。' + (f.id === 'github' ? 'GitHub 连上面的链接都不用填——粘了 JSON 程序会自己认出来源。' : '')));
      }
    }
    var pasteWrap = el('div', { class: 'paste-wrap' }, [
      pasteHint, pasteHintLink, pasteArea,
      el('button', {
        class: 'btn btn-sm btn-primary', type: 'button', onclick: function () {
          var url = rememberLink();
          var raw = pasteArea.value.trim();
          if (/^https?:\/\/\S+$/i.test(raw)) {          // 粘的是链接而不是内容：给出明确指引
            var gf = Fetchers.detect(raw);
            var gj = (gf && gf.jsonURL) ? (gf.jsonURL(raw) || '') : '';
            Toast.warn('这里要粘的是页面内容（源码或 JSON），不是链接：' + (gj ? ('请打开 ' + gj + ' 复制整页粘贴') : '请粘贴页面源码'), 7000);
            return;
          }
          var info = Fetchers.parsePasted(raw, url);
          if (!info) { Toast.err('未能解析出内容，请确认粘贴的是完整页面源码或 JSON'); return; }
          log('\u2714 已在本地解析粘贴内容（未发起任何网络请求）');
          applyInfo(info);
          Toast.ok('已从粘贴内容填充字段');
        }
      }, ICONS.label('\u{1F50E} 解析粘贴内容'))
    ]);

    /* ---- 联网抓取（全部由程序后端负责） ----
     * 只保留一个「强制联网填充」。以前还有「联网自动填充」和「用 Cookie 获取已购信息」：
     * 那两个只填空值、还吃本地缓存，点完常常看不出变化（用户原话「差点意思」），已删除；
     * 所有自动 / 刷新入口也统一走这一套（默认值见 startFetch）。 */
    var forceBtn = el('button', {
      class: 'btn btn-danger-ghost', type: 'button',
      title: '联网重新获取并覆盖信息（忽略本地缓存与字段锁定；自定义标题、原标题、角色三语名始终保留）',
      onclick: function () { doFetch({ forceFill: true, forceNetwork: true, noCache: true }); }
    }, ICONS.label('\u26A1 强制联网填充'));

    /* 判据在 Fetchers.looksDelisted（批量更新商品信息共用），这里只转发 */
    function looksDelisted(info) { return Fetchers.looksDelisted(info); }

    /** 输入的是商品 ID（不是完整链接）时，后台依次尝试候选链接（BOOTH / Gumroad）；
     *  成功就把输入框替换为完整链接，并继续按该链接完成信息获取填充。
     *  候选规则统一由 Fetchers.productCandidates 给（详情页的「从商品链接补充信息」共用）。 */
    function resolveProductInput(raw, opts) {
      var candidates = Fetchers.productCandidates(raw);
      logBox.innerHTML = ''; logBox.style.display = '';
      log('\u{1F50D} 输入的不是完整链接：' + raw + '，正在后台尝试补全为完整商品链接 …');
      forceBtn.disabled = true; ICONS.apply(forceBtn, ('\u23F3 补全链接中 …'));
      function next(i) {
        if (i >= candidates.length) {
          log('\u2716 未能把「' + raw + '」补全为有效商品链接。请粘贴完整商品页 URL 后重试。');
          Toast.err('未能补全该商品 ID，请粘贴完整商品链接', 5600);
          restoreButtons();
          return;
        }
        var candidate = candidates[i];
        return Fetchers.fetchInfoTimed(candidate, { forceNetwork: true, noCache: true, onLog: function () {} }, 12000).then(function (info) {
          if (info && info.__failed && info.reason === 'timeout') {
            log('\u26A0 补全超时（12 秒没有响应）：' + candidate + '，先粘贴完整商品页链接再试');
            Toast.err('补全超时：请粘贴完整商品链接后重试', 5600);
            restoreButtons();
            return;
          }
          var ok = info && !info.__failed && info.originalTitle &&
            !/(^|\s)(404|not found|page not found|不存在)(\s|$)/i.test(info.originalTitle) &&
            info.originalTitle.toLowerCase() !== 'gumroad';
          if (!ok) return next(i + 1);
          fetchInput.value = candidate;
          rememberLink();
          updateFetchHint();
          log('\u2714 已补全商品链接并写入商店链接：' + candidate);
          return startFetch(candidate, opts);
        }).catch(function () { return next(i + 1); });
      }
      return next(0);
    }

    function restoreButtons() {
      forceBtn.disabled = false;
      ICONS.apply(forceBtn, ('\u26A1 强制联网填充'));
    }

    function doFetch(opts) {
      opts = opts || {};
      var url = rememberLink();
      if (!isHttpUrl(url)) {
        var raw = String(url || '').trim();
        /* 纯 ID / 短码 / 漏了协议头的链接都交给补全（判据同 Fetchers.productCandidates） */
        if (raw && Fetchers.productCandidates(raw).length) { resolveProductInput(raw, opts); return; }
        Toast.warn('请输入商品链接，或只输入商品 ID（BOOTH 数字 ID / Gumroad 短链接 ID）');
        return;
      }
      startFetch(url, opts);
    }

    function startFetch(url, opts) {
      /* 一律按「强制联网填充」走：忽略本地缓存、忽略字段锁定（自定义标题 / 原标题 / 角色三语名除外）。
       * 普通填充只填空值、命中缓存就直接返回，用户点完经常「看不出变化」，已经移除。 */
      opts = Object.assign({ forceFill: true, forceNetwork: true, noCache: true }, opts || {});
      logBox.innerHTML = ''; logBox.style.display = '';
      forceBtn.disabled = true;
      ICONS.apply(forceBtn, ('\u23F3 强制联网填充中 …'));
      Fetchers.fetchInfo(url, { onLog: log, noCache: !!opts.noCache, forceNetwork: !!opts.forceNetwork }).then(function (info) {
        if (!info || info.__failed) {
          if (looksDelisted(info)) {
            a.delisted = true;
            log('\u{1F6AB} 商品无法获取（404/410，可能已下架），已标记「已下架」。自动补全将跳过该素材；手动点联网仍可重试，成功后自动清除标记。');
            App.save(a).then(function () { UI.renderAll(); });
            Toast.err('商品已下架，已标记；可手动重试获取', 5200);
          } else {
            log('\u2716 抓取未成功。请确认程序正常运行（程序后端随窗口启动），或改用下方「手动粘贴源码」。');
            Toast.err('自动抓取失败，请查看日志或改用手动粘贴');
          }
          pasteWrap.style.display = '';
        } else if (info.__fromCache && !(info.versions || []).length && !(info.downloadLinks || []).length && !opts.noCache) {
          // 缓存结果缺少版本/下载等关键信息：询问是否清除该链接缓存后重试
          log('\u26A0 本次结果来自解析缓存，且缺少版本/变体与下载链接。');
          Modal.confirm('解析缓存中缺少版本/变体与下载链接等关键信息。是否清除该链接的缓存并重新获取？', { okText: '清除缓存并重试' })
            .then(function (ok) {
              if (ok) {
                Store.cacheDel(url).then(function () { doFetch(Object.assign({}, opts, { noCache: true })); });
              } else {
                applyInfo(info, opts.forceFill);
                Toast.ok('已使用缓存结果填充（版本信息留空）');
              }
            });
        } else {
          if (a.delisted) { a.delisted = false; log('\u2714 商品可正常获取，已清除「已下架」标记'); }
          // 联网填充顺带识别已购版本/变体：
          // BOOTH 已购 variation 的按钮是订单链接；Gumroad 登录后 purchase.content_url 是下载页链接。
          Net.fetchText(url, { forceNetwork: true, onLog: function () {} }).then(function (r) {
            if (r && r.ok && r.text) {
              var isGumroad = /gumroad\.com/i.test(url);
              var ov = isGumroad ? Importer.parseGumroadItemOrderLinks(r.text) : Importer.parseBoothItemOrderLinks(r.text);
              if (ov.length) {
                info.orderVersions = ov;
                var purchased = ov.filter(function (o) { return o.orderUrl && !o.special; });
                var unpurchasedN = ov.length - purchased.length;
                if (purchased.length) log('\u2714 识别到已购版本/变体：' + purchased.map(function (o) { return o.name || '（默认）'; }).join('、') + '（含订单/下载页链接）');
                if (unpurchasedN) log('\u26AA 另有 ' + unpurchasedN + ' 个未购买变体：保留但灰色显示、不计价');
                // 继续抓订单/下载页，把每个已购变体的下载文件（含旧文件）解析出来挂到版本上
                var orderUrls = uniq(purchased.map(function (o) { return o.orderUrl; }).filter(Boolean));
                return Promise.all(orderUrls.map(function (orderUrl) {
                  return Net.fetchText(orderUrl, { forceNetwork: true, onLog: function () {} }).then(function (rr) {
                    if (!rr || !rr.ok || !rr.text) return null;
                    var parsed = Importer.parseOrderPage(orderUrl, rr.text);
                    var items = parsed.items;
                    if (!items.length) return null;
                    var it = items.find(function (x) { return x.itemId === String(info.itemId || ''); }) || items[0];
                    if (it) log('\u2714 订单页解析出 ' + it.downloads.length + ' 个下载文件');
                    return it;
                  }).catch(function () { return null; });
                })).then(function (orders) {
                  orders.forEach(function (it, idx) {
                    if (!it) return;
                    if (isGumroad) {
                      var gumTarget = purchased[idx] || purchased[0];
                      var gumG = (it.orderVersions || {}).default;
                      if (gumG && gumG.files && gumG.files.length) gumTarget.files = gumG.files;
                      if (it.orderPriceValue != null) {
                        gumTarget.orderPrice = it.orderPrice || '';
                        gumTarget.orderPriceValue = it.orderPriceValue;
                        gumTarget.orderPriceCurrency = it.orderPriceCurrency || '';
                      }
                      return;
                    }
                    // BOOTH：一个订单页可能对应多个已购变体。先把文件回填到各自变体，
                    // 再把订单总价按该订单内匹配到的变体数均分（如 5 个 DLC 总价 5000 → 每个 1000）。
                    var orderUrl = orderUrls[idx];
                    var candidates = purchased.filter(function (o) { return o.orderUrl === orderUrl; });
                    if (!candidates.length) candidates = purchased.length ? [purchased[0]] : [];
                    var matched = candidates.filter(function (o) { return (it.orderVersions || {})[o.variationId]; });
                    var targets = matched.length ? matched : (candidates.length ? [candidates[0]] : []);
                    var share = null;
                    if (targets.length && it.orderPriceValue != null) {
                      share = Math.round((it.orderPriceValue / targets.length) * 100) / 100;
                    }
                    targets.forEach(function (o) {
                      var g = (it.orderVersions || {})[o.variationId] || (it.orderVersions || {}).default;
                      if (g && g.files && g.files.length) o.files = g.files;
                      if (share != null) {
                        o.orderPrice = it.orderPrice || '';
                        o.orderPriceValue = share;
                        o.orderPriceCurrency = it.orderPriceCurrency || '';
                      }
                    });
                  });
                  return info;
                });
              }
            }
            return info;
          }).catch(function () { return info; }).then(function (info2) {
            applyInfo(info2, opts.forceFill);
            if (!opts.silent) Toast.ok(opts.forceFill ? '已强制联网填充（标题与角色名保留，已忽略本地缓存）' : '抓取完成，已自动填充可识别的字段');
          });
        }
      }).catch(function (e) {
        log('\u2716 异常：' + (e.message || e));
        Toast.err('抓取异常：' + (e.message || e));
        pasteWrap.style.display = '';
      }).then(function () {
        restoreButtons();
      });
    }

    var openPageBtn = el('button', {
      class: 'btn', type: 'button', title: '在新标签页打开商品页', onclick: function () {
        var url = rememberLink();
        if (!isHttpUrl(url)) { Toast.warn('请先填写商品链接'); return; }
        FS.openExternal(url);
      }
    }, ICONS.label('\u{1F517} 打开商品页'));

    var modeBadge = el('span', { class: 'mode-badge' });
    function refreshModeUI() {
      modeBadge.textContent = '当前方案：' + modeLabel();
      var paste = currentMode() === 'paste';
      pasteWrap.style.display = paste ? '' : 'none';
      forceBtn.style.display = '';          // 「手动粘贴源码」下也留着：想联网就点它，不会偷偷发请求
      updatePasteHint();
    }
    /* 去抖函数必须只创建一次：写在回调里等于每次按键新建闭包，
     * 新闭包的定时器变量是 undefined，永远清不掉上一键的定时器，去抖完全失效。 */
    var updatePasteHintDebounced = debounce(updatePasteHint, 250);
    fetchInput.addEventListener('input', function () { updateFetchHint(); updatePasteHintDebounced(); });

    var switchModeBtn = el('button', {
      class: 'btn btn-sm btn-ghost', type: 'button', onclick: function () { Settings.open('fetch'); }
    }, ICONS.label('\u2699 切换抓取方式'));

    /* ---------------- 基本字段 ---------------- */
    var titleInput = el('input', { class: 'input', value: a.title, placeholder: '例如：戚风用 冬季毛衣套装', required: true });
    var titleOrig = el('input', { class: 'input', value: a.originalTitle, placeholder: '原始商品标题（自动获取或手动填写）' });

    var srcSelect = el('select', { class: 'input', onchange: function () { onSourceChange(); } },
      App.allSources().map(function (s) {
        return el('option', { value: s.id, selected: a.source === s.id }, s.label);
      }));
    var srcCustom = el('input', { class: 'input', value: a.sourceCustom, placeholder: '自定义来源名称' });
    var srcCustomRow = el('div', { style: { display: 'none', marginTop: '6px' } }, [srcCustom]);
    function onSourceChange() { srcCustomRow.style.display = srcSelect.value === 'other' ? '' : 'none'; }
    function onCategoryChange() {
      var field = $('#avatarField');
      var charField = $('#charNameField');
      var isChar = catSelect.value === 'avatar';
      if (field) field.style.display = isChar ? 'none' : '';
      if (charField) charField.style.display = isChar ? '' : 'none';
      charNameEn.required = isChar;   // 角色模型：英文角色名必填（生成存储路径时使用）
    }

    var catSelect = el('select', { class: 'input', onchange: function () { renderCover(); onCategoryChange(); } }, App.allCategories().map(function (c) {
      return el('option', { value: c.id, selected: a.category === c.id }, c.label);
    }));

    var linkEditor = Field.multi(a.links, {
      placeholder: 'https://…（商店 / 商品页链接）', labelPlaceholder: '备注', addText: '添加链接', emptyText: '尚未添加商店链接',
      onChange: function () {
        syncFileId();   // 链接变了可能带出 BOOTH 商品号，编号显示要跟着换
        /* 从链接编辑器里加号进来的地址也要自动取标题；scheduleAutoTitle 定义在下面，
         * var 提升期间是 undefined，用 typeof 兜一下（正常交互时已经定义好）。 */
        if (typeof scheduleAutoTitle === 'function') scheduleAutoTitle();
      }
    });

    /* 素材编号：好友导出/导入时靠它认「是不是同一份」。用户只能看，不能改 ——
     * 它是对外身份，手改一次就会让已经发出去的包认不回来。
     * 值来自 BOOTH 商品号或创建时自动生成，见 syncFileId。 */
    var fileIdInput = el('input', {
      class: 'input mono input-locked', readOnly: true, placeholder: '保存后自动生成'
    });
    var fileIdHint = el('div', { class: 'field-hint' });
    var fileIdCopy = el('button', {
      class: 'btn btn-sm', type: 'button', title: '复制编号',
      onclick: function () {
        var v = String(fileIdInput.value || '').trim();
        if (!v) { Toast.info('保存后才有编号'); return; }
        copyText(v).then(function () { Toast.ok('编号已复制：' + v, 3000); })
          .catch(function () { Toast.warn('复制失败，请手动选中输入框里的编号'); });
      }
    }, '复制');
    var fileIdRow = el('div', { class: 'file-id-row' }, [fileIdInput, fileIdCopy]);
    var fileIdBox = el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '素材编号' }),
      el('div', { class: 'field-control' }, [fileIdRow, fileIdHint])
    ]);

    /* ---------------- 链接 → 自动填「原标题」 ----------------
     * 打开表单、或粘贴/更换商品链接后，由后端取一次商品标题填进「原标题」；
     * 「自定义标题」为空时顺带用它兜底。其他字段（简介、标签、价格）仍要用户点「强制联网填充」。
     * 两点约束：
     *   1. 手动粘贴模式（默认）下一律不联网 —— 「不发外部请求」是程序对外的承诺；
     *   2. 用户自己填过原标题就不覆盖，只有「空」或「上次自动写进去的值」才更新。 */
    var autoTitleCache = Object.create(null);      // url -> 标题（本进程内复用，换表单不用再请求）
    var autoTitleApplied = Object.create(null);    // 自动写过的值，用来认出「这条是我们填的」
    var autoTitleLastUrl = '';
    var autoTitleBusy = false;
    var autoTitleSeq = 0;
    var lastAutoTitle = '';
    var titleAutoHint = el('div', { class: 'field-hint' });

    function autoTitleUrl() {
      var raw = String(fetchInput.value || '').trim();
      if (isHttpUrl(raw)) return raw;
      var list = [];
      try { list = linkEditor.getValue() || []; } catch (e) { list = []; }
      for (var i = 0; i < list.length; i++) {
        var u = String((list[i] && list[i].url) || '').trim();
        if (isHttpUrl(u)) return u;
      }
      return '';
    }

    function autoTitleWritable() {
      var cur = String(titleOrig.value || '').trim();
      if (!cur) return true;
      if (cur === String(lastAutoTitle || '').trim()) return true;
      for (var u in autoTitleApplied) { if (autoTitleApplied[u] === cur) return true; }
      return false;
    }

    function fillAutoTitle(rawTitle) {
      var t = String(rawTitle || '').replace(/\s+/g, ' ').trim();
      if (!t) return false;
      if (String(titleOrig.value || '').trim() === t) {
        titleAutoHint.textContent = '已从链接获取标题：' + t;
        return false;
      }
      if (!autoTitleWritable()) {
        titleAutoHint.textContent = '原标题是你手动填的，链接标题不会覆盖它';
        return false;
      }
      titleOrig.value = t;
      lastAutoTitle = t;
      /* 记进 autoBase：这样后面「重新抓取不覆盖手动修改」的判据认得这是我们填的，
       * 再次抓取时该更新就更新，不会误判成用户手写。 */
      autoBase.titleOrig = t;
      if (!String(titleInput.value || '').trim()) {
        var covered = t.slice(0, 60);
        titleInput.value = covered;
        autoBase.title = covered;
      }
      titleAutoHint.textContent = '已从链接自动获取标题；可直接改';
      return true;
    }

    function maybeAutoTitle() {
      var url = autoTitleUrl();
      if (!url) { titleAutoHint.textContent = ''; return; }
      if (url === autoTitleLastUrl) return;
      if (!autoTitleWritable()) { titleAutoHint.textContent = '原标题是你手动填的，链接标题不会覆盖它'; return; }
      var netOpen = (typeof Net !== 'undefined' && Net.networkAllowed());
      /* 「手动粘贴源码」+ 关掉「粘贴链接自动取标题」才是零请求；其余一律照抓（强制联网） */
      if (!netOpen && App.settings.autoTitleFetch === false) {
        titleAutoHint.textContent = '「粘贴链接自动取标题」已关闭，不会联网（可在「设置 → 联网与抓取」打开）';
        return;
      }
      if (autoTitleCache[url]) { autoTitleLastUrl = url; fillAutoTitle(autoTitleCache[url]); return; }
      autoTitleLastUrl = url;
      if (autoTitleBusy) autoTitleSeq++;      // 旧请求还在路上：把它的结果作废
      autoTitleBusy = true;
      var seq = ++autoTitleSeq;
      titleAutoHint.textContent = '正在获取链接标题…';
      Fetchers.fetchTitle(url, { forceNetwork: true }).then(function (r) {
        if (seq !== autoTitleSeq) return;
        autoTitleBusy = false;
        if (r && r.ok && r.title) {
          autoTitleCache[url] = r.title;
          autoTitleApplied[url] = r.title;
          fillAutoTitle(r.title);
        } else {
          titleAutoHint.textContent = '没能取到标题（' + ((r && r.reason) || '网络问题') + '），可在下面点「强制联网填充」';
        }
      }).catch(function (e) {
        autoTitleBusy = false;
        if (seq === autoTitleSeq) titleAutoHint.textContent = '标题获取失败：' + ((e && e.message) || e);
      });
    }

    /* 去抖只建一次：每次按键新建闭包会让上一键的定时器清不掉（同 updatePasteHint 那条注释） */
    var scheduleAutoTitle = debounce(maybeAutoTitle, 700);
    fetchInput.addEventListener('input', scheduleAutoTitle);
    fetchInput.addEventListener('blur', maybeAutoTitle);
    /* 编辑老素材时原标题多半是空的：打开就补一次，省得用户再点一下链接框 */
    if (!String(a.originalTitle || '').trim()) setTimeout(maybeAutoTitle, 400);

    var dlEditor = Field.multi(a.downloadLinks, { placeholder: 'https://…（直接下载链接）', labelPlaceholder: '文件名', addText: '添加下载链接', emptyText: '尚未添加下载链接', dedupe: true });
    var dlSectionTitle = null;   // 便于聚焦提示
    /* 本地路径只允许一条：多路径会让「导入到 Unity / 获取更新」挑错目标目录 */
    if ((a.paths || []).length > 1) {
      var keepOne = (a.paths || []).filter(function (p) { return p && p.note === '存储路径'; })[0] || a.paths[0];
      a.paths = [keepOne];
    }
    var pathEditor = Field.multi(a.paths, { placeholder: '例如 D:\\素材库\\衣装\\戚风\\冬季毛衣', labelPlaceholder: '说明', addText: '添加本地路径', emptyText: '尚未关联本地路径', pickDir: true, asPath: true });
    /* 隐藏「添加本地路径」按钮：本地路径只保留一条 */
    Array.prototype.forEach.call(pathEditor.querySelectorAll('button'), function (b) {
      if (/添加/.test(b.textContent || '')) b.style.display = 'none';
    });

    var versionEditor = Field.versions(a.versions);
    var tagEditor = Field.tags(a.tags, a.rawTags);
    var avatarPicker = Field.avatars(a.avatars);
    var charNameZh = el('input', { class: 'input', value: a.charNameZh || '', placeholder: '中文名，如 索菲娜' });
    var charNameJa = el('input', { class: 'input', value: a.charNameJa || '', placeholder: '日文名，如 ソフィナ' });
    var charNameEn = el('input', { class: 'input', value: a.charNameEn || '', placeholder: '英文名，如 Sophina' });

    var authorInput = el('input', { class: 'input', value: a.author || a.shop, placeholder: '作者 / 店铺名' });
    // 网盘字段（仅记录 + 角标）
    var cloudInput = el('input', { class: 'input', value: a.cloudUrl || '', placeholder: '网盘路径或分享链接（例：百度网盘 / 我的应用数据/xxx，或 https://pan.baidu.com/s/…）' });
    var descInput = el('textarea', { class: 'input textarea', rows: 8, placeholder: '商品简介（自动获取或手动填写）' });
    descInput.value = a.description || '';
    var noteInput = el('textarea', { class: 'input textarea', rows: 4, placeholder: '改模注意事项、依赖的着色器、使用心得等' });
    noteInput.value = a.note || '';

    var giftCheck = el('input', { type: 'checkbox', checked: !!a.gifted });
    var favCheck = el('input', { type: 'checkbox', checked: a.favorite });
    var hideCheck = el('input', { type: 'checkbox', checked: a.hidden });
    var publishedAtInput = el('input', { type: 'date', class: 'input input-sm', value: a.publishedAt ? fmtDate(a.publishedAt) : '' });

    /* ---------------- 封面 & 图集 ---------------- */
    var coverPreview = el('div', { class: 'cover-preview' });
    var coverPreviewURL = '';   // 本函数自建的封面预览 blob URL：重绘 / 关弹窗前必须先回收，否则每敲一键泄漏一份
    function renderCover() {
      if (coverPreviewURL) { try { URL.revokeObjectURL(coverPreviewURL); } catch (e) {} coverPreviewURL = ''; }
      coverPreview.innerHTML = '';
      var src = '';
      if (coverState.blob) { src = URL.createObjectURL(coverState.blob); coverPreviewURL = src; }
      else if (!coverState.removed && coverState.hasCover && App.coverCache[a.id]) src = App.coverCache[a.id];
      else if (coverState.url) src = coverState.url;
      if (src) {
        var img = el('img', { src: src, alt: '封面预览' });
        img.onerror = function () {
          coverPreview.innerHTML = '';
          coverPreview.appendChild(el('div', { class: 'cover-ph big'}, ICONS.label('\u26A0')));
          coverPreview.appendChild(el('div', { class: 'field-hint', text: '外链封面加载失败（可能被防盗链阻止），建议改用本地上传。' }));
        };
        coverPreview.appendChild(img);
      } else {
        coverPreview.appendChild(el('div', { class: 'cover-ph big' }, [App.categoryIcon(catSelect.value, { size: 64 })]));
      }
      if (!coverState.blob && !coverState.hasCover && coverState.url) {
        coverPreview.appendChild(el('div', { class: 'field-hint', text: '当前为外链封面（不占用本地存储）' }));
      }
    }
    if (!isNew && a.hasCover && !App.coverCache[a.id]) App.coverURLFor(a).then(renderCover);
    renderCover();
    // 编辑页同样按商品 ID 从本地路径认领封面
    if (!isNew && !a.hasCover && !a.coverURL) {
      App.adoptDiskCover(a).then(function (hit) {
        if (!hit) return;
        a.hasCover = true; coverState.hasCover = true;
        App.coverURLFor(a).then(renderCover);
      });
    }

    var galleryBox = el('div', { class: 'gallery' });
    function renderGallery() {
      galleryBox.innerHTML = '';
      if (!galleryImages.length) { galleryBox.appendChild(el('div', { class: 'multi-empty', text: '暂无商品图集' })); return; }
      galleryImages.slice(0, 12).forEach(function (u) {
        var im = el('img', { src: u, alt: '商品图', loading: 'lazy' });
        im.onerror = function () { im.style.display = 'none'; };
        galleryBox.appendChild(el('button', {
          class: 'gallery-item', type: 'button', title: '设为封面',
          onclick: function () { manualCoverEdit = true; coverState.url = u; coverState.blob = null; coverState.removed = false; coverURLInput.value = u; renderCover(); }
        }, [im]));
      });
    }
    renderGallery();

    var fileInput = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onchange: function () {
      var f = fileInput.files && fileInput.files[0]; if (!f) return;
      compressImage(f, App.settings.imageMaxWidth, App.settings.imageQuality).then(function (b) {
        manualCoverEdit = true; coverState.blob = b; coverState.removed = false; renderCover();
        Toast.ok('封面已压缩：' + fmtSize(f.size) + ' \u2192 ' + fmtSize(b.size));
      }).catch(function (e) { Toast.err('图片处理失败：' + e.message); });
      fileInput.value = '';
    } });

    var coverURLInput = el('input', { class: 'input', value: coverState.url, placeholder: '或粘贴图片 URL', oninput: function () {
      manualCoverEdit = true; coverState.url = coverURLInput.value.trim(); renderCover();
    } });

    var coverBox = el('div', { class: 'cover-editor' }, [
      coverPreview,
      el('div', { class: 'cover-btns' }, [
        el('button', { class: 'btn btn-sm', type: 'button', onclick: function () { fileInput.click(); } }, ICONS.label('\u{1F4C1} 本地上传')),
        el('button', {
          class: 'btn btn-sm btn-danger-ghost', type: 'button', onclick: function () {
            manualCoverEdit = true; coverState.blob = null; coverState.url = ''; coverState.removed = true;
            coverURLInput.value = ''; renderCover();
          }
        }, ICONS.label('\u{1F5D1} 清除封面')),
        fileInput
      ]),
      coverURLInput
    ]);


    /* 三个 AI 翻译按钮上提为变量，分别挂到各自字段标签的右侧（labelRight） */
    var aiTitleBtn = el('button', {
      class: 'btn btn-xs btn-ghost', type: 'button', title: '翻译原标题并写入显示标题',
      onclick: function () {
        var src = titleOrig.value.trim() || titleInput.value.trim();
        if (!src) { Toast.warn('没有可翻译的标题'); return; }
        AI.translateText(src, function (m) { console.log('[AI]', m); }).then(function (zh) {
          if (zh && zh.length <= 60) { titleInput.value = zh; Toast.ok('标题已翻译并填入显示标题'); }
        }).catch(function (e) { Toast.err(e.message || '翻译失败'); });
      }
    }, ICONS.label('\u{1F916} AI 翻译标题'));

    var aiDescBtn = el('button', {
      class: 'btn btn-xs btn-ghost', type: 'button', title: '通过 DeepSeek 把简介翻译成中文（原文日文/英文时使用）',
      onclick: function () {
        var src = descInput.value.trim();
        if (!src) { Toast.warn('简介为空'); return; }
        if (/[\u4E00-\u9FFF]/.test(src) && !/[\u3040-\u30FF]/.test(src)) { Toast.info('简介看起来已是中文'); return; }
        Toast.info('AI 翻译简介中 …');
        AI.translateText(src, function (m) { console.log('[AI]', m); }).then(function (zh) {
          if (zh) { descInput.value = zh; Toast.ok('简介已翻译为中文'); }
        }).catch(function (e) { Toast.err(e.message || '翻译失败'); });
      }
    }, ICONS.label('\u{1F916} AI 翻译简介'));

    var aiNoteBtn = el('button', {
      class: 'btn btn-xs btn-ghost', type: 'button', title: '通过 DeepSeek 把备注翻译成中文',
      onclick: function () {
        var src = noteInput.value.trim();
        if (!src) { Toast.warn('备注为空'); return; }
        Toast.info('AI 翻译备注中 …');
        AI.translateText(src, function (m) { console.log('[AI]', m); }).then(function (zh) {
          if (zh) { noteInput.value = zh; Toast.ok('备注已翻译为中文'); }
        }).catch(function (e) { Toast.err(e.message || 'AI 翻译失败'); });
      }
    }, ICONS.label('\u{1F916} AI 翻译备注'));

    /* ---------------- 组装 ---------------- */
    var body = el('div', { class: 'form' }, [
      el('div', { class: 'form-section' }, [
        el('div', { class: 'section-title' }, [ICONS.label('\u{1F4E5} 从商品链接填充信息 '), modeBadge]),
        el('div', { class: 'fetch-row' }, [fetchInput, openPageBtn, forceBtn, switchModeBtn]),
        fetchHint,
        pasteWrap,
        logBox
      ]),

      el('div', { class: 'form-grid' }, [
        el('div', { class: 'form-col' }, [
          el('div', { class: 'section-title'}, ICONS.label('\u{1F4DD} 基本信息')),
          Field.row('显示标题 *', titleInput, '作为卡片主标题显示', aiTitleBtn),
          (function () {
            /* 原标题这一行要多挂一条动态提示（正在获取 / 已获取 / 不覆盖），
             * Field.row 的 hint 只吃字符串，所以拿到节点后自己追加。 */
            var row = Field.row('原标题', titleOrig, '在卡片上以小字显示于自定义标题下方');
            var ctrl = row.querySelector('.field-control');
            if (ctrl) ctrl.appendChild(titleAutoHint);
            return row;
          })(),
          /* 来源与分类并成一行（仅此处两栏） */
          el('div', { class: 'form-two' }, [
            Field.row('来源 *', el('div', {}, [srcSelect, srcCustomRow])),
            Field.row('分类 *', catSelect)
          ]),
          el('div', { id: 'charNameField', class: 'avatar-field', style: { display: 'none' } }, [
            el('div', { class: 'section-title'}, ICONS.label('\u{1F464} 角色名（中 / 日 / 英）')),
            Field.row('中文名', charNameZh, '保存时：自动注册角色；移除其他素材中同名的标签，并加入它们的「支持角色」'),
            Field.row('日文名', charNameJa),
            Field.row('英文名（角色模型必填）', charNameEn, '角色模型素材必须填写英文角色名，创建存储路径/下载文件时用作文件夹名')
          ]),
          Field.row('商店链接', linkEditor, '可添加多个链接'),
          fileIdBox,
          Field.row('作者 / 店铺', authorInput),

          Field.row('状态', el('div', { class: 'inline-row' }, [
            el('label', { class: 'check' }, [giftCheck, el('span', { text: '获赠' })]),
            el('label', { class: 'check' }, [favCheck, el('span', { text: '喜欢' })]),
            el('label', { class: 'check' }, [hideCheck, el('span', { text: '隐藏（不在默认列表显示）' })])
          ]), '获赠会显示专属角标与筛选标签（BOOTH 获赠页同步时自动识别，可手动改）'),
          Field.row('上架日期', publishedAtInput, '商品发布 / 上架日期（YYYY-MM-DD），详情页「商品信息」里显示（卡片封面不再显示）'),
          Field.row('商品简介', el('div', {}, [descInput]), null, aiDescBtn),
          Field.row('备注', noteInput, null, aiNoteBtn),
        ]),
        el('div', { class: 'form-col' }, [
          el('div', { class: 'section-title'}, ICONS.label('\u{1F5BC} 封面图')),
          coverBox,
          el('div', { class: 'section-title'}, ICONS.label('\u{1F5BC} 商品图集（点击设为封面）')),
          galleryBox,
          el('div', { class: 'section-title'}, ICONS.label('\u{1F3F7} 标签')),
          tagEditor,
          el('div', { id: 'avatarField', class: 'avatar-field' }, [
            el('div', { class: 'section-title avatar-title' }, [
              el('span', null, ICONS.label('\u{1F9CD} 支持的角色')),
              el('button', {
                class: 'btn btn-xs btn-ghost', type: 'button', title: '清空全部已选角色',
                onclick: function () { avatarPicker.setValue([]); }
              }, ICONS.label('\u{1F9F9} 清空'))
            ]),
            avatarPicker,
            el('div', { class: 'field-hint', text: '当素材本身就是角色模型（分类＝角色模型）时，该字段自动隐藏——不需要再写「支持角色」。' })
          ]),

        ])
      ]),

      el('div', { class: 'form-section', id: 'downloadSection' }, [
        el('div', { class: 'section-title'}, ICONS.label('\u{1F4C1} 本地文件与下载')),
        Field.row('网盘', cloudInput, '仅作记录与角标提示，不会自动上传'),
        Field.row('本地文件路径', el('div', {}, [
          pathEditor,
          el('div', { class: 'btn-row' }, [
            el('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: function () { Importer.attachLocalDialog(a, pathEditor, { prepare: syncFormBasics, persist: persistImportedPaths }); } }, ICONS.label('\u{1F4E5} 导入已有文件 / 文件夹')),
            el('button', { class: 'btn btn-sm', type: 'button', title: '只创建存储路径并打开资源管理器，由你自己移动文件进去', onclick: function () { Importer.createStoragePathOnly(a, pathEditor, { prepare: syncFormBasics, persist: persistImportedPaths }); } }, ICONS.label('\u{1F4C1} 仅创建路径并打开文件夹'))
          ]),
          el('div', { class: 'drop-zone' }, [
            ICONS.make('folder', { size: 18 }), el('span', { text: '将文件 / 文件夹拖到这里快速导入（成功后自动保存素材）' })
          ])
        ]), '导入会把文件复制进素材库（分类/素材名），写入可打开的绝对路径并自动保存素材；之后「打开文件」直接定位。'),
        Field.row('版本 / 变体', versionEditor, '每个版本只保留「名称 + BOOTH / Gumroad 订单链接」；有订单链接 = 已购买（正常显示，价格按已购变体价合计），没有 = 未购买（灰色，取当前变体价）。'),
        Field.row('下载链接', dlEditor, '记录直链后可在详情页一键下载'),
      ]),


    ]);


    onSourceChange();
    onCategoryChange();
    refreshModeUI();
    syncFileId();

    // BOOTH / Gumroad 源缺少有效变体（没有带订单链接的版本）时：打开编辑页自动获取一次（成功标记锁定，失败不打扰）
    var credsAuto = App.settings.credentials || {};
    var hasCookieAuto = Object.keys(credsAuto).some(function (h) { return credsAuto[h] && credsAuto[h].cookie; });
    var shopLink = !isNew && (a.links || []).filter(function (l) { return isHttpUrl(l.url); })[0];
    var autoSourceOk = a.source !== 'xianyu' && a.source !== 'friend' && !App.isFriend(a);
    var hasValidVersion = (a.versions || []).some(function (v) { return v.orderUrl && v.orderUrl.trim() && !v.special; });
    var isOrderSite = a.source === 'booth' || a.source === 'gumroad';
    var epEdit = App.effectivePrice(a);
    var freeAssetEdit = a.isFree === true || !!(epEdit && epEdit.value === 0);
    var needVariantAuto = !isNew && isOrderSite && autoSourceOk && shopLink && !freeAssetEdit && !a.delisted && !Importer.autoEnrichBusy() &&
      !(a.autoFilled && a.autoFilled.versions) && !hasValidVersion;
    var needCookieAuto = !isNew && App.settings.autoCookieFetch && hasCookieAuto && shopLink && autoSourceOk && !a.delisted &&
      !(a.versions || []).length && !(a.downloadLinks || []).length;
    /* 两条自动补齐都要过限流闸（`Importer.autoEnrichGate`）：该站没 Cookie 就不发请求，
     * 同一条素材失败过就按冷却退避 —— 反复开编辑页不该变成对 BOOTH 的连发。 */
    var gateVariant = needVariantAuto ? Importer.autoEnrichGate(a) : { ok: false };
    var gateCookie = needCookieAuto ? Importer.autoEnrichGate(a, { ignoreSetting: true }) : { ok: false };
    if (gateVariant.ok) {
      setTimeout(function () {
        Importer.autoEnrichTouch(a.id);            // 先记一次尝试：中途失败也走冷却，不每次都重来
        log('\u{1F510} 检测到 ' + (a.source === 'gumroad' ? 'Gumroad' : 'BOOTH') + ' 素材缺少已购变体，自动获取版本 / 变体 …');
        /* 打开编辑页的自动补齐：走强制联网（不吃缓存），但不覆盖已填字段 ——
         * 静默动作覆盖用户改过的东西，等于页面一开就自己变样 */
        doFetch({ forceNetwork: true, noCache: true, forceFill: false, silent: true });
      }, 900);
    } else if (needVariantAuto && !gateVariant.ok) {
      if (gateVariant.why === 'cooldown') log('\u{1F634} 这条素材刚自动补全过（' + gateVariant.tries + ' 次未成功），按冷却跳过，稍后可手动点「强制联网填充」。');
      else if (gateVariant.why === 'no-cookie') log('\u{1F36A} 还没保存 ' + (a.source === 'gumroad' ? 'Gumroad' : 'BOOTH') + ' 的 Cookie，自动补全跳过（读不到订单页，跑了也没用）。');
      else if (gateVariant.why === 'off') log('\u{1F6E1} 「自动补全版本与变体」已关闭，跳过。');
    } else if (Importer.autoEnrichBusy() && !isNew && isOrderSite) {
      log('\u26A0 详情页正在自动获取变体信息，编辑页本次自动操作已跳过，避免冲突。');
    } else if (gateCookie.ok) {
      setTimeout(function () {
        Importer.autoEnrichTouch(a.id);
        log('\u{1F510} 检测到已保存 Cookie，自动获取已购版本与价格 …');
        /* 打开编辑页的自动补齐：走强制联网（不吃缓存），但不覆盖已填字段 ——
         * 静默动作覆盖用户改过的东西，等于页面一开就自己变样 */
        doFetch({ forceNetwork: true, noCache: true, forceFill: false, silent: true });
      }, 700);
    }

    if (opts.focusDownload) {
      setTimeout(function () {
        var sec = $('#downloadSection');
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
        var first = dlEditor && dlEditor.querySelector && dlEditor.querySelector('input');
        if (first) { first.focus(); first.placeholder = '粘贴下载直链或「文件夹导入」补全本地文件'; }
      }, 350);
    }

    var saving = false;
    var saveBtn = null;
    function save() {
      if (saving) return;
      if (!titleInput.value.trim()) { Toast.warn('请填写自定义标题'); titleInput.focus(); return; }
      if (catSelect.value === 'avatar' && !charNameEn.value.trim()) {
        Toast.warn('角色模型素材必须填写英文角色名（生成存储路径时使用）', 4200);
        charNameEn.focus();
        return;
      }
      saving = true;
      saving = true;
      /* 标题 / 角色名变化会连磁盘上的素材文件夹一起改名，改名期间必须锁住按钮 ——
       * 否则连点两次会在「旧名→新名」还没完成时又按旧名算一遍。delay > 0 时额外冷却一会儿再放开。 */
      function resetSaving(delay) {
        if (!saveBtn) { saving = false; return; }
        saveBtn.disabled = true;
        setTimeout(function () {
          saving = false;
          if (saveBtn) { saveBtn.disabled = false; ICONS.apply(saveBtn, ('\u{1F4BE} 保存')); }
        }, delay > 0 ? delay : 0);
      }
      if (saveBtn) { saveBtn.disabled = true; ICONS.apply(saveBtn, ('\u23F3 保存中 …')); }
      /* 30 秒兜底：真遇上死等也把按钮放回来，不会永远「保存中」 */
      var saveWatchdog = setTimeout(function () {
        if (!saving) return;
        resetSaving(0);
        Toast.warn('保存耗时异常，已中止等待；请检查素材库目录后重试', 6000);
      }, 30000);
      var catBeforeSave = a.category;
      a.title = titleInput.value.trim();
      a.originalTitle = titleOrig.value.trim();
      a.source = srcSelect.value;
      a.sourceCustom = srcCustom.value.trim();
      a.category = catSelect.value;
      /* 分类换了：把库内文件夹搬到新分类目录（库外路径不动） */
      if (catBeforeSave !== a.category) { App.relocateToCategory(a, catBeforeSave).catch(function () {}); }
      /* 以编辑器的值为准：若再与原始 links 求并集，删掉的链接保存时会被并回来，永远删不掉 */
      a.links = linkEditor.getValue();
      /* 编号：有 BOOTH 商品号以它为准，否则沿用已存的；都没有（新建）才现生成。
       * 不从输入框取值 —— 那个框是只读的，取值只会把显示值写回去。 */
      a.fileId = boothIdNow() || String(a.fileId || '').trim()
        || Store.newFileId(App.fileIdTakenMap(a.id));
      a.downloadLinks = dlEditor.getValue();
      a.versions = versionEditor.getValue();
      // 已购买 = 有订单链接，自动派生，不提供勾选
      var purchased = (a.versions || []).filter(function (v) { return v.orderUrl && v.orderUrl.trim(); });
      var activeList = purchased.map(function (v) { return v.id; });
      a.activeVersions = activeList;
      a.activeVersion = activeList[0] || '';
      // BOOTH 商品价 = 已购变体计算价（无已购买 = 0）
      if (srcSelect.value === 'booth') {
        // 商品价不再记录（变体价现算），这里只保留提示
      }
      // 有效价格：购买价优先；否则 BOOTH 用变体商品价；其他来源商品价仅展示
      var eff = App.effectivePrice(Store.normalizeAsset(a));
      var allUnpurchased = App.purchaseState(Store.normalizeAsset(a)) === 'unpurchased';
      if (eff && eff.text) {
        a.price = eff.text;
        a.priceValue = eff.value;
        a.currency = eff.currency || a.currency;
        // 没有免费变体且全部变体未购买：不按免费处理（显示「未购买」特殊标签）
        a.isFree = (App.isFriend(a) || a.gifted || allUnpurchased) ? null : (eff.value === 0);
      } else {
        a.price = ''; a.priceValue = null; a.isFree = null;
      }
      a.paths = (pathEditor.getValue() || []).slice(0, 1);   // 只保留第一条
      a.tags = tagEditor.getValue();
      a.rawTags = tagEditor.getRaw();
      a.avatars = avatarPicker.getValue();
      a.charNameZh = charNameZh.value.trim();
      a.charNameJa = charNameJa.value.trim();
      a.charNameEn = charNameEn.value.trim();
      a.author = authorInput.value.trim();
      a.cloudUrl = cloudInput.value.trim();
      a.description = descInput.value.trim();
      a.images = galleryImages.slice();   // 图集全量保存，不截断
      a.note = noteInput.value;
      a.gifted = giftCheck.checked;
      a.favorite = favCheck.checked;
      a.hidden = hideCheck.checked;
      /* 清空上架日期必须落成空串：退回旧值会让日期只能改不能删 */
      a.publishedAt = publishedAtInput.value ? new Date(publishedAtInput.value + 'T00:00:00').toISOString() : '';
      a.coverURL = coverState.removed ? '' : (coverState.url || '');
      /* 是否会动磁盘目录：只有已存在的素材、且文件夹名真的变了才算 */
      var renaming = !isNew && orig && App.folderName(orig) !== App.folderName(a);
      if (renaming && saveBtn) ICONS.apply(saveBtn, ('\u23F3 改名中 …'));

      // 字段级「用户修改」标记：与打开时（或上次自动填充后）的基线比较，变化就标记 userEdited
      a.userEdited = a.userEdited || {};
      function markEdited(key, changed) { if (changed) a.userEdited[key] = true; }
      markEdited('title', dirtyScalar('title', function () { return titleInput.value; }));
      markEdited('titleOrig', dirtyScalar('titleOrig', function () { return titleOrig.value; }));
      markEdited('author', dirtyScalar('author', function () { return authorInput.value; }));
      markEdited('desc', dirtyScalar('desc', function () { return descInput.value; }));
      markEdited('category', dirtyScalar('category', function () { return catSelect.value; }));
      markEdited('source', dirtyScalar('source', function () { return srcSelect.value; }));
      markEdited('sourceCustom', dirtyScalar('sourceCustom', function () { return srcCustom.value; }));
      markEdited('shopUrl', dirtyHidden('shopUrl'));
      markEdited('itemId', dirtyHidden('itemId'));
      markEdited('publishedAt', dirtyHidden('publishedAt'));
      markEdited('shopUpdatedAt', dirtyHidden('shopUpdatedAt'));
      markEdited('purchasePrice', String(a.purchasePrice == null ? '' : a.purchasePrice) !== String(baseOf('purchasePrice', function (v) { return v == null ? '' : v; })));
      markEdited('purchaseCurrency', String(a.purchaseCurrency || '') !== String(baseOf('purchaseCurrency', function (v) { return v || ''; })));
      markEdited('gifted', !!a.gifted !== !!orig.gifted);
      markEdited('tags', dirtyList('tags', function () { return tagEditor.getValue(); }));
      markEdited('raws', dirtyList('raws', function () { return tagEditor.getRaw(); }));
      markEdited('avatars', dirtyList('avatars', function () { return avatarPicker.getValue(); }));
      markEdited('images', JSON.stringify(galleryImages) !== String(baseOf('images', function (v) { return v; })));
      markEdited('dls', dirtyList('dls', function () { return dlEditor.getValue(); }));
      markEdited('versions', dirtyList('versions', function () { return versionEditor.getValue(); }));
      markEdited('cover', dirtyScalar('cover', function () { return coverState.removed ? '[removed]' : (coverState.blob ? '[local]' : coverState.url); }));

      function commit(target, coverBlob, coverRemoved) {
        var step = Promise.resolve(target);
        // 角色模型 + 角色名：全局联动（注册角色、清理其他素材同名标签、加入支持角色）
        if (target.category === 'avatar' && (target.charNameZh || target.charNameJa || target.charNameEn)) {
          step = App.registerCharacter(target, { zh: target.charNameZh, ja: target.charNameJa, en: target.charNameEn });
        }
        step = step.then(function (t) {
          if (coverBlob) {
            t.hasCover = true; t.coverCleared = false; App.dropCover(t.id);
            // 封面确定后自动写进素材本地路径：Unity 按商品 ID 读的就是这个文件
            return Store.putCover(t.id, coverBlob).then(function () {
              return App.saveCoverToPath(t, coverBlob).then(function () { return t; });
            });
          } else if (coverRemoved) {
            t.hasCover = false; t.coverCleared = true; App.dropCover(t.id);
            return Store.deleteCover(t.id).then(function () { return t; });
          }
          return t;
        });
        return step.then(function (t) { return App.save(t); }).then(function () {
          clearTimeout(saveWatchdog); resetSaving(renaming ? 900 : 0);
          Modals.refreshAfterChange(target);
          Toast.ok(isNew ? '已添加素材「' + target.title + '」' : '已保存修改');
        }).catch(function (e) {
          clearTimeout(saveWatchdog); resetSaving(0);
          Toast.err('保存失败：' + (e.message || e));
        });
      }

      // 重复素材合并：商品 ID / 链接 / 标题命中已有素材时，直接并入（并标注多个来源）
      var dup = isNew ? App.findDuplicate(a, false) : null;
      if (dup) {
        Modal.confirm(
          '检测到可能重复的素材「' + (dup.title || dup.originalTitle) + '」。是否把当前内容合并进已有条目？（商品 ID / 链接 / 标题一致，来源会同时保留并标注）',
          { okText: '合并到已有素材', focusOk: true }
        ).then(function (ok) {
          if (!ok) { commit(a, coverState.blob, coverState.removed); return; }
          var merged = App.mergeAssets(dup, a);
          // 新封面优先于旧封面
          commit(merged, coverState.blob, coverState.removed);
        });
        return;
      }
      commit(a, coverState.blob, coverState.removed);
    }

    /** 导入/创建路径前把表单里的基本字段同步到 a：拖拽/按钮导入会用当前分类、标题和角色英文名生成素材库目录 */
    function syncFormBasics() {
      var catBeforeSave = a.category;
      a.title = titleInput.value.trim();
      a.originalTitle = titleOrig.value.trim();
      a.category = catSelect.value;
      a.source = srcSelect.value;
      a.sourceCustom = srcCustom.value.trim();
      a.charNameZh = charNameZh.value.trim();
      a.charNameJa = charNameJa.value.trim();
      a.charNameEn = charNameEn.value.trim();
    }

    /** 导入成功后自动保存素材，让新写入的本地路径立即生效（即使之后点了取消也不丢路径） */
    function persistImportedPaths() {
      syncFormBasics();
      if (!a.title) {
        Toast.warn('已写入本地路径，但请先填写自定义标题再保存，素材信息才会生效', 6200);
        return Promise.resolve(false);
      }
      return App.save(a).then(function () {
        Modals.refreshAfterChange(a, { keepModal: true });
        return true;
      }).catch(function (e) {
        Toast.err('自动保存失败：' + (e && e.message ? e.message : e));
        return false;
      });
    }

    var h = Modal.open({
      title: isNew ? '添加素材' : '编辑素材',
      size: 'lg',
      body: [body],
      onClose: function () {   // 关弹窗时回收封面预览 blob URL
        if (coverPreviewURL) { try { URL.revokeObjectURL(coverPreviewURL); } catch (e) {} coverPreviewURL = ''; }
      },
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '取消'),
        (saveBtn = el('button', { class: 'btn btn-primary', onclick: save }, ICONS.label('\u{1F4BE} 保存')))
      ]
    });
    // DOM 挂载后再根据分类切换「角色名 / 支持角色」字段显隐 + 绑定拖拽导入
    setTimeout(onCategoryChange, 0);
    setTimeout(function () {
      var dz = $('#downloadSection .drop-zone');
      if (dz) {
        ['dragover', 'dragenter'].forEach(function (ev) {
          dz.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); dz.classList.add('over'); });
        });
        ['dragleave', 'drop'].forEach(function (ev) {
          dz.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); dz.classList.remove('over'); });
        });
        dz.addEventListener('drop', function (e) {
          Importer.attachDropped(a, pathEditor, e.dataTransfer, { prepare: syncFormBasics, persist: persistImportedPaths });
        });
      }
    }, 0);
    setTimeout(function () { (isNew ? fetchInput : titleInput).focus(); }, 80);
  }
};
