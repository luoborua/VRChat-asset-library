// 运行时探针：连上 Electron 的 CDP，验证页面、数据目录与内置宿主是否真的工作
const PORT = 9222;

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && t.url.includes('VRChat'));
  if (!page) { console.log('NO_PAGE', JSON.stringify(list.map(t => t.url))); return; }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise(r => ws.addEventListener('open', r));

  const send = (method, params) => new Promise(res => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return { __error: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : null;
  };

  await send('Runtime.enable');
  await new Promise(r => setTimeout(r, 2500));

  const info = await evalJs(`(function(){
    var s = window.App && App.settings || {};
    return {
      href: location.href.split('/').pop(),
      readyState: document.readyState,
      appVersion: window.APP ? APP.version : 'no-APP',
      bootHidden: !!(document.getElementById('bootScreen') && document.getElementById('bootScreen').classList.contains('done')),
      assets: window.App ? App.assets.length : -1,
      cards: document.querySelectorAll('#grid .card').length,
      localDir: window.App ? App.localDir : '',
      libraryRoot: window.App ? App.libraryRoot() : '',
      hostAvail: !!(window.FS && FS.host.available()),
      hostBase: window.FS ? FS.host.base() : '',
      hostDesk: !!(window.FS && FS.host.desk && FS.host.desk()),
      pickPath: typeof (window.FS && FS.pickDirectoryPath),
      modules: ['Store','UI','Settings','Importer','AITranslate','DLQueue','Tools','Modal','Field'].filter(function(k){ return typeof window[k] === 'object' || typeof window[k] === 'function'; })
    };
  })()`);
  console.log('PAGE ' + JSON.stringify(info, null, 1));

  const host = await evalJs(`(async function(){
    try {
      var root = App.libraryRoot();
      var kind = await FS.host.exists(root);
      var txt = await FS.host.readText(root + '\\\\vrclib-data\\\\settings.json');
      var list = await FS.host.scan(root + '\\\\vrclib-data', 0);
      return { kind: kind, settingsLen: (txt||'').length, scanCount: (list||[]).length, sample: (list||[]).slice(0,5).map(function(e){return e.name+'/'+e.kind;}) };
    } catch (e) { return { error: String(e && e.message || e) }; }
  })()`);
  console.log('HOST ' + JSON.stringify(host, null, 1));

  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
