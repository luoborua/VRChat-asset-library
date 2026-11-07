/* 缩略图生成：thumb_ensure / thumb_batch，用 nativeImage 读 → 缩放 → 编码 JPEG。
 * 与谁交互：preload 的 thumb_ensure / thumb_batch 经 IPC 调进来，结果由渲染层按路径引用。
 * 边界：目标文件已存在就直接返回，不重复解码；单个失败只计数，不中断整批。
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const { nativeImage } = require('electron');

async function one(src, dst, max) {
  try {
    await fsp.access(dst);
    return { ok: true, path: dst, cached: true };
  } catch (e) { /* 不存在，继续生成 */ }
  const img = nativeImage.createFromPath(src);
  if (!img || img.isEmpty()) return { ok: false, error: '无法解码图片：' + src };
  const size = img.getSize();
  const w = size.width || 0, h = size.height || 0;
  const limit = Math.max(32, Math.min(4096, Number(max) || 400));
  const scale = Math.min(1, limit / Math.max(w, h, 1));
  const out = (scale < 1) ? img.resize({ width: Math.max(1, Math.round(w * scale)), quality: 'good' }) : img;
  const buf = out.toJPEG(82);
  if (!buf || !buf.length) return { ok: false, error: '缩略图编码失败：' + src };
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.writeFile(dst, buf);
  return { ok: true, path: dst, cached: false, width: Math.round(w * scale), height: Math.round(h * scale) };
}

async function ensure(p) {
  const src = String((p && p.src) || '');
  const dst = String((p && p.dst) || '');
  if (!src || !dst) return { ok: false, error: '缺少 src/dst' };
  return one(src, dst, p.max);
}

async function batch(p) {
  const items = Array.isArray(p && p.items) ? p.items : [];
  const max = (p && p.max) || 400;
  let done = 0, failed = 0;
  for (const it of items) {
    if (!it || !it.src || !it.dst) { failed++; continue; }
    try {
      const r = await one(it.src, it.dst, max);
      if (r && r.ok) done++; else failed++;
    } catch (e) { failed++; }
  }
  return { ok: true, done: done, failed: failed, total: items.length };
}

module.exports = { ensure, batch };
