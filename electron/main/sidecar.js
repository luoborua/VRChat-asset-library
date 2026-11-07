/* 边车客户端：把 /api/wb/* 转发给 vrclib-host.exe（独立的 Rust 宿主进程）。
 * 与谁交互：bridge.js 调 callWb；子进程走 stdio 行分隔 JSON，id 自增配对，乱序也能对上。
 * 请求 {"id":n,"api":…,"payload":…}，响应 {"id":n,"ok":…,"value"|"error"}。
 * 进程懒启动，崩溃或被杀后下一次调用自动重启；参数缺失或 exe 不存在时报明确错误。
 * 边界：不做业务判断，只负责进程生命周期与请求/响应配对。
 */
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

/* 工作台里最慢的操作是整包复制，正常也到不了 5 分钟；超过就当边车卡死。 */
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_LINE = 8 * 1024 * 1024;

let CTX = { appRoot: '', dataDir: '', log: function () {} };
let child = null;
let ready = false;
let bootError = null;
let seq = 0;
const pending = new Map();

function exePath() {
  /* 两个位置都找：仓库内的构建产物，以及打包后放在 resources/host/ 的副本。 */
  const candidates = [
    path.join(CTX.appRoot, 'host-sidecar', 'target', 'release', 'vrclib-host.exe'),
    path.join(CTX.appRoot, 'host-sidecar', 'target', 'debug', 'vrclib-host.exe'),
    path.join(CTX.appRoot, 'host', 'vrclib-host.exe'),
    path.join(process.resourcesPath || '', 'host', 'vrclib-host.exe')
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch (e) {}
  }
  return '';
}

function init(ctx) {
  CTX = Object.assign(CTX, ctx || {});
}

function ensure() {
  if (child && ready) return child;
  if (child) return child;          // 正在启动
  bootError = null;
  const exe = exePath();
  if (!exe) {
    bootError = '找不到 Rust 边车（vrclib-host.exe）。开发环境请先在 host-sidecar/ 下执行 ' +
                'cargo build --release；打包版请确认 host/vrclib-host.exe 随包分发。';
    return null;
  }
  try {
    child = spawn(exe, ['--data-dir=' + CTX.dataDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (e) {
    bootError = '启动 Rust 边车失败：' + (e && e.message);
    child = null;
    return null;
  }

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', function (chunk) {
    buf += chunk;
    /* 边车若吐出一条没有换行的超长输出，缓冲会无上限增长；超了直接丢弃这一行。 */
    if (buf.length > MAX_LINE) {
      CTX.log('[sidecar] 单行输出超过 ' + MAX_LINE + ' 字节，已丢弃');
      buf = '';
      return;
    }
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      const id = msg.id;
      /* 心跳的响应没有 id，直接忽略 */
      if (id === undefined || id === null) { ready = true; continue; }
      const p = pending.get(id);
      if (!p) continue;
      pending.delete(id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error || '边车返回失败'));
    }
  });

  /* 进程被杀时写 stdin 会异步发 EPIPE，不接住就会冒到 uncaughtException。 */
  child.stdin.on('error', function (e) {
    CTX.log('[sidecar] stdin 写入失败：' + (e && e.message));
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', function (d) {
    CTX.log('[sidecar] ' + String(d).trim().slice(0, 300));
  });

  child.on('error', function (e) {
    bootError = 'Rust 边车进程错误：' + (e && e.message);
    for (const [, p] of pending) p.reject(new Error(bootError));
    pending.clear();
    child = null;
    ready = false;
  });

  child.on('exit', function (code, signal) {
    CTX.log('[sidecar] 退出 code=' + code + ' signal=' + signal);
    for (const [, p] of pending) p.reject(new Error('Rust 边车已退出（code=' + code + '）'));
    pending.clear();
    child = null;
    ready = false;
  });

  /* 等待第一行输出再放行会拖慢首个请求，这里直接标记就绪：写入是同步排队的，
   * 进程没起来时 write 会进管道缓冲，起来后照常处理。 */
  ready = true;
  return child;
}

function request(api, payload, timeoutMs) {
  const proc = ensure();
  if (!proc) return Promise.reject(new Error(bootError || 'Rust 边车不可用'));
  const id = ++seq;
  return new Promise(function (resolve, reject) {
    /* 没有超时的话，边车崩溃/被 dispose 的那次调用会让调用方永久 await。 */
    const timer = setTimeout(function () {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error('Rust 边车无响应（' + (api || '') + '），可能已崩溃，重试或重启程序'));
    }, timeoutMs || REQUEST_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    pending.set(id, {
      resolve: function (v) { clearTimeout(timer); resolve(v); },
      reject: function (e) { clearTimeout(timer); reject(e); }
    });
    try {
      proc.stdin.write(JSON.stringify({ id: id, api: api, payload: payload || {} }) + '\n');
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error('写入边车失败：' + (e && e.message)));
    }
  });
}

/** /api/wb/* 全部走这里；名字与工作台路由表一致。 */
function callWb(op, payload) {
  return request('/api/wb/' + op, payload);
}

function dispose() {
  const msg = 'Rust 边车已重启，本次请求作废';
  for (const [, p] of pending) p.reject(new Error(msg));
  pending.clear();
  try { if (child) child.stdin.end(); } catch (e) {}
  try { if (child) child.kill(); } catch (e) {}
  child = null;
  ready = false;
}

module.exports = { init, callWb, dispose, exePath: exePath, _request: request };
