// 第二轮探针：验证数据落盘闭环（示例数据 → 卡片渲染 → vrclib-data\assets.json → 重载后仍在）
const PORT = 9222;
async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errors = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push('EXC: ' + (d.exception && (d.exception.description || d.exception.value) || d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('CONSOLE: ' + m.params.args.map(a => a.value || a.description || '').join(' '));
    }
  });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');

  async function ev(expr, note) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result && r.result.exceptionDetails) {
      console.log(`✗ ${note}\n   `, String(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text).slice(0, 300));
      return null;
    }
    const v = r.result && r.result.result && r.result.result.value;
    console.log(`✓ ${note}\n   `, JSON.stringify(v).slice(0, 300));
    return v;
  }

  await ev(`(async () => {
    const btn = document.getElementById('emptyDemo') || document.getElementById('emptyAdd');
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 600));
    return { clicked: !!btn, assets: App.assets.length };
  })()`, '点击「载入示例数据」');

  await new Promise(r => setTimeout(r, 3000));
  await ev('App.assets.length', '内存素材数');
  await ev('document.querySelectorAll(".card").length', '网格卡片数');
  await ev('App.localDir', '数据目录');
  await ev(`(async () => { await App.flushFileSync(); return 'flushed'; })()`, '强制落盘');
  await new Promise(r => setTimeout(r, 800));
  await ev(`(async () => {
    const p = App.localDir + '\\\\assets.json';
    const k = await FS.host.exists(p);
    let n = 0, at = '';
    if (k === 'file') {
      const j = JSON.parse(await FS.host.readText(p));
      n = (j.assets || []).length; at = j.at || '';
    }
    return { exists: k, count: n, at: at };
  })()`, '磁盘上的 assets.json');

  await send('Page.reload', { ignoreCache: true });
  await new Promise(r => setTimeout(r, 3500));
  await ev('App.assets.length', '重载后素材数（应从磁盘恢复）');
  await ev('document.querySelectorAll(".card").length', '重载后卡片数');

  console.log('\n--- 页面错误 ---');
  console.log(errors.length ? errors.slice(0, 10).join('\n') : '(无)');
  ws.close(); process.exit(0);
}
main().catch(e => { console.error('FAIL', e); process.exit(1); });
