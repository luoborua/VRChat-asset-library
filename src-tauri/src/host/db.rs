/* 素材主库（SQLite）。
 *
 * 为什么换掉 assets.json：
 *   旧实现整库是一个 JSON 文件，每次保存都要「序列化 → base64(+33%) → HTTP → 落盘」，
 *   于是有了 64MB 请求体上限和「容量悬崖」：素材一多，保存直接失败且无法自动恢复。
 *   现在每条素材一行，只有内容变了的行才写，写盘是毫秒级、没有体积上限。
 *
 * 兼容：
 *   首次启动若发现 vrclib-data\assets.json 且库是空的，自动整库导入并把原文件改名成
 *   assets.json.bak（不删，用户随时能翻出来）。settings.json 仍然是文件——它很小。
 */
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

pub struct DbState {
    conn: Mutex<Option<Connection>>,
    /// id → 内容哈希：用于跳过没变的行，避免整库重写
    hashes: Mutex<HashMap<String, u64>>,
    path: Mutex<String>,
}

impl Default for DbState {
    fn default() -> Self {
        Self {
            conn: Mutex::new(None),
            hashes: Mutex::new(HashMap::new()),
            path: Mutex::new(String::new()),
        }
    }
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

impl DbState {
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let db_path = dir.join("library.db");
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS assets (
                id         TEXT PRIMARY KEY,
                ord        INTEGER NOT NULL DEFAULT 0,
                json       TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT ''
             );
             CREATE INDEX IF NOT EXISTS idx_assets_ord ON assets(ord);
             CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '');",
        )
        .map_err(|e| e.to_string())?;

        let state = Self {
            conn: Mutex::new(Some(conn)),
            hashes: Mutex::new(HashMap::new()),
            path: Mutex::new(db_path.to_string_lossy().to_string()),
        };
        state.migrate_legacy(dir)?;
        Ok(state)
    }

    /// 首次启动：把老的 assets.json 整库搬进来，然后改名留底
    fn migrate_legacy(&self, dir: &Path) -> Result<(), String> {
        let legacy = dir.join("assets.json");
        if !legacy.exists() {
            return Ok(());
        }
        {
            let guard = self.conn.lock().unwrap();
            let conn = guard.as_ref().ok_or("数据库未就绪")?;
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if count > 0 {
                return Ok(());
            }
        }

        let text = match std::fs::read_to_string(&legacy) {
            Ok(t) => t,
            Err(_) => return Ok(()),
        };
        let j: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => return Ok(()), // 文件坏了就别动它，让用户自己修
        };
        let list = match j.get("assets").and_then(|x| x.as_array()) {
            Some(a) => a.clone(),
            None => return Ok(()),
        };
        let at = j.get("at").and_then(|x| x.as_str()).unwrap_or("").to_string();

        {
            let mut guard = self.conn.lock().unwrap();
            let conn = guard.as_mut().ok_or("数据库未就绪")?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            {
                let mut stmt = tx
                    .prepare("INSERT OR REPLACE INTO assets (id, ord, json, updated_at) VALUES (?1, ?2, ?3, ?4)")
                    .map_err(|e| e.to_string())?;
                for (i, a) in list.iter().enumerate() {
                    let id = a.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    if id.is_empty() {
                        continue;
                    }
                    let body = serde_json::to_string(a).map_err(|e| e.to_string())?;
                    stmt.execute(params![id, i as i64, body, at]).map_err(|e| e.to_string())?;
                }
            }
            tx.execute("INSERT OR REPLACE INTO meta (k, v) VALUES ('at', ?1)", params![at])
                .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        }

        let bak = dir.join("assets.json.bak");
        let _ = std::fs::rename(&legacy, &bak);
        Ok(())
    }

    pub fn info(&self) -> Value {
        let path = self.path.lock().unwrap().clone();
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let count: i64 = {
            let guard = self.conn.lock().unwrap();
            match guard.as_ref() {
                Some(c) => c.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0)).unwrap_or(0),
                None => 0,
            }
        };
        json!({ "ok": true, "path": path, "count": count, "size": size })
    }

    pub fn load(&self) -> Result<Value, String> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or("数据库未就绪")?;

        let mut stmt = conn
            .prepare("SELECT id, json FROM assets ORDER BY ord ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;

        let mut assets: Vec<Value> = Vec::new();
        let mut hashes: HashMap<String, u64> = HashMap::new();
        for row in rows.flatten() {
            let (id, body) = row;
            hashes.insert(id, fnv1a64(body.as_bytes()));
            if let Ok(v) = serde_json::from_str::<Value>(&body) {
                assets.push(v);
            }
        }
        *self.hashes.lock().unwrap() = hashes;

        let at: String = conn
            .query_row("SELECT v FROM meta WHERE k = 'at'", [], |r| r.get(0))
            .unwrap_or_default();

        Ok(json!({
            "ok": true,
            "assets": assets,
            "at": at,
            "count": assets.len(),
            "source": "db"
        }))
    }

    /// 保存整库：只写内容变了的行，删掉已不存在的 id
    pub fn save(&self, list: &[Value], at: &str) -> Result<Value, String> {
        let mut guard = self.conn.lock().unwrap();
        let conn = guard.as_mut().ok_or("数据库未就绪")?;
        let mut hashes = self.hashes.lock().unwrap();

        let mut next_hashes: HashMap<String, u64> = HashMap::new();
        let mut keep: HashSet<String> = HashSet::new();
        let mut written = 0usize;

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut up = tx
                .prepare("INSERT INTO assets (id, ord, json, updated_at) VALUES (?1, ?2, ?3, ?4)
                          ON CONFLICT(id) DO UPDATE SET ord = excluded.ord, json = excluded.json, updated_at = excluded.updated_at")
                .map_err(|e| e.to_string())?;
            let mut up_ord = tx
                .prepare("UPDATE assets SET ord = ?1, updated_at = ?2 WHERE id = ?3")
                .map_err(|e| e.to_string())?;
            for (i, a) in list.iter().enumerate() {
                let id = a.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if id.is_empty() {
                    continue;
                }
                keep.insert(id.clone());
                let body = serde_json::to_string(a).map_err(|e| e.to_string())?;
                let h = fnv1a64(body.as_bytes());
                next_hashes.insert(id.clone(), h);
                if hashes.get(&id) == Some(&h) {
                    // 内容没变：只校正排序位，不动正文（这才是「增量写」的意义）
                    let _ = up_ord.execute(params![i as i64, at, id]);
                    continue;
                }
                up.execute(params![id, i as i64, body, at]).map_err(|e| e.to_string())?;
                written += 1;
            }
        }

        // 旧行不在新列表里 → 删除
        let mut stale: Vec<String> = Vec::new();
        {
            let mut stmt = tx.prepare("SELECT id FROM assets").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            for id in rows.flatten() {
                if !keep.contains(&id) {
                    stale.push(id);
                }
            }
        }
        for id in &stale {
            let _ = tx.execute("DELETE FROM assets WHERE id = ?1", params![id]);
        }

        tx.execute("INSERT OR REPLACE INTO meta (k, v) VALUES ('at', ?1)", params![at])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;

        *hashes = next_hashes;
        Ok(json!({
            "ok": true,
            "written": written,
            "total": keep.len(),
            "removed": stale.len(),
            "at": at
        }))
    }
}
