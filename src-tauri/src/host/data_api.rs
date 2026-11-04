/* 数据目录迁移（v6.2）
 *
 * 为什么要分两个目录：
 *   settings.json 是「指针本身」——它必须留在程序目录，否则下次启动就不知道该去哪个
 *   目录读配置（鸡生蛋问题）。所以配置固定不动，只搬会随用户增长的重型数据：
 *   library.db / covers / gallery / download-queue.json / assets.json.bak。
 *
 * 迁移顺序（由渲染层编排，这里只负责「复制 + 校验」和「清理旧目录」两步）：
 *   1) data_migrate   复制到新目录并逐个校验字节数
 *   2) 页面写 settings.localDataDir → data_apply_root 让数据库跟过去
 *   3) data_cleanup   删掉旧目录里的重型数据（绝不碰 settings.json）
 *   任何一步失败都停在旧状态：指针没改，数据还在原处。
 */
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::ipc::Channel;

/// 会跟着数据目录走的东西
const HEAVY_FILES: &[&str] = &["library.db", "download-queue.json", "assets.json.bak"];
const HEAVY_DIRS: &[&str] = &["covers", "gallery"];
/// 判断「这里已经有数据了」的标志
const MARKERS: &[&str] = &["library.db", "assets.json"];

fn norm(p: &str) -> PathBuf {
    let s = p.trim().trim_end_matches(['\\', '/']);
    PathBuf::from(s)
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

/// 递归统计文件数与总字节
fn scan_stats(dir: &Path) -> (u64, u64) {
    let mut files = 0u64;
    let mut bytes = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(cur) = stack.pop() {
        let rd = match fs::read_dir(&cur) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(m) = e.metadata() {
                files += 1;
                bytes += m.len();
            }
        }
    }
    (files, bytes)
}

fn is_dir_empty(dir: &Path) -> bool {
    match fs::read_dir(dir) {
        Ok(mut rd) => rd.next().is_none(),
        Err(_) => true,
    }
}

fn has_data(dir: &Path) -> bool {
    MARKERS.iter().any(|m| dir.join(m).exists())
}

/// 复制一个目录（递归），每复制一个文件发一条进度
fn copy_dir(
    from: &Path,
    to: &Path,
    on_event: &Channel<String>,
    done: &mut u64,
    total: u64,
) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("创建目录失败 {to:?}：{e}"))?;
    let rd = fs::read_dir(from).map_err(|e| format!("读取 {from:?} 失败：{e}"))?;
    for e in rd.flatten() {
        let src = e.path();
        let dst = to.join(e.file_name());
        if src.is_dir() {
            copy_dir(&src, &dst, on_event, done, total)?;
        } else {
            fs::copy(&src, &dst).map_err(|e| format!("复制 {src:?} 失败：{e}"))?;
            *done += 1;
            let _ = on_event.send(
                json!({ "phase": "copy", "done": done, "total": total,
                        "name": src.file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default() })
                .to_string(),
            );
        }
    }
    Ok(())
}

/// 复制前后校验：源与目标的文件数、总字节必须一致
fn verify(from: &Path, to: &Path) -> Result<(u64, u64), String> {
    let mut files = 0u64;
    let mut bytes = 0u64;
    for name in HEAVY_FILES {
        let s = from.join(name);
        if !s.exists() {
            continue;
        }
        let d = to.join(name);
        let sm = fs::metadata(&s).map_err(|e| e.to_string())?;
        let dm = fs::metadata(&d).map_err(|_| format!("校验失败：{d:?} 不存在"))?;
        if sm.len() != dm.len() {
            return Err(format!("校验失败：{name} 大小不一致（{} ≠ {}）", sm.len(), dm.len()));
        }
        files += 1;
        bytes += dm.len();
    }
    for name in HEAVY_DIRS {
        let s = from.join(name);
        if !s.exists() {
            continue;
        }
        let d = to.join(name);
        let (sf, sb) = scan_stats(&s);
        let (df, db) = scan_stats(&d);
        if sf != df || sb != db {
            return Err(format!(
                "校验失败：{name} 内容不完整（{df}/{sf} 个文件，{db}/{sb} 字节）"
            ));
        }
        files += df;
        bytes += db;
    }
    Ok((files, bytes))
}

#[tauri::command]
pub fn data_scan(dir: String) -> Value {
    let d = norm(&dir);
    if d.as_os_str().is_empty() {
        return json!({ "ok": false, "error": "目录为空" });
    }
    let exists = d.exists();
    let (files, bytes) = if exists { scan_stats(&d) } else { (0, 0) };
    json!({
        "ok": true,
        "exists": exists,
        "files": files,
        "bytes": bytes,
        "hasData": exists && has_data(&d),
        "empty": !exists || is_dir_empty(&d)
    })
}

#[tauri::command]
pub fn data_migrate(
    state: tauri::State<super::AppState>,
    from: String,
    to: String,
    on_event: Channel<String>,
) -> Value {
    let a = norm(&from);
    let b = norm(&to);
    if a.as_os_str().is_empty() || b.as_os_str().is_empty() {
        return json!({ "ok": false, "error": "源目录或目标目录为空" });
    }
    if same_path(&a, &b) {
        return json!({ "ok": true, "moved": false, "reason": "same", "files": 0, "bytes": 0 });
    }
    if b.starts_with(&a) {
        return json!({ "ok": false, "error": "目标目录不能放在源目录里面" });
    }
    if a.starts_with(&b) {
        return json!({ "ok": false, "error": "源目录已经在目标目录里了" });
    }
    if b.exists() && has_data(&b) {
        return json!({ "ok": false, "error": "目标目录里已经有一份素材库数据，请换一个空文件夹（或先备份后清空）" });
    }
    // 源目录没有数据（首次选择）：只建目录即可
    if !a.exists() || !has_data(&a) {
        if let Err(e) = fs::create_dir_all(&b) {
            return json!({ "ok": false, "error": format!("创建目录失败：{e}") });
        }
        let _ = on_event.send(json!({ "phase": "done", "done": 0, "total": 0 }).to_string());
        return json!({ "ok": true, "moved": false, "files": 0, "bytes": 0 });
    }

    /* 复制前先关掉 SQLite：WAL 模式下库文件与 -wal 是两份，
     * 开着连接直接复制可能拿到不一致的快照。close() 会合并 WAL 并释放句柄。
     * 若后续复制失败，渲染层会调 data_apply_root 按旧设置把库重新打开。 */
    state.db.close();

    // 先数一遍，好让进度条有个总数
    let mut total = 0u64;
    for n in HEAVY_FILES {
        if a.join(n).exists() {
            total += 1;
        }
    }
    for n in HEAVY_DIRS {
        let p = a.join(n);
        if p.exists() {
            total += scan_stats(&p).0;
        }
    }
    let _ = on_event.send(json!({ "phase": "start", "done": 0, "total": total }).to_string());

    if let Err(e) = fs::create_dir_all(&b) {
        return json!({ "ok": false, "error": format!("创建目录失败：{e}") });
    }

    let mut done = 0u64;
    for n in HEAVY_FILES {
        let s = a.join(n);
        if !s.exists() {
            continue;
        }
        if let Err(e) = fs::copy(&s, b.join(n)) {
            return json!({ "ok": false, "error": format!("复制 {n} 失败：{e}") });
        }
        done += 1;
        let _ = on_event.send(
            json!({ "phase": "copy", "done": done, "total": total, "name": n }).to_string(),
        );
    }
    for n in HEAVY_DIRS {
        let s = a.join(n);
        if !s.exists() {
            continue;
        }
        if let Err(e) = copy_dir(&s, &b.join(n), &on_event, &mut done, total) {
            return json!({ "ok": false, "error": e });
        }
    }

    let _ = on_event.send(json!({ "phase": "verify", "done": done, "total": total }).to_string());
    match verify(&a, &b) {
        Ok((files, bytes)) => {
            let _ = on_event.send(json!({ "phase": "done", "done": total, "total": total }).to_string());
            json!({ "ok": true, "moved": true, "files": files, "bytes": bytes,
                    "from": a.to_string_lossy(), "to": b.to_string_lossy() })
        }
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// 删除旧目录里的重型数据。**绝不碰 settings.json**（它是指针，删了下次启动就找不到库）。
#[tauri::command]
pub fn data_cleanup(dir: String) -> Value {
    let d = norm(&dir);
    if d.as_os_str().is_empty() || !d.exists() {
        return json!({ "ok": true, "removed": 0 });
    }
    let mut removed = 0u64;
    for name in HEAVY_FILES {
        // WAL 附属文件也一并清掉
        for f in [name.to_string(), format!("{name}-wal"), format!("{name}-shm")] {
            let p = d.join(&f);
            if p.exists() && fs::remove_file(&p).is_ok() {
                removed += 1;
            }
        }
    }
    for name in HEAVY_DIRS {
        let p = d.join(name);
        if p.exists() && fs::remove_dir_all(&p).is_ok() {
            removed += 1;
        }
    }
    json!({ "ok": true, "removed": removed, "dir": d.to_string_lossy() })
}
