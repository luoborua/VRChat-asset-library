/*
 * 86-import.js —— 导入中心：把外部素材变成库里的记录与文件位置
 *   ① 文件夹导入：扫本地已下载素材，归并版本、挑封面、识别 .url 里的商店链接
 *   ② 用户脚本 JSON / 订单页 / 已购库 / 心愿单：把页面数据转成素材记录
 *   与 App / Store / FS.host / Net / Fetchers 协作；联网与下载交给 Net，编辑界面在 70-forms。
 */

var Importer = (function () {

  var ARCHIVE_EXT = ['zip', 'rar', '7z', 'unitypackage', 'vrca', 'fbx', 'blend', 'psd', 'clip', 'pmx', 'tar', 'gz'];
  var IMAGE_EXT   = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
  var LINK_EXT    = ['url', 'website', 'txt', 'html', 'htm', 'md'];

  function extOf(name) {
    var m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }
  function baseName(name) { return String(name).replace(/\.[^.]+$/, ''); }
  /**
   * 顶层项原生移动：不递归、不复制、不删源；目标有同名项就直接失败，交给调用方按「跳过」处理。
   * 冲突时若先删目标再重试，等于静默删掉用户库里已有的那一份，且不可撤销。
   */
  async function tryMoveEntry(entry, dir) {
    if (!App.settings.importMoveInsteadOfCopy || !entry || typeof entry.move !== 'function') return false;
    if (typeof entry.queryPermission === 'function' && typeof entry.requestPermission === 'function') {
      try {
        var perm = await entry.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') await entry.requestPermission({ mode: 'readwrite' });
      } catch (ePerm) { /* 非选择器句柄可能不允许单独申请权限，继续直接 move */ }
    }
    try {
      await entry.move(dir);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 复制一个 FileSystemFileHandle/File 到目标目录（覆盖同名） */
  async function copyEntryTo(entry, dir, fileName) {
    var f = await entry.getFile();
    var fh = await dir.getFileHandle(fileName || f.name, { create: true });
    var w = await fh.createWritable();
    await w.write(f); await w.close();
    return fh;
  }

  /** 复制一个顶层文件夹（目录复制本身必须进入内部，这是唯一的递归复制入口） */
  async function copyTreeInto(dir, dst, counter) {
    for await (var entry of dir.values()) {
      if (entry.kind === 'file') {
        await copyEntryTo(entry, dst, entry.name);
        counter.copied++;
      } else {
        var sub = await dst.getDirectoryHandle(entry.name, { create: true });
        await copyTreeInto(entry, sub, counter);
      }
    }
  }

  /**
   * 统一入口：把 sourceDir 的顶层子项搬到 dst，不再往下递归。
   * 移动模式下某项失败即跳过并提示，绝不偷偷改成复制。
   */
  async function importTopLevelEntries(sourceDir, dst, onLog) {
    onLog = onLog || function () {};
    var top = [];
    for await (var entry of sourceDir.values()) top.push(entry);
    var counter = { copied: 0, moved: 0, failed: 0, names: [] };
    var moveMode = !!App.settings.importMoveInsteadOfCopy;
    if (moveMode) {
      // 拖拽来的目录通常只有读权限：先给源目录补一次读写权限，子项的 move 才可能成功
      if (typeof sourceDir.queryPermission === 'function' && typeof sourceDir.requestPermission === 'function') {
        try {
          var rootPerm = await sourceDir.queryPermission({ mode: 'readwrite' });
          if (rootPerm !== 'granted') await sourceDir.requestPermission({ mode: 'readwrite' });
        } catch (ePerm) { /* 个别句柄不允许申请，继续按子项逐个补权限 */ }
      }
    }
    for (var item of top) {
      if (moveMode) {
        var moved = await tryMoveEntry(item, dst);
        if (moved) { counter.moved++; counter.names.push(item.name); onLog('已移动：' + item.name); }
        else {
          counter.failed++;
          onLog('\u26A0 移动失败，已跳过（不复制' + (item.kind === 'directory' ? '，目录整项移动不被浏览器支持' : '') + '）：' + item.name);
        }
        continue;
      }
      if (item.kind === 'file') {
        await copyEntryTo(item, dst, item.name);
        counter.copied++;
        counter.names.push(item.name);
        onLog('已复制：' + item.name);
      } else {
        var sub = await dst.getDirectoryHandle(item.name, { create: true });
        await copyTreeInto(item, sub, counter);
        onLog('已复制文件夹：' + item.name);
      }
    }
    return counter;
  }

  /** 从文件名里推断版本号，例如「<名称>_v<数字>.zip」「<名称> ver<数字>」 */
  function guessVersion(name) {
    var s = String(name);
    var m = s.match(/(?:^|[\s_\-\[【(])[vV](\d+(?:[._-]\d+){0,3})(?![\d])/) ||
            s.match(/(?:ver|version|バージョン)[\s._-]*(\d+(?:[._-]\d+){0,3})/i) ||
            s.match(/(?:^|[\s_\-\[【(])(\d+\.\d+(?:\.\d+)?)(?:[\s_\-\]】)]|$)/);
    return m ? ('v' + m[1].replace(/_/g, '.')) : '';
  }

  /** 从 .url / 文本文件内容里提取第一个 http 链接 */
  function extractURL(text) {
    var m = String(text || '').match(/URL\s*=\s*(https?:\/\/\S+)/i) || String(text || '').match(/(https?:\/\/[^\s"'<>）)]+)/);
    return m ? m[1].trim() : '';
  }

  /** 扫描一个目录，产出候选素材列表：每个子文件夹一个候选，散落压缩包按主名聚合 */
  function scanForImport(rootHandle, onProgress) {
    onProgress = onProgress || function () {};
    var candidates = [];
    var looseFiles = [];

    function collect(dir, relPrefix, depth, bucket) {
      var it = dir.values ? dir.values() : null;
      if (!it) return Promise.resolve();
      return (function loop() {
        return it.next().then(function (step) {
          if (step.done) return;
          var entry = step.value;
          var rel = relPrefix ? relPrefix + '/' + entry.name : entry.name;
          var p;
          if (entry.kind === 'file') {
            p = entry.getFile().then(function (f) {
              bucket.push({ name: entry.name, rel: rel, size: f.size, ext: extOf(entry.name), handle: entry, lastModified: f.lastModified });
            }).catch(function () {});
          } else if (depth < 4) {
            p = collect(entry, rel, depth + 1, bucket);
          } else p = Promise.resolve();
          return p.then(loop);
        });
      })();
    }

    // 顶层每个子文件夹算一个候选；散落的压缩包先攒起来，等扫完再按主名聚合
    var topIt = rootHandle.values();
    var chain = Promise.resolve();
    function walkTop() {
      return topIt.next().then(function (step) {
        if (step.done) return;
        var entry = step.value;
        if (entry.kind === 'directory') {
          onProgress('扫描文件夹：' + entry.name);
          var bucket = [];
          return collect(entry, '', 1, bucket).then(function () {
            if (bucket.length) candidates.push(buildCandidate(entry.name, entry, bucket));
            return walkTop();
          });
        }
        return entry.getFile().then(function (f) {
          looseFiles.push({ name: entry.name, rel: entry.name, size: f.size, ext: extOf(entry.name), handle: entry, lastModified: f.lastModified });
        }).catch(function () {}).then(walkTop);
      });
    }

    return chain.then(walkTop).then(function () {
      // 散落的压缩包按「去掉版本号后的主名」聚合，多个版本归到同一素材
      var groups = {};
      looseFiles.forEach(function (f) {
        if (ARCHIVE_EXT.indexOf(f.ext) < 0) return;
        var key = baseName(f.name).replace(/(?:^|[\s_\-\[【(])[vV]\d+(?:[._-]\d+)*/g, '').trim() || baseName(f.name);
        (groups[key] = groups[key] || []).push(f);
      });
      // 同名封面图 / 链接文件只归入一个分组（长键优先，避免同名图片被拆进多个候选素材）
      var keys = Object.keys(groups).sort(function (a, b) { return b.length - a.length; });
      looseFiles.forEach(function (f) {
        if (ARCHIVE_EXT.indexOf(f.ext) >= 0) return;
        if (IMAGE_EXT.indexOf(f.ext) < 0 && LINK_EXT.indexOf(f.ext) < 0) return;
        for (var i = 0; i < keys.length; i++) {
          if (baseName(f.name).indexOf(keys[i]) === 0) {
            groups[keys[i]].push(f);
            break;
          }
        }
      });
      keys.forEach(function (k) {
        candidates.push(buildCandidate(k, null, groups[k]));
      });
      return candidates;
    });
  }

  /** 把一组文件整理成候选素材 */
  function buildCandidate(name, dirHandle, files) {
    var archives = files.filter(function (f) { return ARCHIVE_EXT.indexOf(f.ext) >= 0; });
    var images   = files.filter(function (f) { return IMAGE_EXT.indexOf(f.ext) >= 0; });
    var links    = files.filter(function (f) { return LINK_EXT.indexOf(f.ext) >= 0; });
    var total    = files.reduce(function (s, f) { return s + (f.size || 0); }, 0);

    // 封面优先级：文件名含 cover/thumb/main/封面 > 最大的图 > 第一张
    images.sort(function (a, b) {
      var pa = /cover|thumb|main|封面|表紙|00|01/i.test(a.name) ? 1 : 0;
      var pb = /cover|thumb|main|封面|表紙|00|01/i.test(b.name) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b.size || 0) - (a.size || 0);
    });

    var versions = archives.map(function (f) {
      return {
        name: guessVersion(f.name) || baseName(f.name).slice(0, 40),
        fileName: f.name, size: f.size, path: f.rel, handle: f.handle
      };
    });
    // 有版本号的排在后面（越新越靠后），标记最新
    if (versions.length) {
      versions.sort(function (a, b) { return collator.compare(a.name, b.name); });
      versions[versions.length - 1].isLatest = true;
    }

    return {
      selected: true,
      name: String(name).replace(/[_]+/g, ' ').trim(),
      /* 名字里带 BOOTH 商品号（[5058951]-xxx / 纯数字）就先记下来：
       * 导入时直接当 itemId 用，并在导入完成后自动按它解析一次商品页。 */
      guessItemId: boothIdFromName(name),
      dirHandle: dirHandle,
      files: files, archives: archives, images: images, linkFiles: links,
      versions: versions, totalSize: total,
      coverFile: images[0] || null,
      storeURL: '',
      category: '', avatars: []
    };
  }

  /** 读取候选里的 .url / txt 文件，提取商店链接 */
  function resolveLinks(cands, onProgress) {
    var chain = Promise.resolve();
    cands.forEach(function (c) {
      c.linkFiles.slice(0, 3).forEach(function (lf) {
        chain = chain.then(function () {
          return lf.handle.getFile().then(function (f) {
            if (f.size > 200000) return;
            return f.text().then(function (t) {
              var u = extractURL(t);
              if (u && !c.storeURL) { c.storeURL = u; if (onProgress) onProgress('识别到链接：' + c.name + ' → ' + u); }
            });
          }).catch(function () {});
        });
      });
    });
    return chain.then(function () { return cands; });
  }

  /** 把候选素材搬进 <库根>/<分类>/<素材名>/；移动模式下失败即跳过，不改走复制 */
  function copyIntoLibrary(cand, categoryLabel, onProgress, moveOpts) {
    moveOpts = moveOpts || {};
    return FS.getLibraryRoot().then(function (root) {
      if (!root) return null;
      return FS.ensurePermission(root, 'readwrite').then(function (ok) {
        if (!ok) return null;
        var safe = String(cand.name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '未命名';
        return root.getDirectoryHandle(categoryLabel, { create: true }).then(function (catDir) {
          /* 同名目录不能直接复用：create:true 会拿回已有的那个目录，同名文件被静默
             覆盖，两条素材还会指向同一个 path。撞名就换 _2、_3。 */
          return App.pickFreeFolderName(safe, categoryLabel, {
            exists: function (n) {
              return catDir.getDirectoryHandle(n).then(function () { return true; }, function (err) {
                // NotFoundError / TypeError（名字不合法）= 确实没有；其它错误按「占用」处理，让名字继续往后试
                return !(err && (err.name === 'NotFoundError' || err.name === 'TypeError'));
              });
            }
          }).then(function (pick) {
            if (pick.renamed && onProgress) onProgress('\u26A0 素材库已有同名目录「' + safe + '」，改导入到「' + pick.name + '」');
            return catDir.getDirectoryHandle(pick.name, { create: true }).then(async function (dstDir) {
              var rootPath = App.libraryRoot();
              var dstAbs = joinWinPath(rootPath, [categoryLabel, pick.name]);
              // 文件夹只搬顶层子项，不把子目录拍平成逐文件移动
              var counter;
              if (cand.dirHandle && cand.dirHandle.values) {
                counter = await importTopLevelEntries(cand.dirHandle, dstDir, onProgress, { dstAbs: dstAbs, srcRootAbs: moveOpts.srcRootAbs || '' });
              } else {
                counter = { copied: 0, moved: 0, failed: 0 };
                for (var f of cand.files) {
                  var entry = {
                    kind: 'file', name: f.name, getFile: function () { return f.handle.getFile(); },
                    move: f.handle && f.handle.move ? function (d) { return f.handle.move(d); } : null,
                    remove: f.handle && f.handle.remove ? function () { return f.handle.remove(); } : null
                  };
                  var moved = await tryMoveEntry(entry, dstDir);
                  if (moved) { counter.moved++; continue; }
                  if (App.settings.importMoveInsteadOfCopy) {
                    counter.failed++;
                    if (onProgress) onProgress('\u26A0 移动失败，已跳过（不复制）：' + f.name);
                  } else {
                    await copyEntryTo(entry, dstDir, entry.name);
                    counter.copied++;
                  }
                }
              }
              return { dir: categoryLabel + '/' + pick.name, copied: counter.copied, moved: counter.moved, failed: counter.failed, total: counter.copied + counter.moved };
            });
          });
        });
      });
    });
  }

  /**
   * 登记「存储路径」时只替换同名那一条，其它条目（原始位置、网盘位置）原样保留 ——
   * 整条覆盖会把用户登记过的其它位置一起清掉。
   */
  function setPathEntry(asset, path, note) {
    note = note || '存储路径';
    var list = (asset.paths || []).filter(function (x) { return x && x.path; });
    var hit = false;
    list = list.map(function (x) {
      if ((x.note || '') === note) { hit = true; return { path: path, note: note }; }
      return x;
    });
    if (!hit) list.push({ path: path, note: note });
    asset.paths = list;
    return asset;
  }

  /**
   * 为素材在素材库里建「分类/素材名」文件夹（之后下载的文件放这里），
   * 并把这个位置登记为它的下载存放路径。
   */
  function ensureDownloadFolder(asset, onLog) {
    onLog = onLog || function () {};
    return FS.getLibraryRoot().then(function (root) {
      if (!root) return asset;
      return FS.ensurePermission(root, 'readwrite').then(function (ok) {
        if (!ok) return asset;
        var catLabel = App.categoryLabel(asset.category);
        var safe = App.folderName(asset);
        var hasLocal = (asset.paths || []).some(function (x) {
          return x && !!x.path;
        });
        return root.getDirectoryHandle(catLabel, { create: true }).then(function (catDir) {
          /* 已经有本地路径的素材照旧用原目录；只有新建的才挑空名字，避免两条素材共用一个目录 */
          var pickP = hasLocal ? Promise.resolve({ name: safe, renamed: false })
            : App.pickFreeFolderName(safe, catLabel, {
              excludeId: asset.id,
              exists: function (n) {
                return catDir.getDirectoryHandle(n).then(function () { return true; }, function (err) {
                  return !(err && (err.name === 'NotFoundError' || err.name === 'TypeError'));
                });
              }
            });
          return pickP.then(function (pick) {
            if (pick.renamed) onLog('\u26A0 素材库已有同名目录「' + safe + '」，改用「' + pick.name + '」');
            return catDir.getDirectoryHandle(pick.name, { create: true }).then(function () {
              var rel = catLabel + '\\' + pick.name;
              var rootPath = App.libraryRoot();
              var path = joinWinPath(rootPath, [rel]);
              if (!(asset.paths || []).some(function (x) { return x.path === path; })) {
                setPathEntry(asset, path, '存储路径');
                onLog('\u{1F4C1} 已创建下载文件夹：' + rel);
              }
              return asset;
            });
          });
        }).catch(function () { return asset; });
      });
    }).catch(function () { return asset; });
  }

  /**
   * 静默建出「分类/素材名」存储路径（不弹路径框、不开资源管理器），成功写回并保存；
   * 已有路径直接复用。用于「没有路径时先建目录再下载」。
   */
  function ensureStoragePathQuiet(asset) {
    if (!asset) return Promise.resolve(null);
    var existing = (asset.paths || []).filter(function (p) { return p && p.path && p.note === '存储路径'; })[0];
    if (existing) {
      /* 记录里那条目录可能已经不在了（被手动改名 / 跟着分类搬走 / 被旧快照写回了老位置）。
       * 这时先在库里按名字把真目录找回来 —— 否则后面任何一次写文件都会在原处
       * 重建一个只装着封面图的空壳文件夹（用户看到「新分类下多了个只有图片的目录」）。 */
      if (!FS.host || typeof FS.host.exists !== 'function') return Promise.resolve(existing.path);
      return FS.host.exists(existing.path).then(function (kind) {
        if (kind !== 'missing') return existing.path;                 // dir / file / 判不了 → 不折腾
        return App.findExistingFolder(asset).then(function (hit) {
          if (!hit) return existing.path;
          setPathEntry(asset, hit, '存储路径');
          return Promise.resolve(App.save(asset)).then(function () { return hit; }, function () { return hit; });
        });
      }).catch(function () { return existing.path; });
    }
    var cat = App.categoryLabel(asset.category || 'other');
    var safe = App.folderName(asset);
    var rootPath = App.libraryRoot();
    var folderPath = joinWinPath(rootPath, [cat, safe]);
    function setPath() {
      setPathEntry(asset, folderPath, '存储路径');
      return App.save(asset).then(function (saved) {
        /* setPathEntry 会保留其它条目，存储路径不一定还在第 0 位 */
        var hit = ((saved && saved.paths) || []).filter(function (p) { return p && p.note === '存储路径'; })[0];
        return (hit && hit.path) || folderPath;
      }).catch(function () { return folderPath; });
    }
    return FS.mkdirPath(folderPath).then(function (hostCreated) {
      if (hostCreated) return setPath();
      // 后端离线：退回浏览器句柄创建（与 ensureDownloadFolder 同规则）
      return FS.getLibraryRoot().then(function (root) {
        if (!root) {
          Toast.warn('尚未配置素材库根目录：请先在「设置 → 本地库与整理」选择根目录，才能自动创建存储路径', 6200);
          return null;
        }
        return FS.ensurePermission(root, 'readwrite').then(function (ok) {
          if (!ok) { Toast.warn('未获得素材库目录写入权限，无法自动创建存储路径', 5200); return null; }
          return root.getDirectoryHandle(cat, { create: true }).then(function (catDir) {
            return catDir.getDirectoryHandle(safe, { create: true });
          }).then(function () { return setPath(); })
            .catch(function (e) { Toast.warn('创建存储路径失败：' + (e && e.message), 5200); return null; });
        });
      });
    }).catch(function (e) { Toast.warn('创建存储路径失败：' + (e && e.message), 5200); return null; });
  }

  /* ------------------------------------------------------------------
   * 文件夹导入向导
   * ------------------------------------------------------------------ */
  function folderWizard() {
    if (!FS.supported()) {
      Toast.err('当前浏览器不支持文件夹访问，请使用 Chrome / Edge');
      return;
    }
    var state = { cands: [], root: null, rootName: '' };
    var importing = false;
    /* 关窗 = 取消。否则用户以为停了，后台还在逐项搬运（移动模式下源文件照搬不误），
     * 而界面已经关掉，既没有进度也没有结果可看，且不可撤销。 */
    var aborted = false;
    var importBtn = null;

    var logBox = el('div', { class: 'fetch-log', style: { display: 'none' } });
    function log(m) { logBox.style.display = ''; logBox.appendChild(el('div', { class: 'log-line', text: m })); logBox.scrollTop = logBox.scrollHeight; }

    var listBox = el('div', { class: 'import-list' });
    var summary = el('div', { class: 'field-hint', text: '尚未选择文件夹' });

    var basePathInput = el('input', { class: 'input mono', placeholder: '（可选）该文件夹在磁盘上的完整路径，例如 D:\\素材库\\下载' });
    var catSelect = el('select', { class: 'input' },
      [el('option', { value: '' }, '（自动推断）')].concat(App.allCategories().map(function (c) {
        return el('option', { value: c.id }, c.label);
      })));
    var avatarPicker = Field.avatars([]);
    var copyCheck = el('input', { type: 'checkbox', checked: !!App.settings.importCopyFiles });
    var coverCheck = el('input', { type: 'checkbox', checked: true });

    /* 候选封面预览的 blob URL 必须回收：每重绘一次就新建 N 个，几十个候选能残留
     * 数十 MB；用世代号挡住迟到的异步回调。 */
    var thumbURLs = [];
    var listGen = 0;
    function releaseThumbs() {
      thumbURLs.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
      thumbURLs = [];
    }
    function renderList() {
      listGen++;
      releaseThumbs();
      var myGen = listGen;
      listBox.innerHTML = '';
      if (!state.cands.length) { listBox.appendChild(el('div', { class: 'multi-empty', text: '未发现可导入的素材' })); return; }
      state.cands.forEach(function (c, i) {
        var cb = el('input', { type: 'checkbox', checked: c.selected, onchange: function () { c.selected = cb.checked; updateSummary(); } });
        /* 商品编号提示：能改文字，不能改「认出来的编号」——除非名字里出现新的编号。
         * 只更新这一小块节点，重绘整个列表会让输入框失焦、光标丢掉。 */
        var idChip = el('div', { class: 'chip-wrap' });
        function syncIdChip() {
          idChip.innerHTML = '';
          if (!c.guessItemId) return;
          idChip.appendChild(el('span', {
            class: 'chip chip-ok',
            title: '导入后会按这个编号解析 BOOTH 商品页，自动补全标题 / 封面 / 标签等信息',
            text: '商品 ID ' + c.guessItemId + '（导入后自动解析）'
          }));
        }
        var nameIn = el('input', { class: 'input input-sm', value: c.name, oninput: function () {
          c.name = nameIn.value;
          var id2 = boothIdFromName(this.value);
          if (id2 && id2 !== c.guessItemId) { c.guessItemId = id2; syncIdChip(); }
        } });
        var thumb = el('div', { class: 'import-thumb' }, [App.categoryIcon(c.category || 'other', { size: 22 })]);
        if (c.coverFile) {
          c.coverFile.handle.getFile().then(function (f) {
            if (myGen !== listGen) return;   // 已重绘 / 已关窗：迟到的回调不要再建 blob URL
            var u = URL.createObjectURL(f);
            thumbURLs.push(u);
            thumb.innerHTML = ''; thumb.appendChild(el('img', { src: u, alt: '' }));
          }).catch(function () {});
        }
        listBox.appendChild(el('div', { class: 'import-row' }, [
          el('label', { class: 'check' }, [cb]),
          thumb,
          el('div', { class: 'import-main' }, [
            nameIn,
            el('div', { class: 'field-hint' },
              c.versions.length + ' 个版本 / ' + c.files.length + ' 个文件 / ' + fmtSize(c.totalSize) +
              (c.storeURL ? '  ·  已识别商店链接' : '') +
              (c.coverFile ? '  ·  含封面图' : '')),
            c.versions.length ? el('div', { class: 'chip-wrap' }, c.versions.slice(0, 6).map(function (v) {
              return el('span', { class: 'chip' + (v.isLatest ? ' chip-ok' : '') }, v.name + '（' + fmtSize(v.size) + '）');
            })) : null,
            (function () { syncIdChip(); return idChip; })(),
            c.storeURL ? el('div', { class: 'field-hint mono', text: c.storeURL }) : null
          ])
        ]));
      });
      updateSummary();
    }
    function updateSummary() {
      var sel = state.cands.filter(function (c) { return c.selected; });
      var size = sel.reduce(function (s, c) { return s + c.totalSize; }, 0);
      summary.textContent = '共发现 ' + state.cands.length + ' 项，已选 ' + sel.length + ' 项，合计 ' + fmtSize(size) +
        (state.rootName ? '　（来源文件夹：' + state.rootName + '）' : '');
    }

    var pickBtn = el('button', {
      class: 'btn btn-primary', onclick: function () {
        FS.pickDirectory('vrc-import-src').then(function (r) {
          if (!r) return;
          state.root = r.handle; state.rootName = r.name;
          state.cands = [];          // 换目录先丢掉旧候选：扫描失败也不许再导入上一个目录
          if (importBtn) importBtn.disabled = true;
          if (!basePathInput.value.trim()) basePathInput.placeholder = '（可选）该文件夹的完整路径，末级目录名应为：' + r.name;
          log('开始扫描「' + r.name + '」…');
          listBox.innerHTML = '';
          listBox.appendChild(el('div', { class: 'multi-empty', text: '正在扫描 …' }));
          updateSummary();
          return scanForImport(r.handle, log).then(function (cands) {
            log('扫描完成，发现 ' + cands.length + ' 个候选素材，正在读取链接文件 …');
            return resolveLinks(cands, log);
          }).then(function (cands) {
            cands.forEach(function (c) {
              c.category = Smart.guessCategory({ originalTitle: c.name, tags: [], description: '' });
              c.avatars = c.category === 'avatar' ? [] : Smart.detectAvatars({ originalTitle: c.name, tags: [], description: '' });
            });
            state.cands = cands;
            renderList();
            if (importBtn && !importing) importBtn.disabled = false;   // 扫描成功才放开导入
            log('\u2714 就绪，可勾选后导入');
          });
        }).catch(function (e) { log('\u2716 扫描失败：' + (e.message || e)); });
      }
    }, ICONS.label('\u{1F4C2} 选择要导入的文件夹'));

    function doImport() {
      if (importing) return;   // 防连点：避免同一批候选被导入两次
      var sel = state.cands.filter(function (c) { return c.selected; });
      if (!sel.length) { Toast.warn('请至少勾选一项'); return; }
      importing = true;
      if (importBtn) { importBtn.disabled = true; ICONS.apply(importBtn, ('\u23F3 导入中 …')); }
      var basePath = basePathInput.value.trim().replace(/[\\/]+$/, '');
      var forceCat = catSelect.value;
      var extraAvatars = avatarPicker.getValue();
      var doCopy = copyCheck.checked;
      App.settings.importCopyFiles = doCopy; App.saveSettings();

      log('开始导入 ' + sel.length + ' 项 …');
      var chain = Promise.resolve(), done = 0, failed = 0, stopped = 0;
      var toParse = [];        // 名字里带商品编号的：导入完成后按编号解析一次商品页

      sel.forEach(function (c) {
        chain = chain.then(function () {
          if (aborted) { stopped++; return; }
          var cat = forceCat || c.category || 'other';
          var catLabel = App.categoryLabel(cat);
          /* 名字里的商品编号：有商店链接时以链接为准（链接可能是 Gumroad），
           * 没链接才拿编号当 BOOTH 商品页。 */
          var guessId = c.storeURL ? '' : String(c.guessItemId || '');
          var asset = Store.normalizeAsset({
            title: c.name,
            source: c.storeURL ? (Fetchers.detect(c.storeURL).sourceId || 'other') : (guessId ? 'booth' : 'other'),
            itemId: guessId,
            category: cat,
            avatars: uniq((c.avatars || []).concat(extraAvatars)),
            links: c.storeURL ? [{ url: c.storeURL, label: hostOf(c.storeURL) }]
              : (guessId ? [{ url: 'https://booth.pm/ja/items/' + guessId, label: 'BOOTH' }] : []),
            downloaded: true, downloadedAt: nowISO(),
            fileSize: c.totalSize,
            importedFrom: 'folder',
            versions: c.versions.map(function (v) {
              return { name: v.name, fileName: v.fileName, size: v.size, isLatest: v.isLatest };
            })
          });

          var step = Promise.resolve();

          if (coverCheck.checked && c.coverFile) {
            step = step.then(function () {
              return c.coverFile.handle.getFile().then(function (f) {
                return compressImage(f, App.settings.imageMaxWidth, App.settings.imageQuality).then(function (b) {
                  asset.hasCover = true;
                  return Store.putCover(asset.id, b);
                });
              }).catch(function () {});
            });
          }

          step = step.then(function () {
            if (!doCopy) return null;
            log('\u{1F4E6} 导入「' + c.name + '」到素材库（' + (App.settings.importMoveInsteadOfCopy ? '移动' : '复制') + '模式）…');
            return copyIntoLibrary(c, catLabel, log, { srcRootAbs: basePath ? normalizeWinPath(basePath) : '' });
          }).then(function (res) {
            if (res) {
              var full = App.libraryRoot();   // 路径推导自应用目录，不写死任何人的目录
              var rel = res.dir.replace(/\//g, '\\');
              asset.paths = [{ path: joinWinPath(full, [rel]), note: '素材库（已导入 ' + res.total + ' 个文件）' }];
              log('\u2714 已导入 ' + res.total + ' 个文件' +
                (res.moved ? '（移动 ' + res.moved + ' 个' + (res.copied ? '，复制 ' + res.copied + ' 个' : '') + '）' : '') +
                (res.failed ? '，跳过 ' + res.failed + ' 个（移动失败，不复制）' : '') + ' → ' + res.dir);
            } else if (basePath) {
              asset.paths = [{ path: joinWinPath(basePath, [String(c.name).replace(/[\\/:*?"<>|]/g, '_')]), note: '原始位置' }];
            } else {
              asset.paths = [{ path: normalizeWinPath((state.rootName || '') + '\\' + c.name), note: '相对路径，请补全为绝对路径' }];
            }
            return App.save(asset).then(function (saved) {
              if (guessId) toParse.push({ asset: saved || asset, id: guessId, name: c.name });
              return saved;
            });
          });

          /* 单项失败不中断整批：某一项抛错（权限 / 文件被占用 / 磁盘满）不该让它
           * 后面的项静默不导入。 */
          return step.then(function () { done++; UI.renderAll(); })
            .catch(function (e) {
              failed++;
              log('\u2716 跳过「' + c.name + '」：' + ((e && e.message) || e));
            });
        });
      });

      /* 导入完成后统一按编号解析一遍：串行 + 1.2~1.8 秒间隔，
       * 一批几十个也不会把 BOOTH 打成爬虫。每项失败只记一行，不影响别的项。 */
      function parseAll() {
        if (!toParse.length) return Promise.resolve(null);
        if (App.settings && App.settings.autoParseOnImport === false) {
          log('\u00B7 已关闭「导入后按编号解析」，' + toParse.length + ' 项只登记了编号');
          return Promise.resolve(null);
        }
        log('开始按商品编号解析 ' + toParse.length + ' 项（每项间隔 1~2 秒，别把站点打急）…');
        var okN = 0, badN = 0;
        var p = Promise.resolve();
        toParse.forEach(function (t, i) {
          p = p.then(function () {
            if (aborted) { badN++; return null; }
            log('\u00B7 [' + (i + 1) + '/' + toParse.length + '] 解析 ' + t.id + ' 号：' + t.name);
            return autoParseBoothById(t.asset, t.id).then(function (r) {
              if (r && r.ok) {
                okN++;
                log('  \u2714 已补充：' + (((r.changed || []).slice(0, 6).join('、')) || '（没有新增字段）'));
              } else {
                badN++;
                log('  \u00B7 跳过：' + ((r && r.reason) || '解析失败'));
              }
            });
          });
        });
        return p.then(function () { return { ok: okN, bad: badN }; });
      }

      chain.then(function () {
        var tail = aborted
          ? '（已按关闭窗口中止，剩余 ' + stopped + ' 项未处理）'
          : '';
        log('\u2014\u2014 导入完成：成功 ' + done + ' 项'
          + (failed ? '，失败 ' + failed + ' 项' : '') + tail + ' \u2014\u2014');
        UI.renderAll();
        if (aborted) Toast.info('导入已中止：成功 ' + done + ' 项' + (failed ? '，失败 ' + failed + ' 项' : ''), 7000);
        else Toast.ok('已导入 ' + done + ' 项素材' + (failed ? '，' + failed + ' 项失败' : ''));

        return parseAll().then(function (pr) {
          UI.renderAll();
          if (!pr) return;
          log('\u2014\u2014 按编号解析完成：成功 ' + pr.ok + ' 项'
            + (pr.bad ? '，跳过 ' + pr.bad + ' 项' : '') + ' \u2014\u2014');
          if (pr.ok) Toast.ok('已按商品编号补全 ' + pr.ok + ' 项素材的信息', 5200);
        });
      }).catch(function (e) {
        log('\u2716 导入中断：' + (e.message || e));
        Toast.err('导入失败：' + (e.message || e));
      }).then(function () {
        importing = false;
        if (importBtn) { importBtn.disabled = false; ICONS.apply(importBtn, ('\u2B07 导入所选')); }
      });
    }

    var h = Modal.open({
      title: '从文件夹导入已下载的素材', size: 'lg',
      onClose: function () {
        listGen++; releaseThumbs();
        if (importing) {
          aborted = true;
          log('\u26A0 窗口已关闭，正在停止后续项（已复制/移动完成的不会回滚）');
        }
      },   // 关窗：回收候选封面的 blob，同时中止后续导入
      body: [
        el('div', { class: 'notice' }, [
          el('p', { text: '选择一个存放已下载素材的文件夹：每个子文件夹会被识别为一个素材，其中的压缩包按版本号归并为「版本」，图片自动作为封面，.url / .txt 里的链接自动识别为商店链接。' }),
          el('p', { text: '勾选「导入文件到素材库」后，会按「设置 → 本地库与整理」中的默认搬运方式（移动 / 复制）把文件放进素材库根目录下的「分类/素材名」；不勾选则只登记路径，不动你的文件。' })
        ]),
        el('div', { class: 'btn-row' }, [pickBtn]),
        summary,
        el('div', { class: 'import-opts' }, [
          Field.row('强制分类', catSelect, '留空则按名称自动推断'),
          Field.row('统一追加角色', avatarPicker),
          Field.row('原文件夹完整路径', basePathInput, '填写后，未导入的素材会记录成可直接粘贴的绝对路径'),
          el('label', { class: 'check check-row' }, [copyCheck, el('span', { text: '导入文件到素材库（需先授权素材库根目录；默认移动/复制见设置）' })]),
          el('label', { class: 'check check-row' }, [coverCheck, el('span', { text: '使用文件夹内的图片作为封面（网络抓取的封面优先级更高）' })])
        ]),
        listBox,
        logBox
      ],
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '关闭'),
        (importBtn = el('button', { class: 'btn btn-primary', onclick: doImport }, ICONS.label('\u2B07 导入所选')))
      ]
    });
  }

  /* ------------------------------------------------------------------
   * 用户脚本 / 已购库 JSON 导入
   * ------------------------------------------------------------------ */
  /** 把用户脚本导出的一条记录整理成解析器统一的商品结构 */
  function normalizeBridgeItem(it, site) {
    var srcId = site === 'gumroad' ? 'gumroad' : (site === 'booth' ? 'booth' : 'other');
    var info = Fetchers.finalize({
      itemId: String(it.itemId || it.id || ''),
      originalTitle: it.title || it.name || '',
      description: it.description || '',
      price: it.price != null ? String(it.price) : '',
      priceValue: null, currency: '', isFree: null,
      images: it.images || [], coverURL: (it.images || [])[0] || it.cover || '',
      tags: it.tags || [],
      author: it.shop || it.creator || '', shop: it.shop || it.creator || '',
      shopUrl: it.shopUrl || '', category: it.category || '',
      categoryId: Smart.mapShopCategory(it.category),
      publishedAt: it.publishedAt || it.published_at || '',
      shopUpdatedAt: it.shopUpdatedAt || it.updated_at || '',
      r18: !!it.r18,
      sourceId: srcId,
      downloadLinks: (it.downloads || []).map(function (d) { return { url: d.url, label: d.name || '下载' }; }),
      versions: (it.downloads || []).map(function (d) {
        return { name: guessVersion(d.name || '') || (d.name || '版本'), fileName: d.name || '', size: d.size || 0, url: d.url || '' };
      }),
      sourceURL: it.url || ''
    });
    return info;
  }

  /** 导入用户脚本 / 已购库数据：按商品 ID 与链接判重，能合并的合并，不新建重复条目 */
  function importBridgeJSON(payload, opts) {
    opts = opts || {};
    var log = opts.onLog || function () {};
    if (!payload || !Array.isArray(payload.items)) {
      return Promise.reject(new Error('不是有效的桥接数据：缺少 items 数组'));
    }
    var site = payload.site || '';
    log('数据来源：' + (site || '未知') + '，共 ' + payload.items.length + ' 项');

    var byKey = {};
    App.assets.forEach(function (a) {
      if (a.itemId) {
        byKey[a.source + ':' + a.itemId] = a;
        (a.sources || []).forEach(function (s) { byKey[s.source + ':' + a.itemId] = a; });
      }
      (a.links || []).forEach(function (l) { if (l.url) byKey['url:' + l.url] = a; });
    });

    var created = 0, updated = 0, skippedGifts = 0;
    var chain = Promise.resolve();
    payload.items.forEach(function (raw, i) {
      chain = chain.then(function () {
        // 赠送出去的 gift 不再属于「已购可用」：跳过
        if (raw.gifted || raw.isGift) { skippedGifts++; return; }
        var info = normalizeBridgeItem(raw, site);
        var fresh = Store.normalizeAsset({ source: info.sourceId || 'other', importedFrom: 'userscript' });
        fresh.originalTitle = info.originalTitle;
        fresh.title = (info.originalTitle || '').slice(0, 80);
        fresh.itemId = info.itemId || fresh.itemId;   // 不能把已有商品 ID 覆盖成空：丢了就再也对不上这条素材
        fresh.description = info.description;
        fresh.author = info.author;
        fresh.shop = info.shop;
        fresh.shopUrl = info.shopUrl;
        if (info.price && site !== 'booth') {
          fresh.shopPrice = info.price;
          var pd0 = derivePrice(info.price);
          fresh.shopPriceValue = pd0.value; fresh.shopPriceCurrency = pd0.currency;
        }
        fresh.images = info.images.slice();
        fresh.coverURL = info.coverURL || '';
        fresh.rawTags = Smart.filterBlacklist(Smart.purgeAvatarTags(info.tags));
        fresh.tags = Smart.filterBlacklist(Smart.purgeAvatarTags(App.settings.autoTranslateTags ? Smart.translateTags(info.tags) : info.tags.slice()));
        fresh.downloadLinks = info.downloadLinks;
        fresh.versions = info.versions;
        fresh.category = Smart.guessCategory(info);
        fresh.publishedAt = info.publishedAt || '';
        fresh.shopUpdatedAt = info.shopUpdatedAt || '';
        fresh.note = Smart.extractNotes(info.description);
        fresh.avatars = (App.settings.autoDetectAvatar && fresh.category !== 'avatar') ? Smart.detectAvatars(info) : [];
        if (info.sourceURL) fresh.links = [{ url: info.sourceURL, label: hostOf(info.sourceURL) }];
        if (raw.purchased) { fresh.extra = fresh.extra || {}; fresh.extra.purchased = true; }
        if (raw.giftedReceived) fresh.gifted = true;   // BOOTH 获赠页同步 → 获赠标记（可在编辑页手动改）
        if (info.r18 === true) { fresh.extra = fresh.extra || {}; fresh.extra.r18 = true; }

        var key = (info.sourceId || 'other') + ':' + info.itemId;
        var exist = byKey[key] || (raw.url ? byKey['url:' + raw.url] : null) || App.findDuplicate(fresh, false);
        var a = exist ? App.mergeAssets(exist, fresh) : fresh;
        if (exist && (raw.purchased || raw.giftedReceived)) a.delisted = false;  // 能同步到 = 商品仍可获得

        if (exist) updated++; else created++;
        if ((i + 1) % 10 === 0) log('已处理 ' + (i + 1) + ' / ' + payload.items.length);

        // 可选：自动 AI 翻译未命中的标签
        var step = Promise.resolve(a);
        if (App.settings.aiAutoTags) {
          var pending = (a.tags || []).filter(function (t) { return Smart.isUntranslated(t); });
          if (pending.length) {
            step = AI.translateItems(pending, function (m) { log(m); }).then(function (r) {
              return AI.mergeTagResults(r.results).then(function () {
                var dict = App.settings.userTagDict || {};
                a.tags = (a.tags || []).map(function (t) { return dict[t] || t; });
                return a;
              });
            }).catch(function () { return a; });
          }
        }
        return step.then(function (aa) {
          // 可选：在素材库中创建对应文件夹，作为下载存放位置
          if (App.settings.importCreateFolders && FS.getLibraryRoot) {
            return ensureDownloadFolder(aa, log).then(function () { return App.save(aa); });
          }
          return App.save(aa);
        });
      });
    });

    return chain.then(function () {
      return App.reload();
    }).then(function () {
      log('\u2714 新增 ' + created + ' 项，更新 ' + updated + ' 项' + (skippedGifts ? '，跳过已赠送的 gift ' + skippedGifts + ' 项' : ''));
      UI.renderAll();
      return { created: created, updated: updated, skippedGifts: skippedGifts };
    });
  }

  /** 粘贴 / 拖入用户脚本导出的 JSON */
  function bridgeImportDialog() {
    var ta = el('textarea', { class: 'input textarea mono', rows: 8, placeholder: '粘贴 vrc-library-bridge 用户脚本导出的 JSON（或直接把导出的 .json 文件拖到页面上）' });
    var logBox = el('div', { class: 'fetch-log', style: { display: 'none' } });
    function log(m) { logBox.style.display = ''; logBox.appendChild(el('div', { class: 'log-line', text: m })); logBox.scrollTop = logBox.scrollHeight; }

    var fi = el('input', { type: 'file', accept: '.json', style: { display: 'none' } });
    fi.onchange = function () {
      var f = fi.files[0]; if (!f) return;
      FS.readFileAsText(f).then(function (t) { ta.value = t; log('已载入文件：' + f.name); });
    };

    var busy = false;
    var importBtn = null;
    function doImport() {
      if (busy) return;
      var payload = safeJSON(ta.value, null);
      if (!payload) { Toast.err('无法解析 JSON'); return; }
      busy = true;
      if (importBtn) { importBtn.disabled = true; ICONS.apply(importBtn, ('\u23F3 导入中 …')); }
      importBridgeJSON(payload, { onLog: log }).then(function (r) {
        Toast.ok('导入完成：新增 ' + r.created + ' 项，更新 ' + r.updated + ' 项');
      }).catch(function (e) { Toast.err('导入失败：' + (e.message || e)); log('\u2716 ' + e.message); })
      .then(function () {
        busy = false;
        if (importBtn) { importBtn.disabled = false; ICONS.apply(importBtn, ('\u2B07 导入')); }
      });
    }

    var h = Modal.open({
      title: '从用户脚本导入（已购列表 / 商品信息）', size: 'md',
      body: [
        el('div', { class: 'notice' }, [
          el('b', { text: '这是获取「已购买素材 + 下载直链」的推荐方式' }),
          el('p', { text: '在浏览器安装随附的用户脚本 vrc-library-bridge.user.js（Tampermonkey / Violentmonkey），登录 BOOTH 或 Gumroad 后打开你的库页面，点击右下角面板的「导出」，再把内容粘到这里即可。' }),
          el('p', { text: '整个过程使用你自己浏览器里已登录的会话，本工具不需要、也不会保存你的账号密码。' })
        ]),
        (function () {
          var cb = el('input', { type: 'checkbox', checked: !!App.settings.importCreateFolders, onchange: function () {
            App.settings.importCreateFolders = cb.checked; App.saveSettings();
          } });
          var cbAi = el('input', { type: 'checkbox', checked: !!App.settings.aiAutoTags, onchange: function () {
            App.settings.aiAutoTags = cbAi.checked; App.saveSettings();
          } });
          return el('div', {}, [
            el('label', { class: 'check check-row' }, [cb, el('span', { text: '为每个导入素材在素材库创建「分类/素材名」文件夹（作为下载存放位置）' })]),
            el('label', { class: 'check check-row' }, [cbAi, el('span', { text: '导入时自动用 AI 翻译未命中的标签（需配置 DeepSeek Key）' })])
          ]);
        })(),
        el('div', { class: 'btn-row' }, [
          el('button', { class: 'btn btn-sm', onclick: function () { fi.click(); } }, ICONS.label('\u2B06 选择 JSON 文件')),
          el('button', { class: 'btn btn-sm', onclick: function () {
            if (!navigator.clipboard || !navigator.clipboard.readText) { Toast.warn('当前环境不支持读取剪贴板，请手动粘贴'); return; }
            navigator.clipboard.readText().then(function (t) { ta.value = t; log('已从剪贴板读取 ' + fmtSize(t.length)); })
              .catch(function () { Toast.warn('读取剪贴板被拒绝，请手动粘贴'); });
          } }, ICONS.label('\u{1F4CB} 从剪贴板读取')),
          fi
        ]),
        ta, logBox
      ],
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '取消'),
        (importBtn = el('button', { class: 'btn btn-primary', onclick: doImport }, ICONS.label('\u2B07 导入')))
      ]
    });
  }

  /* ------------------------------------------------------------------
   * 已购库同步（需程序后端在线 + Cookie）
   * ------------------------------------------------------------------ */
  function parseBoothLibrary(html) {
    var items = {};
    var doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return []; }
    function ensure(id) {
      if (!items[id]) items[id] = { itemId: id, url: 'https://booth.pm/ja/items/' + id, title: '', shop: '', images: [], downloads: [], purchased: true, gifted: false };
      return items[id];
    }
    /** 该行是否属于「赠送出去的 gift」 */
    function looksGifted(anchor) {
      var node = anchor;
      for (var i = 0; i < 5 && node; i++) {
        var t = (node.textContent || '');
        if (t.length < 2000 && /ギフト済み|ギフトを贈|ギフトを送|贈ったギフト|送ったギフト|ギフト送付済み|gifted/i.test(t)) return true;
        node = node.parentElement;
      }
      return false;
    }
    Array.prototype.forEach.call(doc.querySelectorAll('a[href*="/items/"]'), function (a) {
      var m = (a.getAttribute('href') || '').match(/\/items\/(\d+)/); if (!m) return;
      var it = ensure(m[1]);
      if (looksGifted(a)) it.gifted = true;
      var txt = (a.textContent || '').trim();
      if (txt && txt.length > 1 && txt.length < 200 && !it.title) it.title = txt;
      var img = a.querySelector('img');
      if (img) { var s = img.getAttribute('src') || img.getAttribute('data-src'); if (s) it.images.push(s); }
      var priceEl = a.closest('li, tr, div[class*="item"]') && a.closest('li, tr, div[class*="item"]').querySelector('[class*="price"], .price');
      if (priceEl && !it.price) {
        var pt = (priceEl.textContent || '').trim().replace(/\s+/g, ' ');
        if (pt && pt.length <= 24) it.price = pt;
      }
    });
    Array.prototype.forEach.call(doc.querySelectorAll('a[href*="/downloadables/"]'), function (a) {
      var node = a, id = '';
      for (var i = 0; i < 8 && node; i++) {
        var link = node.querySelector ? node.querySelector('a[href*="/items/"]') : null;
        if (link) { var m = (link.getAttribute('href') || '').match(/\/items\/(\d+)/); if (m) { id = m[1]; break; } }
        node = node.parentElement;
      }
      if (!id) return;
      var it = ensure(id);
      var name = (a.textContent || '').trim();
      var container = a.parentElement;
      if ((!name || name.length < 3) && container) {
        var t = (container.textContent || '').trim();
        var fm = t.match(/[^\s\/\\]+\.(zip|rar|7z|unitypackage|png|jpg|pdf|txt)/i);
        if (fm) name = fm[0];
      }
      it.downloads.push({ url: a.href || a.getAttribute('href'), name: name || '下载文件' });
    });
    Array.prototype.forEach.call(doc.querySelectorAll('a[href*=".booth.pm"]'), function (a) {
      var host = hostOf(a.getAttribute('href') || '');
      if (!host || host === 'booth.pm' || host === 'accounts.booth.pm') return;
      var node = a;
      for (var i = 0; i < 8 && node; i++) {
        var link = node.querySelector ? node.querySelector('a[href*="/items/"]') : null;
        if (link) {
          var m = (link.getAttribute('href') || '').match(/\/items\/(\d+)/);
          if (m && items[m[1]] && !items[m[1]].shop) {
            items[m[1]].shop = (a.textContent || '').trim().slice(0, 60);
            items[m[1]].shopUrl = 'https://' + host + '/';
          }
          break;
        }
        node = node.parentElement;
      }
    });
    return Object.keys(items).map(function (k) { return items[k]; })
      .filter(function (x) { return !x.gifted && (x.title || x.downloads.length); });
  }

  /**
   * 解析 BOOTH 订单页：一个商品一个条目；该订单里的所有 /downloadables/ 链接归入该商品的
   * 「订单下载文件」版本（一个版本含多个文件），不按每文件拆版本。
   */
  function parseBoothOrder(html) {
    var doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return []; }
    var items = {};
    function ensure(id) {
      if (!items[id]) items[id] = { itemId: id, url: 'https://booth.pm/ja/items/' + id, title: '', images: [], downloads: [], orderVersions: {} };
      return items[id];
    }
    function findItemId(node) {
      for (var i = 0; i < 12 && node; i++) {
        var link = node.querySelector ? node.querySelector('a[href*="/items/"]') : null;
        if (link) {
          var m = (link.getAttribute('href') || '').match(/\/items\/(\d+)/);
          if (m) return m[1];
        }
        node = node.parentElement;
      }
      return '';
    }
    function validPrice(txt) {
      if (!txt) return '';
      var t = String(txt).replace(/\s+/g, ' ').trim();
      // 必须带币种标记，避免把数量/编号当价格；且只取紧跟币种标记的数字，
      // 避免标题里的「3Dモデル」这类数字被当成价格。
      if (!/[¥￥$€]|JPY|USD|CNY|EUR|円|元/i.test(t)) return '';
      var m = t.match(/[¥￥]\s*(\d[\d,]*(?:\.\d+)?)/)
        || t.match(/[$]\s*(\d[\d,]*(?:\.\d+)?)/)
        || t.match(/[€]\s*(\d[\d,]*(?:\.\d+)?)/)
        || t.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:JPY|USD|CNY|EUR|円|元)/i)
        || t.match(/(?:JPY|USD|CNY|EUR)\s*(\d[\d,]*(?:\.\d+)?)/i);
      if (!m) return '';
      var value = parseFloat(String(m[1]).replace(/,/g, ''));
      if (!isFinite(value)) return '';
      var cur = /[¥￥]|JPY|円/i.test(t) ? 'JPY' : (/[$]|USD/i.test(t) ? 'USD' : (/[€]|EUR/i.test(t) ? 'EUR' : 'CNY'));
      return { text: t, value: value, currency: cur };
    }
    function orderPriceFor(link) {
      try {
        // 结构 1：链接所在 <b> 的父 div 的第二个 div（真实订单页 Gist 结构）
        var bA = (link && link.closest && link.closest('b')) || link;
        var meta = bA && bA.closest && bA.closest('div') ? bA.closest('div').parentElement : null;
        var priceEl = meta ? meta.querySelector('div:nth-child(2)') : null;
        var hit = priceEl ? validPrice(priceEl.textContent) : '';
        if (hit) return hit;
        // 结构 2：在商品/订单容器里找带币种标记的叶子节点
        var scope = (link && link.closest)
          ? (link.closest('li, tr, [class*="item"], [class*="order"], [class*="purchase"]') || link.parentElement)
          : null;
        if (scope) {
          var nodes = scope.querySelectorAll('div, span, b, td, dd, li, p');
          for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].children && nodes[i].children.length) continue;
            var h2 = validPrice(nodes[i].textContent);
            if (h2) return h2;
          }
        }
        return '';
      } catch (e) { return ''; }
    }
    // 当前真实订单页：订单总价在「支付金额 / Payment Amount」标签旁的格子里（多 DLC 一单时是整单总价）。
    function orderTotalPrice() {
      try {
        var nodes = Array.prototype.slice.call(doc.querySelectorAll('div, span, dt, dd, th, td'));
        var label = null;
        for (var i = 0; i < nodes.length; i++) {
          var t = String(nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
          if (t.length <= 40 && /支付金额|お支払い金額|支払い金額|支払金額|Payment Amount|Amount Paid|Total Paid|Paid Amount|合計金額|合計/i.test(t)) { label = nodes[i]; break; }
        }
        if (!label) return '';
        var row = (label.closest && (label.closest('.l-row') || label.closest('tr'))) || label.parentElement;
        if (!row) return '';
        var leaves = Array.prototype.slice.call(row.querySelectorAll('div, span, dt, dd, th, td'));
        for (var j = 0; j < leaves.length; j++) {
          if (leaves[j] === label) continue;
          if (leaves[j].children && leaves[j].children.length) continue;
          var hit = validPrice(leaves[j].textContent);
          if (hit) return hit;
        }
        return validPrice(row.textContent);
      } catch (e) { return ''; }
    }
    var orderTotal = orderTotalPrice();
    var rowPrices = {};
    Array.prototype.forEach.call(doc.querySelectorAll('a[href*="/items/"]'), function (a) {
      var m = (a.getAttribute('href') || '').match(/\/items\/(\d+)/); if (!m) return;
      var it = ensure(m[1]);
      var txt = (a.textContent || '').trim();
      if (txt && txt.length > 1 && txt.length < 200 && !it.title) it.title = txt;
      var img = a.querySelector('img');
      if (img) { var s = img.getAttribute('src') || img.getAttribute('data-src'); if (s) it.images.push(s); }
      if (!rowPrices[it.itemId]) rowPrices[it.itemId] = orderPriceFor(a) || '';
    });
    // 真实结构：每个下载文件是 div.js-download-button[data-href]，文件名在同容器 <b>，
    // variation_id 藏在 data-dropdown-items 的 deeplink 参数里。
    Array.prototype.forEach.call(doc.querySelectorAll('.js-download-button[data-href]'), function (btn) {
      var href = btn.getAttribute('data-href') || '';
      var m = href.match(/\/downloadables\/(\d+)/); if (!m) return;
      var id = findItemId(btn);
      var name = '';
      var row = btn.closest ? (btn.closest('.legacy-list-item') || btn.parentElement) : btn.parentElement;
      if (row) {
        var b = row.querySelector('b');
        if (b) name = (b.textContent || '').trim();
      }
      if (!name) {
        var t = (row && row.textContent) ? row.textContent.trim() : '';
        var fm = t.match(/[^\s\/\\]+\.(zip|rar|7z|unitypackage|png|jpg|jpeg|pdf|txt)/i);
        if (fm) name = fm[0];
      }
      var variation = '';
      // 主下载按钮没有 data-dropdown-items 时，从同一行的「其他下载」按钮里取 variation_id
      var ddEl = btn.getAttribute('data-dropdown-items') ? btn : (row ? row.querySelector('[data-dropdown-items]') : null);
      var dd = ddEl ? (ddEl.getAttribute('data-dropdown-items') || '') : '';
      var vm = dd.match(/variation_id=(\d+)/);
      if (vm) variation = vm[1];
      var dl = { url: 'https://booth.pm/downloadables/' + m[1], name: name || '下载文件', source: 'order', variation: variation };
      if (!id) { items.__orderDownloads = (items.__orderDownloads || []).concat([dl]); return; }
      var it = ensure(id);
      it.downloads.push(dl);
      var vkey = variation || 'default';
      it.orderVersions[vkey] = it.orderVersions[vkey] || { variationId: variation, files: [] };
      /* 购买价以订单为准，多变体各算各的、不做除法：变体行自带价格就先记在分组上，
       * 取不到才退回整单均分。 */
      if (it.orderVersions[vkey].rowPriceValue == null) {
        /* 价格不在下载行里，而在同一商品的 sheet 块里（块内同时有商品链接、标题与价格），
         * 所以先向上找「含该商品链接」的容器再取第一个价格；找不到才退回行内。 */
        var rowP = '';
        (function () {
          var node = btn, hops = 0;
          while (node && hops < 8) {
            var lk = node.querySelector ? node.querySelector('a[href*="/items/"]') : null;
            if (lk) {
              var mm = (lk.getAttribute('href') || '').match(/\/items\/(\d+)/);
              if (mm && (!id || mm[1] === id)) {
                var pt = validPrice(String(node.textContent || '').replace(/\s+/g, ' '));
                if (pt) { rowP = pt; return; }
              }
            }
            node = node.parentElement; hops++;
          }
        })();
        if (!rowP) rowP = orderPriceFor(btn) || (row ? orderPriceFor(row.querySelector('b') || btn) : '');
        if (rowP && rowP.value != null) {
          it.orderVersions[vkey].rowPrice = rowP.text;
          it.orderVersions[vkey].rowPriceValue = rowP.value;
          it.orderVersions[vkey].rowPriceCurrency = rowP.currency;
        }
      }
      it.orderVersions[vkey].files.push(dl);
    });
    var list = Object.keys(items).filter(function (k) { return k !== '__orderDownloads'; }).map(function (k) { return items[k]; });
    // 单商品订单页优先用「支付金额」整单总价；多商品订单页仍用每行价格。
    var singleItem = list.length === 1;
    list.forEach(function (it) {
      var op = (singleItem && orderTotal) ? orderTotal : (rowPrices[it.itemId] || '');
      if (op) { it.orderPrice = op.text; it.orderPriceValue = op.value; it.orderPriceCurrency = op.currency; }
    });
    if (items.__orderDownloads && items.__orderDownloads.length) {
      if (list.length === 1) {
        list[0].downloads = list[0].downloads.concat(items.__orderDownloads);
        list[0].orderVersions.default = list[0].orderVersions.default || { variationId: '', files: [] };
        list[0].orderVersions.default.files = list[0].orderVersions.default.files.concat(items.__orderDownloads);
      } else {
        list.forEach(function (it) { it.orderExtraDownloads = items.__orderDownloads; });
      }
    }
    return list.filter(function (x) { return x.downloads.length || x.title; });
  }

  /**
   * 解析 BOOTH 商品页（已登录视图）：每个变体一条，已购变体的购买按钮会指向订单页。
   * 免费变体（许可证 / readme 等）标 special：留在版本列表当公开下载，不参与购买价统计。
   */
  function parseBoothItemOrderLinks(html) {
    var doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return []; }
    function isSpecial(price) {
      var pd = derivePrice(price);
      return pd.value === 0 || /無料|无料|免费|free/i.test(String(price || ''));
    }
    var out = [];
    Array.prototype.forEach.call(doc.querySelectorAll('li.variation-item'), function (li) {
      var nameEl = li.querySelector('.variation-name');
      var priceEl = li.querySelector('.variation-price');
      var orderA = li.querySelector('.variation-cart a[href*="/orders/"]');
      var vid = '';
      var hidden = li.querySelector('input[name="cart_item[variation_id]"]');
      if (hidden) vid = hidden.getAttribute('value') || '';
      var orderUrl = orderA ? (orderA.getAttribute('href') || '') : '';
      var name = (nameEl ? nameEl.textContent : '').trim();
      var price = (priceEl ? priceEl.textContent : '').trim();
      // 免费变体直接收集商品页上的 /downloadables/ 直链
      var files = [];
      Array.prototype.forEach.call(li.querySelectorAll('.variation-cart a[href*="/downloadables/"]'), function (a) {
        var href = a.getAttribute('href') || '';
        var fname = (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim();
        var fm = fname.match(/[^\s\/\\]+\.(zip|rar|7z|unitypackage|png|jpg|jpeg|pdf|txt)/i);
        files.push({ name: fm ? fm[0] : (fname.slice(0, 80) || '免费下载文件'), url: href, size: 0, source: 'public' });
      });
      out.push({
        name: name,
        price: price,
        orderUrl: orderUrl,
        variationId: vid,
        special: isSpecial(price),
        files: files
      });
    });
    return out;
  }

  /* ------------------------------------------------------------------
   * Gumroad 解析：商品页（options=版本/变体，登录后带 purchase.content_url）
   * 与订单/下载页（props.content.content_items=全部文件）
   * ------------------------------------------------------------------ */
  /** Gumroad 页面数据：主要在 div#app[data-page]，另一种形态是 script[data-component-name] */
  function gumroadDataPage(doc) {
    if (!doc) return null;
    var node = doc.querySelector('div#app[data-page]');
    var raw = node ? (node.getAttribute('data-page') || '') : '';
    var d = raw ? safeJSON(raw, null) : null;
    if (!d) {
      var comp = doc.querySelector('script[data-component-name]');
      if (comp && comp.textContent) d = safeJSON(comp.textContent, null);
    }
    return d && typeof d === 'object' ? d : null;
  }
  /** Gumroad content_items → 文件列表（下载地址统一补全为绝对地址） */
  function gumroadContentFiles(content) {
    var out = [];
    (Array.isArray(content && content.content_items) ? content.content_items : []).forEach(function (f) {
      if (!f || typeof f !== 'object') return;
      var u = f.external_link_url || f.download_url || f.stream_url || f.read_url || '';
      if (!u) return;
      if (/^\//.test(u)) u = 'https://gumroad.com' + u;
      var extRaw = String(f.extension || '').replace(/^\./, '');
      var ext = extRaw.toLowerCase();
      var name = String(f.file_name || f.name || '下载文件').replace(/\s+/g, ' ').trim();
      if (ext && name.toLowerCase().indexOf('.' + ext) !== name.length - ext.length - 1) name = name + '.' + extRaw;
      out.push({ name: name, url: u, size: Number(f.file_size || f.content_length || 0) || 0, source: f.external_link_url ? 'external' : 'order' });
    });
    return out;
  }

  /**
   * 解析 Gumroad 商品页的变体：实付价能用唯一变体对上，就把下载页链接挂到那个变体；
   * 对不上就留空，交给用户手填订单链接。免费变体 / 公开文件标 special，只作下载用。
   */
  function parseGumroadItemOrderLinks(html) {
    var doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return []; }
    var d = gumroadDataPage(doc);
    var props = (d && d.props) || {};
    var prod = props.product || {};
    if (!prod || typeof prod !== 'object') return [];
    var purchase = props.purchase || null;
    var cur = String(prod.currency_code || 'usd').toUpperCase();
    var base = Number(prod.price_cents) || 0;
    var options = Array.isArray(prod.options) ? prod.options : [];
    var contentUrl = purchase && purchase.content_url ? String(purchase.content_url) : '';
    var totalPd = purchase && purchase.total_price_including_tax_and_shipping
      ? derivePrice(purchase.total_price_including_tax_and_shipping) : { value: null };
    var totalCents = totalPd.value != null ? Math.round(totalPd.value * 100) : null;
    function priceOf(cents) { return App.priceText(cents / 100, cur); }
    var publicFiles = [];
    (Array.isArray(prod.public_files) ? prod.public_files : []).forEach(function (f) {
      if (!f || typeof f !== 'object') return;
      var u = f.url || f.download_url || '';
      if (!u) return;
      var ext = String(f.extension || '').replace(/^\./, '').toLowerCase();
      var name = String(f.file_name || f.name || '免费下载文件').replace(/\s+/g, ' ').trim();
      if (ext && name.toLowerCase().indexOf('.' + ext) !== name.length - ext.length - 1) name = name + '.' + ext;
      publicFiles.push({ name: name, url: u, size: Number(f.file_size || 0) || 0, source: 'public' });
    });
    // 实付价唯一匹配某变体 → 该变体视为已购买
    var matchCount = 0, matchedIdx = -1;
    if (totalCents != null) {
      options.forEach(function (o, i) {
        var cents = base + (Number(o.price_difference_cents) || 0);
        if (cents === totalCents) { matchCount++; if (matchedIdx < 0) matchedIdx = i; }
      });
    }
    var out = [];
    if (!options.length) {
      if (contentUrl) {
        out.push({
          name: prod.name || '（默认）', price: priceOf(base), orderUrl: contentUrl, variationId: '',
          special: false, files: [],
          orderPrice: purchase.total_price_including_tax_and_shipping || '',
          orderPriceValue: totalPd.value, orderPriceCurrency: totalPd.currency || cur
        });
      }
      if (publicFiles.length) {
        out.push({ name: prod.name || '免费下载', price: '0', orderUrl: '', variationId: '', special: true, files: publicFiles });
      }
      return out;
    }
    options.forEach(function (o, i) {
      var cents = base + (Number(o.price_difference_cents) || 0);
      var isFree = cents === 0 || /免费|free/i.test(String(o.name || ''));
      var purchased = !!contentUrl && ((totalCents != null && matchCount === 1 && i === matchedIdx) || (totalCents == null && options.length === 1));
      out.push({
        name: o.name || '（默认）',
        price: priceOf(cents),
        orderUrl: purchased ? contentUrl : '',
        variationId: String(o.id || ''),
        special: isFree && !purchased,   // 免费变体：未购买时按免费公开链接展示；购买后按已购版本保留下载页
        files: isFree ? publicFiles.slice() : [],
        orderPrice: purchased ? (purchase.total_price_including_tax_and_shipping || '') : '',
        orderPriceValue: purchased ? totalPd.value : null,
        orderPriceCurrency: purchased ? (totalPd.currency || cur) : ''
      });
    });
    return out;
  }

  /**
   * 解析 Gumroad 订单 / 下载页：content_items 就是该订单可下载的全部文件。
   * 返回结构与 BOOTH 订单解析对齐，好让「获取更新」与订单导入共用同一套回填逻辑。
   */
  function parseGumroadOrder(html) {
    var doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return []; }
    var d = gumroadDataPage(doc);
    var props = (d && d.props) || {};
    var content = props.content || {};
    var files = gumroadContentFiles(content);
    // 兜底：页面没有 data-page 时，从 /r/ 链接与 data-resource-id 按钮里收集
    if (!files.length && doc) {
      var seen = {};
      Array.prototype.forEach.call(doc.querySelectorAll('a[href*="/r/"], a.button[data-resource-id], button[data-resource-id]'), function (a) {
        var href = a.getAttribute('href') || '';
        var rid = a.getAttribute('data-resource-id') || '';
        if (!href && rid) href = '/r/' + rid;
        if (!href) return;
        if (href.indexOf('/r/') < 0) return;
        if (seen[href]) return;
        seen[href] = 1;
        var name = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120) || '下载文件';
        files.push({ name: name, url: href.indexOf('http') === 0 ? href : 'https://gumroad.com' + href, size: 0, source: 'order' });
      });
    }
    if (!files.length) return [];
    return [{
      title: props.title || '',
      downloads: files,
      orderVersions: { default: { files: files } },
      license: content.license || null
    }];
  }

  /** 按订单 URL 站点选择订单页解析器（BOOTH / Gumroad 通用入口） */
  function parseOrderPage(url, html) {
    if (/gumroad\.com/i.test(url || '')) return { site: 'gumroad', items: parseGumroadOrder(html) };
    return { site: 'booth', items: parseBoothOrder(html) };
  }

  /** 从 BOOTH 订单页导入：粘贴订单页源码（Ctrl+U / Ctrl+A 复制），或交给后端按 URL + Cookie 抓取 */
  function orderImportDialog() {
    var ta = el('textarea', { class: 'input textarea mono', rows: 10, placeholder: '在浏览器打开 https://accounts.booth.pm/orders/<订单号>，Ctrl+U 全选复制源码，粘贴到这里' });
    var urlIn = el('input', { class: 'input mono', value: 'https://accounts.booth.pm/orders/', placeholder: '订单页 URL（可选，配合已保存的 Cookie 自动抓取）' });
    var logBox = el('div', { class: 'fetch-log', style: { display: 'none' } });
    function log(m) { logBox.style.display = ''; logBox.appendChild(el('div', { class: 'log-line', text: m })); logBox.scrollTop = logBox.scrollHeight; }
    var busy = false;
    var importUrlBtn = null, importPasteBtn = null;
    function setBusy(v) {
      busy = v;
      if (importUrlBtn) { importUrlBtn.disabled = v; ICONS.apply(importUrlBtn, v ? '\u23F3 导入中 …' : ICONS.label('\u2B07 导入')); }
      if (importPasteBtn) { importPasteBtn.disabled = v; ICONS.apply(importPasteBtn, v ? '\u23F3 解析中 …' : ICONS.label('\u2714 解析粘贴的源码并导入')); }
    }

    function run(html, orderUrl, alreadyBusy) {
      if (!alreadyBusy && busy) return;
      var items = parseBoothOrder(html);
      log('解析到 ' + items.length + ' 个商品条目');
      if (!items.length) { Toast.err('没有解析到商品或下载文件'); setBusy(false); return; }
      var byKey = {};
      App.assets.forEach(function (a) {
        if (a.itemId) {
          byKey[a.source + ':' + a.itemId] = a;
          (a.sources || []).forEach(function (s) { byKey[s.source + ':' + a.itemId] = a; });
        }
        (a.links || []).forEach(function (l) { if (l.url) byKey['url:' + l.url] = a; });
      });
      var chain = Promise.resolve(), created = 0, updated = 0;
      items.forEach(function (it) {
        chain = chain.then(function () {
          var key = 'booth:' + it.itemId;
          var exist = byKey[key] || null;
          var a = exist || Store.normalizeAsset({ source: 'booth', importedFrom: 'order' });
          if (exist) updated++; else created++;
          a.itemId = it.itemId;
          if (!a.originalTitle && it.title) a.originalTitle = it.title;
          if (!a.title) a.title = String(it.title || '').slice(0, 80) || ('BOOTH ' + it.itemId);
          a.links = concatUnique(a.links || [], [{ url: 'https://booth.pm/ja/items/' + it.itemId, label: 'BOOTH 商品' }], function (l) { return l.url; });
          if (it.images && it.images.length) a.images = uniq((a.images || []).concat(it.images));
          if (!a.coverURL && a.images && a.images.length) a.coverURL = a.images[0];
          a.downloadLinks = concatUnique(a.downloadLinks || [], it.downloads.map(function (d) { return { url: d.url, label: d.name }; }), function (l) { return l.url; });
          // 版本/变体重构：名称 + 订单链接；一个 variation 一个版本，文件全部进 files[]（source=order）
          var keys = Object.keys(it.orderVersions || {});
          if (!keys.length && it.downloads.length) keys = ['default'];
          var orderVersions = keys.map(function (k, i) {
            var g = (it.orderVersions || {})[k] || { files: it.downloads };
            var files = (g.files || []).map(function (d) { return { name: d.name, url: d.url, size: d.size || 0, source: 'order' }; });
            var name = g.name || (keys.length === 1 ? String(it.title || '').slice(0, 60) : ('订单文件 ' + (i + 1)));
            return {
              id: 'ver_order_' + it.itemId + '_' + (g.variationId || k),
              name: name,
              fileName: files.length ? files[0].name : '',
              url: files.length ? files[0].url : '',
              orderUrl: orderUrl || '',
              size: files.reduce(function (s, f) { return s + (f.size || 0); }, 0),
              isLatest: i === keys.length - 1,
              files: files
            };
          });
          var oldIds = {};
          orderVersions.forEach(function (v) { oldIds[v.id] = 1; });
          a.versions = (a.versions || []).filter(function (v) { return !oldIds[v.id]; }).concat(orderVersions);
          log((exist ? '更新 ' : '新增 ') + (a.title || it.itemId) + '（' + orderVersions.length + ' 个版本 / ' + it.downloads.length + ' 个下载文件）');
          return App.save(a);
        });
      });
      return chain.then(function () {
        UI.renderAll();
        Toast.ok('订单导入完成：新增 ' + created + '，更新 ' + updated);
        log('—— 完成：新增 ' + created + '，更新 ' + updated + ' ——');
      }).catch(function (e) {
        log('\u2716 导入中断：' + (e && e.message));
        Toast.err('订单导入失败：' + (e && e.message));
      }).then(function () { setBusy(false); });
    }

    var h = Modal.open({
      title: '从 BOOTH 订单页导入（一个版本包含多个下载文件）', size: 'md',
      body: [
        el('div', { class: 'notice' }, [
          el('p', { text: '订单页通常一个商品含多个下载文件（新/旧版本混在一起）。此导入把它们归入一个「订单下载文件」版本，下载直链全部保留，不再按每文件拆成多个版本。' }),
          el('p', { text: '方式一（最稳）：在浏览器打开订单页 → Ctrl+U 全选复制源码 → 粘贴到下面。方式二：填写 URL，工具用你已保存的 booth.pm Cookie 经程序后端抓取。' })
        ]),
        Field.row('订单页 URL', urlIn),
        ta,
        logBox
      ],
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '关闭'),
        (importUrlBtn = el('button', {
          class: 'btn', onclick: function () {
            if (busy) return;
            var src = ta.value.trim();
            var orderUrl = urlIn.value.trim();
            if (src.length > 200) { setBusy(true); run(src, orderUrl, true); return; }
            var u = orderUrl;
            if (!isHttpUrl(u)) { Toast.warn('请粘贴订单页源码，或填写有效 URL'); return; }
            log('尝试经程序后端抓取订单页 …');
            setBusy(true);
            Net.fetchText(u, { forceNetwork: true, onLog: log }).then(function (r) {
              if (r && r.ok && r.text) return run(r.text, u, true);
              throw new Error((r && r.reason) || '未返回内容');
            }).catch(function (e) {
              Toast.err('抓取失败：' + (e && e.message) + '。请改用粘贴源码方式。');
              setBusy(false);
            });
          }
        }, ICONS.label('\u2B07 导入'))),
        (importPasteBtn = el('button', {
          class: 'btn btn-primary', onclick: function () { if (busy) return; setBusy(true); run(ta.value, urlIn.value.trim(), true); }
        }, ICONS.label('\u2714 解析粘贴的源码并导入')))
      ]
    });
  }

  /* 已购库同步：模块级锁 + 序号——关掉对话框后循环要尽快停，收尾也只清自己那把锁 */
  var syncRunning = false;
  var syncSeq = 0;

  function syncLibraryDialog() {
    var logBox = el('div', { class: 'fetch-log', style: { display: 'block' } });
    function log(m) { logBox.appendChild(el('div', { class: 'log-line', text: m })); logBox.scrollTop = logBox.scrollHeight; }
    var pagesIn = el('input', { class: 'input input-sm', type: 'number', min: 1, max: 50, value: 5 });
    var urlIn = el('input', { class: 'input mono', value: 'https://accounts.booth.pm/library' });

    var hostTip = el('span', { text: '程序后端：正在检测 …' });
    FS.hostEnsure().then(function (ok) { hostTip.textContent = ok ? '程序后端：\u2714 在线' : '程序后端：\u2716 离线'; });
    var hasCookie = Object.keys(App.settings.credentials || {}).some(function (h) {
      return /booth/.test(h) && App.settings.credentials[h].cookie;
    });

    var closed = false;
    var startBtn = el('button', { class: 'btn btn-primary', onclick: function () { run(); } }, ICONS.label('\u{1F504} 开始同步'));
    var h = Modal.open({
      title: '同步「我的已购素材」（BOOTH）', size: 'md',
      body: [
        el('div', { class: 'notice notice-warn' }, [
          el('b', { text: '前置条件' }),
          el('p', { text: '① 确认程序正常运行（程序后端随窗口启动，无需安装任何环境）；② 在「站点凭证」中保存 booth.pm 的 Cookie。Cookie 只会发给你自己机器上的程序后端。' }),
          el('p', {}, [hostTip, el('span', {}, '；booth.pm Cookie ' + (hasCookie ? '\u2714 已保存' : '\u2716 未保存'))]),
          el('p', { text: '若不想配置 Cookie，请改用「从用户脚本导入」，效果相同且更简单。' })
        ]),
        Field.row('库页面地址', urlIn, '购买记录：https://accounts.booth.pm/library ；获赠：https://accounts.booth.pm/library/gifts'),
        Field.row('抓取页数', pagesIn),
        logBox
      ],
      onClose: function () { closed = true; syncRunning = false; },
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '关闭'),
        startBtn
      ]
    });

    function run() {
      if (syncRunning) { log('\u26A0 同步正在进行中，请勿重复点击'); return; }
      var myRun = ++syncSeq;
      syncRunning = true;
      startBtn.disabled = true; ICONS.apply(startBtn, ('\u{23F3} 同步中 …'));
      var isGiftsPage = /\/gifts/.test(urlIn.value.trim());   // 获赠页 → 自动标记「获赠」
      var pages = Math.max(1, Math.min(50, +pagesIn.value || 5));
      var seenIds = {};
      var all = [];
      var page = 0;

      /* 逐页抓：空页或整页 itemId 都已抓过就停，别白翻到 50 页 */
      function nextPage() {
        if (closed || page >= pages) return Promise.resolve();
        page += 1;
        var base = urlIn.value.trim();
        var u = base + (base.indexOf('?') >= 0 ? '&' : '?') + 'page=' + page;
        log('\u23F3 抓取第 ' + page + ' 页 …');
        return Net.fetchText(u, { onLog: log }).then(function (r) {
          if (closed) return;
          if (!r.ok) { log('\u2716 第 ' + page + ' 页失败'); return nextPage(); }
          var items = parseBoothLibrary(r.text);
          log('\u2714 第 ' + page + ' 页解析到 ' + items.length + ' 项');
          if (!items.length) return;                       // 空页 = 已经翻到底
          var fresh = items.filter(function (x) { return x.itemId && !seenIds[x.itemId]; });
          items.forEach(function (x) { if (x.itemId) seenIds[x.itemId] = 1; });
          if (!fresh.length) { log('\u26A0 第 ' + page + ' 页全是抓过的条目，停止翻页'); return; }
          all = all.concat(fresh);
          return nextPage();
        });
      }

      nextPage().then(function () {
        if (closed) return;
        if (!all.length) { log('\u2716 未解析到任何商品。请确认 Cookie 有效、程序后端已启动。'); return; }
        log('共 ' + all.length + ' 项。开始逐个补全商品详情（版本 / 价格 / 全部下载链接）…');
        var enriched = [];
        var i = 0;
        function nextDetail() {
          if (closed || i >= all.length) return Promise.resolve();
          var it = all[i++];
          if (!it.itemId) { enriched.push(it); return nextDetail(); }
          var jsonURL = 'https://booth.pm/ja/items/' + it.itemId + '.json';
          return Net.fetchText(jsonURL, { onLog: function () {} }).then(function (r) {
            if (!r.ok) { enriched.push(it); return nextDetail(); }
            var d = safeJSON(r.text, null);
            if (!d || !d.name) { enriched.push(it); return nextDetail(); }
            var full = Fetchers.detect(jsonURL).parseJSON(d, jsonURL);
            // 合并：详情 JSON 拥有最终解释权（价格 / 版本 / 下载链接）
            var merged = {
              itemId: String(d.id || it.itemId),
              url: 'https://booth.pm/ja/items/' + (d.id || it.itemId),
              title: full.originalTitle || it.title,
              description: full.description || '',
              price: full.price || it.price || '',
              images: uniq((it.images || []).concat(full.images)),
              tags: full.tags || [],
              shop: full.shop || it.shop,
              shopUrl: full.shopUrl || it.shopUrl || '',
              category: full.category || '',
              categoryId: full.categoryId || '',
              publishedAt: full.publishedAt || it.publishedAt || '',
              shopUpdatedAt: full.shopUpdatedAt || it.shopUpdatedAt || '',
              r18: !!(full.r18 || it.r18),
              downloads: [],
              purchased: true,
              giftedReceived: isGiftsPage
            };
            var have = {};
            (it.downloads || []).forEach(function (x) { if (x.url) { have[x.url] = 1; merged.downloads.push(x); } });
            (full.downloadLinks || []).forEach(function (x) {
              if (x.url && !have[x.url]) { have[x.url] = 1; merged.downloads.push({ name: x.label || '', url: x.url }); }
            });
            // 把版本信息也带进 downloads，导入时自动归并成「版本」
            (full.versions || []).forEach(function (v) {
              if (v.url && !have[v.url]) {
                have[v.url] = 1;
                merged.downloads.push({ name: v.fileName || v.name || '', url: v.url, size: v.size || 0 });
              }
            });
            if (i % 5 === 0 || i === all.length) log('已补全 ' + i + ' / ' + all.length);
            enriched.push(merged);
            return nextDetail();
          }).catch(function () { enriched.push(it); return nextDetail(); });
        }
        return nextDetail().then(function () {
          if (closed) return;
          var withDL = enriched.filter(function (x) { return (x.downloads || []).length; }).length;
          log('\u2714 详情补全完成：' + enriched.length + ' 项，其中 ' + withDL + ' 项带下载直链');
          return importBridgeJSON({ site: 'booth', items: enriched }, { onLog: log }).then(function (r) {
            Toast.ok('同步完成：新增 ' + r.created + ' 项，更新 ' + r.updated + ' 项');
          });
        });
      }).catch(function (e) { log('\u2716 同步失败：' + (e.message || e)); })
        .then(function () {
          if (syncSeq === myRun) syncRunning = false;   // 关了对话框又重开时，别把新那把锁清掉
          startBtn.disabled = false; ICONS.apply(startBtn, ('\u{1F504} 开始同步'));
        });
    }
  }

  /**
   * 统一入口：只创建存储路径（分类/素材文件夹）并打开资源管理器，不搬任何文件。
   * 后端在线时按配置路径字符串精确创建；离线时用浏览器句柄创建并校验根名一致。
   */
  function createStoragePathOnly(asset, pathEditor, dialogOpts) {
    dialogOpts = dialogOpts || {};
    function prepare() { if (dialogOpts.prepare) { try { dialogOpts.prepare(); } catch (e) { console.warn('同步表单失败', e); } } }
    function persist() {
      if (!dialogOpts.persist) return Promise.resolve(false);
      return Promise.resolve().then(function () { return dialogOpts.persist(); }).catch(function (e) {
        console.warn('自动保存失败', e); return false;
      });
    }
    function finish(folderPath) {
      setPathEntry(asset, folderPath, '存储路径');
      try { pathEditor.setValue(asset.paths); } catch (e) {}
      return persist().then(function (saved) {
        FS.openPath(folderPath);
        Toast.ok('存储路径已创建并写入' + (saved ? '（素材已自动保存）' : '') + '，请在资源管理器里自行移动文件进去');
      });
    }
    prepare();
    var cat = App.categoryLabel(asset.category || 'other');
    var rel = cat + '\\' + App.folderName(asset);
    var folderPath = joinWinPath(App.libraryRoot(), [rel]);   // 推导自应用目录，不写死路径
    return FS.mkdirPath(folderPath).then(function (hostCreated) {
      if (hostCreated) return finish(folderPath);
      return FS.getLibraryRoot().then(function (root) {
        if (!root) return FS.setLibraryRoot();
        return root;
      }).then(async function (root) {
        if (!root) { Toast.warn('需要先选择素材库根目录'); return; }
        var rootLast = String(folderPath.replace(/[\\/]+$/, '').split('\\').pop() || '').toLowerCase();
        var handleName = String(root.name || '').toLowerCase();
        if (rootLast && handleName && rootLast !== handleName) {
          Toast.err('素材库根目录句柄（' + root.name + '）与配置路径（' + rootLast + '）不一致。请在「设置 → 本地库与整理」统一后再试。', 7800);
          return;
        }
        await FS.ensurePermission(root, 'readwrite');
        await root.getDirectoryHandle(cat, { create: true });
        var catDir = await root.getDirectoryHandle(cat, { create: true });
        await catDir.getDirectoryHandle(App.folderName(asset), { create: true });
        return finish(folderPath);
      });
    }).catch(function (e) { console.error(e); Toast.err('创建存储路径失败：' + (e && e.message)); });
  }

  /** 编辑素材时：导入已有文件/文件夹到素材库，并回填可打开的路径 */
  function attachLocalDialog(asset, pathEditor, dialogOpts) {
    dialogOpts = dialogOpts || {};
    var logBox = el('div', { class: 'fetch-log', style: { display: 'none' } });
    function log(m) { logBox.style.display = ''; logBox.appendChild(el('div', { class: 'log-line', text: m })); logBox.scrollTop = logBox.scrollHeight; }
    function prepare() {
      if (dialogOpts.prepare) { try { dialogOpts.prepare(); } catch (e) { console.warn('导入前同步表单失败', e); } }
    }
    function persistPaths() {
      if (!dialogOpts.persist) return Promise.resolve(false);
      return Promise.resolve().then(function () { return dialogOpts.persist(); }).catch(function (e) {
        console.warn('导入后自动保存失败', e);
        return false;
      });
    }

    function rootAbs(rel) {
      return joinWinPath(App.libraryRoot(), [rel]);   // 推导自应用目录，不写死路径
    }
    function ensureAssetDir(rootHandle, catLabel, title) {
      var safe = App.folderName(asset);
      return rootHandle.getDirectoryHandle(catLabel, { create: true })
        .then(function (catDir) { return catDir.getDirectoryHandle(safe, { create: true }); });
    }
    async function copyFileTo(fh, file, dirHandle) {
      var fh2 = await dirHandle.getFileHandle(file.name, { create: true });
      var w = await fh2.createWritable();
      await w.write(await file.arrayBuffer()); await w.close();
      return fh2;
    }

    var lastDirP = Store.kvGet('lastImportDirHandle', null);
    function importFilesBrowser() {
      if (!window.showOpenFilePicker) { Toast.err('当前浏览器不支持文件选择，请用 Chrome/Edge'); return; }
      lastDirP.then(function (startIn) {
        var opts = { multiple: true };
        if (startIn) {
          return FS.ensurePermission(startIn, 'read').then(function (ok) {
            if (ok) opts.startIn = startIn;
            return window.showOpenFilePicker(opts);
          });
        }
        return window.showOpenFilePicker(opts);
      }).then(async function (handles) {
        prepare();
        var root = await FS.getLibraryRoot();
        if (!root) { root = await FS.setLibraryRoot(); }
        if (!root) { Toast.warn('需要先选择素材库根目录'); return; }
        await FS.ensurePermission(root, 'readwrite');
        var cat = App.categoryLabel(asset.category || 'other');
        var safeTitle = App.folderName(asset);
        var dst = await ensureAssetDir(root, cat, asset.title || '素材');
        var added = [], ok = 0, fail = 0;
        for (var h of handles) {
          try {
            var file = await h.getFile();
            var moved = await tryMoveEntry(h, dst);
            if (moved) { log('已移动：' + file.name); ok++; }
            else if (!App.settings.importMoveInsteadOfCopy) { await copyFileTo(null, file, dst); log('已复制：' + file.name); ok++; }
            else { fail++; log('\u26A0 移动失败，已跳过（不复制）：' + file.name); }
          } catch (e) { fail++; log('导入失败：' + (e && e.message)); }
        }
        if (ok) {
          var folderPath = rootAbs(cat + '\\' + safeTitle);
          setPathEntry(asset, folderPath, '存储路径');
          try { pathEditor.setValue(asset.paths); } catch (e) {}
          persistPaths().then(function (saved) {
            log('—— 导入完成：成功 ' + ok + ' 个，失败 ' + fail + ' 个；已写入存储路径 1 条' + (saved ? '；已自动保存素材，路径已生效' : '') + ' ——');
            Toast.ok('已导入 ' + ok + ' 个文件' + (fail ? '，' + fail + ' 个失败' : '') + (saved ? '；素材已自动保存' : ''));
          });
        } else Toast.err('导入失败');
      }).catch(function (e) { if (e && e.name !== 'AbortError') { console.error(e); Toast.err('导入失败：' + (e.message || e)); } });
    }

    function importFolderBrowser() {
      lastDirP.then(function (startIn) {
        return FS.pickDirectory('vrc-attach-dir').then(function (r) {
          if (r) Store.kvSet('lastImportDirHandle', r.handle);
          return r;
        });
      }).then(async function (r) {
        if (!r) return;
        prepare();
        var root = await FS.getLibraryRoot();
        if (!root) { root = await FS.setLibraryRoot(); }
        if (!root) { Toast.warn('需要先选择素材库根目录'); return; }
        await FS.ensurePermission(root, 'readwrite');
        var cat = App.categoryLabel(asset.category || 'other');
        var dst = await ensureAssetDir(root, cat, asset.title || '素材');
        var rel = cat + '\\' + App.folderName(asset);
        var dstAbs = rootAbs(rel);
        log('正在导入文件夹内容（' + (App.settings.importMoveInsteadOfCopy ? '移动' : '复制') + '模式，仅处理顶层项：' + r.name + '）…');
        await importTopLevelEntries(r.handle, dst, log, { dstAbs: dstAbs });
        var folderEntry = { path: dstAbs, note: '存储路径' };
        setPathEntry(asset, folderEntry.path, folderEntry.note);
        try { pathEditor.setValue(asset.paths); } catch (e) {}
        persistPaths().then(function (saved) {
          log('—— 导入完成：已写入路径 ' + rootAbs(rel) + (saved ? '；已自动保存素材，路径已生效' : '') + ' ——');
          Toast.ok('文件夹内容已导入素材库并写入路径' + (saved ? '；素材已自动保存' : ''));
        });
      }).catch(function (e) { if (e && e.name !== 'AbortError') { console.error(e); Toast.err('导入失败：' + (e.message || e)); } });
    }

    function importFiles() { return importFilesBrowser(); }
    function importFolder() { return importFolderBrowser(); }

    var h = Modal.open({
      title: '导入已有文件 / 文件夹', size: 'md',
      body: [
        el('div', { class: 'notice' }, [
          el('p', { text: '文件/文件夹会按下方开关选择的默认方式导入到素材库根目录下的「分类 / 素材名」中，并把可打开的绝对路径写入「本地文件路径」。移动模式失败会跳过该项（不复制）；复制模式始终复制。' }),
          el('p', { text: '规则：① 素材已有的商店链接、封面等信息不会被文件夹内容覆盖；② 文件夹内所有文件和子文件夹原样导入，不自动拆分版本，版本由你后续自行管理。' })
        ]),
        el('div', { class: 'btn-row' }, [
          el('button', { class: 'btn btn-primary', onclick: importFiles }, ICONS.label('\u{1F4C4} 选择文件（可多选）')),
          el('button', { class: 'btn btn-primary', onclick: importFolder }, ICONS.label('\u{1F4C2} 选择文件夹'))
        ]),
        (function () {
          var cb = el('input', { type: 'checkbox', checked: !!App.settings.importMoveInsteadOfCopy, onchange: function () {
            App.settings.importMoveInsteadOfCopy = cb.checked; App.saveSettings();
          } });
          return el('label', { class: 'check check-row' }, [cb, el('span', { text: '默认「移动」而非「复制」（移动失败跳过，不复制）' })]);
        })(),
        logBox
      ],
      footer: [el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '关闭')]
    });
  }

  /** 编辑素材时的拖拽快速导入（文件 / 文件夹） */
  function attachDropped(asset, pathEditor, dt, dropOpts) {
    dropOpts = dropOpts || {};
    var items = [];
    if (dt && dt.items) {
      Array.prototype.forEach.call(dt.items, function (item) {
        if (item.kind === 'file') items.push(item);
      });
    }
    if (!items.length) {
      console.warn('拖拽导入：没有找到文件项（DataTransfer.items 为空或没有 kind=file）');
      Toast.warn('没有可导入的文件；如果拖入的是文件夹且浏览器不支持，请改用「导入已有文件 / 文件夹」按钮');
      return Promise.resolve();
    }
    function prepare() {
      if (dropOpts.prepare) { try { dropOpts.prepare(); } catch (e) { console.warn('拖拽导入前同步表单失败', e); } }
    }
    function persistPaths() {
      if (!dropOpts.persist) return Promise.resolve(false);
      return Promise.resolve().then(function () { return dropOpts.persist(); }).catch(function (e) {
        console.warn('拖拽导入后自动保存失败', e);
        return false;
      });
    }
    function readAll(reader) {
      return new Promise(function (res, rej) {
        var out = [];
        (function next() {
          reader.readEntries(function (batch) {
            if (!batch.length) { res(out); return; }
            out = out.concat(Array.prototype.slice.call(batch));
            next();
          }, rej);
        })();
      });
    }
    // webkitGetAsEntry 这条降级路径只在不支持 getAsFileSystemHandle 的环境才会走到
    async function collectLegacyDir(entry, rel) {
      var reader = entry.createReader();
      var list = await readAll(reader);
      var files = [];
      for (var e of list) {
        if (e.isFile) {
          var f = await new Promise(function (res, rej) { e.file(res, rej); });
          files.push({ file: f, rel: rel ? rel + '/' + e.name : e.name });
        } else if (e.isDirectory) {
          files = files.concat(await collectLegacyDir(e, rel ? rel + '/' + e.name : e.name));
        }
      }
      return files;
    }
    /**
     * 解析一个 DataTransferItem：先试 getAsFileSystemHandle，再退 webkitGetAsEntry 和 getAsFile。
     * webkitGetAsEntry 必须同步调用，drop 事件之后异步调会返回 null，所以先取好。
     */
    async function itemToData(item) {
      var entry = null;
      try { entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null; } catch (e) { console.warn('webkitGetAsEntry 调用失败', e); }
      if (item.getAsFileSystemHandle) {
        try {
          var handle = await item.getAsFileSystemHandle();
          if (handle && handle.kind === 'file') {
            var f = await handle.getFile();
            return { file: f, handle: handle, rel: f.name, isDir: false };
          }
          if (handle && handle.kind === 'directory') {
            // 不递归收集：移动/复制都只处理该文件夹的顶层项
            return { rel: handle.name, handle: handle, files: [], isDir: true };
          }
          if (handle) console.warn('拖拽导入：未知的文件系统句柄类型', handle.kind);
        } catch (e) { console.warn('getAsFileSystemHandle 失败，回退旧接口', e); }
      }
      if (entry && entry.isFile) {
        var lf = await new Promise(function (res, rej) { entry.file(res, rej); });
        return { file: lf, rel: lf.name, isDir: false };
      }
      if (entry && entry.isDirectory) {
        var lfiles = await collectLegacyDir(entry, entry.name);
        return { rel: entry.name, files: lfiles, isDir: true };
      }
      // 最终降级：没有目录结构信息，但至少能拿到文件本体（例如无 handle 环境的普通文件拖入）
      if (item.getAsFile) {
        try {
          var gf = item.getAsFile();
          if (gf) return { file: gf, rel: gf.name, isDir: false };
        } catch (e) { console.warn('getAsFile 失败', e); }
      }
      console.warn('拖拽导入：无法解析该拖入项，将跳过', item);
      return null;
    }
    return Promise.all(items.map(itemToData)).then(async function (resolved) {
      var valid = resolved.filter(Boolean);
      if (!valid.length) {
        Toast.err('拖拽导入失败：浏览器没有提供可读取的文件句柄，请改用「导入已有文件 / 文件夹」按钮');
        return;
      }
      // 移动模式下，在同一个用户手势内一次性补全所有源句柄的读写权限：
      // 否则先处理文件夹会消耗掉手势，后面的独立文件永远拿不到授权而移动失败。
      if (App.settings.importMoveInsteadOfCopy) {
        await Promise.all(valid.map(function (it) {
          var h = it.handle;
          if (!h || typeof h.queryPermission !== 'function') return Promise.resolve();
          return h.queryPermission({ mode: 'readwrite' }).then(function (st) {
            if (st === 'granted') return true;
            return h.requestPermission({ mode: 'readwrite' }).then(function () { return true; }, function () { return false; });
          }, function () { return false; });
        }));
      }
      prepare();
      var root = await FS.getLibraryRoot();
      if (!root) { root = await FS.setLibraryRoot(); }
      if (!root) { Toast.warn('需要先选择素材库根目录'); return; }
      var canWrite = await FS.ensurePermission(root, 'readwrite');
      if (!canWrite) {
        Toast.err('拖拽导入失败：未获得素材库目录的写入权限，请在「设置 → 本地库目录」重新选择并授权');
        return;
      }
      var cat = App.categoryLabel(asset.category || 'other');
      var safeTitle = App.folderName(asset);
      var catDir, dst;
      try {
        catDir = await root.getDirectoryHandle(cat, { create: true });
        dst = await catDir.getDirectoryHandle(safeTitle, { create: true });
      } catch (e) {
        console.error('拖拽导入：创建素材目录失败', cat, safeTitle, e);
        Toast.err('拖拽导入失败：无法创建素材目录（' + (e && e.message ? e.message : e) + '）');
        return;
      }
      var added = [], okFiles = 0, failFiles = 0;
      /* 导进来的文件名要登记：详情页「本地文件」靠 downloadedFiles 认「这是本体」。
       * 不登记的话，导入完的文件会被当成「磁盘上多出来的」，一扫描就被划成 DLC。 */
      var importedNames = [];
      var folderPath = absPath([cat, safeTitle]);
      function absPath(parts) {
        return joinWinPath(App.libraryRoot(), parts);   // 推导自应用目录，不写死路径
      }
      async function writeFile(f, dir) {
        var fh = await dir.getFileHandle(f.name, { create: true });
        var w = await fh.createWritable();
        await w.write(await f.arrayBuffer()); await w.close();
      }
      // 拖入的内容按整项搬，绝不递归：
      // 单个文件夹 → 只搬它的顶层子项；多选或直接拖文件 → 每项原样整项搬。
      var singleFolderOnly = valid.length === 1 && valid[0].isDir && valid[0].handle && typeof valid[0].handle.values === 'function';
      for (var it of valid) {
        try {
          if (singleFolderOnly) {
            var counter = await importTopLevelEntries(it.handle, dst, function (m) {
              if (String(m).indexOf('目录整项移动') >= 0) return;   // 目录整项移动浏览器做不到，这类提示直接吞掉
              console.warn('拖拽导入：' + m);
            });
            okFiles += counter.moved + counter.copied;
            failFiles += counter.failed || 0;
            importedNames = importedNames.concat(counter.names || []);
            continue;
          }
          if (!it.isDir) {
            var movedSingle = await tryMoveEntry(it.handle, dst);
            if (movedSingle) { okFiles++; importedNames.push(it.file ? it.file.name : it.rel); }
            else if (!App.settings.importMoveInsteadOfCopy) {
              await writeFile(it.file, dst); okFiles++;
              importedNames.push(it.file.name);
            }
            else { failFiles++; console.warn('拖拽导入：移动失败，已跳过（不复制）', it.rel); }
          } else if (it.handle) {
            // 文件夹作为整体搬：移动模式下做不到就跳过，复制模式整项复制
            if (App.settings.importMoveInsteadOfCopy) {
              var movedDir = await tryMoveEntry(it.handle, dst);
              if (movedDir) { okFiles++; }
              else { failFiles++; }
            } else {
              try {
                var dirCopy = { copied: 0 };
                var sub = await dst.getDirectoryHandle(it.handle.name, { create: true });
                await copyTreeInto(it.handle, sub, dirCopy);
                okFiles += dirCopy.copied;
                console.warn('拖拽导入：已复制文件夹：' + it.rel);
              } catch (eCopy) { failFiles++; console.warn('拖拽导入：复制文件夹失败', eCopy); }
            }
          } else if (App.settings.importMoveInsteadOfCopy) {
            // 这条路径上的目录没有句柄，整项移动做不到，只能跳过
            failFiles += (it.files && it.files.length) || 1;
            console.warn('拖拽导入：文件夹句柄不可用，移动模式已跳过（不复制）', it.rel);
          } else {
            // 没有句柄的目录：只能按已收集到的文件逐个复制
            var copiedLegacy = 0;
            for (var f of it.files) {
              var parts = f.rel.split('/');
              var d = dst;
              for (var i = 1; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i], { create: true });
              await writeFile(f.file, d);
              copiedLegacy++;
            }
            okFiles += copiedLegacy;
          }
        } catch (e) { failFiles++; console.warn('拖拽导入单项失败', e); }
      }
      if (!okFiles) {
        Toast.err('拖拽导入失败' + (failFiles ? '：' + failFiles + ' 个文件未能导入' : ''));
        return;
      }
      setPathEntry(asset, folderPath, '存储路径');
      if (importedNames.length) {
        /* 记进 downloadedFiles：既让详情页认出「这是本体」，也让下载按钮立刻显示「重新下载」 */
        asset.downloadedFiles = uniq((asset.downloadedFiles || []).concat(importedNames.filter(Boolean)));
        asset.downloaded = true;
        if (!asset.downloadedAt) asset.downloadedAt = nowISO();
      }
      try {
        pathEditor.setValue(asset.paths);
      } catch (e) { console.warn('路径登记失败', e); }
      persistPaths().then(function (saved) {
        Toast.ok('拖拽导入完成：' + okFiles + ' 个文件' + (failFiles ? '，' + failFiles + ' 个失败' : '') + (saved ? '；素材已自动保存，路径已生效' : ''));
      });
    }).catch(function (e) {
      console.error('拖拽导入异常', e, e && e.stack);
      Toast.err('拖拽导入异常：' + (e && e.message ? e.message : e));
    });
  }

  /**
   * BOOTH 素材没有任何带订单链接的版本时补一次：商品页 → 商品 HTML（认已购 / 未购变体）
   * → 已购订单页的下载文件。成功后打 autoFilled.versions 避免每次打开都重抓；404/410 记已下架。
   */
  var autoEnrichBusy = false;

  /* ---------------- 自动补全的限流 ----------------
   * 「打开详情 / 编辑页就自己联网」这条路上，一个商品要 1 次 JSON + 1 次商品页 HTML + N 次订单页。
   * 更糟的是失败时不会锁（autoFilled.versions 没写上），于是每开一次详情就整轮重跑 ——
   * 反复点开几十次就是几十轮请求，很容易被 BOOTH 当爬虫。四层约束：
   *   ① 开关：设置里可以整体关掉自动补全；
   *   ② Cookie：目标站没存 Cookie 就不跑 —— 读不到订单页，商品页那几次请求纯属浪费；
   *   ③ 冷却：同一条素材自动补全失败后逐次翻倍（20 分钟 → 40 → 80 … 最长 6 小时）；
   *   ④ 排队：两次自动补全之间至少隔 4 秒，不会并发。
   * 手动按钮（强制联网填充 / 重新解析 / 批量）不受这里约束，那是用户明确要求的。
   */
  var AUTO_TRY_LS = 'vrclib.autoEnrich.tried.v1';
  var AUTO_COOLDOWN_MS = 20 * 60 * 1000;
  var AUTO_COOLDOWN_MAX = 6 * 60 * 60 * 1000;
  var AUTO_GAP_MS = 4000;
  var autoLastAt = 0;

  function autoTriedMap() {
    try {
      var m = JSON.parse(localStorage.getItem(AUTO_TRY_LS) || '{}');
      return (m && typeof m === 'object') ? m : {};
    } catch (e) { return {}; }
  }
  function autoTriedSave(m) {
    try {
      var keys = Object.keys(m);
      if (keys.length > 300) {                       // 这张表不该无限长
        keys.sort(function (x, y) { return (m[x].at || 0) - (m[y].at || 0); });
        keys.slice(0, keys.length - 300).forEach(function (k) { delete m[k]; });
      }
      localStorage.setItem(AUTO_TRY_LS, JSON.stringify(m));
    } catch (e) {}
  }
  function autoUrlOf(a) {
    var link = (a.links || []).map(function (l) { return String((l && l.url) || '').trim(); }).filter(isHttpUrl)[0] || '';
    if (link) return link;
    var iid = String(a.itemId || '').trim();
    if (!iid) return '';
    return (a.source === 'gumroad' ? 'https://gumroad.com/l/' : 'https://booth.pm/ja/items/') + iid;
  }
  /** 这条素材现在能不能自动补全。why 只用于调试日志，不弹给用户。 */
  function autoEnrichGate(a, opts) {
    opts = opts || {};
    if (!a || !a.id) return { ok: false, why: 'no-asset' };
    if (!opts.ignoreSetting && App.settings.autoVariantFetch === false) return { ok: false, why: 'off' };
    var probe = autoUrlOf(a);
    if (!probe) return { ok: false, why: 'no-url' };
    if (!Fetchers.hasCred(probe)) return { ok: false, why: 'no-cookie' };
    var rec = autoTriedMap()[a.id];
    var at = (rec && typeof rec === 'object') ? (Number(rec.at) || 0) : (Number(rec) || 0);
    var n = (rec && typeof rec === 'object') ? (Number(rec.n) || 1) : 1;
    var cool = Math.min(AUTO_COOLDOWN_MS * Math.pow(2, Math.max(0, n - 1)), AUTO_COOLDOWN_MAX);
    if (at && Date.now() - at < cool) return { ok: false, why: 'cooldown', retryAt: at + cool, tries: n };
    return { ok: true };
  }
  /* ---------------- 导入时按「名字里的商品编号」解析 ----------------
   * 下载下来的素材常常是 `[5058951]-オフショルケーブルニットワンピース` 或者纯数字目录，
   * 编号本身就把商品页指出来了，没必要让用户再手动粘一遍链接。导入完成后按编号抓一次
   * 商品页，等价于在详情页「解析并补充」里填 ID 点按钮 —— 但静默、串行、带间隔。
   *
   * 与上面的 autoEnrichBoothAsset 分工不同：那个补「版本与变体」，要 Cookie 与冷却；
   * 这里只抓公开商品页补标题 / 标签 / 图集 / 价格这些，导入是用户主动发起的，不吃冷却。
   * 仍然限流：一次导入几十项时，1.2~1.8 秒的随机间隔，别把站点打急。 */
  var PARSE_GAP_MS = 1200;
  var parseBusyUntil = 0;

  function parseGapWait() {
    var now = Date.now();
    var wait = Math.max(0, parseBusyUntil - now) + (PARSE_GAP_MS + Math.random() * 600);
    parseBusyUntil = now + wait;
    return wait;
  }

  /** 按商品编号解析一次并补进素材。永不 reject（导入不能因为联网失败变红），
   *  返回 { ok, changed:[] , reason }。 */
  function autoParseBoothById(asset, id) {
    if (!asset || !id) return Promise.resolve({ ok: false, reason: 'no-id' });
    if (App.settings && App.settings.autoParseOnImport === false) return Promise.resolve({ ok: false, reason: 'off' });
    var url = 'https://booth.pm/ja/items/' + String(id).replace(/[^\d]/g, '');
    if (!/\/items\/\d+$/.test(url)) return Promise.resolve({ ok: false, reason: 'bad-id' });

    return new Promise(function (r) { setTimeout(r, parseGapWait()); }).then(function () {
      return Fetchers.fetchInfoTimed(url, { forceNetwork: true, noCache: true }, 12000);
    }).then(function (info) {
      if (!info || info.__failed) return { ok: false, reason: (info && info.reason) || 'fetch-failed' };
      /* 拿回来的必须是同一个商品：编号写错 / 已下架时，页面可能是别的商品或 404 壳页，
       * 把它的标题写进来等于把这条素材变成另一个商品。 */
      var gotId = String(info.itemId || '').trim();
      if (gotId && gotId !== String(id)) return { ok: false, reason: 'id-mismatch' };
      if (!info.originalTitle || /(^|\s)(404|not found|page not found|不存在)(\s|$)/i.test(info.originalTitle)) {
        return { ok: false, reason: 'not-found' };
      }
      var before = null;
      try { before = JSON.parse(JSON.stringify(asset)); } catch (e) { before = null; }
      var res = { changed: [] };
      try { res = Tools.applyShopInfo(asset, info, false) || res; } catch (e) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[import] 合并商品信息失败：' + ((e && e.message) || e));
      }
      /* 商品页链接补一条：详情页「链接」里能直接点开，下次重新解析也有落点 */
      if (!asset.links) asset.links = [];
      var hasLink = asset.links.some(function (l) {
        return String((l && l.url) || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase() === url.toLowerCase();
      });
      if (!hasLink) asset.links.push({ url: url, label: (info.shop || 'BOOTH 商品') });
      if (!asset.itemId) asset.itemId = String(id);
      if (!asset.source || asset.source === 'other') asset.source = 'booth';

      return App.save(asset, { prev: before || undefined }).then(function (saved) {
        return { ok: true, asset: saved || asset, changed: (res && res.changed) || [] };
      });
    }).catch(function (e) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[import] 自动解析失败（' + id + '）：' + ((e && e.message) || e));
      return { ok: false, reason: (e && e.message) || String(e) };
    });
  }

  /** 记一次「试过了」。要在发请求之前调：中途失败也算试过，否则一关一开就重来。 */
  function markAutoTried(id) {    if (!id) return;
    var m = autoTriedMap();
    var rec = m[id];
    var n = ((rec && typeof rec === 'object') ? (Number(rec.n) || 0) : (rec ? 1 : 0)) + 1;
    m[id] = { at: Date.now(), n: n };
    autoTriedSave(m);
  }
  function clearAutoTried(id) {
    var m = autoTriedMap();
    if (!m[id]) return;
    delete m[id];
    autoTriedSave(m);
  }
  /** 排队取一个发送空位：两次自动补全之间至少隔 AUTO_GAP_MS */
  function takeAutoSlot() {
    var now = Date.now();
    var gap = Math.max(0, autoLastAt + AUTO_GAP_MS - now);
    autoLastAt = now + gap;
    return gap ? new Promise(function (r) { setTimeout(r, gap); }) : Promise.resolve();
  }

  function autoEnrichBoothAsset(a) {
    if (!a || a.source !== 'booth' || a.delisted) return Promise.resolve(a);
    // 免费素材没有「已购变体」可补；「未购买」不算免费 —— 它的 0 只是没有已购变体，
    // 否则这类素材永远补不上变体与价格
    if (App.purchaseState(a) !== 'unpurchased' && (a.isFree === true || ((App.effectivePrice(a) || {}).value === 0))) return Promise.resolve(a);
    if (a.autoFilled && a.autoFilled.versions) return Promise.resolve(a);
    var hasOrderVersion = (a.versions || []).some(function (v) { return v.orderUrl && v.orderUrl.trim() && !v.special; });
    if (hasOrderVersion) return Promise.resolve(a);
    var url = (a.links || []).filter(function (l) { return isHttpUrl(l.url); })[0];
    var itemUrl = url ? url.url : (a.itemId ? 'https://booth.pm/ja/items/' + a.itemId : '');
    if (!itemUrl) return Promise.resolve(a);
    var gate = autoEnrichGate(a);
    if (!gate.ok) return Promise.resolve(a);        // 关掉了 / 没 Cookie / 还在冷却
    autoEnrichBusy = true;
    markAutoTried(a.id);

    return takeAutoSlot().then(function () {
      return Fetchers.fetchInfo(itemUrl, { forceNetwork: true, noCache: false });
    }).then(function (info) {
      if (!info || info.__failed) {
        var tried = (info && info.tried) || [];
        var gone = (info && (info.status === 404 || info.status === 410)) || tried.some(function (t) { return t && /HTTP (404|410)\b/.test(String(t.error || '')); });
        if (gone) { a.delisted = true; return App.save(a); }
        return a;
      }
      /* 必须是这条素材自己的商品页：拿到别的商品的数据，标题 / 封面 / 店铺就会写串，
       * 表现成「详情页变成另一个商品」，所以对不上就放弃本次补全。 */
      var gotId = String(info.itemId || '').trim();
      var myId = String(a.itemId || '').trim();
      if (gotId && myId && gotId !== myId) {
        console.warn('[enrich] 商品页 ID 与素材不符，已跳过补全：' + myId + ' ≠ ' + gotId);
        return a;
      }
      var step = Promise.resolve(info);
      step = Net.fetchText(itemUrl, { forceNetwork: true, onLog: function () {} }).then(function (r) {
        if (!r || !r.ok || !r.text) return info;
        var ov = parseBoothItemOrderLinks(r.text);
        if (!ov.length) return info;
        info.orderVersions = ov;
        var purchased = ov.filter(function (o) { return o.orderUrl && !o.special; });
        if (!purchased.length) return info;
        var orderUrls = uniq(purchased.map(function (o) { return o.orderUrl; }).filter(Boolean));
        return Promise.all(orderUrls.map(function (orderUrl) {
          return Net.fetchText(orderUrl, { forceNetwork: true, onLog: function () {} }).then(function (rr) {
            if (!rr || !rr.ok || !rr.text) return null;
            var items = parseBoothOrder(rr.text);
            if (!items.length) return null;
            return items.find(function (x) { return String(x.itemId) === String(info.itemId || a.itemId || ''); }) || items[0];
          }).catch(function () { return null; });
        })).then(function (orders) {
          orders.forEach(function (it, idx) {
            if (!it) return;
            // 与 70-forms.js doFetch 一致：一个订单页可能对应多个已购变体，
            // 文件按 variationId 回填到各自变体；订单总价按该订单内匹配到的变体数均分。
            var orderUrl = orderUrls[idx];
            var candidates = purchased.filter(function (o) { return o.orderUrl === orderUrl; });
            if (!candidates.length) candidates = purchased.length ? [purchased[0]] : [];
            var matched = candidates.filter(function (o) { return (it.orderVersions || {})[o.variationId]; });
            var targets = matched.length ? matched : (candidates.length ? [candidates[0]] : []);
            // 整单均分只是兜底：订单页给了该变体行自己的价格就用它
            var share = null;
            if (targets.length && it.orderPriceValue != null) {
              share = Math.round((it.orderPriceValue / targets.length) * 100) / 100;
            }
            targets.forEach(function (o) {
              var g = (it.orderVersions || {})[o.variationId] || (it.orderVersions || {}).default;
              if (g && g.files && g.files.length) o.files = g.files;
              if (g && g.rowPriceValue != null) {
                o.orderPrice = g.rowPrice || '';
                o.orderPriceValue = Number(g.rowPriceValue);
                o.orderPriceCurrency = g.rowPriceCurrency || it.orderPriceCurrency || '';
              } else if (share != null) {
                o.orderPrice = it.orderPrice || '';
                o.orderPriceValue = share;
                o.orderPriceCurrency = it.orderPriceCurrency || '';
              }
            });
          });
          return info;
        });
      }).catch(function () { return info; });

      return step.then(function (info2) {
        a.autoFilled = a.autoFilled || {};
        // 版本合并：只清旧的无订单链接版本；许可证/readme 特殊变体保留并标记免费
        var ovs = Array.isArray(info2.orderVersions) && info2.orderVersions.length ? info2.orderVersions : [];
        if (ovs.length) {
          var incoming = ovs.map(function (o, i) {
            var files = (o.files || []).map(function (f) { return { name: f.name, url: f.url, size: f.size || 0, source: o.special ? 'public' : 'order' }; });
            return {
              id: 'ver_order_' + (o.variationId || o.name || i) + '_' + Date.now().toString(36),
              name: o.name || '（默认）',
              variationId: o.variationId || '',
              orderUrl: o.orderUrl || '',
              price: o.special ? '0' : (o.price || ''),
              purchasePrice: (o.orderPriceValue != null && isFinite(Number(o.orderPriceValue))) ? Number(o.orderPriceValue) : null,
              purchaseCurrency: o.orderPriceCurrency || '',
              special: !!o.special,
              isLatest: false,
              fileName: files.length ? files[0].name : '',
              url: files.length ? files[0].url : '',
              size: files.reduce(function (s, f) { return s + (f.size || 0); }, 0),
              files: files
            };
          });
          var existing = (a.versions || []).slice();
          var incKey = {};
          incoming.forEach(function (v) { incKey[(v.orderUrl && v.orderUrl.trim() ? v.orderUrl.trim() + (v.variationId ? '#vid:' + v.variationId : '') : (v.variationId ? 'vid:' + v.variationId : 'name:' + (v.name || '')))] = 1; if (v.variationId) incKey['vid:' + v.variationId] = 1; if (v.name) incKey['name:' + v.name] = 1; });
          existing = existing.filter(function (v) {
            if (v.orderUrl && v.orderUrl.trim()) return true;
            if (v.variationId && incKey['vid:' + v.variationId]) return true;
            if (v.name && incKey['name:' + v.name]) return true;
            return false;
          });
          var byKey = {}, byName = {};
          existing.forEach(function (v, i) { byKey[(v.orderUrl && v.orderUrl.trim() ? v.orderUrl.trim() + (v.variationId ? '#vid:' + v.variationId : '') : (v.variationId ? 'vid:' + v.variationId : 'name:' + (v.name || '')))] = i; if (v.name) byName[v.name] = i; });
          incoming.forEach(function (v) {
            var k = (v.orderUrl && v.orderUrl.trim() ? v.orderUrl.trim() + (v.variationId ? '#vid:' + v.variationId : '') : (v.variationId ? 'vid:' + v.variationId : 'name:' + (v.name || '')));
            if (byKey[k] !== undefined) { v.id = existing[byKey[k]].id; existing[byKey[k]] = v; }
            else if (v.name && byName[v.name] !== undefined) { v.id = existing[byName[v.name]].id; existing[byName[v.name]] = v; }
            else existing.push(v);
          });
          a.versions = existing;
          a.autoFilled.versions = true;
          clearAutoTried(a.id);            // 成功已锁定，冷却记录可以扔了
        } else if (Array.isArray(info2.versions) && info2.versions.length) {
          var have = {};
          (a.versions || []).forEach(function (v) { if (v.name) have[v.name] = 1; });
          a.versions = (a.versions || []).concat(info2.versions.filter(function (v) { return !have[v.name]; }));
          // 兜底版本不锁定：下次打开仍可再尝试识别订单链接/变体
        }
        if (Array.isArray(info2.downloadLinks) && info2.downloadLinks.length && !a.autoFilled.dls) {
          a.downloadLinks = uniqBy((a.downloadLinks || []).concat(info2.downloadLinks), function (l) { return l.url; });
          a.autoFilled.dls = true;
        }
        // 变体双价格：商品价（页面价）vs 购买价（订单实付价）。不一致时自动把订单价填为素材购买价格。
        var orderSum = 0, orderCur = '', priceMismatch = false;
        (a.versions || []).forEach(function (v) {
          if (!v.orderUrl || v.special) return;
          if (v.purchasePrice != null) {
            orderSum += v.purchasePrice;
            orderCur = v.purchaseCurrency || orderCur;
            var pd = derivePrice(v.price);
            if (Math.abs(v.purchasePrice - (pd.value || 0)) > 0.009) priceMismatch = true;
          }
        });
        if (priceMismatch && !a.autoFilled.purchasePrice) {
          a.purchasePrice = orderSum;
          a.purchaseCurrency = orderCur || '';
          a.autoFilled.purchasePrice = true;
          a.autoFilled.purchaseCurrency = true;
        }
        // BOOTH 商品价 = 已购变体计算价（特殊免费变体不计）
        var sum = 0, cur = '';
        (a.versions || []).forEach(function (v) {
          if (!v.orderUrl || v.special) return;
          var pd = derivePrice(v.price);
          if (pd.value != null) { sum += pd.value; cur = pd.currency || cur; }
        });
        a.shopPrice = App.priceText(sum, cur) || '0';
        a.shopPriceValue = sum; a.shopPriceCurrency = cur;
        a.autoFilled.shopPrice = true;
        if (a.delisted) a.delisted = false;
        return App.save(a);
      });
    }).then(function (saved) { autoEnrichBusy = false; return saved; },
             function (e) { autoEnrichBusy = false; throw e; });
  }

  /**
   * Gumroad 素材没有带订单链接的版本时补一次：商品页认变体 → 下载页取全部文件。
   * 成功后打 autoFilled.versions，避免每次打开都重抓；404/410 记已下架。
   */
  function autoEnrichGumroadAsset(a) {
    if (!a || a.source !== 'gumroad' || a.delisted) return Promise.resolve(a);
    // 免费素材没有已购变体可补；「未购买」不算免费，否则永远补不上
    if (App.purchaseState(a) !== 'unpurchased' && (a.isFree === true || ((App.effectivePrice(a) || {}).value === 0))) return Promise.resolve(a);
    if (a.autoFilled && a.autoFilled.versions) return Promise.resolve(a);
    var hasOrderVersion = (a.versions || []).some(function (v) { return v.orderUrl && v.orderUrl.trim() && !v.special; });
    if (hasOrderVersion) return Promise.resolve(a);
    var url = (a.links || []).filter(function (l) { return isHttpUrl(l.url); })[0];
    var itemUrl = url ? url.url : '';
    if (!itemUrl) return Promise.resolve(a);
    var gate = autoEnrichGate(a);
    if (!gate.ok) return Promise.resolve(a);        // 关掉了 / 没 Cookie / 还在冷却
    autoEnrichBusy = true;
    markAutoTried(a.id);

    return takeAutoSlot().then(function () {
      return Fetchers.fetchInfo(itemUrl, { forceNetwork: true, noCache: false });
    }).then(function (info) {
      if (!info || info.__failed) {
        var tried = (info && info.tried) || [];
        var gone = (info && (info.status === 404 || info.status === 410)) || tried.some(function (t) { return t && /HTTP (404|410)\b/.test(String(t.error || '')); });
        if (gone) { a.delisted = true; return App.save(a); }
        return a;
      }
      var step = Promise.resolve(info);
      step = Net.fetchText(itemUrl, { forceNetwork: true, onLog: function () {} }).then(function (r) {
        if (!r || !r.ok || !r.text) return info;
        var ov = parseGumroadItemOrderLinks(r.text);
        if (!ov.length) return info;
        info.orderVersions = ov;
        var purchased = ov.filter(function (o) { return o.orderUrl && !o.special; });
        if (!purchased.length) return info;
        var orderUrls = uniq(purchased.map(function (o) { return o.orderUrl; }).filter(Boolean));
        return Promise.all(orderUrls.map(function (orderUrl) {
          return Net.fetchText(orderUrl, { forceNetwork: true, onLog: function () {} }).then(function (rr) {
            if (!rr || !rr.ok || !rr.text) return null;
            var items = parseGumroadOrder(rr.text);
            return items.length ? items[0] : null;
          }).catch(function () { return null; });
        })).then(function (orders) {
          orders.forEach(function (it, idx) {
            if (!it) return;
            var o = purchased[idx] || purchased[0];
            var g = it.orderVersions && it.orderVersions.default;
            if (g && g.files && g.files.length) o.files = g.files;
          });
          return info;
        });
      }).catch(function () { return info; });

      return step.then(function (info2) {
        a.autoFilled = a.autoFilled || {};
        var ovs = Array.isArray(info2.orderVersions) && info2.orderVersions.length ? info2.orderVersions : [];
        if (ovs.length) {
          var incoming = ovs.map(function (o, i) {
            var files = (o.files || []).map(function (f) { return { name: f.name, url: f.url, size: f.size || 0, source: o.special ? 'public' : 'order' }; });
            return {
              id: 'ver_order_' + (o.variationId || o.name || i) + '_' + Date.now().toString(36),
              name: o.name || '（默认）',
              variationId: o.variationId || '',
              orderUrl: o.orderUrl || '',
              price: o.special ? '0' : (o.price || ''),
              purchasePrice: (o.orderPriceValue != null && isFinite(Number(o.orderPriceValue))) ? Number(o.orderPriceValue) : null,
              purchaseCurrency: o.orderPriceCurrency || '',
              special: !!o.special,
              isLatest: false,
              fileName: files.length ? files[0].name : '',
              url: files.length ? files[0].url : '',
              size: files.reduce(function (s, f) { return s + (f.size || 0); }, 0),
              files: files
            };
          });
          var existing = (a.versions || []).slice();
          var incKey = {};
          incoming.forEach(function (v) { incKey[(v.orderUrl && v.orderUrl.trim() ? v.orderUrl.trim() + (v.variationId ? '#vid:' + v.variationId : '') : (v.variationId ? 'vid:' + v.variationId : 'name:' + (v.name || '')))] = 1; if (v.variationId) incKey['vid:' + v.variationId] = 1; if (v.name) incKey['name:' + v.name] = 1; });
          existing = existing.filter(function (v) {
            if (v.orderUrl && v.orderUrl.trim()) return true;
            if (v.variationId && incKey['vid:' + v.variationId]) return true;
            if (v.name && incKey['name:' + v.name]) return true;
            return false;
          });
          var byKey = {}, byName = {};
          existing.forEach(function (v, i) { byKey[(v.orderUrl && v.orderUrl.trim() ? v.orderUrl.trim() + (v.variationId ? '#vid:' + v.variationId : '') : (v.variationId ? 'vid:' + v.variationId : 'name:' + (v.name || '')))] = i; if (v.name) byName[v.name] = i; });
          incoming.forEach(function (v) {
            var k = (v.orderUrl && v.orderUrl.trim() ? v.orderUrl.trim() + (v.variationId ? '#vid:' + v.variationId : '') : (v.variationId ? 'vid:' + v.variationId : 'name:' + (v.name || '')));
            if (byKey[k] !== undefined) { v.id = existing[byKey[k]].id; existing[byKey[k]] = v; }
            else if (v.name && byName[v.name] !== undefined) { v.id = existing[byName[v.name]].id; existing[byName[v.name]] = v; }
            else existing.push(v);
          });
          a.versions = existing;
          a.autoFilled.versions = true;
          clearAutoTried(a.id);            // 成功已锁定，冷却记录可以扔了
        } else if (Array.isArray(info2.versions) && info2.versions.length) {
          var have = {};
          (a.versions || []).forEach(function (v) { if (v.name) have[v.name] = 1; });
          a.versions = (a.versions || []).concat(info2.versions.filter(function (v) { return !have[v.name]; }));
          // 兜底版本不锁定：下次打开仍可再尝试识别订单链接/变体
        }
        if (Array.isArray(info2.downloadLinks) && info2.downloadLinks.length && !a.autoFilled.dls) {
          a.downloadLinks = uniqBy((a.downloadLinks || []).concat(info2.downloadLinks), function (l) { return l.url; });
          a.autoFilled.dls = true;
        }
        // 商店价：Gumroad 只读展示商品页价格（统一为币种符号+数值，避免 USD 双前缀；不进统计）
        if (info2.price && !a.autoFilled.shopPrice) {
          var spd = (info2.priceValue != null && isFinite(Number(info2.priceValue)))
            ? { value: Number(info2.priceValue), currency: info2.currency || '' }
            : derivePrice(info2.price);
          a.shopPrice = App.priceText(spd.value, spd.currency) || String(info2.price);
          a.shopPriceValue = spd.value;
          a.shopPriceCurrency = spd.currency;
          a.autoFilled.shopPrice = true;
        }
        // Gumroad 登录后的 purchase.total 是实付价：与页面价一致也自动填入购买价（用户手填值不覆盖）
        var orderSum = 0, orderCur = '', pageSum = 0, priceMismatch = false;
        (a.versions || []).forEach(function (v) {
          if (!v.orderUrl || v.special) return;
          var pd = derivePrice(v.price);
          if (pd.value != null) pageSum += pd.value;
          if (v.purchasePrice != null) {
            orderSum += v.purchasePrice;
            orderCur = v.purchaseCurrency || orderCur;
            if (Math.abs(v.purchasePrice - (pd.value || 0)) > 0.009) priceMismatch = true;
          }
        });
        var gumroadAutoPurchase = orderSum > 0 && a.purchasePrice == null && !(a.userEdited && a.userEdited.purchasePrice);
        if ((priceMismatch || gumroadAutoPurchase) && !a.autoFilled.purchasePrice) {
          a.purchasePrice = orderSum;
          a.purchaseCurrency = orderCur || '';
          a.autoFilled.purchasePrice = true;
          a.autoFilled.purchaseCurrency = true;
        }
        if (a.delisted) a.delisted = false;
        return App.save(a);
      });
    }).then(function (saved) { autoEnrichBusy = false; return saved; },
             function (e) { autoEnrichBusy = false; throw e; });
  }

  /** 导入 BOOTH 心愿单：读取全部心愿单 → 逐项抓取商品信息 → 入库并打「心愿单」标记 */
  function wishlistDialog() {
    var logBox = el('div', { class: 'fetch-log', style: { display: 'none' } });
    function log(m) { logBox.style.display = ''; logBox.appendChild(el('div', { class: 'log-line', text: m })); logBox.scrollTop = logBox.scrollHeight; }
    var busy = false;
    var runBtn;

    function fetchJSON(url) {
      return Net.fetchText(url, { forceNetwork: true, onLog: function () {} }).then(function (r) {
        if (!r || !r.ok) throw new Error(r && r.reason ? ('后端请求失败：' + r.reason) : '后端请求失败');
        return safeJSON(r.text, null);
      });
    }
    function makeFresh(info, wishItem, listName) {
      var fresh = Store.normalizeAsset({ source: 'booth', importedFrom: 'wishlist' });
      fresh.extra = fresh.extra || {};
      fresh.extra.wishlist = true;
      fresh.note = 'BOOTH 心愿单：' + (listName || '默认');
      var title = (info && info.originalTitle) || (wishItem && wishItem.name) || '';
      fresh.originalTitle = title;
      fresh.title = String(title).slice(0, 80);
      if (info) {
        fresh.itemId = info.itemId || (wishItem && String(wishItem.id)) || fresh.itemId || '';   // 保留原值，别清空
        fresh.description = info.description || '';
        fresh.author = info.author || info.shop || (wishItem && wishItem.shop && wishItem.shop.name) || '';
        fresh.shop = info.shop || fresh.author;
        fresh.shopUrl = info.shopUrl || (wishItem && wishItem.shop && wishItem.shop.url) || '';
        fresh.images = (info.images || []).slice();
        fresh.coverURL = info.coverURL || '';
        fresh.rawTags = Smart.filterBlacklist(Smart.purgeAvatarTags(info.tags || []));
        fresh.tags = Smart.filterBlacklist(Smart.purgeAvatarTags(App.settings.autoTranslateTags ? Smart.translateTags(info.tags || []) : (info.tags || []).slice()));
        fresh.downloadLinks = info.downloadLinks || [];
        fresh.versions = (info.versions || []).map(function (v) {
          return Store.normalizeVersion({ name: v.name || '', price: v.price || '', fileName: v.fileName || '', url: v.url || '', size: v.size || 0, files: v.files || [] });
        });
        fresh.category = Smart.guessCategory(info);
        fresh.publishedAt = info.publishedAt || '';
        fresh.shopUpdatedAt = info.shopUpdatedAt || '';
        fresh.note = [fresh.note, Smart.extractNotes(info.description)].filter(Boolean).join('\n').slice(0, 8000);
        if (info.r18 === true) fresh.extra.r18 = true;
        if (App.settings.autoDetectAvatar && fresh.category !== 'avatar') fresh.avatars = Smart.detectAvatars(info);
      } else if (wishItem) {
        fresh.itemId = String(wishItem.id || '') || fresh.itemId;   // 保留原值，别清空
        fresh.author = fresh.shop = (wishItem.shop && wishItem.shop.name) || '';
        fresh.shopUrl = (wishItem.shop && wishItem.shop.url) || '';
        var catName = (wishItem.category && wishItem.category.name && (wishItem.category.name['zh-cn'] || wishItem.category.name.en || wishItem.category.name.ja)) || '';
        fresh.category = Smart.mapShopCategory(catName) || Smart.guessCategory({ originalTitle: title, category: catName, tags: [], description: '' });
        fresh.images = (wishItem.thumbnail_image_urls || []).slice(0, 12);
        fresh.coverURL = fresh.images[0] || '';
        var pd = derivePrice(wishItem.price || '');
        if (pd && pd.value != null) { fresh.shopPrice = App.priceText(pd.value, pd.currency) || String(wishItem.price); fresh.shopPriceValue = pd.value; fresh.shopPriceCurrency = pd.currency; }
        if (wishItem.is_adult === true) fresh.extra.r18 = true;
        if (wishItem.is_end_of_sale) fresh.delisted = true;
      }
      fresh.links = [{ url: 'https://booth.pm/ja/items/' + fresh.itemId, label: 'BOOTH' }];
      return fresh;
    }

    function run() {
      if (busy) return;
      busy = true;
      if (runBtn) { runBtn.disabled = true; ICONS.apply(runBtn, ('\u23F3 导入中 …')); }
      log('\u{1F310} 开始读取 BOOTH 心愿单（全部列表）…');
      var names = [];
      return fetchJSON('https://accounts.booth.pm/wish_list_names.json').then(function (list) {
        names = Array.isArray(list) ? list : [];
        log('\u2714 发现 ' + names.length + ' 个命名心愿单');
        var codes = [{ code: '', name: '默认心愿单' }].concat(names.map(function (n) { return { code: n.code, name: n.name }; }));
        var byId = {};
        var chain = Promise.resolve();
        codes.forEach(function (wl) {
          chain = chain.then(function () {
            var url = 'https://accounts.booth.pm/wish_list_name_items.json' + (wl.code ? '?wish_list_name_code=' + encodeURIComponent(wl.code) : '');
            return fetchJSON(url).then(function (data) {
              var items = (data && data.items) || [];
              log('\u2714 [' + wl.name + '] ' + items.length + ' 项');
              items.forEach(function (it) { if (it && it.id && !byId[it.id]) byId[it.id] = { item: it, list: wl.name }; });
            }).catch(function (e) { log('\u26A0 [' + wl.name + '] 读取失败：' + (e && e.message)); });
          });
        });
        return chain.then(function () { return byId; });
      }).then(function (byId) {
        var entries = Object.keys(byId).map(function (k) { return byId[k]; });
        log('\u{1F4E6} 共 ' + entries.length + ' 个心愿单商品，逐项抓取完整信息 …');
        var created = 0, updated = 0, failed = 0;
        var chain2 = Promise.resolve();
        entries.forEach(function (e, ei) {
          chain2 = chain2.then(function () {
            var url = 'https://booth.pm/ja/items/' + e.item.id;
            return Fetchers.fetchInfo(url, { forceNetwork: true, onLog: function () {} }).then(function (info) {
              if (!info || info.__failed) throw new Error('fetch-failed');
              return info;
            }).catch(function () { return null; }).then(function (info) {
              var fresh = makeFresh(info, e.item, e.list);
              var existing = App.findDuplicate(fresh, false);
              if (existing) {
                existing.extra = existing.extra || {};
                existing.extra.wishlist = true;
                if (!existing.note || existing.note.indexOf('BOOTH 心愿单') < 0) existing.note = [existing.note, 'BOOTH 心愿单：' + e.list].filter(Boolean).join('\n');
                updated++;
                return App.save(existing).then(function () { log('\u267B 已标记心愿单（已存在）：' + (existing.title || existing.originalTitle)); });
              }
              created++;
              return App.save(fresh).then(function () {
                log('\u2714 ' + (created + updated) + '/' + entries.length + '：' + fresh.title);
              });
            }).catch(function (err) {
              failed++;
              log('\u26A0 导入失败 ' + (e.item && e.item.id) + '：' + (err && err.message));
            }).then(function () {
              /* 心愿单动辄上百个，逐个抓也要留出人味儿（800~1300ms） */
              if (ei < entries.length - 1) return new Promise(function (r) { setTimeout(r, 800 + Math.random() * 500); });
            });
          });
        });
        return chain2.then(function () {
          UI.renderAll();
          Toast.ok('心愿单导入完成：新增 ' + created + '，标记已有 ' + updated + (failed ? '，失败 ' + failed : ''));
        });
      }).catch(function (e) {
        log('\u2716 导入失败：' + (e && e.message) + '。请确认已保存 booth.pm Cookie 且程序后端在线。');
        Toast.err('心愿单导入失败：' + (e && e.message), 5200);
      }).then(function () {
        busy = false;
        if (runBtn) { runBtn.disabled = false; ICONS.apply(runBtn, ('\u2B07 开始导入全部心愿单')); }
      });
    }

    var h = Modal.open({
      title: '导入 BOOTH 心愿单', size: 'md',
      body: [
        el('div', { class: 'notice' }, [
          el('p', { text: '使用设置里已保存的 booth.pm Cookie，由程序后端读取你的全部心愿单，逐项抓取商品信息后入库，并打上「心愿单」标记（可筛选）。已存在的商品只追加心愿单标记，不会重复创建。' }),
          el('p', { text: '提示：心愿单商品通常未购买，保存后会按版本情况显示「未购买」标签。' })
        ]),
        (runBtn = el('button', { class: 'btn btn-primary', onclick: run }, ICONS.label('\u2B07 开始导入全部心愿单'))),
        logBox
      ],
      footer: [el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '关闭')]
    });
  }

  /** 用商品页的变体刷新「未购买」变体的当前价，并补上库里还没有的变体。
   *  已购变体以购买价为准，绝不被当前商店价覆盖。 */
  function mergeShopVariants(a, info) {
    var out = { priced: 0, added: 0 };
    if (!a || !info || !Array.isArray(info.versions) || !info.versions.length) return out;
    info.versions.forEach(function (nv) {
      var name = String((nv && nv.name) || '').trim();
      var vid = String((nv && nv.variationId) || '').trim();
      var priceTxt = String((nv && nv.price) || '').trim();
      var hit = (a.versions || []).filter(function (v) {
        if (vid && String(v.variationId || '') === vid) return true;
        return !!name && String(v.name || '').trim() === name;
      })[0];
      if (hit) {
        // 已购买（有订单链接）→ 价格一律不动；未购买 → 用当前商店价刷新
        if (!hit.orderUrl && priceTxt && String(hit.price || '') !== priceTxt) { hit.price = priceTxt; out.priced++; }
        return;
      }
      if (!name) return;
      a.versions = (a.versions || []).concat([{ name: name, price: priceTxt, orderUrl: '', variationId: vid, files: [] }]);
      out.added++;
    });
    return out;
  }
  /** 把商品页解析到的信息并回素材，只动「未购买 / 免费」变体：已购变体的文件与价格
   *  一律以订单页为准，不碰；公开下载链接按 URL 去重后并入。 */
  function mergeItemInfo(a, info) {
    var out = { priced: 0, added: 0, files: 0, links: 0 };
    if (!a || !info) return out;
    (info.versions || []).forEach(function (nv) {
      var name = String((nv && nv.name) || '').trim();
      var vid = String((nv && nv.variationId) || '').trim();
      var priceTxt = String((nv && nv.price) || '').trim();
      var nFiles = (nv && Array.isArray(nv.files)) ? nv.files : [];
      var hit = (a.versions || []).filter(function (v) {
        if (vid && String(v.variationId || '') === vid) return true;
        return !!name && String(v.name || '').trim() === name;
      })[0];
      if (hit) {
        if (hit.orderUrl) return;                        // 已购：文件与价格都以订单页/购买价为准
        if (priceTxt && String(hit.price || '') !== priceTxt) { hit.price = priceTxt; out.priced++; }
        if (nFiles.length) {
          var before = JSON.stringify((hit.files || []).map(function (f) { return [f.name, f.url, f.size || 0]; }));
          var after = JSON.stringify(nFiles.map(function (f) { return [f.name, f.url, f.size || 0]; }));
          if (before !== after) {
            hit.files = nFiles;
            hit.fileName = nFiles[0].name || '';
            hit.url = nFiles[0].url || '';
            hit.size = nFiles.reduce(function (s, f) { return s + (f.size || 0); }, 0);
            out.files++;
          }
        }
        return;
      }
      if (!name) return;
      var pd = derivePrice(priceTxt).value;
      a.versions = (a.versions || []).concat([{
        name: name, price: priceTxt, orderUrl: '', variationId: vid, special: pd === 0,
        files: nFiles, fileName: nFiles.length ? nFiles[0].name : '', url: nFiles.length ? nFiles[0].url : '',
        size: nFiles.reduce(function (s, f) { return s + (f.size || 0); }, 0)
      }]);
      out.added++;
    });
    var have = Object.create(null);
    (a.downloadLinks || []).forEach(function (l) { if (l && l.url) have[String(l.url)] = 1; });
    (info.downloadLinks || []).forEach(function (l) {
      if (!l || !l.url || have[String(l.url)]) return;
      have[String(l.url)] = 1;
      a.downloadLinks = (a.downloadLinks || []).concat([{ url: l.url, label: l.label || '下载' }]);
      out.links++;
    });
    return out;
  }
  /** 把订单页解析出的文件写进某个版本，返回文件数。
   *  详情页「获取更新」与设置页「批量获取更新」共用这一份逻辑，避免两处漂移。 */
  function applyOrderFilesToVersion(it, v) {
    var g = (it && it.orderVersions && it.orderVersions[v.variationId || 'default']) || (it && it.orderVersions && it.orderVersions.default);
    /* 订单页给了该变体行自己的价格就写进购买价；已有值的（手填或上次解析所得）不覆盖 */
    if (g && g.rowPriceValue != null && (v.purchasePrice == null || v.purchasePrice === '')) {
      v.purchasePrice = Number(g.rowPriceValue);
      v.purchaseCurrency = g.rowPriceCurrency || v.purchaseCurrency || '';
    }
    var src = (g && g.files && g.files.length) ? g.files : ((it && it.downloads) || []);
    var files = src.map(function (f) { return { name: f.name || '下载文件', url: f.url || '', size: f.size || 0, source: v.special ? 'public' : 'order' }; });
    v.files = files;
    v.fileName = files.length ? files[0].name : '';
    v.url = files.length ? files[0].url : '';
    v.size = files.reduce(function (s, f) { return s + (f.size || 0); }, 0);
    return files.length;
  }

  return {
    scanForImport: scanForImport, buildCandidate: buildCandidate, guessVersion: guessVersion,
    extractURL: extractURL, copyIntoLibrary: copyIntoLibrary, ensureDownloadFolder: ensureDownloadFolder,
    ensureStoragePathQuiet: ensureStoragePathQuiet,
    attachLocalDialog: attachLocalDialog, attachDropped: attachDropped,
    createStoragePathOnly: createStoragePathOnly,
    folderWizard: folderWizard, bridgeImportDialog: bridgeImportDialog,
    importBridgeJSON: importBridgeJSON, parseBoothLibrary: parseBoothLibrary,
    parseBoothOrder: parseBoothOrder, parseBoothItemOrderLinks: parseBoothItemOrderLinks, orderImportDialog: orderImportDialog,
    parseGumroadItemOrderLinks: parseGumroadItemOrderLinks, parseGumroadOrder: parseGumroadOrder, parseOrderPage: parseOrderPage,
    applyOrderFilesToVersion: applyOrderFilesToVersion, mergeShopVariants: mergeShopVariants, mergeItemInfo: mergeItemInfo,
    syncLibraryDialog: syncLibraryDialog, autoEnrichBoothAsset: autoEnrichBoothAsset,
    autoParseBoothById: autoParseBoothById,
    autoEnrichGumroadAsset: autoEnrichGumroadAsset,
    autoEnrichGate: autoEnrichGate, autoEnrichTouch: markAutoTried, autoEnrichClear: clearAutoTried,
    wishlistDialog: wishlistDialog,
    autoEnrichBusy: function () { return autoEnrichBusy; }
  };
})();

