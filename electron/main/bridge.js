/* 宿主桥：把渲染层 invoke 过来的命令名落到具体处理函数上。
 * 与谁交互：preload 经 IPC 调进来；/api/* 转给 host/ 下各模块，
 * /api/wb/* 转给 Rust 边车（sidecar.js），原始字节走独立的读写通道。
 * 边界：不实现业务 —— 这里只做路由与返回值整形，落盘、抓取、打包都在下游。
 */
const path = require('node:path');

const fsApi = require('./host/api-fs.js');
const guard = require('./host/guard.js');
const net = require('./host/api-net.js');
const dl = require('./host/api-download.js');
const picker = require('./host/api-picker.js');
const pack = require('./host/api-pack.js');
const db = require('./host/api-db.js');
const thumb = require('./host/api-thumb.js');
const p2p = require('./host/api-p2p.js');
const upd = require('./host/api-update.js');
const sidecar = require('./sidecar.js');

let CTX = { appRoot: '', dataDir: '', settingsDir: '', libraryDir: '', getWin: () => null };

function init(ctx) {
  CTX = Object.assign(CTX, ctx || {});
  db.init(CTX.dataDir);
  p2p.init({ dataDir: CTX.dataDir });
  sidecar.init({
    appRoot: CTX.appRoot,
    dataDir: CTX.dataDir,
    log: function (line) { console.log(line); }
  });
}

let busyUntil = 0;   // 导入忙租约的到期时间戳（0 = 不忙）

/* 工作台那批接口全部转给 Rust 边车，这里只登记名字。
 * 常量名看着像「未接通」，实际都通着，别被名字误导。 */
const NOT_YET_WB = [
  'probe', 'setImportBusy', 'quitNow', 'hash', 'plan', 'execute', 'importPath', 'importProgress',
  'projectStatus', 'inspectPath', 'listExtract', 'importSelected', 'discardExtract', 'listDir',
  'findUnity', 'launchUnity', 'logTail', 'receipt', 'allowOverwrite', 'installBridge'
];

function buildRoutes() {
  const r = {
    /* ---- 文件 ---- */
    '/api/exists': p => fsApi.exists(p),
    '/api/readText': p => fsApi.readText(p),
    '/api/readFileBase64': p => fsApi.readFileBase64(p),
    '/api/writeFile': p => fsApi.writeFile(p),
    '/api/mkdir': p => fsApi.mkdir(p),
    '/api/delete': p => fsApi.remove(p),
    '/api/move': p => fsApi.move(p),
    '/api/copy': p => fsApi.copy(p),
    '/api/open': p => fsApi.open(p),
    '/api/openUrl': p => {
      const { shell } = require('electron');
      const u = String((p && p.url) || '');
      if (!/^https?:\/\//i.test(u)) return { ok: false, error: '只允许 http/https 链接' };
      shell.openExternal(u);
      return { ok: true };
    },
    '/api/scan': p => fsApi.scan(p),

    /* ---- 选择器 ---- */
    '/api/pickDir': p => picker.pickDir(CTX.getWin(), p),
    '/api/pickFiles': p => picker.pickFiles(CTX.getWin(), p),
    '/api/saveFile': p => picker.saveFile(CTX.getWin(), p),
    '/api/pickOneFile': p => picker.pickOneFile(CTX.getWin(), p),

    /* ---- 网络 / 下载 ---- */
    '/api/fetch': p => net.apiFetch(p),
    '/api/download': p => dl.apiDownload(p),
    '/api/downloadProgress': p => dl.apiDownloadProgress(p),
    '/api/downloadCancel': p => dl.apiDownloadCancel(p || {}),

    /* ---- 素材包 ---- */
    '/api/pack/export': p => pack.packCreate(p || {}),
    '/api/pack/inspect': p => pack.packInspect(p || {}),
    '/api/pack/extract': p => pack.packExtract(p || {}),
    '/api/pack/progress': () => pack.getProgress(),
    '/api/pack/cancel': () => pack.requestCancel(),

    /* ---- 素材主库 ---- */
    '/api/db/load': () => db.load(),
    '/api/db/save': p => db.save(p || {}),
    '/api/db/info': () => db.info(),

    /* ---- P2P 传文件（磁盘侧 + 局域网信令，见 host/api-p2p.js）---- */
    '/api/p2p/prepare': p => p2p.prepare(p || {}),
    '/api/p2p/open': p => p2p.open(p || {}),
    '/api/p2p/finish': p => p2p.finish((p && p.sessionId) || ''),
    '/api/p2p/cancel': p => p2p.cancel((p && p.sessionId) || ''),
    '/api/p2p/status': p => p2p.status((p && p.sessionId) || ''),
    '/api/p2p/resumable': () => p2p.resumable(),
    '/api/p2p/signalStart': p => p2p.startSignal(p || {}),
    '/api/p2p/signalStop': () => p2p.sigStop(),
    '/api/p2p/signalStatus': () => p2p.sigStatus(),
    '/api/p2p/discover': () => p2p.discover(),

    /* ---- 自动更新（便携包覆盖安装，见 host/api-update.js）---- */
    '/api/update/info': () => upd.info(),
    '/api/update/apply': p => {
      /* 导入还在写盘时替换程序，退出会被拦、文件也可能写一半 —— 先挡住 */
      if (busyUntil > Date.now()) throw new Error('还有导入任务在跑，等它结束再更新');
      return upd.apply(p || {});
    },
    '/api/update/progress': () => upd.progress(),
    '/api/update/cancel': () => upd.cancel()
  };

  /* ---- 改模工作台：转给 Rust 边车 ---- */
  NOT_YET_WB.forEach(function (op) {
    r['/api/wb/' + op] = function (p) { return sidecar.callWb(op, p || {}); };
  });

  /* 导入忙的租约要在主进程留一份，关窗时靠它判断该不该拦。
   * 页面不再续租就自动失效，不会把窗口永久锁死。 */
  r['/api/wb/setImportBusy'] = async function (p) {
    const busy = !!(p && p.busy);
    const keep = Math.min(Math.max(Number((p && p.keepMs) || 120000), 5000), 1800000);
    busyUntil = busy ? Date.now() + keep : 0;
    return sidecar.callWb('setImportBusy', p || {});
  };

  /* 边车里的 quitNow 只能杀掉它自己，必须由主进程接着退应用，
   * 否则用户点「退出」只死一个后台进程。 */
  r['/api/wb/quitNow'] = async function (p) {
    let out = null;
    try { out = await sidecar.callWb('quitNow', p || {}); } catch (e) { out = { ok: true }; }
    busyUntil = 0;
    setTimeout(function () {
      try { require('electron').app.quit(); } catch (e) {}
    }, 150);
    return out || { ok: true };
  };

  return r;
}

let ROUTES = buildRoutes();

async function call(api, payload) {
  const fn = ROUTES[api];
  if (!fn) return { ok: false, error: 'unknown api: ' + api };
  try {
    const out = await fn(payload || {});
    if (out === undefined) return { ok: true };
    // 处理函数普遍已经带 ok 字段；没带的补一个
    if (out && typeof out === 'object' && out.ok === undefined) out.ok = true;
    return out;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---- 原始字节通道：不过 base64，字节原样进出 ---- */
async function readBytes(p) {
  const file = String((p && p.path) || '');
  if (!file) throw new Error('缺少 path');
  return await require('node:fs/promises').readFile(file);
}

async function writeBytes(file, u8) {
  const p = String(file || '');
  if (!p) throw new Error('缺少 path');
  guard.assertWritable(p);
  const buf = Buffer.from(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8));
  await require('node:fs/promises').mkdir(path.dirname(p), { recursive: true });
  await require('node:fs/promises').writeFile(p, buf);
  return { ok: true, size: buf.length };
}

function appPaths() {
  return {
    appRoot: CTX.appRoot,
    settingsDir: CTX.settingsDir,
    dataDir: CTX.dataDir,
    libraryDir: CTX.libraryDir
  };
}

/** 退出时收掉边车进程，别留孤儿（Windows 下父进程退出不会自动杀子进程）。 */
function dispose() { try { sidecar.dispose(); } catch (e) {} }

function isImportBusy() { return busyUntil > Date.now(); }

/**
 * 换数据根：主库、边车、上下文一起改，再按新路径重开库。
 * 边车是带着 --data-dir 启动的，不重启它会继续往旧目录写。
 */
function setDataDir(dir) {
  const next = String(dir || '').trim();
  if (!next) throw new Error('数据目录为空');
  CTX.dataDir = next;
  db.init(next);
  p2p.setDataDir(next);   /* 位图 / transfers 都挂在数据根下，跟着搬 */
  try { sidecar.dispose(); } catch (e) {}
  sidecar.init({
    appRoot: CTX.appRoot,
    dataDir: next,
    log: function (line) { console.log(line); }
  });
  const r = db.load();
  if (r && r.warning) throw new Error(r.warning);
  return r;
}

module.exports = {
  init, call, readBytes, writeBytes, appPaths, thumb, db, p2p, dispose, isImportBusy, setDataDir,
  ROUTES: () => ROUTES
};
