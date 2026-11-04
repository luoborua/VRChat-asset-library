/* 素材包（.vrcpack）的生成、查看与解包。
 * 包结构：vrcpack.json + 素材/<标题>/<原始相对路径> + covers/<id>.<ext>
 * 与 89-pack.js、api-pack.js 保持同一清单字段与同一目录语义。 */
use base64::Engine;
use serde_json::{json, Value};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const MANIFEST: &str = "vrcpack.json";
const FORMAT: &str = "vrcpack";

#[derive(Clone, Default)]
pub struct PackProgress {
    pub running: bool,
    pub phase: String,
    pub total: u32,
    pub done: u32,
    pub bytes: u64,
    pub current: String,
    pub error: String,
}

pub struct PackState {
    pub inner: Mutex<PackProgress>,
}

impl Default for PackState {
    fn default() -> Self {
        Self { inner: Mutex::new(PackProgress::default()) }
    }
}

fn reset(pack: &PackState, phase: &str) {
    let mut g = pack.inner.lock().unwrap();
    *g = PackProgress {
        running: true,
        phase: phase.to_string(),
        ..Default::default()
    };
}

fn set_phase(pack: &PackState, phase: &str) {
    pack.inner.lock().unwrap().phase = phase.to_string();
}

fn bump(pack: &PackState, bytes: u64, current: &str) {
    let mut g = pack.inner.lock().unwrap();
    g.bytes += bytes;
    g.done += 1;
    g.current = current.to_string();
}

fn end(pack: &PackState, err: Option<String>) {
    let mut g = pack.inner.lock().unwrap();
    g.running = false;
    if let Some(e) = err {
        g.error = e;
    }
}

pub fn progress_json(pack: &PackState) -> Value {
    let g = pack.inner.lock().unwrap();
    json!({
        "ok": true,
        "running": g.running,
        "phase": g.phase,
        "total": g.total,
        "done": g.done,
        "bytes": g.bytes,
        "current": g.current,
        "error": g.error
    })
}

fn safe_file_name(s: &str, fallback: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| {
            if "\\/:*?\"<>|".contains(c) || (c as u32) < 0x20 {
                '_'
            } else {
                c
            }
        })
        .collect();
    let v = cleaned.trim().trim_start_matches('.').to_string();
    if v.is_empty() {
        fallback.to_string()
    } else {
        v
    }
}

fn safe_dir_name(s: &str, fallback: &str) -> String {
    let v = safe_file_name(s, fallback);
    if v.chars().count() > 60 {
        v.chars().take(60).collect()
    } else {
        v
    }
}

fn safe_rel_path(s: &str) -> String {
    let parts: Vec<String> = s
        .replace('\\', "/")
        .split('/')
        .filter(|p| !p.is_empty() && *p != "." && *p != "..")
        .map(|p| safe_file_name(p, "x"))
        .collect();
    if parts.is_empty() {
        "file.bin".to_string()
    } else {
        parts.join("/")
    }
}

fn s_of(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn zip_opts() -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(true)
}

/* ---------------- 导出 ---------------- */

pub fn pack_create(pack: &PackState, payload: &Value) -> Result<Value, String> {
    let out_path = s_of(payload, "outPath");
    if out_path.is_empty() {
        return Err("缺少导出路径".into());
    }
    if !out_path.to_lowercase().ends_with(".vrcpack") {
        return Err("导出文件必须以 .vrcpack 结尾".into());
    }
    let entries = payload
        .get("entries")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    if entries.is_empty() {
        return Err("没有可导出的素材".into());
    }
    let with_files = payload.get("withFiles").and_then(|x| x.as_bool()).unwrap_or(false);
    let with_covers = payload.get("withCovers").and_then(|x| x.as_bool()).unwrap_or(true);
    let with_note = payload.get("withNote").and_then(|x| x.as_bool()).unwrap_or(false);
    let with_price = payload.get("withPrice").and_then(|x| x.as_bool()).unwrap_or(false);

    reset(pack, "正在写入素材包");
    pack.inner.lock().unwrap().total = entries.len() as u32;

    if let Some(parent) = Path::new(&out_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = File::create(&out_path).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);

    let mut assets: Vec<Value> = Vec::new();
    let mut used_dirs: Vec<String> = Vec::new();
    let mut used_names: Vec<String> = Vec::new();
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;

    let run = || -> Result<(), String> {
        for e in &entries {
            let id = {
                let raw = s_of(e, "id");
                if raw.trim().is_empty() {
                    format!("as_{}", assets.len() + 1)
                } else {
                    raw
                }
            };
            let title = s_of(e, "title");
            let base_dir = safe_dir_name(&title, "素材");
            let mut dir_name = base_dir.clone();
            if used_dirs.contains(&dir_name.to_lowercase()) {
                let mut n = 2;
                while used_dirs.contains(&format!("{} ({})", base_dir, n).to_lowercase()) {
                    n += 1;
                }
                dir_name = format!("{} ({})", base_dir, n);
            }
            used_dirs.push(dir_name.to_lowercase());
            let dir = format!("素材/{}", dir_name);

            let mut files_out: Vec<Value> = Vec::new();
            if with_files {
                if let Some(list) = e.get("files").and_then(|x| x.as_array()) {
                    for f in list {
                        let src = s_of(f, "path");
                        if src.is_empty() || !Path::new(&src).is_file() {
                            continue;
                        }
                        let rel_raw = {
                            let r = s_of(f, "rel");
                            if r.is_empty() {
                                Path::new(&src)
                                    .file_name()
                                    .map(|x| x.to_string_lossy().to_string())
                                    .unwrap_or_else(|| "file.bin".into())
                            } else {
                                r
                            }
                        };
                        let mut rel = safe_rel_path(&rel_raw);
                        let mut zip_name = format!("{}/{}", dir, rel);
                        if used_names.contains(&zip_name) {
                            let p = Path::new(&rel);
                            let ext = p
                                .extension()
                                .map(|x| format!(".{}", x.to_string_lossy()))
                                .unwrap_or_default();
                            let stem = rel.trim_end_matches(&ext).to_string();
                            let mut n = 2;
                            while used_names.contains(&format!("{}/{}_{}{}", dir, stem, n, ext)) {
                                n += 1;
                            }
                            rel = format!("{}_{}{}", stem, n, ext);
                            zip_name = format!("{}/{}", dir, rel);
                        }
                        used_names.push(zip_name.clone());

                        let mut src_file = File::open(&src).map_err(|e| e.to_string())?;
                        let size = src_file.metadata().map(|m| m.len()).unwrap_or(0);
                        zip.start_file(zip_name.clone(), zip_opts())
                            .map_err(|e| e.to_string())?;
                        std::io::copy(&mut src_file, &mut zip).map_err(|e| e.to_string())?;

                        total_bytes += size;
                        file_count += 1;
                        let name = Path::new(&rel)
                            .file_name()
                            .map(|x| x.to_string_lossy().to_string())
                            .unwrap_or_default();
                        bump(pack, size, &name);
                        files_out.push(json!({
                            "name": name,
                            "rel": rel,
                            "zipPath": zip_name,
                            "size": size
                        }));
                    }
                }
            }

            let mut cover = String::new();
            if with_covers {
                if let Some(b64) = e.get("coverBase64").and_then(|x| x.as_str()) {
                    if let Ok(buf) = base64::engine::general_purpose::STANDARD.decode(b64) {
                        if !buf.is_empty() && buf.len() <= 8 * 1024 * 1024 {
                            let raw_ext = s_of(e, "coverExt").to_lowercase();
                            let ext = if [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]
                                .contains(&raw_ext.as_str())
                            {
                                raw_ext
                            } else {
                                ".jpg".to_string()
                            };
                            let zip_name = format!("covers/{}{}", safe_dir_name(&id, "cover"), ext);
                            zip.start_file(zip_name.clone(), zip_opts())
                                .map_err(|e| e.to_string())?;
                            zip.write_all(&buf).map_err(|e| e.to_string())?;
                            total_bytes += buf.len() as u64;
                            cover = zip_name;
                        }
                    }
                }
                if cover.is_empty() {
                    let cp = s_of(e, "coverPath");
                    if !cp.is_empty() && Path::new(&cp).is_file() {
                        let ext = Path::new(&cp)
                            .extension()
                            .map(|x| format!(".{}", x.to_string_lossy().to_lowercase()))
                            .unwrap_or_else(|| ".jpg".into());
                        let zip_name = format!("covers/{}{}", safe_dir_name(&id, "cover"), ext);
                        let mut f = File::open(&cp).map_err(|e| e.to_string())?;
                        zip.start_file(zip_name.clone(), zip_opts())
                            .map_err(|e| e.to_string())?;
                        std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
                        cover = zip_name;
                    }
                }
            }

            let cat = {
                let c = s_of(e, "category");
                if c.is_empty() { "other".to_string() } else { c }
            };
            let src_kind = {
                let c = s_of(e, "source");
                if c.is_empty() { "other".to_string() } else { c }
            };
            let is_free = match e.get("isFree") {
                Some(Value::Bool(b)) => Value::Bool(*b),
                Some(Value::String(s)) if s == "free" => Value::Bool(true),
                Some(Value::String(s)) if s == "paid" => Value::Bool(false),
                _ => Value::Null,
            };
            let total_size: u64 = files_out
                .iter()
                .map(|f| f.get("size").and_then(|x| x.as_u64()).unwrap_or(0))
                .sum();

            let mut meta = json!({
                "id": id,
                "dir": dir_name,
                "title": s_of(e, "title"),
                "originalTitle": s_of(e, "originalTitle"),
                "category": cat,
                "source": src_kind,
                "tags": e.get("tags").cloned().unwrap_or(json!([])),
                "avatars": e.get("avatars").cloned().unwrap_or(json!([])),
                "itemId": s_of(e, "itemId"),
                "shop": s_of(e, "shop"),
                "author": s_of(e, "author"),
                "isFree": is_free,
                "fileSize": total_size,
                "files": files_out,
                "cover": cover
            });
            if with_note {
                meta["note"] = Value::String(s_of(e, "note"));
            }
            if with_price {
                meta["purchasePrice"] = e.get("purchasePrice").cloned().unwrap_or(Value::Null);
                meta["purchaseCurrency"] = Value::String(s_of(e, "purchaseCurrency"));
            }
            if !with_files {
                pack.inner.lock().unwrap().done += 1;
            }
            assets.push(meta);
        }

        set_phase(pack, "正在写入清单");
        let manifest = json!({
            "format": FORMAT,
            "version": 1,
            "createdAt": "",
            "exporter": {
                "deviceId": payload.get("exporter").and_then(|x| x.get("deviceId")).and_then(|x| x.as_str()).unwrap_or(""),
                "nickname": payload.get("exporter").and_then(|x| x.get("nickname")).and_then(|x| x.as_str()).unwrap_or("")
            },
            "withFiles": with_files,
            "withCovers": with_covers,
            "count": assets.len(),
            "totalBytes": assets.iter().map(|a| a.get("fileSize").and_then(|x| x.as_u64()).unwrap_or(0)).sum::<u64>(),
            "assets": assets
        });
        let body = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        zip.start_file(MANIFEST, zip_opts()).map_err(|e| e.to_string())?;
        zip.write_all(&body).map_err(|e| e.to_string())?;
        zip.finish().map_err(|e| e.to_string())?;
        Ok(())
    };

    match run() {
        Ok(_) => {
            end(pack, None);
            let size = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
            Ok(json!({
                "ok": true,
                "path": out_path,
                "count": assets.len(),
                "withFiles": with_files,
                "files": file_count,
                "totalBytes": total_bytes,
                "packageBytes": size
            }))
        }
        Err(e) => {
            end(pack, Some(e.clone()));
            Err(e)
        }
    }
}

/* ---------------- 查看 ---------------- */

pub fn pack_inspect(payload: &Value) -> Result<Value, String> {
    let path = s_of(payload, "path");
    if path.is_empty() {
        return Err("缺少素材包路径".into());
    }
    let file = File::open(&path).map_err(|_| format!("找不到这个文件：{path}"))?;
    let mut archive = ZipArchive::new(file).map_err(|_| "这不是有效的 zip 文件".to_string())?;
    let package_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

    let mut entry = archive
        .by_name(MANIFEST)
        .map_err(|_| "这不是素材包（缺少 vrcpack.json）—— 别把素材压缩包本身选进来".to_string())?;
    let mut text = String::new();
    entry.read_to_string(&mut text).map_err(|e| e.to_string())?;
    let j: Value = serde_json::from_str(&text).map_err(|_| "清单已损坏，无法解析".to_string())?;
    if j.get("format").and_then(|x| x.as_str()) != Some(FORMAT) {
        return Err(format!(
            "清单格式不对（format={}）",
            j.get("format").and_then(|x| x.as_str()).unwrap_or("?")
        ));
    }
    let assets = j.get("assets").and_then(|x| x.as_array()).cloned();
    if assets.is_none() {
        return Err("清单里没有素材列表".into());
    }
    Ok(json!({
        "ok": true,
        "path": path,
        "packageBytes": package_bytes,
        "manifest": {
            "format": FORMAT,
            "version": j.get("version").cloned().unwrap_or(json!(1)),
            "createdAt": j.get("createdAt").cloned().unwrap_or(json!("")),
            "exporter": j.get("exporter").cloned().unwrap_or(json!({})),
            "withFiles": j.get("withFiles").cloned().unwrap_or(json!(false)),
            "withCovers": j.get("withCovers").cloned().unwrap_or(json!(false)),
            "count": j.get("count").cloned().unwrap_or(json!(0)),
            "totalBytes": j.get("totalBytes").cloned().unwrap_or(json!(0)),
            "assets": assets.unwrap()
        }
    }))
}

/* ---------------- 解包 ---------------- */

pub fn pack_extract(pack: &PackState, payload: &Value) -> Result<Value, String> {
    let path = s_of(payload, "path");
    let dest_root = s_of(payload, "destRoot");
    if path.is_empty() {
        return Err("缺少素材包路径".into());
    }
    if dest_root.is_empty() {
        return Err("缺少解包目标目录".into());
    }
    if !Path::new(&dest_root).is_absolute() {
        return Err("解包目标必须是绝对路径".into());
    }
    let only: Option<Vec<String>> = payload
        .get("onlyIds")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect());

    let file = File::open(&path).map_err(|_| format!("找不到这个文件：{path}"))?;
    let mut archive = ZipArchive::new(file).map_err(|_| "这不是有效的 zip 文件".to_string())?;

    let manifest: Value = {
        let mut entry = archive
            .by_name(MANIFEST)
            .map_err(|_| "这不是素材包（缺少 vrcpack.json）".to_string())?;
        let mut text = String::new();
        entry.read_to_string(&mut text).map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|_| "清单已损坏，无法解析".to_string())?
    };

    let assets = manifest.get("assets").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    reset(pack, "正在解包");
    std::fs::create_dir_all(&dest_root).map_err(|e| e.to_string())?;

    let picked: Vec<&Value> = assets
        .iter()
        .filter(|a| match &only {
            None => true,
            Some(ids) => {
                let id = a.get("id").and_then(|x| x.as_str()).unwrap_or("");
                ids.iter().any(|x| x == id)
            }
        })
        .collect();
    pack.inner.lock().unwrap().total = picked.len() as u32;

    let mut out: Vec<Value> = Vec::new();
    for a in picked {
        let id = a.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let dir_name = {
            let d = a.get("dir").and_then(|x| x.as_str()).unwrap_or("");
            if d.is_empty() {
                let t = a.get("title").and_then(|x| x.as_str()).unwrap_or("");
                safe_dir_name(t, "素材")
            } else {
                safe_dir_name(d, "素材")
            }
        };
        let asset_dir = Path::new(&dest_root).join(&dir_name);
        let mut files_out: Vec<Value> = Vec::new();

        if let Some(list) = a.get("files").and_then(|x| x.as_array()) {
            for f in list {
                let zip_path = f.get("zipPath").and_then(|x| x.as_str()).unwrap_or("");
                if zip_path.is_empty() {
                    continue;
                }
                let rel_source = {
                    let r = f.get("rel").and_then(|x| x.as_str()).unwrap_or("");
                    if r.is_empty() {
                        f.get("name").and_then(|x| x.as_str()).unwrap_or("file.bin").to_string()
                    } else {
                        r.to_string()
                    }
                };
                let rel = safe_rel_path(&rel_source);
                let out_path = asset_dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));

                let mut entry = match archive.by_name(zip_path) {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let mut fh = File::create(&out_path).map_err(|e| e.to_string())?;
                let mut buf = vec![0u8; 256 * 1024];
                let mut written = 0u64;
                loop {
                    let n = entry.read(&mut buf).map_err(|e| format!("解压失败：{e}"))?;
                    if n == 0 {
                        break;
                    }
                    fh.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                    written += n as u64;
                }
                let expect = entry.size();
                if written != expect {
                    return Err(format!(
                        "解压后大小不符（{zip_path}：期望 {expect}，实际 {written}）"
                    ));
                }
                let name = Path::new(&rel)
                    .file_name()
                    .map(|x| x.to_string_lossy().to_string())
                    .unwrap_or_default();
                bump(pack, written, &name);
                files_out.push(json!({
                    "name": name,
                    "rel": rel,
                    "outPath": out_path.to_string_lossy(),
                    "size": written
                }));
            }
        }

        let mut cover_path = String::new();
        if let Some(cover) = a.get("cover").and_then(|x| x.as_str()) {
            if !cover.is_empty() {
                let ext = Path::new(cover)
                    .extension()
                    .map(|x| format!(".{}", x.to_string_lossy()))
                    .unwrap_or_else(|| ".jpg".into());
                let cp = asset_dir.join(format!("_cover{ext}"));
                if let Ok(mut entry) = archive.by_name(cover) {
                    if let Some(parent) = cp.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    if let Ok(mut fh) = File::create(&cp) {
                        if std::io::copy(&mut entry, &mut fh).is_ok() {
                            cover_path = cp.to_string_lossy().to_string();
                        }
                    }
                }
            }
        }
        if only.is_some() {
            pack.inner.lock().unwrap().done += 1;
        }
        out.push(json!({
            "id": id,
            "dir": asset_dir.to_string_lossy(),
            "files": files_out,
            "coverPath": cover_path
        }));
    }

    pack.inner.lock().unwrap().done = out.len() as u32;
    end(pack, None);
    Ok(json!({
        "ok": true,
        "destRoot": dest_root,
        "assets": out,
        "manifest": {
            "exporter": manifest.get("exporter").cloned().unwrap_or(json!({})),
            "createdAt": manifest.get("createdAt").cloned().unwrap_or(json!("")),
            "withFiles": manifest.get("withFiles").cloned().unwrap_or(json!(false))
        }
    }))
}

pub fn suggest_name(nickname: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = now;
    let prefix = if nickname.is_empty() {
        String::new()
    } else {
        format!("{}_{}", safe_file_name(nickname, "user"), "")
    };
    format!("素材包_{}{}.vrcpack", prefix, stamp())
}

fn stamp() -> String {
    // 只用于默认文件名，精度到分钟即可
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86400;
    let rem = secs % 86400;
    format!("{}_{:02}{:02}", days, rem / 3600, (rem % 3600) / 60)
}

pub fn _unused_pathbuf(_p: PathBuf) {}
