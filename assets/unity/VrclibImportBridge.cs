// VRChat改模素材管理库 —— Unity 侧导入助手（阶段 3：.unitypackage 直接导入）
//
// 这是桌面程序与 Unity 编辑器之间的「文件桥」：桌面程序把导入请求写进工程的
// Library/ 目录（Unity 不导入 Library），本助手在编辑器里轮询认领，调
// AssetDatabase.ImportPackage 弹出 Unity 官方导入窗口，把结果写回回执文件。
//
// 协议（全部位于 Library/VrclibBridge/ 下）：
//   Requests/<请求ID>.json            桌面程序写入的导入请求
//   Requests/<请求ID>.json.claimed    已被本助手认领（重命名即互斥锁）
//   Results/<请求ID>.json             本助手写回的回执
//   bridge.json                       本助手的心跳（每 5 秒覆盖一次）
//
// 请求（schema 1）：{ schema, id, project, package, sha256, bytes, allowOverwrite }
//   id      请求 ID（UUID v4），同时用作文件名
//   project 工程根目录绝对路径 —— 必须与当前工程一致，防止串工程
//   package .unitypackage 文件绝对路径
//   sha256  包文件 SHA-256（小写十六进制 64 位），认领时复算核对
//   bytes   包文件字节数（可缺省；给了就必须与实际文件一致）
//   allowOverwrite 是否允许覆盖工程里已存在的同 GUID 资源（缺省 false）
//
// 回执（schema 1）：{ schema, id, sha256, state, message, assets, assetsComplete,
//                    conflicts, overwrote, manifestComplete, package, packageBytes }
//   state：importing → completed / cancelled / failed / blocked
//   blocked：包内 GUID 与工程里已有资源冲突且未允许覆盖，本助手没有调用
//            ImportPackage；conflicts 最多列 100 条
//   assets：清单可用时按「导入后 GUID 仍指向包内路径」逐条核对的结果
//   overwrote：导入前就已存在、导入后仍指向同一路径的资源
//
// 安全边界：
//   · 不联网、不执行命令、不读协议目录与素材包以外的任何文件
//   · 路径拒绝 reparse point（符号链接 / 目录联接）
//   · sha256 不匹配即失败（预览之后包被替换过）
//   · 同一请求只处理一次：认领改名互斥 + 已有最终回执直接跳过
//   · 导入动作最终由人在 Unity 弹窗里确认，本助手不做静默写入
//
// 许可：GPL-3.0（随「VRChat改模素材管理库」整体开源）
//
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;

namespace VrcLib.Workbench
{
    [InitializeOnLoad]
    public static class PackageImportBridge
    {
        /* ---------------- 协议目录 ---------------- */

        static readonly string ProjectRoot =
            Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        static readonly string RequestsDir =
            Path.Combine(ProjectRoot, "Library", "VrclibBridge", "Requests");
        static readonly string ResultsDir =
            Path.Combine(ProjectRoot, "Library", "VrclibBridge", "Results");

        /* SessionState 键：包里的脚本会让 Unity 重编译，static 字段随之清空，
         * 进行中的任务必须存在 SessionState 里才能跨 domain reload 存活。 */
        /* 心跳协议版本：桌面程序核对它来判断工程里装的是不是旧版助手。
         * 改动回执 / 心跳结构时 +1，同时改 Rust 的 BRIDGE_PROTOCOL_VERSION。 */
        const int BridgeVersion = 2;

        const string KeyActive = "VrcLib.Bridge.Active.v1";
        const string KeyCapture = "VrcLib.Bridge.Capture.v1";

        /* 清单解析护栏（.unitypackage = gzip + tar） */
        const int ManifestMaxEntries = 50000;
        const long ManifestMaxBytes = 256L * 1024 * 1024;
        const int ManifestMaxPathBytes = 512;
        const int ManifestTimeoutMs = 5000;

        /* 看门狗：认领后超过这么久还停在 importing，就按中断收尾 */
        const long ImportWatchdogMinutes = 30;

        /* 请求与回执的字段名即 JSON 键名（JsonUtility 按字段名反序列化） */
        [Serializable] private class Request
        {
            public int schema;
            public string id;
            public string project;
            public string package;
            public string sha256;
            public long bytes;
            public bool allowOverwrite;
        }
        [Serializable] private class Conflict
        {
            public string guid;
            public string existingPath;
            public string packagePath;
        }
        [Serializable] private class Receipt
        {
            public int schema = 1;
            public string id;
            public string sha256;
            public string state;
            public string message;
            public string[] assets = new string[0];
            public bool assetsComplete;
            public Conflict[] conflicts = new Conflict[0];
            public string[] overwrote = new string[0];
            public bool manifestComplete;
            public string package;
            public long packageBytes;
        }
        /// 进行中任务（会整体存进 SessionState）
        [Serializable] private class Active
        {
            public Request request;          // 当前请求
            public string phase;             // importing / succeeded / cancelled / failed
            public string note;              // 失败原因等附注
            public string packageName;       // Started 回调里看到的包显示名
            public string phaseAt;           // 最近一次 phase 变化的 UTC ISO 时间
            public long claimedAtTicks;      // 认领时刻（UTC ticks，看门狗用）
            public long packageBytes;        // 认领时量到的包大小
            public bool manifestComplete;    // 包内清单是否解析成功
            public string[] manifestGuids;   // 清单 guid（与 manifestPaths 一一对应）
            public string[] manifestPaths;   // 清单里的资产路径
            public string[] preExistingGuids;// 导入前就已存在的资源（guid）
            public string[] preExistingPaths;// 与 preExistingGuids 对应
        }
        /// 导入路径捕获（也会存 SessionState）
        [Serializable] private class Capture
        {
            public bool open;            // 正在跟踪当前这次导入
            public bool known;           // 是否拿到了 Unity 上报的路径
            public bool complete;        // 路径列表是否完整（跨回调累计，超限截断则 false）
            public string[] paths;
        }

        static readonly Regex RxUuid =
            new Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                      RegexOptions.IgnoreCase);
        static readonly Regex RxSha =
            new Regex("^[0-9a-f]{64}$", RegexOptions.IgnoreCase);

        static Active active;
        // 取消检测：用户在 Unity 导入窗口里点取消时，Unity 不一定派发 importPackageCancelled，
        // 回执就会永远停在 importing，任务卡在「等待 Unity」。
        static bool sawImportWindow;
        static double importWindowClosedAt;
        static double importRequestedAt;
        static Capture capture;
        static double nextPoll;
        static double nextBeat;

        /* 按 id + 分钟去重的告警表（domain reload 后重置，够用） */
        static readonly Dictionary<string, long> WarnSeen =
            new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);

        /* ================================================================
         * 启动：挂钩子 → 恢复中断任务 → 扫描孤儿请求
         * ================================================================ */
        static PackageImportBridge()
        {
            AssetDatabase.importPackageStarted += OnStarted;
            AssetDatabase.importPackageCompleted += OnCompleted;
            AssetDatabase.importPackageCancelled += OnCancelled;
            AssetDatabase.importPackageFailed += OnFailed;
            AssetDatabase.onImportPackageItemsCompleted += OnItems;
            EditorApplication.update += Poll;

            try { RestoreActive(); } catch (Exception e) { Warn(e); }
            try { RecoverOrphans(); } catch (Exception e) { Warn(e); }
        }

        static void Warn(Exception e) { Debug.LogWarning("[素材库桥] " + (e == null ? "" : e.Message)); }

        /// 心跳：让桌面程序知道「助手还活着、在干什么」。
        /// 没有它，队列只能一律显示「请切到 Unity 窗口」，Unity 关了也照样等满 15 分钟。
        static void Heartbeat()
        {
            if (EditorApplication.timeSinceStartup < nextBeat) return;
            nextBeat = EditorApplication.timeSinceStartup + 5.0;
            try
            {
                string dir = Path.Combine(ProjectRoot, "Library", "VrclibBridge");
                Directory.CreateDirectory(dir);
                string id = (active != null && active.request != null) ? active.request.id : "";
                string phase = active == null ? "idle" : active.phase;
                string json = "{\"version\":" + BridgeVersion
                    + ",\"at\":\"" + UtcNowIso() + "\""
                    + ",\"active\":\"" + id + "\""
                    + ",\"phase\":\"" + phase + "\""
                    + ",\"editor\":\"" + Application.unityVersion + "\"}";

                string target = Path.Combine(dir, "bridge.json");
                string temp = Path.Combine(dir, "bridge.tmp");
                using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
                    writer.Write(json);
                if (File.Exists(target)) File.Replace(temp, target, null);
                else File.Move(temp, target);
            }
            catch (Exception e) { WarnOnce("heartbeat", e); }
        }

        /// 同一 id 一分钟内只记一条警告，避免每帧刷屏
        static void WarnOnce(string id, Exception e)
        {
            long minute = DateTime.UtcNow.Ticks / TimeSpan.TicksPerMinute;
            string key = string.IsNullOrEmpty(id) ? "?" : id;
            long seen;
            if (WarnSeen.TryGetValue(key, out seen) && seen == minute) return;
            if (WarnSeen.Count > 256) WarnSeen.Clear();
            WarnSeen[key] = minute;
            Debug.LogWarning("[素材库桥]" + (string.IsNullOrEmpty(id) ? "" : " " + id) + "："
                             + (e == null ? "" : e.Message));
        }

        static string UtcNowIso()
        {
            return DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
        }

        /* ---------------- 跨重编译恢复 ---------------- */

        static void RestoreActive()
        {
            string saved = SessionState.GetString(KeyActive, "");
            if (string.IsNullOrEmpty(saved)) return;

            Active restored = null;
            try { restored = JsonUtility.FromJson<Active>(saved); }
            catch (Exception) { return; }
            if (restored == null || restored.request == null) return;
            if (string.IsNullOrEmpty(restored.request.id) || !RxUuid.IsMatch(restored.request.id)) return;
            active = restored;

            string cap = SessionState.GetString(KeyCapture, "");
            if (!string.IsNullOrEmpty(cap) && cap.Length < 1048576)
            {
                Capture c = JsonUtility.FromJson<Capture>(cap);
                if (c != null) capture = c;
            }

            if (active.phase == "importing")
            {
                /* 导入途中被 domain reload 切断：不能接着等（会永远卡住），
                 * 立刻按清单核对能确认就收尾，否则记失败并说清结果未知。 */
                ResolveInterrupted(
                    "Unity 在导入过程中重新加载了脚本，导入结果未知，可能已部分写入，"
                    + "请在 Project 窗口核对后再决定是否重试。");
                return;
            }

            /* 重编译可能正好切在「事件已到、回执未写」的缝隙里 —— 补写 */
            if (IsFinal(active.phase)) FlushFinal();
        }

        /// 无法确定导入结果时的收尾：清单能全部验证就 completed，否则 failed
        static void ResolveInterrupted(string message)
        {
            if (active == null || active.request == null) return;
            var assets = new List<string>();
            bool verified = ManifestUsable() && VerifyEntries(active.manifestGuids, active.manifestPaths, assets);
            active.phase = verified ? "succeeded" : "failed";
            active.phaseAt = UtcNowIso();
            active.note = verified ? "脚本重新加载前导入已完成，已按包内清单核对。" : message;
            FlushFinal();
        }

        /// Unity 在导入中途被整个关掉：启动时把所有「已认领但没有最终回执」的请求标记为失败
        static void RecoverOrphans()
        {
            if (!Directory.Exists(RequestsDir)) return;
            foreach (string file in Directory.GetFiles(RequestsDir, "*.json.claimed"))
            {
                string fileId = RequestIdFromPath(file);
                try
                {
                    Request req = ReadRequest(file);
                    if (req == null) continue;
                    if (active != null && active.request != null && active.request.id == req.id) continue;
                    if (HasFinalReceipt(req.id)) { CleanupRequestFiles(req.id); continue; }

                    Receipt r = NewReceipt(req, "failed",
                        "Unity 在导入结束前被关闭。导入结果未知，请在 Project 窗口核对后再决定是否重试。");
                    r.packageBytes = FileLengthOrZero(req.package);
                    WriteReceiptJson(r);
                    CleanupRequestFiles(req.id);
                }
                catch (Exception e) { WarnOnce(fileId, e); }
            }
        }

        /* ================================================================
         * 轮询：认领请求 → 校验 → 冲突检查 → 交给 Unity
         * ================================================================ */
        static void Poll()
        {
            try
            {
                Heartbeat();
                Watchdog();
                DetectWindowCancel();

                if (active != null) return;
                if (Application.isBatchMode) return;
                if (EditorApplication.isPlayingOrWillChangePlaymode) return;
                if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
                if (EditorApplication.timeSinceStartup < nextPoll) return;
                nextPoll = EditorApplication.timeSinceStartup + 1.0;

                if (!Directory.Exists(RequestsDir)) return;
                string[] files = Directory.GetFiles(RequestsDir, "*.json");
                Array.Sort(files, StringComparer.Ordinal);
                foreach (string file in files)
                {
                    string id = RequestIdFromPath(file);
                    try { ProcessRequest(file); }
                    catch (Exception e) { WarnOnce(id, e); }
                    if (active != null) break;   // 一次只处理一个，导入是弹窗阻塞式的
                }
            }
            catch (Exception e) { WarnOnce(null, e); }
        }

        /// importing 超过 30 分钟：按中断收尾，避免 active 永久堵住后续请求
        static void Watchdog()
        {
            if (active == null || active.request == null) return;
            if (active.phase != "importing") return;
            if (active.claimedAtTicks <= 0) return;
            long elapsed = DateTime.UtcNow.Ticks - active.claimedAtTicks;
            if (elapsed <= ImportWatchdogMinutes * TimeSpan.TicksPerMinute) return;
            ResolveInterrupted(
                "Unity 导入超过 30 分钟仍未结束，已按中断处理。导入结果未知，可能已部分写入，"
                + "请在 Project 窗口核对后再决定是否重试。");
        }

        /// 当前是否还开着 Unity 的导入窗口（内部类名 PackageImport / ImportPackageWindow）
        static bool ImportWindowVisible()
        {
            EditorWindow[] wins = Resources.FindObjectsOfTypeAll<EditorWindow>();
            foreach (EditorWindow w in wins)
            {
                if (w == null) continue;
                string n = w.GetType().Name;
                if (n == "PackageImport" || n == "ImportPackageWindow") return true;
            }
            return false;
        }

        /// 窗口出现又消失、却没有终态事件时收尾：捕获到资源按清单核对，否则判定为取消。
        static void DetectWindowCancel()
        {
            if (active == null || active.request == null || active.phase != "importing")
            {
                sawImportWindow = false;
                importWindowClosedAt = 0;
                return;
            }
            if (EditorApplication.isCompiling) return;

            if (ImportWindowVisible())
            {
                sawImportWindow = true;
                importWindowClosedAt = 0;
                return;
            }
            if (!sawImportWindow)
            {
                /* 窗口都认不出来时的兜底：超过 90 秒没有任何导入事件，按取消收尾，
                   不让任务永远停在「等待 Unity」。 */
                if (importRequestedAt > 0
                    && EditorApplication.timeSinceStartup - importRequestedAt > 90.0)
                {
                    importRequestedAt = 0;
                    active.phase = "cancelled";
                    active.phaseAt = UtcNowIso();
                    active.note = "Unity 没有开始本次导入（常见原因：包内资源已全部存在），已按跳过处理。";
                    FlushFinal();
                }
                return;
            }
            if (importWindowClosedAt <= 0)
            {
                importWindowClosedAt = EditorApplication.timeSinceStartup;
                return;
            }
            if (EditorApplication.timeSinceStartup - importWindowClosedAt < 3.0) return;

            sawImportWindow = false;
            importWindowClosedAt = 0;

            bool hadAssets = capture != null && capture.paths != null && capture.paths.Length > 0;
            if (hadAssets)
            {
                ResolveInterrupted("导入窗口已关闭但没有收到完成事件，已按已捕获的资源清单核对。");
                return;
            }

            active.phase = "cancelled";
            active.phaseAt = UtcNowIso();
            active.note = "在 Unity 导入窗口里取消了导入，工程内容未改动。";
            FlushFinal();
        }
        static void ProcessRequest(string file)
        {
            Request req = ReadRequest(file);
            if (req == null) return;

            /* 已有最终回执的请求不再重复处理（应用端重发同一 ID 时保持幂等） */
            if (HasFinalReceipt(req.id)) { CleanupRequestFiles(req.id); return; }

            string claimed = file + ".claimed";
            try { File.Move(file, claimed); }
            catch (IOException) { return; }   // 撞上删除/改名，下一轮再看

            active = new Active
            {
                request = req,
                phase = "importing",
                phaseAt = UtcNowIso(),
                claimedAtTicks = DateTime.UtcNow.Ticks
            };
            capture = new Capture();

            try
            {
                SaveActive();
                /* 认领后再做完整校验：不合法也要留一份 failed 回执，别让请求卡在目录里 */
                string reason;
                if (!Valid(req, out reason)) { Fail(reason); return; }

                /* 复算 sha256：预览之后包被替换过就立即失败 */
                string actual = Sha256File(req.package);
                if (!string.Equals(actual, req.sha256, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("素材包与预检时不一致（sha256 不匹配）。");

                active.packageBytes = FileLengthOrZero(req.package);
                SaveActive();

                /* 清单解析失败只降级（manifestComplete=false，不做冲突拦截），不阻断导入 */
                string manifestError;
                List<(string guid, string pathname)> manifest = ReadManifest(req.package, out manifestError);
                if (manifest == null)
                {
                    Debug.LogWarning("[素材库桥] " + req.id + " 清单不可用：" + manifestError);
                    active.manifestComplete = false;
                }
                else
                {
                    active.manifestComplete = true;
                    active.manifestGuids = new string[manifest.Count];
                    active.manifestPaths = new string[manifest.Count];
                    for (int i = 0; i < manifest.Count; i++)
                    {
                        active.manifestGuids[i] = manifest[i].guid;
                        active.manifestPaths[i] = manifest[i].pathname;
                    }
                }

                if (manifest != null)
                {
                    List<Conflict> conflicts;
                    List<string> preGuids;
                    List<string> prePaths;
                    ScanManifest(manifest, req.allowOverwrite, out conflicts, out preGuids, out prePaths);
                    active.preExistingGuids = preGuids.ToArray();
                    active.preExistingPaths = prePaths.ToArray();
                    SaveActive();

                    if (conflicts.Count > 0)
                    {
                        BlockOnConflicts(req, conflicts);
                        return;   // blocked 已收尾，本请求到此为止
                    }

                    /* 包内每一条资源都已在工程里、路径也一致：Unity 只会弹
                       「Nothing to import!」，不会派发完成事件，回执永远悬空。
                       这里直接按「已跳过」收尾，连弹窗都不打开。 */
                    if (conflicts.Count == 0 && manifest.Count > 0 && preGuids.Count == manifest.Count)
                    {
                        active.phase = "succeeded";
                        active.phaseAt = UtcNowIso();
                        active.note = "包内资源已全部存在，本次未重复导入。";
                        FlushFinal();
                        return;
                    }
                }
                SaveActive();

                Receipt importing = NewReceipt(req, "importing", "等待在 Unity 弹窗里确认导入。");
                importing.manifestComplete = active.manifestComplete;
                importing.packageBytes = active.packageBytes;
                WriteReceiptJson(importing);

                sawImportWindow = false;
                importWindowClosedAt = 0;
                importRequestedAt = EditorApplication.timeSinceStartup;
                AssetDatabase.ImportPackage(req.package, true);
            }
            catch (Exception e)
            {
                if (active != null)
                {
                    active.phase = "failed";
                    active.phaseAt = UtcNowIso();
                    active.note = e.Message;
                    FlushFinal();
                }
            }
        }

        /// 清单可用时逐条比对工程里已有的 GUID，收集冲突与「导入前已存在」
        static void ScanManifest(List<(string guid, string pathname)> manifest, bool allowOverwrite,
                                 out List<Conflict> conflicts, out List<string> preGuids,
                                 out List<string> prePaths)
        {
            conflicts = new List<Conflict>();
            preGuids = new List<string>();
            prePaths = new List<string>();

            /* 包内同一 guid 出现两次本身就算冲突（existingPath 留空） */
            var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in manifest)
            {
                int n;
                counts.TryGetValue(entry.guid, out n);
                counts[entry.guid] = n + 1;
            }

            var duplicateReported = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in manifest)
            {
                if (counts[entry.guid] > 1)
                {
                    if (!allowOverwrite && duplicateReported.Add(entry.guid) && conflicts.Count < 100)
                        conflicts.Add(new Conflict
                        {
                            guid = entry.guid,
                            existingPath = "",
                            packagePath = entry.pathname
                        });
                    continue;
                }

                string existing;
                try { existing = AssetDatabase.GUIDToAssetPath(entry.guid); }
                catch (Exception) { existing = null; }
                if (string.IsNullOrEmpty(existing)) continue;   // 工程里没有 → 新增

                if (string.Equals(existing, entry.pathname, StringComparison.OrdinalIgnoreCase))
                {
                    preGuids.Add(entry.guid);
                    prePaths.Add(entry.pathname);
                }
                else if (!allowOverwrite && conflicts.Count < 100)
                {
                    conflicts.Add(new Conflict
                    {
                        guid = entry.guid,
                        existingPath = existing,
                        packagePath = entry.pathname
                    });
                }
            }
        }

        /// 有冲突且未允许覆盖：写 blocked 回执，不调用 ImportPackage，然后立刻清场
        static void BlockOnConflicts(Request req, List<Conflict> conflicts)
        {
            string message = "发现 " + conflicts.Count + " 个资源 GUID 与工程里已有资源冲突，已阻止导入。"
                             + "确认允许覆盖后可重新发起导入。";
            if (conflicts.Count >= 100) message += "（冲突只列出前 100 条，其余略。）";

            Receipt r = NewReceipt(req, "blocked", message);
            r.packageBytes = active == null ? 0 : active.packageBytes;
            r.manifestComplete = true;
            r.conflicts = conflicts.ToArray();

            string id = req.id;
            bool wrote = false;
            try { WriteReceiptJson(r); wrote = true; }
            catch (Exception e) { WarnOnce(id, e); }
            finally
            {
                ClearActiveState();
                /* 回执没写成时保留 .claimed，下次启动由 RecoverOrphans 补 failed */
                if (wrote) CleanupRequestFiles(id);
            }
        }

        static void Fail(string message)
        {
            if (active == null) return;
            active.phase = "failed";
            active.phaseAt = UtcNowIso();
            active.note = message;
            FlushFinal();
        }

        /* ================================================================
         * 导入事件跟踪
         * ================================================================ */

        /// Unity 报上来的 name 可能是完整路径也可能只是显示名，统一按「去扩展名的文件名」比对
        static bool MatchesPackage(string name)
        {
            if (active == null || active.request == null || string.IsNullOrEmpty(name)) return false;
            string incoming = NameKey(name);
            if (string.IsNullOrEmpty(incoming)) return false;
            if (!string.IsNullOrEmpty(active.packageName)
                && string.Equals(NameKey(active.packageName), incoming, StringComparison.OrdinalIgnoreCase))
                return true;
            return string.Equals(NameKey(active.request.package), incoming, StringComparison.OrdinalIgnoreCase);
        }
        static string NameKey(string path)
        {
            try
            {
                string file = Path.GetFileName(path);
                if (file.EndsWith(".unitypackage", StringComparison.OrdinalIgnoreCase))
                    file = file.Substring(0, file.Length - ".unitypackage".Length);
                return file;
            }
            catch (Exception) { return ""; }
        }

        static void OnStarted(string name)
        {
            if (active == null) return;
            if (MatchesPackage(name))
            {
                active.packageName = name;
                capture = new Capture { open = true };
                SaveActive();
            }
            else if (capture != null)
            {
                /* 用户在弹窗期间手动导入了别的包：items 回调没有包名，无法再归属，关闭捕获 */
                capture.open = false;
            }
        }

        static void OnItems(string[] items)
        {
            if (active == null || capture == null || !capture.open || items == null) return;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var paths = capture.known && capture.paths != null
                ? new List<string>(capture.paths) : new List<string>();
            foreach (string p in paths) seen.Add(p);
            bool batchComplete = items.Length <= 10000;
            int budget = 900000;
            for (int i = 0; i < Math.Min(items.Length, 10000); i++)
            {
                string item = items[i];
                if (!ValidAssetPath(item)) { batchComplete = false; continue; }
                if (!seen.Add(item)) continue;
                int cost = Encoding.UTF8.GetByteCount(item) * 2 + 3;
                if (budget - cost < 0) { batchComplete = false; break; }
                budget -= cost;
                paths.Add(item);
            }
            capture.paths = paths.ToArray();
            /* 跨回调累计：前一批已经截断过，后一批不能把「不完整」覆盖成「完整」 */
            capture.complete = capture.known ? (capture.complete && batchComplete) : batchComplete;
            capture.known = true;
            SaveCapture();
        }

        static void OnCompleted(string name)
        {
            if (active == null)
            {
                /* domain reload 把 active 丢了，但包确实导完了：扫描认领目录补回执 */
                try { CompleteOrphan(name); }
                catch (Exception e) { WarnOnce(null, e); }
                return;
            }
            if (!MatchesPackage(name)) return;
            active.phase = "succeeded";
            active.phaseAt = UtcNowIso();
            SaveActive();
            /* 部分 Unity 版本会在命名回调之后才派发 items 回调，延迟一帧再落盘 */
            EditorApplication.delayCall += FlushFinal;
        }

        /// active 丢失时按包名从 .json.claimed 里找回请求，读清单验证后补写回执
        static void CompleteOrphan(string name)
        {
            string incoming = NameKey(name);
            if (string.IsNullOrEmpty(incoming) || !Directory.Exists(RequestsDir)) return;
            foreach (string file in Directory.GetFiles(RequestsDir, "*.json.claimed"))
            {
                string fileId = RequestIdFromPath(file);
                try
                {
                    Request req = ReadRequest(file);
                    if (req == null) continue;
                    if (!string.Equals(NameKey(req.package), incoming, StringComparison.OrdinalIgnoreCase)) continue;
                    if (HasFinalReceipt(req.id)) { CleanupRequestFiles(req.id); continue; }

                    string manifestError;
                    List<(string guid, string pathname)> manifest = ReadManifest(req.package, out manifestError);
                    var assets = new List<string>();
                    bool verified = false;
                    if (manifest != null && manifest.Count > 0)
                    {
                        string[] guids = new string[manifest.Count];
                        string[] paths = new string[manifest.Count];
                        for (int i = 0; i < manifest.Count; i++)
                        {
                            guids[i] = manifest[i].guid;
                            paths[i] = manifest[i].pathname;
                        }
                        verified = VerifyEntries(guids, paths, assets);
                    }

                    Receipt r = NewReceipt(req, verified ? "completed" : "failed",
                        verified
                            ? "脚本重载后已按包内清单核对，导入已完成。"
                            : "Unity 在导入过程中重新加载了脚本，导入结果未知，可能已部分写入，"
                              + "请在 Project 窗口核对后再决定是否重试。");
                    r.packageBytes = FileLengthOrZero(req.package);
                    r.manifestComplete = manifest != null;
                    if (verified)
                    {
                        r.assets = assets.ToArray();
                        r.assetsComplete = true;
                    }
                    WriteReceiptJson(r);
                    CleanupRequestFiles(req.id);
                }
                catch (Exception e) { WarnOnce(fileId, e); }
            }
        }

        static void OnCancelled(string name)
        {
            if (!MatchesPackage(name)) return;
            if (active == null) return;
            active.phase = "cancelled";
            active.phaseAt = UtcNowIso();
            FlushFinal();
        }
        static void OnFailed(string name, string error)
        {
            if (!MatchesPackage(name)) return;
            if (active == null) return;
            active.phase = "failed";
            active.phaseAt = UtcNowIso();
            active.note = error;
            FlushFinal();
        }

        static bool IsFinal(string phase)
        {
            return phase == "succeeded" || phase == "cancelled" || phase == "failed";
        }

        static bool IsFinalState(string state)
        {
            return state == "completed" || state == "cancelled"
                || state == "failed" || state == "blocked";
        }

        /// 落盘最终回执并清空任务状态；回执写成功才删请求文件，写失败留给下次启动补 failed
        static void FlushFinal()
        {
            if (active == null || active.request == null || !IsFinal(active.phase)) return;
            Request req = active.request;
            bool wrote = false;
            try
            {
                string state = active.phase == "succeeded" ? "completed" : active.phase;
                Receipt r = NewReceipt(req, state, active.note);
                r.packageBytes = active.packageBytes;
                r.manifestComplete = active.manifestComplete;

                if (state == "completed")
                {
                    if (ManifestUsable())
                    {
                        /* 清单可用就以「导入后 GUID 指向」为准，比 items 回调可靠 */
                        var assets = new List<string>();
                        bool all = VerifyEntries(active.manifestGuids, active.manifestPaths, assets);
                        r.assets = assets.ToArray();
                        r.assetsComplete = all;
                        r.overwrote = ComputeOverwrote();
                        if (!all)
                            r.message = Append(r.message,
                                "包内清单里有资源没有落到预期路径，请在 Project 窗口核对。");
                    }
                    else if (capture != null && capture.known)
                    {
                        r.assets = capture.paths == null ? new string[0] : capture.paths;
                        r.assetsComplete = capture.complete;
                    }
                    else
                    {
                        r.message = Append(r.message,
                            "Unity 没有上报导入后的资源路径，请在 Project 窗口里自行确认位置。");
                    }
                }

                WriteReceiptJson(r);
                wrote = true;
            }
            catch (Exception e) { Warn(e); }
            finally
            {
                ClearActiveState();
                if (wrote) CleanupRequestFiles(req.id);
            }
        }

        /// 清单在 SessionState 重建后是否还能用来核对
        static bool ManifestUsable()
        {
            return active != null && active.manifestComplete
                && active.manifestGuids != null && active.manifestPaths != null
                && active.manifestGuids.Length > 0
                && active.manifestGuids.Length == active.manifestPaths.Length;
        }

        /// 逐条核对「GUID 现在指向的路径 == 包内路径」；全部命中才算验证通过
        static bool VerifyEntries(string[] guids, string[] paths, List<string> assets)
        {
            if (guids == null || paths == null || guids.Length != paths.Length || guids.Length == 0)
                return false;
            bool all = true;
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < guids.Length; i++)
            {
                string actual;
                try { actual = AssetDatabase.GUIDToAssetPath(guids[i]); }
                catch (Exception) { actual = null; }
                if (string.IsNullOrEmpty(actual)
                    || !string.Equals(actual, paths[i], StringComparison.OrdinalIgnoreCase))
                {
                    all = false;
                    continue;
                }
                if (assets != null && seen.Add(paths[i])) assets.Add(paths[i]);
            }
            return all;
        }

        /// overwrote = 导入前已存在、导入后仍指向同一路径的资源
        static string[] ComputeOverwrote()
        {
            var list = new List<string>();
            if (!ManifestUsable()
                || active.preExistingGuids == null || active.preExistingPaths == null)
                return list.ToArray();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            int n = Math.Min(active.preExistingGuids.Length, active.preExistingPaths.Length);
            for (int i = 0; i < n; i++)
            {
                string actual;
                try { actual = AssetDatabase.GUIDToAssetPath(active.preExistingGuids[i]); }
                catch (Exception) { actual = null; }
                if (string.Equals(actual, active.preExistingPaths[i], StringComparison.OrdinalIgnoreCase)
                    && seen.Add(active.preExistingPaths[i]))
                    list.Add(active.preExistingPaths[i]);
            }
            return list.ToArray();
        }

        static string Append(string message, string extra)
        {
            return string.IsNullOrEmpty(message) ? extra : message + " " + extra;
        }

        static void ClearActiveState()
        {
            active = null;
            capture = null;
            SessionState.EraseString(KeyActive);
            SessionState.EraseString(KeyCapture);
        }

        /* ================================================================
         * 清单解析（.unitypackage = gzip + tar）
         *
         * 只要 ./<guid>/pathname（内容是该资源的 Assets/ 相对路径）。
         * 文件夹型资产没有 <guid>/asset（只有 asset.meta + pathname），所以不能要求 asset 存在。
         * 任何异常、超限、格式错误都在本方法内部消化：返回 null 并写 error，绝不外抛。
         * ================================================================ */
        static List<(string guid, string pathname)> ReadManifest(string packagePath, out string error)
        {
            error = null;
            var entries = new List<(string guid, string pathname)>();
            var watch = System.Diagnostics.Stopwatch.StartNew();
            byte[] header = new byte[512];
            byte[] chunk = new byte[65536];
            long total = 0;
            int entryCount = 0;

            try
            {
                using (var file = new FileStream(packagePath, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (var gzip = new GZipStream(file, CompressionMode.Decompress))
                {
                    while (true)
                    {
                        if (!ReadBlock(gzip, header)) break;   // 读不到下一个块：正常结束
                        if (IsZeroBlock(header)) break;        // tar 结束标记

                        total += 512;
                        if (total > ManifestMaxBytes)
                            throw new InvalidDataException("素材包清单解压后超过 256 MiB。");
                        if (++entryCount > ManifestMaxEntries)
                            throw new InvalidDataException("素材包清单条目超过 50000 个。");
                        CheckManifestTime(watch);

                        char type = (char)header[156];
                        bool sizeOk;
                        long size = ParseTarOctal(header, 124, 12, out sizeOk);
                        if (!sizeOk || size < 0)
                            throw new InvalidDataException("素材包 tar 头里的长度字段不合法。");
                        long padded = size + ((512 - (size % 512)) % 512);

                        total += padded;
                        if (total > ManifestMaxBytes)
                            throw new InvalidDataException("素材包清单解压后超过 256 MiB。");

                        /* pax / GNU 扩展头直接跳过 */
                        if (type == 'x' || type == 'g' || type == 'L' || type == 'K')
                        {
                            SkipExact(gzip, padded, chunk, watch);
                            continue;
                        }

                        bool regular = type == '0' || type == '\0';
                        string guid;
                        string leaf;
                        if (regular && SplitManifestName(TarName(header), out guid, out leaf)
                            && leaf == "pathname")
                        {
                            if (size > ManifestMaxPathBytes)
                                throw new InvalidDataException("素材包里有超过 512 字节的资产路径。");
                            byte[] data = new byte[size];
                            if (size > 0 && !ReadExact(gzip, data, (int)size))
                                throw new EndOfStreamException("素材包清单意外结束。");
                            SkipExact(gzip, padded - size, chunk, watch);

                            string pathname = DecodeManifestPath(data);
                            if (!ValidAssetPath(pathname))
                                throw new InvalidDataException("素材包清单里的资产路径不合法：" + pathname);
                            entries.Add((guid, pathname));
                            continue;
                        }

                        SkipExact(gzip, padded, chunk, watch);
                    }
                }
            }
            catch (Exception e)
            {
                error = string.IsNullOrEmpty(e.Message) ? "读取素材包清单失败。" : e.Message;
                return null;
            }

            return entries;
        }

        /// 解析 tar 的八进制长度字段（偏移 124，12 字节）
        static long ParseTarOctal(byte[] block, int offset, int length, out bool ok)
        {
            ok = false;
            int i = offset;
            int end = offset + length;
            while (i < end && (block[i] == ' ' || block[i] == 0)) i++;
            if (i >= end) { ok = true; return 0; }   // 空字段按 0 处理
            long value = 0;
            for (; i < end; i++)
            {
                byte b = block[i];
                if (b == 0 || b == ' ') break;
                if (b < '0' || b > '7') { ok = false; return 0; }
                if (value > (long.MaxValue >> 3)) { ok = false; return 0; }
                value = (value << 3) + (b - '0');
            }
            ok = true;
            return value;
        }

        /// tar 条目名：ustar 的 prefix（偏移 345）拼在 name 前面
        static string TarName(byte[] header)
        {
            string name = ReadCString(header, 0, 100);
            bool ustar = header[257] == 'u' && header[258] == 's' && header[259] == 't'
                         && header[260] == 'a' && header[261] == 'r';
            if (ustar)
            {
                string prefix = ReadCString(header, 345, 155);
                if (prefix.Length > 0) name = prefix + "/" + name;
            }
            return name;
        }

        static string ReadCString(byte[] block, int offset, int length)
        {
            int end = offset;
            int limit = offset + length;
            while (end < limit && block[end] != 0) end++;
            return Encoding.UTF8.GetString(block, offset, end - offset);
        }

        /// 取 ./ 前缀与结尾 / 之后，判断是否 <32 位 hex>/<leaf>
        static bool SplitManifestName(string name, out string guid, out string leaf)
        {
            guid = null;
            leaf = null;
            if (string.IsNullOrEmpty(name)) return false;
            if (name.StartsWith("./", StringComparison.Ordinal)) name = name.Substring(2);
            if (name.EndsWith("/", StringComparison.Ordinal)) name = name.Substring(0, name.Length - 1);
            if (name.Length < 34 || name[32] != '/') return false;
            for (int i = 0; i < 32; i++) if (!IsHexChar(name[i])) return false;
            guid = name.Substring(0, 32);
            leaf = name.Substring(33);
            return true;
        }

        static bool IsHexChar(char c)
        {
            return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
        }

        static string DecodeManifestPath(byte[] data)
        {
            string path = Encoding.UTF8.GetString(data);
            if (path.Length > 0 && path[0] == '\uFEFF') path = path.Substring(1);
            return path.Trim();
        }

        static bool ReadBlock(Stream stream, byte[] block)
        {
            int read = 0;
            while (read < block.Length)
            {
                int n = stream.Read(block, read, block.Length - read);
                if (n <= 0)
                {
                    if (read == 0) return false;
                    throw new EndOfStreamException("素材包 tar 头不完整。");
                }
                read += n;
            }
            return true;
        }

        static bool ReadExact(Stream stream, byte[] buffer, int count)
        {
            int read = 0;
            while (read < count)
            {
                int n = stream.Read(buffer, read, count - read);
                if (n <= 0) return false;
                read += n;
            }
            return true;
        }

        static void SkipExact(Stream stream, long count, byte[] buffer,
                              System.Diagnostics.Stopwatch watch)
        {
            while (count > 0)
            {
                int piece = (int)Math.Min(buffer.Length, count);
                if (!ReadExact(stream, buffer, piece))
                    throw new EndOfStreamException("素材包清单意外结束。");
                count -= piece;
                CheckManifestTime(watch);
            }
        }

        static void CheckManifestTime(System.Diagnostics.Stopwatch watch)
        {
            if (watch.ElapsedMilliseconds > ManifestTimeoutMs)
                throw new TimeoutException("解析素材包清单超过 5 秒。");
        }

        static bool IsZeroBlock(byte[] block)
        {
            for (int i = 0; i < block.Length; i++) if (block[i] != 0) return false;
            return true;
        }

        /* ================================================================
         * 读写原语
         * ================================================================ */

        static void SaveActive()
        {
            if (active != null) SessionState.SetString(KeyActive, JsonUtility.ToJson(active));
        }
        static void SaveCapture()
        {
            if (active != null && capture != null)
                SessionState.SetString(KeyCapture, JsonUtility.ToJson(capture));
        }

        static string ReceiptPath(string id) { return Path.Combine(ResultsDir, id + ".json"); }

        static bool HasFinalReceipt(string id)
        {
            string path = ReceiptPath(id);
            if (!File.Exists(path)) return false;
            try
            {
                Receipt r = JsonUtility.FromJson<Receipt>(File.ReadAllText(path, Encoding.UTF8));
                return r != null && IsFinalState(r.state);
            }
            catch (Exception) { return false; }
        }

        static Receipt NewReceipt(Request req, string state, string message)
        {
            return new Receipt
            {
                schema = 1,
                id = req.id,
                sha256 = req.sha256,
                state = state,
                message = Clip(message, 2000),
                assets = new string[0],
                assetsComplete = false,
                conflicts = new Conflict[0],
                overwrote = new string[0],
                manifestComplete = false,
                package = req.package,
                packageBytes = 0
            };
        }

        static string Clip(string text, int max)
        {
            if (string.IsNullOrEmpty(text)) return "";
            return text.Length <= max ? text : text.Substring(0, max);
        }

        static long FileLengthOrZero(string path)
        {
            try
            {
                var info = new FileInfo(path);
                return info.Exists ? info.Length : 0;
            }
            catch (Exception) { return 0; }
        }

        static void WriteReceiptJson(Receipt receipt)
        {
            Directory.CreateDirectory(ResultsDir);
            string target = ReceiptPath(receipt.id);
            string temp = Path.Combine(ResultsDir, "w" + Guid.NewGuid().ToString("N").Substring(0, 12) + ".tmp");
            try
            {
                using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
                    writer.Write(JsonUtility.ToJson(receipt));
                if (File.Exists(target)) File.Replace(temp, target, null);
                else File.Move(temp, target);
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }

        /// 最终回执落盘后清掉请求文件，避免目录里留垃圾
        static void CleanupRequestFiles(string id)
        {
            if (string.IsNullOrEmpty(id) || !RxUuid.IsMatch(id)) return;
            TryDelete(Path.Combine(RequestsDir, id + ".json"));
            TryDelete(Path.Combine(RequestsDir, id + ".json.claimed"));
        }

        static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); }
            catch (Exception e) { WarnOnce("cleanup", e); }
        }

        /// 请求文件名 → 请求 ID（同时支持 .json 与 .json.claimed）
        static string RequestIdFromPath(string file)
        {
            string name = Path.GetFileName(file);
            if (name.EndsWith(".json.claimed", StringComparison.OrdinalIgnoreCase))
                return name.Substring(0, name.Length - ".json.claimed".Length);
            if (name.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                return name.Substring(0, name.Length - ".json".Length);
            return null;
        }

        /// 读请求（只做结构校验；完整校验在认领后做，好让失败也能落回执）
        static Request ReadRequest(string file)
        {
            RejectLinks(file, ProjectRoot);
            var info = new FileInfo(file);
            if (!info.Exists || info.Length > 65536) return null;
            Request req = JsonUtility.FromJson<Request>(File.ReadAllText(file, Encoding.UTF8));
            if (req == null) return null;
            if (req.schema != 1) return null;
            if (string.IsNullOrEmpty(req.id) || !RxUuid.IsMatch(req.id)) return null;
            /* 文件名必须就是请求 ID，防止目录里被塞改名文件 */
            string fileId = RequestIdFromPath(file);
            if (string.IsNullOrEmpty(fileId)
                || !string.Equals(fileId, req.id, StringComparison.OrdinalIgnoreCase))
                return null;
            return req;
        }

        static bool Valid(Request req, out string reason)
        {
            reason = null;
            if (req == null) { reason = "请求为空。"; return false; }
            if (req.schema != 1) { reason = "请求 schema 不是 1。"; return false; }
            if (string.IsNullOrEmpty(req.id) || !RxUuid.IsMatch(req.id))
            { reason = "请求 ID 不是合法的 UUID v4。"; return false; }
            if (string.IsNullOrEmpty(req.sha256) || !RxSha.IsMatch(req.sha256))
            { reason = "sha256 不是 64 位十六进制。"; return false; }
            if (string.IsNullOrEmpty(req.project))
            { reason = "请求缺少工程路径。"; return false; }

            string givenProject;
            try { givenProject = Path.GetFullPath(req.project); }
            catch (Exception) { reason = "工程路径不合法。"; return false; }
            if (!string.Equals(TrimRoot(givenProject), TrimRoot(ProjectRoot), StringComparison.OrdinalIgnoreCase))
            { reason = "请求的工程路径与当前工程不一致。"; return false; }

            return ValidPackage(req, out reason);
        }

        /// 包路径阶梯校验：拒绝 UNC/设备路径、系统目录、工程内部路径，并核对大小与 gzip 头
        static bool ValidPackage(Request req, out string reason)
        {
            reason = null;
            string raw = req.package;
            if (string.IsNullOrEmpty(raw) || !Path.IsPathRooted(raw))
            { reason = "素材包路径必须是绝对路径。"; return false; }
            if (!raw.EndsWith(".unitypackage", StringComparison.OrdinalIgnoreCase))
            { reason = "素材包不是 .unitypackage 文件。"; return false; }

            string full;
            try { full = Path.GetFullPath(raw); }
            catch (Exception) { reason = "素材包路径不合法。"; return false; }

            if (raw.StartsWith("\\\\", StringComparison.Ordinal)
                || raw.StartsWith("//", StringComparison.Ordinal)
                || full.StartsWith("\\\\", StringComparison.Ordinal))
            { reason = "拒绝 UNC 或设备路径形式的素材包。"; return false; }

            if (UnderAny(full, EnvDir("WINDIR"), EnvDir("SystemRoot"),
                         EnvDir("ProgramFiles"), EnvDir("ProgramFiles(x86)"), EnvDir("ProgramW6432")))
            { reason = "拒绝从系统目录或 Program Files 下导入素材包。"; return false; }

            if (UnderAny(full, ProjectRoot))
            { reason = "拒绝导入当前工程内部的素材包。"; return false; }

            var info = new FileInfo(full);
            if (!info.Exists) { reason = "素材包不存在或不可访问。"; return false; }
            if (info.Length > 4L * 1024 * 1024 * 1024)
            { reason = "素材包超过 4 GiB。"; return false; }
            if (req.bytes > 0 && req.bytes != info.Length)
            { reason = "请求记录的字节数与素材包实际大小不一致。"; return false; }

            try { RejectLinks(full, ProjectRoot); }
            catch (Exception e) { reason = e.Message; return false; }

            try
            {
                using (var stream = File.Open(full, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    int b0 = stream.ReadByte();
                    int b1 = stream.ReadByte();
                    if (b0 != 0x1f || b1 != 0x8b)
                    { reason = "素材包不是 gzip 压缩格式。"; return false; }
                }
            }
            catch (Exception e) { reason = "素材包无法读取：" + e.Message; return false; }

            req.package = full;   // 归一化，后续统一用绝对路径
            return true;
        }

        static string EnvDir(string name)
        {
            try { return Environment.GetEnvironmentVariable(name); }
            catch (Exception) { return null; }
        }

        static bool UnderAny(string full, params string[] dirs)
        {
            string f = TrimRoot(full);
            if (string.IsNullOrEmpty(f)) return false;
            foreach (string dir in dirs)
            {
                string d = TrimRoot(dir);
                if (string.IsNullOrEmpty(d)) continue;
                if (string.Equals(f, d, StringComparison.OrdinalIgnoreCase)) return true;
                if (f.StartsWith(d + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                    return true;
                if (f.StartsWith(d + Path.AltDirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return false;
        }

        static string TrimRoot(string path)
        {
            if (string.IsNullOrEmpty(path)) return "";
            return path.TrimEnd('\\', '/');
        }

        /// Unity 上报的导入路径必须是干净的 Assets/ 相对路径
        static bool ValidAssetPath(string item)
        {
            if (string.IsNullOrEmpty(item) || item.Length > 32760) return false;
            if (!item.StartsWith("Assets/", StringComparison.Ordinal)) return false;
            if (item.IndexOf(':') >= 0 || item.IndexOf('\\') >= 0) return false;
            foreach (char c in item) if (char.IsControl(c)) return false;
            foreach (string part in item.Split('/'))
                if (part.Length == 0 || part == "." || part == ".."
                    || part.EndsWith(".") || part.EndsWith(" ")) return false;
            return true;
        }

        /// 从文件到根，任何一级都不允许是 reparse point（符号链接 / 目录联接）。
        /// stopAt 非空时走到该目录就停，且不检查该目录本身 —— 工程本身在 junction 下
        /// 不应导致整棵树全盘拒绝；包文件到工程根之间的每一级仍然检查。
        static void RejectLinks(string path, string stopAt = null)
        {
            string stop = null;
            if (!string.IsNullOrEmpty(stopAt))
            {
                try { stop = TrimRoot(Path.GetFullPath(stopAt)); }
                catch (Exception) { stop = null; }
            }
            for (string cursor = Path.GetFullPath(path);
                 !string.IsNullOrEmpty(cursor);
                 cursor = Path.GetDirectoryName(cursor))
            {
                if (stop != null
                    && string.Equals(TrimRoot(cursor), stop, StringComparison.OrdinalIgnoreCase))
                    return;
                if ((File.Exists(cursor) || Directory.Exists(cursor))
                    && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("拒绝符号链接路径：" + cursor);
            }
        }

        static string Sha256File(string path)
        {
            RejectLinks(path, ProjectRoot);
            using (FileStream stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (SHA256 sha = SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }
    }
}
