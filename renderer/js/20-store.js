/* ============ 20-store.js ============ */
/* =====================================================================
 * 20-store.js  —  数据持久化层
 *   数据本体在 <HTML 同目录>\vrclib-data\（见下方 Store.local）；IndexedDB 为缓存副本（素材 / 封面二进制 / 目录句柄 / 设置）
 *   不可用时自动降级到 LocalStorage（封面转 DataURL 存储）
 * ===================================================================== */

var Store = (function () {
  var db = null;
  var useIDB = true;

  /** 店铺字段清洗：不应是 URL / 站名 */
  function cleanShopField(v, shopUrl) {
    var s = String(v || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) {
      var host = '';
      try { host = new URL(s).hostname.replace(/^www\./, ''); } catch (e) {}
      if (host && !/^(booth\.pm|gumroad\.com)$/i.test(host)) {
        return host.replace(/\.booth\.pm$|\.gumroad\.com$/i, '');
      }
      if (shopUrl) {
        try { host = new URL(shopUrl).hostname.replace(/^www\./, ''); } catch (e) {}
        return host ? host.replace(/\.booth\.pm$|\.gumroad\.com$/i, '') : '';
      }
      return '';
    }
    if (/^(booth\.pm|gumroad\.com|booth|gumroad)$/i.test(s)) return '';
    return s;
  }

  /* ---------------- 来源多值（同一素材可能有多个来源） ---------------- */
  function normalizeSource(s) {
    s = s || {};
    return {
      source:       s.source || 'other',
      sourceCustom: s.sourceCustom || '',
      via:          s.via || '',           // 记录方式：import / folder / manual / userscript
      at:           s.at || nowISO()
    };
  }

  /* ---------------- 版本 / 变体模型（一个版本可含多个文件） ---------------- */
  function normalizeFile(f) {
    f = f || {};
    return {
      name:  f.name || f.fileName || '',
      url:   f.url || '',
      size:  Number(f.size || f.fileSize || 0) || 0,
      path:  f.path || '',
      source: f.source || ''      // 'public'=公开/免费链接；'order'=订单页解析的下载链接
    };
  }
  function normalizeVersion(v) {
    v = v || {};
    // 兼容旧字段：单文件信息迁移到 files[]
    var files = Array.isArray(v.files) ? v.files.map(normalizeFile)
      : ((v.fileName || v.url || v.path) ? [normalizeFile({ name: v.fileName, url: v.url, size: v.size, path: v.path })] : []);
    var first = files[0] || {};
    return {
      id:       v.id || uid('ver'),
      name:     v.name || '',          // 版本名 / 变体名（如「ダウンロード版」「v1.2」）
      fileName: v.fileName || first.name || '',
      size:     v.size || files.reduce(function (s, f) { return s + (f.size || 0); }, 0),
      url:      v.url || first.url || '',
      path:     v.path || first.path || '',
      price:    v.price || '',           // 商品价格（商品页显示价）
      purchasePrice: (v.purchasePrice != null && isFinite(Number(v.purchasePrice))) ? Number(v.purchasePrice) : null, // 购买价格（订单页实付价）
      purchaseCurrency: v.purchaseCurrency || '', // 购买价币种
      note:     v.note || '',
      orderUrl: v.orderUrl || '',     // 该版本对应的 BOOTH 订单页 / Gumroad 下载页 URL（有 = 已购买）
      variationId: v.variationId || '', // BOOTH 变体 ID（去重用）
      special:     !!v.special,        // 许可证/readme 等免费特殊变体：只展示名称，不计商品价
      files:    files,
      isLatest: !!v.isLatest,
      addedAt:  v.addedAt || nowISO()
    };
  }

  /** v2.3.10：「免费 / 付费」判定 —— 价格文本优先，其次商品价（BOOTH 变体价 / 商店价）；都未知返回 null（卡片不显示斜丝带） */
  /** v2.5.2：图集去重——同一张图的「/c/WxH/ 路径缩略版」与「原图」视为一张，优先保留原图 */
  function dedupeImages(list) {
    function key(u) {
      var s = String(u || '').split('#')[0].split('?')[0].replace(/\/c\/\d+x\d+\//, '/');
      var m = s.match(/\/([0-9a-f-]{8,})\/i\/(\d+)\/([^/]+)$/i);
      return m ? (m[1] + '|' + m[2] + '|' + m[3].toLowerCase()) : s.toLowerCase();
    }
    function sized(u) { return /\/c\/\d+x\d+\//.test(String(u || '')); }
    var best = Object.create(null), order = [];
    (list || []).forEach(function (u) {
      if (!u) return;
      var k = key(u);
      if (!(k in best)) { best[k] = u; order.push(k); return; }
      if (sized(u) && !sized(best[k])) return;
      if (!sized(u)) best[k] = u;
    });
    return order.map(function (k) { return best[k]; });
  }

  /** v2.5.11（用户批复 C）：变体名标示「停售 / 售罄 / 下架」→ 不参与计价与免费判定（仍照常列出、可下载） */
  function isDeadVariantName(name) {
    return /販売停止|販売終了|贩售停止|停止销售|销售结束|已停售|売り切れ|売切|完売|品切れ|sold\s*out|discontinued|unavailable/i.test(String(name || ''));
  }

  function deriveAssetIsFree(a, isBooth, shopPriceValue) {
    var d = derivePrice(a.price);
    if (typeof d.isFree === 'boolean') return d.isFree;
    // v2.5.2：商品价不再记录 → 免费与否按**变体价**判定（有变体价且全为 0 = 免费）
    // v2.5.11（用户批复 C）：**停售 / 售罄**的变体不参与判定——作者常拿占位价（如 9,999,999）标它们，
    // 否则一条只剩免费变体的素材会被判成「付费」（真实库实测：Project Zero 那条就是这个坑）。
    var vers = (a.versions || []).filter(function (v) {
      if (!v) return false;
      // 停售且**没买过**（无订单链接）→ 不算价格证据；买过的停售变体照常算（用户 2026-10-01 修正）
      if (isDeadVariantName(v.name) && !(v.orderUrl && String(v.orderUrl).trim())) return false;
      return true;   // 含免费/特价变体（special）：它们同样是「是否免费」的证据
    });
    var seen = false, allZero = true;
    vers.forEach(function (v) {
      var pd = derivePrice(String(v.price || ''));
      if (pd.value == null) return;
      seen = true;
      if (pd.value !== 0) allZero = false;
    });
    if (seen) return allZero;
    if (shopPriceValue != null && isFinite(Number(shopPriceValue))) return Number(shopPriceValue) === 0 && !!isBooth;
    return null;
  }

  /* ---------------- 素材数据模型（预留扩展字段） ---------------- */
  function normalizeAsset(a) {
    a = a || {};
    var isBooth = (a.source === 'booth') || (Array.isArray(a.sources) && a.sources.some(function (s) { return s && s.source === 'booth'; }));
    // v2.1 价格模型：purchasePrice/Currency = 用户手填购买价（所有来源都可填）；
    // shopPrice/Value/Currency = 只读商品价（BOOTH 用变体计算价，其他来源为抓取到的商店价）。
    // 存量迁移：BOOTH 旧 price 视为商品价；其他来源旧 price 视为购买价。
    var purchasePrice = (a.purchasePrice != null && isFinite(Number(a.purchasePrice))) ? Number(a.purchasePrice) : null;
    var purchaseCurrency = a.purchaseCurrency || '';
    var shopPrice = a.shopPrice || '';
    var shopPd = derivePrice(shopPrice);
    var shopPriceValue = (a.shopPriceValue != null && isFinite(Number(a.shopPriceValue))) ? Number(a.shopPriceValue) : shopPd.value;
    var shopPriceCurrency = a.shopPriceCurrency || shopPd.currency;
    if (a.price && purchasePrice == null && !shopPrice) {
      var oldPd = derivePrice(a.price);
      if (isBooth) {
        shopPrice = a.price;
        shopPriceValue = (typeof a.priceValue === 'number') ? a.priceValue : oldPd.value;
        shopPriceCurrency = a.currency || oldPd.currency;
      } else if (oldPd.value != null) {
        purchasePrice = oldPd.value;
        var oldCur = a.currency || oldPd.currency || '';
        if (!oldCur || (a.source === 'xianyu' && oldCur === 'JPY')) oldCur = 'CNY';
        purchaseCurrency = oldCur;
      }
    }
    return {
      id:            a.id || uid('as'),
      title:         a.title || '',                 // 自定义标题（主展示）
      originalTitle: a.originalTitle || '',         // 原标题（小字）
      source:        a.source || 'other',           // 主来源标识
      sourceCustom:  a.sourceCustom || '',          // 来源为「其他」时的自定义文本
      sources:       Array.isArray(a.sources) ? a.sources.map(normalizeSource) : [],  // 全部来源（好友分享/闲鱼等可与商店来源并存）
      links:         Array.isArray(a.links) ? a.links.slice() : [],          // 商店链接（多个）
      downloadLinks: Array.isArray(a.downloadLinks) ? a.downloadLinks.slice() : [], // 下载直链
      cloudUrl:      typeof a.cloudUrl === 'string' ? a.cloudUrl : '',              // v2.2.12 网盘路径或分享链接
      downloadedFiles: Array.isArray(a.downloadedFiles) ? a.downloadedFiles.slice() : [],  // v2.3.2 成功下载过的文件名（宿主离线、且浏览器目录句柄也不可用时，作为乐观兜底保留原按钮状态）
      versions:      Array.isArray(a.versions) ? a.versions.map(normalizeVersion) : [],       // 版本 / 变体
      activeVersion: a.activeVersion || '',                                                   // 兼容旧字段：已购买版本 id
      activeVersions: Array.isArray(a.activeVersions) ? uniq(a.activeVersions)
        : (a.activeVersion ? [a.activeVersion] : []),                                        // 已购买版本 id 集合（由 orderUrl 自动派生，保存时重算）
      category:      a.category || 'other',
      tags:          Array.isArray(a.tags) ? uniq(a.tags) : [],
      rawTags:       Array.isArray(a.rawTags) ? uniq(a.rawTags) : [],        // 原始（未翻译）标签
      description:   a.description || '',           // 商品简介（抓取所得，纯文本；界面上叫「商品简介」）
      // v2.5.2：商品图集——按「店铺/商品/文件名」归一，同一张图的 /c/WxH/ 缩略路径与原图只留一张（优先原图）
      images:        dedupeImages(Array.isArray(a.images) ? a.images : []),
      coverURL:      a.coverURL || '',              // 外链封面（无本地封面时使用）
      hasCover:      !!a.hasCover,                  // 是否存在本地封面 Blob
      coverCleared:  !!a.coverCleared,              // v2.3.7 用户主动清除过封面：不再按商品ID 从素材文件夹自动认领
      avatars:       Array.isArray(a.avatars) ? uniq(a.avatars) : [],        // 支持角色
      charNameZh:    a.charNameZh || '',          // 该素材作为角色模型时的中文角色名
      charNameJa:    a.charNameJa || '',
      charNameEn:    a.charNameEn || '',
      paths:         Array.isArray(a.paths) ? a.paths.slice() : [],          // 本地文件路径（多个）
      note:          a.note || '',
      author:        Store.cleanShopField(a.author, a.shopUrl),
      /* v2.5.2（用户批准）：商品价不再记录——price / shopPrice* 一律丢弃（保存即清理旧数据）；
       * 价格一律由**变体价**现算（见 App.effectivePrice），购买价 purchasePrice 继续保留。 */
      price: '', priceValue: null, currency: '', shopPrice: '', shopPriceValue: null, shopPriceCurrency: '',
      /* v2.5.3（用户批复）：isFree 改为**以变体价现算为准**。原实现「一旦是布尔值就永不重算」，
       * 而 v2.5.2 起价格口径改成变体价现算 → 两者会长期不一致（真实库实测 21 条素材显示「免费」
       * 却算得出 ¥100~¥1000 且确实有非 0 变体价，卡片还因此隐藏价格）。
       * 只有拿不到任何价格证据（derived === null）时才沿用已存值。 */
      isFree:        (function () { var derived = deriveAssetIsFree(a, isBooth, null); return derived !== null ? derived : ((typeof a.isFree === 'boolean') ? a.isFree : null); })(),
      purchasePrice: purchasePrice,                 // 手填购买价（数值，所有来源）
      purchaseCurrency: purchaseCurrency,           // 购买价币种：CNY/JPY/USD/EUR
      gifted:        !!(a.gifted || (a.extra && a.extra.gifted)),  // 获赠（BOOTH 获赠页自动识别，可手动改）
      delisted:      !!(a.delisted || (a.extra && a.extra.delisted)), // 已下架（确定失效才标记）
      autoFilled:    (a.autoFilled && typeof a.autoFilled === 'object') ? a.autoFilled : {}, // 字段级“自动获取”标记
      userEdited:    (a.userEdited && typeof a.userEdited === 'object') ? a.userEdited : {}, // 字段级“用户修改”标记
      shop:          Store.cleanShopField(a.shop, a.shopUrl),
      shopUrl:       a.shopUrl || '',
      itemId:        a.itemId || '',                // 站点商品 ID（BOOTH/Gumroad）
      hidden:        !!a.hidden,                    // 隐藏标记（不在默认列表中显示）
      downloaded:    !!a.downloaded,
      downloadedAt:  a.downloadedAt || '',
      favorite:      !!a.favorite,
      rating:        typeof a.rating === 'number' ? a.rating : 0,
      fileSize:      a.fileSize || 0,
      version:       a.version || '',
      importedFrom:  a.importedFrom || '',   // 'folder' | 'userscript' | 'library-sync' | ''
      publishedAt:   a.publishedAt || '',    // 商品上架时间（原站点）
      shopUpdatedAt: a.shopUpdatedAt || '',  // 商品更新时间（原站点）
      createdAt:     a.createdAt || nowISO(),
      updatedAt:     a.updatedAt || nowISO(),
      extra:         a.extra && typeof a.extra === 'object' ? a.extra : {}    // 预留扩展
    };
  }

  /* ---------------- IndexedDB 打开 ---------------- */
  function open() {
    return new Promise(function (resolve) {
      if (!('indexedDB' in window)) { useIDB = false; return resolve(false); }
      var req;
      try { req = indexedDB.open(APP.dbName, APP.dbVersion); }
      catch (e) { useIDB = false; return resolve(false); }
      req.onupgradeneeded = function (ev) {
        var d = ev.target.result;
        if (!d.objectStoreNames.contains('assets')) {
          var s = d.createObjectStore('assets', { keyPath: 'id' });
          s.createIndex('createdAt', 'createdAt');
          s.createIndex('category', 'category');
        }
        if (!d.objectStoreNames.contains('covers')) d.createObjectStore('covers', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv'))     d.createObjectStore('kv', { keyPath: 'k' });
        // v2：抓取结果缓存（同一商品链接不重复请求 / 重复解析）
        if (!d.objectStoreNames.contains('fetchCache')) d.createObjectStore('fetchCache', { keyPath: 'url' });
        // v3：图集缓存表（v2.3.6 起图集本体落盘 vrclib-data\gallery\，这里只剩宿主离线时的兜底与迁移来源）
        if (!d.objectStoreNames.contains('gallery')) d.createObjectStore('gallery', { keyPath: 'id' });
      };
      req.onsuccess = function () { db = req.result; useIDB = true; resolve(true); };
      req.onerror = function () { useIDB = false; resolve(false); };
      req.onblocked = function () { useIDB = false; resolve(false); };
    });
  }

  function tx(storeNames, mode) {
    return db.transaction(storeNames, mode || 'readonly');
  }
  function reqP(request) {
    return new Promise(function (res, rej) {
      request.onsuccess = function () { res(request.result); };
      request.onerror = function () { rej(request.error); };
    });
  }

  /* ---------------- LocalStorage 降级 ---------------- */
  function lsRead() { return safeJSON(localStorage.getItem(APP.lsKey), { assets: [], covers: {}, kv: {} }); }
  function lsWrite(data) {
    try { localStorage.setItem(APP.lsKey, JSON.stringify(data)); return true; }
    catch (e) { Toast.err('本地存储空间不足，请减少封面图或导出备份后清理'); return false; }
  }

  /* ---------------- 素材 CRUD ---------------- */
  function allAssets() {
    if (!useIDB) return Promise.resolve(lsRead().assets.map(normalizeAsset));
    return reqP(tx('assets').objectStore('assets').getAll()).then(function (rows) {
      return (rows || []).map(normalizeAsset);
    });
  }

  /** v2.5.1（真 bug 修复）：任何写库动作都必须镜像到**文件主库**（vrclib-data\assets.json）。
   *  文件是启动时的数据源，只写 IndexedDB 的改动会在下次启动被文件里的旧数据覆盖回来——
   *  「删除素材后刷新又出现」就是这么来的（App.remove 只删了 IDB）。以前只有 App.save 会 scheduleFileSync，
   *  直接调 Store.putAssets / deleteAsset / clearAll 的地方（批量操作、标签全局改名、备份导入、清空素材库…）全都漏了。
   *  放在 store 层做，一次覆盖所有调用点，以后新增调用也不会再漏。 */
  function markFileDirty() {
    try {
      if (typeof App !== 'undefined' && App && typeof App.scheduleFileSync === 'function') App.scheduleFileSync('assets');
    } catch (e) {}
  }

  function putAsset(asset) {
    var a = normalizeAsset(asset);
    a.updatedAt = nowISO();
    if (!useIDB) {
      var d = lsRead();
      var i = d.assets.findIndex(function (x) { return x.id === a.id; });
      if (i >= 0) d.assets[i] = a; else d.assets.push(a);
      lsWrite(d); markFileDirty(); return Promise.resolve(a);
    }
    var t = tx('assets', 'readwrite');
    return reqP(t.objectStore('assets').put(a)).then(function () { markFileDirty(); return a; });
  }

  function putAssets(list) {
    if (!useIDB) {
      var d = lsRead();
      list.forEach(function (raw) {
        var a = normalizeAsset(raw);
        var i = d.assets.findIndex(function (x) { return x.id === a.id; });
        if (i >= 0) d.assets[i] = a; else d.assets.push(a);
      });
      lsWrite(d); markFileDirty(); return Promise.resolve(list.length);
    }
    var t = tx('assets', 'readwrite'), s = t.objectStore('assets');
    list.forEach(function (raw) { s.put(normalizeAsset(raw)); });
    return new Promise(function (res, rej) {
      t.oncomplete = function () { markFileDirty(); res(list.length); };
      t.onerror = function () { rej(t.error); };
    });
  }

  function deleteAsset(id) {
    if (!useIDB) {
      var d = lsRead();
      d.assets = d.assets.filter(function (x) { return x.id !== id; });
      delete d.covers[id];
      lsWrite(d); markFileDirty(); return Promise.resolve();
    }
    var t = tx(['assets', 'covers'], 'readwrite');
    t.objectStore('assets').delete(id);
    t.objectStore('covers').delete(id);
    // ← 这里以前没有标脏：删完只写进 IDB，文件里还在 → 刷新后素材"复活"
    return new Promise(function (res) { t.oncomplete = function () { markFileDirty(); res(); }; t.onerror = res; });
  }

  function clearAll() {
    if (!useIDB) { localStorage.removeItem(APP.lsKey); markFileDirty(); return Promise.resolve(); }
    var t = tx(['assets', 'covers'], 'readwrite');
    t.objectStore('assets').clear();
    t.objectStore('covers').clear();
    return new Promise(function (res) { t.oncomplete = function () { markFileDirty(); res(); }; t.onerror = res; });
  }

  /* ---------------- 封面（Blob / DataURL） ---------------- */
  function putCover(id, blob) {
    if (!useIDB) {
      return fileToDataURL(blob).then(function (durl) {
        var d = lsRead(); d.covers[id] = durl; lsWrite(d); return true;
      });
    }
    var t = tx('covers', 'readwrite');
    return reqP(t.objectStore('covers').put({ id: id, blob: blob, mime: blob.type, size: blob.size, at: nowISO() }))
      .then(function () { return true; });
  }

  function getCover(id) {
    if (!useIDB) { var d = lsRead(); return Promise.resolve(d.covers[id] ? { dataURL: d.covers[id] } : null); }
    return reqP(tx('covers').objectStore('covers').get(id)).then(function (r) { return r || null; });
  }

  function deleteCover(id) {
    if (!useIDB) { var d = lsRead(); delete d.covers[id]; lsWrite(d); return Promise.resolve(); }
    var t = tx('covers', 'readwrite');
    return reqP(t.objectStore('covers').delete(id));
  }

  function allCovers() {
    if (!useIDB) {
      var d = lsRead();
      return Promise.resolve(Object.keys(d.covers).map(function (k) { return { id: k, dataURL: d.covers[k] }; }));
    }
    return reqP(tx('covers').objectStore('covers').getAll()).then(function (r) { return r || []; });
  }

  /* ---------------- 键值（设置 / 目录句柄） ---------------- */
  function kvGet(key, fallbackValue) {
    if (!useIDB) { var d = lsRead(); return Promise.resolve(d.kv[key] === undefined ? fallbackValue : d.kv[key]); }
    return reqP(tx('kv').objectStore('kv').get(key)).then(function (r) {
      return r && 'v' in r ? r.v : fallbackValue;
    });
  }
  function kvSet(key, value) {
    if (!useIDB) { var d = lsRead(); d.kv[key] = value; lsWrite(d); return Promise.resolve(true); }
    var t = tx('kv', 'readwrite');
    return reqP(t.objectStore('kv').put({ k: key, v: value })).then(function () { return true; });
  }
  function kvDel(key) {
    if (!useIDB) { var d = lsRead(); delete d.kv[key]; lsWrite(d); return Promise.resolve(); }
    var t = tx('kv', 'readwrite');
    return reqP(t.objectStore('kv').delete(key));
  }

  /* ---------------- 图集本地缓存 ---------------- */
  function galleryGet(id) {
    if (!useIDB) { var d0 = lsRead(); return Promise.resolve((d0.kv['gal_' + id]) || { id: id, items: [] }); }
    return reqP(tx('gallery').objectStore('gallery').get(id)).then(function (r) { return r || { id: id, items: [] }; }).catch(function () { return { id: id, items: [] }; });
  }
  function galleryAdd(id, item) {
    return galleryGet(id).then(function (rec) {
      rec.items = rec.items || [];
      var i = rec.items.findIndex(function (x) { return x.url === item.url; });
      if (i >= 0) rec.items[i] = item; else rec.items.push(item);
      if (!useIDB) {
        var d = lsRead(); d.kv['gal_' + id] = rec; lsWrite(d);
        return Promise.resolve(rec);
      }
      var t = tx('gallery', 'readwrite');
      return reqP(t.objectStore('gallery').put(rec)).then(function () { return rec; });
    });
  }
  function galleryClear(id) {
    if (!useIDB) { var d = lsRead(); delete d.kv['gal_' + id]; lsWrite(d); return Promise.resolve(); }
    var t = tx('gallery', 'readwrite');
    return reqP(t.objectStore('gallery').delete(id));
  }
  /** 全部图集缓存记录（v2.3.6 迁移到磁盘时遍历用） */
  function galleryAll() {
    if (!useIDB) {
      var d = lsRead(), out = [];
      Object.keys(d.kv || {}).forEach(function (k) { if (k.indexOf('gal_') === 0) out.push(d.kv[k]); });
      return Promise.resolve(out);
    }
    return reqP(tx('gallery').objectStore('gallery').getAll()).then(function (rs) { return rs || []; }).catch(function () { return []; });
  }

  /* ---------------- 图集磁盘缓存（v2.3.6：vrclib-data\gallery\<商品ID>\，PNG） ---------------- */
  function safeSeg(s) { return String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '_').trim(); }
  function galleryDir(itemId, settings) {
    var d = dataDir(settings);
    var seg = safeSeg(itemId);
    if (!d || !seg) return '';
    return joinWinPath(d, ['gallery', seg]);
  }
  function saveGalleryFile(itemId, fileName, blob, settings) {
    var dir = galleryDir(itemId, settings);
    if (!dir || !blob || !fileName) return Promise.resolve('');
    var path = joinWinPath(dir, [safeSeg(fileName)]);
    if (bytesMode()) {
      return blobBytes(blob).then(function (bytes) {
        if (!bytes) return '';
        return hostReady().then(function (ok) {
          if (!ok) return '';
          return FS.host.writeBytes(path, bytes).then(function () { return path; }).catch(function () { return ''; });
        });
      }).catch(function () { return ''; });
    }
    return b64OfBlob(blob).then(function (b64) {
      if (!b64) return '';
      return hostReady().then(function (ok) {
        if (!ok) return '';
        return FS.host.mkdir(dir)
          .then(function () { return FS.host.writeFile(path, b64); })
          .then(function () { return path; })
          .catch(function () { return ''; });
      });
    }).catch(function () { return ''; });
  }
  function listGalleryFiles(itemId, settings) {
    var dir = galleryDir(itemId, settings);
    if (!dir) return Promise.resolve([]);
    return hostReady().then(function (ok) {
      if (!ok) return [];
      return FS.host.scan(dir, 0).then(function (entries) {
        return (entries || []).filter(function (e) { return e && e.kind === 'file'; });
      }).catch(function () { return []; });
    }).catch(function () { return []; });
  }
  function loadGalleryFile(itemId, fileName, settings) {
    var dir = galleryDir(itemId, settings);
    if (!dir || !fileName) return Promise.resolve(null);
    var path = joinWinPath(dir, [safeSeg(fileName)]);
    return hostReady().then(function (ok) {
      if (!ok) return null;
      if (bytesMode()) {
        return FS.host.readBytes(path).then(function (bytes) {
          var ext = String(fileName).split('.').pop().toLowerCase();
          var mime = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : (ext === 'gif' ? 'image/gif' : 'image/jpeg'));
          return new Blob([bytes], { type: mime });
        }).catch(function () { return null; });
      }
      return FS.host.readFileBase64(path).then(function (j) {
        var b64 = (j && (j.dataBase64 || j.base64)) || '';
        if (!b64) return null;
        var ext = String(fileName).split('.').pop().toLowerCase();
        var mime = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : (ext === 'gif' ? 'image/gif' : 'image/jpeg'));
        return fetch('data:' + mime + ';base64,' + b64).then(function (r) { return r.blob(); });
      }).catch(function () { return null; });
    }).catch(function () { return null; });
  }

  /* ---------------- 抓取结果缓存 ---------------- */
  function cacheGet(url) {
    var ttl = (App.settings.cacheTTLHours || 168) * 3600 * 1000;
    if (!App.settings.cacheEnabled) return Promise.resolve(null);
    if (!useIDB) {
      var d = lsRead(); var hit = (d.kv['cache_' + url]);
      if (!hit) return Promise.resolve(null);
      // v2.5.3：过期顺手删掉（原来只「读不到」不删除，IDB/localStorage 的抓取缓存只增不减）
      if (Date.now() - hit.at > ttl) { delete d.kv['cache_' + url]; lsWrite(d); return Promise.resolve(null); }
      return Promise.resolve(hit.info);
    }
    return reqP(tx('fetchCache').objectStore('fetchCache').get(url)).then(function (r) {
      if (!r) return null;
      if (Date.now() - r.at > ttl) { cacheDel(url); return null; }
      return r.info;
    }).catch(function () { return null; });
  }
  function cacheSet(url, info) {
    if (!App.settings.cacheEnabled) return Promise.resolve(false);
    var rec = { url: url, info: info, at: Date.now() };
    if (!useIDB) { var d = lsRead(); d.kv['cache_' + url] = rec; lsWrite(d); return Promise.resolve(true); }
    var t = tx('fetchCache', 'readwrite');
    return reqP(t.objectStore('fetchCache').put(rec)).then(function () { return true; }).catch(function () { return false; });
  }
  function cacheClear() {
    if (!useIDB) {
      var d = lsRead();
      Object.keys(d.kv).forEach(function (k) { if (k.indexOf('cache_') === 0) delete d.kv[k]; });
      lsWrite(d); return Promise.resolve();
    }
    var t = tx('fetchCache', 'readwrite');
    return reqP(t.objectStore('fetchCache').clear());
  }
  function cacheDel(url) {
    if (!useIDB) {
      var d = lsRead(); delete d.kv['cache_' + url]; lsWrite(d); return Promise.resolve(true);
    }
    var t = tx('fetchCache', 'readwrite');
    return reqP(t.objectStore('fetchCache').delete(url)).then(function () { return true; }).catch(function () { return false; });
  }
  function cacheCount() {
    if (!useIDB) {
      var d = lsRead();
      return Promise.resolve(Object.keys(d.kv).filter(function (k) { return k.indexOf('cache_') === 0; }).length);
    }
    return reqP(tx('fetchCache').objectStore('fetchCache').count()).catch(function () { return 0; });
  }

  /** 存储用量估算 */
  function estimate() {
    if (navigator.storage && navigator.storage.estimate) {
      return navigator.storage.estimate().catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  /**
   * 图标本地化：优先 IndexedDB 中的 Blob，没有则下载一次并缓存。
   * 返回可安全给 <img> 使用的 URL（本地 objectURL 或原始 URL 兜底）。
   */
  /** v2.5.3：Blob → dataURL。图标是长生命周期缓存（App.iconCache 全程不清空），
   *  原来返回 objectURL 却从不 revoke ⇒ 每张图标一份常驻 blob；dataURL 不需要回收。 */
  function blobToDataURL(blob) {
    return new Promise(function (res) {
      try {
        var fr = new FileReader();
        fr.onload = function () { res(String(fr.result || '')); };
        fr.onerror = function () { res(''); };
        fr.readAsDataURL(blob);
      } catch (e) { res(''); }
    });
  }
  function iconURL(url) {
    if (!url || !/^https?:\/\//i.test(url)) return Promise.resolve(url);
    var key = 'icon_' + url;
    return kvGet(key, null).then(function (cached) {
      if (cached && cached instanceof Blob) return blobToDataURL(cached).then(function (u) { return u || url; });
      return fetch(url, { mode: 'cors' }).then(function (r) {
        if (!r.ok) return url;
        return r.blob();
      }).then(function (blob) {
        if (!(blob instanceof Blob)) return url;
        return kvSet(key, blob).then(function () { return blobToDataURL(blob); }, function () { return blobToDataURL(blob); })
          .then(function (u) { return u || url; });
      }).catch(function () { return url; });
    }).catch(function () { return url; });
  }

  /* ================= 文件主库（v2.3.0） =================
   * 位置：<HTML 同目录>\vrclib-data\{assets.json, settings.json, covers\<id>.<ext>}
   * 语义：文件为准，IndexedDB 降为缓存；宿主离线时 App 走只读缓存。
   * settings.json 刻意排除凭据类字段（Cookie / AI Key / WebDAV 密码），
   * 这些只留在 IndexedDB 的加密存储里，不落旁路明文文件。
   */
  var DATA_DIRNAME = 'vrclib-data';
  // 只排除【凭据类】与【环境相关】字段；fuzzyDict 是普通词表，必须落盘（v2.3.1 修正）
  var SETTINGS_SKIP = ['credentials', 'ai', 'webdavAccounts', 'localDataDir', 'githubToken'];   // v2.3.25：Token 只留浏览器本机库

  function htmlDir() {
    try {
      /* 桌面壳（Electron / Tauri）由主进程直接给根目录 —— Tauri 的页面地址是
       * http://tauri.localhost，从 location 推不出文件系统路径。
       * 数据目录仍固定在 <程序根>\vrclib-data，与旧版完全一致，不会让老库「消失」。 */
      if (window.vrcElectron && window.vrcElectron.appRoot) return String(window.vrcElectron.appRoot);
      if (String(location.protocol) !== 'file:') return '';
      if (/[?&]nolocal=1\b/.test(String(location.search || ''))) return '';   // 冒烟/测试用：不在产物目录写 vrclib-data
      var p = decodeURIComponent(String(location.pathname || '')).replace(/^\/+/, '').replace(/\//g, '\\');
      var i = p.lastIndexOf('\\');
      return i > 0 ? p.slice(0, i) : '';
    } catch (e) { return ''; }
  }
  function dataDir(settings) {
    var custom = normalizeWinPath((settings || App.settings || {}).localDataDir || '');
    if (custom) return custom;
    var d = htmlDir();
    return d ? joinWinPath(d, [DATA_DIRNAME]) : '';
  }
  function jsonPath(name, settings) {
    var d = dataDir(settings);
    return d ? joinWinPath(d, [name]) : '';
  }
  function b64OfBytes(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
  }
  function b64OfText(s) { return b64OfBytes(new TextEncoder().encode(String(s))); }
  /* v3.0.0（D9 · 容量悬崖）：宿主 /api/writeFile 的上限 = **请求体 64 MB**（tools/vrclib-host.mjs readBody：
   * len > 64*1024*1024 → req.destroy()，连 HTTP 响应都不给）。base64 膨胀 4/3 ⇒ 原始 JSON 超过约 48 MiB
   * 就必然写不进去；而页面侧只看到「请求失败」，与宿主离线无法区分 —— 于是提示说错原因、还白重试 15 次
   * （约 5 分钟）。这里在**发送之前**按体积判死，并把结构化原因（too-large / host-offline / host-error）
   * 留给上层说话。
   * ⚠ 联动：HOST_BODY_LIMIT 必须与宿主 readBody 的上限**同步改**（宿主侧：tools/vrclib-host.mjs，
   *   v3.0.0 起 = 64 MB = 67108864 B）。这是前端唯一一处常数，改一处即可；Store.local.hostBodyLimit()
   *   把它连同推导出的悬崖值暴露出来，供探针/测试钉住这个联动。 */
  var HOST_BODY_LIMIT = 67108864;     // = 64 MB，与 tools/vrclib-host.mjs readBody 上限一致
  var BODY_WRAP = 256;                // JSON({path, dataBase64}) 的包装余量
  var lastWriteFail = null;
  function noteWriteFail(kind, info) { lastWriteFail = Object.assign({ kind: kind, at: Date.now() }, info || {}); }
  function lastWriteFailInfo() { return lastWriteFail; }
  function hostBodyLimitInfo() {
    return { limitBytes: HOST_BODY_LIMIT, wrap: BODY_WRAP, cliffRawBytes: Math.floor((HOST_BODY_LIMIT - BODY_WRAP) * 3 / 4) };
  }
  function b64OfBlob(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result || '').split(',')[1] || ''); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsDataURL(blob);
    });
  }
  function hostReady() { return (typeof FS !== 'undefined' && FS.hostEnsure) ? FS.hostEnsure() : Promise.resolve(false); }
  /** errBox：文件「存在但读不出来」时记录原因（缺文件不记）。
   *  v2.3.11：这条信息是防止「读失败被当成首次运行 → 启动链把空列表写回去」的关键，
   *  起因是宿主 /api/readText 有 2MB 上限（v2.3.11 前；现 64MB），而用户 assets.json 已 2.8MB。 */
  function readJsonFile(path, errBox) {
    if (!path) return Promise.resolve(null);
    return hostReady().then(function (ok) {
      if (!ok) return null;
      return FS.host.exists(path).then(function (kind) {
        if (kind !== 'file') return null;
        return FS.host.readText(path).then(function (txt) {
          try { return JSON.parse(txt); } catch (e) { if (errBox) errBox.push(path + '：JSON 解析失败'); return null; }
        });
      });
    }).catch(function (e) { if (errBox) errBox.push(path + '：' + ((e && e.message) || e)); return null; });
  }
  function writeTextFile(path, text) {
    if (!path) return Promise.resolve(false);
    var bytes = new TextEncoder().encode(String(text));
    /* v6.1：Tauri 下直接写字节。没有 base64 膨胀 ⇒ 也就没有「原始 JSON 超过约 48MB 必写不进去」
     * 这个悬崖，下面的体积预检只是给 Electron/浏览器兜底。 */
    if (bytesMode()) {
      return hostReady().then(function (ok) {
        if (!ok) { noteWriteFail('host-offline', { path: path }); return false; }
        return FS.host.writeBytes(path, bytes)
          .then(function () { lastWriteFail = null; return true; })
          .catch(function (e) { noteWriteFail('host-error', { path: path, error: String((e && e.message) || e) }); return false; });
      }).catch(function (e) { noteWriteFail('host-offline', { path: path, error: String((e && e.message) || e) }); return false; });
    }
    var bodyBytes = 4 * Math.ceil(bytes.length / 3) + BODY_WRAP;      // base64 后 + JSON 包装
    if (bodyBytes > HOST_BODY_LIMIT) {
      noteWriteFail('too-large', { path: path, rawBytes: bytes.length, bodyBytes: bodyBytes, limitBytes: HOST_BODY_LIMIT });
      return Promise.resolve(false);        // 体积超限是确定性失败：绝不重试（重试只会白等 5 分钟）
    }
    var b64 = b64OfBytes(bytes);
    return hostReady().then(function (ok) {
      if (!ok) { noteWriteFail('host-offline', { path: path }); return false; }
      var d = path.slice(0, path.lastIndexOf('\\'));
      return FS.host.mkdir(d)
        .then(function () { return FS.host.writeFile(path, b64); })
        .then(function () { lastWriteFail = null; return true; })
        .catch(function (e) { noteWriteFail('host-error', { path: path, error: String((e && e.message) || e) }); return false; });
    }).catch(function (e) { noteWriteFail('host-offline', { path: path, error: String((e && e.message) || e) }); return false; });
  }
  function settingsPayload(settings) {
    var s = {}, src = settings || App.settings || {};
    Object.keys(src).forEach(function (k) {
      if (SETTINGS_SKIP.indexOf(k) >= 0) return;
      if (k === 'v' || k === 'at' || k === 'settings') return;   // v2.3.18：settings.json 的外壳键绝不能进 payload
      s[k] = src[k];
    });
    return s;
  }
  /** 加载文件主库 → {dir, assets, settings, ok}
   *  v6.0：Tauri 载体下素材主库改为 SQLite（vrclib-data\library.db），
   *        settings.json 仍是文件。返回结构与读 assets.json 时完全一致，
   *        上层 App.bootLocalData 的时间戳比较、只读保护逻辑全部照旧。 */
  function dbMode() {
    try { return !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke); } catch (e) { return false; }
  }
  /** v6.1：能不能直接读写原始字节（Tauri 可以；Electron / 浏览器退回 base64 通道） */
  function bytesMode() {
    try { return !!(typeof FS !== 'undefined' && FS.host && FS.host.bytesSupported && FS.host.bytesSupported()); } catch (e) { return false; }
  }
  function blobBytes(blob) {
    if (!blob) return Promise.resolve(null);
    if (blob.arrayBuffer) {
      return blob.arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
    }
    return Promise.resolve(null);
  }
  /** v6.2：封面一落盘就顺手生成 400px 缩略图（失败不影响封面本身） */
  function makeThumb(dir, coverPath, id) {
    try {
      if (!FS.host || !FS.host.thumb) return;
      var tdir = joinWinPath(dir, ['covers', 'thumb']);
      var width = (App.settings && App.settings.thumbWidth) || 400;
      FS.host.thumb(coverPath, joinWinPath(tdir, [id + '.jpg']), width).catch(function () {});
      if (App._thumbMissing) delete App._thumbMissing[id];
    } catch (e) {}
  }
  function loadAll(settings) {
    var dir = dataDir(settings);
    if (!dir) return Promise.resolve({ dir: '', ok: false, assets: null, settings: null, readErrors: [] });
    var errs = [];
    if (dbMode()) {
      return Promise.all([
        FS.host.db('load'),
        readJsonFile(joinWinPath(dir, ['settings.json']), errs)
      ]).then(function (r) {
        var db = r[0] || {};
        var count = Number(db.count) || 0;
        /* count=0 → 当作首次运行（assets=null），让启动链保持原来的「首次运行」分支 */
        var assetsFile = count > 0 ? { v: 1, at: db.at || '', assets: db.assets || [] } : null;
        return { dir: dir, assets: assetsFile, settings: r[1], ok: !!(assetsFile || r[1]), readErrors: errs };
      }).catch(function (e) {
        errs.push('素材库数据库：' + ((e && e.message) || e));
        return { dir: dir, assets: null, settings: null, ok: false, readErrors: errs };
      });
    }
    return Promise.all([
      readJsonFile(joinWinPath(dir, ['assets.json']), errs),
      readJsonFile(joinWinPath(dir, ['settings.json']), errs)
    ]).then(function (r) {
      return { dir: dir, assets: r[0], settings: r[1], ok: !!(r[0] || r[1]), readErrors: errs };
    });
  }
  function saveAssets(list, settings) {
    if (dbMode()) {
      return FS.host.db('save', { assets: list || [], at: nowISO() })
        .then(function () { lastWriteFail = null; return true; })
        .catch(function (e) {
          noteWriteFail('db-error', { error: String((e && e.message) || e) });
          return false;
        });
    }
    return writeTextFile(jsonPath('assets.json', settings), JSON.stringify({ v: 1, at: nowISO(), assets: list || [] }));
  }
  function saveSettings(settings) {
    return writeTextFile(jsonPath('settings.json', settings), JSON.stringify({ v: 1, at: nowISO(), settings: settingsPayload(settings) }, null, 1));
  }
  /** 封面落盘 covers\<id>.<ext> */
  function saveCoverFile(id, blob, settings) {
    var dir = dataDir(settings);
    if (!dir || !blob || !id) return Promise.resolve(false);
    var mime = String(blob.type || '');
    var ext = /png/i.test(mime) ? 'png' : (/webp/i.test(mime) ? 'webp' : (/gif/i.test(mime) ? 'gif' : 'jpg'));
    if (bytesMode()) {
      return blobBytes(blob).then(function (bytes) {
        if (!bytes) return false;
        return hostReady().then(function (ok) {
          if (!ok) return false;
          var covers = joinWinPath(dir, ['covers']);
          var coverPath = joinWinPath(covers, [id + '.' + ext]);
          return FS.host.writeBytes(coverPath, bytes)
            .then(function () { makeThumb(dir, coverPath, id); return true; })
            .catch(function () { return false; });
        });
      }).catch(function () { return false; });
    }
    return b64OfBlob(blob).then(function (b64) {
      if (!b64) return false;
      return hostReady().then(function (ok) {
        if (!ok) return false;
        var covers = joinWinPath(dir, ['covers']);
        var coverPath = joinWinPath(covers, [id + '.' + ext]);
        return FS.host.mkdir(covers)
          .then(function () { return FS.host.writeFile(coverPath, b64); })
          .then(function () { makeThumb(dir, coverPath, id); return true; })
          .catch(function () { return false; });
      });
    }).catch(function () { return false; });
  }
  /** v2.3.4 下载队列落盘（vrclib-data\download-queue.json） */
  function saveQueue(list) {
    return writeTextFile(jsonPath('download-queue.json'), JSON.stringify({ v: 1, at: nowISO(), tasks: list || [] }));
  }
  function loadQueue() {
    return readJsonFile(jsonPath('download-queue.json')).then(function (j) {
      return (j && Array.isArray(j.tasks)) ? j.tasks : [];
    }).catch(function () { return []; });
  }
  /** 磁盘上是否已有该素材的封面文件 */
  function coverExistsOnDisk(id, settings) {
    var dir = dataDir(settings);
    if (!dir || !id) return Promise.resolve(false);
    return hostReady().then(function (ok) {
      if (!ok) return false;
      var chain = Promise.resolve(false);
      ['png', 'jpg', 'webp', 'gif'].forEach(function (e) {
        chain = chain.then(function (hit) {
          if (hit) return true;
          return FS.host.exists(joinWinPath(dir, ['covers', id + '.' + e])).then(function (k) { return k === 'file'; }).catch(function () { return false; });
        });
      });
      return chain;
    }).catch(function () { return false; });
  }
  /** IndexedDB 缺封面时从磁盘读回；命中返回 Blob，否则 null */
  function loadCoverFile(id, settings) {
    var dir = dataDir(settings);
    if (!dir || !id) return Promise.resolve(null);
    return hostReady().then(function (ok) {
      if (!ok) return null;
      var exts = ['png', 'jpg', 'webp', 'gif'];
      var chain = Promise.resolve(null);
      exts.forEach(function (e) {
        chain = chain.then(function (hit) {
          if (hit) return hit;
          var p = joinWinPath(dir, ['covers', id + '.' + e]);
          return FS.host.exists(p).then(function (kind) {
            if (kind !== 'file') return null;
            var mime = e === 'png' ? 'image/png' : (e === 'webp' ? 'image/webp' : (e === 'gif' ? 'image/gif' : 'image/jpeg'));
            if (bytesMode()) {
              return FS.host.readBytes(p).then(function (bytes) {
                return new Blob([bytes], { type: mime });
              }).catch(function () { return null; });
            }
            return FS.host.readFileBase64(p).then(function (j) {
              var b64 = (j && (j.dataBase64 || j.base64)) || '';
              if (!b64) return null;
              var bin = atob(b64), arr = new Uint8Array(bin.length);
              for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
              return new Blob([arr], { type: mime });
            });
          }).catch(function () { return null; });
        });
      });
      return chain;
    }).catch(function () { return null; });
  }

  return {
    open: open,
    get isIDB() { return useIDB; },
    normalizeAsset: normalizeAsset, normalizeVersion: normalizeVersion, normalizeSource: normalizeSource,
    cleanShopField: cleanShopField,
    allAssets: allAssets, putAsset: putAsset, putAssets: putAssets,
    deleteAsset: deleteAsset, clearAll: clearAll,
    putCover: function (id, blob) {
      return putCover(id, blob).then(function (r) { try { saveCoverFile(id, blob, App.settings); } catch (e) {} return r; });
    },
    getCover: function (id) {
      return getCover(id).then(function (r) {
        if (r) return r;
        return loadCoverFile(id, App.settings).then(function (b) { return b ? { id: id, blob: b, mime: b.type } : null; });
      });
    },
    deleteCover: deleteCover, allCovers: allCovers,
    kvGet: kvGet, kvSet: kvSet, kvDel: kvDel,
    cacheGet: cacheGet, cacheSet: cacheSet, cacheDel: cacheDel, cacheClear: cacheClear, cacheCount: cacheCount,
    galleryGet: galleryGet, galleryAdd: galleryAdd, galleryClear: galleryClear, galleryAll: galleryAll,
    estimate: estimate, iconURL: iconURL,
    local: {
      DIRNAME: DATA_DIRNAME, htmlDir: htmlDir, dataDir: dataDir, jsonPath: jsonPath,
      loadAll: loadAll, saveAssets: saveAssets, saveSettings: saveSettings,
      saveCoverFile: saveCoverFile, loadCoverFile: loadCoverFile, coverExistsOnDisk: coverExistsOnDisk, settingsPayload: settingsPayload,
      saveQueue: saveQueue, loadQueue: loadQueue,
      lastWriteFail: lastWriteFailInfo,   // v3.0.0（D9）：最近一次写盘失败的结构化原因（too-large / host-offline / host-error）
      hostBodyLimit: hostBodyLimitInfo,   // v3.0.0（D9）：{limitBytes, wrap, cliffRawBytes} —— 前端护栏与宿主上限的联动锚点
      galleryDir: galleryDir, saveGalleryFile: saveGalleryFile, listGalleryFiles: listGalleryFiles, loadGalleryFile: loadGalleryFile
    }
  };
})();

