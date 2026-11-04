/* 导出链路自检（不依赖系统对话框）
 *
 * v6.2 把导出改成了「原生另存为 + 直接写盘」。对话框是操作系统窗口，
 * CDP 点不到，本机安全策略又禁了 Add-Type / COM 的键鼠模拟，
 * 所以这里改成在页面里临时替换 Host.saveFile 来接管对话框这一步：
 *   · 模拟「用户取消」 → 应静默，无 toast、无异常
 *   · 模拟「用户选了某路径」→ 应真的把字节写到该路径，并 toast 出路径
 *   · 记录调用参数 → 验证 title / defaultPath / filters 传得对不对
 * 唯一没覆盖的是 rfd 组件本身能否弹窗，而它与素材包导出用的是同一个命令。
 *
 * 用法：VRC_PROBE_PORT=9222 node probe-export.mjs verify
 */
const PORT = Number(process.env.VRC_PROBE_PORT || 9222);
const OUT_DIR = process.argv[3] || 'C:\\vrclib-export-test';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page) { console.error('找不到页面'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
await new Promise(r => ws.addEventListener('open', r));
const send = (method, params = {}) => new Promise(res => {
  const mid = ++id; pend.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
await send('Runtime.enable');

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    throw new Error(String(r.result.exceptionDetails.text || JSON.stringify(r.result.exceptionDetails)));
  }
  return r.result?.result?.value;
}

const out = (s) => console.log(s);
const json = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
let fails = 0;
function check(ok, name, extra) {
  if (!ok) fails++;
  out((ok ? '✓ ' : '✗ ') + name + (extra === undefined ? '' : ' ' + JSON.stringify(extra)));
}

// 清掉可能残留的 toast，避免误判
await ev(`(()=>{document.querySelectorAll('.toast').forEach(t=>t.remove());return 1;})()`);

/* ---------- 1. 用户取消：应静默 ---------- */
const cancelRun = await ev(`(async()=>{
  window.__calls = [];
  const orig = FS.host.saveFile;
  FS.host.saveFile = function (p) { window.__calls.push(p); return Promise.resolve({ ok: false, cancelled: true }); };
  document.querySelectorAll('.toast').forEach(t=>t.remove());
  let threw = '';
  try { await FS.downloadJSON(true); } catch (e) { threw = String(e && e.message || e); }
  FS.host.saveFile = orig;
  await new Promise(r => setTimeout(r, 350));
  return { threw: threw, call: window.__calls[0] || null,
           toasts: [...document.querySelectorAll('.toast .toast-msg')].map(x=>x.textContent) };
})()`);
check(cancelRun.threw === '', '取消不抛异常', cancelRun.threw || '(无)');
check(cancelRun.toasts.length === 0, '取消时不弹任何提示', cancelRun.toasts);
check(!!cancelRun.call, '确实调用了原生另存为', cancelRun.call && cancelRun.call.title);
check(/\.json$/i.test((cancelRun.call || {}).defaultPath || ''), '默认文件名是 .json',
  (cancelRun.call || {}).defaultPath);
check(Array.isArray((cancelRun.call || {}).filters) && cancelRun.call.filters.length > 0,
  '带了文件类型过滤器', (cancelRun.call || {}).filters);

/* ---------- 2. 用户选路径：应真写盘 ---------- */
// 记下目录里原有的文件，事后清理
const targetJson = OUT_DIR + '\\probe-backup.json';
const targetCsv = OUT_DIR + '\\probe-list.csv';

const saveRun = await ev(`(async()=>{
  const orig = FS.host.saveFile;
  FS.host.saveFile = function () { return Promise.resolve({ ok: true, path: '${json(targetJson)}' }); };
  document.querySelectorAll('.toast').forEach(t=>t.remove());
  let threw = '', payload = null;
  try { payload = await FS.downloadJSON(true); } catch (e) { threw = String(e && e.message || e); }
  FS.host.saveFile = orig;
  await new Promise(r => setTimeout(r, 500));
  return { threw: threw, assets: payload && payload.assets ? payload.assets.length : 0,
           toasts: [...document.querySelectorAll('.toast .toast-msg')].map(x=>x.textContent) };
})()`);
check(saveRun.threw === '', '保存不抛异常', saveRun.threw || '(无)');
check(saveRun.toasts.some(t => /保存到/.test(t)), '提示里带出了保存路径', saveRun.toasts.map(t => t.split('\n')[1] || t));
check(saveRun.toasts.every(t => !/失败/.test(t)), '没有失败提示', saveRun.toasts);

// 读回磁盘上的文件确认
const back = await ev(`(async()=>{
  const p = '${json(targetJson)}';
  try {
    const txt = await FS.host.readText(p);
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    return { exists: true, len: txt.length, isJson: !!j,
             assets: j && j.assets ? j.assets.length : -1,
             covers: j && j.covers ? Object.keys(j.covers).length : -1,
             hasCreds: !!(j && j.settings && j.settings.credentials) };
  } catch (e) { return { exists: false, err: String(e && e.message || e) }; }
})()`);
check(back.exists, '备份文件已落盘', back.err || targetJson);
check(back.isJson, '内容是合法 JSON', back.len ? back.len + ' 字符' : '');
check(back.assets === saveRun.assets, '条数与内存一致', { 文件: back.assets, 内存: saveRun.assets });
check(back.hasCreds === false, '凭证未写进备份', back.hasCreds);

/* ---------- 3. CSV 走同一套 ---------- */
const csvRun = await ev(`(async()=>{
  const orig = FS.host.saveFile;
  FS.host.saveFile = function () { return Promise.resolve({ ok: true, path: '${json(targetCsv)}' }); };
  document.querySelectorAll('.toast').forEach(t=>t.remove());
  let threw = '';
  try { await FS.downloadCSV(App.assets); } catch (e) { threw = String(e && e.message || e); }
  FS.host.saveFile = orig;
  await new Promise(r => setTimeout(r, 500));
  return { threw: threw, toasts: [...document.querySelectorAll('.toast .toast-msg')].map(x=>x.textContent) };
})()`);
check(csvRun.threw === '', 'CSV 导出不抛异常', csvRun.threw || '(无)');
check(csvRun.toasts.some(t => /保存到/.test(t)), 'CSV 提示带出路径', csvRun.toasts.map(t => t.split('\n')[1] || t));

const csvBack = await ev(`(async()=>{
  try { const t = await FS.host.readText('${json(targetCsv)}');
        return { exists: true, len: t.length, bom: t.charCodeAt(0) === 0xFEFF, lines: t.split(/\\r?\\n/).length };
  } catch (e) { return { exists: false, err: String(e && e.message || e) }; }
})()`);
check(csvBack.exists, 'CSV 已落盘', csvBack.err || targetCsv);
check(csvBack.bom, 'CSV 保留 BOM（Excel 中文不乱码）', csvBack.len ? csvBack.len + ' 字符' : '');

out('');
out(fails === 0 ? '全部通过' : fails + ' 项未通过');
process.exit(fails === 0 ? 0 : 1);
