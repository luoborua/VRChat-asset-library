/* 运行时生成窗口与托盘图标（RGBA PNG），避免工程里塞二进制素材。
 * 只画一个与页面 favicon 一致的盒形标记，底色用主题色；
 * 边界：不做多尺寸图标集，也不读外部图片。
 */
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 生成圆角方块 + 盒形描边的 RGBA PNG，窗口与托盘共用 */
function makeIconPng(size = 32) {
  const px = Buffer.alloc(size * size * 4, 0);
  const r = size * 0.22;
  const inset = size * 0.16;

  const inRounded = (x, y, x0, y0, x1, y1, rad) => {
    if (x < x0 || y < y0 || x > x1 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + rad), x1 - rad);
    const cy = Math.min(Math.max(y, y0 + rad), y1 - rad);
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= rad * rad;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRounded(x + 0.5, y + 0.5, 0.5, 0.5, size - 0.5, size - 0.5, r)) continue;
      // 底色：主题蓝 → 边缘略深，做出一点体积感
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      const shade = edge < 1.5 ? 0.78 : 1;
      px[i] = Math.round(109 * shade);
      px[i + 1] = Math.round(140 * shade);
      px[i + 2] = Math.round(255 * shade);
      px[i + 3] = 255;

      // 盒子轮廓（描边）
      const x0 = inset, y0 = inset * 1.15, x1 = size - inset, y1 = size - inset * 0.9;
      const nearBox = inRounded(x + 0.5, y + 0.5, x0, y0, x1, y1, size * 0.06) &&
        !inRounded(x + 0.5, y + 0.5, x0 + 2, y0 + 2, x1 - 2, y1 - 2, size * 0.04);
      const lid = Math.abs((y + 0.5) - (y0 + (y1 - y0) * 0.42)) < 1.2 && x > x0 + 1 && x < x1 - 1;
      if (nearBox || lid) {
        px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 255;
      }
    }
  }

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { makeIconPng };
