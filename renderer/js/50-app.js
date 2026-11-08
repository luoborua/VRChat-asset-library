/* 应用核心：状态、字典合并、筛选排序、价格模型与卡片 / 侧栏渲染。
 * 负责维护 App.settings / App.assets 内存态及其派生视图，对外暴露 App 与 UI 两个全局对象。
 * 依赖 Store / FS / Smart 等模块做持久化与抓取，不直接发起网络请求。
 * 不含弹窗、表单与启动装配，那些分别在 60 / 70 / 90 中实现。
 */

/** 把写盘失败的三类原因翻成用户能自救的话：
 *  若把「体积超上限」也说成「后端离线」，用户会一直等一个永远不会成功的重试。 */
function mbText(n) { return (Number(n || 0) / 1048576).toFixed(2); }
function fileWriteFailShort(kind) {
  if (kind === 'db-error') return '素材数据库写入失败';
  if (kind === 'too-large') return '数据体积超过单次写入上限';
  if (kind === 'host-error') return '拒绝写入（目录被占用 / 无写权限）';
  return '写入失败（原因未知）';
}
function fileWriteFailText(kind, info) {
  var dir = App.localDir || '(未知目录)';
  if (kind === 'db-error') {
    return '素材数据库写入失败（' + dir + '）：' + String(info.error || '未知原因')
      + '。改动仍在浏览器缓存里；请确认数据目录可写（不要放在只读位置 / 不要被其它程序占用），'
      + '修好后按 Ctrl+S 或再改一次任意素材即可补写。';
  }
  if (kind === 'too-large') {
    /* 悬崖值由上限现算（不写死），后端上限变了这里自动跟着变 */
    var cliffRaw = Math.floor(((Number(info.limitBytes) || 0) - 256) * 3 / 4);
    return '数据太大，未能写入 ' + dir + '：本次请求体约 ' + mbText(info.bodyBytes) + ' MB（原始 JSON ' + mbText(info.rawBytes)
      + ' MB），超过程序后端单次写入上限 ' + mbText(info.limitBytes) + ' MB（' + String(info.limitBytes) + ' 字节）——'
      + '原始 JSON 超过约 ' + mbText(cliffRaw) + ' MB 就一定写不进去。'
      + '本次不会自动重试。改动仍在浏览器缓存里：请先按 Ctrl+S（或设置页「导出完整备份」）留底，'
      + '再清理不用的素材 / 大字段后重试；确实需要更大的主库时，得由后端侧提高该上限。';
  }
  if (kind === 'host-error') {
    return '后端拒绝写入 ' + dir + '：' + String(info.error || '未知原因')
      + '（常见原因：目录被占用 / 没有写权限 / 路径不存在）。请关闭占用该目录的程序、检查权限，'
      + '或到「设置 → 本地库与整理」改用别的库目录。改动仍在浏览器缓存里。';
  }
  return '未能写入 ' + dir + '：程序后端未就绪（不是目录不可写）。请重启程序，'
    + '再按 Ctrl+S 或改一次任意素材即可补写落盘；改动仍在本地缓存里。';
}

/** 带 scheme:// 的条目不是本地磁盘路径（如网盘地址）。
 *  normalizeWinPath 会把 // 压成 \，等于把原始信息毁掉 —— 这类条目一律原样保留，
 *  别的地方要判断「这条路径能不能当本地目录用」也用它。 */
function isSchemePath(p) { return /^[a-z][a-z0-9+.\-]*:\/\//i.test(String(p || '')); }

var App = {
  assets: [],                       // 在用素材（不含回收站）
  trashed: [],                      // 已删除、只留标记的素材（回收站页用）
  settings: defaultSettings(),
  coverCache: Object.create(null),   // id -> objectURL
  iconCache: Object.create(null),    // 原始图标 URL -> 本地 objectURL（IndexedDB 缓存）
  filters: { q: '', categories: [], sources: [], avatars: [], tags: [], tagsNot: [], status: 'all', price: 'all', r18: false, delisted: false, wishlist: false },
  selection: Object.create(null),
  selectMode: false,
  page: 1,
  ready: false,
  detailAssetId: '',   // 当前详情弹窗展示的素材 id（Modals.syncDetailId 维护），用于判断能否原地刷新


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
  /* 这三张表不加跨调用缓存：设置里直接改字段（不走 saveSettings）的路径存在，
   * 跨调用缓存会变成「改了不生效」的隐性 bug。性能只在单次调用内批量化。 */
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

  /* ---------------- 单次批量作用域 ----------------
   * 一次 reload 的存量清洗要对全库反复取角色表、角色显示名、标签表与黑名单正则，
   * 若每条素材都重建一遍就浪费。作用域是调用方私有的临时对象，用完即弃，不是跨调用缓存；
   * 角色设置表的引用一变就整体作废重建，保证「直接改设置也立刻生效」。
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
  /** 角色表里「名字就是工具/软件名」的自定义角色 id ——整轮只算一遍 */
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
    if (iconURL && /^data:image\//i.test(iconURL)) return ICONS.custom(iconURL, opts);   // 本地内嵌品牌图直接渲染
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
    /* 手填购买价 = 用户自己记下真的花了多少钱，有值即视为已购买 ——
     * 否则价格不显示、也不计入花费统计。 */
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
    base.images = concatUniq(base.images, inc.images);   // 图集不截断，与 normalizeAsset 保持一致
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
   * 剔除指向「已不存在的角色」的悬空引用：角色记录丢失后素材只留着 av_… id，卡片只能显示裸 id。
   * 判定依据 = 内置角色 + 自定义角色 + 已合并删除的内置角色。
   * 安全阀：角色字典为空却出现大量未知 id 时，更可能是设置没读进来而不是真有坏引用 → 整条清洗跳过。
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
    // 只把「已知文件扩展名」当文件。通用的「点 + 字母数字」判断会把 …_v1.0.6.1 这类
    // 文件夹名误判为文件，再取父目录就把路径砍成分类目录。
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
      /* 非本地路径原样留在旁边：收敛只针对本地路径，不能因此把它们丢掉 */
      var foreign = all.filter(function (x) { return isSchemePath(x.path); })
        .map(function (x) { return { path: x.path, note: x.note }; });
      var entries = all.filter(function (x) { return !isSchemePath(x.path); }).map(function (x) {
        return { path: normalizeWinPath(x.path), note: x.note };
      }).filter(function (x) { return x.path; });
      if (!entries.length) {
        if (foreign.length && JSON.stringify(foreign) !== JSON.stringify(a.paths || [])) { a.paths = foreign; changed++; }
        return;
      }
      var expected = App.folderName(a).toLowerCase();
      var catLabel = String(App.categoryLabel(a.category || 'other') || '').toLowerCase();
      // 末级正好等于素材文件夹名就是它，先于「像不像文件」的判断，否则会被父目录砍掉一级
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
      var one = [{ path: finalPath, note: '存储路径' }].concat(foreign);
      if (JSON.stringify(one) !== JSON.stringify(a.paths || [])) { a.paths = one; changed++; }
    });
    return { list: list, changed: changed };
  },

  /**
   * 定向修正「存储路径退化成分类目录」的坏数据：
   * 只处理末级正好等于某个分类名的路径，并用后端确认 <库根>\<分类>\<素材文件夹名> 真实存在才改写。
   * 不做全库扫描，后端离线直接跳过。
   */
  repairCategoryOnlyPaths: function (list) {
    list = list || [];
    var rootPath = App.libraryRoot();
    var changed = 0;
    // 路径末级若正好是【任一】分类名，说明它曾被截断成分类目录。
    // 不能用素材的「当前分类」判断：分类改过之后路径里的分类段是变更前的分类，按当前分类比对必然漏修。
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
   * 登记某类路径（默认「存储路径」）时只替换这一类，其余条目原样保留。
   * 直接赋 asset.paths = [{…}] 会清掉用户登记的网盘位置与原始位置，而且保存后不可恢复。
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
  /** 统一的「改标题」入口：右键菜单和编辑页保存都走同一套逻辑。
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
    /* 角色表在本轮同步内只取一遍，不按素材重建；设置表被换掉就由 scopeAvatars 重建。 */
    function avatarPool() { return scope ? App.scopeAvatars(scope) : App.allAvatars(); }
    /* 用「名字 → 最早出现的下标」索引代替每条素材各做一次 find；
     * 索引跟着池子的数组身份走：池子重建或新建角色时作废重算。 */
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
      // 先在整个角色表（内置 + 自定义）里按名字/别名匹配；命中就直接复用，避免建出重复角色
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
    // 模型的三语名字在双层循环外先算一遍，避免每个素材都重算
    var modelNames = models.map(function (m) { return [m.charNameZh, m.charNameJa, m.charNameEn].filter(Boolean); });
    // 小写形式也预先算好，省掉内层的 toLowerCase
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
        // 代理功能已移除：遗留的代理列表不再使用
        if (!Array.isArray(base.proxies)) base.proxies = [];
        // 联网方式归一：早期配置存成 proxyMode /「代理·直连·自动」，一律折算为当前取值
        if (s.fetchMode === undefined && s.proxyMode !== undefined) {
          base.fetchMode = (s.proxyMode === 'direct') ? 'direct' : 'paste';
        }
        if (['proxy', 'direct', 'auto'].indexOf(base.fetchMode) >= 0) base.fetchMode = 'host';
        if (FETCH_MODES.map(function (m) { return m.id; }).indexOf(base.fetchMode) < 0) base.fetchMode = 'paste';
        // 配置里可能存过账号密码，统一清除，只保留 Cookie
        var creds = base.credentials || {};
        Object.keys(creds).forEach(function (h) {
          if (creds[h] && (creds[h].user !== undefined || creds[h].pass !== undefined)) {
            creds[h] = { cookie: creds[h].cookie || '' };
          }
        });
      }
      // 角色名优先显示的取值只允许 label/zh/ja/en；无效值回退到显示名。
      // 非 label 的取值一律归一为 label，之后用户仍可自由再选。
      if (['label', 'zh', 'ja', 'en'].indexOf(base.avatarNamePriority) < 0) {
        base.avatarNamePriority = 'label'; settingsDirty = true;
      }
      if (!base.avatarNamePriorityMigrated && base.avatarNamePriority !== 'label') {
        base.avatarNamePriority = 'label'; base.avatarNamePriorityMigrated = true; settingsDirty = true;
      }
      /* 后端已内置在主进程里，不再有「后端工具文件夹」或启动器参数可配置：
       * 这里只做存量清理，免得设置文件里一直留着几个永不生效的键。 */
      ['proxyToolPath', 'hostToolPath', 'hostBackground'].forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(base, k)) { delete base[k]; settingsDirty = true; }
      });
      // 本地路径设置统一成单反斜杠，清掉双反斜杠写法
      ['libraryRootPath'].forEach(function (k) {
        var nv = normalizeWinPath(base[k]);
        if (nv !== base[k]) { base[k] = nv; settingsDirty = true; }
      });
      App.settings = base;
      /* 窄条件路径自愈（不阻塞设置加载；后端离线或路径有效时什么都不做） */
      try { App.healDerivedPaths(); } catch (e) {}
      if (settingsDirty) App.saveSettings();
      return base;
    });
  },
  /* ---------------- 文件主库 ----------------
   * <HTML 同目录>\vrclib-data\ 是数据本体，IndexedDB 降为缓存。
   * 后端离线 / 非 file:// 打开且未配置目录 → 只在浏览器缓存里读写，不落盘。
   */
  localDir: '',
  localReadOnly: false,
  _fileDirty: null,
  _fileTimer: null,
  /** 启动时读入文件主库；文件存在则以文件为准并回灌 IndexedDB */
  localOffline: false,
  localCacheNewer: false,   // 启动时发现缓存比文件新 → 稍后由启动链回写文件
  needSyncAfterBoot: false, // 判定「以缓存为准」后必须真回写一次，否则 at 不动 → 每次开机都判定缓存更新
  bootLocalData: function () {
    App.localDir = Store.local.dataDir(App.settings);
    // 无法推导数据目录（非 file:// 打开且未配置）→ 只读缓存
    if (!App.localDir) { App.localReadOnly = true; App.localOffline = false; return Promise.resolve(false); }
    // 后端离线时必须真的进入「只读缓存」，否则每次保存都静默写失败且不提示。
    // 读取本身不受影响——素材照常从缓存读出，只是改动暂不落盘。
    return FS.hostEnsure().then(function (ok) {
      if (!ok) { App.localReadOnly = true; App.localOffline = true; return false; }
      App.localReadOnly = false; App.localOffline = false;
      // 文件与缓存按时间戳比，谁新用谁：否则离线期间只在缓存里做的改动，
      // 下次启动会被文件里的版本覆盖掉。
      return Promise.all([Store.local.loadAll(App.settings), Store.allAssets()]).then(function (r) {
        var loc = r[0], cached = r[1] || [];
        // settings.json 的外壳是 {v,at,settings:{…}}，这里必须只取内层——
        // 整包并进 App.settings 会把这几个键写回，文件每次启动多嵌一层。
        if (loc.settings) {
          var savedSettings = (loc.settings.settings && typeof loc.settings.settings === 'object') ? loc.settings.settings : loc.settings;
          /* 文件里可能残留已废弃的后端启动参数，合并前要剔掉，
           * 否则上面 loadSettings 的清理会被这一步原样覆盖回来。 */
          ['proxyToolPath', 'hostToolPath', 'hostBackground'].forEach(function (k) { delete savedSettings[k]; });
          App.settings = Object.assign({}, App.settings, savedSettings);
          delete App.settings.v; delete App.settings.at; delete App.settings.settings;
          /* 设置里可能写着「数据放在别的盘」：合并后必须重算 localDir，
           * 否则后续封面 / 队列的路径全指错。 */
          App.localDir = Store.local.dataDir(App.settings) || App.localDir;
          /* applyTheme() 在合并文件设置之前已经跑过一遍，合并完要重新应用一次，
           * 否则主题 / 毛玻璃这些开关会停在缓存里的那份设置上。 */
          try { App.applyTheme(); } catch (e) {}
        }
        var list = (loc.assets && Array.isArray(loc.assets.assets)) ? loc.assets.assets : null;
        if (!list && (loc.readErrors || []).length) {
          // 数据文件存在但读不出来（超出写入上限 / JSON 损坏 / 权限）——
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
        if (cacheAt > fileAt + 2000) {                      // 缓存更新 → 不采用时间戳更早的文件，交给启动链回写
          App.localCacheNewer = true;
          /* 光标记「以缓存为准」不够，回写必须真的发生：只弹提示不落盘的话，
           * 文件里的 at 会一直停在原值，下次启动照样判定「缓存更新」，每次开机都弹一次。 */
          App.needSyncAfterBoot = true;
          return false;
        }
        App.localCacheNewer = false;
        var fixed = list.map(Store.normalizeAsset);
        App.assets = fixed;
        return Store.putAssets(fixed).then(function () { return true; });
      });
    }).catch(function () { App.localReadOnly = true; return false; });
  },
  /** 数据文件读不出来时的红色告警条——先保住文件，再谈写入 */
  showReadBrokenBanner: function () {
    if (document.getElementById('localReadBrokenBanner')) return;
    var bar = el('div', { id: 'localReadBrokenBanner', class: 'local-banner local-banner-danger' }, [
      el('span', {}, ICONS.label('\u26D4 数据文件读取失败，已暂停写入以防覆盖：' + (App.localReadError || '未知原因') + '（素材仍从浏览器缓存读取）')),
      el('button', { class: 'btn btn-xs btn-primary', onclick: function () { location.reload(); } }, '修复后重新载入'),
      el('button', { class: 'btn btn-xs', onclick: function () { var b = document.getElementById('localReadBrokenBanner'); if (b) b.remove(); } }, '知道了')
    ]);
    document.body.insertBefore(bar, document.body.firstChild);
  },
  /** 后端离线时的常驻提示条：说明当前只读缓存，并提供「重试连接」把改动补写落盘 */
  showLocalBanner: function () {
    if (document.getElementById('localDataBanner')) return;
    var bar = el('div', { id: 'localDataBanner', class: 'local-banner' }, [
      el('span', {}, ICONS.label('\u26A0 程序后端离线：素材照常读取，但改动只存在浏览器缓存，尚未写入 ' + (App.localDir || '数据目录'))),
      el('button', { class: 'btn btn-xs btn-primary', onclick: function () {
        FS.hostEnsureRetry(3).then(function (ok) {
          if (!ok) { Toast.warn('仍未连接到程序后端：请重启程序后再点重试', 6200); return; }
          App.localReadOnly = false; App.localOffline = false;
          var b = document.getElementById('localDataBanner'); if (b) b.remove();
          Toast.ok('已连接程序后端，正在把离线期间的改动写入 ' + App.localDir);
          App.scheduleFileSync();     // 无参 = 素材与设置都标脏，整体补写一次
          App.syncCoverFiles(60);     // 顺带补写离线期间只落在浏览器缓存里的封面
        });
      } }, ICONS.label('\u{1F504} 重试连接')),
      el('button', { class: 'btn btn-xs', onclick: function () {
        var b = document.getElementById('localDataBanner'); if (b) b.remove();
      } }, '知道了')
    ]);
    document.body.insertBefore(bar, document.body.firstChild);
  },
  /**
   * 扫描素材库，给「磁盘上已有文件夹、但素材没有本地路径」的素材补上路径。
   * 手动触发、只补不删：按 folderName 在各分类目录下查找真实存在的目录，当前分类优先；
   * 找不到就跳过，不改动任何已有路径，也不新建文件夹。
   */
  scanAndFillPaths: function (onLog) {
    onLog = onLog || function () {};
    var rootPath = App.libraryRoot();
    var targets = (App.assets || []).filter(function (a) {
      var local = (a.paths || []).filter(function (p) { return p && p.path; });
      return !local.length;
    });
    if (!targets.length) return Promise.resolve({ checked: 0, filled: 0, skipped: 0 });
    return FS.hostEnsure().then(function (ok) {
      if (!ok) throw new Error('程序后端未就绪：无法扫描素材库，请重启程序');
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
    App._fileRetryCount = 0;   // 有新的改动 → 自动重试次数重新计（用户在编辑＝还在继续补写）
    App._fileTimer = setTimeout(function () { App.flushFileSync(); }, 1200);
  },
  flushFileSync: function () {
    if (!App.localDir || App.localReadOnly || App.localReadBroken) return Promise.resolve(false);
    var d = App._fileDirty || {};
    App._fileDirty = null;
    var jobs = [];
    if (d.assets) jobs.push(Store.local.saveAssets(App.assets.concat(App.trashed || []), App.settings));
    if (d.settings) jobs.push(Store.local.saveSettings(App.settings));
    if (!jobs.length) return Promise.resolve(false);
    return Promise.all(jobs).then(function (rs) {
      var failed = rs.some(function (r) { return r === false; });
      if (!failed) { App._fileWarned = false; App._fileRetryCount = 0; App._fileWarnKind = ''; return true; }
      // 写失败不静默：重新标脏 + 明确提示 + 自动重试（后端恢复后由「重试连接」或这里补写）
      App._fileDirty = App._fileDirty || {};
      if (d.assets) App._fileDirty.assets = true;
      if (d.settings) App._fileDirty.settings = true;
      /* 先分清楚是哪一类失败再说话，原因来自 Store.local.lastWriteFail() */
      var fInfo = (Store.local.lastWriteFail && Store.local.lastWriteFail()) || { kind: 'host-offline' };
      var fKind = fInfo.kind || 'host-offline';
      var retryable = (fKind !== 'too-large');
      if (fKind !== App._fileWarnKind) { App._fileWarned = false; App._fileWarnKind = fKind; }   // 原因变了要重新说明一次
      if (!App._fileWarned) { App._fileWarned = true; Toast.warn(fileWriteFailText(fKind, fInfo), 9000); }
      /* 自动重试有次数上限：后端一直离线时不可能无限重排（每次还会连带端口探测）。
       * 15 次（约 5 分钟）后停下，改由「重试连接」或下一次改动重新开始；
       * 体积超上限是确定性失败，一次也不重试，其余失败每次都要让用户看到进度与原因。 */
      var FILE_RETRY_MAX = 15, FILE_RETRY_MS = 20000;
      if (!retryable) {
        App._fileRetryCount = FILE_RETRY_MAX;
        console.warn('[localData] 体积超过后端写入上限，已停止自动重试：' + JSON.stringify(fInfo));
        return false;
      }
      if (!App._fileRetry && (App._fileRetryCount || 0) < FILE_RETRY_MAX) {
        App._fileRetryCount = (App._fileRetryCount || 0) + 1;
        var fN = App._fileRetryCount;
        App._fileRetry = setTimeout(function () {
          App._fileRetry = null;
          if (App._fileDirty && !App.localReadOnly) App.flushFileSync();
          else if ((App._fileRetryCount || 0) >= FILE_RETRY_MAX) {
            console.warn('[localData] 自动重试已达上限，等后端恢复后由「重试连接」或新的改动补写');
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
  /** 把只在浏览器缓存里的封面补写到 vrclib-data\covers 与素材文件夹。
   *  用游标续跑：每轮从上次位置继续，逐个走 ensureCoverOnDisk（已存在的直接跳过）；
   *  按批次截断会让后面的素材永远轮不到。 */
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
    delete s.githubToken;   // GitHub Token 同样不导出
    return s;
  },

  /* ---------------- 数据加载 & 存量清洗 ---------------- */
  reload: function () {
    return Store.allAssets().then(function (list) {
      var changed = false;
      /* 整轮存量清洗共用一个批量作用域：角色表 / 显示名 / 标签表 / 黑名单 / 工具名角色表各只建一遍。
       * 作用域是本函数私有、用完即弃，不是跨调用缓存。 */
      var scope = App.newScope();
      /* 带 scheme:// 的条目不是本地磁盘路径：normalizeWinPath 会把 // 压成 \。
       * 这类条目已不能打开或扫描，但至少保留原文，用户能自己改成真实路径。 */
      var foreignPathCount = 0;
      function normPath(p) {
        var raw = String((p && typeof p === 'object' ? p.path : p) || '');
        return isSchemePath(raw) ? raw : normalizeWinPath(raw);
      }
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
          return normPath(p);
        }).map(function (p) {
          return { path: normPath(p), note: (p && typeof p === 'object' && p.note) || '' };
        });
        if (JSON.stringify(cleanedPaths) !== JSON.stringify(a.paths || [])) { a.paths = cleanedPaths; changed = true; }
        // 清洗 3.5：支持角色按显示名去重，避免内置角色与模型自定义角色同名时出现两个相同 chip
        var cleanAv = App.normalizeAvatarIds(a.avatars || [], scope);
        if (cleanAv.join('|') !== (a.avatars || []).join('|')) { a.avatars = cleanAv; changed = true; }
        // 清洗：BOOTH 素材可能被“兜底版本”锁住而没识别到已购变体 → 解锁，让下次打开自动重试
        if (a.source === 'booth' && a.autoFilled && a.autoFilled.versions) {
          var hasRealOrder = (a.versions || []).some(function (v) { return v.orderUrl && v.orderUrl.trim() && !v.special; });
          if (!hasRealOrder) { a.autoFilled.versions = false; changed = true; }
        }
        // 清洗 6：把误当成「支持角色」的工具/软件名词清掉（如 lilToon、Modular Avatar）
        if (typeof TOOL_STOP_RE !== 'undefined') {
          // 工具名角色表整轮只算一遍，不按素材重扫
          var badIds = App.scopeToolIds(scope);
          if (Object.keys(badIds).length) {
            App.settings.customAvatars = (App.settings.customAvatars || []).filter(function (c) { return !badIds[c.id]; });
            App.saveSettings();
          }
          var cleanedAv = (a.avatars || []).filter(function (id) { return !badIds[id] && !TOOL_STOP_RE.test(String(App.scopeAvatarLabel(scope, id))); });
          if (cleanedAv.length !== (a.avatars || []).length) { a.avatars = cleanedAv; changed = true; }
        }
        // 清洗 5：心愿单标记与「已购买」互斥——买了就不再是心愿单（否则卡片一直显示「心愿单」而不显示价格）
        if (a.extra && a.extra.wishlist && App.isPurchased(a)) { a.extra.wishlist = false; changed = true; }
        // 清洗 4：价格文本为空、但商品价已知 → 补上「免费 / 付费」判定
        if (a.isFree === null || a.isFree === undefined) {
          var spv = (a.shopPriceValue != null && isFinite(Number(a.shopPriceValue))) ? Number(a.shopPriceValue) : null;
          if (spv !== null) {
            var isBoothSrc = (a.source === 'booth') || (Array.isArray(a.sources) && a.sources.some(function (s) { return s && s.source === 'booth'; }));
            a.isFree = (spv === 0) && isBoothSrc;
            changed = true;
          }
        }
      });
      /* 把与内置分类同名的自定义分类「提升」为内置分类：素材引用与排序一并折算，自定义项删除，
       * 避免同一个分类并存两个 id。 */
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
      list.forEach(function (a) {
        (a.paths || []).forEach(function (p) {
          if (isSchemePath(p && typeof p === 'object' ? p.path : p)) foreignPathCount++;
        });
      });
      if (foreignPathCount && !App._foreignPathWarned) {
        App._foreignPathWarned = true;
        try {
          Toast.warn('有 ' + foreignPathCount + ' 条路径不是本地磁盘路径，已原样保留。'
            + '这些素材打开、扫描都会失败，建议在详情页改成实际路径。', 8000);
        } catch (eWarn) {}
      }

      /* 回收站里的记录也在这份清单里，只是带着 trashAt：拆成两份，
       * 界面只看 App.assets，回收站页只看 App.trashed，后续清洗也只跑在用素材。 */
      App.trashed = list.filter(function (a) { return a.trashAt > 0; });
      list = list.filter(function (a) { return !(a.trashAt > 0); });
      /* 素材编号：老记录没这个字段，这里一次性补齐（有 BOOTH 商品号的直接用商品号）；
       * 同时修掉「两条素材共用一个编号」的历史数据 —— 导入判重只看编号，
       * 共用编号会让它们被当成同一份、元数据互相覆盖。
       * 并进 changed，本轮结束会写回磁盘，不会每次开机重新生成一遍。 */
      var idFix = Store.ensureFileIds(list.concat(App.trashed));
      if (idFix.length) changed = true;
      /* 回收站里的记录改了号也要落盘：只在内存里改的话，下次开机重算一遍，
       * 撤回时拿到的编号又变了，对外的身份跟着飘。 */
      var trashedFix = idFix.filter(function (a) { return a.trashAt > 0; });
      if (idFix.dups) {
        try {
          Toast.warn('发现 ' + idFix.dups + ' 条素材的编号与别的素材重复，已重新分配（原编号在扫描时无法区分两份素材）。'
            + '如刚导入过好友素材包，导出方那边的编号可能需要重新核对。', 10000);
        } catch (eId) {}
      }
      App.assets = list;
      // 存量数据：把「下载存放位置（已创建文件夹）」等相对路径补全为完整路径（仅当路径真实存在）
      return FS.completeRelativePaths(list).then(function (rel) {
        if (rel.changed) changed = true;
        var pathFix = App.consolidateAssetPaths(list);
        if (pathFix.changed) changed = true;
        // 定向修正「路径退化成分类目录」的坏数据
        return App.repairCategoryOnlyPaths(list).then(function (rep) {
          if (rep && rep.changed) changed = true;
          var charSync = App.syncCharacterConfigs(list, scope);
          var dedupe = App.dedupeAvatarConfigs(list);
          if (charSync.cfgChanged || dedupe.cfgChanged) App.saveSettings();
          var assetFixList = charSync.assetsChanged.concat(dedupe.assetsChanged);
          // 清洗 7：剔除悬空角色引用。必须排在角色同步 / 去重之后，否则会误删刚建好的角色引用。
          var prune = App.pruneDanglingAvatars(list);
          if (prune.removed) {
            assetFixList = assetFixList.concat(prune.changed);
            try { Toast.info('已清理 ' + prune.removed + ' 处失效的角色引用（对应角色记录已不存在）', 6000); } catch (e) {}
          }
          var needAssetSave = changed || assetFixList.length;
          /* 把「这轮开机到底改没改数据」告诉启动流程：
           * 无条件 scheduleFileSync 等于每次开机都把整份 assets.json 重写一遍。 */
          App._lastReloadChanged = !!needAssetSave;
          if (needAssetSave) {
            /* changed 为真时整份重写；回收站里只改了编号的记录也要一起写回去 */
            var putList = changed ? list.concat(trashedFix) : uniq(assetFixList);
            return Store.putAssets(putList).then(function () { return list; });
          }
          return list;
        });
      });
    });
  },

  /** 素材在素材库中的文件夹名：{商品ID}_{角色英文名/标题}；总长截断但保留商品ID */
  /** 分类变更后把库内的素材文件夹搬到对应分类目录（库外路径一律不动）。
   *  oldCat 是变更前的分类 id；a.category 已经是新分类。返回 Promise<boolean> 表示有没有真的搬。 */
  /** 扫描「库内、但所在目录不是它当前分类目录」的素材，返回待移动清单（不修改任何东西） */
  planCategoryCleanup: function () {
    var root = App.libraryRoot();
    if (!root) return [];
    var norm = function (s) { return String(s || '').replace(/[\\/]+$/, '').toLowerCase(); };
    var rootL = norm(root);
    var out = [];
    (App.assets || []).forEach(function (a) {
      var list = (a.paths || []).filter(function (p) { return p && p.path; });
      var hit = list.filter(function (p) { return p.note === '存储路径'; })[0] || list[0];
      if (!hit) return;
      if (norm(hit.path).indexOf(rootL) !== 0) return;               // 库外路径不动
      var to = joinWinPath(root, [App.categoryLabel(a.category), App.folderName(a)]);
      if (norm(to) === norm(hit.path)) return;
      out.push({ asset: a, hit: hit, from: hit.path, to: to });
    });
    return out;
  },

  /** 执行整理：逐个移动目录并改写存储路径；返回 { moved, failed:[{name,reason}] } */
  runCategoryCleanup: function (items, onProgress) {
    var res = { moved: 0, failed: [] };
    var chain = Promise.resolve();
    items.forEach(function (it, i) {
      chain = chain.then(function () {
        if (onProgress) { try { onProgress(i + 1, items.length, it); } catch (e) {} }
        var parent = it.to.replace(/[\\/][^\\/]+$/, '');
        return Promise.resolve(FS.host.ensure ? FS.host.ensure() : true).then(function (ready) {
          if (!ready) throw new Error('程序后端未就绪');
          return FS.mkdirPath(parent).catch(function () {});
        }).then(function () {
          return FS.host.move(it.from, it.to);
        }).then(function () {
          it.asset.paths = (it.asset.paths || []).map(function (x) {
            return (x.path === it.hit.path) ? { path: it.to, note: it.hit.note || '存储路径' } : x;
          });
          return App.save(it.asset).then(function () { res.moved++; });
        }).catch(function (e) {
          res.failed.push({ name: it.asset.title || it.asset.id, reason: (e && e.message) || String(e) });
        });
      });
    });
    return chain.then(function () { return res; });
  },
  relocateToCategory: function (a, oldCat) {
    if (!a || !oldCat || oldCat === a.category) return Promise.resolve(false);
    var list = (a.paths || []).filter(function (p) { return p && p.path; });
    var hit = list.filter(function (p) { return p.note === '存储路径'; })[0] || list[0];
    if (!hit) return Promise.resolve(false);
    var root = App.libraryRoot();
    if (!root) return Promise.resolve(false);
    var norm = function (s) { return String(s || '').replace(/[\\/]+$/, '').toLowerCase(); };
    var cur = norm(hit.path);
    if (cur.indexOf(norm(root)) !== 0) return Promise.resolve(false);   // 库外素材不动
    var dst = joinWinPath(root, [App.categoryLabel(a.category), App.folderName(a)]);
    if (norm(dst) === cur) return Promise.resolve(false);
    var parent = dst.replace(/[\\\\\/][^\\\\\/]+$/, '');
    return FS.mkdirPath(parent).catch(function () {}).then(function () {
      return FS.movePath(hit.path, dst);
    }).then(function (ok) {
      if (!ok) {
        Toast.warn('分类已改，但文件夹没能移动（目标可能已存在同名目录）：' + dst, 6200);
        return false;
      }
      a.paths = (a.paths || []).map(function (x) {
        return (x === hit) ? { path: dst, note: hit.note || '存储路径' } : x;
      });
      return App.save(a).then(function () { return true; });
    }).catch(function (e) {
      Toast.warn('分类已改，移动文件夹失败：' + ((e && e.message) || e), 6200);
      return false;
    });
  },
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

  /**
   * 新建素材前给库内目录挑一个没被占用的名字。
   *
   * 为什么需要：目录已存在时若直接复用，两条素材算出同一个目录名就会共用目录，
   * 同名文件被静默覆盖，两条记录还会指向同一个 path，删一条另一条就悬空。
   *
   * 占用判定两路：① 已有素材登记的存储路径正是这个绝对路径（同名不同分类不算冲突）；
   * ② 磁盘上目录真的存在（opts.exists 优先用调用方手上的句柄探）。
   * 撞名依次试 名字_2、名字_3……最多 99 次，再不行带时间戳。
   *
   * opts.exists(name) → Promise<boolean>  自定义存在性探测
   * opts.excludeId  改已有素材时把自身排除
   * → Promise<{ name, renamed }>
   */
  pickFreeFolderName: function (desired, catLabel, opts) {
    opts = opts || {};
    var base = String(desired == null ? '' : desired)
      .replace(/[\\/:*?"<>|]/g, '_').replace(/^\s+|\s+$/g, '').slice(0, 120) || '未命名';
    var cat = String(catLabel == null ? '' : catLabel).trim();
    var root = '';
    try { root = normalizeWinPath(App.libraryRoot()); } catch (eRoot) { root = ''; }

    var taken = Object.create(null);
    var lastSegs = Object.create(null);
    (App.assets || []).forEach(function (x) {
      if (!x || (opts.excludeId && x.id === opts.excludeId)) return;
      var p = '';
      try { p = App.primaryLocalPath(x); } catch (ePath) { p = ''; }
      if (!p) return;
      var norm = normalizeWinPath(p);
      taken[norm.toLowerCase()] = 1;
      lastSegs[String(norm.split(/[\\/]/).pop() || '').toLowerCase()] = 1;
    });

    function absOf(name) { return cat && root ? joinWinPath(root, [cat, name]) : ''; }
    function inRegistry(name) {
      var abs = absOf(name);
      // 能拼出「库根\分类\名字」就按完整路径比（同名的不同分类不算冲突）；
      // 拼不出来（没配库根 / 没分类）就退回只比末段，宁可多改一次名也不覆盖别人的文件
      if (abs) return !!taken[normalizeWinPath(abs).toLowerCase()];
      return !!lastSegs[String(name).toLowerCase()];
    }
    function onDisk(name) {
      if (typeof opts.exists === 'function') {
        return Promise.resolve().then(function () { return opts.exists(name); })
          .then(function (v) { return !!v; }).catch(function () { return false; });
      }
      var abs = absOf(name);
      if (!abs || !FS.host || typeof FS.host.exists !== 'function') return Promise.resolve(false);
      return FS.host.exists(abs).then(function (kind) { return kind === 'file' || kind === 'dir'; })
        .catch(function () { return false; });
    }

    var n = 1;
    function step() {
      var cand = n === 1 ? base : base + '_' + n;
      if (n > 99) return Promise.resolve({ name: base + '_' + Date.now(), renamed: true });
      if (inRegistry(cand)) { n++; return step(); }
      return onDisk(cand).then(function (occupied) {
        if (!occupied) return { name: cand, renamed: cand !== base };
        n++;
        return step();
      });
    }
    return step();
  },

  cleanTitle: function (s) {
    return String(s || '').trim()
      .replace(/\s*[-–—|]\s*(BOOTH|Gumroad|pixiv)\s*$/i, '')
      .replace(/\s*[-–—|]\s*[^|]{2,40}\s*[-–—|]\s*BOOTH\s*$/i, '')
      .trim();
  },

  /** 是否 GitHub（开源）来源——决定「开源」斜丝带与详情页徽章 */
  isGitHubSource: function (a) {
    if (!a) return false;
    if (a.source === 'github') return true;
    return Array.isArray(a.sources) && a.sources.some(function (s) { return s && s.source === 'github'; });
  },

  /** 是否已购买（有订单链接或抓取时识别为已购）——心愿单标记据此失效 */
  isPurchased: function (a) {
    if (!a) return false;
    if (a.extra && a.extra.purchased) return true;
    return (a.versions || []).some(function (v) { return v && v.orderUrl && String(v.orderUrl).trim(); });
  },

  /** 素材库根目录的生效路径——设置里没填就用默认值（避免各处各写一份默认路径） */
  libraryRoot: function () {
    return normalizeWinPath(App.settings.libraryRootPath) || defaultLibraryRootPath();   // 未填时推导自应用目录
  },

  /** 窄条件路径自愈 —— 仅当 ① 设置里填过该路径（留空 / 纯空白一律跳过，不猜不写不提示）且该目录不存在，
   *  且 ② <应用目录>\<名称> 确实存在 时，才改用推导值并回写设置。
   *  绝不覆盖用户已有的有效自定义路径；后端离线（无法判定）时一律不动。 */
  healDerivedPaths: function () {
    try {
      if (typeof FS === 'undefined' || !FS.host || typeof FS.hostEnsure !== 'function' || typeof FS.host.exists !== 'function') return Promise.resolve(false);
      var targets = [
        { key: 'libraryRootPath', derived: defaultLibraryRootPath(), label: '素材库目录' }
      ];
      var healedLib = '';
      return FS.hostEnsure().then(function (ok) {
        if (!ok) return false;                                  // 后端离线 ⇒ 无法判定 ⇒ 不动
        var changed = [];
        var chain = Promise.resolve();
        targets.forEach(function (t) {
          chain = chain.then(function () {
            var cur = normalizeWinPath(App.settings[t.key] || '');
            var der = normalizeWinPath(t.derived || '');
            if (!der || cur === der) return null;
            /* 留空 / 纯空白一律跳过 —— 不猜、不写设置、不提示。
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

  /* ---------------- 缩略图 ----------------
   * 网格用 covers\thumb\<id>.jpg（400px），详情页仍用原图。
   * 缩略图按需生成：首次渲染该素材时 404 → 自动退回原图并补生成一次，下次就命中。
   * 这样启动不必解码上千张图，也不会改动任何既有数据结构。 */
  _thumbMissing: {},
  _thumbTried: {},
  thumbDir: function () {
    var d = App.localDir || (Store.local && Store.local.dataDir ? Store.local.dataDir(App.settings) : '');
    return d ? joinWinPath(d, ['covers', 'thumb']) : '';
  },
  thumbURLFor: function (asset) {
    if (!asset || !asset.id || !asset.hasCover) return '';
    if (!(FS.host && FS.host.bytesSupported && FS.host.bytesSupported())) return '';
    if (App._thumbMissing[asset.id]) return '';
    var dir = App.thumbDir();
    if (!dir) return '';
    return 'http://vrcasset.localhost/' + encodeURIComponent(joinWinPath(dir, [asset.id + '.jpg']));
  },
  /** 原图在磁盘上的路径（covers\<id>.<ext>），找不到返回 '' */
  coverPathOnDisk: function (id) {
    var dir = (App.localDir || (Store.local && Store.local.dataDir ? Store.local.dataDir(App.settings) : ''));
    if (!dir || !id) return Promise.resolve('');
    var chain = Promise.resolve('');
    ['png', 'jpg', 'webp', 'gif'].forEach(function (e) {
      chain = chain.then(function (hit) {
        if (hit) return hit;
        var p = joinWinPath(dir, ['covers', id + '.' + e]);
        return FS.host.exists(p).then(function (k) { return k === 'file' ? p : ''; }).catch(function () { return ''; });
      });
    });
    return chain;
  },
  /** 生成该素材的缩略图（每次会话只尝试一次） */
  /* 缩略图生成排队执行，一次只跑一张：渲染时并发生成整页缩略图会把解码与落盘压在主线程上，
   * 界面直接「未响应」。 */
  _thumbQueue: [],
  _thumbRunning: false,
  _pumpThumbQueue: function () {
    if (App._thumbRunning) return;
    var next = App._thumbQueue.shift();
    if (!next) return;
    App._thumbRunning = true;
    next().then(function () { App._thumbRunning = false; setTimeout(App._pumpThumbQueue, 60); },
                 function () { App._thumbRunning = false; setTimeout(App._pumpThumbQueue, 60); });
  },
  requestThumb: function (asset) {
    if (!asset || !asset.id || !asset.hasCover) return Promise.resolve(false);
    if (!(FS.host && FS.host.thumb)) return Promise.resolve(false);
    if (App._thumbTried[asset.id]) return Promise.resolve(false);
    App._thumbTried[asset.id] = true;
    var self = App;
    var job = function () { return self._thumbOnce(asset); };
    self._thumbQueue.push(job);
    setTimeout(App._pumpThumbQueue, 120);
    return Promise.resolve(true);
  },
  _thumbOnce: function (asset) {
    if (!asset || !asset.id || !asset.hasCover) return Promise.resolve(false);
    if (!(FS.host && FS.host.thumb)) return Promise.resolve(false);
    var dstDir = App.thumbDir();
    if (!dstDir) return Promise.resolve(false);
    return App.coverPathOnDisk(asset.id).then(function (src) {
      if (!src) return false;
      var dst = joinWinPath(dstDir, [asset.id + '.jpg']);
      return FS.host.thumb(src, dst, App.settings.thumbWidth || 400)
        .then(function () { delete App._thumbMissing[asset.id]; return true; })
        .catch(function () { return false; });
    }).catch(function () { return false; });
  },

  /** 把一张图片设为封面（拖到卡片缩略图上补图时走这里）。
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

  /** 在素材本地存储路径下按「商品ID」找封面图（.png 优先），命中返回 {path,name,ext,mime}，否则 '' */
  diskCoverFile: function (asset) {
    var itemId = String((asset && asset.itemId) || '').trim();
    var all = ((asset && asset.paths) || []).map(function (p) { return p && p.path ? String(p.path).trim() : ''; }).filter(Boolean);
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

  /** 打开素材时若应用内还没有封面，就按商品ID 从本地路径认领一张（写进封面缓存，列表/详情都能看到） */
  adoptDiskCover: function (asset) {
    if (!asset || !asset.id) return Promise.resolve(null);
    var live = App.assets.find(function (x) { return x.id === asset.id; }) || asset;
    if (live.hasCover || live.coverURL || live.coverCleared) return Promise.resolve(null);   // 用户主动清除过就不再自动认领
    return App.diskCoverFile(live).then(function (f) {
      if (!f) return null;
      var read = (FS.host.bytesSupported && FS.host.bytesSupported())
        ? FS.host.readBytes(f.path).then(function (bytes) { return new Blob([bytes], { type: f.mime }); })
        : FS.host.readFileBase64(f.path).then(function (j) {
            var b64 = (j && (j.dataBase64 || j.base64 || j.data)) || '';
            if (!b64) return null;
            return fetch('data:' + f.mime + ';base64,' + b64).then(function (r) { return r.blob(); });
          });
      return read.then(function (blob) {
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

  /** 把某条素材的封面补写到磁盘 —— vrclib-data\covers\<id>.<ext> 与素材文件夹 <文件夹名>.png 两处，
   *  缺哪补哪；两侧都在就整条跳过（不动盘、不联网）。
   *  opts: quiet 静默 / allowFetch 允许联网补抓 / createFolder 允许新建素材文件夹
   *  返回 { covers, folder, fetched } */
  ensureCoverOnDisk: function (asset, opts) {
    opts = opts || {};
    var res = { covers: 'skip', folder: 'skip', fetched: false };
    if (!asset || !asset.id) return Promise.resolve(res);
    /* 门槛不能只是 !asset.hasCover：有有效 coverURL 却没有封面文件的素材会永远不补写。
     * 放宽为：hasCover=true 照旧；hasCover=false 时须同时满足 allowFetch、未主动清除封面、
     * coverURL 有效、且没关掉自动抓封面 —— 四条不满足就原样 skip（不发请求、不写盘）。 */
    var canFetch = !!opts.allowFetch && !asset.coverCleared
      && /^https?:\/\//i.test(String(asset.coverURL || ''))
      && App.settings.autoFetchCover !== false;
    if (!asset.hasCover && !canFetch) return Promise.resolve(res);
    if (!App.localDir || App.localReadOnly) { res.covers = res.folder = 'offline'; return Promise.resolve(res); }
    return Store.getCover(asset.id).then(function (rec) {
      if (rec && rec.blob) return rec.blob;
      if (!opts.allowFetch) return null;
      if (asset.coverCleared) return null;                       // 主动清除过 → 不抓（hasCover=true 也守住）
      if (App.settings.autoFetchCover === false) return null;    // 设置里关了自动抓封面 → 不抓
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
  /** 封面写进素材文件夹（<文件夹名>.png）。
   *  quiet:true 静默；create:false 时不为没有存储路径的素材新建文件夹；
   *  目标文件已存在就直接跳过（详情页每次打开都补写，不能重复转换与重复写盘）。 */
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
      if (!folderPath) { warnHtml('未能创建素材存储路径，封面没写进素材文件夹（检查后端与素材库根目录）', 5600); return null; }
      var name = App.folderName(asset) + '.png';
      var dst = joinWinPath(folderPath, [name]);
      return FS.host.exists(dst).then(function (kind) {
        if (kind === 'file') return { path: dst, name: name, skipped: true };
        return toPngBlob(blob).then(function (png) {
          return FS.writeFileToPath(dst, png).then(function (ok) {
            if (ok) { if (!quiet) Toast.ok('封面已写入素材文件夹：' + name, 3600); }
            else warnHtml('封面写入素材文件夹失败（后端是否在线？）');
            return ok ? { path: dst, name: name } : null;
          });
        });
      });
    }).catch(function (e) { warnHtml('封面写入素材文件夹失败：' + ((e && e.message) || e)); return null; });
  },

  /** 按下载队列的真实状态刷新页面上的下载按钮（排队中 / 下载中 xx% / 已下载） */
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
        // 下完的文件按钮变浅红「重新下载」，方便重下
        // 浅红类必须加在按钮上：加到 span 上会变成蓝底按钮配「↻ 重新下载」文案
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

  /* ---------------- 图集本地化缓存（按商品 ID 落盘 PNG） ---------------- */
  galleryDirCache: Object.create(null),
  galleryItemId: function (asset) {
    var id = String((asset && asset.itemId) || '').trim();
    return id || String((asset && asset.id) || '').trim();
  },
  galleryPrefix: function (i) { var n = String((i || 0) + 1); return (n.length < 2 ? '0' + n : n) + '_'; },   // 位置式命名，仅用于兼容读取
  /* 缓存文件名按图片 URL 生成，不按位置：位置式命名在图集去重 / 新增 / 删除后会整体错位，
   * 同一序号指向另一张图，于是把 A 图的缓存当成 B 图显示。 */
  /** 原图名清洗（cap = 截断长度：现用 40，兼容读取用 60） */
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
  /** 在磁盘文件列表里定位某个 URL 的缓存：先按 URL 哈希命名；位置式命名只有在原图名一致时才算命中，
   *  并且按生成时同一口径（60 字 / 40 字截断）精确重建再比，绝不张冠李戴。 */
  galleryFindCached: function (files, url, i) {
    var want = App.galleryCacheName(url);
    var list = files || [];
    for (var k = 0; k < list.length; k++) { if (String(list[k] && list[k].name || '') === want) return want; }
    var pre = App.galleryPrefix(i);
    var legacyBase = App.galleryBase(url, 60);       // 位置式命名的 60 字口径
    var wantBase = App.galleryBase(url, 40);         // 兼容 40 字口径
    for (var j = 0; j < list.length; j++) {
      var n = String(list[j] && list[j].name || '');
      if (n.indexOf(pre) !== 0) continue;
      var got = n.slice(pre.length).replace(/\.png$/i, '');
      if (got === legacyBase || got === wantBase) return n;
    }
    return '';
  },
  /** 缓存文件名（保留原签名）：只由 URL 决定，与位置无关 */
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
    var url = ((asset && asset.images) || [])[i];   // 按这一格当前的 URL 找缓存，而不是按序号
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
  /** 一张 README 图要落的最终路径（原图先落这里，转成 PNG 后再覆盖回同一路径，不留临时目录） */
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

  /** 抓一张 README 图——优先程序后端下载（带浏览器 UA，不受 CORS / 防盗链限制），失败退回浏览器直连。
   *  后端下载直接落在 dst（最终路径），读回后在调用方转 PNG 覆盖，因此不产生临时文件。 */
  ghFetchImage: function (url, dst) {
    var u = String(url || '').trim();
    if (!u) return Promise.resolve(null);
    var p = String(dst || '');
    return FS.hostEnsure().then(function (hostOk) {
      if (!hostOk || !p) return null;
      return FS.host.download(u, p, {}, '')
        .then(function (j) {
          if (!j || !(j.size > 64)) return null;      // 后端会拒绝把登录页 / 错误页存成文件
          if (FS.host.bytesSupported && FS.host.bytesSupported()) {
            return FS.host.readBytes(p).then(function (bytes) { return new Blob([bytes]); });
          }
          return FS.host.readFileBase64(p).then(function (r) {
            var b64 = (r && (r.dataBase64 || r.base64 || r.data)) || '';
            if (!b64) return null;
            // media type 只是给 toPngBlob 的提示（浏览器按内容嗅探，随后一律重编码成 PNG）
            return fetch('data:image/png;base64,' + b64).then(function (x) { return x.blob(); });
          });
        })
        .catch(function () { return null; });
    }).then(function (b) {
      if (b) return b;
      return Net.fetchBlob(u, {});                    // 后端不可用或下载失败 → 浏览器直连兜底
    }).catch(function () { return null; });
  },

  /** 封面立即落盘——IndexedDB + vrclib-data\\covers\\<id>.png + 素材文件夹 <商品ID_标题>.png */
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

  /** GitHub 素材抓取即把 README 图片下载到本地
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
      // 按图片 URL 找缓存：按序号回填的话，图集一变就整体错位（显示成别的图）
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
  /** 把浏览器里的图集缓存一次性搬到磁盘（转 PNG），搬完清空 IndexedDB 图集库 */
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

  /* ---------------- 模糊搜索（默认关闭） ----------------
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
    /* 索引对象上挂着缓存标记键 __src（存的是原始字典对象）：直接 idx[q] 在 q === '__src' 时会拿到
     * 那个对象，接着 .filter 就抛 TypeError；索引的键都是小写，查询前要先 toLowerCase。 */
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

  /** 磁盘对账——把存储目录里的真实文件与库里记录（downloadedFiles + 各版本 files）逐一比对。
   *  返回 Promise<{dir, error?, onDisk?, recorded?, missing?, extra?}>；error: no-path / no-host / offline / missing-dir */
  localFileAudit: function (a) {
    var dir = App.primaryLocalPath(a);
    if (!dir) return Promise.resolve({ dir: '', error: 'no-path' });
    if (!FS.host || typeof FS.host.scan !== 'function') return Promise.resolve({ dir: dir, error: 'no-host' });
    var recorded = uniq((a.downloadedFiles || []).map(String).concat(
      (a.versions || []).reduce(function (acc, v) {
        return acc.concat((v.files || []).map(function (f) { return String((f && f.name) || ''); }));
      }, [])
    )).filter(function (n) { return !!n; });
    /* 后端离线时不能直接判 'offline'：有浏览器库根句柄就用 FSA 枚举做权威对账。
     * 结果多带 via: 'host' | 'fsa'，调用方据此说明这次走的是哪条通道。 */
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
      /* 第二档：浏览器库根句柄（后端离线）；不可用才回落第三档 'offline' */
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
  /** 素材的主本地路径——优先 note=「存储路径」那条，其次第一条本地绝对路径；没有则返回 '' */
  primaryLocalPath: function (a) {
    var local = (a.paths || []).map(function (p) {
      return { path: (p && typeof p === 'object') ? String(p.path || '') : String(p || ''), note: (p && typeof p === 'object' && p.note) || '' };
    }).filter(function (p) {
      return p.path && isAbsoluteWinPath(p.path);
    });
    var hit = local.filter(function (p) { return p.note === '存储路径'; })[0] || local[0];
    return hit ? normalizeWinPath(hit.path) : '';
  },
  /* ---------------- 筛选 & 排序 ---------------- */
  /** 长按分类：把「除这一类以外」的分类全部选中（其余亮、它灰掉）；再长按一次回到只看它 */
  categorySoloToggle: function (id) {
    var all = App.allCategories().map(function (c) { return c.id; });
    var others = all.filter(function (x) { return x !== id; });
    var cur = App.filters.categories || [];
    var isExcept = others.length > 0 && cur.length === others.length &&
      others.every(function (x) { return cur.indexOf(x) >= 0; });
    App.filters.categories = isExcept ? [id] : others;
    App.page = 1;
    UI.renderAll();
    Toast.info(isExcept ? ('只看「' + App.categoryLabel(id) + '」')
      : ('已排除「' + App.categoryLabel(id) + '」，其余分类全选'), 2600);
  },
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
      /* 标签筛选三态：tags = 必须包含（AND）；tagsNot = 排除（命中任一即过滤掉），两者可同时生效。
       * 匹配口径沿用 App.displayTags，与侧栏 / 卡片 / 详情同源，不另起一套。 */
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
      /* 免费 / 付费筛选与卡片丝带共用 App.priceBucket：侧栏数字点进去必须一致 */
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
        /* 两条都没有价格时不能算 Infinity - Infinity = NaN：比较器返回 NaN 的排序结果由引擎决定，
         * 同一批素材每次顺序都可能不同；这里显式给空值相等的名次，并稳定排到末尾。 */
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

  /** 分页（pageSize=0 表示不分页） */
  /** 每页张数由 UI.fitGrid 量出「一屏能放几张」（rows × cols）后写入 fitPageSize；
   *  fitPageSize 为 0 时（还没量过、列表视图）用下面按卡片大小写的兜底值。 */
  fitPageSize: 0,
  pageSizeFor: function () {
    if (App.fitPageSize > 0) return App.fitPageSize;
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

  /* ---------------- 价格模型 ---------------- */
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
   *  币种为空时按调用方给的商店币种兜底；仍然为空就只显示数值 —— 绝不默认 CNY。 */
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
    /* 没有购买凭据的素材不显示价格、不参与价格排序、不计入花费统计：
     * 未购变体价之和既不是花费、也不代表它的价格（作者占位价会把合计推到天价）。
     * 变体各自的价格仍在详情页「版本与变体」里列出。 */
    if (!App.hasPurchaseProof(a)) return null;
    if (a.purchasePrice != null && isFinite(Number(a.purchasePrice))) {
      var v = Number(a.purchasePrice);
      return { text: App.priceText(v, a.purchaseCurrency), value: v, currency: a.purchaseCurrency || '', isFree: v === 0 };
    }
    var isBooth = a.source === 'booth' || (Array.isArray(a.sources) && a.sources.some(function (s) { return s && s.source === 'booth'; }));
    /* 没有手填购买价时按变体价现算：有已购变体就合计它们的变体价，否则取未购变体的当前价。 */
    /* 停售 ≠ 没买过：只有「停售且没有任何订单链接」的变体才不参与计价，
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
  /** 该变体是否标示「停售 / 售罄」（作者常拿占位价如 9,999,999 标它们）→ 不参与计价 */
  isDeadVariant: function (v) {
    return /販売停止|販売終了|贩售停止|停止销售|销售结束|已停售|売り切れ|売切|完売|品切れ|sold\s*out|discontinued|unavailable/i.test(String((v && v.name) || ''));
  },
  /** 是否有购买凭据 —— 手填购买价，或存在带订单链接的已购变体。
   *  没有凭据 = 没花过钱：不显示价格、不参与价格排序、不计入花费统计。 */
  hasPurchaseProof: function (a) {
    if (!a) return false;
    if (a.purchasePrice != null && isFinite(Number(a.purchasePrice))) return true;
    return (a.versions || []).some(function (v) { return v && v.orderUrl && String(v.orderUrl).trim(); });
  },
  /** 是否存在免费变体（special / 名字含 免费·無料·free / 价格为 0） */
  hasFreeVariant: function (a) {
    return ((a && a.versions) || []).some(function (v) {
      if (!v || typeof v !== 'object') return false;
      if (v.special) return true;
      if (/免费|無料|free/i.test(String(v.name || ''))) return true;
      var pd = derivePrice(String(v.price || ''));
      return pd.isFree === true || (pd.value != null && pd.value === 0);
    });
  },
  /** 「付费」只给确实有购买凭据的素材——没花过钱的素材不该被标成「付费」 */
  isPaidAsset: function (a) { return !!a && a.isFree === false && App.hasPurchaseProof(a); },
  /** 价格桶 —— 卡片丝带 / 价格筛选 / 侧栏计数共用同一条判据，避免「丝带说免费、点筛选却是付费」。
   *  · 'paid'：有购买凭据且非免费　· 'free'：isFree===true，或没有购买凭据但有免费变体　· ''：其余 */
  priceBucket: function (a) {
    if (!a) return '';
    if (App.isPaidAsset(a)) return 'paid';
    if (a.isFree === true) return 'free';
    if (!App.hasPurchaseProof(a) && App.hasFreeVariant(a)) return 'free';
    return '';
  },
  /** 商店来源的默认计价币种（BOOTH=JPY / Gumroad=USD）；未知返回 ''。
   *  用于「裸数字价」兜底 —— 绝不默认 CNY，否则 1680 日元会显示成「CNY 1,680」。 */
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
      /* 计数口径与筛选口径对齐：六个维度各自独立累加。
       * 用 else-if 把每条素材只归一类的话，「未购买」并不排除好友分享 / 获赠，
       * 侧栏数字点进去就会多出一截。 */
      if (unpurchased) s.price.unpurchased++;
      if (a.gifted) s.price.gift++;
      if (friend) s.price.share++;
      var plain = !friend && !a.gifted && !unpurchased;   // 免费/付费/未记录与筛选一致：排除分享、获赠、未购买
      var pBucketS = App.priceBucket(a);                  // 与丝带 / 筛选同一条判据
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
  /** 把标题栏配色同步给主进程：按解析后的主题取色（樱粉 / 天际蓝各有自己的窗口底色），
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
    /* 毛玻璃是独立开关；没有这个字段时按「开」处理（与 defaultSettings 一致） */
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
    /* 编号是身份，不能被空值抹掉：老调用点传进来的快照没带就沿用库里的，
     * 两边都没有才现生成（有 BOOTH 商品号的以商品号为准，见 Store.fileIdOf）。 */
    var incomingFileId = String(a.fileId || (old && old.fileId) || '').trim();
    if (!a.fileId && old && old.fileId) a.fileId = old.fileId;
    if (!a.fileId && !Store.boothIdOf(a)) a.fileId = Store.newFileId(App.fileIdTakenMap(a.id));
    /* 自带编号（拷来的记录、手改过盘上 json）可能和现有素材撞号：编号是身份，
     * 两条共用一个号会在导入判重时被当成同一份、互相覆盖，这里直接换个新号。
     * 已有记录不动 —— 它本来就在库里，启动时的 ensureFileIds 已经做过全表去重。 */
    if (!old && incomingFileId && !Store.boothIdOf(a)
      && Store.isFileIdTaken(incomingFileId, App.fileIdTakenMap(a.id))) {
      a.fileId = Store.newFileId(App.fileIdTakenMap(a.id));
    }

    /* 防止过期快照整条覆盖：卡片渲染时拿到的是当时的对象引用。若这期间后台异步改过这条素材
     * （adoptDiskCover 把 hasCover 置 true 并落库），用户随后点一下★收藏，保存的就是过期快照，
     * 封面标记被打回 false。判据：调用方对象的 updatedAt 更早，则这些界面不直接编辑、
     * 只由后台维护的字段以库里为准。 */
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
      /* 改名 / 改标题前先查重：别的素材已占用同一个文件夹名就拒绝，
       * 否则两条素材争同一个目录，写入互相覆盖。 */
      var wantFolder = App.folderName(a);
      var clash = App.assets.filter(function (x) {
        return x.id !== a.id && App.folderName(x).toLowerCase() === wantFolder.toLowerCase();
      })[0];
      if (clash) {
        return Promise.reject(new Error('已存在同名素材「' + (clash.title || clash.id) + '」，换个标题或角色名再保存'));
      }
      /* 段名取磁盘上的实际名字（存储路径末段）：导入后改过或翻译过标题的素材，
       * 按当前标题算出的名字与目录对不上，改名会失败、路径也更新不了。 */
      var realOld = '';
      var oldPath = App.primaryLocalPath(old);
      if (oldPath) realOld = oldPath.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '');
      var oldFolder = realOld || App.folderName(old);
      var newFolder = App.folderName(a);
      pre = FS.renameAssetFolder(oldFolder, newFolder, App.categoryLabel(a.category), old).then(function (renamed) {
        if (renamed) App.updatePathsForFolderName(a, oldFolder, newFolder);
      }).catch(function (e) {
        /* 改名尽力而为：失败也不能让保存卡住或整体失败 */
        if (typeof console !== 'undefined' && console.warn) console.warn('[rename] 跳过：' + ((e && e.message) || e));
        return false;
      });
    }
    return pre.then(function () { return Store.putAsset(a); }).then(function (saved) {
      App.scheduleFileSync('assets');
      var i = App.assets.findIndex(function (x) { return x.id === saved.id; });
      if (i >= 0) App.assets[i] = saved;
      /* 只有确实新增的素材才插进列表：无条件 unshift 时，
       * 改名保存（要复制整个文件夹、耗时几秒）期间被删掉的素材会在保存完成后又回来。 */
      else if (!existedBefore) App.assets.unshift(saved);
      return saved;
    });
  },
  /** 素材编号：好友导出/导入时用来判定「是不是同一份」 */
  fileIdOf: function (a) { return Store.fileIdOf(a); },

  /** 当前库里已占用的编号表，生成新编号时传给 Store.newFileId 避重。
   *  键统一大写：编号比较一律大小写不敏感，否则手改过小写的记录会漏查、发出重号。 */
  fileIdTakenMap: function (selfId) {
    var taken = Object.create(null);
    (App.assets || []).concat(App.trashed || []).forEach(function (x) {
      if (!x || (selfId && x.id === selfId)) return;
      var f = Store.fileIdKey(Store.fileIdOf(x));   // 生效编号（BOOTH 商品号优先）
      if (f) taken[f] = 1;
      var raw = Store.fileIdKey(x.fileId);          // 记录里另存的号也占位，删了商品链接也不会被抢
      if (raw) taken[raw] = 1;
    });
    return taken;
  },

  /** 删除只打标记：记录、封面、磁盘文件都留在原处，48 小时内可撤回、可彻底删 */
  remove: function (id) {
    var asset = App.assets.filter(function (x) { return x.id === id; })[0] || null;
    var mark = asset
      ? Store.trashMark(asset).then(function (marked) {
          asset.trashAt = marked.trashAt;
          App.trashed.unshift(asset);
        }).catch(function (e) {
          if (window.console) console.warn('[trash] 标记失败：' + ((e && e.message) || e));
        })
      : Promise.resolve();
    return mark.then(function () {
      App.dropCover(id);
      App.assets = App.assets.filter(function (x) { return x.id !== id; });
      App.persistNow();
      App.refreshTrashUI();     // 回收站页开着的时候删除，列表和按钮状态要跟着变
      return asset;
    });
  },

  /** 从回收站恢复若干条：撤回提示与回收站页的「恢复」共用这一条路径 */
  restoreDeleted: function (ids) {
    var want = (ids || []).slice();
    if (!want.length) return Promise.resolve(0);
    return Store.trashRestoreMany(want).then(function (back) {
      if (!back.length) return 0;
      back.forEach(function (a) {
        App.trashed = App.trashed.filter(function (x) { return x.id !== a.id; });
        if (!App.assets.some(function (x) { return x.id === a.id; })) App.assets.unshift(a);
      });
      App.persistNow();
      UI.renderAll();
      App.refreshTrashUI();
      return back.length;
    });
  },

  /** 删除 / 撤回这类一次性动作直接落盘：只等防抖的话，紧接着重启会把状态回退 */
  persistNow: function () {
    App.scheduleFileSync('assets');
    try { return App.flushFileSync(); } catch (e) { return Promise.resolve(false); }
  },

  /** 回收站页面的数据源；页面没打开时什么都不做 */
  refreshTrashUI: function () {
    if (window.TrashUI && typeof TrashUI.refresh === 'function') TrashUI.refresh();
  },

  /**
   * 定期清理过期记录：只扫带标记的，内部分批（每批 20 条），批间让出主线程。
   * 启动后先跑一次，之后每 30 分钟一次；清理期间不重入。
   */
  startTrashSweep: function () {
    if (App._trashTimer) return;
    var run = function () {
      if (App._trashBusy || App.localReadOnly) return;
      App._trashBusy = true;
      Store.trashPurge().then(function (n) {
        App._trashBusy = false;
        if (!n) return;
        /* 内存里的清单得跟着掉，否则下一次写盘会把删掉的记录又写回文件 */
        return Store.trashList().then(function (list) {
          App.trashed = list;
          App.scheduleFileSync('assets');
          App.refreshTrashUI();
        });
      }).catch(function (e) {
        App._trashBusy = false;
        if (window.console) console.warn('[trash] 清理失败：' + ((e && e.message) || e));
      });
    };
    setTimeout(run, 8000);
    App._trashTimer = setInterval(run, 30 * 60 * 1000);
  },

  /** 删除后的 10 秒撤回提示；错过就只能在左侧「回收站」里找回（48 小时内） */
  deletedToast: function (list) {
    var items = (list || []).filter(Boolean);
    if (!items.length) return null;
    var one = items.length === 1;
    var title = items[0] && (items[0].title || items[0].originalTitle || '（未命名）');
    var msg = one ? ('已删除「' + title + '」\n是否撤回操作？') : ('已删除 ' + items.length + ' 项素材\n是否撤回操作？');
    var ids = items.map(function (a) { return a.id; });
    return Toast.undo(msg, {
      ms: 10000,
      actionText: '撤回',
      onAction: function () {
        return App.restoreDeleted(ids).then(function (n) {
          if (n) Toast.ok(n === 1 ? '已恢复该素材' : ('已恢复 ' + n + ' 项素材'));
          else Toast.warn('回收站里找不到这条了，可能已经过期');
        });
      }
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


/*
 * 渲染层
 */
var UI = {

  /* renderAll / renderMain / renderGrid 支持可选的分步渲染：
   * 传 opts = { progressive:true, firstChunk, budgetMs, onFirstPaint, onDone } 时先同步渲出首批卡片，
   * 其余按时间片分帧续渲；不传 opts 就是一次性同步渲染，其它调用点不受影响。 */
  renderAll: function (opts) {
    UI.renderSidebar();
    UI.renderMain(opts);
  },

  /** 视图指纹：翻页 / 排序 / 视图模式 / 卡尺 / 每页数量 / 筛选 / 搜索任一变化
   *  才算「换了一批内容」，才值得播卡片入场动画。只是某条素材被改（收藏、标签、评分、
   *  隐藏…）时指纹不变 —— 这时重绘必须静默。 */
  viewKey: function () {
    return [App.page, App.settings.sort, App.settings.view, App.settings.cardSize,
            App.settings.pageSize].join('\u0001');
  },

  /** 卡片复用用的全局指纹：这些设置任一变化都可能改掉每张卡的外观（自定义图标 / 分类 / 角色改名…），
   *  那时整页重建。选中态和「当前素材」属于单卡，放在 cardSig 里 —— 否则拖框连选时
   *  每勾一张都会把全页指纹一起改掉，等于又回到整页重建。 */
  cardGlobalKey: function () {
    var s = App.settings || {};
    return [
      App.selectMode ? 1 : 0,
      s.view || '', s.cardSize || '',
      s.tagTranslationEnabled === false ? 0 : 1,
      /* 筛选不进全局指纹：受它影响的只有卡片上几个 chip 的高亮与 title，
       * 由 UI.syncCardFilterState 就地改 class 即可。留在指纹里会让点一个标签 chip
       * 就重建本页每张卡（新 <img> = 每张一次请求 + 解码，外加整屏重绘）。 */
      JSON.stringify(s.customIcons || {}),
      JSON.stringify(s.customCategories || []),
      JSON.stringify(s.customSources || []),
      JSON.stringify(s.customAvatars || []),
      JSON.stringify(s.avatarOverrides || {})
    ].join('\u0001');
  },
  /** 单张卡的内容指纹：素材整份 JSON（不挑字段 —— 漏一个字段就是一张永远不更新的过期卡），
   *  外加只影响这一张卡的选中态 / 当前素材。 */
  cardSig: function (a, gkey) {
    return (gkey || UI.cardGlobalKey()) + '\u0002' +
      (App.selectMode && App.selection[a.id] ? 1 : 0) +
      (App.activeAssetId === a.id ? 1 : 0) + '\u0002' +
      JSON.stringify(a);
  },

  /* ---------------- 筛选态就地同步 ----------------
   * 筛选若进全局指纹，点一个标签 chip 就让本页每张卡失效重建（新 <img> = 一次请求 + 解码 + 整屏重绘）。
   * 实际上筛选只影响卡片上几个 chip 的高亮与 title，改 class 就够。
   * 下面几个 title 小函数是唯一出处，UI.card 与 syncCardFilterState 共用，避免两处文案漂移。 */
  catChipTitle: function (a, on) {
    return '分类：' + App.categoryLabel(a.category) + (on ? '（已筛选，再点取消）' : '（点击只看此分类）');
  },
  srcChipTitle: function (a, on) {
    return '来源：' + App.sourceEntries(a).map(function (s) {
      return (s.source === 'other' && s.sourceCustom) ? s.sourceCustom : App.sourceLabel({ source: s.source, sourceCustom: s.sourceCustom });
    }).join('、') + (on ? '（已筛选，再点取消）' : '（点击只看此来源）');
  },
  avChipTitle: function (v, on) {
    return '角色：' + App.avatarLabel(v) + (on ? '（已筛选，再点取消）' : '（点击只看此角色）');
  },
  ossRibbonTitle: function () {
    return '开源素材（GitHub 仓库）' + (App.filters.sources.indexOf('github') >= 0 ? '，已只看 GitHub 来源，再点取消' : '，点击只看 GitHub 来源');
  },

  /** 把筛选变化同步到已经存在的卡片节点上：不重建节点、不重新请求封面、不重播动画。 */
  syncCardFilterState: function (card, a) {
    if (!card || !a || !card.querySelector) return;
    var f = App.filters || {};
    var cats = f.categories || [], srcs = f.sources || [], avs = f.avatars || [];

    var catOn = cats.indexOf(a.category) >= 0;
    var badge = card.querySelector('.cat-badge');
    if (badge) { badge.classList.toggle('cat-badge-on', catOn); badge.title = UI.catChipTitle(a, catOn); }
    var chipCat = card.querySelector('.chip-cat');
    if (chipCat) { chipCat.classList.toggle('chip-on', catOn); chipCat.title = UI.catChipTitle(a, catOn); }

    var chipSrc = card.querySelector('.chip-source');
    if (chipSrc) {
      var primary = App.primarySource(a);
      var srcOn = srcs.indexOf(primary.source) >= 0;
      chipSrc.classList.toggle('chip-on', srcOn);
      /* 与 UI.card 一致：已筛选时不挂来源色，让 .chip-on 的主色描边显出来 */
      chipSrc.style.borderColor = srcOn ? '' : App.sourceColor(primary.source);
      chipSrc.title = UI.srcChipTitle(a, srcOn);
    }

    var oss = card.querySelector('.ribbon-oss');
    if (oss) oss.title = UI.ossRibbonTitle();

    Array.prototype.forEach.call(card.querySelectorAll('.chip-av[data-fv]'), function (n) {
      var v = n.getAttribute('data-fv');
      var on = avs.indexOf(v) >= 0;
      n.classList.toggle('chip-on', on);
      n.title = UI.avChipTitle(v, on);
    });

    Array.prototype.forEach.call(card.querySelectorAll('.tag[data-fv]'), function (n) {
      var t = n.getAttribute('data-fv');
      var st = UI.tagFilterState(t);
      n.classList.remove('tag-on', 'tag-out');
      var cls = UI.tagFilterClass(st);          // ' tag-on' | ' tag-out' | ''
      if (cls) n.className += cls;              // 只追加，保住 tag-untrans 等其它类
      n.title = UI.cardTagTitle(t, st);
    });
  },

  /** 把某张卡片标成「当前素材」（蓝色边框 + 外扩光晕，没有多选那样的勾选标记）——
   *  常驻而不是闪一下：刷新 / 重渲染之后仍看得出刚才打开或改的是哪一个。 */
  /** 只重画这一张卡，不动整页、不重置滚动、不重播入场动画。
   *  返回 false = 这张卡当前不在屏幕上，交给调用方决定要不要整体刷新。 */
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
    fresh.__sig = UI.cardSig(asset);   // 与 renderGrid 共用同一套复用判据，否则下次重绘会把这张卡白重建一次
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

  /* 搜索 / 排序 / 视图切换 / 侧栏筛选 → 瞬间回顶部，不做平滑动画。
   * 滚动读写统一走下面这几个封装：换滚动载体只改 scrollEl() 一处。 */
  scrollEl: function () {
    /* 滚动发生在卡片区（.main）内部。顶栏在文档流第一行、页签栏与侧栏各占一列，
     * 三者都不动，所以不存在"内容滚到顶栏背后"的问题，也就不需要 z-index 去挡。 */
    return document.querySelector('.main') || null;
  },
  sY: function () {
    var el = UI.scrollEl();
    if (el) return el.scrollTop;
    /* 兜底必须真正读 window：写成自调用会无限递归报 RangeError */
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
  /** 内容区可见带的中心（定位用）—— 顶栏那段高度不属于内容区，不能直接用 window.innerHeight/2 */
  centerY: function () {
    var el = UI.scrollEl();
    /* 同上：兜底要读 window 视口中心，自调用会无限递归 */
    if (!el) return (typeof window !== 'undefined') ? Math.round(window.innerHeight / 2) : 0;
    var r = el.getBoundingClientRect();
    return Math.round(r.top + el.clientHeight / 2);
  },
  scrollTopInstant: function () { UI.scrollTo(0); },
  /** 卡片上的「只看这个」筛选做成开关：当前正好只筛了这一个值，再点就取消；
   *  否则切回「只看这一个」。分类 / 来源 / 角色都走这里，只动某一维筛选，不清掉其它条件。 */
  filterOnly: function (key, value) {
    var cur = Array.isArray(App.filters[key]) ? App.filters[key] : (App.filters[key] = []);
    var isOnly = cur.length === 1 && cur[0] === value;
    App.filters[key] = isOnly ? [] : [value];
    return !isOnly;
  },
  /** 卡片内发起的筛选（分类 / 来源 / 角色 / 标签 chip、分类角标、价格丝带）：
   *  不回顶部，而是从当前位置把这张卡定位到可见范围；跨页时自动切到它所在页；
   *  若这张卡被新筛选排除，则保持当前位置不动。 */
  filterFromCard: function (asset, mutate) {
    var id = asset && asset.id;
    var y = UI.sY();
    try { mutate(); } catch (e) {}
    App.page = 1;
    UI.renderAll();
    /* renderAll 会先清空网格 → 文档瞬间变矮 → 浏览器把 scrollY 夹到 0，
     * 于是「当前位置」丢失、还会被误判成「已经可见」；渲染后要立刻还原。 */
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
    /* 从当前位置开始滚，滚到目标卡出现为止（最小滚动，不居中、不跳顶）。
     * 顶部兜底只在元素始终不在 DOM / 无法进入视口时才用。 */
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
  /**
   * 保存 / 导入后保持视图稳定：卡片已在本页只做必要的滚动；不在本页时只在
   * 「当前筛选结果里仍包含它」时换页定位。绝不清空用户的筛选 / 搜索 ——
   * 找不到卡片就重置筛选，用户看到的是「刷新一下回到了开头、然后又滚回来」。
   */
  revealAsset: function (id) {
    var card = document.querySelector('.card[data-id="' + id + '"]');
    if (card) {
      var r = card.getBoundingClientRect();
      if (r.top >= 0 && r.bottom <= window.innerHeight) return;
      // 定位不做滚动动画——直接瞬间到位
      UI.scrollTo(Math.max(0, (UI.sY()) + r.top - UI.centerY() + Math.round(r.height / 2)));
      return;
    }
    var all = App.filtered();
    var idx = -1;
    for (var i = 0; i < all.length; i++) { if (all[i].id === id) { idx = i; break; } }
    if (idx < 0) return;                       // 被当前筛选排除 → 保持视图不动，不动筛选条件
    /* 不能读 App.settings.pageSize：每页张数由 pageSizeFor() 按卡片大小决定，
     * 两者不一致时「定位到某条素材」会跳到完全不相干的页。 */
    var target = Math.floor(idx / Math.max(1, App.pageSizeFor())) + 1;
    if (target !== (App.page || 1)) {
      // 换页后先回到上次的滚动位置，再挪到目标卡片：重渲染会把视图甩回页面顶部
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

    // 概览：总数 / 收藏 / 已关联路径
    root.appendChild(el('div', { class: 'side-stat' }, [
      el('div', { class: 'stat-item' }, [el('b', { text: String(st.total) }), el('span', { text: '素材总数' })]),
      el('div', { class: 'stat-item' }, [el('b', { text: String(st.favorite) }), el('span', { text: '喜欢' })]),
      el('div', { class: 'stat-item' }, [el('b', { text: String(st.withPath) }), el('span', { text: '已关联路径' })])
    ]));

    /* 状态：只有四项，做成和下面分组一样的 chip 行，不再用下拉。
     * 下拉会把另外三个状态藏起来，用户看不出还能按什么筛。
     * 四项都给计数，否则混排时有的带数字有的不带，看着像漏了。 */
    root.appendChild(UI.filterGroup('状态', STATUS_FILTERS.map(function (s) {
      var cnt = s.id === 'all' ? st.total
        : (s.id === 'favorite' ? st.favorite
          : (s.id === 'nopath' ? Math.max(0, st.total - st.withPath) : st.hidden));
      return { id: s.id, label: s.label, count: cnt, active: App.filters.status === s.id };
    }), function (id) {
      /* 只重画网格，不 renderAll：App.stats() 是全库统计、与筛选无关 */
      App.filters.status = id; App.page = 1; UI.renderMain();
    }, 'chips'));

    // 来源：与标签 / 分类一样以 chips 展示，按匹配数量降序
    root.appendChild(UI.filterGroup('来源', App.allSources().map(function (c) {
      return { id: c.id, label: c.label, iconKind: 'src', count: st.sources[c.id] || 0,
        active: App.filters.sources.indexOf(c.id) >= 0 };
    }).filter(function (x) { return x.count > 0 || x.active; })
      .sort(function (a, b) { return b.count - a.count; }), function (id) {
      UI.toggleArr(App.filters.sources, id); App.page = 1; UI.renderAll();
    }, 'chips'));

    // 分类（数量降序；“其他”固定最后）
    /* 分类始终列全：空分类也显示（显示计数 0），避免「明明有这一类却找不到」 */
    root.appendChild(UI.filterGroup('分类', App.allCategories().map(function (c) {
      return { id: c.id, label: c.label, iconKind: 'cat', count: st.categories[c.id] || 0,
        active: App.filters.categories.indexOf(c.id) >= 0, last: c.id === 'other' };
    })
      .sort(function (a, b) { return b.count - a.count; }), function (id) {
      UI.toggleArr(App.filters.categories, id); App.page = 1; UI.renderAll();
    }, 'chips', undefined, function (id) { App.categorySoloToggle(id); }));

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
        /* 侧栏标签也走三态：in 用 active（主色），out 用 tag-out（红色 + 删除线） */
        var tstate = UI.tagFilterState(t);
        return { id: t, label: t, count: st.tags[t], active: tstate === 'in', cls: tstate === 'out' ? 'tag-out' : '', state: tstate, title: UI.tagFilterTitle(t, tstate) };
      }));
    root.appendChild(UI.filterGroup('标签', tagItems, function (id) {
      if (id === '__r18__') { App.filters.r18 = !App.filters.r18; App.page = 1; UI.renderAll(); return; }
      if (id === '__delisted__') { App.filters.delisted = !App.filters.delisted; App.page = 1; UI.renderAll(); return; }
      if (id === '__wishlist__') { App.filters.wishlist = !App.filters.wishlist; App.page = 1; UI.renderAll(); return; }
      UI.cycleTagFilter(id);   // 默认 → 必须包含 → 排除 → 默认
    }, 'chips'));

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

  /* ---------------- 标签筛选三态 ----------------
   * 默认（none）→ 必须包含（in：App.filters.tags，AND）→ 排除（out：App.filters.tagsNot，命中任一即过滤）→ 默认。
   * 侧栏标签项 / 卡片标签 chip / 详情页标签 chip 三处统一走这里，避免三套行为漂移。 */
  tagFilterState: function (t) {
    if (!t) return 'none';
    if ((App.filters.tags || []).indexOf(t) >= 0) return 'in';
    if ((App.filters.tagsNot || []).indexOf(t) >= 0) return 'out';
    return 'none';
  },
  /** 状态 → 追加到 .tag 上的 class（in 用 tag-on；out 用 tag-out：红色 + 删除线） */
  tagFilterClass: function (state) {
    return state === 'in' ? ' tag-on' : (state === 'out' ? ' tag-out' : '');
  },
  tagFilterTitle: function (t, state) {
    var now = state === 'in' ? '必须包含' : (state === 'out' ? '排除' : '不筛选');
    return '标签：' + t + '（当前：' + now + '）—— 点击：默认 → 必须包含 → 排除 → 取消';
  },
  /** 卡片上的标签是两态：没筛 → 加入筛选；已筛或已排除 → 取消。
   *  三态循环只保留给侧栏列表与详情页，卡片上连点两下就是「开 → 关」。 */
  cardTagTitle: function (t, state) {
    var now = state === 'in' ? '已筛选' : (state === 'out' ? '已排除' : '未筛选');
    return '标签：' + t + '（当前：' + now + '）—— 点击筛选，再点一次取消';
  },
  toggleTagFilter: function (t, opts) {
    opts = opts || {};
    if (typeof t !== 'string' || !t) return 'none';
    if (!Array.isArray(App.filters.tags)) App.filters.tags = [];
    if (!Array.isArray(App.filters.tagsNot)) App.filters.tagsNot = [];
    var state = UI.tagFilterState(t);
    if (state === 'in') {
      var i = App.filters.tags.indexOf(t);
      if (i >= 0) App.filters.tags.splice(i, 1);
    } else if (state === 'out') {
      var j = App.filters.tagsNot.indexOf(t);
      if (j >= 0) App.filters.tagsNot.splice(j, 1);
    } else {
      App.filters.tags.push(t);
    }
    if (opts.render !== false) { App.page = 1; UI.renderAll(); }
    return UI.tagFilterState(t);
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

  filterGroup: function (title, items, onPick, style, limit, onLongPress) {
    /* 折叠状态跨渲染保留：放在局部变量里的话，每次重建都从展开开始，
     * 用户折好分组、滚下去点一项，回来发现自己又被展开了。 */
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
        var chip = el('button', {
          class: 'side-item' + (it.active ? ' active' : '') + (it.cls ? ' ' + it.cls : '') + (it.disabled ? ' dim' : ''),
          title: it.disabled ? (it.label + '（已选「通用/多角色」，该角色不参与筛选）') : (it.title || it.label),
          disabled: !!it.disabled,
          /* 侧栏发起的筛选一律瞬间回顶部；卡片内发起的走 UI.filterFromCard（定位、不回顶） */
          onclick: function () {
            if (chip._lpFired) { chip._lpFired = false; return; }   // 长按后抬手不当作普通点击
            onPick(it.id); UI.scrollTopInstant();
          }
        }, [
          it.iconKind ? App.icon(it.iconKind, it.id, { size: 14, class: 'side-ico' }) : null,
          el('span', { class: 'side-item-label', text: it.label }),
          it.count == null ? null : el('span', { class: 'side-item-count', text: String(it.count) })
        ]);
        if (onLongPress) {
          var lpTimer = 0;
          var cancelLp = function () { if (lpTimer) { clearTimeout(lpTimer); lpTimer = 0; } };
          chip.addEventListener('pointerdown', function () {
            cancelLp();
            lpTimer = setTimeout(function () {
              lpTimer = 0;
              chip._lpFired = true;
              onLongPress(it.id);
            }, 520);
          });
          ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) {
            chip.addEventListener(ev, cancelLp);
          });
        }
        body.appendChild(chip);
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
  /** 当前排序的短标签（按钮文字用） */
  sortLabel: function () {
    var list = (typeof SORTS !== 'undefined' && SORTS) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === App.settings.sort) return list[i].label;
    return '默认排序';
  },
  syncSortButton: function () {
    var b = $('#btnSort');
    if (b) { b.textContent = UI.sortLabel(); b.title = '排序方式：' + UI.sortLabel() + '（点一下换下一种）'; }
  },

  /* ---------------- 一屏容量 ----------------
   * 目标：每页尽量铺满一屏，不用滚动就能看全，分页条落在页面底部。
   *
   * 做法：画完这一页后**逐张**量「这张卡的下沿落在哪」。完整落在可视区里的都留下，
   * 第一张探出可视区的卡以及它后面的卡一起翻到下一页 —— 按「张」切，不按「行」切。
   * 而且允许最后一排探出去一点（见下面的 TOL）：一屏只剩小半行时，为了那点像素
   * 把整排推到下一页，底部空得更多。真正「整排都在屏幕外」的才翻下去。
   *
   * 为什么不再按行估算：卡片内容多少不一，同一行会被最高的那张撑高，一屏常常剩
   * 大半行的高度；整行丢到下一页，底部就空一大片（用户原话「卡片没塞满」）。
   * 按实测位置切之后，那点余量能再放一排就再放一排。
   *
   * 反方向也要能长回来：窗口拉高 / 列数变多 / 卡片变小之后，旧张数会明显少于一屏，
   * 所以「一页画满且全都放得下」时按实测行高再补整数行 —— 这一段是估算，
   * 多补了下一帧量出来会自己收回去（收敛，不会来回抖）。 */
  fitGrid: function (grid, pi) {
    if (!grid || !pi || UI._fitBusy) return;
    /* 列表视图一行就 92px，一屏能放六七条，翻页比滚动更烦 —— 维持原来的分页方式 */
    if (App.settings.view === 'list') { App.fitPageSize = 0; return; }
    var cards = grid.children;
    if (!cards.length) return;
    var main = document.querySelector('.main');
    if (!main) return;

    var cs = getComputedStyle(grid);
    var gap = parseFloat(cs.rowGap || cs.gap || '14') || 14;
    var cols = (cs.gridTemplateColumns || '').split(' ').filter(function (x) { return x && x !== 'none'; }).length || 1;

    var size = Math.max(1, Number(pi.size) || 0);
    var total = (pi.all || []).length;
    var shown = cards.length;                 // 这一页实际画出来几张

    var ms = getComputedStyle(main);
    var borderT = parseFloat(ms.borderTopWidth) || 0;
    var mrect = main.getBoundingClientRect();
    var scrolled = main.scrollTop;
    /* 卡片下沿换算成「滚动内容坐标」（从 padding 盒顶算）。用 rect 差 + scrollTop，
     * 与当前滚到哪无关 —— 否则页面滚一下，量出来的可用张数就变了。 */
    function bottomOf(node) {
      return node.getBoundingClientRect().bottom - mrect.top - borderT + scrolled;
    }
    var PAD_NOPAGER = 16, PAD_PAGER = 72;     // 与 styles.css 的 .main / body.has-pager .main 对齐
    /* 允许最后一行「探出」一点点：一屏只剩小半行时，为了那几十像素把整排卡推到下一页，
     * 底部反而空得更多。探出来的部分滚一下就看见了，再往下的行才翻页。
     * 上限取「1/3 行高」且不超过 56px —— 再多就变成每页都要滚一大截了。 */
    var rowProbe = 0;
    for (var p = 0; p < Math.min(shown, cols); p++) {
      var ph = cards[p].getBoundingClientRect().height;
      if (ph > rowProbe) rowProbe = ph;
    }
    var TOL = Math.round(Math.min(rowProbe * 0.35, 56)) || 0;
    /* 可视区下沿（同一套内容坐标）：clientHeight 含 padding，要把底部留白扣掉 */
    function fitCount(padB) {
      var limit = main.clientHeight - padB + TOL;   // +TOL：允许最后一排探出去一点
      var n = 0;
      for (var i = 0; i < shown; i++) {
        if (bottomOf(cards[i]) <= limit) n = i + 1;
        else break;                            // 网格按 DOM 顺序排，后面只会更低
      }
      return n;
    }
    /* 要不要给分页条留位置，取决于「不留时够不够装下全部」；两个都量，
     * 判定用不留位置的容量，这样不会出现「加了分页条→少一张→又不加分页条」的来回横跳。 */
    var nNoPager = fitCount(PAD_NOPAGER);
    var single = total <= nNoPager;
    var pb = single ? PAD_NOPAGER : PAD_PAGER;
    var fit = single ? nNoPager : fitCount(PAD_PAGER);
    var cap;

    if (shown < size) {
      /* 这一页没画满（最后一页）：放得下就什么都别改 —— 拿不满的一页去量容量，
       * 量出来的永远等于「已经画出来的张数」，会把每页张数越算越小。
       * 只有真的溢出了才收一下（例：首帧按兜底 24 张画，而一屏只放得下 16 张）。 */
      if (fit >= shown) return;
      cap = fit;
    } else {
      cap = fit;
      /* 这一页画满了、而且全都放得下 —— 说明还有余量，往回收一点空间： */
      if (cap === shown) {
        /* 1) 最后一行没排满：同一排的卡不额外占高度，补满它几乎不花空间 */
        var rest = shown % cols;
        if (rest) cap += cols - rest;
        /* 2) 下面还够一整行（含行距）才继续加，半个行高不加，免得来回抖 */
        var rowH = 0;
        for (var k = Math.max(0, shown - cols); k < shown; k++) {
          var h = cards[k].getBoundingClientRect().height;
          if (h > rowH) rowH = h;
        }
        if (rowH > 0) {
          var spare = (main.clientHeight - pb + TOL) - bottomOf(cards[shown - 1]);
          var addRows = Math.floor((spare + gap) / (rowH + gap));
          if (addRows > 0) cap += addRows * cols;
        }
      }
    }
    /* 再挤也得留一整行：比一行还少就没法看了（窗口高度小于一行时才会到这） */
    size = Math.max(cols, cap);
    if (size === App.fitPageSize) return;

    /* 换每页张数时保住当前看的位置，而不是甩回第一页 */
    var offset = ((pi.page || 1) - 1) * (pi.size || size);
    App.fitPageSize = size;
    UI._fitBusy = true;
    requestAnimationFrame(function () {
      UI._fitBusy = false;
      App.page = Math.floor(offset / size) + 1;
      UI.renderAll();
    });
  },

  /** 分页条要居中在「卡片区」里，而不是整个窗口：左边还有页签栏和侧栏，
   *  写死 left:50% 会明显偏左。把 .main 的中心写进 --pager-x（fixed 只能用视口坐标）。 */
  syncPagerX: function () {
    var main = document.querySelector('.main');
    if (!main) return;
    var r = main.getBoundingClientRect();
    if (!r.width) return;
    document.documentElement.style.setProperty('--pager-x', Math.round(r.left + r.width / 2) + 'px');
  },

  /** 内容比视口高（会滚一点）时给 body 挂个类：分页条改成实心，
   *  否则半透明的胶囊压在半张卡上，卡片会从底下透出来，看着像渲染坏了。 */
  syncPagerOverflow: function () {
    var main = document.querySelector('.main');
    if (!main) return;
    document.body.classList.toggle('pager-overflow', main.scrollHeight - main.clientHeight > 2);
  },

  /** 只刷新多选计数（拖选 / 多选单击的热路径用，不跑全库 filter 与强制布局以外的任何东西） */
  syncBulkCount: function () {
    var c = $('#bulkCount');
    if (!c) return;
    var txt = String(App.selectedIds().length);
    if (c.textContent === txt) return;
    c.textContent = txt;
    c.classList.remove('bump');
    void c.offsetWidth;
    c.classList.add('bump');
  },

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
    UI.syncSortButton();
    var bar = $('#bulkBar');
    var dock = document.getElementById('fabDock');
    if (dock) dock.classList.toggle('show', App.selectMode);
    if (bar) {
      var ids = App.selectedIds();
      bar.classList.toggle('show', App.selectMode);
      var c = $('#bulkCount');
      if (c) {
        var txt = String(ids.length);
        /* 数字变了才播一下弹性动画：拖动连选时能看出「又多选了一个」 */
        if (c.textContent !== txt) {
          c.textContent = txt;
          c.classList.remove('bump');
          void c.offsetWidth;
          c.classList.add('bump');
        }
      }
    }
    var g = $('#grid');
    if (g) {
      g.classList.toggle('list-view', App.settings.view === 'list');
      g.setAttribute('data-size', App.settings.cardSize || 'm');
    }
    $$('.view-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.view === App.settings.view); });
  },

  /* ---------------- 卡片网格 ---------------- */
  /* 卡宽自适应交给 CSS（.grid 用 repeat(auto-fill, minmax(卡宽,1fr))），
     行内剩余空间由浏览器平摊，这里不算宽度、也不写 --card-w。 */
  /** 按当前宽度和卡片尺寸计算纵向分栏数量 */
  masonryColumnCount: function (width) {
    var cfg = { s: 164, m: 220, l: 290 };
    var colWidth = cfg[App.settings.cardSize] || 220;
    var gap = App.settings.cardSize === 's' ? 10 : (App.settings.cardSize === 'l' ? 18 : 14);
    width = width || (($('#grid') && $('#grid').clientWidth) || 0);
    if (!width || width <= colWidth) return 1;
    return Math.max(1, Math.floor((width + gap) / (colWidth + gap)));
  },

  /* 渲染代号：分帧续渲靠它判断自己是否已被新一轮渲染取代 */
  _renderSeq: 0,

  renderGrid: function (pi, opts) {
    var grid = $('#grid');
    if (!grid) { if (opts && opts.onDone) opts.onDone(); return; }
    var mySeq = ++UI._renderSeq;
    pi = pi || App.pageInfo();
    var list = pi.items;
    var isList = App.settings.view === 'list';
    grid.classList.toggle('list-view', isList);
    grid.setAttribute('data-size', App.settings.cardSize || 'm');
    /* 入场动画只在「换了一批内容」时播：若每次重绘都给每张卡重挂 cardIn，
     * 点一下 ★ 收藏或加个标签，整页卡片会集体消失再从 0 弹回来。
     * 数据变更类重绘（视图指纹没变）一律静默替换：不播动画、不动滚动位置。 */
    var vk = UI.viewKey();
    var animate = vk !== UI._lastViewKey;
    UI._lastViewKey = vk;
    UI.renderPager(pi);
    var empty = $('#emptyState');
    if (!list.length) {
      /* 空结果自己清场，不靠 grid.innerHTML='' */
      if (grid.replaceChildren) grid.replaceChildren(); else grid.textContent = '';
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

    /* 不自建分栏：列数交给 CSS grid 按「容器宽度 / 固定卡宽」算 ——
     * 收起侧栏就自动多排几列，卡片尺寸不变；同一行里最高的卡决定行高，其余撑满这一行。 */
    var doneCb = function () {
      UI.fitGrid(grid, pi);          // 画完才知道一行多高、一屏放得下几行
      UI.syncPagerOverflow();        // 内容比视口高时，分页条要改成实心（否则卡片从它底下透出来）
      if (opts && opts.onDone) opts.onDone();
    };
    /* 按 id 复用已有卡片节点，只重建内容真的变了的：每张新 <img> 都要重新走一次
     * vrcasset 请求与解码，整页重建还会让所有卡重播入场动画。
     * 指纹相同就把原节点搬回新位置（图片不重新解码、请求数为 0），只有新建的卡才播动画。 */
    var gkey = UI.cardGlobalKey();
    var existing = Object.create(null);
    for (var ci = 0; ci < grid.children.length; ci++) {
      var ce = grid.children[ci];
      if (ce && ce.dataset && ce.dataset.id) existing[ce.dataset.id] = ce;
    }
    var frag = document.createDocumentFragment();
    var animIdx = 0;
    function place(a) {
      var sig = UI.cardSig(a, gkey);
      var card = existing[a.id];
      var fresh = !(card && card.__sig === sig);
      if (fresh) card = UI.card(a);
      /* 复用的卡也要跟上筛选态（筛选不在全局指纹里，见 cardGlobalKey） */
      else UI.syncCardFilterState(card, a);
      card.__sig = sig;
      if (animate && fresh) {
        card.style.animation = '';
        card.style.animationDelay = (Math.min(animIdx, 6) * 12) + 'ms';
        animIdx++;
      } else {
        /* 静默：这卡本来就在屏上（或这次不是换批内容）→ 不要再淡入一次 */
        card.style.animation = 'none';
        card.style.animationDelay = '';
      }
      frag.appendChild(card);          // 复用节点会被「搬」进 fragment，DOM 里的图片缓存不受影响
    }
    var firstFlush = true;
    function flush() {
      /* replaceChildren 一次换完：顺序、增删都对，且复用的节点只是被移动，不会重新加载图片 */
      if (firstFlush && grid.replaceChildren) grid.replaceChildren(frag);
      else grid.appendChild(frag);
      firstFlush = false;
      frag = document.createDocumentFragment();
    }
    if (!opts || !opts.progressive) {
      for (var k = 0; k < list.length; k++) place(list[k]);
      flush();
      doneCb();
      return;
    }
    /* 分步渲染：首批同步入 DOM，其余按 budgetMs 时间片分帧续渲；最终顺序与一次性渲染一致。 */
    var firstChunk = Math.max(1, opts.firstChunk || 24);
    var budget = opts.budgetMs || 12;
    var at = 0;
    for (; at < list.length && at < firstChunk; at++) place(list[at]);
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
        if (mySeq !== UI._renderSeq) return;   // 已被新一轮渲染取代，立刻停手
        var t0 = nowMs();
        while (at < list.length && nowMs() - t0 < budget) { place(list[at]); at++; }
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
    UI.syncPagerX();                       // 居中在卡片区（侧栏收放后要重算）
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

  /** 标题开头的 [xxx] 当成一个整体（不拆行），避免出现「用)]IconGenerator」这种半截孤行。
   *  只在括号组不超过 14 个字时启用 —— 再长就放任它按需断行，免得撑出卡片。 */
  cardTitleChildren: function (text) {
    var s = String(text || '');
    var m = /^(\[[^\[\]]{1,14}\])/.exec(s);
    if (!m || m[1].length >= s.length) return s;
    return [el('span', { class: 'tt-prefix' }, m[1]), '\u200B', s.slice(m[1].length)];
  },

  /** 就地切换一张卡的多选勾（拖选与多选单击共用，不重绘整页） */
  markCard: function (card, on) {
    if (!card) return;
    card.classList.toggle('selected', on);
    var mark = card.querySelector('.sel-mark');
    if (!mark) {
      mark = document.createElement('div');
      mark.className = 'sel-mark';
      card.appendChild(mark);
    }
    mark.classList.toggle('on', on);
    mark.textContent = on ? '\u2714' : '';
  },

  card: function (a) {
    var selected = !!App.selection[a.id];
    /* 筛选态先算一次；卡片构建与 UI.syncCardFilterState 用同一套判据 */
    var catOn = App.filters.categories.indexOf(a.category) >= 0;
    // 有封面时分类图标缩小为左下角角标（与左上角路径角标错开）；无封面时才作为大占位图标
    var cover = el('div', { class: 'card-cover' }, [
      el('div', { class: 'cover-ph' }, [App.categoryIcon(a.category, { size: 34 })])
    ]);
    /* 优先用 400px 缩略图，缺失时退回原图并补生成一次 */
    (function () {
      var img = null;
      function paint(url, isThumb) {
        if (!url) return;
        cover.classList.add('has-img');
        if (!img) {
          img = new Image();
          img.className = 'cover-img';
          img.alt = a.title;
          img.loading = 'lazy';
          img.decoding = 'async';   // 解码不占主线程，滚动时少一次卡顿
          /* 封面图不允许被拖走：拖到别的卡片上会走「拖图设封面」，把别人的封面换掉。 */
          img.draggable = false;
          img.onerror = function () {
            if (isThumb) {
              /* 缩略图还没生成 / 已损坏：记下来别再试，退回原图，并在后台补一张 */
              App._thumbMissing[a.id] = true;
              App.requestThumb(a);
              App.coverURLFor(a).then(function (u) {
                if (!u) { cover.classList.remove('has-img'); return; }
                img.onerror = function () { cover.classList.remove('has-img'); };
                img.src = u;
              });
              return;
            }
            cover.classList.remove('has-img');
          };
          cover.appendChild(img);
        }
        img.src = url;
      }
      var thumb = App.thumbURLFor(a);
      if (thumb) { paint(thumb, true); return; }
      App.coverURLFor(a).then(function (url) { paint(url, false); });
    })();

    var badges = el('div', { class: 'card-badges' }, [
      /* 类型图标放封面左上角，与其它角标同排 */
      el('span', {
        class: 'badge badge-dim cat-badge' + (App.filters.categories.indexOf(a.category) >= 0 ? ' cat-badge-on' : ''),
        dataset: { fk: 'cat' },
        title: UI.catChipTitle(a, catOn),
        onclick: function (e) { e.stopPropagation(); UI.filterFromCard(a, function () { UI.filterOnly('categories', a.category); }); }
      }, [App.categoryIcon(a.category, { size: 18 })]),
      (a.extra && a.extra.r18) ? el('span', { class: 'badge badge-r18', title: '成人向（R-18）' }, 'R18') : null,
      a.delisted ? el('span', { class: 'badge badge-dim', title: '商品已下架 / 无法获取信息', text: '已下架' }) : null,
      a.hidden ? el('span', { class: 'badge badge-dim', title: '已隐藏'}, ICONS.label('\u{1F648}')) : null,
      /* 本地路径 / 网盘角标在封面左下角（见下方 card-corner），这里不重复 */
    ]);
    cover.appendChild(badges);

    // 文件关联类角标（本地路径 / 网盘）放封面左下角，可点击直接打开
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
          if (isHttpUrl(a.cloudUrl)) FS.openExternal(a.cloudUrl);
          else { copyText(a.cloudUrl); Toast.info('网盘地址已复制：' + a.cloudUrl, 2600); }
        }
      }, ICONS.label('\u2601')) : null
    ]);
    if (corner.children.length) cover.appendChild(corner);

    /* 卡片不画价格丝带，只保留与价格无关的两枚：心愿单、开源 */
    if (a.extra && a.extra.wishlist && !App.isPurchased(a)) {
      cover.appendChild(el('span', {
        class: 'price-ribbon ribbon-wishlist', title: 'BOOTH 心愿单商品，点击只看心愿单',
        onclick: function (e) { e.stopPropagation(); UI.filterFromCard(a, function () { App.filters.wishlist = !App.filters.wishlist; }); }
      }, '心愿单'));
    } else if (App.isGitHubSource(a)) {
      cover.appendChild(el('span', {
        class: 'price-ribbon ribbon-oss',
        dataset: { fk: 'oss' },
        title: UI.ossRibbonTitle(),
        onclick: function (e) { e.stopPropagation(); UI.filterFromCard(a, function () { UI.filterOnly('sources', 'github'); }); }
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
        /* a 是渲染那一刻的快照：保存必须拿库里最新的那条，
         * 否则会把后台刚写好的封面标记 / 下载状态一并覆盖回原值。 */
        var live = App.assets.find(function (x) { return x.id === a.id; }) || a;
        live.favorite = !live.favorite;
        a.favorite = live.favorite;
        /* 只重画这一张卡 + 刷新侧栏「喜欢」计数：为一个星标重建整页会让入场动画一并重播。
         * refreshCard 内部已处理「被筛选 / 翻页挤出本页」的情况（那时退回整体重绘）。 */
        App.save(live).then(function () {
          UI.refreshCard(live.id) || UI.renderAll();
          UI.renderSidebar();
        });
      }
    }, a.favorite ? ICONS.label('\u2605') : ICONS.label('\u2606')));

    var srcEntries = App.sourceEntries(a);
    var primarySrc = App.primarySource(a);
    var primaryLabel = (primarySrc.source === 'other' && primarySrc.sourceCustom)
      ? primarySrc.sourceCustom
      : App.sourceLabel({ source: primarySrc.source, sourceCustom: primarySrc.sourceCustom });
    /* 来源 chip 也是开关：生效时不挂来源色描边，让 .chip-on 的主色描边显出来，
     * 否则行内 border-color 会盖掉高亮。 */
    var srcOn = App.filters.sources.indexOf(primarySrc.source) >= 0;
    var srcTag = el('span', {
      class: 'chip chip-source chip-click' + (srcOn ? ' chip-on' : ''),
      dataset: { fk: 'src' },
      style: srcOn ? null : { borderColor: App.sourceColor(primarySrc.source) },
      title: UI.srcChipTitle(a, srcOn),
      onclick: function (e) { e.stopPropagation(); UI.filterFromCard(a, function () { UI.filterOnly('sources', primarySrc.source); }); }
    }, [App.sourceIcon(primarySrc.source, { size: 13 }), document.createTextNode(primaryLabel + (srcEntries.length > 1 ? ' +' + (srcEntries.length - 1) : ''))]);

    var body = el('div', { class: 'card-body' }, [
      el('div', { class: 'card-title', title: a.title || a.originalTitle }, UI.cardTitleChildren(a.title || a.originalTitle || '（未命名）')),
      a.originalTitle && a.originalTitle !== a.title
        ? el('div', { class: 'card-subtitle', title: a.originalTitle }, a.originalTitle) : null,
      el('div', { class: 'card-chips' }, [
        el('span', {
          class: 'chip chip-cat chip-click' + (App.filters.categories.indexOf(a.category) >= 0 ? ' chip-on' : ''),
          dataset: { fk: 'catc' },
          title: UI.catChipTitle(a, catOn),
          onclick: function (e) { e.stopPropagation(); UI.filterFromCard(a, function () { UI.filterOnly('categories', a.category); }); }
        }, [App.categoryIcon(a.category, { size: 13 }), document.createTextNode(App.categoryLabel(a.category))]),
        srcTag,
      ]),
      (a.avatars || []).length ? el('div', { class: 'card-avatars' },
        App.normalizeAvatarIds(App.filterAvatars(a)).slice(0, 4).map(function (v) {
          var avLabel = App.avatarLabel(v);
          return el('span', {
            class: 'chip chip-av chip-click' + (App.filters.avatars.indexOf(v) >= 0 ? ' chip-on' : ''),
            dataset: { fk: 'av', fv: v },
            title: UI.avChipTitle(v, App.filters.avatars.indexOf(v) >= 0),
            onclick: function (e) { e.stopPropagation(); UI.filterFromCard(a, function () { UI.filterOnly('avatars', v); }); }
          }, avLabel);
        })
          .concat(a.avatars.length > 4 ? [el('span', {
            class: 'chip chip-av chip-more',
            /* 悬停显示被收起的角色，避免只有一个没有说明的 +N */
            title: '另有 ' + (a.avatars.length - 4) + ' 个支持角色：' +
              App.normalizeAvatarIds(App.filterAvatars(a)).slice(4).map(App.avatarLabel).join('、')
          }, '+' + (a.avatars.length - 4))] : [])
      ) : null,
      (function () {
        var all = App.displayTags(a);
        if (!all.length) return null;
        /* 一行最多 3 枚标签：固定塞 5 枚进 nowrap 时 flex 会把每枚压成一两个字。
         * 超过 3 枚只放 2 枚 + 「+N」，每枚不参与压缩，长标签自己省略号。 */
        var shown = all.length > 3 ? all.slice(0, 2) : all.slice(0, 3);
        var moreN = all.length - shown.length;
        var nodes = shown.map(function (t) {
          var tstate = UI.tagFilterState(t);
          return el('span', {
            class: 'tag tag-click' + (Smart.isUntranslated(t) ? ' tag-untrans' : '') + UI.tagFilterClass(tstate),
            dataset: { fk: 'tag', fv: t },
            title: UI.cardTagTitle(t, tstate),
            onclick: function (e) { e.stopPropagation(); UI.filterFromCard(a, function () { UI.toggleTagFilter(t, { render: false }); }); }
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
        if (App._suppressClick) { App._suppressClick = false; e.stopPropagation(); return; }
        if (App.selectMode) {
          App.selection[a.id] = !App.selection[a.id];
          UI.markCard(this, !!App.selection[a.id]);
          UI.syncBulkCount();
        } else {
          App.activeAssetId = a.id;   // 记住「正在看 / 改哪一个」，刷新后仍然高亮
          UI.flashCard(a.id);          // 点开详情就立刻显示光晕，不等下一次重渲染
          Modals.detail(a.id);
        }
      }
    }, [cover, body]);
    if (App.selectMode) {
      card.appendChild(el('div', { class: 'sel-mark' + (selected ? ' on' : '') }, selected ? ICONS.label('\u2714') : ''));
    }
    /* 右键菜单（编辑 / 分类 / 标签 / 角色 / 复制 / 喜欢 / 隐藏 / 导出 / 删除） */
      /* 长按卡片进入多选 */
    (function () {
      var pressTimer = null;
      card.addEventListener('pointerdown', function () {
        pressTimer = setTimeout(function () {
          pressTimer = null;
          if (App._paintActive) return;    // 正在拖动连选，别抢着重绘（会打断拖动）
          App._suppressClick = true;
          App.selectMode = true;
          App.selection[a.id] = true;
          UI.renderMain();
        }, 450);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) {
        card.addEventListener(ev, function () {
          if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        });
      });
    })();
  if (typeof AssetMenu !== 'undefined' && AssetMenu.attach) AssetMenu.attach(card, a);
    return card;
  }
};

