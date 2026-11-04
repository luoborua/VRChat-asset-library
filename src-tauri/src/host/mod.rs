/* 宿主调度：把原 HTTP 路由表 1:1 映射成 Tauri 命令。
 *
 * 为什么保留「api 字符串 + payload 对象」这一层：
 *   渲染层 40-fs.js 有 25 处 FS.host.* 调用，全部经过 hostCall(api, payload)。
 *   保留同一张路由表，页面侧只换传输（fetch → invoke），业务代码一个字都不用动，
 *   行为与 Electron 版严格一致。
 */
pub mod download_api;
pub mod fs_api;
pub mod net_api;
pub mod pack_api;
pub mod picker_api;
pub mod webdav_api;

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    pub dl: download_api::DlState,
    pub pack: pack_api::PackState,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            dl: download_api::DlState::default(),
            pack: pack_api::PackState::default(),
        }
    }
}

/// 程序根目录：debug 下是仓库根（= src-tauri 的上一级），release 下是 exe 所在目录。
/// 数据目录 <root>\vrclib-data 与素材库 <root>\本地素材库 都挂在它下面，与 Electron 版一致。
pub fn app_root() -> std::path::PathBuf {
    if let Ok(v) = std::env::var("VRCLIB_ROOT") {
        if !v.trim().is_empty() {
            return std::path::PathBuf::from(v);
        }
    }
    #[cfg(debug_assertions)]
    {
        let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        return manifest.parent().map(|p| p.to_path_buf()).unwrap_or(manifest);
    }
    #[cfg(not(debug_assertions))]
    {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|x| x.to_path_buf()))
            .unwrap_or_else(|| std::path::PathBuf::from("."))
    }
}

pub fn data_dir() -> std::path::PathBuf {
    app_root().join("vrclib-data")
}

pub fn library_dir() -> std::path::PathBuf {
    app_root().join("本地素材库")
}

fn fail(msg: impl Into<String>) -> Value {
    json!({ "ok": false, "error": msg.into() })
}

#[tauri::command]
pub fn app_paths() -> Value {
    json!({
        "appRoot": app_root().to_string_lossy(),
        "dataDir": data_dir().to_string_lossy(),
        "libraryDir": library_dir().to_string_lossy()
    })
}

#[tauri::command]
pub fn win_action(app: AppHandle, action: String) -> bool {
    let Some(win) = app.get_webview_window("main") else {
        return false;
    };
    match action.as_str() {
        "min" => {
            let _ = win.minimize();
            true
        }
        "max" => {
            if win.is_maximized().unwrap_or(false) {
                let _ = win.unmaximize();
            } else {
                let _ = win.maximize();
            }
            true
        }
        "close" => {
            let _ = win.close();
            true
        }
        _ => false,
    }
}

#[tauri::command]
pub async fn host_call(
    app: AppHandle,
    state: State<'_, AppState>,
    api: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    let p = payload.unwrap_or(json!({}));
    let out: Result<Value, String> = match api.as_str() {
        "/api/exists" => fs_api::exists(&p).await,
        "/api/readText" => fs_api::read_text(&p).await,
        "/api/readFileBase64" => fs_api::read_file_base64(&p).await,
        "/api/writeFile" => fs_api::write_file(&p).await,
        "/api/mkdir" => fs_api::mkdir(&p).await,
        "/api/delete" => fs_api::delete(&p).await,
        "/api/move" => fs_api::move_path(&p).await,
        "/api/copy" => fs_api::copy(&p).await,
        "/api/open" => fs_api::open_path(&app, &p).await,
        "/api/scan" => fs_api::scan(&p).await,

        "/api/pickDir" => picker_api::pick_dir(&app, &p).await,
        "/api/pickFiles" => picker_api::pick_files(&app, &p).await,
        "/api/saveFile" => picker_api::save_file(&app, &p).await,
        "/api/pickOneFile" => picker_api::pick_one_file(&app, &p).await,

        "/api/fetch" => net_api::api_fetch(&p).await,
        "/api/download" => download_api::api_download(&state.dl, &p).await,
        "/api/downloadProgress" => {
            let job_id = p.get("jobId").and_then(|x| x.as_str()).unwrap_or("");
            Ok(download_api::progress(&state.dl, job_id))
        }
        "/api/downloadCancel" => {
            let job_id = p.get("jobId").and_then(|x| x.as_str()).unwrap_or("");
            Ok(download_api::cancel(&state.dl, job_id))
        }

        "/api/webdav/test" => webdav_api::test(&p).await,
        "/api/webdav/list" => webdav_api::list(&p).await,
        "/api/webdav/put" => webdav_api::put(&p).await,
        "/api/webdav/get" => webdav_api::get(&p).await,
        "/api/webdav/mkcol" => webdav_api::mkcol(&p).await,

        "/api/pack/export" => pack_api::pack_create(&state.pack, &p),
        "/api/pack/inspect" => pack_api::pack_inspect(&p),
        "/api/pack/extract" => pack_api::pack_extract(&state.pack, &p),
        "/api/pack/progress" => Ok(pack_api::progress_json(&state.pack)),

        other => return Ok(fail(format!("unknown api: {other}"))),
    };
    Ok(match out {
        Ok(v) => v,
        Err(e) => fail(e),
    })
}

/// SSE 流式转发：改用 Tauri Channel 传帧，帧格式与原宿主逐字节一致。
#[tauri::command]
pub async fn host_stream(payload: Option<Value>, on_event: Channel<String>) -> Result<Value, String> {
    let p = payload.unwrap_or(json!({}));
    match net_api::api_stream(&p, &on_event).await {
        Ok(v) => Ok(v),
        Err(e) => Ok(fail(e)),
    }
}
