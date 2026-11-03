/* Electron 主进程：窗口 / 托盘 / 快捷键 / 内置宿主生命周期
 *
 * 设计要点（与 3.x 的 WebView2 壳保持一致，但宿主从 exe 搬进主进程）：
 *   1. 渲染层仍是同一份页面（根目录 HTML + electron/renderer 下的模块），**不做任何前端专有改造**；
 *   2. 主进程在 127.0.0.1:8788~8792 起一个与 VRCLibHost 同契约的 HTTP 服务，
 *      页面用原有的 hostProbe 就能发现它，URL 探测、字段、错误语义全部沿用；
 *   3. 数据仍在 <应用目录>\vrclib-data（页面按 location 推导，所以入口 HTML 必须留在根目录）。 */
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { createHostServer, setLogFile, HOST_VERSION } = require('./host/server.js');
const { makeIconPng } = require('./icon.js');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ENTRY_HTML = path.join(APP_ROOT, 'VRChat改模素材管理库.html');
const DATA_DIR = path.join(APP_ROOT, 'vrclib-data');
const RUNTIME_DIR = path.join(APP_ROOT, 'runtime');
const LOG_FILE = path.join(RUNTIME_DIR, 'electron-host.log');

/* v4.3.2：宿主访问令牌。每次启动随机生成，只在本次进程内有效；
 * 只通过 additionalArguments 交给本窗口的 preload，网页拿不到（见 host/server.js 的访问控制）。 */
const HOST_TOKEN = crypto.randomBytes(24).toString('hex');

/* v4.4：隐藏系统标题栏，只保留系统画的窗口按钮（− □ ×）。
 * 好处：顶部只剩应用自己的一条顶栏，颜色由页面主题决定；
 * 代价：页面必须自己留出右上角按钮区（styles.css 的 .topbar 右侧 padding），并加拖动区。
 * TITLEBAR_H 必须等于 CSS 里的 --topbar-h（58），否则系统按钮会与顶栏内容错位。 */
const TITLEBAR_H = 58;
const TITLEBAR_DARK = { color: '#14171d', symbolColor: '#a3abbb' };
const TITLEBAR_LIGHT = { color: '#ffffff', symbolColor: '#5b6579' };

let win = null;
let tray = null;
let host = null;
let quitting = false;

/* v4.4：页面切主题时上报标题栏配色（只接受颜色字符串，不开放任何能力） */
ipcMain.on('titlebar:colors', function (_event, opt) {
  if (!win || win.isDestroyed()) return;
  var color = String((opt && opt.color) || '') || TITLEBAR_DARK.color;
  var symbol = String((opt && opt.symbolColor) || '') || TITLEBAR_DARK.symbolColor;
  try { win.setTitleBarOverlay({ color: color, symbolColor: symbol, height: TITLEBAR_H }); } catch (e) {}
  try { win.setBackgroundColor(color); } catch (e) {}
});

/* v4.9：页面自绘窗口按钮（最小化 / 最大化 / 关闭）。只认这三个固定动作，不开放其它能力。 */
ipcMain.on('win:action', function (_event, action) {
  if (!win || win.isDestroyed()) return;
  if (action === 'min') win.minimize();
  else if (action === 'max') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  else if (action === 'close') win.close();
});

const iconImage = () => nativeImage.createFromBuffer(makeIconPng(32));

function logBoot(line) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.appendFileSync(path.join(RUNTIME_DIR, 'electron-boot.log'),
      new Date().toTimeString().slice(0, 8) + '  ' + line + '\n', 'utf8');
  } catch {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 920,
    minWidth: 1160,   // v5.2：940 太窄，顶栏「设置」等按钮会被裁掉
    minHeight: 620,
    show: false,
    backgroundColor: '#0e1014',
    title: 'VRChat 改模素材管理库 · v1.1',
    icon: iconImage(),
    autoHideMenuBar: true,
    /* v4.4：不要系统标题栏，只保留系统窗口按钮（覆盖层）。颜色随后由页面主题同步过来。 */
    titleBarStyle: 'hidden',
    /* v4.9：关掉系统窗口按钮覆盖层（那块不透明矩形和顶栏渐变对不上，像脏遮罩）。改由页面自绘 .win-controls。 */
    titleBarOverlay: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
      // 把访问令牌交给本窗口的 preload（渲染进程 process.argv 可见，页面 JS 不可见）
      additionalArguments: ['--vrclib-token=' + HOST_TOKEN],
      // 允许 file:// 页面访问 127.0.0.1 上的宿主（与原 WebView2 版行为一致）
      webSecurity: true
    }
  });

  win.setMenuBarVisibility(false);

/* v4.9：最大化状态回传，页面按钮在 □ / ❐ 间切换 */
['maximize', 'unmaximize'].forEach(function (ev) {
  win.on(ev, function () { try { win.webContents.send('win:state', win.isMaximized()); } catch (e) {} });
});

  win.once('ready-to-show', () => {
    win.show();
    logBoot('WINDOW shown');
  });

  win.webContents.on('did-finish-load', () => {
    logBoot('NAV_DONE ' + win.webContents.getURL());
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    logBoot('RENDER_GONE ' + JSON.stringify(details));
  });

  /* v4.3.2：页面里的 window.open / target=_blank 一律交给系统浏览器，
   * 不要在应用内再开一个裸 Electron 窗口（没有菜单、没有地址栏，用户会以为程序坏了）。 */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 快捷键：与 3.x 桌面版保持一致（供前端 postMessage 的 F5/F11 也照旧走这里）
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const k = input.key;
    if (k === 'F5') { event.preventDefault(); win.reload(); }
    else if (k === 'F11') { event.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
    else if (k === 'Escape' && win.isFullScreen()) { win.setFullScreen(false); }
    else if (input.control && input.shift && (k === 'I' || k === 'i')) { event.preventDefault(); win.webContents.toggleDevTools(); }
    else if (input.control && (k === 'o' || k === 'O')) { event.preventDefault(); openDataDir(); }
  });

  win.on('close', e => {
    if (!quitting) {
      // 与原桌面版一致：关闭窗口即退出（不做最小化到托盘）
      quitting = true;
    }
  });

  win.loadFile(ENTRY_HTML);
}

function openDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  shell.openPath(DATA_DIR);
}

function openLibraryDir() {
  const p = path.join(APP_ROOT, '本地素材库');
  fs.mkdirSync(p, { recursive: true });
  shell.openPath(p);
}

function buildTray() {
  tray = new Tray(iconImage());
  tray.setToolTip('VRChat 改模素材管理库');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏窗口', click: () => { if (!win) return; win.isVisible() ? win.hide() : win.show(); } },
    { label: '刷新（F5）', click: () => win && win.reload() },
    { type: 'separator' },
    { label: '打开数据目录（Ctrl+O）', click: openDataDir },
    { label: '打开素材库目录', click: openLibraryDir },
    { type: 'separator' },
    {
      label: '重连宿主',
      click: async () => {
        if (!host) return;
        await host.stop().catch(() => {});
        try { await host.start(); } catch (e) { dialog.showErrorBox('宿主重启失败', String(e.message || e)); }
        win && win.reload();
      }
    },
    {
      label: '检查更新',
      click: () => {
        if (!win) return;
        win.show();
        win.focus();
        win.webContents.executeJavaScript('(typeof Updater !== "undefined") && Updater.check()').catch(() => {});
      }
    },
    { label: '开发者工具（Ctrl+Shift+I）', click: () => win && win.webContents.toggleDevTools() },
    { type: 'separator' },
    {
      label: '关于',
      click: () => dialog.showMessageBox(win, {
        type: 'info',
        title: '关于',
        message: 'VRChat 改模素材管理库 · Electron 版',
        detail: '版本 ' + app.getVersion() + '\n内置宿主 v' + HOST_VERSION + '（接口与 VRCLibHost 一致）\n数据目录：' + DATA_DIR,
        buttons: ['好']
      })
    },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => { if (win) { win.isVisible() ? win.hide() : win.show(); } });
}

async function boot() {
  if (!fs.existsSync(ENTRY_HTML)) {
    dialog.showErrorBox('找不到主程序页面', '缺少文件：\n' + ENTRY_HTML);
    app.quit();
    return;
  }
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  setLogFile(LOG_FILE);
  logBoot('BOOT app=' + APP_ROOT + ' html=' + ENTRY_HTML);

  host = createHostServer(() => win, HOST_TOKEN);
  let port = 0;
  try {
    port = await host.start();
    logBoot('HOST ok port=' + port);
  } catch (e) {
    // 端口全占用不是致命错误：页面可能连上外部 VRCLibHost，但要明确告诉用户
    logBoot('HOST FAIL ' + String(e.message || e));
    dialog.showMessageBox({
      type: 'warning',
      title: '内置宿主未启动',
      message: '8788~8792 全部被占用，内置宿主未能启动。',
      detail: '页面仍可打开，但联网抓取 / 下载 / 写盘会受限。请关闭占用端口的程序后重试。',
      buttons: ['继续', '退出']
    }).then(r => { if (r.response === 1) { quitting = true; app.quit(); } });
  }

  createWindow();
  buildTray();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });

  app.whenReady().then(boot);

  app.on('window-all-closed', () => { quitting = true; app.quit(); });

  app.on('before-quit', async () => {
    quitting = true;
    if (host) await host.stop().catch(() => {});
  });
}
