/* 边车模块根：只提供工作台实现所需的最小宿主能力。
 *
 * 职责：持有数据根目录，并用 #[path] 把 workbench_api.rs 编进本 crate；不写业务代码。
 * 边界：p2p_api / signal_api 未编入——其信令依赖 tokio net，当前 Windows 构建环境缺 binutils。
 */
use std::path::PathBuf;
use std::sync::OnceLock;

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 启动时注入一次，之后只读。
pub fn init_data_dir(p: PathBuf) {
    let _ = DATA_DIR.set(p);
}

/// 库内所有 json / 缩略图 / 备份都落在这个目录下。
pub fn data_dir() -> PathBuf {
    DATA_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

#[path = "workbench_api.rs"]
pub mod workbench_api;
