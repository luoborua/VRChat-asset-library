/* Electron 主进程：应用生命周期、窗口、托盘、自定义协议与 IPC 入口。
 * 与谁交互：渲染层经 preload 暴露的同名接口调进来，路由集中在 bridge.js；
 * 数据目录、边车进程、P2P 会话这些资源都挂在本进程上，退出时逐个收掉。
 * 边界：不放业务逻辑 —— 文件、网络、素材包、P2P 都在 host/ 下，这里只做装配与兜底。
 */
const { app, BrowserWindow, Menu, Tray, dialog, screen, shell, ipcMain, protocol, session, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const bridge = require('./bridge.js');
const dataApi = require('./host/api-data.js');
const { makeIconPng } = require('./icon.js');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const RENDERER_INDEX = path.join(APP_ROOT, 'renderer', 'index.html');
const RENDERER_URL = pathToFileURL(RENDERER_INDEX).href;
const SETTINGS_ROOT = path.join(APP_ROOT, 'vrclib-data');

/* 主动退出流程置位：关窗拦截要让路，否则托盘「退出」会被静默取消。 */
let quitting = false;
/* 数据根：settings.json 配了 localDataDir 就用它，否则默认与配置同目录。
 * 用户自己挪过位置的数据不能被程序改回默认值。 */
function resolveDataDir() {
  try {
    const txt = fs.readFileSync(path.join(SETTINGS_ROOT, 'settings.json'), 'utf8');
    const j = JSON.parse(txt);
    const p = j && j.settings && j.settings.localDataDir;
    if (p && String(p).trim()) return String(p).trim();
  } catch (e) {}
  return SETTINGS_ROOT;
}
/* 数据根可变：「更改数据位置」会改它。窗口的 additionalArguments 在创建时就固化了，
 * 所以 preload 另走 sendSync('app:env') 取实时值，否则刷新后拿到的还是旧目录。 */
let DATA_DIR = resolveDataDir();
const LIBRARY_DIR = path.join(APP_ROOT, '本地素材库');
const RUNTIME_DIR = path.join(APP_ROOT, 'runtime');
/* 设置目录固定在 appRoot/vrclib-data：用户的 settings.json 与库根配置都在这里 */
const SETTINGS_DIR = SETTINGS_ROOT;
/* 缓存与单实例锁放程序目录（便携）。%APPDATA% 不可写时 requestSingleInstanceLock
 * 不返回 false，而是直接把进程带走，所以不能留在默认位置。 */
try { fs.mkdirSync(path.join(RUNTIME_DIR, 'electron-userdata'), { recursive: true }); } catch (e) {}
app.setPath('userData', path.join(RUNTIME_DIR, 'electron-userdata'));

const DEV = process.argv.includes('--devtools');

let win = null;

/* 自定义协议必须在 app ready 之前声明权限，否则页面里的 <img> / fetch 读不到 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'vrcasset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  }
]);

function mimeOf(file) {
  const ext = String(file).toLowerCase().replace(/^.*\./, '');
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'avif') return 'image/avif';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'json') return 'application/json';
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'webm') return 'video/webm';
  return 'application/octet-stream';
}

function logBoot(line) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.appendFileSync(path.join(RUNTIME_DIR, 'electron-boot.log'),
      new Date().toTimeString().slice(0, 8) + '  ' + line + '\n', 'utf8');
  } catch (e) {}
}

/* 主进程兜底：加载期与 ready 之前的异常没有窗口可报，只能落盘，
 * 双击没反应时看 runtime/electron-boot.log。 */
process.on('uncaughtException', function (e) {
  logBoot('uncaughtException: ' + ((e && (e.stack || e.message)) || String(e)));
});
process.on('unhandledRejection', function (e) {
  logBoot('unhandledRejection: ' + ((e && (e.stack || e.message)) || String(e)));
});
logBoot('main loaded, pid=' + process.pid + ' electron=' + process.versions.electron + ' node=' + process.versions.node);

function createWindow() {
  logBoot('createWindow');
  /* 默认宽度是「中等卡片一排 6 张」，小屏 / 高缩放机器上会超出屏幕，按工作区再夹一次。 */
  let winW = 1739;
  let winH = 1000;
  try {
    const wa = screen.getPrimaryDisplay().workAreaSize;
    winW = Math.min(winW, Math.round(wa.width * 0.94));
    winH = Math.min(winH, Math.round(wa.height * 0.90));
  } catch (e) { logBoot('screen query failed: ' + e.message); }

  win = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: 1160,
    minHeight: 620,
    show: false,
    backgroundColor: '#0e1014',
    title: 'VRChat 改模素材管理库',
    icon: nativeImage.createFromBuffer(makeIconPng(32)),
    autoHideMenuBar: true,
    /* 无边框外观：系统标题栏隐藏，窗口按钮由页面自绘（.win-controls） */
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    frame: false,
    webPreferences: {
      /* 渲染进程隔离：上下文隔离开、Node 关、webview 标签禁用。
       * 沙箱不可用时这几项是唯一防线，所以不随沙箱开关放宽。 */
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [
        '--vrclib-app-root=' + APP_ROOT,
        '--vrclib-data-dir=' + DATA_DIR,
        '--vrclib-settings-dir=' + SETTINGS_DIR,
        '--vrclib-library-dir=' + LIBRARY_DIR
      ]
    }
  });

  /* 窗口必须真的显示出来：ready-to-show 要等首帧绘制，页面被卡住就永不触发，
   * 于是进程活着但屏幕全黑。三道兜底：就绪 / 加载失败 / 2.5 秒超时。 */
  var shown = false;
  function showWin(reason) {
    if (shown || !win || win.isDestroyed()) return;
    shown = true;
    win.show();
    win.focus();
    logBoot('window shown (' + reason + ')');
  }
  win.once('ready-to-show', function () { showWin('ready-to-show'); });
  win.webContents.on('did-fail-load', function (_e, code, desc, url) {
    logBoot('did-fail-load ' + code + ' ' + desc + ' ' + String(url).slice(0, 120));
    showWin('did-fail-load');
  });
  win.webContents.on('render-process-gone', function (_e, d) {
    logBoot('render-process-gone ' + JSON.stringify(d));
  });
  setTimeout(function () { showWin('timeout'); }, 2500);

  /* 最大化状态：页面标题栏的按钮靠这条事件切换图标（90-main.js 的 onWinState）。 */
  function sendWinState() {
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send('win:state', win.isMaximized()); } catch (e) {}
  }
  win.on('maximize', sendWinState);
  win.on('unmaximize', sendWinState);
  win.webContents.on('did-finish-load', sendWinState);

  /* 导入还在跑时先让页面确认再关窗。busy 是租约而不是布尔值，
   * 页面崩了没人续租，过期后照样能关，不会把窗口锁死。 */
  win.on('close', function (e) {
    try { bridge.p2p.flushAll(); } catch (err) {}
    /* 主动退出（托盘「退出」、quitNow）必须放行，否则 app.quit 会被这次 preventDefault 静默取消。 */
    if (quitting) { logBoot('window close (退出流程)'); return; }
    if (bridge.isImportBusy()) {
      e.preventDefault();
      logBoot('close blocked: import busy');
      try { win.webContents.send('wb-busy-close', {}); } catch (err) {}
      return;
    }
    logBoot('window close (用户关窗 / 程序请求)');
  });
  win.on('closed', function () { win = null; });

  /* 只允许停在本地渲染页：页面一旦被换成外部站点，preload 暴露的能力就等于交出去了。 */
  win.webContents.setWindowOpenHandler(function () { return { action: 'deny' }; });
  win.webContents.on('will-navigate', function (e, url) {
    const target = String(url || '');
    if (target === RENDERER_URL || target.indexOf(RENDERER_URL + '#') === 0) return;
    e.preventDefault();
    logBoot('navigation blocked: ' + target.slice(0, 120));
  });

  win.loadFile(RENDERER_INDEX);

  if (DEV) win.webContents.openDevTools({ mode: 'detach' });

  win.webContents.on('before-input-event', function (_e, input) {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      win.webContents.toggleDevTools();
    }
  });
}

/* 托盘菜单：显示 / 隐藏、刷新、打开两个目录、检查更新、关于、退出。
 * 无边框窗口没有系统标题栏，托盘是唯一能把窗口叫回来或退掉的入口。 */
let tray = null;
function buildTray() {
  try {
    const icon = nativeImage.createFromBuffer(makeIconPng(16));
    tray = new Tray(icon);
    tray.setToolTip('VRChat 改模素材管理库');
    const toggle = function () {
      if (!win || win.isDestroyed()) return;
      if (win.isVisible() && !win.isMinimized()) win.hide();
      else { win.show(); if (win.isMinimized()) win.restore(); win.focus(); }
    };
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 / 隐藏窗口', click: toggle },
      { label: '刷新（F5）', click: function () { if (win && !win.isDestroyed()) win.webContents.reload(); } },
      { type: 'separator' },
      { label: '打开数据目录', click: function () { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {} shell.openPath(DATA_DIR); } },
      { label: '打开素材库目录', click: function () { try { fs.mkdirSync(LIBRARY_DIR, { recursive: true }); } catch (e) {} shell.openPath(LIBRARY_DIR); } },
      { type: 'separator' },
      {
        label: '检查更新',
        click: function () {
          if (!win || win.isDestroyed()) return;
          win.show(); win.focus();
          win.webContents.executeJavaScript("(typeof Updater !== 'undefined') && Updater.check()").catch(function () {});
        }
      },
      {
        label: '关于',
        click: function () {
          if (!win || win.isDestroyed()) return;
          dialog.showMessageBox(win, {
            type: 'info',
            title: '关于',
            message: 'VRChat 改模素材管理库 · Electron 版',
            detail: 'Electron ' + process.versions.electron + ' / Chromium ' + process.versions.chrome +
              '\n数据目录：' + DATA_DIR + '\n素材库目录：' + LIBRARY_DIR
          });
        }
      },
      { label: '退出', click: function () { app.quit(); } }
    ]));
    tray.on('double-click', toggle);
    tray.on('click', function () {
      if (!win || win.isDestroyed()) return;
      win.show(); if (win.isMinimized()) win.restore(); win.focus();
    });
    logBoot('tray created');
  } catch (e) {
    logBoot('tray failed: ' + ((e && e.message) || e));
  }
}

function setupProtocol() {
  /* 渲染层拼的是 http://vrcasset.localhost/<encoded 路径>，这个域名只在本进程内有意义：
   * 重定向到自定义协议再读磁盘。只拦这一个域名，真实网络请求仍走 Chromium 网络栈。 */
  const filter = { urls: ['http://vrcasset.localhost/*'] };
  session.defaultSession.webRequest.onBeforeRequest(filter, function (details, cb) {
    const tail = details.url.slice('http://vrcasset.localhost/'.length);
    cb({ redirectURL: 'vrcasset://asset/' + tail });
  });

  protocol.handle('vrcasset', async function (request) {
    try {
      const u = new URL(request.url);
      let rel = decodeURIComponent(u.pathname || '');
      if (rel.startsWith('/')) rel = rel.slice(1);
      if (!rel) return new Response('missing path', { status: 400 });
      const file = path.isAbsolute(rel) ? rel : path.resolve(APP_ROOT, rel);
      /* 缩略图跟着数据目录走，而数据目录可能在程序目录之外。用 path.relative 判边界，
       * 顺便挡住 G:\xxx-evil 这种同前缀的兄弟目录。 */
      const roots = [APP_ROOT];
      try {
        const p = bridge.appPaths();
        if (p && p.dataDir) roots.push(p.dataDir);
      } catch (e) {}
      const inside = roots.some(function (root) {
        const r = path.relative(path.resolve(root), path.resolve(file));
        return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
      });
      if (!inside) return new Response('forbidden', { status: 403 });
      const buf = await fsp.readFile(file);
      return new Response(buf, {
        status: 200,
        headers: { 'content-type': mimeOf(file), 'cache-control': 'no-cache' }
      });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  });
}

function setupIpc() {
  ipcMain.handle('host:call', async function (_e, arg) {
    return await bridge.call((arg && arg.api) || '', (arg && arg.payload) || {});
  });
  ipcMain.handle('host:readBytes', async function (_e, arg) {
    return await bridge.readBytes(arg || {});
  });
  ipcMain.handle('host:writeBytes', async function (_e, arg) {
    return await bridge.writeBytes((arg && arg.path) || '', (arg && arg.bytes) || new Uint8Array());
  });
  ipcMain.handle('thumb:ensure', async function (_e, arg) {
    return await bridge.thumb.ensure(arg || {});
  });
  ipcMain.handle('thumb:batch', async function (_e, arg) {
    return await bridge.thumb.batch(arg || {});
  });
  /* ---- P2P 分块二进制通道：不过 base64，字节原样进出 ----
   * 页面按 64KB 顺序写、一次预取几块，这里多加工一次就是多一份拷贝。 */
  ipcMain.handle('p2p:read', function (_e, arg) {
    return bridge.p2p.readBlock((arg && arg.session) || '', (arg && arg.block) || 0);
  });
  ipcMain.handle('p2p:write', function (_e, arg) {
    return bridge.p2p.writeBlock(
      (arg && arg.session) || '',
      (arg && arg.block) || 0,
      (arg && arg.bytes) || new Uint8Array()
    );
  });
  ipcMain.handle('app:paths', function () { return bridge.appPaths(); });
  ipcMain.handle('app:openExternal', function (_e, arg) {
    const u = String((arg && arg.url) || '');
    if (!/^https?:\/\//i.test(u)) return false;
    shell.openExternal(u);
    return true;
  });
  /* ---- 数据目录（体检 / 搬家 / 清理 / 切换）----
   * 搬家期间按 {phase,done,total,name} 推帧，页面（40-fs.js dataMigrate）转给进度窗。 */
  ipcMain.handle('data:data_scan', function (_e, arg) {
    return dataApi.scan((arg && arg.dir) || '');
  });
  ipcMain.handle('data:data_migrate', function (e, arg) {
    const jobId = String((arg && arg.jobId) || '');
    return dataApi.migrate({
      from: (arg && arg.from) || '',
      to: (arg && arg.to) || '',
      emit: function (frame) {
        if (!jobId) return;
        try { e.sender.send('data:migrate:' + jobId, frame); } catch (err) {}
      },
      /* 复制前必须关库：WAL 下库文件与 -wal 是两份，开着连接复制会拿到不一致的快照 */
      closeDb: function () { try { bridge.db.close(); } catch (err) {} }
    });
  });
  ipcMain.handle('data:data_cleanup', function (_e, arg) {
    return dataApi.cleanup((arg && arg.dir) || '');
  });
  ipcMain.handle('data:data_apply_root', function () {
    return applyDataRoot();
  });

  /* preload 每次加载同步问一次数据根：additionalArguments 在窗口创建时就固化了，
   * 改完数据位置再刷新，只有这里能给出新值。 */
  ipcMain.on('app:env', function (e) {
    e.returnValue = {
      appRoot: APP_ROOT,
      dataDir: DATA_DIR,
      settingsDir: SETTINGS_DIR,
      libraryDir: LIBRARY_DIR
    };
  });
  ipcMain.handle('win:action', function (_e, arg) {
    if (!win || win.isDestroyed()) return false;
    const a = String((arg && arg.action) || '');
    if (a === 'min') win.minimize();
    else if (a === 'max') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    /* show：最小化 / 被托盘藏起来之后，从界面侧也能把窗口叫回前台（max 不一定能解最小化） */
    else if (a === 'show') { win.show(); if (win.isMinimized()) win.restore(); win.focus(); }
    else if (a === 'close') win.close();
    return true;
  });
}

/* 切数据根：重读 settings.json，把主库、素材目录、边车全部指过去。
 * 调用前必须先把 settings.localDataDir 落盘（saveSettings 有防抖），否则这里读到旧值。 */
function applyDataRoot() {
  const prev = DATA_DIR;
  const next = resolveDataDir();
  DATA_DIR = next;
  try {
    const info = bridge.setDataDir(next);
    logBoot('data root -> ' + next);
    return { ok: true, dataDir: next, path: info && info.path, count: info && info.count };
  } catch (e) {
    /* 开不起来就退回旧根，别让应用停在「库已关闭」的状态 */
    DATA_DIR = prev;
    try { bridge.setDataDir(prev); } catch (e2) {}
    return { ok: false, error: '切换数据目录后打开主库失败：' + ((e && e.message) || e) };
  }
}

/* 单实例：第二次双击只把已有窗口拉到前面。必须早于 ready，
 * 否则两个实例会同时打开同一份 assets.json。 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(function () {
    bridge.init({
      appRoot: APP_ROOT,
      dataDir: DATA_DIR,
      settingsDir: SETTINGS_DIR,
      libraryDir: LIBRARY_DIR,
      getWin: function () { return win; }
    });
    setupProtocol();
    setupIpc();
    Menu.setApplicationMenu(null);
    createWindow();
    buildTray();
    logBoot('window created, renderer=' + RENDERER_INDEX);

    /* 上次导入没跑完就关窗，留下的临时解压目录在后台清掉；
     * 延后 1.5 秒，既不挡启动，也不让用户先看到一堆临时目录。 */
    setTimeout(function () {
      try {
        const r = dataApi.sweepOrphanExtracts(DATA_DIR);
        if (r.dirs > 0 || r.kept > 0) {
          logBoot('启动清理：删除 ' + r.dirs + ' 个临时解压目录，保留 ' + r.kept + ' 个等待 Unity 回执的目录');
        }
      } catch (e) {
        logBoot('sweep orphan extracts failed: ' + ((e && e.message) || e));
      }
    }, 1500);
  });

  app.on('window-all-closed', function () {
    logBoot('window-all-closed');
    if (process.platform !== 'darwin') app.quit();
  });

  /* 退出链路留痕（关窗 → before-quit → will-quit → quit → exit）：
   * 应用「开一下就没了」时，没有这几行就只能靠猜。 */
  app.on('before-quit', function () { quitting = true; logBoot('before-quit'); });
  app.on('will-quit', function () {
    logBoot('will-quit');
    /* 传一半的位图再刷一次（关窗那条路径可能被「导入忙」拦过，这里是最后机会） */
    try { bridge.p2p.flushAll(); } catch (e) {}
    try { bridge.p2p.sigStop(); } catch (e) {}
    /* 边车是独立进程，父进程退出不会带走它，必须显式收掉，否则下次启动会多一个僵尸。 */
    try { bridge.dispose(); } catch (e) { logBoot('dispose sidecar failed: ' + e.message); }
  });
  app.on('quit', function (_e, code) { logBoot('quit code=' + code); });
  process.on('exit', function (code) { logBoot('process exit ' + code); });
}
