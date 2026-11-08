/*
 * 10-util.js —— 通用工具：DOM 构造、路径与文本处理、图片与剪贴板、提示条。
 * 交互：渲染层各模块直接调用；本文件不持有状态，也不读写存储。
 * 边界：只做纯换算与浏览器 API 包装，业务规则留在各自模块。
 */

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

/** 创建元素：el('div', {class:'x', onclick:fn}, [child|string]) */
function el(tag, attrs, children) {
  var node = document.createElement(tag);
  if (attrs) {
    for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class' || k === 'className') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') { for (var s in v) node.style[s] = v[s]; }
      else if (k === 'dataset') { for (var d in v) node.dataset[d] = v[d]; }
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  if (children != null) appendChildren(node, children);
  return node;
}
function appendChildren(node, children) {
  if (!Array.isArray(children)) children = [children];
  children.forEach(function (c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { appendChildren(node, c); return; }
    if (typeof c === 'string' || typeof c === 'number') node.appendChild(document.createTextNode(String(c)));
    else node.appendChild(c);
  });
}

/** HTML 转义 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function uid(prefix) {
  return (prefix || 'a') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function nowISO() { return new Date().toISOString(); }

function fmtDate(iso, withTime) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  var p = function (n) { return n < 10 ? '0' + n : '' + n; };
  var s = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  if (withTime) s += ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  return s;
}

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '—';
  var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0, n = Number(bytes);
  if (!isFinite(n) || n < 0) return '—';   // 非有限值不参与换算，否则界面会显示 NaN KB
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 2 : 1)) + ' ' + u[i];
}

/**
 * Windows 路径工具：本地磁盘路径统一走这里，避免各处手拼反斜杠。
 * 注意源码转义：写 '\\' 得到一个反斜杠，写 '\\\\' 会得到运行时的两个。
 */
function normalizeWinPath(p) {
  var s = String(p == null ? '' : p).trim();
  if (!s) return '';
  s = s.replace(/\//g, '\\');
  var unc = /^\\\\/.test(s);          // 先统一分隔符再判 UNC，否则 //server/share 会被压成 \server\share
  s = s.replace(/\\+/g, '\\');
  if (unc) s = '\\' + s;
  return s.replace(/\\+$/, '');
}
function joinWinPath(root, parts) {
  var segs = [String(root == null ? '' : root).replace(/[\\/]+$/, '')];
  (parts || []).forEach(function (p) {
    var seg = String(p == null ? '' : p).replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
    if (seg) segs.push(seg);
  });
  return normalizeWinPath(segs.join('\\'));
}
function isAbsoluteWinPath(p) {
  var s = normalizeWinPath(p);
  return /^[A-Za-z]:[\\/]/.test(s) || /^[A-Za-z]:$/.test(s) || /^\\\\/.test(s);
}

/**
 * 图片文件（封面 / 预览图 / 截图）。
 * 本地文件对账时一律跳过：它们是封面与图集的附属物，不该在「额外文件 / DLC」里占一行，
 * 删掉一张预览图也不该被当成「本体缺失」。
 */
function isImageFileName(name) {
  return /\.(png|jpe?g|webp|gif|bmp|avif|ico|tga|tiff?|heic|jfif|svg)$/i.test(String(name || '').trim());
}
/**
 * 从素材名 / 文件名里认出 BOOTH 商品编号。
 * 下载站的落地命名五花八门，能用同一套规则吃下的就这几类：
 *   `[5058951]-オフショルケーブルニットワンピース`、`(5058951) xxx`、`【5058951】xxx`、
 *   `5058951_衣装`、`5058951-xxx`、以及整个名字就是 `5058951`。
 * 只认 5~9 位纯数字：版本号（带小数点）、4 位年份、8 位日期（20240101）都不算编号，
 * 否则 `2024-01-05 衣装` 这种会被当成商品页去请求。
 */
function boothIdFromName(name) {
  var s = String(name == null ? '' : name).trim();
  if (!s) return '';
  /* 去掉扩展名：`5058951.zip` 也要能认出来。只截 2~5 位的常见后缀，
   * 免得把「5058951_A案」里的点当成扩展名分隔。 */
  s = s.replace(/\.(zip|rar|7z|unitypackage|txt|url|png|jpe?g|webp|gif|bmp)$/i, '').trim();
  if (!s) return '';
  function usable(d) {
    if (!/^\d{5,9}$/.test(d)) return false;
    /* 8 位日期（20240101 / 19991231）是「上架日期」味的目录名，不是商品号 */
    if (/^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(d)) return false;
    return true;
  }
  if (usable(s)) return s;                                        // 整个名字就是编号
  var m = s.match(/^[\[\(（【]\s*(\d{5,9})\s*[\]\)）】]/);          // [5058951]-xxx / (5058951) xxx
  if (m && usable(m[1])) return m[1];
  m = s.match(/^(\d{5,9})(?=[\s\-_.]|$)/);                        // 5058951_xxx / 5058951 xxx
  if (m && usable(m[1])) return m[1];
  return '';
}

function concatUnique(arr1, arr2, keyFn) {
  var seen = Object.create(null), out = [];
  (arr1 || []).concat(arr2 || []).forEach(function (v) {
    var k = keyFn ? keyFn(v) : v;
    if (k === undefined || k === null || k === '') return;
    if (seen[k]) return;
    seen[k] = 1; out.push(v);
  });
  return out;
}

function debounce(fn, ms) {
  var t; return function () {
    var a = arguments, self = this;
    clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms || 200);
  };
}

/** 轻量混淆存储（非加密，仅防肩窥；界面会明确提示风险） */
function obfuscate(str) {
  if (!str) return '';
  try {
    var key = 'vrc-lib-2024';
    var out = '';
    for (var i = 0; i < str.length; i++) {
      out += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return 'ob:' + btoa(unescape(encodeURIComponent(out)));
  } catch (e) { return str; }
}
function deobfuscate(str) {
  if (!str) return '';
  if (String(str).slice(0, 3) !== 'ob:') return str;
  try {
    var key = 'vrc-lib-2024';
    var raw = decodeURIComponent(escape(atob(String(str).slice(3))));
    var out = '';
    for (var i = 0; i < raw.length; i++) {
      out += String.fromCharCode(raw.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return out;
  } catch (e) { return ''; }
}

/** 提示条 */
var Toast = {
  /** 组装一条提示。ms > 0 时顶部有一条倒计时进度条，走完自动关闭 —— 所有有时限的
   *  提示都走这里，别再各写一套：进度条是 CSS 动画、关闭是 setTimeout，
   *  两者共用同一个 ms，分开算就会出现「条走完了窗还在」。 */
  make: function (opts) {
    opts = opts || {};
    var root = $('#toastRoot');
    if (!root) { console.log('[toast]', opts.msg); return null; }
    var type = opts.type || 'info';
    var ms = (opts.ms == null) ? 2600 : Number(opts.ms);
    var icons = { ok: 'check', err: 'error', warn: 'warning', info: 'info' };   // 图标位用内联 SVG，不依赖字体
    var closed = false, timer = null;
    var bar = ms > 0 ? el('i', { style: { animationDuration: ms + 'ms' } }) : null;
    var actBtn = null;
    if (opts.action && typeof opts.action.onClick === 'function') {
      actBtn = el('button', { class: 'toast-act', type: 'button' }, opts.action.text || '撤回');
    }
    var node = el('div', {
      class: 'toast toast-' + type + (ms > 0 ? ' toast-timed' : '') + (actBtn ? ' toast-undo' : '')
    }, [
      bar ? el('div', { class: 'toast-prog' }, [bar]) : null,
      el('div', { class: 'toast-row' }, [
        ICONS.make(opts.icon || icons[type] || 'info', { size: 15, class: 'toast-ico' }),
        el('span', { class: 'toast-msg', text: opts.msg }),
        actBtn
      ])
    ]);
    function close() {
      if (closed) return;
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      node.classList.remove('in');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 260);
    }
    if (actBtn) {
      actBtn.addEventListener('click', function () {
        if (closed) return;
        actBtn.disabled = true;      // 连点两次会把同一件事做两遍（恢复、撤回都是写库）
        close();
        try { opts.action.onClick(); }
        catch (e) { if (window.console) console.warn('[toast] 动作失败：' + ((e && e.message) || e)); }
      });
    }
    root.appendChild(node);
    requestAnimationFrame(function () { node.classList.add('in'); });
    if (ms > 0) timer = setTimeout(close, ms);
    return { node: node, close: close };
  },

  show: function (msg, type, ms) {
    var h = Toast.make({ msg: msg, type: type, ms: ms });
    return h ? h.node : null;
  },
  ok: function (m, ms) { return Toast.show(m, 'ok', ms); },
  err: function (m, ms) { return Toast.show(m, 'err', ms || 4200); },
  warn: function (m, ms) { return Toast.show(m, 'warn', ms || 3600); },
  info: function (m, ms) { return Toast.show(m, 'info', ms); },

  /** 可撤销提示：10 秒内点按钮执行 onAction，进度条走完就关（关闭与条共用同一个 ms） */
  undo: function (msg, opts) {
    opts = opts || {};
    var ms = Math.max(1000, opts.ms || 10000);
    return Toast.make({
      msg: msg, type: 'info', ms: ms, icon: opts.icon || 'trash',
      action: {
        text: opts.actionText || '撤回',
        onClick: function () { if (typeof opts.onAction === 'function') opts.onAction(); }
      }
    });
  }
};

/** 复制到剪贴板；非安全上下文没有 navigator.clipboard，退回 execCommand */
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(function () { return true; }).catch(fallback);
  }
  return Promise.resolve(fallback());
  function fallback() {
    try {
      var ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
      ta.value = text; document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }
}

/** 触发浏览器下载 */
function downloadBlob(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = el('a', { href: url, download: filename });
  document.body.appendChild(a); a.click();
  setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 400);
}

/** 读取文件为 DataURL */
function fileToDataURL(file) {
  return new Promise(function (res, rej) {
    var fr = new FileReader();
    fr.onload = function () { res(fr.result); };
    fr.onerror = function () { rej(fr.error); };
    fr.readAsDataURL(file);
  });
}

/** 图片压缩：输入 Blob/File/DataURL/URL，输出压缩后的 Blob（webp 优先） */
function compressImage(src, maxWidth, quality) {
  maxWidth = maxWidth || 720; quality = quality || 0.82;
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.crossOrigin = 'anonymous';
    var revoke = null;
    img.onload = function () {
      try {
        var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (!w || !h) throw new Error('图片尺寸无效');
        var scale = Math.min(1, maxWidth / w);
        var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        var cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        var ctx = cv.getContext('2d');
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, cw, ch);
        var mime = 'image/webp';
        var test = cv.toDataURL(mime);
        if (test.indexOf('data:image/webp') !== 0) mime = 'image/jpeg';
        cv.toBlob(function (blob) {
          if (revoke) URL.revokeObjectURL(revoke);
          if (blob) resolve(blob); else reject(new Error('压缩失败'));
        }, mime, quality);
      } catch (e) { if (revoke) URL.revokeObjectURL(revoke); reject(e); }
    };
    img.onerror = function () { if (revoke) URL.revokeObjectURL(revoke); reject(new Error('图片加载失败（可能被跨域策略阻止）')); };
    if (typeof src === 'string') img.src = src;
    else { revoke = URL.createObjectURL(src); img.src = revoke; }
  });
}

/** 图片转 PNG；本身已是 PNG 且不需缩放时原样返回，避免二次编码掉画质 */
function toPngBlob(src, maxWidth) {
  if (src && typeof src !== 'string') {
    if (src.type === 'image/png' && !maxWidth) return Promise.resolve(src);
    if (src.type && src.type.indexOf('image/') !== 0) return Promise.reject(new Error('不是图片格式：' + src.type));
  }
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.crossOrigin = 'anonymous';
    var revoke = null;
    img.onload = function () {
      try {
        var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (!w || !h) throw new Error('图片尺寸无效');
        var scale = maxWidth ? Math.min(1, maxWidth / w) : 1;
        var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        var cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        var ctx = cv.getContext('2d');
        if (scale < 1) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; }
        ctx.drawImage(img, 0, 0, cw, ch);
        cv.toBlob(function (blob) {
          if (revoke) URL.revokeObjectURL(revoke);
          if (!blob) { reject(new Error('PNG 编码失败')); return; }
          if (blob.type !== 'image/png') { reject(new Error('PNG 编码失败（得到 ' + (blob.type || '未知格式') + '）')); return; }
          resolve(blob);
        }, 'image/png');
      } catch (e) { if (revoke) URL.revokeObjectURL(revoke); reject(e); }
    };
    img.onerror = function () { if (revoke) URL.revokeObjectURL(revoke); reject(new Error('图片解码失败（格式不受支持或跨域被阻止）')); };
    if (typeof src === 'string') img.src = src;
    else { revoke = URL.createObjectURL(src); img.src = revoke; }
  });
}

/** 安全 JSON 解析 */
function safeJSON(text, fallbackValue) {
  if (text == null) return fallbackValue;   // JSON.parse(null) 返回 null 而不抛错
  try {
    var v = JSON.parse(text);
    return (v && typeof v === 'object') ? v : fallbackValue;
  } catch (e) { return fallbackValue; }
}

/** 数组去重 */
function uniq(arr) {
  var seen = Object.create(null), out = [];
  (arr || []).forEach(function (v) {
    var k = String(v);
    if (!seen[k]) { seen[k] = 1; out.push(v); }
  });
  return out;
}

/** 按 keyFn 结果去重（保留先出现的项） */
function uniqBy(arr, keyFn) {
  var seen = Object.create(null), out = [];
  (arr || []).forEach(function (v) {
    var k = String(keyFn(v) || '');
    if (!k || seen[k]) return;
    seen[k] = 1; out.push(v);
  });
  return out;
}

/** 中文友好排序 */
var collator = (function () {
  try { return new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' }); }
  catch (e) { return { compare: function (a, b) { return String(a).localeCompare(String(b)); } }; }
})();

/** 简易 CSV 字段转义 */
function csvCell(v) {
  var s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // 前置单引号：标题以 = + - @ 开头时 Excel 会当公式执行
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 从 URL 猜测域名 */
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

/** 判断是否有效 http(s) 链接 */
function isHttpUrl(u) { return /^https?:\/\//i.test(String(u || '').trim()); }

