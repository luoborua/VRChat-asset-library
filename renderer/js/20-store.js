/*
 * 20-store.js —— 素材主库：素材、封面 Blob、目录句柄与设置的读写。
 *   真源是数据目录下的 library.db 与 settings.json，经 FS.host 读写；
 *   IndexedDB 只是缓存，再不可用则降级 LocalStorage（封面转 DataURL）。
 * 边界：只管存取与字段规范化，不做业务判断；写库后通知 App 同步到文件。
 */

var Store = (function () {
  var db = null;
  var useIDB = true;
  var assetsReadBroken = false;   // 主库读取有异常时为真：进入只读保护，禁止整库覆盖写

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
    // 单文件字段（fileName / url / path）一并折进 files[]，读盘时只认一种形状
    var files = Array.isArray(v.files) ? v.files.map(normalizeFile)
      : ((v.fileName || v.url || v.path) ? [normalizeFile({ name: v.fileName, url: v.url, size: v.size, path: v.path })] : []);
    var first = files[0] || {};
    return {
      id:       v.id || uid('ver'),
      name:     v.name || '',          // 版本名 / 变体名（如「ダウンロード版」「通常版」）
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

  /** 图集去重：同一张图的 /c/WxH/ 缩略版与原图视为一张，保留原图 */
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

  /** 变体名写着停售 / 售罄 / 下架 → 不参与计价与免费判定，但仍照常列出、可下载 */
  function isDeadVariantName(name) {
    return /販売停止|販売終了|贩售停止|停止销售|销售结束|已停售|売り切れ|売切|完売|品切れ|sold\s*out|discontinued|unavailable/i.test(String(name || ''));
  }

  /** 免费判定：价格文本优先，其次变体价，再次商店价；拿不到任何价格证据时返回 null（界面不显示丝带） */
  function deriveAssetIsFree(a, isBooth, shopPriceValue) {
    var d = derivePrice(a.price);
    if (typeof d.isFree === 'boolean') return d.isFree;
    // 免费与否按变体价判定：有变体价且全为 0 才算免费。
    // 停售 / 售罄变体不参与判定——作者常用 9,999,999 这类占位价，
    // 否则只剩免费变体的素材会被判成「付费」。
    var vers = (a.versions || []).filter(function (v) {
      if (!v) return false;
      // 停售且没买过（无订单链接）不算价格证据；买过的照常算
      if (isDeadVariantName(v.name) && !(v.orderUrl && String(v.orderUrl).trim())) return false;
      return true;   // 免费 / 特价变体（special）同样是「是否免费」的证据
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
    // 价格模型：purchasePrice / Currency 是用户手填的购买价（所有来源都可填）；
    // shopPrice / Value / Currency 是只读商品价（BOOTH 按变体算，其他来源取抓到的商店价）。
    // 早期数据只有 price 一个字段：BOOTH 视为商品价，其余来源视为购买价。
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
      cloudUrl:      typeof a.cloudUrl === 'string' ? a.cloudUrl : '',              // 网盘路径或分享链接
      downloadedFiles: Array.isArray(a.downloadedFiles) ? a.downloadedFiles.slice() : [],  // 成功下载过的文件名：后端与目录句柄都不可用时用来兜底按钮状态
      versions:      Array.isArray(a.versions) ? a.versions.map(normalizeVersion) : [],       // 版本 / 变体
      activeVersion: a.activeVersion || '',                                                   // 单个已购版本 id（多版本用 activeVersions）
      activeVersions: Array.isArray(a.activeVersions) ? uniq(a.activeVersions)
        : (a.activeVersion ? [a.activeVersion] : []),                                        // 已购买版本 id 集合（由 orderUrl 自动派生，保存时重算）
      category:      a.category || 'other',
      tags:          Array.isArray(a.tags) ? uniq(a.tags) : [],
      rawTags:       Array.isArray(a.rawTags) ? uniq(a.rawTags) : [],        // 原始（未翻译）标签
      description:   a.description || '',           // 商品简介（抓取所得，纯文本；界面上叫「商品简介」）
      // 图集按「店铺 / 商品 / 文件名」归一：同一张图的缩略路径与原图只留一张
      images:        dedupeImages(Array.isArray(a.images) ? a.images : []),
      coverURL:      a.coverURL || '',              // 外链封面（无本地封面时使用）
      hasCover:      !!a.hasCover,                  // 是否存在本地封面 Blob
      coverCleared:  !!a.coverCleared,              // 用户主动清除过封面：不再按商品 ID 从素材文件夹自动认领
      avatars:       Array.isArray(a.avatars) ? uniq(a.avatars) : [],        // 支持角色
      charNameZh:    a.charNameZh || '',          // 该素材作为角色模型时的中文角色名
      charNameJa:    a.charNameJa || '',
      charNameEn:    a.charNameEn || '',
      paths:         Array.isArray(a.paths) ? a.paths.slice() : [],          // 本地文件路径（多个）
      note:          a.note || '',
      author:        Store.cleanShopField(a.author, a.shopUrl),
      /* 商品价不入库：price / shopPrice* 一律清空，价格改由变体价现算，
       * 购买价 purchasePrice 继续保留。 */
      price: '', priceValue: null, currency: '', shopPrice: '', shopPriceValue: null, shopPriceCurrency: '',
      /* isFree 以变体价现算为准：若直接沿用存值，价格口径一变就会长期不一致，
       * 出现「标着免费却算得出非 0 价」的情况。只有拿不到任何价格证据时才沿用已存值。 */
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
      fileId:        String(a.fileId || '').trim().toUpperCase(),  // 素材编号：好友导出/导入判「同一份」用，见 fileIdOf；统一大写，比较时不会因大小写漏判
      hidden:        !!a.hidden,                    // 隐藏标记（不在默认列表中显示）
      trashAt:       Number(a.trashAt) || 0,         // 进回收站的时间戳：>0 表示已删除、只剩标记
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
        // 抓取结果缓存：同一商品链接不重复请求与解析
        if (!d.objectStoreNames.contains('fetchCache')) d.createObjectStore('fetchCache', { keyPath: 'url' });
        // 图集缓存：本体已落盘到数据目录的 gallery\，这里只留后端离线时的兜底
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

  /** 所有写库动作都要顺手标脏，让文件主库跟着重写。
   *  文件是启动时的数据源，只改 IndexedDB 的改动会在下次启动被文件里的数据盖回去
   *  （「删除素材后刷新又出现」就是这样）。放在 store 层做，调用点再多也不会漏。 */
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
      if (!lsWrite(d)) return Promise.reject(new Error('本地存储写入失败（空间不足）'));
      markFileDirty(); return Promise.resolve(a);
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
      if (!lsWrite(d)) return Promise.reject(new Error('本地存储写入失败（空间不足）'));
      markFileDirty(); return Promise.resolve(list.length);
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
    return new Promise(function (res, rej) {
      var settled = false;
      function fail(e) {
        if (settled) return; settled = true;
        Toast.err('删除素材失败，主库未更新：' + ((e && e.message) || '事务被中止'), 6000);
        rej(e || new Error('删除素材失败'));
      }
      t.oncomplete = function () { if (settled) return; settled = true; markFileDirty(); res(); };
      t.onerror = function () { fail(t.error); };
      t.onabort = function () { fail(t.error); };
    });
  }

  function clearAll() {
    if (!useIDB) { localStorage.removeItem(APP.lsKey); markFileDirty(); return Promise.resolve(); }
    var t = tx(['assets', 'covers'], 'readwrite');
    t.objectStore('assets').clear();
    t.objectStore('covers').clear();
    return new Promise(function (res, rej) {
      var settled = false;
      function fail(e) {
        if (settled) return; settled = true;
        Toast.err('清空素材库失败，主库未更新：' + ((e && e.message) || '事务被中止'), 6000);
        rej(e || new Error('清空素材库失败'));
      }
      t.oncomplete = function () { if (settled) return; settled = true; markFileDirty(); res(); };
      t.onerror = function () { fail(t.error); };
      t.onabort = function () { fail(t.error); };
    });
  }

  /* ---------------- 封面（Blob / DataURL） ---------------- */
  function putCover(id, blob) {
    if (!useIDB) {
      return fileToDataURL(blob).then(function (durl) {
        var d = lsRead(); d.covers[id] = durl;
        if (!lsWrite(d)) throw new Error('本地存储写入失败（空间不足）');
        return true;
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

  /* ---------------- 素材编号（好友导出 / 导入靠它认「是不是同一份」） ----------------
   * BOOTH 商品直接取商品编号（纯数字）；其余素材给「V + 8 位」，字母开头。
   * 两类不可能撞车（一个纯数字、一个字母打头），所以不必加前缀区分来源。
   * 编号生成后不再变，只有填了 BOOTH 链接才会被商品编号接管 —— 见 fileIdOf。 */
  var FILE_ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // 去掉 0/O/1/I/L：人工抄写不会认错
  var FILE_ID_LEN = 8;

  /* 本进程里已经发出去、但可能还没落盘的编号。
   * 调用方传进来的 taken 是「库里已有」的快照：一次导入几十条、连着新建几条时，
   * 先发的号还在内存里没进列表，taken 里查不到，光靠随机不撞只能叫「概率高」。
   * 发过的号先在这里占位，才谈得上确保不重复。进程重启即清空，不影响落盘数据。 */
  var fileIdReserved = Object.create(null);
  var fileIdSeq = 0;

  /** 比较用的归一化键：大小写不敏感（历史数据里可能被手改成小写） */
  function fileIdKey(id) { return String(id == null ? '' : id).trim().toUpperCase(); }

  /** 这个编号是否已经被占用：reserved（本进程已发）+ taken（外部传入的已占用表） */
  function isFileIdTaken(id, taken) {
    var k = fileIdKey(id);
    if (!k) return false;
    if (fileIdReserved[k]) return true;
    if (!taken) return false;
    if (taken[k]) return true;
    return !!(taken[String(id).trim()] || taken[k.toLowerCase()]);   // 兼容调用方传小写/带空格的键
  }

  /** 占位：外部带进来的编号（导入时沿用对方的号）也要登记，后续发号才不会撞它 */
  function reserveFileId(id) {
    var k = fileIdKey(id);
    if (k) fileIdReserved[k] = 1;
    return k;
  }

  /** 把数字按 alphabet 编成定长 FILE_ID_LEN 位（低位在右） */
  function encodeFileId(num) {
    var A = FILE_ID_ALPHABET, L = A.length, x = Math.abs(Math.floor(num)) || 0;
    var s = '';
    for (var i = 0; i < FILE_ID_LEN; i++) { s = A.charAt(x % L) + s; x = Math.floor(x / L); }
    return s;
  }

  /** 生成一个没被占用的编号；taken 是「已占用编号」表，可省略。
   *  两段式：先随机试 128 次（空间 32^8 ≈ 1.1e12，正常第一次就中）；
   *  万一连着撞（说明随机源异常或 taken 几乎满），改走「时间戳 + 自增序号」派生，
   *  逐号往上找空位 —— 这条兜底路径同样逐个查重，且仍是 V + 8 位定长，不再退化成不定长时间戳串。 */
  function newFileId(taken) {
    for (var n = 0; n < 128; n++) {
      var s = 'V';
      for (var i = 0; i < FILE_ID_LEN; i++) {
        s += FILE_ID_ALPHABET.charAt(Math.floor(Math.random() * FILE_ID_ALPHABET.length));
      }
      if (!isFileIdTaken(s, taken)) { fileIdReserved[s] = 1; return s; }
    }
    var salt = Date.now();
    for (var k = 0; k < 100000; k++) {
      fileIdSeq++;
      var cand = 'V' + encodeFileId(salt + fileIdSeq * 7919 + k * 104729);
      if (!isFileIdTaken(cand, taken)) { fileIdReserved[cand] = 1; return cand; }
    }
    /* 走到这里等于 32^8 个号全被占了，实际不可能；返回空让调用方按「无编号」处理，
     * 也绝不返回一个可能撞车的号去覆盖别人。 */
    return '';
  }

  /** 从 itemId / 链接里取 BOOTH 商品编号；没有就返回空串。
   *  链接要认 /ja/items/123、/zh-cn/items/123 这几种带语言段的写法。 */
  function boothIdOf(a) {
    if (!a) return '';
    var iid = String(a.itemId || '').trim();
    if (/^\d+$/.test(iid)) return iid;
    var urls = [];
    (a.links || []).forEach(function (l) { urls.push(String((l && l.url) || l || '')); });
    if (a.sourceURL) urls.push(String(a.sourceURL));
    if (a.shopUrl) urls.push(String(a.shopUrl));
    for (var i = 0; i < urls.length; i++) {
      var m = urls[i].match(/booth\.pm\/(?:[a-z-]+\/)?items\/(\d+)/i);
      if (m) return m[1];
    }
    return '';
  }

  /** 生效编号：有 BOOTH 商品编号就以它为准，否则用存下来的 fileId */
  function fileIdOf(a) {
    var booth = boothIdOf(a);
    if (booth) return booth;
    return String((a && a.fileId) || '').trim();
  }

  /** 给缺编号的记录补一个，并把「两条素材撞同一个编号」修掉；返回补过/改过的记录。
   *  返回值的 dups / boothDups 是这次的修正统计，供调用方决定要不要提示。 */
  function ensureFileIds(list) {
    var taken = Object.create(null);
    var fixed = [], dups = 0, boothDups = 0;
    (list || []).forEach(function (a) {
      if (!a) return;
      var eff = fileIdOf(a);
      var k = fileIdKey(eff);
      if (!k) {
        /* 完全没编号（既没 fileId 也没 BOOTH 商品号）：现发一个 */
        var f0 = newFileId(taken);
        if (!f0) return;
        taken[fileIdKey(f0)] = 1;
        a.fileId = f0;
        fixed.push(a);
        return;
      }
      if (!taken[k]) {
        taken[k] = 1;
        /* BOOTH 商品号也落一份到 fileId：日后把商品链接删掉了，身份还是它，不会重新随机 */
        if (!a.fileId) { a.fileId = eff; fixed.push(a); }
        return;
      }
      /* 撞号：两条不同素材共用一个编号。导入判重只看编号，这种情况会把后一条当成前一条，
       * 元数据互相覆盖 —— 所以先出现的保留，后面的重新发号。
       * 例外是 BOOTH 商品号：两条都是同一商品（用户选过「全部新增一条」），
       * 商品号是对外身份不能改，只记数交给调用方提示。 */
      if (boothIdOf(a)) { boothDups++; return; }
      var f = newFileId(taken);
      if (!f) return;                       // 号池异常（实际到不了）：保持原样，下次启动再修
      taken[fileIdKey(f)] = 1;
      a.fileId = f;
      fixed.push(a);
      dups++;
    });
    fixed.dups = dups;
    fixed.boothDups = boothDups;
    return fixed;
  }

  /* ---------------- 回收站（记录上打标记，48 小时后清） ----------------
   * 不另建一张表：删除只是给记录盖上 trashAt，记录仍留在主库里，
   * 因此重启、换数据目录、导出备份都不会把它弄丢。
   * 清理是「只扫标记过的记录 + 分批删」，见 trashPurge。 */
  var TRASH_TTL = 48 * 3600 * 1000;

  function isTrashed(a) { return !!(a && a.trashAt > 0); }

  function trashMarkMany(list) {
    var at = Date.now();
    var marked = (list || []).filter(function (a) { return a && a.id; }).map(function (a) {
      var n = normalizeAsset(a);
      n.trashAt = at;
      return n;
    });
    if (!marked.length) return Promise.resolve([]);
    return putAssets(marked).then(function () { return marked; });
  }

  function trashMark(asset) {
    if (!asset || !asset.id) return Promise.reject(new Error('没有可回收的素材'));
    return trashMarkMany([asset]).then(function (l) { return l[0]; });
  }

  function trashList() {
    return allAssets().then(function (list) {
      return list.filter(isTrashed).sort(function (a, b) { return (b.trashAt || 0) - (a.trashAt || 0); });
    });
  }

  function trashRestoreMany(ids) {
    var want = {}, out = [];
    (ids || []).forEach(function (id) { want[String(id)] = 1; });
    return allAssets().then(function (list) {
      var picked = list.filter(function (a) { return want[a.id] && isTrashed(a); });
      if (!picked.length) return [];
      picked.forEach(function (a) { delete a.trashAt; out.push(a); });
      return putAssets(picked).then(function () { return out; });
    });
  }

  function trashRestore(id) {
    return trashRestoreMany([id]).then(function (l) { return l[0] || null; });
  }

  /** 立刻彻底删掉一条（覆盖层里的「立刻删除」） */
  function trashDrop(id) { return deleteAsset(id).then(function () { return true; }); }

  /** 清空回收站：先列出来再分批删，避免一次事务塞太多 */
  function trashClear(opts) {
    opts = opts || {};
    var batch = Math.max(1, opts.batch || 30);
    var gap = opts.gap == null ? 30 : opts.gap;
    return trashList().then(function (list) {
      var ids = list.map(function (a) { return a.id; });
      var done = 0;
      function step(i) {
        if (i >= ids.length) return Promise.resolve(done);
        var slice = ids.slice(i, i + batch);
        return Promise.all(slice.map(function (id) {
          return deleteAsset(id).catch(function () {});
        })).then(function () {
          done += slice.length;
          return new Promise(function (r) { setTimeout(r, gap); }).then(function () { return step(i + batch); });
        });
      }
      return step(0);
    });
  }

  /** 过期清理：只检查标记过的记录，每批 batch 条、批间让出主线程，避免长任务卡界面 */
  function trashPurge(opts) {
    opts = opts || {};
    var batch = Math.max(1, opts.batch || 20);
    var gap = opts.gap == null ? 40 : opts.gap;
    var now = Date.now();
    var removed = 0;
    return allAssets().then(function (list) {
      var expired = list.filter(function (a) { return isTrashed(a) && (now - a.trashAt) > TRASH_TTL; });
      function step(i) {
        if (i >= expired.length) return Promise.resolve(removed);
        var slice = expired.slice(i, i + batch);
        return Promise.all(slice.map(function (a) {
          return deleteAsset(a.id).catch(function () {});
        })).then(function () {
          removed += slice.length;
          return new Promise(function (r) { setTimeout(r, gap); }).then(function () { return step(i + batch); });
        });
      }
      return step(0);
    });
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
  /** 全部图集缓存记录：把缓存搬到磁盘目录时逐条遍历用 */
  function galleryAll() {
    if (!useIDB) {
      var d = lsRead(), out = [];
      Object.keys(d.kv || {}).forEach(function (k) { if (k.indexOf('gal_') === 0) out.push(d.kv[k]); });
      return Promise.resolve(out);
    }
    return reqP(tx('gallery').objectStore('gallery').getAll()).then(function (rs) { return rs || []; }).catch(function () { return []; });
  }

  /* ---------------- 图集磁盘缓存：<数据目录>\gallery\<商品ID>\ ---------------- */
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
      // 过期顺手删掉：只判读不到而不删，抓取缓存会只增不减
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

  /** Blob → dataURL：图标缓存全程不清空，用 dataURL 才不必回收 objectURL，
   *  否则每张图标都会常驻一份 blob。 */
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
  /** 图标本地化：优先用缓存过的 Blob，没有再下载一次并缓存；返回可安全给 <img> 用的 URL */
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

  /* ================= 文件主库 =================
   * 位置：<数据目录>\{library.db | assets.json, settings.json, covers\<id>.<ext>}
   * 语义：文件为准，IndexedDB 降为缓存；后端离线时上层只能读缓存。
   * settings.json 刻意排除凭据类字段：Cookie / AI Key 只留在加密的键值存储里，不落明文。
   */
  var DATA_DIRNAME = 'vrclib-data';
  // 只排除凭据类字段；fuzzyDict 是普通词表，必须落盘
  var SETTINGS_SKIP = ['credentials', 'ai', 'githubToken'];   // Token 只留本机库

  function htmlDir() {
    try {
      /* 桌面壳由主进程直接给程序根目录：页面地址不是 file://，从 location 推不出文件系统路径。 */
      if (window.vrcElectron && window.vrcElectron.appRoot) return String(window.vrcElectron.appRoot);
      if (String(location.protocol) !== 'file:') return '';
      if (/[?&]nolocal=1\b/.test(String(location.search || ''))) return '';   // 冒烟/测试用：不在产物目录写 vrclib-data
      var p = decodeURIComponent(String(location.pathname || '')).replace(/^\/+/, '').replace(/\//g, '\\');
      var i = p.lastIndexOf('\\');
      return i > 0 ? p.slice(0, i) : '';
    } catch (e) { return ''; }
  }
  /** 配置目录：固定为 <程序根>\vrclib-data，**永远不搬**。
   *  因为 settings.json 里存着「数据放在哪」（localDataDir）这个指针本身，
   *  它要是跟着数据一起搬，下次启动就不知道该去哪个目录读配置了。 */
  function settingsDir() {
    try {
      if (window.vrcElectron && window.vrcElectron.settingsDir) return normalizeWinPath(window.vrcElectron.settingsDir);
    } catch (e) {}
    var d = htmlDir();
    return d ? joinWinPath(d, [DATA_DIRNAME]) : '';
  }
  function settingsPath() {
    var d = settingsDir();
    return d ? joinWinPath(d, ['settings.json']) : '';
  }
  /** 数据根：用户选过目录就用它，否则与配置同目录 */
  function dataDir(settings) {
    var custom = normalizeWinPath((settings || App.settings || {}).localDataDir || '');
    if (custom) return custom;
    return settingsDir();
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
  /* 后端写文件接口的请求体上限是 64 MB，base64 膨胀 4/3，原始 JSON 超过约 48 MiB 必然写不进去；
   * 而页面只看到「请求失败」，与后端离线无法区分，既说错原因又会白等一轮重试。
   * 所以在发送之前先按体积判死，并把结构化原因（too-large / host-offline / host-error）留给上层。
   * ⚠ HOST_BODY_LIMIT 必须与后端 readBody 的上限同步修改，前端只有这一处常数。 */
  var HOST_BODY_LIMIT = 67108864;     // 64 MB，与后端 readBody 的上限一致
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
  /** 读 JSON：失败时把原因塞进 errBox，缺文件不记。
   *  这条信息决定了「读不出来」能否与「首次运行」区分开——分不开，启动链就会把空列表写回主库。 */
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
    /* 能直接写字节就不绕 base64：没有膨胀，也就没有那条约 48 MiB 的体积悬崖；
     *  下面的预检只给只能走 base64 的载体兜底。 */
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
      return Promise.resolve(false);        // 体积超限是确定性失败，绝不重试：重试只会白等一轮超时
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
      if (k === 'v' || k === 'at' || k === 'settings') return;   // 外壳键不能再套一层写回去
      s[k] = src[k];
    });
    return s;
  }
  /** 加载文件主库 → {dir, assets, settings, ok, readErrors}。
   *  SQLite 模式下素材由 db 接口给出，返回结构与读 assets.json 时一致，
   *  上层的时间戳比较与只读保护因此不必区分载体。 */
  function dbMode() {
    try { return !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke); } catch (e) { return false; }
  }
  /** 后端能否直接读写原始字节；不能就只能走 base64 通道 */
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
  /** 封面一落盘就顺手生成缩略图；失败不影响封面本身 */
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
    assetsReadBroken = false;   // 每次重读都重新判定，读干净了就解除只读
    try { if (typeof App !== 'undefined' && App) App.assetsReadBroken = false; } catch (e) {}
    if (!dir) return Promise.resolve({ dir: '', ok: false, assets: null, settings: null, readErrors: [] });
    var errs = [];
    if (dbMode()) {
      return Promise.all([
        FS.host.db('load'),
        readJsonFile(settingsPath(), errs)
      ]).then(function (r) {
        var db = r[0] || {};
        var count = Number(db.count) || 0;
        /* count=0 当作首次运行（assets=null），让启动链走首次运行分支，而不是拿空列表回写主库 */
        var assetsFile = count > 0 ? { v: 1, at: db.at || '', assets: db.assets || [] } : null;
        var skipped = Number(db.skipped) || 0, warning = String(db.warning || '');
        if (warning || skipped > 0) {
          assetsReadBroken = true;
          try { if (typeof App !== 'undefined' && App) App.assetsReadBroken = true; } catch (e) {}
          var why = warning || (skipped + ' 条记录无法解析');
          errs.push('素材主库：' + why);
          Toast.err('素材主库读取异常，已暂停写入以防覆盖：' + why + '。请先导出备份再处理', 9000);
        }
        return { dir: dir, assets: assetsFile, settings: r[1], ok: !!(assetsFile || r[1]), readErrors: errs };
      }).catch(function (e) {
        errs.push('素材库数据库：' + ((e && e.message) || e));
        return { dir: dir, assets: null, settings: null, ok: false, readErrors: errs };
      });
    }
    return Promise.all([
      readJsonFile(joinWinPath(dir, ['assets.json']), errs),
      readJsonFile(settingsPath(), errs)
    ]).then(function (r) {
      return { dir: dir, assets: r[0], settings: r[1], ok: !!(r[0] || r[1]), readErrors: errs };
    });
  }
  function saveAssets(list, settings) {
    if (assetsReadBroken) {   // 只读保护：主库读不干净时绝不整库覆盖写
      noteWriteFail('db-error', { error: '素材主库读取异常，已暂停整库写入' });
      return Promise.resolve(false);
    }
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
    return writeTextFile(settingsPath(), JSON.stringify({ v: 1, at: nowISO(), settings: settingsPayload(settings) }, null, 1));
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
  /** 下载队列落盘：<数据目录>\download-queue.json */
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
    newFileId: newFileId, fileIdOf: fileIdOf, boothIdOf: boothIdOf, ensureFileIds: ensureFileIds,
    isFileIdTaken: isFileIdTaken, reserveFileId: reserveFileId, fileIdKey: fileIdKey,
    allAssets: allAssets, putAsset: putAsset, putAssets: putAssets,
    deleteAsset: deleteAsset, clearAll: clearAll,
    TRASH_TTL: TRASH_TTL, isTrashed: isTrashed,
    trashMark: trashMark, trashMarkMany: trashMarkMany, trashList: trashList,
    trashRestore: trashRestore, trashRestoreMany: trashRestoreMany,
    trashDrop: trashDrop, trashClear: trashClear, trashPurge: trashPurge,
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
      DIRNAME: DATA_DIRNAME, htmlDir: htmlDir, settingsDir: settingsDir, settingsPath: settingsPath,
      dataDir: dataDir, jsonPath: jsonPath,
      loadAll: loadAll, saveAssets: saveAssets, saveSettings: saveSettings,
      saveCoverFile: saveCoverFile, loadCoverFile: loadCoverFile, coverExistsOnDisk: coverExistsOnDisk, settingsPayload: settingsPayload,
      saveQueue: saveQueue, loadQueue: loadQueue,
      lastWriteFail: lastWriteFailInfo,   // 最近一次写盘失败的结构化原因，供上层区分超限与离线
      hostBodyLimit: hostBodyLimitInfo,   // {limitBytes, wrap, cliffRawBytes}：前端护栏与后端上限的联动锚点
      galleryDir: galleryDir, saveGalleryFile: saveGalleryFile, listGalleryFiles: listGalleryFiles, loadGalleryFile: loadGalleryFile
    }
  };
})();

