/* 极简 ZIP 读写（零依赖）。
 *
 * 为什么自己写而不装 archiver/jszip：
 *   1. 只需要两种最基础的能力 —— 全 store 写、store/deflate 读；
 *   2. 素材包动辄几百 MB 到几 GB，必须**流式**，不能整包读进内存；
 *   3. 不引第三方依赖，离线可构建，也不会因为 Electron 升级丢传递依赖。
 *
 * 写：一律 store（不压缩）。素材本身已经是 zip/unitypackage，再压一遍只耗 CPU、几乎不减体积。
 *     用 data descriptor（bit 3）把 CRC 写在数据后面，避免为了算 CRC 把每个文件读两遍。
 * 读：支持 method 0（store）与 8（deflate），用 zlib.inflateRaw 流式解。
 *
 * 已知边界：总大小 > 4GB 会需要 ZIP64，这里直接拒绝并提示分批导出（不做 ZIP64）。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { once } = require('node:events');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DD = 0x08074b50;

const FLAG_UTF8 = 0x0800;
const FLAG_DD = 0x0008;
const MAX_TOTAL = 4 * 1024 * 1024 * 1024 - 1;   // 40 亿字节，普通 zip 的上限

/* ---------------- CRC32 ---------------- */

const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crcUpdate(crc, buf) {
  let c = crc;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return c;
}
function crcInit() { return 0xFFFFFFFF; }
function crcFinal(c) { return (c ^ 0xFFFFFFFF) >>> 0; }

/* ---------------- 时间戳 ---------------- */

function dosDateTime(d) {
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { time: time & 0xFFFF, date: date & 0xFFFF };
}

/* ---------------- 路径安全 ---------------- */

/** zip 内路径统一成正斜杠；拒绝绝对路径、盘符、上跳 */
function safeEntryName(name) {
  let s = String(name || '').replace(/\\/g, '/').trim();
  if (!s) throw new Error('空的条目名');
  if (/^[a-zA-Z]:/.test(s) || s.startsWith('/')) throw new Error('条目名不能是绝对路径：' + s);
  const parts = s.split('/').filter(Boolean);
  for (const p of parts) {
    if (p === '.' || p === '..') throw new Error('条目名不能包含上跳：' + s);
  }
  return parts.join('/');
}

/* ==================================================================== */
/* 写                                                                   */
/* ==================================================================== */

function createZipWriter(filePath) {
  let out = null;
  let offset = 0;
  const entries = [];

  function u16(n) { const b = Buffer.allocUnsafe(2); b.writeUInt16LE(n >>> 0, 0); return b; }
  function u32(n) { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(n >>> 0, 0); return b; }

  async function write(buf) {
    offset += buf.length;
    if (!out.write(buf)) await once(out, 'drain');
  }

  async function open() {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    out = fs.createWriteStream(filePath, { flags: 'w' });
    await once(out, 'open');
  }

  /** 把一个本地文件写进包（流式） */
  async function addFile(entryName, absPath) {
    const name = safeEntryName(entryName);
    const st = await fsp.stat(absPath);
    if (!st.isFile()) throw new Error('不是文件：' + absPath);
    if (offset + st.size + 512 > MAX_TOTAL) {
      throw new Error('素材包超过 4GB 上限（' + path.basename(absPath) + ' 放不下），请分批导出');
    }

    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosDateTime(st.mtime || new Date());
    const localOffset = offset;

    // local file header：crc/尺寸先填 0，真正的值写在数据后面的 data descriptor
    await write(Buffer.concat([
      u32(SIG_LOCAL), u16(20), u16(FLAG_UTF8 | FLAG_DD), u16(0),
      u16(time), u16(date), u32(0), u32(0), u32(0),
      u16(nameBuf.length), u16(0), nameBuf
    ]));

    let crc = crcInit();
    let size = 0;
    const rs = fs.createReadStream(absPath, { highWaterMark: 1 << 20 });
    try {
      for await (const chunk of rs) {
        crc = crcUpdate(crc, chunk);
        size += chunk.length;
        await write(chunk);
      }
    } catch (e) {
      rs.destroy();
      throw e;
    }
    const c = crcFinal(crc);

    await write(Buffer.concat([u32(SIG_DD), u32(c), u32(size), u32(size)]));

    entries.push({ name: nameBuf, crc: c, size, offset: localOffset, time, date });
    return { size, crc: c };
  }

  /** 把内存里的内容写进包（清单这种小文件用） */
  async function addBuffer(entryName, buf) {
    const name = safeEntryName(entryName);
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosDateTime(new Date());
    const localOffset = offset;
    const c = crcFinal(crcUpdate(crcInit(), buf));

    await write(Buffer.concat([
      u32(SIG_LOCAL), u16(20), u16(FLAG_UTF8 | FLAG_DD), u16(0),
      u16(time), u16(date), u32(0), u32(0), u32(0),
      u16(nameBuf.length), u16(0), nameBuf
    ]));
    await write(buf);
    await write(Buffer.concat([u32(SIG_DD), u32(c), u32(buf.length), u32(buf.length)]));

    entries.push({ name: nameBuf, crc: c, size: buf.length, offset: localOffset, time, date });
    return { size: buf.length, crc: c };
  }

  async function close() {
    const cdStart = offset;
    for (const e of entries) {
      await write(Buffer.concat([
        u32(SIG_CENTRAL), u16(20), u16(20), u16(FLAG_UTF8 | FLAG_DD), u16(0),
        u16(e.time), u16(e.date), u32(e.crc), u32(e.size), u32(e.size),
        u16(e.name.length), u16(0), u16(0), u16(0), u16(0), u32(0),
        u32(e.offset), e.name
      ]));
    }
    const cdSize = offset - cdStart;
    await write(Buffer.concat([
      u32(SIG_EOCD), u16(0), u16(0), u16(entries.length), u16(entries.length),
      u32(cdSize), u32(cdStart), u16(0)
    ]));
    await new Promise(function (resolve, reject) {
      out.end(function () { resolve(); });
      out.on('error', reject);
    });
    return { entries: entries.length, bytes: offset };
  }

  async function abort() {
    try { if (out) out.destroy(); } catch (e) {}
    try { await fsp.unlink(filePath); } catch (e) {}
  }

  return { open, addFile, addBuffer, close, abort };
}

/* ==================================================================== */
/* 读                                                                   */
/* ==================================================================== */

/** 读 EOCD，拿到中央目录的位置与条目数 */
async function readEocd(fh, fileSize) {
  const tailLen = Math.min(fileSize, 66000);
  const buf = Buffer.allocUnsafe(tailLen);
  await fh.read(buf, 0, tailLen, fileSize - tailLen);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      return {
        count: buf.readUInt16LE(i + 10),
        cdSize: buf.readUInt32LE(i + 12),
        cdOffset: buf.readUInt32LE(i + 16)
      };
    }
  }
  throw new Error('不是有效的 zip 文件（找不到目录结尾记录）');
}

/** 读整个包的条目表（不解压，只看目录） */
async function listEntries(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const st = await fh.stat();
    const eo = await readEocd(fh, st.size);
    const cd = Buffer.allocUnsafe(eo.cdSize);
    await fh.read(cd, 0, eo.cdSize, eo.cdOffset);

    const out = [];
    let p = 0;
    for (let i = 0; i < eo.count; i++) {
      if (cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('中央目录损坏（第 ' + (i + 1) + ' 项）');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compSize = cd.readUInt32LE(p + 20);
      const uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.slice(p + 46, p + 46 + nameLen).toString('utf8');
      out.push({ name, method, crc, compSize, uncompSize, localOffset, flags });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** 从包里解出一个条目到磁盘（流式） */
async function extractEntry(filePath, entry, outPath) {
  const fh = await fsp.open(filePath, 'r');
  let rs = null;
  try {
    // local header 的 nameLen / extraLen 可能与中央目录不同，必须按 local 的来定位数据起点
    const head = Buffer.allocUnsafe(30);
    await fh.read(head, 0, 30, entry.localOffset);
    if (head.readUInt32LE(0) !== SIG_LOCAL) throw new Error('条目头损坏：' + entry.name);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const dataStart = entry.localOffset + 30 + nameLen + extraLen;

    await fsp.mkdir(path.dirname(outPath), { recursive: true });

    /* 空文件（0 字节）：没有数据段，直接落一个空文件。
     * 不能走下面的 createReadStream —— 那会算出 end = start - 1，Node 直接抛
     * "Cannot read properties of undefined (reading 'Symbol(kState)')"。 */
    if (!entry.compSize) {
      await fsp.writeFile(outPath, Buffer.alloc(0));
      return { outPath, size: 0 };
    }

    const ws = fs.createWriteStream(outPath, { flags: 'w' });
    await once(ws, 'open');

    const raw = fh.createReadStream({ start: dataStart, end: dataStart + entry.compSize - 1, autoClose: false });
    rs = raw;
    const src = entry.method === 8 ? raw.pipe(zlib.createInflateRaw()) : raw;

    let written = 0;
    let crc = crcInit();
    try {
      for await (const chunk of src) {
        crc = crcUpdate(crc, chunk);
        written += chunk.length;
        if (!ws.write(chunk)) await once(ws, 'drain');
      }
    } finally {
      try { raw.destroy(); } catch (e) {}
    }
    await new Promise(function (resolve, reject) {
      ws.end(function () { resolve(); });
      ws.on('error', reject);
    });

    if (written !== entry.uncompSize) {
      throw new Error('解压后大小不符（' + entry.name + '：期望 ' + entry.uncompSize + '，实际 ' + written + '）');
    }
    if (crcFinal(crc) !== (entry.crc >>> 0)) {
      throw new Error('校验失败（' + entry.name + '）—— 文件可能在传输中损坏');
    }
    return { outPath, size: written };
  } finally {
    try { if (rs) rs.destroy(); } catch (e) {}
    await fh.close().catch(function () {});
  }
}

/** 只把某个小条目读进内存（清单用） */
async function readEntryBuffer(filePath, entry, maxBytes) {
  const limit = maxBytes || (8 * 1024 * 1024);
  if (entry.uncompSize > limit) throw new Error('条目过大，拒绝载入内存：' + entry.name);
  const tmp = path.join(require('node:os').tmpdir(), 'vrcpack-' + process.pid + '-' + Date.now() + '.tmp');
  try {
    await extractEntry(filePath, entry, tmp);
    return await fsp.readFile(tmp);
  } finally {
    try { await fsp.unlink(tmp); } catch (e) {}
  }
}

module.exports = {
  createZipWriter,
  listEntries,
  extractEntry,
  readEntryBuffer,
  safeEntryName,
  crcUpdate, crcInit, crcFinal
};
