/* P2P 传文件的磁盘侧：摊平清单、按 64KB 全局块号读写、位图落盘续传，
 * 外加只转发文本帧的 WebSocket 信令服务与 UDP 局域网发现。
 * 与谁交互：WebRTC 与 SDP/ICE 交换全在渲染层，这里只收发字节与信令文本。
 * 边界：不解析 SDP/ICE，不中转文件数据，也不判断谁能连。
 * 块号全局是因为位图只要一条、续传不用按文件拆；接收端先写临时目录，
 * 中断时素材目录里不会留半截文件，同名冲突只在最后一步发生。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dgram = require('node:dgram');
const http = require('node:http');
const crypto = require('node:crypto');

const BLOCK = 64 * 1024;
const TMP_DIR = '.vrclib-p2p';
const BITMAP_DIRTY = 256;

const DEFAULT_PORT = 8787;
const PORT_TRIES = 10;
const MAX_FRAME = 1 << 20;                 // 一条 SDP 也就几 KB，1MB 是防炸上限
const DISCOVERY_PORTS = [8786, 8787, 8788, 8789, 8790];
const DISCOVERY_TAG = 'VRCLIB-P2P/1';

let DATA_DIR = '';
/** handle（`<sessionId>#<role>`）→ session */
const sessions = new Map();

function init(ctx) {
  DATA_DIR = String((ctx && ctx.dataDir) || '');
  dropSessions();
}

function setDataDir(dir) {
  DATA_DIR = String(dir || '');
  dropSessions();
}

/* 换数据根会立刻搬或删旧目录，Windows 上还开着的句柄会让删除失败，所以先关文件再清表。 */
function dropSessions() {
  for (const s of sessions.values()) {
    try { closeHandles(s); } catch (e) {}
  }
  sessions.clear();
}

function transfersDir() {
  return path.join(DATA_DIR, 'transfers');
}

function bitmapPath(id) {
  return path.join(transfersDir(), id + '.json');
}

/* ------------------------------ 小工具 ------------------------------ */

function fnv1a(buf) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < buf.length; i++) {
    h = (h ^ BigInt(buf[i])) & mask;
    h = (h * prime) & mask;
  }
  return h;
}

/** 会话 ID = 清单内容 + 总字节数的 FNV64；同一份清单必然得到同一个 ID（续传的前提） */
function sessionId(files, total) {
  const parts = [];
  for (const f of files) {
    parts.push(f[0]);
    parts.push('\u0001');
    parts.push(String(f[1]));
    parts.push('\n');
  }
  parts.push(String(total));
  const h = fnv1a(Buffer.from(parts.join(''), 'utf8'));
  return h.toString(16).padStart(16, '0') + '-' + total.toString(16);
}

/** 相对路径只允许普通片段：绝对路径、盘符、`..` 一律拒绝 */
function safeRel(rel) {
  let s = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!s) throw new Error('相对路径为空');
  const segs = s.split('/');
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..') throw new Error('相对路径非法：' + s);
    if (/^[A-Za-z]:/.test(seg)) throw new Error('相对路径非法：' + s);
  }
  return segs.join('/');
}

function locate(s, block) {
  for (let i = 0; i < s.files.length; i++) {
    const f = s.files[i];
    if (block >= f.start && block < f.start + f.blocks) return [i, (block - f.start) * BLOCK];
  }
  return null;
}

function blockLen(s, block) {
  const loc = locate(s, block);
  if (!loc) return 0;
  return Math.min(BLOCK, Math.max(0, s.files[loc[0]].size - loc[1]));
}

function hasBlock(s, block) {
  const i = Math.floor(block / 8);
  if (i >= s.bitfield.length) return false;
  return ((s.bitfield[i] >> (block % 8)) & 1) === 1;
}

function markBlock(s, block) {
  const i = Math.floor(block / 8);
  if (i >= s.bitfield.length) {
    const next = Buffer.alloc(i + 1);
    s.bitfield.copy(next);
    s.bitfield = next;
  }
  const mask = 1 << (block % 8);
  if ((s.bitfield[i] & mask) === 0) {
    s.bitfield[i] |= mask;
    s.received += blockLen(s, block);
  }
}

function buildFiles(items, base) {
  const out = [];
  let start = base;
  for (const it of items) {
    const blocks = Math.ceil(it.size / BLOCK);
    out.push({ rel: it.rel, abs: it.abs, size: it.size, blocks: blocks, start: start });
    start += blocks;
  }
  return { files: out, blocks: start };
}

function sessionToJson(s) {
  let next = 0;
  if (s.role === 'recv') {
    next = s.blocks;
    for (let b = 0; b < s.blocks; b++) {
      if (!hasBlock(s, b)) { next = b; break; }
    }
  }
  return {
    /* sessionId 是清单身份（配对 + 位图命名），handle 是进程内句柄：
       同一份清单同时收发会撞在一起，所以句柄带角色后缀，读写接口一律用 handle。 */
    sessionId: s.id,
    handle: s.id + '#' + s.role,
    role: s.role,
    root: s.root,
    total: s.total,
    blocks: s.blocks,
    nextBlock: next,
    received: s.received,
    pct: s.total === 0 ? 0 : (s.received / s.total) * 100,
    done: s.done,
    blockSize: BLOCK,
    fileCount: s.files.length,
    files: s.files.map((f) => ({ rel: f.rel, size: f.size, blocks: f.blocks }))
  };
}

/** 位图落盘：中断 / 关窗后靠它接上 */
function saveBitmap(s) {
  try {
    fs.mkdirSync(transfersDir(), { recursive: true });
    const v = {
      sessionId: s.id,
      root: s.root,
      total: s.total,
      blocks: s.blocks,
      blockSize: BLOCK,
      received: s.received,
      done: s.done,
      files: s.files.map((f) => ({ rel: f.rel, size: f.size })),
      bitfield: Buffer.from(s.bitfield).toString('base64'),
      at: Math.floor(Date.now() / 1000)
    };
    fs.writeFileSync(bitmapPath(s.id), JSON.stringify(v), 'utf8');
  } catch (e) { /* 落盘失败不影响传输本身 */ }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function closeHandles(s) {
  for (const fd of s.handles.values()) {
    try { fs.closeSync(fd); } catch (e) {}
  }
  s.handles.clear();
}


/** /api/p2p/prepare —— 入参 { items: [{ abs, rel }] }，出参即「清单」 */
function prepare(v) {
  const arr = v && v.items;
  if (!Array.isArray(arr)) throw new Error('缺少 items');
  if (!arr.length) throw new Error('没有选择任何文件');

  const raw = [];
  let total = 0;
  for (const it of arr) {
    const abs = String((it && it.abs) || '').trim();
    const relIn = String((it && it.rel) || '').trim();
    if (!abs) throw new Error('清单里有空路径');
    let st;
    try { st = fs.statSync(abs); } catch (e) { throw new Error('读不到 ' + abs + '：' + e.message); }
    if (!st.isFile()) continue;
    const rel = safeRel(relIn);
    total += st.size;
    raw.push({ rel: rel, abs: abs, size: st.size });
  }
  if (!raw.length) throw new Error('清单里的文件都不存在');

  const id = sessionId(raw.map((r) => [r.rel, r.size]), total);
  const built = buildFiles(raw, 0);
  const s = {
    id: id, role: 'send', root: '', files: built.files, total: total, blocks: built.blocks,
    bitfield: Buffer.alloc(0), received: 0, handles: new Map(), dirty: 0, done: false
  };
  const out = sessionToJson(s);
  sessions.set(id + '#send', s);
  /* 发送会话只活在当前进程里，用户换着批次传会一直堆；只留最近 8 个。 */
  const sendKeys = [];
  for (const k of sessions.keys()) if (k.endsWith('#send')) sendKeys.push(k);
  for (let i = 0; i < sendKeys.length - 8; i++) sessions.delete(sendKeys[i]);
  return out;
}


/** /api/p2p/open —— 入参 { manifest, dstRoot }；有位图就接着传 */
function open(v) {
  const m = (v && v.manifest) || null;
  if (!m) throw new Error('缺少 manifest');
  const dstRoot = String((v && v.dstRoot) || '').trim();
  if (!dstRoot) throw new Error('缺少接收目录');
  const total = Number(m.total) || 0;
  const filesIn = m.files;
  if (!Array.isArray(filesIn)) throw new Error('manifest 里没有 files');

  const root = dstRoot;
  const tmp = path.join(root, TMP_DIR, String(m.sessionId || 'session'));

  const items = [];
  let totalCalc = 0;
  for (const f of filesIn) {
    const rel = safeRel(f && f.rel);
    const size = Number((f && f.size) || 0);
    totalCalc += size;
    items.push({ rel: rel, abs: path.join(tmp, rel), size: size });
  }
  /* 只比大小对不上；全 0 字节的清单是合法输入（空文件也是要传的东西）。 */
  if (totalCalc !== total) {
    throw new Error('清单大小对不上：声明 ' + total + '，实际 ' + totalCalc);
  }
  const id = String(m.sessionId || '');
  if (!id) throw new Error('manifest 没有 sessionId');

  const built = buildFiles(items, 0);
  let bitfield = Buffer.alloc(Math.ceil(built.blocks / 8));
  let received = 0;

  const old = readJson(bitmapPath(id));
  if (old && Number(old.blocks) === built.blocks && typeof old.bitfield === 'string') {
    let decoded = Buffer.alloc(0);
    try { decoded = Buffer.from(old.bitfield, 'base64'); } catch (e) {}
    decoded.copy(bitfield, 0, 0, Math.min(decoded.length, bitfield.length));
    /* 按位图重算已收字节：位图是唯一可信来源，不沿用文件里记的 received */
    for (const f of built.files) {
      for (let b = 0; b < f.blocks; b++) {
        const gb = f.start + b;
        const idx = Math.floor(gb / 8);
        if (idx < bitfield.length && ((bitfield[idx] >> (gb % 8)) & 1) === 1) {
          received += Math.min(BLOCK, f.size - b * BLOCK);
        }
      }
    }
  }

  const s = {
    id: id, role: 'recv', root: root, files: built.files, total: total, blocks: built.blocks,
    bitfield: bitfield, received: received, handles: new Map(), dirty: 0, done: false
  };
  const out = sessionToJson(s);
  sessions.set(id + '#recv', s);
  return out;
}


/** 发送方取一块（最多 64KB，最后一块可能更短） */
function readBlock(handle, block) {
  const s = sessions.get(String(handle));
  if (!s) throw new Error('会话不存在');
  const loc = locate(s, Number(block));
  if (!loc) throw new Error('块号越界：' + block);
  const f = s.files[loc[0]];
  const off = loc[1];
  const len = Math.min(BLOCK, Math.max(0, f.size - off));
  const buf = Buffer.alloc(len);
  let fd = -1;
  try {
    fd = fs.openSync(f.abs, 'r');
    const n = fs.readSync(fd, buf, 0, len, off);
    if (n !== len) throw new Error('读 ' + f.rel + ' 不足：' + n + '/' + len);
  } catch (e) {
    throw new Error('读 ' + f.rel + ' 失败：' + ((e && e.message) || e));
  } finally {
    if (fd >= 0) { try { fs.closeSync(fd); } catch (e) {} }
  }
  return buf;
}

/** 接收方写一块；重复块直接丢弃，不算进度 */
function writeBlock(handle, block, data) {
  const s = sessions.get(String(handle));
  if (!s) throw new Error('会话不存在');
  if (s.role !== 'recv') throw new Error('该会话不是接收方');
  const b = Number(block);
  if (hasBlock(s, b)) return { ok: true, dup: true, received: s.received, pct: sessionToJson(s).pct };

  const loc = locate(s, b);
  if (!loc) throw new Error('块号越界：' + block);
  const fi = loc[0];
  const off = loc[1];
  const f = s.files[fi];
  const expect = Math.min(BLOCK, Math.max(0, f.size - off));
  const bytes = Buffer.from(data || []);
  if (bytes.length !== expect) {
    throw new Error('块 ' + b + ' 长度不符：收到 ' + bytes.length + '，应为 ' + expect);
  }

  let fd = s.handles.get(fi);
  if (fd === undefined) {
    try { fs.mkdirSync(path.dirname(f.abs), { recursive: true }); } catch (e) {}
    try {
      fd = fs.openSync(f.abs, 'r+');
    } catch (e) {
      fd = fs.openSync(f.abs, 'w+');
    }
    /* 先按最终大小占位，写尾部块时不会稀疏成 0 字节 */
    try { if (fs.fstatSync(fd).size !== f.size) fs.ftruncateSync(fd, f.size); } catch (e) {}
    s.handles.set(fi, fd);
  }
  try {
    fs.writeSync(fd, bytes, 0, bytes.length, off);
  } catch (e) {
    throw new Error('写 ' + f.abs + ' 失败：' + ((e && e.message) || e));
  }

  markBlock(s, b);
  s.dirty += 1;
  const out = sessionToJson(s);
  if (s.dirty % BITMAP_DIRTY === 0) saveBitmap(s);
  return { ok: true, dup: false, received: s.received, pct: out.pct };
}


/** 校验块是否齐、把临时目录搬到正式位置 */
function finish(handle) {
  const s = sessions.get(String(handle));
  if (!s) throw new Error('会话不存在');
  if (s.role !== 'recv') throw new Error('该会话不是接收方');

  const missing = [];
  for (let b = 0; b < s.blocks; b++) {
    if (!hasBlock(s, b)) {
      missing.push(b);
      if (missing.length >= 20) break;
    }
  }
  if (missing.length) {
    throw new Error('还有 ' + missing.length + ' 块没收到（例：' + missing.slice(0, 5).join(',') + '）');
  }

  closeHandles(s);
  let moved = 0;
  const failed = [];
  for (const f of s.files) {
    const dst = path.join(s.root, f.rel);
    try { fs.mkdirSync(path.dirname(dst), { recursive: true }); } catch (e) {
      failed.push(f.rel + ': ' + ((e && e.message) || e));
      continue;
    }
    /* 同名文件先留一份 .bak，避免用户手改的东西被无声覆盖 */
    try {
      if (fs.existsSync(dst)) {
        const ext = path.extname(dst);
        const bak = ext ? dst + 'bak' : dst + '.bak';
        fs.renameSync(dst, bak);
      }
    } catch (e) { /* 备份失败也继续，至少别卡住整次传输 */ }
    if (f.size === 0) {
      try { fs.closeSync(fs.openSync(dst, 'w')); moved += 1; } catch (e) { failed.push(f.rel + ': ' + e.message); }
      continue;
    }
    try { fs.renameSync(f.abs, dst); moved += 1; } catch (e) { failed.push(f.rel + ': ' + e.message); }
  }

  /* 有文件没落盘就别清场：临时文件还在，位图也还在，用户重连能直接重试。
   * 反过来说，这里一旦 saveBitmap + 删临时目录，失败就变成不可恢复的了。 */
  if (failed.length) {
    saveBitmap(s);
    return {
      ok: false,
      moved: moved,
      total: s.files.length,
      failed: failed,
      root: s.root,
      retryable: true,
      error: '有 ' + failed.length + ' 个文件没能写入目录（可能被占用或无权限），重连后可重试'
    };
  }

  s.done = true;
  s.received = s.total;
  saveBitmap(s);

  /* 临时目录收干净（还可能剩别的会话，所以只删本会话这层） */
  try { fs.rmSync(path.join(s.root, TMP_DIR, s.id), { recursive: true, force: true }); } catch (e) {}
  try { fs.unlinkSync(bitmapPath(s.id)); } catch (e) {}

  return { ok: true, moved: moved, total: s.files.length, failed: failed, root: s.root };
}

/** 放弃一次传输：关句柄、删本会话的临时目录 */
function cancel(handle) {
  const key = String(handle);
  const s = sessions.get(key);
  if (s) {
    closeHandles(s);
    sessions.delete(key);
    /* 只有接收端有临时目录；发送端的 root 是空的，拼出来是相对路径，删了等于乱删当前目录。 */
    if (s.role === 'recv') {
      const tmp = path.join(s.root, TMP_DIR, s.id);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    }
    try { fs.unlinkSync(bitmapPath(s.id)); } catch (e) {}
  }
  return { ok: true };
}

function listBitmaps() {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(transfersDir(), { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    if (!e.isFile() || path.extname(e.name) !== '.json') continue;
    const v = readJson(path.join(transfersDir(), e.name));
    if (!v) continue;
    out.push(v);
  }
  return out;
}

/** 会话还在就报状态；进程重启过就报位图里能续的那些 */
function status(handle) {
  const s = sessions.get(String(handle));
  if (s) return sessionToJson(s);
  const list = listBitmaps().filter((v) => v.done !== true);
  return { ok: true, missing: true, resumable: list };
}

/** 上次没传完的会话（UI 开机时问一句要不要续） */
function resumable() {
  const list = [];
  for (const v of listBitmaps()) {
    if (v.done === true) continue;
    const first = Array.isArray(v.files) && v.files[0] ? String(v.files[0].rel || '') : '';
    const name = first.split('/')[0] || '未命名';
    list.push({
      sessionId: v.sessionId,
      name: name,
      files: Array.isArray(v.files) ? v.files.length : 0,
      total: v.total,
      received: v.received,
      root: v.root,
      at: v.at
    });
  }
  list.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return { ok: true, list: list };
}

/** 关窗 / 退出前把所有未完成会话的位图刷一遍 */
function flushAll() {
  for (const s of sessions.values()) {
    if (!s.done && s.role === 'recv') saveBitmap(s);
  }
}


/* 信令只需要「握手 + 收发文本帧」，一百多行就够，不必为此引第三方包
 * （node:ws 不是内置，引进来还要处理打包时的原生模块问题）。 */
function wsAccept(key) {
  return crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function wsFrame(text) {
  const payload = Buffer.from(String(text), 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** 极简 WS 帧解析：服务端只收文本帧（客户端一定带掩码） */
function makeParser(onText, onClose, sendRaw) {
  let buf = Buffer.alloc(0);
  let frags = [];
  return function (chunk) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) { onClose(); return; }
        len = Number(big);
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      /* RFC 6455：客户端帧必须带掩码；控制帧不能分片、载荷不超过 125 字节。 */
      if (!masked || (op >= 0x8 && (!fin || len > 125))) { onClose(); return; }

      let payload;
      if (masked) {
        const mask = buf.slice(off, off + 4);
        const src = buf.slice(off + 4, off + 4 + len);
        payload = Buffer.alloc(len);
        for (let i = 0; i < len; i++) payload[i] = src[i] ^ mask[i & 3];
      } else {
        payload = buf.slice(off, off + len);
      }
      buf = buf.slice(off + maskLen + len);

      if (op === 0x8) { onClose(); return; }
      if (op === 0x9) {                 // ping → pong
        try { sendRaw(Buffer.from([0x8a, 0x00])); } catch (e) {}
        continue;
      }
      if (op === 0xa) continue;          // pong
      if (op === 0x1 || op === 0x0) {
        frags.push(payload);
        /* 分片总量也要有上限，否则一直发 FIN=0 的续帧就能把内存撑爆。 */
        const total = frags.reduce((n, b) => n + b.length, 0);
        if (total > MAX_FRAME) { frags = []; onClose(); return; }
        if (fin) {
          const all = Buffer.concat(frags);
          frags = [];
          onText(all.toString('utf8'));
        }
      }
    }
  };
}

function validCode(c) {
  return typeof c === 'string' && c.length === 6 &&
    /^[0-9A-Z]+$/.test(c) && !/[ILOU]/.test(c);
}

/** 往 8.8.8.8 建一个 UDP「连接」拿路由选出的源地址；UDP connect 不发包，断网也能用 */
/* 虚拟网卡（Radmin / ZeroTier 这类）的地址才是对方真正能连上的那个，而默认路由
 * 永远指向物理网卡，只报一个地址必然有人连不上。 */
const VIRTUAL_NIC_RE = /radmin|zerotier|tailscale|hamachi|wintun|wireguard|openvpn|sstap|clash|tap-|tap0|tun0|vpn|virtual|vmware|vbox|hyper-v|vethernet/i;

/** 所有可用于连接的 IPv4（跳过回环与 169.254 链路本地），物理网卡在前。 */
function listIpv4() {
  const out = [];
  let nics = {};
  try { nics = os.networkInterfaces() || {}; } catch (e) { return out; }
  for (const name of Object.keys(nics)) {
    for (const a of nics[name] || []) {
      const fam = a.family;
      if (fam !== 'IPv4' && fam !== 4) continue;
      if (a.internal) continue;
      const ip = String(a.address || '');
      if (!ip || ip.indexOf('169.254.') === 0) continue;
      out.push({ ip: ip, iface: name, virtual: VIRTUAL_NIC_RE.test(name) });
    }
  }
  out.sort((x, y) => (x.virtual === y.virtual ? 0 : (x.virtual ? 1 : -1)));
  return out;
}

function lanIp() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { sock.close(); } catch (e) {} resolve(v); };
    sock.once('error', () => finish(''));
    try {
      sock.connect(80, '8.8.8.8', () => {
        try { finish(String(sock.address().address || '')); } catch (e) { finish(''); }
      });
    } catch (e) {
      finish('');
    }
    setTimeout(() => finish(''), 800);
  });
}

function prefixOf(mask) {
  if (!mask) return 0;
  let n = 0;
  const parts = mask.split('.').map((x) => parseInt(x, 10) || 0);
  for (const p of parts) {
    for (let bit = 7; bit >= 0; bit--) {
      if ((p >> bit) & 1) n += 1;
      else return n;
    }
  }
  return n;
}

function ipToInt(ip) {
  const p = String(ip).split('.').map((x) => parseInt(x, 10) || 0);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function broadcastOf(ip, prefix) {
  if (!prefix || prefix >= 31) return '';
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return intToIp((ipToInt(ip) | (~mask >>> 0)) >>> 0);
}

/** 一张网卡可能对应多个候选广播地址：虚拟网卡上报的前缀经常不准（/32、/31、0），
 *  单靠上报值算不出广播，这里再补 /24 /16 /8 三种常见掩码。 */
function broadcastCandidates(ip, prefix) {
  const out = [];
  const push = (bc) => { if (bc && bc !== ip && out.indexOf(bc) < 0) out.push(bc); };
  push(broadcastOf(ip, prefix));
  for (const p of [24, 16, 8]) push(broadcastOf(ip, p));
  return out;
}

function localNetworks() {
  const out = [];
  let ifs = {};
  try { ifs = os.networkInterfaces() || {}; } catch (e) { return out; }
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (!a || a.family !== 'IPv4' || a.internal) continue;
      const prefix = a.netmask ? prefixOf(a.netmask) : 24;
      out.push({ ip: a.address, prefix: prefix, broadcast: broadcastCandidates(a.address, prefix) });
    }
  }
  return out;
}

let SIG = null;   // { port, lan, server, discSock, rooms, stop, lastBusy, timer }

function roomSend(room, to, msg) {
  const conn = to === 'host' ? room.host : room.guest;
  if (conn) { try { conn.send(msg); } catch (e) {} }
}

function roomPeer(room, role) {
  return role === 'host' ? room.guest : room.host;
}

function roomLeave(code, role, conn) {
  const room = SIG && SIG.rooms.get(code);
  if (!room) return;
  /* 同角色重连会顶掉旧连接，旧 socket 的 close 会晚一步走到这里；
   * 不比对 conn 就会把刚接上的新连接清掉，之后 peer 的 ready 全被丢弃。 */
  if (conn && role === 'host' && room.host && room.host !== conn) return;
  if (conn && role === 'guest' && room.guest && room.guest !== conn) return;
  if (role === 'host') room.host = null; else room.guest = null;
  roomSend(room, role === 'host' ? 'guest' : 'host', '{"t":"peer-left"}');
  if (!room.host && !room.guest) SIG.rooms.delete(code);
}

function sigStatus() {
  if (SIG && SIG.stop) return { ok: true, running: false, self: '', peer: '' };
  if (!SIG) return { ok: true, running: false, self: '', peer: '' };
  /* 每个网卡给一行完整地址：对方在不同网络上时（物理 WiFi / Radmin / ZeroTier），
   * 能连的地址不是同一个，只报一个必然有人连不上。 */
  const addrs = listIpv4().map((a) => ({
    ip: a.ip, iface: a.iface, virtual: a.virtual, url: 'ws://' + a.ip + ':' + SIG.port
  }));
  return {
    ok: true,
    running: true,
    port: SIG.port,
    lan: SIG.lan,
    addrs: addrs,
    self: 'ws://127.0.0.1:' + SIG.port,
    peer: SIG.lan ? 'ws://' + SIG.lan + ':' + SIG.port : ''
  };
}

function sigStop() {
  if (!SIG) {
    /* 还在启动途中叫停：打标记，listen 回调看到后自己关端口，别把 SIG 写回来。 */
    if (STARTING) STOP_REQUESTED = true;
    return { ok: true, stopped: false };
  }
  const port = SIG.port;
  SIG.stop = true;
  try { SIG.server.close(); } catch (e) {}
  try { if (SIG.discSock) SIG.discSock.close(); } catch (e) {}
  try { if (SIG.timer) clearInterval(SIG.timer); } catch (e) {}
  for (const room of SIG.rooms.values()) {
    for (const conn of [room.host, room.guest]) {
      if (conn) { try { conn.socket.destroy(); } catch (e) {} }
    }
  }
  SIG.rooms.clear();
  SIG = null;
  return { ok: true, stopped: true, port: port };
}

/** 先占一个 UDP 端口做发现应答；全被占也不影响收发，只是对方得手动填地址 */
function bindDiscovery(port) {
  return new Promise((resolve) => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= DISCOVERY_PORTS.length) return resolve(null);
      const p = DISCOVERY_PORTS[idx++];
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      let settled = false;
      sock.once('error', () => {
        if (settled) return;
        settled = true;
        try { sock.close(); } catch (e) {}
        tryNext();
      });
      sock.once('message', () => {});
      sock.bind(p, () => {
        if (settled) return;
        settled = true;
        sock.on('message', (msg, rinfo) => {
          const parts = String(msg).trim().split(/\s+/);
          if (parts[0] !== DISCOVERY_TAG || !parts[1]) return;
          /* 把对方的随机 token 原样带回去，方便它确认「这条回执是回应我那一次探测的」 */
          const reply = DISCOVERY_TAG + ' ' + parts[1] + ' ' + port;
          try { sock.send(Buffer.from(reply), rinfo.port, rinfo.address); } catch (e) {}
        });
        resolve(sock);
      });
    };
    tryNext();
  });
}

/* 启动过程要等 listen 回调 + 网卡枚举，最长几百毫秒；这段时间里的并发调用会各自监听一次，
 * 先起的那台 server 就变成孤儿（端口被占、停不掉）。单飞 + 停止请求标记收口。 */
let STARTING = null;
let STOP_REQUESTED = false;

function startSignal(v) {
  if (SIG && !SIG.stop) return Promise.resolve(sigStatus());
  if (STARTING) return STARTING;
  STOP_REQUESTED = false;

  const p = new Promise((resolve, reject) => {
    const want = Number((v && v.port) || 0) || DEFAULT_PORT;

    const tryListen = (p, left) => {
      const server = http.createServer((req, res) => {
        /* 探活：/ping 与 / 都回 ok */
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('ok');
      });
      server.once('error', () => {
        if (left <= 0) { reject(new Error(want + '~' + (want + PORT_TRIES - 1) + ' 这些端口都被占用了，先关掉占用的程序')); return; }
        tryListen(p + 1, left - 1);
      });
      server.listen(p, '0.0.0.0', async () => {
        const port = server.address().port;
        /* 优先用网卡枚举出来的第一个物理地址；lanIp() 那套「连 8.8.8.8 看出口」
         * 在断网或只有虚拟网卡时会返回空，留作兜底。 */
        const first = listIpv4()[0];
        const lan = (first && first.ip) || await lanIp();

        /* 启动期间有人叫停：别把 SIG 写回来，直接把刚监听的端口关掉。 */
        if (STOP_REQUESTED) {
          try { server.close(); } catch (e) {}
          resolve({ ok: true, running: false, self: '', peer: '' });
          return;
        }

        SIG = { port: port, lan: lan, server: server, discSock: null, rooms: new Map(), stop: false, lastBusy: Date.now(), timer: null };

        server.on('upgrade', onUpgrade);

        const disc = await bindDiscovery(port);
        if (SIG && disc) SIG.discSock = disc;

        /* 空闲看门狗：连续 15 分钟没有任何连接就自动关掉，避免长期占端口 */
        SIG.timer = setInterval(() => {
          if (!SIG) return;
          const busy = Array.from(SIG.rooms.values()).some((r) => r.host || r.guest);
          if (busy) SIG.lastBusy = Date.now();
          else if (Date.now() - SIG.lastBusy >= 15 * 60 * 1000) {
            SIG.stop = true;
            try { SIG.server.close(); } catch (e) {}
            try { if (SIG.discSock) SIG.discSock.close(); } catch (e) {}
            try { clearInterval(SIG.timer); } catch (e) {}
          }
        }, 20000);
        if (SIG.timer.unref) SIG.timer.unref();

        resolve(sigStatus());
      });
    };
    tryListen(want, PORT_TRIES - 1);
  });

  STARTING = p.then(
    function (r) { STARTING = null; return r; },
    function (e) { STARTING = null; throw e; }
  );
  return STARTING;
}

function onUpgrade(req, socket, head) {
  const url = String(req.url || '');
  const qIdx = url.indexOf('?');
  const rawPath = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const query = qIdx >= 0 ? url.slice(qIdx + 1) : '';
  const m = /^\/room\/([^/]+)$/.exec(rawPath);
  const key = req.headers['sec-websocket-key'];

  socket.on('error', function () { /* 客户端断开是常态，别让异常冒到主进程 */ });

  /* decodeURIComponent 遇到不合法的百分号编码会抛 URIError，局域网里谁都能触发，
   * 不接住的话这条连接会一直挂着，只能等全局异常兜底。 */
  let roomCode = '';
  try {
    roomCode = m ? decodeURIComponent(m[1]) : '';
  } catch (e) {
    try { socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 9\r\n\r\nbad room '); } catch (e2) {}
    return;
  }

  if (!roomCode || !validCode(roomCode) || !key) {
    try { socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 9\r\n\r\nbad room '); } catch (e) {}
    return;
  }
  const code = roomCode.toUpperCase();
  const role = /role=host/.test(query) ? 'host' : 'guest';

  try {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
    );
  } catch (e) { return; }
  try { socket.setNoDelay(true); } catch (e) {}

  const conn = {
    socket: socket,
    send: function (text) { try { socket.write(wsFrame(text)); } catch (e) {} }
  };

  if (!SIG) { try { socket.destroy(); } catch (e) {} return; }
  const room = SIG.rooms.get(code) || { host: null, guest: null };
  /* 同角色重连：直接顶掉旧的，旧连接的读循环会自然退出 */
  if (role === 'host') room.host = conn; else room.guest = conn;
  SIG.rooms.set(code, room);
  if (roomPeer(room, role)) {
    const peer = role === 'host' ? 'guest' : 'host';
    roomSend(room, peer, '{"t":"peer-joined"}');
    conn.send('{"t":"peer-joined"}');
  }
  SIG.lastBusy = Date.now();

  const parser = makeParser(
    function (text) {
      /* 转发给「对方」，不是回给自己 —— 传错就等于消息原地打转 */
      const r = SIG && SIG.rooms.get(code);
      if (!r) return;
      roomSend(r, role === 'host' ? 'guest' : 'host', text);
    },
    function () { try { socket.destroy(); } catch (e) {} },
    function (buf) { try { socket.write(buf); } catch (e) {} }
  );

  socket.on('data', parser);
  socket.on('close', () => { roomLeave(code, role, conn); });
  socket.on('end', () => { try { socket.destroy(); } catch (e) {} });
  if (head && head.length) parser(head);
}

/**
 * 局域网里找正在跑信令服务的那台：每张网卡各发一份探测。
 * 只绑 0.0.0.0 的话包只会从默认路由出去，Radmin / ZeroTier 这类虚拟网卡永远排不到。
 */
function discover() {
  return new Promise(async (resolve) => {
    const nets = localNetworks();
    const me = await lanIp();
    const token = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
    const probe = Buffer.from(DISCOVERY_TAG + ' ' + token, 'utf8');

    const socks = [];
    let settled = false;
    let found = null;

    const cleanup = () => {
      for (const s of socks) { try { s.close(); } catch (e) {} }
      socks.length = 0;
    };

    const bindOne = (addr) => new Promise((res) => {
      const s = dgram.createSocket('udp4');
      let ok = false;
      s.once('error', () => { if (!ok) { ok = true; try { s.close(); } catch (e) {} res(null); } });
      s.bind(0, addr, () => {
        if (ok) return;
        ok = true;
        res(s);
      });
    });

    const targets = [];
    for (const n of nets) {
      const s = await bindOne(n.ip);
      if (s) {
        socks.push(s);
        targets.push({ sock: s, ip: n.ip, list: n.broadcast.concat(['255.255.255.255']) });
      }
    }
    /* 兜底：普通局域网（单网卡 / 默认路由就是对的）走受限广播 */
    const any = await bindOne('0.0.0.0');
    if (any) { socks.push(any); targets.push({ sock: any, ip: '', list: ['255.255.255.255'] }); }

    if (!socks.length) {
      resolve({ ok: false, error: '没有可用的网卡，无法在局域网里找对方' });
      return;
    }

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (found) resolve(found);
      else resolve({ ok: true, found: false, url: '', lan: '', networks: nets });
    };

    for (const s of socks) {
      try { s.setBroadcast(true); } catch (e) {}
      s.on('message', (msg, rinfo) => {
        const parts = String(msg).trim().split(/\s+/);
        if (parts[0] !== DISCOVERY_TAG) return;
        if (parts[1] !== token) return;
        const port = parseInt(parts[2], 10) || DEFAULT_PORT;
        const ip = rinfo.address;
        /* 同一台机器上本服务也开着时，广播会打到自己；连自己只会干等 */
        if (ip === me) return;
        found = { ok: true, found: true, url: 'ws://' + ip + ':' + port, lan: ip };
        finish();
      });
    }

    const blast = (extra24) => {
      for (const t of targets) {
        const list = extra24
          ? t.list.concat(t.ip ? broadcastCandidates(t.ip, 24) : [])
          : t.list;
        for (const bc of list) {
          for (const p of DISCOVERY_PORTS) {
            try { t.sock.send(probe, p, bc); } catch (e) {}
          }
        }
      }
    };

    blast(false);
    /* 重发两轮：广播本身不可靠，虚拟网卡尤其容易丢第一包 */
    setTimeout(() => blast(true), 350);
    setTimeout(() => blast(true), 700);
    /* 外层必须比收包窗口宽，否则窗口没走完就被判「没找到」 */
    setTimeout(finish, 4500);
  });
}

module.exports = {
  init, setDataDir,
  prepare, open, readBlock, writeBlock, finish, cancel, status, resumable, flushAll,
  startSignal, sigStop, sigStatus, discover,
  BLOCK
};
