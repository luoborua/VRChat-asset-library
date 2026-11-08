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
  `regress7.js`、`regress8.js`、`regress9.js`、`regress10.js`、`regress11.js`、`regress12.js`、`regress13.js`、`regress14.js`、`regress15.js`、`regress16.js`、`regress17.js`、`regress18.js`、`regress19.js`（需应用带调试端口启动），`node runtime/test-update.js`（离线跑更新覆盖脚本）、
  `node runtime/e2e-update.js [port]`（需先搭便携目录，见文件头）；
  `node runtime/test-p2p.js` 与 `node runtime/test-data-api.js` 可脱离应用单独跑。
  `regress8.js` 会临时把抓取模式切到「内置联网」并请求真实的 BOOTH 商品（8562330 / 6102188），测完复原；
  它的「模式已复原」断言比对的是**测试开始时的值**，不是你假设的 `paste`。
  `regress9.js` 也请求真实 BOOTH 商品（8562330）验证「更新商品信息」，可用 `node runtime/regress9.js 9334` 换端口。
  `regress13.js` 验「只填商品 ID 也能解析」（`Fetchers.productCandidates` + 详情页自动补全），
  同样真实请求 8562330。它每轮用不同 id 建测试素材（上一轮可能已经写进副本库，重名会让详情页指向旧记录）；
  跑完记得**重建副本库**再做别的回归，否则带 8562330 的测试素材会留下重复素材编号，regress5/6 会假失败。
  `regress10.js` 验详情页切页，需要先在测试目录放 3 个文件：`node runtime/regress10.js 9333 <文件夹绝对路径>`
  （图片文件会被「图片不扫描」跳过，所以断言按 2 个文件算）。
  `regress11.js` 验「拖到卡片 → 放进这条素材」，要预先建好 `runtime/_t/src`（放了 `衣装_DLC.zip`、
  `衣装本体_v1.3.zip`、`preview.png`）与 `runtime/_t/dest`；它会真的复制文件并写库，跑完自己清理测试素材。
  `preview.png` **必须是真 PNG**（设封面要解出一张图，随便糊的字节会让「素材标记为有封面」失败）。
  合成拖放事件用 `new DragEvent(type, { dataTransfer })` + `dt.items.add(new File(...))` 就能走完整路由。
  `regress14.js`（61 项）验「本地文件」的本体 / DLC 分组、对账、拖动改判、本体缺失与移除记录、导入默认去向、补 DLC 的复制 / 移动：测试目录 `runtime/_t/lf`
  （含一个 90 字长文件名）由脚本自己建、跑完自己删；它把测试素材真的写进副本库再 `App.remove` 送进回收站，
  所以**它之后跑 regress4 前先清一次回收站**，否则「清空回收站」那几项会因为条数不对而假失败。
  取样尽量别依赖「App.assets[0] 是哪条」：库里多一条 BOOTH 素材就能让断言翻车（regress5、regress8 都踩过）。
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
- **商品输入可以是纯数字 ID**：`Fetchers.productCandidates(raw)` 是唯一判据，返回按优先级排的候选完整链接 ——
  纯数字（4–15 位）→ `booth.pm/ja/items/<id>` + `zh-cn`（**不要再拼 Gumroad**：那边是字母数字短码，
  纯数字只会白等一次超时）；少了 `https://` 的链接自动补协议头；纯字母数字短码 → `gumroad.com/l/<code>`。
  详情页的「从商品链接补充信息」和编辑页的「强制联网填充」都走它，别各写一套正则。
  试探候选一律用 `Fetchers.fetchInfoTimed(url, ctx, ms)`：编号写错时后端可能长时间不返回，
  不带超时按钮会永远停在「解析中…」。后端的 `reason` 是内部代号（`host-failed` / `host-offline`），
  给用户看的文案要过一层映射，别直接吐出来。
- **详情页「解析并补充」的计划与写库必须共用一份**（`70-forms.js` 的 `enrichPlan` → `previewApply` → `applyInfo`）：
  plan 里每一项都是 `{ label, cur, next, apply }`，预览负责显示 `cur → next`，应用只是把每项 `apply()` 跑一遍。
  **别回到「预览一个函数、写库另一个函数」的写法** —— 旧版就是这样，而且只往 `a.rawTags` 里塞标签、
  从来没写过 `a.tags`（界面上的标签胶囊读的是 `a.tags`），所以「预览里明明有标签，应用完还是空的」。
  规则：只补空白字段；标签 / 图集只增不减；标题拆成「原标题（无条件补）」和「标题（仅在空/未命名时）」两行；
  商品价只在没有商品价且数值 > 0 时写（**永远不写 0**，0 会被 `Store.deriveAssetIsFree` 当成「免费」）。
  收尾刷新用 `Modals.refreshAfterChange(saved, { keepModal: true })`，**不要 `Modals.detail(a.id)`** ——
  不带 handle 调用会再压一层新弹窗，回来看到两个详情叠着。
- **别在 `applyInfo` 里用 `normU`**：那个标识符只在详情页「同商品检测」那段局部作用域里定义过
  （`70-forms.js` 约 382 行），在 `applyInfo` 里是未定义的。`Array.prototype.some` 会调它，
  于是「素材已经有一条链接」时点「应用」直接抛 ReferenceError —— 表现就是不提示、不刷新、像是没反应。
  链接比对用 `applyInfo` 上方那个 `urlKey()`。
- **粘贴商品链接自动填「原标题」**：`Fetchers.fetchTitle(url)` 只取标题，别拿 `fetchInfo` 顶 —— 那条路会抓
  图集、变体、订单页，几十个请求换一个标题不值当。BOOTH 直接读 `booth.pm/ja/items/<id>.json` 的 `name`
  （比整页 HTML 小，也不会被语言跳转 / 年龄确认页挡）。表单侧在 `70-forms.js` 的 `maybeAutoTitle`：
  打开表单（原标题为空）、粘贴/更换链接、从链接编辑器添加时各触发一次，写进「原标题」并给空着的「显示标题」兜底。
  两条铁律：**用户手填的原标题不覆盖**（只认「空」或「上次自动写进去的值」，见 `autoTitleWritable`）；
  **默认「手动粘贴源码」下是否联网由设置里 `autoTitleFetch` 决定**（默认开，关掉后连这一次请求都不发）。
  站点后缀统一由 `Fetchers.cleanPageTitle` 剥：先剥「- 店名 - BOOTH」两段，再剥「- BOOTH」单段 ——
  顺序反了店名会永远留在标题里。
- **只有「强制联网填充」这一种填充**（`70-forms.js` 编辑页的 `forceBtn`）：以前还有「联网自动填充」和
  「用 Cookie 获取已购信息」，两个都只填空值、还吃本地缓存，点完常常看不出变化，已删除。
  `startFetch` 的默认值就是 `{ forceFill: true, forceNetwork: true, noCache: true }`；
  `Fetchers.fetchInfo` 里也把「没传 `forceNetwork`」当强制处理（默认 `forceNetwork/noCache = true`），
  免得新写的调用点又悄悄回到吃缓存的老路。**唯一的例外是「打开编辑页自动补齐变体」那两条静默调用**：
  显式 `forceFill: false` —— 后台自己动起来把用户填好的字段冲掉，比不补更糟。
  批量工具（批量添加 / 批量补全 / 更新商品信息 / 同步心愿单）同样一律强制，`Net.networkAllowed()` 的
  「手动粘贴源码」门槛在这些**用户点了按钮**的入口上不再拦截（那是「不偷偷发请求」，不是「点了也不发」）。
- **自动补全必须有限流**（`86-import.js` 的 `autoEnrichGate` / `takeAutoSlot`）：打开详情 / 编辑页会自己联网，
  一个商品是「1 次 JSON + 1 次商品页 HTML + N 次订单页」，而**失败时不会锁** `autoFilled.versions`
  —— 于是每开一次详情就整轮重跑，反复点开几十次就是几十轮请求，站点会当爬虫。四层约束，缺一层都会漏：
  1. 总开关 `App.settings.autoVariantFetch`（设置 → 联网与抓取，默认开），关掉后只有手动按钮才联网；
  2. **目标站没存 Cookie 就不跑**（`Fetchers.hasCred` 只看有没有、不解密）——读不到订单页，商品页那两次是白请求；
  3. 冷却按素材记在 `localStorage` 的 `vrclib.autoEnrich.tried.v1`（`{at, n}`，不是写库，别改成 `App.save`：
     「打开详情不落库」是有测试盯着的），20 分钟起每次翻倍、封顶 6 小时，成功锁定时 `clearAutoTried` 清掉；
  4. 两次自动补全之间至少隔 4 秒（`takeAutoSlot`），并发由 `autoEnrichBusy` 挡住。
  设置页那个「清除冷却记录」按钮就是删这个 key —— 用户换完 Cookie 想立刻重试时用。
  **手动入口不受闸门约束**（强制联网填充 / 重新解析 / 批量），那是用户明确要求的。
- **批量的请求间隔别再调回 200ms**：批量添加、批量补全、批量获取更新、同步心愿单现在都是
  700~1500ms 抖动（`setTimeout(r, 900 + Math.random() * 600)` 这种写法），看起来像个在读页面的人。
- **批量「更新商品信息」**（多选后顶部批量操作条的 `#bulkRefreshInfo` → `Tools.bulkRefreshInfo`）：对选中素材重抓一次商品页。
  与「批量获取更新（订单文件）」严格分工：**这条只动商品页字段**（原标题/作者/店铺/简介/标签/图集/封面外链/
  上下架与更新日期/分类/支持角色），版本与下载文件归那边。合并规则在 `Tools.applyShopInfo`，四条不能拆：
  1. 沿用表单那套字段锁：`a.userEdited[k]` 为真就跳过（勾「覆盖我手动改过的字段」才放开）；
  2. 自定义标题、角色三语名**永不覆盖**，自定义标题只在空着时用原标题兜底；
  3. 标签 / 图集**只增不减**，不能把用户自己补的内容冲掉；封面外链只在没有本地封面且用户没清过封面时写；
  4. 分类只在当前是「其他」时补，不抢用户分好的类。
  请求一律 `{ forceNetwork: true, noCache: true }`（用户点按钮就是明确要联网，手动粘贴模式下也发这一次）；
  串行 + 900~1500ms 抖动间隔，别把站点打急。下架判定统一走 `Fetchers.looksDelisted`（只认 404/410），编辑页也用它。
- **详情页「版本与下载」是两个切页**（`70-forms.js` 的 `detail-tabs`）：`链接` 页保持原样（版本 / 下载直链 / 订单链接），
  `本地文件` 页按「**本体文件 / 额外文件 · DLC**」分两组渲染，一行一个文件（`nowrap` + 省略号，长名字不许换行，
  否则「显示」按钮会掉到第二行）。默认页规则：原地刷新（`opts.keepTab`）回到上次那一页；
  否则有远端文件停「链接」，**一条链接都没有但有本地路径时直接停在「本地文件」**。
  别把两页合成一页：链接来自 `versions[].files`（必须有 url 才渲染），本地文件来自磁盘，两者本来就不是一套数据。
- **本体认哪个文件**（`App.localBaseEntries`，唯一判据，别各写一套）：
  ① `versions[]` 里 `local:true` 的条目 → `fileName` 就是本体；
  ② 远端变体里**确实下载过**（名字在 `downloadedFiles`）的那个主文件 → 本体，且**一个版本只认一个**：
  `fileName` 在候选里才用它，否则取体积最大的非许可证文件。**不能把 `versions[].files` 全算本体**
  （没下载的远端文件本来就不在磁盘上，全算等于每次开详情都报「本体缺失」），也**不能盲信 `fileName`**
  （`normalizeVersion` 会把 `files[0]` 兜底成 `fileName`，而 BOOTH 的 `files[0]` 常是 readme）；
  ③ 导入 / 下载过、但**没有版本归属**的（`downloadedFiles` 里不在任何 `versions[].files` 中）→ 本体。
  ③ 是「导进来的新文件默认算本体」那条需求；有版本归属的必须交给 ②，否则同一订单里买的 DLC 会被全算成本体。
  **`extraFiles` 里登记过的一律不算本体**（优先级最高）：那是用户明确划成 DLC 的，
  否则「本体 → DLC」会被下一次对账按 ③ 改回去。
  其余磁盘文件一律是「额外文件 / DLC」，记在 `extraFiles[]`（`{name,size,addedAt,note}`，`20-store.js` 里规范化）。
  **凡是把文件写进素材目录的入口，都要把文件名记进 `downloadedFiles`**（编辑页「导入已有文件 / 文件夹」的
  `attachDropped`、下载队列、审计工具「登记」都这么做）。漏记的后果是那条文件没有任何记录，扫描时被当成
  「磁盘上多出来的」→ 直接划成 DLC，用户看到的就是「我明明导入的是本体，怎么跑到 DLC 里去了」。
- **本地对账**（`App.localScanFiles` + `App.localFileApply`，详情页与「重新扫描磁盘状态」共用）：
  只读顶层文件名 —— `FS.host.scan(dir, 1)`，**传 0 等于整树递归**（后端 `maxDepth<=0` 时 limit=Infinity）。
  对账结果：磁盘上没有的额外文件从记录里删掉；多出来的文件登记进 `extraFiles`（`note:'扫描补充'`）；
  **本体缺失只汇报、不删记录**（要靠它提示「本体缺失」并快速补回）。`isImageFileName` 命中的图片一律不参与
  （封面 / 预览图不是素材文件，删一张也不该报缺失）。读不到目录（`no-path` / `offline` / `missing-dir`）时
  **绝不落库**，否则一次失败扫描会被当成「文件都没了」写进库。
- **拖动条目改判本体 / DLC**：本地页每一行 `draggable`，整个 `.local-group-box` 是放置区（`.drop-ok` 虚线高亮）。
  归本体 = 从 `extraFiles` 摘掉 + 补进 `downloadedFiles`（判据③）；归 DLC = 写 `extraFiles`（`note:'手动归为 DLC'`）。
  **不要为了归 DLC 去删 `downloadedFiles`**：那是「这个文件下载过」的事实，删了下载按钮会变回「下载」，
  而分类只看 `extraFiles` 的优先级，留着不会让分类回弹。拖到同一组不触发任何改动。
- **本体缺失与快速补充**：打开详情就静默对账一次（`save:false`，只更新界面），缺失清单挂在两个切页**之上**
  （`.local-miss-box`），停在「链接」页也看得见；点「快速补充本体文件」选一个文件就 `FS.host.copy` 进素材目录
  （同名已存在则不复制），写回该版本的 `fileName`，并把旧名字从 `downloadedFiles` 摘掉（否则下次还报同一个缺失）。
  缺失超过 1 个时先弹窗逐条列（`local-fill-row`），别直接弹系统选文件框。
- **缺失记录可以手动移除**（`renderMissing` 每行尾的「移除记录」+ 多条时的「全部移除记录」）：
  `stripFileRecord(names)` 把这个名字从 `versions[].fileName` / `versions[].files` / `downloadedFiles` / `extraFiles`
  里一起摘掉（**只改库，不碰磁盘**，这些文件本来就找不到了）。`local:true` 的版本本身就是一个文件，
  记录摘空后整条版本一起收掉，并把剩下的最后一个本地版本顶成 `isLatest`。
  先 `Modal.confirm` 再改库：这是删记录，不是删文件，文案必须说清「不会删除任何文件」。
  改完 `App.save` + `Modals.refreshAfterChange(a,{keepModal:true})` 原地重建详情，缺失提示随之消失。
  自测：`node runtime/regress14.js`（61 项，含确认框、取消回滚、单条 / 全部移除、空本地版本收掉）。
  `重新解析` 除了刷新链接，也会先跑一遍这套对账并把结果并进同一条 Toast。
- **本地文件可以就地删掉**（`renderLocal` 的 `row()` 行尾「删除」→ `deleteLocalFile`）：
  拖错 / 下错 / 被当成 DLC 的文件，用户不需要去资源管理器翻目录。两道闸：先 `Modal.confirm`
  （写明文件名、完整路径、会进回收站），再走 `FS.host.trash`（后端 `/api/trash` → `shell.trashItem`，
  **能还原**）；回收站不可用（网页载体 / 系统拒绝）时**再问一次**才 `FS.host.remove` 永久删，
  绝不默默永久删。删完 `stripFileRecord([name])` 摘掉版本 / 下载记录 / `extraFiles`，
  按文件大小减 `a.fileSize`，再 `App.save` + `Modals.refreshAfterChange(…, {keepModal:true})`：
  不摘记录的话下次扫描会报「本体缺失」。只碰这一个文件，素材记录和目录里其它文件都不动。
  行里已经有「显示 + 删除」两个按钮，`flex-wrap:nowrap` 别改（否则名字一长按钮就掉行）。
  自测：`node runtime/regress18.js`（20 项，含取消不动、DLC 删除、本体删除不留缺失提示）。
- **拖文件到卡片 = 放进这一条素材**（`89-pack.js` 的 `cardOf`/`markCard` → `DropImport.openIntoCard`）：
  悬停时整张卡压一层遮罩（`.card-drop-mask`：主色调 + 压暗，白色虚线框，图标 + 「放进这条素材」+ 素材名 + 去向提示），
  卡片再加 3px 主色描边和外发光。**别退回「只描边 + 一个小标签」**：封面偏亮的卡片根本看不出高亮，
  用户会以为拖到卡片和拖到空白处是同一件事。遮罩不铺整屏（那是拖到空白处的提示），且 `pointer-events: none`。
  松手弹窗让用户选两组东西：
  `这批文件怎么算` → `作为附加文件`（只放进目录，不动版本）/ `作为新版本`（登记 `versions[]`）/ `设为封面`（仅全是图片时才给，且不复制原图）；
  **默认去向按「这条素材有没有本体」判**（`App.localBaseEntries(asset).length`）：一个本体都没有 → 默认 `作为新版本`
  （不然拖进来的本体立刻被算成 DLC，用户看到的就是「导入的新文件默认跑去了 DLC」）；已有本体 → 默认仍是 `作为附加文件`。
  `文件怎么放` → `复制（保留原文件）` / `移动`，默认跟 `App.settings.importMoveInsteadOfCopy`，选「设为封面」时整块隐藏
  （换封面不动文件）。头部那句说明必须跟着切换（复制 vs 移动），别写死。
  三条边界：
  1. **只有在弹窗全都关掉时才接管**（`modalBlocked()`）；详情页开着时拖背景卡片仍走「先关窗口」提示。
  2. 图片拖到 `.card-cover` / `.detail-cover` 仍然直接设为封面（旧行为优先于新弹窗），不要抢。
  3. `.vrcpack` 拖到卡片上要拦下并提示拖到空白处，不能把整包塞进单条素材。
  落盘走 `Importer.ensureStoragePathQuiet` 取目录 + `FS.host.copy`（选「移动」时 `FS.host.move`，跨盘由后端退化成复制 + 删源），
  重名自动 `_2`（`freeName`），绝不覆盖。「附加文件」把文件名记进 `extraFiles`（`note:'拖进卡片' / '移动进卡片'`），
  否则详情页「本地文件」分不出这条 DLC 是登记过的还是陌生文件。
  「新版本」写的 `versions[]` 条目要带 `local: true` —— 它没有 `orderUrl`，不加这个标记会被详情页当成
  「未购买变体」灰色列出来；`unpurchasedVer` 的过滤条件里也有它。自测：`node runtime/regress11.js`（33 项）。

## 导入时从名字里认商品编号

下载站的落地命名常常就把商品号写在名字里（`[5058951]-オフショル…`、`(5058951) xxx`、`5058951_xxx`、
整个名字就是 `5058951`）。**编号能认出来就别让用户再粘一遍链接。**

- 解析函数只有一个：`10-util.js` 的 `boothIdFromName(name)`。只认 **5~9 位纯数字**，且
  `^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$` 这种 8 位日期要排除
  （`20240101` 是「上架日期」味的目录名）。4 位年份、带小数点的版本号、10 位长串都不认；
  **编号出现在名字中间（`衣装 5058951`）不猜** —— 宁可让用户自己填，也别把版本号当商品号去请求。
- 两条导入路径都把它存成候选的 `guessItemId`：
  `86-import.js` 的 `buildCandidate`（文件夹导入）、`89b-drop-import.js` 的 `groupItems`（拖拽整包导入）。
  列表里显示 `chip-ok`「商品 ID xxx（导入后自动解析）」，用户改标题时若出现新编号会跟着重算。
  别重绘整个列表去更新这枚 chip —— 输入框会失焦。
- 写库时：`itemId = guessItemId`、`source = 'booth'`、`links` 补 `https://booth.pm/ja/items/<id>`。
  **有 `.url` 里的商店链接时以链接为准**（可能是 Gumroad），不要拿名字里的数字盖掉它。
- 导入完成后跑 `Importer.autoParseBoothById(asset, id)`：`Fetchers.fetchInfoTimed` 抓商品页，
  合并走 `Tools.applyShopInfo`（与「更新商品信息」同一套字段规则：标题只在为空时填、标签图集只增不减）。
  三条硬约束：
  1. **抓回来的 `info.itemId` 与目标编号不一致 → 一个字都不写**（编号写错时页面可能是别的商品，
     写进去等于把这条素材变成另一个商品）；
  2. 404 / 网络失败 → 只记一行日志，**绝不 reject**（导入不能因为联网失败变红）；
  3. 串行 + 每项 1.2~1.8 秒随机间隔（`parseGapWait`），一次导入几十项也不会把站点打成爬虫。
- 总开关 `App.settings.autoParseOnImport`（默认开），设置页「本地库与整理」里可关；
  关掉后只登记编号、不发请求。拖拽导入关窗（`state.abortParse`）后不再跑剩下的项。
- `versionless()` 会把 `[5058951]` 当成版本号括注拿掉，标题因此变成 `-オフショル…`；
  `cleanTitle()` 里清掉开头残留的分隔符（`^[\s\-–—_·]+`）。**`versionless` 是归组用的，别动它。**
- 自测：`node runtime/regress19.js`（34 项，含名称解析的正反例、两条导入路径的候选、mock 联网后的
  合并 / 不匹配 / 404 / 失败 / 关开关，以及一条端到端的拖拽导入）。

## 卡片上的两行小标签

- **角色 chip 按宽度预算放，不靠 flex 压缩**（`50-app.js` 的 `cardOf`）：`wpx()` 按「全角 11px / 半角 6px +
  左右内边距 18」估每枚 chip 的宽度，卡片内宽按 `cardSize` 取（s 140 / m 198 / l 266），
  能完整放下几枚就放几枚（上限 4），放不下的折成 `+N`，**还给 +N 预留宽度**。
  以前固定塞 4 枚 + `+N`：名字一长，`.chip` 的 `overflow:hidden` 让 flex 把每枚压成「威…」，
  末尾的 `+N` 还会被卡片右边裁掉（用户截图就是这个）。CSS 侧 `.card-avatars .chip-av` 用
  `flex: 0 0 auto`，只保留「单个超长名字」的省略号兜底，不再允许压缩。
- 标签行（`.card-tags`）是另一套规则：最多 3 枚（>3 时 2 枚 + `+N`），单枚 `max-width: 42%` 省略号，
  `+N` 用 `flex: 0 0 auto`。两行都别改成换行 —— 卡片高度会跳，一屏容量跟着乱。
  自测：`node runtime/regress15.js`。
- **卡片封面上不再挂「上架日期」**（原来右下角那枚 `.cover-date` 已删）：小卡片空间本来就紧，日期只是噪声。
  `publishedAt` 仍然完整保留 —— 详情页「商品信息」里显示、编辑表单里可改、排序（`published_desc/asc`）与
  导出列（`40-fs.js` 的表头）都还在。别把数据字段一起删了。

## 详情页标题可就地改名

- `70-forms.js` 的 `detail-title-edit`：点标题 → 换成 `input.detail-title-input`，回车/失焦保存，
  Esc 取消（`stopPropagation`，别让 Esc 冒泡把弹窗一起关了）。存的是**素材名字 `a.title`**，
  `a.originalTitle`（商店原标题）永远不动。
- **必须传副本给 `App.save`**（`Object.assign({}, a, {title:v})`）：`App.save` 靠
  `old.folderName !== new.folderName` 决定要不要重命名磁盘目录、以及查不查重名。
  直接改 `a` 再存时新旧是同一个对象，比对永远相等 —— 目录不会改名，重名也拦不住。
  重名会 reject（「已存在同名素材」），失败时把界面文字还原。

## 分类 / 改名必须让磁盘文件夹跟着走

一条素材的磁盘位置永远是「`库根\分类\文件夹名`」，**分类变了、标题变了，文件夹必须一起搬**。
以前只有编辑页保存才顺手搬一次，解析并补充 / 批量更新商品信息这些入口直接在库里那条对象上改字段，
`App.save` 比不出新旧差异 —— 结果是「分类换了，文件还在老目录」，而写封面时后端又按记录里的旧路径
`mkdirp` 出一个只有封面图的空壳目录（后端 `writeFile` 会给父目录兜底建目录，空壳就是这么来的）。

- **`App.save(asset, { prev })`**：调用方在**库里那条对象**上改字段时（详情页 `applyInfo`、
  `Tools.bulkRefreshInfo`），必须把改动前的副本当 `prev` 传进来。不传时 `old === a`，
  `prepareFolderForSave` 看不到任何差异，目录不会动。改动前的副本在**改动之前**取
  （`JSON.parse(JSON.stringify(a))`），别在 apply 之后再拍。
- `App.save` 保存前跑 `App.prepareFolderForSave(a, old)`，两步：
  1. `reconcileStoragePath`：快照里的存储路径在磁盘上不存在、而库里登记的那条还在 → 以磁盘为准，
     把路径恢复成库里的，并按「文件实际待在哪个分类目录」把 `category` 一起修正回来。
     纠回来之后**跳过**搬目录（这次拿的是过期快照，照它的标题搬会把真目录改成旧名字）。
  2. `moveFolderForSave`：标题 / 角色名 / 分类任一变了 → 用一次 `FS.renameAssetFolder(..., dstAbs)`
     搬到 `库根\新分类\新名字`（改名 + 换分类合并成一次移动）。库外登记的路径只在原地改名。
     只换分类时**保留磁盘上的真实目录名**（可能是 `pickFreeFolderName` 给的 `名字_2`）。
     名字撞车仍然 reject（`err.fatal`，`prepareFolderForSave` 不吞它）。
- **别把 `App.assets[i]` 换成新对象**：`App.save` 改成 `Object.assign(live, saved)` 就地更新。
  详情页 / 编辑表单 / 批量条都拿着这条引用，换对象会让它们继续保存旧快照（路径被打回、分类被改写）。
  同理，调用方传的是副本时也要 `Object.assign(asset, saved)` 同步回去。
- **`saveCoverToPath` 的 `create:false` 现在会先确认目录存在**：不在了就什么都不写。
  后端的写文件会顺手建父目录，路径一旦是「过期快照里的旧位置」，就会在那边长出一个只装着封面的空壳文件夹。
- **`ensureStoragePathQuiet` 会先把目录认回来**：记录里的存储路径不存在时，按 `folderName` 在
  各分类目录里找真目录（当前分类优先），找到就改记录、用它；找不到才按原行为创建。
- **`App.runCategoryCleanup`（设置 → 按分类整理素材目录）在目标已存在时改成「把记录指过去」**：
  `FS.host.move` 拒绝覆盖目标，以前这里直接算失败。现在只要目标目录不属于别的素材，就把这条素材的
  存储路径改写过去（`res.repointed` 计数），既不删也不合并别人的目录。
  已经坏掉的记录（旧位置只剩封面、真目录在正确分类下）用这个工具就能修回来。
- 自测：`node runtime/regress17.js [port]`（26 项，含换分类搬目录、过期快照、就地改名、
  路径失而复得、空壳封面、按分类整理重指、以及详情页「解析并补充 → 应用」的整条界面流程）。
  它需要一个库根指向测试目录的副本实例，别对真库跑。

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

## 每页张数 = 一屏能放几张

- `UI.fitGrid`（`50-app.js`，在 `renderGrid` 画完后调）**逐张量卡片下沿落在哪**，
  完整落在可视区里的留下，第一张探出可视区的卡以及它后面的卡一起翻到下一页；
  结果写进 `App.fitPageSize`，`App.pageSizeFor()` 优先用它。
- 不按「行」估算：同一行被最高那张卡撑高，一屏常剩大半行，整行推到下一页底部就空一大片
  （用户原话「卡片没塞满」）。按实测位置切，那点余量能再放一排就再放一排。
- **只有「超出部分 > 卡高的 80%」才翻页**：`TOL = 0.8 × 行高`（行高取最后一排里最高的那张），
  也就是「还露得出卡高的 20% 就留在本页」。旧规则是 `min(0.35 × 行高, 56)`，卡的尺寸一大
  容忍度就只剩几十像素，底部于是总空掉一整排（用户原话「这个页面还是空了好多」）。
  现在底部哪怕只剩小半个卡高，也把下一排画出来 —— 代价是最后一排会被视口 / 分页条切掉一截，
  这一截滚一下就能看全，比空着强。实测：7 列 × 卡高 215 的窗口，30 项从 3 页变 2 页。
- 探出去时给 `body` 挂 `pager-overflow`（`UI.syncPagerOverflow`），把分页条从半透明改成实心 ——
  否则半透明胶囊压在半张卡上，卡片会从底下透出来，看着像渲染坏了。
- 每页张数**不必是列数的整数倍**（最后一行可以不满）。只有整行空白才是问题。
- 反方向要能长回来：窗口拉高 / 列数变多 / 卡片变小后，旧张数会明显少于一屏，
  所以「一页画满且全都放得下」时按实测行高再补整数行。**估算和实测必须用同一个 `TOL`**，
  否则估少一排、底部照样空。估算踩空（新增那排的卡比上一排高）时靠 `UI._fitReject` 记住那个张数，
  同一种窗口尺寸下不再试 —— 不记就会在「加一排 / 退回去」之间每帧重绘。窗口/列数/视图/卡片尺寸变了即作废。
- **不满一页的时候（最后一页）放得下就别改**：拿不满的一页去量容量，量出来永远等于已画张数，
  会把 `fitPageSize` 越算越小。只有真的溢出才收一下。
- 分页条是 `position: fixed`：只有 `body.has-pager`（页数 > 1）时 `.main` 才加 72px 底部留白；
  单页时不留，否则平白多出一截空白。`.grid` 上**不要**再加 `padding-bottom`（会和 `.main` 的重复）。
- **分页条居中在卡片区，不是窗口**：左边还有页签栏 + 侧栏，`left: 50%` 会明显偏左。
  `UI.syncPagerX()` 把 `.main` 中心写进 `--pager-x`（fixed 只能吃视口坐标，写不成 calc），
  `renderPager` 里调一次，另用 `ResizeObserver` 盯 `.main` —— 侧栏收放是 220ms 的 CSS 过渡，
  中途不触发 resize 也不重绘，靠它每帧跟一下。
- 「要不要给分页条留位置」用「不留时够不够装下全部」来判：装得下就单页、不留白；
  装不下才改用「让出 72px」再量一次。这样不会在两个结果之间来回横跳（会死循环重绘）。
- 换每页张数时按 offset 换算页码（`floor(offset / size) + 1`），别甩回第一页。
- 列表视图不套用一屏容量（一行 92px，翻页比滚动更烦），`fitGrid` 直接把 `fitPageSize` 归零。
- 窗口高度变化也要重算：`90-main.js` 的 resize 只在列数或内容区高度差 ≥24px 时重绘。
  自测：`node runtime/regress12.js`（22 项，含「末卡至少露出 20%」「探出量 ≤ 卡高 80%」「底部余量小于一行」）。

## 性能这块的既有结论

- JS 不慢：`renderAll` 5.8–9.2ms，800 条素材时 6.2ms；滚动时主线程每帧约 1ms。
- 布局是「顶栏一行 + 内容区三列」的纵向 flex，滚动分别在 `.main` 与 `.sidebar` 内部。
  早期结论说内层滚动会卡死合成器，那是 `position: fixed` 的内层容器；flex 子项 + `overflow:auto`
  实测无长帧（24 次滚动手势最长掉帧 7ms）。真要改回去，先按 `runtime/scroll-bench-now.js` 量一遍。
- Electron 下不要给 `wheel` 注册 `{passive:false}`：那会把每一帧滚动的提交权从合成器抢回主线程。
- `vrcasset://` 协议必须异步读盘，否则每张封面都在主线程等 I/O。
- 卡顿取证：`window.__jank` 记帧间隔与长任务，F9 呼出面板（也可用 `?debug=1` 启动即采）。
