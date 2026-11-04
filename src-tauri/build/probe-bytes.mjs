// 第五轮探针：原始字节通道（无 base64）+ 大文件写入 + 封面落盘 + 背包封面走路径
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
    console.log(`✓ ${note}\n   `, JSON.stringify(v).slice(0, 320));
    return v;
  }

  await ev(`FS.host.bytesSupported()`, '字节通道可用');
  await ev(`(async () => {
    const n = 3 * 1024 * 1024;                       // 3MB：旧版 base64 要膨胀 33%
    const u8 = new Uint8Array(n);
    for (let i = 0; i < n; i += 4096) u8[i] = i & 255;
    const t0 = performance.now();
    await FS.host.writeBytes('C:\\\\vrclib-selftest\\\\big.bin', u8);
    const back = await FS.host.readBytes('C:\\\\vrclib-selftest\\\\big.bin');
    return { wrote: n, read: back.length, same: back.length === n && back[0] === 0, ms: Math.round(performance.now() - t0) };
  })()`, '3MB 字节往返');

  await ev(`(async () => {
    const before = await FS.host.readText(App.localDir + '\\\\settings.json');
    App.settings.themeHint = 'probe-' + Date.now();
    await Store.local.saveSettings(App.settings);
    const after = await FS.host.readText(App.localDir + '\\\\settings.json');
    const j = JSON.parse(after);
    return { changed: before !== after, hasKey: !!j.settings.themeHint, bytes: after.length };
  })()`, 'settings.json 走字节写');

  await ev(`(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const g = c.getContext('2d'); g.fillStyle = '#e91e63'; g.fillRect(0,0,64,64);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const ok = await Store.local.saveCoverFile('probe_cover', blob, App.settings);
    const bytes = await FS.host.readBytes(App.localDir + '\\\\covers\\\\probe_cover.png');
    return { saved: ok, bytes: bytes.length, pngMagic: bytes[0] === 137 && bytes[1] === 80 };
  })()`, '封面 存盘 + 读回（PNG 魔数）');

  await ev(`(async () => {
    const dir = 'C:\\\\vrclib-selftest';
    const pack = dir + '\\\\cover-pack.vrcpack';
    const out = await FS.host.pack('export', {
      outPath: pack, withFiles: false, withCovers: true,
      entries: [{
        id: 'as_c', title: '封面测试', category: 'tools', source: 'other',
        files: [], coverPath: App.localDir + '\\\\covers\\\\probe_cover.png'
      }]
    });
    const info = await FS.host.pack('inspect', { path: pack });
    const a = info.manifest.assets[0];
    return { ok: out.ok, cover: a.cover, files: (a.files || []).length };
  })()`, '素材包封面走磁盘路径（无 base64）');

  await ev(`(async () => {
    const r = await fetch('http://vrcasset.localhost/' + encodeURIComponent(App.localDir + '\\\\covers\\\\probe_cover.png'));
    const b = await r.blob();
    return { status: r.status, type: b.type, size: b.size };
  })()`, '自定义协议读封面');

  console.log('\n--- 页面错误 ---');
  console.log(errors.length ? errors.slice(0, 10).join('\n') : '(无)');
  ws.close(); process.exit(0);
}
main().catch(e => { console.error('FAIL', e); process.exit(1); });
