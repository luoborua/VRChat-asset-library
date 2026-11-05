# VRChat 改模素材管理库

> 把硬盘里散落的改模素材收成一个能搜、能看封面的图库，需要的时候直接送进 Unity

下了一堆衣装、发型、配饰，文件名各写各的，过两个月就不知道哪个是哪个。这个程序干的就是这件事：把压缩包、文件夹、unitypackage 拖进来，配封面、分分类、打标签，以后按名字或者按角色找。

Windows 10 / 11 能跑，界面全中文，数据都放本地。看素材、扫目录、解析商品页都不会改动原文件，也不会碰 Unity 工程；只有导入、导出、删除这些操作会写盘，删除走系统回收站。

## 程序下载

编译好的程序在 [Releases](https://github.com/luoborua/VRChat-asset-library/releases)。`VRCLib.exe` 和同目录的 `WebView2Loader.dll` 要放在一起，只拷 exe 会一闪就退。

第一次启动会问数据放哪，建议别放 C 盘。之后在设置里指定素材库目录，导入的素材会按「分类 / 标题」建文件夹。

## 主要功能

- 卡片图库，列表用 400px 缩略图，点进详情才读原图
- 分类、标签、收藏、备注、集合；搜索支持模糊匹配，右侧筛选栏可以按分类、标签、来源、支持角色过滤
- 什么都能拖进窗口：zip、rar、7z、unitypackage、fbx、psd、整个文件夹。压缩包原样入库，不会自作主张解开
- 图片拖到卡片上就是封面，顺手在素材文件夹里留一份 `<文件夹名>.png`
- 商品信息可以粘贴 BOOTH 页面源码离线解析，也可以开联网自己抓，支持 BOOTH、Gumroad、Patreon
- 填个 DeepSeek 的 Key 就能一键翻译标签和简介，Key 加密存在本机，不进设置文件
- 下载队列带断点续传和重试，关掉程序也不丢
- 素材包导出成 `.vrcpack`，其实是标准 zip，对方没装这程序也能用 7-Zip 解开
- 改动工作台：登记 Unity 工程，导入素材，记下每条导入从哪来、落到哪、几个文件
- 五档主题，毛玻璃可以单独关

## 送进 Unity

先在「改动工作台」里添加工程。要选到同时有 `Assets`、`Packages`、`ProjectSettings` 的那一层，选错了会提示。

然后从素材库多选素材点「导入到 Unity」，或者直接把文件夹、压缩包拖到工作台。导入前会先检查一遍，不能导的会写明原因。

unitypackage 不自己解，是把请求交给 Unity，由它在官方导入窗口里处理。导完会按包内清单核对一遍，结果回到记录里。

同一份素材导第二遍时，如果检测到是它自己的旧版本，按钮会变成「替换旧版本并导入」，旧目录挪到回收站保留 30 天。撞的是别的素材就没办法了，只能自己去 Unity 里删。

导到一半关程序也不要紧，下次启动会问要不要接着导，已经拷过的文件跳过。

## 常见问题

**提示「路径重叠」**
素材目录和工程目录套在一起了，或者压缩包就放在工程里面。把素材挪到工程外面再导。

**提示「GUID 冲突」**
工程里已经有同 ID 的资源。如果那是这个素材的旧版本，点「替换旧版本并导入」；如果是别的素材，先去 Unity 里删掉旧的，或者换一个素材。

**导入后少了文件**
看任务条上的「注意：」，里面写了跳过了什么。常见的是文件名带 `?`、`:` 这类 Windows 不允许的字符。

**Packages 没导进去**
那是 Unity 的依赖目录，复制进 Assets 不生效，得用 VCC 装。程序只导 Assets 里的东西。

**太大的包导不动**
一次最多 2 万个文件，解压后不超过 8 GiB。

## 数据在哪

都在启动时选的那个数据目录里：

- `library.db` — 素材主库
- `covers\` — 封面和缩略图
- `workbench.json` — 工作台登记和导入记录
- `download-queue.json` — 下载队列
- `trash\` — 被替换掉的旧版本，保留 30 天

设置单独放在程序目录的 `vrclib-data\settings.json`，里面只有「数据放在哪」这类指针，跟着数据一起搬会导致下次找不到库。换机器或者做备份，拷数据目录就行。

Cookie 和 AI Key 加密存在 WebView 的 IndexedDB 里，不进设置文件，也不会被导出。

## 自己构建

需要 Rust 和 Tauri 2，环境要求写在 [`src-tauri/README.md`](src-tauri/README.md)。

```
powershell -File src-tauri/build/build-tauri.ps1                       日常构建
powershell -File src-tauri/build/build-tauri.ps1 -Configuration release  发布版，会做 LTO，体积小一点
```

脚本会把 exe 和 `WebView2Loader.dll` 复制到仓库根目录，双击 `VRCLib.exe` 就能跑。

改前端的时候不用重新编译，开一个窗口跑 `node scripts/dev-server.mjs`，另一个窗口设好 `VRCLIB_DEV_URL=http://127.0.0.1:8765` 再 `cargo run`，窗口里按 Ctrl+R 就能看到改动。

直接用 `cargo build` 也行，但 `tauri` 的 `custom-protocol` 特性必须开着（仓库里已经常开），否则出来的 exe 会去连开发服务器，双击只会看到「127.0.0.1 拒绝连接」。

## 反馈

用着有问题、导入报错、界面有瑕疵，去 [Issues](https://github.com/luoborua/VRChat-asset-library/issues) 提就行。附上素材文件名、Unity 版本和截图，好定位。别传付费素材和账号凭证。

## 许可

仓库暂时没附 LICENSE，默认保留所有权利。

Unity、VRChat、BOOTH、Gumroad、Patreon 这些名字属于各自的权利人，本项目跟它们没关系。素材和封面的版权归原作者。
