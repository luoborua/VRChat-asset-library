// mingw 工具链下，rustc 会给 exe 塞一份默认清单，tauri-build（embed-resource）又往 .res 里
// 写了一份 comctl32 的清单，链接时 ld 合并 .rsrc 就会报 "multiple non-default manifests"。
// 这是 x86_64-pc-windows-gnu 的已知现象，两份清单内容等价、产物正常，只屏蔽这一类噪声。
#![allow(linker_messages)]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod host;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// WebView2 的用户数据目录不能让运行时自己去「碰运气」创建。
/// 之前的写法把成败押在「%LOCALAPPDATA%\<identifier> 恰好已经存在」上：
/// 只要需要新建（首次启动、清理过配置、换了安装位置），就会在
/// CreateCoreWebView2Environment 阶段失败（0x8000FFFF），表现就是程序闪退。
/// 这里先由我们自己建好目录，并显式告诉 WebView2 用哪个目录。
fn ensure_webview_data_dir(app: &tauri::App) -> std::path::PathBuf {
    let dir = app.path().app_local_data_dir().unwrap_or_else(|_| {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        base.join("com.vrclib.assetlibrary")
    });
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::create_dir_all(dir.join("EBWebView"));
    dir
}

/// 启动失败必须留下可读的记录；没有它只能靠 WER 猜。
fn log_startup(dir: &std::path::Path, line: &str) {
    use std::io::Write;
    let path = dir.join("startup-error.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{}] {}", stamp, line);
    }
}

const TITLE: &str = "VRChat 改模素材管理库 · v1.2";

/// 页面侧的 vrcElectron 兼容层：Electron 的 preload 暴露了什么，这里就补齐什么。
/// 页面据此判断「跑在原生壳里」，并拿到数据目录（Tauri 的 URL 不是 file://，推导不出来）。
fn init_script() -> String {
    let root = host::app_root().to_string_lossy().replace('\\', "\\\\");
    let cfg = host::settings_dir().to_string_lossy().replace('\\', "\\\\");
    let data = host::data_root().to_string_lossy().replace('\\', "\\\\");
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
    settingsDir: '{cfg}',
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
                        "VRChat 改模素材管理库 · Tauri 版\n版本 1.2.1\n数据目录：{}",
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
        /* 前端产物：开发模式的 vrclibdev 协议要按真正的类型返回，
           否则 WebView2 会把 html/js 当二进制，页面直接黑屏。 */
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        "ico" => "image/x-icon",
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
        .register_uri_scheme_protocol("vrclibdev", |_app, request| {
            use tauri::http::Response;
            /* 开发模式专用：页面直接从 renderer/ 目录读，但走的是自定义协议，
               与内置资源同理属于「自家源」，Tauri 的 IPC 才不会被拒。 */
            let root = std::env::var("VRCLIB_DEV_DIR").unwrap_or_default();
            if root.is_empty() {
                return Response::builder().status(404).body(Vec::new()).unwrap();
            }
            let raw = request.uri().path().trim_start_matches('/');
            let rel = if raw.is_empty() { "index.html" } else { raw };
            let decoded = percent_encoding::percent_decode_str(rel)
                .decode_utf8_lossy()
                .to_string();
            let root_path = std::path::Path::new(&root);
            /* 两边都要 canonicalize：Windows 上它返回 \\?\G:\... 前缀，
               拿没处理过的 root 去 starts_with 比对永远失败（原来就栽在这，页面 404）。 */
            let Ok(root_canon) = root_path.canonicalize() else {
                return Response::builder().status(404).body(Vec::new()).unwrap();
            };
            let target = root_canon.join(&decoded);
            let ok = target
                .canonicalize()
                .map(|p| p.starts_with(&root_canon))
                .unwrap_or(false);
            if !ok {
                return Response::builder().status(404).body(Vec::new()).unwrap();
            }
            match std::fs::read(&target) {
                Ok(bytes) => Response::builder()
                    .status(200)
                    .header("Content-Type", mime_of(&target.to_string_lossy()))
                    .header("Cache-Control", "no-store")
                    .body(bytes)
                    .unwrap(),
                Err(_) => Response::builder().status(404).body(Vec::new()).unwrap(),
            }
        })        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
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
            host::host_p2p_read,
            host::host_p2p_write,
            host::thumb_ensure,
            host::thumb_batch,
            host::app_paths,
            host::win_action,
            host::data_apply_root,
            host::data_api::data_scan,
            host::data_api::data_migrate,
            host::data_api::data_cleanup,
            open_external
        ])
        .setup(|app| {
            /* 素材主库在窗口之前就绪：首次启动要把老的 assets.json 迁进来 */
            app.manage(host::AppState::new(&host::data_dir()));

            /* 上次如果是「导入还没跑完就关窗口」，进程是被直接杀掉的：
               临时解压目录会留在素材旁边。启动时在后台清掉（单实例插件保证此刻没有别的实例在导入），
               不清的话用户会在素材库里看到一堆 `<包名>`、`<包名> (2)` 的临时目录。 */
            std::thread::spawn(|| {
                let (removed, kept) = host::workbench_api::sweep_orphan_extracts();
                if removed > 0 || kept > 0 {
                    eprintln!("[vrclib] 启动清理：删除 {removed} 个临时解压目录，保留 {kept} 个等待 Unity 回执的目录");
                }
            });

            /* v6.5：默认窗口按「中等卡片刚好一排 6 张」定宽。
             * 算法：侧栏 300 + 主区内边距 32 + (6×220 + 5×14) + 竖向滚动条约 17 = 1739。
             * 7 列需要容器 1624 以上，所以 1722~1956 这个区间内一排稳定是 6 张。
             * 但小屏/高缩放机器上 1739 会超出屏幕，所以再按主显示器夹一次。 */
            let (mut win_w, mut win_h) = (1739.0_f64, 920.0_f64);
            if let Ok(Some(mon)) = app.primary_monitor() {
                let scale = if mon.scale_factor() > 0.0 { mon.scale_factor() as f64 } else { 1.0 };
                let sw = mon.size().width as f64 / scale;    // 逻辑像素，与 inner_size 同单位
                let sh = mon.size().height as f64 / scale;
                win_w = win_w.min(sw * 0.94);
                win_h = win_h.min(sh * 0.90);
            }

            let wv_dir = ensure_webview_data_dir(app);
            let mut attempt = 0;
            /* 开发模式：设了 VRCLIB_DEV_DIR（renderer 目录）就从这个目录实时读文件，
               改前端（JS/CSS/HTML）后按 Ctrl+R 即可，不必重新编译 exe。

               为什么走自定义协议而不是本地 HTTP（v6.6 修）：
               http://127.0.0.1:8765 会被 Tauri 判成**外部来源**，外部来源下应用自己的命令
               （host_call 等）默认不放行，于是所有文件读写都返回
               「host_call not found. Plugin not found」，启动就报「数据文件读取失败」。
               自定义协议在 Windows 上映射成 http://vrclibdev.localhost，与内置资源同属「自家源」，
               IPC 正常，也就没有端口、没有被别的网页冒用的可能。 */
            let webview_url = {
                #[cfg(debug_assertions)]
                {
                    let dev_dir = std::env::var("VRCLIB_DEV_DIR").unwrap_or_default();
                    if !dev_dir.trim().is_empty() {
                        match "vrclibdev://localhost/index.html".parse::<tauri::Url>() {
                            Ok(url) => WebviewUrl::CustomProtocol(url),
                            Err(_) => WebviewUrl::App("index.html".into()),
                        }
                    } else {
                        WebviewUrl::App("index.html".into())
                    }
                }
                #[cfg(not(debug_assertions))]
                {
                    WebviewUrl::App("index.html".into())
                }
            };
            let win = loop {
                attempt += 1;
                let mut builder = WebviewWindowBuilder::new(app, "main", webview_url.clone())
                    .title(TITLE)
                    .inner_size(win_w, win_h)
                    .min_inner_size(1160.0, 620.0)
                    .decorations(false)
                    .background_color(tauri::window::Color(14, 16, 20, 255))
                    .initialization_script(init_script())
                    .visible(false);
                #[cfg(windows)]
                {
                    builder = builder.data_directory(wv_dir.clone());
                }
                match builder.build() {
                    Ok(w) => break w,
                    Err(e) => {
                        let msg = e.to_string();
                        log_startup(&wv_dir, &format!("webview attempt {} failed: {}", attempt, msg));
                        /* 0x8000FFFF（灾难性故障）几乎都是配置目录本身坏了或建不出来：
                           把坏目录挪走再试一次，而不是让用户去删 %LOCALAPPDATA%。 */
                        if attempt == 1 && msg.contains("0x8000FFFF") {
                            let profile = wv_dir.join("EBWebView");
                            if profile.exists() {
                                let bak = wv_dir.join(format!("EBWebView.broken-{}", std::process::id()));
                                let _ = std::fs::rename(&profile, &bak);
                                log_startup(&wv_dir, &format!("profile moved to {}", bak.display()));
                                let _ = std::fs::create_dir_all(&profile);
                            }
                            continue;
                        }
                        log_startup(&wv_dir, "giving up");
                        return Err(e.into());
                    }
                }
            };

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
                /* 导入还在跑的时候，先别关：让页面弹一次确认。
                   busy 是「租约」而不是布尔值（见 workbench_api::import_busy_now），
                   页面崩了或事件没绑上，租约过期后照样能关，不会把窗口锁死。 */
                WindowEvent::CloseRequested { api, .. } => {
                    /* 传文件到一半被关窗：位图必须落盘，否则下次接不上。 */
                    if let Some(st) = w.try_state::<host::AppState>() {
                        host::p2p_api::flush_all(&st.p2p);
                    }
                    if host::workbench_api::import_busy_now() {
                        api.prevent_close();
                        let _ = w.emit("wb-busy-close", ());
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
