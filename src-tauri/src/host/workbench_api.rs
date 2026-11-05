/* workbench_api.rs — 改模工作台的磁盘侧实现（对应 docs/改模工作台-逻辑拆分.md）
 *
 * 分工：
 *   Rust 这边只做「真的碰磁盘」的重活 —— 遍历、hash、GUID 索引、复制、拉进程。
 *   业务判断（要不要导、能不能装、话术怎么说）全在 renderer/js/91-workbench.js。
 *
 * 为什么不用新增依赖：
 *   sha256 自己实现 60 行，比加一个 crate 更省事 —— 也避免离线环境拉不到包。
 *
 * 安全口径（L50/L51）：
 *   工作台只往工程的 Assets/VRCAL_Imports 目录里写，别的路径一律不碰；
 *   所有写操作都会先比对 canonicalize 后的前缀，任何 ".." 越界直接拒绝。
 */

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/* ============================ sha256 ============================ */

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

struct Sha256 {
    h: [u32; 8],
    buf: [u8; 64],
    len: usize,
    total: u64,
}

impl Sha256 {
    fn new() -> Self {
        Self {
            h: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buf: [0u8; 64],
            len: 0,
            total: 0,
        }
    }

    fn block(&mut self, b: &[u8]) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut a = self.h[0];
        let mut b2 = self.h[1];
        let mut c = self.h[2];
        let mut d = self.h[3];
        let mut e = self.h[4];
        let mut f = self.h[5];
        let mut g = self.h[6];
        let mut hh = self.h[7];
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b2) ^ (a & c) ^ (b2 & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b2;
            b2 = a;
            a = t1.wrapping_add(t2);
        }
        self.h[0] = self.h[0].wrapping_add(a);
        self.h[1] = self.h[1].wrapping_add(b2);
        self.h[2] = self.h[2].wrapping_add(c);
        self.h[3] = self.h[3].wrapping_add(d);
        self.h[4] = self.h[4].wrapping_add(e);
        self.h[5] = self.h[5].wrapping_add(f);
        self.h[6] = self.h[6].wrapping_add(g);
        self.h[7] = self.h[7].wrapping_add(hh);
    }

    fn update(&mut self, mut data: &[u8]) {
        self.total = self.total.wrapping_add(data.len() as u64);
        if self.len > 0 {
            let take = (64 - self.len).min(data.len());
            self.buf[self.len..self.len + take].copy_from_slice(&data[..take]);
            self.len += take;
            data = &data[take..];
            if self.len == 64 {
                let block = self.buf;
                self.block(&block);
                self.len = 0;
            }
        }
        while data.len() >= 64 {
            let (block, rest) = data.split_at(64);
            self.block(block);
            data = rest;
        }
        if !data.is_empty() {
            self.buf[..data.len()].copy_from_slice(data);
            self.len = data.len();
        }
    }

    fn finish(mut self) -> [u8; 32] {
        let bits = self.total.wrapping_mul(8);
        self.update(&[0x80]);
        while self.len != 56 {
            self.update(&[0x00]);
        }
        self.update(&bits.to_be_bytes());
        let mut out = [0u8; 32];
        for (i, v) in self.h.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
        }
        out
    }
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    h.finish().iter().map(|b| format!("{b:02x}")).collect()
}

/* ============================ 小工具 ============================ */

fn s_of(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn join_rel(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{rel}/{name}")
    }
}

/// 把「正斜杠相对路径」拼成当前平台的 PathBuf（Windows 上自动转反斜杠）
fn native(base: &Path, rel: &str) -> PathBuf {
    let mut out = base.to_path_buf();
    for part in rel.split('/') {
        if !part.is_empty() && part != "." {
            out.push(part);
        }
    }
    out
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 统一成「小写、正斜杠、去尾分隔符」用于比较（存盘仍用原样）
fn cmp_key(p: &str) -> String {
    p.replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn overlap(a: &str, b: &str) -> bool {
    let (a, b) = (cmp_key(a), cmp_key(b));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
}

fn sanitize_name(raw: &str) -> String {
    let mut out = String::new();
    let mut last_space = false;
    for ch in raw.chars() {
        let bad = matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            || (ch as u32) < 0x20;
        let c = if bad { '_' } else { ch };
        if c == ' ' {
            if last_space {
                continue;
            }
            last_space = true;
        } else {
            last_space = false;
        }
        out.push(c);
    }
    let trimmed = out.trim().trim_matches('.').to_string();
    let cut: String = trimmed.chars().take(60).collect();
    if cut.is_empty() {
        "Material".to_string()
    } else {
        cut
    }
}

fn read_capped(path: &Path, cap: u64) -> Option<String> {
    let md = fs::metadata(path).ok()?;
    if !md.is_file() || md.len() > cap {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&bytes).to_string())
}

fn read_json(path: &Path) -> Option<Value> {
    let txt = read_capped(path, 1024 * 1024)?;
    serde_json::from_str::<Value>(&txt).ok()
}

/* ============================ 工程校验 ============================ */

fn project_parts() -> [&'static str; 3] {
    ["Assets", "Packages", "ProjectSettings"]
}

fn require_project(root: &Path) -> Result<(), String> {
    if !root.is_dir() {
        return Err(format!("目录不存在：{}", root.to_string_lossy()));
    }
    let mut missing: Vec<&str> = Vec::new();
    for name in project_parts() {
        match fs::metadata(root.join(name)) {
            Ok(m) if m.is_dir() => {}
            _ => missing.push(name),
        }
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "这不是 Unity 工程根目录：缺少 {}。请选择同时包含 Assets、Packages、ProjectSettings 的那一层。",
            missing.join("、")
        ))
    }
}

/// L04：ProjectVersion.txt 第一行的 m_EditorVersion
fn editor_version(root: &Path) -> String {
    let txt = match read_capped(&root.join("ProjectSettings").join("ProjectVersion.txt"), 64 * 1024) {
        Some(t) => t,
        None => return String::new(),
    };
    for line in txt.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("m_EditorVersion:") {
            return rest.trim().to_string();
        }
    }
    String::new()
}

fn looks_like_version(v: &str) -> bool {
    !v.is_empty()
        && v.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '+')
}

/* ============================ 依赖就绪（L09-L13） ============================ */

const DEPS: [(&str, &str); 3] = [
    ("com.vrchat.avatars", "VRChat Avatar SDK"),
    ("nadena.dev.modular-avatar", "Modular Avatar"),
    ("nadena.dev.ndmf", "NDMF"),
];

fn readiness(root: &Path) -> (Vec<Value>, Vec<String>) {
    let mut notes: Vec<String> = Vec::new();
    let vpm = read_json(&root.join("Packages").join("vpm-manifest.json"));
    let lock = read_json(&root.join("Packages").join("packages-lock.json"));

    let mut deps: Vec<Value> = Vec::new();
    for (id, label) in DEPS {
        // ① Packages/<id>/package.json
        let mut state = "unknown";
        let mut version = String::new();
        let mut evidence = String::new();

        let embedded = read_json(&root.join("Packages").join(id).join("package.json"));
        if let Some(pkg) = embedded {
            if pkg.get("name").and_then(|x| x.as_str()) == Some(id) {
                state = "files-found";
                version = pkg
                    .get("version")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                evidence = format!("Packages/{id}/package.json");
            }
        }

        // ② 声明来源
        if state != "files-found" {
            let declared = lock
                .as_ref()
                .and_then(|v| v.get("dependencies"))
                .and_then(|d| d.get(id))
                .and_then(|d| d.get("version"))
                .and_then(|x| x.as_str())
                .or_else(|| {
                    vpm.as_ref()
                        .and_then(|v| v.get("dependencies"))
                        .and_then(|d| d.get(id))
                        .and_then(|d| d.get("version"))
                        .and_then(|x| x.as_str())
                });
            if let Some(ver) = declared {
                state = "declared";
                version = ver.to_string();
            }
        }

        // ④ 只在 lock 版本形如 x.y.z 时才去看 PackageCache，不拼任意路径
        if state != "files-found" && looks_like_version(&version) {
            let cache = root
                .join("Library")
                .join("PackageCache")
                .join(format!("{id}@{version}"))
                .join("package.json");
            if let Some(pkg) = read_json(&cache) {
                if pkg.get("name").and_then(|x| x.as_str()) == Some(id) {
                    state = "files-found";
                    if let Some(v) = pkg.get("version").and_then(|x| x.as_str()) {
                        version = v.to_string();
                    }
                    evidence = format!("Library/PackageCache/{id}@{version}/package.json");
                }
            }
        }

        if state == "unknown" {
            version.clear();
        }

        deps.push(json!({
            "id": id,
            "label": label,
            "state": state,
            "version": version,
            "evidence": evidence
        }));
    }

    // 读失败的清单只记一条 note，不当成证据
    for name in ["vpm-manifest.json", "packages-lock.json"] {
        let p = root.join("Packages").join(name);
        if p.exists() && read_json(&p).is_none() {
            notes.push(format!("Packages/{name} 无法解析，未将它当作依赖证据。"));
        }
    }

    (deps, notes)
}

/* ============================ 目录遍历（L14-L19） ============================ */

const SKIP_DIRS: [&str; 9] = [
    ".git",
    ".svn",
    "library",
    "temp",
    "node_modules",
    "obj",
    "logs",
    "build",
    // Mac 打的包会带这一层资源副本；复制进 Assets 只会多出一堆 `._xxx` 垃圾
    "__macosx",
];
const SKIP_EXT: [&str; 9] = ["exe", "msi", "bat", "cmd", "ps1", "lnk", "url", "scr", "vrcalpart"];
const MAX_FILES: usize = 20000;
/// 复制中途写在目标目录里的「未完成」标记。进程被杀后它还在，下次导入据此「接着拷」。
const IMPORT_MARKER: &str = ".vrcal-importing";
const MAX_DEPTH: usize = 6;

struct Walked {
    files: Vec<(String, u64)>,
    warnings: Vec<String>,
}

fn walk(root: &Path) -> Result<Walked, String> {
    let mut files: Vec<(String, u64)> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut skipped_ext = 0usize;
    let mut skipped_depth = 0usize;
    let mut skipped_link = 0usize;

    let mut stack: Vec<(PathBuf, String, usize)> = vec![(root.to_path_buf(), String::new(), 0)];
    while let Some((dir, rel, depth)) = stack.pop() {
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            let md = match fs::symlink_metadata(ent.path()) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if md.file_type().is_symlink() {
                skipped_link += 1;
                continue;
            }
            let child_rel = join_rel(&rel, &name);
            if md.is_dir() {
                if SKIP_DIRS.contains(&name.to_lowercase().as_str()) {
                    continue;
                }
                if depth + 1 > MAX_DEPTH {
                    skipped_depth += 1;
                    continue;
                }
                stack.push((ent.path(), child_rel, depth + 1));
            } else {
                let ext = ent
                    .path()
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if SKIP_EXT.contains(&ext.as_str()) {
                    skipped_ext += 1;
                    continue;
                }
                if files.len() >= MAX_FILES {
                    return Err(format!(
                        "素材目录文件过多（超过 {MAX_FILES} 个），请选择更具体的条目再导入。"
                    ));
                }
                files.push((child_rel, md.len()));
            }
        }
    }

    if skipped_ext > 0 {
        warnings.push(format!("已跳过 {skipped_ext} 个可执行/脚本文件（不会复制进工程）。"));
    }
    if skipped_depth > 0 {
        warnings.push(format!(
            "已跳过 {skipped_depth} 个超过 {MAX_DEPTH} 层的子目录，请确认素材是否完整。"
        ));
    }
    if skipped_link > 0 {
        warnings.push(format!("已跳过 {skipped_link} 个目录链接/符号链接。"));
    }

    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(Walked { files, warnings })
}

/// L18：内容签名 = 排序后的 (相对路径, 字节数) 列表的 sha256
fn signature_of(files: &[(String, u64)]) -> String {
    let mut feed = String::new();
    for (rel, size) in files {
        feed.push_str(rel);
        feed.push('\u{0}');
        feed.push_str(&size.to_string());
        feed.push('\n');
    }
    sha256_hex(feed.as_bytes())
}

/* ============================ GUID 索引（L21） ============================ */

fn meta_guid(path: &Path) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let mut buf = [0u8; 2048];
    let n = f.read(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf[..n]);
    for line in text.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("guid:") {
            let g = rest.trim();
            if g.len() == 32 && g.chars().all(|c| c.is_ascii_hexdigit()) {
                return Some(g.to_ascii_lowercase());
            }
        }
    }
    None
}

/// 源路径解析：目录型素材按相对路径拼接；单文件素材本身就是那一个文件
fn source_path(base: &Path, is_dir: bool, rel: &str) -> PathBuf {
    if is_dir {
        native(base, rel)
    } else {
        base.to_path_buf()
    }
}

/// 收集源目录里已有的 GUID（只关心会被复制进来的部分）
fn source_guids(root: &Path, is_dir: bool, files: &[(String, u64)]) -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    for (rel, _) in files {
        if !rel.to_lowercase().ends_with(".meta") {
            continue;
        }
        let p = source_path(root, is_dir, rel);
        if let Some(g) = meta_guid(&p) {
            map.insert(g, rel.clone());
        }
    }
    map
}

/// 在工程 Assets 里找与这些 GUID 撞车的 .meta
fn find_conflicts(project_root: &Path, wanted: &HashMap<String, String>) -> (Vec<Value>, usize) {
    let mut conflicts: Vec<Value> = Vec::new();
    if wanted.is_empty() {
        return (conflicts, 0);
    }
    let mut remaining: HashSet<&String> = wanted.keys().collect();
    let assets = project_root.join("Assets");
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(assets, String::new(), 0)];
    let mut inspected = 0usize;

    while let Some((dir, rel, depth)) = stack.pop() {
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for ent in rd.flatten() {
            inspected += 1;
            if inspected > 300_000 {
                return (conflicts, inspected);
            }
            let name = ent.file_name().to_string_lossy().to_string();
            let md = match fs::symlink_metadata(ent.path()) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if md.file_type().is_symlink() {
                continue;
            }
            let child_rel = join_rel(&rel, &name);
            if md.is_dir() {
                if depth < 24 {
                    stack.push((ent.path(), child_rel, depth + 1));
                }
            } else if name.to_lowercase().ends_with(".meta") {
                if let Some(g) = meta_guid(&ent.path()) {
                    if remaining.remove(&g) {
                        conflicts.push(json!({
                            "guid": g,
                            "path": format!("Assets/{child_rel}"),
                            "sourcePath": wanted.get(&g).cloned().unwrap_or_default()
                        }));
                        if remaining.is_empty() {
                            return (conflicts, inspected);
                        }
                    }
                }
            }
        }
    }
    (conflicts, inspected)
}

/* ============================ 替换旧版本（B5） ============================ */

const IMPORTS_PREFIX: &str = "Assets/VRCAL_Imports/";

/// 从 `Assets/VRCAL_Imports/<一层>/…` 里取出「那一次导入的根目录」
fn import_root_of(path: &str) -> Option<String> {
    let key = cmp_key(path);
    let lower_prefix = IMPORTS_PREFIX.to_lowercase();
    if !key.starts_with(&lower_prefix) {
        return None;
    }
    let rest = path.replace('\\', "/");
    let tail = &rest[lower_prefix.len()..];
    let seg = tail.split('/').next().unwrap_or("");
    if seg.is_empty() {
        return None;
    }
    Some(format!("{IMPORTS_PREFIX}{seg}"))
}

fn receipt_signature(dir_abs: &Path) -> Option<String> {
    read_json(&dir_abs.join(".vrcal-import.json"))
        .and_then(|v| v.get("signature").and_then(|x| x.as_str()).map(|s| s.to_string()))
}

/// 这个目录是不是工作台自己导入的（回执就是我们的记号）
fn is_import_dir(project_root: &Path, dest_rel: &str) -> bool {
    native(project_root, dest_rel)
        .join(".vrcal-import.json")
        .is_file()
}

/// 冲突是否全部来自「同一素材的上一次导入」。
/// 只有这种冲突才允许替换 —— 素材跟工程里别的资源撞车时，覆盖等于毁掉引用。
fn replaceable_dir(conflicts: &[Value], material: &str) -> Option<String> {
    let wanted = sanitize_name(material).to_lowercase();
    let mut root: Option<String> = None;
    for c in conflicts {
        let path = c.get("path").and_then(|x| x.as_str()).unwrap_or("");
        let r = import_root_of(path)?;
        match root.as_ref() {
            Some(prev) if cmp_key(prev) != cmp_key(&r) => return None, // 散在多个目录 → 不是同一素材
            Some(_) => {}
            None => root = Some(r),
        }
    }
    let root = root?;
    let leaf = root.rsplit('/').next().unwrap_or("");
    // 旧目录形如「衣装-ab12cd34」或「衣装」；必须是以本素材名开头的
    if !leaf.to_lowercase().starts_with(&wanted) {
        return None;
    }
    Some(root)
}

fn trash_root() -> PathBuf {
    super::data_dir().join("trash")
}

/// 回收站保留 30 天：够用户后悔，也不至于把盘塞满
fn prune_trash() {
    let root = trash_root();
    let rd = match fs::read_dir(&root) {
        Ok(r) => r,
        Err(_) => return,
    };
    let now = std::time::SystemTime::now();
    for ent in rd.flatten() {
        let old = fs::metadata(ent.path())
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map(|d| d.as_secs() > 30 * 24 * 60 * 60)
            .unwrap_or(false);
        if old {
            let _ = fs::remove_dir_all(ent.path());
        }
    }
}

fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    for (rel, _) in walk(src)?.files {
        let from = native(src, &rel);
        let to = native(dst, &rel);
        if let Some(p) = to.parent() {
            fs::create_dir_all(p).map_err(|e| format!("建目录失败：{e}"))?;
        }
        fs::copy(&from, &to).map_err(|e| format!("复制失败（{rel}）：{e}"))?;
    }
    Ok(())
}

/// 把旧的导入目录挪到回收站。只接受 `Assets/VRCAL_Imports/<一层>` 且带本程序回执的目录。
/// 返回落到回收站里的路径；没有旧目录时返回 None。
fn trash_import_dir(project_root: &Path, dest_rel: &str) -> Result<Option<PathBuf>, String> {
    let key = dest_rel.replace('\\', "/").trim_end_matches('/').to_string();
    let lower = key.to_lowercase();
    if !lower.starts_with(&IMPORTS_PREFIX.to_lowercase())
        || key.contains("..")
        || key.contains(':')
    {
        return Err("只能替换 Assets/VRCAL_Imports 下的目录。".into());
    }
    // 只允许「一层」：VRCAL_Imports/衣装，不能是 VRCAL_Imports 本身
    if lower == IMPORTS_PREFIX.to_lowercase().trim_end_matches('/').to_lowercase() {
        return Err("不能替换整个 VRCAL_Imports 目录。".into());
    }
    let src = native(project_root, &key);
    if !src.is_dir() {
        return Ok(None);
    }
    if !src.join(".vrcal-import.json").is_file() {
        return Err(
            "这个目录不是工作台导入的（缺少 .vrcal-import.json），不能自动替换。请先在 Unity 里确认它是什么。"
                .into(),
        );
    }
    prune_trash();
    let leaf = src
        .file_name()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_else(|| "import".into());
    let root = trash_root();
    fs::create_dir_all(&root).map_err(|e| format!("建回收站失败：{e}"))?;
    let dst = root.join(format!("{}-{}", sanitize_name(&leaf), now_ms()));
    // 同盘 rename 是瞬时的；跨盘（工程在别的分区）退化成复制 + 删除
    if fs::rename(&src, &dst).is_err() {
        copy_tree(&src, &dst).map_err(|e| format!("移到回收站失败：{e}"))?;
        fs::remove_dir_all(&src).map_err(|e| format!("移除旧目录失败：{e}"))?;
    }
    Ok(Some(dst))
}

/// 复制失败时把回收站里的旧目录放回去，别让用户两头落空
fn restore_import_dir(project_root: &Path, dest_rel: &str, trashed: &Option<PathBuf>) {
    if let Some(from) = trashed {
        let to = native(project_root, dest_rel);
        if to.exists() {
            let _ = fs::remove_dir_all(&to);
        }
        if fs::rename(from, &to).is_err() {
            let _ = copy_tree(from, &to);
        }
    }
}

/* ============================ 对外接口 ============================ */

/// /api/wb/probe —— 工程校验 + 依赖就绪（只读）
/* ============================ 关闭窗口前的确认 ============================ */

/// 「导入还在进行」的租约到期时间（毫秒）。前端在导入期间每 40 秒续一次，
/// 做成租约而不是布尔值：页面崩了 / 事件没绑上时，窗口不会被永远锁住。
static BUSY_UNTIL_MS: AtomicU64 = AtomicU64::new(0);

/// 窗口收到 CloseRequested 时问一句：现在能直接关吗？
pub fn import_busy_now() -> bool {
    let until = BUSY_UNTIL_MS.load(Ordering::Relaxed);
    until > 0 && until > now_ms()
}

/// /api/wb/setImportBusy —— 前端告诉我们「还在导入」，并按 keepMs 续期；busy=false 立刻解除。
pub async fn set_import_busy(v: &Value) -> Result<Value, String> {
    let busy = v.get("busy").and_then(|x| x.as_bool()).unwrap_or(false);
    if busy {
        let keep = v
            .get("keepMs")
            .and_then(|x| x.as_u64())
            .unwrap_or(120_000)
            .clamp(5_000, 30 * 60_000);
        BUSY_UNTIL_MS.store(now_ms().saturating_add(keep), Ordering::Relaxed);
    } else {
        BUSY_UNTIL_MS.store(0, Ordering::Relaxed);
    }
    Ok(json!({ "ok": true, "busy": busy }))
}

/// /api/wb/quitNow —— 用户在「确定退出？」里点了退出。给 IPC 一点时间把返回值送回去再退出。
pub async fn quit_now(_v: &Value) -> Result<Value, String> {
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(150));
        std::process::exit(0);
    });
    Ok(json!({ "ok": true }))
}

pub async fn probe(v: &Value) -> Result<Value, String> {
    let p = s_of(v, "path");
    if p.is_empty() {
        return Err("缺少工程路径".into());
    }
    let v2 = v.clone();
    tokio::task::spawn_blocking(move || probe_sync(&v2))
        .await
        .map_err(|e| e.to_string())?
}

fn probe_sync(v: &Value) -> Result<Value, String> {
    let raw = s_of(v, "path");
    let root = PathBuf::from(&raw);
    if !root.is_dir() {
        return Ok(json!({ "ok": true, "valid": false, "missing": ["(目录不存在)"], "root": raw }));
    }
    let mut missing: Vec<&str> = Vec::new();
    for name in project_parts() {
        match fs::metadata(root.join(name)) {
            Ok(m) if m.is_dir() => {}
            _ => missing.push(name),
        }
    }
    if !missing.is_empty() {
        return Ok(json!({ "ok": true, "valid": false, "missing": missing, "root": raw }));
    }

    let version = editor_version(&root);
    let (deps, notes) = readiness(&root);
    let name = root
        .file_name()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_else(|| raw.clone());

    // 两个 Unity 助手的安装状态（Assets 里有界搜索）
    let bridge_installed =
        find_named_file(&root.join("Assets"), BRIDGE_FILE_NAME).is_some();
    let ma_installed = find_named_file(&root.join("Assets"), MA_FILE_NAME).is_some();

    Ok(json!({
        "ok": true,
        "valid": true,
        "root": raw,
        "name": name,
        "unityVersion": version,
        "dependencies": deps,
        "notes": notes,
        "bridgeInstalled": bridge_installed,
        "maInstalled": ma_installed,
        "checkedAt": now_ms()
    }))
}

/// /api/wb/hash —— 单文件 sha256（流式，不整读进内存）
pub async fn hash(v: &Value) -> Result<Value, String> {
    let p = s_of(v, "path");
    if p.is_empty() {
        return Err("缺少 path".into());
    }
    let v2 = v.clone();
    tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let path = PathBuf::from(s_of(&v2, "path"));
        let mut f = fs::File::open(&path).map_err(|e| format!("无法读取文件：{e}"))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 256 * 1024];
        let mut total = 0u64;
        loop {
            let n = f.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            total += n as u64;
            hasher.update(&buf[..n]);
        }
        let hex: String = hasher.finish().iter().map(|b| format!("{b:02x}")).collect();
        Ok(json!({ "ok": true, "sha256": hex, "size": total }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// /api/wb/plan —— 导入预检：清单、签名、GUID 冲突、目标目录（不写盘）
pub async fn plan(v: &Value) -> Result<Value, String> {
    let v2 = v.clone();
    tokio::task::spawn_blocking(move || plan_sync(&v2))
        .await
        .map_err(|e| e.to_string())?
}

fn plan_sync(v: &Value) -> Result<Value, String> {
    let project = s_of(v, "projectRoot");
    let source = s_of(v, "source");
    let job_id = s_of(v, "id");
    if project.is_empty() || source.is_empty() {
        return Err("缺少工程或素材路径。".into());
    }
    let root = PathBuf::from(&project);
    require_project(&root)?;

    let spath = PathBuf::from(&source);
    let mut smd = fs::metadata(&spath).map_err(|_| format!("素材路径不存在：{source}"))?;

    // L19：互相包含都拒绝
    if overlap(&project, &source) {
        return Err("素材与工程路径重叠（互相包含），请把它们放在不同目录。".into());
    }

    let source_name = if smd.is_dir() {
        spath
            .file_name()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_else(|| "Material".to_string())
    } else {
        spath
            .file_stem()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_else(|| "Material".to_string())
    };

    // .unitypackage（阶段 3）：不复制文件，走「请求 → Unity 助手 → 回执」的文件桥
    let is_package = smd.is_file()
        && spath
            .extension()
            .map(|e| e.to_string_lossy().eq_ignore_ascii_case("unitypackage"))
            .unwrap_or(false);
    if is_package {
        // 阶段 3/4 硬化：先认 gzip 魔数。误改后缀的普通文件在这里拒绝，
        // 不要等到 Unity 那边才炸出一句看不懂的导入错误。
        check_package_header(&spath)?;
        let installed = bridge_file(&root).is_some();
        let mut warnings: Vec<String> = Vec::new();
        if !installed {
            warnings.push(
                "工程里还没有安装 Unity 助手（VrclibImportBridge.cs），发送前需要先安装。".into(),
            );
        }
        warnings.push("导入位置由包内结构和 Unity 弹窗决定，不由本程序指定。".into());
        return Ok(json!({
            "ok": true,
            "mode": "unitypackage",
            "supported": true,
            "sourceName": source_name,
            "sourcePath": source,
            "projectRoot": project,
            "unityVersion": editor_version(&root),
            "fileCount": 1,
            "bytes": smd.len(),
            "signature": sha256_file(&spath)?,   // 包模式下签名就是包本身的 sha256
            "bridgeInstalled": installed,
            "conflicts": [],
            "ready": installed,
            "warnings": warnings
        }));
    }

    /* B1：素材目录自己带一层 Assets 时，和 importPath 一样剥掉。
       否则同一个素材从「手动入口」和「队列入口」会落成两种不同结构。 */
    let mut spath = spath;
    let mut stripped_assets = false;
    if smd.is_dir() && spath.join("Assets").is_dir() {
        spath = spath.join("Assets");
        if let Ok(m) = fs::metadata(&spath) {
            smd = m;
        }
        stripped_assets = true;
    }

    let walked = if smd.is_dir() {
        walk(&spath)?
    } else {
        Walked {
            files: vec![(
                spath
                    .file_name()
                    .map(|x| x.to_string_lossy().to_string())
                    .unwrap_or_else(|| "file".to_string()),
                smd.len(),
            )],
            warnings: Vec::new(),
        }
    };
    if walked.files.is_empty() {
        return Err("这个目录里没有可导入的文件。".into());
    }

    let signature = signature_of(&walked.files);
    let bytes: u64 = walked.files.iter().map(|(_, s)| *s).sum();
    let guids = source_guids(&spath, smd.is_dir(), &walked.files);
    let (conflicts, inspected) = find_conflicts(&root, &guids);

    let suffix: String = job_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .rev()
        .take(8)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let suffix = if suffix.len() >= 4 {
        suffix
    } else {
        signature.chars().take(8).collect()
    };
    let dest_rel = format!(
        "Assets/VRCAL_Imports/{}-{}",
        sanitize_name(&source_name),
        suffix
    );
    let dest_abs = native(&root, &dest_rel);

    /* 上次导入被中途杀掉时，目标目录里会留着 .vrcal-importing。
       这种情况要「接着拷」，不能按「替换旧版本」把目录整个重来一遍。 */
    let resuming = dest_abs.join(IMPORT_MARKER).is_file();

    /* B5：冲突全部来自「同一素材的上一次导入」时，别直接判死 ——
       给一个可替换的目标，前端会显示「替换旧版本」。
       另外：目标目录已存在且是我们的回执时（素材没有 .meta 的那种），同样可以替换。 */
    let mut replace_dir = String::new();
    if resuming {
        // 上次没拷完：已经有标记，接着复制即可
    } else if !conflicts.is_empty() {
        if let Some(d) = replaceable_dir(&conflicts, &source_name) {
            if is_import_dir(&root, &d) {
                replace_dir = d;
            }
        }
    } else if receipt_signature(&dest_abs).as_deref() == Some(signature.as_str()) {
        // 没有 GUID 冲突时，只有「跟上次导入的内容完全一致」才敢替换：
        // 同名但不同素材的目录，换掉会毁掉别人场景里的引用
        replace_dir = dest_rel.clone();
    }

    let mut warnings = walked.warnings.clone();
    if !replace_dir.is_empty() {
        warnings.push(format!(
            "工程里已有这个素材的上一次导入（{replace_dir}）。可以选「替换旧版本」：旧目录会移到回收站，不会直接删掉。"
        ));
    }
    if resuming {
        warnings.push("上次导入没有跑完（程序被关掉了）。这次会接着复制：已存在的文件跳过，只补剩下的。".into());
    }
    if stripped_assets {
        warnings.push("素材里带了一层 Assets，已只复制它里面的内容（避免变成 Assets/VRCAL_Imports/x/Assets/…）。".into());
    }
    if dest_abs.exists() && replace_dir.is_empty() {
        warnings.push("目标目录已存在：本次会跳过同名文件，不会覆盖。".into());
    }
    if inspected >= 300_000 {
        warnings.push("工程 Assets 文件过多，GUID 检查只覆盖了前 30 万个条目。".into());
    }
    if !guids.is_empty() && conflicts.is_empty() {
        warnings.push(format!("已核对 {} 个 .meta 的 GUID，无冲突。", guids.len()));
    }

    Ok(json!({
        "ok": true,
        "mode": "copy",
        "supported": true,
        "sourceName": source_name,
        // 剥过 Assets 之后真正要复制的目录；execute 会拿它复验签名
        "sourcePath": spath.to_string_lossy(),
        "sourceRoot": source,
        "projectRoot": project,
        "unityVersion": editor_version(&root),
        "fileCount": walked.files.len(),
        "bytes": bytes,
        "signature": signature,
        "destRel": dest_rel,
        "conflicts": conflicts,
        // 可替换的目标目录（空 = 不能替换）；替换只会把它移到回收站
        "replaceable": !replace_dir.is_empty(),
        "replaceDir": replace_dir,
        // 上次没跑完：可以接着拷，不用管冲突
        "resuming": resuming,
        "ready": conflicts.is_empty() || !replace_dir.is_empty() || resuming,
        "warnings": warnings
    }))
}

/// /api/wb/execute —— 真正复制（写 Assets/VRCAL_Imports/** 与本目录回执）
pub async fn execute(v: &Value) -> Result<Value, String> {
    let v2 = v.clone();
    tokio::task::spawn_blocking(move || execute_sync(&v2))
        .await
        .map_err(|e| e.to_string())?
}

fn execute_sync(v: &Value) -> Result<Value, String> {
    let project = s_of(v, "projectRoot");
    let source = s_of(v, "source");
    let dest_rel = s_of(v, "destRel");
    let expected = s_of(v, "signature");
    let job_id = s_of(v, "id");
    // 包模式没有 destRel（位置由 Unity 弹窗决定），不能拿它做必填校验
    let looks_like_package = source.to_lowercase().ends_with(".unitypackage");
    if project.is_empty() || source.is_empty() || (!looks_like_package && dest_rel.is_empty()) {
        return Err("缺少工程、素材或目标目录。".into());
    }

    let root = PathBuf::from(&project);
    require_project(&root)?;

    // .unitypackage 走文件桥（阶段 3），不进复制流程
    if looks_like_package {
        let spath = PathBuf::from(&source);
        let smd = fs::metadata(&spath).map_err(|_| format!("素材路径不存在：{source}"))?;
        if !smd.is_file() {
            return Err("这个路径不是 .unitypackage 文件。".into());
        }
        if overlap(&project, &source) {
            return Err("素材包与工程路径重叠（互相包含），已中止。".into());
        }
        return execute_package(&root, &project, &spath, &source, &expected);
    }

    // L50/L51：目标必须落在 Assets/VRCAL_Imports/ 下，且不含 .. 段
    let dest_key = dest_rel.replace('\\', "/");
    if !dest_key.to_lowercase().starts_with("assets/vrcal_imports/")
        || dest_key.contains("..")
        || dest_key.contains(':')
    {
        return Err("目标目录不在允许写入的范围内（Assets/VRCAL_Imports）。".into());
    }
    let dest_abs = native(&root, &dest_key);
    let resuming = dest_abs.join(IMPORT_MARKER).is_file();

    let spath = PathBuf::from(&source);
    let smd = fs::metadata(&spath).map_err(|_| format!("素材路径不存在：{source}"))?;
    if overlap(&project, &source) {
        return Err("素材与工程路径重叠（互相包含），已中止。".into());
    }

    // L25：执行前复验签名
    let walked = if smd.is_dir() {
        walk(&spath)?
    } else {
        Walked {
            files: vec![(
                spath
                    .file_name()
                    .map(|x| x.to_string_lossy().to_string())
                    .unwrap_or_else(|| "file".to_string()),
                smd.len(),
            )],
            warnings: Vec::new(),
        }
    };
    let signature = signature_of(&walked.files);
    if walked.files.is_empty() {
        // 空目录不能算「导入成功 0 个文件」—— 那会让用户以为导进去了
        return Err("这个目录里没有可导入的文件。".into());
    }
    if !expected.is_empty() && signature != expected {
        return Err("素材在上次预检之后发生了变化，请重新预检再导入。".into());
    }

    // L21：复制前再核一次 GUID，避免预检与执行之间工程变了
    let guids = source_guids(&spath, smd.is_dir(), &walked.files);
    let (conflicts, _) = find_conflicts(&root, &guids);

    /* B5：替换旧版本。
       replace 可以是具体目录（预检给的 replaceDir），也可以是 "auto"（队列入口用：
       只有冲突全部落在本次目标目录里才允许替换）。替换 = 移到回收站，不是删除。 */
    let replace_req = s_of(v, "replace");
    let mut trashed: Option<PathBuf> = None;
    let mut replaced_note = String::new();
    let auto = replace_req.eq_ignore_ascii_case("auto");
    let target_rel = if auto { dest_key.clone() } else { replace_req.clone() };
    // 没有 GUID 冲突时，只有内容签名跟旧回执一致才敢换目录（防同名不同素材）
    let same_as_before = receipt_signature(&dest_abs).as_deref() == Some(signature.as_str());
    let want_replace = !resuming
        && (!conflicts.is_empty()
            || (!target_rel.is_empty() && dest_abs.exists() && same_as_before));
    if want_replace {
        if target_rel.is_empty() {
            return Err(format!(
                "工程里已存在相同的 GUID（{}），已停止复制。请先核对后再处理。",
                conflicts
                    .first()
                    .and_then(|c| c.get("path"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("未知文件")
            ));
        }
        // 冲突必须全都在被替换的那个目录里，否则不是「同一素材的旧副本」
        let all_inside = conflicts.iter().all(|c| {
            let p = cmp_key(c.get("path").and_then(|x| x.as_str()).unwrap_or(""));
            p.starts_with(&format!("{}/", cmp_key(&target_rel)))
        });
        if !conflicts.is_empty() && !all_inside {
            return Err(format!(
                "工程里有其它资源与本次导入共用 GUID（{}），覆盖会破坏引用，已停止。",
                conflicts
                    .first()
                    .and_then(|c| c.get("path"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("未知文件")
            ));
        }
        trashed = trash_import_dir(&root, &target_rel)?;
        if trashed.is_some() {
            replaced_note = format!("已把上次导入的旧版本移到回收站（{target_rel}）。");
        }
    }

    if let Err(e) = fs::create_dir_all(&dest_abs) {
        restore_import_dir(&root, &target_rel, &trashed);
        return Err(format!("无法创建目标目录：{e}"));
    }

    // 先落「未完成」标记：中途被杀掉时，下次导入能认出这是半成品并接着拷
    let marker = dest_abs.join(IMPORT_MARKER);
    let _ = fs::write(&marker, b"1");

    let mut copied = 0usize;
    let mut skipped = 0usize;
    let mut bytes: u64 = 0;
    let mut warnings: Vec<String> = walked.warnings.clone();
    if !replaced_note.is_empty() {
        warnings.push(replaced_note);
    }
    if resuming {
        warnings.push("上次导入没有跑完，这次接着复制（已存在的文件跳过）。".into());
    }

    for (rel, _size) in &walked.files {
        let from = source_path(&spath, smd.is_dir(), rel);
        let to = native(&dest_abs, rel);
        if to.exists() {
            skipped += 1;
            continue;
        }
        if let Some(parent) = to.parent() {
            if fs::create_dir_all(parent).is_err() {
                skipped += 1;
                continue;
            }
        }
        match copy_file_atomic(&from, &to) {
            Ok(()) => {
                copied += 1;
                bytes += *_size;
            }
            Err(e) => {
                warnings.push(format!("复制失败：{rel}（{e}）"));
                skipped += 1;
            }
        }
    }

    if copied == 0 && skipped > 0 && !resuming {
        // 一个都没复制进去：把回收站里的旧版本放回去，别让用户两头空
        if trashed.is_some() {
            let _ = fs::remove_dir_all(&dest_abs);
            restore_import_dir(&root, &target_rel, &trashed);
        }
        return Err("目标目录里已存在同名文件，没有复制任何内容。".into());
    }

    // L28：回执
    let receipt = json!({
        "schema": 1,
        "id": job_id,
        "signature": signature,
        "dest": dest_key,
        "files": copied,
        "skipped": skipped,
        "bytes": bytes,
        "state": "completed",
        "at": now_ms()
    });
    let receipt_path = dest_abs.join(".vrcal-import.json");
    let _ = fs::write(
        &receipt_path,
        serde_json::to_vec_pretty(&receipt).unwrap_or_default(),
    );
    // 拷完了，撤掉「未完成」标记
    let _ = fs::remove_file(&marker);

    Ok(json!({
        "ok": true,
        "destRel": dest_key,
        "copied": copied,
        "skipped": skipped,
        "bytes": bytes,
        "signature": signature,
        "replaced": trashed.is_some(),
        // 旧版本去哪了（回收站里，可以手动找回）
        "trashPath": trashed
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        // 本次复制进来的预制件（阶段 4：MA 装配请求要用）
        "prefabs": walked.files.iter()
            .filter(|(rel, _)| rel.to_lowercase().ends_with(".prefab"))
            .map(|(rel, _)| format!("{dest_key}/{rel}"))
            .collect::<Vec<String>>(),
        "warnings": warnings
    }))
}

/// /api/wb/listDir —— 只列一层，给「查看工程文件」用
fn ext_eq(p: &Path, want: &str) -> bool {
    p.extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case(want))
        .unwrap_or(false)
}

fn find_packages(root: &Path, max_depth: usize, limit: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= limit {
            break;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for ent in entries.flatten() {
            let p = ent.path();
            let name = ent.file_name().to_string_lossy().to_string();
            if p.is_dir() {
                if depth + 1 > max_depth {
                    continue;
                }
                if matches!(name.as_str(), "Library" | "Temp" | "obj" | ".git" | "node_modules") {
                    continue;
                }
                stack.push((p, depth + 1));
            } else if ext_eq(&p, "unitypackage") {
                out.push(p);
                if out.len() >= limit {
                    break;
                }
            }
        }
    }
    out.sort();
    out
}

fn extract_progress_path() -> PathBuf {
    super::data_dir().join("extract-progress.json")
}

fn write_extract_progress(active: bool, file: &Path, entries: usize, total: usize, bytes: u64, dir: &Path) {
    let body = json!({
        "active": active,
        "file": file.to_string_lossy(),
        "name": file.file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default(),
        "entries": entries,
        "total": total,
        "bytes": bytes,
        "dir": dir.to_string_lossy()
    });
    let path = extract_progress_path();
    if let Some(p) = path.parent() {
        let _ = fs::create_dir_all(p);
    }
    let _ = fs::write(&path, serde_json::to_vec(&body).unwrap_or_default());
}

/// /api/wb/importProgress —— 解压进度（前端在弹窗里轮询）
pub async fn import_progress(_v: &Value) -> Result<Value, String> {
    let path = extract_progress_path();
    let body = fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or_else(|| json!({ "active": false }));
    Ok(body)
}

/* ---------------- 解压目录登记：只删「我们自己解压出来的」目录 ----------------
 * cleanupDir 是前端传进来的字符串，直接 remove_dir_all 等于把前端参数当删除命令用，
 * 传错一次就是删用户的整个素材目录。这里把每次解压生成的目录写进数据目录的登记表，
 * 只有登记过的路径才允许删；陌生路径一律拒绝（返回 false，不报错）。
 */
fn extract_roots_path() -> PathBuf {
    super::data_dir().join("extract-roots.json")
}

fn root_key(dir: &Path) -> String {
    cmp_key(&dir.to_string_lossy())
}

/* 两把锁分开：登记表与待清理表各自串行化。
   顺序上「持有待清理锁 → 取登记锁」是唯一的嵌套，反向不会发生（defer_cleanup 先读后写，
   读的时候锁已经放开），所以不会死锁。同一个进程里并发导入也不会互相踩掉登记。 */
static ROOTS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static CLEANUP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn guard(lock: &'static std::sync::Mutex<()>) -> std::sync::MutexGuard<'static, ()> {
    lock.lock().unwrap_or_else(|e| e.into_inner())
}

fn register_extract_root_at(registry: &Path, dir: &Path) {
    let _g = guard(&ROOTS_LOCK);
    let mut map = load_cleanup_at(registry);
    if let Some(obj) = map.as_object_mut() {
        // 顺手剔除已经不存在的目录，避免登记表只增不减
        let dead: Vec<String> = obj
            .iter()
            .filter(|(_, v)| v.as_str().map(|s| !Path::new(s).exists()).unwrap_or(true))
            .map(|(k, _)| k.clone())
            .collect();
        for k in dead {
            obj.remove(&k);
        }
        obj.insert(root_key(dir), json!(dir.to_string_lossy()));
    }
    save_cleanup_at(registry, &map);
}

fn forget_extract_root_locked(registry: &Path, dir: &Path) -> bool {
    let mut map = load_cleanup_at(registry);
    let key = root_key(dir);
    let known = map.get(&key).is_some();
    if let Some(obj) = map.as_object_mut() {
        obj.remove(&key);
    }
    if known {
        save_cleanup_at(registry, &map);
    }
    known
}

fn forget_extract_root_at(registry: &Path, dir: &Path) -> bool {
    let _g = guard(&ROOTS_LOCK);
    forget_extract_root_locked(registry, dir)
}

fn remove_extract_dir_at(registry: &Path, dir: &Path) -> bool {
    {
        let _g = guard(&ROOTS_LOCK);
        if !forget_extract_root_locked(registry, dir) {
            return false;
        }
    }
    // 删目录放在锁外面：大目录删起来慢，别把别的导入堵在锁上
    fs::remove_dir_all(dir).is_ok()
}

fn register_extract_root(dir: &Path) {
    register_extract_root_at(&extract_roots_path(), dir);
}

/// 删掉一个解压目录；没登记过 → 什么都不做，返回 false。
fn remove_extract_dir(dir: &Path) -> bool {
    remove_extract_dir_at(&extract_roots_path(), dir)
}

fn is_extract_root(dir: &Path) -> bool {
    let _g = guard(&ROOTS_LOCK);
    load_cleanup_at(&extract_roots_path())
        .get(&root_key(dir))
        .is_some()
}

/// 包导入还没结束，先别删；只接受登记过的解压目录（陌生路径不登记，避免以后被误删）
fn defer_cleanup(request_ids: &[String], dir: &Path) -> bool {
    if !is_extract_root(dir) {
        return false;
    }
    cleanup_register(request_ids, dir);
    true
}

/// 解压目录守卫：正常返回、提前 return、`?` 抛错都会走到 Drop。
/// 含 `.unitypackage` 的目录要等 Unity 回执，那条路径必须先 `disarm()`。
struct ExtractDir {
    path: PathBuf,
    armed: bool,
}

impl ExtractDir {
    fn new(dir: &Path) -> Self {
        Self { path: dir.to_path_buf(), armed: true }
    }
    fn disarm(&mut self) {
        self.armed = false;
    }
    fn remove_now(&mut self) -> bool {
        if !self.armed {
            return false;
        }
        self.armed = false;
        remove_extract_dir(&self.path)
    }
}

impl Drop for ExtractDir {
    fn drop(&mut self) {
        if self.armed {
            let _ = remove_extract_dir(&self.path);
        }
    }
}

/// Windows 会「接受但不落成你以为的文件」的名字：`bad:name.txt` 会被写成
/// 文件 `bad` 的备用数据流，`a?.txt` 会被截断成 `a`。这些必须提前拦，不能等建文件时看运气。
fn unsafe_name_component(name: &str) -> bool {
    let bad = |c: char| {
        matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20
    };
    if name.chars().any(bad) {
        return true;
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return true;
    }
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    RESERVED.contains(&stem.as_str())
}

/// 就地解压：<压缩包所在目录>/<包名>/，重名时追加 (2)(3)…。
/// 返回（解压目录, 警告）—— 个别文件名不合法时不算失败，但必须让用户知道少了什么。
fn extract_zip_beside(zip_path: &Path) -> Result<(PathBuf, Vec<String>), String> {
    let parent = zip_path
        .parent()
        .ok_or_else(|| "压缩包没有上级目录".to_string())?;
    let stem = zip_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unzipped".into());
    let mut dest = parent.join(&stem);
    let mut seq = 2;
    while dest.exists() {
        dest = parent.join(format!("{} ({})", stem, seq));
        seq += 1;
        if seq > 999 {
            return Err("同名解压目录过多，请先清理后再试。".into());
        }
    }
    fs::create_dir_all(&dest).map_err(|e| format!("无法创建解压目录：{e}"))?;
    let file = fs::File::open(zip_path).map_err(|e| format!("打不开压缩包：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| "这不是有效的 zip 压缩包".to_string())?;
    // 先登记：后面任何提前中止都能走统一清理，不留半成品
    register_extract_root(&dest);
    let mut total: u64 = 0;
    let entry_total = archive.len();
    let mut entry_done = 0usize;
    let mut warnings: Vec<String> = Vec::new();
    let mut unwritable: Vec<String> = Vec::new();
    write_extract_progress(true, zip_path, 0, entry_total, 0, &dest);
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let rel = match entry.enclosed_name() {
            Some(r) => r.to_path_buf(),
            None => continue,
        };
        if rel.components().count() > 24 {
            continue;
        }
        // 名字本身不合法：跳过并记账，别让它静默变成别的文件（见 unsafe_name_component）
        let illegal = rel.components().any(|c| match c {
            std::path::Component::Normal(n) => unsafe_name_component(&n.to_string_lossy()),
            _ => false,
        });
        if illegal {
            unwritable.push(rel.to_string_lossy().replace('\\', "/"));
            continue;
        }
        total = total.saturating_add(entry.size());
        entry_done += 1;
        if entry_done % 200 == 0 {
            write_extract_progress(true, zip_path, entry_done, entry_total, total, &dest);
        }
        if total > 8 * 1024 * 1024 * 1024 {
            let _ = remove_extract_dir(&dest);
            write_extract_progress(false, zip_path, entry_done, entry_total, total, &dest);
            return Err("压缩包解压后超过 8 GiB，已中止。".into());
        }
        let out = dest.join(&rel);
        if entry.is_dir() {
            let _ = fs::create_dir_all(&out);
            continue;
        }
        if let Some(p) = out.parent() {
            let _ = fs::create_dir_all(p);
        }
        let mut w = match fs::File::create(&out) {
            Ok(f) => f,
            Err(_) => {
                // Windows 上不合法的文件名（`?` `:` `<` 之类）—— 记下来，最后一次性报
                unwritable.push(rel.to_string_lossy().replace('\\', "/"));
                continue;
            }
        };
        if let Err(e) = std::io::copy(&mut entry, &mut w) {
            drop(w);
            let _ = fs::remove_file(&out);
            // 读不出来（加密包 / CRC 错 / 磁盘满）：整包都不可信，别留一堆 0 字节文件
            let _ = remove_extract_dir(&dest);
            write_extract_progress(false, zip_path, entry_done, entry_total, total, &dest);
            return Err(format!(
                "解压失败：{}（{e}）。如果压缩包设了密码，请先解开密码再导入。",
                rel.to_string_lossy().replace('\\', "/")
            ));
        }
    }
    write_extract_progress(false, zip_path, entry_total, entry_total, total, &dest);
    if !unwritable.is_empty() {
        warnings.push(format!(
            "有 {} 个文件因为文件名在 Windows 上不合法而没能解压：{}",
            unwritable.len(),
            unwritable.iter().take(5).cloned().collect::<Vec<_>>().join("、")
        ));
    }
    Ok((dest, warnings))
}

fn cleanup_fulfil(request_id: &str) {
    cleanup_fulfil_at(&cleanup_registry_path(), request_id);
}

/* ---------------- 解压目录清理 ---------------- */

/// 待清理表：requestId → 解压目录。包导入是异步的（要等 Unity 读包），
/// 所以不能在解压后立刻删；等回执进入终态再按这张表删。
fn cleanup_registry_path() -> PathBuf {
    super::data_dir().join("pending-cleanup.json")
}

fn load_cleanup_at(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({}))
}

fn save_cleanup_at(path: &Path, map: &Value) {
    if let Some(p) = path.parent() {
        let _ = fs::create_dir_all(p);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(map) {
        let _ = fs::write(path, bytes);
    }
}

fn cleanup_register_at(registry: &Path, request_ids: &[String], dir: &Path) {
    if request_ids.is_empty() {
        return;
    }
    let _g = guard(&CLEANUP_LOCK);
    let dir_key = dir.to_string_lossy().to_string();
    let mut map = load_cleanup_at(registry);
    let obj = match map.as_object_mut() {
        Some(o) => o,
        None => return,
    };
    // 超出保留期的条目顺手清掉：Unity 一直没开、回执永远不到时，目录不能永远赖着
    prune_cleanup(obj, now_ms());
    let entry = obj.entry(dir_key).or_insert_with(|| json!({ "ids": [], "at": now_ms() }));
    if entry.get("at").is_none() {
        entry["at"] = json!(now_ms());
    }
    if let Some(ids) = entry.get_mut("ids").and_then(|x| x.as_array_mut()) {
        for id in request_ids {
            if !ids.iter().any(|x| x.as_str() == Some(id.as_str())) {
                ids.push(json!(id));
            }
        }
    }
    save_cleanup_at(registry, &map);
}

/// 待清理目录最多留 7 天。包导入是异步的，但「一周还没回执」只可能是 Unity 不会再处理了。
const CLEANUP_MAX_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// 剔除过期条目，返回需要删除的目录（调用方负责真的删）
fn prune_cleanup(obj: &mut serde_json::Map<String, Value>, now: u64) -> Vec<String> {
    let mut stale: Vec<String> = Vec::new();
    for (dir, entry) in obj.iter() {
        let at = entry.get("at").and_then(|x| x.as_u64()).unwrap_or(0);
        // at 缺失（旧版本写的表）按过期处理，避免永远清不掉
        if at == 0 || now.saturating_sub(at) > CLEANUP_MAX_AGE_MS {
            stale.push(dir.clone());
        }
    }
    for dir in &stale {
        obj.remove(dir);
    }
    stale
}

fn cleanup_register(request_ids: &[String], dir: &Path) {
    cleanup_register_at(&cleanup_registry_path(), request_ids, dir);
}

/// 某个请求到终态：从表里摘掉；一个目录的所有请求都结束后删掉该目录。
fn cleanup_fulfil_at(registry: &Path, request_id: &str) {
    cleanup_fulfil_at_with_roots(registry, &extract_roots_path(), request_id);
}

fn cleanup_fulfil_at_with_roots(registry: &Path, roots: &Path, request_id: &str) {
    if request_id.is_empty() {
        return;
    }
    let _g = guard(&CLEANUP_LOCK);
    let mut map = load_cleanup_at(registry);
    let mut done: Vec<String> = Vec::new();
    if let Some(obj) = map.as_object_mut() {
        for (dir, entry) in obj.iter_mut() {
            if let Some(ids) = entry.get_mut("ids").and_then(|x| x.as_array_mut()) {
                ids.retain(|x| x.as_str() != Some(request_id));
                if ids.is_empty() {
                    done.push(dir.clone());
                }
            }
        }
        done.extend(prune_cleanup(obj, now_ms()));
        for dir in &done {
            obj.remove(dir);
        }
    }
    save_cleanup_at(registry, &map);
    for dir in done {
        // 只删登记过的解压目录，表被改坏也不会变成任意路径删除
        let _ = remove_extract_dir_at(roots, Path::new(&dir));
    }
}
/* ---------------- 解压后挑选导入 ---------------- */

/// /api/wb/inspectPath —— 判断素材到底是 zip、包、还是「装着 zip 的文件夹」
pub async fn inspect_path(v: &Value) -> Result<Value, String> {
    let path = s_of(v, "path");
    if path.trim().is_empty() {
        return Err("缺少素材路径。".into());
    }
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|_| format!("素材路径不存在：{path}"))?;
    if meta.is_dir() {
        let zips: Vec<String> = find_zips(&p, 2, 8)
            .iter()
            .map(|z| z.to_string_lossy().to_string())
            .collect();
        let has_packages = !find_packages(&p, 6, 200).is_empty();
        return Ok(json!({
            "ok": true,
            "kind": "dir",
            "hasPackages": has_packages,
            "zips": zips
        }));
    }
    let kind = if ext_eq(&p, "zip") {
        "zip"
    } else if ext_eq(&p, "unitypackage") {
        "unitypackage"
    } else {
        "file"
    };
    Ok(json!({ "ok": true, "kind": kind, "hasPackages": false, "zips": Vec::<String>::new() }))
}
/// /api/wb/listExtract —— 列出解压目录顶层内容，供用户勾选
/// 列目录的递归实现：前序压入节点，返回子树里的文件数（避免对每个目录再 walk 一遍）。
/// `.meta` 不单独列（Unity 的元数据，列出来只会把列表刷满）；隐藏项、__MACOSX 一起跳过。
const LIST_MAX_DEPTH: usize = 8;
const LIST_MAX_NODES: usize = 2000;

fn walk_list(
    root: &Path,
    rel: &str,
    depth: usize,
    out: &mut Vec<Value>,
    truncated: &mut bool,
) -> usize {
    if depth > LIST_MAX_DEPTH {
        *truncated = true;
        return 0;
    }
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    let it = match fs::read_dir(&dir) {
        Ok(i) => i,
        Err(_) => return 0,
    };
    let mut items: Vec<_> = it.flatten().collect();
    items.sort_by(|a, b| {
        let ad = a.path().is_dir();
        let bd = b.path().is_dir();
        // 目录排前面，同级按名字（不区分大小写）排
        bd.cmp(&ad).then_with(|| {
            a.file_name()
                .to_string_lossy()
                .to_lowercase()
                .cmp(&b.file_name().to_string_lossy().to_lowercase())
        })
    });

    let mut total_files = 0usize;
    for e in items {
        if out.len() >= LIST_MAX_NODES {
            *truncated = true;
            return total_files;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if name.starts_with('.')
            || lower == "__macosx"
            || lower == "thumbs.db"
            || lower == "desktop.ini"
            || lower.ends_with(".meta")
        {
            continue;
        }
        let path = e.path();
        let is_dir = path.is_dir();
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let size = if is_dir {
            0
        } else {
            fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
        };

        // 先占位压入父节点，递归回来再回填文件数（保持前序顺序）
        let idx = out.len();
        out.push(json!({
            "path": child_rel,
            "name": name,
            "dir": is_dir,
            "depth": depth,
            "size": size,
            "files": if is_dir { 0 } else { 1 },
            "package": lower.ends_with(".unitypackage")
        }));

        if is_dir {
            let sub = walk_list(root, &child_rel, depth + 1, out, truncated);
            out[idx]["files"] = json!(sub);
            total_files += sub;
        } else {
            total_files += 1;
        }
    }
    total_files
}

pub async fn list_extract(v: &Value) -> Result<Value, String> {
    let dir = s_of(v, "dir");
    if dir.trim().is_empty() {
        return Err("缺少解压目录。".into());
    }
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err("解压目录不存在。".into());
    }
    /* 递归列出整棵树：压缩包里常有「好几个文件夹、每个里面又有子目录」，
       只列顶层会让用户没法只导入其中一层。返回扁平列表（path + depth），
       前端按 depth 缩进、按 path 前缀管父子关系。 */
    let mut entries: Vec<Value> = Vec::new();
    let mut truncated = false;
    walk_list(&root, "", 0, &mut entries, &mut truncated);
    Ok(json!({
        "ok": true,
        "dir": dir,
        "entries": entries,
        "truncated": truncated
    }))
}

/// 启动清扫：本程序是单实例，刚起来时不可能有导入在跑，
/// 所以登记表里的解压目录都是上次异常退出（直接关窗口）留下的。
/// 唯一不能动的是「还在等 Unity 回执」的目录——包里那份 .unitypackage 可能还没被读走，
/// 这些留在 pending-cleanup 里按 7 天 TTL 处理。
pub fn sweep_orphan_extracts() -> (usize, usize) {
    let data = super::data_dir();
    /* 和导入抢同一张表：清扫期间不许有人登记新的解压目录，
       否则「读表 → 删目录 → 写回」可能把刚登记的条目覆盖掉。
       按既有顺序先待清理锁、再登记锁。 */
    let _cleanup = guard(&CLEANUP_LOCK);
    let _roots = guard(&ROOTS_LOCK);
    sweep_orphan_extracts_at(&data.join("extract-roots.json"), &data.join("pending-cleanup.json"))
}

fn sweep_orphan_extracts_at(roots_path: &Path, cleanup_path: &Path) -> (usize, usize) {
    let mut removed = 0usize;

    // 1) 待清理表里过期的（> 7 天）先删掉，别让它们永远赖着
    let mut cleanup = load_cleanup_at(cleanup_path);
    let mut expired: Vec<String> = Vec::new();
    if let Some(obj) = cleanup.as_object_mut() {
        expired = prune_cleanup(obj, now_ms());
        for d in &expired {
            obj.remove(d);
        }
        save_cleanup_at(cleanup_path, &cleanup);
    }
    for d in &expired {
        if fs::remove_dir_all(Path::new(d)).is_ok() {
            removed += 1;
        }
    }

    // 2) 还挂在待清理表里的目录要保住
    let mut keep: HashSet<String> = HashSet::new();
    if let Some(o) = cleanup.as_object() {
        for k in o.keys() {
            keep.insert(cmp_key(k));
        }
    }

    // 3) 登记表里不在 keep 的，全是孤儿
    let roots = load_cleanup_at(roots_path);
    let mut next = serde_json::Map::new();
    let mut kept = 0usize;
    if let Some(obj) = roots.as_object() {
        for (k, v) in obj.iter() {
            let path = match v.as_str() {
                Some(s) if !s.is_empty() => s,
                _ => continue,
            };
            if keep.contains(&cmp_key(path)) {
                next.insert(k.clone(), v.clone());
                kept += 1;
                continue;
            }
            if fs::remove_dir_all(Path::new(path)).is_ok() {
                removed += 1;
            }
        }
    }
    save_cleanup_at(roots_path, &Value::Object(next));
    (removed, kept)
}

/// /api/wb/discardExtract —— 丢掉一个解压目录（用户点「跳过」、解压后是空的、导入失败时用）。
/// 只认本程序登记过的解压目录，别的路径一律拒绝，绝不会变成任意删除。
pub async fn discard_extract(v: &Value) -> Result<Value, String> {
    let dir = s_of(v, "dir");
    if dir.trim().is_empty() {
        return Err("缺少目录。".into());
    }
    let p = PathBuf::from(&dir);
    let removed = remove_extract_dir(&p);
    Ok(json!({ "ok": true, "removed": removed, "dir": dir }))
}

/// /api/wb/importSelected —— 只导入用户勾选的那几项
pub async fn import_selected(v: &Value) -> Result<Value, String> {
    let v2 = v.clone();
    tokio::task::spawn_blocking(move || import_selected_sync(&v2))
        .await
        .map_err(|e| e.to_string())?
}

/// 复制结果：复制了几个、跳过几个、搬了多少字节
struct CopyStats {
    bytes: u64,
    copied: usize,
    skipped: usize,
}

/// 复制文件或整个目录。同名文件**跳过不覆盖**（与 execute 的口径一致）。
/// 单文件「先写临时名、再改名」：进程在复制途中被关掉时，目标位置不会留下半截文件
/// （Unity 拿到半个 fbx 会直接报资源损坏）。临时名以 .vrcalpart 结尾，遍历时会跳过。
fn copy_file_atomic(from: &Path, to: &Path) -> Result<(), String> {
    let stem = to
        .file_name()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let tmp = to.with_file_name(format!("{stem}.vrcalpart"));
    let _ = fs::remove_file(&tmp);
    fs::copy(from, &tmp).map_err(|e| format!("复制失败：{e}"))?;
    if let Err(e) = fs::rename(&tmp, to) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("落盘失败：{e}"));
    }
    Ok(())
}

fn copy_any(src: &Path, dst: &Path) -> Result<CopyStats, String> {
    let md = fs::metadata(src).map_err(|e| format!("读不到 {}：{e}", src.display()))?;
    if md.is_file() {
        if dst.exists() {
            return Ok(CopyStats { bytes: 0, copied: 0, skipped: 1 });
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
        }
        copy_file_atomic(src, dst)?;
        return Ok(CopyStats { bytes: md.len(), copied: 1, skipped: 0 });
    }
    let mut stats = CopyStats { bytes: 0, copied: 0, skipped: 0 };
    let files = walk(src)?.files;
    for (rel, _size) in files {
        let from = src.join(&rel);
        let to = dst.join(&rel);
        if to.exists() {
            stats.skipped += 1;
            continue;
        }
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
        }
        if let Ok(m) = fs::metadata(&from) {
            stats.bytes = stats.bytes.saturating_add(m.len());
        }
        copy_file_atomic(&from, &to).map_err(|e| format!("复制失败（{rel}）：{e}"))?;
        stats.copied += 1;
    }
    Ok(stats)
}

fn import_selected_sync(v: &Value) -> Result<Value, String> {
    let project = s_of(v, "projectRoot");
    let dir = s_of(v, "dir");
    if project.trim().is_empty() || dir.trim().is_empty() {
        return Err("缺少工程或解压目录。".into());
    }
    let keep_dir = v.get("keep").and_then(|x| x.as_bool()).unwrap_or(false);
    let picks: Vec<String> = v
        .get("pick")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if picks.is_empty() {
        return Err("没有勾选任何内容。".into());
    }
    let root = PathBuf::from(&project);
    require_project(&root)?;
    let src_root = PathBuf::from(&dir);
    if !src_root.is_dir() {
        return Err("解压目录不存在。".into());
    }
    let name = sanitize_name(
        &src_root
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "imported".into()),
    );
    let dest_rel = format!("Assets/VRCAL_Imports/{}", name);
    let dest = root.join("Assets").join("VRCAL_Imports").join(&name);
    let resuming = dest.join(IMPORT_MARKER).is_file();
    // 解压目录守卫：中途报错也要把它收拾掉（含包时改成等回执再删）
    let mut guard: Option<ExtractDir> = None;
    if !keep_dir && is_extract_root(&src_root) {
        guard = Some(ExtractDir::new(&src_root));
    }

    /* 勾选项只能落在解压目录里：`..` / 绝对路径 / 盘符一律拒绝，避免拿 pick 拼出目录外路径 */
    let mut chosen: Vec<(String, PathBuf)> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    for pick in picks.iter() {
        let rel = pick.replace('\\', "/");
        let bad = rel.split('/').any(|p| p == "..")
            || rel.starts_with('/')
            || rel.contains(':')
            || rel.is_empty();
        if bad {
            return Err(format!("勾选项路径不合法：{pick}"));
        }
        let p = src_root.join(Path::new(&rel));
        if !p.exists() {
            missing.push(pick.clone());
            continue;
        }
        chosen.push((rel, p));
    }
    if chosen.is_empty() {
        return Err("勾选的内容都不在了，请重新解压后再试。".into());
    }

    let mut jobs: Vec<Value> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    let mut pkg_ids: Vec<String> = Vec::new();
    let mut seq = 0u32;
    let mut copied = 0u64;
    let mut files = 0usize;
    let mut skipped = 0usize;
    let mut package_picks: Vec<PathBuf> = Vec::new();
    let mut replaced = false;

    if !missing.is_empty() {
        notes.push(format!("这些勾选项没找到，已跳过：{}", missing.join("、")));
    }

    /* 落「未完成」标记：中途被杀掉时，下次导入能认出这是半成品并接着拷 */
    let _ = fs::create_dir_all(&dest);
    let marker = dest.join(IMPORT_MARKER);
    let _ = fs::write(&marker, b"1");

    /* 先复制、最后发包：一个包装不上（Unity 没开 / 助手没装）不该把同批的文件夹一起废掉 */
    for (rel, src) in chosen.into_iter() {
        if src.is_file() && rel.to_lowercase().ends_with(".unitypackage") {
            package_picks.push(src);
            continue;
        }
        /* D5：Packages / ProjectSettings 是工程结构，不是素材。
           复制进 Assets 里既不会生效，还会给工程留下一堆看不懂的目录。 */
        if src.is_dir() && (rel.eq_ignore_ascii_case("Packages") || rel.eq_ignore_ascii_case("ProjectSettings")) {
            notes.push(if rel.eq_ignore_ascii_case("Packages") {
                "已跳过「Packages」：它是 Unity 工程的依赖包目录，复制进 Assets 不会生效；需要这些包请用 VCC 安装。".to_string()
            } else {
                "已跳过「ProjectSettings」：它是工程设置目录，不属于素材内容。".to_string()
            });
            continue;
        }
        // D8：复制前查 GUID 冲突。这里不做的话，覆盖 = Unity 里的引用指向错误资源
        let walked = if src.is_dir() {
            walk(&src)?.files
        } else {
            vec![(
                src.file_name()
                    .map(|x| x.to_string_lossy().to_string())
                    .unwrap_or_else(|| "file".to_string()),
                fs::metadata(&src).map(|m| m.len()).unwrap_or(0),
            )]
        };
        let guids = source_guids(&src, src.is_dir(), &walked);
        let (conflicts, _) = find_conflicts(&root, &guids);
        if !conflicts.is_empty() {
            /* B5：冲突全部落在「本次目标目录」里 → 这是同一素材的上一次导入，
               允许替换（旧目录进回收站）。有一条在外面就说明撞上了别的资源，必须拒绝。 */
            let prefix = format!("{}/", cmp_key(&dest_rel));
            let all_in_dest = conflicts.iter().all(|c| {
                cmp_key(c.get("path").and_then(|x| x.as_str()).unwrap_or("")).starts_with(&prefix)
            });
            if all_in_dest && !replaced && !resuming {
                trash_import_dir(&root, &dest_rel)?;
                replaced = true;
                notes.push("已把上次导入的旧版本移到回收站，再写入新内容。".to_string());
                let (after, _) = find_conflicts(&root, &guids);
                if !after.is_empty() {
                    let first = after
                        .first()
                        .and_then(|c| c.get("path"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("工程内已有文件");
                    return Err(format!("替换旧版本后仍然存在 GUID 冲突（{first}），已停止。"));
                }
            } else if !all_in_dest {
                let first = conflicts
                    .first()
                    .and_then(|c| c.get("path"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("工程内已有文件");
                return Err(format!(
                    "「{rel}」里有 {} 个 .meta 的 GUID 与工程现有文件重复（例如 {first}），已停止导入。拒绝覆盖是为了不让 Unity 的引用指错资源。",
                    conflicts.len()
                ));
            }
        }
        /* D4 + 层级选择：勾选项可以是 `Mod/Textures` 这种嵌套路径，目标要保留相对结构，
           否则两个同名子目录（A/Textures、B/Textures）会撞在一起。
           顶层 `Assets` 仍然剥掉，避免出现 Assets/VRCAL_Imports/x/Assets/… */
        let mut parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
        if !parts.is_empty() && parts[0].eq_ignore_ascii_case("Assets") && src.is_dir() {
            parts.remove(0);
        }
        let mut target = dest.clone();
        for part in &parts {
            target = target.join(part);
        }
        let st = copy_any(&src, &target)?;
        /* D6：目录里夹着 .unitypackage 时，现在只会被当普通文件复制 ——
           Unity 里看到一个二进制文件，装不了。至少要说出来。 */
        if src.is_dir() && !find_packages(&src, 4, 5).is_empty() {
            notes.push(format!(
                "「{rel}」里有 .unitypackage 文件，这次是按普通文件复制的，不会安装。需要安装请把它单独勾选导入。"
            ));
        }
        copied = copied.saturating_add(st.bytes);
        files += st.copied;
        skipped += st.skipped;
        if st.copied == 0 && st.skipped > 0 {
            notes.push(format!(
                "「{rel}」里全是同名文件，没有覆盖也没有新增；要更新请先用「替换旧版本」或手动删掉旧目录。"
            ));
        }
    }

    if files > 0 || skipped > 0 {
        let receipt = json!({
            "schema": 1,
            "id": format!("imp-{}-sel", now_ms()),
            "state": "completed",
            "message": "",
            "dest": dest_rel,
            "files": files,
            "bytes": copied,
            "skipped": skipped,
            "signature": ""
        });
        let _ = fs::create_dir_all(&dest);
        let _ = fs::write(
            dest.join(".vrcal-import.json"),
            serde_json::to_vec_pretty(&receipt).unwrap_or_default(),
        );
        jobs.push(json!({ "kind": "folder", "destRel": dest_rel, "result": receipt }));
    }

    for pkg in package_picks {
        let req = json!({
            "projectRoot": project,
            "id": format!("imp-{}-{}", now_ms(), { seq += 1; seq }),
            "source": pkg.to_string_lossy(),
            "destRel": "",
            "expected": ""
        });
        // D12：单个包失败记成 failed job，继续处理下一个，不再 `?` 掉整批
        match execute_sync(&req) {
            Ok(r) => {
                if let Some(rid) = r.get("requestId").and_then(|x| x.as_str()) {
                    if !rid.is_empty() {
                        pkg_ids.push(rid.to_string());
                    }
                }
                jobs.push(json!({ "kind": "package", "path": pkg.to_string_lossy(), "result": r }));
            }
            Err(e) => {
                jobs.push(json!({
                    "kind": "package",
                    "path": pkg.to_string_lossy(),
                    "result": { "ok": false, "state": "failed", "message": e }
                }));
            }
        }
    }

    /* 解压目录清理：只删登记过的解压目录；含包时等回执终态再删 */
    let mut cleaned = false;
    if keep_dir {
        // 用户选择保留：这条记录不再由我们管理，别留着以后误删
        let _ = forget_extract_root_at(&extract_roots_path(), &src_root);
    } else if let Some(g) = guard.as_mut() {
        if pkg_ids.is_empty() {
            cleaned = g.remove_now();
        } else {
            defer_cleanup(&pkg_ids, &g.path);
            g.disarm();
        }
    }

    // 拷完了（没有包要等回执）才撤标记；有包时标记留在原地没意义，一并撤掉
    let _ = fs::remove_file(&marker);

    Ok(json!({
        "ok": true,
        "dir": dir,
        "destRel": dest_rel,
        "cleanedUp": cleaned,
        "notes": notes,
        "jobs": jobs
    }))
}
/// /api/wb/importPath —— 素材库 → Unity 工程。
/// .zip 就地解压后按内容分派；文件夹整树复制进 Assets/VRCAL_Imports/<名字>；
/// .unitypackage 直接走已有的包导入链路。
pub async fn import_path(v: &Value) -> Result<Value, String> {
    let v2 = v.clone();
    tokio::task::spawn_blocking(move || import_path_sync(&v2))
        .await
        .map_err(|e| e.to_string())?
}

/// 目录里找压缩包（有界，跳过噪音目录）—— 用于「素材是装着 zip 的文件夹」这种形状
fn find_zips(root: &Path, max_depth: usize, limit: usize) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= limit || depth > max_depth {
            continue;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if path.is_dir() {
                if matches!(name.as_str(), ".git" | "library" | "temp" | "obj" | "node_modules" | "__macosx") {
                    continue;
                }
                stack.push((path, depth + 1));
            } else if name.ends_with(".zip") && out.len() < limit {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}
/// 列出 root 下「本次不会被打包走的」条目名（用于告诉用户丢了什么）
fn entries_beside(root: &Path, keep: Option<&Path>, skip: &[PathBuf]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Ok(rd) = fs::read_dir(root) {
        for e in rd.flatten() {
            let p = e.path();
            if let Some(k) = keep {
                if p == k {
                    continue;
                }
            }
            // 包本身、以及包含包的目录都不算「被丢掉」
            if skip.iter().any(|x| x == &p || x.starts_with(&p)) {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name.eq_ignore_ascii_case("__macosx") {
                continue;
            }
            out.push(if p.is_dir() { format!("{name}/") } else { name });
        }
    }
    out.sort();
    out
}

/// 完整工程结构只复制了 Assets 时，缺的依赖要说清楚
fn vpm_structure_note(root: &Path) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    if root.join("Packages").is_dir() {
        parts.push("Packages/");
    }
    if root.join("ProjectSettings").is_dir() {
        parts.push("ProjectSettings/");
    }
    if parts.is_empty() {
        return None;
    }
    Some(format!(
        "这份素材带的是完整 Unity 工程结构（含 {}）。工作台只复制了 Assets；\
如果素材依赖其中的包，请用 VCC 单独安装，否则 Unity 里可能报缺脚本 / 缺 shader。",
        parts.join("、")
    ))
}

fn import_path_sync(v: &Value) -> Result<Value, String> {
    let project = s_of(v, "projectRoot");
    let source = s_of(v, "path");
    let extract_only = v.get("extractOnly").and_then(|x| x.as_bool()).unwrap_or(false);
    let cleanup_dir = s_of(v, "cleanupDir");
    // 压缩包里再套压缩包时会递归进来；层数必须有上限，否则一个 zip 炸弹就能把磁盘铺满
    let depth = v.get("depth").and_then(|x| x.as_u64()).unwrap_or(0);
    if depth > 3 {
        return Err("压缩包套得太深（超过 3 层），已停止。请先手动解压后再导入。".into());
    }
    if project.trim().is_empty() || source.trim().is_empty() {
        return Err("缺少工程路径或素材路径。".into());
    }
    let root = PathBuf::from(&project);
    require_project(&root)?;
    let src = PathBuf::from(&source);
    let meta = fs::metadata(&src).map_err(|_| format!("素材路径不存在：{source}"))?;

    /* L19：解压之前就要判重叠。压缩包本身放在工程目录里时，解压结果会直接落进工程，
       Unity 会立刻把一半解开的目录当成资源导入 —— 这里必须先拦住。 */
    if overlap(&project, &source) {
        return Err("素材与工程路径重叠（互相包含），请把它们放在不同目录。".into());
    }

    let mut jobs: Vec<Value> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    let mut extracted: Option<String> = None;
    let mut target = src.clone();
    let mut is_dir = meta.is_dir();
    let mut seq = 0u32;
    let mut pkg_ids: Vec<String> = Vec::new();
    // 本轮解压出来的目录：无论成功、失败还是 `?` 抛错，都由守卫统一清理
    let mut own_guard: Option<ExtractDir> = None;
    // 前端分批解压后把目录传回来，同样挂守卫（未登记的路径不会建守卫）
    let mut param_guard: Option<ExtractDir> = None;
    if !cleanup_dir.trim().is_empty() {
        let d = PathBuf::from(&cleanup_dir);
        if is_extract_root(&d) {
            param_guard = Some(ExtractDir::new(&d));
        }
    }

    if !is_dir && ext_eq(&src, "zip") {
        let (dir, warns) = extract_zip_beside(&src)?;
        notes.extend(warns);
        notes.push(format!("已解压到 {}", dir.display()));
        extracted = Some(dir.to_string_lossy().to_string());
        own_guard = Some(ExtractDir::new(&dir));
        target = dir;
        is_dir = true;
    }

    /* 只解压、不入队：前端先批量解压（带进度），再按队列逐个导入 */
    if extract_only {
        // 目录交给前端挑选，这里不能删
        if let Some(g) = own_guard.as_mut() {
            g.disarm();
        }
        return Ok(json!({
            "ok": true,
            "source": source,
            "extractedTo": extracted,
            "cleanedUp": false,
            "notes": notes,
            "jobs": Vec::<Value>::new(),
            "hasPackages": extracted.as_ref().map(|d| !find_packages(std::path::Path::new(d), 6, 200).is_empty()).unwrap_or(false)
        }));
    }

    if is_dir {
        /* 素材是「只装着 zip 的文件夹」：先解压，再按解压结果递归导入，
           否则会把 zip 原样塞进工程（Unity 里看不到任何东西）。 */
        if find_packages(&target, 6, 200).is_empty() {
            let zips = find_zips(&target, 2, 8);
            if !zips.is_empty() {
                for z in zips.iter() {
                    let (dir, warns) = extract_zip_beside(z)?;
                    notes.extend(warns);
                    notes.push(format!("已解压 {}", z.display()));
                    // 子调用自己挂着 cleanupDir 守卫，成功/失败都会收拾
                    let sub = import_path_sync(&json!({
                        "projectRoot": project,
                        "path": dir.to_string_lossy(),
                        "cleanupDir": dir.to_string_lossy(),
                        "depth": depth + 1
                    }))?;
                    if let Some(list) = sub.get("jobs").and_then(|x| x.as_array()) {
                        jobs.extend(list.iter().cloned());
                    }
                    if let Some(list) = sub.get("notes").and_then(|x| x.as_array()) {
                        notes.extend(list.iter().filter_map(|x| x.as_str()).map(|s| s.to_string()));
                    }
                }
                return Ok(json!({
                    "ok": true,
                    "source": source,
                    "extractedTo": Value::Null,
                    "cleanedUp": false,
                    "notes": notes,
                    "jobs": jobs
                }));
            }
        }
        let packages = find_packages(&target, 6, 200);
        if packages.is_empty() {
            let raw = target
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "imported".into());
            let name = sanitize_name(&raw);
            let dest = format!("Assets/VRCAL_Imports/{}", name);
            /* VRChat 素材包通常解压出 <名>/Assets/…；直接拿外层会把 Assets 再套一层 */
            let mut body = target.clone();
            let mut src_dir = body.clone();
            if src_dir.join("Assets").is_dir() {
                src_dir = src_dir.join("Assets");
            } else {
                let kids: Vec<PathBuf> = fs::read_dir(&src_dir)
                    .map(|it| it.flatten().map(|e| e.path()).collect())
                    .unwrap_or_default();
                if kids.len() == 1 && kids[0].is_dir() {
                    body = kids[0].clone();
                    src_dir = body.clone();
                    if src_dir.join("Assets").is_dir() {
                        src_dir = src_dir.join("Assets");
                    }
                }
            }
            // E3：完整工程结构只取 Assets，依赖包不会自动装 —— 必须说出来
            if let Some(n) = vpm_structure_note(&body) {
                notes.push(n);
            }
            // E6：Assets 之外的兄弟条目被丢掉时也要说一声
            let ignored = entries_beside(&body, Some(&src_dir), &[]);
            if !ignored.is_empty() {
                notes.push(format!(
                    "已跳过 {}（不在 Assets 里，未复制进工程）",
                    ignored.join("、")
                ));
            }
            let r = execute_sync(&json!({
                "projectRoot": project,
                "id": format!("imp-{}-{}", now_ms(), { seq += 1; seq }),
                "source": src_dir.to_string_lossy(),
                "destRel": dest,
                "expected": "",
                // 冲突都落在同一目标目录时按「更新」处理（旧目录进回收站）
                "replace": "auto"
            }))?;
            for w in r.get("warnings").and_then(|x| x.as_array()).into_iter().flatten() {
                if let Some(t) = w.as_str() {
                    if t.contains("回收站") {
                        notes.push(t.to_string());
                    }
                }
            }
            jobs.push(json!({ "kind": "folder", "destRel": dest, "result": r }));
        } else {
            // E2：同时有包和其它内容时，其它内容会被忽略 —— 记进 notes，别静默
            let ignored = entries_beside(&target, None, &packages);
            if !ignored.is_empty() {
                notes.push(format!(
                    "这份素材里还有 {} 没有导入（本次只处理 .unitypackage）。需要的话请单独导入它们。",
                    ignored.join("、")
                ));
            }
            for pkg in packages {
                let req = json!({
                    "projectRoot": project,
                    "id": format!("imp-{}-{}", now_ms(), { seq += 1; seq }),
                    "source": pkg.to_string_lossy(),
                    "destRel": "",
                    "expected": ""
                });
                // 单个包失败不拖垮整批：记成 failed job，继续发下一个
                match execute_sync(&req) {
                    Ok(r) => {
                        if let Some(rid) = r.get("requestId").and_then(|x| x.as_str()) {
                            if !rid.is_empty() {
                                pkg_ids.push(rid.to_string());
                            }
                        }
                        jobs.push(json!({
                            "kind": "package",
                            "path": pkg.to_string_lossy(),
                            "result": r
                        }));
                    }
                    Err(e) => {
                        jobs.push(json!({
                            "kind": "package",
                            "path": pkg.to_string_lossy(),
                            "result": { "ok": false, "state": "failed", "message": e }
                        }));
                    }
                }
            }
        }
    } else if ext_eq(&src, "unitypackage") {
        let req = json!({
            "projectRoot": project,
            "id": format!("imp-{}-{}", now_ms(), { seq += 1; seq }),
            "source": source,
            "destRel": "",
            "expected": ""
        });
        let r = execute_sync(&req)?;
        if let Some(rid) = r.get("requestId").and_then(|x| x.as_str()) {
            if !rid.is_empty() {
                pkg_ids.push(rid.to_string());
            }
        }
        jobs.push(json!({ "kind": "package", "path": source, "result": r }));
    } else {
        return Err("只支持 .unitypackage、.zip 或文件夹。".into());
    }

    /* 解压目录清理：文件夹已经同步复制完 → 立刻删；
       包导入要等 Unity 读包 → 记进待清理表，等回执终态再删。 */
    let mut cleaned = false;
    for g in [own_guard.as_mut(), param_guard.as_mut()].into_iter().flatten() {
        if pkg_ids.is_empty() {
            if g.remove_now() {
                cleaned = true;
            }
        } else {
            defer_cleanup(&pkg_ids, &g.path);
            g.disarm();
        }
    }
    Ok(json!({
        "ok": true,
        "source": source,
        "extractedTo": extracted,
        "cleanedUp": cleaned,
        "notes": notes,
        "jobs": jobs
    }))
}

/// /api/wb/projectStatus —— 工程是否正被 Unity 打开（看 Temp/UnityLockfile）
pub async fn project_status(v: &Value) -> Result<Value, String> {
    let project = s_of(v, "projectRoot");
    if project.trim().is_empty() {
        return Err("缺少工程路径。".into());
    }
    let lock = PathBuf::from(&project).join("Temp").join("UnityLockfile");
    Ok(json!({
        "ok": true,
        "open": lock.exists(),
        "lock": lock.to_string_lossy()
    }))
}
pub async fn list_dir(v: &Value) -> Result<Value, String> {
    let root = s_of(v, "root");
    if root.is_empty() {
        return Err("缺少 root".into());
    }
    let v2 = v.clone();
    tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let base = PathBuf::from(s_of(&v2, "root"));
        let rel = s_of(&v2, "rel").replace('\\', "/");
        if rel.contains("..") {
            return Err("路径不合法。".into());
        }
        let dir = if rel.is_empty() {
            base.clone()
        } else {
            native(&base, &rel)
        };
        let limit = v2.get("limit").and_then(|x| x.as_u64()).unwrap_or(500) as usize;
        let mut dirs: Vec<Value> = Vec::new();
        let mut files: Vec<Value> = Vec::new();
        let rd = fs::read_dir(&dir).map_err(|e| format!("无法读取目录：{e}"))?;
        for ent in rd.flatten().take(limit) {
            let name = ent.file_name().to_string_lossy().to_string();
            let md = match ent.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let entry = json!({
                "name": name,
                "rel": join_rel(&rel, &name),
                "size": if md.is_dir() { 0 } else { md.len() },
                "mtime": md.modified().ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            });
            if md.is_dir() {
                dirs.push(entry);
            } else {
                files.push(entry);
            }
        }
        dirs.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        files.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        dirs.extend(files);
        Ok(json!({ "ok": true, "entries": dirs, "rel": rel }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// /api/wb/findUnity —— L45/L46：只认版本一致的那一个
pub async fn find_unity(v: &Value) -> Result<Value, String> {
    let version = s_of(v, "version");
    if version.is_empty() {
        return Ok(json!({ "ok": true, "path": "", "reason": "工程没有记录 Unity 版本" }));
    }
    let v2 = v.clone();
    tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let version = s_of(&v2, "version");
        for cand in unity_candidates(&version) {
            if cand.is_file()
                && cand
                    .file_name()
                    .map(|n| n.to_string_lossy().eq_ignore_ascii_case("Unity.exe"))
                    .unwrap_or(false)
            {
                return Ok(json!({
                    "ok": true,
                    "path": cand.to_string_lossy(),
                    "version": version
                }));
            }
        }
        Ok(json!({
            "ok": true,
            "path": "",
            "reason": format!("没有找到 Unity {version}，可以用「打开工程」手动选择，或直接在 Unity Hub 里打开。")
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn unity_candidates(version: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    // ② Unity Hub 的编辑器登记
    if let Ok(appdata) = std::env::var("APPDATA") {
        let hub = PathBuf::from(appdata).join("UnityHub").join("editors-v2.json");
        if let Some(txt) = read_capped(&hub, 4 * 1024 * 1024) {
            if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                if let Some(list) = v.get("data").and_then(|x| x.as_array()) {
                    for item in list {
                        if item.get("version").and_then(|x| x.as_str()) != Some(version) {
                            continue;
                        }
                        if let Some(locs) = item.get("location").and_then(|x| x.as_array()) {
                            for loc in locs {
                                if let Some(p) = loc.as_str() {
                                    if Path::new(p).is_absolute() {
                                        out.push(PathBuf::from(p));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // ③ 默认安装位置
    for env in ["ProgramFiles", "ProgramW6432"] {
        if let Ok(base) = std::env::var(env) {
            out.push(
                PathBuf::from(base)
                    .join("Unity")
                    .join("Hub")
                    .join("Editor")
                    .join(version)
                    .join("Editor")
                    .join("Unity.exe"),
            );
        }
    }

    out
}

/// /api/wb/launchUnity —— L47/L48：已经开着就不重复拉
pub async fn launch_unity(v: &Value) -> Result<Value, String> {
    let editor = s_of(v, "editor");
    let project = s_of(v, "projectRoot");
    if editor.is_empty() || project.is_empty() {
        return Err("缺少编辑器或工程路径。".into());
    }
    let root = PathBuf::from(&project);
    require_project(&root)?;

    let lock = root.join("Temp").join("UnityLockfile");
    if lock.is_file() {
        return Ok(json!({ "ok": true, "already": true, "message": "这个工程已经用 Unity 打开了。" }));
    }
    if !Path::new(&editor).is_file() {
        return Err(format!("编辑器不存在：{editor}"));
    }

    std::process::Command::new(&editor)
        .arg("-projectPath")
        .arg(&project)
        .spawn()
        .map_err(|e| format!("启动 Unity 失败：{e}"))?;

    Ok(json!({ "ok": true, "already": false }))
}

/// /api/wb/logTail —— 读 Unity Editor.log 末尾，给排查用
pub async fn log_tail(v: &Value) -> Result<Value, String> {
    let lines = v.get("lines").and_then(|x| x.as_u64()).unwrap_or(200) as usize;
    let lines = lines.clamp(20, 2000);
    tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let base = std::env::var("LOCALAPPDATA")
            .map_err(|_| "找不到 LOCALAPPDATA，无法定位 Unity 日志。".to_string())?;
        let log = PathBuf::from(base)
            .join("Unity")
            .join("Editor")
            .join("Editor.log");
        if !log.is_file() {
            return Ok(json!({
                "ok": true, "path": log.to_string_lossy(), "exists": false,
                "text": "", "message": "还没有 Unity 日志（打开过一次 Unity 之后才会有）。"
            }));
        }
        let mut f = fs::File::open(&log).map_err(|e| e.to_string())?;
        let total = f.metadata().map(|m| m.len()).unwrap_or(0);
        let from = total.saturating_sub(512 * 1024);
        let _ = f.seek(SeekFrom::Start(from));
        let mut buf = String::new();
        let _ = f.read_to_string(&mut buf);
        let all: Vec<&str> = buf.lines().collect();
        let start = all.len().saturating_sub(lines);
        Ok(json!({
            "ok": true,
            "path": log.to_string_lossy(),
            "exists": true,
            "text": all[start..].join("\n"),
            "truncated": from > 0
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ============================ 阶段 3：.unitypackage 文件桥 ============================ */
/* 协议与 assets/unity/VrclibImportBridge.cs 一一对应：
 *   请求：Library/VrclibBridge/Requests/<uuid>.json          （本程序写入）
 *   回执：Library/VrclibBridge/Results/<uuid>.json           （Unity 助手写入）
 * 请求字段 { schema:1, id, project, package, sha256 }；回执字段
 * { schema:1, id, sha256, state: importing|completed|cancelled|failed, message, assets, assetsComplete }。
 * 本程序只写 Library/VrclibBridge/Requests 和 Assets/Editor/VrclibImportBridge.cs，
 * 不碰工程其它任何位置。 */

/// 编译期把 Unity 助手源码嵌进二进制 —— 运行时不依赖仓库目录结构
const BRIDGE_SOURCE: &str = include_str!("../../../assets/unity/VrclibImportBridge.cs");
const MA_SOURCE: &str = include_str!("../../../assets/unity/VrclibMASetup.cs");
const BRIDGE_FILE_NAME: &str = "VrclibImportBridge.cs";
/// 助手心跳里约定的版本号（与 assets/unity/VrclibImportBridge.cs 的 BridgeVersion 一致）。
/// 不一致说明工程里装的是旧助手，前端会提示「更新 Unity 助手」。
const BRIDGE_PROTOCOL_VERSION: u32 = 2;
const MA_FILE_NAME: &str = "VrclibMASetup.cs";

/// 生成 UUID v4（不引 rand：RandomState 的种子每次进程不同，配合版本位足够当请求 ID 用）
fn uuid_v4() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut bytes = [0u8; 16];
    let mut filled = 0usize;
    while filled < 16 {
        let src = RandomState::new().build_hasher().finish().to_le_bytes();
        let take = (16 - filled).min(8);
        bytes[filled..filled + take].copy_from_slice(&src[..take]);
        filled += take;
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// 单个素材包上限 4 GiB。再大就不是「一份改模素材」了，
/// 也让桌面端在算 hash 之前就能明确拒绝，而不是把磁盘读穿。
const PACKAGE_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Unity 素材包是 tar.gz，头两字节固定 1f 8b。
fn check_package_header(path: &Path) -> Result<(), String> {
    let mut f = fs::File::open(path).map_err(|e| format!("打不开素材包：{e}"))?;
    let mut head = [0u8; 2];
    let n = f
        .read(&mut head)
        .map_err(|e| format!("读素材包失败：{e}"))?;
    if n < 2 || head != [0x1f, 0x8b] {
        return Err("这不是有效的 Unity 素材包（不是 gzip 格式）".into());
    }
    Ok(())
}

/// 请求 ID 必须长得像 UUID，防止拿它拼路径越界
fn valid_request_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// 流式算文件 sha256 —— unitypackage 可能几百 MB，不能整个读进内存
fn sha256_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut f = fs::File::open(path).map_err(|e| format!("打不开素材包：{e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| format!("读素材包失败：{e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finish().iter().map(|b| format!("{b:02x}")).collect())
}

/// 在工程 Assets 里找 Unity 助手（导入桥；有界搜索，跳过 Library/Temp 等噪音目录）
fn bridge_file(root: &Path) -> Option<std::path::PathBuf> {
    find_named_file(&root.join("Assets"), BRIDGE_FILE_NAME)
}

/// 包模式的执行：复验 sha256 → 写请求文件 → 等 Unity 认领
fn execute_package(
    root: &Path,
    project: &str,
    spath: &Path,
    source: &str,
    expected: &str,
) -> Result<Value, String> {
    if bridge_file(root).is_none() {
        return Err("工程里还没有 Unity 助手，请先在预览页点「安装 Unity 助手」。".into());
    }
    let md = fs::metadata(spath).map_err(|e| format!("读素材包信息失败：{e}"))?;
    if !md.is_file() {
        return Err("这个路径不是 .unitypackage 文件。".into());
    }
    if md.len() > PACKAGE_MAX_BYTES {
        return Err("素材包超过 4 GiB，工作台不支持这么大的包。".into());
    }
    check_package_header(spath)?;
    let actual = sha256_file(spath)?;
    if !expected.is_empty() && actual != expected {
        return Err("素材包在预检之后发生了变化，请重新预检再导入。".into());
    }
    let id = uuid_v4();
    let req = json!({
        "schema": 1,
        "id": id,
        "project": project,
        "package": source,
        "sha256": actual,
        "bytes": md.len(),
        "allowOverwrite": false,
    });
    let requests = root.join("Library").join("VrclibBridge").join("Requests");
    fs::create_dir_all(&requests).map_err(|e| format!("无法创建请求目录：{e}"))?;
    let tmp = requests.join(format!("{id}.json.tmp"));
    let final_path = requests.join(format!("{id}.json"));
    // 原子落盘：先写临时名再改名，Unity 侧只见完整文件
    fs::write(
        &tmp,
        serde_json::to_vec(&req).map_err(|e| format!("序列化请求失败：{e}"))?,
    )
    .map_err(|e| format!("写入请求失败：{e}"))?;
    fs::rename(&tmp, &final_path).map_err(|e| format!("落盘请求失败：{e}"))?;

    Ok(json!({
        "ok": true,
        "mode": "unitypackage",
        "requestId": id,
        "state": "waiting-unity",
        "destRel": "",
        "message": "请求已放进工程。打开 Unity 后助手会弹出官方导入窗口，等你在里面确认。"
    }))
}

/// /api/wb/receipt —— 查询 Unity 助手写回的回执
pub async fn receipt(v: &Value) -> Result<Value, String> {
    let v2 = v.clone();
    tokio::task::spawn_blocking(move || receipt_sync(&v2))
        .await
        .map_err(|e| e.to_string())?
}

/// 读 Unity 助手的「心跳」：Library/VrclibBridge/bridge.json（助手每次轮询覆盖一次）。
/// 用途只有一个 —— 队列等回执时能区分「助手没在跑」和「助手在跑但还没导完」，
/// 而不是一律显示「请切到 Unity 窗口」让用户干等。
/// 返回 (状态, 版本, 空闲?)：
///   missing —— 没有心跳文件（旧版助手，或者从没打开过工程）
///   stale   —— 有文件但 30 秒没更新（Unity 在编译 / 卡住 / 已关闭）
///   alive   —— 30 秒内还在跳
fn bridge_heartbeat(root: &Path) -> (String, u32, bool) {
    let path = root.join("Library").join("VrclibBridge").join("bridge.json");
    let md = match fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => return ("missing".into(), 0, true),
    };
    let age = md
        .modified()
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_secs())
        .unwrap_or(u64::MAX);
    // 过期也要读出内容：版本号仍然可信，不能拿「0 版」当成「装了旧助手」
    let body = read_json(&path).unwrap_or(Value::Null);
    let version = body.get("version").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    if age > 30 {
        return ("stale".into(), version, true);
    }
    let idle = body
        .get("active")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .is_empty();
    ("alive".into(), version, idle)
}

fn receipt_sync(v: &Value) -> Result<Value, String> {
    let project = s_of(v, "projectRoot");
    let id = s_of(v, "requestId");
    if project.is_empty() || id.is_empty() {
        return Err("缺少工程路径或请求 ID。".into());
    }
    // 请求 ID 必须长得像 UUID，防止拿它拼路径越界
    if !valid_request_id(&id) {
        return Err("请求 ID 格式不对。".into());
    }
    let root = PathBuf::from(&project);
    require_project(&root)?;

    let bridge_root = root.join("Library").join("VrclibBridge");
    let receipt_path = bridge_root.join("Results").join(format!("{id}.json"));
    let claimed = bridge_root.join("Requests").join(format!("{id}.json.claimed"));

    if !receipt_path.exists() {
        let (bridge, version, idle) = bridge_heartbeat(&root);
        return Ok(json!({
            "ok": true,
            "found": false,
            // 请求还没被认领 = Unity 没开或助手没编译好
            "queued": !claimed.exists(),
            "state": "waiting-unity",
            "bridge": bridge,
            "bridgeVersion": version,
            "bridgeCurrent": version == BRIDGE_PROTOCOL_VERSION,
            "active": !idle
        }));
    }
    let text = fs::read_to_string(&receipt_path).map_err(|e| format!("读回执失败：{e}"))?;
    let mut r: Value =
        serde_json::from_str(&text).map_err(|e| format!("回执不是合法 JSON：{e}"))?;
    let (bridge, version, idle) = bridge_heartbeat(&root);
    if let Some(obj) = r.as_object_mut() {
        obj.insert("ok".into(), json!(true));
        obj.insert("found".into(), json!(true));
        obj.insert("bridge".into(), json!(bridge));
        obj.insert("bridgeVersion".into(), json!(version));
        obj.insert("bridgeCurrent".into(), json!(version == BRIDGE_PROTOCOL_VERSION));
        obj.insert("active".into(), json!(!idle));
    }
    /* 终态到了：如果这次导入用的是临时解压目录，此刻才安全删除 */
    let terminal = r
        .get("state")
        .and_then(|x| x.as_str())
        .map(|s| matches!(s, "completed" | "failed" | "cancelled"))
        .unwrap_or(false);
    if terminal {
        cleanup_fulfil(&id);
    }
    Ok(r)
}

/// /api/wb/allowOverwrite —— 冲突闸门：把状态为 blocked 的回执换成
/// allowOverwrite:true 的请求，让 Unity 重新执行同一次导入（覆盖同名资源）。
pub async fn allow_overwrite(v: &Value) -> Result<Value, String> {
    let v2 = v.clone();
    tokio::task::spawn_blocking(move || allow_overwrite_sync(&v2))
        .await
        .map_err(|e| e.to_string())?
}

fn allow_overwrite_sync(v: &Value) -> Result<Value, String> {
    let project = s_of(v, "projectRoot");
    let id = s_of(v, "requestId");
    if project.is_empty() || id.is_empty() {
        return Err("缺少工程路径或请求 ID。".into());
    }
    if !valid_request_id(&id) {
        return Err("请求 ID 格式不对。".into());
    }
    let root = PathBuf::from(&project);
    require_project(&root)?;

    let bridge_root = root.join("Library").join("VrclibBridge");
    let results = bridge_root.join("Results");
    let receipt_path = results.join(format!("{id}.json"));
    let r = read_json(&receipt_path)
        .ok_or_else(|| "找不到这次导入的回执，无法确认冲突。".to_string())?;
    // blocked = Unity 发现了 GUID 冲突、没有导入、并且已删掉 .claimed（不会自动再执行）。
    // 只有这个状态才允许「仍要导入」，别的状态要么已完成、要么还在跑。
    if s_of(&r, "state") != "blocked" {
        return Err("这条导入没有待确认的冲突".into());
    }

    let package = s_of(&r, "package");
    let sha = s_of(&r, "sha256");
    let package_bytes = r
        .get("packageBytes")
        .and_then(|x| x.as_u64())
        .ok_or_else(|| "回执里缺少素材包大小，无法确认覆盖是否安全。".to_string())?;
    if package.is_empty() || sha.is_empty() {
        return Err("回执里缺少素材包信息，请重新预检后再导入。".into());
    }

    // 覆盖前再确认一次包没被换掉：大小和 sha256 都必须与回执一致
    let pkg = PathBuf::from(&package);
    let md = fs::metadata(&pkg)
        .map_err(|_| "素材包文件已经不在了，请重新预检后再导入。".to_string())?;
    if !md.is_file() {
        return Err("素材包路径不是文件，请重新预检后再导入。".into());
    }
    if md.len() != package_bytes {
        return Err("素材包大小和预检时不一致，请重新预检再导入。".into());
    }
    if sha256_file(&pkg)? != sha {
        return Err("素材包内容和预检时不一致，请重新预检再导入。".into());
    }

    // 旧回执改名归档：保留证据，同时让轮询不再看到这条 blocked
    let stamp = now_ms();
    let superseded = results.join(format!("{id}.json.superseded-{stamp}"));
    fs::rename(&receipt_path, &superseded)
        .map_err(|e| format!("无法归档旧回执：{e}"))?;

    let req = json!({
        "schema": 1,
        "id": id,
        "project": project,
        "package": package,
        "sha256": sha,
        "bytes": package_bytes,
        "allowOverwrite": true,
    });
    let requests = bridge_root.join("Requests");
    let publish = || -> Result<(), String> {
        fs::create_dir_all(&requests).map_err(|e| format!("无法创建请求目录：{e}"))?;
        let tmp = requests.join(format!("{id}.json.tmp"));
        let final_path = requests.join(format!("{id}.json"));
        fs::write(
            &tmp,
            serde_json::to_vec(&req).map_err(|e| format!("序列化请求失败：{e}"))?,
        )
        .map_err(|e| format!("写入请求失败：{e}"))?;
        fs::rename(&tmp, &final_path).map_err(|e| format!("落盘请求失败：{e}"))?;
        Ok(())
    };
    if let Err(e) = publish() {
        // 回滚：请求没发出去，就把 blocked 回执放回原处。
        // 否则这条记录会「既没有回执、也没有请求」，界面永远停在等待。
        let _ = fs::rename(&superseded, &receipt_path);
        return Err(e);
    }

    Ok(json!({
        "ok": true,
        "requestId": id,
        "state": "waiting-unity"
    }))
}

/// /api/wb/installBridge —— 把 Unity 助手装进工程（Assets/Editor/）
pub async fn install_bridge(v: &Value) -> Result<Value, String> {
    let v2 = v.clone();
    tokio::task::spawn_blocking(move || install_bridge_sync(&v2))
        .await
        .map_err(|e| e.to_string())?
}

fn install_bridge_sync(v: &Value) -> Result<Value, String> {
    let project = s_of(v, "projectRoot");
    if project.is_empty() {
        return Err("缺少工程路径。".into());
    }
    // update=true 时，已存在但内容与内嵌版本不同的助手会被就地更新
    let update = v.get("update").and_then(|x| x.as_bool()).unwrap_or(false);
    let root = PathBuf::from(&project);
    require_project(&root)?;

    let dest_dir = root.join("Assets").join("Editor");
    let mut installed: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut updated: Vec<String> = Vec::new();

    // 两个助手：导入桥 + MA 装配。已存在且内容一致 → 跳过；不一致且允许更新 → 原地覆盖
    for (file_name, source) in [(BRIDGE_FILE_NAME, BRIDGE_SOURCE), (MA_FILE_NAME, MA_SOURCE)] {
        if let Some(existing) = find_named_file(&root.join("Assets"), file_name) {
            let same = fs::read_to_string(&existing)
                .map(|c| c == source)
                .unwrap_or(false);
            if same {
                skipped.push(file_name.to_string());
            } else if update {
                fs::write(&existing, source)
                    .map_err(|e| format!("更新 {file_name} 失败：{e}"))?;
                updated.push(file_name.to_string());
            } else {
                skipped.push(format!(
                    "{file_name}（已存在旧版本，可点「更新 Unity 助手」升级）"
                ));
            }
            continue;
        }
        let dest = dest_dir.join(file_name);
        if dest.exists() {
            return Err(format!(
                "Assets/Editor/{file_name} 已存在但未被识别，为避免覆盖你的修改，请先手动处理。"
            ));
        }
        fs::create_dir_all(&dest_dir).map_err(|e| format!("无法创建 Assets/Editor：{e}"))?;
        fs::write(&dest, source).map_err(|e| format!("写入 {file_name} 失败：{e}"))?;
        installed.push(file_name.to_string());
    }

    let mut parts: Vec<String> = Vec::new();
    if !installed.is_empty() {
        parts.push(format!("已安装 {}", installed.join("、")));
    }
    if !updated.is_empty() {
        parts.push(format!("已更新 {}", updated.join("、")));
    }
    if parts.is_empty() {
        parts.push("两个 Unity 助手都已是最新版本".to_string());
    } else {
        parts.push("。回到 Unity 让它重新编译一次（右下角转圈结束）即生效".to_string());
    }

    Ok(json!({
        "ok": true,
        "installed": installed,
        "updated": updated,
        "skipped": skipped,
        "message": parts.join("")
    }))
}

/* ============================ 阶段 4：MA 装配请求 ============================ */
/* 协议与 assets/unity/VrclibMASetup.cs 对应：
 *   请求：Library/VrclibBridge/MARequests/<uuid>.json（本程序写入）
 *   回执：Library/VrclibBridge/MAResults/<uuid>.json（Unity 侧 MA 助手写入）
 * 请求 { schema:1, id, sha256, project, sourceName, mode, importId, prefabPaths, assemble, menu }
 * 回执 { schema:1, id, sha256, state: waiting-import|waiting-selection|applied|skipped|error, message, ... } */

/// /api/wb/maRequest —— 导入完成后发起 MA 装配请求
pub async fn ma_request(v: &Value) -> Result<Value, String> {
    let v2 = v.clone();
    tokio::task::spawn_blocking(move || ma_request_sync(&v2))
        .await
        .map_err(|e| e.to_string())?
}

fn ma_request_sync(v: &Value) -> Result<Value, String> {
    let project = s_of(v, "projectRoot");
    let source_name = s_of(v, "sourceName");
    let mode = s_of(v, "mode");
    let signature = s_of(v, "signature");
    let import_id = s_of(v, "importId");
    let menu = v.get("menu").and_then(|x| x.as_bool()).unwrap_or(false);
    let prefab_paths: Vec<String> = v
        .get("prefabPaths")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    if project.is_empty() || signature.len() != 64 || !signature.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("缺少工程路径或素材签名不合法。".into());
    }
    if mode != "copy" && mode != "unitypackage" {
        return Err("mode 只能是 copy 或 unitypackage。".into());
    }
    if mode == "unitypackage" && import_id.len() != 36 {
        return Err("包模式必须提供导入请求 ID（importId）。".into());
    }
    if source_name.is_empty() || source_name.len() > 1000 {
        return Err("素材名不合法（1~1000 字符）。".into());
    }
    if prefab_paths.len() > 1000 {
        return Err("预制件路径过多（上限 1000）。".into());
    }
    // 预制件路径必须是干净的 Assets/ 相对 .prefab 路径，且真实存在
    for p in &prefab_paths {
        let key = p.replace('\\', "/");
        if !key.to_lowercase().starts_with("assets/")
            || !key.to_lowercase().ends_with(".prefab")
            || key.contains("..")
            || key.contains(':')
        {
            return Err(format!("预制件路径不合法：{p}"));
        }
        if !native(&PathBuf::from(&project), &key).exists() {
            return Err(format!("预制件不存在：{p}"));
        }
    }

    let root = PathBuf::from(&project);
    require_project(&root)?;
    // MA 助手必须已安装（跟导入桥一起装的）
    if find_named_file(&root.join("Assets"), MA_FILE_NAME).is_none() {
        return Err("工程里还没有 MA 装配助手，请先安装 Unity 助手。".into());
    }
    // 包模式：对应的导入必须已完成
    if mode == "unitypackage" {
        let import_receipt = root
            .join("Library")
            .join("VrclibBridge")
            .join("Results")
            .join(format!("{import_id}.json"));
        let ok = fs::read_to_string(&import_receipt)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .map(|r| r.get("state").and_then(|s| s.as_str()) == Some("completed"))
            .unwrap_or(false);
        if !ok {
            return Err("对应的素材包还没完成导入，等导入完成后再发起 MA 装配。".into());
        }
    }

    let id = uuid_v4();
    let req = json!({
        "schema": 1,
        "id": id,
        "sha256": signature,
        "projectRoot": project,
        "sourceName": source_name,
        "mode": mode,
        "importId": if mode == "unitypackage" { import_id } else { "".to_string() },
        "prefabPaths": prefab_paths,
        "assemble": true,
        "menu": menu
    });
    let dir = root.join("Library").join("VrclibBridge").join("MARequests");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建 MA 请求目录：{e}"))?;
    let tmp = dir.join(format!("{id}.json.tmp"));
    let final_path = dir.join(format!("{id}.json"));
    fs::write(
        &tmp,
        serde_json::to_vec(&req).map_err(|e| format!("序列化 MA 请求失败：{e}"))?,
    )
    .map_err(|e| format!("写入 MA 请求失败：{e}"))?;
    fs::rename(&tmp, &final_path).map_err(|e| format!("落盘 MA 请求失败：{e}"))?;

    Ok(json!({
        "ok": true,
        "requestId": id,
        "state": "waiting-selection",
        "message": "MA 装配请求已放进工程。打开 Unity 后：角色和预制件都唯一时自动装配，否则会弹窗口让你选。"
    }))
}

/// /api/wb/maReceipt —— 查询 MA 装配回执
pub async fn ma_receipt(v: &Value) -> Result<Value, String> {
    let v2 = v.clone();
    tokio::task::spawn_blocking(move || ma_receipt_sync(&v2))
        .await
        .map_err(|e| e.to_string())?
}

fn ma_receipt_sync(v: &Value) -> Result<Value, String> {
    let project = s_of(v, "projectRoot");
    let id = s_of(v, "requestId");
    if project.is_empty() || id.is_empty() {
        return Err("缺少工程路径或请求 ID。".into());
    }
    let ok_shape = id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if !ok_shape {
        return Err("请求 ID 格式不对。".into());
    }
    let root = PathBuf::from(&project);
    require_project(&root)?;
    let path = root
        .join("Library")
        .join("VrclibBridge")
        .join("MAResults")
        .join(format!("{id}.json"));
    if !path.exists() {
        return Ok(json!({
            "ok": true,
            "found": false,
            "state": "waiting-selection"
        }));
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读 MA 回执失败：{e}"))?;
    let mut r: Value =
        serde_json::from_str(&text).map_err(|e| format!("MA 回执不是合法 JSON：{e}"))?;
    if let Some(obj) = r.as_object_mut() {
        obj.insert("ok".into(), json!(true));
        obj.insert("found".into(), json!(true));
    }
    Ok(r)
}

/// 按文件名在目录树里找文件（有界，跳过噪音目录）—— install_bridge 与 bridge_file 共用
fn find_named_file(dir: &Path, name: &str) -> Option<std::path::PathBuf> {
    fn rec(dir: &Path, name: &str, budget: &mut usize) -> Option<std::path::PathBuf> {
        if *budget == 0 {
            return None;
        }
        let rd = fs::read_dir(dir).ok()?;
        for entry in rd.flatten() {
            if *budget == 0 {
                return None;
            }
            *budget -= 1;
            let p = entry.path();
            let entry_name = entry.file_name().to_string_lossy().to_string();
            if p.is_dir() {
                if matches!(
                    entry_name.as_str(),
                    "Library" | "Temp" | "obj" | "bin" | ".git" | "Logs" | "UserSettings"
                ) {
                    continue;
                }
                if let Some(hit) = rec(&p, name, budget) {
                    return Some(hit);
                }
            } else if entry_name == name {
                return Some(p);
            }
        }
        None
    }
    let mut budget = 200_000usize;
    rec(dir, name, &mut budget)
}

/* ============================ 测试 ============================ */
/* 只跑真正会碰磁盘的那几条：预检、复制、GUID 拦截、路径重叠、sha256。
 * 跑法：cargo test --lib / cargo test（本文件在 bin crate 里，用 cargo test 即可） */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let p = std::env::temp_dir().join(format!("vrclib-wb-{tag}-{stamp}"));
            fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn path(&self) -> PathBuf { self.0.clone() }
    }
    impl Drop for TempDir {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    fn fake_project(root: &Path, version: &str) {
        for name in ["Assets", "Packages", "ProjectSettings"] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        fs::write(
            root.join("ProjectSettings").join("ProjectVersion.txt"),
            format!("m_EditorVersion: {version}\n"),
        ).unwrap();
        fs::write(
            root.join("Packages").join("vpm-manifest.json"),
            json!({"dependencies": {"com.vrchat.avatars": {"version": "3.7.1"}}}).to_string(),
        ).unwrap();
    }

    fn fake_material(root: &Path) -> PathBuf {
        let m = root.join("SomeOutfit");
        fs::create_dir_all(m.join("Prefabs")).unwrap();
        fs::write(m.join("Prefabs").join("Outfit.prefab"), "prefab").unwrap();
        fs::write(m.join("readme.txt"), "hello").unwrap();
        m
    }

    /// 造一个「看起来是 gzip」的包体：这里只校验头两字节，测试不需要真的压缩
    fn fake_package_bytes(body: &[u8]) -> Vec<u8> {
        let mut v = vec![0x1f, 0x8b];
        v.extend_from_slice(body);
        v
    }

    #[test]
    fn sha256_matches_reference_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn probe_reads_version_and_dependencies() {
        let t = TempDir::new("probe");
        let root = t.path().join("MyAvatar");
        fake_project(&root, "2022.3.22f1");

        let r = probe_sync(&json!({"path": root.to_string_lossy()})).unwrap();
        assert_eq!(r["valid"], true);
        assert_eq!(r["unityVersion"], "2022.3.22f1");
        let deps = r["dependencies"].as_array().unwrap();
        assert_eq!(deps.len(), 3);
        let sdk = deps.iter().find(|d| d["id"] == "com.vrchat.avatars").unwrap();
        assert_eq!(sdk["state"], "declared");
        assert_eq!(sdk["version"], "3.7.1");
        let ma = deps.iter().find(|d| d["id"] == "nadena.dev.modular-avatar").unwrap();
        assert_eq!(ma["state"], "unknown");
    }

    #[test]
    fn probe_rejects_folder_without_assets() {
        let t = TempDir::new("bad");
        let root = t.path().join("notaproject");
        fs::create_dir_all(root.join("Assets")).unwrap();
        let r = probe_sync(&json!({"path": root.to_string_lossy()})).unwrap();
        assert_eq!(r["valid"], false);
        let missing: Vec<&str> = r["missing"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap()).collect();
        assert!(missing.contains(&"Packages"));
        assert!(missing.contains(&"ProjectSettings"));
    }

    #[test]
    fn plan_then_execute_copies_and_writes_receipt() {
        let t = TempDir::new("import");
        let root = t.path().join("Proj");
        fake_project(&root, "2022.3.22f1");
        let material = fake_material(&t.path());

        let plan = plan_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": material.to_string_lossy(),
            "id": "job_1a2b3c4d"
        })).unwrap();
        assert_eq!(plan["mode"], "copy");
        assert_eq!(plan["fileCount"], 2);
        assert_eq!(plan["ready"], true);
        assert_eq!(plan["conflicts"].as_array().unwrap().len(), 0);

        let dest = plan["destRel"].as_str().unwrap().to_string();
        assert!(dest.starts_with("Assets/VRCAL_Imports/SomeOutfit-"));

        let done = execute_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": material.to_string_lossy(),
            "destRel": dest,
            "signature": plan["signature"],
            "id": "job_1a2b3c4d"
        })).unwrap();
        assert_eq!(done["copied"], 2);

        let target = native(&root, &dest);
        assert!(target.join("readme.txt").is_file());
        assert!(target.join("Prefabs").join("Outfit.prefab").is_file());
        assert!(target.join(".vrcal-import.json").is_file());
    }

    #[test]
    fn execute_refuses_when_source_changed() {
        let t = TempDir::new("changed");
        let root = t.path().join("Proj");
        fake_project(&root, "2022.3.22f1");
        let material = fake_material(&t.path());
        let plan = plan_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": material.to_string_lossy(),
            "id": "job_zzz1"
        })).unwrap();
        fs::write(material.join("extra.txt"), "changed").unwrap();

        let err = execute_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": material.to_string_lossy(),
            "destRel": plan["destRel"],
            "signature": plan["signature"],
            "id": "job_zzz1"
        })).unwrap_err();
        assert!(err.contains("发生了变化"), "实际错误：{err}");
    }

    #[test]
    fn guid_conflict_blocks_import() {
        let t = TempDir::new("guid");
        let root = t.path().join("Proj");
        fake_project(&root, "2022.3.22f1");
        let material = fake_material(&t.path());

        let guid = "0123456789abcdef0123456789abcdef";
        // 工程里已有一个用着这个 GUID 的资源
        fs::write(root.join("Assets").join("Existing.mat"), "x").unwrap();
        fs::write(
            root.join("Assets").join("Existing.mat.meta"),
            format!("fileFormatVersion: 2\nguid: {guid}\ntimeCreated: 1\n"),
        ).unwrap();
        // 素材里带了同一个 GUID 的 .meta
        fs::write(material.join("readme.txt.meta"), format!("fileFormatVersion: 2\nguid: {guid}\n")).unwrap();

        let plan = plan_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": material.to_string_lossy(),
            "id": "job_guid1"
        })).unwrap();
        assert_eq!(plan["ready"], false);
        assert_eq!(plan["conflicts"].as_array().unwrap().len(), 1);

        let err = execute_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": material.to_string_lossy(),
            "destRel": plan["destRel"],
            "signature": plan["signature"],
            "id": "job_guid1"
        })).unwrap_err();
        assert!(err.contains("GUID"), "实际错误：{err}");
    }

    #[test]
    fn rejects_overlapping_paths() {
        let t = TempDir::new("overlap");
        let root = t.path().join("Proj");
        fake_project(&root, "2022.3.22f1");
        let inside = root.join("Assets").join("SomeOutfit");
        fs::create_dir_all(&inside).unwrap();

        let err = plan_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": inside.to_string_lossy(),
            "id": "job_ov1"
        })).unwrap_err();
        assert!(err.contains("重叠"), "实际错误：{err}");
    }

    #[test]
    fn execute_refuses_path_outside_imports() {
        let t = TempDir::new("escape");
        let root = t.path().join("Proj");
        fake_project(&root, "2022.3.22f1");
        let material = fake_material(&t.path());

        let err = execute_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": material.to_string_lossy(),
            "destRel": "Assets/../../evil",
            "id": "job_esc"
        })).unwrap_err();
        assert!(err.contains("允许写入"), "实际错误：{err}");
    }

    #[test]
    fn unitypackage_plan_reports_sha_and_bridge_state() {
        let t = TempDir::new("upkg");
        let root = t.path().join("Proj");
        fake_project(&root, "2022.3.22f1");
        let pkg = t.path().join("Outfit.unitypackage");
        let pkg_body = fake_package_bytes(b"pretend this is a gzipped unitypackage");
        fs::write(&pkg, &pkg_body).unwrap();

        let plan = plan_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": pkg.to_string_lossy(),
            "id": "job_pkg1"
        })).unwrap();
        assert_eq!(plan["mode"], "unitypackage");
        assert_eq!(plan["supported"], true);
        assert_eq!(plan["fileCount"], 1);
        assert_eq!(plan["bridgeInstalled"], false);
        assert_eq!(plan["ready"], false);
        assert_eq!(plan["signature"], sha256_hex(&pkg_body));

        // 没装助手时执行会被拦下
        let err = execute_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": pkg.to_string_lossy(),
            "signature": plan["signature"],
            "id": "job_pkg1"
        })).unwrap_err();
        assert!(err.contains("助手"), "实际错误：{err}");
    }

    #[test]
    fn install_bridge_then_package_roundtrip() {
        let t = TempDir::new("bridge");
        let root = t.path().join("Proj");
        fake_project(&root, "2022.3.22f1");
        let pkg = t.path().join("Outfit.unitypackage");
        let pkg_body = fake_package_bytes(b"package bytes");
        fs::write(&pkg, &pkg_body).unwrap();

        // 安装助手（一次装两个）
        let r1 = install_bridge_sync(&json!({ "projectRoot": root.to_string_lossy() })).unwrap();
        assert_eq!(r1["ok"], true);
        let installed1: Vec<&str> = r1["installed"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap()).collect();
        assert!(installed1.contains(&"VrclibImportBridge.cs"));
        assert!(installed1.contains(&"VrclibMASetup.cs"));
        assert!(root.join("Assets").join("Editor").join(BRIDGE_FILE_NAME).is_file());
        assert!(root.join("Assets").join("Editor").join(MA_FILE_NAME).is_file());
        // 内容 = 内嵌源码
        assert_eq!(
            fs::read_to_string(root.join("Assets").join("Editor").join(BRIDGE_FILE_NAME)).unwrap(),
            BRIDGE_SOURCE
        );
        // 重复安装 → 全部跳过
        let r2 = install_bridge_sync(&json!({ "projectRoot": root.to_string_lossy() })).unwrap();
        assert_eq!(r2["installed"].as_array().unwrap().len(), 0);
        assert_eq!(r2["skipped"].as_array().unwrap().len(), 2);

        // plan 现在报告已安装且 ready
        let plan = plan_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": pkg.to_string_lossy(),
            "id": "job_pkg2"
        })).unwrap();
        assert_eq!(plan["bridgeInstalled"], true);
        assert_eq!(plan["ready"], true);

        // 执行 → 请求文件落盘且字段齐全
        let done = execute_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": pkg.to_string_lossy(),
            "signature": plan["signature"],
            "id": "job_pkg2"
        })).unwrap();
        assert_eq!(done["mode"], "unitypackage");
        let rid = done["requestId"].as_str().unwrap().to_string();
        assert_eq!(rid.len(), 36);
        assert_eq!(&rid[14..15], "4"); // UUID v4 版本位
        let req_text = fs::read_to_string(
            root.join("Library").join("VrclibBridge").join("Requests").join(format!("{rid}.json"))
        ).unwrap();
        let req: Value = serde_json::from_str(&req_text).unwrap();
        assert_eq!(req["schema"], 1);
        assert_eq!(req["id"], rid.as_str());
        assert_eq!(req["project"], root.to_string_lossy().to_string());
        assert_eq!(req["package"], pkg.to_string_lossy().to_string());
        assert_eq!(req["sha256"], sha256_hex(&pkg_body));

        // 回执查询：还没有回执 → 排队中
        let q = receipt_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "requestId": rid
        })).unwrap();
        assert_eq!(q["found"], false);
        assert_eq!(q["state"], "waiting-unity");

        // 模拟 Unity 助手写回执
        let results = root.join("Library").join("VrclibBridge").join("Results");
        fs::create_dir_all(&results).unwrap();
        fs::write(
            results.join(format!("{rid}.json")),
            json!({
                "schema": 1, "id": rid, "sha256": sha256_hex(&pkg_body),
                "state": "completed", "message": "",
                "assets": ["Assets/VRCAL_Imports/Outfit.prefab"], "assetsComplete": true
            }).to_string()
        ).unwrap();
        let fin = receipt_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "requestId": rid
        })).unwrap();
        assert_eq!(fin["found"], true);
        assert_eq!(fin["state"], "completed");
        assert_eq!(fin["assets"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn package_execute_rejects_changed_source() {
        let t = TempDir::new("pkgchg");
        let root = t.path().join("Proj");
        fake_project(&root, "2022.3.22f1");
        let pkg = t.path().join("Outfit.unitypackage");
        fs::write(&pkg, fake_package_bytes(b"v1")).unwrap();
        install_bridge_sync(&json!({ "projectRoot": root.to_string_lossy() })).unwrap();

        let plan = plan_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": pkg.to_string_lossy(),
            "id": "job_chg"
        })).unwrap();
        fs::write(&pkg, fake_package_bytes(b"v2-changed")).unwrap();
        let err = execute_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": pkg.to_string_lossy(),
            "signature": plan["signature"],
            "id": "job_chg"
        })).unwrap_err();
        assert!(err.contains("发生了变化"), "实际错误：{err}");
    }

    #[test]
    fn uuid_v4_shape_is_stable() {
        for _ in 0..50 {
            let u = uuid_v4();
            assert_eq!(u.len(), 36);
            let parts: Vec<&str> = u.split('-').collect();
            assert_eq!(
                parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
                vec![8, 4, 4, 4, 12]
            );
            assert!(u.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
            assert!(u.chars().next().unwrap().is_ascii_hexdigit());
            assert_eq!(&u[14..15], "4");
            assert!(u.as_bytes()[19] == b'8' || u.as_bytes()[19] == b'9'
                || u.as_bytes()[19] == b'a' || u.as_bytes()[19] == b'b');
        }
    }

    #[test]
    fn ma_request_roundtrip_copy_mode() {
        let t = TempDir::new("macopy");
        let root = t.path().join("Proj");
        fake_project(&root, "2022.3.22f1");
        install_bridge_sync(&json!({ "projectRoot": root.to_string_lossy() })).unwrap();

        // 先复制导入一个带预制件的素材
        let m = t.path().join("SomeOutfit");
        fs::create_dir_all(&m).unwrap();
        fs::write(m.join("Outfit.prefab"), "prefab").unwrap();
        let plan = plan_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": m.to_string_lossy(),
            "id": "job_ma1"
        })).unwrap();
        let done = execute_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": m.to_string_lossy(),
            "destRel": plan["destRel"],
            "signature": plan["signature"],
            "id": "job_ma1"
        })).unwrap();
        let prefabs: Vec<String> = done["prefabs"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert_eq!(prefabs.len(), 1);
        assert!(prefabs[0].ends_with("/Outfit.prefab"));

        // 发起 MA 装配请求
        let sig = plan["signature"].as_str().unwrap().to_string();
        let r = ma_request_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "sourceName": "SomeOutfit",
            "mode": "copy",
            "signature": sig,
            "prefabPaths": prefabs,
            "menu": true
        })).unwrap();
        let rid = r["requestId"].as_str().unwrap().to_string();
        assert_eq!(rid.len(), 36);
        let req_text = fs::read_to_string(
            root.join("Library").join("VrclibBridge").join("MARequests").join(format!("{rid}.json"))
        ).unwrap();
        let req: Value = serde_json::from_str(&req_text).unwrap();
        assert_eq!(req["schema"], 1);
        assert_eq!(req["mode"], "copy");
        assert_eq!(req["assemble"], true);
        assert_eq!(req["menu"], true);
        assert_eq!(req["sha256"], sig);

        // 回执查询：还没有 → waiting-selection
        let q = ma_receipt_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "requestId": rid
        })).unwrap();
        assert_eq!(q["found"], false);
        assert_eq!(q["state"], "waiting-selection");

        // 模拟 Unity 写回执
        let results = root.join("Library").join("VrclibBridge").join("MAResults");
        fs::create_dir_all(&results).unwrap();
        fs::write(
            results.join(format!("{rid}.json")),
            json!({
                "schema": 1, "id": rid, "sha256": sig, "state": "applied",
                "message": "装配完成", "avatarName": "MyAvatar",
                "hierarchyPath": "MyAvatar/Outfit", "menuMode": "created"
            }).to_string()
        ).unwrap();
        let fin = ma_receipt_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "requestId": rid
        })).unwrap();
        assert_eq!(fin["found"], true);
        assert_eq!(fin["state"], "applied");
        assert_eq!(fin["avatarName"], "MyAvatar");
        assert_eq!(fin["menuMode"], "created");
    }

    #[test]
    fn ma_request_requires_completed_import_for_package_mode() {
        let t = TempDir::new("mapkg");
        let root = t.path().join("Proj");
        fake_project(&root, "2022.3.22f1");
        install_bridge_sync(&json!({ "projectRoot": root.to_string_lossy() })).unwrap();

        let err = ma_request_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "sourceName": "Outfit",
            "mode": "unitypackage",
            "signature": "a".repeat(64),
            "importId": "01234567-89ab-4cde-8f01-234567890abc",
            "menu": false
        })).unwrap_err();
        assert!(err.contains("还没完成导入"), "实际错误：{err}");
    }

    #[test]
    fn single_file_source_copies_without_nesting() {
        let t = TempDir::new("single");
        let root = t.path().join("Proj");
        fake_project(&root, "2022.3.22f1");
        let file = t.path().join("Body.fbx");
        fs::write(&file, b"fbx-bytes").unwrap();

        let plan = plan_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": file.to_string_lossy(),
            "id": "job_single1"
        })).unwrap();
        assert_eq!(plan["fileCount"], 1);

        let dest = plan["destRel"].as_str().unwrap().to_string();
        execute_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": file.to_string_lossy(),
            "destRel": dest,
            "signature": plan["signature"],
            "id": "job_single1"
        })).unwrap();

        let target = native(&root, &dest).join("Body.fbx");
        assert!(target.is_file(), "单文件应落在目标目录下，而不是嵌套一层目录");
        assert_eq!(fs::read(&target).unwrap(), b"fbx-bytes");
    }

    #[test]
    fn package_rejects_non_gzip_magic() {
        let t = TempDir::new("pkgmagic");
        let root = t.path().join("Proj");
        fake_project(&root, "2022.3.22f1");
        install_bridge_sync(&json!({ "projectRoot": root.to_string_lossy() })).unwrap();
        let pkg = t.path().join("NotAPackage.unitypackage");
        fs::write(&pkg, b"plain text renamed to .unitypackage").unwrap();

        let err = plan_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": pkg.to_string_lossy(),
            "id": "job_magic"
        })).unwrap_err();
        assert!(err.contains("gzip"), "实际错误：{err}");

        // 执行侧同样拦住（助手已装，拦它的必须是魔数而不是别的）
        let err2 = execute_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "source": pkg.to_string_lossy(),
            "signature": "",
            "id": "job_magic"
        })).unwrap_err();
        assert!(err2.contains("gzip"), "实际错误：{err2}");
    }

    #[test]
    fn allow_overwrite_rejects_receipt_that_is_not_blocked() {
        let t = TempDir::new("ovnotblocked");
        let root = t.path().join("Proj");
        fake_project(&root, "2022.3.22f1");
        let rid = uuid_v4();
        let results = root.join("Library").join("VrclibBridge").join("Results");
        fs::create_dir_all(&results).unwrap();
        fs::write(
            results.join(format!("{rid}.json")),
            json!({
                "schema": 1, "id": rid, "sha256": "00", "state": "completed",
                "message": "", "assets": [], "assetsComplete": true
            }).to_string()
        ).unwrap();

        let err = allow_overwrite_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "requestId": rid
        })).unwrap_err();
        assert!(err.contains("待确认的冲突"), "实际错误：{err}");

        // 没有回执时也不能放行
        let err2 = allow_overwrite_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "requestId": uuid_v4()
        })).unwrap_err();
        assert!(err2.contains("回执"), "实际错误：{err2}");
    }

    #[test]
    fn allow_overwrite_rewrites_request_and_archives_receipt() {
        let t = TempDir::new("ovok");
        let root = t.path().join("Proj");
        fake_project(&root, "2022.3.22f1");
        install_bridge_sync(&json!({ "projectRoot": root.to_string_lossy() })).unwrap();
        let pkg = t.path().join("Outfit.unitypackage");
        let pkg_body = fake_package_bytes(b"blocked package bytes");
        fs::write(&pkg, &pkg_body).unwrap();

        let rid = uuid_v4();
        let results = root.join("Library").join("VrclibBridge").join("Results");
        fs::create_dir_all(&results).unwrap();
        fs::write(
            results.join(format!("{rid}.json")),
            json!({
                "schema": 1, "id": rid, "sha256": sha256_hex(&pkg_body), "state": "blocked",
                "message": "发现 1 处 GUID 冲突",
                "assets": [], "assetsComplete": true,
                "conflicts": [{
                    "guid": "aaaabbbbccccddddeeeeffff00001111",
                    "existingPath": "Assets/Existing.mat",
                    "packagePath": "Assets/Incoming.mat"
                }],
                "overwrote": [], "manifestComplete": true,
                "package": pkg.to_string_lossy(), "packageBytes": pkg_body.len()
            }).to_string()
        ).unwrap();

        let r = allow_overwrite_sync(&json!({
            "projectRoot": root.to_string_lossy(),
            "requestId": rid
        })).unwrap();
        assert_eq!(r["ok"], true);
        assert_eq!(r["requestId"], rid.as_str());
        assert_eq!(r["state"], "waiting-unity");

        let req_text = fs::read_to_string(
            root.join("Library").join("VrclibBridge").join("Requests").join(format!("{rid}.json"))
        ).unwrap();
        let req: Value = serde_json::from_str(&req_text).unwrap();
        assert_eq!(req["schema"], 1);
        assert_eq!(req["id"], rid.as_str());
        assert_eq!(req["project"], root.to_string_lossy().to_string());
        assert_eq!(req["package"], pkg.to_string_lossy().to_string());
        assert_eq!(req["sha256"], sha256_hex(&pkg_body));
        assert_eq!(req["bytes"].as_u64().unwrap(), pkg_body.len() as u64);
        assert_eq!(req["allowOverwrite"], true);

        // 旧回执被改名归档，轮询不会再看到 blocked
        assert!(!results.join(format!("{rid}.json")).exists());
        let prefix = format!("{rid}.json.superseded-");
        let archived = fs::read_dir(&results).unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with(&prefix));
        assert!(archived, "旧回执没有归档");
    }
}

#[cfg(test)]
mod import_path_tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn zip_extracts_beside_source() {
        let base = std::env::temp_dir().join(format!("vrclib-zip-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let zip_path = base.join("pack.zip");
        {
            let f = fs::File::create(&zip_path).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("inner/a.txt", opts).unwrap();
            w.write_all(b"hello").unwrap();
            w.finish().unwrap();
        }
        let (dir, warns) = extract_zip_beside(&zip_path).unwrap();
        assert!(warns.is_empty(), "正常包不应该有警告");
        assert!(dir.starts_with(&base), "解压目录必须留在源盘");
        assert_eq!(dir.file_name().unwrap().to_string_lossy(), "pack");
        assert!(dir.join("inner").join("a.txt").exists());

        let (again, _) = extract_zip_beside(&zip_path).unwrap();
        assert_eq!(again.file_name().unwrap().to_string_lossy(), "pack (2)");
        // 这两个目录是「解压产物」，所以允许删；清完 base 才不会在临时目录里堆东西
        assert!(remove_extract_dir(&dir));
        assert!(remove_extract_dir(&again));
        assert!(!dir.exists() && !again.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn finds_packages_recursively() {
        let base = std::env::temp_dir().join(format!("vrclib-find-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("x").join("y")).unwrap();
        fs::write(base.join("top.unitypackage"), b"x").unwrap();
        fs::write(base.join("x").join("y").join("deep.unitypackage"), b"x").unwrap();
        fs::write(base.join("x").join("note.txt"), b"x").unwrap();
        let found = find_packages(&base, 6, 10);
        assert_eq!(found.len(), 2);
        let _ = fs::remove_dir_all(&base);
    }
}
#[cfg(test)]
mod import_path_flow_tests {
    use super::*;

    fn fake_project(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vrclib-proj-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Assets")).unwrap();
        fs::create_dir_all(root.join("Packages")).unwrap();
        fs::create_dir_all(root.join("ProjectSettings")).unwrap();
        fs::write(root.join("ProjectSettings").join("ProjectVersion.txt"), b"m_EditorVersion: 2022.3.21f1\n").unwrap();
        root
    }

    #[test]
    fn imports_folder_into_project() {
        let project = fake_project("folder");
        let src = std::env::temp_dir().join(format!("vrclib-src-{}", std::process::id()));
        let _ = fs::remove_dir_all(&src);
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.txt"), b"hi").unwrap();
        fs::write(src.join("sub").join("b.txt"), b"hi").unwrap();

        let out = import_path_sync(&json!({
            "projectRoot": project.to_string_lossy(),
            "path": src.to_string_lossy()
        }))
        .expect("import should succeed");

        let jobs = out["jobs"].as_array().unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0]["kind"], "folder");
        let dest = project.join("Assets").join("VRCAL_Imports");
        assert!(dest.exists(), "目标目录应被创建");
        let mut found = false;
        for ent in walk(&dest).unwrap().files {
            if ent.0.ends_with("a.txt") {
                found = true;
            }
        }
        assert!(found, "文件应被复制进工程");
        let _ = fs::remove_dir_all(&project);
        let _ = fs::remove_dir_all(&src);
    }

    #[test]
    fn rejects_unsupported_file() {
        let project = fake_project("bad");
        let f = std::env::temp_dir().join(format!("vrclib-note-{}.txt", std::process::id()));
        fs::write(&f, b"x").unwrap();
        let err = import_path_sync(&json!({
            "projectRoot": project.to_string_lossy(),
            "path": f.to_string_lossy()
        }))
        .unwrap_err();
        assert!(err.contains("只支持"), "应提示只支持三种来源，实际：{err}");
        let _ = fs::remove_dir_all(&project);
        let _ = fs::remove_file(&f);
    }
}

#[cfg(test)]
mod bridge_request_tests {
    use super::*;

    fn project_with_bridge(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vrclib-bridge-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Assets").join("Editor")).unwrap();
        fs::create_dir_all(root.join("Packages")).unwrap();
        fs::create_dir_all(root.join("ProjectSettings")).unwrap();
        fs::write(root.join("ProjectSettings").join("ProjectVersion.txt"), b"m_EditorVersion: 2022.3.21f1\n").unwrap();
        fs::write(
            root.join("Assets").join("Editor").join("VrclibImportBridge.cs"),
            b"// stub",
        )
        .unwrap();
        root
    }

    /// 回归：给 Unity 的请求必须用协议字段 `project`，不能把内部名 `projectRoot` 写进去。
    /// 这个错误会让助手回执「请求缺少工程路径」，包永远不会被导入。
    #[test]
    fn package_request_uses_bridge_field_names() {
        let project = project_with_bridge("pkg");
        let pkg = std::env::temp_dir().join(format!("vrclib-fake-{}.unitypackage", std::process::id()));
        fs::write(&pkg, b"\x1f\x8b\x08\x00\x00\x00\x00\x00payload").unwrap();

        execute_package(
            &project,
            &project.to_string_lossy(),
            &pkg,
            &pkg.to_string_lossy(),
            "",
        )
        .expect("写请求应成功");

        let reqs = project.join("Library").join("VrclibBridge").join("Requests");
        let entry = fs::read_dir(&reqs)
            .expect("请求目录应存在")
            .next()
            .expect("应写出一个请求")
            .unwrap();
        let v: Value = serde_json::from_slice(&fs::read(entry.path()).unwrap()).unwrap();

        assert_eq!(
            v.get("project").and_then(|x| x.as_str()),
            Some(project.to_string_lossy().as_ref()),
            "请求必须带 project 字段"
        );
        assert!(v.get("projectRoot").is_none(), "不能把内部键写进协议");
        assert!(v.get("package").and_then(|x| x.as_str()).is_some(), "必须带 package");

        let _ = fs::remove_dir_all(&project);
        let _ = fs::remove_file(&pkg);
    }
}

#[cfg(test)]
mod import_zip_shape_tests {
    use super::*;
    use std::io::Write;

    fn fake_project(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vrclib-zproj-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Assets")).unwrap();
        fs::create_dir_all(root.join("Packages")).unwrap();
        fs::create_dir_all(root.join("ProjectSettings")).unwrap();
        fs::write(root.join("ProjectSettings").join("ProjectVersion.txt"), b"m_EditorVersion: 2022.3.21f1\n").unwrap();
        root
    }

    /// 素材包常见结构是 <名>/Assets/…；解压后复制进工程时不能再套一层 Assets。
    #[test]
    fn zip_with_assets_layer_copies_contents_directly() {
        let project = fake_project("shape");
        let base = std::env::temp_dir().join(format!("vrclib-zipshape-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let zip_path = base.join("pack.zip");
        {
            let f = fs::File::create(&zip_path).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("pack/Assets/Test/a.txt", opts).unwrap();
            w.write_all(b"hello").unwrap();
            w.finish().unwrap();
        }

        let out = import_path_sync(&json!({
            "projectRoot": project.to_string_lossy(),
            "path": zip_path.to_string_lossy()
        }))
        .expect("解压导入应成功");
        assert_eq!(out["jobs"].as_array().unwrap().len(), 1);

        let direct = project.join("Assets").join("VRCAL_Imports").join("pack").join("Test").join("a.txt");
        let nested = project.join("Assets").join("VRCAL_Imports").join("pack").join("Assets").join("Test").join("a.txt");
        assert!(direct.exists(), "应直接落在 pack/Test/a.txt");
        assert!(!nested.exists(), "不应复制出嵌套的 Assets 目录");

        let _ = fs::remove_dir_all(&project);
        let _ = fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod cleanup_tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vrclib-clean-{}-{}", std::process::id(), tag));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// 文件夹导入是同步复制，解压目录应当在导入结束后立刻删除。
    #[test]
    fn zip_folder_import_removes_extraction_dir() {
        use std::io::Write;
        let project = tmpdir("proj");
        fs::create_dir_all(project.join("Assets")).unwrap();
        fs::create_dir_all(project.join("Packages")).unwrap();
        fs::create_dir_all(project.join("ProjectSettings")).unwrap();
        fs::write(project.join("ProjectSettings").join("ProjectVersion.txt"), b"m_EditorVersion: 2022.3.21f1\n").unwrap();

        let base = tmpdir("zip");
        let zip_path = base.join("pack.zip");
        {
            let f = fs::File::create(&zip_path).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("pack/a.txt", opts).unwrap();
            w.write_all(b"hi").unwrap();
            w.finish().unwrap();
        }

        let out = import_path_sync(&json!({
            "projectRoot": project.to_string_lossy(),
            "path": zip_path.to_string_lossy()
        }))
        .expect("导入应成功");

        assert_eq!(out["cleanedUp"], true, "文件夹导入后应清理解压目录");
        assert!(!base.join("pack").exists(), "解压目录不应残留");

        let _ = fs::remove_dir_all(&project);
        let _ = fs::remove_dir_all(&base);
    }

    /// 包导入是异步的：登记后不能立刻删；最后一个使用者结束后才删。
    #[test]
    fn registry_removes_dir_only_after_last_request() {
        let base = tmpdir("reg");
        let registry = base.join("pending-cleanup.json");
        let roots = base.join("extract-roots.json");
        let dir = tmpdir("extract");
        fs::write(dir.join("a.unitypackage"), b"x").unwrap();
        assert!(dir.exists());

        // 只有「我们自己解压出来的目录」才登记，也才允许被清理
        register_extract_root_at(&roots, &dir);
        cleanup_register_at(&registry, &["req-1".to_string(), "req-2".to_string()], &dir);
        assert!(dir.exists(), "登记时不能删目录");

        cleanup_fulfil_at_with_roots(&registry, &roots, "req-1");
        assert!(dir.exists(), "还有请求没结束，目录要保留");

        cleanup_fulfil_at_with_roots(&registry, &roots, "req-2");
        assert!(!dir.exists(), "最后一个请求结束应删除目录");

        let _ = fs::remove_dir_all(&base);
    }

    /// G5：没登记过的目录一律不删 —— 前端传错 cleanupDir 不能变成删用户目录。
    #[test]
    fn refuses_to_delete_unregistered_dir() {
        let base = tmpdir("guard");
        let roots = base.join("extract-roots.json");
        let user_dir = tmpdir("user-materials");
        fs::write(user_dir.join("keep.txt"), b"x").unwrap();

        assert!(!remove_extract_dir_at(&roots, &user_dir), "陌生目录必须拒绝");
        assert!(user_dir.exists(), "不能删掉用户自己的目录");

        register_extract_root_at(&roots, &user_dir);
        assert!(remove_extract_dir_at(&roots, &user_dir), "登记后才允许删");
        assert!(!user_dir.exists());

        let _ = fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod zip_in_folder_tests {
    use super::*;
    use std::io::Write;

    fn fake_project(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vrclib-zipfolder-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Assets")).unwrap();
        fs::create_dir_all(root.join("Packages")).unwrap();
        fs::create_dir_all(root.join("ProjectSettings")).unwrap();
        fs::write(root.join("ProjectSettings").join("ProjectVersion.txt"), b"m_EditorVersion: 2022.3.21f1\n").unwrap();
        root
    }

    /// 素材是「装着 zip 的文件夹」时：必须解压 zip 再导入，不能把 zip 原样复制进工程。
    #[test]
    fn folder_with_zip_is_extracted_not_copied() {
        let project = fake_project("proj");
        let base = std::env::temp_dir().join(format!("vrclib-zipsrc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let asset_dir = base.join("installer");
        fs::create_dir_all(&asset_dir).unwrap();
        let zip_path = asset_dir.join("installer.zip");
        {
            let f = fs::File::create(&zip_path).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("Assets/Test/b.txt", opts).unwrap();
            w.write_all(b"hi").unwrap();
            w.finish().unwrap();
        }

        let out = import_path_sync(&json!({
            "projectRoot": project.to_string_lossy(),
            "path": asset_dir.to_string_lossy()
        }))
        .expect("导入应成功");

        let dest = project.join("Assets").join("VRCAL_Imports");
        let copied = dest.join("installer").join("Test").join("b.txt");
        assert!(copied.exists(), "应导入解压后的内容");
        let stray_zip = dest.join("installer").join("installer.zip");
        assert!(!stray_zip.exists(), "不能把 zip 原样复制进工程");
        assert!(out.get("jobs").is_some());

        let _ = fs::remove_dir_all(&project);
        let _ = fs::remove_dir_all(&base);
    }
}
#[cfg(test)]
mod import_selected_tests {
    use super::*;

    fn fake_project(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vrclib-picksel-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Assets")).unwrap();
        fs::create_dir_all(root.join("Packages")).unwrap();
        fs::create_dir_all(root.join("ProjectSettings")).unwrap();
        fs::write(root.join("ProjectSettings").join("ProjectVersion.txt"), b"m_EditorVersion: 2022.3.21f1\n").unwrap();
        root
    }

    /// 只导入勾选项：勾 Assets → 内容剥掉 Assets 层；没勾的 readme 不复制。
    #[test]
    fn imports_only_picked_entries() {
        let project = fake_project("proj");
        let src = std::env::temp_dir().join(format!("vrclib-extract-{}", std::process::id()));
        let _ = fs::remove_dir_all(&src);
        fs::create_dir_all(src.join("Assets").join("Tool")).unwrap();
        fs::write(src.join("Assets").join("Tool").join("a.cs"), b"//x").unwrap();
        fs::write(src.join("readme.txt"), b"hi").unwrap();

        let out = import_selected_sync(&json!({
            "projectRoot": project.to_string_lossy(),
            "dir": src.to_string_lossy(),
            "pick": ["Assets"]
        }))
        .expect("应成功");

        let dest = project.join("Assets").join("VRCAL_Imports");
        let stem = src.file_name().unwrap().to_string_lossy().to_string();
        let picked = dest.join(&stem).join("Tool").join("a.cs");
        let nested = dest.join(&stem).join("Assets").join("Tool").join("a.cs");
        assert!(picked.exists(), "勾选的 Assets 内容应复制进目标目录");
        assert!(!nested.exists(), "不应保留 Assets 这一层");
        let skipped = dest.join(&stem).join("readme.txt");
        assert!(!skipped.exists(), "没勾的条目不应被复制");
        assert!(out.get("jobs").is_some());

        let _ = fs::remove_dir_all(&project);
        let _ = fs::remove_dir_all(&src);
    }
}

/* ============================ 边界条件回归测试 ============================ */
#[cfg(test)]
mod boundary_tests {
    use super::*;
    use std::io::Write;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vrclib-edge-{}-{}", std::process::id(), tag));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn project(tag: &str) -> PathBuf {
        let root = tmp(tag);
        for p in ["Assets", "Packages", "ProjectSettings"] {
            fs::create_dir_all(root.join(p)).unwrap();
        }
        fs::write(root.join("ProjectSettings").join("ProjectVersion.txt"), b"m_EditorVersion: 2022.3.21f1\n").unwrap();
        root
    }

    fn zip_of(path: &Path, entry: &str, body: &[u8]) {
        let f = fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(f);
        w.start_file(entry, zip::write::SimpleFileOptions::default()).unwrap();
        w.write_all(body).unwrap();
        w.finish().unwrap();
    }

    /// C9：压缩包放在工程里时，解压结果会直接落进工程 —— 必须在解压前拒绝。
    #[test]
    fn refuses_zip_inside_project_before_extracting() {
        let proj = project("zipinproj");
        let zip_path = proj.join("Assets").join("pack.zip");
        zip_of(&zip_path, "a.txt", b"hi");

        let err = import_path_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "path": zip_path.to_string_lossy(),
            "extractOnly": true
        }))
        .expect_err("工程内的压缩包必须被拒绝");
        assert!(err.contains("重叠"), "错误应说明路径重叠：{err}");
        assert!(!proj.join("Assets").join("pack").exists(), "不能先解压再判断");

        let _ = fs::remove_dir_all(&proj);
    }

    /// E12：空目录不能算「成功导入 0 个文件」。
    #[test]
    fn empty_folder_is_not_a_success() {
        let proj = project("emptyproj");
        let src = tmp("emptysrc");
        let err = import_path_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "path": src.to_string_lossy()
        }))
        .expect_err("空目录应报错");
        assert!(err.contains("没有可导入的文件"), "{err}");

        let _ = fs::remove_dir_all(&proj);
        let _ = fs::remove_dir_all(&src);
    }

    /// D7：勾选导入遇到同名文件要跳过，不能覆盖已有内容。
    #[test]
    fn selected_import_skips_existing_instead_of_overwriting() {
        let proj = project("pickproj");
        let src = tmp("picksrc");
        fs::create_dir_all(src.join("Assets").join("Tool")).unwrap();
        fs::write(src.join("Assets").join("Tool").join("a.cs"), b"new").unwrap();

        let stem = src.file_name().unwrap().to_string_lossy().to_string();
        let dest_file = proj
            .join("Assets").join("VRCAL_Imports").join(&stem)
            .join("Tool").join("a.cs");
        fs::create_dir_all(dest_file.parent().unwrap()).unwrap();
        fs::write(&dest_file, b"old").unwrap();

        import_selected_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "dir": src.to_string_lossy(),
            "pick": ["Assets"]
        }))
        .expect("应成功");

        assert_eq!(fs::read(&dest_file).unwrap(), b"old", "已有文件不能被覆盖");

        let _ = fs::remove_dir_all(&proj);
        let _ = fs::remove_dir_all(&src);
    }

    /// D8：勾选导入也要查 GUID 冲突（原实现直接覆盖，Unity 引用会指错资源）。
    #[test]
    fn selected_import_blocks_guid_conflict() {
        let proj = project("guidproj");
        fs::write(
            proj.join("Assets").join("existing.meta"),
            b"fileFormatVersion: 2\nguid: 0123456789abcdef0123456789abcdef\n",
        )
        .unwrap();

        let src = tmp("guidsrc");
        fs::create_dir_all(src.join("Assets").join("Tool")).unwrap();
        fs::write(
            src.join("Assets").join("Tool").join("a.cs.meta"),
            b"fileFormatVersion: 2\nguid: 0123456789abcdef0123456789abcdef\n",
        )
        .unwrap();
        fs::write(src.join("Assets").join("Tool").join("a.cs"), b"//x").unwrap();

        let err = import_selected_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "dir": src.to_string_lossy(),
            "pick": ["Assets"]
        }))
        .expect_err("GUID 冲突必须拦住");
        assert!(err.contains("GUID"), "{err}");

        let _ = fs::remove_dir_all(&proj);
        let _ = fs::remove_dir_all(&src);
    }

    /// D12：一个包装不上（没装助手）不该把同批的文件夹一起废掉。
    #[test]
    fn package_failure_does_not_drop_folder_copies() {
        let proj = project("mixedproj");
        let src = tmp("mixedsrc");
        fs::create_dir_all(src.join("Assets").join("Tool")).unwrap();
        fs::write(src.join("Assets").join("Tool").join("a.cs"), b"//x").unwrap();
        fs::write(src.join("thing.unitypackage"), b"\x1f\x8bnot-really").unwrap();

        let out = import_selected_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "dir": src.to_string_lossy(),
            "pick": ["Assets", "thing.unitypackage"]
        }))
        .expect("文件夹部分应当成功");

        let stem = src.file_name().unwrap().to_string_lossy().to_string();
        assert!(
            proj.join("Assets").join("VRCAL_Imports").join(&stem).join("Tool").join("a.cs").exists(),
            "文件夹内容应已复制"
        );
        let jobs = out["jobs"].as_array().unwrap();
        let failed = jobs.iter().filter(|j| j["result"]["ok"] == json!(false)).count();
        assert_eq!(failed, 1, "包失败应记成 failed job，而不是拖垮整批");

        let _ = fs::remove_dir_all(&proj);
        let _ = fs::remove_dir_all(&src);
    }

    /// D10：勾选项带 `..` 时不能跳出解压目录。
    #[test]
    fn rejects_pick_that_escapes_extract_dir() {
        let proj = project("escaperoj");
        let src = tmp("escapesrc");
        let err = import_selected_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "dir": src.to_string_lossy(),
            "pick": ["../outside"]
        }))
        .expect_err("越界勾选必须拒绝");
        assert!(err.contains("不合法"), "{err}");

        let _ = fs::remove_dir_all(&proj);
        let _ = fs::remove_dir_all(&src);
    }

    /// B1：手动入口也要剥掉素材自带的那层 Assets，两个入口落点要一致。
    #[test]
    fn plan_strips_leading_assets_layer() {
        let proj = project("planproj");
        let src = tmp("plansrc");
        fs::create_dir_all(src.join("Assets").join("Tool")).unwrap();
        fs::write(src.join("Assets").join("Tool").join("a.cs"), b"//x").unwrap();

        let r = plan_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "source": src.to_string_lossy(),
            "id": "job-abcd1234"
        }))
        .expect("预检应成功");

        let plan_source = PathBuf::from(r["sourcePath"].as_str().unwrap());
        assert_eq!(plan_source, src.join("Assets"), "预检应指向剥层后的 Assets");
        assert_eq!(r["fileCount"], json!(1));
        assert!(r["destRel"].as_str().unwrap().starts_with("Assets/VRCAL_Imports/"));

        let _ = fs::remove_dir_all(&proj);
        let _ = fs::remove_dir_all(&src);
    }

    /// G5：cleanupDir 传的是陌生路径时，不许删 —— 只有解压产物才归我们清理。
    #[test]
    fn import_path_refuses_to_delete_foreign_cleanup_dir() {
        let proj = project("cleanproj");
        let src = tmp("cleansrc");
        fs::create_dir_all(src.join("Tool")).unwrap();
        fs::write(src.join("Tool").join("a.cs"), b"//x").unwrap();
        fs::write(src.join("keep-me.txt"), b"user data").unwrap();

        let out = import_path_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "path": src.to_string_lossy(),
            "cleanupDir": src.to_string_lossy()
        }))
        .expect("导入应成功");

        assert_eq!(out["cleanedUp"], json!(false), "陌生目录不该被清理");
        assert!(src.join("keep-me.txt").exists(), "用户目录必须原样保留");

        let _ = fs::remove_dir_all(&proj);
        let _ = fs::remove_dir_all(&src);
    }

    /* ---------------- B5：替换旧版本 ---------------- */

    const GUID_A: &str = "0123456789abcdef0123456789abcdef";

    fn meta_with_guid(guid: &str) -> String {
        format!("fileFormatVersion: 2\nguid: {guid}\n")
    }

    /// 造一个「上次导入过的」目录：文件 + .meta + 回执
    fn seed_old_import(proj: &Path, dir_name: &str, guid: &str, signature: &str) -> PathBuf {
        let dir = proj.join("Assets").join("VRCAL_Imports").join(dir_name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.cs"), b"//old").unwrap();
        fs::write(dir.join("a.cs.meta"), meta_with_guid(guid)).unwrap();
        fs::write(
            dir.join(".vrcal-import.json"),
            serde_json::to_vec(&json!({ "schema": 1, "signature": signature, "dest": format!("Assets/VRCAL_Imports/{dir_name}") })).unwrap(),
        )
        .unwrap();
        dir
    }

    fn seed_source(base: &Path, folder: &str, guid: &str) -> PathBuf {
        let src = base.join(folder);
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.cs"), b"//new").unwrap();
        fs::write(src.join("a.cs.meta"), meta_with_guid(guid)).unwrap();
        src
    }

    /// 冲突全部来自同一素材的上一次导入 → 预检应给「可替换」，而不是直接判死。
    #[test]
    fn plan_marks_previous_import_as_replaceable() {
        let proj = project("b5plan");
        seed_old_import(&proj, "衣装-abcd1234", GUID_A, "old");
        let base = tmp("b5plansrc");
        let src = seed_source(&base, "衣装", GUID_A);

        let r = plan_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "source": src.to_string_lossy(),
            "id": "job-abcd1234"
        }))
        .expect("预检应成功");

        assert_eq!(r["conflicts"].as_array().unwrap().len(), 1, "应识别到 GUID 冲突");
        assert_eq!(r["replaceable"], json!(true), "同一素材的旧副本应可替换");
        assert_eq!(r["replaceDir"], json!("Assets/VRCAL_Imports/衣装-abcd1234"));
        assert_eq!(r["ready"], json!(true));

        let _ = fs::remove_dir_all(&proj);
        let _ = fs::remove_dir_all(&base);
    }

    /// 冲突来自工程里别的资源 → 不能替换，仍然拒绝。
    #[test]
    fn conflict_outside_imports_cannot_be_replaced() {
        let proj = project("b5outside");
        fs::create_dir_all(proj.join("Assets").join("Other")).unwrap();
        fs::write(proj.join("Assets").join("Other").join("x.meta"), meta_with_guid(GUID_A)).unwrap();
        let base = tmp("b5outsidesrc");
        let src = seed_source(&base, "衣装", GUID_A);

        let r = plan_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "source": src.to_string_lossy(),
            "id": "job-abcd1234"
        }))
        .expect("预检应成功");

        assert_eq!(r["replaceable"], json!(false));
        assert_eq!(r["ready"], json!(false), "撞到工程里别的资源必须拒绝");

        let _ = fs::remove_dir_all(&proj);
        let _ = fs::remove_dir_all(&base);
    }

    /// 替换：旧目录进回收站、新内容落到目标目录。
    #[test]
    fn execute_replace_moves_old_copy_to_trash() {
        let proj = project("b5exec");
        // 旧目录名的后缀与本次 job id 不同（真实场景里每次导入都是新的 job id）
        let old_dir = seed_old_import(&proj, "衣装-old00000", GUID_A, "old");
        let base = tmp("b5execsrc");
        let src = seed_source(&base, "衣装", GUID_A);

        let plan = plan_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "source": src.to_string_lossy(),
            "id": "job-abcd1234"
        }))
        .expect("预检应成功");

        let r = execute_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "source": plan["sourcePath"],
            "destRel": plan["destRel"],
            "signature": plan["signature"],
            "id": "job-abcd1234",
            "replace": plan["replaceDir"]
        }))
        .expect("替换导入应成功");

        assert_eq!(r["replaced"], json!(true));
        assert_eq!(r["copied"], json!(2));
        assert!(!old_dir.exists(), "旧目录应已移走");
        assert_ne!(native(&proj, plan["destRel"].as_str().unwrap()), old_dir, "新旧目录不能是同一个");
        let trash = PathBuf::from(r["trashPath"].as_str().unwrap());
        assert!(trash.exists(), "旧目录应落在回收站");
        assert!(trash.join("a.cs").exists());

        let dest = native(&proj, r["destRel"].as_str().unwrap());
        assert_eq!(fs::read(dest.join("a.cs")).unwrap(), b"//new", "目录里应是新内容");

        let _ = fs::remove_dir_all(&trash);
        let _ = fs::remove_dir_all(&proj);
        let _ = fs::remove_dir_all(&base);
    }

    /// 队列入口重复导入同一个素材：自动替换，不再报「已存在相同的 GUID」。
    #[test]
    fn reimporting_folder_replaces_previous_copy() {
        let proj = project("b5re");
        let base = tmp("b5resrc");
        let src = base.join("衣装");
        fs::create_dir_all(src.join("Assets")).unwrap();
        fs::write(src.join("Assets").join("a.cs"), b"//v1").unwrap();
        fs::write(src.join("Assets").join("a.cs.meta"), meta_with_guid(GUID_A)).unwrap();

        let first = import_path_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "path": src.to_string_lossy()
        }))
        .expect("首次导入应成功");
        assert_eq!(first["jobs"][0]["result"]["copied"], json!(2));

        fs::write(src.join("Assets").join("a.cs"), b"//v2").unwrap();
        let second = import_path_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "path": src.to_string_lossy()
        }))
        .expect("重复导入应被当作更新，而不是报冲突");

        let dest = proj.join("Assets").join("VRCAL_Imports").join("衣装");
        assert_eq!(fs::read(dest.join("a.cs")).unwrap(), b"//v2", "应换成了新内容");
        let notes = second["notes"].as_array().unwrap();
        assert!(
            notes.iter().any(|n| n.as_str().unwrap_or("").contains("回收站")),
            "应告诉用户旧版本去了回收站：{notes:?}"
        );

        let _ = fs::remove_dir_all(&proj);
        let _ = fs::remove_dir_all(&base);
    }

    /* ---------------- 层级选择：整棵解压树 ---------------- */

    /// listExtract 要递归列出每一层，并给出 depth / 子树文件数；.meta 不单列。
    #[test]
    fn list_extract_walks_every_level() {
        let base = tmp("treelist");
        fs::create_dir_all(base.join("Mod").join("Textures")).unwrap();
        fs::write(base.join("Mod").join("model.fbx"), b"x").unwrap();
        fs::write(base.join("Mod").join("a.cs.meta"), b"meta").unwrap();
        fs::write(base.join("Mod").join("Textures").join("t.png"), b"x").unwrap();
        fs::write(base.join("README.txt"), b"x").unwrap();

        let mut out: Vec<Value> = Vec::new();
        let mut truncated = false;
        walk_list(&base, "", 0, &mut out, &mut truncated);

        let paths: Vec<String> = out
            .iter()
            .map(|v| v["path"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            paths,
            vec![
                "Mod",
                "Mod/Textures",
                "Mod/Textures/t.png",
                "Mod/model.fbx",
                "README.txt"
            ],
            "目录在前、层级先序、.meta 不列"
        );
        let mod_node = out.iter().find(|v| v["path"] == json!("Mod")).unwrap();
        assert_eq!(mod_node["files"], json!(2), "子树里有 2 个文件");
        assert_eq!(mod_node["depth"], json!(0));
        let tex = out.iter().find(|v| v["path"] == json!("Mod/Textures")).unwrap();
        assert_eq!(tex["files"], json!(1));
        assert_eq!(tex["depth"], json!(1));
        assert!(!truncated);

        let _ = fs::remove_dir_all(&base);
    }

    /// 勾选嵌套目录时，目标要保留相对结构（同名子目录否则会撞在一起）。
    #[test]
    fn nested_pick_keeps_relative_structure() {
        let proj = project("nestproj");
        let src = tmp("nestsrc");
        fs::create_dir_all(src.join("A").join("Textures")).unwrap();
        fs::create_dir_all(src.join("B").join("Textures")).unwrap();
        fs::write(src.join("A").join("Textures").join("a.png"), b"a").unwrap();
        fs::write(src.join("B").join("Textures").join("b.png"), b"b").unwrap();

        import_selected_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "dir": src.to_string_lossy(),
            "pick": ["A/Textures", "B/Textures"]
        }))
        .expect("嵌套勾选应成功");

        let stem = src.file_name().unwrap().to_string_lossy().to_string();
        let base = proj.join("Assets").join("VRCAL_Imports").join(&stem);
        assert!(
            base.join("A").join("Textures").join("a.png").exists(),
            "A/Textures 要落在 <素材>/A/Textures"
        );
        assert!(
            base.join("B").join("Textures").join("b.png").exists(),
            "B/Textures 要落在 <素材>/B/Textures"
        );

        let _ = fs::remove_dir_all(&proj);
        let _ = fs::remove_dir_all(&src);
    }

    /* ---------------- 直接关程序之后的收尾 ---------------- */

    /// 启动清扫：孤儿解压目录要删掉，但「等 Unity 回执」的必须保住。
    #[test]
    fn startup_sweep_removes_orphans_but_keeps_pending() {
        let base = tmp("sweep");
        let roots = base.join("extract-roots.json");
        let cleanup = base.join("pending-cleanup.json");

        let orphan = base.join("orphan");
        let pending = base.join("pending");
        fs::create_dir_all(&orphan).unwrap();
        fs::create_dir_all(&pending).unwrap();
        fs::write(orphan.join("a.txt"), b"x").unwrap();
        fs::write(pending.join("b.unitypackage"), b"x").unwrap();

        let mut map = serde_json::Map::new();
        map.insert(
            cmp_key(&orphan.to_string_lossy()),
            json!(orphan.to_string_lossy()),
        );
        map.insert(
            cmp_key(&pending.to_string_lossy()),
            json!(pending.to_string_lossy()),
        );
        save_cleanup_at(&roots, &Value::Object(map));

        let mut pend = serde_json::Map::new();
        pend.insert(
            pending.to_string_lossy().to_string(),
            json!({ "ids": ["req-1"], "at": now_ms() }),
        );
        save_cleanup_at(&cleanup, &Value::Object(pend));

        let (removed, kept) = sweep_orphan_extracts_at(&roots, &cleanup);
        assert_eq!(removed, 1, "孤儿目录要删掉");
        assert_eq!(kept, 1, "等回执的目录要保住");
        assert!(!orphan.exists());
        assert!(pending.exists(), "包还在 Unity 那边排队，目录不能删");
        assert_eq!(load_cleanup_at(&roots).as_object().unwrap().len(), 1);

        let _ = fs::remove_dir_all(&base);
    }

    /// 单文件复制走「临时名 + 改名」，成功后不留 .vrcalpart。
    #[test]
    fn copying_a_file_leaves_no_partial() {
        let base = tmp("atomic");
        let from = base.join("a.bin");
        fs::write(&from, b"hello").unwrap();
        let to = base.join("sub").join("a.bin");
        fs::create_dir_all(to.parent().unwrap()).unwrap();

        copy_file_atomic(&from, &to).unwrap();
        assert_eq!(fs::read(&to).unwrap(), b"hello");

        let leftovers: Vec<String> = fs::read_dir(to.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".vrcalpart"))
            .collect();
        assert!(leftovers.is_empty(), "不该留下临时文件：{leftovers:?}");

        let _ = fs::remove_dir_all(&base);
    }

    /* ---------------- 续传：中断之后接着拷 ---------------- */

    fn seed_resume_case(tag: &str) -> (PathBuf, PathBuf, String) {
        let proj = project(tag);
        let src = tmp(&format!("{tag}-src"));
        fs::write(src.join("a.cs"), b"//new-a").unwrap();
        fs::write(src.join("a.cs.meta"), meta_with_guid(GUID_A)).unwrap();
        fs::write(src.join("b.cs"), b"//new-b").unwrap();
        fs::write(src.join("b.cs.meta"), meta_with_guid("fedcba9876543210fedcba9876543210")).unwrap();

        // 目标目录名带内容后缀，得用预检算出来，再模拟「上次拷到一半」
        let plan = plan_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "source": src.to_string_lossy(),
            "id": "job-abcd1234"
        }))
        .expect("预检");
        let dest_rel = plan["destRel"].as_str().unwrap().to_string();
        let dest = native(&proj, &dest_rel);
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("a.cs"), b"//old-a").unwrap();
        fs::write(dest.join("a.cs.meta"), meta_with_guid(GUID_A)).unwrap();
        fs::write(dest.join(".vrcal-importing"), b"1").unwrap();
        (proj, src, dest_rel)
    }

    /// 有未完成标记时，预检要给「可续传」，而不是「替换旧版本」。
    #[test]
    fn plan_marks_interrupted_import_as_resumable() {
        let (proj, src, _dest_rel) = seed_resume_case("resumeplan");

        let r = plan_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "source": src.to_string_lossy(),
            "id": "job-abcd1234"
        }))
        .expect("预检应成功");

        assert_eq!(r["resuming"], json!(true));
        assert_eq!(r["ready"], json!(true), "续传不该被冲突挡死");
        assert_eq!(r["replaceable"], json!(false), "续传不是替换");

        let _ = fs::remove_dir_all(&proj);
        let _ = fs::remove_dir_all(&src);
    }

    /// 续传执行：只补缺失的文件，已存在的不动，完成后撤掉标记。
    #[test]
    fn interrupted_import_continues_instead_of_restarting() {
        let (proj, src, dest_rel) = seed_resume_case("resumeexec");
        let dest = native(&proj, &dest_rel);

        let r = execute_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "source": src.to_string_lossy(),
            "destRel": dest_rel,
            "signature": "",
            "id": "job-abcd1234",
            "replace": "auto"
        }))
        .expect("续传应成功");

        assert_eq!(r["copied"], json!(2), "只补 b.cs 和 b.cs.meta");
        assert_eq!(r["skipped"], json!(2), "a 的两个文件跳过");
        assert_eq!(fs::read(dest.join("a.cs")).unwrap(), b"//old-a", "旧内容不能被覆盖");
        assert!(dest.join("b.cs").exists());
        assert!(
            !dest.join(".vrcal-importing").exists(),
            "拷完要撤掉未完成标记"
        );

        let _ = fs::remove_dir_all(&proj);
        let _ = fs::remove_dir_all(&src);
    }

    /* ---------------- 队列等回执：助手心跳 ---------------- */

    /// 有心跳 = alive（带版本，能看出空闲还是忙碌）；没有 = missing。
    #[test]
    fn heartbeat_reports_version_and_busy_state() {
        let proj = project("beat");
        let (state, _, idle) = bridge_heartbeat(&proj);
        assert_eq!(state, "missing", "还没装新版助手时应当是 missing");
        assert!(idle);

        let dir = proj.join("Library").join("VrclibBridge");
        fs::create_dir_all(&dir).unwrap();
        let beat = dir.join("bridge.json");
        fs::write(&beat, br#"{"version":2,"at":"x","active":"","phase":"idle"}"#).unwrap();

        let (state, version, idle) = bridge_heartbeat(&proj);
        assert_eq!(state, "alive");
        assert_eq!(version, 2);
        assert!(idle, "active 为空 = 助手空闲");

        fs::write(&beat, br#"{"version":2,"at":"x","active":"abc","phase":"importing"}"#).unwrap();
        let (state, _, idle) = bridge_heartbeat(&proj);
        assert_eq!(state, "alive");
        assert!(!idle, "active 非空 = 正在导入");

        let _ = fs::remove_dir_all(&proj);
    }

    /// 心跳超过 30 秒没更新 → stale（Unity 在编译 / 卡住 / 已关闭）
    #[test]
    fn old_heartbeat_is_stale() {
        let proj = project("beatstale");
        let dir = proj.join("Library").join("VrclibBridge");
        fs::create_dir_all(&dir).unwrap();
        let beat = dir.join("bridge.json");
        fs::write(&beat, br#"{"version":2,"active":"abc"}"#).unwrap();

        let f = fs::OpenOptions::new().write(true).open(&beat).unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
        f.set_modified(old).unwrap();
        drop(f);

        let (state, _, _) = bridge_heartbeat(&proj);
        assert_eq!(state, "stale");

        let _ = fs::remove_dir_all(&proj);
    }

    /// 还没回执时，receipt 也要把助手状态带回去 —— 前端据此区分「助手没跑」和「还没导完」。
    #[test]
    fn receipt_carries_bridge_state_while_pending() {
        let proj = project("beatreceipt");
        let id = "11111111-1111-4111-8111-111111111111";

        let r = receipt_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "requestId": id
        }))
        .unwrap();
        assert_eq!(r["found"], json!(false));
        assert_eq!(r["bridge"], json!("missing"));
        assert_eq!(r["bridgeCurrent"], json!(false));

        fs::create_dir_all(proj.join("Library").join("VrclibBridge")).unwrap();
        fs::write(
            proj.join("Library").join("VrclibBridge").join("bridge.json"),
            br#"{"version":2,"active":""}"#,
        )
        .unwrap();

        let r = receipt_sync(&json!({
            "projectRoot": proj.to_string_lossy(),
            "requestId": id
        }))
        .unwrap();
        assert_eq!(r["bridge"], json!("alive"));
        assert_eq!(r["bridgeVersion"], json!(2));
        assert_eq!(r["bridgeCurrent"], json!(true));

        let _ = fs::remove_dir_all(&proj);
    }

    /// C3：文件名在 Windows 上不合法时，解压不静默——要给出警告而不是失败。
    #[test]
    fn unwritable_entry_name_is_reported() {
        let base = tmp("badname");
        let zip_path = base.join("pack.zip");
        zip_of(&zip_path, "bad:name?.txt", b"hi");
        let (dir, warns) = extract_zip_beside(&zip_path).unwrap();
        // Windows 上 `:` 无法建文件；POSIX 上能建，这条断言只在 Windows 生效
        if cfg!(windows) {
            assert!(!warns.is_empty(), "应当提示有文件没能解压");
        }
        assert!(dir.starts_with(&base));
        let _ = remove_extract_dir(&dir);
        let _ = fs::remove_dir_all(&base);
    }
}
