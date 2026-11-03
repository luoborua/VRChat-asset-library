/* ============ 30-fetch.js ============ */
/* =====================================================================
 * 30-fetch.js  —  信息获取与解析（可插拔）
 *
 *  抓取方式（用户可在设置中切换，默认手动粘贴）：
 *    手动粘贴源码：不发起任何外部请求，纯本地离线解析（默认）
 *    内置宿主联网：全部外部请求由本机 VRCLibHost 发起，不再使用任何 CORS 代理
 *
 *  解析产物结构参考 BoothPM-SDK 的商品数据模型：
 *    { itemId, originalTitle(name), description, price/priceValue/currency/isFree,
 *      images[], coverURL, tags[], author, shop, shopUrl, sourceId }
 * ===================================================================== */

var Net = (function () {

  /** 宿主离线时的统一失败结果（页面无宿主仍可用手动粘贴，联网功能受限） */
  function hostOffline(log, tried) {
    log('\u26A0 内置宿主（VRCLibHost）未启动。联网抓取 / Cookie 已购识别 / AI 翻译都需要宿主。');
    log('  请重启程序（关闭窗口后重新双击「启动素材库_Electron版.bat」）再试；手动粘贴源码不受影响。');
    return Promise.resolve({ ok: false, tried: tried, reason: 'host-offline' });
  }

  /** 取得该域名下用户手动录入的 Cookie（异步解密；账号密码不再存储） */
  function credFor(url) {
    var host = hostOf(url);
    var creds = (App.settings.credentials) || {};
    var hit = creds[host];
    if (!hit) {
      var keys = Object.keys(creds);
      for (var i = 0; i < keys.length; i++) {
        if (host && (host === keys[i] || host.slice(-(keys[i].length + 1)) === '.' + keys[i])) { hit = creds[keys[i]]; break; }
      }
    }
    if (!hit || !hit.cookie) return Promise.resolve(null);
    return Secure.decrypt(hit.cookie).then(function (cookie) { return cookie ? { cookie: cookie } : null; });
  }

  /** 当前是否允许联网抓取（host 模式才允许；Cookie 按钮可用 forceNetwork 临时放行） */
  function networkAllowed() { return (App.settings.fetchMode || 'paste') !== 'paste'; }

  /** 兼容旧调用（代理通道已移除，联网统一由内置宿主负责） */
  function buildChain() { return []; }

  /**
   * 抓取文本内容。返回 {ok, text, via, tried:[], reason}
   */
  function fetchText(url, opts) {
    opts = opts || {};
    var log = opts.onLog || function () {};

    // 用户显式点击「用 Cookie 联网获取」时，即便处于手动粘贴模式也允许联网（forceNetwork）
    if (!networkAllowed() && !opts.forceNetwork) {
      log('\u{1F6E1} 当前为「手动粘贴源码」模式，工具不会发起任何外部请求。');
      return Promise.resolve({ ok: false, tried: [], reason: 'paste-mode' });
    }
    if (opts.forceNetwork) log('\u{1F510} 已按你的要求使用 Cookie 联网获取（仅由内置宿主发起请求）');

    var tried = [{ name: '内置宿主', ok: false, error: '' }];
    return credFor(url).then(function (cred) {
      return FS.hostEnsure().then(function (hostOk) {
        if (!hostOk) return hostOffline(log, tried);
        log('\u{1F5A5} 内置宿主通道：由 VRCLibHost 发起请求（不再使用任何代理）');
        var hdrs = opts.headers ? Object.assign({}, opts.headers) : {};   // v2.3.22：允许调用方带自定义头（如 GitHub API 的 Accept）
        if (cred && cred.cookie) hdrs.Cookie = cred.cookie;
        return FS.host.fetchURL(url, hdrs).then(function (j) {
          if (!j || !j.okFlag) throw new Error('HTTP ' + ((j && j.status) || 0));
          var text = String((j && j.text) || '');
          if (text.length < 40) throw new Error('返回内容为空');
          tried[0].ok = true; tried[0].error = '';
          log('\u2714 内置宿主抓取成功（' + fmtSize(text.length) + '）');
          return { ok: true, text: text, via: '内置宿主', tried: tried };
        }).catch(function (e) {
          tried[0].error = String(e.message || e);
          log('\u2716 内置宿主抓取失败：' + (e.message || e));
          return { ok: false, tried: tried, reason: 'host-failed' };
        });
      });
    });
  }

  /** 抓取二进制（封面图）。图片可直接由 <img> 显示，即使手动粘贴模式下也允许浏览器尝试直连下载 */
  function fetchBlob(url, opts) {
    opts = opts || {};
    var log = opts.onLog || function () {};
    return fetch(url, { mode: 'cors' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (b) {
      if (!b || b.size < 64) throw new Error('图片为空');
      log('\u2714 封面图下载成功（' + fmtSize(b.size) + '，直连）');
      return b;
    }).catch(function (e) {
      log('\u26A0 封面图直连下载失败：' + (e.message || e));
      return null;
    });
  }

  return {
    fetchText: fetchText, fetchBlob: fetchBlob,
    credFor: credFor, networkAllowed: networkAllowed, buildChain: buildChain
  };
})();


/* =====================================================================
 * 站点解析策略（可插拔）
 *   Fetchers.register({ id, name, sourceId, match(url), fetch(url,ctx), parse(text,url) })
 * ===================================================================== */
var Fetchers = (function () {
  var list = [];

  function register(f) { list.push(f); return f; }
  function detect(url) {
    for (var i = 0; i < list.length; i++) { if (list[i].match && list[i].match(url)) return list[i]; }
    return list[list.length - 1];
  }

  /** 统一的空结构（对齐 BoothPM-SDK 商品模型） */
  function emptyInfo() {
    return {
      itemId: '', originalTitle: '', description: '',
      price: '', priceValue: null, currency: '', isFree: null,
      images: [], coverURL: '', tags: [],
      author: '', shop: '', shopUrl: '', category: '', categoryId: '', sourceId: '',
      publishedAt: '', shopUpdatedAt: '',
      downloadLinks: [], versions: [], sourceURL: '',
      r18: false
    };
  }

  /** HTML → 纯文本：块级元素换行、链接前加空格，避免 URL 与文字粘连 */
  function htmlToText(html) {
    var s = String(html || '');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|li|h\d|section|article|tr)>/gi, '\n');
    s = s.replace(/<li[^>]*>/gi, '\n\u2022 ');
    s = s.replace(/<a\s[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, function (m, href, txt) {
      var t = txt.replace(/<[^>]+>/g, '');
      return (t.trim() ? t.trim() + ' ' : '') + href;
    });
    s = s.replace(/<[^>]+>/g, ' ');
    var ta = document.createElement('textarea');
    ta.innerHTML = s;
    s = ta.value;
    return s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** 店铺名清洗：作者/店铺字段不应是 URL 或站名 */
  function sanitizeShop(info) {
    [['shop'], ['author']].forEach(function (pair) {
      var k = pair[0];
      var v = String(info[k] || '').trim();
      if (/^https?:\/\//i.test(v)) {
        var host = hostOf(v);
        if (host && !/^(booth\.pm|gumroad\.com)$/i.test(host)) {
          info[k] = host.replace(/\.booth\.pm$|\.gumroad\.com$/i, '');
        } else {
          info[k] = '';
        }
      } else if (/^(booth\.pm|gumroad\.com|booth|gumroad)$/i.test(v)) {
        info[k] = '';
      }
    });
    if (!info.author && info.shop) info.author = info.shop;
    if (!info.shop && info.author) info.shop = info.author;
    return info;
  }

  /**
   * 标签清洗：剔除平台名 / 站点导航词 / 角色名 / 与素材属性无关的噪声。
   * 例如 BOOTH 页面 meta keywords 里的 booth、ブース、pixiv 都会被过滤掉。
   */
  function cleanTags(tags, ctx) {
    ctx = ctx || {};
    if (!App.settings.tagFilterEnabled) {
      return uniq((tags || []).map(function (t) { return String(t).trim().replace(/^#/, ''); }).filter(Boolean));
    }
    var stop = (typeof Smart !== 'undefined' && Smart.blacklistSet) ? Smart.blacklistSet() : Object.create(null);
    // 店铺名 / 作者名本身不是素材属性
    [ctx.shop, ctx.author].forEach(function (n) { if (n) { stop[String(n).toLowerCase().trim()] = 1; if (Smart.normalizeTagToken) stop[Smart.normalizeTagToken(n)] = 1; } });
    // 支持角色名称（含日/英/中别名）应从标签里剔除——角色归属走「支持角色」字段
    var avAlias = Object.create(null);
    (App.allAvatars() || []).forEach(function (av) {
      [av.label].concat(av.alias || []).forEach(function (n) {
        var s = String(n || '').trim().toLowerCase();
        if (s.length > 1) { avAlias[s] = 1; if (Smart.normalizeTagToken) avAlias[Smart.normalizeTagToken(s)] = 1; }
      });
    });
    // 链接所在站点域名也不是标签
    if (ctx.url) {
      var h = hostOf(ctx.url);
      if (h) { stop[h.toLowerCase()] = 1; h.split('.').forEach(function (part) { if (part.length > 2) stop[part.toLowerCase()] = 1; }); }
    }
    var seen = Object.create(null), out = [];
    (tags || []).forEach(function (raw) {
      var t = String(raw == null ? '' : raw).trim().replace(/^[#＃]+/, '').replace(/\s+/g, ' ');
      if (!t) return;
      if (t.length > 24) return;                      // 过长的多半是句子而非标签
      if (/^\d+$/.test(t)) return;                    // 纯数字
      if (/https?:|[<>@|]/.test(t)) return;           // 链接 / 非法字符
      var low = t.toLowerCase();
      var norm = Smart.normalizeTagToken ? Smart.normalizeTagToken(t) : low;
      if (stop[low] || stop[norm]) return;
      if (Smart.isBlacklisted && Smart.isBlacklisted(t)) return;
      // 角色名等价变体（含 対応/向け/用/版/衣装/改変 等后缀）→ 走「支持角色」字段
      if (avAlias[low] || avAlias[norm] || (Smart.isAvatarEquivalent && Smart.isAvatarEquivalent(t))) return;
      if (seen[low]) return;
      seen[low] = 1; out.push(t);
    });
    return out.slice(0, 30);
  }

  /** 规范化：补齐价格衍生字段、去重图集、清洗标签、店铺名清洗 */
  function finalize(info) {
    sanitizeShop(info);
    var p = derivePrice(info.price);
    if (info.priceValue == null) info.priceValue = p.value;
    if (!info.currency) info.currency = p.currency;
    if (info.isFree == null) info.isFree = p.isFree;
    // R-18 识别：BOOTH 官方 is_adult 优先；否则只看标题/分类/标签，不再看简介——
    // 简介里出现“可用于 R-18 作品/利用规约”这类表述不代表商品本身是成人向（曾误标 3390957）。
    if (info.r18 !== true) {
      var r18Hay = [info.originalTitle, info.category].concat(info.tags || []).join(' ');
      info.r18 = /(?:^|[^a-z0-9])(?:r-?18|18禁|成人向け|adult(?:[- ]only)?)(?:[^a-z0-9]|$)/i.test(r18Hay);
    }
    info.images = uniq((info.images || []).filter(function (u) {
      var s = String(u);
      if (!s) return false;
      // BOOTH 的原图文件名以 _base_resized.jpg 结尾，但它是大图，必须保留。
      // 真正的缩略图是 /c/72x72_xxx 这类带尺寸前缀的路径。
      if (/\/c\/\d+x\d+_/i.test(s)) return false;
      if (/(^|[\/_.-])thumbnail([\/_.-]|$)/i.test(s)) return false;
      return true;
    }));
    /* v2.5.2：BOOTH 同一张图常给两个 URL——/c/620x620/<shop>/i/<item>/<file> 与 /<shop>/i/<item>/<file>，
     * 以前只按字符串去重 → 图集里同一张图出现两次（实测 1 条素材命中）。这里按「店铺/商品/文件名」归一，优先保留原图。 */
    (function () {
      function key(u) {
        var s = String(u || '').split('#')[0].split('?')[0].replace(/\/c\/\d+x\d+\//, '/');
        var m = s.match(/\/([0-9a-f-]{8,})\/i\/(\d+)\/([^/]+)$/i);
        return m ? (m[1] + '|' + m[2] + '|' + m[3].toLowerCase()) : s.toLowerCase();
      }
      function sized(u) { return /\/c\/\d+x\d+\//.test(String(u || '')); }
      var best = Object.create(null), order = [];
      info.images.forEach(function (u) {
        var k = key(u);
        if (!(k in best)) { best[k] = u; order.push(k); return; }
        if (sized(u) && !sized(best[k])) return;   // 已有原图 → 丢弃缩略版
        if (!sized(u)) best[k] = u;                // 当前是原图 → 顶掉缩略版
      });
      info.images = order.map(function (k) { return best[k]; });
    })();
    if (!info.coverURL && info.images.length) info.coverURL = info.images[0];
    info.tags = cleanTags(info.tags, { shop: info.shop, author: info.author, url: info.sourceURL });
    info.description = String(info.description || '').replace(/[ \t]+/g, ' ').trim().slice(0, 12000);
    info.versions = Array.isArray(info.versions) ? info.versions : [];
    return info;
  }

  /** 从 BOOTH 的 variations 里提取版本 / 变体与可下载文件 */
  function extractVariations(d, currencyCode) {
    var versions = [], links = [];
    if (!d || !Array.isArray(d.variations)) return { versions: versions, links: links };
    /* v2.5.14：variations[].price 是**裸数字**，String() 之后没有币种。调用方（BOOTH 商品页）传入店铺币种补上，
     * 否则写回变体后详情页只能按空币种兜底 —— 旧实现默认 CNY，于是 1680 日元的变体显示成「CNY 1,680」。 */
    var shopCur = String(currencyCode || '');
    d.variations.forEach(function (v) {
      if (!v || typeof v !== 'object') return;
      var vname = v.name || v.title || '';
      var vprice = (v.price != null) ? String(v.price) : '';
      if (vprice && shopCur && !/[¥￥$€]|JPY|USD|EUR|CNY|RMB|円|元/i.test(vprice)) vprice += ' ' + shopCur;
      var files = [];
      // downloadable 可能是 { no_musics: [...] } / { musics: [...] } 之类的结构，统一深挖一层
      var dl = v.downloadable;
      if (dl && typeof dl === 'object') {
        Object.keys(dl).forEach(function (k) {
          if (Array.isArray(dl[k])) dl[k].forEach(function (f) { if (f && typeof f === 'object') files.push(f); });
        });
      }
      var verFiles = files.map(function (f) {
        var fname = f.name || f.file_name || '';
        var furl = f.url || (f.id ? 'https://booth.pm/downloadables/' + f.id : '');
        if (furl) links.push({ url: furl, label: fname || vname || '下载', variation: vname });
        return { name: fname, url: furl, size: Number(f.file_size || f.size || 0) || 0 };
      });
      versions.push({
        name: vname || (verFiles.length ? verFiles[0].name : '') || '（默认）',
        price: vprice,
        files: verFiles,
        fileName: verFiles.length ? verFiles[0].name : '',
        url: verFiles.length ? verFiles[0].url : '',
        size: verFiles.reduce(function (s, f) { return s + (f.size || 0); }, 0)
      });
    });
    return { versions: versions, links: links };
  }

  /* ---------- 通用 HTML 解析（og / twitter / ld+json / meta） ---------- */
  function parseGeneric(text, url) {
    var info = emptyInfo();
    info.sourceURL = url || '';
    var doc;
    try { doc = new DOMParser().parseFromString(text, 'text/html'); } catch (e) { return finalize(info); }
    function meta(sel, attr) {
      var n = doc.querySelector(sel);
      return n ? (n.getAttribute(attr || 'content') || '').trim() : '';
    }
    info.originalTitle = meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]') ||
      (doc.querySelector('title') ? doc.querySelector('title').textContent.trim() : '');
    info.coverURL = meta('meta[property="og:image"]') || meta('meta[property="og:image:secure_url"]') ||
      meta('meta[name="twitter:image"]') || '';
    info.description = htmlToText(meta('meta[property="og:description"]') || meta('meta[name="description"]') || '');
    // 页面标题常带「- 店名 - BOOTH」后缀，商品名应去掉站点后缀
    if (info.originalTitle) {
      info.originalTitle = info.originalTitle
        .replace(/\s*[-–—|]\s*(BOOTH|Gumroad|pixiv)\s*$/i, '')
        .replace(/\s*[-–—|]\s*[^|]{2,40}\s*[-–—|]\s*BOOTH\s*$/i, '')
        .trim();
    }
    var kw = meta('meta[name="keywords"]');
    if (kw) info.tags = kw.split(/[,\uFF0C]/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 24);

    var scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length; i++) {
      var data = safeJSON(scripts[i].textContent, null);
      if (!data) continue;
      var arr = Array.isArray(data) ? data : (data['@graph'] ? data['@graph'] : [data]);
      for (var j = 0; j < arr.length; j++) {
        var o = arr[j]; if (!o || typeof o !== 'object') continue;
        var t = o['@type'];
        if (t === 'Product' || (Array.isArray(t) && t.indexOf('Product') >= 0)) {
          if (o.name) info.originalTitle = info.originalTitle || String(o.name);
          if (o.sku || o.productID) info.itemId = info.itemId || String(o.sku || o.productID);
          if (o.image) {
            var im = Array.isArray(o.image) ? o.image : [o.image];
            im.forEach(function (x) { var u = typeof x === 'string' ? x : (x && x.url); if (u) info.images.push(u); });
          }
          if (o.description) info.description = info.description || htmlToText(String(o.description));
          if (o.brand) info.author = info.author || (typeof o.brand === 'string' ? o.brand : (o.brand.name || ''));
          if (o.category) info.category = info.category || String(o.category);
          if (o.offers) {
            var of = Array.isArray(o.offers) ? o.offers[0] : o.offers;
            if (of && of.price != null) {
              info.priceValue = parseFloat(of.price);
              info.currency = of.priceCurrency || '';
              info.price = (of.priceCurrency ? of.priceCurrency + ' ' : '') + of.price;
              info.isFree = info.priceValue === 0;
            }
          }
        }
      }
    }
    var imgs = doc.querySelectorAll('img');
    for (var k = 0; k < imgs.length && info.images.length < 16; k++) {
      var s = imgs[k].getAttribute('src') || imgs[k].getAttribute('data-src') || '';
      if (s && /^https?:/i.test(s) && !/icon|logo|avatar|sprite|blank|placeholder/i.test(s)) info.images.push(s);
    }
    return finalize(info);
  }

  /* ---------- BOOTH ---------- */
  var boothFetcher = register({
    id: 'booth',
    name: 'BOOTH',
    sourceId: 'booth',
    match: function (url) { return /(^|\.)booth\.pm/i.test(hostOf(url)); },
    itemId: function (url) { var m = String(url).match(/\/items\/(\d+)/); return m ? m[1] : ''; },
    /** 商品 JSON 接口地址（也用于「手动粘贴」模式下引导用户复制哪个页面） */
    jsonURL: function (url) {
      var id = boothFetcher.itemId(url);
      return id ? 'https://booth.pm/ja/items/' + id + '.json' : '';
    },
    fetch: function (url, ctx) {
      var log = (ctx && ctx.onLog) || function () {};
      var id = boothFetcher.itemId(url);
      var self = this;
      if (!id) { log('\u26A0 未能从链接中解析出 BOOTH 商品 ID，改用通用解析'); return genericFetch(url, ctx); }
      var jsonURL = self.jsonURL(url);
      log('检测到 BOOTH 商品 ID：' + id + '，优先请求官方 JSON 接口');
      return Net.fetchText(jsonURL, ctx).then(function (r) {
        if (r.ok) {
          var data = safeJSON(r.text, null);
          if (data && (data.name || data.id)) { log('\u2714 BOOTH JSON 解析成功'); return self.parseJSON(data, url); }
          log('\u26A0 JSON 接口返回内容异常，改抓商品页 HTML');
        } else if (r.reason === 'paste-mode' || r.reason === 'no-channel') {
          return { __failed: true, reason: r.reason, hint: jsonURL };
        }
        return Net.fetchText(url, ctx).then(function (r2) {
          if (!r2.ok) return { __failed: true, tried: r2.tried, reason: r2.reason, hint: jsonURL };
          return self.parse(r2.text, url);
        });
      });
    },
    /** 解析 BOOTH items/<id>.json（字段命名对齐 BoothPM-SDK 的商品模型） */
    parseJSON: function (d, url) {
      var info = emptyInfo();
      info.sourceId = 'booth';
      info.itemId = String(d.id || boothFetcher.itemId(url || '') || '');
      info.originalTitle = d.name || '';
      if (Array.isArray(d.images)) {
        // 只收录原图，不收录 resized 缩略图
        d.images.forEach(function (im) { if (im && im.original) info.images.push(im.original); });
      }
      if (Array.isArray(d.tags)) info.tags = d.tags.map(function (t) { return (t && (t.name || t)) || ''; }).filter(Boolean);
      if (d.category && d.category.name) {
        info.category = d.category.name;
        info.categoryId = (typeof Smart !== 'undefined' && Smart.mapShopCategory) ? Smart.mapShopCategory(d.category.name) : '';
        info.tags.push(d.category.name);
      }
      if (d.price != null) info.price = String(d.price);
      // v2.5.14：BOOTH 内嵌 JSON 的 price 是裸数字 —— 不补币种的话，落库后会被当成「未知币种」
      if (info.price && !/[¥￥$€]|JPY|USD|EUR|CNY|RMB|円|元/i.test(info.price)) info.price += ' JPY';
      if (d.published_at) info.publishedAt = String(d.published_at);
      if (d.updated_at) info.shopUpdatedAt = String(d.updated_at);
      if (d.is_adult === true) info.r18 = true;
      if (d.shop) {
        info.shop = d.shop.name || '';
        info.author = d.shop.name || '';
        info.shopUrl = d.shop.url || '';
      }
      if (d.description) info.description = htmlToText(d.description);
      info.sourceURL = url || (info.itemId ? 'https://booth.pm/ja/items/' + info.itemId : '');
      // 变体 / 版本（BOOTH 的下载文件挂在 variations 上，已购买时才会带出下载直链）
      var ex = extractVariations(d, 'JPY');   // BOOTH 一律日元
      info.versions = ex.versions;
      info.downloadLinks = info.downloadLinks.concat(ex.links);
      if (!info.price && ex.versions.length && ex.versions[0].price) info.price = ex.versions[0].price;
      // 版本信息也常写在简介末尾（更新履历 / v1.2 等），一并解析
      if (!info.versions.length && info.description && typeof Smart !== 'undefined' && Smart.extractVersionsFromText) {
        var vFromDesc = Smart.extractVersionsFromText(info.description);
        if (vFromDesc.length) info.versions = vFromDesc;
      }
      return finalize(info);
    },
    parse: function (text, url) {
      var info = parseGeneric(text, url);
      info.sourceId = 'booth';
      info.sourceURL = url || '';
      info.itemId = info.itemId || boothFetcher.itemId(url || '');
      var doc; try { doc = new DOMParser().parseFromString(text, 'text/html'); } catch (e) { doc = null; }
      if (doc) {
        // og:description 常被截断，优先取商品页里的完整描述区块
        var descNode = doc.querySelector('.item-description, .item-description__inner, [class*="item-description"], [class*="description"]');
        if (descNode && descNode.innerHTML && descNode.innerHTML.length > (info.description || '').length) {
          info.description = htmlToText(descNode.innerHTML);
        }
        if (!info.versions.length && info.description) {
          info.versions = Smart.extractVersionsFromText(info.description);
        }
        // 只取真正的商品标签区域：BOOTH 的标签链接指向 /search/<tag> 或带 tag= 参数
        var tagNodes = doc.querySelectorAll('.tag-banner-item, .item-tag a, a[href*="/search/"], a[href*="tag="]');
        var tags = [];
        for (var i = 0; i < tagNodes.length && tags.length < 24; i++) {
          var t = (tagNodes[i].textContent || '').trim().replace(/^[#＃]+/, '');
          if (t && t.length <= 24) tags.push(t);
        }
        if (tags.length) info.tags = uniq(info.tags.concat(tags));
        var shopNode = doc.querySelector('.shop-name, .u-tpg-caption1 a, [class*="shop"] a');
        if (shopNode) {
          info.shop = info.author = (shopNode.textContent || '').trim();
          if (shopNode.getAttribute) info.shopUrl = shopNode.getAttribute('href') || '';
        }
        var priceNode = doc.querySelector('.price, [class*="price"]');
        if (priceNode && !info.price) info.price = (priceNode.textContent || '').trim().slice(0, 24);
        var dl = doc.querySelectorAll('a[href*="/downloadables/"]');
        for (var j = 0; j < dl.length; j++) {
          info.downloadLinks.push({ url: dl[j].href, label: (dl[j].textContent || '下载').trim().slice(0, 40) });
        }
      }
      return finalize(info);
    }
  });

  /* ---------- Gumroad ---------- */
  /** Gumroad SPA 数据：商品页 / 订单页统一放在 div#app[data-page]；旧订单页在 script[data-component-name] */
  function gumroadPageData(doc) {
    if (!doc) return null;
    var node = doc.querySelector('div#app[data-page]');
    var raw = node ? (node.getAttribute('data-page') || '') : '';
    var d = raw ? safeJSON(raw, null) : null;
    if (!d) {
      var comp = doc.querySelector('script[data-component-name]');
      if (comp && comp.textContent) d = safeJSON(comp.textContent, null);
    }
    return d && typeof d === 'object' ? d : null;
  }
  /** cents + 币种代码 → 价格对象（页面统一用 App.priceText 的文本格式） */
  function gumroadPrice(cents, currencyCode) {
    var n = Number(cents);
    if (!isFinite(n)) return null;
    var cur = String(currencyCode || 'usd').toUpperCase();
    return { value: n / 100, currency: cur, text: App.priceText(n / 100, cur) };
  }
  /** 订单/下载页里的 content_items → 文件列表（相对下载地址统一补全为 gumroad.com 绝对地址） */
  function gumroadContentFiles(content) {
    var out = [];
    (Array.isArray(content && content.content_items) ? content.content_items : []).forEach(function (f) {
      if (!f || typeof f !== 'object') return;
      var u = f.external_link_url || f.download_url || f.stream_url || f.read_url || '';
      if (!u) return;
      if (/^\//.test(u)) u = 'https://gumroad.com' + u;
      var extRaw = String(f.extension || '').replace(/^\./, '');
      var ext = extRaw.toLowerCase();
      var name = String(f.file_name || f.name || '下载文件').replace(/\s+/g, ' ').trim();
      if (ext && name.toLowerCase().indexOf('.' + ext) !== name.length - ext.length - 1) name = name + '.' + extRaw;
      out.push({ name: name, url: u, size: Number(f.file_size || f.content_length || 0) || 0, source: f.external_link_url ? 'external' : 'order' });
    });
    return out;
  }
  /** Gumroad options（变体）→ 版本列表（只含商品页公开信息；购买/订单链接由后续订单解析补充） */
  function gumroadOptionVersions(prod) {
    if (!prod || !Array.isArray(prod.options) || !prod.options.length) return [];
    var cur = String(prod.currency_code || 'usd').toUpperCase();
    var base = Number(prod.price_cents) || 0;
    return prod.options.map(function (o, i) {
      var cents = base + (Number(o.price_difference_cents) || 0);
      var money = gumroadPrice(cents, cur);
      return {
        id: 'ver_gumroad_' + (o.id || i) + '_' + Date.now().toString(36),
        name: o.name || '（默认）',
        variationId: String(o.id || ''),
        price: money ? money.text : '',
        priceValue: money ? money.value : null,
        priceCurrency: money ? money.currency : '',
        note: o.description || '',
        special: cents === 0 || /免费|free/i.test(String(o.name || '')),
        orderUrl: '', files: []
      };
    });
  }

  var gumroadFetcher = register({
    id: 'gumroad',
    name: 'Gumroad',
    sourceId: 'gumroad',
    match: function (url) { return /gumroad\.com/i.test(hostOf(url)); },
    fetch: function (url, ctx) { return genericFetch(url, ctx, 'gumroad'); },
    parse: function (text, url) {
      var info = parseGeneric(text, url);
      info.sourceId = 'gumroad';
      info.sourceURL = url || '';
      var doc; try { doc = new DOMParser().parseFromString(text, 'text/html'); } catch (e) { doc = null; }
      var d = gumroadPageData(doc);
      var props = (d && d.props) || (d || {});
      var prod = props.product || {};
      if (prod && typeof prod === 'object') {
        if (prod.name) info.originalTitle = info.originalTitle || prod.name;
        if (prod.id || prod.permalink) info.itemId = info.itemId || String(prod.id || prod.permalink);
        if (prod.description_html) info.description = htmlToText(prod.description_html);
        else if (prod.summary && !info.description) info.description = String(prod.summary);
        var cents = prod.price_cents != null ? prod.price_cents
          : (prod.pwyw && prod.pwyw.suggested_price_cents != null ? prod.pwyw.suggested_price_cents : null);
        var money = gumroadPrice(cents, prod.currency_code);
        if (money) { info.price = money.text; info.priceValue = money.value; info.currency = money.currency; info.isFree = money.value === 0; }
        if (prod.seller && prod.seller.name) {
          info.shop = info.author = prod.seller.name;
          info.shopUrl = prod.seller.profile_url || '';
        } else if (props.creator_profile && props.creator_profile.name) {
          info.shop = info.author = props.creator_profile.name;
          info.shopUrl = info.shopUrl || ('https://' + (props.creator_profile.subdomain || ''));
        }
        if (Array.isArray(prod.covers)) {
          prod.covers.forEach(function (c) {
            if (!c || typeof c !== 'object') return;
            if (c.original_url) info.images.push(c.original_url);
            else if (c.url) info.images.push(c.url);
          });
        }
        if (!info.images.length && prod.thumbnail_url) info.images.push(prod.thumbnail_url);
        if (Array.isArray(prod.options) && prod.options.length) info.versions = gumroadOptionVersions(prod);
        // 免费商品的公开文件：Gumroad public_files 直接给出下载地址
        if (Array.isArray(prod.public_files) && prod.public_files.length) {
          var pubFiles = [];
          prod.public_files.forEach(function (f) {
            if (!f || typeof f !== 'object') return;
            var u = f.url || f.download_url || '';
            if (!u) return;
            var ext = String(f.extension || '').replace(/^\./, '').toLowerCase();
            var name = String(f.file_name || f.name || '免费下载文件').replace(/\s+/g, ' ').trim();
            if (ext && name.toLowerCase().indexOf('.' + ext) !== name.length - ext.length - 1) name = name + '.' + ext;
            pubFiles.push({ name: name, url: u, size: Number(f.file_size || 0) || 0, source: 'public' });
            info.downloadLinks.push({ url: u, label: name });
          });
          if (pubFiles.length && !info.versions.length) {
            info.versions = [{
              id: 'ver_gumroad_public_' + Date.now().toString(36),
              name: prod.name || '免费下载', price: '0', priceValue: 0, priceCurrency: '', special: true,
              orderUrl: '', files: pubFiles, fileName: pubFiles[0].name, url: pubFiles[0].url
            }];
          }
        }
      }
      // 订单/下载页：props.content.content_items → 下载链接 + 一个「订单文件」版本（orderUrl=当前链接）
      var orderFiles = gumroadContentFiles(props.content);
      if (orderFiles.length) {
        info.downloadLinks = info.downloadLinks.concat(orderFiles.map(function (f) { return { url: f.url, label: f.name }; }));
        info.versions = [{
          id: 'ver_gumroad_order_' + Date.now().toString(36),
          name: props.title || '订单下载文件',
          orderUrl: url || '',
          special: false,
          isLatest: true,
          fileName: orderFiles[0].name,
          url: orderFiles[0].url,
          size: orderFiles.reduce(function (s, f) { return s + (f.size || 0); }, 0),
          files: orderFiles
        }];
      }
      return finalize(info);
    }
  });

  /* ---------- GitHub（v2.3.22）：仓库链接 → api.github.com ----------
   * 用户口径：向普通素材靠拢兼容——license 放进「下载链接」，star 放到「价格」的位置，
   * Release 等同于其他素材的「变体（版本）」，每个 Release 的资产就是可下载文件。
   */
  var GH_API = 'https://api.github.com';
  var GH_RESERVED = { topics: 1, collections: 1, sponsors: 1, marketplace: 1, orgs: 1, users: 1, settings: 1,
    features: 1, about: 1, pricing: 1, explore: 1, trending: 1, search: 1, login: 1, join: 1, apps: 1, new: 1 };
  function ghParseRepo(url) {
    var m = String(url || '').match(/^https?:\/\/(?:www\.)?github\.com\/([^\/?#]+)\/([^\/?#]+)/i);
    if (!m) return null;
    var owner = m[1], repo = m[2].replace(/\.git$/i, '');
    if (!owner || !repo || GH_RESERVED[owner.toLowerCase()]) return null;
    return { owner: owner, repo: repo, full: owner + '/' + repo };
  }
  function ghStars(n) {
    n = Number(n) || 0;
    if (n >= 1000) return '★ ' + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
    return '★ ' + n;
  }
  function ghIso(s) { return s ? String(s) : ''; }
  /** 用仓库 JSON（+ 可选 Release JSON 数组）拼出 Fetchers 标准 info */
  /** README 里的图片：徽章（shields/coverage/捐赠…）与 .svg 过滤，相对路径转成可下载直链 */
  var GH_BADGE_HOSTS = /^(www\.)?(img\.shields\.io|shields\.io|badgen\.net|badge\.fury\.io|codecov\.io|coveralls\.io|travis-ci\.(org|com)|appveyor\.com|circleci\.com|api\.codacy\.com|sonarcloud\.io|paypalobjects\.com|opencollective\.com|ko-fi\.com|patreon\.com|discord\.(gg|com))$/i;
  function ghReadmeImages(html, repo) {
    var out = [], seen = {}, full = (repo && repo.full_name) || '', branch = (repo && repo.default_branch) || 'main';
    var src = String(html || ''), m;
    // v2.3.25：README 现在优先取 raw Markdown，所以 <img src> 与 ![alt](url) 两种写法都要抽，且保持出现顺序（首图=封面）
    var cands = [];
    var re = /<img[^>]+src=["']([^"']+)["']/gi;
    while ((m = re.exec(src))) cands.push({ at: m.index, u: m[1] });
    var reMd = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
    while ((m = reMd.exec(src))) cands.push({ at: m.index, u: m[1] });
    cands.sort(function (a, b) { return a.at - b.at; });
    for (var ci = 0; ci < cands.length; ci++) {
      var u = String(cands[ci].u || '').trim().replace(/&amp;/g, '&');
      if (!u || /^data:/i.test(u)) continue;
      if (/\.svg(\?|#|$)/i.test(u)) continue;                                  // 徽章几乎都是 svg
      var host = (u.match(/^https?:\/\/([^\/]+)/i) || [])[1] || '';
      if (host && GH_BADGE_HOSTS.test(host)) continue;                          // 徽章站 / 捐赠按钮
      if (/^https?:\/\//i.test(u)) {
        u = u.replace(/^https?:\/\/github\.com\/([^\/]+\/[^\/]+)\/blob\//i, 'https://github.com/$1/raw/');   // blob=网页，raw=字节
      } else if (/^\/\//.test(u)) { u = 'https:' + u; }
      else if (u.charAt(0) === '/') { u = 'https://github.com' + u; }
      else { u = 'https://github.com/' + full + '/raw/' + branch + '/' + u.replace(/^\.\//, ''); }
      if (seen[u]) continue;
      seen[u] = 1; out.push(u);
    }
    return out;
  }

  function ghInfoFromJson(repo, releases, url, readme) {
    var info = emptyInfo();
    if (!repo || !repo.full_name) return null;
    var owner = (repo.owner && repo.owner.login) || String(repo.full_name).split('/')[0];
    info.sourceId = 'github';
    info.sourceURL = repo.html_url || url || '';
    info.itemId = repo.full_name;                      // 商品ID = owner/repo（文件夹名会自动把 / 换成 _）
    info.originalTitle = repo.full_name;
    info.title = repo.name || String(repo.full_name).split('/')[1] || repo.full_name;
    info.description = repo.description || '';
    info.author = owner;
    info.shop = owner;
    info.shopUrl = repo.html_url || '';
    info.images = ghReadmeImages(readme, repo);                 // v2.3.23：封面与图集取自 README 里的图片
    info.coverURL = info.images[0] || (repo.owner && repo.owner.avatar_url) || '';   // README 无图时退回仓库头像
    info.isFree = true;                                 // 开源素材天然免费
    info.shopPrice = ghStars(repo.stargazers_count);    // star 占「价格」的位置
    info.shopPriceValue = null;
    info.shopPriceCurrency = '';
    info.publishedAt = ghIso(repo.created_at);
    info.shopUpdatedAt = ghIso(repo.pushed_at || repo.updated_at);
    var tags = [];
    (repo.topics || []).forEach(function (t) { if (t) tags.push(String(t)); });
    if (repo.language) tags.push(String(repo.language));
    if (repo.archived) tags.push('已归档');
    info.tags = Smart.filterBlacklist(Smart.purgeAvatarTags(tags));
    info.rawTags = tags.slice();
    // 分类：按 topics/语言猜一个，默认「工具」
    var tl = tags.join(' ').toLowerCase();
    info.categoryId = /shader|poiyomi|liltoon/.test(tl) ? 'shaders'
      : /avatar|model|3dモデル/.test(tl) ? 'avatar'
      : /clothing|outfit|衣装/.test(tl) ? 'clothing'
      : /texture|material/.test(tl) ? 'textures'
      : /gimmick|prefab|component|ギミック/.test(tl) ? 'gimmicks' : 'tools';
    // license → 下载链接（special：进许可证框）
    var lic = repo.license || null;
    if (lic) {
      var licUrl = (repo.html_url || '') + '/blob/' + (repo.default_branch || 'main') + '/LICENSE';
      info.downloadLinks.push({ url: licUrl, label: 'LICENSE · ' + (lic.spdx_id || lic.name || '自定义'), special: true });
    }
    var branch = repo.default_branch || 'main';
    if (repo.html_url) info.downloadLinks.push({ url: repo.html_url + '/archive/refs/heads/' + branch + '.zip', label: repo.name + '-' + branch + '.zip（源码包）' });
    // Release → 变体；资产 → 文件
    (releases || []).forEach(function (rel, i) {
      if (!rel || rel.draft) return;
      var assets = (rel.assets || []).map(function (a) {
        return { name: a.name || '', url: a.browser_download_url || '', size: Number(a.size) || 0 };
      });
      info.versions.push({
        name: rel.name || rel.tag_name || ('Release ' + (i + 1)),
        tag: rel.tag_name || '',
        price: '', priceValue: null, priceCurrency: '',
        orderUrl: '', special: false, isLatest: i === 0,
        url: assets.length ? assets[0].url : '',
        fileName: assets.length ? assets[0].name : '',
        size: assets.reduce(function (s, a) { return s + (a.size || 0); }, 0),
        files: assets,
        addedAt: ghIso(rel.published_at),
        note: String(rel.body || '').slice(0, 400),
        htmlUrl: rel.html_url || ''
      });
    });
    if (!info.versions.length) {
      info.versions.push({
        name: '默认分支源码（' + branch + '）', tag: '', price: '', priceValue: null, priceCurrency: '',
        orderUrl: '', special: false, isLatest: true,
        url: repo.html_url ? repo.html_url + '/archive/refs/heads/' + branch + '.zip' : '',
        fileName: repo.name + '-' + branch + '.zip',
        size: 0, files: [], addedAt: ghIso(repo.pushed_at), note: '', htmlUrl: repo.html_url || ''
      });
    }
    return info;
  }
  /* ---------- v2.3.25：可选 Token（5000 次/小时）与 README 省配额取法 ---------- */
  function ghTokenSet() { return !!(App.settings && App.settings.githubToken); }
  /** 拼 GitHub 请求头：配了 Token 就带 Authorization（匿名 60 次/小时 → 带 Token 5000 次/小时） */
  function ghAuthHeaders(base) {
    var h = Object.assign({}, base || {});
    var enc = (App.settings && App.settings.githubToken) || '';
    if (!enc) return Promise.resolve(h);
    return Secure.decrypt(enc).then(function (tk) {
      tk = String(tk || '').trim();
      if (tk) h.Authorization = 'Bearer ' + tk;
      return h;
    }).catch(function () { return h; });
  }
  /** README 优先取 raw.githubusercontent.com（CDN，不占 API 配额；实测 Markdown 里的图与渲染 HTML 抽出来一致） */
  var GH_README_NAMES = ['README.md', 'readme.md', 'README.markdown'];
  function ghFetchReadme(full, ctx, hdrs, log) {
    var i = 0;
    function tryRaw() {
      if (i >= GH_README_NAMES.length) return Promise.resolve('');
      var name = GH_README_NAMES[i++];
      return Net.fetchText('https://raw.githubusercontent.com/' + full + '/HEAD/' + name,
        { forceNetwork: ctx && ctx.forceNetwork, onLog: function () {} }).then(function (r) {
        var t = (r && r.ok) ? String(r.text || '') : '';
        if (t.trim()) { log('\u{1F4C4} README 取自 raw（' + name + '，不占 API 配额）'); return t; }
        return tryRaw();
      });
    }
    return tryRaw().then(function (t) {
      if (t) return t;
      log('\u{1F4C4} raw README 未命中，退回 API /readme');
      return Net.fetchText(GH_API + '/repos/' + full + '/readme',
        { forceNetwork: ctx && ctx.forceNetwork, onLog: function () {}, headers: Object.assign({}, hdrs, { Accept: 'application/vnd.github.html+json' }) })
        .then(function (r2) { return (r2 && r2.ok) ? String(r2.text || '') : ''; });
    });
  }

  var ghFetcher = register({
    id: 'github',
    name: 'GitHub 仓库',
    sourceId: 'github',
    match: function (url) { return !!ghParseRepo(url); },
    /** 手动粘贴时引导用户复制哪个地址（浏览器可直接打开整页 JSON） */
    jsonURL: function (url) { var p = ghParseRepo(url); return p ? (GH_API + '/repos/' + p.full) : ''; },
    fetch: function (url, ctx) {
      var log = (ctx && ctx.onLog) || function () {};
      var p = ghParseRepo(url);
      if (!p) return Promise.resolve({ __failed: true, reason: '不是 GitHub 仓库链接' });
      return ghAuthHeaders({ Accept: 'application/vnd.github+json' }).then(function (hdrs) {
        log('\u{1F419} GitHub：读取仓库 ' + p.full + '（api.github.com，' + (ghTokenSet() ? '已配置 Token：5000' : '匿名限额 60') + ' 次/小时）');
        return Net.fetchText(GH_API + '/repos/' + p.full, { forceNetwork: ctx && ctx.forceNetwork, onLog: log, headers: hdrs }).then(function (r) {
          if (!r.ok) return { __failed: true, tried: r.tried, reason: r.reason || (ghTokenSet() ? '仓库信息获取失败（私有仓库或 Token 无效？）' : '仓库信息获取失败（可能是私有仓库或限额用尽）') };
          var repo = safeJSON(r.text, null);
          if (!repo || !repo.full_name) return { __failed: true, reason: '仓库不存在或返回不是 JSON（限额/私有仓库）' };
          var relP = Net.fetchText(GH_API + '/repos/' + p.full + '/releases?per_page=30', { forceNetwork: ctx && ctx.forceNetwork, onLog: log, headers: hdrs });
          var rdP = ghFetchReadme(p.full, ctx, hdrs, log);
          return Promise.all([relP, rdP]).then(function (arr) {
            var rr = arr[0], readme = String(arr[1] || '');
            var rels = rr && rr.ok ? safeJSON(rr.text, []) : [];
            var info = ghInfoFromJson(repo, Array.isArray(rels) ? rels : [], url, readme);
            if (info) log('\u2714 已解析仓库：' + info.title + '（' + info.shopPrice + '，' + info.versions.length + ' 个 Release，README 图 ' + info.images.length + ' 张）');
            return info || { __failed: true, reason: '仓库信息解析失败' };
          });
        });
      });
    },
    parse: function (text, url) {
      var j = safeJSON(String(text || '').trim(), null);
      if (j && j.full_name) return ghInfoFromJson(j, [], url);
      return null;   // 粘贴的不是仓库 JSON → 交给通用解析
    }
  });
  /** 解析仓库 JSON；可注入 Releases（数组或 JSON 文本），供导入与自检复用同一套映射 */
  function ghFromJSON(text, url, releases, readme) {
    var j = safeJSON(String(text || '').trim(), null);
    if (j && j.full_name) {
      var rels = releases;
      if (typeof rels === 'string') rels = safeJSON(rels.trim(), []);
      return ghInfoFromJson(j, Array.isArray(rels) ? rels : [], url, readme);
    }
    return ghFetcher.parse(text, url);
  }

  /* ---------- 通用（兜底） ---------- */
  register({
    id: 'generic',
    name: '通用网页',
    sourceId: '',
    match: function () { return true; },
    fetch: function (url, ctx) { return genericFetch(url, ctx); },
    parse: parseGeneric
  });

  function genericFetch(url, ctx, sourceId) {
    return Net.fetchText(url, ctx).then(function (r) {
      if (!r.ok) return { __failed: true, tried: r.tried, reason: r.reason };
      var f = detect(url);
      var info = f.parse(r.text, url);
      if (sourceId) info.sourceId = sourceId;
      return info;
    });
  }

  /**
   * 统一入口：先查本地缓存（借鉴 booth-library-manager 的缓存策略），
   * 未命中再按当前方案抓取；成功后写入缓存。
   */
  function fetchInfo(url, ctx) {
    ctx = ctx || {};
    var log = ctx.onLog || function () {};
    return Store.cacheGet(url).then(function (cached) {
      if (cached && !ctx.noCache) {
        log('\u{1F4BE} 命中本地缓存，未发起任何网络请求（可在设置中清空缓存）');
        cached.__fromCache = true;
        return cached;
      }
      var f = detect(url);
      log('识别站点：' + f.name);
      return f.fetch(url, ctx).then(function (info) {
        if (info && !info.__failed) Store.cacheSet(url, info);
        return info;
      });
    });
  }

  /** 解析用户手动粘贴的源码（HTML 或 JSON）——离线模式的核心 */
  function parsePasted(text, url) {
    var trimmed = String(text || '').trim();
    if (!trimmed) return null;
    // v2.3.25：粘 JSON 时按「内容特征」挑会解析 JSON 的那一个（以前一律走通用分支，GitHub 字段会全丢）。
    // 注意不能按链接盲派：BOOTH 的 parse 是 HTML 解析器，把 JSON 喂给它只会解析出空壳。
    var byUrl = url ? detect(url) : null;
    var byUrlGeneric = !byUrl || byUrl.id === 'generic';
    if (trimmed[0] === '{' || trimmed[0] === '[') {
      var d = safeJSON(trimmed, null);
      if (d) {
        if (d.full_name && d.owner) {                                     // GitHub 仓库 JSON 自带身份：没填链接也认得出来
          var gOut = ghFetcher.parse(trimmed, url || d.html_url || '');
          if (gOut && !gOut.__failed) {
            if (!gOut.sourceId) gOut.sourceId = 'github';
            return cacheAndReturn(gOut, url);
          }
        }
        if (d.name && (d.images || d.shop)) return cacheAndReturn(boothFetcher.parseJSON(d, url), url);
        var info = emptyInfo();
        info.originalTitle = d.name || d.title || '';
        info.description = d.description || '';
        info.itemId = String(d.id || '');
        if (Array.isArray(d.images)) d.images.forEach(function (im) {
          var u = typeof im === 'string' ? im : (im.original || im.resized || im.url); if (u) info.images.push(u);
        });
        if (d.image) info.images.push(typeof d.image === 'string' ? d.image : (d.image.url || ''));
        if (Array.isArray(d.tags)) info.tags = d.tags.map(function (t) { return t && (t.name || t); }).filter(Boolean);
        if (d.price != null) info.price = String(d.price);
        if (d.is_adult === true) info.r18 = true;
        if (d.shop && d.shop.name) { info.author = info.shop = d.shop.name; info.shopUrl = d.shop.url || ''; }
        return cacheAndReturn(finalize(info), url);
      }
    }
    // 无 URL 时也识别出 Gumroad SPA 页面（data-page 里的 price_cents / content_items 是其特征）
    var looksGumroad = /gumroad\.com|data-page/i.test(trimmed) && /price_cents|content_items|gumroad/i.test(trimmed);
    var f = (!byUrlGeneric ? byUrl : null) || (looksGumroad ? gumroadFetcher : null);
    var out = f ? f.parse(trimmed, url || '') : null;
    // v2.3.25：来源解析器认不出（例如粘的是 GitHub 仓库页面源码）就回落通用解析，至少抽出 og: 标题/简介/图
    if (!out || out.__failed) out = parseGeneric(trimmed, url || '');
    if (url && out && !out.sourceId && f && f.sourceId) out.sourceId = f.sourceId;
    return cacheAndReturn(out, url);
  }

  /** 把解析结果写入本地缓存后原样返回（同步返回，缓存写入异步进行） */
  function cacheAndReturn(info, url) {
    if (url && info && !info.__failed) { try { Store.cacheSet(url, info); } catch (e) {} }
    return info;
  }

  return {
    register: register, detect: detect, fetchInfo: fetchInfo,
    parsePasted: parsePasted, parseGeneric: parseGeneric, emptyInfo: emptyInfo,
    ghParseRepo: ghParseRepo, ghFromJSON: ghFromJSON,   // v2.3.22：GitHub 来源（供详情/冒烟使用）
    cleanTags: cleanTags, finalize: finalize, extractVariations: extractVariations,
    get list() { return list; }
  };
})();


/* =====================================================================
 * 智能推断：标签翻译 / 分类猜测 / 角色识别
 * ===================================================================== */
var Smart = (function () {

  /** 归一化标签 token：小写 + 去掉空格/连字符/下划线/点/全角括号，用于同义与黑名单匹配 */
  function normalizeTagToken(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/[\s\-_/·・.]+/g, '')
      .replace(/[【】（）()\[\]]/g, '')
      .trim();
  }

  var MERGE_MAP = (function () {
    var m = Object.create(null);
    (TAG_MERGE_GROUPS || []).forEach(function (g) {
      g.forEach(function (w) { m[normalizeTagToken(w)] = g[0]; });
    });
    return m;
  })();

  var TAG_DICT_LOWER = (function () {
    var m = Object.create(null);
    Object.keys(TAG_DICT || {}).forEach(function (k) { m[k.toLowerCase()] = TAG_DICT[k]; });
    return m;
  })();

  /** 同义合并：不同语言/表达形式 → 组内中文规范名 */
  function mergeSynonym(tag) {
    var t = normalizeTagToken(tag);
    return MERGE_MAP[t] || '';
  }

  function translateTag(tag) {
    if (!tag) return { text: '', translated: false };
    var t = String(tag).trim().replace(/^#/, '');
    var user = App.settings.userTagDict || {};
    if (user[t]) return { text: user[t], translated: true };
    if ((App.settings.noTranslateTags || []).indexOf(t) >= 0) return { text: t, translated: true };
    var merged = mergeSynonym(t);
    if (merged) return { text: merged, translated: true };
    if (TAG_DICT[t]) return { text: TAG_DICT[t], translated: true };
    var lowerHit = TAG_DICT_LOWER[t.toLowerCase()];
    if (lowerHit) return { text: lowerHit, translated: true };
    if (/[\u4E00-\u9FFF]/.test(t) && !/[\u3040-\u30FF]/.test(t)) return { text: t, translated: true };
    return { text: t, translated: false };
  }

  function translateTags(tags) {
    return uniq((tags || []).map(function (t) { return translateTag(t).text; }).filter(Boolean));
  }

  function isUntranslated(tag) { return !translateTag(tag).translated; }

  var CATEGORY_HINTS = [
    { id: 'shaders',     kw: ['シェーダー', 'shader', 'liltoon', 'poiyomi', '着色器', 'toon'] },
    { id: 'textures',    kw: ['テクスチャ', 'texture', '贴图', '纹理', 'ネイル', 'タトゥー', 'マテリアル', 'material'] },
    { id: 'hair',        kw: ['髪型', '髪', 'ヘア', 'hair', '发型', '头发', 'hairstyle'] },
    { id: 'accessories', kw: ['アクセサリー', 'アクセ', 'accessory', '配饰', '靴', 'ブーツ', '帽子', 'メガネ', 'ピアス', 'ネックレス', '尻尾', '獣耳', '猫耳', '武器', 'weapon', '眼镜'] },
    { id: 'gimmicks',    kw: ['ギミック', 'gimmick', '功能', 'system', 'システム', 'アニメーション', 'animation', 'エフェクト', 'particle', 'パーティクル', 'menu', 'expression'] },
    { id: 'tools',       kw: ['ツール', 'tool', 'unity', 'blender', 'エディタ', 'editor', '插件', 'script', 'スクリプト'] },
    { id: 'body_parts',  kw: ['素体', 'ボディ', 'body', '目', '瞳', 'フェイス', 'face', '身体'] },
    { id: 'avatar',      kw: ['アバター', 'avatar', 'オリジナル3dモデル', '3dモデル', '角色', 'モデル', 'vrm'] },
    { id: 'worlds',      kw: ['ワールド', 'world', '场景', 'シーン', 'scene', 'ステージ'] },
    { id: 'clothing',    kw: ['衣装', '服', 'ワンピース', 'スカート', 'ドレス', 'パーカー', '水着', 'メイド', '制服', 'clothing', 'outfit', 'costume', 'dress', 'ニット'] }
  ];

  /** BOOTH 自带分类名 → 本库分类标识 */
  var BOOTH_CATEGORY_MAP = {
    '3D衣装': 'clothing', '衣装': 'clothing', '3D服': 'clothing', '服': 'clothing',
    '3Dキャラクター': 'avatar', '3Dモデル': 'avatar', 'アバター': 'avatar', 'オリジナル3Dモデル': 'avatar',
    '髪型': 'hair', 'ヘア': 'hair', '3D髪': 'hair',
    'アクセサリー': 'accessories', 'アクセサリ': 'accessories', '装飾': 'accessories',
    'テクスチャ': 'textures', 'マテリアル': 'textures', '素材': 'textures',
    'ツール': 'tools', 'Unityツール': 'tools', '制作支援': 'tools',
    'ワールド': 'worlds', '3Dワールド': 'worlds', 'シーン': 'worlds',
    'シェーダー': 'shaders', 'シェーダ': 'shaders',
    'ギミック': 'gimmicks', 'セットアップ': 'gimmicks', 'アニメーション': 'gimmicks',
    'エフェクト': 'effects', 'パーティクル': 'effects', '粒子': 'effects', '特效': 'effects',
    'ボディ': 'body_parts', '素体': 'body_parts', 'フェイス': 'body_parts',
    'その他': 'other', '同人誌': 'other', '音楽': 'other', 'イラスト': 'other', '漫画': 'other'
  };

  function mapShopCategory(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    if (BOOTH_CATEGORY_MAP[s]) return BOOTH_CATEGORY_MAP[s];
    // 去掉「3D」前缀再试
    var bare = s.replace(/^3D/, '').replace(/^3d/, '');
    if (BOOTH_CATEGORY_MAP[bare]) return BOOTH_CATEGORY_MAP[bare];
    var low = s.toLowerCase();
    if (/衣装|服/.test(low)) return 'clothing';
    if (/髪|ヘア|hair/.test(low)) return 'hair';
    if (/アクセ|accessor/.test(low)) return 'accessories';
    if (/テクスチャ|texture|マテリアル/.test(low)) return 'textures';
    if (/ツール|tool|unity/.test(low)) return 'tools';
    if (/ワールド|world|シーン/.test(low)) return 'worlds';
    if (/シェーダ|shader/.test(low)) return 'shaders';
    if (/ギミック|gimmick|アニメ/.test(low)) return 'gimmicks';
    if (/キャラクター|モデル|アバター|avatar|3d/.test(low)) return 'avatar';
    return '';
  }

  function guessCategory(info) {
    // BOOTH 自带分类优先（站方分类最准确）
    var mapped = info && (info.categoryId || mapShopCategory(info.category));
    if (mapped) return mapped;
    var hay = [(info.originalTitle || ''), (info.category || ''), (info.description || '').slice(0, 400)]
      .concat(info.tags || []).join(' ').toLowerCase();
    for (var i = 0; i < CATEGORY_HINTS.length; i++) {
      var h = CATEGORY_HINTS[i];
      for (var j = 0; j < h.kw.length; j++) {
        if (hay.indexOf(String(h.kw[j]).toLowerCase()) >= 0) return h.id;
      }
    }
    return 'other';
  }

  /* v4.3.2：以前这里是隐式全局（`_roleTagGuard = …` 没有声明），
   * 而 detectAvatars 内部又 `var _roleTagGuard = Object.create(null)` 重新建了一个空表，
   * 把外层刚按标签填好的内容整个遮蔽掉 —— 「标签里出现过的词不当角色名」这条规则从未生效过。
   * 现在提到模块级声明一次，两处共用。 */
  var _roleTagGuard = Object.create(null);

  function detectAvatars(info) {
    var title = info.originalTitle || info.title || '';
    var desc = String(info.description || '');
    var tags = info.tags || [];
    // v2.3.19：标签参与排除错误的角色名（完全相等才排除）
    _roleTagGuard = Object.create(null);
    tags.concat(info.rawTags || []).forEach(function (t) {
      var k = String(t || '').trim().toLowerCase();
      if (k) _roleTagGuard[k] = 1;
    });
    // 支持角色通常写在“対応アバター / 支持角色 / supported avatars / supports:”区块。
    // 优先只在该区块内识别，减少把正文里顺带提到的角色名误判成支持角色。
    var lines = desc.split(/\n+/);
    var block = '';
    for (var bi = 0; bi < lines.length; bi++) {
      // 只认明确的“支持角色”小节标题；裸「対応」出现在正文里不算（如“PBのみ対応”）
      if (/対応(?:アバター|モデル|先)(?:一覧)?|支持(?:角色|的模型|的模型角色)|適用|适配|supported\s+avatars?|supports?[:：]|compatible\s+(?:with\s+)?(?:avatars?|models?)|works?\s+with|made\s+for|以下のキャラクターに対応/i.test(lines[bi])) {
        block = lines.slice(bi, Math.min(lines.length, bi + 16)).join('\n');
        break;
      }
    }
    var TOKEN_SPLIT = /[\s\/／、,，&＆+＋・|｜:：;；()[\]（）【】{}「」『』"'\uFF5E~_.\-]+/;
    function phraseHit(hay, name) {
      var lower = String(hay || '').toLowerCase();
      var nl = String(name || '').toLowerCase();
      if (!nl) return false;
      var idx = lower.indexOf(nl);
      while (idx >= 0) {
        var before = idx > 0 ? lower.charAt(idx - 1) : '';
        var after = idx + nl.length < lower.length ? lower.charAt(idx + nl.length) : '';
        if (!/[a-z0-9\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(before) &&
            !/[a-z0-9\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(after)) return true;
        idx = lower.indexOf(nl, idx + 1);
      }
      return false;
    }
    // 受欢迎度：现有素材引用次数越多越优先；越冷门的角色越少被单独适配，放后面减少误匹配。
    // 「通用/多角色」固定排最后——它只是备选，详情里有具体角色时让位。
    var pop = {};
    (App.assets || []).forEach(function (a) {
      (a.avatars || []).forEach(function (id) { pop[id] = (pop[id] || 0) + 1; });
    });
    var sortedAvs = App.allAvatars().slice().sort(function (a, b) {
      if (a.id === 'universal') return 1;
      if (b.id === 'universal') return -1;
      return (pop[b.id] || 0) - (pop[a.id] || 0);
    });
    function scan(hay) {
      var text = String(hay || '');
      var tokens = text.split(TOKEN_SPLIT);
      var found = [];
      var claimed = {};
      sortedAvs.forEach(function (av) {
        var names = [av.label].concat(av.alias || []);
        for (var i = 0; i < names.length; i++) {
          var n = String(names[i]);
          if (!n) continue;
          // 单个中日韩字符（如「汐」「萌」）允许参与匹配；单个拉丁字母/数字不允许
          if (n.length === 1 && !/[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(n)) continue;
          var hit = false;
          if (n.indexOf(' ') < 0) {
            for (var t = 0; t < tokens.length; t++) {
              var tok = tokens[t];
              if (!tok) continue;
              // 同一证据（token）只给最高受欢迎度的角色：冷门角色不会抢走热门角色的适配位
              if (claimed[tok] !== undefined) continue;
              if (avatarNameMatch(tok, n)) { claimed[tok] = av.id; found.push(av.id); hit = true; break; }
            }
          } else {
            var key = 'p:' + n.toLowerCase();
            if (claimed[key] === undefined && phraseHit(text, n)) { claimed[key] = av.id; found.push(av.id); hit = true; }
          }
          if (hit) break;
        }
      });
      return found;
    }

    /* ---- 支持角色区块里出现「尚未收录」的名字：自动注册为新角色 ----
     * 同一行里英文名与日文/中文名成对出现时合并为一个角色（英文优先作为显示名），
     * 单独出现时用解析到的该名称直接创建（英文 > 日文 > 中文）。
     */
    var SUPPORT_STOP = {};
    [
      // 小节/术语
      '対応アバター', '対応モデル', '対応先', '対応済み', '対応', '支持角色', '支持', '适配', '適用', '向け', '用', '専用', '专用',
      'アバター', 'avatars', 'avatar', 'model', 'models', 'supported', 'supports', 'compatible', 'works', 'with', 'made', 'for',
      'all', 'any', 'general', 'common', 'universal', 'multi', '共通', '汎用', '全対応', 'modular', 'unity', 'vrchat', 'booth', 'ブース',
      'version', 'ver', 'dlc', 'ma', '3d', 'r18', 'fbx', 'tool', 'tools', 'data', 'extension', 'keys', 'original', 'en',
      'www', 'notion', 'discord', 'com', 'invite', 'ai', 'agent', 'github', 'url', 'readme', 'txt',
      // 商品简介高频词（英文）
      'large', 'maybe', 'not', 'work', 'installed', 'by', 'vrcfurry', 'other', 'animation', 'controll', 'fx', 'using',
      'please', 'ensure', 'this', 'control', 'has', 'hight', 'prior', 'hairfit', 'hayanuri', 'gogoloco', 'unityagent',
      'adameve', 'kakeudonn', 'septem47', 'lighfu', 'brn', 'mesh', 'bone', 'texture', 'uv', 'psd', 'stockings', 'nipple',
      'on', 'plus', 'no', 'shape', 'keys', 'hoodie', 'breasts', 'breast', 'big', 'flat', 'corset', 'hip', 'tights', 'small',
      'nakiya', 'body', 'slender', 'pelvis', 'slim', 'fat', 'leg', 'preset', 'legs', 'bra', 'cow', 'thigh', 'blendshapes',
      // 日文正文高频词
      '購入', '金額', '変更', 'セール', 'まで', '商品説明', '販売', '作動', '保障', '動作', '保証', '以外', '導入', 'ください', '対応しました',
      '追加', '機能', '位置合わせ', '質感', '色', '髪', '髪色', '貫通修正', '統一', '改変', '悩み', '解決', '操作', '必要', '同梱',
      'メッシュ', 'シーン', 'マウス', 'テクスチャ', '迷子状態', 'サヨナラ', '画像編集', 'ソフト', '完結', 'ドラッグ', 'ドロップ', '自動検出',
      'プレビュー', '塗れる', '手間', 'ゼロ', '初心者', '安心設計', '準備', '塗り直し', '簡単', '視覚的', 'マスク作成', '迷いません',
      '内容物', '動作環境', '前提アセット', '仕様', '詳細', '注意事項', '利用規約', '規約', 'クレジット', '更新履歴', '変更履歴', 'サイズ',
      'ポリゴン', '説明', '紹介', '価格', 'ダウンロード', '対応バージョン', 'バージョン', 'オリジナル', '単品', '円', '開催期間',
      'フォロワー', '達成記念', '感謝', '気持ち', 'これからもよろしくお願いします', 'アバター本体', '分割版', '動作確認', '互換',
      '場合', 'です', '猫耳', '組み合わせ', 'たい', 'シェイプキー', '早期アクセス', 'おすすめ', '苦手', 'コンポーネント', '設定',
      'プロパティ名', '覚えきれない', '放心', '拉高', '优先级', '动画插件', '対応アバタ',
      // 韩文正文高频词
      '대응', '모델', '전용', '상품설명', '제품을', '임포트하기', '전에', '도입해', '주세요', '완료하였습니다', '귀를', '움직이는',
      '애니메이션', '기능을', '추가하여', '다음과', '같은', '캐릭터를', '지원합니다', '아바타', '셰이프',
      // 用户实测误添加清单（全部排除；已收录角色的韩文别名不在此列，仍走正常匹配）
      '購入いただいた方は', 'アバターが追加されると金額が変更されます', 'セール11', '11まで', 'MANUKAのsmall',
      'breast対応FBXを新たに作りました', 'PBのみ対応しています', 'ヘアだけ販売します', 'VRCでの作動のみを保障します',
      '以外の動作は保証しません', 'lilToonを導入してください', 'Unity専用Modular', 'Avatar対応完了しました',
      '耳を動かすアニメーション機能を追加し', '以下のキャラクターに対応しました', '쇼콜라', '리리카', '밀피', '이치고', '루미나',
      'Kami', 'Pita', 'かみぴた', 'あの子の', '私のアバターでも使いたい', 'でも', '非対応だから位置合わせが面倒くさい',
      '髪を組み合わせたら', '質感も色もバラバラ', 'そんな改変の悩みをまとめて解決するツールです', 'Unityの難しい操作は必要なし',
      'HairFit', '同梱の', 'でボタンひとつ', '位置合わせから', 'メッシュの貫通修正', '髪色の統一',
      '髪改変がこれ1つで完結します', 'その名も', 'Unityのシーン上でアバターにマウスを乗せると',
      '対応するテクスチャの位置を教えてくれます', '3Dのこの部分は', '画像のどこ', 'という迷子状態とはもうサヨナラです',
      '画像編集ソフト不要', 'Unityだけで完結', 'アバターをドラッグ', 'ドロップするだけで', '使われているテクスチャを自動検出',
      'プレビュー画面をなぞるだけで塗れるので', '別のソフトを行き来する手間がゼロになります', '初心者さんにも安心設計',
      'Dだけで準備OK', '間違えても塗り直しは簡単', '今どこを塗っているか', 'が視覚的にわかるので', '初めてのマスク作成でも迷いません',
      'HayaNuri', 'unitypackage', 'Readme', 'txt', '4以降', 'chocolaterice', 'jingo1016', 'ponderogen', 'Lapwing',
      'kujishift', 'mio3works', 'mukumi', 'Sayori', 'hiehieck', 'Nao', 'rakostudio', 'paryi', 'komado', 'harunopupu',
      'Marycia', 'brn', 'BlendShapes', 'Keys', 'Hoodie', 'Breasts', 'big', 'flat', 'Corset', 'Hip', 'Tights', 'Breast',
      'small', 'Nakiya', 'No', 'Shape', 'Body', 'Slender', 'Pelvis', 'Slim', 'Fat', 'Leg', 'Preset', 'Legs', 'bra', 'Cow',
      'Thigh', 'EXTENSION', 'CLOTHING', 'あまとうさぎ', '海咲', '新たに対応追加', 'フォロワー1万人達成記念',
      '感謝の気持ちを込めて', 'これからもよろしくお願いします', '3月25日', '4月10日', 'Stockings', 'URL', 'adameve',
      'まめひなたにも対応しています', 'アバター本体はこちら', '仕様詳細', '11232△Polygon', 'mesh', '分割版は7個', 'Bone',
      'Texture', '1枚', 'UV', 'PSD', 'STUDIOで動作確認', 'Maya2022製', 'Blenderでは互換がない場合があります', 'Autodesk',
      'です', 'Blendshapeのmamehinata', 'キプフェルの猫耳と組み合わせたい場合は', 'Material', 'Nipple', 'ON', 'リゼ',
      'kakeudonn', 'limit', '対応アバタ', 'septem47', 'シェイプキー', 'PLUS', 'www', 'notion', 'so', 'UnityAgent', 'discord',
      'com', 'invite', 'AI', 'Agent', 'Editor上でAIとチャットするだけで', '髪の色を青にして', 'この衣装を着せて', 'そんな一言で',
      'github', 'lighfu', '現在早期アクセスです', 'こんな人におすすめ', 'Unity操作が苦手だけどアバター改変したい',
      'コンポーネントの設定やプロパティ名を覚えきれない', 'Large', 'Maybe', 'not', 'work', 'Gogoloco', 'installed', 'by',
      'VRCfurry', 'other', 'animation', 'controll', 'FX', 'using', 'please', 'ensure', 'this', 'control', 'has', 'hight',
      'prior', '如果用了其他的动画插件', '所以请放心拉高优先级', 'unityは2022のみ対応です'
    ].forEach(function (w) { SUPPORT_STOP[w.toLowerCase()] = 1; });
    // v2.3.17：并入「工具 / 软件 / 技术名词」表——lilToon、Modular Avatar、VRCSDK 这类词常出现在「対応」列表里，但不是角色名
    (typeof TOOL_STOPWORDS !== 'undefined' ? TOOL_STOPWORDS : []).forEach(function (w) { SUPPORT_STOP[String(w).toLowerCase()] = 1; });
    var PROSE_HINTS = /(います|ました|します|ません|です|でした|する|した|して|ください|のみ|だけ|から|まで|として|により|ため|ので|という|これ|この|その|あの|私|さん|様|ちゃん|君|くん)/;
    var PARTICLE_END = /(は|が|を|に|で|と|も|へ|の|や|か|ね|よ|わ)$/;
    var newRoleCache = {};
    var stagedAny = false;
    function knownToken(tok) {
      var hit = false;
      sortedAvs.some(function (av) {
        return [av.label].concat(av.alias || []).some(function (n) {
          n = String(n || '');
          if (n.indexOf(' ') >= 0) return false;
          if (avatarNameMatch(tok, n)) { hit = true; return true; }
          return false;
        });
      });
      return hit;
    }
    // v2.3.19：当前素材的标签（用户规则：标签可以「一定程度」参与排除错误的角色名）。
    // 只做**完全相等**的排除——标签里出现过的词不再当角色名，但不做「包含」匹配，
    // 免得把「マヌカ対応」这类标签里的真实角色名一起吃掉。
    // v4.3.2：这里曾用 `var` 重建了一个空表，把上面按标签填好的内容遮蔽掉，已删除。
    function isLikelyRoleToken(s) {
      var core = stripTagDecorations(s);
      if (!core || core.length < 2 || core.length > 24) return false;
      var low = core.toLowerCase();
      if (SUPPORT_STOP[low]) return false;
      if (_roleTagGuard[low]) return false;
      if (/\d/.test(core) || /^https?:|[<>@|]/.test(core)) return false;
      // 只允许中日韩文 / 拉丁字母（可带连字符与撇号）；emoji、装饰符号直接排除
      if (!/^[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AFA-Za-z'’-]+$/.test(core)) return false;
      if (knownToken(core)) return false;
      // 核心词与原文一致时保留原文大小写（NewRole 不变成 newrole）；只去后缀时用剥离后的核心词
      var name = s.toLowerCase() === core.toLowerCase() ? s : core;
      if (/^[A-Za-z]/.test(name)) {
        // 混合文字（如 Unity専用Modular）不是角色名
        if (/[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(name)) return false;
        // 未收录英文名必须有首字母大写或驼峰（全小写通常是普通单词/店铺/文件词）
        if (name === name.toLowerCase()) return false;
        if (name.length < 2 || name.length > 20) return false;
        return true;
      }
      // 日文/韩文/中文：排除句子片段与助词结尾
      if (name.length > 10) return false;
      if (PARTICLE_END.test(name)) return false;
      if (PROSE_HINTS.test(name)) return false;
      if (/[のノ]/.test(name) && name.length > 4) return false;   // 「〇〇の」通常是正文
      return true;
    }
    function registerBlockRole(pair) {
      var en = String(pair.en || '').trim();
      var other = String(pair.other || '').trim();
      var ja = /[\u3040-\u30FF]/.test(other) ? other : '';
      var zh = other && !ja ? other : '';
      var names = uniq([en, ja, zh].filter(Boolean));
      if (!names.length) return '';
      var key = names.map(function (n) { return n.toLowerCase(); }).sort().join('|');
      if (newRoleCache[key]) return newRoleCache[key];
      var lowNames = names.map(function (n) { return n.toLowerCase(); });
      var existing = App.allAvatars().find(function (av) {
        return [av.label, av.nameZh, av.nameJa, av.nameEn].concat(av.alias || [])
          .some(function (n) { return lowNames.indexOf(String(n || '').trim().toLowerCase()) >= 0; });
      });
      if (existing) { newRoleCache[key] = existing.id; return existing.id; }
      // 未收录角色不再直接入库：暂存到 pendingAvatars，由用户在「设置 → 分类与角色」统一批准
      var pending = App.settings.pendingAvatars || (App.settings.pendingAvatars = []);
      var dupPending = pending.find(function (p) {
        return [p.label, p.nameZh, p.nameJa, p.nameEn].concat(p.alias || [])
          .some(function (n) { return lowNames.indexOf(String(n || '').trim().toLowerCase()) >= 0; });
      });
      if (!dupPending) {
        var label = en || ja || zh;
        pending.push({
          id: 'pav_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
          label: label, nameEn: en || '', nameJa: ja || '', nameZh: zh || '', alias: names,
          source: 'parse', createdAt: nowISO()
        });
        stagedAny = true;
      }
      newRoleCache[key] = '';   // 未批准前不作为支持角色返回
      return '';
    }
    function extractBlockRoles(blockText) {
      if (!blockText) return [];
      var ids = [];
      var first = true;
      var stopped = false;
      var SUPPORT_END = /^(仕様|スペック|内容|収録|同梱|更新履歴|変更履歴|サイズ|ポリゴン|説明|紹介|価格|購入|ダウンロード|利用規約|注意|規約|クレジット|動作環境|前提アセット|商品説明|상품설명|販売|内容物|バージョン|対応バージョン)/i;
      String(blockText).split(/\n+/).forEach(function (line) {
        if (stopped) return;
        var t = line.trim();
        if (!t) { first = false; return; }
        // 支持角色列表通常紧跟标题行；遇到规格/说明等小节标题就停止，避免把正文词建成角色
        if (!first && SUPPORT_END.test(t)) { stopped = true; return; }
        // 非标题行必须是“列表样”的短行：带项目符号 / 短且无句尾标点 / 本身是内联标题
        var inlineHeader = first || /対応(?:アバター|モデル|先)|supported\s+avatars?|以下のキャラクターに対応/i.test(t);
        var bulletLike = /^[・•\-*◦●○◆◇▶▷✧①-⑳\d]{1,4}\s*/.test(t);
        var shortBare = t.length <= 48 && !/[。！？!?…]/.test(t) && t.split(TOKEN_SPLIT).filter(Boolean).length <= 4;
        if (!inlineHeader && !bulletLike && !shortBare) { first = false; return; }
        first = false;
        var latins = [], others = [];
        line.split(TOKEN_SPLIT).forEach(function (raw) {
          var s = String(raw || '').trim();
          if (!s || !isLikelyRoleToken(s)) return;
          // 核心词与原文一致时保留原文大小写（NewRole 不变成 newrole）；只去后缀时用剥离后的核心词
          var core = stripTagDecorations(s);
          var name = s.toLowerCase() === core.toLowerCase() ? s : core;
          if (/^[A-Za-z]/.test(name)) latins.push(name); else others.push(name);
        });
        var n = Math.max(latins.length, others.length);
        for (var i = 0; i < n; i++) {
          var id = registerBlockRole({ en: latins[i] || '', other: others[i] || '' });
          if (id) ids.push(id);
        }
      });
      return uniq(ids);
    }

    var blockRoles = block ? extractBlockRoles(block) : [];
    var found = block ? scan(block).concat(blockRoles) : [];
    // 回退链：简介支持角色区块 → 标题 + 简介 → 标签
    if (!found.length) {
      found = scan([title, desc.slice(0, 4000)].join(' '));
    }
    if (!found.length) {
      found = scan((tags || []).join(' '));
    }
    /* v2.5.8（用户要求）：**变体名 / 文件名始终参与识别**，不再只当最后回退。
     * 理由：BOOTH 的一个变体就是「这一版给哪个角色用」（如「桔梗用 -Kikyo」），
     * 文件名同理（如 NM06_Chiffon.zip）——比正文里顺带提到的角色名更准。
     * 只**匹配已知角色**（scan 不注册新角色），与上面的结果取并集，不会引入脏角色。 */
    var variantText = (info.orderVersions || []).concat(info.versions || []).map(function (v) {
      return [v && v.name, v && v.fileName].filter(Boolean).join(' ');
    }).join(' ');
    var fromVariants = variantText ? scan(variantText) : [];
    var out = uniq(found.concat(fromVariants));
    // 「通用/多角色」只作备选：已经识别到具体支持角色时，不返回通用
    if (out.length > 1) {
      var detailed = out.filter(function (id) { return id !== 'universal'; });
      if (detailed.length) out = detailed;
    }
    if (stagedAny) App.saveSettings();
    return out;
  }

  /**
   * 从简介里解析版本信息（通常出现在商品简介末尾的「更新履歴 / 変更履歴」或 ver/v 标记处）
   */
  function extractVersionsFromText(text) {
    var s = String(text || '');
    if (!s) return [];
    var out = [], seen = {};
    function push(name, context) {
      var key = name.toLowerCase();
      if (!name || seen[key]) return;
      seen[key] = 1;
      out.push(Store.normalizeVersion({ name: name, note: (context || '').slice(0, 80) }));
    }
    // 明确的版本声明（优先从末尾 800 字符里找）
    var tail = s.slice(-800);
    var tailFirst = s.slice(0, 800);
    [tail, tailFirst].forEach(function (part) {
      var re = /(?:バージョン|対応バージョン|最新バージョン|version|ver\.?|v)\s*[:：]?\s*(\d+(?:\.\d+){0,3})/gi;
      var m;
      while ((m = re.exec(part)) && out.length < 12) {
        var ctx = part.slice(Math.max(0, m.index - 40), Math.min(part.length, m.index + 60)).replace(/\s+/g, ' ');
        push('v' + m[1], ctx);
      }
    });
    // 更新历史标题后的行（例：更新履歴 / 2024-12-01 v1.2 〇〇修正）
    var lines = s.split(/\n+/);
    for (var i = 0; i < lines.length && out.length < 12; i++) {
      var ln = lines[i].trim();
      if (!/更新履歴|変更履歴|update|changelog|history/i.test(ln)) continue;
      for (var j = i + 1; j < Math.min(lines.length, i + 20); j++) {
        var lm = lines[j].match(/(?:ver\.?|v)?\s*(\d+(?:\.\d+){1,3})\b/i);
        if (lm && lines[j].indexOf('円') < 0 && lines[j].indexOf('¥') < 0 && lines[j].indexOf('$') < 0) {
          push('v' + lm[1], lines[j].slice(0, 80));
        }
      }
    }
    // 括号内的独立版本标记
    var re2 = /[\(（【]?(v|ver\.?)\s*(\d+(?:\.\d+){0,3})[\)）】]?/gi, m2;
    while ((m2 = re2.exec(s)) && out.length < 12) {
      push('v' + m2[2], s.slice(Math.max(0, m2.index - 30), Math.min(s.length, m2.index + 40)).replace(/\s+/g, ' '));
    }
    return out.slice(0, 12);
  }

  /**
   * 从商品简介中提取「注意事项 / 使用条件 / 许可」等内容。
   * 常见于 BOOTH 描述的「注意」「免責」「禁止」「ライセンス」「利用規約」「クレジット」章节。
   */
  function extractNotes(text) {
    var s = String(text || '');
    if (!s) return '';
    var lines = s.split(/\n+/);
    var out = [], capturing = false;
    var START = /(注意|注意事項|免責|禁止事項|使用条件|利用規約|ライセンス|規約|クレジット|再配布|改変条件|商用利用|転載|使用許諾|禁止|must not|license|terms)/i;
    var STOP = /^(紹介|説明|内容|仕様|更新履歴|変更履歴|バージョン|サイズ|ポリゴン|シェーダー|収録内容|同梱物|動作環境|対応アバター|対応モデル)$/i;
    lines.forEach(function (ln) {
      var t = ln.trim();
      if (!t) return;
      if (START.test(t)) capturing = true;
      if (capturing && STOP.test(t)) capturing = false;
      if (capturing) out.push(t);
    });
    return out.slice(0, 30).join('\n');
  }

  /** 简介里存在简体中文时，只保留中文部分（多语言页面常见） */
  function hasChinese(text) {
    var c = (String(text || '').match(/[\u4E00-\u9FFF]/g) || []).length;
    var total = String(text || '').length;
    return total > 0 && c / total > 0.2;
  }

  function pickChinese(text) {
    var s = String(text || '');
    if (!s) return s;
    if (hasChinese(s)) {
      // 按行取中文含量高的行（如「简体中文」区块），否则整段保留
      var lines = s.split(/\n+/);
      var zhLines = lines.filter(function (l) { return hasChinese(l); });
      if (zhLines.length >= 2) return zhLines.join('\n');
    }
    return s;
  }

  /** 黑名单签名（内置表 + 用户两张表的内容指纹）——集合 / 正则表 / 批量作用域三处共用同一把尺 */
  function blacklistKey() {
    var user1 = App.settings.userTagStopwords || [];
    var user2 = App.settings.userTagBlacklist || [];
    return TAG_STOPWORDS.length + '|' + TAG_BLACKLIST.length + '|' + user1.length + '|' + user2.length + '|' + user1.join('\u0001') + '|' + user2.join('\u0001');
  }
  /** 黑名单集合（内置 + 用户追加；按用户设置签名缓存，避免每个标签都重建集合） */
  var _blacklistCache = null, _blacklistKey = '';
  function blacklistSet() {
    var user1 = App.settings.userTagStopwords || [];
    var user2 = App.settings.userTagBlacklist || [];
    var key = blacklistKey();
    if (_blacklistCache && _blacklistKey === key) return _blacklistCache;
    var set = Object.create(null);
    TAG_STOPWORDS.concat(TAG_BLACKLIST, user1, user2).forEach(function (w) {
      var low = String(w).toLowerCase();
      set[low] = 1;
      var norm = normalizeTagToken(w);
      if (norm) set[norm] = 1;
    });
    _blacklistCache = set; _blacklistKey = key;
    return set;
  }

  /** 黑名单里以 /pattern/flags 形式书写的条目 → RegExp（无法编译的按普通文本处理） */
  var _blacklistRegexCache = null, _blacklistRegexKey = '';
  function blacklistRegexes() {
    var user1 = App.settings.userTagStopwords || [];
    var user2 = App.settings.userTagBlacklist || [];
    var key = blacklistKey();
    if (_blacklistRegexCache && _blacklistRegexKey === key) return _blacklistRegexCache;
    var out = [];
    TAG_STOPWORDS.concat(TAG_BLACKLIST, user1, user2).forEach(function (w) {
      var s = String(w || '').trim();
      var m = s.match(/^\/(.+)\/([a-z]*)$/i);
      if (!m) return;
      try { out.push(new RegExp(m[1], m[2])); } catch (e) { /* 非法正则按普通文本保留在 blacklistSet 里 */ }
    });
    _blacklistRegexCache = out; _blacklistRegexKey = key;
    return out;
  }

  /** 标签是否命中黑名单（精确 / 归一化 / 正则三种匹配）——集合与正则表由调用方给，便于批量作用域复用 */
  function blacklistHit(tag, set, res) {
    var low = String(tag == null ? '' : tag).toLowerCase();
    var norm = normalizeTagToken(tag);
    if (set[low] || (norm && set[norm])) return true;
    for (var i = 0; i < res.length; i++) {
      var re = res[i];
      re.lastIndex = 0;
      if (re.test(String(tag == null ? '' : tag)) || re.test(low)) return true;
    }
    return false;
  }
  function isBlacklisted(tag) { return blacklistHit(tag, blacklistSet(), blacklistRegexes()); }

  /** 过滤黑名单标签（中日韩英、分类重叠、文件格式等；同时用归一化 token 与正则匹配）
   *  scope：可选的**批量作用域**（见 newBatchScope）——一次清洗里只算一遍签名与正则表 */
  function filterBlacklist(tags, scope) {
    var list = tags || [];
    if (!list.length) return [];
    var set, res;
    if (scope) {
      var key = blacklistKey();
      if (scope.blKey !== key) { scope.blKey = key; scope.blSet = blacklistSet(); scope.blRes = blacklistRegexes(); }
      set = scope.blSet; res = scope.blRes;
    } else {
      set = blacklistSet(); res = blacklistRegexes();
    }
    return uniq(list.filter(function (t) { return !blacklistHit(t, set, res); }));
  }

  /** 单个标签是否可视为某角色名的等价变体（如 萌対応 / 萌ちゃん対応 / 桔梗3D / 桔梗酱対応） */
  var AVATAR_SUFFIX_TOKENS = '対応済み|対応|适配|对应|向け|用|用衣装|対応衣装|改変|衣装|髪型|发型|アクセサリー|アクセ|配饰|モデル|模型|版|ちゃん|酱|chan|等|など|専用|专用|3d|3d模型|3dモデル|dlc|差分|様';
  /* v2.5.7（性能，实测驱动）：这三个正则由**常量**拼出，原先却写在函数体内**每次调用现场编译**。
   * 实测：reload() 里 purgeAvatarTags 占 3715ms（86%），根因就是 isAvatarEquivalent 对每个标签
   * 遍历全部角色×别名（约 700 次 avatarNameMatch），每次又编译 2~3 个正则 = 每标签上千次编译。 */
  var AV_SUFFIX_RE_END = new RegExp('(' + AVATAR_SUFFIX_TOKENS + ')$');
  var AV_SUFFIX_RE_ALL = new RegExp('^(?:' + AVATAR_SUFFIX_TOKENS + ')+$');
  var AV_DECOR_HEAD = /^[#＃【\[（(]+/;
  var AV_DECOR_TAIL = /[】\]）)]+$/;
  var AV_SPACES_G = /\s+/g;
  function stripTagDecorations(s) {
    var t = String(s == null ? '' : s).trim().toLowerCase()
      .replace(AV_DECOR_HEAD, '').replace(AV_DECOR_TAIL, '')
      .replace(AV_SPACES_G, ' ').trim();
    var prev = '';
    while (t && t !== prev) {
      prev = t;
      t = t.replace(AV_SUFFIX_RE_END, '').trim();
    }
    return t;
  }
  function avatarNameMatch(tag, name) {
    var s = stripTagDecorations(tag);
    var a = stripTagDecorations(name);
    if (!s || !a) return false;
    // 单个 CJK 字（如“萌”）可以参与匹配；单个拉丁字母不行
    if (a.length < 2 && /^[a-z0-9]$/i.test(a)) return false;
    if (s === a) return true;
    // 兼容“角色名 + 剩余后缀”（旧逻辑：剩余部分必须是已知后缀组合）
    var idx = s.indexOf(a);
    if (idx < 0) return false;
    var left = s.slice(0, idx);
    if (left.length > 2) return false;
    var right = s.slice(idx + a.length);
    if (!right) return true;
    return AV_SUFFIX_RE_ALL.test(right);
  }

  /* v2.5.7（性能）：「单次调用内批量化」，**不做跨调用缓存**——
   * 原实现 purgeAvatarTags 对**每个标签**都重建一遍角色名表（上百个别名逐个 strip），
   * 一次清洗 425 条素材要做几十万次重复 strip。现在一次 purgeAvatarTags 只建一遍名表。
   * 不跨调用缓存 = 设置改了立刻生效，不会出现"改了不生效"的隐性 bug。 */
  function avatarStrippedNames(list) {
    var out = [];
    (list || App.allAvatars()).forEach(function (av) {
      [av.label].concat(av.alias || []).forEach(function (n) {
        var s = stripTagDecorations(n);
        if (s) out.push(s);
      });
    });
    return out;
  }
  /** 已去装饰的标签 s 是否命中名表（判定逐条对齐 avatarNameMatch） */
  function strippedMatchesAny(s, names) {
    for (var i = 0; i < names.length; i++) {
      var a = names[i];
      if (a.length < 2 && /^[a-z0-9]$/i.test(a)) continue;   // 单个拉丁字母不参与匹配
      if (s === a) return true;
      var idx = s.indexOf(a);
      if (idx < 0) continue;
      if (idx > 2) continue;                                  // left.length > 2 → 不匹配
      var right = s.slice(idx + a.length);
      if (!right) return true;
      if (AV_SUFFIX_RE_ALL.test(right)) return true;
    }
    return false;
  }
  /** 该标签是否与任意角色名等价（含常见后缀组合） */
  function isAvatarEquivalent(tag) {
    var s = stripTagDecorations(tag);
    return !!s && strippedMatchesAny(s, avatarStrippedNames());
  }

  /* v2.5.13（性能复查第 2 轮）：把 v2.5.7 的「单次调用内批量化」再推一层到「**单次批量作用域内**批量化」。
   * reload() 一轮要清洗 425 条素材 × 2 份标签 = 850 次，每次都重建一遍角色名表（≈275ms，实测）。
   * 作用域由调用方创建（App.newScope()）、用完即弃 —— **不是跨调用缓存**；
   * 且 App.scopeToken() 盯着三张角色设置表的**引用**，任一被换掉就整体作废重建，
   * 因此与「每次现算」逐条等价（含循环中途清理工具名角色那一次）。
   * v2.5.7 立的护栏不变：**不传 scope 的调用照旧每次现算**（冒烟里有专门断言）。 */
  function newBatchScope() { return { blKey: '' }; }
  function scopeNames(scope) {
    if (!scope) return avatarStrippedNames();
    if (typeof App.scopeToken === 'function') App.scopeToken(scope);
    if (scope.tagNames) return scope.tagNames;
    var list = (typeof App.scopeAvatars === 'function') ? App.scopeAvatars(scope) : App.allAvatars();
    scope.tagNames = avatarStrippedNames(list);
    return scope.tagNames;
  }

  /** 移除标签里的角色名（多语言别名 + 变体等价都覆盖）——名表在本函数内只建一遍
   *  scope：可选的**批量作用域**——整轮清洗共用一张名表（作用域内只建一遍） */
  function purgeAvatarTags(tags, scope) {
    var list = tags || [];
    if (!list.length) return [];
    var names = scopeNames(scope);
    return uniq(list.filter(function (t) {
      var s = stripTagDecorations(t);
      return !(s && strippedMatchesAny(s, names));
    }));
  }

  return {
    translateTag: translateTag, translateTags: translateTags, isUntranslated: isUntranslated,
    mergeSynonym: mergeSynonym, MERGE_MAP: MERGE_MAP, normalizeTagToken: normalizeTagToken,
    guessCategory: guessCategory, detectAvatars: detectAvatars,
    mapShopCategory: mapShopCategory, BOOTH_CATEGORY_MAP: BOOTH_CATEGORY_MAP,
    blacklistSet: blacklistSet, blacklistRegexes: blacklistRegexes, isBlacklisted: isBlacklisted, filterBlacklist: filterBlacklist,

    extractVersionsFromText: extractVersionsFromText,
    extractNotes: extractNotes,
    hasChinese: hasChinese, pickChinese: pickChinese, purgeAvatarTags: purgeAvatarTags, newBatchScope: newBatchScope,
    avatarNameMatch: avatarNameMatch, isAvatarEquivalent: isAvatarEquivalent
  };
})();

