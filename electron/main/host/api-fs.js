/* 文件系统接口：exists / readText / readFileBase64 / writeFile / mkdir / remove / trash /
 * move / copy / open / scan，返回体与宿主 HTTP 接口同一形状。
 * 与谁交互：bridge.js 与 server.js 的路由表按整个 payload 调用；写入前过 guard 的路径护栏。
 * 边界：不判业务、不决定路径归属；超限读取直接报错，让调用方改用复制 / 下载 / 素材包。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { shell } = require('electron');
const guard = require('./guard.js');

/** 目录不存在就逐级创建，调用方不必先建父目录 */
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

/* base64 读入必须有上限：几 GB 的文件会先读进内存、再膨胀 4/3、再序列化一次，直接 OOM。
 * 128MB 覆盖封面 / 图集 / 清单这些真实用途，更大的请走 copy / download / pack。 */
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

/** 删除带安全阀：拒绝盘符根与过短路径，一个路径参数不该能把整块盘删掉 */
async function remove({ path: p }) {
  const s = String(p || '');
  if (!s) throw new Error('缺少 path');
  if (/^[a-zA-Z]:[\\/]?$/.test(s) || s.replace(/[\\/]+/g, '').length < 4) {
    throw new Error('拒绝删除：路径过短或为盘符根（' + s + '）');
  }
  guard.assertWritable(s);
  await fsp.rm(s, { recursive: true, force: true });
  return { ok: true, path: s };
}

/** 移进系统回收站（可撤回）。用在「本地文件」删错文件这类用户明确要删、但可能后悔的动作上。
 *  护栏与 remove 一样；回收站不可用时抛错，由渲染层问用户要不要改成永久删除。 */
async function trash({ path: p }) {
  const s = String(p || '');
  if (!s) throw new Error('缺少 path');
  if (/^[a-zA-Z]:[\\/]?$/.test(s) || s.replace(/[\\/]+/g, '').length < 4) {
    throw new Error('拒绝删除：路径过短或为盘符根（' + s + '）');
  }
  guard.assertWritable(s);
  if (!(await pathExists(s))) throw new Error('文件已经不在了：' + s);
  await shell.trashItem(s);
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

/** 目录树：rel 为相对 path 的 Windows 风格相对路径；maxDepth=0 表示不限深度 */
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

module.exports = { mkdirp, exists, readText, readFileBase64, writeFile, mkdir, remove, trash, move, copy, open, scan, isDirectorySync };
