/* 文件系统接口：与 VRCLibHost 的 /api/{exists,readText,writeFile,readFileBase64,mkdir,delete,move,copy,open,scan}
 * 完全同契约 —— 渲染层 40-fs.js 的 Host.* 调用面一个字都不用改。 */
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tokio::fs;

const TEXT_LIMIT: u64 = 64 * 1024 * 1024;
const B64_LIMIT: u64 = 128 * 1024 * 1024;

fn p_of(v: &Value) -> String {
    v.get("path").and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn s_of(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn mtime_ms(m: &std::fs::Metadata) -> f64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// 逐级创建目录（宿主不指望调用方先 mkdir）
pub async fn mkdirp(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).await.map_err(|e| e.to_string())
}

pub async fn exists(v: &Value) -> Result<Value, String> {
    let p = p_of(v);
    if p.is_empty() {
        return Err("缺少 path".into());
    }
    match fs::metadata(&p).await {
        Ok(m) => {
            let kind = if m.is_dir() { "dir" } else { "file" };
            Ok(json!({ "ok": true, "kind": kind, "size": m.len(), "mtime": mtime_ms(&m) }))
        }
        Err(_) => Ok(json!({ "ok": true, "kind": "missing" })),
    }
}

pub async fn read_text(v: &Value) -> Result<Value, String> {
    let p = p_of(v);
    let m = fs::metadata(&p).await.map_err(|e| format!("{e}"))?;
    if !m.is_file() {
        return Err(format!("不是文件：{p}"));
    }
    if m.len() > TEXT_LIMIT {
        return Err(format!("文件过大（>64MB）：{p}"));
    }
    let bytes = fs::read(&p).await.map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "text": String::from_utf8_lossy(&bytes).to_string(), "size": bytes.len() }))
}

pub async fn read_file_base64(v: &Value) -> Result<Value, String> {
    let p = p_of(v);
    let m = fs::metadata(&p).await.map_err(|e| format!("{e}"))?;
    if !m.is_file() {
        return Err(format!("不是文件：{p}"));
    }
    if m.len() > B64_LIMIT {
        return Err(format!(
            "文件过大（{}MB，上限 128MB）：{}。大文件请用复制 / 下载 / 素材包，不要整份读进内存。",
            m.len() / 1048576,
            p
        ));
    }
    let bytes = fs::read(&p).await.map_err(|e| e.to_string())?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(json!({ "ok": true, "dataBase64": b64, "size": bytes.len() }))
}

pub async fn write_file(v: &Value) -> Result<Value, String> {
    let p = p_of(v);
    if p.is_empty() {
        return Err("缺少 path".into());
    }
    let b64 = v.get("dataBase64").and_then(|x| x.as_str()).ok_or("缺少 dataBase64")?;
    use base64::Engine;
    let buf = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("base64 解码失败：{e}"))?;
    let path = PathBuf::from(&p);
    if let Some(parent) = path.parent() {
        mkdirp(parent).await?;
    }
    fs::write(&path, &buf).await.map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "size": buf.len(), "path": p }))
}

pub async fn mkdir(v: &Value) -> Result<Value, String> {
    let p = p_of(v);
    if p.is_empty() {
        return Err("缺少 path".into());
    }
    mkdirp(Path::new(&p)).await?;
    Ok(json!({ "ok": true, "path": p }))
}

/// 删除带安全阀：拒绝盘符根、拒绝过短路径（与宿主行为一致）
pub async fn delete(v: &Value) -> Result<Value, String> {
    let p = p_of(v);
    if p.is_empty() {
        return Err("缺少 path".into());
    }
    let compact: String = p.chars().filter(|c| *c != '\\' && *c != '/').collect();
    let is_drive = p.len() <= 3 && p.chars().nth(1) == Some(':');
    if is_drive || compact.chars().count() < 4 {
        return Err(format!("拒绝删除：路径过短或为盘符根（{p}）"));
    }
    let path = PathBuf::from(&p);
    if path.is_dir() {
        fs::remove_dir_all(&path).await.map_err(|e| e.to_string())?;
    } else if path.exists() {
        fs::remove_file(&path).await.map_err(|e| e.to_string())?;
    }
    Ok(json!({ "ok": true, "path": p }))
}

pub async fn move_path(v: &Value) -> Result<Value, String> {
    let src = s_of(v, "src");
    let dst = s_of(v, "dst");
    if src.is_empty() || dst.is_empty() {
        return Err("缺少 src/dst".into());
    }
    if Path::new(&dst).exists() {
        return Err(format!("目标已存在，拒绝覆盖：{dst}"));
    }
    let d = PathBuf::from(&dst);
    if let Some(parent) = d.parent() {
        mkdirp(parent).await?;
    }
    match fs::rename(&src, &dst).await {
        Ok(_) => Ok(json!({ "ok": true, "src": src, "dst": dst })),
        Err(_) => {
            // 跨盘（EXDEV / ERROR_NOT_SAME_DEVICE）→ 复制后删源
            copy_tree(Path::new(&src), &d).await?;
            if Path::new(&src).is_dir() {
                fs::remove_dir_all(&src).await.map_err(|e| e.to_string())?;
            } else {
                fs::remove_file(&src).await.map_err(|e| e.to_string())?;
            }
            Ok(json!({ "ok": true, "src": src, "dst": dst }))
        }
    }
}

pub async fn copy(v: &Value) -> Result<Value, String> {
    let src = s_of(v, "src");
    let dst = s_of(v, "dst");
    if src.is_empty() || dst.is_empty() {
        return Err("缺少 src/dst".into());
    }
    let d = PathBuf::from(&dst);
    if let Some(parent) = d.parent() {
        mkdirp(parent).await?;
    }
    copy_tree(Path::new(&src), &d).await?;
    Ok(json!({ "ok": true, "src": src, "dst": dst }))
}

async fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    let m = fs::metadata(src).await.map_err(|e| e.to_string())?;
    if m.is_dir() {
        fs::create_dir_all(dst).await.map_err(|e| e.to_string())?;
        let mut rd = fs::read_dir(src).await.map_err(|e| e.to_string())?;
        while let Some(ent) = rd.next_entry().await.map_err(|e| e.to_string())? {
            let name = ent.file_name();
            let target = dst.join(&name);
            Box::pin(copy_tree(&ent.path(), &target)).await?;
        }
        Ok(())
    } else {
        fs::copy(src, dst).await.map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// 目录树：rel 为相对 path 的 Windows 风格相对路径；maxDepth=0 表示不限
pub async fn scan(v: &Value) -> Result<Value, String> {
    let root = p_of(v);
    if root.is_empty() {
        return Err("缺少 path".into());
    }
    let m = fs::metadata(&root).await.map_err(|_| format!("目录不存在：{root}"))?;
    if !m.is_dir() {
        return Err(format!("目录不存在：{root}"));
    }
    let limit = v.get("maxDepth").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
    let limit = if limit > 0 { limit } else { usize::MAX };
    let mut entries: Vec<Value> = Vec::new();
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(PathBuf::from(&root), String::new(), 1)];

    while let Some((dir, rel, depth)) = stack.pop() {
        if depth > limit {
            continue;
        }
        let mut rd = match fs::read_dir(&dir).await {
            Ok(r) => r,
            Err(_) => continue,
        };
        while let Some(ent) = rd.next_entry().await.ok().flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}\\{name}") };
            let (mut size, mut mtime) = (0u64, 0f64);
            if let Ok(md) = ent.metadata().await {
                size = md.len();
                mtime = mtime_ms(&md);
            }
            let is_dir = ent.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
            entries.push(json!({
                "name": name,
                "kind": if is_dir { "directory" } else { "file" },
                "size": size,
                "mtime": mtime,
                "rel": child_rel
            }));
            if is_dir && depth < limit {
                stack.push((ent.path(), child_rel, depth + 1));
            }
        }
    }
    Ok(json!({ "ok": true, "entries": entries, "root": root }))
}

/// 打开目录（资源管理器）/ 在文件夹中显示文件
pub async fn open_path(app: &tauri::AppHandle, v: &Value) -> Result<Value, String> {
    use tauri_plugin_opener::OpenerExt;
    let p = p_of(v);
    let m = fs::metadata(&p).await.map_err(|_| format!("路径不存在：{p}"))?;
    if m.is_dir() {
        app.opener().open_path(&p, None::<&str>).map_err(|e| e.to_string())?;
    } else {
        app.opener()
            .reveal_item_in_dir(&p)
            .map_err(|e| e.to_string())?;
    }
    Ok(json!({ "ok": true }))
}
