/* preload：把渲染层调用的 window.__TAURI__.core.invoke 接到 IPC 上。
 * 与谁交互：渲染层（40-fs.js）只认一组固定命令名，这里逐个翻译成 ipcRenderer.invoke，
 * 主进程 main.js 注册同名 handler。
 * 边界：只暴露这组命令与白名单事件名，不透出 ipcRenderer / require / node 能力；
 * 路径校验与权限判断都在主进程做。
 */
const { contextBridge, ipcRenderer, webUtils, shell } = require('electron');

function argValue(prefix) {
  try {
    const hit = process.argv.find(function (a) { return a.startsWith(prefix); });
    return hit ? hit.slice(prefix.length) : '';
  } catch (e) { return ''; }
}

/* 路径以主进程的实时值为准：additionalArguments 在窗口创建时固化，
 * 改完数据位置再刷新就拿不到新值。同步 IPC 只在加载时用一次，代价有限。 */
let ENV = {};
try { ENV = ipcRenderer.sendSync('app:env') || {}; } catch (e) { ENV = {}; }

const APP_ROOT = ENV.appRoot || argValue('--vrclib-app-root=');
const DATA_DIR = ENV.dataDir || argValue('--vrclib-data-dir=');
const SETTINGS_DIR = ENV.settingsDir || argValue('--vrclib-settings-dir=');
const LIBRARY_DIR = ENV.libraryDir || argValue('--vrclib-library-dir=');

/* 流式接口没有实现：明确拒绝，别让调用方以为拿到了空流 */
const NOT_YET = function (what) {
  return Promise.reject(new Error('「' + what + '」还没迁移到 Electron 版'));
};

function invoke(cmd, args, opts) {
  const a = args || {};
  const o = opts || {};
  switch (cmd) {
    case 'host_call':
      return ipcRenderer.invoke('host:call', { api: a.api, payload: a.payload });
    case 'host_read_bytes':
      return ipcRenderer.invoke('host:readBytes', { path: a.path });
    case 'host_write_bytes': {
      /* 第二个位置参数是裸字节，路径在第三个参数的 headers 里 —— 调用约定如此 */
      const h = (o.headers || {})['x-vrc-path'] || '';
      let p = '';
      try { p = decodeURIComponent(String(h)); } catch (e) { p = String(h); }
      return ipcRenderer.invoke('host:writeBytes', { path: p, bytes: a });
    }
    case 'thumb_ensure':
      return ipcRenderer.invoke('thumb:ensure', a);
    case 'thumb_batch':
      return ipcRenderer.invoke('thumb:batch', a);
    case 'app_paths':
      return ipcRenderer.invoke('app:paths');
    case 'win_action':
      return ipcRenderer.invoke('win:action', { action: a.action });
    case 'open_external':
      return ipcRenderer.invoke('app:openExternal', { url: a.url });
    case 'data_scan':
    case 'data_cleanup':
    case 'data_apply_root':
      return ipcRenderer.invoke('data:' + cmd, a);
    case 'data_migrate': {
      /* 搬家要实时进度：页面传进来的是 Channel（40-fs.js 的 TAURI_CHANNEL），
       * 这里按 jobId 开一条专用通道，把每帧转进 Channel.onmessage。 */
      const ch = a.onEvent;
      const jobId = 'mig-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const onFrame = function (_e, frame) {
        try { if (ch && typeof ch.onmessage === 'function') ch.onmessage(frame); } catch (err) {}
      };
      const chName = 'data:migrate:' + jobId;
      ipcRenderer.on(chName, onFrame);
      return ipcRenderer.invoke('data:data_migrate', { from: a.from, to: a.to, jobId: jobId })
        .finally(function () {
          try { ipcRenderer.removeListener(chName, onFrame); } catch (e) {}
        });
    }
    case 'host_p2p_read':
      return ipcRenderer.invoke('p2p:read', { session: a.session, block: a.block });
    case 'host_p2p_write': {
      /* 同 host_write_bytes 的约定：第一个位置参数是裸字节，会话与块号放在 headers 里 */
      const h = o.headers || {};
      return ipcRenderer.invoke('p2p:write', {
        session: h['x-p2p-session'] || '',
        block: Number(h['x-p2p-block'] || 0),
        bytes: a
      });
    }
    case 'host_stream':
      return NOT_YET('流式请求');
    default:
      return Promise.reject(new Error('未实现的命令：' + cmd));
  }
}

/* 页面只在 host_stream 里用到 Channel；这里给个空壳，让构造不报错 */
function Channel() {
  this.onmessage = null;
  this.__id = 0;
}
Channel.prototype.toJSON = function () { return { __channelId: this.__id }; };

/* event.listen 垫片：页面用它监听主进程推来的几条事件
 * （导入中关窗的确认、拖拽桥、窗口状态）。只放行白名单里的名字，
 * 不把任意 IPC 通道透给页面。 */
const EVENT_ALLOW = ['wb-busy-close', 'win:state', 'vrc://drag'];
function listen(name, cb) {
  try {
    const ch = String(name || '');
    if (EVENT_ALLOW.indexOf(ch) < 0 || typeof cb !== 'function') return Promise.resolve(function () {});
    const handler = function (_e, payload) {
      try { cb({ event: ch, payload: payload || {} }); } catch (err) {}
    };
    ipcRenderer.on(ch, handler);
    return Promise.resolve(function () {
      try { ipcRenderer.removeListener(ch, handler); } catch (e) {}
    });
  } catch (e) {
    return Promise.resolve(function () {});
  }
}

contextBridge.exposeInMainWorld('__TAURI__', {
  core: { invoke: invoke, Channel: Channel },
  event: { listen: listen }
});

/* 页面另外还会读 window.vrcElectron（desk 判定、拖拽取路径、窗口按钮、标题栏配色） */
contextBridge.exposeInMainWorld('vrcElectron', {
  shell: 'electron',
  version: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  appRoot: APP_ROOT,
  dataDir: DATA_DIR,
  settingsDir: SETTINGS_DIR,
  libraryDir: LIBRARY_DIR,
  getPathForFile: function (file) {
    try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; }
  },
  openExternal: function (url) {
    try {
      const u = String(url || '');
      if (!/^https?:\/\//i.test(u)) return false;
      shell.openExternal(u);
      return true;
    } catch (e) { return false; }
  },
  winAction: function (action) {
    try {
      const a = String(action || '');
      if (['min', 'max', 'show', 'close'].indexOf(a) < 0) return false;
      ipcRenderer.invoke('win:action', { action: a });
      return true;
    } catch (e) { return false; }
  },
  onWinState: function (cb) {
    try {
      if (typeof cb !== 'function') return false;
      ipcRenderer.on('win:state', function (_e, max) { try { cb(!!max); } catch (err) {} });
      return true;
    } catch (e) { return false; }
  },
  setTitleBar: function () { return true; }   // 自绘标题栏，不需要系统覆盖层配色
});
