/* p2p_api.rs — P2P 传文件的磁盘侧。

 * 网络（WebRTC DataChannel、口令碰面）全在渲染层，这里只做三件事：
 *   1. 发送方：把勾选的素材摊平成「相对路径 + 绝对路径 + 大小」的清单，算出会话 ID
 *   2. 收发双方：按 64 KB 全局块号读写，块号跨文件连续
 *   3. 接收方：把已收块记成位图落盘，断线重连时只补缺口

 * 为什么块号是全局的：位图只要一条，续传判断不用按文件拆开；
 * 文件边界用前缀和反查，素材包常见几十到几百个文件，线性扫描都比二分省事。

 * 为什么接收端先写临时目录再搬：
 *   传输中断时素材目录里不会留半截文件；同名冲突也只在最后一步才发生，
 *   用户在确认框里看到的是「要覆盖哪几个」，不是「已经悄悄覆盖了一堆」。
 */

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, PathBuf};
use std::sync::Mutex;

pub const BLOCK: u64 = 64 * 1024;
const TMP_DIR: &str = ".vrclib-p2p";
const BITMAP_DIRTY: u64 = 256;

#[derive(Clone)]
pub struct FileRec {
    pub rel: String,
    pub abs: PathBuf,
    pub size: u64,
    pub blocks: u64,
    pub start: u64, // 该文件首块在全局块序列里的下标
}

impl FileRec {
    fn json(&self) -> Value {
        json!({ "rel": self.rel, "size": self.size, "blocks": self.blocks })
    }
}

pub struct Session {
    pub id: String,
    pub role: String, // send / recv
    pub root: PathBuf,
    pub files: Vec<FileRec>,
    pub total: u64,
    pub blocks: u64,
    pub bitfield: Vec<u8>, // recv 侧专用，send 侧留空
    pub received: u64,
    pub handles: HashMap<usize, File>,
    pub dirty: u64,
    pub done: bool,
}

impl Session {
    fn pct(&self) -> f64 {
        if self.total == 0 {
            return 0.0;
        }
        (self.received as f64) / (self.total as f64) * 100.0
    }

    fn has(&self, block: u64) -> bool {
        let i = (block / 8) as usize;
        i < self.bitfield.len() && (self.bitfield[i] >> (block % 8)) & 1 == 1
    }

    fn mark(&mut self, block: u64) {
        let i = (block / 8) as usize;
        if i >= self.bitfield.len() {
            self.bitfield.resize(i + 1, 0);
        }
        let mask = 1u8 << (block % 8);
        if self.bitfield[i] & mask == 0 {
            self.bitfield[i] |= mask;
            self.received += self.block_len(block);
        }
    }

    fn block_len(&self, block: u64) -> u64 {
        match self.locate(block) {
            Some((fi, off)) => {
                let size = self.files[fi].size;
                std::cmp::min(BLOCK, size.saturating_sub(off))
            }
            None => 0,
        }
    }

    fn locate(&self, block: u64) -> Option<(usize, u64)> {
        for (i, f) in self.files.iter().enumerate() {
            if block >= f.start && block < f.start + f.blocks {
                return Some((i, (block - f.start) * BLOCK));
            }
        }
        None
    }

    fn to_json(&self) -> Value {
        /* 续传起点：位图里第一个空洞。块是顺序写进去的，所以正常情况就等于已收块数；
           真出现中间空洞（比如某次写入失败），这里也能给出正确的下界。 */
        let next = if self.role == "recv" {
            (0..self.blocks).find(|b| !self.has(*b)).unwrap_or(self.blocks)
        } else {
            0
        };
        json!({
            /* sessionId 是「清单身份」，用于和对端配对、给位图文件命名；
               handle 是「本进程内的会话句柄」，同一进程同时收发同一份清单时，
               两者会撞在一起，所以句柄带角色后缀。读写接口一律用 handle。 */
            "sessionId": self.id,
            "handle": format!("{}#{}", self.id, self.role),
            "role": self.role,
            "root": self.root.to_string_lossy(),
            "total": self.total,
            "blocks": self.blocks,
            "nextBlock": next,
            "received": self.received,
            "pct": self.pct(),
            "done": self.done,
            "blockSize": BLOCK,
            "fileCount": self.files.len(),
            "files": self.files.iter().map(|f| f.json()).collect::<Vec<_>>(),
        })
    }
}

pub struct P2pState {
    pub sessions: Mutex<HashMap<String, Session>>,
}

impl Default for P2pState {
    fn default() -> Self {
        Self { sessions: Mutex::new(HashMap::new()) }
    }
}

/* ---------------- 小工具 ---------------- */

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// 会话 ID = 清单内容 + 总字节数的 FNV64。
/// 同一个清单必然得到同一个 ID，这是断点续传能跨进程接上的前提。
fn session_id(files: &[(String, u64)], total: u64) -> String {
    let mut buf = String::new();
    for (rel, size) in files {
        buf.push_str(rel);
        buf.push('\u{1}');
        buf.push_str(&size.to_string());
        buf.push('\n');
    }
    buf.push_str(&total.to_string());
    format!("{:016x}-{:x}", fnv1a(buf.as_bytes()), total)
}

/// 相对路径只允许普通片段：绝对路径、盘符、`..` 一律拒绝。
fn safe_rel(rel: &str) -> Result<PathBuf, String> {
    let rel = rel.replace('\\', "/");
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() {
        return Err("相对路径为空".into());
    }
    let p = PathBuf::from(rel);
    for c in p.components() {
        match c {
            Component::Normal(_) => {}
            _ => return Err(format!("相对路径非法：{rel}")),
        }
    }
    Ok(p)
}

fn transfers_dir() -> PathBuf {
    crate::host::data_dir().join("transfers")
}

fn bitmap_path(id: &str) -> PathBuf {
    transfers_dir().join(format!("{id}.json"))
}

/// 把位图落盘。中断 / 关窗后靠它接上。
fn save_bitmap(s: &Session) {
    let dir = transfers_dir();
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let b64: String = {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity((s.bitfield.len() + 2) / 3 * 4);
        for c in s.bitfield.chunks(3) {
            let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            out.push(T[(n >> 18) as usize & 63] as char);
            out.push(T[(n >> 12) as usize & 63] as char);
            out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
            out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
        }
        out
    };
    let v = json!({
        "sessionId": s.id,
        "root": s.root.to_string_lossy(),
        "total": s.total,
        "blocks": s.blocks,
        "blockSize": BLOCK,
        "received": s.received,
        "done": s.done,
        "files": s.files.iter().map(|f| json!({ "rel": f.rel, "size": f.size })).collect::<Vec<_>>(),
        "bitfield": b64,
        "at": now_secs(),
    });
    let _ = fs::write(bitmap_path(&s.id), v.to_string());
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn decode_b64(s: &str) -> Vec<u8> {
    let mut tab = [0u8; 256];
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (i, &c) in T.iter().enumerate() {
        tab[c as usize] = i as u8;
    }
    let bytes: Vec<u8> = s.bytes().filter(|b| *b != b'=' && !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for c in bytes.chunks(4) {
        let mut n: u32 = 0;
        for (i, b) in c.iter().enumerate() {
            n |= (tab[*b as usize] as u32) << (18 - i * 6);
        }
        out.push((n >> 16) as u8);
        if c.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if c.len() > 3 {
            out.push(n as u8);
        }
    }
    out
}

fn build_files(items: Vec<(String, PathBuf, u64)>, base: u64) -> (Vec<FileRec>, u64) {
    let mut out = Vec::with_capacity(items.len());
    let mut start = base;
    for (rel, abs, size) in items {
        let blocks = (size + BLOCK - 1) / BLOCK;
        out.push(FileRec { rel, abs, size, blocks, start });
        start += blocks;
    }
    (out, start)
}

/* ============================ 发送侧 ============================ */

/// /api/p2p/prepare
/// 入参 { items: [{ abs, rel }] } —— 由渲染层从勾选的素材构造。
/// 出参即「清单」，原样交给对端就能建立接收会话。
pub fn prepare(state: &P2pState, v: &Value) -> Result<Value, String> {
    let arr = v
        .get("items")
        .and_then(|x| x.as_array())
        .ok_or_else(|| "缺少 items".to_string())?;
    if arr.is_empty() {
        return Err("没有选择任何文件".into());
    }

    let mut raw: Vec<(String, PathBuf, u64)> = Vec::with_capacity(arr.len());
    let mut total = 0u64;
    for it in arr {
        let abs = it.get("abs").and_then(|x| x.as_str()).unwrap_or("").trim();
        let rel_in = it.get("rel").and_then(|x| x.as_str()).unwrap_or("").trim();
        if abs.is_empty() {
            return Err("清单里有空路径".into());
        }
        let p = PathBuf::from(abs);
        let md = fs::metadata(&p).map_err(|e| format!("读不到 {abs}：{e}"))?;
        if !md.is_file() {
            continue;
        }
        let rel = safe_rel(rel_in)?.to_string_lossy().replace('\\', "/");
        total += md.len();
        raw.push((rel, p, md.len()));
    }
    if raw.is_empty() {
        return Err("清单里的文件都不存在".into());
    }

    let id = session_id(&raw.iter().map(|r| (r.0.clone(), r.2)).collect::<Vec<_>>(), total);
    let (files, blocks) = build_files(raw, 0);

    let sess = Session {
        id: id.clone(),
        role: "send".into(),
        root: PathBuf::new(),
        files,
        total,
        blocks,
        bitfield: Vec::new(),
        received: 0,
        handles: HashMap::new(),
        dirty: 0,
        done: false,
    };
    let key = format!("{}#{}", sess.id, sess.role);
    let out = sess.to_json();
    state.sessions.lock().unwrap().insert(key, sess);
    Ok(out)
}

/* ============================ 接收侧 ============================ */

/// /api/p2p/open
/// 入参 { manifest: <prepare 的返回>, dstRoot }。
/// 若存在同 ID 的位图，直接接上继续；返回 receiver 需要补的块区间由位图反映。
pub fn open(state: &P2pState, v: &Value) -> Result<Value, String> {
    let m = v.get("manifest").ok_or_else(|| "缺少 manifest".to_string())?;
    let dst_root = v.get("dstRoot").and_then(|x| x.as_str()).unwrap_or("").trim();
    if dst_root.is_empty() {
        return Err("缺少接收目录".into());
    }
    let total = m.get("total").and_then(|x| x.as_u64()).unwrap_or(0);
    let files_in = m
        .get("files")
        .and_then(|x| x.as_array())
        .ok_or_else(|| "manifest 里没有 files".to_string())?;

    let root = PathBuf::from(dst_root);
    let tmp = root.join(TMP_DIR).join(
        m.get("sessionId")
            .and_then(|x| x.as_str())
            .unwrap_or("session"),
    );

    let mut items: Vec<(String, PathBuf, u64)> = Vec::with_capacity(files_in.len());
    let mut total_calc = 0u64;
    for f in files_in {
        let rel_in = f.get("rel").and_then(|x| x.as_str()).unwrap_or("");
        let size = f.get("size").and_then(|x| x.as_u64()).unwrap_or(0);
        let rel = safe_rel(rel_in)?;
        total_calc += size;
        items.push((rel.to_string_lossy().replace('\\', "/"), tmp.join(&rel), size));
    }
    if total == 0 || total_calc != total {
        return Err(format!("清单大小对不上：声明 {total}，实际 {total_calc}"));
    }

    let id = m
        .get("sessionId")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return Err("manifest 没有 sessionId".into());
    }
    let (files, blocks) = build_files(items, 0);

    /* 恢复：位图文件存在就读回来，同时把临时目录里已有的部分文件对齐到实际长度。 */
    let mut bitfield = vec![0u8; ((blocks + 7) / 8) as usize];
    let mut received = 0u64;
    if let Ok(txt) = fs::read_to_string(bitmap_path(&id)) {
        if let Ok(old) = serde_json::from_str::<Value>(&txt) {
            if old.get("blocks").and_then(|x| x.as_u64()) == Some(blocks) {
                if let Some(b64) = old.get("bitfield").and_then(|x| x.as_str()) {
                    let decoded = decode_b64(b64);
                    let n = std::cmp::min(decoded.len(), bitfield.len());
                    bitfield[..n].copy_from_slice(&decoded[..n]);
                    for (i, f) in files.iter().enumerate() {
                        for b in 0..f.blocks {
                            let gb = f.start + b;
                            let idx = (gb / 8) as usize;
                            if idx < bitfield.len() && (bitfield[idx] >> (gb % 8)) & 1 == 1 {
                                received += std::cmp::min(BLOCK, f.size - b * BLOCK);
                            }
                        }
                        let _ = i;
                    }
                }
            }
        }
    }

    let sess = Session {
        id: id.clone(),
        role: "recv".into(),
        root: root.clone(),
        files,
        total,
        blocks,
        bitfield,
        received,
        handles: HashMap::new(),
        dirty: 0,
        done: false,
    };
    let key = format!("{}#{}", sess.id, sess.role);
    let out = sess.to_json();
    state.sessions.lock().unwrap().insert(key, sess);
    Ok(out)
}

/* ============================ 分块读写 ============================ */

/// 发送方取一块。返回的字节数最多 64 KB，最后一块可能更短。
pub fn read_block(state: &P2pState, id: &str, block: u64) -> Result<Vec<u8>, String> {
    let guard = state.sessions.lock().unwrap();
    let s = guard.get(id).ok_or_else(|| "会话不存在".to_string())?;
    let (fi, off) = s.locate(block).ok_or_else(|| format!("块号越界：{block}"))?;
    let f = &s.files[fi];
    let len = std::cmp::min(BLOCK, f.size.saturating_sub(off)) as usize;
    let mut buf = vec![0u8; len];
    let mut fh = File::open(&f.abs)
        .map_err(|e| format!("打开 {}（{}）失败：{e}", f.rel, f.abs.display()))?;
    fh.seek(SeekFrom::Start(off)).map_err(|e| e.to_string())?;
    fh.read_exact(&mut buf).map_err(|e| format!("读 {} 失败：{e}", f.rel))?;
    Ok(buf)
}

/// 接收方写一块。返回是否新写入（重复块直接丢弃，不算进度）。
pub fn write_block(state: &P2pState, id: &str, block: u64, data: &[u8]) -> Result<Value, String> {
    let mut guard = state.sessions.lock().unwrap();
    let s = guard.get_mut(id).ok_or_else(|| "会话不存在".to_string())?;
    if s.role != "recv" {
        return Err("该会话不是接收方".into());
    }
    if s.has(block) {
        return Ok(json!({ "ok": true, "dup": true, "received": s.received, "pct": s.pct() }));
    }
    let (fi, off) = s.locate(block).ok_or_else(|| format!("块号越界：{block}"))?;
    let expect = std::cmp::min(BLOCK, s.files[fi].size.saturating_sub(off)) as usize;
    if data.len() != expect {
        return Err(format!("块 {block} 长度不符：收到 {}，应为 {expect}", data.len()));
    }
    let path = s.files[fi].abs.clone();
    let size = s.files[fi].size;

    let fh = match s.handles.get_mut(&fi) {
        Some(h) => h,
        None => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
            }
            let f = fs::OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .open(&path)
                .map_err(|e| format!("建文件 {} 失败：{e}", path.display()))?;
            /* 先按最终大小占位，写尾部块时不会稀疏成 0 字节。 */
            if f.metadata().map(|m| m.len()).unwrap_or(0) != size {
                let _ = f.set_len(size);
            }
            s.handles.insert(fi, f);
            s.handles.get_mut(&fi).unwrap()
        }
    };
    fh.seek(SeekFrom::Start(off)).map_err(|e| e.to_string())?;
    fh.write_all(data).map_err(|e| format!("写 {} 失败：{e}", path.display()))?;

    s.mark(block);
    s.dirty += 1;
    let received = s.received;
    let pct = s.pct();
    let dirty = s.dirty;
    if dirty % BITMAP_DIRTY == 0 {
        save_bitmap(s);
    }
    Ok(json!({ "ok": true, "dup": false, "received": received, "pct": pct }))
}

/* ============================ 收尾 ============================ */

/// /api/p2p/finish —— 校验块是否齐、把临时目录搬到正式位置。
pub fn finish(state: &P2pState, id: &str) -> Result<Value, String> {
    let mut guard = state.sessions.lock().unwrap();
    let s = guard.get_mut(id).ok_or_else(|| "会话不存在".to_string())?;
    if s.role != "recv" {
        return Err("该会话不是接收方".into());
    }
    let mut missing = Vec::new();
    for b in 0..s.blocks {
        if !s.has(b) {
            missing.push(b);
            if missing.len() >= 20 {
                break;
            }
        }
    }
    if !missing.is_empty() {
        return Err(format!("还有 {} 块没收到（例：{:?}）", missing.len(), &missing[..missing.len().min(5)]));
    }

    s.handles.clear();
    let mut moved = 0u32;
    let mut failed = Vec::new();
    for f in &s.files {
        let dst = s.root.join(&f.rel);
        if let Some(parent) = dst.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                failed.push(format!("{}: {e}", f.rel));
                continue;
            }
        }
        /* 已存在同名文件时先留一份 .bak，避免用户手改的东西被无声覆盖。 */
        if dst.exists() {
            let bak = dst.with_extension(format!(
                "{}bak",
                dst.extension().map(|e| format!("{}.", e.to_string_lossy())).unwrap_or_default()
            ));
            let _ = fs::rename(&dst, &bak);
        }
        /* 空文件没有块，临时目录里不会生成，直接建一个空壳。 */
        if f.size == 0 {
            match File::create(&dst) {
                Ok(_) => moved += 1,
                Err(e) => failed.push(format!("{}: {e}", f.rel)),
            }
            continue;
        }
        match fs::rename(&f.abs, &dst) {
            Ok(_) => moved += 1,
            Err(e) => failed.push(format!("{}: {e}", f.rel)),
        }
    }

    s.done = true;
    s.received = s.total;
    let root = s.root.clone();
    let id2 = s.id.clone();
    save_bitmap(s);

    /* 临时目录收干净（还能剩下别的会话的目录，所以只删本会话这层） */
    let tmp = root.join(TMP_DIR).join(&id2);
    let _ = fs::remove_dir_all(&tmp);
    let _ = fs::remove_file(bitmap_path(&id2));

    Ok(json!({
        "ok": failed.is_empty(),
        "moved": moved,
        "total": s.files.len(),
        "failed": failed,
        "root": root.to_string_lossy(),
    }))
}

/// /api/p2p/cancel —— 放弃一次传输：关句柄、删本会话的临时刻。
pub fn cancel(state: &P2pState, id: &str) -> Result<Value, String> {
    let mut guard = state.sessions.lock().unwrap();
    if let Some(s) = guard.remove(id) {
        let tmp = s.root.join(TMP_DIR).join(&s.id);
        drop(s);
        let _ = fs::remove_dir_all(&tmp);
        let _ = fs::remove_file(bitmap_path(id));
    }
    Ok(json!({ "ok": true }))
}

/// /api/p2p/status
pub fn status(state: &P2pState, id: &str) -> Result<Value, String> {
    let guard = state.sessions.lock().unwrap();
    if let Some(s) = guard.get(id) {
        return Ok(s.to_json());
    }
    /* 进程重启后会话没了，但位图还在：把能恢复的会话报给 UI，让用户决定要不要续。 */
    let mut list = Vec::new();
    if let Ok(rd) = fs::read_dir(transfers_dir()) {
        for e in rd.flatten() {
            if e.path().extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            if let Ok(txt) = fs::read_to_string(e.path()) {
                if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                    if v.get("done").and_then(|x| x.as_bool()) == Some(false) {
                        list.push(v);
                    }
                }
            }
        }
    }
    Ok(json!({ "ok": true, "missing": true, "resumable": list }))
}

/// /api/p2p/resumable —— 上次没传完的会话（UI 开机时问一句要不要续）
pub fn resumable() -> Value {
    let mut list: Vec<Value> = Vec::new();
    if let Ok(rd) = fs::read_dir(transfers_dir()) {
        for e in rd.flatten() {
            if e.path().extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Ok(txt) = fs::read_to_string(e.path()) else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&txt) else { continue };
            if v.get("done").and_then(|x| x.as_bool()) == Some(true) {
                continue;
            }
            let name = v
                .get("files")
                .and_then(|x| x.as_array())
                .and_then(|a| a.first())
                .and_then(|f| f.get("rel"))
                .and_then(|x| x.as_str())
                .unwrap_or("未命名")
                .split('/')
                .next()
                .unwrap_or("未命名")
                .to_string();
            list.push(json!({
                "sessionId": v.get("sessionId"),
                "name": name,
                "files": v.get("files").and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0),
                "total": v.get("total"),
                "received": v.get("received"),
                "root": v.get("root"),
                "at": v.get("at"),
            }));
        }
    }
    list.sort_by(|a, b| {
        b.get("at").and_then(|x| x.as_u64()).unwrap_or(0)
            .cmp(&a.get("at").and_then(|x| x.as_u64()).unwrap_or(0))
    });
    json!({ "ok": true, "list": list })
}

/// 关窗 / 退出前把所有未完成会话的位图刷一遍
pub fn flush_all(state: &P2pState) {
    let guard = state.sessions.lock().unwrap();
    for s in guard.values() {
        if !s.done && s.role == "recv" {
            save_bitmap(s);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_rejects_escape() {
        assert!(safe_rel("素材/a.png").is_ok());
        assert!(safe_rel("../etc/passwd").is_err());
        assert!(safe_rel("C:/Windows/win.ini").is_err());
        /* 前导斜杠按相对根处理，不应被当成绝对路径放行 */
        assert_eq!(safe_rel("/abs/path").unwrap(), PathBuf::from("abs/path"));
        assert!(safe_rel("a/../../b").is_err());
    }

    #[test]
    fn block_math() {
        let files = vec![
            FileRec { rel: "a".into(), abs: PathBuf::new(), size: BLOCK * 2, blocks: 2, start: 0 },
            FileRec { rel: "b".into(), abs: PathBuf::new(), size: BLOCK / 2, blocks: 1, start: 2 },
        ];
        assert_eq!(files.len(), 2);
        let total: u64 = files.iter().map(|f| f.size).sum();
        assert_eq!(total, BLOCK * 2 + BLOCK / 2);
    }

    #[test]
    fn id_is_stable() {
        let a = session_id(&[("x/a".into(), 10)], 10);
        let b = session_id(&[("x/a".into(), 10)], 10);
        assert_eq!(a, b);
        let c = session_id(&[("x/a".into(), 11)], 11);
        assert_ne!(a, c);
    }

    /// 走一遍真实流程：prepare → open → 逐块搬 → finish，逐字节比对。
    /// 特意混了跨块边界的文件、贴边文件、空文件，这三种是分块最容易错的地方。
    #[test]
    fn full_roundtrip() {
        let base = std::env::temp_dir().join(format!("vrclib-p2p-rt-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(src.join("素材甲")).unwrap();
        fs::create_dir_all(&dst).unwrap();
        std::env::set_var("VRCLIB_ROOT", &base);

        let cases: Vec<(&str, usize)> = vec![
            ("素材甲/贴图.png", BLOCK as usize + 1234), // 跨块
            ("素材甲/模型.fbx", BLOCK as usize),        // 正好一块
            ("素材甲/说明.txt", 77),                    // 不足一块
            ("素材甲/空.json", 0),                      // 空文件
        ];
        let mut items = Vec::new();
        let mut expect = Vec::new();
        for (rel, size) in &cases {
            let p = src.join(rel);
            let data: Vec<u8> = (0..*size).map(|i| (i * 31 + 7) as u8).collect();
            fs::write(&p, &data).unwrap();
            expect.push(data);
            items.push(json!({ "abs": p.to_string_lossy(), "rel": rel }));
        }

        let st = P2pState::default();
        let manifest = prepare(&st, &json!({ "items": items })).unwrap();
        let send_h = manifest["handle"].as_str().unwrap().to_string();
        assert_eq!(manifest["blocks"].as_u64().unwrap(), 4);

        let opened = open(&st, &json!({ "manifest": manifest, "dstRoot": dst.to_string_lossy() })).unwrap();
        let recv_h = opened["handle"].as_str().unwrap().to_string();
        assert_eq!(opened["received"].as_u64().unwrap(), 0, "新会话应该从零开始");

        let total_blocks = opened["blocks"].as_u64().unwrap();
        for b in 0..total_blocks {
            let data = read_block(&st, &send_h, b).unwrap();
            write_block(&st, &recv_h, b, &data).unwrap();
        }
        let fin = finish(&st, &recv_h).unwrap();
        assert_eq!(fin["ok"], true, "finish 失败：{fin}");

        for (i, (rel, _)) in cases.iter().enumerate() {
            let got = fs::read(dst.join(rel)).unwrap();
            assert_eq!(got, expect[i], "{rel} 内容不一致");
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// 传一半 → 掉线 → 重启（会话全丢，只剩位图）→ 重新 prepare/open → 只补剩下的块。
    /// 这条是断点续传的核心承诺，必须真测，不能只靠推理。
    #[test]
    fn resume_after_restart() {
        let base = std::env::temp_dir().join(format!("vrclib-p2p-rs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let src = base.join("s");
        let dst = base.join("d");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        std::env::set_var("VRCLIB_ROOT", &base);

        let size = BLOCK * 3 - 500;
        let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        let p = src.join("big.bin");
        fs::write(&p, &data).unwrap();
        let items = || json!({ "items": [{ "abs": p.to_string_lossy(), "rel": "包/big.bin" }] });

        let st = P2pState::default();
        let m1 = prepare(&st, &items()).unwrap();
        let send_h = m1["handle"].as_str().unwrap().to_string();
        let sid1 = m1["sessionId"].as_str().unwrap().to_string();

        let opened = open(&st, &json!({ "manifest": m1.clone(), "dstRoot": dst.to_string_lossy() })).unwrap();
        let recv_h = opened["handle"].as_str().unwrap().to_string();
        assert_eq!(opened["blocks"].as_u64().unwrap(), 3);
        assert_eq!(opened["received"].as_u64().unwrap(), 0);

        for b in 0..2 {
            let d = read_block(&st, &send_h, b).unwrap();
            write_block(&st, &recv_h, b, &d).unwrap();
        }
        flush_all(&st);
        drop(st); // 应用退出，内存里什么都没了

        let st2 = P2pState::default();
        let m2 = prepare(&st2, &items()).unwrap();
        assert_eq!(m2["sessionId"].as_str().unwrap(), sid1, "同一份清单必须得到同一个会话 ID");
        let send_h2 = m2["handle"].as_str().unwrap().to_string();

        let re = open(&st2, &json!({ "manifest": m2, "dstRoot": dst.to_string_lossy() })).unwrap();
        let recv_h2 = re["handle"].as_str().unwrap().to_string();
        assert_eq!(re["received"].as_u64().unwrap(), BLOCK * 2, "重启后应接上前两块");

        let d = read_block(&st2, &send_h2, 2).unwrap();
        let r = write_block(&st2, &recv_h2, 2, &d).unwrap();
        assert_eq!(r["dup"], false);

        let fin = finish(&st2, &recv_h2).unwrap();
        assert_eq!(fin["ok"], true, "finish 失败：{fin}");
        assert_eq!(fs::read(dst.join("包/big.bin")).unwrap(), data, "续传后内容必须一致");

        let _ = fs::remove_dir_all(&base);
    }
}
