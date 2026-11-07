# 给接手这个仓库的智能体

## 硬约束

- **不要主动打包。** 发布由用户决定，他没说就不做。
- **不要往仓库根目录复制 exe。** 需要边车时用 `host-sidecar` 的产物（见下）。
- 改完 `renderer/` 不用构建：Electron 直接从磁盘读文件，重启窗口即可生效。

## 怎么跑起来

- 日常启动：双击 `启动素材库_Electron版.bat`（内部会实测沙箱可用性并选择启动参数）。
- 调试/自动化：`调试端口.bat` 会带 `--remote-debugging-port=9333` 启动，之后可连
  `http://127.0.0.1:9333/json/list`。
- **回归脚本**：`node runtime/regress.js`、`regress2.js`、`regress3.js`、`regress4.js`、`regress5.js`、`regress6.js`、
  `regress7.js`、`regress8.js`、`regress9.js`（需应用带调试端口启动），`node runtime/test-update.js`（离线跑更新覆盖脚本）、
  `node runtime/e2e-update.js [port]`（需先搭便携目录，见文件头）；
  `node runtime/test-p2p.js` 与 `node runtime/test-data-api.js` 可脱离应用单独跑。
  `regress8.js` 会临时把抓取模式切到「内置联网」并请求真实的 BOOTH 商品（8562330 / 6102188），测完复原；
  它的「模式已复原」断言比对的是**测试开始时的值**，不是你假设的 `paste`。
  `regress9.js` 也请求真实 BOOTH 商品（8562330）验证「更新商品信息」，可用 `node runtime/regress9.js 9334` 换端口。
- **想另开一个实例跑回归而不碰用户数据**：把 `electron/main` + `renderer` + `host/vrclib-host.exe` +
  一份 `vrclib-data` 复制到 `runtime/_t/app`（`package.json` 的 `main` 指 `electron/main/main.js`），
  再 `electron.exe ./app --remote-debugging-port=9333`。APP_ROOT 变了 → userData / 单实例锁 / 素材库全在副本里，
  用户正在用的那个实例不受影响。
- 窗口被最小化时 `visibilityState=hidden`，rAF 不跑、截图会挂住；测试脚本先用
  `vrcElectron.winAction('show')` 把窗口叫回来。

## 边车（改模工作台的重活）

工作台的磁盘实现是一个独立进程 `vrclib-host.exe`，源码在 `host-sidecar/`，
渲染层通过主进程用「标准输入输出 + 行分隔 JSON」调用它。

```
cd host-sidecar
export PATH="/c/Users/nmclb/.cargo/bin:/c/Users/nmclb/mingw64/bin:$PATH"
cargo +stable-x86_64-pc-windows-gnu build --release
cp target/release/vrclib-host.exe ../host/vrclib-host.exe
```

本机默认 toolchain 是 MSVC，直接 `cargo build` 会把 `link.exe` 解析成 Git 自带的 `link`，
报 `extra operand`。**必须带 `+stable-x86_64-pc-windows-gnu`。**

## 先读什么

- `docs/改模工作台-逻辑拆分.md` —— 工作台的业务规则。
- `docs/工作台导入-边界条件清单.md` —— 导入的逐条边界条件。
- `docs/审查台账.md` —— 修过什么、故意没修什么，以及每条的依据。

## 仓库结构速记

- `renderer/` 纯静态前端：按编号顺序 `<script>` 引入的原生 JS，无框架、无构建。
  `50-app.js` 是主界面（`App` / `UI`），`90-main.js` 是启动与全局事件，`40-fs.js` 是访问后端的唯一入口，
  `93-trash.js` 是回收站页。
- `electron/main/` 主进程：`main.js` 管窗口/托盘/协议，`bridge.js` 路由 `/api/*`，
  `preload.js` 提供 `window.__TAURI__.core.invoke` 同名接口，`host/` 下是各功能实现。
- `host-sidecar/` Rust 边车，`src/main.rs` 是请求分发，`src/host/workbench_api.rs` 是工作台磁盘实现。
- 数据在启动时选的目录：`library.db`（SQLite）、`covers/`（封面与 `thumb/` 缩略图）、
  `settings.json`、`workbench.json`、`download-queue.json`、`transfers/`（P2P 续传位图）。

## 两条约定

- **素材编号**（`asset.fileId`）：好友导出/导入判定「是不是同一份」的唯一依据，**只读，用户改不了**。
  BOOTH 商品直接用商品编号（纯数字）；其余素材用 `V` + 8 位大写字母数字（字母打头，和纯数字天然不撞）。
  编号生成后不再变，只在填了 BOOTH 链接时被商品编号接管。导入判重**只看编号**（`findExisting2`）：
  标题、商品号、链接都不再参与，包里没编号的条目按新素材处理。改这条规则时三处要一起动：
  `20-store.js` 的 `fileIdOf`、`89-pack.js` 的 `findExisting2`/`metaFileId`、`api-pack.js` 的清单字段。
- **编号必须全局唯一，不许两条素材共用一个号**（共用会在导入时被当成同一份、元数据互相覆盖）。四条保障，
  改动时别拆：
  1. `Store.newFileId` 除传入的 `taken` 外，还查模块级 `fileIdReserved`（本进程发过、可能还没落盘的号）——
     一次导入几十条时 `taken` 是旧快照，只靠随机不撞不算「确保」。兜底路径同样逐个查重，不再退回不定长时间戳串。
  2. `Store.ensureFileIds` 在启动时会全表审计：缺号的补、撞号的（含仅大小写不同）给后出现的那条重发；
     两条同 BOOTH 商品号除外（同一商品本就是同一份），只计数不报警改号。
  3. 导入选「新增一条」时用 `Packer.allocImportFileId`：对方编号本库没人用才照抄，被占用就另发新号。
  4. 编号比较一律走 `Store.fileIdKey`（trim + 大写），落库 `normalizeAsset` 也统一大写。
     自测：`node runtime/regress6.js`（22 项，含「Math.random 恒定也发唯一号」）。
- **有时限的提示统一带倒计时条**：`Toast.make({ msg, ms })` 与 `Modal.open({ autoClose })` 共用
  同一条 `.toast-prog` / `.modal-prog`（同一个 `toastCountdown` 动画）。不要再单独写一个
  `setTimeout` + 进度环，条和关闭时长必须来自同一个 `ms`。
- **粘贴商品链接自动填「原标题」**：`Fetchers.fetchTitle(url)` 只取标题，别拿 `fetchInfo` 顶 —— 那条路会抓
  图集、变体、订单页，几十个请求换一个标题不值当。BOOTH 直接读 `booth.pm/ja/items/<id>.json` 的 `name`
  （比整页 HTML 小，也不会被语言跳转 / 年龄确认页挡）。表单侧在 `70-forms.js` 的 `maybeAutoTitle`：
  打开表单（原标题为空）、粘贴/更换链接、从链接编辑器添加时各触发一次，写进「原标题」并给空着的「显示标题」兜底。
  两条铁律：**用户手填的原标题不覆盖**（只认「空」或「上次自动写进去的值」，见 `autoTitleWritable`）；
  **默认「手动粘贴源码」下是否联网由设置里 `autoTitleFetch` 决定**（默认开，关掉后连这一次请求都不发）。
  站点后缀统一由 `Fetchers.cleanPageTitle` 剥：先剥「- 店名 - BOOTH」两段，再剥「- BOOTH」单段 ——
  顺序反了店名会永远留在标题里。
- **批量「更新商品信息」**（多选后顶部批量操作条的 `#bulkRefreshInfo` → `Tools.bulkRefreshInfo`）：对选中素材重抓一次商品页。
  与「批量获取更新（订单文件）」严格分工：**这条只动商品页字段**（原标题/作者/店铺/简介/标签/图集/封面外链/
  上下架与更新日期/分类/支持角色），版本与下载文件归那边。合并规则在 `Tools.applyShopInfo`，四条不能拆：
  1. 沿用表单那套字段锁：`a.userEdited[k]` 为真就跳过（勾「覆盖我手动改过的字段」才放开）；
  2. 自定义标题、角色三语名**永不覆盖**，自定义标题只在空着时用原标题兜底；
  3. 标签 / 图集**只增不减**，不能把用户自己补的内容冲掉；封面外链只在没有本地封面且用户没清过封面时写；
  4. 分类只在当前是「其他」时补，不抢用户分好的类。
  请求一律 `{ forceNetwork: true, noCache: true }`（用户点按钮就是明确要联网，手动粘贴模式下也发这一次）；
  串行 + 220ms 间隔，别把站点打急。下架判定统一走 `Fetchers.looksDelisted`（只认 404/410），编辑页也用它。

## 自动更新（覆盖安装）

- **分工**：`renderer/js/84-update.js` 只负责比对版本、挑包、显示进度；真正的下载/解压/替换在
  `electron/main/host/api-update.js`（`/api/update/info|apply|progress|cancel`）。
- **只认便携包**：Release 资产里必须有名字带 `win-x64` 的 zip（`vrchat-asset-library_vX_win-x64.zip`）。
  历史上的单 exe 壳包（`VRCLib-1.3.0-win64.zip`）结构完全不同，`pickAsset` 会拒绝，宁可不给按钮。
- **必须重启才替换**：`electron.exe` 运行时被锁，`apply` 只是下载+解压+起一段 PowerShell，
  由它等本进程退出 → 备份 `app/` → `robocopy /E` 覆盖 → 失败回滚 `app/` → 用原命令行参数重启 → 清临时目录。
  **不要在 `spawn` 上加 `detached`**：Windows 下 `detached + stdio:ignore` 会让 powershell 直接退出、脚本一行不跑
  （实测退出码 0、文件不生成）。
- **用户数据永不覆盖**：`extractAll` 跳过 `app/vrclib-data/`、`vrclib-data/`、`本地素材库/`、`runtime/`
  以及任何非 ASCII 路径；`robocopy` 不加 `/MIR`，所以目标里多出来的文件一个不删。
- **打包结构**：`app/electron/main/` + `app/renderer/`（不是 `app/electron/renderer/`，main.js 读 `<APP_ROOT>/renderer/index.html`）
  + `app/host/vrclib-host.exe` + `app/package.json`。APP_ROOT 因此等于 `app/`，安装目录是它的上一级。
  打包脚本里不要用 `Remove-Item -Recurse` 批量删文件（杀软与删除守护会拦），用 robocopy 排除或空目录镜像。

## 性能这块的既有结论

- JS 不慢：`renderAll` 5.8–9.2ms，800 条素材时 6.2ms；滚动时主线程每帧约 1ms。
- 布局是「顶栏一行 + 内容区三列」的纵向 flex，滚动分别在 `.main` 与 `.sidebar` 内部。
  早期结论说内层滚动会卡死合成器，那是 `position: fixed` 的内层容器；flex 子项 + `overflow:auto`
  实测无长帧（24 次滚动手势最长掉帧 7ms）。真要改回去，先按 `runtime/scroll-bench-now.js` 量一遍。
- Electron 下不要给 `wheel` 注册 `{passive:false}`：那会把每一帧滚动的提交权从合成器抢回主线程。
- `vrcasset://` 协议必须异步读盘，否则每张封面都在主线程等 I/O。
- 卡顿取证：`window.__jank` 记帧间隔与长任务，F9 呼出面板（也可用 `?debug=1` 启动即采）。
