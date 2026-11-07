/*
 * 95-shell-bridge.js  —  主进程拖拽事件的转接层
 *
 * 负责：把主进程推来的 vrc://drag 帧（{kind, paths, x, y}）合成标准的
 *       dragover / drop / dragleave 事件，页面照常走自己那套拖放逻辑。
 * 与谁交互：window.__TAURI__.event.listen 收帧，取文件字节走 vrcasset:// 自定义协议。
 * 边界：不复制文件，也不改 89-pack.js 的分流规则 —— 只造事件与文件替身。
 */

(function () {
  var T = window.__TAURI__;
  if (!T || !T.event || !T.core) return;          // Electron / 浏览器里完全不启用

  var IMG_RE = /\.(png|jpe?g|webp|gif|bmp|tga|tiff?)$/i;
  var MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', bmp: 'image/bmp', tga: 'image/x-tga', tif: 'image/tiff', tiff: 'image/tiff',
    zip: 'application/zip', vrcpack: 'application/zip', unitypackage: 'application/octet-stream',
    rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', fbx: 'application/octet-stream',
    blend: 'application/octet-stream', psd: 'image/vnd.adobe.photoshop'
  };

  function extOf(name) {
    var m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }
  function baseName(p) {
    var s = String(p || '').replace(/[\\/]+$/, '');
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function mimeOf(name) {
    return MIME[extOf(name)] || '';
  }

  /** 轻量文件替身：只带导入流程真正会读的字段（name / size / type / 真实路径） */
  function stubFile(path, size) {
    var name = baseName(path);
    return { name: name, size: Number(size) || 0, type: mimeOf(name), __vrcPath: path };
  }

  /** 真正能读字节的 File（拖图设封面用）：走 vrcasset:// 自定义协议直读磁盘 */
  function realFile(path) {
    var name = baseName(path);
    var url = 'http://vrcasset.localhost/' + encodeURIComponent(path);
    return fetch(url)
      .then(function (r) { return r.ok ? r.blob() : null; })
      .then(function (blob) {
        if (!blob) return stubFile(path, 0);
        try {
          var f = new File([blob], name, { type: blob.type || mimeOf(name) });
          f.__vrcPath = path;
          return f;
        } catch (e) {
          blob.__vrcPath = path;
          blob.name = name;
          return blob;
        }
      })
      .catch(function () { return stubFile(path, 0); });
  }

  function makeDT(files) {
    var items = files.map(function (f) { return { kind: 'file', type: f.type || '', getAsFile: function () { return f; } }; });
    return {
      files: files,
      items: items,
      types: ['Files'],
      dropEffect: 'copy',
      effectAllowed: 'all',
      getData: function () { return ''; },
      setData: function () {},
      setDragImage: function () {}
    };
  }

  function dispatch(type, x, y, files) {
    var target = document.elementFromPoint(x, y) || document.body;
    var ev;
    try { ev = new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }); }
    catch (e) { ev = document.createEvent('Event'); ev.initEvent(type, true, true); }
    try { Object.defineProperty(ev, 'dataTransfer', { value: makeDT(files || []) }); } catch (e2) {}
    try { Object.defineProperty(ev, 'clientX', { value: x }); } catch (e3) {}
    try { Object.defineProperty(ev, 'clientY', { value: y }); } catch (e4) {}
    target.dispatchEvent(ev);
  }

  function cssPoint(payload) {
    var dpr = window.devicePixelRatio || 1;
    return { x: (Number(payload.x) || 0) / dpr, y: (Number(payload.y) || 0) / dpr };
  }

  T.event.listen('vrc://drag', function (e) {
    var p = e.payload || {};
    var pt = cssPoint(p);
    var paths = Array.isArray(p.paths) ? p.paths : [];

    if (p.kind === 'enter' || p.kind === 'over') {
      /* 悬停：只给名字与类型，不读字节（几百 MB 的包不能为了提示去加载） */
      var lazy = paths.map(function (x) { return stubFile(x, 0); });
      dispatch('dragover', pt.x, pt.y, lazy);
      return;
    }

    if (p.kind === 'leave') {
      var ev = document.createEvent('Event');
      ev.initEvent('dragleave', true, true);
      try { Object.defineProperty(ev, 'relatedTarget', { value: null }); } catch (err) {}
      (document.elementFromPoint(pt.x, pt.y) || document.body).dispatchEvent(ev);
      return;
    }

    if (p.kind !== 'drop') return;

    var el = document.elementFromPoint(pt.x, pt.y);
    var onCover = !!(el && el.closest && el.closest('.card-cover, .detail-cover'));
    var allImages = paths.length > 0 && paths.every(function (x) { return IMG_RE.test(x); });

    /* 拖到缩略图上是「设封面」——那条路径会把 File 当 Blob 读，必须给真文件；
     * 其它情况只要路径与大小，用替身即可，避免把整个压缩包读进内存。 */
    var build = (onCover && allImages)
      ? Promise.all(paths.map(realFile))
      : Promise.all(paths.map(function (x) {
          return Promise.resolve()
            .then(function () { return FS.host.exists(x); })
            .then(function (kind) { return stubFile(x, 0); })
            .catch(function () { return stubFile(x, 0); });
        }));

    build.then(function (files) {
      dispatch('drop', pt.x, pt.y, files);
    });
  });
})();
