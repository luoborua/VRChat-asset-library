// ==UserScript==
// @name         VRC 素材库桥接 (vrc-library-bridge)
// @namespace    https://github.com/local/vrchat-asset-library
// @version      1.0.0
// @description  在 BOOTH / Gumroad 页面上导出「已购买素材 + 下载直链 + 商品信息」为 JSON，供「VRChat 改模素材管理库」导入。全程使用你自己已登录的会话，不需要也不会读取账号密码。
// @author       VRChat 改模素材管理库
// @match        https://booth.pm/*
// @match        https://*.booth.pm/*
// @match        https://accounts.booth.pm/*
// @match        https://app.gumroad.com/*
// @match        https://gumroad.com/*
// @grant        GM_setClipboard
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  var SITE = /booth\.pm$/.test(location.hostname) ? 'booth'
           : (/gumroad\.com$/.test(location.hostname) ? 'gumroad' : 'other');

  var collected = [];       // 收集到的商品
  var seen = Object.create(null);

  /* ------------------------------------------------------------------ 工具 */
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function txt(n) { return n ? (n.textContent || '').trim() : ''; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function addItem(it) {
    if (!it) return;
    var key = (it.itemId || it.url || it.title);
    if (!key || seen[key]) {
      if (seen[key]) {   // 合并下载链接
        var old = collected.filter(function (x) { return (x.itemId || x.url || x.title) === key; })[0];
        if (old && it.downloads) {
          var have = {};
          old.downloads.forEach(function (d) { have[d.url] = 1; });
          it.downloads.forEach(function (d) { if (!have[d.url]) old.downloads.push(d); });
        }
      }
      return;
    }
    seen[key] = 1;
    collected.push(it);
    updateCount();
  }

  /* ------------------------------------------------------------- BOOTH 解析 */
  function boothItemIdFrom(href) {
    var m = String(href || '').match(/\/items\/(\d+)/);
    return m ? m[1] : '';
  }

  /** 商品页 / 任意页面：调用官方 JSON 接口拿完整信息（依赖当前登录态） */
  function fetchBoothItem(id) {
    return fetch('https://booth.pm/ja/items/' + id + '.json', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return null;
        var images = (d.images || []).map(function (im) { return im.original || im.resized; }).filter(Boolean);
        var downloads = [];
        (d.variations || []).forEach(function (v) {
          var dl = v && v.downloadable;
          if (!dl || typeof dl !== 'object') return;
          Object.keys(dl).forEach(function (k) {
            if (!Array.isArray(dl[k])) return;
            dl[k].forEach(function (f) {
              if (!f) return;
              downloads.push({
                name: f.name || f.file_name || '',
                url: f.url || (f.id ? 'https://booth.pm/downloadables/' + f.id : ''),
                size: Number(f.file_size || f.size || 0) || 0
              });
            });
          });
        });
        return {
          itemId: String(d.id || id),
          url: 'https://booth.pm/ja/items/' + (d.id || id),
          title: d.name || '',
          description: String(d.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000),
          price: d.price != null ? String(d.price) : '',
          images: images,
          tags: (d.tags || []).map(function (t) { return t && (t.name || t); }).filter(Boolean),
          shop: (d.shop && d.shop.name) || '',
          shopUrl: (d.shop && d.shop.url) || '',
          category: (d.category && d.category.name) || '',
          downloads: downloads.filter(function (x) { return x.url; }),
          purchased: downloads.length > 0
        };
      }).catch(function () { return null; });
  }

  /** 库页面 / 列表页：从任意 document 中抠出商品与下载链接 */
  function scrapeBoothDOM(doc) {
    doc = doc || document;
    var _$$ = function (sel) { return Array.prototype.slice.call(doc.querySelectorAll(sel)); };
    var map = Object.create(null);
    function ensure(id) {
      if (!map[id]) map[id] = { itemId: id, url: 'https://booth.pm/ja/items/' + id, title: '', shop: '', shopUrl: '', images: [], tags: [], downloads: [], purchased: true, gifted: false };
      return map[id];
    }
    function looksGifted(anchor) {
      var node = anchor;
      for (var i = 0; i < 5 && node; i++) {
        var t = (node.textContent || '');
        if (t.length < 2000 && /ギフト済み|ギフトを贈|ギフトを送|贈ったギフト|送ったギフト|ギフト送付済み|gifted/i.test(t)) return true;
        node = node.parentElement;
      }
      return false;
    }
    _$$('a[href*="/items/"]').forEach(function (a) {
      var id = boothItemIdFrom(a.getAttribute('href')); if (!id) return;
      var it = ensure(id);
      if (looksGifted(a)) it.gifted = true;
      var t = txt(a);
      if (t && t.length > 1 && t.length < 200 && !it.title) it.title = t;
      var img = a.querySelector('img');
      if (img) { var s = img.getAttribute('src') || img.getAttribute('data-src'); if (s) it.images.push(s); }
    });
    _$$('a[href*="/downloadables/"]').forEach(function (a) {
      var node = a, id = '';
      for (var i = 0; i < 8 && node; i++) {
        var link = node.querySelector && node.querySelector('a[href*="/items/"]');
        if (link) { id = boothItemIdFrom(link.getAttribute('href')); if (id) break; }
        node = node.parentElement;
      }
      if (!id) return;
      var it = ensure(id);
      var name = txt(a);
      if (!name || name.length < 3) {
        var m = txt(a.parentElement).match(/[^\s\/\\]+\.(zip|rar|7z|unitypackage|png|jpg|jpeg|pdf|txt|fbx|psd)/i);
        if (m) name = m[0];
      }
      var href = a.getAttribute('href') || '';
      it.downloads.push({ name: name || '下载文件', url: href.indexOf('http') === 0 ? href : ('https://booth.pm' + href), size: 0 });
    });
    // 店铺名
    _$$('a[href*=".booth.pm"]').forEach(function (a) {
      var host = ''; try { host = new URL(a.getAttribute('href'), location.origin).hostname; } catch (e) { return; }
      if (!host || host === 'booth.pm' || host === 'accounts.booth.pm') return;
      var node = a;
      for (var i = 0; i < 8 && node; i++) {
        var link = node.querySelector && node.querySelector('a[href*="/items/"]');
        if (link) {
          var id = boothItemIdFrom(link.getAttribute('href'));
          if (id && map[id] && !map[id].shop) { map[id].shop = txt(a).slice(0, 60); map[id].shopUrl = 'https://' + host + '/'; }
          break;
        }
        node = node.parentElement;
      }
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .filter(function (x) { return !x.gifted && (x.title || x.downloads.length); });
  }

  /* ----------------------------------------------------------- Gumroad 解析 */
  function scrapeGumroadDOM() {
    var out = [];
    // 优先从页面内嵌的 JSON 数据里取
    $$('script[data-component-name], div[data-react-props], div[data-page]').forEach(function (n) {
      var raw = n.getAttribute('data-react-props') || n.getAttribute('data-page') || n.textContent;
      var d; try { d = JSON.parse(raw); } catch (e) { return; }
      var list = (d && (d.results || d.products || (d.props && d.props.products))) || null;
      if (!Array.isArray(list)) return;
      list.forEach(function (p) {
        if (!p || typeof p !== 'object') return;
        var prod = p.product || p;
        out.push({
          itemId: String(prod.id || prod.permalink || ''),
          url: prod.url || prod.permalink_url || location.href,
          title: prod.name || prod.title || '',
          description: String(prod.description || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 2000),
          price: String(prod.formatted_price || prod.price || ''),
          images: [prod.thumbnail_url || prod.preview_url].filter(Boolean),
          tags: Array.isArray(prod.tags) ? prod.tags.map(String) : [],
          shop: (prod.creator && (prod.creator.name || prod.creator.display_name)) || '',
          shopUrl: (prod.creator && prod.creator.profile_url) || '',
          downloads: (prod.download_url ? [{ name: prod.name || '下载', url: prod.download_url, size: 0 }] : []),
          purchased: true
        });
      });
    });
    if (out.length) return out;
    // 回退：直接扫 DOM 卡片
    $$('a[href*="/d/"], a[href*="/l/"]').forEach(function (a) {
      var card = a.closest('[class*="product"], article, li') || a.parentElement;
      var title = txt(card && card.querySelector('h3, h4, [class*="title"]')) || txt(a);
      if (!title) return;
      var img = card && card.querySelector('img');
      out.push({
        itemId: '', url: a.href, title: title,
        images: img ? [img.getAttribute('src')].filter(Boolean) : [],
        tags: [], shop: txt(card && card.querySelector('[class*="creator"], [class*="seller"]')),
        downloads: /\/d\//.test(a.href) ? [{ name: title, url: a.href, size: 0 }] : [],
        purchased: true
      });
    });
    return out;
  }

  /* ------------------------------------------------------------- 翻页收集 */
  function currentPageNo() {
    var m = location.search.match(/[?&]page=(\d+)/);
    return m ? parseInt(m[1], 10) : 1;
  }

  function collectAllPages(maxPages, withDetail, onLog) {
    var base = location.origin + location.pathname;
    var page = 1, empty = 0;
    function step() {
      if (page > maxPages || empty >= 2) return Promise.resolve();
      var url = base + '?page=' + page;
      onLog('抓取第 ' + page + ' 页 …');
      return fetch(url, { credentials: 'include' })
        .then(function (r) { return r.ok ? r.text() : ''; })
        .then(function (html) {
          if (!html) { empty++; page++; return sleep(250).then(step); }
          var doc = new DOMParser().parseFromString(html, 'text/html');
          var found = SITE === 'booth' ? scrapeBoothDOM(doc) : [];
          if (!found.length) empty++; else empty = 0;
          found.forEach(addItem);
          onLog('第 ' + page + ' 页：' + found.length + ' 项（累计 ' + collected.length + '）');
          page++;
          return sleep(400).then(step);
        }).catch(function (e) { onLog('第 ' + page + ' 页失败：' + e.message); page++; empty++; return sleep(400).then(step); });
    }
    return step().then(function () {
      if (!withDetail || SITE !== 'booth') return;
      var targets = collected.filter(function (c) { return c.itemId && !c.tags.length; });
      onLog('开始补全 ' + targets.length + ' 个商品的详细信息（较慢）…');
      var i = 0;
      function detail() {
        if (i >= targets.length) return Promise.resolve();
        var c = targets[i++];
        return fetchBoothItem(c.itemId).then(function (full) {
          if (full) {
            c.title = full.title || c.title;
            c.description = full.description;
            c.price = full.price;
            c.tags = full.tags;
            c.images = (c.images || []).concat(full.images);
            c.shop = c.shop || full.shop;
            c.shopUrl = c.shopUrl || full.shopUrl;
            c.category = full.category;
            var have = {}; c.downloads.forEach(function (d) { have[d.url] = 1; });
            full.downloads.forEach(function (d) { if (!have[d.url]) c.downloads.push(d); });
          }
          if (i % 5 === 0) onLog('已补全 ' + i + ' / ' + targets.length);
          return sleep(350).then(detail);
        }).catch(function () { return sleep(350).then(detail); });
      }
      return detail();
    });
  }

  /* ------------------------------------------------------------------ 面板 */
  var panel, logEl, countEl;

  function updateCount() { if (countEl) countEl.textContent = String(collected.length); }
  function log(m) {
    if (!logEl) return;
    var d = document.createElement('div');
    d.textContent = m;
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function payload() {
    return {
      app: 'vrc-library-bridge', version: 1, site: SITE,
      exportedAt: new Date().toISOString(),
      pageUrl: location.href,
      items: collected
    };
  }

  function copyJSON() {
    var s = JSON.stringify(payload(), null, 2);
    if (typeof GM_setClipboard === 'function') { GM_setClipboard(s, 'text'); log('\u2714 已复制到剪贴板（' + collected.length + ' 项）'); return; }
    navigator.clipboard.writeText(s).then(function () { log('\u2714 已复制到剪贴板（' + collected.length + ' 项）'); })
      .catch(function () { log('\u2716 复制失败，请改用「下载 JSON」'); });
  }
  function downloadJSON() {
    var blob = new Blob([JSON.stringify(payload(), null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vrc-library-' + SITE + '-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 500);
    log('\u2714 已下载 JSON（' + collected.length + ' 项）');
  }

  function build() {
    panel = document.createElement('div');
    panel.id = 'vrc-bridge-panel';
    panel.innerHTML = [
      '<div class="vb-head"><b>VRC 素材库桥接</b><span class="vb-count">0</span><button class="vb-min">\u2013</button></div>',
      '<div class="vb-body">',
      '  <div class="vb-row"><button class="vb-btn vb-item">导出本页商品</button>',
      '       <button class="vb-btn vb-page">导出本页列表</button></div>',
      '  <div class="vb-row"><button class="vb-btn vb-all">导出全部页（自动翻页）</button></div>',
      '  <label class="vb-chk"><input type="checkbox" class="vb-detail" checked> 同时补全每个商品的详细信息（较慢）</label>',
      '  <div class="vb-row"><button class="vb-btn vb-copy">复制 JSON</button>',
      '       <button class="vb-btn vb-dl">下载 JSON</button>',
      '       <button class="vb-btn vb-clear">清空</button></div>',
      '  <div class="vb-log"></div>',
      '</div>'
    ].join('');
    document.body.appendChild(panel);

    var css = document.createElement('style');
    css.textContent = [
      '#vrc-bridge-panel{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:300px;',
      'background:#161a21;color:#e6e9ef;border:1px solid #2a303b;border-radius:12px;',
      'font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.45)}',
      '#vrc-bridge-panel .vb-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #2a303b}',
      '#vrc-bridge-panel .vb-count{margin-left:auto;background:#6d8cff;color:#fff;border-radius:20px;padding:0 8px;font-size:12px}',
      '#vrc-bridge-panel .vb-min{background:none;border:0;color:#a3abbb;cursor:pointer;font-size:16px;line-height:1}',
      '#vrc-bridge-panel .vb-body{padding:10px 12px;display:flex;flex-direction:column;gap:7px}',
      '#vrc-bridge-panel.min .vb-body{display:none}',
      '#vrc-bridge-panel .vb-row{display:flex;gap:6px;flex-wrap:wrap}',
      '#vrc-bridge-panel .vb-btn{flex:1;min-width:88px;background:#222831;color:#e6e9ef;border:1px solid #333b48;',
      'border-radius:7px;padding:6px 8px;cursor:pointer;font-size:12.5px}',
      '#vrc-bridge-panel .vb-btn:hover{background:#2b323d;border-color:#46506180}',
      '#vrc-bridge-panel .vb-chk{display:flex;gap:6px;align-items:center;color:#a3abbb;font-size:12px}',
      '#vrc-bridge-panel .vb-log{max-height:150px;overflow:auto;background:#0f1319;border:1px solid #2a303b;',
      'border-radius:7px;padding:6px 8px;font-family:Consolas,monospace;font-size:11.5px;color:#a3abbb}'
    ].join('');
    document.head.appendChild(css);

    logEl = panel.querySelector('.vb-log');
    countEl = panel.querySelector('.vb-count');

    panel.querySelector('.vb-min').onclick = function () { panel.classList.toggle('min'); };

    panel.querySelector('.vb-item').onclick = function () {
      if (SITE === 'booth') {
        var id = boothItemIdFrom(location.pathname);
        if (!id) { log('\u2716 当前不是 BOOTH 商品页'); return; }
        log('读取商品 ' + id + ' …');
        fetchBoothItem(id).then(function (it) {
          if (!it) { log('\u2716 读取失败'); return; }
          addItem(it);
          log('\u2714 已加入：' + it.title + (it.downloads.length ? '（含 ' + it.downloads.length + ' 个下载文件）' : '（未购买或无下载）'));
        });
      } else {
        var arr = scrapeGumroadDOM();
        arr.forEach(addItem);
        log('\u2714 本页解析到 ' + arr.length + ' 项');
      }
    };

    panel.querySelector('.vb-page').onclick = function () {
      var arr = SITE === 'booth' ? scrapeBoothDOM() : scrapeGumroadDOM();
      arr.forEach(addItem);
      log('\u2714 本页解析到 ' + arr.length + ' 项（累计 ' + collected.length + '）');
    };

    panel.querySelector('.vb-all').onclick = function () {
      var withDetail = panel.querySelector('.vb-detail').checked;
      log('开始自动翻页收集 …');
      collectAllPages(30, withDetail, log).then(function () {
        log('\u2014\u2014 收集完成，共 ' + collected.length + ' 项 \u2014\u2014');
      });
    };

    panel.querySelector('.vb-copy').onclick = copyJSON;
    panel.querySelector('.vb-dl').onclick = downloadJSON;
    panel.querySelector('.vb-clear').onclick = function () {
      collected = []; seen = Object.create(null); updateCount(); log('已清空');
    };

    log('站点：' + SITE + '　路径：' + location.pathname);
    if (/\/library/.test(location.pathname)) log('检测到库页面，可直接点「导出全部页」。');
    else if (SITE === 'booth' && boothItemIdFrom(location.pathname)) log('检测到商品页，可点「导出本页商品」。');
    else log('提示：打开 accounts.booth.pm/library 或 app.gumroad.com/library 效果最好。');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();