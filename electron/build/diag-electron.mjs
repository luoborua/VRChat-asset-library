// 诊断：监听 console / 未捕获异常，然后重载页面，输出启动期错误
const PORT = 9222;

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && t.url.includes('VRChat'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const events = [];

  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || []).map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' ');
      events.push('[console.' + m.params.type + '] ' + txt);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      events.push('[exception] ' + (d.exception && (d.exception.description || d.exception.value) || d.text));
    }
    if (m.method === 'Log.entryAdded') {
      events.push('[log.' + m.params.entry.level + '] ' + m.params.entry.text);
    }
  });
  await new Promise(r => ws.addEventListener('open', r));

  const send = (method, params) => new Promise(res => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise(r => setTimeout(r, 9000));

  const state = await evalJs(`(function(){
    var bs = document.getElementById('bootScreen');
    return {
      bootClass: bs ? bs.className : 'no-boot',
      bootText: bs ? bs.innerText.replace(/\\s+/g,' ').slice(0, 300) : '',
      booted: window.App ? !!App.booted : null,
      localReadOnly: window.App ? App.localReadOnly : null,
      localOffline: window.App ? App.localOffline : null,
      localDir: window.App ? App.localDir : '',
      rootPath: window.App ? App.settings.libraryRootPath : '',
      rootFn: window.App ? App.libraryRoot() : '',
      appBase: (function(){ try { return Store.htmlDir(); } catch(e){ return 'ERR:'+e.message; } })()
    };
  })()`);

  console.log('STATE ' + JSON.stringify(state, null, 1));
  console.log('EVENTS(' + events.length + ')');
  for (const e of events.slice(0, 40)) console.log('  ' + e.slice(0, 400));
  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
