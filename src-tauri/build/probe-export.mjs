/* 导出备份 / CSV 的「另存为」链路自检
 *
 * 为什么要单独一个脚本：v6.2 把导出从 <a download>（静默丢进系统下载文件夹）
 * 改成了原生「另存为」对话框 + 直接写盘。对话框是操作系统窗口，CDP 点不到，
 * 所以这里只负责「触发」和「收结果」，中间那个开窗/按键/取消的步骤交给
 * PowerShell 做（见 src-tauri/build/probe-export.ps1）。
 *
 * 用法：
 *   node probe-export.mjs trigger [--csv]    触发一次导出（不等待）
 *   node probe-export.mjs check              读回结果与 toast
 *
 * 端口用 VRC_PROBE_PORT，默认 9222。
 */
const PORT = Number(process.env.VRC_PROBE_PORT || 9222);
const mode = process.argv[2] || 'trigger';
const args = process.argv.slice(3);
const csv = args.includes('--csv');
const withCovers = args.includes('--with-covers');

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

function line(ok, name, val) {
  console.log((ok ? '✓ ' : '✗ ') + name + ' ' + JSON.stringify(val));
}

if (mode === 'trigger') {
  // 不 awaitPromise：对话框一开，promise 就悬在那里，等 PowerShell 去点
  if (csv) {
    await send('Runtime.evaluate', {
      expression: `(()=>{window.__expErr=null;window.__expDone=false;
        FS.downloadCSV(App.assets).then(r=>{window.__expDone=true;window.__expPath=r;})
          .catch(e=>{window.__expErr=String(e&&e.message||e);});return 'started';})()`,
      returnByValue: true
    });
    line(true, '已触发 CSV 导出', { 条目: 'App.assets' });
  } else {
    await send('Runtime.evaluate', {
      expression: `(()=>{window.__expErr=null;window.__expDone=false;
        FS.downloadJSON(${withCovers}).then(r=>{window.__expDone=true;window.__expPath=r?r.assets.length:0;})
          .catch(e=>{window.__expErr=String(e&&e.message||e);});return 'started';})()`,
      returnByValue: true
    });
    line(true, '已触发 JSON 导出', { 含封面: withCovers });
  }
  process.exit(0);
}

if (mode === 'check') {
  const r = await send('Runtime.evaluate', {
    expression: `({done:!!window.__expDone, err:window.__expErr||'', path:window.__expPath||'',
       toasts:[...document.querySelectorAll('.toast .toast-msg')].map(x=>x.textContent),
       errToast:[...document.querySelectorAll('.toast-err')].map(x=>x.textContent)})`,
    returnByValue: true
  });
  const v = r.result?.result?.value || {};
  line(!v.err, '无未捕获异常', v.err || '(无)');
  line(v.done, '导出 promise 已结束', v.done);
  line(v.toasts.length === 0 || !v.errToast.length, '无错误提示', v.errToast);
  console.log('--- toast 文本 ---');
  console.log(v.toasts.length ? v.toasts.map(t => '  ' + t.replace(/\n/g, '\n  ')).join('\n') : '  （无：说明是用户取消，符合预期）');
  process.exit(0);
}

console.error('未知模式：' + mode);
process.exit(1);
