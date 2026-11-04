/* 原生对话框：pickDir / pickFiles / saveFile / pickOneFile
 * 直接返回绝对路径 —— 这是桌面壳相对浏览器版的核心收益。 */
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

fn filters_of(payload: &Value) -> Vec<(String, Vec<String>)> {
    let mut out = Vec::new();
    if let Some(list) = payload.get("filters").and_then(|x| x.as_array()) {
        for f in list {
            let name = f.get("name").and_then(|x| x.as_str()).unwrap_or("文件").to_string();
            let exts: Vec<String> = f
                .get("extensions")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            if !exts.is_empty() {
                out.push((name, exts));
            }
        }
    }
    out
}

pub async fn pick_dir(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let title = payload
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("选择素材库目录")
        .to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(title)
        .pick_folder(move |p| {
            let _ = tx.send(p);
        });
    match rx.await.map_err(|e| e.to_string())? {
        Some(fp) => match fp.into_path() {
            Ok(pb) => Ok(json!({ "ok": true, "path": pb.to_string_lossy() })),
            Err(e) => Err(e.to_string()),
        },
        None => Ok(json!({ "ok": false, "cancelled": true })),
    }
}

pub async fn pick_files(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let title = payload
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("选择素材文件")
        .to_string();
    let filters = filters_of(payload);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dlg = app.dialog().file().set_title(title);
    for (name, exts) in &filters {
        let refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
        dlg = dlg.add_filter(name, &refs);
    }
    dlg.pick_files(move |p| {
        let _ = tx.send(p);
    });
    match rx.await.map_err(|e| e.to_string())? {
        Some(list) => {
            let mut paths = Vec::new();
            for fp in list {
                if let Ok(pb) = fp.into_path() {
                    paths.push(Value::String(pb.to_string_lossy().to_string()));
                }
            }
            Ok(json!({ "ok": true, "paths": paths }))
        }
        None => Ok(json!({ "ok": false, "cancelled": true })),
    }
}

pub async fn save_file(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let title = payload
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("保存文件")
        .to_string();
    let default_path = payload
        .get("defaultPath")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let filters = filters_of(payload);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dlg = app.dialog().file().set_title(title);
    if !default_path.is_empty() {
        dlg = dlg.set_file_name(default_path);
    }
    for (name, exts) in &filters {
        let refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
        dlg = dlg.add_filter(name, &refs);
    }
    dlg.save_file(move |p| {
        let _ = tx.send(p);
    });
    match rx.await.map_err(|e| e.to_string())? {
        Some(fp) => match fp.into_path() {
            Ok(pb) => Ok(json!({ "ok": true, "path": pb.to_string_lossy() })),
            Err(e) => Err(e.to_string()),
        },
        None => Ok(json!({ "ok": false, "cancelled": true })),
    }
}

pub async fn pick_one_file(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let title = payload
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("选择文件")
        .to_string();
    let filters = filters_of(payload);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dlg = app.dialog().file().set_title(title);
    for (name, exts) in &filters {
        let refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
        dlg = dlg.add_filter(name, &refs);
    }
    dlg.pick_file(move |p| {
        let _ = tx.send(p);
    });
    match rx.await.map_err(|e| e.to_string())? {
        Some(fp) => match fp.into_path() {
            Ok(pb) => Ok(json!({ "ok": true, "path": pb.to_string_lossy() })),
            Err(e) => Err(e.to_string()),
        },
        None => Ok(json!({ "ok": false, "cancelled": true })),
    }
}
