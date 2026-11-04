/* ============ 70-forms.js ============ */
/* =====================================================================
 * 70-forms.js  —  素材详情视图 / 新增·编辑表单 / 信息获取交互
 *   抓取交互遵循「默认手动粘贴源码（零外部请求）」
 * ===================================================================== */

var Modals = {

  /**
   * 素材变更后的统一刷新入口（保存 / 自动补全 / 导入自动保存共用，避免多种刷新行为）：
   *   renderAll → 定位并稳定显示目标卡片；
   *   keepModal=false 时关闭当前弹窗；
   *   reopenDetail=true 时关闭后重新打开详情（用于详情页触发的后台自动补全）。
   */
  refreshAfterChange: function (target, opts) {
    opts = opts || {};
    /* v2.5.2：素材改完时**不要**无脑「重新定位」——只要它还在当前页的网格里，就静默刷新，
     * 不换页、不滚动、不抢视线（用户原话：不会触发排序变化时就不要从头定位）。
     * 只有它被筛掉 / 被排到别的页了，才走 revealAsset 去把它找出来。 */
    var wasOnPage = !!(target && target.id && document.querySelector('.card[data-id="' + target.id + '"]'));
    /* v5.2（用户要求）：编辑一条素材时，只要那张卡还在屏幕上，就只换这一张，不动整页。 */
    if (wasOnPage && !opts.keepModal && target && target.id && UI.refreshCard && UI.refreshCard(target.id)) {
      /* v5.7：只换卡片也要把编辑弹窗关掉；关掉之后若底下还压着这条素材的详情页，
       * 详情页里的「存储路径 / 标题」也得跟着重建 —— 否则看到的还是改名前的旧路径。 */
      Modal.closeTop();
      if (App.refreshAssetView) App.refreshAssetView(target);
      return;
    }
    var keepY = (typeof window !== 'undefined') ? (UI.sY()) : 0;   // v2.5.2：重渲染前记住滚动位置
    UI.renderAll();
    var stillOnPage = !!(target && target.id && document.querySelector('.card[data-id="' + target.id + '"]'));
    /* v2.5.3 修复：只有「原地不动」时才做 140ms 后的滚动兜底。
     * 目标被筛掉 / 被排到别的页时要走 revealAsset 定位，而这个定时器会在 80ms 定位之后把它拽回旧位置
     * ——「编辑后目标不在当前页 → 瞬间定位」就会失效（用户看到的是回到旧位置）。 */
    var willReveal = !opts.keepModal && !!(target && target.id) && !(wasOnPage && stillOnPage);
    if (typeof window !== 'undefined' && keepY) {
      UI.scrollTo(keepY);                                                                        // 渲染后立刻还原
      if (!willReveal) setTimeout(function () { UI.scrollTo(keepY); }, 140);                      // 卡片/封面加载后文档变高，再无声兜一次（否则可能被钳到顶部）
    }
    if (opts.keepModal) {
      /* v3.0.0 修复「弹窗劫持」（P1）：原地刷新**只允许**更新「用户当前正在看的那个素材」的详情弹窗。
       * 旧判据只看「顶层是不是详情弹窗」——用户正看着 B 的详情时，A 的后台任务（自动补全 / 重新解析 /
       * 简介汉化 / 封面补写）一完成就会把弹窗内容换成 A（顶层的 handle 不变，只是原地重建了内容）。
       * 现在必须素材 id 一致（App.detailAssetId 由 Modals.syncDetailId 维护）；不是同一个素材就只保留
       * 上面已经做完的网格刷新，**绝不碰别人的弹窗**（不重开、不滚动、不改内容）。 */
      var top = Modal.stack && Modal.stack.length ? Modal.stack[Modal.stack.length - 1] : null;
      var sameDetail = !!(top && top.kind === 'detail' && target && target.id && App.detailAssetId === target.id);
      if (sameDetail) Modals.detail(target.id, top, { noAutoEnrich: true });
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

  /** v3.0.0：同步「当前详情弹窗展示的是哪一个素材」→ App.detailAssetId（栈顶往下第一个详情弹窗）。
   *  打开详情 / 原地更新详情 / 关闭详情后都要调用；没有详情弹窗时置空串。
   *  这是 refreshAfterChange(keepModal) 判定「能不能原地更新」的唯一依据——
   *  后台任务完成时绝不允许把用户正在看的**另一个**素材的详情窗换成目标素材。 */
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

  /** v2.3.21：更新日志（点顶栏版本号打开）——按次版本号（2.3 / 2.2 / …）聚合，功能为主、修复一句带过 */
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
  detail: function (id, targetHandle, opts) {
    opts = opts || {};   // v2.5.3：noAutoEnrich=true 时不再自动补全（防「刷新详情 → 再次判定 → 再次补全」死循环）
    var a = App.assets.find(function (x) { return x.id === id; });
    if (!a) { Toast.err('未找到该素材'); return; }
    /* v2.5.14（用户批复 · 修3）：打开详情页就顺手把封面补写到磁盘（covers 目录 + 素材文件夹），
     * 缺哪补哪、静默；浏览器里没有 blob 时允许联网补抓一次。不阻塞界面。 */
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
    // v2.5.2：section 支持右上角动作节点（如「版本与下载」标题右侧的「重新解析」）
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
    // v2.3.5：应用内没有封面时，按商品ID 从素材本地路径认领（命中即当封面显示并写入封面缓存）
    if (!a.hasCover && !a.coverURL) {
      App.adoptDiskCover(a).then(function (hit) {
        if (!hit) return;
        App.coverURLFor(a).then(function (url) {
          if (!url) return;
          cover.innerHTML = '';
          cover.appendChild(el('img', { src: url, alt: title }));
          // v2.3.16：只把这一张卡片的封面补上，不做整列表重渲染（重渲染会打断滚动/闪烁，也让人以为「又刷新了一次」）
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

    /** 无存储路径时先静默创建，再通过宿主直接下载；不再跳转打开下载页面 */
    function ensureAndDownload(url, name, btn, opts) {
      opts = opts || {};
      if (!isHttpUrl(url)) { Toast.warn('下载链接无效'); return; }
      function labelNode() { return btn ? (btn.querySelector('.dl-label') || btn) : null; }
      var origLabel = labelNode() ? String(labelNode().textContent || '') : '';
      function setLabel(txt) { var t = labelNode(); if (t) ICONS.apply(t, txt); }
      if (btn) { btn.disabled = true; setLabel('\u23F3 下载中 …'); }
      function restore() { if (btn) { btn.disabled = false; setLabel(origLabel || '\u2B07 下载'); } }
      // v2.3.4：不再直接下载，改为入队（由下载队列执行，悬浮窗显示进度；v2.3.13 起可并发，默认 4）
      Importer.ensureStoragePathQuiet(a).then(function (folderPath) {
        if (!folderPath) { Toast.err('无法创建存储路径，已取消下载。请检查「设置 → 本地库与整理」的素材库根目录与内置宿主状态。', 6200); restore(); return; }
        var dst = joinWinPath(folderPath, [name || 'download']);
        var queued = DLQueue.enqueue({ url: url, name: name || '下载文件', dst: dst, assetId: a.id,
          overwrite: !!opts.overwrite, expectSize: opts.expectSize || 0 });
        if (queued && queued.state === 'running') {   // v2.5.1（P1）：正在下的文件不重复入队
          Toast.info('该文件正在下载中，稍后再点「重新下载」', 3600);
          restore();
          return;
        }
        // v2.3.10：入队后按队列真实状态刷新（排队中 → 下载中 xx%），不再写死「排队中」
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
        var doDel = function () { App.remove(a.id).then(function () { Modal.closeTop(); UI.renderAll(); Toast.ok('已删除该素材'); }); };
        if (App.settings.confirmDelete) Modal.confirm('确定要删除「' + title + '」吗？此操作不可撤销。', { okText: '删除' }).then(function (ok) { if (ok) doDel(); });
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

    /* v2.5.8（用户反馈）：这段是**上方按钮的注释**，必须紧贴按钮、并以 * 起头（不能飘在头部下方远处）。 */
    var hint = el('div', { class: 'action-hint', text: '* ' +
      ((a.paths || []).length ? '已关联本地路径，点击「打开文件」定位；有多个路径时在下方逐个打开。'
      : ((a.downloadLinks || []).length ? '尚未关联本地路径——先去下载，下载后请登记路径或使用「文件夹导入」。'
      : '尚未关联本地路径，也没有下载链接——先补充下载链接（也可直接手动导入本地文件）。')) });

    // 标签 / 角色 / 链接 / 版本 / 路径节点
    var tagChips = App.displayTags(a).length ? el('div', { class: 'chip-wrap' }, App.displayTags(a).map(function (t) {
      var tstate = UI.tagFilterState(t);
      return el('span', { class: 'tag tag-click' + (Smart.isUntranslated(t) ? ' tag-untrans' : '') + UI.tagFilterClass(tstate),
        title: UI.tagFilterTitle(t, tstate),
        /* v3.0.0（用户要求）：详情页标签也走三态（不再「替换成只筛这一个」）：默认 → 必须包含 → 排除 → 默认 */
        onclick: function () { Modal.closeTop(); UI.cycleTagFilter(t); } },
        t + (Smart.isUntranslated(t) ? '（待翻译）' : ''));
    })) : null;

    var avatarChips = !isAvatar && App.filterAvatars(a).length ? el('div', { class: 'chip-wrap' },
      App.filterAvatars(a).map(function (v) { return el('span', { class: 'chip chip-av' }, App.avatarLabel(v)); })) : null;

    /** BOOTH 商品链接统一显示成中文页。实测两条硬规则：
     *   · 主域名：语言段是必需的——https://booth.pm/items/8842608 → 404，https://booth.pm/zh-cn/items/8842608 → 200
     *   · 自定义店铺：语言段反而是错的——https://r2f.booth.pm/zh-cn/items/8783321 → 404（ja / en 同样 404），
     *     必须是不带语言段的 https://r2f.booth.pm/items/8783321 → 200
     *  所以只对主域名加 zh-cn；自定义店铺保持原样，并顺手去掉历史误加的语言段。 */
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
    var unpurchasedVer = (a.versions || []).filter(function (v) { return !isPurchasedVer(v) && !v.special; });
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
    // v2.5.2：商品价不再显示（变体价更准）——详情页不再有「已购买 N 个版本，合计 …」这行
    var activeTotalNode = null;

    // 「获取更新」：手动解析已购版本订单页里的下载文件（订单链接存在但 files 尚未解析时补充）
    // v2.5.0：改为共用 Importer.applyOrderFilesToVersion（批量获取更新走同一份逻辑）
    function orderFilesFromItem(it, v) { return Importer.applyOrderFilesToVersion(it, v); }
    // v2.5.0：常驻黄色「获取更新」——首次点它补全缺失文件，之后点它刷新已解析的文件（含作者新上传的文件）
    /** v2.5.1：抓商品页——BOOTH 走公开 JSON；Gumroad 走商品页 data-page；抓不到返回 null */
    function fetchItemInfo() {
      if (typeof Net === 'undefined' || !Net.networkAllowed()) return Promise.resolve(null);
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
    /* v2.5.1：只要这条素材还能抓到商品页/订单页，就给「获取更新」入口——
     * 免费素材（没有已购变体）以前完全没有这个按钮，白瞎了「获取更新」。 */
    var canUpdate = purchasedVer.length > 0
      || !!(a.itemId && String(a.itemId).trim())
      || (a.links || []).some(function (l) { return isHttpUrl(l.url); });
    var fetchOrderBtn = canUpdate ? el('button', {
      class: 'btn btn-xs btn-parse', type: 'button',
      title: '重新解析这条素材的商品页与订单页：刷新所有变体（含免费变体）的下载文件、未购变体的当前价，并补上作者新增的变体与免费下载',
      onclick: function () {
        var targets = purchasedVer.slice();
        fetchOrderBtn.disabled = true; ICONS.apply(fetchOrderBtn, ('\u23F3 获取更新 …'));
        var urls = uniq(targets.map(function (v) { return v.orderUrl; }).filter(Boolean));
        var orderP = Promise.all(urls.map(function (url) {
          return Net.fetchText(url, { forceNetwork: true, onLog: function () {} }).then(function (r) {
            if (!r || !r.ok || !r.text) return { url: url, item: null };
            var parsed = Importer.parseOrderPage(url, r.text);
            var items = parsed.items;
            if (!items.length) return { url: url, item: null };
            /* v2.5.2：不做「无脑取第一条」——那会把别的商品的条目并进本条素材（会表现成「详情页变成另一个商品」）。
             * 仍接受的情况：① itemId 对得上；② 订单页只有一条（一个订单页通常就一件商品）；③ 条目没带 itemId。
             * 只有「多条且都对不上」才放弃更新。 */
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
        // 订单页（已购变体的文件）+ 商品页（免费变体文件 / 未购当前价 / 新变体 / 公开下载链接）一起刷
        Promise.all([orderP, fetchItemInfo()]).then(function (pack2) {
          var results = pack2[0] || [], info = pack2[1];
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
          if (!touched && !shopN) {
            back();
            Toast.err(targets.length
              ? '未解析到更新：订单页可能需要已登录的 Cookie（设置 → 联网与宿主），或该 Gumroad 下载链接已过期。'
              : '未解析到更新：抓不到商品页（检查内置宿主在线 / 链接是否有效）。', 5600);
            return;
          }
          if (!added && !changed && !shopN) {
            back();
            Toast.info('没有发现更新' + (failed ? '（' + failed + ' 个订单页取不到）' : ''), 4200);
            return;
          }
          return App.save(a).then(function () {
            try { App.ensureCoverOnDisk(a, { quiet: true, allowFetch: true }); } catch (e) {}   // v2.5.14：解析完顺手补写封面
            Modals.refreshAfterChange(a, { keepModal: true });   // v2.3.16：原地静默刷新，不关弹窗、不跳列表
            var shopTxt = shop
              ? ((shop.files ? '；刷新 ' + shop.files + ' 个变体文件' : '') + (shop.priced ? '；未购价 ' + shop.priced + ' 个' : '')
                + (shop.added ? '；新增变体 ' + shop.added + ' 个' : '') + (shop.links ? '；新增下载链接 ' + shop.links + ' 条' : ''))
              : '';
            Toast.ok('已更新：新增 ' + added + ' 个文件' + (changed ? '、刷新 ' + changed + ' 个版本' : '') +
              (failed ? '；' + failed + ' 个订单页取不到' : '') + shopTxt, 5200);
          });
        });
      }
    }, ICONS.label('\u{1F504} 重新解析')) : null;
    // v2.5.2：按钮上移到「版本与下载」标题右侧（右对齐），这里不再需要「已购买版本 / 版本·变体」副标签
    var verSectionNode = purchasedVer.length ? el('div', { class: 'ver-section' }, [
      el('div', { class: 'ver-list' }, purchasedVer.map(function (v) {
        return el('div', { class: 'ver-item on' }, [
          el('div', { class: 'ver-main' }, [
            el('b', { text: v.name || v.fileName || '（未命名版本）' }),
            el('span', { class: 'grow' }),   // v2.5.2：价格靠右对齐（同一行，不占多行）
            el('div', { class: 'field-hint mono' }, [
              el('a', { href: v.orderUrl, target: '_blank', rel: 'noopener', title: v.orderUrl }, '订单链接')
            ])
          ])
        ]);
      }))
    ]) : null;
    // 统一的「已下载」检测：详情页所有下载按钮共用，渲染时按同名文件在存储目录下探测。
    // 存储目录优先取 note=存储路径 的那条，不再只认 paths[0]（技术手册 §51.7）。
    function storageDirOf() {
      var ps = a.paths || [];
      var local = ps.filter(function (x) { return x && x.path && !App.isWebdavPath(x.path); });
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
    /**
     * v2.3.2 统一的「已下载」标记：先按本地记录乐观标记，再用磁盘结果权威覆盖。
     * 之所以不能只等权威结果：FS.hostEnsure() 有 4 秒「刚探测成功」缓存，宿主刚掉线时
     * 它会先返回 true，随后的真实请求失败若被吞掉，按钮就会错误地回到「⬇ 下载」。
     */
    /** v2.5.0：磁盘上已有该文件 → 按钮变浅红「重新下载」（可点，点击时宿主覆盖旧文件） */
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
    function markDownloaded(btn, name) {
      if (!btn || !name) return;
      var known = localKnown(name);
      /* v3.0.3（用户要求「网页端断开宿主后也能验证是否已下载」）：三档判定 ——
       *   ① 宿主可用 → FS.host.exists（权威，行为与改前一致）
       *   ② 宿主离线但浏览器有库根句柄且能读 → FS.diskFileState 内部走 relativePathExists（权威）
       *   ③ 两者都没有 → **静默**保持乐观标记（用户要求：不加「（未校验）」这类标注），但绝不把"无法判定"当成"没下载"。 */
      if (known) markRedownload(btn, '', '此前成功下载过；当前无法确认文件是否还在磁盘上');
      var dir = storageDirOf();
      if (!dir || !FS.diskFileState) return;
      var dst = joinWinPath(dir, [String(name)]);
      var rel = (typeof FS.relPathFromLibrary === 'function') ? FS.relPathFromLibrary(dir, name) : '';
      FS.diskFileState(dst, rel).then(function (st) {
        if (!st || !st.known) return;                               // 第三档：无法判定 → 静默保持乐观标记（不额外标注）
        if (st.exists) {
          markRedownload(btn, dst, st.via === 'fsa' ? '浏览器库目录里已存在（宿主离线，已校验）' : '');
          return;
        }
        markPlainDownload(btn);                                     // 权威结论：磁盘上没有 → 回到「⬇ 下载」
      }).catch(function () {
        if (known) markRedownload(btn, '', '此前成功下载过；校验请求失败，未能确认文件是否还在磁盘上');
      });
    }
    // ---- 下载链接：按变体分组（v2.2.12 重构）----
    // 旧实现把同一批文件分散在「免费下载链接（许可证/readme）」「公开 / 免费下载链接」
    // 「订单页解析出的下载链接」与 downloadLinks 四个互不感知的区块，同一 URL 被渲染 2~3 次
    // （商品 8821023 实测：VRChatDLSS5Cam-win64.zip 出现两行）。现在统一为：
    // 一个变体一个分组、组内挂它自己的文件、历史版本默认折叠、同一 URL 全局只出现一次；
    // 许可证/readme 单独成框。
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
        // v2.5.2：未购变体的价格也显示字母币种（JPY 500），避免 ¥ 的 JPY/CNY 歧义
        /* v2.5.14（用户反馈 · 修5）：重新解析会把 BOOTH 商品页的**裸数字价**（如 1680）写回变体，
         * 空币种时旧实现由 codePriceText 默认成 CNY → 这里显示成「CNY 1,680」。现在按**商店来源**兜底
         * （BOOTH=JPY / Gumroad=USD），0 价直接显示「免费」。 */
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
          ? el('button', { class: 'chip chip-ver-off chip-buy', title: '前往购买：' + txt, onclick: function () { window.open(buyUrl, '_blank', 'noopener'); } }, txt)
          : el('span', { class: 'chip chip-ver-off', title: txt }, txt);
      }))
    ]) : null;

    /* v2.2.12 网盘（WebDAV）：远端目录浏览 / 下载到本地 / 上传本地文件 */
    function openDavBrowser(pStr) {
      var info = App.webdavOf(pStr);
      if (!info || !info.account) {
        Toast.warn('找不到 WebDAV 账号「' + (info ? info.label : '') + '」：请先在 设置 → 本地库与整理 里添加');
        return;
      }
      var rootUrl = String(info.account.url || '').replace(/\/?$/, '/');
      var cur = info.sub || '';
      var listBox = el('div', { class: 'link-list' });
      var head = el('div', { class: 'field-hint' });
      var logBox = el('div', { class: 'fetch-log', style: { display: 'none' } });
      function logLine(m) { logBox.style.display = ''; logBox.appendChild(el('div', { class: 'log-line', text: m })); logBox.scrollTop = logBox.scrollHeight; }
      function encSeg(sub) { return String(sub || '').split('/').filter(function (s) { return s; }).map(encodeURIComponent).join('/'); }
      function urlOf(sub, isDir) { var p = encSeg(sub); return rootUrl + p + (isDir && p ? '/' : ''); }
      function localDir() {
        var ls = (a.paths || []).filter(function (x) { return x && x.path && !App.isWebdavPath(x.path); });
        var hit = ls.filter(function (x) { return x.note === '存储路径'; })[0] || ls[0];
        return hit && hit.path;
      }
      function creds() {
        return App.davCredsFor(info.label).then(function (c) {
          if (!c) throw new Error('WebDAV 账号不存在：' + info.label);
          return c;
        });
      }
      function downloadRemote(e, btn) {
        var dir = localDir();
        if (!dir) { Toast.warn('该素材还没有本地存储路径：请先编辑素材「创建存储路径」再下载'); return; }
        var dst = joinWinPath(dir, [e.name]);
        btn.disabled = true; ICONS.apply(btn, ('\u23F3 下载中 …'));
        creds().then(function (c) {
          return FS.davCall('/api/webdav/get', { url: urlOf(cur ? cur + '/' + e.name : e.name, false), localPath: dst, username: c.username, password: c.password });
        }).then(function (r) {
          ICONS.apply(btn, r.exists ? '已存在' : '\u2714 已下载');
          logLine('\u2714 ' + e.name + ' → ' + dst + (r.exists ? '（同名已存在，未覆盖）' : ''));
          if (!r.exists) Toast.ok('已从网盘下载到：' + dst);
        }).catch(function (err) {
          btn.disabled = false; ICONS.apply(btn, ('\u2B07 下载到本地'));
          logLine('\u2716 ' + e.name + '：' + (err && err.message));
        });
      }
      function load(sub) {
        cur = sub || '';
        head.textContent = '账号：' + info.label + '　位置：/' + cur;
        listBox.innerHTML = '';
        listBox.appendChild(el('div', { class: 'field-hint', text: '正在读取远端目录 …' }));
        creds().then(function (c) {
          return FS.davCall('/api/webdav/list', { url: urlOf(cur, true), username: c.username, password: c.password });
        }).then(function (r) {
          listBox.innerHTML = '';
          if (cur) {
            listBox.appendChild(el('div', { class: 'link-row' }, [
              el('button', { class: 'btn btn-xs', onclick: function () { load(cur.split('/').slice(0, -1).join('/')); } }, ICONS.label('\u2B06 上一级'))
            ]));
          }
          if (!r.entries.length) listBox.appendChild(el('div', { class: 'field-hint', text: '（空目录）' }));
          r.entries.forEach(function (e) {
            if (e.isDir) {
              listBox.appendChild(el('div', { class: 'link-row' }, [
                el('code', { class: 'path', title: e.name }, ICONS.label('\u{1F4C1} ' + e.name)),
                el('button', { class: 'btn btn-xs', onclick: function () { load(cur ? cur + '/' + e.name : e.name); } }, '进入')
              ]));
              return;
            }
            var btn = el('button', { class: 'btn btn-xs btn-primary' }, ICONS.label('\u2B07 下载到本地'));
            btn.onclick = function () { downloadRemote(e, btn); };
            listBox.appendChild(el('div', { class: 'link-row' }, [
              el('code', { class: 'path', title: e.name }, e.name + (e.size ? '  ·  ' + fmtSize(e.size) : '')),
              btn
            ]));
          });
        }).catch(function (e) {
          listBox.innerHTML = '';
          listBox.appendChild(el('div', { class: 'field-hint' }, ICONS.label('\u2716 ' + (e && e.message))));
        });
      }
      function uploadHere() {
        FS.host.pickFiles().then(function (r) {
          if (!r || !r.ok || !(r.paths || []).length) return;
          var chain = Promise.resolve();
          r.paths.forEach(function (lp) {
            chain = chain.then(function () {
              var nm = String(lp).split('\\').pop();
              logLine('\u23F3 上传 ' + nm + ' …');
              return creds().then(function (c) {
                return FS.davCall('/api/webdav/put', { url: urlOf(cur ? cur + '/' + nm : nm, false), localPath: lp, username: c.username, password: c.password });
              }).then(function (rr) { logLine('\u2714 ' + nm + ' 已上传（' + fmtSize(rr.size) + '）'); })
                .catch(function (e) { logLine('\u2716 ' + nm + '：' + (e && e.message)); });
            });
          });
          return chain.then(function () { load(cur); Toast.ok('上传结束，详见下方日志'); });
        });
      }
      Modal.open({
        title: '网盘目录（WebDAV）', size: 'lg',
        body: [el('div', { class: 'detail-stack' }, [
          head,
          el('div', { class: 'btn-row' }, [
            el('button', { class: 'btn btn-sm', onclick: function () { load(cur); } }, ICONS.label('\u{1F504} 刷新')),
            el('button', { class: 'btn btn-sm btn-primary', onclick: function () { uploadHere(); } }, ICONS.label('\u2B06 上传本地文件到此处'))
          ]),
          listBox,
          logBox
        ])]
      });
      load(cur);
    }

    var pathNode = (a.paths || []).length ? el('div', { class: 'link-list' }, a.paths.map(function (p) {
      if (App.isWebdavPath(p.path)) {
        return el('div', { class: 'link-row' }, [
          // v2.5.2：路径本身就是「复制」入口（点一下复制），不再单列一个「复制」按钮
          el('code', { class: 'path path-copy', title: '点击复制：' + p.path, onclick: function () { copyText(p.path).then(function () { Toast.ok('路径已复制'); }); } }, p.path + (p.note ? '  （' + p.note + '）' : '')),
          el('button', { class: 'btn btn-xs btn-primary', onclick: function () { openDavBrowser(p.path); } }, ICONS.label('\u2601 浏览网盘'))
        ]);
      }
      return el('div', { class: 'link-row' }, [
        el('code', { class: 'path path-copy', title: '点击复制：' + p.path, onclick: function () { copyText(p.path).then(function () { Toast.ok('路径已复制'); }); } }, p.path + (p.note ? '  （' + p.note + '）' : '')),
        el('button', { class: 'btn btn-xs', onclick: function () { FS.openPath(p.path); } }, ICONS.label('\u{1F4C2} 打开'))
      ]);
    })) : null;

    // 店铺名：URL / 站点根地址不再当作作者名
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

    // 商品 ID：普通文本展示即可；商品页访问已由「商店链接」提供，不再做超链接/复制按钮
    var idKV = a.itemId ? el('span', { text: a.itemId }) : '';
    // v2.2.12 网盘：http(s) 链接可点，其它按纯文本展示
    var cloudKV = a.cloudUrl
      ? (/^https?:\/\//i.test(a.cloudUrl)
        ? el('a', { href: a.cloudUrl, target: '_blank', rel: 'noopener', title: '打开网盘链接' }, a.cloudUrl)
        : el('span', { class: 'mono', text: a.cloudUrl }))
      : '';

    // 商品图集：头部缩略条浏览 + 预览窗口（上一张/下一张/设为封面）
    // 图集本地化：外链图下载后转 PNG 存 vrclib-data\gallery\<商品ID>\（v2.3.6 起），之后离线也能浏览
    var galleryImages = (a.images || []).slice();   // v2.3.6：不再截断到 24 张（缓存/预览覆盖全部图集）
    var galleryLocal = Object.create(null);
    var galleryDisposed = false;   // v2.5.3：本轮已回收（原地刷新/关闭弹窗后，异步预加载不得再产 blob URL）
    /** v2.5.3：回收本轮图集 blob。原地刷新分行必须**先回收上一轮**——旧实现只在 onClose 里回收，
     *  而原地刷新（自动补全/保存后的静默刷新）走的是提前 return 分支，整册 objectURL 会变成永久孤儿。 */
    function revokeGallery() {
      galleryDisposed = true;
      Object.keys(galleryLocal).forEach(function (u) {
        var v = galleryLocal[u];
        if (v && String(v).slice(0, 5) === 'blob:') { try { URL.revokeObjectURL(v); } catch (e) {} }
        delete galleryLocal[u];
      });
    }
    /* v2.5.2：缩略图**只加载一次**。原来是渲染时先给 img.src 设外链（第一次加载），等 galleryPreload
     * 拿到磁盘缓存后再换成 blob URL（第二次加载）——打开详情页能明显看到「图先出现、随后又刷一遍」。
     * 现在渲染时不设 src，等预加载判定完（磁盘命中 → blob，未命中 → 外链）一次性设定。 */
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
      if (galleryDisposed) return;   // v2.5.3：本轮已回收（原地刷新/关闭）→ 不能再建 blob URL
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
        if (galleryDisposed) return '';   // v2.5.3：本轮已回收 → 丢弃（异步下载可能晚于刷新/关闭）
        var objectURL = URL.createObjectURL(blob);
        galleryLocal[u] = objectURL;
        // v2.5.2：只补「还没决定 src」的缩略图；已经按外链加载过的不再换源——换源=同一张图加载两次
        galleryThumbs.forEach(function (t) { if (t.url === u && !t.decided) t.img.src = objectURL; });
        return objectURL;
      }
      // v2.3.6：先看磁盘缓存（vrclib-data\gallery\<商品ID>\），没有才联网下载并转 PNG 落盘
      return App.galleryFromDisk(a, i).then(function (hit) {
        if (hit && hit.blob) return adopt(hit.blob);
        return Net.fetchBlob(u, {}).then(function (b) {
          if (!b) return null;
          return toPngBlob(b, App.settings.imageMaxWidth).then(function (png) {
            return App.galleryToDisk(a, i, u, png).then(function (p) {
              if (p) return adopt(png);
              // 宿主离线等写不了盘：退回浏览器缓存兜底，等宿主回来由迁移搬到磁盘（不会白抓一次）
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

    /* v2.5.4（用户要求）预览页改造：
     *  ① 图片下方一行「全部图集」缩略图（与详情页同一套外观 + 两侧渐隐，可点选、当前项高亮、自动滚到可见）；
     *  ② 上/下一张循环（首尾相接），且不再重复显示同一张；
     *  ③ 下方「删除这张」——从素材库图集里移除该图并即时刷新详情页；
     *  ④ 上/下一张按钮改成**贴在图片左右两侧**的半透明箭头，鼠标不在图片两侧时不显示；
     *  ⑤ 「缓存全部图集」如实汇报缓存了几张 / 失败几张（原来无论成败都提示「已本地化缓存」）。 */
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
        // v2.5.4 修正：迟到的本地化回调只在「仍停在同一张」时才替换 src（旧写法 cur === cur 恒真，快速翻页会串图）
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
      /* v2.5.6（用户反馈「按钮太小 / 图标没有竖直居中」）：
       * 箭头改用**定尺寸内联 SVG**，不再用字体字符 '‹' —— 字符墨迹只有字号的约 0.35，
       * 且墨迹中心 ≠ 行盒中心（实测：字号 34.5px 时墨迹仅 8×12px、中心偏上 1.5px），
       * 靠 line-height 居中永远有偏差。SVG 放进 flex 居中容器里是**几何精确居中**。 */
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
      /* v2.5.8（用户批复，最终口径）：翻页热区 = **舞台的左 1/3 / 右 1/3**（左中右三段结构），
       * 与图片尺寸无关、只看舞台；鼠标进入整条带内即显示箭头。所以热区挂在 stage 上，不挂图片。 */
      var prevZone = null, nextZone = null;
      if (galleryImages.length > 1) {
        prevZone = el('div', { class: 'viewer-navzone viewer-navzone-prev', title: '上一张（可循环）', onclick: function () { navTo(-1); } }, [
          el('span', { class: 'viewer-nav' }, [navArrow('prev')])
        ]);
        nextZone = el('div', { class: 'viewer-navzone viewer-navzone-next', title: '下一张（可循环）', onclick: function () { navTo(1); } }, [
          el('span', { class: 'viewer-nav' }, [navArrow('next')])
        ]);
      }
      /* v2.5.6（用户要求）：按钮尺寸基准 = **图片纵向（显示高度）的 1/7**（原为「长边/7」），
       * 夹在 36~200px；按钮做成正方形 → 圆形光晕不被压扁。
       * 点击范围规则不变：仍然是「按钮 + 两侧留白」贴着图片左右边缘。
       * 图片加载 / 换图 / 窗口缩放时重算。 */
      function sizeNav() {
        /* v2.5.8：量 imgWrap（与图片同盒，但一定已挂到 DOM）；直接量 img 会在
         * "图片还没排版"时得到 0 并走舞台兜底，之后又不一定有机会重量。 */
        var r = (imgWrap || img).getBoundingClientRect();
        var base = r.height || 0;                      // 纵向（高度）
        if (!base) {   // 图片还没加载出来（外链被墙/加载中）：退而用舞台尺寸，别让箭头停在默认小尺寸
          var sr = (stage && stage.getBoundingClientRect) ? stage.getBoundingClientRect() : { width: 0, height: 0 };
          base = Math.max(0, Math.min(sr.width || 0, sr.height || 0) * 0.9);
        }
        if (!base) return;
        var h = Math.max(36, Math.min(200, Math.round(base / 7)));
        /* v2.5.8 关键修复：热区已经挂在 **stage** 上，而 CSS 变量沿 DOM 继承 ——
         * 写在 imgWrap 上热区根本收不到（实测 --nav-h 写成了 42px，按钮却仍渲染 78px 的默认值）。
         * 所以变量必须写在热区的父级 stage 上。imgWrap 也写一份，兼容以后有元素要用。 */
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
        /* v2.5.8（用户批复，最终口径）：热区 = **舞台的左右各 1/3**（左中右三段），
         * 与图片尺寸无关 —— 几何全在 CSS 里，JS 只负责箭头尺寸。 */
      }
      /* v2.5.6（性能）：翻页 / 换图路径里**不要做同步强制布局**——刚改过 src 的 img 立刻
       * getBoundingClientRect() 会强制同步排版。改成 rAF 合帧：一帧最多量一次，
       * 连点翻页也只算一次；实测该路径每帧节省一次强制 layout。 */
      var navRaf = 0;
      function scheduleNavSize() {
        if (navRaf) return;
        navRaf = requestAnimationFrame(function () {           // 双帧：等布局稳定后再量（实测单帧会量到未落定的高度，差 1px）
          navRaf = requestAnimationFrame(function () { navRaf = 0; sizeNav(); });
        });
      }
      img.addEventListener('load', scheduleNavSize);
      window.addEventListener('resize', scheduleNavSize);
      /* v2.5.8：图片的**渲染尺寸**会随弹窗/图集条/滚动条变化（load 事件之后仍会变），
       * 只靠 load + resize 会量到过期高度（实测 78px 的箭头对应 292px 的图 = 比例 0.267 而非 1/7）。
       * 用 ResizeObserver 盯住 img 自身尺寸 —— 一变就重算；关弹窗时断开。 */
      var navRO = (typeof ResizeObserver === 'function') ? new ResizeObserver(function () { scheduleNavSize(); }) : null;
      if (navRO) { try { navRO.observe(img); } catch (e) {} }
      /* v2.5.8：首次打开时 img 往往还没排版（getBoundingClientRect().height = 0），
       * sizeNav 会走"舞台兜底值"；之后图片定型却不会再量第二次（实测：兜底算出 78px，
       * 而图片实际 292px → 比例 0.267 而不是 1/7）。这里补**有限次稳定重测**（有界，不常驻），
       * 关弹窗时全部清掉。 */
      var navSettleTimers = [80, 240, 600, 1200].map(function (ms) {
        return setTimeout(function () { scheduleNavSize(); }, ms);
      });
      var stage = el('div', { class: 'viewer-stage' }, [imgWrap, prevZone, nextZone]);
      /* v2.5.14（用户反馈）：双击翻页热区不再产生文本选区。mousedown 的默认行为是「开始选择」，
       * preventDefault 只挡选择、不影响随后的 click 导航（探针 build/_probe-viewer-select.mjs 复测）。 */
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
          else Toast.warn('已本地化 ' + okN + ' 张，' + failN + ' 张没抓到（多为外链防盗链或未联网；可在「设置 → 联网与宿主」检查抓取方式）', 5200);
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
        onClose: function () {   // v2.5.4b：别把缩放监听留在窗口上；v2.5.6：待执行的合帧回调也一并取消
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
          // v2.5.2：alt 留空（无 src 时不会渲染出「图片缺失」文字）；加载失败也**不隐藏**（隐藏会让后面的图左移 = 看起来像重新排序）
          var im = el('img', { alt: '', loading: 'lazy', title: '浏览并设为封面' });   // src 由 applyThumbSrc 一次性设定
          im.onerror = function () { im.classList.add('img-failed'); };
          galleryThumbs.push({ url: u, img: im });
          return el('button', { class: 'gallery-item', onclick: function () { openGalleryViewer(i); } }, [im]);
        }))
      : el('div', { class: 'detail-gallery-strip empty' }, [el('span', { text: '暂无商品图集' })]);

    /* v2.5.2：图集固定一行——滚轮 = 横向滚动，两侧虚化提示「还有更多」；滚到底虚化消失。
     * 这样详情页头部的高度由封面决定，不会被图集撑高。
     * v2.5.4：抽成 attachStripScroll()，预览页底部那一行缩略图复用同一套外观与滚动行为。 */
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

    /* v2.5.4（用户要求）：图集右上角「重新获取」——重新联网抓商品页图集，把整列表换成网页端当前的样子。
     * 既是「和网页端不一样」的修复入口，也是剔除重复 / 陈旧图的保底手段。 */
    var refetchGalleryBtn = el('button', {
      // v2.5.12（用户要求）：样式与「隐藏 / 喜欢 / 删除」一致（统一用 .btn），文案改「重新获取图集」
      class: 'btn gallery-refetch', type: 'button',   // 不占用 .btn-parse：那个类名被「版本与下载 → 重新解析」与冒烟夹具锚定
      title: '重新联网获取商品页图集：整列表替换为网页端当前的样子（自动去重），用于剔除重复 / 陈旧图',
      onclick: function () {
        var link = (a.links || []).filter(function (l) { return isHttpUrl(l.url); })[0];
        var url = link ? link.url : (a.itemId ? 'https://booth.pm/ja/items/' + a.itemId : '');
        if (!url) { Toast.warn('这条素材没有商店链接，无法重新获取图集'); return; }
        if (typeof Net === 'undefined' || !Net.networkAllowed()) { Toast.warn('当前抓取方式不允许联网（可在「设置 → 联网与宿主」切换）', 4200); return; }
        refetchGalleryBtn.disabled = true; ICONS.apply(refetchGalleryBtn, '\u23F3 获取中 …');
        Fetchers.fetchInfo(url, { forceNetwork: true, noCache: false }).then(function (info) {
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

    // 商品图集本地化：打开详情后自动后台逐个缓存，已缓存则直接跳过（v2.5.4：按真实结果提示，不再谎报「已缓存」）
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
      // v2.5.2：商品价不再显示（价格看变体）
      kv('商店链接', linksNode || '无'),
      kv('作者 / 店铺', shopKV),
      kv('商品 ID', idKV),
      kv('网盘', cloudKV),
      kv('原始标签', (a.rawTags || []).length ? (a.rawTags || []).join(' / ') : ''),
      kv('上架日期', a.publishedAt ? fmtDate(a.publishedAt) : ''),
      kv('商品更新日期', a.shopUpdatedAt ? fmtDate(a.shopUpdatedAt) : ''),
      kv('本地添加', fmtDate(a.createdAt, true)),
      kv('本地修改', fmtDate(a.updatedAt, true))
    ]);

    var head = el('div', { class: 'detail-head' }, [
      el('div', { class: 'detail-head-cover' }, [cover]),
      el('div', { class: 'detail-head-info' }, [
        el('h3', { class: 'detail-title', text: title }),
        orig ? el('div', { class: 'detail-subtitle', title: a.originalTitle }, orig) : null,
        chips,
        el('div', { class: 'detail-gallery-slot' }, [galleryNode]),
        el('div', { class: 'detail-tools' }, [
          hideBtn, favBtn,
          /* v2.5.10（用户要求）：「重新获取」挪到「喜欢」右边，中间留一段**更宽的空白**（.tool-sep） */
          el('span', { class: 'tool-sep' }),
          refetchGalleryBtn,
          el('span', { class: 'grow' }),
          deleteBtn
        ]),
        el('div', { class: 'detail-actions' }, [
          el('div', { class: 'detail-actions-cell' }, [primaryBtn, hint]),   // v2.5.8：注释跟着它注释的按钮走
          el('div', { class: 'detail-actions-cell' }, [editBtn])
        ])
      ])
    ]);

    var content = el('div', { class: 'detail-content-wrap' }, [
      el('div', { class: 'detail-content-head' }, [ICONS.make('box', { size: 15 }), el('span', { text: '详细信息' })]),
      el('div', { class: 'detail-content' }, [
        // 左栏：标签 + 商品信息 + 商品描述（平衡两栏内容量）
        el('div', { class: 'detail-col' }, [
          section('标签', tagChips),
          section('商品信息', meta),
          section('商品简介', descBlock)
        ]),
        // 右栏：版本与下载 + 图集 + 备注
        el('div', { class: 'detail-col' }, [
          section('版本与下载', el('div', { class: 'detail-stack' }, [activeTotalNode, verSectionNode, dlNode, licenseNode, unpurchasedNode, pathNode]), fetchOrderBtn),
          section('备注', a.note ? el('div', { class: 'note-box' }, [el('span', { text: a.note })]) : null)
        ])
      ])
    ]);

    var body = el('div', { class: 'detail detail-v2' }, [head, content]);

    // BOOTH / Gumroad 源缺少有效变体时打开详情自动获取一次（免费素材不需要购买变体，直接跳过；成功刷新并锁定，失败保持原样）
    var epAuto = App.effectivePrice(a);
    // v2.3.12：BOOTH「未购买」素材的商品价按模型就是 0（= 没有任何已购变体），不能因此当免费而跳过补全，
    // 否则变体/价格永远补不上（核对时发现 27 个素材卡在这个状态）。
    var unpurchasedAsset = App.purchaseState(a) === 'unpurchased';
    var freeAsset = !unpurchasedAsset && (a.isFree === true || !!(epAuto && epAuto.value === 0));
    var needsVariantAuto = !freeAsset && !a.delisted && !Importer.autoEnrichBusy() &&
      (a.source === 'booth' || a.source === 'gumroad') &&
      !(a.autoFilled && a.autoFilled.versions) &&
      !(a.versions || []).some(function (v) { return v.orderUrl && v.orderUrl.trim() && !v.special; }) &&
      (((a.links || []).some(function (l) { return isHttpUrl(l.url); })) || a.itemId);
    if (!opts.noAutoEnrich && needsVariantAuto) {
      Toast.info('正在通过内置宿主自动获取版本 / 变体 …', 2200);
      var enrichFn = a.source === 'gumroad' ? Importer.autoEnrichGumroadAsset : Importer.autoEnrichBoothAsset;
      enrichFn(a).then(function (saved) {
        if (!saved || saved.delisted) return;
        /* v2.5.3 修复「自动补全无限循环」：补全会**放弃**（返回同一个对象 = 什么都没改：商品页 ID 不符 /
         * 抓取失败 / 没有可解析的订单链接），此时既不能刷新详情、也不能报「已补全」——刷新会重跑本段判定，
         * 形成每轮一对 Toast 的死循环（实测 3 秒 101 轮；fetch 命中缓存时微任务链直接饿死事件循环 = 标签页卡死）。
         * 详情页自身的重渲染一律走 opts.noAutoEnrich（见 refreshAfterChange）。 */
        var locked = !!(saved.autoFilled && saved.autoFilled.versions);
        if (saved === a && !locked) { console.warn('[enrich] 本次未补全，保持原样（下次打开详情会再试一次）'); return; }
        Modals.refreshAfterChange(saved, { keepModal: true });
        if (locked) Toast.ok('已自动补全版本 / 变体信息');
        try { App.ensureCoverOnDisk(saved, { quiet: true, allowFetch: true }); } catch (e) {}   // v2.5.14：补全后顺手补写封面
      });
    }

    if (targetHandle && targetHandle.body) {
      // v2.5.3：原地刷新前先回收上一轮图集的 blob URL（否则每刷新一次就泄漏一整册）
      if (typeof targetHandle._revokeGallery === 'function') { try { targetHandle._revokeGallery(); } catch (e) {} }
      targetHandle._revokeGallery = revokeGallery;
      targetHandle.kind = 'detail';
      targetHandle.assetId = id;              // v3.0.0：原地刷新也要钉住「这个弹窗属于谁」
      Modals.syncDetailId();
      targetHandle.body.innerHTML = '';
      appendChildren(targetHandle.body, body);
      return targetHandle;
    }
    var h = Modal.open({
      title: '素材详情', size: 'lg', body: [body],
      /* v3.0.0：关闭时清空归属记录——Modal.close() 会先把 handle 移出栈再回调 onClose，
       * 所以这里 syncDetailId() 扫到的是「剩下还在的详情弹窗」（没有则置空）。
       * v4.6：顺带收掉卡片上的「正在看」高亮——以前 App.activeAssetId 一直留着，
       * 那张卡会长期挂一圈主色光晕，看着像一直选中。原地刷新时 detailAssetId 还在，不清。 */
      onClose: function () {
        revokeGallery();
        Modals.syncDetailId();
        if (!App.detailAssetId) {
          App.activeAssetId = '';
          $$('#grid .card.card-active').forEach(function (c) { c.classList.remove('card-active'); });
        }
      }
    });
    h._revokeGallery = revokeGallery;   // v2.5.3：原地刷新时用它回收上一轮图集 blob
    App.syncDownloadButtons();   // v2.3.10：重开详情也按下载队列的真实状态显示按钮
    h.kind = 'detail';
    h.assetId = id;   // v3.0.0：弹窗归属的素材 id（refreshAfterChange keepModal 的唯一判据）
    Modals.syncDetailId();
    return h;
  },

  /* ------------------------------------------------------------------
   * 新增 / 编辑表单
   * ------------------------------------------------------------------ */
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

      if (info.originalTitle) {
        if (canAuto('titleOrig')) {
          titleOrig.value = info.originalTitle; setScalarBase('titleOrig', info.originalTitle); markAuto('titleOrig');
        } else skip('原标题');
        // 自定义标题只在本来为空时用原标题兜底
        if (!titleInput.value.trim() && canAuto('title')) {
          titleInput.value = info.originalTitle.slice(0, 60); setScalarBase('title', info.originalTitle.slice(0, 60)); markAuto('title');
        }
      }
      if (info.author || info.shop) {
        if (canAuto('author')) {
          authorInput.value = info.author || info.shop; setScalarBase('author', info.author || info.shop); markAuto('author');
        } else skip('作者 / 店铺');
      }
      if (info.shopUrl && canAuto('shopUrl')) { a.shopUrl = info.shopUrl; setHiddenBase('shopUrl', info.shopUrl); markAuto('shopUrl'); } else if (info.shopUrl) skip('店铺链接');
      if (info.itemId && canAuto('itemId')) { a.itemId = info.itemId; setHiddenBase('itemId', info.itemId); markAuto('itemId'); } else if (info.itemId) skip('商品 ID');
      // 商品价（只读）：BOOTH 稍后用变体计算价覆盖；其他来源取抓取到的商店价。
      // 统一存成「币种符号 + 数值」，避免页面 JSON-LD 带来的 “USD 15” 双前缀。
      // v2.5.2（用户批准）：商品价不再写入素材——价格一律按变体价现算。
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
          onCategoryChange();   // v2.3.1：抓到的就是角色模型时立即显示「角色名」区块，不必手动改一次类型
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
        delete a.extra.r18;   // 清除历史误判：简介里“允许用于 R-18 作品”并不代表商品本身是成人向
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
            // v2.3.23：GitHub README 图片抓取即本地化——首图下载失败自动顺延下一张，全部失败保留仓库头像外链
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
      return true;
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
    var fetchHint = el('div', { class: 'field-hint', text: '提示：可粘贴完整商品链接；也可以只输入 BOOTH 数字商品 ID（如 8404988）或 Gumroad 短链接 ID，点「联网自动填充」会自动补全为完整链接并写入下方「商店链接」。' });
    function updateFetchHint() {
      var raw = fetchInput.value.trim();
      if (!raw) {
        fetchHint.textContent = '提示：可粘贴完整商品链接；也可以只输入 BOOTH 数字商品 ID（如 8404988）或 Gumroad 短链接 ID，点「联网自动填充」会自动补全为完整链接并写入下方「商店链接」。';
      } else if (/^\d{4,15}$/.test(raw)) {
        fetchHint.textContent = '已识别为 BOOTH 商品 ID：点「联网自动填充」会自动补全为完整商品链接，并写入「商店链接」。';
      } else if (!isHttpUrl(raw) && /^[A-Za-z0-9][A-Za-z0-9_.=-]{0,100}$/.test(raw)) {
        fetchHint.textContent = '已识别为商品 ID / 短链接：点「联网自动填充」会先尝试补全为完整链接（BOOTH 优先），成功后写入「商店链接」。';
      } else {
        fetchHint.textContent = '完整商品链接：点「联网自动填充」抓取信息，并自动写入「商店链接」。';
      }
    }
    function updatePasteHint() {
      var url = fetchInput.value.trim();
      pasteHint.textContent = '操作步骤：① 在浏览器打开商品页 / 仓库页 → ② 按 Ctrl+U 查看网页源代码 → ③ Ctrl+A 全选、Ctrl+C 复制 → ④ 粘贴到下方文本框 → ⑤ 点击「解析粘贴内容」。全过程不产生任何外部请求。';
      pasteHintLink.innerHTML = '';
      // v2.3.25：任何有 jsonURL 的来源都给出「直接打开 JSON」的省事入口（BOOTH / GitHub 都适用）
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
          if (/^https?:\/\/\S+$/i.test(raw)) {          // v2.3.25：粘的是「链接」而不是「内容」时给出明确指引
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

    /* ---- 联网抓取（全部由内置宿主负责） ---- */
    var netBtn = el('button', {
      class: 'btn', type: 'button', onclick: function () { doFetch({}); }
    }, ICONS.label('\u{1F310} 联网自动填充'));
    // 已保存 Cookie 时：即便在手动粘贴模式下也可直接让宿主联网获取（含已购版本与下载直链）
    var cookieBtn = el('button', {
      class: 'btn btn-warn', type: 'button', title: '用本机保存的 Cookie 由内置宿主获取，已购商品会带出版本、价格与全部下载直链',
      onclick: function () { doFetch({ forceNetwork: true, viaCookie: true }); }
    }, ICONS.label('\u{1F510} 用 Cookie 获取已购信息'));
    // 强制联网填充：忽略字段锁定与本地缓存，除自定义标题/原标题/角色三语名外全部用获取信息覆盖
    var forceBtn = el('button', {
      class: 'btn btn-danger-ghost', type: 'button',
      title: '忽略「自动获取/用户自定义」锁定与本地缓存，重新联网获取并覆盖信息（自定义标题、原标题、角色三语名始终保留；标签会重新自动翻译）',
      onclick: function () { doFetch({ forceFill: true, forceNetwork: true, noCache: true }); }
    }, ICONS.label('\u26A1 强制联网填充'));

    function looksDelisted(info) {
      if (!info) return false;
      if (info.status === 404 || info.status === 410) return true;
      var tried = info.tried || [];
      for (var i = 0; i < tried.length; i++) {
        if (tried[i] && /HTTP (404|410)\b/.test(String(tried[i].error || ''))) return true;
      }
      return false;
    }

    /** 输入的是商品 ID（不是完整链接）时，后台依次尝试 BOOTH / Gumroad 候选链接；
     *  成功就把输入框替换为完整链接，并继续按该链接完成信息获取填充。 */
    function resolveProductInput(raw, opts) {
      var candidates = [];
      if (/^\d{4,15}$/.test(raw)) {
        candidates.push('https://booth.pm/ja/items/' + raw);
        candidates.push('https://booth.pm/zh-cn/items/' + raw);
      }
      candidates.push('https://gumroad.com/l/' + encodeURIComponent(raw));
      logBox.innerHTML = ''; logBox.style.display = '';
      log('\u{1F50D} 检测到输入的是商品 ID：' + raw + '，正在后台尝试补全为完整商品链接 …');
      netBtn.disabled = true; cookieBtn.disabled = true; forceBtn.disabled = true;
      function next(i) {
        if (i >= candidates.length) {
          log('\u2716 未能把「' + raw + '」补全为有效商品链接。请粘贴完整商品页 URL 后重试。');
          Toast.err('未能补全该商品 ID，请粘贴完整商品链接', 5600);
          restoreButtons();
          return;
        }
        var candidate = candidates[i];
        return Fetchers.fetchInfo(candidate, { forceNetwork: true, noCache: false, onLog: function () {} }).then(function (info) {
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
      netBtn.disabled = false; cookieBtn.disabled = false; forceBtn.disabled = false;
      ICONS.apply(netBtn, ('\u{1F310} 联网自动填充'));
      ICONS.apply(cookieBtn, ('\u{1F510} 用 Cookie 获取已购信息'));
      ICONS.apply(forceBtn, ('\u26A1 强制联网填充'));
    }

    function doFetch(opts) {
      opts = opts || {};
      var url = rememberLink();
      if (!isHttpUrl(url)) {
        var raw = String(url || '').trim();
        if (/^[A-Za-z0-9][A-Za-z0-9_.=-]{0,100}$/.test(raw)) { resolveProductInput(raw, opts); return; }
        Toast.warn('请输入商品链接，或只输入商品 ID（BOOTH 数字 ID / Gumroad 短链接 ID）');
        return;
      }
      startFetch(url, opts);
    }

    function startFetch(url, opts) {
      opts = opts || {};
      if (!Net.networkAllowed() && !opts.forceNetwork) {
        log('\u{1F6E1} 当前为「手动粘贴源码」模式，未发起任何请求。如需联网抓取，请在「设置 → 联网与宿主」选择「内置宿主联网」，或点「用 Cookie 获取已购信息」。');
        Toast.warn('当前为「手动粘贴源码」模式');
        return;
      }
      logBox.innerHTML = ''; logBox.style.display = '';
      netBtn.disabled = true; cookieBtn.disabled = true; forceBtn.disabled = true;
      ICONS.apply(netBtn, ('\u{23F3} 抓取中 …'));
      ICONS.apply(cookieBtn, ('\u{23F3} 获取中 …'));
      ICONS.apply(forceBtn, ('\u23F3 强制联网填充中 …'));
      Fetchers.fetchInfo(url, { onLog: log, noCache: !!opts.noCache, forceNetwork: !!opts.forceNetwork }).then(function (info) {
        if (!info || info.__failed) {
          if (looksDelisted(info)) {
            a.delisted = true;
            log('\u{1F6AB} 商品无法获取（404/410，可能已下架），已标记「已下架」。自动补全将跳过该素材；手动点联网仍可重试，成功后自动清除标记。');
            App.save(a).then(function () { UI.renderAll(); });
            Toast.err('商品已下架，已标记；可手动重试获取', 5200);
          } else {
            log('\u2716 抓取未成功。请确认程序正常运行（内置宿主随窗口启动），或改用下方「手动粘贴源码」。');
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
          // 「联网自动填充」附带识别已购版本/变体：
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
        window.open(url, '_blank', 'noopener');
      }
    }, ICONS.label('\u{1F517} 打开商品页'));

    var modeBadge = el('span', { class: 'mode-badge' });
    function refreshModeUI() {
      modeBadge.textContent = '当前方案：' + modeLabel();
      var paste = currentMode() === 'paste';
      pasteWrap.style.display = paste ? '' : 'none';
      netBtn.style.display = paste ? 'none' : '';
      forceBtn.style.display = '';
      // 离线模式下如果保存过 Cookie，仍提供「仅 Cookie 联网获取」按钮
      var creds = App.settings.credentials || {};
      var hasCookie = Object.keys(creds).some(function (h) { return creds[h] && creds[h].cookie; });
      cookieBtn.style.display = (paste && hasCookie) ? '' : 'none';
      updatePasteHint();
    }
    /* v2.5.3 修复：去抖函数必须只创建一次。写在回调里＝每次按键新建一个闭包，新闭包的定时器变量是 undefined，
     * 永远清不掉上一键的定时器 ⇒ 去抖完全失效（连打 20 个字符＝20 个定时器全触发）。 */
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

    var linkEditor = Field.multi(a.links, { placeholder: 'https://…（商店 / 商品页链接）', labelPlaceholder: '备注', addText: '添加链接', emptyText: '尚未添加商店链接' });
    var dlEditor = Field.multi(a.downloadLinks, { placeholder: 'https://…（直接下载链接）', labelPlaceholder: '文件名', addText: '添加下载链接', emptyText: '尚未添加下载链接', dedupe: true });
    var dlSectionTitle = null;   // 便于聚焦提示
    var pathEditor = Field.multi(a.paths, { placeholder: '例如 D:\\素材库\\衣装\\戚风\\冬季毛衣', labelPlaceholder: '说明', addText: '添加本地路径', emptyText: '尚未关联本地路径', pickDir: true, asPath: true });   // v3.0.4：中性示例

    var versionEditor = Field.versions(a.versions);
    var tagEditor = Field.tags(a.tags, a.rawTags);
    var avatarPicker = Field.avatars(a.avatars);
    var charNameZh = el('input', { class: 'input', value: a.charNameZh || '', placeholder: '中文名，如 索菲娜' });
    var charNameJa = el('input', { class: 'input', value: a.charNameJa || '', placeholder: '日文名，如 ソフィナ' });
    var charNameEn = el('input', { class: 'input', value: a.charNameEn || '', placeholder: '英文名，如 Sophina' });

    var authorInput = el('input', { class: 'input', value: a.author || a.shop, placeholder: '作者 / 店铺名' });
    // v2.2.12 网盘字段（仅记录 + 角标；远端读写走 webdav:// 路径）
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
    var coverPreviewURL = '';   // v2.5.3：本函数自建的封面预览 blob URL（重绘/关弹窗前必须先回收，否则每敲一键泄漏一份）
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
    // v2.3.5：编辑页同样按商品ID 认领本地路径下的封面
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


    /* v2.3.28：三个 AI 翻译按钮上提为变量——分别挂到各自字段标签的右侧（labelRight） */
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
        el('div', { class: 'fetch-row' }, [fetchInput, openPageBtn, netBtn, cookieBtn, forceBtn, switchModeBtn]),
        fetchHint,
        pasteWrap,
        logBox
      ]),

      el('div', { class: 'form-grid' }, [
        el('div', { class: 'form-col' }, [
          el('div', { class: 'section-title'}, ICONS.label('\u{1F4DD} 基本信息')),
          Field.row('显示标题 *', titleInput, '作为卡片主标题显示', aiTitleBtn),
          Field.row('原标题', titleOrig, '在卡片上以小字显示于自定义标题下方'),
          /* v2.3.28：来源与分类并到同一行（仅此处两栏） */
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
          Field.row('作者 / 店铺', authorInput),

          /* v2.3.28：状态 / 上架日期 从右栏上移到「商品价格」与「商品简介」之间 */
          /* v2.3.29：备注移到「商品简介」之后（原来的顺序是 备注 → 商品描述） */
          Field.row('状态', el('div', { class: 'inline-row' }, [
            el('label', { class: 'check' }, [giftCheck, el('span', { text: '获赠' })]),
            el('label', { class: 'check' }, [favCheck, el('span', { text: '喜欢' })]),
            el('label', { class: 'check' }, [hideCheck, el('span', { text: '隐藏（不在默认列表显示）' })])
          ]), '获赠会显示专属角标与筛选标签（BOOTH 获赠页同步时自动识别，可手动改）'),
          Field.row('上架日期', publishedAtInput, '商品发布 / 上架日期（YYYY-MM-DD），详情与卡片封面右下角显示'),
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
        Field.row('网盘', cloudInput, '仅作记录与角标提示，不会自动上传；远端读写请用上面的 webdav:// 路径'),
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
    if (needVariantAuto) {
      setTimeout(function () {
        log('\u{1F510} 检测到 ' + (a.source === 'gumroad' ? 'Gumroad' : 'BOOTH') + ' 素材缺少已购变体，自动获取版本 / 变体 …');
        doFetch({ forceNetwork: true, silent: true });
      }, 900);
    } else if (Importer.autoEnrichBusy() && !isNew && isOrderSite) {
      log('\u26A0 详情页正在自动获取变体信息，编辑页本次自动操作已跳过，避免冲突。');
    } else if (!isNew && App.settings.autoCookieFetch && hasCookieAuto && shopLink && autoSourceOk && !a.delisted &&
        !(a.versions || []).length && !(a.downloadLinks || []).length) {
      setTimeout(function () {
        log('\u{1F510} 检测到已保存 Cookie，自动获取已购版本与价格 …');
        doFetch({ forceNetwork: true, silent: true });
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
      /* v5.5（用户要求）：标题/角色名变了会连磁盘上的素材文件夹一起改名，
       * 改名期间按钮必须锁住 —— 否则连点两次会在「旧名→新名」还没完成时又按旧名算一遍。
       * delay > 0 时额外冷却一会儿再放开，确保目录那边真的落定。 */
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
      a.title = titleInput.value.trim();
      a.originalTitle = titleOrig.value.trim();
      a.source = srcSelect.value;
      a.sourceCustom = srcCustom.value.trim();
      a.category = catSelect.value;
      /* v4.3.2：以前这里把编辑器的值和原始 links 做并集，本意是「不改动就保留」，
       * 结果是删掉的链接保存时又被并回来，永远删不掉。编辑器初始化时已经装了全部链接，
       * 以编辑器的值为准即可。 */
      a.links = linkEditor.getValue();
      a.downloadLinks = dlEditor.getValue();
      a.versions = versionEditor.getValue();
      // 已购买 = 有订单链接，自动派生，不提供勾选
      var purchased = (a.versions || []).filter(function (v) { return v.orderUrl && v.orderUrl.trim(); });
      var activeList = purchased.map(function (v) { return v.id; });
      a.activeVersions = activeList;
      a.activeVersion = activeList[0] || '';
      // BOOTH 商品价 = 已购变体计算价（无已购买 = 0）
      if (srcSelect.value === 'booth') {
        // v2.5.2：商品价不再记录（变体价现算）——这里只提示，不再写 shopPrice*
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
      a.paths = pathEditor.getValue();
      a.tags = tagEditor.getValue();
      a.rawTags = tagEditor.getRaw();
      a.avatars = avatarPicker.getValue();
      a.charNameZh = charNameZh.value.trim();
      a.charNameJa = charNameJa.value.trim();
      a.charNameEn = charNameEn.value.trim();
      a.author = authorInput.value.trim();
      a.cloudUrl = cloudInput.value.trim();
      a.description = descInput.value.trim();
      a.images = galleryImages.slice();   // v2.3.11：不再截断到 24 张
      a.note = noteInput.value;
      a.gifted = giftCheck.checked;
      a.favorite = favCheck.checked;
      a.hidden = hideCheck.checked;
      /* v4.3.2：清空上架日期以前会退回旧值，等于日期永远删不掉（只能改不能删）。 */
      a.publishedAt = publishedAtInput.value ? new Date(publishedAtInput.value + 'T00:00:00').toISOString() : '';
      a.coverURL = coverState.removed ? '' : (coverState.url || '');
      /* 是否会动磁盘目录：只有老素材、且文件夹名真的变了才算 */
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
            // v2.3.7：封面确定后自动写进素材本地路径（Unity 按商品ID 读的就是这个文件），不再需要手动「保存封面」按钮
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
      onClose: function () {   // v2.5.3：关弹窗时回收封面预览 blob URL
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
