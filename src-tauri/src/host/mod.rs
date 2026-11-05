/* 宿主调度：把原 HTTP 路由表 1:1 映射成 Tauri 命令。
 *
 * 为什么保留「api 字符串 + payload 对象」这一层：
 *   渲染层 40-fs.js 有 25 处 FS.host.* 调用，全部经过 hostCall(api, payload)。
 *   保留同一张路由表，页面侧只换传输（fetch → invoke），业务代码一个字都不用动，
 *   行为与 Electron 版严格一致。
 */
pub mod data_api;
pub mod db;
pub mod download_api;
pub mod fs_api;
pub mod net_api;
pub mod pack_api;
pub mod picker_api;
pub mod thumbs;
pub mod webdav_api;
pub mod workbench_api;

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    pub dl: download_api::DlState,
    pub pack: pack_api::PackState,
    pub db: db::DbState,
}

impl AppState {
    pub fn new(data_dir: &std::path::Path) -> Self {
        let db = match db::DbState::open(data_dir) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[db] 打开失败：{e}");
                db::DbState::default()
            }
        };
        Self {
            dl: download_api::DlState::default(),
            pack: pack_api::PackState::default(),
            db,
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

/// 配置目录：永远在程序目录下，**不随数据搬家**。
/// 里面只放 settings.json（约 1 KB），其中一项 localDataDir 指向真正的数据根。
/// 这样「数据可以放到任意盘」与「启动时知道去哪找数据」不冲突。
pub fn settings_dir() -> std::path::PathBuf {
    app_root().join("vrclib-data")
}

/// 数据根：settings.json 里配了 localDataDir 就用它，否则默认与配置同目录（便携模式）。
pub fn data_root() -> std::path::PathBuf {
    let cfg = settings_dir().join("settings.json");
    if let Ok(txt) = std::fs::read_to_string(&cfg) {
        if let Ok(v) = serde_json::from_str::<Value>(&txt) {
            if let Some(p) = v
                .get("settings")
                .and_then(|s| s.get("localDataDir"))
                .and_then(|x| x.as_str())
            {
                let p = p.trim();
                if !p.is_empty() {
                    return std::path::PathBuf::from(p);
                }
            }
        }
    }
    settings_dir()
}

/// 兼容旧名：库里其它地方仍按 data_dir() 取主库位置
pub fn data_dir() -> std::path::PathBuf {
    data_root()
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
        "settingsDir": settings_dir().to_string_lossy(),
        "dataDir": data_root().to_string_lossy(),
        "libraryDir": library_dir().to_string_lossy()
    })
}

/// 重新解析数据根并重开数据库。
/// 迁移流程的最后一步：settings.json 已写入新的 localDataDir，这里让连接跟过去。
#[tauri::command]
pub fn data_apply_root(state: State<AppState>) -> Value {
    let root = data_root();
    match state.db.reopen(&root) {
        Ok(v) => v,
        Err(e) => fail(format!("切换数据目录后打开主库失败：{e}")),
    }
}

/* ---------------- 原始字节通道（v6.1：彻底不再过 base64） ----------------
 * 读：返回 tauri::ipc::Response，页面直接拿到 ArrayBuffer；
 * 写：请求体就是裸字节（invoke 传 Uint8Array），路径放在 x-vrc-path 头里（percent 编码，保证 ASCII）。
 * 相比原来的 base64：不膨胀 33%、不产生中间字符串、没有 64MB 请求体上限。 */

#[tauri::command]
pub async fn host_read_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn host_write_bytes(request: tauri::ipc::Request<'_>) -> Result<Value, String> {    let raw = request
        .headers()
        .get("x-vrc-path")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if raw.is_empty() {
        return Err("缺少路径".into());
    }
    let path = percent_encoding::percent_decode_str(raw)
        .decode_utf8_lossy()
        .to_string();
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.to_vec(),
        _ => return Err("请求体必须是二进制".into()),
    };
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "size": bytes.len(), "path": path }))
}

/* ---------------- 缩略图 ---------------- */

#[tauri::command]
pub async fn thumb_ensure(src: String, dst: String, max: Option<u32>) -> Result<Value, String> {
    let w = max.unwrap_or(400);
    tauri::async_runtime::spawn_blocking(move || thumbs::thumb_ensure(&src, &dst, w))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn thumb_batch(items: Vec<Value>, max: Option<u32>) -> Result<Value, String> {
    let w = max.unwrap_or(400);
    tauri::async_runtime::spawn_blocking(move || thumbs::thumb_batch(&items, w))
        .await
        .map_err(|e| e.to_string())
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

        "/api/pack/export" => pack_api::pack_create(&state.pack, &p),        "/api/pack/inspect" => pack_api::pack_inspect(&p),
        "/api/pack/extract" => pack_api::pack_extract(&state.pack, &p),
        "/api/pack/progress" => Ok(pack_api::progress_json(&state.pack)),

        /* ---- 素材主库（SQLite）---- */
        "/api/db/load" => state.db.load(),
        "/api/db/save" => {
            let list = p.get("assets").and_then(|x| x.as_array()).cloned().unwrap_or_default();
            let at = p.get("at").and_then(|x| x.as_str()).unwrap_or("").to_string();
            state.db.save(&list, &at)
        }
        "/api/db/info" => Ok(state.db.info()),

        /* ---- 改模工作台（工程登记 / 导入预检 / 复制）---- */
        "/api/wb/probe" => workbench_api::probe(&p).await,
        "/api/wb/setImportBusy" => workbench_api::set_import_busy(&p).await,
        "/api/wb/quitNow" => workbench_api::quit_now(&p).await,
        "/api/wb/hash" => workbench_api::hash(&p).await,
        "/api/wb/plan" => workbench_api::plan(&p).await,
        "/api/wb/execute" => workbench_api::execute(&p).await,
        "/api/wb/importPath" => workbench_api::import_path(&p).await,
        "/api/wb/importProgress" => workbench_api::import_progress(&p).await,
        "/api/wb/projectStatus" => workbench_api::project_status(&p).await,
        "/api/wb/inspectPath" => workbench_api::inspect_path(&p).await,
        "/api/wb/listExtract" => workbench_api::list_extract(&p).await,
        "/api/wb/importSelected" => workbench_api::import_selected(&p).await,
        "/api/wb/discardExtract" => workbench_api::discard_extract(&p).await,
        "/api/wb/listDir" => workbench_api::list_dir(&p).await,
        "/api/wb/findUnity" => workbench_api::find_unity(&p).await,
        "/api/wb/launchUnity" => workbench_api::launch_unity(&p).await,
        "/api/wb/logTail" => workbench_api::log_tail(&p).await,
        "/api/wb/receipt" => workbench_api::receipt(&p).await,
        "/api/wb/allowOverwrite" => workbench_api::allow_overwrite(&p).await,
        "/api/wb/installBridge" => workbench_api::install_bridge(&p).await,
        "/api/wb/maRequest" => workbench_api::ma_request(&p).await,
        "/api/wb/maReceipt" => workbench_api::ma_receipt(&p).await,

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
