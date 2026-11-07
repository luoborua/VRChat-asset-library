/*
 * 92-p2p.js  —  点对点传文件（WebRTC DataChannel）
 *
 * 负责：建连、交换 SDP/ICE、推块收块，以及传输面板与对话框。
 * 与谁交互：清单 / 分块读写 / 位图走 FS.host.p2p，信令是局域网 WS，素材摊平复用 Packer。
 * 边界：不碰磁盘落地细节，也不做中继 —— 打洞失败直接报错，流量不经过第三方。
 * 流程：host 出清单建房拿 6 位口令，guest 输口令进房，确认后从对端缺的第一块开始推；
 *      断线用同一口令重连，位图决定从哪块续。
 */

var P2P = (function () {
  'use strict';

  var ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32：去掉 I L O U
  var CODE_LEN = 6;                                  // 30 bit ≈ 10.7 亿种
  var HIGH_WATER = 4 * 1024 * 1024;                 // DataChannel 发送队列硬上限 16 MiB，留足余量
  var PREFETCH = 8;                                  // 预读块数：够填满管道，又不至于吃内存
  var SAMPLE_MS = 400;

  /* 这次传输是不是「顺手把本机信令服务起来」的：是的话收尾要自己关掉，
     手动在设置里开的常驻服务不归这里管。 */
  var signalAuto = false;

  /* 公开 STUN。打洞失败就直接报错，不回落中继 —— 这是产品选择：
   * 中继要按流量付费，而且会让「P2P」名不副实。 */
  var ICE = [
    { urls: 'stun:stun.qq.com:3478' },
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' }
  ];

  var S = {
    state: 'idle',      // idle | hosting | joining | linking | confirming | sending | receiving | done | failed
    role: '',           // send | recv
    code: '',
    ws: null,
    base: '',           // 本次连接用的信令地址（发起方＝本机，接收方＝自动发现到的那台）
    pc: null,
    dc: null,
    sendSession: null,  // prepare 的返回
    recvSession: null,  // open 的返回
    items: null,        // host 侧原始勾选，重连时要重新 prepare
    dstRoot: '',
    peer: null,
    expect: 0,          // guest：下一块的块号
    sent: 0,            // host：已发出的块数
    received: 0,
    total: 0,
    blocks: 0,
    speed: 0,
    error: '',
    lastAt: 0,
    lastBytes: 0,
    startedAt: 0
  };

  var listeners = [];
  function emit() {
    var snap = snapshot();
    listeners.forEach(function (f) { try { f(snap); } catch (e) {} });
  }
  function onChange(f) {
    listeners.push(f);
    return function () {
      var i = listeners.indexOf(f);
      if (i >= 0) listeners.splice(i, 1);
    };
  }
  function snapshot() {
    var mw = S.manifestWire || {};
    var files = (mw.files && mw.files.length) || 0;
    var first = files ? String(mw.files[0].rel || '').split('/')[0] : '';
    return {
      state: S.state, role: S.role, code: S.code, error: S.error,
      peer: S.peer, received: S.received, total: S.total, blocks: S.blocks,
      sent: S.sent, speed: S.speed, startedAt: S.startedAt,
      blockSize: mw.blockSize || 65536,
      dstRoot: S.dstRoot,
      files: files,
      name: first ? (files > 1 ? first + ' 等 ' + files + ' 项' : first) : '',
      /* 发送方没有「已收字节」，进度按已发块数算；接收方按字节算。 */
      pct: S.role === 'send'
        ? (S.blocks ? Math.min(100, S.sent / S.blocks * 100) : 0)
        : (S.total > 0 ? Math.min(100, S.received / S.total * 100) : 0)
    };
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function sz(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  /** 口令：用 crypto 而不是 Math.random —— 口令即房间号，可枚举就等于没有确认环节 */
  function newCode(n) {
    var buf = new Uint8Array(n || CODE_LEN);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    var s = '';
    for (var i = 0; i < buf.length; i++) s += ALPHABET[buf[i] & 31];
    return s;
  }
  /** 用户输入容错：小写、空格、把 O 打成 0、把 I/L 打成 1 */
  function normCode(v) {
    return String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
      .replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  }

  /** 发起方：本机信令没跑就自动起来，省得用户先去设置里点一下 */
  async function ensureLocalSignal() {
    var st = await FS.host.p2p('signalStatus', {});
    if (st && st.running && st.self) {
      S.base = st.self;
      return st.self;
    }
    var r = await FS.host.p2p('signalStart', {});
    /* 记一笔：这次信令是为本次传输顺手起来的，用完自己收掉，
       别在后台白占端口等到空闲超时；手动在设置里开的常驻服务不归这里管。 */
    signalAuto = true;
    S.base = r.self;
    return r.self;
  }

  /** 传输结束 / 放弃时收掉「顺手起来」的信令服务 */
  function stopSignalIfAuto() {
    if (!signalAuto) return;
    signalAuto = false;
    try {
      FS.host.p2p('signalStop', {}).then(function () {
        if (typeof App !== 'undefined' && App.settings) {
          App.settings.p2pSignalAuto = false;
          if (App.saveSettings) App.saveSettings();
        }
      }).catch(function () {});
    } catch (e) {}
  }

  /** 接收方：在局域网里喊一声，谁开着信令服务谁应答。地址只用于这一次连接，不写进设置。 */
  async function findSignal() {
    var r = await FS.host.p2p('discover', {});
    if (!r || !r.found || !r.url) {
      var nets = (r && r.networks) || [];
      var extra = nets.length
        ? '（本机网段：' + nets.map(function (n) { return n.ip + '/' + n.prefix; }).join('、') + '）'
        : '';
      throw new Error('没找到局域网里的好友：让对方先点「传给好友」把服务开起来；两边要连同一个 WiFi，或同一个虚拟局域网（Radmin / ZeroTier 这类）' + extra);
    }
    S.base = r.url;
    return r.url;
  }

  /* 等对端期间盯着信令服务：后端空闲 15 分钟会自动关，界面要立刻告诉用户重新分享 */
  var idleTimer = null;
  function setState(s) {
    S.state = s;
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    if (s === 'hosting') {
      idleTimer = setInterval(function () {
        FS.host.p2p('signalStatus', {}).then(function (st) {
          if (S.state !== 'hosting') return;
          if (st && st.running === false) {
            fail('信令服务已因 15 分钟没有传输自动关闭，请重新点「传给好友」分享');
          }
        }).catch(function () {});
      }, 60000);
    }
    emit();
  }
  function fail(msg) {
    if (S.state === 'failed') return;   // 掉线时 ws.onclose / pc.onconnectionstatechange 会连着报，只留第一条
    if (S.state === 'idle') return;     // 已经取消/收尾了，迟到的回调不该再把状态翻成「失败」
    S.error = String(msg || '未知错误');
    S.state = 'failed';
    closeLink();
    emit();
  }

  /* ---------------- 信令 ---------------- */

  function wsUrl(code, role) {
    var base = S.base;
    if (!base) throw new Error('信令地址还没准备好，重试一次');
    var u = base.replace(/^http/, 'ws');
    return u + '/room/' + encodeURIComponent(code) + '?role=' + role;
  }

  function openSignal(code, role) {
    return new Promise(function (res, rej) {
      var url;
      try { url = wsUrl(code, role); } catch (e) { return rej(e); }
      var ws;
      try { ws = new WebSocket(url); } catch (e) { return rej(new Error('信令地址无效：' + url)); }
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; try { ws.close(); } catch (e) {} rej(new Error('连不上信令服务器')); }
      }, 8000);
      ws.onopen = function () {
        if (settled) return;
        settled = true; clearTimeout(timer); res(ws);
      };
      ws.onerror = function () {
        if (settled) return;
        settled = true; clearTimeout(timer); rej(new Error('信令服务器拒绝连接'));
      };
      ws.onclose = function (ev) {
        if (!settled) {
          settled = true; clearTimeout(timer);
          rej(new Error(ev && ev.code === 4004 ? '房间不存在' : '信令连接已断开'));
          return;
        }
        /* 传输中的意外掉线：不立刻判死，交给重连按钮处理 */
        if (S.state === 'sending' || S.state === 'receiving' || S.state === 'confirming') {
          fail('与对方的连接中断');
        }
      };
    });
  }

  function send(msg) {
    try {
      if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg));
    } catch (e) {}
  }

  function bindSignal(ws) {
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      onSignal(m).catch(function (e) { fail(e && e.message || e); });
    };
  }

  async function onSignal(m) {
    switch (m.t) {
      case 'peer-joined':
        if (S.role === 'send') await makeOffer();
        break;
      case 'peer-left':
        if (S.state !== 'done') fail('对方已离开');
        break;
      case 'sdp':
        await onSdp(m.payload);
        break;
      case 'ice':
        await addIce(m.payload);
        break;
      case 'hello':
        S.peer = m.payload;
        emit();
        break;
      case 'manifest':
        S.pendingManifest = m.payload;
        await askConfirm(m.payload);
        break;
      case 'ready':
        await beginSend(m.payload);
        break;
      case 'accept':
        S.dstRoot = m.payload && m.payload.dstRoot || '';
        break;
      case 'reject':
        fail(m.payload && m.payload.reason || '对方拒绝了本次传输');
        break;
      case 'done':
        await finishRecv();
        break;
      case 'bye':
        if (S.state !== 'done') fail('对方已断开');
        break;
    }
  }

  /* ---------------- WebRTC ---------------- */

  /** 是否还处在「这次传输真的在跑」的阶段：cancel / 关窗时是我们主动关 pc 与 dc，
   *  它们的 onclose 晚一步回来，那时不该再判成失败。 */
  function active() {
    var st = S.state;
    return st === 'hosting' || st === 'joining' || st === 'linking' ||
           st === 'confirming' || st === 'sending' || st === 'receiving';
  }

  function newPC() {
    var pc = new RTCPeerConnection({ iceServers: ICE });
    pc.onicecandidate = function (e) {
      if (e.candidate) send({ t: 'ice', payload: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed') {
        /* 打洞没成功或中途断了。这里只报错，不自动重试：用户需要先确认对方还在。 */
        if (active()) fail('无法建立直连（双方网络可能都不支持打洞）');
      }
    };
    return pc;
  }

  async function makeOffer() {
    if (!S.pc) return;
    setState('linking');
    var offer = await S.pc.createOffer();
    await S.pc.setLocalDescription(offer);
    send({ t: 'sdp', payload: { type: offer.type, sdp: offer.sdp } });
  }

  var iceQueue = [];
  async function addIce(c) {
    if (!S.pc) return;
    if (!S.pc.remoteDescription || !S.pc.remoteDescription.type) { iceQueue.push(c); return; }
    try { await S.pc.addIceCandidate(c); } catch (e) {}
  }
  async function flushIce() {
    var q = iceQueue; iceQueue = [];
    for (var i = 0; i < q.length; i++) {
      try { await S.pc.addIceCandidate(q[i]); } catch (e) {}
    }
  }

  async function onSdp(p) {
    if (!p || !p.sdp) return;
    if (!S.pc) {
      /* guest 侧：收到 offer 才建 PC，ondatachannel 在 setRemote 之前挂好 */
      S.pc = newPC();
      S.pc.ondatachannel = function (e) { attachChannel(e.channel); };
    }
    await S.pc.setRemoteDescription({ type: p.type, sdp: p.sdp });
    await flushIce();
    if (p.type === 'offer') {
      setState('linking');
      var ans = await S.pc.createAnswer();
      await S.pc.setLocalDescription(ans);
      send({ t: 'sdp', payload: { type: ans.type, sdp: ans.sdp } });
    }
  }

  function attachChannel(dc) {
    S.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 1 << 20;
    dc.onopen = function () { onChannelOpen(); };
    dc.onclose = function () {
      if (active()) fail('传输通道已关闭');
    };
    dc.onmessage = function (ev) { onData(ev.data); };
  }

  function onChannelOpen() {
    if (S.role === 'send') {
      /* 先把清单发过去，对端据此弹确认框 */
      send({ t: 'manifest', payload: S.manifestWire });
      setState('confirming');
    } else {
      setState('confirming');
    }
  }

  /* ---------------- host：发起 ---------------- */

  /** items: [{ abs, rel }]，由素材多选那边构造 */
  async function startSend(items) {
    if (S.state !== 'idle' && S.state !== 'done' && S.state !== 'failed') {
      throw new Error('已经有一个传输在进行');
    }
    closeLink();
    reset();
    S.role = 'send';
    S.items = items;
    var prep = await FS.host.p2p('prepare', { items: items });
    S.sendSession = prep;
    S.manifestWire = {
      sessionId: prep.sessionId, total: prep.total, blocks: prep.blocks,
      blockSize: prep.blockSize, files: prep.files
    };
    S.total = prep.total;
    S.blocks = prep.blocks;
    S.code = newCode(CODE_LEN);
    S.startedAt = Date.now();

    await ensureLocalSignal();
    S.ws = await openSignal(S.code, 'host');
    bindSignal(S.ws);
    S.pc = newPC();
    var dc = S.pc.createDataChannel('file', { ordered: true });
    attachChannel(dc);

    setState('hosting');
    return { code: S.code, total: prep.total, fileCount: prep.files.length };
  }

  async function beginSend(payload) {
    var from = (payload && payload.from) | 0;
    S.sent = from;
    setState('sending');
    S.startedAt = S.startedAt || Date.now();
    S.lastAt = Date.now();
    S.lastBytes = from * (S.manifestWire.blockSize || 65536);
    try {
      await pumpSend(from);
      send({ t: 'done' });
      S.state = 'done';
      S.speed = 0;
      emit();
      stopSignalIfAuto();   // 发完了就把顺手起来的信令收掉
    } catch (e) {
      fail(e && e.message || e);
    }
  }

  function drain(dc) {
    if (dc.bufferedAmount < HIGH_WATER) return Promise.resolve();
    return new Promise(function (r) {
      var done = false;
      var h = function () {
        if (done) return;
        done = true;
        dc.removeEventListener('bufferedamountlow', h);
        r();
      };
      dc.addEventListener('bufferedamountlow', h);
      setTimeout(h, 200);
    });
  }

  var tickPort = null;
  function tick() {
    if (!tickPort) {
      var mc = new MessageChannel();
      tickPort = { p1: mc.port1, p2: mc.port2, q: [] };
      mc.port1.onmessage = function () { var f = tickPort.q.shift(); if (f) f(); };
    }
    return new Promise(function (r) { tickPort.q.push(r); tickPort.p2.send(0); });
  }

  async function pumpSend(from) {
    var total = S.blocks;
    var next = from;
    var queue = [];
    var handle = S.sendSession.handle;
    var dc = S.dc;
    var live = true;

    var producing = (async function () {
      while (next < total && live && S.state === 'sending') {
        if (queue.length >= PREFETCH) { await sleep(2); continue; }
        var i = next++;
        try {
          var buf = await FS.host.p2pRead(handle, i);
          queue.push(buf);
        } catch (e) {
          live = false;
          throw e;
        }
      }
    })();

    var sent = from;
    while (sent < total && live && S.state === 'sending') {
      if (!queue.length) {
        if (dc.readyState !== 'open') throw new Error('通道已断开');
        await sleep(1);
        continue;
      }
      if (dc.bufferedAmount >= HIGH_WATER) { await drain(dc); continue; }
      var data = queue.shift();
      try {
        dc.send(data);
      } catch (e) {
        queue.unshift(data);
        await drain(dc);
        continue;
      }
      sent++;
      S.sent = sent;
      sample(sent * (S.manifestWire.blockSize || 65536));
      if ((sent & 31) === 0) await tick();
    }
    await producing.catch(function () {});
    if (sent < total && S.state === 'sending') throw new Error('发送提前中止（已发 ' + sent + '/' + total + ' 块）');
  }

  /* ---------------- guest：加入 ---------------- */

  async function join(code, dstRoot, base) {
    if (S.state !== 'idle' && S.state !== 'done' && S.state !== 'failed') {
      throw new Error('已经有一个传输在进行');
    }
    closeLink();
    reset();
    S.role = 'recv';
    S.code = normCode(code);
    S.dstRoot = dstRoot;
    if (!S.code || S.code.length !== CODE_LEN) throw new Error('口令是 6 位，检查一下');
    S.pc = newPC();
    S.pc.ondatachannel = function (e) { attachChannel(e.channel); };
    /* 手动填了地址就直接用，否则去局域网里找：UDP 广播常被防火墙吃掉
       （尤其第一次运行没勾「专用网络」），手动地址是那情况下的唯一出路。 */
    var manual = String(base || '').trim().replace(/^http/i, 'ws');
    if (manual) S.base = manual.replace(/\/+$/, '');
    else await findSignal();
    S.ws = await openSignal(S.code, 'guest');
    bindSignal(S.ws);
    setState('joining');
    return { code: S.code };
  }

  async function askConfirm(manifest) {
    S.pendingManifest = manifest;
    S.manifestWire = manifest;
    S.total = manifest.total;
    S.blocks = manifest.blocks;
    setState('confirming');
    var ok = await P2PUI.confirm(snapshot());
    if (!ok) {
      send({ t: 'reject', payload: { reason: '对方取消了接收' } });
      S.state = 'failed';
      S.error = '你取消了接收';
      closeLink();
      emit();
      return;
    }
    var opened = await FS.host.p2p('open', { manifest: manifest, dstRoot: S.dstRoot });
    S.recvSession = opened;
    S.expect = opened.nextBlock || 0;
    S.received = opened.received || 0;
    send({ t: 'ready', payload: { from: S.expect, dstRoot: S.dstRoot } });
    setState('receiving');
    S.startedAt = Date.now();
    S.lastAt = Date.now();
    S.lastBytes = S.received;
  }

  var writeChain = Promise.resolve();
  var writeErr = null;
  function onData(buf) {
    if (S.state !== 'receiving') return;
    var block = S.expect++;
    writeChain = writeChain.then(function () {
      if (writeErr) return;
      return FS.host.p2pWrite(S.recvSession.handle, block, buf).then(function (r) {
        S.received = r.received;
        sample(S.received);
        if (S.blocks > 0 && block === S.blocks - 1) emit();
      }).catch(function (e) {
        writeErr = e;
        fail(e && e.message || e);
      });
    });
  }

  async function finishRecv() {
    try {
      await writeChain;
      if (writeErr) return;
      var r = await FS.host.p2p('finish', { sessionId: S.recvSession.handle });
      S.state = 'done';
      S.received = S.total;
      S.speed = 0;
      emit();
      stopSignalIfAuto();   // 传完了就把顺手起来的信令收掉
      if (typeof Toast !== 'undefined' && Toast.ok) Toast.ok('接收完成：' + r.moved + ' 个文件已放入 ' + (S.dstRoot || '素材目录'));
    } catch (e) {
      fail(e && e.message || e);
    }
  }

  /* ---------------- 进度/速度 ---------------- */

  function sample(bytes) {
    var now = Date.now();
    if (!S.lastAt) { S.lastAt = now; S.lastBytes = bytes; return; }
    var dt = now - S.lastAt;
    if (dt < SAMPLE_MS) return;
    var inst = (bytes - S.lastBytes) * 1000 / dt;
    S.speed = S.speed ? S.speed * 0.6 + inst * 0.4 : inst;
    S.lastAt = now;
    S.lastBytes = bytes;
    emit();
  }

  /* ---------------- 收尾 ---------------- */

  function closeLink() {
    try { if (S.dc) S.dc.close(); } catch (e) {}
    try { if (S.pc) S.pc.close(); } catch (e) {}
    try { if (S.ws && S.ws.readyState === 1) S.ws.close(); } catch (e) {}
    S.dc = null; S.pc = null; S.ws = null;
    iceQueue = [];
  }

  function reset() {
    S.role = ''; S.code = ''; S.peer = null; S.error = '';
    S.sent = 0; S.received = 0; S.total = 0; S.blocks = 0; S.speed = 0;
    S.expect = 0; S.lastAt = 0; S.lastBytes = 0; S.startedAt = 0;
    S.sendSession = null; S.recvSession = null; S.manifestWire = null; S.pendingManifest = null;
    S.base = '';
    writeChain = Promise.resolve(); writeErr = null;
    iceQueue = [];
  }

  function cancel() {
    var role = S.role;
    var h = role === 'recv' ? (S.recvSession && S.recvSession.handle) : (S.sendSession && S.sendSession.handle);
    send({ t: 'bye' });
    closeLink();
    /* 发送方取消只是关连接，不动磁盘 —— 后端 cancel 对 send 会话会拼出一个相对路径去删，
       没必要冒这个险；只有接收方需要把 .vrclib-p2p/<sid> 清掉。 */
    if (h && role === 'recv' && typeof FS !== 'undefined') {
      FS.host.p2p('cancel', { sessionId: h }).catch(function () {});
    }
    S.state = 'idle';
    S.error = '';
    reset();
    emit();
  }

  /** 断线重连：复用同一个口令重新走一遍 SDP，接收端 open 会读回位图 */
  async function retry() {
    if (!S.code || !S.role) throw new Error('没有可重连的会话');
    closeLink();
    S.error = '';
    var code = S.code, role = S.role;
    if (role === 'send') {
      var items = S.items;
      var keep = S.code;
      reset();
      S.items = items;
      S.code = keep;
      var prep = await FS.host.p2p('prepare', { items: items });
      S.sendSession = prep;
      S.manifestWire = {
        sessionId: prep.sessionId, total: prep.total, blocks: prep.blocks,
        blockSize: prep.blockSize, files: prep.files
      };
      S.total = prep.total; S.blocks = prep.blocks; S.role = 'send';
      S.ws = await openSignal(S.code, 'host');
      bindSignal(S.ws);
      S.pc = newPC();
      attachChannel(S.pc.createDataChannel('file', { ordered: true }));
      setState('hosting');
    } else {
      var dst = S.dstRoot;
      reset();
      S.role = 'recv'; S.code = code; S.dstRoot = dst;
      S.pc = newPC();
      S.pc.ondatachannel = function (e) { attachChannel(e.channel); };
      S.ws = await openSignal(S.code, 'guest');
      bindSignal(S.ws);
      setState('joining');
    }
  }

  /* ---------------- 素材 → 清单 ---------------- */

  /** 把素材列表摊平成 [{ abs, rel }]：文件与解压目录的差异交给 Packer.collectFiles，
   *  这里只给每个素材套一层「素材名/」目录，避免不同素材的子目录撞名。 */
  function collectItems(list) {
    var out = [];
    var seen = Object.create(null);
    var chain = Promise.resolve();
    (list || []).forEach(function (a) {
      chain = chain.then(function () {
        return Packer.collectFiles(a).then(function (files) {
          var root = String(a.name || '素材').replace(/[\\/:*?"<>|]/g, '_').trim() || '素材';
          (files || []).forEach(function (f) {
            var rel = String(f.rel || f.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
            if (!rel || !f.path) return;
            var full = root + '/' + rel;
            if (seen[full]) return;
            seen[full] = 1;
            out.push({ abs: f.path, rel: full });
          });
        });
      });
    });
    return chain.then(function () { return out; });
  }

  /* ---------------- 会话恢复 ---------------- */

  function resumable() {
    return FS.host.p2p('resumable', {}).then(function (r) { return r.list || []; });
  }

  return {
    state: snapshot,
    onChange: onChange,
    startSend: startSend,
    join: join,
    cancel: cancel,
    retry: retry,
    stopSignalIfAuto: stopSignalIfAuto,
    resumable: resumable,
    collectItems: collectItems,
    newCode: newCode,
    normCode: normCode,
    fmtSize: sz
  };
})();

/*
 * P2PUI — 传输面板 + 确认框 + 发起/接收对话框
 * 面板外观完全复用下载面板的 .dl-panel 规则，保证两块悬浮窗是同一套语言。
 */
var P2PUI = (function () {
  'use strict';

  var panel = null, bodyEl = null, badgeEl = null, titleEl = null;
  var st = { y: null };
  var confirmBox = null, confirmResolve = null;

  function sz(n) { return P2P.fmtSize(n); }

  /* ---------- 面板 ---------- */
  function build() {
    if (panel) return;
    titleEl = el('span', { class: 'dl-title' }, ICONS.label('\u2B06 传输'));
    badgeEl = el('span', { class: 'dl-badge', text: '0' });
    var head = el('div', { class: 'dl-head' }, [
      titleEl,
      badgeEl,
      el('span', { class: 'dl-spacer' }),
      el('button', {
        class: 'dl-btn', title: '关闭面板', onclick: function () { hide(); }
      }, ICONS.label('\u2715'))
    ]);
    bodyEl = el('div', { class: 'dl-body' });
    panel = el('div', { class: 'dl-panel p2p-panel dl-collapsed dl-docked-right', id: 'p2pPanel' }, [head, bodyEl]);
    document.body.appendChild(panel);

    head.addEventListener('mousedown', function (ev) {
      if (ev.target && ev.target.tagName === 'BUTTON') return;
      var r = panel.getBoundingClientRect();
      var oy = ev.clientY - r.top;
      panel.classList.add('dl-dragging');
      panel.classList.remove('dl-collapsed');
      function mv(e) {
        st.y = Math.max(0, Math.min(window.innerHeight - r.height, e.clientY - oy));
        panel.style.top = st.y + 'px';
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        panel.classList.remove('dl-dragging');
        panel.classList.add('dl-collapsed');
        save();
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
      ev.preventDefault();
    });
    panel.addEventListener('mouseenter', function () { panel.classList.remove('dl-collapsed'); });
    panel.addEventListener('mouseleave', function () {
      if (!panel.classList.contains('dl-dragging')) panel.classList.add('dl-collapsed');
    });
    window.addEventListener('resize', function () { place(); });
  }

  function load() {
    var s = (App.settings && App.settings.p2pPanel) || {};
    st.y = (typeof s.y === 'number') ? s.y : null;
  }
  function save() {
    if (typeof App === 'undefined') return;
    App.settings.p2pPanel = { y: st.y };
    if (App.saveSettings) App.saveSettings();
  }
  function place() {
    if (!panel) return;
    panel.style.right = '0px';
    panel.style.left = 'auto';
    var h = panel.offsetHeight || 80;
    var y = (st.y == null) ? 300 : st.y;
    panel.style.top = Math.max(0, Math.min(window.innerHeight - h, y)) + 'px';
  }
  function show() {
    build();
    panel.style.display = '';
    place();
  }
  function hide() {
    if (panel) panel.style.display = 'none';
  }

  var STATE_TEXT = {
    idle: '',
    hosting: '等你把口令发给好友',
    joining: '正在连接…',
    linking: '正在建立直连…',
    confirming: '等待对方确认…',
    sending: '发送中',
    receiving: '接收中',
    done: '已完成',
    failed: '失败'
  };

  function render(s) {
    if (!panel) return;
    if (s.state === 'idle') { hide(); return; }
    show();
    var isSend = s.role === 'send';
    ICONS.apply(titleEl, isSend ? '\u2B06 发送' : '\u{1F4E5} 接收');
    badgeEl.textContent = (s.state === 'done' || s.state === 'failed') ? '0' : '1';

    bodyEl.innerHTML = '';
    var row = el('div', { class: 'dl-task p2p-task dl-' + (s.state === 'failed' ? 'failed' : (s.state === 'done' ? 'done' : 'running')) });

    var name = s.name || '文件';
    var who = (s.peer && s.peer.name) || '好友';
    row.appendChild(el('div', { class: 'dl-name', title: name },
      isSend ? name : ('来自 ' + who + ' · ' + name)));

    if (s.state === 'hosting') {
      row.appendChild(el('div', { class: 'p2p-code' }, [
        el('span', { class: 'dim', text: '口令' }),
        el('b', { text: s.code })
      ]));
      row.appendChild(el('div', { class: 'dl-stat' }, ICONS.label('把上面 6 位口令发给好友，让他在「接收文件」里输入')));
      row.appendChild(el('div', { class: 'dl-stat dim', text: '服务会在 15 分钟没有传输后自动关闭；关闭后需要重新分享，口令也会变。' }));
    } else {
      var pct = Math.floor(s.pct || 0);
      row.appendChild(el('div', { class: 'dl-bar' }, [el('i', { style: { width: pct + '%' } })]));
      var line;
      if (s.state === 'failed') {
        line = ICONS.label('\u2716 ' + (s.error || '失败'));
      } else if (s.state === 'done') {
        line = ICONS.label('\u2714 已完成 · ' + sz(s.total));
      } else if (s.state === 'sending' || s.state === 'receiving') {
        var done = isSend ? (s.sent * (s.blockSize || 65536)) : s.received;
        line = ICONS.label('\u23F3 ' + STATE_TEXT[s.state] + ' ' + pct + '% · ' +
          sz(Math.min(done, s.total || done)) + ' / ' + sz(s.total) +
          (s.speed ? ' · ' + sz(s.speed) + '/s' : ''));
      } else {
        line = ICONS.label(STATE_TEXT[s.state] || s.state);
      }
      row.appendChild(el('div', { class: 'dl-stat' }, line));
    }

    var acts = el('div', { class: 'p2p-acts' });
    if (s.state === 'failed') {
      acts.appendChild(el('button', {
        class: 'btn btn-sm', onclick: function () { P2P.retry().catch(function (e) { Toasts(e.message); }); }
      }, '重连'));
    }
    if (s.state !== 'done' && s.state !== 'idle') {
      acts.appendChild(el('button', {
        class: 'btn btn-sm', onclick: function () { P2P.cancel(); }
      }, '取消'));
    }
    if (s.state === 'done') {
      acts.appendChild(el('button', {
        class: 'btn btn-sm', onclick: function () { hide(); }
      }, '收起'));
    }
    if (acts.children.length) row.appendChild(acts);
    bodyEl.appendChild(row);
  }


  function Toasts(msg) {
    if (typeof Toast !== 'undefined' && Toast.err) Toast.err(msg);
    else console.warn(msg);
  }

  /* ---------- 确认框 ---------- */
  function confirm(s) {
    return new Promise(function (resolve) {
      confirmResolve = resolve;
      if (!confirmBox) {
        var card = el('div', { class: 'p2p-confirm-card' });
        confirmBox = el('div', { class: 'p2p-confirm-mask', id: 'p2pConfirm' }, [card]);
        document.body.appendChild(confirmBox);
      }
      var card = confirmBox.firstChild;
      card.innerHTML = '';
      card.appendChild(el('h3', { text: '好友想给你传文件' }));
      card.appendChild(el('div', { class: 'p2p-confirm-who' }, [
        el('span', { class: 'p2p-avatar', text: (s.peer && s.peer.name || '?').slice(0, 1).toUpperCase() }),
        el('div', {}, [
          el('b', { text: (s.peer && s.peer.name) || '未知设备' }),
          el('span', { class: 'dim', text: (s.peer && s.peer.platform) || '' })
        ])
      ]));
      card.appendChild(el('div', { class: 'p2p-confirm-stats' }, [
        el('div', {}, [el('b', { text: String(s.files || 0) }), el('span', { text: ' 个文件' })]),
        el('div', {}, [el('b', { text: sz(s.total) }), el('span', { text: ' 总计' })])
      ]));
      var dst = el('div', { class: 'p2p-confirm-dst dim', text: '保存到：' + (s.dstRoot || '') });
      card.appendChild(dst);
      card.appendChild(el('div', { class: 'p2p-confirm-btns' }, [
        el('button', { class: 'btn', onclick: function () { closeConfirm(false); } }, '拒绝'),
        el('button', { class: 'btn btn-primary', onclick: function () { closeConfirm(true); } }, '接收')
      ]));
      confirmBox.style.display = '';
    });
  }
  function closeConfirm(ok) {
    if (confirmBox) confirmBox.style.display = 'none';
    var r = confirmResolve; confirmResolve = null;
    if (r) r(ok);
  }

  /* ---------- 发起 / 接收对话框 ---------- */
  var dlg = null, dlgWatch = null, dlgMode = '';

  function closeDialog() {
    if (dlg) dlg.style.display = 'none';
    if (dlgWatch) { dlgWatch(); dlgWatch = null; }
    /* 关掉「传给好友」窗口时还没连上对端：这个口令就废了（下次发起会新生成一个），
       顺手把为它起来的信令服务和半成品清单一起收掉，别让端口白占着。 */
    if (dlgMode === 'send') {
      var cur = null;
      try { cur = P2P.state(); } catch (e) {}
      var stt = cur && cur.state;
      if (stt === 'hosting' || stt === 'idle' || stt === 'failed') {
        try { P2P.cancel(); } catch (e) {}
        try { P2P.stopSignalIfAuto(); } catch (e) {}
      }
    }
    dlgMode = '';
  }

  function ensureDlg() {
    if (dlg) return dlg;
    dlg = el('div', { class: 'p2p-confirm-mask', id: 'p2pDialog' }, [el('div', { class: 'p2p-confirm-card p2p-dlg-card' })]);
    dlg.addEventListener('mousedown', function (e) { if (e.target === dlg) closeDialog(); });
    document.body.appendChild(dlg);
    return dlg;
  }

  /** 发起：把口令大字显示出来，复制走剪贴板 */
  function openSendDialog(items) {
    ensureDlg();
    dlgMode = 'send';
    var card = dlg.firstChild;
    card.innerHTML = '';
    card.appendChild(el('h3', { text: '传给好友' }));
    card.appendChild(el('p', { class: 'dim p2p-hint', text: '把口令发给对方，让他点右上角「接收」输进去。同一个局域网（同一 WiFi，或同一个 Radmin / ZeroTier 房间）里地址会自动找到；万一没找到，把下面其中一行整段发给他。' }));

    var codeEl = el('div', { class: 'p2p-bigcode', text: '······' });
    card.appendChild(codeEl);
    var stat = el('div', { class: 'p2p-dlg-stat dim', text: '正在准备清单…' });
    card.appendChild(stat);

    var btns = el('div', { class: 'p2p-confirm-btns' });
    var copyBtn = el('button', { class: 'btn', text: '复制口令', onclick: function () {
      copyText(codeEl.textContent.replace('-', ''));
      if (typeof Toast !== 'undefined') Toast.ok('口令已复制');
    }});
    copyBtn.style.display = 'none';
    btns.appendChild(copyBtn);
    /* 点错边的人不少：这边顺手给一个「我要接收」的入口，
       点击会先把本次发起收掉（含信令），再切到接收窗口 */
    btns.appendChild(el('button', { class: 'btn', text: '我有口令，去接收', onclick: function () {
      closeDialog();
      openReceiveDialog();
    }}));
    btns.appendChild(el('button', { class: 'btn', text: '关闭', onclick: function () { closeDialog(); } }));
    card.appendChild(btns);
    dlg.style.display = '';

    P2P.startSend(items).then(function (r) {
      codeEl.textContent = r.code.slice(0, 3) + '-' + r.code.slice(3);
      copyBtn.style.display = '';
      stat.textContent = '共 ' + r.fileCount + ' 个文件 · ' + sz(r.total) + ' · 等待好友输入口令…';
      /* 每个网卡的完整地址都列出来：物理 WiFi 与虚拟局域网走的是不同地址，
         只给人看一个，另一边的人必然连不上。点一行就复制「地址 口令」。 */
      FS.host.p2p('signalStatus', {}).then(function (st) {
        var addrs = (st && st.addrs) || [];
        if (!addrs.length) return;
        var list = el('div', { class: 'p2p-addr-list' });
        addrs.forEach(function (a) {
          var line = a.url + ' ' + r.code.slice(0, 3) + '-' + r.code.slice(3);
          var item = el('div', { class: 'p2p-addr-item', title: '点击复制这一行' }, [
            el('span', { class: 'p2p-addr-tag', text: a.virtual ? '虚拟局域网' : '局域网' }),
            el('b', { text: a.url }),
            el('span', { class: 'p2p-addr-nic', text: a.virtual ? a.iface : '' })
          ]);
          item.addEventListener('click', function () {
            copyText(line);
            if (typeof Toast !== 'undefined') Toast.ok('已复制：' + line);
          });
          list.appendChild(item);
        });
        list.appendChild(el('div', {
          class: 'p2p-addr-cap',
          text: '自动发现不到时，让对方把这行整段粘进「接收文件」（地址和口令会自动分开）。走虚拟局域网就用「虚拟局域网」那行。'
        }));
        card.insertBefore(list, stat);
      }).catch(function () {});
    /* 对方接上后状态会变，这里只负责把提示语跟上 */
    if (dlgWatch) dlgWatch();
    dlgWatch = P2P.onChange(function (s) {
        if (s.state === 'confirming') stat.textContent = '好友已连上，等待他确认接收…';
        else if (s.state === 'sending') stat.textContent = '正在传输…';
        else if (s.state === 'done') stat.textContent = '传输完成';
        else if (s.state === 'failed') stat.textContent = '失败：' + (s.error || '');
      });
    }).catch(function (e) {
      stat.textContent = e && e.message || String(e);
      if (typeof Toast !== 'undefined') Toast.err(stat.textContent);
      /* 建连失败时把半成品会话收掉，否则后端的 prepare 结果会一直挂着 */
      try { P2P.cancel(); } catch (_) {}
    });
  }

  var dstPath = '';

  /** 接收：输口令 + 选保存目录 */
  function openReceiveDialog() {
    dstPath = (App.settings && App.settings.p2pDst) || '';
    ensureDlg();
    dlgMode = 'recv';
    var card = dlg.firstChild;
    card.innerHTML = '';
    card.appendChild(el('h3', { text: '接收文件' }));
    card.appendChild(el('p', { class: 'dim p2p-hint', text: '输入好友给你的 6 位口令（你们要在同一个局域网里：同一 WiFi，或同一个 Radmin / ZeroTier 房间）。连上之后会先问你要不要收，再开始传。找不到对方时，把好友那边显示的整行地址+口令粘到下面的口令框，会自动分开填。' }));

    /* 地址留空＝局域网自动发现。填上就直连 —— UDP 广播被防火墙吃掉时（很常见），
       把对方「接收文件」窗口里那行 ws:// 地址填进来就能连。 */
    var addrInput = el('input', {
      class: 'p2p-addr-input', type: 'text',
      placeholder: '信令地址（留空＝自动发现）', autocomplete: 'off', spellcheck: 'false'
    });

    var input = el('input', {
      class: 'p2p-code-input', type: 'text', maxlength: '7',
      placeholder: 'ABC-123', autocomplete: 'off', spellcheck: 'false'
    });
    /* 对方发来的常是「地址 + 口令」一整行：地址进地址栏，口令留在口令栏。
       paste 优先、input 兜底（拖放与部分输入法不触发 paste）。 */
    function absorb(txt) {
      if (!txt) return false;
      var m = String(txt).match(/(?:wss?:\/\/)?(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{2,5}))?/i);
      if (!m) return false;
      addrInput.value = 'ws://' + m[1] + ':' + (m[2] || 8787);
      var code = P2P.normCode(String(txt).replace(m[0], ' ')).slice(0, 6);
      input.value = code.length > 3 ? code.slice(0, 3) + '-' + code.slice(3) : code;
      return true;
    }
    input.addEventListener('input', function () {
      if (absorb(input.value)) return;
      var v = P2P.normCode(input.value).slice(0, 6);
      input.value = v.length > 3 ? v.slice(0, 3) + '-' + v.slice(3) : v;
    });
    input.addEventListener('paste', function (e) {
      var txt = '';
      try { txt = ((e.clipboardData || window.clipboardData).getData('text') || ''); } catch (err) { return; }
      if (absorb(txt)) e.preventDefault();
    });
    card.appendChild(input);
    card.appendChild(addrInput);

    var dst = el('div', { class: 'p2p-dst-row' }, [
      el('span', { class: 'dim', text: '保存到' }),
      el('b', { class: 'p2p-dst-path', text: '（未选择）' }),
      el('button', { class: 'btn btn-sm', text: '选择…', onclick: function () {
        FS.host.pickDir().then(function (p) {
          if (!p) return;
          dstPath = p;
          if (typeof App !== 'undefined') { App.settings.p2pDst = p; if (App.saveSettings) App.saveSettings(); }
          dst.querySelector('.p2p-dst-path').textContent = p;
        }).catch(function (e) { if (typeof Toast !== 'undefined') Toast.err(e.message); });
      }})
    ]);
    if (dstPath) dst.querySelector('.p2p-dst-path').textContent = dstPath;
    card.appendChild(dst);

    var stat = el('div', { class: 'p2p-dlg-stat dim', text: '' });
    card.appendChild(stat);

    var btns = el('div', { class: 'p2p-confirm-btns' });
    var go = el('button', { class: 'btn btn-primary', text: '连接', onclick: function () {
      var code = P2P.normCode(input.value);
      if (code.length !== 6) { stat.textContent = '口令是 6 位'; return; }
      if (!dstPath) { stat.textContent = '还没选保存目录'; return; }
      go.disabled = true;
      stat.textContent = '正在连接…';
      var manual = String(addrInput.value || '').trim();
      P2P.join(code, dstPath, manual).then(function () {
        stat.textContent = '已连上，等待对方建立直连…';
      }).catch(function (e) {
        go.disabled = false;
        stat.textContent = e && e.message || String(e);
      });
    }});
    btns.appendChild(go);
    btns.appendChild(el('button', { class: 'btn', text: '取消', onclick: function () { closeDialog(); } }));
    card.appendChild(btns);
    dlg.style.display = '';
    setTimeout(function () { input.focus(); }, 30);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); });
  }

  /* ---------- 本机信令服务：一个按钮搞定 ---------- */
  function refreshSignal(box) {
    box.innerHTML = '';
    FS.host.p2p('signalStatus', {}).then(function (st) {
      if (st.running) {
        box.appendChild(el('div', { class: 'p2p-signal-head' }, [
          el('b', { text: '本机信令服务' }),
          el('span', { class: 'p2p-signal-on', text: st.port ? ('运行中 · 端口 ' + st.port) : '运行中' }),
          el('button', {
            class: 'btn btn-sm', text: '停止',
            onclick: function () {
              FS.host.p2p('signalStop', {}).then(function () {
                App.settings.p2pSignalAuto = false;
                App.saveSettings();
                refreshSignal(box);
                if (typeof Toast !== 'undefined') Toast.info('已停止');
              });
            }
          })
        ]));
        var ips = ((st && st.addrs) || []).map(function (a) { return a.ip; });
        box.appendChild(el('p', {
          class: 'p2p-signal-note',
          text: '同一 WiFi 下的好友点右上角「接收」、输口令就能连上，地址是自动找的。'
            + (ips.length ? '（本机地址 ' + ips.join(' / ') + '）' : '')
        }));
      } else {
        var btn = el('button', {
          class: 'btn btn-sm btn-primary', text: '启动',
          onclick: function () {
            btn.disabled = true;
            FS.host.p2p('signalStart', {}).then(function () {
              App.settings.p2pSignalAuto = true;
              App.saveSettings();
              refreshSignal(box);
              if (typeof Toast !== 'undefined') Toast.ok('已启动');
            }).catch(function (e) {
              btn.disabled = false;
              if (typeof Toast !== 'undefined') Toast.err(e.message || String(e));
            });
          }
        });
        box.appendChild(el('div', { class: 'p2p-signal-head' }, [
          el('b', { text: '本机信令服务' }),
          el('span', { class: 'p2p-signal-state', text: '未启动' }),
          btn
        ]));
        box.appendChild(el('p', {
          class: 'p2p-signal-note',
          text: '开了之后你这台就是「碰头地点」，不用注册也不用联网。只有连同一个路由器的好友能用。点「传给好友」时也会自动启动。'
        }));
      }
    }).catch(function (e) {
      box.appendChild(el('p', { class: 'p2p-signal-note', text: '读不到信令状态：' + (e.message || e) }));
    });
  }

  function signalBox() {
    var box = el('div', { class: 'p2p-signal-box' });
    refreshSignal(box);
    return box;
  }

  function init() {
    load();
    P2P.onChange(render);
    /* 上次关程序前是开着的，就顺手再开一次；端口可能被别的程序占，失败就静默放弃 */
    if (typeof App !== 'undefined' && App.settings && App.settings.p2pSignalAuto) {
      FS.host.p2p('signalStart', {}).then(function () {
        App.saveSettings();
      }).catch(function () {});
    }
    /* 面板初始不显示；有任务再出来 */
  }

  return {
    init: init,
    confirm: confirm,
    hide: hide,
    openSendDialog: openSendDialog,
    openReceiveDialog: openReceiveDialog,
    signalBox: signalBox
  };
})();
