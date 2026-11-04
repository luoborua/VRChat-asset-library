const fs = require('fs');
const W = 32, H = 32;
const px = Buffer.alloc(W * H * 4);
function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = ((H - 1 - y) * W + x) * 4;
  px[i] = b; px[i + 1] = g; px[i + 2] = r; px[i + 3] = a;
}
// 背景：深色圆角方块
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const cx = Math.min(x, W - 1 - x), cy = Math.min(y, H - 1 - y);
  const corner = (cx < 4 && cy < 4) ? Math.hypot(4 - cx, 4 - cy) > 4 : false;
  if (corner) set(x, y, 0, 0, 0, 0);
  else set(x, y, 0x14, 0x17, 0x1d, 255);
}
// 包裹：箱体 + 顶盖 + 中缝
const L = 0xad, L2 = 0xd6;
for (let y = 11; y <= 24; y++) { set(8, y, L2, L2, L2); set(23, y, L2, L2, L2); }
for (let x = 8; x <= 23; x++) { set(x, 11, L2, L2, L2); set(x, 24, L2, L2, L2); }
for (let x = 6; x <= 25; x++) set(x, 8, L, L, L);
for (let x = 8; x <= 23; x++) set(x, 9, L, L, L);
set(7, 9, L, L, L); set(24, 9, L, L, L);
for (let y = 5; y <= 8; y++) { set(15, y, L, L, L); set(16, y, L, L, L); }
for (let y = 9; y <= 24; y++) { set(15, y, L, L, L); set(16, y, L, L, L); }

const maskRowBytes = 4;
const mask = Buffer.alloc(maskRowBytes * H, 0);
const dib = Buffer.alloc(40);
dib.writeUInt32LE(40, 0);
dib.writeInt32LE(W, 4);
dib.writeInt32LE(H * 2, 8);
dib.writeUInt16LE(1, 12);
dib.writeUInt16LE(32, 14);
dib.writeUInt32LE(0, 16);
dib.writeUInt32LE(W * H * 4 + mask.length, 20);

const image = Buffer.concat([dib, px, mask]);
const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4);
const ent = Buffer.alloc(16);
ent.writeUInt8(W, 0); ent.writeUInt8(H, 1); ent.writeUInt8(0, 2); ent.writeUInt8(0, 3);
ent.writeUInt16LE(1, 4); ent.writeUInt16LE(32, 6);
ent.writeUInt32LE(image.length, 8); ent.writeUInt32LE(22, 12);

const out = process.argv[2];
fs.writeFileSync(out, Buffer.concat([dir, ent, image]));
console.log('icon.ico', fs.statSync(out).size, 'bytes');
