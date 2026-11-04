/* ============ 50-app.js ============ */
/* =====================================================================
 * 50-app.js  —  应用核心：状态、字典合并、筛选、渲染
 * ===================================================================== */

/** v3.0.0（D9 · 容量悬崖）：把写盘失败的三类原因翻成用户能自救的话 ——
 *  旧文案把「体积超宿主上限」也说成「宿主离线或目录不可写」，用户会一直等一个永远不会成功的重试。 */
function mbText(n) { return (Number(n || 0) / 1048576).toFixed(2); }
function fileWriteFailShort(kind) {
  if (kind === 'db-error') return '素材数据库写入失败';
  if (kind === 'too-large') return '数据体积超过宿主单次写入上限';
  if (kind === 'host-error') return '宿主拒绝写入（目录被占用 / 无写权限）';
  return '内置宿主未启动或已断开';
}
function fileWriteFailText(kind, info) {
  var dir = App.localDir || '(未知目录)';
  if (kind === 'db-error') {
    return '素材数据库写入失败（' + dir + '）：' + String(info.error || '未知原因')
      + '。改动仍在浏览器缓存里；请确认数据目录可写（不要放在只读位置 / 不要被其它程序占用），'
      + '修好后按 Ctrl+S 或再改一次任意素材即可补写。';
  }
  if (kind === 'too-large') {
    /* 悬崖值由上限现算（不写死），宿主上限变了这里自动跟着变 */
    var cliffRaw = Math.floor(((Number(info.limitBytes) || 0) - 256) * 3 / 4);
    return '数据太大，未能写入 ' + dir + '：本次请求体约 ' + mbText(info.bodyBytes) + ' MB（原始 JSON ' + mbText(info.rawBytes)
      + ' MB），超过内置宿主单次写入上限 ' + mbText(info.limitBytes) + ' MB（' + String(info.limitBytes) + ' 字节）——'
      + '原始 JSON 超过约 ' + mbText(cliffRaw) + ' MB 就一定写不进去。'
      + '本次不会自动重试。改动仍在浏览器缓存里：请先按 Ctrl+S（或设置页「导出完整备份」）留底，'
      + '再清理不用的素材 / 大字段后重试；确实需要更大的主库时，得由宿主侧提高该上限。';
  }
  if (kind === 'host-error') {
    return '宿主拒绝写入 ' + dir + '：' + String(info.error || '未知原因')
      + '（常见原因：目录被占用 / 没有写权限 / 路径不存在）。请关闭占用该目录的程序、检查权限，'
      + '或到「设置 → 本地库与整理」改用别的库目录。改动仍在浏览器缓存里。';
  }
  return '未能写入 ' + dir + '：内置宿主未就绪（不是目录不可写）。请重启程序，'
    + '再点页面顶部提示条的「重试连接」即可补写落盘；改动仍在本地缓存里。';
}

var App = {
  assets: [],
  settings: defaultSettings(),
  coverCache: Object.create(null),   // id -> objectURL
  iconCache: Object.create(null),    // 原始图标 URL -> 本地 objectURL（IndexedDB 缓存）
  filters: { q: '', categories: [], sources: [], avatars: [], tags: [], tagsNot: [], status: 'all', price: 'all', r18: false, delisted: false, wishlist: false },
  selection: Object.create(null),
  selectMode: false,
  page: 1,
  ready: false,
  detailAssetId: '',   // v3.0.0：当前详情弹窗展示的素材 id（Modals.syncDetailId 维护；弹窗劫持判据）


  /* ---------------- 字典（内置 + 用户自定义） ---------------- */
  _order: function (list, orderIds) {
    var order = orderIds || [];
    var inOrder = [];
    order.forEach(function (id) {
      var i = list.findIndex(function (x) { return x.id === id; });
      if (i >= 0) { inOrder.push(list[i]); list.splice(i, 1); }
    });
    return inOrder.concat(list);
  },
  /* v2.5.7：**不给这三张表加跨调用缓存**——设置里直接改字段（不走 saveSettings）的路径存在，
   * 跨调用缓存会变成"改了不生效"的隐性 bug（实测被冒烟抓到 4 条功能回归）。
   * 性能改从"单次调用内批量化"入手（见 Smart.purgeAvatarTags）。 */
  allCategories: function () { return App._order(CATEGORIES.concat(App.settings.customCategories || []), App.settings.categoryOrder); },
  allSources: function () { return App._order(SOURCES.concat(App.settings.customSources || []), App.settings.sourceOrder); },
  allAvatars: function () {
    var list = AVATARS.concat(App.settings.customAvatars || []);
    var deleted = App.settings.deletedAvatars || [];
    list = list.filter(function (a) { return deleted.indexOf(a.id) < 0; });
    var ov = App.settings.avatarOverrides || {};
    list = list.map(function (a) {
      var o = ov[a.id];
      if (!o) return a;
      var c = Object.assign({}, a);
      c.label = o.label || o.nameZh || c.label;
      c.nameZh = o.nameZh || c.nameZh || '';
      c.nameJa = o.nameJa || c.nameJa || '';
      c.nameEn = o.nameEn || c.nameEn || '';
      c.altZh = (o.altZh || []).concat(c.altZh || []);
      c.altJa = (o.altJa || []).concat(c.altJa || []);
      c.altEn = (o.altEn || []).concat(c.altEn || []);
      c.alias = uniq([c.nameZh, c.nameJa, c.nameEn, c.label].concat(c.altZh || [], c.altJa || [], c.altEn || [], a.alias || []).filter(Boolean));
      return c;
    });
    // 通用/多角色始终第一
    var u = list.filter(function (a) { return a.id === 'universal'; });
    var rest = list.filter(function (a) { return a.id !== 'universal'; });
    rest = App._order(rest, App.settings.avatarOrder);
    return u.concat(rest);
  },

  /* ---------------- v2.5.13（性能复查第 2 轮）：单次批量作用域 ----------------
   * 一次 reload() 的存量清洗要对 425 条素材 × 若干派生表反复取值：
   * 角色表（allAvatars）、角色 id→显示名、标签名表、黑名单正则 —— 原先每条素材都重建一遍。
   * 作用域是**调用方私有的临时对象**（App.newScope()），用完即弃 —— **不是跨调用缓存**；
   * scopeToken() 盯着三张角色设置表（customAvatars / deletedAvatars / avatarOverrides）的**引用**，
   * 任一被换掉（例如循环里清掉工具名角色、或同步时新建了角色）就整体作废重建。
   * 这样「设置里直接改字段、不走 saveSettings 也立刻生效」的护栏（v2.5.7 立的规矩）不受影响：
   * 不传 scope 的调用照旧每次现算。 */
  newScope: function () {
    return { tAvSet: false, tCustom: null, tDeleted: null, tOverrides: null, avList: null, avLabels: null, tagNames: null, toolIds: null, blKey: '' };
  },
  /** true = 设置未变；false = 刚检测到变化（并把作用域内的派生数据全部作废） */
  scopeToken: function (scope) {
    if (!scope) return false;
    var s = App.settings || {};
    if (scope.tAvSet === true && scope.tCustom === s.customAvatars && scope.tDeleted === s.deletedAvatars && scope.tOverrides === s.avatarOverrides) return true;
    scope.tCustom = s.customAvatars; scope.tDeleted = s.deletedAvatars; scope.tOverrides = s.avatarOverrides; scope.tAvSet = true;
    scope.avList = null; scope.avLabels = null; scope.tagNames = null; scope.toolIds = null; scope.blKey = '';
    return false;
  },
  /** 作用域内的角色表（内置 + 自定义，已去删/已套覆盖） */
  scopeAvatars: function (scope) {
    if (!scope) return App.allAvatars();
    App.scopeToken(scope);
    if (!scope.avList) scope.avList = App.allAvatars();
    return scope.avList;
  },
  /** 作用域内的「角色 id → 显示名」（等价于逐次 App.avatarLabel） */
  scopeAvatarLabel: function (scope, id) {
    var list = App.scopeAvatars(scope);
    if (!scope.avLabels) {
      var m = Object.create(null);
      list.forEach(function (v) { if (!(v.id in m)) m[v.id] = v.label; });
      scope.avLabels = m;
    }
    return (scope.avLabels[id] !== undefined) ? scope.avLabels[id] : id;
  },
  /** 角色表里「名字就是工具/软件名」的自定义角色 id（v2.3.17 清洗 6 用）——整轮只算一遍 */
  toolAvatarIds: function () {
    var ids = Object.create(null);
    ((App.settings && App.settings.customAvatars) || []).forEach(function (c) {
      if (!c || !c.id) return;
      var names = [c.label].concat(c.alias || []);
      if (names.some(function (n) { return TOOL_STOP_RE.test(String(n || '').trim()); })) ids[c.id] = 1;
    });
    return ids;
  },
  scopeToolIds: function (scope) {
    if (!scope) return App.toolAvatarIds();
    App.scopeToken(scope);
    if (!scope.toolIds) scope.toolIds = App.toolAvatarIds();
    return scope.toolIds;
  },

  categoryLabel: function (id) {
    var c = App.allCategories().find(function (x) { return x.id === id; });
    return c ? c.label : (id || '其他');
  },
  sourceLabel: function (a) {
    if (!a) return '';
    if (a.source === 'other' && a.sourceCustom) return a.sourceCustom;
    var s = App.allSources().find(function (x) { return x.id === a.source; });
    return s ? s.label : (a.source || '其他');
  },

  /**
   * 统一图标出口，返回 DOM 节点。
   * 优先级：用户自定义图标（Emoji / 图片 URL） > 内置 SVG > 兜底图标
   */
  icon: function (kind, id, opts) {
    opts = opts || {};
    var custom = (App.settings.customIcons || {})[kind + ':' + id];
    var list = kind === 'cat' ? App.allCategories() : App.allSources();
    var it = list.find(function (x) { return x.id === id; });
    var iconURL = custom || (it && it.iconURL) || '';

    // 图片类图标（默认来源图标 / 用户自定义 URL）统一走本地缓存
    if (iconURL && /^data:image\//i.test(iconURL)) return ICONS.custom(iconURL, opts);   // v2.3.27：本地内嵌品牌图直接渲染
    if (iconURL && /^https?:\/\//i.test(iconURL)) {
      var cachedP = App.iconCache[iconURL] || Store.iconURL(iconURL);
      App.iconCache[iconURL] = cachedP;
      var holder = ICONS.custom(iconURL, opts);
      cachedP.then(function (local) {
        var img = holder.querySelector && holder.querySelector('img');
        if (img && local && local !== iconURL) img.src = local;
      });
      return holder;
    }
    if (custom) return ICONS.custom(custom, opts);
    var key = (it && it.icon) || (kind === 'cat' ? 'other' : 'unknown');
    if (!ICONS.has(key)) return ICONS.custom(key, opts);   // 自定义项可直接存 Emoji
    var o = { size: opts.size, class: opts.class, title: opts.title };
    if (kind === 'src' && it && it.color && opts.brand !== false) o.color = it.color;
    return ICONS.make(key, o);
  },
  categoryIcon: function (id, opts) { return App.icon('cat', id, opts); },
  sourceIcon: function (id, opts) { return App.icon('src', id, opts); },
  sourceColor: function (id) {
    var s = App.allSources().find(function (x) { return x.id === id; });
    return s && s.color ? s.color : '#adb5bd';
  },

  /** 该素材的全部来源（多来源并存时用于标注）；BOOTH / Gumroad 始终排在前面 */
  sourceEntries: function (a) {
    if (!a) return [];
    var entries = (a.sources && a.sources.length) ? a.sources.slice() : [];
    if (!entries.some(function (e) { return e.source === a.source; })) {
      entries.unshift({ source: a.source, sourceCustom: a.sourceCustom, via: a.importedFrom || 'manual', at: a.createdAt });
    }
    var rank = function (s) { return s === 'booth' ? 0 : (s === 'gumroad' ? 1 : 2); };
    return entries.sort(function (x, y) {
      var d = rank(x.source) - rank(y.source);
      return d !== 0 ? d : 0;
    });
  },
  /** 优先显示的主来源：BOOTH > Gumroad > 其他 */
  primarySource: function (a) {
    var entries = App.sourceEntries(a);
    return (entries && entries[0]) || { source: a && a.source, sourceCustom: a && a.sourceCustom };
  },
  /**
   * 版本购买状态：
   *  - 'unpurchased'：有版本/变体、没有一个免费变体、且全部变体都未购买（没有订单链接）
   *  - ''：其他情况（含全部已购、部分已购、免费变体、无版本、非 BOOTH/Gumroad 来源）
   */
  purchaseState: function (a) {
    if (!a) return '';
    var vers = (a.versions || []).filter(function (v) { return v && typeof v === 'object'; });
    if (!vers.length) return '';
    var site = a.source === 'booth' || a.source === 'gumroad' ||
      (Array.isArray(a.sources) && a.sources.some(function (s) { return s && (s.source === 'booth' || s.source === 'gumroad'); }));
    if (!site) return '';
    var hasFree = vers.some(function (v) {
      if (v.special) return true;
      if (/免费|無料|free/i.test(String(v.name || ''))) return true;
      var pd = derivePrice(v.price);
      return pd.isFree === true || (pd.value != null && pd.value === 0);
    });
    if (hasFree) return '';
    if (vers.some(function (v) { return v.orderUrl && String(v.orderUrl).trim(); })) return '';
    /* v2.5.6（用户批复）：**手填购买价 = 用户自己记下"真的花了多少钱"，有值即视为已购买**，
     * 不再判「未购买」——否则它的价格不显示、也不计入花费统计（镜像测试实测：
     * 真实库 as_mtn6u3p2_0l6o39g 手填 0 JPY 却被判未购买）。 */
    if (a.purchasePrice != null && isFinite(Number(a.purchasePrice))) return '';
    // 只有「带价格/变体号」的商店版本才算未购买；本地导入的无价格版本不参与此判断
    var shopLike = vers.some(function (v) { return String(v.price || '').trim() || String(v.variationId || '').trim(); });
    if (!shopLike) return '';
    return 'unpurchased';
  },

  /** 按商品 ID / 链接 / 标题找可能重复的素材 */
  findDuplicate: function (candidate, strict) {
    var cand = Store.normalizeAsset(candidate);
    var candLinks = (cand.links || []).map(function (l) { return String(l.url || '').trim(); }).filter(isHttpUrl);
    var candTitles = [cand.title, cand.originalTitle].map(function (s) { return String(s || '').trim().toLowerCase(); }).filter(function (s) { return s.length >= 4; });
    function hasSource(x, src) {
      return x.source === src || (Array.isArray(x.sources) && x.sources.some(function (s) { return s && s.source === src; }));
    }
    function sameShopSource(x, y, src) { return hasSource(x, src) && hasSource(y, src); }

    for (var i = 0; i < App.assets.length; i++) {
      var b = App.assets[i];
      if (b.id === cand.id) continue;
      // 1) 同源 + 同商品 ID（BOOTH/Gumroad 允许主来源被合并成 other，但 sources 里仍保留原始来源）
      if (cand.itemId && b.itemId === cand.itemId) {
        if (cand.source === b.source) return b;
        if (sameShopSource(cand, b, 'booth')) return b;
        if (sameShopSource(cand, b, 'gumroad')) return b;
      }
      // 2) 商店链接重叠
      var bLinks = (b.links || []).map(function (l) { return String(l.url || '').trim(); }).filter(isHttpUrl);
      if (candLinks.length && bLinks.some(function (l) { return candLinks.indexOf(l) >= 0; })) return b;
      if (!strict) {
        // 3) 标题精确匹配（至少一方带商品链接 / 商品 ID，避免误合并同名素材）
        var bTitles = [b.title, b.originalTitle].map(function (s) { return String(s || '').trim().toLowerCase(); });
        var oneIsShop = (candLinks.length || cand.itemId) || (bLinks.length || b.itemId);
        if (oneIsShop && candTitles.some(function (t) { return bTitles.indexOf(t) >= 0; })) return b;
      }
    }
    return null;
  },

  /** 合并两个素材：以 base 为主体，吸收 incoming 的所有信息与来源 */
  mergeAssets: function (baseIn, incomingIn) {
    var base = Store.normalizeAsset(baseIn);
    var inc = Store.normalizeAsset(incomingIn);
    function concatUniq(a1, a2, keyFn) {
      var seen = {}, out = [];
      (a1 || []).concat(a2 || []).forEach(function (x) {
        var k = keyFn ? keyFn(x) : String(x);
        if (k && !seen[k]) { seen[k] = 1; out.push(x); }
      });
      return out;
    }
    base.title = base.title || inc.title;
    base.originalTitle = base.originalTitle || inc.originalTitle;
    base.itemId = base.itemId || inc.itemId;
    base.description = base.description || inc.description;
    base.author = base.author || inc.author;
    base.shop = base.shop || inc.shop;
    base.shopUrl = base.shopUrl || inc.shopUrl;
    if (base.purchasePrice == null && inc.purchasePrice != null) {
      base.purchasePrice = inc.purchasePrice; base.purchaseCurrency = inc.purchaseCurrency || '';
    }
    if (!base.shopPrice && inc.shopPrice) {
      base.shopPrice = inc.shopPrice; base.shopPriceValue = inc.shopPriceValue; base.shopPriceCurrency = inc.shopPriceCurrency || '';
    }
    if (!base.price && inc.price) base.price = inc.price;
    if (inc.gifted) base.gifted = true;
    base.autoFilled = Object.assign({}, inc.autoFilled || {}, base.autoFilled || {});
    base.userEdited = Object.assign({}, inc.userEdited || {}, base.userEdited || {});
    if (base.category === 'other') base.category = inc.category;
    if (base.source === 'other') base.source = inc.source;
    base.note = [base.note, inc.note].filter(Boolean).join('\n').slice(0, 8000);
    base.favorite = base.favorite || inc.favorite;
    base.hidden = base.hidden || inc.hidden;
    base.fileSize = Math.max(base.fileSize || 0, inc.fileSize || 0);
    base.links = concatUniq(base.links, inc.links, function (l) { return l.url; });
    base.downloadLinks = concatUniq(base.downloadLinks, inc.downloadLinks, function (l) { return l.url; });
    base.paths = concatUniq(base.paths, inc.paths, function (p) { return p.path; });
    base.versions = concatUniq(base.versions, inc.versions, function (v) {
      return v.orderUrl || (v.variationId ? 'vid:' + v.variationId : '') || v.fileName || v.url || v.name;
    })
      .map(function (v) { return Store.normalizeVersion(v); });
    if (inc.activeVersion && !base.activeVersion) base.activeVersion = inc.activeVersion;
    base.tags = concatUniq(base.tags, inc.tags);
    base.rawTags = concatUniq(base.rawTags, inc.rawTags);
    base.images = concatUniq(base.images, inc.images);   // v2.3.11：不再截断到 24 张（与 normalizeAsset 保持一致）
    base.avatars = concatUniq(base.avatars, inc.avatars);
    // 多来源合并
    var srcs = concatUniq(base.sources, inc.sources, function (s) { return s.source + '|' + s.sourceCustom; });
    [base, inc].forEach(function (x) {
      srcs.push(Store.normalizeSource({ source: x.source, sourceCustom: x.sourceCustom, via: x.importedFrom || 'merge', at: nowISO() }));
    });
    base.sources = concatUniq(srcs, [], function (s) { return s.source + '|' + s.sourceCustom; });
    // 主来源优先显示 BOOTH > Gumroad > 其他
    var srcRank = function (s) { return s === 'booth' ? 0 : (s === 'gumroad' ? 1 : 2); };
    base.sources.sort(function (x, y) { return srcRank(x.source) - srcRank(y.source); });
    var bestSrc = base.sources[0] || { source: base.source, sourceCustom: base.sourceCustom };
    if (srcRank(base.source) > srcRank(bestSrc.source)) {
      base.source = bestSrc.source;
      base.sourceCustom = bestSrc.source === 'other' ? (bestSrc.sourceCustom || '') : '';
    }
    // 封面：base 有就用 base；否则继承 incoming 的封面地址，调用方决定是否搬运 Blob
    base.hasCover = base.hasCover || inc.hasCover;
    if (!base.coverURL) base.coverURL = inc.coverURL || '';
    if (!base.hasCover && inc.hasCover) base._adoptCoverFrom = inc.id;
    else delete base._adoptCoverFrom;
    base.extra = Object.assign({}, inc.extra || {}, base.extra || {});
    base.updatedAt = nowISO();
    return Store.normalizeAsset(base);
  },
  avatarLabel: function (id) {
    var v = App.allAvatars().find(function (x) { return x.id === id; });
    return v ? v.label : id;
  },

  /**
   * 标签显示值：开启翻译显示时用 a.tags（多个原文多对一合并后的有效标签）；
   * 关闭翻译显示时直接用 a.rawTags（原文标签）。rawTags 始终参与搜索。
   */
  displayTags: function (a) {
    if (App.settings.tagTranslationEnabled === false) {
      return (a && a.rawTags && a.rawTags.length) ? a.rawTags.slice() : ((a && a.tags) || []).slice();
    }
    return (a && a.tags) || [];
  },

  /**
   * 「通用/多角色」规则：只要素材选了通用，对外（筛选/统计/卡片/详情）只按通用处理，
   * 其他已选角色保留在数据里并锁定，不参与筛选。
   */
  filterAvatars: function (a) {
    var avs = (a && a.avatars) || [];
    // 角色模型素材的“支持角色”只算它自己：按中/日/英角色名反查自己的角色 id，不把其他角色带进统计/筛选
    if (a && a.category === 'avatar') {
      var names = [a.charNameZh, a.charNameJa, a.charNameEn].map(function (n) { return String(n || '').trim().toLowerCase(); }).filter(Boolean);
      var own = '';
      App.allAvatars().some(function (av) {
        var cand = [av.label, av.nameZh, av.nameJa, av.nameEn].concat(av.alias || [])
          .map(function (n) { return String(n || '').trim().toLowerCase(); });
        if (names.some(function (n) { return cand.indexOf(n) >= 0; })) { own = av.id; return true; }
        return false;
      });
      return own ? [own] : [];
    }
    return avs.indexOf('universal') >= 0 ? ['universal'] : avs;
  },

  /**
   * 支持角色按「显示名」去重：内置角色与自定义角色同标签时只保留一个（优先内置 id）。
   */
  normalizeAvatarIds: function (ids, scope) {
    var builtin = {};
    AVATARS.forEach(function (v) { builtin[v.id] = 1; });
    var sorted = (ids || []).slice().sort(function (a, b) {
      return (builtin[b] ? 1 : 0) - (builtin[a] ? 1 : 0);
    });
    var seen = Object.create(null), out = [];
    sorted.forEach(function (id) {
      var label = scope ? App.scopeAvatarLabel(scope, id) : App.avatarLabel(id);
      if (seen[label]) return;
      seen[label] = 1; out.push(id);
    });
    return out;
  },

  /**
   * v2.3.26 清洗 7：剔除指向「已不存在的角色」的悬空引用。
   * 背景：角色记录（settings.customAvatars）丢失后素材仍留着 av_… id → 卡片只能显示裸 id（实测 234 个素材 / 892 处）。
   * 判定依据 = 内置角色 + 自定义角色 + 已合并删除的内置角色。
   * 安全阀：角色字典为空却出现大量「未知」id 时，更可能是设置没读进来而不是真有坏引用 → 整条清洗跳过。
   */
  pruneDanglingAvatars: function (list) {
    var arr = list || App.assets || [];
    if (!App.settings || !Array.isArray(App.settings.customAvatars)) return { removed: 0, changed: [] };
    var known = Object.create(null);
    App.allAvatars().forEach(function (v) { if (v && v.id) known[v.id] = 1; });
    (App.settings.deletedAvatars || []).forEach(function (id) { if (id) known[id] = 1; });
    var unknown = 0;
    arr.forEach(function (a) {
      (a.avatars || []).forEach(function (id) { if (!known[id]) unknown++; });
    });
    if (!unknown) return { removed: 0, changed: [] };
    if (!App.settings.customAvatars.length && unknown > 20) {
      console.warn('[avatarPrune] 跳过：角色字典为空但有 ' + unknown + ' 处未知引用，疑似设置未正确载入');
      return { removed: 0, changed: [] };
    }
    var removed = 0, changedList = [];
    arr.forEach(function (a) {
      var ids = a.avatars || [];
      if (!ids.length) return;
      var kept = ids.filter(function (id) { return known[id]; });
      if (kept.length !== ids.length) { removed += ids.length - kept.length; a.avatars = kept; changedList.push(a); }
    });
    return { removed: removed, changed: changedList };
  },

  /**
   * 设置角色模型素材的「角色名（中/日/英）」，并全局联动：
   * ① 注册/更新自定义角色；② 移除其他素材标签里的同名（含 用/対応/对应 等后缀）；
   * ③ 给受影响素材的「支持角色」添加该角色。
   */
  registerCharacter: function (asset, names) {
    var zh = String(names.zh || '').trim();
    var ja = String(names.ja || '').trim();
    var en = String(names.en || '').trim();
    var aliases = uniq([zh, ja, en].filter(function (s) { return s.length >= 2; }));
    if (!aliases.length) return asset;

    // 1) 找已有角色（按别名匹配，英文忽略大小写），否则注册
    var target = null;
    App.allAvatars().forEach(function (av) {
      if (target) return;
      var cand = [av.label].concat(av.alias || []);
      if (aliases.some(function (n) { return cand.some(function (c) { return String(c || '').trim().toLowerCase() === String(n || '').trim().toLowerCase(); }); })) target = av;
    });
    if (!target) {
      target = { id: 'av_' + Date.now().toString(36), label: zh || ja || en, alias: aliases };
      App.settings.customAvatars.push(target);
    } else {
      target.label = target.label || zh || ja || en;
      target.alias = uniq((target.alias || []).concat(aliases));
    }
    asset.charNameZh = zh; asset.charNameJa = ja; asset.charNameEn = en;
    asset.avatars = [target.id];

    // 2) 其他素材：移除同名标签 + 自动加入支持角色
    var changed = [];
    App.assets.forEach(function (other) {
      if (other.id === asset.id) return;
      var found = false;
      aliases.forEach(function (n) {
        var nl = String(n).toLowerCase();
        var variants = [nl, nl + '用', nl + '対応', nl + '对应', nl + '向け', nl + '用衣装', nl + '対応衣装', nl + '改変', nl + 'ちゃん'];
        var before = other.tags.length + other.rawTags.length;
        other.tags = (other.tags || []).filter(function (t) { return variants.indexOf(String(t).toLowerCase()) < 0; });
        other.rawTags = (other.rawTags || []).filter(function (t) { return variants.indexOf(String(t).toLowerCase()) < 0; });
        if ((other.tags.length + other.rawTags.length) !== before) found = true;
        var hay = [other.title, other.originalTitle, other.description].join(' ').toLowerCase();
        if (hay.indexOf(nl) >= 0) found = true;
      });
      if (found) {
        other.avatars = uniq((other.avatars || []).concat([target.id]));
        changed.push(other);
      }
    });

    return App.saveSettings().then(function () {
      if (changed.length) return Store.putAssets(changed);
    }).then(function () { return asset; });
  },

  /**
   * 合并支持角色：把 sourceId 合并到 targetId。
   * 所有素材的 avatars 引用替换为目标角色；自定义来源角色移除、内置来源角色加入删除清单，
   * 并清理 avatarOverrides / avatarOrder 中的来源角色。
   */
  mergeAvatarRoles: function (sourceId, targetId) {
    sourceId = String(sourceId || '');
    targetId = String(targetId || '');
    if (!sourceId || sourceId === targetId) return Promise.resolve({ changed: 0 });
    var changedAssets = [];
    App.assets.forEach(function (a) {
      if (!(a.avatars || []).some(function (id) { return id === sourceId; })) return;
      a.avatars = uniq((a.avatars || []).map(function (id) { return id === sourceId ? targetId : id; }));
      changedAssets.push(a);
    });
    var customs = App.settings.customAvatars || [];
    App.settings.customAvatars = customs.filter(function (x) { return x.id !== sourceId; });
    var builtin = AVATARS.some(function (x) { return x.id === sourceId; });
    if (builtin) App.settings.deletedAvatars = uniq((App.settings.deletedAvatars || []).concat([sourceId]));
    if (App.settings.avatarOverrides) delete App.settings.avatarOverrides[sourceId];
    if (Array.isArray(App.settings.avatarOrder)) {
      App.settings.avatarOrder = App.settings.avatarOrder.filter(function (id) { return id !== sourceId; });
    }
    return App.saveSettings().then(function () {
      return changedAssets.length ? Store.putAssets(changedAssets) : null;
    }).then(function () {
      return { changed: changedAssets.length };
    });
  },

  /**
   * 本地路径收敛：每个素材只保留一条「存储路径」。
   * 优先选末尾等于素材文件夹名的目录路径；否则选第一条目录路径；再退化为首个文件路径的父目录。
   * 多个版本/变体都在同一存储路径下，因此文件级路径一律不保留。
   */
  consolidateAssetPaths: function (list) {
    list = list || [];
    var changed = 0;
    // 只把「已知文件扩展名」当文件。曾用通用的 /\.[A-Za-z0-9]{1,12}$/ 判断，
    // 把 …_v1.0.6.1 / …v2.0.4 这类【文件夹名】误判为文件 → 下面 parentDir() 砍掉末级、
    // 路径退化成分类目录（商品 7182575 实例，技术手册 §51.6）。
    var FILE_EXT = /\.(zip|rar|7z|unitypackage|png|jpe?g|gif|webp|bmp|tga|psd|clip|sai|txt|pdf|md|url|lnk|fbx|blend|obj|mp4|webm|wav|mp3|ogg|exe|dll)$/i;
    function lastSeg(p) {
      var s = normalizeWinPath(p).replace(/[\\/]+$/, '');
      return String(s.split('\\').pop() || '').toLowerCase();
    }
    function isLikelyFile(p) { return FILE_EXT.test(String(p || '')); }
    function parentDir(p) {
      var s = normalizeWinPath(p);
      var idx = s.lastIndexOf('\\');
      if (idx <= 0) return s;
      if (/^[A-Za-z]:$/.test(s.slice(0, idx))) return s.slice(0, idx) + '\\';
      return s.slice(0, idx);
    }
    list.forEach(function (a) {
      var all = (a.paths || []).map(function (p) {
        return {
          path: (p && typeof p === 'object') ? String(p.path || '') : String(p || ''),
          note: (p && typeof p === 'object' && p.note) || ''
        };
      }).filter(function (x) { return x.path; });
      // v2.2.12：webdav:// 远端路径不参与本地收敛，原样保留（否则会被当 Windows 路径截断）
      var remote = all.filter(function (x) { return App.isWebdavPath(x.path); })
        .map(function (x) { return { path: x.path, note: '网盘路径' }; });
      var entries = all.filter(function (x) { return !App.isWebdavPath(x.path); }).map(function (x) {
        return { path: normalizeWinPath(x.path), note: x.note };
      }).filter(function (x) { return x.path; });
      if (!entries.length) {
        if (remote.length && JSON.stringify(remote) !== JSON.stringify(a.paths || [])) { a.paths = remote; changed++; }
        return;
      }
      var expected = App.folderName(a).toLowerCase();
      var catLabel = String(App.categoryLabel(a.category || 'other') || '').toLowerCase();
      // 末级正好等于素材文件夹名 → 就是它，不再做「像不像文件」的判断（这是 7182575 被砍成分类目录的直接原因）
      var exact = entries.filter(function (x) { return lastSeg(x.path) === expected; })[0];
      var chosen;
      if (exact) chosen = exact;
      else {
        // 其次：不像文件、且末级不是分类目录名；再次：不像文件；最后才退回第一条
        chosen = entries.filter(function (x) { return !isLikelyFile(x.path) && lastSeg(x.path) !== catLabel; })[0]
          || entries.filter(function (x) { return !isLikelyFile(x.path); })[0]
          || entries[0];
      }
      var finalPath = (!exact && isLikelyFile(chosen.path)) ? parentDir(chosen.path) : chosen.path;
      finalPath = normalizeWinPath(finalPath);
      var one = [{ path: finalPath, note: '存储路径' }].concat(remote);
      if (JSON.stringify(one) !== JSON.stringify(a.paths || [])) { a.paths = one; changed++; }
    });
    return { list: list, changed: changed };
  },

  /**
   * 定向修复「存储路径退化成分类目录」的历史坏数据（技术手册 §51.6）。
   * 只处理【末级正好等于分类名】这一种确定坏形态（全库仅十余条），用宿主确认
   * <库根>\<分类>\<素材文件夹名> 真实存在才改写；不做全库扫描，宿主离线直接跳过。
   */
  repairCategoryOnlyPaths: function (list) {
    list = list || [];
    var rootPath = App.libraryRoot();
    var changed = 0;
    // 路径末级若正好是【任一】分类名，说明它曾被截断成分类目录。
    // 注意：不能用素材的「当前分类」来判断——分类改过之后路径里的分类段是【旧分类】
    // （实测 7182575：路径停在 着色器\，而当前分类已是 工具，按当前分类比对必然漏修）。
    var catLabels = {};
    App.allCategories().forEach(function (c) { catLabels[String(c.label).toLowerCase()] = 1; });
    function catSegOf(p) {
      var s = normalizeWinPath(p).replace(/[\\/]+$/, '');
      var seg = String(s.split('\\').pop() || '');
      return catLabels[seg.toLowerCase()] ? seg : '';
    }
    var targets = list.filter(function (a) {
      var p = (a.paths || [])[0];
      return !!(p && p.path && catSegOf(p.path));
    });
    if (!targets.length) return Promise.resolve({ changed: 0 });
    return FS.hostEnsure().then(function (ok) {
      if (!ok) return { changed: 0 };
      var chain = Promise.resolve();
      targets.forEach(function (a) {
        chain = chain.then(function () {
          var cand = joinWinPath(rootPath, [catSegOf(a.paths[0].path), App.folderName(a)]);
          return FS.host.exists(cand).then(function (kind) {
            if (kind !== 'dir') return;
            App.setPathEntry(a, cand, '存储路径');
            changed++;
          });
        });
      });
      return chain.then(function () { return { changed: changed }; });
    }).catch(function () { return { changed: changed }; });
  },

  /**
   * v4.3.2：登记某类路径（默认「存储路径」）时只替换这一类，其余条目原样保留。
   * 以前多处直接 `asset.paths = [{…}]`，建档/导入一次就把用户登记的网盘位置、
   * 原始位置全部清空，而且保存后不可恢复。
   */
  setPathEntry: function (asset, path, note) {
    note = note || '存储路径';
    var list = (asset.paths || []).filter(function (x) { return x && x.path; });
    var hit = false;
    list = list.map(function (x) {
      if ((x.note || '') === note) { hit = true; return { path: path, note: note }; }
      return x;
    });
    if (!hit) list.push({ path: path, note: note });
    asset.paths = list;
    return asset;
  },

  /**
   * 素材文件夹改名后，同步更新其「存储路径」的最后一级目录名。
   */
  updatePathsForFolderName: function (asset, oldFolder, newFolder) {
    if (!oldFolder || oldFolder === newFolder) return asset;
    (asset.paths || []).forEach(function (p) {
      if (!p || typeof p !== 'object' || !p.path) return;
      var path = normalizeWinPath(p.path);
      var idx = path.toLowerCase().lastIndexOf('\\' + String(oldFolder).toLowerCase());
      if (idx >= 0 && idx + oldFolder.length + 1 === path.length) {
        p.path = path.slice(0, idx + 1) + newFolder;
        p.note = p.note || '存储路径';
      }
    });
    return asset;
  },
  /** v5.6（用户要求）：统一的「改标题」入口 —— 右键菜单和编辑页保存都最终走同一套逻辑。
   *  顺序：校验重名 → 改磁盘目录 → 同步存储路径 → 落库 → 刷新卡片与已打开的详情页。 */
  renameAssetTo: function (id, newTitle) {
    var live = (App.assets || []).filter(function (x) { return x.id === id; })[0];
    if (!live) return Promise.resolve({ ok: false, reason: '素材不存在' });
    var t = String(newTitle == null ? '' : newTitle).trim();
    if (!t) return Promise.resolve({ ok: false, reason: '标题不能为空' });
    if (t === live.title) return Promise.resolve({ ok: true, changed: false });
    /* 重名预检：App.save 里还有同一道检查（防止别处绕过），这里先拦是为了能说清「和谁重名」。 */
    var next = Object.assign({}, live, { title: t });
    var want = App.folderName(next);
    var clash = App.assets.filter(function (x) {
      return x.id !== id && App.folderName(x).toLowerCase() === want.toLowerCase();
    })[0];
    if (clash) return Promise.resolve({ ok: false, reason: '已存在同名素材「' + (clash.title || clash.id) + '」，换个标题或角色名' });
    var beforePath = ((live.paths || [])[0] || {}).path || '';
    next.updatedAt = nowISO();
    /* 真正的改名 / 路径同步 / 落库都在 App.save 里（编辑页保存走的也是它），这里只负责预检与界面刷新。 */
    return App.save(next).then(function (saved) {
      var afterPath = (((saved || next).paths || [])[0] || {}).path || '';
      App.refreshAssetView(saved || next);
      return { ok: true, changed: true, renamed: !!(beforePath && afterPath && beforePath !== afterPath) };
    }).catch(function (e) {
      return { ok: false, reason: (e && e.message) || String(e) };
    });
  },

  /** 卡片 + 已打开的详情页一起刷新（详情页里显示着存储路径，目录改名后必须跟着变）。 */
  refreshAssetView: function (asset) {
    if (!asset || !asset.id) return;
    try { UI.refreshCard(asset.id); } catch (e) {}
    var top = (typeof Modal !== 'undefined' && Modal.stack && Modal.stack.length) ? Modal.stack[Modal.stack.length - 1] : null;
    if (top && top.kind === 'detail' && App.detailAssetId === asset.id && typeof Modals !== 'undefined' && Modals.detail) {
      Modals.detail(asset.id, top, { noAutoEnrich: true });
    }
  },

  syncCharacterConfigs: function (list, scope) {
    list = list || App.assets;
    var cfgChanged = false;
    var assetsChanged = [];

    function same(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
    function hasName(names, target) {
      return names.some(function (n) { return n && n.length >= 2 && same(n, target); });
    }
    /* v2.5.13（性能）：角色表在**本轮同步内只取一遍**（原先每条模型素材都重建一次 allAvatars）。
     * 作用域失效检查仍在 scopeAvatars 里：设置表被换掉就重建；新建的角色顺手补进缓存表。 */
    function avatarPool() { return scope ? App.scopeAvatars(scope) : App.allAvatars(); }
    /* v2.5.13（性能）：再把「每条模型素材都对角色表做一次 find」换成**一次建索引**——
     * key = 角色名（label / nameZh / nameJa / nameEn / alias，trim+小写），value = 该名字在表里**最早**出现的下标。
     * 语义与原来的 Array.find 完全一致：取「表里第一个名字匹配上的角色」（资产名取全长 ≥ 2 的）。
     * 索引跟着池子的**数组身份**走：池子被重建（设置变了）或新建了角色（push 进池子）就作废重算。 */
    var poolIdxMap = null, poolIdxList = null;
    function poolIndexOf(pool, names) {
      if (!poolIdxMap || poolIdxList !== pool) {
        poolIdxMap = Object.create(null); poolIdxList = pool;
        for (var pi = 0; pi < pool.length; pi++) {
          var c = pool[pi];
          [c.label, c.nameZh, c.nameJa, c.nameEn].concat(c.alias || []).forEach(function (x) {
            var k = String(x == null ? '' : x).trim().toLowerCase();
            if (k && poolIdxMap[k] === undefined) poolIdxMap[k] = pi;
          });
        }
      }
      var best = -1;
      names.forEach(function (n) {
        if (!n || n.length < 2) return;
        var hit = poolIdxMap[String(n).trim().toLowerCase()];
        if (hit !== undefined && (best < 0 || hit < best)) best = hit;
      });
      return best;
    }

    // 1) 模型角色 → 三语配置
    list.forEach(function (a) {
      if (a.category !== 'avatar') return;
      var zh = String(a.charNameZh || '').trim();
      var ja = String(a.charNameJa || '').trim();
      var en = String(a.charNameEn || '').trim();
      if (!zh && !ja && !en) return;
      var names = uniq([zh, ja, en].filter(Boolean));
      var custom = App.settings.customAvatars || (App.settings.customAvatars = []);
      // 先在整个角色表（内置 + 自定义）里按名字/别名匹配；命中就直接复用，不再新建重复角色
      var pool = avatarPool();
      var poolHit = poolIndexOf(pool, names);
      var target = poolHit >= 0 ? pool[poolHit] : null;
      if (!target) {
        target = { id: 'av_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
          label: zh || ja || en, nameZh: zh, nameJa: ja, nameEn: en, alias: names };
        custom.push(target); cfgChanged = true;
        // 新建的角色要让同一轮里后面的素材也能匹配到（等价于逐次 allAvatars()）
        if (scope && scope.avList) scope.avList.push(target);
        if (scope) scope.avLabels = null;
        poolIdxMap = null;                    // 角色表变了 → 名字索引作废重算
      } else if (custom.some(function (c) { return c.id === target.id; })) {
        if (!target.nameZh && zh) { target.nameZh = zh; cfgChanged = true; }
        if (!target.nameJa && ja) { target.nameJa = ja; cfgChanged = true; }
        if (!target.nameEn && en) { target.nameEn = en; cfgChanged = true; }
        var mergedAlias = uniq((target.alias || []).concat(names));
        if (mergedAlias.join('|') !== (target.alias || []).join('|')) { target.alias = mergedAlias; cfgChanged = true; }
      }
      a.avatars = uniq((a.avatars || []).concat([target.id]));
      assetsChanged.push(a);
    });

    // 2) 支持角色 → 命中模型名字的素材
    var models = list.filter(function (a) { return a.category === 'avatar'; });
    // v2.5.13（性能）：模型的三语名字在 425×模型数 的双层循环外先算一遍（原先是每个「其它素材」都重算）
    var modelNames = models.map(function (m) { return [m.charNameZh, m.charNameJa, m.charNameEn].filter(Boolean); });
    // 小写形式也先算一遍（原先每个「其它素材 × 模型 × 名字」都要 toLowerCase 一次）
    var modelNamesLower = modelNames.map(function (ns) { return ns.map(function (n) { return String(n).toLowerCase(); }); });
    list.forEach(function (other) {
      if (other.category === 'avatar') return;
      var hay = [other.title, other.originalTitle, other.description].concat(other.tags || [], other.rawTags || []).join(' ').toLowerCase();
      models.forEach(function (m, mi) {
        var names = modelNames[mi];
        if (!names.length) return;
        var low = modelNamesLower[mi];
        var hit = names.some(function (n, ni) { return n.length >= 2 && hay.indexOf(low[ni]) >= 0; });
        if (!hit) return;
        var target = (App.settings.customAvatars || []).find(function (c) {
          return [c.nameZh, c.nameJa, c.nameEn, c.label].concat(c.alias || []).some(function (x) { return hasName(names, x); });
        }) || null;
        if (target && (other.avatars || []).indexOf(target.id) < 0) {
          other.avatars = uniq((other.avatars || []).concat([target.id]));
          if (assetsChanged.indexOf(other) < 0) assetsChanged.push(other);
        }
      });
    });

    return { cfgChanged: cfgChanged, assetsChanged: assetsChanged };
  },

  /**
   * 冗余维护：清理重复的「支持角色」配置。
   * - 自定义角色若与内置角色同名/同别名 → 删除自定义项，素材引用改指内置 id；
   * - 自定义角色之间同标签/同别名 → 合并为最早一条，素材引用改指规范 id。
   * 每次 reload 自动执行（幂等）。
   */
  dedupeAvatarConfigs: function (list) {
    list = list || App.assets;
    var custom = App.settings.customAvatars || [];
    var cfgChanged = false;
    var assetsChanged = [];
    if (!custom.length) return { cfgChanged: false, assetsChanged: [] };
    function norm(s) { return String(s || '').trim().toLowerCase(); }
    function keys(c) {
      return [c.label, c.nameZh, c.nameJa, c.nameEn].concat(c.alias || []).map(norm).filter(function (x) { return x.length >= 2; });
    }
    var byId = {};
    custom.forEach(function (c) { byId[c.id] = c; });
    var keep = [];
    var remap = {};
    custom.forEach(function (c) {
      var cKeys = keys(c);
      var builtin = AVATARS.find(function (v) {
        var vKeys = [v.label].concat(v.alias || []).map(norm);
        return cKeys.some(function (x) { return vKeys.indexOf(x) >= 0; });
      });
      var earlier = keep.find(function (prev) {
        var pKeys = keys(prev);
        return cKeys.some(function (x) { return pKeys.indexOf(x) >= 0; });
      });
      var canonicalId = builtin ? builtin.id : (earlier ? earlier.id : '');
      if (canonicalId && canonicalId !== c.id) {
        remap[c.id] = canonicalId;
        cfgChanged = true;
        if (!builtin && byId[canonicalId]) {
          var t = byId[canonicalId];
          if (!t.nameZh && c.nameZh) { t.nameZh = c.nameZh; }
          if (!t.nameJa && c.nameJa) { t.nameJa = c.nameJa; }
          if (!t.nameEn && c.nameEn) { t.nameEn = c.nameEn; }
          var merged = uniq((t.alias || []).concat(c.alias || []));
          if (merged.join('|') !== (t.alias || []).join('|')) t.alias = merged;
        }
      } else {
        keep.push(c);
      }
    });
    if (cfgChanged) {
      App.settings.customAvatars = keep;
      list.forEach(function (a) {
        var before = (a.avatars || []).join('|');
        var fixed = uniq((a.avatars || []).map(function (id) { return remap[id] || id; }));
        if (fixed.join('|') !== before) {
          a.avatars = fixed;
          if (assetsChanged.indexOf(a) < 0) assetsChanged.push(a);
        }
      });
    }
    return { cfgChanged: cfgChanged, assetsChanged: assetsChanged };
  },

  /* ---------------- 设置 ---------------- */
  loadSettings: function () {
    return Store.kvGet('settings', null).then(function (s) {
      var base = defaultSettings();
      var settingsDirty = false;
      if (s && typeof s === 'object') {
        Object.keys(base).forEach(function (k) { if (s[k] !== undefined) base[k] = s[k]; });
        // 代理功能已移除：旧代理列表不再使用
        if (!Array.isArray(base.proxies)) base.proxies = [];
        // v1.0 -> v1.1 迁移：proxyMode 合并为 fetchMode；v2.0 起旧「代理/直连/自动」统一改为宿主联网
        if (s.fetchMode === undefined && s.proxyMode !== undefined) {
          base.fetchMode = (s.proxyMode === 'direct') ? 'direct' : 'paste';
        }
        if (['proxy', 'direct', 'auto'].indexOf(base.fetchMode) >= 0) base.fetchMode = 'host';
        if (FETCH_MODES.map(function (m) { return m.id; }).indexOf(base.fetchMode) < 0) base.fetchMode = 'paste';
        // 旧版本可能保存过账号密码，按新要求一律清除，只保留 Cookie
        var creds = base.credentials || {};
        Object.keys(creds).forEach(function (h) {
          if (creds[h] && (creds[h].user !== undefined || creds[h].pass !== undefined)) {
            creds[h] = { cookie: creds[h].cookie || '' };
          }
        });
      }
      // 角色列表优先显示只允许 显示名(label)/zh/ja/en；无效值回退显示名。
      // v2.2.5 曾把用户点过的值直接保存：首次进入 v2.2.6 统一恢复「显示名（默认）」，之后可再自由选择。
      if (['label', 'zh', 'ja', 'en'].indexOf(base.avatarNamePriority) < 0) {
        base.avatarNamePriority = 'label'; settingsDirty = true;
      }
      if (!base.avatarNamePriorityMigrated && base.avatarNamePriority !== 'label') {
        base.avatarNamePriority = 'label'; base.avatarNamePriorityMigrated = true; settingsDirty = true;
      }
      /* v4.1.0：hostToolPath / hostBackground / proxyToolPath 随旧 WebView2 壳一并移除 ——
       * 宿主已内置在 Electron 主进程里，不再有「宿主工具文件夹」或启动器参数可配置。
       * 这里只做存量清理，免得旧 settings.json 里一直留着三个永不生效的键。 */
      ['proxyToolPath', 'hostToolPath', 'hostBackground'].forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(base, k)) { delete base[k]; settingsDirty = true; }
      });
      // v1.8.1 迁移：本地路径设置统一为单反斜杠（修复历史版本写入的双反斜杠）
      ['libraryRootPath'].forEach(function (k) {
        var nv = normalizeWinPath(base[k]);
        if (nv !== base[k]) { base[k] = nv; settingsDirty = true; }
      });
      App.settings = base;
      /* v3.0.4：窄条件路径自愈（不阻塞设置加载；宿主离线或路径有效时什么都不做） */
      try { App.healDerivedPaths(); } catch (e) {}
      if (settingsDirty) App.saveSettings();
      return base;
    });
  },
  /* ---------------- 文件主库（v2.3.0） ----------------
   * <HTML 同目录>\vrclib-data\ 是数据本体，IndexedDB 降为缓存。
   * 宿主离线 / 非 file:// 打开且未配置目录 → 只在浏览器缓存里读写，不落盘。
   */
  localDir: '',
  localReadOnly: false,
  _fileDirty: null,
  _fileTimer: null,
  /** 启动时读入文件主库；文件存在则以文件为准并回灌 IndexedDB */
  localOffline: false,
  localCacheNewer: false,   // v2.3.3：启动时发现缓存比文件新 → 稍后由启动链回写文件
  bootLocalData: function () {
    App.localDir = Store.local.dataDir(App.settings);
    // 无法推导数据目录（非 file:// 打开且未配置）→ 只读缓存
    if (!App.localDir) { App.localReadOnly = true; App.localOffline = false; return Promise.resolve(false); }
    // v2.3.1 修正：宿主离线时必须真的进入「只读缓存」，否则每次保存都静默写失败且不提示。
    // 读取本身不受影响——素材照常从 IndexedDB 缓存读出，只是改动暂不落盘。
    return FS.hostEnsure().then(function (ok) {
      if (!ok) { App.localReadOnly = true; App.localOffline = true; return false; }
      App.localReadOnly = false; App.localOffline = false;
      // v2.3.3：文件与缓存**比时间戳**，谁新用谁。
      // 否则会出现：离线期间改了东西（只在缓存），下次启动被那份旧的 assets.json 覆盖掉。
      return Promise.all([Store.local.loadAll(App.settings), Store.allAssets()]).then(function (r) {
        var loc = r[0], cached = r[1] || [];
        // v2.3.18：settings.json 的外壳是 {v,at,settings:{…}}，这里必须只取内层——
        // 以前把整包并进 App.settings，v/at/settings 三键于是被写回，文件每次启动多嵌一层
        // （实测用户文件里已出现 settings.settings 嵌套），而且文件里的设置从来没被读进来过。
        if (loc.settings) {
          var savedSettings = (loc.settings.settings && typeof loc.settings.settings === 'object') ? loc.settings.settings : loc.settings;
          /* v4.1.0：文件里可能残留旧 WebView2 壳的宿主启动参数（宿主工具目录 / 后台隐藏运行）。
           * 这里在合并前剔掉，否则上面 loadSettings 的清理会被这一步原样覆盖回来。 */
          ['proxyToolPath', 'hostToolPath', 'hostBackground'].forEach(function (k) { delete savedSettings[k]; });
          App.settings = Object.assign({}, App.settings, savedSettings);
          delete App.settings.v; delete App.settings.at; delete App.settings.settings;
        }
        var list = (loc.assets && Array.isArray(loc.assets.assets)) ? loc.assets.assets : null;
        if (!list && (loc.readErrors || []).length) {
          // v2.3.11：数据文件**存在但读不出来**（宿主旧 2MB 上限（现 64MB） / JSON 损坏 / 权限）——
          // 绝不能当「首次运行」处理，否则启动链会把内存里的空列表写回去 = 清空整个素材库。
          App.localReadOnly = true;
          App.localReadBroken = true;
          App.localReadError = loc.readErrors.join('；');
          console.warn('[localData] 数据文件读取失败，已暂停写入：' + App.localReadError);
          return false;
        }
        if (!list || !list.length) return false;            // 首次运行：交给 reload 收尾后写入
        var fileAt = Date.parse((loc.assets && loc.assets.at) || '') || 0;
        var cacheAt = 0;
        cached.forEach(function (x) { var t = Date.parse((x && x.updatedAt) || '') || 0; if (t > cacheAt) cacheAt = t; });
        if (cacheAt > fileAt + 2000) {                      // 缓存更新 → 不采用旧文件，交给启动链回写
          App.localCacheNewer = true;
          return false;
        }
        App.localCacheNewer = false;
        var fixed = list.map(Store.normalizeAsset);
        App.assets = fixed;
        return Store.putAssets(fixed).then(function () { return true; });
      });
    }).catch(function () { App.localReadOnly = true; return false; });
  },
  /** v2.3.11：数据文件读不出来时的红色告警条——先保住文件，再谈写入 */
  showReadBrokenBanner: function () {
    if (document.getElementById('localReadBrokenBanner')) return;
    var bar = el('div', { id: 'localReadBrokenBanner', class: 'local-banner local-banner-danger' }, [
      el('span', {}, ICONS.label('\u26D4 数据文件读取失败，已暂停写入以防覆盖：' + (App.localReadError || '未知原因') + '（素材仍从浏览器缓存读取）')),
      el('button', { class: 'btn btn-xs btn-primary', onclick: function () { location.reload(); } }, '修复后重新载入'),
      el('button', { class: 'btn btn-xs', onclick: function () { var b = document.getElementById('localReadBrokenBanner'); if (b) b.remove(); } }, '知道了')
    ]);
    document.body.insertBefore(bar, document.body.firstChild);
  },
  /** 宿主离线时的常驻提示条：说明当前只读缓存，并提供「重试连接」把改动补写落盘 */
  showLocalBanner: function () {
    if (document.getElementById('localDataBanner')) return;
    var bar = el('div', { id: 'localDataBanner', class: 'local-banner' }, [
      el('span', {}, ICONS.label('\u26A0 内置宿主离线：素材照常读取，但改动只存在浏览器缓存，尚未写入 ' + (App.localDir || '数据目录'))),
      el('button', { class: 'btn btn-xs btn-primary', onclick: function () {
        FS.hostEnsureRetry(3).then(function (ok) {
          if (!ok) { Toast.warn('仍未连接到内置宿主：请重启程序后再点重试', 6200); return; }
          App.localReadOnly = false; App.localOffline = false;
          var b = document.getElementById('localDataBanner'); if (b) b.remove();
          Toast.ok('已连接内置宿主，正在把离线期间的改动写入 ' + App.localDir);
          App.scheduleFileSync();     // 无参 = 素材与设置都标脏，整体补写一次
          App.syncCoverFiles(60);     // 顺带补写离线期间只落在浏览器缓存里的封面（v2.5.14：20 → 60）
        });
      } }, ICONS.label('\u{1F504} 重试连接')),
      el('button', { class: 'btn btn-xs', onclick: function () {
        var b = document.getElementById('localDataBanner'); if (b) b.remove();
      } }, '知道了')
    ]);
    document.body.insertBefore(bar, document.body.firstChild);
  },
  /**
   * v2.3.3：扫描素材库，给「磁盘上已有文件夹、但素材没有本地路径」的素材补上路径。
   * 手动触发、只补不删：按 folderName 在各分类目录下查找真实存在的目录，
   * 当前分类优先；找不到就跳过（不改动任何已有路径，也不新建文件夹）。
   */
  scanAndFillPaths: function (onLog) {
    onLog = onLog || function () {};
    var rootPath = App.libraryRoot();
    var targets = (App.assets || []).filter(function (a) {
      var local = (a.paths || []).filter(function (p) { return p && p.path && !App.isWebdavPath(p.path); });
      return !local.length;
    });
    if (!targets.length) return Promise.resolve({ checked: 0, filled: 0, skipped: 0 });
    return FS.hostEnsure().then(function (ok) {
      if (!ok) throw new Error('内置宿主离线：无法扫描素材库，请先启动宿主');
      var labels = App.allCategories().map(function (c) { return c.label; });
      var filled = 0, skipped = 0;
      var chain = Promise.resolve();
      targets.forEach(function (a) {
        chain = chain.then(function () {
          var cur = App.categoryLabel(a.category || 'other');
          var order = [cur].concat(labels.filter(function (l) { return l !== cur; }));
          var probe = Promise.resolve(null);
          order.forEach(function (lbl) {
            probe = probe.then(function (hit) {
              if (hit) return hit;
              var p = joinWinPath(rootPath, [lbl, App.folderName(a)]);
              return FS.host.exists(p).then(function (k) { return k === 'dir' ? p : null; }).catch(function () { return null; });
            });
          });
          return probe.then(function (hit) {
            if (!hit) { skipped++; return null; }
            App.setPathEntry(a, hit, '存储路径');
            filled++;
            onLog('\u2714 ' + (a.itemId || a.title || a.id) + ' → ' + hit);
            return App.save(a);
          });
        });
      });
      return chain.then(function () {
        onLog('\u2714 扫描完成：检查 ' + targets.length + ' 个无路径素材，补上 ' + filled + ' 个，未找到 ' + skipped + ' 个');
        return { checked: targets.length, filled: filled, skipped: skipped };
      });
    });
  },

  /** 变更后延迟写文件（合并短时间内的多次保存） */
  scheduleFileSync: function (what) {
    if (!App.localDir || App.localReadOnly) return;
    App._fileDirty = App._fileDirty || {};
    if (what) App._fileDirty[what] = true;
    else { App._fileDirty.assets = true; App._fileDirty.settings = true; }
    if (App._fileTimer) clearTimeout(App._fileTimer);
    App._fileRetryCount = 0;   // v2.5.3：有新的改动 → 自动重试次数重新计（用户在编辑＝还在努力补写）
    App._fileTimer = setTimeout(function () { App.flushFileSync(); }, 1200);
  },
  flushFileSync: function () {
    if (!App.localDir || App.localReadOnly || App.localReadBroken) return Promise.resolve(false);
    var d = App._fileDirty || {};
    App._fileDirty = null;
    var jobs = [];
    if (d.assets) jobs.push(Store.local.saveAssets(App.assets, App.settings));
    if (d.settings) jobs.push(Store.local.saveSettings(App.settings));
    if (!jobs.length) return Promise.resolve(false);
    return Promise.all(jobs).then(function (rs) {
      var failed = rs.some(function (r) { return r === false; });
      if (!failed) { App._fileWarned = false; App._fileRetryCount = 0; App._fileWarnKind = ''; return true; }
      // v2.3.2：写失败不静默——重新标脏 + 明确提示 + 自动重试（宿主恢复后由「重试连接」或这里补写）
      App._fileDirty = App._fileDirty || {};
      if (d.assets) App._fileDirty.assets = true;
      if (d.settings) App._fileDirty.settings = true;
      /* v3.0.0（D9 · 容量悬崖）：先分清楚是哪一类失败再说话。原因来自 Store.local.lastWriteFail()。 */
      var fInfo = (Store.local.lastWriteFail && Store.local.lastWriteFail()) || { kind: 'host-offline' };
      var fKind = fInfo.kind || 'host-offline';
      var retryable = (fKind !== 'too-large');
      if (fKind !== App._fileWarnKind) { App._fileWarned = false; App._fileWarnKind = fKind; }   // 原因变了要重新说明一次
      if (!App._fileWarned) { App._fileWarned = true; Toast.warn(fileWriteFailText(fKind, fInfo), 9000); }
      /* v2.5.3：自动重试加**次数上限**。原先宿主一直离线时每 20 秒重排一次、永不停止（每次还连带 5 个端口的
       * 宿主探测）。上限 15 次（约 5 分钟）后停下，改由「重试连接」按钮或下一次改动（scheduleFileSync）重新开始。
       * v3.0.0（D9）：① 体积超上限 = 确定性失败 → **一次也不重试**；② 其它两类每次重试都让用户看见进度与原因
       * （1/15、3/15 …），不再静默空转 5 分钟。 */
      var FILE_RETRY_MAX = 15, FILE_RETRY_MS = 20000;
      if (!retryable) {
        App._fileRetryCount = FILE_RETRY_MAX;
        console.warn('[localData] 体积超过宿主写入上限，已停止自动重试：' + JSON.stringify(fInfo));
        return false;
      }
      if (!App._fileRetry && (App._fileRetryCount || 0) < FILE_RETRY_MAX) {
        App._fileRetryCount = (App._fileRetryCount || 0) + 1;
        var fN = App._fileRetryCount;
        App._fileRetry = setTimeout(function () {
          App._fileRetry = null;
          if (App._fileDirty && !App.localReadOnly) App.flushFileSync();
          else if ((App._fileRetryCount || 0) >= FILE_RETRY_MAX) {
            console.warn('[localData] 自动重试已达上限，等宿主恢复后由「重试连接」或新的改动补写');
            Toast.err('自动重试已停止（' + App._fileRetryCount + '/' + FILE_RETRY_MAX + '）：' + fileWriteFailShort(fKind)
              + '。改动仍在浏览器缓存里；修好后点顶部提示条的「重试连接」，或再改一次任意素材即可补写。', 9000);
          }
        }, FILE_RETRY_MS);
        if (fN === 1 || fN % 3 === 0) {
          Toast.info('仍在重试写入（' + fN + '/' + FILE_RETRY_MAX + '，每 ' + (FILE_RETRY_MS / 1000) + ' 秒一次）：'
            + fileWriteFailShort(fKind) + ' —— 改动仍在浏览器缓存里', 4200);
        }
      }
      return false;
    }).catch(function () { return false; });
  },
  /** v2.3.2：宿主恢复后，把只在浏览器缓存里的封面补写到 vrclib-data\covers。
   *  v2.5.14（用户批复 · 修3）：改成**游标续跑 + 两处一起补**。旧实现 `filter(hasCover).slice(0, limit)`
   *  是「先截断再判断磁盘有没有」，于是永远只照顾前 20 条、后面的素材永远轮不到（真实库实测：
   *  398 条有本地路径的素材里 339 条素材文件夹缺 <文件夹名>.png）。现在每轮从上次位置继续，
   *  逐个走 ensureCoverOnDisk（covers 目录 + 素材文件夹，已存在的直接跳过）。 */
  syncCoverFiles: function (limit) {
    if (!App.localDir || App.localReadOnly) return Promise.resolve(0);
    var list = (App.assets || []).filter(function (x) { return x && x.hasCover; });
    if (!list.length) return Promise.resolve(0);
    var batch = Math.max(1, Number(limit) || 20);
    var start = Number(App._coverSyncCursor) || 0;
    if (start >= list.length) start = 0;
    var slice = list.slice(start, start + batch);
    App._coverSyncCursor = (start + slice.length >= list.length) ? 0 : (start + slice.length);
    var n = 0, chain = Promise.resolve();
    slice.forEach(function (x) {
      chain = chain.then(function () {
        return App.ensureCoverOnDisk(x, { quiet: true }).then(function (r) {
          if (r.covers === 'ok' || r.folder === 'ok') n++;
        });
      });
    });
    return chain.then(function () { return n; });
  },
  saveSettings: function () { App.scheduleFileSync('settings'); return Store.kvSet('settings', App.settings); },
  exportableSettings: function () {
    var s = JSON.parse(JSON.stringify(App.settings));
    delete s.credentials;   // 凭证绝不随备份导出
    delete s.ai;            // AI 密钥同样不导出
    delete s.githubToken;   // v2.3.25：GitHub Token 同样不导出
    /* v4.3.2 修复：webdavAccounts 里带着 passwordEnc、账号名和内网地址，
     * 但导出时一直没剥掉，与设置页「凭证永不随备份导出」的承诺相反。
     * 落库用的 SETTINGS_SKIP 早就排除了它，导出这条路径漏了。 */
    delete s.webdavAccounts;
    return s;
  },

  /* ---------------- 数据加载 & 存量清洗 ---------------- */
  reload: function () {
    return Store.allAssets().then(function (list) {
      var changed = false;
      /* v2.5.13（性能复查第 2 轮）：整轮存量清洗共用一个**批量作用域**——
       * 角色表 / 角色 id→显示名 / 标签名表 / 黑名单正则 / 工具名角色表 各只建一遍。
       * 作用域是本函数私有的临时对象、用完即弃，**不是跨调用缓存**（v2.5.7 的护栏见 App.newScope 注释）。 */
      var scope = App.newScope();
      list.forEach(function (a) {
        // 清洗 1：标签剔除角色名（多语言别名）+ 黑名单
        var t = Smart.filterBlacklist(Smart.purgeAvatarTags(a.tags || [], scope), scope);
        var r = Smart.filterBlacklist(Smart.purgeAvatarTags(a.rawTags || [], scope), scope);
        if (t.join('|') !== (a.tags || []).join('|')) { a.tags = t; changed = true; }
        if (r.join('|') !== (a.rawTags || []).join('|')) { a.rawTags = r; changed = true; }
        // 清洗 1.5：图集剔除缩略图（只保留原图）
        var cleanImgs = (a.images || []).filter(function (u) {
          var s = String(u);
          if (/\/c\/\d+x\d+_/i.test(s)) return false;         // BOOTH 72x72 缩略图
          if (/(^|[\/_.-])thumbnail([\/_.-]|$)/i.test(s)) return false;
          return true;
        });
        if (cleanImgs.join('|') !== (a.images || []).join('|')) { a.images = cleanImgs; changed = true; }
        // 清洗 2：标题去掉「- 店名 - BOOTH」后缀
        var ct = App.cleanTitle(a.title);
        var co = App.cleanTitle(a.originalTitle);
        if (ct !== a.title) { a.title = ct; changed = true; }
        if (co !== a.originalTitle) { a.originalTitle = co; changed = true; }
        // 清洗 3：本地文件路径统一单反斜杠，并把字符串路径规范成 {path, note} 结构
        var cleanedPaths = concatUnique([], a.paths, function (p) {
          return normalizeWinPath(typeof p === 'string' ? p : (p && p.path));
        }).map(function (p) {
          var path = normalizeWinPath(typeof p === 'string' ? p : (p && p.path));
          return { path: path, note: (p && typeof p === 'object' && p.note) || '' };
        });
        if (JSON.stringify(cleanedPaths) !== JSON.stringify(a.paths || [])) { a.paths = cleanedPaths; changed = true; }
        // 清洗 3.5：支持角色按显示名去重（修复内置角色与模型自定义角色同名时出现两个相同 chip）
        var cleanAv = App.normalizeAvatarIds(a.avatars || [], scope);
        if (cleanAv.join('|') !== (a.avatars || []).join('|')) { a.avatars = cleanAv; changed = true; }
        // v2.1.0 清洗：BOOTH 素材此前可能被“兜底版本”锁住而没识别到已购变体 → 解锁，让下次打开自动重试
        if (a.source === 'booth' && a.autoFilled && a.autoFilled.versions) {
          var hasRealOrder = (a.versions || []).some(function (v) { return v.orderUrl && v.orderUrl.trim() && !v.special; });
          if (!hasRealOrder) { a.autoFilled.versions = false; changed = true; }
        }
        // v2.3.17 清洗 6：把误当成「支持角色」的工具/软件名词清掉（如 lilToon 着色器、Modular Avatar）
        if (typeof TOOL_STOP_RE !== 'undefined') {
          // v2.5.13（性能）：工具名角色表整轮只算一遍（原先每条素材都把 130 个自定义角色重扫一遍）
          var badIds = App.scopeToolIds(scope);
          if (Object.keys(badIds).length) {
            App.settings.customAvatars = (App.settings.customAvatars || []).filter(function (c) { return !badIds[c.id]; });
            App.saveSettings();
          }
          var cleanedAv = (a.avatars || []).filter(function (id) { return !badIds[id] && !TOOL_STOP_RE.test(String(App.scopeAvatarLabel(scope, id))); });
          if (cleanedAv.length !== (a.avatars || []).length) { a.avatars = cleanedAv; changed = true; }
        }
        // v2.3.16 清洗 5：心愿单标记与「已购买」互斥——买了就不再是心愿单（否则卡片一直显示「心愿单」而不显示价格）
        if (a.extra && a.extra.wishlist && App.isPurchased(a)) { a.extra.wishlist = false; changed = true; }
        // v2.3.10 清洗 4：价格文本为空、但商品价已知 → 补上「免费 / 付费」判定，修「付费素材卡片没有斜丝带」
        if (a.isFree === null || a.isFree === undefined) {
          var spv = (a.shopPriceValue != null && isFinite(Number(a.shopPriceValue))) ? Number(a.shopPriceValue) : null;
          if (spv !== null) {
            var isBoothSrc = (a.source === 'booth') || (Array.isArray(a.sources) && a.sources.some(function (s) { return s && s.source === 'booth'; }));
            a.isFree = (spv === 0) && isBoothSrc;
            changed = true;
          }
        }
      });
      /* v2.5.5（用户批复）：把与**内置分类同名**的自定义分类「提升」为内置分类。
       * 例：用户自建的「道具」(cat_xxx) 现在有了内置 id props —— 素材引用与分类排序一并迁移，自定义项删除。
       * 通用规则，日后把任何自建分类固化成内置项都不会丢数据。 */
      if (Array.isArray(App.settings.customCategories) && App.settings.customCategories.length) {
        var builtinByLabel = {};
        CATEGORIES.forEach(function (c) { builtinByLabel[String(c.label).trim()] = c.id; });
        var catDrop = {};
        App.settings.customCategories.forEach(function (c) {
          var bid = c && builtinByLabel[String(c.label || '').trim()];
          if (bid && bid !== c.id) catDrop[c.id] = bid;
        });
        if (Object.keys(catDrop).length) {
          list.forEach(function (a) { if (catDrop[a.category]) { a.category = catDrop[a.category]; changed = true; } });
          App.settings.customCategories = App.settings.customCategories.filter(function (c) { return !catDrop[c.id]; });
          if (Array.isArray(App.settings.categoryOrder)) App.settings.categoryOrder = App.settings.categoryOrder.map(function (id) { return catDrop[id] || id; });
          App.saveSettings();
        }
      }
      App.assets = list;
      // 老数据修复：把「下载存放位置（已创建文件夹）」等相对路径自动补全为完整路径（仅当路径真实存在）
      return FS.completeRelativePaths(list).then(function (rel) {
        if (rel.changed) changed = true;
        var pathFix = App.consolidateAssetPaths(list);
        if (pathFix.changed) changed = true;
        // 定向修复「路径退化成分类目录」的历史坏数据（技术手册 §51.6）
        return App.repairCategoryOnlyPaths(list).then(function (rep) {
          if (rep && rep.changed) changed = true;
          var charSync = App.syncCharacterConfigs(list, scope);
          var dedupe = App.dedupeAvatarConfigs(list);
          if (charSync.cfgChanged || dedupe.cfgChanged) App.saveSettings();
          var assetFixList = charSync.assetsChanged.concat(dedupe.assetsChanged);
          // v2.3.26 清洗 7：剔除悬空角色引用。必须排在角色同步/去重之后，否则会误删刚建好的角色引用。
          var prune = App.pruneDanglingAvatars(list);
          if (prune.removed) {
            assetFixList = assetFixList.concat(prune.changed);
            try { Toast.info('已清理 ' + prune.removed + ' 处失效的角色引用（对应角色记录已不存在）', 6000); } catch (e) {}
          }
          var needAssetSave = changed || assetFixList.length;
          /* v4.3.2：把「这轮开机到底改没改数据」告诉启动流程。
           * 以前 90-main 无条件 scheduleFileSync，每次开机都把整份 assets.json 重写一遍
           * （几 MB 的 JSON 走 base64 再 PUT 一次），白耗磁盘和 CPU。 */
          App._lastReloadChanged = !!needAssetSave;
          if (needAssetSave) {
            var putList = changed ? list : uniq(assetFixList);
            return Store.putAssets(putList).then(function () { return list; });
          }
          return list;
        });
      });
    });
  },

  /** 素材在素材库中的文件夹名：{商品ID}_{角色英文名/标题}；总长截断但保留商品ID */
  folderName: function (a) {
    var base = (a.category === 'avatar' && a.charNameEn)
      ? a.charNameEn
      : (a.title || a.originalTitle || '未命名');
    // 原标题中「【】」括起来的部分直接剔除（如【マヌカ用】【PB対応】）
    base = String(base).replace(/【[^】]*】/g, '').replace(/\s+/g, ' ').trim();
    var MAX = 120;
    var clean = function (s) { return String(s || '').replace(/[\\/:*?"<>|]/g, '_'); };
    if (a.itemId) {
      var prefix = clean(a.itemId) + '_';
      var remain = Math.max(1, MAX - prefix.length);
      return (prefix + clean(base).slice(0, remain)) || '未命名';
    }
    return clean(base).slice(0, MAX) || '未命名';
  },

  cleanTitle: function (s) {
    return String(s || '').trim()
      .replace(/\s*[-–—|]\s*(BOOTH|Gumroad|pixiv)\s*$/i, '')
      .replace(/\s*[-–—|]\s*[^|]{2,40}\s*[-–—|]\s*BOOTH\s*$/i, '')
      .trim();
  },

  /** v2.3.22：是否 GitHub（开源）来源——决定「开源」斜丝带与详情页徽章 */
  isGitHubSource: function (a) {
    if (!a) return false;
    if (a.source === 'github') return true;
    return Array.isArray(a.sources) && a.sources.some(function (s) { return s && s.source === 'github'; });
  },

  /** v2.3.16：是否已购买（有订单链接或抓取时识别为已购）——心愿单标记据此失效 */
  isPurchased: function (a) {
    if (!a) return false;
    if (a.extra && a.extra.purchased) return true;
    return (a.versions || []).some(function (v) { return v && v.orderUrl && String(v.orderUrl).trim(); });
  },

  /** v2.3.15：素材库根目录的生效路径——设置里没填就用默认值（避免各处各写一份默认路径） */
  libraryRoot: function () {
    return normalizeWinPath(App.settings.libraryRootPath) || defaultLibraryRootPath();   // v3.0.4：推导自应用目录
  },

  /** v3.0.4（用户要求）：**窄条件**路径自愈 —— 仅当 ① 设置里**填过**该路径（留空/纯空白一律跳过，不猜不写不提示）且该目录不存在
   *  且 ② <应用目录>\<名称> 确实存在 时，才改用推导值并回写设置。
   *  绝不覆盖用户已有的有效自定义路径；宿主离线（无法判定）时一律不动。 */
  healDerivedPaths: function () {
    try {
      if (typeof FS === 'undefined' || !FS.host || typeof FS.hostEnsure !== 'function' || typeof FS.host.exists !== 'function') return Promise.resolve(false);
      var targets = [
        { key: 'libraryRootPath', derived: defaultLibraryRootPath(), label: '素材库目录' }
      ];
      var healedLib = '';
      return FS.hostEnsure().then(function (ok) {
        if (!ok) return false;                                  // 宿主离线 ⇒ 无法判定 ⇒ 不动
        var changed = [];
        var chain = Promise.resolve();
        targets.forEach(function (t) {
          chain = chain.then(function () {
            var cur = normalizeWinPath(App.settings[t.key] || '');
            var der = normalizeWinPath(t.derived || '');
            if (!der || cur === der) return null;
            /* v3.0.4（用户要求）：**留空/纯空白一律跳过** —— 不猜、不写设置、不提示。
             * 只有「用户明确填过某路径、而该路径不存在」且「<应用目录>\<名称> 存在」时才自愈。 */
            if (!cur) return null;
            return FS.host.exists(cur).then(function (hasCur) {
              if (hasCur) return null;                                          // 配置路径存在 ⇒ 尊重用户设置
              return FS.host.exists(der).then(function (hasDer) {
                if (!hasDer) return null;                                       // 推导路径也不存在 ⇒ 不动
                App.settings[t.key] = der;
                changed.push(t.label + '：' + (cur || '(未设置)') + ' → ' + der);
                if (t.key === 'libraryRootPath') healedLib = der;
                return null;
              });
            });
          });
        });
        return chain.then(function () {
          if (!changed.length) return false;
          console.info('[paths] 已自愈为程序旁的目录：' + changed.join('；'));
          try { App.saveSettings(); } catch (e) {}
          if (healedLib) { try { Toast.info('素材库目录已改为程序旁的「本地素材库」：' + healedLib + '（原来的设置路径不存在）', 7000); } catch (e) {} }
          return true;
        });
      }).catch(function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  },

  /* ---------------- 封面 ---------------- */
  coverURLFor: function (asset) {
    if (App.coverCache[asset.id]) return Promise.resolve(App.coverCache[asset.id]);
    if (!asset.hasCover) return Promise.resolve(asset.coverURL || '');
    return Store.getCover(asset.id).then(function (c) {
      if (!c) return asset.coverURL || '';
      var url = c.dataURL ? c.dataURL : URL.createObjectURL(c.blob);
      App.coverCache[asset.id] = url;
      return url;
    });
  },
  dropCover: function (id) {
    var u = App.coverCache[id];
    if (u && u.slice(0, 5) === 'blob:') URL.revokeObjectURL(u);
    delete App.coverCache[id];
  },

  /** v4.7：把一张图片设为封面（拖到卡片缩略图上补图时走这里）。
   *  blob → 压缩 → IndexedDB 封面 → 写 <文件夹名>.png → 落库。 */
  setCoverFromBlob: function (asset, blob) {
    if (!asset || !blob) return Promise.reject(new Error('没有图片数据'));
    return compressImage(blob, App.settings.imageMaxWidth, App.settings.imageQuality).then(function (png) {
      asset.hasCover = true;
      asset.coverCleared = false;
      App.dropCover(asset.id);
      return Store.putCover(asset.id, png).then(function () {
        return App.saveCoverToPath(asset, png, { quiet: true, create: true });
      }).then(function () {
        return App.save(asset);
      });
    }).then(function () {
      UI.renderAll();
      /* 详情页正好开着这一条时，直接换掉大图 —— 重新打开详情会多叠一层弹窗，这里只动那一张图 */
      if (App.detailAssetId === asset.id) {
        App.coverURLFor(asset).then(function (url) {
          var dc = document.querySelector('.modal .detail-cover');
          if (!dc || !url) return;
          var img = dc.querySelector('img');
          if (!img) {
            img = document.createElement('img');
            img.alt = asset.title || '';
            dc.innerHTML = '';
            dc.appendChild(img);
          }
          img.src = url;
        }).catch(function () {});
      }
      return asset;
    });
  },

  /** v2.3.5：在素材本地存储路径下按「商品ID」找封面图（.png 优先），命中返回 {path,name,ext,mime}，否则 '' */
  diskCoverFile: function (asset) {
    var itemId = String((asset && asset.itemId) || '').trim();
    var all = ((asset && asset.paths) || []).map(function (p) { return p && p.path ? String(p.path).trim() : ''; }).filter(Boolean)
      .filter(function (p) { return !App.isWebdavPath(p); });   // v2.3.11：webdav:// 不能拿去扫本地目录
    var dirs = uniq(all.filter(function (p) { return (asset.paths || []).some(function (x) { return x && x.path === p && x.note === '存储路径'; }); }).concat(all));
    if (!itemId || !dirs.length || !FS.host || !FS.host.scan) return Promise.resolve('');
    var re = new RegExp('^' + itemId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9])', 'i');
    var IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' };
    var dir = dirs[0];
    return FS.host.scan(dir, 0).then(function (entries) {
      var cands = [];
      (entries || []).forEach(function (e) {
        if (!e || e.kind !== 'file' || !e.name) return;
        var dot = e.name.lastIndexOf('.');
        if (dot < 0) return;
        var ext = e.name.slice(dot + 1).toLowerCase();
        if (!IMG[ext] || !re.test(e.name)) return;
        cands.push({ path: joinWinPath(dir, [e.rel || e.name]), name: e.name, ext: ext, mime: IMG[ext] });
      });
      cands.sort(function (x, y) {
        var px = x.ext === 'png' ? 0 : 1, py = y.ext === 'png' ? 0 : 1;
        return px - py || String(x.name).localeCompare(String(y.name));
      });
      return cands[0] || '';
    }).catch(function () { return ''; });
  },

  /** v2.3.5：打开素材时若应用内还没有封面，就按商品ID 从本地路径认领一张（写进封面缓存，列表/详情都能看到） */
  adoptDiskCover: function (asset) {
    if (!asset || !asset.id) return Promise.resolve(null);
    var live = App.assets.find(function (x) { return x.id === asset.id; }) || asset;
    if (live.hasCover || live.coverURL || live.coverCleared) return Promise.resolve(null);   // 用户主动清除过就不再自动认领
    return App.diskCoverFile(live).then(function (f) {
      if (!f) return null;
      return FS.host.readFileBase64(f.path).then(function (j) {
        var b64 = (j && (j.base64 || j.data)) || '';
        if (!b64) return null;
        return fetch('data:' + f.mime + ';base64,' + b64).then(function (r) { return r.blob(); });
      }).then(function (blob) {
        if (!blob) return null;
        return Store.putCover(live.id, blob).then(function () {
          live.hasCover = true;
          App.dropCover(live.id);
          return App.save(live).then(function () {
            Toast.ok('已从本地路径识别封面：' + f.name, 4200);
            return { path: f.path, name: f.name, blob: blob };
          });
        });
      });
    }).catch(function (e) { console.warn('[diskCover] 认领封面失败：' + ((e && e.message) || e)); return null; });
  },

  /** v2.3.7：封面确定后自动写进素材本地路径（<商品ID_标题>.png，真 PNG）——Unity 按商品ID 读的就是这个文件 */
  /** v2.5.14（用户批复 · 修3）：把某条素材的封面**补写到磁盘** —— `vrclib-data\covers\<id>.<ext>`
   *  与**素材文件夹 `<文件夹名>.png`** 两处，缺哪补哪；两侧都在就整条跳过（不动盘、不联网）。
   *  opts:
   *    quiet       : true 静默（不弹任何提示）—— 详情页打开 / 补全完成 / 启动补写都走静默
   *    allowFetch  : true 时允许联网补抓封面（宿主优先、浏览器兜底）并转 PNG 落库；默认 false（避免启动时批量抓图）
   *    createFolder: true 时允许给「还没有存储路径」的素材新建文件夹；默认 false（只写已有文件夹）
   *  返回 { covers, folder, fetched }：covers/folder ∈ 'ok' | 'skip' | 'fail' | 'noblob' | 'nopath' | 'offline' */
  ensureCoverOnDisk: function (asset, opts) {
    opts = opts || {};
    var res = { covers: 'skip', folder: 'skip', fetched: false };
    if (!asset || !asset.id) return Promise.resolve(res);
    /* v3.0.1 热修（用户已批「修」）：原门槛是 `!asset.hasCover` ⇒ hasCover=false 直接 skip，
     * 于是「有有效 coverURL、却没有封面文件」的素材（用户真库 61 条）打开详情永远不补写（实测 rurune 成功、Aya 什么都不写）。
     * 放宽为：hasCover=true 照旧；hasCover=false 时**只有同时满足**下面四条才允许走抓取链路 ——
     *   ① opts.allowFetch（只有详情页/解析完成这些显式入口才传 true，启动补写不传）
     *   ② 没有主动清除过封面（asset.coverCleared）
     *   ③ coverURL 是有效 http(s)
     *   ④ 设置里没关掉「自动下载并压缩封面图到本地库」（autoFetchCover）
     * 四条不满足 ⇒ 原样 skip（不发请求、不写盘），语义与改前一致。 */
    var canFetch = !!opts.allowFetch && !asset.coverCleared
      && /^https?:\/\//i.test(String(asset.coverURL || ''))
      && App.settings.autoFetchCover !== false;
    if (!asset.hasCover && !canFetch) return Promise.resolve(res);
    if (!App.localDir || App.localReadOnly) { res.covers = res.folder = 'offline'; return Promise.resolve(res); }
    return Store.getCover(asset.id).then(function (rec) {
      if (rec && rec.blob) return rec.blob;
      if (!opts.allowFetch) return null;
      if (asset.coverCleared) return null;                       // v3.0.1：主动清除过 → 不抓（连 hasCover=true 的路径也守住）
      if (App.settings.autoFetchCover === false) return null;    // v3.0.1：设置里关了自动抓封面 → 不抓
      var url = String(asset.coverURL || '');
      if (!/^https?:\/\//i.test(url)) return null;
      var maxW = App.settings.imageMaxWidth || 720;
      return App.ghFetchImage(url, App.ghCoverRawPath(asset))
        .then(function (b) { return b ? toPngBlob(b, maxW).catch(function () { return null; }) : null; })
        .then(function (png) {
          if (!png) return null;
          res.fetched = true;
          return Store.putCover(asset.id, png).then(function () {      // putCover 顺带写 covers 目录
            asset.hasCover = true;
            return App.save(asset).then(function () { return png; });
          });
        });
    }).then(function (blob) {
      if (!blob) { res.covers = res.folder = 'noblob'; return res; }
      return Store.local.coverExistsOnDisk(asset.id, App.settings).then(function (has) {
        if (has) res.covers = 'skip';
        var step = has ? Promise.resolve() : Store.local.saveCoverFile(asset.id, blob, App.settings).then(function (ok) { res.covers = ok ? 'ok' : 'fail'; });
        return step.then(function () {
          return App.saveCoverToPath(asset, blob, { quiet: !!opts.quiet, create: !!opts.createFolder }).then(function (r) {
            res.folder = r ? 'ok' : ((App.primaryLocalPath(asset) || opts.createFolder) ? 'fail' : 'nopath');
            return res;
          });
        });
      });
    }).catch(function () { res.covers = res.folder = 'fail'; return res; });
  },
  /** v2.3.23：封面写进素材文件夹（<文件夹名>.png）。
   *  v2.5.14：加 opts —— quiet:true 静默（自动补写用）；create:false 时**不为没有存储路径的素材新建文件夹**；
   *  并且目标文件已存在就直接跳过（详情页每次打开都补写，不能重复转换与重复写盘）。 */
  saveCoverToPath: function (asset, blob, opts) {
    opts = opts || {};
    if (!asset || !blob || typeof Importer === 'undefined') return Promise.resolve(null);
    var quiet = !!opts.quiet;
    function warnHtml(m, ms) { if (!quiet) Toast.warn(m, ms || 5200); }
    var pathP;
    if (opts.create === false) pathP = Promise.resolve(App.primaryLocalPath(asset));
    else if (typeof Importer.ensureStoragePathQuiet === 'function') pathP = Importer.ensureStoragePathQuiet(asset);
    else pathP = Promise.resolve(App.primaryLocalPath(asset));
    return pathP.then(function (folderPath) {
      if (!folderPath) { warnHtml('未能创建素材存储路径，封面没写进素材文件夹（检查宿主与素材库根目录）', 5600); return null; }
      var name = App.folderName(asset) + '.png';
      var dst = joinWinPath(folderPath, [name]);
      return FS.host.exists(dst).then(function (kind) {
        if (kind === 'file') return { path: dst, name: name, skipped: true };
        return toPngBlob(blob).then(function (png) {
          return FS.writeFileToPath(dst, png).then(function (ok) {
            if (ok) { if (!quiet) Toast.ok('封面已写入素材文件夹：' + name, 3600); }
            else warnHtml('封面写入素材文件夹失败（宿主是否在线？）');
            return ok ? { path: dst, name: name } : null;
          });
        });
      });
    }).catch(function (e) { warnHtml('封面写入素材文件夹失败：' + ((e && e.message) || e)); return null; });
  },

  /** v2.3.10：按下载队列的真实状态刷新页面上的下载按钮（排队中 / 下载中 xx% / 已下载） */
  syncDownloadButtons: function (tasks) {
    if (typeof DLQueue === 'undefined' || typeof document === 'undefined' || !document.querySelectorAll) return;
    var list = tasks || DLQueue.list() || [];
    Array.prototype.forEach.call(document.querySelectorAll('[data-dl-url]'), function (btn) {
      var url = btn.getAttribute('data-dl-url');
      if (!url) return;
      var t = list.filter(function (x) { return x && x.url === url; })[0];
      if (!t) return;   // 队列里没有 → 保持「已下载 / ⬇ 下载」的原判定，别把探测结果冲掉
      var label = btn.querySelector('.dl-label') || btn;
      if (t.state === 'running') {
        var pct = (t.total > 0) ? (Math.min(100, Math.floor(t.received / t.total * 100)) + '%') : '';
        ICONS.apply(label, '\u23F3 下载中 ' + (pct || (t.received ? fmtSize(t.received) : '…')));
        btn.disabled = true;
        btn.title = '正在下载，进度见右下「下载任务」悬浮窗';
      } else if (t.state === 'pending') {
        label.textContent = '排队中';
        btn.disabled = true;
        btn.title = '已加入下载队列，前面还有任务在跑';
      } else if (t.state === 'done') {
        // v2.5.0：下完的文件按钮变浅红「重新下载」（原来写死「✔ 已下载」并禁用，想重下只能删文件）
        // v2.5.1（P2）：浅红类必须加在**按钮**上——带 <span class="dl-label"> 的按钮（「下载文件 / 导入」）
        // 以前把类加到了 span 上，结果是蓝底按钮配「↻ 重新下载」文案。
        btn.classList.remove('btn-primary'); btn.classList.add('btn-redl');
        btn.dataset.redl = '1';
        ICONS.apply(label, ('\u21BB 重新下载'));
        btn.disabled = false;
        btn.title = '文件已在存储路径（点击重新下载，会覆盖它）';
      } else {
        ICONS.apply(label, ('\u2B07 下载'));
        btn.disabled = false;
        btn.title = t.error ? ('上次下载失败：' + t.error) : '';
      }
    });
  },

  /* ---------------- 图集本地化缓存（v2.3.6：按商品ID 落盘 PNG，不再占浏览器空间） ---------------- */
  galleryDirCache: Object.create(null),
  galleryItemId: function (asset) {
    var id = String((asset && asset.itemId) || '').trim();
    return id || String((asset && asset.id) || '').trim();
  },
  galleryPrefix: function (i) { var n = String((i || 0) + 1); return (n.length < 2 ? '0' + n : n) + '_'; },   // 旧命名，仅用于兼容读取
  /* v2.5.4：缓存文件名改为**按图片 URL**，不再按位置。
   * 旧命名 <序号>_<原图名>.png 在图集去重 / 新增 / 删除后会整体错位——同一序号指向的已是另一张图，
   * 于是把 A 图的缓存当成 B 图显示：用户看到的「图集有重复 / 和网页端不一样」就来自这里。
   * 实测真实库：329 个缓存目录里 47 个文件已错位（7 个素材）、4 个素材同一张图缓存了多份。 */
  /** 原图名清洗（cap = 截断长度：新命名 40 / v2.5.3 旧命名 60） */
  galleryBase: function (url, cap) {
    var base = '';
    try {
      var u = String(url || '').split('?')[0].split('#')[0];
      base = decodeURIComponent(u.split('/').pop() || '');
    } catch (e) { base = ''; }
    base = base.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, cap || 40);
    return base || 'img';
  },
  galleryCacheName: function (url) {
    var base = App.galleryBase(url, 40);
    var s = String(url || ''), h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return ('0000000' + h.toString(16)).slice(-8) + '_' + base + '.png';
  },
  /** 在磁盘文件列表里定位某个 URL 的缓存：先按新命名（URL 哈希）；旧的位置命名只有在**原图名一致**时才算命中。
   *  v2.5.6（用户批复）：旧命名回退原来拿「新名字去掉哈希后的 **40 字**截断名」去比，
   *  而 v2.5.3 旧缓存写的是「**60 字**截断名」—— 只要原图名超过 40 字就永远对不上。
   *  真实库镜像审计：3044 组命名对齐的旧缓存里有 2952 组（97%）因此取不到（2 GB 缓存白丢）。
   *  现改为**按旧命名公式精确重建再比**：文件名与 URL 完全一致才认，依旧绝不张冠李戴。 */
  galleryFindCached: function (files, url, i) {
    var want = App.galleryCacheName(url);
    var list = files || [];
    for (var k = 0; k < list.length; k++) { if (String(list[k] && list[k].name || '') === want) return want; }
    var pre = App.galleryPrefix(i);
    var legacyBase = App.galleryBase(url, 60);       // v2.5.3 的旧命名口径
    var wantBase = App.galleryBase(url, 40);         // 兼容极早期只有 40 字的写法
    for (var j = 0; j < list.length; j++) {
      var n = String(list[j] && list[j].name || '');
      if (n.indexOf(pre) !== 0) continue;
      var got = n.slice(pre.length).replace(/\.png$/i, '');
      if (got === legacyBase || got === wantBase) return n;
    }
    return '';
  },
  /** 缓存文件名（保留旧签名）：现在只由 URL 决定，与位置无关 */
  galleryFileBase: function (i, url) { return App.galleryCacheName(url); },
  galleryFiles: function (asset, force) {
    var itemId = App.galleryItemId(asset);
    if (!itemId) return Promise.resolve([]);
    if (!force && App.galleryDirCache[itemId]) return Promise.resolve(App.galleryDirCache[itemId]);
    return Store.local.listGalleryFiles(itemId, App.settings).then(function (files) {
      App.galleryDirCache[itemId] = files || [];
      return App.galleryDirCache[itemId];
    });
  },
  /** 从磁盘缓存读第 i 张 → {blob,name} 或 null */
  galleryFromDisk: function (asset, i) {
    var itemId = App.galleryItemId(asset);
    if (!itemId) return Promise.resolve(null);
    var url = ((asset && asset.images) || [])[i];   // v2.5.4：按这一格**当前的 URL** 找缓存，而不是按序号
    if (!url) return Promise.resolve(null);
    return App.galleryFiles(asset).then(function (files) {
      var hit = App.galleryFindCached(files, url, i);
      if (!hit) return null;
      return Store.local.loadGalleryFile(itemId, hit, App.settings).then(function (blob) {
        return blob ? { blob: blob, name: hit } : null;
      });
    });
  },
  /** 把第 i 张写进磁盘缓存（已转 PNG） */
  galleryToDisk: function (asset, i, url, blob) {
    var itemId = App.galleryItemId(asset);
    if (!itemId || !blob) return Promise.resolve('');
    var name = App.galleryFileBase(i, url);
    return Store.local.saveGalleryFile(itemId, name, blob, App.settings).then(function (p) {
      if (p) {
        var c = App.galleryDirCache[itemId];
        if (c) c.push({ name: name, kind: 'file', size: blob.size, mtime: 0 });
      }
      return p;
    });
  },
  /** v2.3.23：一张 README 图要落的最终路径（原图先落这里，转成 PNG 后再覆盖回同一路径，不留临时目录） */
  ghImagePath: function (asset, i, url) {
    var itemId = App.galleryItemId(asset);
    if (!itemId) return '';
    var dir = Store.local.galleryDir(itemId, App.settings);
    if (!dir) return '';
    return joinWinPath(dir, [App.galleryFileBase(i, url)]);
  },
  /** 封面待落路径（vrclib-data 下的 covers/<id>.png；随后由 PNG 与封面管线覆盖） */
  ghCoverRawPath: function (asset) {
    if (!asset || !asset.id) return '';
    var dir = Store.local.dataDir(App.settings);
    if (!dir) return '';
    return joinWinPath(dir, ['covers', String(asset.id) + '.png']);
  },

  /** v2.3.23：抓一张 README 图——优先内置宿主下载（带浏览器 UA，不受 CORS / 防盗链限制），失败退回浏览器直连。
   *  宿主下载直接落在 dst（最终路径），读回后在调用方转 PNG 覆盖，因此不产生临时文件。 */
  ghFetchImage: function (url, dst) {
    var u = String(url || '').trim();
    if (!u) return Promise.resolve(null);
    var p = String(dst || '');
    return FS.hostEnsure().then(function (hostOk) {
      if (!hostOk || !p) return null;
      return FS.host.download(u, p, {}, '')
        .then(function (j) {
          if (!j || !(j.size > 64)) return null;      // 宿主会拒绝把登录页 / 错误页存成文件
          return FS.host.readFileBase64(p);
        })
        .then(function (j) {
          var b64 = (j && (j.base64 || j.data)) || '';
          if (!b64) return null;
          // media type 只是给 toPngBlob 的提示（浏览器按内容嗅探，随后一律重编码成 PNG）
          return fetch('data:image/png;base64,' + b64).then(function (r) { return r.blob(); });
        })
        .catch(function () { return null; });
    }).then(function (b) {
      if (b) return b;
      return Net.fetchBlob(u, {});                    // 宿主不可用或下载失败 → 浏览器直连兜底
    }).catch(function () { return null; });
  },

  /** v2.3.23：封面立即落盘——IndexedDB + vrclib-data\\covers\\<id>.png + 素材文件夹 <商品ID_标题>.png */
  applyLocalCover: function (asset, png, url) {
    if (!asset || !asset.id || !png) return Promise.resolve(false);
    asset.hasCover = true; asset.coverCleared = false;
    if (url) asset.coverURL = url;
    App.dropCover(asset.id);
    return Store.putCover(asset.id, png).then(function () {
      return Store.local.saveCoverFile(asset.id, png, App.settings);
    }).then(function () {
      return App.saveCoverToPath(asset, png);
    }).then(function () {
      return App.save(asset);
    }).then(function () { return true; })
      .catch(function (e) { console.warn('[ghCover] ' + ((e && e.message) || e)); return false; });
  },

  /** v2.3.23：GitHub 素材抓取即把 README 图片下载到本地
   *  - 封面：按顺序下载，首张成功的转 PNG 走封面管线（首图失败自动顺延下一张）
   *  - 其余：转 PNG 落盘 vrclib-data\\gallery\\<商品ID>\\NN_<name>.png
   *  - 全部失败：不动封面，保留抓取时的仓库头像外链
   *  返回 { cover, coverBlob, coverURL, gallery, tried, index }
   */
  ghLocalizeImages: function (asset, info, opts) {
    opts = opts || {};
    var log = opts.log || function () {};
    var imgs = uniq(((info && info.images) || []).map(function (u) { return String(u || '').trim(); }).filter(Boolean));
    if (!asset || !asset.id || !imgs.length) return Promise.resolve(null);
    var maxW = App.settings.imageMaxWidth || 720;
    function one(u, dst) {
      return App.ghFetchImage(u, dst).then(function (b) {
        if (!b) return null;
        return toPngBlob(b, maxW).catch(function () { return null; });
      });
    }
    var coverPng = null, coverIdx = -1, tried = 0;
    var chain = Promise.resolve();
    imgs.forEach(function (u, i) {                       // 1) 顺序找第一张能用的图当封面
      chain = chain.then(function () {
        if (coverPng) return null;
        tried++;
        return one(u, App.ghCoverRawPath(asset)).then(function (png) {
          if (png) { coverPng = png; coverIdx = i; }
          else log('\u26A0 README 图片不可用，顺延下一张：' + u);
        });
      });
    });
    return chain.then(function () {
      if (!coverPng) { log('\u26A0 README 图片全部下载失败，封面继续使用仓库头像外链'); return { cover: false, gallery: 0, tried: tried, index: -1 }; }
      return App.applyLocalCover(asset, coverPng, imgs[coverIdx]).then(function () {
        var n = 0, g = Promise.resolve();
        imgs.forEach(function (u, i) {                   // 2) 其余进图集（封面之前已试过且失败的图不再重复下载）
          if (i <= coverIdx) return;
          g = g.then(function () {
            return one(u, App.ghImagePath(asset, i, u)).then(function (png) {
              if (!png) return null;
              return App.galleryToDisk(asset, i, u, png).then(function (p) { if (p) n++; });
            });
          });
        });
        return g.then(function () {
          log('\u2714 README 封面已本地化（第 ' + (coverIdx + 1) + ' 张）' + (n ? '，图集缓存 ' + n + ' 张' : ''));
          return { cover: true, coverBlob: coverPng, coverURL: imgs[coverIdx], gallery: n, tried: tried, index: coverIdx };
        });
      });
    });
  },

  /** 打开详情时把磁盘上已有的缓存读回（免网络） */
  galleryPreload: function (asset, images) {
    if (!App.galleryItemId(asset)) return Promise.resolve([]);
    return App.galleryFiles(asset).then(function (files) {
      var jobs = [];
      // v2.5.4：改成「按图片 URL 找缓存」——旧实现按文件名序号回填，图集一变就整体错位（显示成别的图）
      (images || []).forEach(function (url, i) {
        if (!url) return;
        var hit = App.galleryFindCached(files, url, i);
        if (hit) jobs.push({ url: url, name: hit });
      });
      var out = [];
      var chain = Promise.resolve();
      jobs.forEach(function (j) {
        chain = chain.then(function () {
          return Store.local.loadGalleryFile(App.galleryItemId(asset), j.name, App.settings).then(function (b) {
            if (b) out.push({ url: j.url, blob: b });
          });
        });
      });
      return chain.then(function () { return out; });
    }).catch(function () { return []; });
  },
  /** 把浏览器里的旧图集缓存一次性迁到磁盘（转 PNG），迁完清空 IndexedDB 图集库 */
  migrateGalleryCache: function () {
    if (App.galleryMigrating) return Promise.resolve({ skipped: true });
    if (App.localReadOnly || !Store.local || !Store.local.listGalleryFiles) return Promise.resolve({ skipped: true });
    App.galleryMigrating = true;
    var done = 0, failed = 0, left = 0;
    return Store.galleryAll().then(function (recs) {
      var list = (recs || []).filter(function (r) { return r && r.id && (r.items || []).length; });
      left = list.length;
      var chain = Promise.resolve();
      list.forEach(function (rec) {
        chain = chain.then(function () {
          var asset = App.assets.find(function (x) { return x.id === rec.id; }) || Store.normalizeAsset({ id: rec.id, itemId: rec.id });
          var ok = Promise.resolve(true);
          (rec.items || []).forEach(function (it, idx) {
            ok = ok.then(function (prev) {
              if (!prev || !it || !it.blob) return prev;
              return toPngBlob(it.blob, App.settings.imageMaxWidth).then(function (png) {
                return App.galleryToDisk(asset, idx, it.url, png).then(function (p) { return !!p; });
              }).catch(function () { return false; });
            });
          });
          return ok.then(function (all) {
            if (!all) { failed++; return; }
            done++;
            return Store.galleryClear(rec.id).catch(function () {});
          });
        });
      });
      return chain;
    }).then(function () {
      App.galleryMigrating = false;
      if (done || failed) Toast.ok('图集缓存已迁移到磁盘（' + done + ' 个素材' + (failed ? '，' + failed + ' 个失败下次再试' : '') + '）', 5200);
      return { done: done, failed: failed, left: left };
    }).catch(function (e) {
      App.galleryMigrating = false;
      return { done: done, failed: failed, left: left, err: (e && e.message) || String(e) };
    });
  },

  /* ---------------- 模糊搜索（v2.2.12，默认关闭） ----------------
   * 开启后：① 词表扩展——设置页用 DeepSeek 生成的近义词/俗称/常见错拼表，同组任一词互相命中；
   *        ② 拼写容错——拉丁词按有界编辑距离匹配（长度 ≤4 容 1 个错，其余容 2 个）。
   * 中日文不做编辑距离（单字距离无意义），只依赖词表。精确匹配永远优先，关闭时行为不变。
   */
  fuzzyIndexCache: null,
  fuzzyIndex: function () {
    var dict = App.settings.fuzzyDict || {};
    if (App.fuzzyIndexCache && App.fuzzyIndexCache.__src === dict) return App.fuzzyIndexCache;
    var idx = { __src: dict };
    Object.keys(dict).forEach(function (k) {
      var key = String(k).toLowerCase();
      var group = [key].concat((dict[k] || []).map(function (w) { return String(w).toLowerCase(); }));
      group.forEach(function (w) { if (w && !idx[w]) idx[w] = group; });
    });
    App.fuzzyIndexCache = idx;
    return idx;
  },
  fuzzyTerms: function (q) {
    /* v4.3.2：索引对象上挂着缓存标记键 __src（存的是原始字典对象），
     * 直接 `idx[q]` 在 q === '__src' 时会拿到那个对象，接着 .filter 就抛 TypeError。
     * 顺手补 toLowerCase：索引的键都是小写，以前大写查询一律查不到。 */
    var g = App.fuzzyIndex()[String(q || '').toLowerCase()];
    return Array.isArray(g) ? g.filter(function (w) { return w && w !== q; }) : [];
  },
  /** 有界编辑距离：任一行最小值超过 max 立刻返回 false，避免完整 DP 表 */
  editWithin: function (a, b, max) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > max) return false;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      var best = i;
      for (j = 1; j <= b.length; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return false;
      prev = cur.slice();
    }
    return prev[b.length] <= max;
  },
  /** hay 为已小写化的检索全文，q 为已小写化的查询词 */
  fuzzyHit: function (hay, q) {
    if (!q) return true;
    if (hay.indexOf(q) >= 0) return true;
    var terms = App.fuzzyTerms(q), i;
    for (i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) >= 0) return true;
    if (q.length < 3) return false;
    if (/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/.test(q)) return false;
    var max = q.length <= 4 ? 1 : 2;
    var toks = hay.split(/[^0-9a-z\u00c0-\u024f]+/);
    for (i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (!t || Math.abs(t.length - q.length) > max) continue;
      if (App.editWithin(q, t, max)) return true;
    }
    return false;
  },

  /* ---------------- 网盘（WebDAV）路径（v2.2.12） ----------------
   * 素材的「本地文件路径」可以填 webdav://账号名/远端路径，由宿主代为读写。
   * 远端条目一律不参与本地路径收敛（否则会被当成 Windows 路径截断）。
   */
  isWebdavPath: function (p) { return /^webdav:\/\//i.test(String(p || '')); },
  /** v2.5.0（S2/S4）：磁盘对账——把存储目录里的真实文件与库里记录（downloadedFiles + 各版本 files）逐一比对。
   *  返回 Promise<{dir, error?, onDisk?, recorded?, missing?, extra?}>；error: no-path / no-host / offline / missing-dir */
  localFileAudit: function (a) {
    var dir = App.primaryLocalPath(a);
    if (!dir) {
      // v2.5.1（P6）：只有 webdav:// 远端路径的素材单列一类，不再混进「未关联本地路径」
      var remote = (a.paths || []).map(function (p) { return (p && typeof p === 'object') ? String(p.path || '') : String(p || ''); })
        .filter(function (p) { return p && App.isWebdavPath(p); });
      return Promise.resolve({ dir: '', error: remote.length ? 'remote-only' : 'no-path', remote: remote });
    }
    if (!FS.host || typeof FS.host.scan !== 'function') return Promise.resolve({ dir: dir, error: 'no-host' });
    var recorded = uniq((a.downloadedFiles || []).map(String).concat(
      (a.versions || []).reduce(function (acc, v) {
        return acc.concat((v.files || []).map(function (f) { return String((f && f.name) || ''); }));
      }, [])
    )).filter(function (n) { return !!n; });
    /* v3.0.3（用户要求）：宿主离线时不再直接判 'offline' —— 有浏览器库根句柄就用 FSA 枚举做权威对账。
     * 结果多带一个 via: 'host' | 'fsa'，调用方据此说明这次对账是用哪条通道做的。 */
    function compareAgainst(onDisk, via) {
      var low = Object.create(null), recLow = Object.create(null);
      onDisk.forEach(function (n) { low[String(n).toLowerCase()] = 1; });
      recorded.forEach(function (n) { recLow[n.toLowerCase()] = 1; });
      return {
        dir: dir, onDisk: onDisk, recorded: recorded, via: via,
        missing: recorded.filter(function (n) { return !low[n.toLowerCase()]; }),
        extra: onDisk.filter(function (n) { return !recLow[n.toLowerCase()]; })
      };
    }
    return FS.hostEnsure().then(function (ok) {
      if (ok) {
        return FS.host.scan(dir, 0).then(function (entries) {
          return compareAgainst((entries || []).filter(function (e) { return e && e.kind === 'file'; }).map(function (e) { return String(e.name); }), 'host');
        }, function () { return { dir: dir, error: 'missing-dir', recorded: recorded }; });
      }
      /* 第二档：浏览器库根句柄（宿主离线）；不可用才回落第三档 'offline' */
      if (typeof FS.listLibraryDir !== 'function' || typeof FS.relPathFromLibrary !== 'function') {
        return { dir: dir, error: 'offline', recorded: recorded };
      }
      var relDir = FS.relPathFromLibrary(dir, '');
      if (!relDir) return { dir: dir, error: 'offline', recorded: recorded };
      return FS.listLibraryDir(relDir).then(function (fsa) {
        if (!fsa || !fsa.usable) return { dir: dir, error: 'offline', recorded: recorded };
        if (!fsa.exists) return { dir: dir, error: 'missing-dir', recorded: recorded, via: 'fsa' };
        return compareAgainst(fsa.names || [], 'fsa');
      });
    }).catch(function () { return { dir: dir, error: 'offline', recorded: recorded }; });
  },
  /** v2.3.29：素材的主本地路径——优先 note=「存储路径」那条，其次第一条本地绝对路径；只有 webdav:// 时返回 ''（本地打不开） */
  primaryLocalPath: function (a) {
    var local = (a.paths || []).map(function (p) {
      return { path: (p && typeof p === 'object') ? String(p.path || '') : String(p || ''), note: (p && typeof p === 'object' && p.note) || '' };
    }).filter(function (p) {
      return p.path && !App.isWebdavPath(p.path) && isAbsoluteWinPath(p.path);
    });
    var hit = local.filter(function (p) { return p.note === '存储路径'; })[0] || local[0];
    return hit ? normalizeWinPath(hit.path) : '';
  },
  /** 取某个 WebDAV 账号的实际凭据（密码出库时解密） */
  davCredsFor: function (label) {
    var acc = (App.settings.webdavAccounts || []).filter(function (x) { return x && x.label === label; })[0];
    if (!acc) return Promise.resolve(null);
    return Secure.decrypt(acc.passwordEnc || '').then(function (pw) {
      var base = String(acc.url || '');
      if (base && base.slice(-1) !== '/') base += '/';
      return { label: acc.label, url: base, username: acc.username || '', password: pw || '' };
    }).catch(function () {
      var base = String(acc.url || '');
      if (base && base.slice(-1) !== '/') base += '/';
      return { label: acc.label, url: base, username: acc.username || '', password: '' };
    });
  },
  webdavOf: function (p) {
    var m = String(p || '').match(/^webdav:\/\/([^\/]+)\/?(.*)$/i);
    if (!m) return null;
    var label = decodeURIComponent(m[1]);
    var acc = (App.settings.webdavAccounts || []).filter(function (x) { return x && x.label === label; })[0];
    if (!acc) return { label: label, account: null, sub: m[2] || '' };
    var base = String(acc.url || '');
    if (base && base.slice(-1) !== '/') base += '/';
    return { label: label, account: acc, sub: m[2] || '', url: base + (m[2] || '') };
  },

  /* ---------------- 筛选 & 排序 ---------------- */
  filtered: function () {
    var f = App.filters;
    var q = (f.q || '').trim().toLowerCase();
    var out = App.assets.filter(function (a) {
      if (f.categories.length && f.categories.indexOf(a.category) < 0) return false;
      if (f.sources.length && f.sources.indexOf(a.source) < 0) return false;
      if (f.avatars.length) {
        var hit = App.filterAvatars(a).some(function (v) { return f.avatars.indexOf(v) >= 0; });
        if (!hit) return false;
      }
      /* v3.0.0（用户要求）：标签筛选三态 —— tags = 必须包含（AND，维持现状）；tagsNot = 排除（命中任一即过滤掉）；
       * 两者可同时生效。匹配口径沿用 App.displayTags（与侧栏/卡片/详情同源，不另起一套）。 */
      if (f.tags.length || (f.tagsNot || []).length) {
        var th = App.displayTags(a);
        if (f.tags.length && !f.tags.every(function (t) { return th.indexOf(t) >= 0; })) return false;
        if ((f.tagsNot || []).length && (f.tagsNot || []).some(function (t) { return th.indexOf(t) >= 0; })) return false;
      }
      switch (f.status) {
        case 'downloaded':   if (!a.downloaded) return false; break;
        case 'undownloaded': if (a.downloaded) return false; break;
        case 'favorite':     if (!a.favorite) return false; break;
        case 'haspath':      if (!(a.paths || []).length) return false; break;
        case 'nopath':       if ((a.paths || []).length) return false; break;
        case 'hidden':       if (!a.hidden) return false; break;
      }
      // 隐藏项默认不出现（除非显式筛选「已隐藏」或在设置中开启显示）
      if (a.hidden && f.status !== 'hidden' && !App.settings.showHidden) return false;
      // 价格维度（免费 / 付费 / 分享 / 获赠 / 未记录 / 未购买）
      var friend = App.isFriend(a);
      var unpurchased = App.purchaseState(a) === 'unpurchased';
      /* v2.5.14（用户批复 A）：免费/付费筛选与卡片丝带共用 App.priceBucket —— 侧栏数字点进去必须一致 */
      var pBucket = App.priceBucket(a);
      if (f.price === 'free' && (friend || a.gifted || unpurchased || pBucket !== 'free')) return false;
      if (f.price === 'paid' && (friend || a.gifted || unpurchased || pBucket !== 'paid')) return false;
      if (f.price === 'unpurchased' && !unpurchased) return false;
      if (f.price === 'share' && !friend) return false;
      if (f.price === 'gift' && !a.gifted) return false;
      if (f.price === 'unknown' && (friend || a.gifted || unpurchased || (a.isFree !== null && a.isFree !== undefined))) return false;
      // 已下架特殊标签：仅显示 delisted=true 的素材
      if (f.delisted && !a.delisted) return false;
      // 心愿单特殊标签：仅显示 extra.wishlist=true 的素材
      if (f.wishlist && !(a.extra && a.extra.wishlist)) return false;
      // R18 特殊标签：extra.r18 或标签文本 R-18/R18 命中才显示
      if (f.r18) {
        var r18Tags = (a.tags || []).join(' ').toLowerCase();
        if (!(a.extra && a.extra.r18) && !/(^|[^a-z0-9])r-?18([^a-z0-9]|$)/.test(r18Tags)) return false;
      }
      if (q) {
        var hay = [a.title, a.originalTitle, a.note, a.author, a.shop, a.itemId, a.description,
          App.categoryLabel(a.category), App.sourceLabel(a)]
          .concat(a.tags || []).concat(a.rawTags || [])
          .concat(App.filterAvatars(a).map(App.avatarLabel))
          .concat((a.paths || []).map(function (p) { return p.path; }))
          .join(' ').toLowerCase();
        if (hay.indexOf(q) < 0 && !(App.settings.fuzzySearch && App.fuzzyHit(hay, q))) return false;
      }
      return true;
    });
    var sort = App.settings.sort || 'created_desc';
    out.sort(function (a, b) {
      switch (sort) {
        case 'created_asc':  return String(a.createdAt).localeCompare(String(b.createdAt));
        case 'updated_desc': return String(b.updatedAt).localeCompare(String(a.updatedAt));
        case 'title_asc':    return collator.compare(a.title || a.originalTitle, b.title || b.originalTitle);
        case 'title_desc':   return collator.compare(b.title || b.originalTitle, a.title || a.originalTitle);
        case 'category':     return collator.compare(App.categoryLabel(a.category), App.categoryLabel(b.category)) ||
                                    collator.compare(a.title, b.title);
        case 'source':       return collator.compare(App.sourceLabel(a), App.sourceLabel(b)) ||
                                    collator.compare(a.title, b.title);
        case 'rating_desc':  return (b.rating || 0) - (a.rating || 0) || collator.compare(a.title, b.title);
        /* v4.3.2：两条都「没有价格」时原来算 Infinity - Infinity = NaN，
         * 比较器返回 NaN 的排序结果由引擎实现决定 —— 同一批素材每次排出来的顺序都可能不同。
         * 现在显式给空值项一个相等的名次，并把它们稳定地排到末尾。 */
        case 'price_asc': {
          var va = App.sortPriceValue(a), vb = App.sortPriceValue(b);
          if (va == null && vb == null) return 0;
          if (va == null) return 1;
          if (vb == null) return -1;
          return va - vb;
        }
        case 'price_desc': {
          var wa = App.sortPriceValue(a), wb = App.sortPriceValue(b);
          if (wa == null && wb == null) return 0;
          if (wa == null) return 1;
          if (wb == null) return -1;
          return wb - wa;
        }
        case 'published_desc': return String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''));
        case 'published_asc':  return String(a.publishedAt || '').localeCompare(String(b.publishedAt || ''));
        case 'shopupdated_desc': return String(b.shopUpdatedAt || '').localeCompare(String(a.shopUpdatedAt || ''));
        case 'shopupdated_asc':  return String(a.shopUpdatedAt || '').localeCompare(String(b.shopUpdatedAt || ''));
        default:             return String(b.createdAt).localeCompare(String(a.createdAt));
      }
    });
    return out;
  },

  /** 分页（借鉴商品列表分页逻辑；pageSize=0 表示不分页） */
  /** v5.0：每页数量不再让用户选 —— 按卡片大小换算，保证一页占的「面积」大致等于中号 24 张。
   *  小 34（170px 宽）/ 中 24（220px）/ 大 15（290px），允许有少量浮动。 */
  pageSizeFor: function () {
    var map = { s: 34, m: 24, l: 15 };
    return map[App.settings.cardSize] || 24;
  },

  pageInfo: function () {
    var all = App.filtered();
    var size = App.pageSizeFor();
    var pages = size > 0 ? Math.max(1, Math.ceil(all.length / size)) : 1;
    if (App.page > pages) App.page = pages;
    if (App.page < 1) App.page = 1;
    var items = size > 0 ? all.slice((App.page - 1) * size, App.page * size) : all;
    return { all: all, items: items, page: App.page, pages: pages, size: size, total: all.length };
  },

  /* ---------------- 价格模型（v2.1） ---------------- */
  /** 该素材是否为好友分享来源（sources 或主来源含 friend） */
  isFriend: function (a) {
    return a.source === 'friend' || (Array.isArray(a.sources) && a.sources.some(function (s) { return s && s.source === 'friend'; }));
  },
  /** 价格文本：币种 + 千分位数值 */
  priceText: function (value, currency) {
    if (value == null || !isFinite(Number(value))) return '';
    var cur = currency || '';
    var sym = cur === 'JPY' ? '\u00A5' : (cur === 'USD' ? '$' : (cur === 'EUR' ? '\u20AC' : '\u00A5'));
    return sym + ' ' + Number(value).toLocaleString('ja-JP');
  },
  /** 详情/编辑页的商品价格：一律用字母币种前缀（USD / CNY / JPY / EUR），避免 ¥ 符号无法区分 CNY 与 JPY。
   *  v2.5.14：币种为空时**按调用方给的商店币种兜底**（fallback，通常是 App.sourceCurrency(a)）；
   *  仍然为空就只显示数值 —— **绝不默认 CNY**。 */
  codePriceText: function (value, currency, fallback) {
    if (value == null || !isFinite(Number(value))) return '';
    var cur = String(currency || '').toUpperCase() || String(fallback || '').toUpperCase();
    var num = Number(value).toLocaleString('ja-JP');
    return cur ? (cur + ' ' + num) : num;
  },
  /**
   * 有效价格：购买价优先；没有购买价时 BOOTH 用变体计算商品价，
   * 其他来源商品价仅展示（value=null 表示不计统计）。
   * 返回 {text,value,currency,isFree}
   */
  effectivePrice: function (a) {
    if (!a) return null;
    /* v2.5.5（用户批复）：**未购买**的素材不显示价格、不参与价格排序、不计入花费统计。
     * 理由：未购变体价之和既不是花费、也不是它能代表的价格（实测有作者占位价 999999，
     * 求和后算出 ¥1,007,599，还把价格排序前三名全占了）。变体各自的价格仍在详情页「版本与变体」里列出。 */
    /* v2.5.11（用户批复 A，扩展 v2.5.5 的口径）：判据从「未购买」推广为「**没有购买凭据**」——
     * 没花过钱的素材一律不显示价格、不参与价格排序、不计入花费统计。 */
    if (!App.hasPurchaseProof(a)) return null;
    if (a.purchasePrice != null && isFinite(Number(a.purchasePrice))) {
      var v = Number(a.purchasePrice);
      return { text: App.priceText(v, a.purchaseCurrency), value: v, currency: a.purchaseCurrency || '', isFree: v === 0 };
    }
    var isBooth = a.source === 'booth' || (Array.isArray(a.sources) && a.sources.some(function (s) { return s && s.source === 'booth'; }));
    /* v2.5.2：商品价字段不再记录 → 没有手填购买价时，直接按**变体价**现算：
     * 有已购变体就合计它们的变体价（= 以前的商品价口径），否则取未购变体的当前价。 */
    /* v2.5.11（C，用户修正）：**停售 ≠ 没买过** —— 只有「停售且没有任何订单链接」的变体才不参与计价；
     * 已经买过的停售变体照常计入（以实际订单为准）。 */
    var versV = (a.versions || []).filter(function (v) {
      if (!v || v.special) return false;
      if (App.isDeadVariant(v) && !(v.orderUrl && String(v.orderUrl).trim())) return false;
      return true;
    });
    var boughtV = versV.filter(function (v) { return v.orderUrl && String(v.orderUrl).trim(); });
    var pickV = boughtV.length ? boughtV : versV;
    if (pickV.length) {
      var vSum = 0, vCur = '', vHas = false;
      pickV.forEach(function (v) {
        var pd = derivePrice(String(v.price || ''));
        if (pd.value == null) return;
        vHas = true; vSum += pd.value; vCur = vCur || pd.currency || '';
      });
      if (vHas) return { text: App.priceText(vSum, vCur), value: isBooth ? vSum : null, currency: vCur, isFree: isBooth && vSum === 0 };
    }
    if (a.shopPriceValue != null && isFinite(Number(a.shopPriceValue))) {
      var sv = Number(a.shopPriceValue);
      return {
        text: App.priceText(sv, a.shopPriceCurrency) || a.shopPrice,   // 统一用币种+数值显示，避免出现 “USD 15” 这类双前缀
        value: isBooth ? sv : null,   // 非 BOOTH 商品价只展示，不统计
        currency: a.shopPriceCurrency || '',
        isFree: sv === 0 && isBooth
      };
    }
    if (a.shopPrice) {
      var pd = derivePrice(a.shopPrice);
      return {
        text: a.shopPrice,
        value: isBooth ? pd.value : null,
        currency: pd.currency,
        isFree: isBooth && pd.isFree === true
      };
    }
    return null;
  },
  /** v2.5.11（用户批复 C）：该变体是否标示「停售 / 售罄」（作者常拿占位价如 9,999,999 标它们）→ 不参与计价 */
  isDeadVariant: function (v) {
    return /販売停止|販売終了|贩售停止|停止销售|销售结束|已停售|売り切れ|売切|完売|品切れ|sold\s*out|discontinued|unavailable/i.test(String((v && v.name) || ''));
  },
  /** v2.5.11（用户批复 A）：是否有**购买凭据** —— 手填购买价，或存在带订单链接的已购变体。
   *  没有凭据 = 没花过钱：不显示价格、不参与价格排序、不计入花费统计（与「未购买」同一条规则）。 */
  hasPurchaseProof: function (a) {
    if (!a) return false;
    if (a.purchasePrice != null && isFinite(Number(a.purchasePrice))) return true;
    return (a.versions || []).some(function (v) { return v && v.orderUrl && String(v.orderUrl).trim(); });
  },
  /** v2.5.14（用户批复 A）：是否**存在免费变体**（special / 名字含 免费·無料·free / 价格为 0） */
  hasFreeVariant: function (a) {
    return ((a && a.versions) || []).some(function (v) {
      if (!v || typeof v !== 'object') return false;
      if (v.special) return true;
      if (/免费|無料|free/i.test(String(v.name || ''))) return true;
      var pd = derivePrice(String(v.price || ''));
      return pd.isFree === true || (pd.value != null && pd.value === 0);
    });
  },
  /** v2.5.14（用户批复 A）：「付费」只给**确实有购买凭据**的素材——没花过钱的素材不再被标成「付费」 */
  isPaidAsset: function (a) { return !!a && a.isFree === false && App.hasPurchaseProof(a); },
  /** v2.5.14（用户批复 A）：价格桶 —— 卡片丝带 / 价格筛选 / 侧栏计数**共用同一条判据**，
   *  避免「丝带说免费、点筛选却是付费」。
   *  · 'paid'：有购买凭据且非免费　· 'free'：isFree===true，或没有购买凭据但有免费变体　· ''：其余 */
  priceBucket: function (a) {
    if (!a) return '';
    if (App.isPaidAsset(a)) return 'paid';
    if (a.isFree === true) return 'free';
    if (!App.hasPurchaseProof(a) && App.hasFreeVariant(a)) return 'free';
    return '';
  },
  /** 商店来源的默认计价币种（BOOTH=JPY / Gumroad=USD）；未知返回 ''。
   *  v2.5.14：用于「裸数字价」的兜底 —— **绝不默认 CNY**（旧实现在空币种时默认 CNY，
   *  于是 BOOTH 的 1680 日元变体价显示成「CNY 1,680」）。 */
  sourceCurrency: function (a) {
    if (!a) return '';
    var list = [a.source].concat((a.sources || []).map(function (s) { return s && s.source; }));
    if (list.indexOf('booth') >= 0) return 'JPY';
    if (list.indexOf('gumroad') >= 0) return 'USD';
    return '';
  },
  /** 价格排序用数值：与统计口径一致（好友分享/非 BOOTH 商品价不计） */
  sortPriceValue: function (a) {
    var ep = App.effectivePrice(a);
    return (ep && ep.value != null) ? ep.value : null;
  },

  /** 统计各维度数量 */
  stats: function () {
    var s = { total: App.assets.length, categories: {}, sources: {}, avatars: {}, tags: {},
      downloaded: 0, favorite: 0, withPath: 0, hidden: 0, r18: 0, delisted: 0, wishlist: 0,
      price: { all: App.assets.length, free: 0, paid: 0, unknown: 0, share: 0, gift: 0, unpurchased: 0 } };
    App.assets.forEach(function (a) {
      if (a.hidden) s.hidden++;
      if (a.delisted) s.delisted++;
      if (a.extra && a.extra.wishlist) s.wishlist++;
      var friend = App.isFriend(a);
      var unpurchased = App.purchaseState(a) === 'unpurchased';
      /* v2.5.3（用户批复）：计数口径与筛选口径对齐——六个维度各自独立累加。
       * 原先用 else-if 链把每条素材只归一类，而筛选里「未购买」并不排除好友分享/获赠，
       * 于是侧栏显示「未购买 69」点进去却 80 条（真实库实测差 11 条）。 */
      if (unpurchased) s.price.unpurchased++;
      if (a.gifted) s.price.gift++;
      if (friend) s.price.share++;
      var plain = !friend && !a.gifted && !unpurchased;   // 免费/付费/未记录与筛选一致：排除分享、获赠、未购买
      var pBucketS = App.priceBucket(a);                  // v2.5.14（用户批复 A）：与丝带/筛选同一条判据
      if (plain && pBucketS === 'free') s.price.free++;
      else if (plain && pBucketS === 'paid') s.price.paid++;
      else if (plain) s.price.unknown++;
      var r18Hit = (a.extra && a.extra.r18) || /(^|[^a-z0-9])r-?18([^a-z0-9]|$)/i.test((a.tags || []).join(' '));
      if (r18Hit) s.r18++;
      s.categories[a.category] = (s.categories[a.category] || 0) + 1;
      s.sources[a.source] = (s.sources[a.source] || 0) + 1;
      App.filterAvatars(a).forEach(function (v) { s.avatars[v] = (s.avatars[v] || 0) + 1; });
      App.displayTags(a).forEach(function (t) { s.tags[t] = (s.tags[t] || 0) + 1; });
      if (a.downloaded) s.downloaded++;
      if (a.favorite) s.favorite++;
      if ((a.paths || []).length) s.withPath++;
    });
    return s;
  },

  /* ---------------- 主题 ---------------- */
  /** v4.5：把标题栏配色同步给主进程。按**解析后的主题**取色（樱粉/天际蓝各有自己的窗口底色），
   *  窗口按钮仍是系统画的，这里只换底色与符号色。 */
  syncTitleBar: function (t) {
    try {
      if (!(window.vrcElectron && typeof window.vrcElectron.setTitleBar === 'function')) return;
      var meta = (typeof themeMeta === 'function') ? themeMeta(t) : null;
      var dark = (t === 'dark');
      window.vrcElectron.setTitleBar({
        color: (meta && meta.titleBar) || (dark ? '#14171d' : '#ffffff'),
        symbolColor: (meta && meta.symbol) || (dark ? '#a3abbb' : '#5b6579')
      });
    } catch (e) {}
  },

  /** 设置里的主题值 → 实际生效的主题 id（'auto' 按系统深浅色解析） */
  resolveTheme: function (theme) {
    var t = theme || (App.settings && App.settings.theme) || 'dark';
    if (t === 'auto') {
      t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    }
    if (t !== 'dark' && t !== 'light' && t !== 'sakura' && t !== 'sky') t = 'dark';
    return t;
  },

  applyTheme: function (theme) {
    var t = App.resolveTheme(theme);
    document.documentElement.setAttribute('data-theme', t);
    /* 毛玻璃是独立开关；老配置里没有这个字段时按「开」处理（与 defaultSettings 一致） */
    var glass = !(App.settings && App.settings.glass === false);
    document.documentElement.setAttribute('data-glass', glass ? '1' : '0');
    App.syncTitleBar(t);
    var btn = $('#btnTheme');
    if (btn) {
      var meta = (typeof themeMeta === 'function') ? themeMeta(App.settings.theme) : null;
      ICONS.apply(btn, ((App.settings.theme === 'auto') ? '\u{1F504}' : (meta ? meta.icon : (t === 'dark' ? '\u{1F319}' : '\u2600'))));
    }
  },

  /* ---------------- 选择模式 ---------------- */
  selectedIds: function () { return Object.keys(App.selection).filter(function (k) { return App.selection[k]; }); },
  clearSelection: function () { App.selection = Object.create(null); },

  /* ---------------- 保存 / 删除 ---------------- */
  save: function (asset) {
    var a = Store.normalizeAsset(asset);
    var old = App.assets.find(function (x) { return x.id === a.id; });

    /* v4.3.2：防止「旧快照整条覆盖」
     * 网格卡片、列表行在渲染时拿到的是当时的对象引用。如果这期间后台异步改过这条素材
     * （最典型的是 adoptDiskCover 把 hasCover 置 true 并落库），用户随后点一下★收藏，
     * 保存的就是那份旧快照 —— 封面标记被打回 false，重启后卡片变占位图。
     * 判据：调用方对象的 updatedAt 早于库里的，就认为是旧快照，
     * 这些**界面上不直接编辑、只由后台维护**的字段以库里为准。 */
    if (old && String(a.updatedAt || '') && String(old.updatedAt || '')
      && String(a.updatedAt) < String(old.updatedAt)) {
      ['hasCover', 'coverCleared', 'downloaded', 'downloadedAt', 'galleryFiles'].forEach(function (k) {
        if (old[k] !== undefined) a[k] = old[k];
      });
    }

    // 多来源：当前来源自动并入 sources，标注取得方式
    var entries = a.sources && a.sources.length ? a.sources.slice() : [];
    if (!entries.some(function (e) { return e.source === a.source && (e.sourceCustom || '') === (a.sourceCustom || ''); })) {
      entries.push(Store.normalizeSource({ source: a.source, sourceCustom: a.sourceCustom, via: a.importedFrom || 'manual', at: nowISO() }));
    }
    a.sources = entries;
    // 标题 / 角色名变化时，同步重命名素材库中的文件夹（尽力而为），并同步更新存储路径
    var pre = Promise.resolve();
    var existedBefore = !!old;
    if (old && App.folderName(old) !== App.folderName(a)) {
      /* v5.6（用户要求）：改名/改标题前先查重 —— 素材库里已有别的素材占用了同一个文件夹名就拒绝，
       * 否则两个素材会争同一个目录，后面的写入互相覆盖。 */
      var wantFolder = App.folderName(a);
      var clash = App.assets.filter(function (x) {
        return x.id !== a.id && App.folderName(x).toLowerCase() === wantFolder.toLowerCase();
      })[0];
      if (clash) {
        return Promise.reject(new Error('已存在同名素材「' + (clash.title || clash.id) + '」，换个标题或角色名再保存'));
      }
      /* v2.5.16：旧段名取**磁盘上的实际名字**（存储路径末段）——否则「导入后改过标题 / 翻译过标题」的素材
       * （真实库 398 条里 293 条如此）会因为路径对不上而改名失败、路径也更新不了。 */
      var realOld = '';
      var oldPath = App.primaryLocalPath(old);
      if (oldPath) realOld = oldPath.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '');
      var oldFolder = realOld || App.folderName(old);
      var newFolder = App.folderName(a);
      pre = FS.renameAssetFolder(oldFolder, newFolder, App.categoryLabel(a.category), old).then(function (renamed) {
        if (renamed) App.updatePathsForFolderName(a, oldFolder, newFolder);
      }).catch(function (e) {
        /* v5.4：改名是「尽力而为」，失败也绝不能让保存卡住或整体失败 */
        if (typeof console !== 'undefined' && console.warn) console.warn('[rename] 跳过：' + ((e && e.message) || e));
        return false;
      });
    }
    return pre.then(function () { return Store.putAsset(a); }).then(function (saved) {
      App.scheduleFileSync('assets');
      var i = App.assets.findIndex(function (x) { return x.id === saved.id; });
      if (i >= 0) App.assets[i] = saved;
      /* v4.3.2：只有**确实新增**的素材才插进列表。
       * 以前这里无条件 unshift，于是「改名保存要复制整个素材文件夹、耗时几秒」期间
       * 用户把这条删掉，保存一完成它就又回来了（删了又出现）。 */
      else if (!existedBefore) App.assets.unshift(saved);
      return saved;
    });
  },
  remove: function (id) {
    return Store.deleteAsset(id).then(function () {
      App.dropCover(id);
      App.assets = App.assets.filter(function (x) { return x.id !== id; });
    });
  },

  /** 全局修改标签：对所有使用该标签的素材生效 */
  renameTag: function (oldTag, newTag) {
    var changed = 0;
    var list = App.assets.map(function (a) {
      var b = false;
      ['tags', 'rawTags'].forEach(function (key) {
        var arr = a[key] || [];
        for (var i = 0; i < arr.length; i++) {
          if (arr[i] === oldTag) { arr[i] = newTag; b = true; }
        }
      });
      if (b) changed++;
      return a;
    });
    return Store.putAssets(list).then(function () {
      App.assets = list;
      UI.renderAll();
      return changed;
    });
  },

  /** 清理重复冗余标签：角色名 / 分类名 / 来源名 / 黑名单 + 去重 */
  cleanRedundantTags: function () {
    var blocked = Smart.blacklistSet();
    var cats = {}, srcs = {};
    App.allCategories().forEach(function (c) { cats[String(c.label).toLowerCase()] = 1; });
    App.allSources().forEach(function (s) { srcs[String(s.label).toLowerCase()] = 1; });
    function isRedundant(t) {
      var low = String(t).toLowerCase();
      return !!(blocked[low] || Smart.isBlacklisted(t) || cats[low] || srcs[low] || Smart.isAvatarEquivalent(t));
    }
    var removed = 0, changedAssets = 0;
    function canonical(t) { return Smart.translateTag(t).text || String(t); }
    var list = App.assets.map(function (a) {
      var before = (a.tags || []).length + (a.rawTags || []).length;
      a.tags = uniq((a.tags || []).map(canonical).filter(function (t) { return !isRedundant(t); }));
      a.rawTags = uniq((a.rawTags || []).map(canonical).filter(function (t) { return !isRedundant(t); }));
      var after = a.tags.length + a.rawTags.length;
      removed += (before - after);
      if (before !== after) changedAssets++;
      return a;
    });
    return Store.putAssets(list).then(function () {
      App.assets = list;
      UI.renderAll();
      return { removed: removed, assets: changedAssets };
    });
  },

  /** 全局删除标签：从所有素材中移除 */
  deleteTag: function (tag) {
    var changed = 0;
    var list = App.assets.map(function (a) {
      var b = false;
      ['tags', 'rawTags'].forEach(function (key) {
        var arr = a[key] || [];
        var n = arr.filter(function (x) { return x !== tag; });
        if (n.length !== arr.length) { a[key] = n; b = true; }
      });
      if (b) changed++;
      return a;
    });
    return Store.putAssets(list).then(function () {
      App.assets = list;
      UI.renderAll();
      return changed;
    });
  }
};


/* =====================================================================
 * 渲染层
 * ===================================================================== */
var UI = {

  /* v2.5.13（性能复查第 2 轮 · 「快速开机」）：renderAll/renderMain/renderGrid 支持**可选的分步渲染**——
   * 传 opts = { progressive:true, firstChunk, budgetMs, onFirstPaint, onDone } 时，
   * 先同步渲出首批卡片（首屏立刻可见），其余按时间片分帧续渲；
   * **不传 opts ＝ 与旧行为完全相同的一次性同步渲染**（其它所有调用点不受影响）。 */
  renderAll: function (opts) {
    UI.renderSidebar();
    UI.renderMain(opts);
  },

  /**
   * 保存/导入后保持视图稳定：卡片已在本页 → 只做必要的滚动；不在本页 → 只在
   * 「当前筛选结果里仍包含它」时换页定位。**绝不清空用户的筛选 / 搜索**
   * （v2.3.16：旧实现在找不到卡片时会重置 filters + 搜索框并跳回第 1 页，
   *  用户看到的就是「刷新一下回到了开头、然后又滚回来」）。
   */
  /** v2.5.2：把某张卡片标成「当前素材」（蓝色边框 + 外扩光晕，没有多选那样的勾选标记）——
   *  常驻而不是闪一下：这样刷新/重渲染之后你仍然看得出刚才打开/改的是哪一个。 */
  /** v5.2（用户要求）：只重画这一张卡，不动整页、不重置滚动、不重播入场动画。
   *  返回 false = 这张卡当前不在屏幕上（被筛掉 / 不在本页），交给调用方决定要不要整体刷新。 */
  refreshCard: function (id) {
    var sel = '.card[data-id="' + String(id).replace(/"/g, '') + '"]';
    var node = document.querySelector(sel);
    if (!node) return false;
    var asset = (App.assets || []).filter(function (x) { return x.id === id; })[0];
    if (!asset) return false;
    /* 改完之后如果它已经不符合当前筛选 / 不在本页，就交回整体渲染（该消失就消失）。 */
    var pi = App.pageInfo();
    var onPage = (pi.items || []).some(function (x) { return x.id === id; });
    if (!onPage) { UI.renderAll(); return true; }
    var fresh = UI.card(asset);
    fresh.style.animation = 'none';
    if (node.parentNode) node.parentNode.replaceChild(fresh, node);
    if (App.activeAssetId === id) UI.flashCard(id);
    return true;
  },

  flashCard: function (id) {
    App.activeAssetId = id || '';
    var cards = document.querySelectorAll('.card');
    Array.prototype.forEach.call(cards, function (c) {
      if (!c.dataset) return;
      c.classList.toggle('card-active', c.dataset.id === App.activeAssetId);
    });
  },

  /* v2.5.9（用户要求）：搜索 / 排序 / 视图切换 / 侧栏筛选 → **瞬间回顶部**（不用平滑动画） */
  /* v2.5.16（用户反馈「顶栏右侧不该有滚动条」）：把**内容区** .layout 变成滚动容器、顶栏保持 fixed，
   * 滚动条就只从顶栏下方开始。为不动上层语义，滚动读写统一走下面这几个封装：
   * 有 .layout 就用它，没有（异常结构/沙箱）自动退回 window —— 行为与改前一致。 */
  scrollEl: function () { return document.querySelector('.layout'); },
  sY: function () {
    var el = UI.scrollEl();
    if (el) return el.scrollTop;
    /* v3.0.0 修复：抽滚动容器时这里误写成 `(UI.sY())` —— 自调用 ⇒ 没有 .layout 时**无限递归**报
     * RangeError（注释承诺的「退回 window」根本走不到）。兜底要真的读 window。 */
    return (typeof window !== 'undefined') ? (window.scrollY || window.pageYOffset || 0) : 0;
  },
  scrollTo: function (y) {
    var v = Math.max(0, Math.round(Number(y) || 0));
    var el = UI.scrollEl();
    if (el) { el.scrollTop = v; return; }
    try { window.scrollTo(0, v); } catch (e) {}
  },
  scrollToSmooth: function (y) {
    var v = Math.max(0, Math.round(Number(y) || 0));
    var el = UI.scrollEl();
    try {
      if (el && el.scrollTo) el.scrollTo({ top: v, behavior: 'smooth' });
      else window.scrollTo({ top: v, behavior: 'smooth' });
    } catch (e) { if (el) el.scrollTop = v; else window.scrollTo(0, v); }
  },
  /** 内容区可见带的中心（定位用）—— 不能再用 window.innerHeight/2，顶栏那 58px 不属于内容区 */
  centerY: function () {
    var el = UI.scrollEl();
    /* v3.0.0 修复：同上，`return UI.centerY()` 是自调用（无限递归）；退回 window 视口中心。 */
    if (!el) return (typeof window !== 'undefined') ? Math.round(window.innerHeight / 2) : 0;
    var r = el.getBoundingClientRect();
    return Math.round(r.top + el.clientHeight / 2);
  },
  scrollTopInstant: function () { UI.scrollTo(0); },
  /** v2.5.9（用户要求）：**卡片内**发起的筛选（卡片上的分类/来源/角色/标签 chip、分类角标、价格丝带）
   *  —— 不回顶部：从当前位置出发把这张卡**定位到视口居中**；
   *  跨页时自动切到它所在页（页码跟着变，切页后先还原滚动位置再瞬间居中）；
   *  若这张卡被新筛选排除 → **保持当前位置不动**。 */
  filterFromCard: function (asset, mutate) {
    var id = asset && asset.id;
    var y = UI.sY();
    try { mutate(); } catch (e) {}
    App.page = 1;
    UI.renderAll();
    /* v2.5.9 关键：renderAll 会先清空网格 → 文档瞬间变矮 → **浏览器把 scrollY 夹到 0**，
     * 于是"当前位置"丢失、还会被误判成"已经可见"。所以渲染后立刻把滚动位置还原。 */
    UI.scrollTo(y);
    var all = App.filtered();
    var idx = -1;
    for (var i = 0; i < all.length; i++) { if (all[i].id === id) { idx = i; break; } }
    if (idx < 0) { UI.scrollTo(y); return; }               // 被筛掉 → 位置不动
    var size = App.pageSizeFor();
    var target = size > 0 ? (Math.floor(idx / size) + 1) : 1;
    if (target !== (App.page || 1)) {
      App.page = target;
      UI.renderAll();
      UI.scrollTo(y);                                      // 换页先回原位置，避免"先跳顶再滚下"
    }
    /* v2.5.9（用户要求）：**从当前位置开始滚，滚到目标卡出现为止**（最小滚动，不居中、不跳顶）；
     * 跨页也一样先试当前位置。顶部兜底**只在根本做不到时**才用（元素始终不在 DOM / 无法进入视口），
     * 不作为常规回落。 */
    function cardVisible() {
      var c = document.querySelector('.card[data-id="' + id + '"]');
      if (!c) return false;
      var r = c.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    }
    function revealNearest() {
      var c = document.querySelector('.card[data-id="' + id + '"]');
      if (!c) return false;
      try { c.scrollIntoView({ block: 'nearest', behavior: 'auto' }); } catch (e) {}
      return cardVisible();
    }
    setTimeout(function () {
      if (cardVisible()) return;                                  // 已经在可见范围内 → 一点不动
      if (revealNearest()) return;                                // 从当前位置滚到它出现
      UI.scrollTopInstant();                                      // 不行 → 从顶部重新来
      setTimeout(function () { revealNearest(); }, 60);
    }, 80);
  },
  revealAsset: function (id) {
    var card = document.querySelector('.card[data-id="' + id + '"]');
    if (card) {
      var r = card.getBoundingClientRect();
      if (r.top >= 0 && r.bottom <= window.innerHeight) return;
      // v2.5.2（用户批复）：定位不做滚动动画——直接瞬间到位
      UI.scrollTo(Math.max(0, (UI.sY()) + r.top - UI.centerY() + Math.round(r.height / 2)));
      return;
    }
    var all = App.filtered();
    var idx = -1;
    for (var i = 0; i < all.length; i++) { if (all[i].id === id) { idx = i; break; } }
    if (idx < 0) return;                       // 被当前筛选排除 → 保持视图不动，不动筛选条件
    var target = Math.floor(idx / (App.settings.pageSize || 48)) + 1;
    if (target !== (App.page || 1)) {
      // v2.3.17：换页后先回到用户原来的滚动位置，再平滑挪到目标卡片——
      // 以前重渲染会把视图甩回页面顶部，用户看到的是「先回到开头再滚下来」
      var y = UI.sY();
      App.page = target;
      UI.renderMain();
      UI.scrollTo(y);
    }
    setTimeout(function () {
      var c = document.querySelector('.card[data-id="' + id + '"]');
      if (!c) return;
      var rr = c.getBoundingClientRect();
      if (rr.top >= 0 && rr.bottom <= window.innerHeight) return;
      UI.scrollTo(Math.max(0, (UI.sY()) + rr.top - UI.centerY() + Math.round(rr.height / 2)));   // 同样是瞬间定位
    }, 80);
  },

  /** 计算一次 pageInfo，复用给网格和工具条，避免重复 filter/sort */
  renderMain: function (opts) {
    var pi = App.pageInfo();
    UI.renderGrid(pi, opts);
    UI.renderToolbar(pi);
  },

  /* ---------------- 侧栏筛选 ---------------- */
  renderSidebar: function () {
    var root = $('#sidebarBody'); if (!root) return;
    var st = App.stats();
    root.innerHTML = '';

    // 概览（已下载标注已移除，仅保留总数 / 收藏 / 已关联路径）
    root.appendChild(el('div', { class: 'side-stat' }, [
      el('div', { class: 'stat-item' }, [el('b', { text: String(st.total) }), el('span', { text: '素材总数' })]),
      el('div', { class: 'stat-item' }, [el('b', { text: String(st.favorite) }), el('span', { text: '喜欢' })]),
      el('div', { class: 'stat-item' }, [el('b', { text: String(st.withPath) }), el('span', { text: '已关联路径' })])
    ]));

    // 状态：紧跟概览之后（下拉式，直接显示标签文案，v2.3.1 起不再套「状态：…的素材」）
    var statusSelect = el('select', {
      class: 'input status-select', id: 'statusFilter', title: '按状态筛选素材',
      onchange: function () { App.filters.status = statusSelect.value; App.page = 1; UI.renderAll(); }
    }, STATUS_FILTERS.map(function (s) {
      return el('option', { value: s.id, selected: App.filters.status === s.id }, s.label);
    }));
    root.appendChild(el('div', { class: 'side-status-inline' }, [statusSelect]));

    // 来源（按需求移到分类上方；与标签/分类一样以 chips 展示，按匹配数量降序）
    root.appendChild(UI.filterGroup('来源', App.allSources().map(function (c) {
      return { id: c.id, label: c.label, iconKind: 'src', count: st.sources[c.id] || 0,
        active: App.filters.sources.indexOf(c.id) >= 0 };
    }).filter(function (x) { return x.count > 0 || x.active; })
      .sort(function (a, b) { return b.count - a.count; }), function (id) {
      UI.toggleArr(App.filters.sources, id); App.page = 1; UI.renderAll();
    }, 'chips'));

    // 分类（数量降序；“其他”固定最后）
    root.appendChild(UI.filterGroup('分类', App.allCategories().map(function (c) {
      return { id: c.id, label: c.label, iconKind: 'cat', count: st.categories[c.id] || 0,
        active: App.filters.categories.indexOf(c.id) >= 0, last: c.id === 'other' };
    }).filter(function (x) { return x.count > 0 || x.active || App.settings.showEmptyFacets; })
      .sort(function (a, b) { return b.count - a.count; }), function (id) {
      UI.toggleArr(App.filters.categories, id); App.page = 1; UI.renderAll();
    }, 'chips'));

    // 支持角色：选中「通用/多角色」时其他角色变灰锁定（已选中的保留但只按通用参与筛选）
    var universalFilterOn = App.filters.avatars.indexOf('universal') >= 0;
    var avItems = App.allAvatars().map(function (c) {
      return { id: c.id, label: c.label, count: st.avatars[c.id] || 0, active: App.filters.avatars.indexOf(c.id) >= 0,
        pinned: c.id === 'universal', disabled: universalFilterOn && c.id !== 'universal' };
    }).filter(function (x) { return x.id === 'universal' || x.count > 0 || x.active; })
      .sort(function (a, b) { return b.count - a.count; });   // 通用 pinned 置顶，其余按数量降序
    root.appendChild(UI.filterGroup('支持角色', avItems, function (id) {
      if (universalFilterOn && id !== 'universal') return;   // 通用选中时其他角色锁定
      UI.toggleArr(App.filters.avatars, id); App.page = 1; UI.renderAll();
    }, 'chips', 30));

    // 标签（免费 / 付费 / 分享 / 获赠 / R18 / 已下架 作为特殊标签置顶；特殊标签无论有没有素材都显示；其余按数量排序）
    var priceFacets = [
      { id: '__r18__', label: 'R18', count: st.r18, active: !!App.filters.r18, pinned: true, cls: 'facet-r18' },
      { id: '__delisted__', label: '已下架', count: st.delisted, active: !!App.filters.delisted, pinned: true, cls: 'facet-delisted' },
      { id: '__wishlist__', label: '心愿单', count: st.wishlist, active: !!App.filters.wishlist, pinned: true, cls: 'facet-wishlist' }
    ];
    var tagItems = priceFacets.concat(Object.keys(st.tags).sort(function (a, b) { return st.tags[b] - st.tags[a]; })
      .map(function (t) {
        /* v3.0.0（用户要求）：侧栏标签也走三态 —— in 用 active（主色），out 用 tag-out（红色 + 删除线） */
        var tstate = UI.tagFilterState(t);
        return { id: t, label: t, count: st.tags[t], active: tstate === 'in', cls: tstate === 'out' ? 'tag-out' : '', state: tstate, title: UI.tagFilterTitle(t, tstate) };
      }));
    root.appendChild(UI.filterGroup('标签', tagItems, function (id) {
      if (id === '__r18__') { App.filters.r18 = !App.filters.r18; App.page = 1; UI.renderAll(); return; }
      if (id === '__delisted__') { App.filters.delisted = !App.filters.delisted; App.page = 1; UI.renderAll(); return; }
      if (id === '__wishlist__') { App.filters.wishlist = !App.filters.wishlist; App.page = 1; UI.renderAll(); return; }
      UI.cycleTagFilter(id);   // v3.0.0（用户要求）：默认 → 必须包含 → 排除 → 默认
    }, 'chips', 40));

    // 重置
    root.appendChild(el('button', {
      class: 'btn btn-ghost btn-block', onclick: function () {
        App.filters = { q: '', categories: [], sources: [], avatars: [], tags: [], tagsNot: [], status: 'all', price: 'all', r18: false, delisted: false, wishlist: false };
        App.page = 1;
        UI.promotedFilters = Object.create(null);
        var si = $('#searchInput'); if (si) si.value = '';
        UI.renderAll();
      }
    }, ICONS.label('\u{1F504} 重置全部筛选')));
  },

  toggleArr: function (arr, id) {
    var i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1); else arr.push(id);
  },

  /* ---------------- v3.0.0（用户要求）：标签筛选三态 ----------------
   * 默认（none）→ 必须包含（in：App.filters.tags，AND）→ 排除（out：App.filters.tagsNot，命中任一即过滤）→ 默认。
   * 侧栏标签项 / 卡片标签 chip / 详情页标签 chip 三处统一走这里，避免三套行为漂移。 */
  tagFilterState: function (t) {
    if (!t) return 'none';
    if ((App.filters.tags || []).indexOf(t) >= 0) return 'in';
    if ((App.filters.tagsNot || []).indexOf(t) >= 0) return 'out';
    return 'none';
  },
  /** 状态 → 追加到 .tag 上的 class（in 沿用 v2.5.10 的 tag-on；out 新增 tag-out，红色 + 删除线） */
  tagFilterClass: function (state) {
    return state === 'in' ? ' tag-on' : (state === 'out' ? ' tag-out' : '');
  },
  tagFilterTitle: function (t, state) {
    var now = state === 'in' ? '必须包含' : (state === 'out' ? '排除' : '不筛选');
    return '标签：' + t + '（当前：' + now + '）—— 点击：默认 → 必须包含 → 排除 → 取消';
  },
  /** 推进三态；opts.render === false 时只改数据（交给调用方渲染——卡片内筛选走 filterFromCard 的定位逻辑） */
  cycleTagFilter: function (t, opts) {
    opts = opts || {};
    if (typeof t !== 'string' || !t) return 'none';
    if (!Array.isArray(App.filters.tags)) App.filters.tags = [];
    if (!Array.isArray(App.filters.tagsNot)) App.filters.tagsNot = [];
    var state = UI.tagFilterState(t);
    if (state === 'none') {
      App.filters.tags.push(t);
    } else if (state === 'in') {
      var i = App.filters.tags.indexOf(t);
      if (i >= 0) App.filters.tags.splice(i, 1);
      if (App.filters.tagsNot.indexOf(t) < 0) App.filters.tagsNot.push(t);
    } else {
      var j = App.filters.tagsNot.indexOf(t);
      if (j >= 0) App.filters.tagsNot.splice(j, 1);
    }
    if (opts.render !== false) { App.page = 1; UI.renderAll(); }
    return UI.tagFilterState(t);
  },

  filterGroup: function (title, items, onPick, style, limit) {
    /* v4.3.2：折叠状态跨渲染保留。以前 open 是局部变量，每次 renderSidebar 重建都从「展开」开始，
     * 用户折好分组、滚到下面点一个筛选项，回来发现自己又被展开了。 */
    UI._groupOpen = UI._groupOpen || Object.create(null);
    var open = UI._groupOpen[title] !== false;
    var wrap = el('div', { class: 'side-group' + (style === 'chips' ? ' chips-group' : '') + (open ? '' : ' collapsed') });
    var head = el('div', { class: 'side-group-head' + (open ? '' : ' collapsed') }, [
      el('span', { text: title }),
      el('span', { class: 'side-group-count', text: items.length ? String(items.length) : '' })
    ]);
    var body = el('div', { class: 'side-group-body' });
    if (!open) body.style.display = 'none';
    head.addEventListener('click', function () {
      open = !open;
      UI._groupOpen[title] = open;
      body.style.display = open ? '' : 'none';
      head.classList.toggle('collapsed', !open);
    });
    // 临时提前的选中项：跨 renderSidebar 保留，直到「展开全部」或刷新页面才清空
    UI.promotedFilters = UI.promotedFilters || Object.create(null);
    var promoted = UI.promotedFilters[title] || (UI.promotedFilters[title] = Object.create(null));

    function renderList(expanded) {
      body.innerHTML = '';
      // pinned 永远置顶；last 永远垫底（分类里的“其他”）；其余保持调用方给定的数量顺序（稳定排序）
      var ordered = items.slice().sort(function (a, b) {
        var pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0;
        if (pa !== pb) return pb - pa;
        var la = a.last ? 1 : 0, lb = b.last ? 1 : 0;
        if (la !== lb) return la - lb;
        return 0;
      });
      if (!expanded && limit) {
        ordered.forEach(function (it, idx) {
          if (idx >= limit && it.active) promoted[it.id] = 1;
        });
        var base = ordered.slice(0, limit);
        var out = base.slice();
        Object.keys(promoted).forEach(function (id) {
          var it = ordered.filter(function (x) { return String(x.id) === id; })[0];
          if (it && out.indexOf(it) < 0) out.unshift(it);
        });
        ordered = out;
      }
      if (!ordered.length) body.appendChild(el('div', { class: 'side-empty', text: '暂无' }));
      ordered.forEach(function (it) {
        body.appendChild(el('button', {
          class: 'side-item' + (it.active ? ' active' : '') + (it.cls ? ' ' + it.cls : '') + (it.disabled ? ' dim' : ''),
          title: it.disabled ? (it.label + '（已选「通用/多角色」，该角色不参与筛选）') : (it.title || it.label),
          disabled: !!it.disabled,
          /* v2.5.9（用户要求）：**侧栏**发起的筛选一律瞬间回顶部；卡片内发起的筛选走 UI.filterFromCard（定位、不回顶） */
          onclick: function () { onPick(it.id); UI.scrollTopInstant(); }
        }, [
          it.iconKind ? App.icon(it.iconKind, it.id, { size: 14, class: 'side-ico' }) : null,
          el('span', { class: 'side-item-label', text: it.label }),
          it.count == null ? null : el('span', { class: 'side-item-count', text: String(it.count) })
        ]));
      });
      if (!expanded && limit && items.length > limit) {
        body.appendChild(el('button', {
          class: 'side-more', onclick: function () {
            delete UI.promotedFilters[title];
            renderList(true);
          }
        }, '展开全部 ' + items.length + ' 项 \u25BE'));
      }
    }
    renderList(false);
    wrap.appendChild(head); wrap.appendChild(body);
    return wrap;
  },

  /* ---------------- 工具条 ---------------- */
  renderToolbar: function (pi) {
    pi = pi || App.pageInfo();
    var n = pi.total;
    var info = $('#resultInfo');
    if (info) {
      info.textContent = '共 ' + n + ' 项' + (n !== App.assets.length ? '（总计 ' + App.assets.length + '）' : '') +
        (pi.pages > 1 ? '  ·  第 ' + pi.page + ' / ' + pi.pages + ' 页' : '');
    }
    var ps = $('#pageSizeSelect');
    if (ps && String(ps.value) !== String(App.settings.pageSize)) ps.value = String(App.settings.pageSize);
    var sel = $('#sortSelect');
    if (sel && sel.value !== App.settings.sort) sel.value = App.settings.sort;
    var bar = $('#bulkBar');
    if (bar) {
      var ids = App.selectedIds();
      bar.classList.toggle('show', App.selectMode);
      var c = $('#bulkCount'); if (c) c.textContent = String(ids.length);
    }
    var g = $('#grid');
    if (g) {
      g.classList.toggle('list-view', App.settings.view === 'list');
      g.setAttribute('data-size', App.settings.cardSize || 'm');
    }
    $$('.view-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.view === App.settings.view); });
  },

  /* ---------------- 卡片网格 ---------------- */
  /** 按当前宽度和卡片尺寸计算纵向分栏数量 */
  masonryColumnCount: function (width) {
    var cfg = { s: 170, m: 220, l: 290 };
    var colWidth = cfg[App.settings.cardSize] || 220;
    var gap = App.settings.cardSize === 's' ? 10 : (App.settings.cardSize === 'l' ? 18 : 14);
    width = width || (($('#grid') && $('#grid').clientWidth) || 0);
    if (!width || width <= colWidth) return 1;
    return Math.max(1, Math.floor((width + gap) / (colWidth + gap)));
  },

  renderGrid: function (pi, opts) {
    var grid = $('#grid');
    if (!grid) { if (opts && opts.onDone) opts.onDone(); return; }
    pi = pi || App.pageInfo();
    var list = pi.items;
    grid.innerHTML = '';
    var isList = App.settings.view === 'list';
    grid.classList.toggle('list-view', isList);
    grid.setAttribute('data-size', App.settings.cardSize || 'm');
    UI.renderPager(pi);
    var empty = $('#emptyState');
    if (!list.length) {
      if (empty) {
        empty.style.display = '';
        $('#emptyText').textContent = App.assets.length
          ? '没有符合当前筛选条件的素材，试试重置筛选。'
          : '素材库还是空的，点击右上角「+ 添加素材」开始建立；别人给你的 .vrcpack 素材包、zip / unitypackage 素材，直接拖进窗口就能导入。';
      }
      if (opts && opts.onFirstPaint) opts.onFirstPaint();
      if (opts && opts.onDone) opts.onDone();
      return;
    }
    if (empty) empty.style.display = 'none';

    /* v5.0：不再自己轮转分栏。列数交给 CSS grid 按「容器宽度 / 固定卡宽」算：
     * 收起侧栏 → 容器变宽 → 自动多排几列，卡片尺寸不变；
     * 同一行里最高的卡决定行高，其余卡撑满这一行。 */
    var doneCb = function () { if (opts && opts.onDone) opts.onDone(); };
    var frag = document.createDocumentFragment();
    var animIdx = 0;
    function renderOne(a) {
      var card = UI.card(a);
      /* 入场错峰：最多 14 张累加，每张 18ms，避免大页等太久 */
      card.style.animationDelay = (Math.min(animIdx, 14) * 18) + 'ms';
      animIdx++;
      frag.appendChild(card);
    }
    function flush() { grid.appendChild(frag); frag = document.createDocumentFragment(); }
    if (!opts || !opts.progressive) {
      for (var k = 0; k < list.length; k++) renderOne(list[k]);
      flush();
      doneCb();
      return;
    }
    /* 分步渲染：首批同步入 DOM，其余按 budgetMs 时间片分帧续渲；最终顺序与一次性渲染一致。 */
    var firstChunk = Math.max(1, opts.firstChunk || 24);
    var budget = opts.budgetMs || 12;
    var at = 0;
    for (; at < list.length && at < firstChunk; at++) renderOne(list[at]);
    flush();
    if (opts.onFirstPaint) opts.onFirstPaint();
    if (at >= list.length) { doneCb(); return; }
    function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
    function nextFrame(fn) {
      var fired = false;
      function go() { if (fired) return; fired = true; fn(); }
      var to = setTimeout(go, 50);                    // 兜底：页面被隐藏 / rAF 被节流时也能继续推进
      if (window.requestAnimationFrame) window.requestAnimationFrame(function () { clearTimeout(to); go(); });
    }
    (function step() {
      nextFrame(function () {
        var t0 = nowMs();
        while (at < list.length && nowMs() - t0 < budget) { renderOne(list[at]); at++; }
        flush();
        if (at >= list.length) { doneCb(); return; }
        budget = Math.min(budget * 2, 150);
        step();
      });
    })();
  },

  /** 分页条 */
  renderPager: function (pi) {
    var box = $('#pager'); if (!box) return;
    box.innerHTML = '';
    document.body.classList.toggle('has-pager', !!(pi && pi.pages > 1));
    if (!pi || pi.pages <= 1) { box.style.display = 'none'; return; }
    box.style.display = '';
    function go(n) { App.page = n; UI.renderMain(); UI.scrollToSmooth(0); }
    box.appendChild(el('button', { class: 'btn btn-sm', disabled: pi.page <= 1, onclick: function () { go(pi.page - 1); } }, '‹ 上一页'));
    var nums = [];
    for (var i = 1; i <= pi.pages; i++) {
      if (i === 1 || i === pi.pages || Math.abs(i - pi.page) <= 2) nums.push(i);
      else if (nums[nums.length - 1] !== '…') nums.push('…');
    }
    nums.forEach(function (n) {
      if (n === '…') { box.appendChild(el('span', { class: 'pager-gap', text: '…' })); return; }
      box.appendChild(el('button', {
        class: 'btn btn-sm' + (n === pi.page ? ' btn-primary' : ''),
        onclick: function () { go(n); }
      }, String(n)));
    });
    box.appendChild(el('button', { class: 'btn btn-sm', disabled: pi.page >= pi.pages, onclick: function () { go(pi.page + 1); } }, '下一页 ›'));
  },

  /** v4.7：标题开头的 [xxx] 当成一个整体（不拆行），避免出现「用)]IconGenerator」这种半截孤行。
   *  只在括号组不超过 14 个字时启用 —— 再长就放任它按需断行，免得撑出卡片。 */
  cardTitleChildren: function (text) {
    var s = String(text || '');
    var m = /^(\[[^\[\]]{1,14}\])/.exec(s);
    if (!m || m[1].length >= s.length) return s;
    return [el('span', { class: 'tt-prefix' }, m[1]), '\u200B', s.slice(m[1].length)];
  },

  card: function (a) {
    var selected = !!App.selection[a.id];
    // 有封面时分类图标缩小为左下角角标（与左上角路径角标错开）；无封面时才作为大占位图标
    var cover = el('div', { class: 'card-cover' }, [
      el('div', { class: 'cover-ph' }, [App.categoryIcon(a.category, { size: 34 })])
    ]);
    App.coverURLFor(a).then(function (url) {
      if (!url) return;
      // 只要存在封面地址就进入「角标模式」；加载失败时退回大占位图标
      cover.classList.add('has-img');
      var img = new Image();
      img.className = 'cover-img';
      img.alt = a.title;
      img.loading = 'lazy';
      img.onerror = function () {
        cover.classList.remove('has-img');
      };
      /* v5.2：封面图不允许被拖走 —— 以前拖它到别的卡片上，会走「拖图设封面」逻辑，
       * 把别人卡片的封面换掉。 */
      img.draggable = false;
      img.src = url;
      cover.appendChild(img);
    });

    var badges = el('div', { class: 'card-badges' }, [
      /* v2.3.28：类型图标移到封面左上角，与其它角标同排（下方那个重复的分类气泡已去掉） */
      el('span', {
        class: 'badge badge-dim cat-badge',
        title: '分类：' + App.categoryLabel(a.category) + '（点击只看此分类）',
        onclick: function (e) { e.stopPropagation(); UI.filterFromCard(a, function () { App.filters.categories = [a.category]; }); }
      }, [App.categoryIcon(a.category, { size: 18 })]),
      (a.extra && a.extra.r18) ? el('span', { class: 'badge badge-r18', title: '成人向（R-18）' }, 'R18') : null,
      a.delisted ? el('span', { class: 'badge badge-dim', title: '商品已下架 / 无法获取信息', text: '已下架' }) : null,
      a.hidden ? el('span', { class: 'badge badge-dim', title: '已隐藏'}, ICONS.label('\u{1F648}')) : null,
      /* v2.3.29：本地路径 / 网盘角标移到封面左下角（见下方 card-corner），这里不再重复 */
    ]);
    cover.appendChild(badges);

    // v2.3.29：文件关联类角标（本地路径 / 网盘）放封面左下角，可点击直接打开
    var localPath = App.primaryLocalPath(a);
    var corner = el('div', { class: 'card-corner' }, [
      localPath ? el('span', {
        class: 'badge badge-dim', title: '已关联本地路径：' + localPath + '（点击打开）',
        onclick: function (e) { e.stopPropagation(); FS.openPath(localPath); }
      }, ICONS.label('\u{1F4C1}')) : null,
      a.cloudUrl ? el('span', {
        class: 'badge badge-cloud',
        title: isHttpUrl(a.cloudUrl) ? '网盘：' + a.cloudUrl + '（点击打开链接）' : '网盘：' + a.cloudUrl + '（不是网页链接，点击复制）',
        onclick: function (e) {
          e.stopPropagation();
          if (isHttpUrl(a.cloudUrl)) window.open(a.cloudUrl, '_blank', 'noopener');
          else { copyText(a.cloudUrl); Toast.info('网盘地址已复制：' + a.cloudUrl, 2600); }
        }
      }, ICONS.label('\u2601')) : null
    ]);
    if (corner.children.length) cover.appendChild(corner);

    /* v5.2：价格字段已移除 —— 卡片上不再画价格丝带（免费 / 付费 / 未购买 / 分享 / 获赠）。
     * 只保留与价格无关的两枚：心愿单、开源。 */
    if (a.extra && a.extra.wishlist && !App.isPurchased(a)) {
      cover.appendChild(el('span', {
        class: 'price-ribbon ribbon-wishlist', title: 'BOOTH 心愿单商品，点击只看心愿单',
        onclick: function (e) { e.stopPropagation(); UI.filterFromCard(a, function () { App.filters.wishlist = !App.filters.wishlist; }); }
      }, '心愿单'));
    } else if (App.isGitHubSource(a)) {
      cover.appendChild(el('span', {
        class: 'price-ribbon ribbon-oss', title: '开源素材（GitHub 仓库），点击只看 GitHub 来源',
        onclick: function (e) { e.stopPropagation(); UI.filterFromCard(a, function () { App.filters.sources = ['github']; }); }
      }, '开源'));
    }

    // 封面右下角：发布 / 上架日期（有记录才显示）
    if (a.publishedAt) {
      cover.appendChild(el('span', { class: 'cover-date', title: '发布 / 上架日期：' + fmtDate(a.publishedAt) }, fmtDate(a.publishedAt)));
    }

    cover.appendChild(el('button', {
      class: 'fav-btn' + (a.favorite ? ' on' : ''),
      title: a.favorite ? '取消喜欢' : '喜欢',
      onclick: function (e) {
        e.stopPropagation();
        /* v4.3.2：`a` 是渲染那一刻的快照。保存必须拿库里最新的那条，
         * 否则会把后台刚写好的封面标记 / 下载状态一并覆盖回旧值。 */
        var live = App.assets.find(function (x) { return x.id === a.id; }) || a;
        live.favorite = !live.favorite;
        a.favorite = live.favorite;
        App.save(live).then(function () { UI.renderAll(); });
      }
    }, a.favorite ? ICONS.label('\u2605') : ICONS.label('\u2606')));

    var srcEntries = App.sourceEntries(a);
    var primarySrc = App.primarySource(a);
    var primaryLabel = (primarySrc.source === 'other' && primarySrc.sourceCustom)
      ? primarySrc.sourceCustom
      : App.sourceLabel({ source: primarySrc.source, sourceCustom: primarySrc.sourceCustom });
    var srcTag = el('span', {
      class: 'chip chip-source chip-click', style: { borderColor: App.sourceColor(primarySrc.source) },
      title: '来源：' + srcEntries.map(function (s) { return (s.source === 'other' && s.sourceCustom) ? s.sourceCustom : App.sourceLabel({ source: s.source, sourceCustom: s.sourceCustom }); }).join('、') + '（点击只看此来源）',
      onclick: function (e) { e.stopPropagation(); UI.filterFromCard(a, function () { App.filters.sources = [primarySrc.source]; }); }
    }, [App.sourceIcon(primarySrc.source, { size: 13 }), document.createTextNode(primaryLabel + (srcEntries.length > 1 ? ' +' + (srcEntries.length - 1) : ''))]);

    var body = el('div', { class: 'card-body' }, [
      el('div', { class: 'card-title', title: a.title || a.originalTitle }, UI.cardTitleChildren(a.title || a.originalTitle || '（未命名）')),
      a.originalTitle && a.originalTitle !== a.title
        ? el('div', { class: 'card-subtitle', title: a.originalTitle }, a.originalTitle) : null,
      el('div', { class: 'card-chips' }, [
        el('span', {
          class: 'chip chip-cat chip-click', title: '分类：' + App.categoryLabel(a.category) + '（点击只看此分类）',
          onclick: function (e) { e.stopPropagation(); UI.filterFromCard(a, function () { App.filters.categories = [a.category]; }); }
        }, [App.categoryIcon(a.category, { size: 13 }), document.createTextNode(App.categoryLabel(a.category))]),
        srcTag,
      ]),
      (a.avatars || []).length ? el('div', { class: 'card-avatars' },
        App.normalizeAvatarIds(App.filterAvatars(a)).slice(0, 4).map(function (v) {
          var avLabel = App.avatarLabel(v);
          return el('span', {
            class: 'chip chip-av chip-click' + (App.filters.avatars.indexOf(v) >= 0 ? ' chip-on' : ''), title: '角色：' + avLabel + '（点击只看此角色）',
            onclick: function (e) { e.stopPropagation(); UI.filterFromCard(a, function () { App.filters.avatars = [v]; }); }
          }, avLabel);
        })
          .concat(a.avatars.length > 4 ? [el('span', {
            class: 'chip chip-av chip-more',
            /* v2.3.28：悬停显示被收起的角色（原来只有一个没有任何说明的 +N） */
            title: '另有 ' + (a.avatars.length - 4) + ' 个支持角色：' +
              App.normalizeAvatarIds(App.filterAvatars(a)).slice(4).map(App.avatarLabel).join('、')
          }, '+' + (a.avatars.length - 4))] : [])
      ) : null,
      (function () {
        var all = App.displayTags(a);
        if (!all.length) return null;
        /* v5.2（用户反馈「卡片标签显示有问题」）：原来固定塞 5 枚进一行 nowrap，
         * 装不下时 flex 会把每枚都压扁成「短」「猫」这种一两个字 —— 读不了。
         * 现在最多 3 枚；超过 3 枚只放 2 枚 + 「+N」，每枚不参与压缩，长标签自己省略号。 */
        var shown = all.length > 3 ? all.slice(0, 2) : all.slice(0, 3);
        var moreN = all.length - shown.length;
        var nodes = shown.map(function (t) {
          var tstate = UI.tagFilterState(t);
          return el('span', {
            class: 'tag tag-click' + (Smart.isUntranslated(t) ? ' tag-untrans' : '') + UI.tagFilterClass(tstate),
            title: UI.tagFilterTitle(t, tstate),
            onclick: function (e) { e.stopPropagation(); UI.filterFromCard(a, function () { UI.cycleTagFilter(t, { render: false }); }); }
          }, t + (Smart.isUntranslated(t) ? '（待翻译）' : ''));
        });
        if (moreN > 0) nodes.push(el('span', {
          class: 'tag tag-more',
          title: '另有 ' + moreN + ' 个标签：' + all.slice(shown.length).join('、')
        }, '+' + moreN));
        return el('div', { class: 'card-tags' }, nodes);
      })(),
    ]);

    var card = el('div', {
      class: 'card' + (selected ? ' selected' : '') + (App.activeAssetId === a.id ? ' card-active' : ''),
      dataset: { id: a.id },
      onclick: function (e) {
        if (App.selectMode) {
          App.selection[a.id] = !App.selection[a.id];
          UI.renderMain();
        } else {
          App.activeAssetId = a.id;   // v2.5.2：记住「正在看/改哪一个」，刷新后仍然高亮
          UI.flashCard(a.id);          // v2.5.2 修正：点开详情页就立刻显示光晕（原来只有重渲染后才出现）
          Modals.detail(a.id);
        }
      }
    }, [cover, body]);

    if (App.selectMode) {
      card.appendChild(el('div', { class: 'sel-mark' + (selected ? ' on' : '') }, selected ? ICONS.label('\u2714') : ''));
    }
    /* v4.4：右键菜单（编辑 / 分类 / 标签 / 角色 / 复制 / 喜欢 / 隐藏 / 导出 / 删除） */
    if (typeof AssetMenu !== 'undefined' && AssetMenu.attach) AssetMenu.attach(card, a);
    return card;
  }
};

