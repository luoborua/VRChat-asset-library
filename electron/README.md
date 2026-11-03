# Electron 版（v1.0）

单文件 HTML 拆成工程结构，宿主从外部 exe（WebView2 / `VRCLibHost.exe`）搬进 Electron 主进程。
**功能与数据格式不变**：同一份 `vrclib-data\`、同一套接口契约、同一批页面模块。

> **v4.1.0：只保留 Electron 单一载体。** 旧的 WebView2 桌面壳、独立宿主 `VRCLibHost.exe`、WebView2 DLL、`结构修复` 工具与用户脚本以外的 `host\` 目录都已删除（归档在 `runtime\_旧版归档\旧壳_WebView2_20261102.zip`）。渲染层里只为旧壳服务的代码也一并清掉了。

## 快速开始

```
双击根目录  启动素材库_Electron版.bat
```

首次在新机器上运行需要先装依赖（本机已装好，`node_modules` 已存在）：

```bash
cd electron
npm install
```

## 目录

```
electron/
├── package.json            electron（devDependency）
├── main/
│   ├── main.js             窗口 / 托盘 / 快捷键 / 单实例 / 宿主生命周期
│   ├── preload.js          只暴露 {shell:'electron'} 标识，不开 node 集成
│   ├── icon.js             运行时生成 32×32 PNG 图标（无需二进制素材）
│   └── host/
│       ├── server.js       HTTP 路由 + CORS + 64MB 请求体上限（8788~8792 自动选端口）
│       ├── api-fs.js       exists / readText / writeFile / readFileBase64 / mkdir / delete / move / copy / open / scan
│       ├── api-net.js      fetch（一次性）+ stream（SSE 转发，AI 翻译用）
│       ├── api-download.js download + downloadProgress（.part 临时文件、断点续传、失败重试、同路径互斥）
│       ├── api-webdav.js   test / list / put / get / mkcol（PROPFIND 解析，无第三方依赖）
│       ├── api-picker.js   pickDir / pickFiles / saveFile / pickOneFile（原生对话框，直接拿绝对路径）
│       ├── api-pack.js     素材包：packCreate / packInspect / packExtract / progress
│       └── zip.js          零依赖 ZIP 读写（store 写、store+deflate 读、全程流式、CRC32 校验）
├── renderer/
│   ├── styles.css          从原单文件抽出的样式表
│   ├── manifest.json       模块清单（顺序 = 原脚本顺序）
│   └── js/                 18 个模块，与原 17 段一一对应；89-pack.js 为 v4.2.0 新增
└── build/
    ├── split-single.mjs    单文件 → 多文件的迁移脚本（一次性，可重放）
    ├── probe-electron.mjs  CDP 探针：页面 / 数据目录 / 宿主
    ├── diag-electron.mjs   CDP 诊断：console 与未捕获异常
    └── test-host-apis.mjs  宿主接口回归（14 项）
```

入口 HTML 仍留在根目录（`VRChat改模素材管理库.html`，124 行），因为页面用
`location` 推导数据目录 `<HTML 同目录>\vrclib-data`；把入口挪进 `renderer/` 会让数据目录跟着跑偏。

## 运行机制

1. 主进程先起 HTTP 宿主（`127.0.0.1:8788~8792`，名字与版本对得上 `40-fs.js` 的 `HOST_NAME` / `HOST_MIN_VERSION`）；
2. 再开窗口 `loadFile(入口HTML)`；
3. 页面的 `hostProbe()` 探测 5 个端口 → 命中主进程宿主 → 之后所有文件/联网/下载都走它。

渲染层不依赖任何 Electron 专有 API 做数据通道，只读 `window.vrcElectron`（由 preload 注入）来判断"现在跑在原生壳里"，用于切换文案与布局。缺这个标识时页面仍可运行，只是按网页版文案显示。

## 验证

```bash
cd electron
node build/test-host-apis.mjs      # 需应用已启动且带 --remote-debugging-port=9222
node build/probe-electron.mjs
```

启动带调试端口：

```bash
cd electron
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9222
```

本机环境可能带 `ELECTRON_RUN_AS_NODE=1`，不清掉 Electron 会以纯 Node 模式启动、窗口不出现。

## v4.2.0：素材包

`89-pack.js`（渲染层）+ `api-pack.js` / `zip.js`（主进程）实现了「打完整包」：

| 环节 | 做法 |
|---|---|
| 收文件 | 素材路径是文件就直接收；是目录就 `scan(dir, 0)` **全递归**，`rel` 保留子目录 |
| 打包 | 全 store（素材本身已是压缩包，再压只耗 CPU）；用 data descriptor 写 CRC，避免每个文件读两遍 |
| 封面 | 走 base64（封面只在 IndexedDB 的 blob 里，没有稳定磁盘路径） |
| 清单 | `vrcpack.json`，字段白名单 + 备注/价格按开关决定 `delete` |
| 解包 | 目标路径**自己拼**（`dir` + 清洗后的 `rel`），不使用 zip 内的路径，从根上避免 zip-slip |
| 校验 | 解完比对 `uncompSize` 与 CRC32，失败明确报错 |

包内结构刻意做成"人也能看懂"：

```
素材/<标题>/<原始文件与子目录>    ← 没装本程序也能直接解压使用
covers/<id>.<ext>
vrcpack.json
```

已知边界：不做 ZIP64，单包上限 4GB。超了会在导出时报错并提示分批。

### v4.2.1：拖入即导入

| 环节 | 做法 |
|---|---|
| 取路径 | Electron 32+ 已移除 `File.path`，`preload.js` 用 `webUtils.getPathForFile(file)` 换成磁盘路径，经 contextBridge 暴露为只读函数 |
| 识别 | `dataTransfer.types` 含 `Files` 才算文件拖拽，内部拖拽（卡片排序）不触发 |
| 提示层 | 复用 `body.dragging` + `::after { content: attr(data-drop-hint) }`；用「400ms 无 dragover」判定离开窗口，比 `dragleave` 可靠（后者移入子元素就误触发） |
| 不打断 | `Modal.stack` 非空时不响应；栈顶是素材包预览时例外，允许替换（`importPath` 先关旧弹窗，避免两个预览叠在一起） |
| 分流 | 先看文件名再要路径：文件夹 / 非 `.vrcpack|.zip` 各自给出具体提示；随后 `exists` 兜一次「名字像包其实是目录」 |

`installDropZone()` 在 `90-main.js` 启动时调用一次，监听走**冒泡**阶段 —— 素材编辑页的图集拖拽区会 `stopPropagation`，两者互不干扰。

## v4.3.0：清单对比（反向）

导入是「把别人的东西装进来」，清单对比是「看自己有什么是别人没有的」，方向相反但共用同一个清单格式。

| 环节 | 做法 |
|---|---|
| 判据 | `itemId` → `title` → `originalTitle`；后两者 `normKey()` 去空白 + 小写，容忍本地改名与全半角差异 |
| 归集 | 清单侧先建 `ids` / `titles` 两个哈希表，本库一次遍历，O(n+m)，几百条无压力 |
| 默认勾选 | 只勾「有本地文件 **且** 无相似项」的（`paths.length`）；没文件的标灰、疑似项标黄，都不默认选 |
| 相似提示 | `annotateSimilar()` 给每条差集找清单里最像的一条：先去空白统一大小写，一方包含另一方（被包含侧 ≥3 字）算 0.9，否则字符 bigram 的 Dice 系数，≥0.45 才提示。**只提示，不改判定** |
| 性能 | 先判包含关系再按长度比剪枝（反过来会误杀「冬季毛衣 ⊂ 冬季毛衣套装」）；`missing × pool > 70 万` 直接跳过提示并在摘要说明 |
| 导出 | 直接调用 `exportDialog(picked)`，路径解析、进度、署名、ZIP 全复用，不写第二套 |
| 只读 | 整个流程只有 `pack/inspect` + 读取 `App.assets`，不调用任何写接口 |

两个顺手接的入口：导出弹窗里的「只导清单（不打包文件）」；导入清单包预览里的「找出他没有的素材」（关掉预览直接转对比，`Modal.stack` 保持为 1）。

## v4.1.0 清掉了什么

| 移除项 | 原用途 | 现状 |
|---|---|---|
| `40-fs.js` 的 `deskAvailable` / `deskCall` / `'desk:'` 分支 | WebView2 宿主对象桥（不走 HTTP） | 全删；宿主只有 HTTP 一条路 |
| `90-main.js` 的 `chrome.webview.postMessage` 转发 | 把 F5/F11/Ctrl+Shift+I/Ctrl+O 转给 WinForms 壳 | 全删；主进程 `before-input-event` 已直接处理 |
| 设置 → 宿主工具文件夹（含选择按钮、目录校验） | 指向 `host\VRCLibHost.exe` 所在目录 | 整块移除 |
| 设置 → 宿主后台隐藏运行 + `applyHostLaunchMode()` | 往 `host-mode.txt` 写启动参数 | 整块移除（Electron 本身就是窗口） |
| 设置项 `hostToolPath` / `hostBackground` | 同上 | 从默认值与 `settings.json` 清理，旧文件读到即剔除 |
| 21 处「双击启动素材库_宿主版.bat」提示 | 引导启动外部宿主 | 改成「内置宿主随窗口启动 / 请重启程序」 |

`/api/shutdown` 也删了 —— Electron 版宿主随窗口退出，没有单独的停止动作。

## 与 3.x 的差异

| | 3.x（WebView2 壳） | 4.x（Electron） |
|---|---|---|
| 宿主 | `素材库桌面版.exe` 内置 + 可选 `VRCLibHost.exe` | 主进程内置，无外部进程 |
| 页面 | 1 个 1.1MB 单文件 | 入口 124 行 + 17 个模块 + 独立 CSS |
| 取绝对路径 | 需 WebView2 桥或手动填写 | 原生对话框直出路径 |
| 宿主配置 | 宿主工具目录、后台隐藏运行 | 无（无需配置） |
| 退出 | 托盘菜单 | 托盘菜单 / 关窗即退 |
