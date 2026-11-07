/* 网络接口：apiFetch 一次取全，apiStream 把上游分块转成 SSE 帧（AI 翻译用）。
 * 与谁交互：bridge 的 /api/fetch 走 apiFetch，server.js 的 /api/stream 直接拿 res 写流。
 * 边界：只允许 http/https；不重试、不缓存，超时按请求与空闲分别计时。
 */

const DEFAULT_TIMEOUT = 30000;
const MIN_TIMEOUT = 5000;
const MAX_TIMEOUT = 300000;

function clampTimeout(ms) {
  const n = Number(ms);
  if (!n || Number.isNaN(n)) return DEFAULT_TIMEOUT;
  return Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, n));
}

function onlyHttp(url) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) throw new Error('仅支持 http/https URL');
  return u;
}

/** 一次性抓取：{ok, okFlag, status, text, headers} */
async function apiFetch(payload = {}) {
  const url = onlyHttp(payload.url);
  const method = String(payload.method || 'GET').toUpperCase();
  const timeout = clampTimeout(payload.timeoutMs);
  const headers = payload.headers || {};
  const init = { method, headers, redirect: 'follow' };
  if (payload.body != null && method !== 'GET' && method !== 'HEAD') init.body = payload.body;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), timeout);
  init.signal = ctrl.signal;
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    const outHeaders = {};
    res.headers.forEach((v, k) => { outHeaders[k] = v; });
    return { ok: true, okFlag: res.ok, status: res.status, text, headers: outHeaders, url: res.url };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SSE 转发：把上游分块写成 data: {...}\n\n
 * 帧格式与前端 40-fs.js 的 streamFetch 解析器严格对应。
 */
async function apiStream(payload, res, origin) {
  const url = onlyHttp(payload.url);
  const method = String(payload.method || 'GET').toUpperCase();
  const idle = clampTimeout(payload.timeoutMs);
  const headers = payload.headers || {};
  const init = { method, headers, redirect: 'follow' };
  if (payload.body != null && method !== 'GET' && method !== 'HEAD') init.body = payload.body;

  const head = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  };
  /* 只回显本程序来源：别的站点即使发得出请求，也读不到响应体 */
  if (origin) head['Access-Control-Allow-Origin'] = origin;
  res.writeHead(200, head);

  const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(new Error('请求超时（' + idle + 'ms 无数据）')), idle);
  init.signal = ctrl.signal;

  /* 页面关掉或刷新时中止上游请求，否则这里会一直读到空闲超时，替一个不存在的页面花流量。 */
  const onClose = () => { try { ctrl.abort(new Error('调用方已断开')); } catch (e) {} };
  res.on('close', onClose);

  try {
    const upstream = await fetch(url, init);
    send({ type: 'head', status: upstream.status, ok: upstream.ok });
    if (!upstream.body) { send({ type: 'error', error: '上游无响应体' }); res.end(); return; }

    const reader = upstream.body.getReader();
    const dec = new TextDecoder('utf-8');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (timer) { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(new Error('请求超时（' + idle + 'ms 无数据）')), idle); }
      const text = dec.decode(value, { stream: true });
      if (text) send({ type: 'chunk', text });
    }
    res.end();
  } catch (e) {
    try { send({ type: 'error', error: String((e && e.message) || e) }); } catch (e2) {}
    try { res.end(); } catch (e2) {}
  } finally {
    if (timer) clearTimeout(timer);
    res.removeListener('close', onClose);
  }
}

module.exports = { apiFetch, apiStream };
