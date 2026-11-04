/* ============ 40-fs.js ============ */
/* =====================================================================
 * 40-fs.js  —  本地文件系统 / 导入导出 / 整理辅助
 *   浏览器端使用 File System Access API（Chrome / Edge 支持）
 *   本机文件操作统一走 Tauri 的进程内命令（见下方 Host）；v2.3.12 起已移除旧的 window.vrcBridge 预留桥接
 * ===================================================================== */

var FS = (function () {

  function supported() { return typeof window.showDirectoryPicker === 'function'; }
  function saveSupported() { return typeof window.showSaveFilePicker === 'function'; }
  /* ---------------- 进程内宿主（Tauri 命令） ----------------
   * v6.0：宿主不再是 127.0.0.1:8788~8792 的 HTTP 服务，而是同一进程里的 Rust 命令。
   * 端口探测、访问令牌、健康检查、断线横幅都随 HTTP 层一并删除：
   *   没有端口，就没有「别的本地服务冒充宿主」的可能；没有跨进程调用，也就不会「断开」。 */

  /* v6.0（Tauri 载体）：宿主不再是 HTTP 服务，而是进程内的 Rust 命令。
   * 只换传输，不换契约 —— 下面 hostCall 的 api 名与 payload 与 HTTP 版完全一致，
   * 于是 25 处 FS.host.* 调用与全部业务逻辑都不用改。 */
  var TAURI_INVOKE = (function () {
    try {
      if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') {
        return window.__TAURI__.core.invoke;
      }
    } catch (e) {}
    return null;
  })();
  var TAURI_CHANNEL = (function () {
    try { return (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.Channel) || null; } catch (e) { return null; }
  })();

  /* v2.5.3 的「宿主身份 + 最低版本」校验、v2.5.2 的「断开横幅 / 恢复补写」都只对 HTTP 宿主有意义，
   * Tauri 没有端口可探、没有身份可冒充，一并移除。 */

  /** 宿主就绪判定：进程内命令，只要 __TAURI__ 在就永远在线，没有「探测」这一步。
   *  保留这个函数是为了不动机场一样的调用点（hostEnsure / hostEnsureRetry）。 */
  function hostProbe() {
    return Promise.resolve(!!TAURI_INVOKE);
  }
  /** 带重试的宿主探测——Tauri 下无需重试，签名保留（50-app.js 启动时会调用） */
  function hostEnsureRetry() {
    return Promise.resolve(!!TAURI_INVOKE);
  }
  function hostCall(api, payload) {
    /* 直接进进程内命令；返回值语义与旧 HTTP 版逐字段一致（ok=false 抛错、cancelled 原样返回） */
    if (!TAURI_INVOKE) {
      return Promise.reject(new Error('当前载体不支持文件操作：请从桌面程序运行，不要直接用浏览器打开页面'));
    }
    return TAURI_INVOKE('host_call', { api: api, payload: payload === undefined ? {} : (payload || {}) })
      .catch(function (e) { throw new Error(String((e && e.message) || e || '宿主调用失败')); })
      .then(function (j) {
        if (j && j.ok === false && j.cancelled === true) return j;
        if (!j || j.ok === false) throw new Error((j && j.error) || ('宿主请求失败 ' + api));
        return j;
      });
  }
  var Host = {
    available: function () { return !!TAURI_INVOKE; },
    /** 当前是否跑在原生桌面壳里（Electron / Tauri）。
     *  页面据此切换文案与布局：网页版讲「启动宿主」，桌面版讲「内置宿主」。 */
    desk: function () {
      var s = window.vrcElectron && window.vrcElectron.shell;
      return s === 'electron' || s === 'tauri';
    },
    checked: function () { return true; },
    ensure: function () { return hostProbe(); },
    retryHost: function () { return hostProbe(); },
    base: function () { return ''; },
    pickDir: function () { return hostCall('/api/pickDir').then(function (j) { return j.path || ''; }); },
    pickFiles: function () { return hostCall('/api/pickFiles').then(function (j) { return j.paths || []; }); },
    /* v4.2.0 素材包：另存为 / 选单个文件 / 打包相关调用。
     * 返回的是宿主原始对象（含 ok / cancelled），调用方自己判断用户是否取消。 */
    saveFile: function (p) { return hostCall('/api/saveFile', p || {}); },
    pickOneFile: function (p) { return hostCall('/api/pickOneFile', p || {}); },
    pack: function (api, payload) { return hostCall('/api/pack/' + api, payload || {}); },
    /** v6.0：素材主库（SQLite）—— load / save / info */
    db: function (op, payload) { return hostCall('/api/db/' + op, payload || {}); },
    /** v6.1：原始字节通道。读回 Uint8Array，写入直接给 Uint8Array —— 全程不碰 base64。 */
    bytesSupported: function () { return !!TAURI_INVOKE; },
    readBytes: function (p) {
      if (!TAURI_INVOKE) return Promise.reject(new Error('当前载体不支持原始字节读取'));
      return TAURI_INVOKE('host_read_bytes', { path: p }).then(function (buf) {
        return (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
      });
    },
    writeBytes: function (p, bytes) {
      if (!TAURI_INVOKE) return Promise.reject(new Error('当前载体不支持原始字节写入'));
      var u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
      return TAURI_INVOKE('host_write_bytes', u8, { headers: { 'x-vrc-path': encodeURIComponent(String(p)) } })
        .then(function (r) {
          if (!r || r.ok === false) throw new Error((r && r.error) || '写入失败');
          return r;
        });
    },
    /** v6.2：缩略图（Rust 侧 image crate 生成 400px JPEG） */
    thumb: function (src, dst, max) {
      if (!TAURI_INVOKE) return Promise.reject(new Error('当前载体不支持缩略图'));
      return TAURI_INVOKE('thumb_ensure', { src: src, dst: dst, max: max || 400 });
    },
    thumbBatch: function (items, max) {
      if (!TAURI_INVOKE) return Promise.reject(new Error('当前载体不支持缩略图'));
      return TAURI_INVOKE('thumb_batch', { items: items || [], max: max || 400 });
    },
    scan: function (p, maxDepth) { return hostCall('/api/scan', { path: p, maxDepth: maxDepth || 0 }).then(function (j) { return j.entries || []; }); },
    move: function (src, dst) { return hostCall('/api/move', { src: src, dst: dst }); },
    copy: function (src, dst) { return hostCall('/api/copy', { src: src, dst: dst }); },
    mkdir: function (p) { return hostCall('/api/mkdir', { path: p }); },
    writeFile: function (p, dataBase64) { return hostCall('/api/writeFile', { path: p, dataBase64: dataBase64 }); },
    readFileBase64: function (p) { return hostCall('/api/readFileBase64', { path: p }); },
    download: function (url, p, headers, jobId, overwrite) {
      var payload = { url: url, path: p, headers: headers || {}, jobId: jobId || '', overwrite: !!overwrite };
      return hostCall('/api/download', payload);
    },
    /** v2.5.1（F3）：删除本地文件/目录（宿主带安全阀：拒绝盘符根与短路径） */
    remove: function (p) { return hostCall('/api/delete', { path: p }); },
    /** 下载进度：宿主统一返回 {ok, job:{received,total,speed,…}}，这里摊平成一层供 88-download.js 直接读。 */
    downloadProgress: function (jobId) {
      return hostCall('/api/downloadProgress', { jobId: jobId }).then(function (r) {
        if (r && r.job) return Object.assign({ ok: r.ok !== false }, r.job);
        return r;
      });
    },
    /** v4.3.2：取消下载（页面点「移除」时用，真正断掉宿主侧的上游请求） */
    downloadCancel: function (jobId) { return hostCall('/api/downloadCancel', { jobId: jobId }); },
    open: function (p) { return hostCall('/api/open', { path: p }); },
    exists: function (p) { return hostCall('/api/exists', { path: p }).then(function (j) { return j.kind || null; }); },
    /** v4.4：带大小的 stat（exists 只回 kind，导入素材时要拿 fileSize） */
    stat: function (p) { return hostCall('/api/exists', { path: p }); },
    readText: function (p) { return hostCall('/api/readText', { path: p }).then(function (j) { return j.text || ''; }); },
    /** v2.5.14：第 5 个参数 = 可选超时（毫秒）。宿主 2.3.17 起支持（限幅 5~300 秒）；
     *  旧宿主会忽略这个字段、仍按 30 秒处理 —— 向后兼容。 */
    fetchURL: function (url, headers, method, body, timeoutMs) {
      var payload = { url: url, headers: headers || {}, method: method || 'GET', body: body };
      if (timeoutMs) payload.timeoutMs = timeoutMs;
      return hostCall('/api/fetch', payload);
    },
    /** v2.5.15：**流式请求**（宿主 2.3.18 的 /api/stream，SSE 转发）。给 AI 翻译这类长响应用：
     *  只要上游持续吐字节就不会中断（宿主侧是空闲超时）。
     *  opts: { timeoutMs, onChunk(text, acc) }
     *  返回 { status, ok, text, error }；宿主没有这个接口（旧 exe）→ 抛「宿主流式接口不可用」。 */
    streamFetch: function (url, headers, method, body, opts) {
      opts = opts || {};
      var payload = { url: url, headers: headers || {}, method: method || 'GET', body: body };
      if (opts.timeoutMs) payload.timeoutMs = opts.timeoutMs;
      /* Tauri：SSE 改成 Tauri Channel 传帧。帧结构 {type:'head'|'chunk'|'error'} 与原宿主一致，
       * 调用方（87-ai.js）拿到的 {status, ok, text, error} 语义不变。 */
      if (TAURI_INVOKE && TAURI_CHANNEL) {
        return Promise.resolve().then(function () {
          var ch = new TAURI_CHANNEL();
          var out = { status: 0, ok: false, text: '', error: '' };
          ch.onmessage = function (raw) {
            var evt = null;
            try { evt = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (e) { return; }
            if (!evt) return;
            if (evt.type === 'head') { out.status = evt.status || 0; out.ok = !!evt.ok; }
            else if (evt.type === 'chunk') {
              out.text += evt.text || '';
              if (opts.onChunk) { try { opts.onChunk(evt.text || '', out); } catch (e) {} }
            } else if (evt.type === 'error') { out.error = String(evt.error || '流式请求失败'); }
          };
          return TAURI_INVOKE('host_stream', { payload: payload, onEvent: ch }).then(function (r) {
            if (out.error) throw new Error(out.error);
            if (r && r.ok === false && r.error && !out.error) throw new Error(String(r.error));
            return out;
          });
        });
      }
      /* 没有 Tauri Channel 就没有流式通道。这里宁可明确报错，也不退回「缓冲式」请求：
       * 那种退让会让 AI 翻译在长响应下被截断，看起来像「模型答到一半停了」。 */
      return Promise.reject(new Error('当前载体不支持流式请求，请从桌面程序运行'));
    }
  };

  /** 请求目录句柄权限 */
  function ensurePermission(handle, mode) {
    if (!handle || !handle.queryPermission) return Promise.resolve(true);
    var opts = { mode: mode || 'readwrite' };
    return handle.queryPermission(opts).then(function (st) {
      if (st === 'granted') return true;
      return handle.requestPermission(opts).then(function (s2) { return s2 === 'granted'; });
    }).catch(function () { return false; });
  }

  /** 选择一个文件夹，返回 {handle, name}；同 id 会记住上次选择位置 */
  function pickDirectory(idHint) {
    if (!supported()) {
      Toast.warn('当前浏览器不支持「选择文件夹」，请改用 Chrome / Edge，或手动输入路径');
      return Promise.resolve(null);
    }
    var key = 'lastDirHandle_' + (idHint || 'default');
    return Store.kvGet(key, null).then(function (last) {
      var opts = { mode: 'readwrite' };
      if (idHint) opts.id = idHint;
      if (last) {
        return ensurePermission(last, 'read').then(function (ok) {
          if (ok) { try { opts.startIn = last; } catch (e) {} }
          return window.showDirectoryPicker(opts);
        });
      }
      return window.showDirectoryPicker(opts);
    }).then(function (h) {
      Store.kvSet(key, h);
      return { handle: h, name: h.name };
    }).catch(function (e) {
      if (e && e.name === 'AbortError') return null;
      Toast.err('选择文件夹失败：' + (e.message || e));
      return null;
    });
  }

  /**
   * 选择文件夹并**直接拿到真实绝对路径**（v3.0.5）。
   * 宿主在线（桌面版内置宿主 / VRCLibHost）时走宿主原生对话框，返回 {path, name, handle:null}，
   * 不再受「浏览器不返回磁盘路径」限制；宿主离线才退回浏览器句柄 + 库根反查。
   */
  function pickDirectoryPath(idHint) {
    return Host.ensure().then(function (ok) {
      if (ok) {
        return Host.pickDir().then(function (p) {
          if (!p) return null;
          var s = String(p);
          var name = s.replace(/[\\/]+$/, '').split('\\').pop() || s;
          return { path: s, name: name, handle: null };
        });
      }
      return pickDirectory(idHint).then(function (r) {
        if (!r) return null;
        return resolveDirectoryPath(r.handle).then(function (full) {
          return { path: full || '', name: r.name, handle: r.handle };
        });
      });
    }).catch(function (e) {
      if (e && e.name === 'AbortError') return null;
      Toast.err('选择文件夹失败：' + ((e && e.message) || e));
      return null;
    });
  }

  /** 设置素材库根目录（用于自动整理 / 创建分类文件夹）
   *  注意：导入搬运（entry.move / createWritable）依赖**浏览器目录句柄**，所以这里必须返回 handle，
   *  不能改成"只给路径"。需要"只要路径"的场景请用 pickDirectoryPath()。 */
  function setLibraryRoot() {
    return pickDirectory('vrc-library-root').then(function (r) {
      if (!r) return null;
      return Store.kvSet('libraryRoot', r.handle).then(function () {
        App.settings.libraryRootName = r.name;
        return App.saveSettings().then(function () { return r; });
      });
    });
  }
  function getLibraryRoot() { return Store.kvGet('libraryRoot', null); }

  /**
   * 尝试把 FileSystemDirectoryHandle 还原成绝对路径。
   * 浏览器出于安全限制不返回磁盘路径；但素材库根句柄在本地存着，
   * 因此可以用 isSameEntry 在库根下做有界搜索，还原「根\分类\素材文件夹」。
   * 找不到（例如选的是库外的文件夹）返回 null，调用方提示用户手动粘贴完整路径。
   */
  function resolveDirectoryPath(handle) {
    if (!handle || typeof handle.isSameEntry !== 'function') return Promise.resolve(null);
    return getLibraryRoot().then(async function (root) {
      if (!root || typeof root.isSameEntry !== 'function') return null;
      var rootPath = App.libraryRoot();
      // 关键一致性校验：库根【句柄】必须与库根【路径字符串】是同一个目录。
      // 用户曾分别用两种方式选过库根，句柄指向 Perula 源文件夹、路径字符串却是 本地素材库，
      // 导致 BFS 把“源文件夹的 rel”拼到错误根路径上，生成 G:\...\本地素材库\<源文件夹名> 的假路径。
      var rootLast = String(rootPath.replace(/[\\/]+$/, '').split('\\').pop() || '').toLowerCase();
      var handleName = String(root.name || '').toLowerCase();
      if (rootLast && handleName && rootLast !== handleName) {
        console.warn('resolveDirectoryPath：库根句柄名「' + root.name + '」与库根路径末段「' + rootLast + '」不一致，放弃自动还原。请在设置中统一两处。');
        return null;
      }
      var ok = await ensurePermission(root, 'read');
      if (!ok) return null;
      try {
        if (handle.isSameEntry(root)) return rootPath;
        var queue = [{ dir: root, rel: '', depth: 0 }];
        var visited = 0;
        while (queue.length && visited < 2500) {
          var cur = queue.shift();
          if (cur.depth >= 6) continue;
          visited++;
          try {
            for await (var entry of cur.dir.values()) {
              if (entry.kind !== 'directory' && entry.kind !== 'file') continue;
              var rel = cur.rel ? cur.rel + '\\' + entry.name : entry.name;
              if (typeof entry.isSameEntry === 'function' && entry.isSameEntry(handle)) {
                return joinWinPath(rootPath, [rel]);
              }
              if (entry.kind === 'directory' && cur.depth < 5) queue.push({ dir: entry, rel: rel, depth: cur.depth + 1 });
            }
          } catch (e) { /* 单个目录读不到就跳过，继续找 */ }
        }
      } catch (e) {}
      return null;
    }).catch(function () { return null; });
  }

  /** 校验一个素材库内的相对路径是否真实存在（文件或文件夹均可） */
  function relativePathExists(rel) {
    var parts = String(rel || '').replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean);
    if (!parts.length) return Promise.resolve(false);
    return getLibraryRoot().then(function (root) {
      if (!root) return false;
      return ensurePermission(root, 'read').then(function (ok) {
        if (!ok) return false;
        var cur = root;
        function step(i) {
          var name = parts[i];
          var last = i === parts.length - 1;
          if (last) {
            return cur.getDirectoryHandle(name).then(function () { return true; })
              .catch(function () { return cur.getFileHandle(name).then(function () { return true; }).catch(function () { return false; }); });
          }
          return cur.getDirectoryHandle(name).then(function (dir) { cur = dir; return step(i + 1); })
            .catch(function () { return false; });
        }
        return step(0);
      });
    }).catch(function () { return false; });
  }

  /** v3.0.3（用户要求「断开宿主也能验证是否已下载」）：把「存储目录 + 文件名」换算成**库根相对路径**（FSA 分支用）。
   *  dir 可能是 Windows 绝对路径（用 App.libraryRoot() 前缀剥掉）或历史遗留的相对路径；
   *  映射不到库根下（不是绝对路径也不在库根内）时返回 ''，表示 FSA 分支不可用。 */
  function relPathFromLibrary(dir, name) {
    var d = normalizeWinPath(dir || '');
    if (!d) return '';
    var rel = d;
    if (isAbsoluteWinPath(d)) {
      var root = normalizeWinPath(App.libraryRoot() || '');
      if (!root) return '';
      var a = d.toLowerCase(), b = root.toLowerCase();
      if (a === b) rel = '';
      else if (a.indexOf(b + '\\') === 0) rel = d.slice(root.length + 1);
      else return '';
    }
    rel = String(rel || '').replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
    var n = String(name || '').trim();
    if (!n) return rel;
    return rel ? (rel + '\\' + n) : n;
  }

  /** v3.0.3：三档「文件是否真的在磁盘上」判定（用户要求：断开宿主也能验证）。
   *   ① 宿主可用 → FS.host.exists(absPath)（权威；与改前行为一致）
   *   ② 宿主不可用、但**浏览器库根句柄可用且拿到读权限** → relativePathExists(relPath)（权威）
   *   ③ 两者都没有 / 无法判定 → { known:false } ⇒ 调用方**静默保持乐观标记**（用户要求不加标注；但不得把"无法判定"当成"没有文件"）
   *  返回 Promise<{known:true, exists:boolean, via:'host'|'fsa'} | {known:false}> */
  function diskFileState(absPath, relPath) {
    function viaHost() {
      if (!absPath || !FS.host || typeof FS.host.exists !== 'function' || typeof FS.hostEnsure !== 'function') return Promise.resolve(null);
      return FS.hostEnsure().then(function (ok) {
        if (!ok) return null;                        // 宿主不可用 ⇒ 让位给 FSA 分支（不再像旧版那样直接放弃）
        return FS.host.exists(absPath).then(function (k) { return { known: true, exists: k === 'file', via: 'host' }; });
      }).catch(function () { return null; });        // 宿主刚掉线：也退化到 FSA 分支
    }
    function viaFsa() {
      if (!relPath) return Promise.resolve(null);
      return getLibraryRoot().then(function (root) {
        if (!root) return null;                      // 没有句柄 ⇒ 不可判定（**不能**当成"文件不存在"）
        return ensurePermission(root, 'read').then(function (ok) {
          if (!ok) return null;                      // 没读权限 ⇒ 不可判定
          return relativePathExists(relPath).then(function (ex) { return { known: true, exists: !!ex, via: 'fsa' }; });
        });
      }).catch(function () { return null; });
    }
    return viaHost().then(function (r) { return r || viaFsa(); })
      .then(function (r) { return r || { known: false }; })     // 两条通道都不可用 ⇒ 明确回 {known:false}（调用方据此静默保留原标记）
      .catch(function () { return { known: false }; });
  }

  /** v3.0.3：用浏览器库根句柄列出**库根相对目录**下的文件（宿主离线时的降级枚举，与宿主 scan(dir,0) 同口径）。
   *  返回 {usable, exists, names}：usable=false ⇒ 句柄/读权限不可用（**不可判定**，不能让调用方误判成"没有文件"）。 */
  function listLibraryDir(relDir) {
    var parts = String(relDir || '').replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean);
    return getLibraryRoot().then(function (root) {
      if (!root) return { usable: false, exists: false, names: [] };
      return ensurePermission(root, 'read').then(function (ok) {
        if (!ok) return { usable: false, exists: false, names: [] };
        var cur = root;
        function step(i) {
          if (i >= parts.length) {
            return scanDirectory(cur, 0).then(function (r) { return { usable: true, exists: true, names: (r && r.names ? r.names.slice() : []) }; });
          }
          return cur.getDirectoryHandle(parts[i]).then(function (dir) { cur = dir; return step(i + 1); })
            .catch(function () { return { usable: true, exists: false, names: [] }; });
        }
        return step(0);
      });
    }).catch(function () { return { usable: false, exists: false, names: [] }; });
  }

  /**
   * 自动补全素材里的相对本地路径：
   * 用 libraryRootPath（空则默认库根）拼接，并用文件系统句柄验证完整路径存在后才改写。
   * 「下载存放位置（已创建文件夹）」这种老数据就是靠这里修复。
   */
  function completeRelativePaths(list) {
    list = list || [];
    var rootPath = App.libraryRoot();
    var changed = false;
    var chain = Promise.resolve();
    list.forEach(function (a) {
      (a.paths || []).forEach(function (p) {
        if (!p || typeof p !== 'object' || !p.path) return;
        var path = String(p.path);
        if (/^webdav:\/\//i.test(path)) return;          // v2.2.12 远端路径不参与本地补全
        if (isAbsoluteWinPath(path)) return;
        chain = chain.then(function () {
          return relativePathExists(path).then(function (exists) {
            if (!exists) return;
            p.path = joinWinPath(rootPath, [path]);
            changed = true;
          });
        });
      });
    });
    return chain.then(function () { return { list: list, changed: changed }; });
  }
  /** 统计目录内文件数与总大小（浅层 + 一级子目录） */
  function scanDirectory(handle, maxDepth) {
    maxDepth = maxDepth == null ? 2 : maxDepth;
    var result = { files: 0, size: 0, folders: [], names: [] };
    function walk(dir, depth) {
      var it = dir.values ? dir.values() : null;
      if (!it) return Promise.resolve();
      var chain = Promise.resolve();
      return (function loop() {
        return it.next().then(function (step) {
          if (step.done) return;
          var entry = step.value;
          var p;
          if (entry.kind === 'file') {
            result.names.push(entry.name);
            p = entry.getFile().then(function (f) { result.files++; result.size += f.size; }).catch(function () {});
          } else {
            result.folders.push(entry.name);
            p = depth < maxDepth ? walk(entry, depth + 1) : Promise.resolve();
          }
          return p.then(loop);
        });
      })();
    }
    return walk(handle, 0).then(function () { return result; }).catch(function () { return result; });
  }

  /** 在库根目录下按分类创建文件夹 */
  function createCategoryFolders() {
    return getLibraryRoot().then(function (root) {
      if (!root) { Toast.warn('请先在「设置 → 本地库目录」中选择素材库根目录'); return null; }
      return ensurePermission(root, 'readwrite').then(function (ok) {
        if (!ok) { Toast.err('未获得目录写入权限'); return null; }
        var cats = App.allCategories();
        var created = [];
        var chain = Promise.resolve();
        cats.forEach(function (c) {
          chain = chain.then(function () {
            return root.getDirectoryHandle(c.label, { create: true })
              .then(function () { created.push(c.label); })
              .catch(function (e) { console.warn('创建失败', c.label, e); });
          });
        });
        return chain.then(function () { return created; });
      });
    });
  }

  /**
   * 打开本地路径。
   * 本地宿主在线时交给宿主用资源管理器打开；
   * 宿主离线时降级为复制路径到剪贴板。
   * 只接受完整绝对路径（G:\… / \\server\…）；不完整路径不再猜根目录，
   * 否则 explorer 定位失败会回退到桌面。
   */
  function openPath(path) {
    var raw = normalizeWinPath(path);
    if (!raw) { Toast.warn('未提供可打开的本地路径'); return; }
    // 只有完整绝对路径才交给 explorer；不完整的相对路径过去会定位失败并回退到桌面
    if (!isAbsoluteWinPath(raw)) {
      copyText(raw);
      Toast.warn('该本地路径不完整（' + raw + '），无法直接打开。请在编辑页补全为 G:\\… 或 \\\\服务器\\… 的完整路径（已复制当前内容）。', 6200);
      return;
    }
    var abs = raw;
    // 打开/定位统一由本地宿主负责（vrcpath 协议已不再使用）；先给即时反馈，再做带重试的宿主探测
    Toast.info('正在打开资源管理器（若宿主刚启动会稍等 1~3 秒）…', 1800);
    hostEnsureRetry(3).then(function (ok) {
      if (!ok) {
        copyText(abs);
        Toast.warn('内置宿主未就绪：无法直接打开资源管理器（路径已复制到剪贴板）。请重启程序后重试。', 6800);
        return;
      }
      return Host.open(abs).then(function () {
        Toast.ok('已通过本地宿主打开：' + abs, 3200);
      }, function (e) {
        copyText(abs);
        Toast.warn('宿主打开失败：' + (e && e.message) + '（路径已复制）', 5200);
      });
    });
  }

  /** 素材文件夹重命名：标题/角色名修改后同步。优先交给本地宿主（整目录 rename，快且不复制文件）；宿主不在时回退浏览器句柄复制+删除。
   *  v2.5.16（用户反馈「连着宿主改名却仍走网页实现」）——**真因**：旧实现用 `libraryRoot() + 分类名 + folderName(旧标题)`
   *  重建源路径，而磁盘上的文件夹名保留的是**导入时的原标题**。真实库实测（398 条有存储路径的素材）：
   *  **293 条**磁盘名 ≠ 用当前标题重建的名字（父目录 100% 一致）。于是源路径不存在 → 宿主 /api/move 抛
   *  「源不存在」→ 代码**静默回退**到浏览器句柄复制+删除（慢、可能弹权限、多半直接失败）。
   *  现在：源目录一律取素材自己的存储路径；宿主在线时失败就**明说原因**，不再偷偷换成浏览器实现。 */
  function renameAssetFolder(oldName, newName, categoryLabel, asset) {
    if (!oldName || oldName === newName) return Promise.resolve(false);
    function browserRename() {
      return getLibraryRoot().then(function (root) {
        if (!root) return false;
        return ensurePermission(root, 'readwrite').then(function (ok) {
          if (!ok) return false;
          return root.getDirectoryHandle(categoryLabel, { create: true }).then(async function (catDir) {
            try {
              var oldDir = await catDir.getDirectoryHandle(oldName);
              var newDir = await catDir.getDirectoryHandle(newName, { create: true });
              async function copy(src, dst) {
                for await (var entry of src.values()) {
                  if (entry.kind === 'file') {
                    var f = await entry.getFile();
                    var fh = await dst.getFileHandle(entry.name, { create: true });
                    var w = await fh.createWritable(); await w.write(f); await w.close();
                  } else {
                    var sub = await dst.getDirectoryHandle(entry.name, { create: true });
                    await copy(entry, sub);
                  }
                }
              }
              await copy(oldDir, newDir);
              try { await catDir.removeEntry(oldName, { recursive: true }); } catch (e) {}
              return true;
            } catch (e) { return false; }
          }).catch(function () { return false; });
        });
      });
    }
    var rootPath = App.libraryRoot();
    /* 源目录优先取素材**自己的存储路径**（权威），没有才退回「根目录 + 分类 + 旧名」 */
    var curPath = '';
    try { curPath = (asset && App.primaryLocalPath) ? App.primaryLocalPath(asset) : ''; } catch (e) { curPath = ''; }
    var parentDir, oldAbs;
    if (curPath && curPath.indexOf('\\') >= 0) {
      oldAbs = curPath.replace(/[\\/]+$/, '');
      parentDir = oldAbs.replace(/[\\/][^\\/]*$/, '');
    } else {
      parentDir = joinWinPath(rootPath, [categoryLabel]);
      oldAbs = joinWinPath(parentDir, [oldName]);
    }
    var newAbs = joinWinPath(parentDir, [newName]);
    if (oldAbs.toLowerCase() === newAbs.toLowerCase()) return Promise.resolve(false);
    /* v5.4：改名只是「顺手同步磁盘目录」，绝不能拖住保存 —— 宿主 8 秒不应答就放行，
     * 旧目录本来就缺失（ENOENT）时也只提示一句，不拿红字吓人。 */
    var TIMEOUT = { timeout: true };
    function withTimeout(promise, ms) {
      return Promise.race([
        Promise.resolve(promise),
        new Promise(function (res) { setTimeout(function () { res(TIMEOUT); }, ms); })
      ]);
    }
    return withTimeout(Host.ensure(), 8000).then(function (ok) {
      if (ok === TIMEOUT) {
        if (typeof Toast !== 'undefined' && Toast.info) Toast.info('宿主没有应答，文件夹未改名；素材信息照常保存', 5000);
        return false;
      }
      if (!ok) return browserRename();                       // 宿主确实离线 → 才用浏览器实现
      return withTimeout(Host.move(oldAbs, newAbs), 8000).then(function (r) {
        if (r === TIMEOUT) {
          if (typeof console !== 'undefined' && console.warn) console.warn('[rename] 宿主改名超时：' + oldAbs + ' → ' + newAbs);
          if (typeof Toast !== 'undefined' && Toast.info) Toast.info('文件夹改名没完成（宿主没有应答），素材信息已保存', 5000);
          return false;
        }
        return true;
      }, function (err) {
        /* 宿主在线却失败：**不再静默**换成浏览器复制+删除（旧路径不存在时那只会留下半成品），
         * 把宿主给的原因显示出来，让用户知道文件夹没改成。 */
        var msg = (err && err.message) || String(err);
        if (typeof console !== 'undefined' && console.warn) console.warn('[rename] 宿主改名失败：' + msg + '（' + oldAbs + ' → ' + newAbs + '）');
        if (/ENOENT|not found|不存在|no such file/i.test(msg)) {
          /* 旧目录本来就不在磁盘上（多半已被手动改名/移走）：不算故障，保存照常进行 */
          if (typeof Toast !== 'undefined' && Toast.info) Toast.info('旧目录不在磁盘上（可能已手动改名），本次只保存素材信息，路径未改动。', 5200);
        } else if (typeof Toast !== 'undefined' && Toast.warn) {
          Toast.warn('文件夹改名没成功（宿主：' + msg + '）：素材库里的目录仍是旧名，可手动改名后重新登记路径。', 6000);
        }
        return false;
      });
    });
  }

  /**
   * 系统级移动（改写路径 = rename）：只由本地宿主执行（vrcpath 协议已不再使用）。
   * 返回 'host' | false。
   */
  async function movePath(src, dst) {
    var s = normalizeWinPath(src);
    var d = normalizeWinPath(dst);
    if (!isAbsoluteWinPath(s) || !isAbsoluteWinPath(d)) return false;
    var sL = s.toLowerCase();
    var dL = d.toLowerCase();
    if (sL === dL) { Toast.warn('源与目标相同，已取消移动：' + s, 5200); return false; }
    if (dL === sL + '\\' || dL.indexOf(sL + '\\') === 0) {
      Toast.warn('目标不能位于源文件夹内部（这等于把文件夹搬进它自己），已取消移动：' + s, 6800);
      return false;
    }
    var ok = await Host.ensure();
    if (!ok) {
      copyText(d);
      Toast.warn('内置宿主未就绪：无法执行移动（目标路径已复制）。请重启程序后重试。', 6800);
      return false;
    }
    try {
      await Host.move(s, d);
      Toast.ok('已通过本地宿主移动：' + s + ' → ' + d, 3600);
      return 'host';
    } catch (e) {
      copyText(d);
      Toast.warn('宿主移动失败：' + (e && e.message) + '（目标路径已复制，未做任何回退）', 6800);
      return false;
    }
  }

  /** 系统级复制：只由本地宿主执行（fs.cpSync 整项复制、源保留）。返回 'host' | false */
  async function copyPath(src, dst) {
    var s = normalizeWinPath(src);
    var d = normalizeWinPath(dst);
    if (!isAbsoluteWinPath(s) || !isAbsoluteWinPath(d)) return false;
    var sL = s.toLowerCase();
    var dL = d.toLowerCase();
    if (dL.indexOf(sL + '\\') === 0 || dL === sL) {
      Toast.warn('目标不能位于源文件夹内部（会把源复制进它自己），已取消复制：' + s, 6800);
      return false;
    }
    var ok = await Host.ensure();
    if (!ok) {
      copyText(d);
      Toast.warn('内置宿主未就绪：无法执行复制（目标路径已复制）。请重启程序后重试。', 6800);
      return false;
    }
    try {
      await Host.copy(s, d);
      Toast.ok('已通过本地宿主复制：' + s + ' → ' + d, 3600);
      return 'host';
    } catch (e) {
      copyText(d);
      Toast.warn('宿主复制失败：' + (e && e.message) + '（目标路径已复制，未做任何回退）', 6800);
      return false;
    }
  }

  /** v2.2.12 网盘（WebDAV）：统一走宿主；宿主离线直接抛错 */
  function davCall(api, payload) {
    return Host.ensure().then(function (ok) {
      if (!ok) throw new Error('内置宿主未就绪：网盘（WebDAV）功能不可用');
      return hostCall(api, payload);
    });
  }

  /** 按【完整路径字符串】精确创建目录：宿主在线时走宿主；返回是否已由宿主创建 */
  async function mkdirPath(p) {
    var s = normalizeWinPath(p);
    if (!isAbsoluteWinPath(s)) return false;
    if (await Host.ensure()) {
      try { await Host.mkdir(s); return true; } catch (e) { Toast.warn('宿主创建目录失败：' + (e && e.message), 5200); }
    }
    return false;
  }

  /** 把 Blob/File 按完整路径字符串写到磁盘（宿主在线时走宿主；返回 Promise<boolean>） */
  function writeFileToPath(p, blob) {
    var s = normalizeWinPath(p);
    if (!isAbsoluteWinPath(s) || !blob) return Promise.resolve(false);
    return Host.ensure().then(function (ok) {
      if (!ok) { Toast.warn('内置宿主未就绪：无法把文件写到磁盘路径', 5200); return false; }
      /* v6.1：能走原始字节就别绕 base64（写封面、导出图片都走这条） */
      if (Host.bytesSupported && Host.bytesSupported() && blob.arrayBuffer) {
        return blob.arrayBuffer().then(function (ab) {
          return Host.writeBytes(s, new Uint8Array(ab)).then(function () { return true; });
        }).catch(function (e) { Toast.warn('写入文件失败：' + (e && e.message), 5600); return false; });
      }
      return fileToDataURL(blob).then(function (durl) {
        var base64 = String(durl || '').split(',')[1] || '';
        if (!base64) return false;
        return Host.writeFile(s, base64).then(function () { return true; });
      });
    }).catch(function (e) { Toast.warn('写入文件失败：' + (e && e.message), 5600); return false; });
  }

  /** 用宿主把 URL 直接下载到本地路径（同名文件存在时返回 {exists:true}，不覆盖；
   *  v2.5.0：「重新下载」传 overwrite=true，宿主先下到 <file>.redl 成功后再替换旧文件）。
   *  自动附带该站点已保存的 Cookie；宿主会拒绝把 HTML 登录页/错误页保存成下载文件。 */
  function downloadToPath(url, p, headers, jobId, overwrite) {
    var s = normalizeWinPath(p);
    if (!isAbsoluteWinPath(s) || !isHttpUrl(url)) return Promise.resolve(false);
    return Host.ensure().then(function (ok) {
      if (!ok) { Toast.warn('内置宿主未就绪：无法直接下载到存储路径', 5200); return false; }
      return Net.credFor(url).then(function (cred) {
        var h = Object.assign({}, headers || {});
        if (cred && cred.cookie && !h.Cookie) h.Cookie = cred.cookie;
        return Host.download(url, s, h, jobId, overwrite);
      });
    }).catch(function (e) { Toast.warn('下载失败：' + (e && e.message), 5600); return false; });
  }

  /* ---------------- 导出 ---------------- */

  /** 导出完整备份 JSON（可选包含封面） */
  function exportJSON(withCovers) {
    return Store.allAssets().then(function (assets) {
      var payload = {
        app: APP.name, version: APP.version, exportedAt: nowISO(),
        settings: App.exportableSettings(), assets: assets, covers: {}
      };
      if (!withCovers) return payload;
      return Store.allCovers().then(function (covers) {
        var chain = Promise.resolve();
        covers.forEach(function (c) {
          chain = chain.then(function () {
            if (c.dataURL) { payload.covers[c.id] = c.dataURL; return; }
            if (!c.blob) return;
            return fileToDataURL(c.blob).then(function (d) { payload.covers[c.id] = d; });
          });
        });
        return chain.then(function () { return payload; });
      });
    });
  }

  function downloadJSON(withCovers) {
    return exportJSON(withCovers).then(function (payload) {
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      var name = 'VRChat素材库备份_' + fmtDate(nowISO()).replace(/-/g, '') + (withCovers ? '_含封面' : '') + '.json';
      downloadBlob(blob, name);
      Toast.ok('已导出 ' + payload.assets.length + ' 条素材（' + fmtSize(blob.size) + '）');
      return payload;
    });
  }

  /** 导出 CSV（Excel 友好，带 BOM） */
  function downloadCSV(assets) {
    var head = ['自定义标题', '原标题', '来源', '分类', '标签', '支持角色', '商店链接', '本地路径',
      '上架日期', '作者/店铺', '喜欢', '备注', '添加时间', 'ID'];
    var lines = [head.map(csvCell).join(',')];
    assets.forEach(function (a) {
      lines.push([
        a.title, a.originalTitle, App.sourceLabel(a), App.categoryLabel(a.category),
        (a.tags || []).join(' / '),
        (a.avatars || []).map(App.avatarLabel).join(' / '),
        (a.links || []).map(function (l) { return l.url; }).join(' | '),
        (a.paths || []).map(function (p) { return p.path; }).join(' | '),
        a.publishedAt ? fmtDate(a.publishedAt) : '',
        a.author || a.shop || '', a.favorite ? '是' : '否',
        (a.note || '').replace(/\r?\n/g, ' '), fmtDate(a.createdAt, true), a.id
      ].map(csvCell).join(','));
    });
    var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, 'VRChat素材清单_' + fmtDate(nowISO()).replace(/-/g, '') + '.csv');
    Toast.ok('已导出 CSV（' + assets.length + ' 条）');
  }

  /** 生成「建议目录结构」文本 + 一键创建脚本 */
  function buildStructurePlan(assets, rootPath) {
    rootPath = rootPath || App.libraryRoot();   // v3.0.4：由应用目录推导，不再硬编码个人路径
    var tree = {};
    assets.forEach(function (a) {
      var cat = App.categoryLabel(a.category);
      var avs = (a.avatars || []).map(App.avatarLabel);
      var av = avs.length ? avs[0] : '通用';
      tree[cat] = tree[cat] || {};
      tree[cat][av] = tree[cat][av] || [];
      tree[cat][av].push(a);
    });
    var lines = [rootPath], bat = ['@echo off', 'chcp 65001 > nul', 'rem 由 ' + APP.name + ' 生成的目录结构脚本',
      'set ROOT=' + rootPath, 'if not exist "%ROOT%" mkdir "%ROOT%"'];
    Object.keys(tree).sort(collator.compare).forEach(function (cat) {
      lines.push('  ├─ ' + cat);
      bat.push('if not exist "%ROOT%\\' + cat + '" mkdir "%ROOT%\\' + cat + '"');
      Object.keys(tree[cat]).sort(collator.compare).forEach(function (av) {
        lines.push('  │   ├─ ' + av + '   （' + tree[cat][av].length + ' 项）');
        bat.push('if not exist "%ROOT%\\' + cat + '\\' + av + '" mkdir "%ROOT%\\' + cat + '\\' + av + '"');
        tree[cat][av].slice(0, 200).forEach(function (a) {
          var safe = String(a.title || a.originalTitle || a.id).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
          lines.push('  │   │     ' + safe);
        });
      });
    });
    bat.push('echo 目录结构创建完成。', 'pause');
    return { text: lines.join('\r\n'), bat: bat.join('\r\n'), tree: tree };
  }

  /* ---------------- 导入 ---------------- */
  function importJSON(payload, mode) {
    // mode: 'merge' 合并 | 'replace' 覆盖
    if (!payload || !Array.isArray(payload.assets)) {
      return Promise.reject(new Error('文件格式不正确：缺少 assets 数组'));
    }
    var step = mode === 'replace' ? Store.clearAll() : Promise.resolve();
    return step.then(function () {
      return Store.putAssets(payload.assets);
    }).then(function () {
      var covers = payload.covers || {};
      var ids = Object.keys(covers);
      var chain = Promise.resolve();
      ids.forEach(function (id) {
        chain = chain.then(function () {
          return fetch(covers[id]).then(function (r) { return r.blob(); })
            .then(function (b) { return Store.putCover(id, b); })
            .catch(function () {});
        });
      });
      return chain.then(function () { return ids.length; });
    }).then(function (coverCount) {
      if (payload.settings && mode !== 'nosettings') {
        // 仅合并安全字段
        var s = payload.settings;
        ['userTagDict', 'customCategories', 'customAvatars', 'customSources', 'theme'].forEach(function (k) {
          if (s[k] !== undefined) App.settings[k] = s[k];
        });
        return App.saveSettings().then(function () { return { assets: payload.assets.length, covers: coverCount }; });
      }
      return { assets: payload.assets.length, covers: coverCount };
    });
  }

  function readFileAsText(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsText(file, 'utf-8');
    });
  }

  return {
    supported: supported, saveSupported: saveSupported,
    pickDirectory: pickDirectory, pickDirectoryPath: pickDirectoryPath, setLibraryRoot: setLibraryRoot, getLibraryRoot: getLibraryRoot,
    resolveDirectoryPath: resolveDirectoryPath,
    relativePathExists: relativePathExists, completeRelativePaths: completeRelativePaths,
  /* v3.0.3：断开宿主也能验证「是否已下载」——三档判定 + 库根相对路径换算 + 离线目录枚举 */
  relPathFromLibrary: relPathFromLibrary, diskFileState: diskFileState, listLibraryDir: listLibraryDir,
    ensurePermission: ensurePermission, scanDirectory: scanDirectory,
    createCategoryFolders: createCategoryFolders, openPath: openPath,
    movePath: movePath, copyPath: copyPath, mkdirPath: mkdirPath, writeFileToPath: writeFileToPath, downloadToPath: downloadToPath,
    host: Host, hostAvailable: function () { return !!TAURI_INVOKE; }, hostEnsure: function () { return hostProbe(); },
    davCall: davCall,
    hostEnsureRetry: hostEnsureRetry,
    renameAssetFolder: renameAssetFolder,
    exportJSON: exportJSON, downloadJSON: downloadJSON, downloadCSV: downloadCSV,
    buildStructurePlan: buildStructurePlan, importJSON: importJSON, readFileAsText: readFileAsText
  };
})();

