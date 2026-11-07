# VRChat 改模素材管理库

> 把硬盘里散落的改模素材收成一个能搜、能看封面的图库，需要的时候直接送进 Unity

下了一堆衣装、发型、配饰，文件名各写各的，过两个月就不知道哪个是哪个。此程序的功能：把压缩包、文件夹、unitypackage 拖进来，配封面、分分类、打标签，以后按名字或者按角色找。

## 主要功能

- 分类、标签、收藏、备注、集合；搜索支持模糊匹配，右侧筛选栏可以按分类、标签、来源、支持角色过滤
- 什么都能拖进窗口：zip、rar、7z、unitypackage、fbx、psd、整个文件夹。
- 图片拖到卡片上就是封面，顺手在素材文件夹里留一份 `<文件夹名>.png`
- 商品信息可以粘贴 BOOTH 页面源码离线解析，也可以开联网自己抓，支持 BOOTH、Gumroad、Patreon
- 填个 DeepSeek 的 Key 就能一键翻译标签和简介，Key 加密存在本机，不进设置文件
- 下载队列带断点续传和重试，关掉程序也不丢
- 素材包导出成 `.vrcpack`，其实是标准 zip，对方没装这程序也能用 7-Zip 解开
- 改动工作台：登记 Unity 工程，导入素材，记下每条导入从哪来、落到哪、几个文件

## 数据在哪

都在启动时选的那个数据目录里：

- `library.db` — 素材主库
- `covers\` — 封面和缩略图
- `workbench.json` — 工作台登记和导入记录
- `download-queue.json` — 下载队列
- `trash\` — 被替换掉的旧版本，保留 30 天

## 怎么运行

双击 `启动素材库_Electron版.bat`。运行时已经放在 `electron/node_modules/electron/` 里，不需要单独装环境。

## 自己构建

边车（改模工作台的磁盘部分）需要 Rust 与 gnu 工具链：

```
cd host-sidecar
cargo +stable-x86_64-pc-windows-gnu build --release
copy target\release\vrclib-host.exe ..\host\vrclib-host.exe
```

本机默认的 MSVC 工具链会把 `link.exe` 解析成 Git 自带的 `link` 而报错，所以必须显式指定上面那个 toolchain。
前端不需要构建：Electron 直接从 `renderer/` 读文件，改完重启窗口即可。
