// Tauri 版运行时探针：连 WebView2 的 CDP，直接执行页面里的真实调用
const PORT = 9222;

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url)) || list.find(t => t.type === 'page');
  if (!page) { console.log('NO_PAGE'); return; }
  console.log('URL:', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
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
  const send = (method, params = {}) => new Promise(res => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise(r => setTimeout(r, 3500));

  async function ev(expr, note) {
    const r = await send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true, userGesture: true
    });
    const res = r.result && r.result.result;
    if (r.result && r.result.exceptionDetails) {
      console.log(`✗ ${note || expr}\n   `, JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text).slice(0, 400));
      return null;
    }
    console.log(`✓ ${note || expr}\n   `, JSON.stringify(res && res.value).slice(0, 400));
    return res && res.value;
  }

  await ev('window.vrcElectron && window.vrcElectron.shell', 'shell 标识');
  await ev('window.vrcElectron && window.vrcElectron.appRoot', 'appRoot');
  await ev('typeof window.__TAURI__', '__TAURI__');
  await ev('typeof FS + "/" + typeof App + "/" + typeof UI', '模块就绪');
  await ev('App && App.assets ? App.assets.length : -1', '素材条数');

  await ev(`FS.host.ensure().then(function(ok){ return 'ensure=' + ok + ' desk=' + FS.host.desk(); })`, '宿主探测');

  await ev(`(async () => {
    const root = 'C:\\\\vrclib-selftest';
    await FS.host.mkdir(root);
    const txt = '你好 vrclib ' + Date.now();
    const b64 = btoa(unescape(encodeURIComponent(txt)));
    await FS.host.writeFile(root + '\\\\t.txt', b64);
    const back = await FS.host.readText(root + '\\\\t.txt');
    return { same: back === txt, len: back.length };
  })()`, '写盘 → 读回（UTF-8 往返）');

  await ev(`(async () => {
    const r = await FS.host.scan('C:\\\\vrclib-selftest', 0);
    return { entries: r.length, first: r[0] && r[0].name };
  })()`, '目录扫描');

  await ev(`(async () => {
    const kind = await FS.host.stat('C:\\\\vrclib-selftest\\\\t.txt');
    const missing = await FS.host.exists('C:\\\\vrclib-selftest\\\\nope.txt');
    return { kind: kind.kind, size: kind.size, missing: missing };
  })()`, 'stat / missing');

  await ev(`(async () => {
    const dir = 'C:\\\\vrclib-selftest';
    const pack = dir + '\\\\selftest.vrcpack';
    const out = await FS.host.pack('export', {
      outPath: pack, withFiles: true, withCovers: false,
      exporter: { deviceId: 'probe', nickname: '自检' },
      entries: [{
        id: 'as_probe', title: '自检素材', category: 'tools', source: 'other',
        files: [{ path: dir + '\\\\t.txt', rel: 't.txt' }]
      }]
    });
    const info = await FS.host.pack('inspect', { path: pack });
    const ex = await FS.host.pack('extract', { path: pack, destRoot: dir + '\\\\out' });
    return { count: out.count, pkg: out.packageBytes, assets: info.manifest.assets.length, extracted: ex.assets[0].files.length };
  })()`, '素材包 导出→查看→解包');

  await ev(`(async () => {
    const r = await fetch('http://vrcasset.localhost/' + encodeURIComponent('C:\\\\vrclib-selftest\\\\t.txt'));
    return { status: r.status, text: (await r.text()).slice(0, 20) };
  })()`, 'vrcasset 自定义协议');

  await ev(`UI.renderAll(), document.querySelectorAll('.card').length`, '重渲染卡片数');

  console.log('\n--- 页面错误 ---');
  console.log(errors.length ? errors.slice(0, 12).join('\n') : '(无)');
  ws.close();
  process.exit(0);
}
main().catch(e => { console.error('PROBE_FAIL', e); process.exit(1); });
