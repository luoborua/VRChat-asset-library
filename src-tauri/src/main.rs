#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod host;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const TITLE: &str = "VRChat 改模素材管理库 · v1.1";

/// 页面侧的 vrcElectron 兼容层：Electron 的 preload 暴露了什么，这里就补齐什么。
/// 页面据此判断「跑在原生壳里」，并拿到数据目录（Tauri 的 URL 不是 file://，推导不出来）。
fn init_script() -> String {
    let root = host::app_root().to_string_lossy().replace('\\', "\\\\");
    let data = host::data_dir().to_string_lossy().replace('\\', "\\\\");
    let lib = host::library_dir().to_string_lossy().replace('\\', "\\\\");
    format!(
        r#"(function () {{
  if (!window.__TAURI__) return;
  var inv = window.__TAURI__.core.invoke;
  window.vrcElectron = {{
    shell: 'tauri',
    version: 'tauri2',
    token: '',
    appRoot: '{root}',
    dataDir: '{data}',
    libraryDir: '{lib}',
    getPathForFile: function (file) {{
      try {{ return (file && file.__vrcPath) || ''; }} catch (e) {{ return ''; }}
    }},
    openExternal: function (url) {{
      var u = String(url || '');
      if (!/^https?:\/\//i.test(u)) return false;
      inv('open_external', {{ url: u }}).catch(function () {{}});
      return true;
    }},
    winAction: function (action) {{
      var a = String(action || '');
      if (['min', 'max', 'close'].indexOf(a) < 0) return false;
      inv('win_action', {{ action: a }}).catch(function () {{}});
      return true;
    }},
    onWinState: function (cb) {{
      if (typeof cb !== 'function') return false;
      window.__TAURI__.event.listen('win:state', function (e) {{ try {{ cb(!!e.payload); }} catch (err) {{}} }});
      return true;
    }},
    setTitleBar: function () {{ return true; }}
  }};
}})();"#
    )
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示 / 隐藏窗口", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "刷新（F5）", true, None::<&str>)?;
    let open_data = MenuItem::with_id(app, "open_data", "打开数据目录", true, None::<&str>)?;
    let open_lib = MenuItem::with_id(app, "open_lib", "打开素材库目录", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "检查更新", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", "关于", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[&show, &refresh, &sep, &open_data, &open_lib, &sep2, &update, &about, &quit],
    )?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip(TITLE)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => toggle_window(app),
            "refresh" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval("location.reload()");
                }
            }
            "open_data" => {
                use tauri_plugin_opener::OpenerExt;
                let dir = host::data_dir();
                let _ = std::fs::create_dir_all(&dir);
                let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
            }
            "open_lib" => {
                use tauri_plugin_opener::OpenerExt;
                let dir = host::library_dir();
                let _ = std::fs::create_dir_all(&dir);
                let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
            }
            "update" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                    let _ = w.eval("(typeof Updater !== 'undefined') && Updater.check()");
                }
            }
            "about" => {
                use tauri_plugin_dialog::DialogExt;
                app.dialog()
                    .message(format!(
                        "VRChat 改模素材管理库 · Tauri 版\n版本 1.1.0\n数据目录：{}",
                        host::data_dir().to_string_lossy()
                    ))
                    .title("关于")
                    .show(|_| {});
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn toggle_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

fn mime_of(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .map(|x| x.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "zip" | "vrcpack" => "application/zip",
        "json" => "application/json",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// 只放行素材库里真实存在的类型：图片 / 压缩包 / 清单文本。
/// 这个协议是给 <img> 和拖图设封面用的，不该变成「读任意本地文件」的口子。
fn asset_protocol_allowed(path: &str) -> bool {
    let ext = std::path::Path::new(path)
        .extension()
        .map(|x| x.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "zip" | "vrcpack" | "json" | "txt" | "md"
    )
}

fn main() {
    tauri::Builder::default()
        .register_uri_scheme_protocol("vrcasset", |_app, request| {
            use tauri::http::Response;
            let raw = request.uri().path().trim_start_matches('/').to_string();
            let path = percent_encoding::percent_decode_str(&raw)
                .decode_utf8_lossy()
                .to_string();
            if !asset_protocol_allowed(&path) {
                return Response::builder().status(404).body(Vec::new()).unwrap();
            }
            match std::fs::read(&path) {
                Ok(bytes) => Response::builder()
                    .status(200)
                    .header("Content-Type", mime_of(&path))
                    .header("Cache-Control", "no-cache")
                    /* 页面源是 http://tauri.localhost，读 vrcasset.localhost 属跨源；
                     * <img> 不需要，但 fetch（拖图设封面要读字节）必须有这个头。 */
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes)
                    .unwrap(),
                Err(_) => Response::builder().status(404).body(Vec::new()).unwrap(),
            }
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            host::host_call,
            host::host_stream,
            host::host_read_bytes,
            host::host_write_bytes,
            host::thumb_ensure,
            host::thumb_batch,
            host::app_paths,
            host::win_action,
            open_external
        ])
        .setup(|app| {
            /* 素材主库在窗口之前就绪：首次启动要把老的 assets.json 迁进来 */
            app.manage(host::AppState::new(&host::data_dir()));

            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(TITLE)
                .inner_size(1380.0, 920.0)
                .min_inner_size(1160.0, 620.0)
                .decorations(false)
                .background_color(tauri::window::Color(14, 16, 20, 255))
                .initialization_script(init_script())
                .visible(false)
                .build()?;

            win.show()?;

            /* 拖拽：WebView2 的原生拖放会把 DOM 的 drop 事件吃掉（拿不到路径），
             * 所以由主进程收 WindowEvent::DragDrop，再用合成事件交回页面 ——
             * 页面里的拖拽逻辑（遮罩提示 / 拖图设封面 / 导入分流）一行都不用改。 */
            let last_max = Arc::new(AtomicBool::new(false));
            let w = win.clone();
            win.on_window_event(move |event| match event {
                WindowEvent::DragDrop(drag) => {
                    let payload = match drag {
                        tauri::DragDropEvent::Enter { paths, position } => Some((
                            "enter",
                            paths.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
                            position.x,
                            position.y,
                        )),
                        tauri::DragDropEvent::Over { position } => {
                            Some(("over", Vec::new(), position.x, position.y))
                        }
                        tauri::DragDropEvent::Drop { paths, position } => Some((
                            "drop",
                            paths.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
                            position.x,
                            position.y,
                        )),
                        tauri::DragDropEvent::Leave => Some(("leave", Vec::new(), 0.0, 0.0)),
                        _ => None,
                    };
                    if let Some((kind, paths, x, y)) = payload {
                        let _ = w.emit(
                            "vrc://drag",
                            serde_json::json!({ "kind": kind, "paths": paths, "x": x, "y": y }),
                        );
                    }
                }
                WindowEvent::Resized(_) => {
                    let now = w.is_maximized().unwrap_or(false);
                    if now != last_max.load(Ordering::Relaxed) {
                        last_max.store(now, Ordering::Relaxed);
                        let _ = w.emit("win:state", now);
                    }
                }
                _ => {}
            });

            build_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> bool {
    use tauri_plugin_opener::OpenerExt;
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return false;
    }
    app.opener().open_url(u, None::<&str>).is_ok()
}
