// 第三轮探针：自定义协议 + 原生拖拽桥（用 Tauri 事件模拟一次真实拖放）
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
      console.log(`✗ ${note}\n   `, String(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text).slice(0, 300));
      return null;
    }
    const v = r.result && r.result.result && r.result.result.value;
    console.log(`✓ ${note}\n   `, JSON.stringify(v).slice(0, 300));
    return v;
  }

  await ev(`(async () => {
    const r = await fetch('http://vrcasset.localhost/' + encodeURIComponent('C:\\\\vrclib-selftest\\\\t.txt'));
    return { status: r.status, text: (await r.text()).slice(0, 24) };
  })()`, 'vrcasset 读文本');

  await ev(`(async () => {
    const r = await fetch('http://vrcasset.localhost/' + encodeURIComponent('C:\\\\Windows\\\\win.ini'));
    return { blocked: r.status };
  })()`, 'vrcasset 拒绝非素材类型');

  // 模拟原生拖入：emit 一个 vrc://drag drop 事件，看页面是否走原有导入流程
  await ev(`(async () => {
    await window.__TAURI__.event.emit('vrc://drag', {
      kind: 'enter', paths: ['C:\\\\vrclib-selftest\\\\selftest.vrcpack'], x: 600, y: 400
    });
    await new Promise(r => setTimeout(r, 120));
    const overlay = document.body.classList.contains('dragging');
    const hint = document.body.getAttribute('data-drop-hint');
    return { overlay: overlay, hint: hint };
  })()`, '拖入 → 全屏提示层');

  await ev(`(async () => {
    await window.__TAURI__.event.emit('vrc://drag', {
      kind: 'drop', paths: ['C:\\\\vrclib-selftest\\\\selftest.vrcpack'], x: 600, y: 400
    });
    await new Promise(r => setTimeout(r, 1200));
    return { modals: (Modal.stack || []).length, title: document.querySelector('.modal-title') && document.querySelector('.modal-title').textContent };
  })()`, '松手 → 素材包预览弹窗');

  await ev(`(async () => {
    Modal.closeTop();
    return { modals: (Modal.stack || []).length };
  })()`, '关闭弹窗');

  console.log('\n--- 页面错误 ---');
  console.log(errors.length ? errors.slice(0, 10).join('\n') : '(无)');
  ws.close(); process.exit(0);
}
main().catch(e => { console.error('FAIL', e); process.exit(1); });
