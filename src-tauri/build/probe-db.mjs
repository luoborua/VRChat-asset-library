// 第四轮探针：SQLite 主库（读取 / 增量写 / 重载持久化）
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
    console.log(`✓ ${note}\n   `, JSON.stringify(v).slice(0, 320));
    return v;
  }

  await ev('App.assets.length', '从 SQLite 读到的素材数');
  await ev('document.querySelectorAll(".card").length', '卡片数');
  await ev(`FS.host.db('info')`, '数据库信息');

  await ev(`(async () => {
    const before = App.assets[0].title;
    App.assets[0].title = before + '·增量测试';
    App.scheduleFileSync('assets');
    await new Promise(r => setTimeout(r, 1600));
    const r = await FS.host.db('save', { assets: App.assets, at: new Date().toISOString() });
    return { written: r.written, total: r.total, removed: r.removed };
  })()`, '改 1 条 → 只写 1 行');

  await send('Page.reload', { ignoreCache: true });
  await new Promise(r => setTimeout(r, 3500));
  await ev('App.assets[0] && App.assets[0].title', '重载后标题（应含增量测试）');
  await ev('App.assets.length', '重载后条数');

  await ev(`(async () => {
    App.assets[0].title = String(App.assets[0].title).replace('·增量测试','');
    await App.flushFileSync();
    return 'restored';
  })()`, '还原测试改动');

  console.log('\n--- 页面错误 ---');
  console.log(errors.length ? errors.slice(0, 10).join('\n') : '(无)');
  ws.close(); process.exit(0);
}
main().catch(e => { console.error('FAIL', e); process.exit(1); });
