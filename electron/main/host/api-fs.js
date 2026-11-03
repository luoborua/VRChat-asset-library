/* 文件系统接口：与 VRCLibHost 的 /api/{exists,readText,writeFile,readFileBase64,mkdir,delete,move,copy,open,scan} 完全同契约 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { shell } = require('electron');

/** 目录不存在就逐级创建（宿主不要指望调用方先 mkdir） */
async function mkdirp(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/** 注意签名：路由传的是整个 payload（{path}），不是路径字符串 */
async function exists({ path: p }) {
  if (!p) throw new Error('缺少 path');
  try {
    const st = await fsp.stat(p);
    return { ok: true, kind: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs };
  } catch {
    return { ok: true, kind: 'missing' };
  }
}

const TEXT_LIMIT = 64 * 1024 * 1024;

async function readText({ path: p }) {
  const st = await fsp.stat(p);
  if (!st.isFile()) throw new Error('不是文件：' + p);
  if (st.size > TEXT_LIMIT) throw new Error('文件过大（>64MB）：' + p);
  return { ok: true, text: await fsp.readFile(p, 'utf8'), size: st.size };
}

/** v4.3.2：readFileBase64 以前没有上限 —— 传一个几 GB 的文件进来，base64 会先把它读进内存、
 *  再膨胀 4/3 变成字符串、再序列化一次，进程直接 OOM。
 *  128MB 足以覆盖封面 / 图集 / 清单这些真实用途；真要大文件请走 copy / download / pack。 */
const B64_LIMIT = 128 * 1024 * 1024;

async function readFileBase64({ path: p }) {
  const st = await fsp.stat(p);
  if (!st.isFile()) throw new Error('不是文件：' + p);
  if (st.size > B64_LIMIT) {
    throw new Error('文件过大（' + Math.round(st.size / 1048576) + 'MB，上限 128MB）：' + p
      + '。大文件请用复制 / 下载 / 素材包，不要整份读进内存。');
  }
  const buf = await fsp.readFile(p);
  return { ok: true, dataBase64: buf.toString('base64'), size: buf.length };
}

async function writeFile({ path: p, dataBase64 }) {
  if (typeof p !== 'string' || !p) throw new Error('缺少 path');
  if (typeof dataBase64 !== 'string') throw new Error('缺少 dataBase64');
  const buf = Buffer.from(dataBase64, 'base64');
  await mkdirp(path.dirname(p));
  await fsp.writeFile(p, buf);
  return { ok: true, size: buf.length, path: p };
}

async function mkdir({ path: p }) {
  if (typeof p !== 'string' || !p) throw new Error('缺少 path');
  await mkdirp(p);
  return { ok: true, path: p };
}

/** 删除带安全阀：拒绝盘符根、拒绝过短路径（与宿主行为一致） */
async function remove({ path: p }) {
  const s = String(p || '');
  if (!s) throw new Error('缺少 path');
  if (/^[a-zA-Z]:[\\/]?$/.test(s) || s.replace(/[\\/]+/g, '').length < 4) {
    throw new Error('拒绝删除：路径过短或为盘符根（' + s + '）');
  }
  await fsp.rm(s, { recursive: true, force: true });
  return { ok: true, path: s };
}

async function move({ src, dst }) {
  if (!src || !dst) throw new Error('缺少 src/dst');
  if (await pathExists(dst)) throw new Error('目标已存在，拒绝覆盖：' + dst);
  await mkdirp(path.dirname(dst));
  try {
    await fsp.rename(src, dst);
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      await fsp.cp(src, dst, { recursive: true });
      await fsp.rm(src, { recursive: true, force: true });
    } else throw e;
  }
  return { ok: true, src, dst };
}

async function copy({ src, dst }) {
  if (!src || !dst) throw new Error('缺少 src/dst');
  await mkdirp(path.dirname(dst));
  await fsp.cp(src, dst, { recursive: true, force: true });
  return { ok: true, src, dst };
}

async function open({ path: p }) {
  const st = await fsp.stat(p).catch(() => null);
  if (!st) throw new Error('路径不存在：' + p);
  if (st.isDirectory()) {
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  } else {
    shell.showItemInFolder(p);
  }
  return { ok: true };
}

async function pathExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/** 目录树：rel 为相对 path 的 Windows 风格相对路径；maxDepth=0 表示不限 */
async function scan({ path: root, maxDepth }) {
  if (typeof root !== 'string' || !root) throw new Error('缺少 path');
  const st = await fsp.stat(root).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error('目录不存在：' + root);

  const limit = Number(maxDepth) > 0 ? Number(maxDepth) : Infinity;
  const entries = [];

  async function walk(dir, rel, depth) {
    if (depth > limit) return;
    let list;
    try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      const childRel = rel ? rel + '\\' + d.name : d.name;
      let size = 0;
      let mtime = 0;
      try {
        const s = await fsp.stat(path.join(dir, d.name));
        size = s.size; mtime = s.mtimeMs;
      } catch { /* 单个项读不到不影响整棵树 */ }
      entries.push({
        name: d.name,
        kind: d.isDirectory() ? 'directory' : 'file',
        size, mtime, rel: childRel
      });
      if (d.isDirectory() && depth < limit) await walk(path.join(dir, d.name), childRel, depth + 1);
    }
  }

  await walk(root, '', 1);
  return { ok: true, entries, root };
}

function isDirectorySync(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

module.exports = { mkdirp, exists, readText, readFileBase64, writeFile, mkdir, remove, move, copy, open, scan, isDirectorySync };
