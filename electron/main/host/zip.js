/* 极简 ZIP 读写，零依赖：写一律 store，读支持 store 与 deflate。
 * 与谁交互：api-pack.js 用它生成 / 查看 / 解包 .vrcpack；全程流式，不整包读进内存。
 * 写侧用 data descriptor 把 CRC 写在数据之后，避免为了算 CRC 把每个文件读两遍。
 * 边界：不做 ZIP64，总大小超过 4GB 直接拒绝；不写目录条目，也不保留 Unix 权限位。
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

/* = */
/* 写                                                                   */
/* = */

function createZipWriter(filePath) {
  let out = null;
  let offset = 0;
  const entries = [];

  function u16(n) { const b = Buffer.allocUnsafe(2); b.writeUInt16LE(n >>> 0, 0); return b; }
  function u32(n) { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(n >>> 0, 0); return b; }

  async function write(buf) {
    /* abort 之后可能还有一次写排在路上（取消就是随时发生的）。
     * 直接 out.write 会抛 ERR_STREAM_DESTROYED，那个错误不在任何 await 链上，
     * 会变成主进程的 uncaughtException。这里当成普通失败抛出去。 */
    if (!out || out.destroyed) throw new Error('写入已中止');
    offset += buf.length;
    if (!out.write(buf)) await once(out, 'drain');
  }

  async function open() {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    out = fs.createWriteStream(filePath, { flags: 'w' });
    await once(out, 'open');
  }

  /** 把一个本地文件写进包（流式） */
  async function addFile(entryName, absPath, onChunk) {
    const name = safeEntryName(entryName);
    const st = await fsp.stat(absPath);
    if (!st.isFile()) throw new Error('不是文件：' + absPath);
    if (offset + st.size + 512 > MAX_TOTAL) {
      throw new Error('素材包超过 4GB 上限（' + path.basename(absPath) + ' 放不下），请分批导出');
    }

    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosDateTime(st.mtime || new Date());
    const localOffset = offset;

    // local file header：crc / 尺寸先填 0，真正的值写在数据后面的 data descriptor
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
        /* onChunk 每 1MB 调一次：取消要能在一个大文件写到一半时生效，
         * 只在文件之间检查的话，用户点取消后还得等几百 MB 写完。 */
        if (onChunk) onChunk();
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
    if (out) {
      /* 销毁那一刻缓冲区里可能还有块，流会 emit 一个 error（ERR_STREAM_DESTROYED）。
       * 产物本来就要丢掉，这里挂个空监听，别让它冒成 uncaughtException。 */
      try { out.on('error', function () {}); } catch (e) {}
      try { out.destroy(); } catch (e) {}
      out = null;
    }
    try { await fsp.unlink(filePath); } catch (e) {}
  }

  return { open, addFile, addBuffer, close, abort };
}

/* = */
/* 读                                                                   */
/* = */

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
    /* 声明值来自文件本身，不能直接拿去分配内存：4GB 的 cdSize 会立刻抛 RangeError，
     * 越界的 cdOffset 会读出一段垃圾当目录。 */
    if (!eo.count) throw new Error('包里没有条目');
    if (eo.cdSize <= 0 || eo.cdOffset <= 0 || eo.cdOffset + eo.cdSize > st.size) {
      throw new Error('中央目录越界（包可能已损坏或被截断）');
    }
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
      /* Windows 的 Compress-Archive 写的是反斜杠（app\electron\）：统一成正斜杠。
       * 不统一的话，调用方按 '/' 判「目录条目」会漏判，把目录当成 0 字节文件建出来。 */
      const name = cd.slice(p + 46, p + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
      out.push({ name, method, crc, compSize, uncompSize, localOffset, flags });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** 从包里解出一个条目到磁盘（流式） */
async function extractEntry(filePath, entry, outPath, onChunk) {
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

    /* 0 字节条目没有数据段，直接落一个空文件：走 createReadStream 会算出
     * end = start - 1，Node 直接抛异常。 */
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
        if (onChunk) onChunk();
        crc = crcUpdate(crc, chunk);
        written += chunk.length;
        /* 解压炸弹：等写完再比对就已经落盘了，边写边卡上限 */
        if (written > entry.uncompSize) {
          try { ws.destroy(); } catch (e) {}
          try { await fsp.rm(outPath, { force: true }); } catch (e) {}
          throw new Error('解压后超过声明大小（' + entry.name + '），已中止');
        }
        if (!ws.write(chunk)) await once(ws, 'drain');
      }
    } catch (e) {
      /* 半途失败（取消最常走这条）：先关写流再抛。
       * Windows 上句柄不关，上层删这个半截文件会 EBUSY。 */
      try { ws.destroy(); } catch (e2) {}
      throw e;
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
