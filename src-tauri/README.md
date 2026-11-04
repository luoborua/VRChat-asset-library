# Tauri 2 版（v6.0）

同一份渲染层（`renderer/`，21 个模块 + styles.css）跑在 Tauri 里，
宿主从「Electron 主进程里的 HTTP 服务」换成了「进程内的 Rust 命令」。

**界面、交互、数据结构、素材包格式全部不变**，换掉的只是承载方式与存储实现。

## 目录

```
src-tauri/
├── Cargo.toml
├── tauri.conf.json            frontendDist 指向 ../renderer
├── capabilities/default.json  核心 API + 原生对话框 + 打开链接
├── .cargo/config.toml         GNU 目标链接器
├── icons/icon.ico             运行时生成（make-ico.js）
├── build/                     构建与验证脚本
│   ├── build-tauri.ps1        一键构建并拷到仓库根目录
│   ├── probe-tauri.mjs        宿主接口自检（写盘/扫描/素材包）
│   ├── probe-data.mjs         数据落盘与重载
│   ├── probe-drop.mjs         自定义协议 + 拖拽桥
│   ├── probe-db.mjs           SQLite 主库
│   ├── probe-bytes.mjs        原始字节通道
│   ├── probe-thumb.mjs        缩略图管线
│   └── probe-ui.mjs           详情/编辑/设置/右键/搜索/主题
└── src/
    ├── main.rs                窗口、托盘、单实例、原生拖拽、vrcasset 协议
    └── host/
        ├── mod.rs             路由表（api 字符串 → Rust 函数）+ AppState
        ├── fs_api.rs          exists/readText/readFileBase64/writeFile/mkdir/delete/move/copy/open/scan
        ├── net_api.rs         fetch + SSE（Tauri Channel 传帧）
        ├── download_api.rs    .part 续传、重试、取消、进度
        ├── webdav_api.rs      PROPFIND 解析 + PUT/GET/MKCOL
        ├── picker_api.rs      原生对话框（目录/多选/另存为/单文件）
        ├── pack_api.rs        .vrcpack 导出/查看/解包
        ├── db.rs              SQLite 素材主库（含 assets.json 迁移）
        └── thumbs.rs          400px 缩略图
```

## 为什么保留「api 字符串 + payload」这层

渲染层有 25 处 `FS.host.*`，全部经过 `hostCall(api, payload)`。
Rust 侧照抄同一张路由表，页面只把 `fetch` 换成 `invoke`，
**其余业务代码一行不动** —— 这是「重构后行为一致」最省事也最可靠的做法。

## 构建前提（Windows）

Tauri 官方要求 MSVC C++ 工具集。本机只有 VS 安装器、没有 C++ 工作负载，
所以改用 MinGW-w64 + GNU 目标，无需管理员权限。两个必须的绕行：

| 坑 | 现象 | 绕行 |
|---|---|---|
| 宿主编译链 | 构建脚本按宿主编译；MSVC 宿主找不到 `link.exe` | 用 `stable-x86_64-pc-windows-gnu` 整套工具链（宿主也 GNU） |
| 中文路径 | `dlltool could not create import library … Can't open def file`（路径乱码） | `CARGO_TARGET_DIR=C:\vrclib-build`（纯 ASCII 产物目录） |

准备（一次性）：

```bash
rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal
# MinGW-w64 解压到 %USERPROFILE%\mingw64
cd src-tauri && rustup override set stable-x86_64-pc-windows-gnu
```

构建：

```powershell
cd src-tauri
powershell -ExecutionPolicy Bypass -File build\build-tauri.ps1
```

产物会拷到仓库根目录 `VRChat改模素材管理库.exe`，双击 `启动素材库_Tauri版.bat` 运行。

> **`WebView2Loader.dll` 必须和 exe 放在同一目录**，否则启动瞬间退出、事件查看器里是
> `0xC0000135`（STATUS_DLL_NOT_FOUND）。构建脚本已自动把它从产物目录同步到根目录，
> 手动拷贝 exe 时别忘了带上这个 160 KB 的 DLL。

> 若换到装了 MSVC 的机器，删掉 `src-tauri/.cargo/config.toml` 与 `rustup override unset`，
> 用默认 msvc 工具链直接 `cargo build` 即可，不需要任何绕行。

## 数据

**数据目录可配置**：`settings.json` 固定留在程序目录（它存着 `localDataDir` 这个指针），
主库 / 封面 / 缩略图 / 下载队列跟着用户选的位置走。首次启动询问一次，之后可在设置页更改；
迁移由 `host/data_api.rs` 完成（复制 → 逐文件校验 → 切换指针 → 重开库 → 清理旧目录）。

| 项 | 位置 |
|---|---|
| 素材主库 | `<数据目录>\library.db`（SQLite，WAL；默认数据目录 = `vrclib-data\`） |
| 迁移备份 | `<数据目录>\assets.json.bak`（首次启动自动生成） |
| 设置 | `vrclib-data\settings.json`（**不随数据搬家**） |
| 封面 | `<数据目录>\covers\<id>.<ext>` |
| 缩略图 | `<数据目录>\covers\thumb\<id>.jpg`（400px） |
| 素材文件 | `本地素材库\`（可在设置里改） |

首次启动若发现 `assets.json` 且库为空 → 整库导入 → 原文件改名 `.bak`。
之后 `assets.json` 不再写入，也不再有 64MB 请求体上限。

## 验证

```bash
# 带调试端口启动（用 WebView2 的 CDP）
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./VRChat改模素材管理库.exe

node src-tauri/build/probe-tauri.mjs    # 宿主接口
node src-tauri/build/probe-db.mjs       # SQLite
node src-tauri/build/probe-bytes.mjs    # 字节通道
node src-tauri/build/probe-thumb.mjs    # 缩略图
node src-tauri/build/probe-ui.mjs       # 交互冒烟
```

## 与原 Electron 版的差异

| | Electron | Tauri |
|---|---|---|
| 宿主 | 主进程内 HTTP（127.0.0.1:8788~8792，带访问令牌） | 进程内命令调用，无端口、无令牌 |
| 素材主库 | `assets.json` 整库 JSON + base64 过 HTTP | `library.db` 逐行，只写变更行 |
| 二进制 | 读写一律 base64（膨胀 33%，128MB 上限） | 原始字节（`Response` / 裸请求体） |
| 封面显示 | IndexedDB blob → object URL | 网格走 400px 缩略图，详情走原图 |
| 拖拽 | `webUtils.getPathForFile` | 主进程收 `DragDrop` 事件 → 合成 DOM 事件 |
| 安装体积 / 内存 | 数百 MB / 150~350 MB | 单 exe 十余 MB / 60~120 MB |

## 已知边界

- 只做桌面（未配移动端），`lib.rs` 风格的单 `main.rs`。
- 素材包仍是「全 store 不压缩」，单包上限受 zip 32 位字段限制（4GB）。
- 缩略图按需生成：某素材第一次显示时若还没有缩略图，会先显示原图并在后台补一张。
