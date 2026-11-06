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

## 自己构建

需要 Rust 和 Tauri 2，环境要求写在 [`src-tauri/README.md`](src-tauri/README.md)。

```
powershell -File src-tauri/build/build-tauri.ps1                       日常构建
powershell -File src-tauri/build/build-tauri.ps1 -Configuration release  发布版，会做 LTO，体积小一点
```
