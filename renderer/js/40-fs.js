/*
 * 40-fs.js —— 渲染层访问本机文件的唯一入口：选择、读写、移动复制、后端调用
 *   （hostCall → preload 垫片 → IPC），以及导入导出与目录结构整理。
 * 交互：20-store.js 的落盘、改名、导出都经这里；浏览器侧另有 File System Access 兜底。
 * 边界：不做数据建模，也不决定业务语义——只把路径与字节送到该去的地方。
 */

var FS = (function () {

  function supported() { return typeof window.showDirectoryPicker === 'function'; }
  function saveSupported() { return typeof window.showSaveFilePicker === 'function'; }
  /* ---------------- 进程内后端 ----------------
   * 后端是同进程的命令调用，不是本地 HTTP 服务：没有端口，就没有被别的本地服务冒充的余地，
   * 也没有跨进程调用会「断开」。
   * api 名与 payload 形状保持不变，业务侧的调用点因此不必改动。 */
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

  /** 后端就绪判定：进程内命令，载体在就永远在线，没有探测这一步；
   *  保留函数只为不扰动既有调用点。 */
  function hostProbe() {
    return Promise.resolve(!!TAURI_INVOKE);
  }
  /** 带重试签名的就绪判定：进程内后端无需重试，保留给启动链调用 */
  function hostEnsureRetry() {
    return Promise.resolve(!!TAURI_INVOKE);
  }
  function hostCall(api, payload) {
    /* ok=false 抛错，cancelled 原样返回给调用方自己判断 */
    if (!TAURI_INVOKE) {
      return Promise.reject(new Error('当前载体不支持文件操作：请从桌面程序运行，不要直接用浏览器打开页面'));
    }
    return TAURI_INVOKE('host_call', { api: api, payload: payload === undefined ? {} : (payload || {}) })
      .catch(function (e) { throw new Error(String((e && e.message) || e || '后端调用失败')); })
      .then(function (j) {
        if (j && j.ok === false && j.cancelled === true) return j;
        if (!j || j.ok === false) throw new Error((j && j.error) || ('后端请求失败 ' + api));
        return j;
      });
  }
  var Host = {
    available: function () { return !!TAURI_INVOKE; },
    /** 是否跑在原生桌面壳里：页面据此切换文案与布局，区分网页版与桌面版 */
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
    /* 素材包：另存为 / 选单个文件 / 打包。返回后端原始对象（含 ok / cancelled），
     * 由调用方判断用户是否取消。 */
    saveFile: function (p) { return hostCall('/api/saveFile', p || {}); },
    pickOneFile: function (p) { return hostCall('/api/pickOneFile', p || {}); },
    pack: function (api, payload) { return hostCall('/api/pack/' + api, payload || {}); },
    /** 导入与工程：probe / hash / plan / execute / listDir / findUnity / launchUnity / logTail / receipt / installBridge */
    wb: function (op, payload) { return hostCall('/api/wb/' + op, payload || {}); },
    /** 素材主库（SQLite）：load / save / info */
    db: function (op, payload) { return hostCall('/api/db/' + op, payload || {}); },
    /** 自动更新：info / apply / progress / cancel（桌面版才通，网页载体直接报不支持） */
    update: function (op, payload) { return hostCall('/api/update/' + op, payload || {}); },
    /** 原始字节通道：读回与写入都是 Uint8Array，全程不碰 base64 */
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
    /** P2P 传文件：磁盘侧会话（prepare / open / status / finish / cancel）+ 分块二进制读写。
     *  块数据走 host_p2p_read / host_p2p_write，和 readBytes 那条通道一样不过 base64。 */
    p2p: function (op, payload) { return hostCall('/api/p2p/' + op, payload || {}); },
    p2pRead: function (session, block) {
      if (!TAURI_INVOKE) return Promise.reject(new Error('当前载体不支持分块读取'));
      return TAURI_INVOKE('host_p2p_read', { session: session, block: block })
        .then(function (buf) { return (buf instanceof Uint8Array) ? buf : new Uint8Array(buf); });
    },
    p2pWrite: function (session, block, bytes) {
      if (!TAURI_INVOKE) return Promise.reject(new Error('当前载体不支持分块写入'));
      var u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
      return TAURI_INVOKE('host_p2p_write', u8, {
        headers: { 'x-p2p-session': session, 'x-p2p-block': String(block) }
      }).then(function (r) {
        if (!r || r.ok === false) throw new Error((r && r.error) || '分块写入失败');
        return r;
      });
    },
    /** 缩略图：由后端生成 400px JPEG */
    thumb: function (src, dst, max) {
      if (!TAURI_INVOKE) return Promise.reject(new Error('当前载体不支持缩略图'));
      return TAURI_INVOKE('thumb_ensure', { src: src, dst: dst, max: max || 400 });
    },
    thumbBatch: function (items, max) {
      if (!TAURI_INVOKE) return Promise.reject(new Error('当前载体不支持缩略图'));
      return TAURI_INVOKE('thumb_batch', { items: items || [], max: max || 400 });
    },
    /* ---- 数据目录（选择 / 搬迁） ---- */
    dataScan: function (dir) {
      if (!TAURI_INVOKE) return Promise.resolve({ ok: false, error: '当前载体不支持' });
      return TAURI_INVOKE('data_scan', { dir: String(dir || '') });
    },
    /** 复制到新目录并校验；onEvent({phase,done,total,name}) 用于进度条 */
    dataMigrate: function (from, to, onEvent) {
      if (!TAURI_INVOKE) return Promise.reject(new Error('当前载体不支持数据迁移'));
      var ch = new TAURI_CHANNEL();
      ch.onmessage = function (raw) {
        if (!onEvent) return;
        try { onEvent(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch (e) {}
      };
      return TAURI_INVOKE('data_migrate', { from: from, to: to, onEvent: ch });
    },
    /** 删除旧目录里的重型数据（不会碰 settings.json） */
    dataCleanup: function (dir) {
      if (!TAURI_INVOKE) return Promise.resolve({ ok: false, error: '当前载体不支持' });
      return TAURI_INVOKE('data_cleanup', { dir: String(dir || '') });
    },
    /** 重新解析数据根并重开数据库（写完 settings.localDataDir 之后调用） */
    dataApplyRoot: function () {
      if (!TAURI_INVOKE) return Promise.resolve({ ok: false, error: '当前载体不支持' });
      return TAURI_INVOKE('data_apply_root', {});
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
    /** 删除本地文件 / 目录；后端带安全阀，拒绝盘符根与短路径 */
    remove: function (p) { return hostCall('/api/delete', { path: p }); },
    /** 下载进度：后端统一返回 {ok, job:{received,total,speed,…}}，这里摊平成一层供 88-download.js 直接读。 */
    downloadProgress: function (jobId) {
      return hostCall('/api/downloadProgress', { jobId: jobId }).then(function (r) {
        if (r && r.job) return Object.assign({ ok: r.ok !== false }, r.job);
        return r;
      });
    },
    /** 取消下载：真正断掉后端侧的上游请求，不只是从列表里移除 */
    downloadCancel: function (jobId) { return hostCall('/api/downloadCancel', { jobId: jobId }); },
    open: function (p) { return hostCall('/api/open', { path: p }); },
    openUrl: function (u) { return hostCall('/api/openUrl', { url: u }); },
    /* 用默认浏览器打开外链；失败时把链接复制到剪贴板并提示 */
    openExternal: function (u) {
      var url = String(u || '').trim();
      if (!/^https?:\/\//i.test(url)) { Toast.warn('链接无效'); return Promise.resolve(); }
      return this.openUrl(url).catch(function () {
        try { copyText(url); } catch (e) {}
        Toast.err('打不开浏览器，链接已复制：' + url, 6200);
      });
    },
    exists: function (p) { return hostCall('/api/exists', { path: p }).then(function (j) { return j.kind || null; }); },
    /** 带大小的 stat：exists 只回 kind，导入素材时还要 fileSize */
    stat: function (p) { return hostCall('/api/exists', { path: p }); },
    readText: function (p) { return hostCall('/api/readText', { path: p }).then(function (j) { return j.text || ''; }); },
    /** 第 5 个参数是可选超时（毫秒），后端会限幅；不传则用后端默认值 */
    fetchURL: function (url, headers, method, body, timeoutMs) {
      var payload = { url: url, headers: headers || {}, method: method || 'GET', body: body };
      if (timeoutMs) payload.timeoutMs = timeoutMs;
      return hostCall('/api/fetch', payload);
    },
    /** 流式请求：给 AI 翻译这类长响应用，只要上游持续吐字节就不会被空闲超时掐断。
     *  opts: { timeoutMs, onChunk(text, acc) }；返回 { status, ok, text, error }。 */
    streamFetch: function (url, headers, method, body, opts) {
      opts = opts || {};
      var payload = { url: url, headers: headers || {}, method: method || 'GET', body: body };
      if (opts.timeoutMs) payload.timeoutMs = opts.timeoutMs;
      /* 流式帧经 Channel 传回：{type:'head'|'chunk'|'error'}，调用方拿到的结果形状不变 */
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
      /* 没有流式通道就明确报错，不退回缓冲式请求：
       * 那种退让会让长响应被截断，看起来像「模型答到一半停了」。 */
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
   * 选择文件夹并直接拿到真实绝对路径：后端可用时走原生对话框，返回 {path, name, handle:null}；
   * 后端离线才退回浏览器句柄 + 库根反查。
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
   * 把 FileSystemDirectoryHandle 还原成绝对路径。
   * 浏览器不返回磁盘路径，只能拿库根句柄做有界搜索，还原「根\分类\素材文件夹」。
   * isSameEntry 返回 Promise，必须 await——直接当布尔用会恒为真，把任意目录当成库根。
   * 找不到（例如选的是库外文件夹）返回 null，调用方提示用户手动粘贴完整路径。
   */
  function resolveDirectoryPath(handle) {
    if (!handle || typeof handle.isSameEntry !== 'function') return Promise.resolve(null);
    return getLibraryRoot().then(async function (root) {
      if (!root || typeof root.isSameEntry !== 'function') return null;
      var rootPath = App.libraryRoot();
      // 库根句柄与库根路径必须是同一个目录：两者分别选过不同位置时，
      // 搜索会把相对路径拼到错误根上，生成一个并不存在的假路径。
      var rootLast = String(rootPath.replace(/[\\/]+$/, '').split('\\').pop() || '').toLowerCase();
      var handleName = String(root.name || '').toLowerCase();
      if (rootLast && handleName && rootLast !== handleName) {
        console.warn('resolveDirectoryPath：库根句柄名「' + root.name + '」与库根路径末段「' + rootLast + '」不一致，放弃自动还原。请在设置中统一两处。');
        return null;
      }
      var ok = await ensurePermission(root, 'read');
      if (!ok) return null;
      try {
        if (await handle.isSameEntry(root)) return rootPath;
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
              if (typeof entry.isSameEntry === 'function' && entry.name === handle.name && await entry.isSameEntry(handle)) {
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

  /** 把「存储目录 + 文件名」换算成库根相对路径，供目录句柄分支使用。
   *  dir 可能是 Windows 绝对路径（剥掉库根前缀）或相对路径；
   *  映射不到库根下时返回 ''，表示这条分支不可用。 */
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

  /** 判断文件是否真的在磁盘上，后端离线时也要能答。
   *   ① 后端可用 → 问后端（权威）
   *   ② 后端不可用但库根句柄有读权限 → 按相对路径查（权威）
   *   ③ 两者都不可用 → { known:false }，调用方保留原标记；不能把「无法判定」当成「没有文件」
   *  返回 Promise<{known:true, exists:boolean, via:'host'|'fsa'} | {known:false}> */
  function diskFileState(absPath, relPath) {
    function viaHost() {
      if (!absPath || !FS.host || typeof FS.host.exists !== 'function' || typeof FS.hostEnsure !== 'function') return Promise.resolve(null);
      return FS.hostEnsure().then(function (ok) {
        if (!ok) return null;                        // 后端不可用 ⇒ 让位给 FSA 分支，而不是直接放弃
        return FS.host.exists(absPath).then(function (k) { return { known: true, exists: k === 'file', via: 'host' }; });
      }).catch(function () { return null; });        // 后端刚掉线：也退化到 FSA 分支
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

  /** 用库根句柄列出库根相对目录下的文件，供后端离线时降级枚举，口径与后端 scan 一致。
   *  返回 {usable, exists, names}：usable=false 表示不可判定，不能被当成「没有文件」。 */
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
   * 打开本地路径：后端在线时交给资源管理器，离线时降级为复制路径。
   * 只接受完整绝对路径（G:\… / \\server\…）；不猜根目录，
   * 否则 explorer 定位失败会回退到桌面。
   */
  function openPath(path) {
    var raw = normalizeWinPath(path);
    if (!raw) { Toast.warn('未提供可打开的本地路径'); return; }
    // 不完整的相对路径交给 explorer 会定位失败并回退到桌面，所以先拦下
    if (!isAbsoluteWinPath(raw)) {
      copyText(raw);
      Toast.warn('该本地路径不完整（' + raw + '），无法直接打开。请在编辑页补全为 G:\\… 或 \\\\服务器\\… 的完整路径（已复制当前内容）。', 6200);
      return;
    }
    var abs = raw;
    // 先给即时反馈，再做带重试的后端探测：刚启动时后端可能还没就绪
    Toast.info('正在打开资源管理器（若后端刚启动会稍等 1~3 秒）…', 1800);
    hostEnsureRetry(3).then(function (ok) {
      if (!ok) {
        copyText(abs);
        Toast.warn('程序后端未就绪：无法直接打开资源管理器（路径已复制到剪贴板）。请重启程序后重试。', 6800);
        return;
      }
      return Host.open(abs).then(function () {
        Toast.ok('已通过本地后端打开：' + abs, 3200);
      }, function (e) {
        copyText(abs);
        Toast.warn('后端打开失败：' + (e && e.message) + '（路径已复制）', 5200);
      });
    });
  }

  /** 素材文件夹改名：标题或角色名改完后同步磁盘目录。
   *  源目录必须取素材自己的存储路径——磁盘文件夹名保留的是导入时的原标题，
   *  用当前标题重建多半根本不存在，后端只会报「源不存在」。
   *  后端在线却失败时明说原因，不再静默退回浏览器复制 + 删除。 */
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
    /* 源目录优先取素材自己的存储路径；没有才退回「根目录 + 分类 + 旧名」 */
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
    /* 改名只是顺手同步磁盘目录，不能拖住保存：后端 8 秒不应答就放行，
     * 旧目录本来就缺失时也只提示一句，不拿红字吓人。 */
    var TIMEOUT = { timeout: true };
    function withTimeout(promise, ms) {
      return Promise.race([
        Promise.resolve(promise),
        new Promise(function (res) { setTimeout(function () { res(TIMEOUT); }, ms); })
      ]);
    }
    return withTimeout(Host.ensure(), 8000).then(function (ok) {
      if (ok === TIMEOUT) {
        if (typeof Toast !== 'undefined' && Toast.info) Toast.info('后端没有应答，文件夹未改名；素材信息照常保存', 5000);
        return false;
      }
      if (!ok) return browserRename();                       // 后端确实离线 → 才用浏览器实现
      return withTimeout(Host.move(oldAbs, newAbs), 8000).then(function (r) {
        if (r === TIMEOUT) {
          if (typeof console !== 'undefined' && console.warn) console.warn('[rename] 后端改名超时：' + oldAbs + ' → ' + newAbs);
          if (typeof Toast !== 'undefined' && Toast.info) Toast.info('文件夹改名没完成（后端没有应答），素材信息已保存', 5000);
          return false;
        }
        return true;
      }, function (err) {
        /* 后端在线却失败就明说原因：此时再回退到复制 + 删除，
         * 源路径不存在时只会留下半成品。 */
        var msg = (err && err.message) || String(err);
        if (typeof console !== 'undefined' && console.warn) console.warn('[rename] 后端改名失败：' + msg + '（' + oldAbs + ' → ' + newAbs + '）');
        if (/ENOENT|not found|不存在|no such file/i.test(msg)) {
          /* 旧目录本来就不在磁盘上（多半已被手动改名/移走）：不算故障，保存照常进行 */
          if (typeof Toast !== 'undefined' && Toast.info) Toast.info('旧目录不在磁盘上（可能已手动改名），本次只保存素材信息，路径未改动。', 5200);
        } else if (typeof Toast !== 'undefined' && Toast.warn) {
          Toast.warn('文件夹改名没成功（后端：' + msg + '）：素材库里的目录仍是旧名，可手动改名后重新登记路径。', 6000);
        }
        return false;
      });
    });
  }

  /**
   * 系统级移动（改名即移动）：只由本机后端执行，返回 'host' | false。
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
      Toast.warn('程序后端未就绪：无法执行移动（目标路径已复制）。请重启程序后重试。', 6800);
      return false;
    }
    try {
      await Host.move(s, d);
      Toast.ok('已通过本地后端移动：' + s + ' → ' + d, 3600);
      return 'host';
    } catch (e) {
      copyText(d);
      Toast.warn('后端移动失败：' + (e && e.message) + '（目标路径已复制，未做任何回退）', 6800);
      return false;
    }
  }

  /** 系统级复制：只由本机后端执行，源保留；返回 'host' | false */
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
      Toast.warn('程序后端未就绪：无法执行复制（目标路径已复制）。请重启程序后重试。', 6800);
      return false;
    }
    try {
      await Host.copy(s, d);
      Toast.ok('已通过本地后端复制：' + s + ' → ' + d, 3600);
      return 'host';
    } catch (e) {
      copyText(d);
      Toast.warn('后端复制失败：' + (e && e.message) + '（目标路径已复制，未做任何回退）', 6800);
      return false;
    }
  }

  /** 按【完整路径字符串】精确创建目录：后端在线时走后端；返回是否已由后端创建 */
  async function mkdirPath(p) {
    var s = normalizeWinPath(p);
    if (!isAbsoluteWinPath(s)) return false;
    if (await Host.ensure()) {
      try { await Host.mkdir(s); return true; } catch (e) { Toast.warn('后端创建目录失败：' + (e && e.message), 5200); }
    }
    return false;
  }

  /** 把 Blob/File 按完整路径字符串写到磁盘（后端在线时走后端；返回 Promise<boolean>） */
  function writeFileToPath(p, blob) {
    var s = normalizeWinPath(p);
    if (!isAbsoluteWinPath(s) || !blob) return Promise.resolve(false);
    return Host.ensure().then(function (ok) {
      if (!ok) { Toast.warn('程序后端未就绪：无法把文件写到磁盘路径', 5200); return false; }
      /* 能走原始字节就别绕 base64：写封面、导出图片都走这条 */
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

  /** 用后端把 URL 直接下载到本地路径；同名文件存在时返回 {exists:true}，不覆盖。
   *  overwrite=true 时先下到临时文件、成功后再替换，中途失败不会毁掉旧文件。
   *  自动带上该站点已保存的 Cookie；后端会拒绝把 HTML 登录页 / 错误页存成下载文件。 */
  function downloadToPath(url, p, headers, jobId, overwrite) {
    var s = normalizeWinPath(p);
    if (!isAbsoluteWinPath(s) || !isHttpUrl(url)) return Promise.resolve(false);
    return Host.ensure().then(function (ok) {
      if (!ok) { Toast.warn('程序后端未就绪：无法直接下载到存储路径', 5200); return false; }
      return Net.credFor(url).then(function (cred) {
        var h = Object.assign({}, headers || {});
        if (cred && cred.cookie && !h.Cookie) h.Cookie = cred.cookie;
        return Host.download(url, s, h, jobId, overwrite);
      });
    }).catch(function (e) { Toast.warn('下载失败：' + (e && e.message), 5600); return false; });
  }

  /* ---------------- 导出 ---------------- */

  /** Blob → 原始字节（不经 base64） */
  function blobToU8(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(new Uint8Array(fr.result)); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsArrayBuffer(blob);
    });
  }

  /** 存到用户自己选的位置：原生「另存为」优先，没有原生对话框才退回浏览器下载。
   *  一律走 <a download> 会被壳静默丢进系统「下载」文件夹——不弹窗也没有路径提示，
   *  用户常常找不到文件、反复导出堆同名副本。
   *  返回 {status, path}：saved / cancelled / download / failed；取消是正常操作，静默返回。 */
  function saveToUserPath(blob, defaultName, opts) {
    opts = opts || {};
    if (!TAURI_INVOKE) {
      downloadBlob(blob, defaultName);
      return Promise.resolve({ status: 'download', path: '' });
    }
    var def = defaultName;
    try { def = joinWinPath(App.libraryRoot(), [defaultName]); } catch (e) {}
    return Host.saveFile({
      title: opts.title || '保存文件',
      defaultPath: def,
      filters: opts.filters || []
    }).then(function (r) {
      if (!r || r.ok === false) return { status: 'cancelled', path: '' };   // 取消 / 关窗
      var path = String(r.path || '');
      if (!path) return { status: 'cancelled', path: '' };
      if (opts.ext && !new RegExp('\\.' + opts.ext + '$', 'i').test(path)) path += '.' + opts.ext;
      return blobToU8(blob).then(function (bytes) {
        return Host.writeBytes(path, bytes).then(function () { return { status: 'saved', path: path }; });
      });
    }).catch(function (e) {
      Toast.err('保存失败：' + ((e && e.message) || e || '未知错误'), 5600);
      return { status: 'failed', path: '' };
    });
  }

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
      return saveToUserPath(blob, name, {
        title: '导出完整备份',
        ext: 'json',
        filters: [{ name: 'JSON 备份', extensions: ['json'] }]
      }).then(function (r) {
        if (r.status === 'cancelled') return payload;        // 用户取消：静默，什么都不提示
        var base = '已导出 ' + payload.assets.length + ' 条素材（' + fmtSize(blob.size) + '）';
        if (r.status === 'saved') Toast.ok(base + '\n保存到：' + r.path, 7000);
        else if (r.status === 'download') Toast.ok(base);     // 无原生对话框，退回浏览器下载
        return payload;
      });
    });
  }

  /** 导出 CSV（Excel 友好，带 BOM） */
  function downloadCSV(assets) {
    /* 最后一列是素材编号而不是内部主键：内部 id 只在库里有意义，
     * 抄到表里对不上任何东西；编号才是能拿去和好友核对的那一个。 */
    var head = ['自定义标题', '原标题', '来源', '分类', '标签', '支持角色', '商店链接', '本地路径',
      '上架日期', '作者/店铺', '喜欢', '备注', '添加时间', '素材编号'];
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
        (a.note || '').replace(/\r?\n/g, ' '), fmtDate(a.createdAt, true), App.fileIdOf(a)
      ].map(csvCell).join(','));
    });
    var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var name = 'VRChat素材清单_' + fmtDate(nowISO()).replace(/-/g, '') + '.csv';
    return saveToUserPath(blob, name, {
      title: '导出 CSV 清单',
      ext: 'csv',
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
    }).then(function (r) {
      if (r.status === 'cancelled') return '';
      var base = '已导出 CSV（' + assets.length + ' 条）';
      if (r.status === 'saved') Toast.ok(base + '\n保存到：' + r.path, 7000);
      else if (r.status === 'download') Toast.ok(base);
      return r.path;
    });
  }

  /** 生成「建议目录结构」文本 + 一键创建脚本 */
  function buildStructurePlan(assets, rootPath) {
    rootPath = rootPath || App.libraryRoot();   // 由应用目录推导，不写死机器路径
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
  /* 后端离线也能核对「是否已下载」：三档判定 + 库根相对路径换算 + 离线目录枚举 */
  relPathFromLibrary: relPathFromLibrary, diskFileState: diskFileState, listLibraryDir: listLibraryDir,
    ensurePermission: ensurePermission, scanDirectory: scanDirectory,
    createCategoryFolders: createCategoryFolders, openPath: openPath,
    movePath: movePath, copyPath: copyPath, mkdirPath: mkdirPath, writeFileToPath: writeFileToPath, downloadToPath: downloadToPath,
    host: Host, hostAvailable: function () { return !!TAURI_INVOKE; }, hostEnsure: function () { return hostProbe(); },
    hostEnsureRetry: hostEnsureRetry,
    renameAssetFolder: renameAssetFolder,
    exportJSON: exportJSON, downloadJSON: downloadJSON, downloadCSV: downloadCSV,
    buildStructurePlan: buildStructurePlan, importJSON: importJSON, readFileAsText: readFileAsText
  };
})();

