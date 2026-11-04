// 第七轮探针：交互冒烟（详情 / 编辑 / 设置 / 右键菜单 / 搜索 / 筛选）
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
  await send('Runtime.enable'); await send('Log.enable');
  async function ev(expr, note) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result && r.result.exceptionDetails) {
      console.log(`✗ ${note}\n   `, String(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text).slice(0, 260));
      return null;
    }
    const v = r.result && r.result.result && r.result.result.value;
    console.log(`✓ ${note}\n   `, JSON.stringify(v).slice(0, 260));
    return v;
  }

  await ev(`(async () => { const a = App.assets[0]; Modals.detail(a.id); await new Promise(r=>setTimeout(r,700));
    return { modal: (Modal.stack||[]).length, title: (document.querySelector('.modal-title')||{}).textContent, hasCover: !!document.querySelector('.detail-cover img') }; })()`, '打开详情页');

  await ev(`(async () => { const a = App.assets[0]; Modals.edit(a.id); await new Promise(r=>setTimeout(r,600));
    return { modals: (Modal.stack||[]).length, inputs: document.querySelectorAll('.modal input, .modal textarea').length }; })()`, '打开编辑表单');

  await ev(`(async () => { while ((Modal.stack||[]).length) Modal.closeTop(); await new Promise(r=>setTimeout(r,400)); return { modals:(Modal.stack||[]).length }; })()`, '关闭全部弹窗');

  await ev(`(async () => { Settings.open('library'); await new Promise(r=>setTimeout(r,700));
    return { modals:(Modal.stack||[]).length, tabs: document.querySelectorAll('.settings-tab').length, tab: (document.querySelector('.settings-tab.active')||{}).textContent }; })()`, '打开设置（本地库）');
  await ev(`(async () => { while ((Modal.stack||[]).length) Modal.closeTop(); await new Promise(r=>setTimeout(r,300)); return 'closed'; })()`, '关闭设置');

  await ev(`(async () => {
    const card = document.querySelector('.card');
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 300 }));
    await new Promise(r=>setTimeout(r,400));
    const items = document.querySelectorAll('.ctx-menu .ctx-item, .ctx-item');
    return { items: items.length, first: items[0] && items[0].textContent.slice(0, 12) };
  })()`, '右键菜单');

  await ev(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.click();
    await new Promise(r=>setTimeout(r,250));
    return { menuGone: !document.querySelector('.ctx-menu') };
  })()`, '关闭右键菜单');

  await ev(`(async () => {
    const q = document.getElementById('searchInput');
    q.value = '毛衣'; q.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r=>setTimeout(r,500));
    const n = document.querySelectorAll('.card').length;
    q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r=>setTimeout(r,500));
    return { filtered: n, restored: document.querySelectorAll('.card').length };
  })()`, '搜索过滤 / 清空');

  await ev(`(async () => {
    App.filters.status = 'downloaded'; UI.renderAll(); await new Promise(r=>setTimeout(r,400));
    const n = document.querySelectorAll('.card').length;
    App.filters.status = ''; UI.renderAll(); await new Promise(r=>setTimeout(r,400));
    return { filtered: n, restored: document.querySelectorAll('.card').length };
  })()`, '侧栏状态筛选');

  await ev(`(async () => {
    const before = document.body.getAttribute('data-theme');
    document.getElementById('btnTheme').click();
    await new Promise(r=>setTimeout(r,500));
    return { before: before, after: document.body.getAttribute('data-theme'), html: document.documentElement.getAttribute('data-theme') };
  })()`, '切换主题');

  await ev(`(async () => { document.getElementById('btnTheme').click(); await new Promise(r=>setTimeout(r,300)); return 'restored theme'; })()`, '主题还原');

  console.log('\n--- 页面错误 ---');
  console.log(errors.length ? errors.slice(0, 12).join('\n') : '(无)');
  ws.close(); process.exit(0);
}
main().catch(e => { console.error('FAIL', e); process.exit(1); });
