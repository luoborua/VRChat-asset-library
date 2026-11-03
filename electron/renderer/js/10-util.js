/* ============ 10-util.js ============ */
/* =====================================================================
 * 10-util.js  —  通用工具函数
 * ===================================================================== */

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
    if (Array.isArray(c)) { appendChildren(node, c); return; }   // 嵌套数组扁平化
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
  var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 2 : 1)) + ' ' + u[i];
}

/**
 * Windows 路径工具：所有本地磁盘路径统一走这里，避免「手动拼反斜杠」。
 * - normalizeWinPath：统一分隔符、压缩重复分隔符、去掉末尾分隔符（保留 UNC 的 \\ 前缀）
 * - joinWinPath：root + 若干子段 → 规范绝对路径
 * 注意：JS 源码里写单个反斜杠是 '\\'（两个字符），写四个字符 '\\\\' 会得到运行时双反斜杠。
 */
function normalizeWinPath(p) {
  var s = String(p == null ? '' : p).trim();
  if (!s) return '';
  var unc = /^\\\\/.test(s);
  s = s.replace(/\//g, '\\').replace(/\\+/g, '\\');
  if (unc && !/^\\\\/.test(s)) s = '\\' + s;
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
  show: function (msg, type, ms) {
    var root = $('#toastRoot');
    if (!root) { console.log('[toast]', msg); return; }
    var icons = { ok: 'check', err: 'error', warn: 'warning', info: 'info' };   // v2.3.27：Toast 图标位改用内联 SVG
    var node = el('div', { class: 'toast toast-' + (type || 'info') }, [
      ICONS.make(icons[type || 'info'] || 'info', { size: 15, class: 'toast-ico' }),
      el('span', { class: 'toast-msg', text: msg })
    ]);
    root.appendChild(node);
    requestAnimationFrame(function () { node.classList.add('in'); });
    setTimeout(function () {
      node.classList.remove('in');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 260);
    }, ms || 2600);
    return node;
  },
  ok: function (m, ms) { return Toast.show(m, 'ok', ms); },
  err: function (m, ms) { return Toast.show(m, 'err', ms || 4200); },
  warn: function (m, ms) { return Toast.show(m, 'warn', ms || 3600); },
  info: function (m, ms) { return Toast.show(m, 'info', ms); }
};

/** 复制到剪贴板（含降级方案） */
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

/** 图片转 PNG：输入 Blob/File/DataURL/URL，输出 PNG Blob（本身已是 PNG 且不需缩放则原样返回，避免二次编码）；maxWidth 给定时按宽度等比缩小 */
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
  try { return JSON.parse(text); } catch (e) { return fallbackValue; }
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
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 从 URL 猜测域名 */
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

/** 判断是否有效 http(s) 链接 */
function isHttpUrl(u) { return /^https?:\/\//i.test(String(u || '').trim()); }

