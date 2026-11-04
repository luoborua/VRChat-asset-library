// 第六轮探针：缩略图管线（生成 / 网格命中 / 详情用原图 / 回退）
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
    console.log(`✓ ${note}\n   `, JSON.stringify(v).slice(0, 340));
    return v;
  }

  await ev(`(async () => {
    // 造一张 1600x1200 的“大封面”，走真实封面保存路径
    const c = document.createElement('canvas'); c.width = 1600; c.height = 1200;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0,0,1600,1200); grd.addColorStop(0,'#5b8cff'); grd.addColorStop(1,'#ff7ab6');
    g.fillStyle = grd; g.fillRect(0,0,1600,1200);
    g.fillStyle = '#fff'; g.font = 'bold 120px sans-serif'; g.fillText('VRC', 80, 640);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const ok = await Store.local.saveCoverFile('probe_big', blob, App.settings);
    await new Promise(r => setTimeout(r, 800));
    const thumb = await FS.host.exists(App.localDir + '\\\\covers\\\\thumb\\\\probe_big.jpg');
    const orig  = await FS.host.exists(App.localDir + '\\\\covers\\\\probe_big.png');
    const tSize = thumb === 'file' ? (await FS.host.stat(App.localDir + '\\\\covers\\\\thumb\\\\probe_big.jpg')).size : 0;
    const oSize = (await FS.host.stat(App.localDir + '\\\\covers\\\\probe_big.png')).size;
    return { saved: ok, thumb: thumb, thumbBytes: tSize, orig: orig, origBytes: oSize, shrink: (oSize/Math.max(tSize,1)).toFixed(1) + 'x' };
  })()`, '大封面 → 自动生成缩略图');

  await ev(`(async () => {
    // 直接验 Rust 侧尺寸
    const r = await FS.host.thumb(App.localDir + '\\\\covers\\\\probe_big.png', App.localDir + '\\\\covers\\\\thumb\\\\probe_big2.jpg', 400);
    return { w: r.width, h: r.height, srcW: r.srcWidth, srcH: r.srcHeight, bytes: r.size };
  })()`, '缩略图尺寸（应为 400 宽）');

  await ev(`(async () => {
    // 给第一条素材挂上这张封面，看网格是否走缩略图
    const a = App.assets[0];
    a.hasCover = true; delete App._thumbMissing[a.id];
    const blob = await (await fetch('http://vrcasset.localhost/' + encodeURIComponent(App.localDir + '\\\\covers\\\\probe_big.png'))).blob();
    await Store.putCover(a.id, blob);
    await Store.local.saveCoverFile(a.id, blob, App.settings);
    await new Promise(r => setTimeout(r, 900));
    await App.save(a);
    UI.renderAll();
    await new Promise(r => setTimeout(r, 900));
    const card = document.querySelector('.card[data-id="' + a.id + '"] img.cover-img');
    return { src: card ? card.src : '(无图)', usesThumb: !!(card && card.src.indexOf('/covers/thumb/') >= 0), id: a.id };
  })()`, '网格卡片使用缩略图');

  await ev(`(async () => {
    const a = App.assets[0];
    const url = await App.coverURLFor(a);
    return { isBlob: String(url).slice(0, 5) === 'blob:', thumbUrl: App.thumbURLFor(a).slice(0, 60) };
  })()`, '详情页仍拿原图（blob）');

  console.log('\n--- 页面错误 ---');
  console.log(errors.length ? errors.slice(0, 10).join('\n') : '(无)');
  ws.close(); process.exit(0);
}
main().catch(e => { console.error('FAIL', e); process.exit(1); });
