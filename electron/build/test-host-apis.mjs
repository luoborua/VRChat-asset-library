// 接口回归：通过页面里的 FS.host.* 逐个验证内置宿主（跳过会弹窗的 pickDir / pickFiles）
const PORT = 9222;

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && t.url.includes('VRChat'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (method, params) => new Promise(res => {
    const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });

  const script = `(async function(){
    var base = App.libraryRoot() + '\\\\runtime\\\\_apitest';
    var out = {}; var R = [];
    async function t(name, fn){ try { var v = await fn(); R.push([name, 'ok', typeof v === 'object' ? JSON.stringify(v).slice(0,80) : String(v).slice(0,80)]); return v; } catch(e){ R.push([name, 'FAIL', String(e && e.message || e).slice(0,120)]); } }
    try { await FS.host.remove(base); } catch(e){}
    await t('mkdir', function(){ return FS.host.mkdir(base); });
    await t('writeFile', function(){ return FS.host.writeFile(base+'\\\\a.txt', btoa('hello-vrclib')); });
    await t('exists(file)', function(){ return FS.host.exists(base+'\\\\a.txt'); });
    await t('readText', function(){ return FS.host.readText(base+'\\\\a.txt'); });
    await t('readFileBase64', async function(){ var r = await FS.host.readFileBase64(base+'\\\\a.txt'); return atob(r.dataBase64 || r); });
    await t('copy', function(){ return FS.host.copy(base+'\\\\a.txt', base+'\\\\b.txt'); });
    await t('scan', async function(){ var e = await FS.host.scan(base, 0); return e.map(function(x){return x.name+'/'+x.kind;}).join(','); });
    await t('move', function(){ return FS.host.move(base+'\\\\b.txt', base+'\\\\c.txt'); });
    await t('delete', function(){ return FS.host.remove(base+'\\\\c.txt'); });
    await t('fetch', async function(){ var j = await FS.host.fetchURL('http://127.0.0.1:8788/api/health'); return 'okFlag='+j.okFlag+' status='+j.status+' len='+String(j.text||'').length; });
    await t('download', async function(){
      var dst = base+'\\\\dl.json';
      var res = await FS.host.download('http://127.0.0.1:8788/api/health', dst, {}, 'job_test1', true);
      return 'size='+(res && res.size);
    });
    await t('downloadProgress', async function(){ var p = await FS.host.downloadProgress('job_test1'); return 'received='+p.received+' total='+p.total; });
    await t('stream', async function(){
      var r = await FS.host.streamFetch('http://127.0.0.1:8788/api/health', {}, 'GET', null, {timeoutMs: 8000});
      return 'status='+r.status+' len='+String(r.text||'').length;
    });
    await t('cleanup', function(){ return FS.host.remove(base); });
    out.rows = R;
    return out;
  })()`;

  const r = await send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) {
    console.log('EXCEPTION ' + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description));
  } else {
    const rows = r.result.result.value.rows;
    let pass = 0;
    for (const [n, s, d] of rows) { console.log((s === 'ok' ? '  ✔ ' : '  ✘ ') + n.padEnd(18) + d); if (s === 'ok') pass++; }
    console.log(`\n${pass}/${rows.length} 通过`);
  }
  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
