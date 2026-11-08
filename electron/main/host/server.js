/* 内置宿主 HTTP 服务：接口名、请求体、返回体与渲染层期待的宿主一致，
 * 页面因此不必区分「本机服务」还是进程内实现。
 * 与谁交互：渲染层轮询端口后向 127.0.0.1 发 POST；handler 复用 host/ 下各 api-* 模块。
 * 边界：只听回环且要求访问令牌 —— 本机不等于只有本程序能访问；不做鉴权之外的业务判断。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
  exists, readText, readFileBase64, writeFile, mkdir, remove, trash, move, copy, open, scan
} = require('./api-fs.js');
const { apiFetch, apiStream } = require('./api-net.js');
const { apiDownload, apiDownloadProgress, apiDownloadCancel } = require('./api-download.js');
const { webdavTest, webdavList, webdavPut, webdavGet, webdavMkcol } = require('./api-webdav.js');
const { pickDir, pickFiles, saveFile, pickOneFile } = require('./api-picker.js');
const { packCreate, packInspect, packExtract, getProgress } = require('./api-pack.js');

/** 必须与 40-fs.js 里的 HOST_NAME 一字不差，否则页面会认为「这不是本宿主」而拒绝使用 */
const HOST_NAME = 'VRChat改模素材管理库 · 本地宿主（VRCLibHost）';
/** 报给页面的宿主版本：低于页面要求的版本会被判为不可用 */
const HOST_VERSION = '4.3.2';

const PORTS = [8788, 8789, 8790, 8791, 8792];
const BODY_LIMIT = 64 * 1024 * 1024;

/* ---------------- 访问控制 ----------------
 * 只听 127.0.0.1 不等于只有本程序能访问：任意网页都能发 POST 过来，读到响应就等于拿到磁盘读写权。
 * 真正的门禁是每次启动随机生成的 token（经 preload 只给本窗口），Origin / Host 校验挡 DNS rebinding。
 */
let ACCESS_TOKEN = '';

/** 未配置 token 时（例如被当模块单独跑测试）不启用校验，保持向后兼容 */
function tokenOk(req) {
  if (!ACCESS_TOKEN) return true;
  const got = String(req.headers['x-vrclib-token'] || '');
  return got.length === ACCESS_TOKEN.length && got === ACCESS_TOKEN;
}

/** Host 头必须是本机回环 —— DNS rebinding 攻击把 evil.com 解析到 127.0.0.1 时，
 *  Host 仍是 evil.com，这里直接拒掉。 */
function hostOk(req) {
  const h = String(req.headers.host || '');
  if (!h) return true;                       // HTTP/1.0 无 Host，本地工具可能这样发
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(h);
}

/** 允许的页面来源：本程序（Origin 缺失或 null）与本机 http 源 */
function originAllowed(origin) {
  if (!origin || origin === 'null') return true;
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(origin);
}

let logFile = '';
function setLogFile(p) {
  logFile = p;
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
}
function log(line) {
  const s = new Date().toTimeString().slice(0, 8) + '  ' + line + '\n';
  if (logFile) { try { fs.appendFileSync(logFile, s, 'utf8'); } catch {} }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error('请求体超过 64MB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, obj, status = 200, origin) {
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  };
  /* 只回显本程序自己的来源：别的站点即使能发请求，也读不到响应体 */
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  res.writeHead(status, headers);
  res.end(body);
}

/** 业务路由（全部 POST，除健康检查） */
function routes(getWindow) {
  const win = () => getWindow() || undefined;
  return {
    '/api/exists': p => exists(p),
    '/api/readText': p => readText(p),
    '/api/readFileBase64': p => readFileBase64(p),
    '/api/writeFile': p => writeFile(p),
    '/api/mkdir': p => mkdir(p),
    '/api/delete': p => remove(p),
    '/api/trash': p => trash(p),
    '/api/move': p => move(p),
    '/api/copy': p => copy(p),
    '/api/open': p => open(p),
    '/api/scan': p => scan(p),
    '/api/pickDir': p => pickDir(win(), p),
    '/api/pickFiles': p => pickFiles(win(), p),
    '/api/saveFile': p => saveFile(win(), p),
    '/api/pickOneFile': p => pickOneFile(win(), p),

    /* ---- 素材包（.vrcpack）：导出 / 查看 / 解包 ---- */
    '/api/pack/export': p => packCreate(p || {}),
    '/api/pack/inspect': p => packInspect(p || {}),
    '/api/pack/extract': p => packExtract(p || {}),
    '/api/pack/progress': () => getProgress(),
    '/api/fetch': p => apiFetch(p),
    '/api/download': p => apiDownload(p),
    '/api/downloadProgress': p => apiDownloadProgress(p),
    '/api/downloadCancel': p => apiDownloadCancel(p || {}),
    '/api/webdav/test': p => webdavTest(p),
    '/api/webdav/list': p => webdavList(p),
    '/api/webdav/put': p => webdavPut(p),
    '/api/webdav/get': p => webdavGet(p),
    '/api/webdav/mkcol': p => webdavMkcol(p)
  };
}

function createHostServer(getWindow, token) {
  ACCESS_TOKEN = String(token || '');
  const table = routes(getWindow);
  let port = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const api = url.pathname;
    const rawOrigin = req.headers.origin;
    const origin = originAllowed(rawOrigin) ? (rawOrigin || '') : '';

    if (!hostOk(req)) {
      return sendJson(res, { ok: false, error: '拒绝访问：Host 头不是本机回环' }, 403, '');
    }

    if (req.method === 'OPTIONS') {
      /* 预检不可能带自定义头，所以这里只校验来源；真正的门禁在下面按 token 判。
       * Access-Control-Allow-Headers 必须显式列出 X-VRCLib-Token，否则带 token 的请求会在预检阶段被浏览器拦掉。 */
      if (!origin) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('forbidden origin');
      }
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-VRCLib-Token',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin'
      });
      return res.end();
    }

    if (api === '/api/health') {
      // 健康检查不带 token：页面靠它做端口发现，此时还不知道自己在跟谁说话。
      // 但它只回固定的几项信息，不碰文件系统。
      return sendJson(res, { ok: true, name: HOST_NAME, version: HOST_VERSION, port }, 200, origin);
    }

    if (!tokenOk(req)) {
      log('DENY ' + api + '  token 不匹配  origin=' + String(rawOrigin || '-'));
      return sendJson(res, { ok: false, error: '未授权的调用（缺少或错误的访问令牌）' }, 403, origin);
    }

    if (api === '/api/stream') {
      try {
        const payload = await readBody(req);
        log('/api/stream → ' + String(payload.url || '').slice(0, 80));
        return await apiStream(payload, res, origin);
      } catch (e) {
        return sendJson(res, { ok: false, error: String(e.message || e) }, 400, origin);
      }
    }

    const handler = table[api];
    if (!handler) return sendJson(res, { ok: false, error: 'unknown api: ' + api }, 404, origin);

    let payload = {};
    try {
      payload = await readBody(req);
      const started = Date.now();
      const out = await handler(payload);
      const ms = Date.now() - started;
      // 全量记录：请求量本来就低（一次操作几条），排查「谁把设置写成默认值」这类问题全靠它
      log(api + ' ' + (out && out.ok === false ? (out.cancelled ? 'cancel' : 'FAIL') : 'ok') + ' ' + ms + 'ms'
        + (payload && payload.path ? '  ' + String(payload.path).slice(-70) : ''));
      return sendJson(res, out, 200, origin);
    } catch (e) {
      log(api + ' FAIL ' + String(e.message || e) + (payload && payload.path ? '  ' + String(payload.path).slice(-70) : ''));
      return sendJson(res, { ok: false, error: String((e && e.message) || e) }, 200, origin);
    }
  });

  function listenOn(p) {
    return new Promise((resolve, reject) => {
      const onError = err => { server.removeListener('listening', onOk); reject(err); };
      const onOk = () => { server.removeListener('error', onError); port = p; resolve(p); };
      server.once('error', onError);
      server.once('listening', onOk);
      server.listen(p, '127.0.0.1');
    });
  }

  return {
    async start() {
      for (const p of PORTS) {
        try {
          const got = await listenOn(p);
          log('宿主已启动 http://127.0.0.1:' + got + '/api  (v' + HOST_VERSION + ')');
          return got;
        } catch (e) {
          if (e && e.code === 'EADDRINUSE') continue;
          throw e;
        }
      }
      throw new Error('8788~8792 端口全部被占用，无法启动内置宿主');
    },
    stop() {
      return new Promise(resolve => server.close(() => resolve()));
    },
    get port() { return port; }
  };
}

module.exports = { setLogFile, createHostServer, HOST_NAME, HOST_VERSION };
