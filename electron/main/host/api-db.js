/* 主库读写：/api/db/{load,save,info}，落在数据根下的 library.db（SQLite）。
 * 与谁交互：bridge 路由调用；驱动用 Node 内置的 node:sqlite，不必带原生模块与 rebuild。
 * 表结构固定为 assets(id, ord, json, updated_at) + meta(k, v)，与库文件一一对应。
 * 边界：整库覆盖写（先删后插），不做增量同步，也不替调用方合并记录。
 */
const path = require('node:path');
const fsp = require('node:fs/promises');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { DatabaseSync = null; }

let dbPath = '';
let conn = null;
let lastError = '';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS assets (',
  '  id TEXT PRIMARY KEY,',
  '  ord INTEGER NOT NULL DEFAULT 0,',
  '  json TEXT NOT NULL,',
  '  updated_at TEXT NOT NULL DEFAULT \'\'',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_assets_ord ON assets(ord);',
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT \'\');'
].join(' ');

function init(dataDir) {
  close();
  dbPath = path.join(dataDir, 'library.db');
}

function open() {
  if (conn) return conn;
  if (!DatabaseSync) throw new Error('当前 Electron 的 Node 没有 node:sqlite，无法打开主库');
  conn = new DatabaseSync(dbPath);
  conn.exec(SCHEMA);
  return conn;
}

function close() {
  try { if (conn) conn.close(); } catch (e) {}
  conn = null;
}

function load() {
  try {
    const c = open();
    const rows = c.prepare('SELECT id, json FROM assets ORDER BY ord ASC').all();
    const assets = [];
    let skipped = 0;
    for (const r of rows) {
      try { assets.push(JSON.parse(r.json)); } catch (e) { skipped++; }
    }
    let at = '';
    try {
      const m = c.prepare('SELECT v FROM meta WHERE k = ?').get('at');
      if (m) at = m.v || '';
    } catch (e) {}
    /* count 是消耗方判断「首次运行还是空库」的唯一依据，不能省。
     * skipped 必须透出：有坏行时界面要进只读保护，否则下一次整库覆盖写会把丢掉的条目坐实。 */
    const out = { ok: true, count: assets.length, assets: assets, at: at, path: dbPath, skipped: skipped };
    if (skipped > 0) out.warning = '主库里有 ' + skipped + ' 条记录解析失败，已跳过';
    return out;
  } catch (e) {
    lastError = String((e && e.message) || e);
    return { ok: true, count: 0, assets: [], at: '', path: dbPath, skipped: 0, warning: '主库打开失败：' + lastError };
  }
}

function save(payload) {
  const list = (payload && Array.isArray(payload.assets)) ? payload.assets : [];
  const at = (payload && payload.at) || new Date().toISOString();
  try {
    const c = open();
    c.exec('BEGIN');
    try {
      c.exec('DELETE FROM assets');
      const ins = c.prepare('INSERT INTO assets (id, ord, json, updated_at) VALUES (?, ?, ?, ?)');
      for (let i = 0; i < list.length; i++) {
        const a = list[i] || {};
        const id = String(a.id || '');
        if (!id) continue;
        ins.run(id, i, JSON.stringify(a), at);
      }
      const up = c.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
      up.run('at', at);
      c.exec('COMMIT');
    } catch (e) {
      try { c.exec('ROLLBACK'); } catch (e2) {}
      throw e;
    }
    return { ok: true, count: list.length, written: list.length, at: at };
  } catch (e) {
    return { ok: false, error: '写入主库失败：' + String((e && e.message) || e) };
  }
}

function info() {
  let size = 0;
  let count = 0;
  try {
    const c = open();
    const r = c.prepare('SELECT COUNT(*) AS n FROM assets').get();
    count = (r && r.n) || 0;
  } catch (e) {}
  try {
    // 同步 stat：info 是低频调用，不值得为此引入异步
    size = require('node:fs').statSync(dbPath).size;
  } catch (e) {}
  return { ok: true, path: dbPath, count: count, size: size };
}

module.exports = { init, load, save, info, close };
