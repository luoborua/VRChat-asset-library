/* vrclib-host —— 工作台边车宿主：从标准输入逐行读 JSON 请求，路由到工作台实现，逐行写回结果。
 *
 * 交互：由桌面端主进程拉起，数据根目录通过 --data-dir 注入；未知 api 返回「未实现」。
 * 边界：不做业务判断、不持有状态；请求并发处理，出口加锁保证整行不交错。
 */
mod host;

use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// 把 api 名映射到具体实现；新增接口时路由表与实现必须同时补上。
async fn dispatch(api: &str, p: &Value) -> Result<Value, String> {
    use host::workbench_api as wb;
    match api {
        "/api/wb/probe" => wb::probe(p).await,
        "/api/wb/setImportBusy" => wb::set_import_busy(p).await,
        "/api/wb/quitNow" => wb::quit_now(p).await,
        "/api/wb/hash" => wb::hash(p).await,
        "/api/wb/plan" => wb::plan(p).await,
        "/api/wb/execute" => wb::execute(p).await,
        "/api/wb/importPath" => wb::import_path(p).await,
        "/api/wb/importProgress" => wb::import_progress(p).await,
        "/api/wb/projectStatus" => wb::project_status(p).await,
        "/api/wb/inspectPath" => wb::inspect_path(p).await,
        "/api/wb/listExtract" => wb::list_extract(p).await,
        "/api/wb/importSelected" => wb::import_selected(p).await,
        "/api/wb/discardExtract" => wb::discard_extract(p).await,
        "/api/wb/listDir" => wb::list_dir(p).await,
        "/api/wb/findUnity" => wb::find_unity(p).await,
        "/api/wb/launchUnity" => wb::launch_unity(p).await,
        "/api/wb/logTail" => wb::log_tail(p).await,
        "/api/wb/receipt" => wb::receipt(p).await,
        "/api/wb/allowOverwrite" => wb::allow_overwrite(p).await,
        "/api/wb/installBridge" => wb::install_bridge(p).await,
        other => Err(format!("边车未实现：{other}")),
    }
}

fn main() {
    /* 数据根必须由启动方显式传入：传错会让工作台写到别处，缺参数就直接拒绝启动。 */
    let mut data_dir: Option<PathBuf> = None;
    for a in std::env::args().skip(1) {
        if let Some(v) = a.strip_prefix("--data-dir=") {
            if !v.trim().is_empty() {
                data_dir = Some(PathBuf::from(v.trim()));
            }
        }
    }
    let data_dir = match data_dir {
        Some(d) => d,
        None => {
            eprintln!("vrclib-host: 缺少 --data-dir=<数据根目录>");
            std::process::exit(2);
        }
    };
    host::init_data_dir(data_dir);

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("vrclib-host: 无法创建运行时：{e}");
            std::process::exit(3);
        }
    };

    let out: Arc<Mutex<io::Stdout>> = Arc::new(Mutex::new(io::stdout()));
    let stdin = io::stdin();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = writeln!(out.lock().unwrap(), "{}", json!({ "ok": false, "error": format!("请求不是合法 JSON：{e}") }));
                let _ = out.lock().unwrap().flush();
                continue;
            }
        };

        // 心跳走主线程直答，不占工作线程，避免忙时探活超时
        if req.get("api").and_then(|x| x.as_str()) == Some("__ping") {
            let _ = writeln!(out.lock().unwrap(), "{}", json!({ "ok": true, "value": "pong" }));
            let _ = out.lock().unwrap().flush();
            continue;
        }

        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let api = req.get("api").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let payload = req.get("payload").cloned().unwrap_or_else(|| json!({}));
        let out2 = out.clone();

        rt.spawn(async move {
            let res = dispatch(&api, &payload).await;
            let line = match res {
                Ok(v) => json!({ "id": id, "ok": true, "value": v }),
                Err(e) => json!({ "id": id, "ok": false, "error": e }),
            };
            let mut guard = out2.lock().unwrap();
            let _ = writeln!(guard, "{}", line);
            let _ = guard.flush();
        });
    }

    /* stdin 关闭即父进程已退出；留一点时间让在跑的请求写完结果。 */
    rt.shutdown_timeout(std::time::Duration::from_secs(3));
}
