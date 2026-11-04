/* 「缓存比文件新」死循环的验证
 *
 * 症状：每次开机都弹「检测到浏览器缓存比 … 里的数据更新，已按缓存为准并回写文件」。
 * 根因：判定条件成立时只弹了 toast，没有真正触发落盘 → 库里的 at 永远停在旧值
 *       → 下次启动的 cacheAt 又比它新 → 再弹一次。
 *
 * 修法：判定成立时设置 App.needSyncAfterBoot，启动链在 reload 完成后补写一次。
 *
 * 用法（VRC_PROBE_PORT 指定调试端口）：
 *   node probe-datasync.mjs           开机现场快照 + 等回写后的复核
 */
const PORT = Number(process.env.VRC_PROBE_PORT || 9222);

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
  if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.text || ''));
  return r.result?.result?.value;
}

const snap = `(async()=>{
  const db = await FS.host.db('load');
  const cached = await Store.allAssets();
  let cacheAt = 0;
  cached.forEach(x => { const t = Date.parse(x.updatedAt || '') || 0; if (t > cacheAt) cacheAt = t; });
  const fileAt = Date.parse(db.at || '') || 0;
  return {
    dbAt: db.at || '(空)',
    dbCount: db.count,
    cacheCount: cached.length,
    cacheAt: cacheAt ? new Date(cacheAt).toISOString() : '(空)',
    cacheAtMs: cacheAt,
    fileAtMs: fileAt,
    diffSec: Math.round((cacheAt - fileAt) / 1000),
    needSyncFlag: !!App.needSyncAfterBoot,
    cacheNewerToast: [...document.querySelectorAll('.toast')]
      .some(t => /缓存比.*更新/.test(t.textContent || ''))
  };
})()`;

const t0 = Date.now();
const before = await ev(snap);
console.log('=== 开机现场 ===');
console.log('  库里 at        :', before.dbAt);
console.log('  缓存里最新时间 :', before.cacheAt);
console.log('  两者相差       :', before.diffSec, '秒');
console.log('  判定标记       :', before.needSyncFlag);
console.log('  本次弹了提示   :', before.cacheNewerToast);
console.log('  条数 库/缓存   :', before.dbCount, '/', before.cacheCount);

// 回写是 1.2 秒防抖 + 写盘，留足时间
await new Promise(r => setTimeout(r, 4200));

const after = await ev(snap);
console.log('');
console.log('=== 回写之后 ===');
console.log('  库里 at        :', after.dbAt);
console.log('  缓存里最新时间 :', after.cacheAt);
console.log('  两者相差       :', after.diffSec, '秒');
console.log('  条数 库/缓存   :', after.dbCount, '/', after.cacheCount);

let fails = 0;
const check = (ok, name, extra) => {
  if (!ok) fails++;
  console.log((ok ? '✓ ' : '✗ ') + name + (extra === undefined ? '' : ' ' + JSON.stringify(extra)));
};

console.log('');
check(after.fileAtMs > before.fileAtMs, '库里的 at 确实前进了（回写真的发生）',
  { 之前: before.dbAt, 现在: after.dbAt });
check(after.diffSec <= 2, '回写后缓存不再领先文件（下次开机不会再弹）',
  { 相差秒: after.diffSec });
check(after.dbCount === after.cacheCount, '回写后条数一致（没有丢/多数据）',
  { 库: after.dbCount, 缓存: after.cacheCount });
check(after.dbCount === before.dbCount, '回写没有改变素材条数',
  { 之前: before.dbCount, 现在: after.dbCount });

console.log('');
console.log(fails === 0 ? '本次运行已自愈；重启一次应不再提示' : fails + ' 项未通过');
process.exit(fails === 0 ? 0 : 1);
