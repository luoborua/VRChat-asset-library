/* 数据目录搬家与启动清扫：体检、复制校验、清理旧目录、打扫被中断的解压目录。
 * 与谁交互：main.js 的 data:* IPC 调进来，进度帧推给渲染层的进度窗；
 * 步骤由渲染层（80-settings.js）编排：复制 → 改指针重开库 → 清旧目录。
 * 边界：只搬固定清单里的重型数据；settings.json 是指针，任何情况下都不碰。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/** 会跟着数据目录走的东西 */
const HEAVY_FILES = [
  'library.db', 'download-queue.json', 'assets.json', 'assets.json.bak',
  'workbench.json', 'pending-cleanup.json', 'extract-roots.json'
];
const HEAVY_DIRS = ['covers', 'gallery', 'transfers'];
/** 判断「这里已经有数据了」的标志 */
const MARKERS = ['library.db', 'assets.json'];
/** 待清理目录最多留 7 天（Unity 一周都没回执，就是不会再处理了） */
const CLEANUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function norm(p) {
  return String(p == null ? '' : p).trim().replace(/[\\/]+$/, '');
}

function samePath(a, b) {
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

/** 按路径分段比较，不是字符串前缀（G:\a-evil 不算在 G:\a 下） */
function isUnder(child, parent) {
  const c = path.resolve(norm(child)).toLowerCase().split(/[\\/]+/).filter(Boolean);
  const p = path.resolve(norm(parent)).toLowerCase().split(/[\\/]+/).filter(Boolean);
  if (!p.length || p.length > c.length) return false;
  for (let i = 0; i < p.length; i++) if (p[i] !== c[i]) return false;
  return true;
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch (e) { return false; }
}

/** 递归统计文件数与总字节（异步：目录大了也不能卡住主进程） */
async function scanStats(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = await fsp.readdir(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else {
        try {
          const st = await fsp.stat(p);
          files += 1;
          bytes += st.size;
        } catch (err) { /* 读不到就不算，不让单个坏项中断整棵树的统计 */ }
      }
    }
  }
  return { files, bytes };
}

async function isDirEmpty(dir) {
  try {
    const ents = await fsp.readdir(dir);
    return ents.length === 0;
  } catch (e) {
    return true;
  }
}

async function hasData(dir) {
  for (const m of MARKERS) {
    if (await exists(path.join(dir, m))) return true;
  }
  return false;
}

/* ---------------- /api 对应的三个命令 ---------------- */

/** 体检：目录在不在、多少文件多大、有没有现成的库、空不空 */
async function scan(dir) {
  const d = norm(dir);
  if (!d) return { ok: false, error: '目录为空' };
  const ex = await exists(d);
  const st = ex ? await scanStats(d) : { files: 0, bytes: 0 };
  return {
    ok: true,
    exists: ex,
    files: st.files,
    bytes: st.bytes,
    hasData: ex && (await hasData(d)),
    empty: !ex || (await isDirEmpty(d))
  };
}

/** 递归复制，每落一个文件发一条进度帧（frame 结构固定为 phase/done/total/name） */
async function copyDir(from, to, emit, cursor) {
  await fsp.mkdir(to, { recursive: true });
  const ents = await fsp.readdir(from, { withFileTypes: true });
  for (const e of ents) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) {
      await copyDir(src, dst, emit, cursor);
    } else {
      await fsp.copyFile(src, dst);
      cursor.done += 1;
      emit({ phase: 'copy', done: cursor.done, total: cursor.total, name: e.name });
    }
  }
}

/** 复制前后校验：源与目标的文件数、总字节必须一致 */
async function verify(from, to) {
  let files = 0;
  let bytes = 0;
  for (const name of HEAVY_FILES) {
    const s = path.join(from, name);
    if (!(await exists(s))) continue;
    const d = path.join(to, name);
    if (!(await exists(d))) return { error: '校验失败：' + d + ' 不存在' };
    const sm = await fsp.stat(s);
    const dm = await fsp.stat(d);
    if (sm.size !== dm.size) {
      return { error: '校验失败：' + name + ' 大小不一致（' + sm.size + ' ≠ ' + dm.size + '）' };
    }
    files += 1;
    bytes += dm.size;
  }
  for (const name of HEAVY_DIRS) {
    const s = path.join(from, name);
    if (!(await exists(s))) continue;
    const d = path.join(to, name);
    const sf = await scanStats(s);
    const df = await scanStats(d);
    if (sf.files !== df.files || sf.bytes !== df.bytes) {
      return {
        error: '校验失败：' + name + ' 内容不完整（' + df.files + '/' + sf.files + ' 个文件，' +
          df.bytes + '/' + sf.bytes + ' 字节）'
      };
    }
    files += df.files;
    bytes += df.bytes;
  }
  return { files, bytes };
}

/**
 * 搬家。opts: { from, to, emit(frame), closeDb() }
 * 调用前必须先 closeDb —— WAL 下库文件与 -wal 是两份，开着连接复制会拿到不一致的快照。
 */
async function migrate(opts) {
  const a = norm(opts && opts.from);
  const b = norm(opts && opts.to);
  const emit = (typeof (opts && opts.emit) === 'function') ? opts.emit : function () {};
  if (!a || !b) return { ok: false, error: '源目录或目标目录为空' };
  if (samePath(a, b)) return { ok: true, moved: false, reason: 'same', files: 0, bytes: 0 };
  if (isUnder(b, a)) return { ok: false, error: '目标目录不能放在源目录里面' };
  if (isUnder(a, b)) return { ok: false, error: '源目录已经在目标目录里了' };
  if ((await exists(b)) && (await hasData(b))) {
    return { ok: false, error: '目标目录里已经有一份素材库数据，请换一个空文件夹（或先备份后清空）' };
  }
  /* 源目录没有数据（首次选择）：只建目录即可 */
  if (!(await exists(a)) || !(await hasData(a))) {
    try { await fsp.mkdir(b, { recursive: true }); } catch (e) {
      return { ok: false, error: '创建目录失败：' + ((e && e.message) || e) };
    }
    emit({ phase: 'done', done: 0, total: 0 });
    return { ok: true, moved: false, files: 0, bytes: 0 };
  }

  if (typeof opts.closeDb === 'function') {
    try { opts.closeDb(); } catch (e) {}
  }

  /* 先数一遍，好让进度条有个总数 */
  let total = 0;
  for (const n of HEAVY_FILES) if (await exists(path.join(a, n))) total += 1;
  for (const n of HEAVY_DIRS) {
    const p = path.join(a, n);
    if (await exists(p)) total += (await scanStats(p)).files;
  }
  emit({ phase: 'start', done: 0, total: total });

  try { await fsp.mkdir(b, { recursive: true }); } catch (e) {
    return { ok: false, error: '创建目录失败：' + ((e && e.message) || e) };
  }

  const cursor = { done: 0, total: total };
  for (const n of HEAVY_FILES) {
    const s = path.join(a, n);
    if (!(await exists(s))) continue;
    try { await fsp.copyFile(s, path.join(b, n)); } catch (e) {
      return { ok: false, error: '复制 ' + n + ' 失败：' + ((e && e.message) || e) };
    }
    cursor.done += 1;
    emit({ phase: 'copy', done: cursor.done, total: total, name: n });
  }
  for (const n of HEAVY_DIRS) {
    const s = path.join(a, n);
    if (!(await exists(s))) continue;
    try { await copyDir(s, path.join(b, n), emit, cursor); } catch (e) {
      return { ok: false, error: '复制 ' + n + ' 失败：' + ((e && e.message) || e) };
    }
  }

  emit({ phase: 'verify', done: cursor.done, total: total });
  const v = await verify(a, b);
  if (v.error) return { ok: false, error: v.error };
  emit({ phase: 'done', done: total, total: total });
  return { ok: true, moved: true, files: v.files, bytes: v.bytes, from: norm(a), to: norm(b) };
}

/** 删除旧目录里的重型数据。**绝不碰 settings.json**（它是指针，删了下次启动就找不到库）。 */
async function cleanup(dir) {
  const d = norm(dir);
  if (!d || !(await exists(d))) return { ok: true, removed: 0 };
  let removed = 0;
  for (const name of HEAVY_FILES) {
    // WAL 附属文件也一并清掉
    for (const f of [name, name + '-wal', name + '-shm']) {
      const p = path.join(d, f);
      if (await exists(p)) {
        try { await fsp.unlink(p); removed += 1; } catch (e) {}
      }
    }
  }
  for (const name of HEAVY_DIRS) {
    const p = path.join(d, name);
    if (await exists(p)) {
      try { await fsp.rm(p, { recursive: true, force: true }); removed += 1; } catch (e) {}
    }
  }
  return { ok: true, removed: removed, dir: d };
}

/* ---------------- 启动清扫：被中断的导入留下的解压目录 ---------------- */

function cmpKey(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function readJsonMap(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch (e) {
    return {};
  }
}

function writeJsonMap(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {}
}

/** 只删「看起来是解压目录」的路径：绝对路径、有层级、是目录、不是盘符根 */
function safeRemoveDir(p) {
  const d = norm(p);
  if (!d) return false;
  if (!path.isAbsolute(d)) return false;
  const parts = d.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return false;      // C:\ 这种根一律不碰
  try {
    if (!fs.statSync(d).isDirectory()) return false;
  } catch (e) {
    return false;
  }
  try { fs.rmSync(d, { recursive: true, force: true }); return true; } catch (e) { return false; }
}

/**
 * 启动清扫被中断的导入留下的临时解压目录：过期的删、仍挂着的留、
 * 解压根表里不在保留集合的一律当孤儿删掉并摘表。
 */
function sweepOrphanExtracts(dataDir) {
  const removed = { dirs: 0, kept: 0 };
  const pendingPath = path.join(dataDir, 'pending-cleanup.json');
  const rootsPath = path.join(dataDir, 'extract-roots.json');

  const pending = readJsonMap(pendingPath);
  const now = Date.now();
  const stale = [];
  for (const dir of Object.keys(pending)) {
    const entry = pending[dir] || {};
    const at = Number(entry.at) || 0;
    if (!at || now - at > CLEANUP_MAX_AGE_MS) stale.push(dir);
  }
  for (const dir of stale) delete pending[dir];
  if (stale.length) writeJsonMap(pendingPath, pending);
  for (const dir of stale) if (safeRemoveDir(dir)) removed.dirs += 1;

  const keep = new Set(Object.keys(pending).map(cmpKey));

  const roots = readJsonMap(rootsPath);
  const next = {};
  for (const k of Object.keys(roots)) {
    const dir = String(roots[k] || '');
    if (!dir) continue;
    if (keep.has(cmpKey(dir))) {
      next[k] = roots[k];
      removed.kept += 1;
      continue;
    }
    if (safeRemoveDir(dir)) removed.dirs += 1;
  }
  writeJsonMap(rootsPath, next);
  return removed;
}

module.exports = {
  scan, migrate, cleanup, sweepOrphanExtracts,
  HEAVY_FILES, HEAVY_DIRS, MARKERS
};
