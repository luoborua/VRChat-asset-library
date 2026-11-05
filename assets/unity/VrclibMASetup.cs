// VRChat改模素材管理库 —— Unity 侧 MA 装配助手（阶段 4：Modular Avatar 自动装配）
//
// 与 PackageImportBridge 同住一个协议根（Library/VrclibBridge/），但职责不同：
//   导入桥负责「把 .unitypackage 弄进工程」（弹 Unity 官方窗口）；
//   本助手负责「导入之后把衣装预制件装配到角色上」（挂层级 + 可选显隐菜单）。
//
// 协议（全部位于 Library/VrclibBridge/ 下）：
//   MARequests/<请求ID>.json   桌面程序写入的装配请求
//   MAResults/<请求ID>.json    本助手写回的回执
//   MAState/<请求ID>.json      进行中日志（Unity 中途被杀后凭它判断「不许自动重放」）
//
// 请求（schema 1）：{ schema, id, sha256, project, sourceName, mode, importId, prefabPaths, assemble, menu }
//   id          请求 ID（UUID v4），同时用作文件名
//   sha256      素材身份（复制模式 = 文件清单签名；包模式 = 包文件哈希），回执必须一致
//   mode        "copy"（文件夹复制导入）或 "unitypackage"
//   importId    包模式下指向导入桥的请求 ID —— 装配必须等那次导入回执 completed
//   prefabPaths 复制模式下由桌面程序提供的 Assets/ 相对预制件路径
//   assemble    恒为 true（本助手只做装配）
//   menu        是否同时接入游戏内显隐菜单开关
//
// 回执（schema 1）：{ schema, id, sha256, state, message, avatarName, prefabPath, hierarchyPath, menuMode }
//   state：waiting-import → waiting-selection → applied / skipped / error
//
// 安全边界：
//   · 只改场景实例，永不保存场景、预制件资产、表情菜单或参数资产
//   · 所有场景改动包在一个 Undo 组里：一次撤销即可整体还原；失败自动回滚
//   · MA 与 VRChat SDK 全部通过反射访问，本文件不引用任何第三方命名空间，
//     缺依赖时报错退出而不是编译失败
//   · Unity 在装配中途被关掉：下次启动只标记 error，绝不自动重放（场景状态未知）
//
// 许可：GPL-3.0（随「VRChat改模素材管理库」整体开源）

using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace VrcLib.Workbench
{
    [InitializeOnLoad]
    public static class MASetup
    {
        /* ---------------- 协议目录与常量 ---------------- */

        static readonly string ProjectRoot =
            Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        static readonly string Root = Path.Combine(ProjectRoot, "Library", "VrclibBridge");

        /// MA 组件类型的程序集限定名前缀（反射用，不引编译期依赖）
        const string MaPrefix = "nadena.dev.modular_avatar.core.";
        const string AvatarDescriptorType = "VRC.SDK3.Avatars.Components.VRCAvatarDescriptor";
        const string MenuInstallerType = MaPrefix + "ModularAvatarMenuInstaller";
        const string MenuItemType = MaPrefix + "ModularAvatarMenuItem";
        const string ObjectToggleType = MaPrefix + "ModularAvatarObjectToggle";
        const string MergeArmatureType = MaPrefix + "ModularAvatarMergeArmature";
        const string BoneProxyType = MaPrefix + "ModularAvatarBoneProxy";
        const string ObjectReferenceType = MaPrefix + "AvatarObjectReference";
        const string SetupOutfitEditorType = MaPrefix + "editor.SetupOutfit";

        static readonly Regex RxUuid = new Regex(
            "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$",
            RegexOptions.IgnoreCase);
        static readonly Regex RxSha = new Regex("^[0-9a-f]{64}$", RegexOptions.IgnoreCase);

        /* ---------------- 数据结构（字段名 = JSON 键名） ---------------- */

        [Serializable] internal sealed class Request
        {
            public int schema;
            public string id, sha256, project, sourceName, mode, importId;
            public string[] prefabPaths;
            public bool assemble, menu;
        }
        [Serializable] private sealed class Receipt
        {
            public int schema = 1;
            public string id, sha256, state, message;
            public string avatarName, prefabPath, hierarchyPath, menuName, menuMode;
        }
        /// 进行中日志：只用来判断「Unity 是否死在装配半路」
        [Serializable] private sealed class Journal
        {
            public int schema = 1;
            public string id, sha256, phase;   // selection / applying / failed
        }

        static readonly List<Request> pending = new List<Request>();
        static double nextPoll;
        static string lastWarning;

        /* ================================================================
         * 启动与轮询
         * ================================================================ */
        static MASetup()
        {
            EditorApplication.update += Poll;
        }

        [MenuItem("Tools/素材库/MA 装配导入的预制件")]
        private static void OpenWindow()
        {
            RefreshRequests();
            SetupWindow.Open();
        }

        static void Poll()
        {
            if (EditorApplication.isCompiling || EditorApplication.isUpdating
                || EditorApplication.isPlayingOrWillChangePlaymode
                || EditorApplication.timeSinceStartup < nextPoll) return;
            nextPoll = EditorApplication.timeSinceStartup + 1.0;
            try
            {
                RefreshRequests();
                ProcessAutoAssembly();
            }
            catch (Exception e) { Warn(e); }
        }

        static void Warn(Exception e)
        {
            string message = "[素材库 MA] " + e.Message;
            if (lastWarning != message) Debug.LogWarning(message);
            lastWarning = message;
        }

        /// 读请求目录，刷新 pending 列表并维护状态回执
        static void RefreshRequests()
        {
            pending.Clear();
            string dir = Path.Combine(Root, "MARequests");
            NoLinks(dir);
            if (!Directory.Exists(dir)) return;

            foreach (string file in Directory.GetFiles(dir, "*.json").OrderBy(p => p, StringComparer.Ordinal))
            {
                try
                {
                    Request req = Read<Request>(file);
                    if (!Valid(req) || !string.Equals(
                            Path.GetFileNameWithoutExtension(file), req.id, StringComparison.OrdinalIgnoreCase))
                        continue;   // 无效请求：忽略（不写回执，留给人查日志）

                    Receipt receipt = CurrentReceipt(req);
                    if (IsFinal(receipt)) continue;   // 已了结的请求不再动

                    // 上次死在装配半路：只标记错误，不自动重放
                    Journal journal = CurrentJournal(req);
                    if (journal.phase == "applying")
                    {
                        WriteReceipt(req, "error",
                            "Unity 在装配过程中被中断。请先检查场景和撤销记录，再重新发起；不会自动重放。");
                        continue;
                    }

                    bool imported = Imported(req);
                    string state = imported ? "waiting-selection" : "waiting-import";
                    string message = imported ? SelectionStatus(req) : "等待对应的素材包导入完成。";
                    if (imported && string.IsNullOrEmpty(message))
                        message = "请在窗口里选择角色和预制件后应用。场景不会自动保存。";
                    if (receipt == null || receipt.state != state || receipt.message != message)
                        WriteReceipt(req, state, message);
                    pending.Add(req);

                    // 需要人工选择且没自动装配条件时，替用户把窗口打开（每个请求只提醒一次）
                    string announced = "VrcLib.MA.Announced." + req.id;
                    if (imported && !Application.isBatchMode && !SessionState.GetBool(announced, false)
                        && !CanAutoAssemble(req))
                    {
                        SessionState.SetBool(announced, true);
                        EditorApplication.delayCall += SetupWindow.Open;
                    }
                }
                catch (Exception e) { Warn(e); }
            }
        }

        /// 毫无歧义（唯一角色 + 唯一已知预制件 + 依赖齐全）时直接装配，不开窗
        static void ProcessAutoAssembly()
        {
            foreach (Request req in pending.ToArray())
            {
                if (!CanAutoAssemble(req)) continue;
                try
                {
                    GameObject avatar = AvatarChoices()[0];
                    GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(PrefabChoices(req)[0]);
                    ApplyAssembly(req, avatar, prefab);
                }
                catch (Exception e) { Warn(e); }
            }
        }

        /* ================================================================
         * 请求校验与状态
         * ================================================================ */

        static bool Valid(Request req)
        {
            try
            {
                return req != null && req.assemble && req.schema == 1
                    && req.id != null && RxUuid.IsMatch(req.id)
                    && req.sha256 != null && RxSha.IsMatch(req.sha256)
                    && !string.IsNullOrEmpty(req.project)
                    && string.Equals(Path.GetFullPath(req.project), ProjectRoot, StringComparison.OrdinalIgnoreCase)
                    && (req.mode == "copy" || req.mode == "unitypackage")
                    && req.sourceName != null && req.sourceName.Length <= 1000
                    && (req.mode != "unitypackage"
                        || (req.importId != null && RxUuid.IsMatch(req.importId)))
                    && req.prefabPaths != null && req.prefabPaths.Length <= 1000
                    && req.prefabPaths.All(ValidPrefabPath);
            }
            catch { return false; }
        }

        static bool ValidPrefabPath(string path)
        {
            if (string.IsNullOrEmpty(path) || path.Length > 2000
                || !path.StartsWith("Assets/", StringComparison.Ordinal)
                || !path.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase)
                || path.IndexOfAny(new[] { '\\', ':', '\0' }) >= 0) return false;
            string[] parts = path.Split('/');
            if (parts.Any(p => p.Length == 0 || p == "." || p == "..")) return false;
            string full = Path.GetFullPath(Path.Combine(ProjectRoot, path));
            return full.StartsWith(Path.Combine(ProjectRoot, "Assets") + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase);
        }

        /// 对应的素材是否已经进工程（复制模式天然完成；包模式看导入桥的回执）
        static bool Imported(Request req)
        {
            if (req.mode == "copy") return true;
            ImportReceipt r = Read<ImportReceipt>(Path.Combine(Root, "Results", req.importId + ".json"));
            return r != null && r.schema == 1 && r.id == req.importId
                && string.Equals(r.sha256, req.sha256, StringComparison.OrdinalIgnoreCase)
                && r.state == "completed";
        }

        /// 导入桥回执里我们关心的字段（跨类读取，避免整包反序列化）
        [Serializable] private sealed class ImportReceipt
        {
            public int schema;
            public string id, sha256, state;
            public string[] assets;
            public bool assetsComplete;
        }

        /// 本次导入批次的预制件候选
        static string[] PrefabChoices(Request req)
        {
            if (req.mode == "copy")
                return req.prefabPaths
                    .Where(p => AssetDatabase.LoadAssetAtPath<GameObject>(p) != null)
                    .Distinct(StringComparer.Ordinal).ToArray();
            ImportReceipt r = Read<ImportReceipt>(Path.Combine(Root, "Results", req.importId + ".json"));
            if (r == null || r.assets == null) return new string[0];
            return r.assets
                .Where(p => p != null
                    && p.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase)
                    && ValidPrefabPath(p)
                    && AssetDatabase.LoadAssetAtPath<GameObject>(p) != null)
                .Distinct(StringComparer.Ordinal).ToArray();
        }
        /// 批次清单是否可信（Unity 没上报或截断过 → 自动装配关闭，必须人工选）
        static bool BatchKnown(Request req)
        {
            if (req.mode == "copy") return req.prefabPaths.Length > 0;
            ImportReceipt r = Read<ImportReceipt>(Path.Combine(Root, "Results", req.importId + ".json"));
            return r != null && r.assets != null && (r.assetsComplete || r.assets.Length > 0);
        }

        /* ---------------- 依赖与场景状态 ---------------- */

        static Type FindType(string name)
        {
            foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type type = assembly.GetType(name, false);
                if (type != null) return type;
            }
            return null;
        }

        /// 装配 + 菜单两条链的依赖是否齐（空串 = 齐）
        static string DependencyStatus(Request req)
        {
            if (FindType(AvatarDescriptorType) == null)
                return "工程缺少 VRChat Avatars SDK，请先安装兼容版本。";
            bool assemblyMissing = FindType(MergeArmatureType) == null
                || FindType(BoneProxyType) == null
                || FindType(ObjectReferenceType) == null
                || SetupOutfitMethod() == null;
            if (assemblyMissing)
                return "Modular Avatar 装配组件缺失或版本不兼容，请安装兼容的 Modular Avatar。";
            if (req.menu)
            {
                bool menuMissing = FindType(MenuInstallerType) == null
                    || FindType(MenuItemType) == null
                    || FindType(ObjectToggleType) == null;
                if (menuMissing)
                    return "Modular Avatar 菜单组件缺失或版本不兼容，请安装兼容的 Modular Avatar。";
            }
            return "";
        }

        /// MA 公开的「设置服装」命令：SetupOutfit.SetupOutfitUI(GameObject)
        static MethodInfo SetupOutfitMethod()
        {
            Type type = FindType(SetupOutfitEditorType);
            MethodInfo method = type == null ? null : type.GetMethod(
                "SetupOutfitUI", BindingFlags.Public | BindingFlags.Static,
                null, new[] { typeof(GameObject) }, null);
            return method != null && method.ReturnType == typeof(void) ? method : null;
        }

        static bool IsSceneAvatar(GameObject avatar)
        {
            Type descriptor = FindType(AvatarDescriptorType);
            return descriptor != null && avatar != null
                && !EditorUtility.IsPersistent(avatar)
                && avatar.scene.IsValid() && avatar.scene.isLoaded
                && !EditorSceneManagerIsPreview(avatar)
                && avatar.GetComponent(descriptor) != null;
        }
        static bool EditorSceneManagerIsPreview(GameObject go)
        {
            // PrefabStageUtility.GetPrefabStage(go) != null 表示在预制件编辑模式里，不算场景实例
            var utility = FindType("UnityEditor.SceneManagement.PrefabStageUtility");
            if (utility == null) return false;
            MethodInfo get = utility.GetMethod("GetPrefabStage",
                BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(GameObject) }, null);
            object stage = get == null ? null : get.Invoke(null, new object[] { go });
            return stage != null;
        }

        /// 当前打开的场景里有多少个 VRChat 角色
        static GameObject[] AvatarChoices()
        {
            Type descriptor = FindType(AvatarDescriptorType);
            if (descriptor == null) return new GameObject[0];
            return Resources.FindObjectsOfTypeAll(descriptor).OfType<Component>()
                .Select(c => c.gameObject)
                .Where(IsSceneAvatar)
                .Distinct()
                .OrderBy(g => g.name, StringComparer.Ordinal)
                .ToArray();
        }

        static bool CanAutoAssemble(Request req)
        {
            if (!Imported(req) || !string.IsNullOrEmpty(DependencyStatus(req))) return false;
            if (AvatarChoices().Length != 1) return false;
            if (!BatchKnown(req)) return false;
            return PrefabChoices(req).Length == 1;
        }

        /// waiting-selection 阶段给人看的引导文案
        static string SelectionStatus(Request req)
        {
            string missing = DependencyStatus(req);
            if (!string.IsNullOrEmpty(missing)) return missing;
            GameObject[] avatars = AvatarChoices();
            if (avatars.Length == 0) return "场景里还没有 VRChat 角色。请先打开目标角色的场景，再刷新。";
            if (avatars.Length > 1) return "场景里有多个角色，请在窗口里选一个再装配。";
            if (!BatchKnown(req)) return "Unity 没有给出完整的预制件清单，请在窗口里手动选择。";
            string[] choices = PrefabChoices(req);
            if (choices.Length != 1)
                return "请选择要装配的预制件。尚未修改任何场景内容。";
            return "角色与预制件都唯一，将自动装配。一次撤销可整体还原；确认无误后请自行保存场景。";
        }

        /* ================================================================
         * 装配本体
         * ================================================================ */

        /// 校验实例上的 MA 绑定是否指向所选角色（MergeArmature / BoneProxy）
        static string BindingStatus(GameObject instance, GameObject avatar)
        {
            bool found = false;
            foreach (string pair in new[] { MergeArmatureType + "|mergeTargetObject", BoneProxyType + "|target" })
            {
                string[] parts = pair.Split('|');
                Type type = FindType(parts[0]);
                if (type == null) continue;
                foreach (Component component in instance.GetComponentsInChildren(type, true))
                {
                    Behaviour behaviour = component as Behaviour;
                    if (behaviour != null && !behaviour.enabled) continue;
                    object target = GetMember(component, parts[1]);
                    Transform transform = target is GameObject
                        ? ((GameObject)target).transform
                        : target as Transform;
                    if (transform == null || transform.gameObject.scene != avatar.scene
                        || !(transform == avatar.transform || transform.IsChildOf(avatar.transform))
                        || transform.IsChildOf(instance.transform))
                        return "“" + component.gameObject.name + "”上的 MA 绑定未指向所选角色，"
                            + "请检查其 Merge Armature 或 Bone Proxy 的目标。";
                    found = true;
                }
            }
            return found ? "" : "此预制件尚未确认与所选角色的 MA 绑定。";
        }

        /// 是不是一件「带骨骼的服装」（蒙皮网格 / 人形动画机 / Hips 骨）
        static bool HasOutfitSkeleton(GameObject instance)
        {
            return instance.GetComponentsInChildren<SkinnedMeshRenderer>(true)
                       .Any(r => r.bones != null && r.bones.Length > 0)
                || instance.GetComponentsInChildren<Animator>(true)
                       .Any(a => a.avatar != null && a.avatar.isHuman)
                || instance.GetComponentsInChildren<Transform>(true).Any(t => t != instance.transform
                    && (string.Equals(t.name, "Hips", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(t.name, "pelvis", StringComparison.OrdinalIgnoreCase)));
        }

        static void ApplyAssembly(Request req, GameObject avatar, GameObject prefab)
        {
            if (!Valid(req)) throw new InvalidOperationException("MA 装配请求无效。");
            if (IsFinal(CurrentReceipt(req))) return;
            if (!Imported(req)) throw new InvalidOperationException("对应的素材还没完成导入。");
            string dep = DependencyStatus(req);
            if (!string.IsNullOrEmpty(dep)) throw new InvalidOperationException(dep);
            if (!IsSceneAvatar(avatar)) throw new InvalidOperationException("请选择已打开场景中的 VRChat 角色。");
            string prefabPath = AssetDatabase.GetAssetPath(prefab);
            if (prefab == null || !EditorUtility.IsPersistent(prefab) || !ValidPrefabPath(prefabPath)
                || PrefabUtility.GetPrefabAssetType(prefab) == PrefabAssetType.NotAPrefab
                || AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath) != prefab)
                throw new InvalidOperationException("请选择 Assets/ 下的预制件资源，不能选场景实例。");
            NoLinks(Path.Combine(ProjectRoot, prefabPath));
            if (BatchKnown(req) && !PrefabChoices(req).Contains(prefabPath, StringComparer.Ordinal))
                throw new InvalidOperationException("请选择本次导入的预制件。");

            Journal journal = CurrentJournal(req);
            journal.phase = "applying";
            AtomicWrite(JournalPath(req.id), journal);

            Undo.IncrementCurrentGroup();
            int undoGroup = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName("素材库 MA 装配");
            try
            {
                // MA 的公开装配例程可能改到角色本身的既有属性，一并纳入撤销范围
                Undo.RegisterFullObjectHierarchyUndo(avatar, "素材库 MA 装配");
                GameObject instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab, avatar.transform);
                if (instance == null) throw new InvalidOperationException("Unity 无法实例化这个预制件。");
                Undo.RegisterCreatedObjectUndo(instance, "素材库 MA 装配");

                // 已有有效绑定 → 原样保留；没有且是骨骼服装 → 调 MA 的 Setup Outfit
                string binding = BindingStatus(instance, avatar);
                bool preserved = string.IsNullOrEmpty(binding);
                if (!preserved)
                {
                    if (!HasOutfitSkeleton(instance))
                        throw new InvalidOperationException(binding
                            + " 此预制件不是可识别的骨骼服装，请在 MA 里明确配置挂载方式。");
                    SetupOutfitMethod().Invoke(null, new object[] { instance });
                    binding = BindingStatus(instance, avatar);
                    if (!string.IsNullOrEmpty(binding))
                        throw new InvalidOperationException("MA 设置服装后仍未建立有效绑定。" + binding);
                }
                if (instance.transform.parent != avatar.transform)
                    throw new InvalidOperationException("MA 意外改变了预制件根的父级，已回滚本次装配。");

                // 可选：游戏内显隐菜单。作者已带 MA 菜单预设就保留，否则建一个开关
                string menuMode = null;
                if (req.menu)
                {
                    if (HasMenuPreset(prefab)) menuMode = "preserved";
                    else
                    {
                        GameObject group = new GameObject("素材库菜单 " + req.id.Substring(0, 8));
                        Undo.RegisterCreatedObjectUndo(group, "素材库 MA 装配");
                        group.transform.SetParent(avatar.transform, false);
                        CreateToggle(group, instance, req, prefab.name, instance.activeSelf);
                        menuMode = "created";
                    }
                }

                Undo.RecordObject(instance.transform, "放到角色层级最后");
                instance.transform.SetAsLastSibling();
                Undo.FlushUndoRecordObjects();
                Undo.CollapseUndoOperations(undoGroup);
                WriteReceipt(req, "applied", preserved
                    ? "预制件已装配为角色的最后一个直接子物体，保留其原有 MA 绑定。场景未保存；一次撤销可整体还原。"
                    : "MA 设置服装完成且绑定已核对，预制件位于角色层级最后。场景未保存；一次撤销可整体还原；适配与穿模请自行检查。",
                    avatar, prefabPath,
                    menuMode == "created" ? prefab.name : (menuMode == "preserved" ? "作者已有菜单" : null),
                    instance, menuMode);
                Selection.activeGameObject = instance;
            }
            catch (Exception exception)
            {
                Undo.RevertAllDownToGroup(undoGroup);
                journal.phase = "failed";
                Exception cause = exception is TargetInvocationException && exception.InnerException != null
                    ? exception.InnerException : exception;
                try
                {
                    AtomicWrite(JournalPath(req.id), journal);
                    WriteReceipt(req, "error", "装配已整体回滚：" + cause.Message);
                }
                catch (Exception writeError) { Warn(writeError); }
                throw new InvalidOperationException(cause.Message, cause);
            }
            finally { Undo.IncrementCurrentGroup(); }
            RefreshRequests();
        }

        /// 预制件里是否已带 MA 菜单组件（MenuItem / MenuInstaller）
        static bool HasMenuPreset(GameObject prefab)
        {
            Type item = FindType(MenuItemType), installer = FindType(MenuInstallerType);
            return (item != null && prefab.GetComponentsInChildren(item, true).Length != 0)
                || (installer != null && prefab.GetComponentsInChildren(installer, true).Length != 0);
        }

        /* ---------------- 反射工具 ---------------- */

        static object GetMember(object value, string name)
        {
            FieldInfo field = value.GetType().GetField(name);
            if (field != null) return field.GetValue(value);
            PropertyInfo property = value.GetType().GetProperty(name);
            if (property != null && property.CanRead) return property.GetValue(value, null);
            throw new InvalidOperationException("当前 MA 版本接口不兼容：" + name);
        }
        static void SetMember(object value, string name, object contents)
        {
            FieldInfo field = value.GetType().GetField(name);
            if (field != null) { field.SetValue(value, contents); return; }
            PropertyInfo property = value.GetType().GetProperty(name);
            if (property != null && property.CanWrite) { property.SetValue(value, contents, null); return; }
            throw new InvalidOperationException("当前 MA 版本接口不兼容：" + name);
        }
        static void SetEnum(object value, string member, string name)
        {
            FieldInfo field = value.GetType().GetField(member);
            PropertyInfo property = value.GetType().GetProperty(member);
            if (field == null && property == null)
                throw new InvalidOperationException("当前 MA 版本接口不兼容：" + member);
            Type type = field == null ? property.PropertyType : field.FieldType;
            SetMember(value, member, Enum.Parse(type, name));
        }

        /// 给衣装实例配一个游戏内显隐开关：
        /// 菜单组 → MenuItem(Toggle) + MenuInstaller + ObjectToggle(引用实例)
        static void CreateToggle(GameObject group, GameObject instance, Request req, string name, bool visible)
        {
            GameObject node = new GameObject(name);
            Undo.RegisterCreatedObjectUndo(node, "素材库 MA 菜单");
            node.transform.SetParent(group.transform, false);
            Undo.AddComponent(node, FindType(MenuInstallerType));
            Component item = Undo.AddComponent(node, FindType(MenuItemType));

            // MenuItem.Control 是 SDK 的 VRCExpressionsMenu.Control 结构体
            FieldInfo controlField = item.GetType().GetField("Control");
            if (controlField == null)
                throw new InvalidOperationException("当前 MA 版本未开放菜单控件接口。");
            object control = Activator.CreateInstance(controlField.FieldType);
            SetEnum(control, "type", "Toggle");
            SetMember(control, "name", name);
            SetMember(control, "value", 1f);
            FieldInfo parameterField = control.GetType().GetField("parameter");
            if (parameterField == null)
                throw new InvalidOperationException("当前 SDK 的菜单参数接口不兼容。");
            object parameter = Activator.CreateInstance(parameterField.FieldType);
            SetMember(parameter, "name", "VrcLibMenu_" + req.id.Replace("-", ""));
            SetMember(control, "parameter", parameter);
            SetMember(item, "Control", control);
            SetMember(item, "isDefault", visible);
            SetMember(item, "automaticValue", false);
            SetMember(item, "label", name);
            SetEnum(item, "MenuSource", "Children");

            // ObjectToggle.Objects：开关控制实例的显隐（开关放在角色根下，衣装被藏起来时开关仍可用）
            Component toggle = Undo.AddComponent(node, FindType(ObjectToggleType));
            IList objects = GetMember(toggle, "Objects") as IList;
            if (objects == null || !objects.GetType().IsGenericType)
                throw new InvalidOperationException("当前 MA 版本的 Object Toggle 接口不兼容。");
            object entry = Activator.CreateInstance(objects.GetType().GetGenericArguments()[0]);
            object reference = Activator.CreateInstance(FindType(ObjectReferenceType));
            MethodInfo set = reference.GetType().GetMethod("Set", new[] { typeof(GameObject) });
            if (set == null)
                throw new InvalidOperationException("当前 MA 版本无法引用导入的实例。");
            set.Invoke(reference, new object[] { instance });
            SetMember(entry, "Object", reference);
            SetMember(entry, "Active", true);
            objects.Add(entry);
            SetMember(toggle, "Objects", objects);

            Undo.RecordObject(instance, "设置导入物默认可见性");
            instance.SetActive(visible);
            PrefabUtility.RecordPrefabInstancePropertyModifications(instance);
            EditorUtility.SetDirty(item);
            EditorUtility.SetDirty(toggle);
        }

        /* ================================================================
         * 协议读写原语
         * ================================================================ */

        static string ReceiptPath(string id) { return Path.Combine(Root, "MAResults", id + ".json"); }
        static string JournalPath(string id) { return Path.Combine(Root, "MAState", id + ".json"); }

        static void NoLinks(string path)
        {
            for (string cursor = Path.GetFullPath(path);
                 !string.IsNullOrEmpty(cursor);
                 cursor = Path.GetDirectoryName(cursor))
                if ((File.Exists(cursor) || Directory.Exists(cursor))
                    && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("拒绝符号链接路径：" + cursor);
        }

        static T Read<T>(string path) where T : class
        {
            NoLinks(path);
            if (!File.Exists(path)) return null;
            if (new FileInfo(path).Length > 1024 * 1024)
                throw new IOException("MA 记录文件过大，无法安全读取。");
            return JsonUtility.FromJson<T>(File.ReadAllText(path, Encoding.UTF8));
        }

        static void AtomicWrite(string path, object value)
        {
            NoLinks(path);
            string directory = Path.GetDirectoryName(path);
            Directory.CreateDirectory(directory);
            string temporary = Path.Combine(directory, ".ma-" + Guid.NewGuid().ToString("N").Substring(0, 12) + ".tmp");
            try
            {
                using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    byte[] bytes = new UTF8Encoding(false).GetBytes(JsonUtility.ToJson(value));
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
                NoLinks(path);
                if (File.Exists(path)) File.Replace(temporary, path, null);
                else File.Move(temporary, path);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        static bool SameIdentity(Request req, Receipt receipt)
        {
            return receipt != null && receipt.schema == 1 && receipt.id == req.id
                && string.Equals(receipt.sha256, req.sha256, StringComparison.OrdinalIgnoreCase);
        }
        static bool IsFinal(Receipt receipt)
        {
            return receipt != null
                && (receipt.state == "applied" || receipt.state == "skipped" || receipt.state == "error");
        }
        static Receipt CurrentReceipt(Request req)
        {
            Receipt receipt = Read<Receipt>(ReceiptPath(req.id));
            if (receipt != null && !SameIdentity(req, receipt))
                throw new IOException("MA 回执与请求身份不一致，未作任何修改。");
            return receipt;
        }
        static Journal CurrentJournal(Request req)
        {
            Journal journal = Read<Journal>(JournalPath(req.id));
            if (journal != null && (journal.schema != 1 || journal.id != req.id
                || !string.Equals(journal.sha256, req.sha256, StringComparison.OrdinalIgnoreCase)))
                throw new IOException("MA 恢复记录与当前请求不一致，请核对工程。");
            return journal ?? new Journal { id = req.id, sha256 = req.sha256, phase = "selection" };
        }

        static void WriteReceipt(Request req, string state, string message,
            GameObject avatar = null, string prefab = null, string menuName = null,
            GameObject instance = null, string menuMode = null)
        {
            string text = message == null ? "" : (message.Length > 2000 ? message.Substring(0, 2000) : message);
            AtomicWrite(ReceiptPath(req.id), new Receipt
            {
                id = req.id,
                sha256 = req.sha256,
                state = state,
                message = text,
                avatarName = avatar == null ? null : avatar.name,
                prefabPath = prefab,
                menuName = menuName,
                hierarchyPath = instance == null || avatar == null
                    ? null
                    : avatar.name + "/" + instance.name,
                menuMode = menuMode
            });
        }

        /* ================================================================
         * 人工选择窗口（中文界面）
         * ================================================================ */

        private sealed class SetupWindow : EditorWindow
        {
            string requestId;
            GameObject avatar, prefab;
            string error = "";

            internal static void Open()
            {
                SetupWindow window = GetWindow<SetupWindow>("素材库 · MA 装配");
                window.minSize = new Vector2(460, 420);
                window.Show();
            }

            void OnGUI()
            {
                EditorGUILayout.LabelField("使用 Modular Avatar 装配导入的预制件", EditorStyles.boldLabel);
                EditorGUILayout.HelpBox(
                    "预制件会挂到所选角色的层级最后。有多个角色或预制件时需要你先选。"
                    + "一次撤销可整体还原；确认后请自行保存场景。", MessageType.Info);
                if (GUILayout.Button("刷新待处理的导入")) { RefreshRequests(); Repaint(); }

                if (pending.Count == 0)
                {
                    EditorGUILayout.HelpBox(
                        "暂无待处理请求。请在素材库里导入时勾选 MA 装配。已完成、跳过和失败的请求不会自动重复执行。",
                        MessageType.Info);
                    return;
                }

                string[] labels = new[] { "请选择一次导入…" }
                    .Concat(pending.Select(r => r.sourceName + " · " + r.id.Substring(0, 8))).ToArray();
                int selected = pending.FindIndex(r => r.id == requestId) + 1;
                int next = EditorGUILayout.Popup("导入记录", selected, labels);
                if (next != selected)
                {
                    requestId = next == 0 ? null : pending[next - 1].id;
                    avatar = null; prefab = null; error = "";
                }
                Request req = pending.FirstOrDefault(r => r.id == requestId);
                if (req == null) return;

                Receipt receipt = CurrentReceipt(req);
                EditorGUILayout.HelpBox(receipt == null ? "正在等待请求状态。" : receipt.message, MessageType.Info);

                string dep = DependencyStatus(req);
                if (!string.IsNullOrEmpty(dep)) EditorGUILayout.HelpBox(dep, MessageType.Warning);
                if (req.menu && string.IsNullOrEmpty(dep))
                    EditorGUILayout.HelpBox("本次同时接入游戏内菜单：作者已带 MA 菜单则保留；"
                        + "没有时创建显隐开关。装配与菜单一次撤销。", MessageType.Info);

                GameObject[] avatars = AvatarChoices();
                int avatarIndex = Array.IndexOf(avatars, avatar) + 1;
                int nextAvatar = EditorGUILayout.Popup("已加载的角色", avatarIndex,
                    new[] { "请选择角色…" }.Concat(avatars.Select(g => g.name + " · " + g.scene.name)).ToArray());
                if (nextAvatar != avatarIndex) avatar = nextAvatar == 0 ? null : avatars[nextAvatar - 1];
                avatar = (GameObject)EditorGUILayout.ObjectField("场景角色根对象", avatar, typeof(GameObject), true);

                string[] paths = PrefabChoices(req);
                if (paths.Length > 0)
                {
                    string current = prefab == null ? "" : AssetDatabase.GetAssetPath(prefab);
                    int index = Array.IndexOf(paths, current) + 1;
                    int choice = EditorGUILayout.Popup("本次导入的预制件", index,
                        new[] { "请选择预制件…" }.Concat(paths).ToArray());
                    if (choice != index) prefab = choice == 0 ? null : AssetDatabase.LoadAssetAtPath<GameObject>(paths[choice - 1]);
                }
                else
                {
                    EditorGUILayout.HelpBox(BatchKnown(req)
                        ? "Assets 里还没有本次导入的可用预制件。请核对素材包导入选项，等 Unity 编译完成后刷新。"
                        : "Unity 没返回本次导入的预制件清单，请手动选择正确的预制件资源。",
                        MessageType.Warning);
                    prefab = (GameObject)EditorGUILayout.ObjectField("预制件资源", prefab, typeof(GameObject), false);
                }

                if (!string.IsNullOrEmpty(error)) EditorGUILayout.HelpBox(error, MessageType.Error);
                using (new EditorGUI.DisabledScope(avatar == null || prefab == null
                    || !string.IsNullOrEmpty(dep) || !Imported(req)))
                {
                    if (GUILayout.Button("装配到所选角色 · 支持撤销"))
                        try { ApplyAssembly(req, avatar, prefab); error = ""; }
                        catch (Exception exception) { error = exception.Message; }
                }
                if (GUILayout.Button("跳过 MA 装配 · 保留已导入文件"))
                {
                    WriteReceipt(req, "skipped", "已跳过 MA 装配，已导入的文件保持原样。");
                    RefreshRequests();
                }
            }
        }
    }
}
