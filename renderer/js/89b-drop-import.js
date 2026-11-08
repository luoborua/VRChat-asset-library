/*
 * 89b-drop-import.js  —  拖进窗口就导入（zip / unitypackage / 任意素材文件 / 文件夹）
 *
 * 负责：把拖入项整理成素材候选、预览里改标题与分类、复制或移动进素材库。
 * 与谁交互：拖放事件与选文件来自 89-pack.js / 95-shell-bridge.js；
 *           目录扫描与落盘走 FS.host，记录写入走 Store / App.save。
 * 边界：只搬拖进来的那一层；压缩包原样入库不自动解压；默认复制，不动源文件。
 */

var DropImport = (function () {

  var IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tga', 'tif', 'tiff'];
  var ARCHIVE_EXT = ['zip', 'rar', '7z', 'unitypackage', 'vrm', 'vrca', 'fbx', 'blend',
    'psd', 'clip', 'sai', 'spp', 'pmx', 'pmd', 'tar', 'gz', 'tgz'];

  var current = null;          // 当前打开着的导入预览（拖入第二个文件时用来替换）
  var busy = false;

  /* ---------------- 名称 / 路径小工具 ---------------- */

  function extOf(name) {
    var m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }
  function stemOf(name) {
    return String(name || '').replace(/\.[^.]+$/, '');
  }
  function fileBaseName(p) {
    var s = String(p || '').replace(/[\\/]+$/, '');
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function isImage(name) { return IMAGE_EXT.indexOf(extOf(name)) >= 0; }

  /** 从文件名推断版本号：_v…、ver…、【v…】这几种写法都认 */
  function guessVersion(name) {
    var s = String(name || '');
    var m = s.match(/(?:^|[\s_\-\[【(])[vV](\d+(?:[._-]\d+){0,3})(?![\d])/) ||
            s.match(/(?:ver|version|バージョン)[\s._-]*(\d+(?:[._-]\d+){0,3})/i) ||
            s.match(/(?:^|[\s_\-\[【(])(\d+\.\d+(?:\.\d+)?)(?:[\s_\-)\]】)]|$)/);
    return m ? ('v' + m[1].replace(/_/g, '.')) : '';
  }

  /** 去掉版本号后的主名：用于「同一素材的多个版本」归组 */
  function versionless(stem) {
    return String(stem || '')
      .replace(/[（(\[【]\s*[vV\u7248]?\s*\d+(?:[._-]\d+)*\s*[)）\]】]/g, ' ')
      .replace(/(?:^|[\s_\-\[【(])[vV]\d+(?:[._-]\d+)*/g, ' ')
      .replace(/(?:ver|version|バージョン)[\s._-]*\d+(?:[._-]\d+)*/ig, ' ')
      .replace(/[\s_\-]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 只用于文件夹名/标题的安全清洗（和 App.folderName 同规则，但不带商品ID 前缀） */
  function safeName(s, fallback) {
    var v = String(s == null ? '' : s)
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/^\s+|\s+$/g, '')
      .replace(/^\.+/, '');
    if (!v) v = fallback || '未命名';
    return v.length > 100 ? v.slice(0, 100) : v;
  }

  function cleanTitle(s) {
    return String(s || '')
      .replace(/_+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function typeLabel(name, isDir) {
    if (isDir) return '文件夹';
    var ext = extOf(name);
    if (ext === 'unitypackage') return 'unitypackage 包';
    if (ext === 'zip') return 'ZIP 压缩包';
    if (ext === 'rar') return 'RAR 压缩包';
    if (ext === '7z') return '7z 压缩包';
    if (ext === 'fbx' || ext === 'blend') return '模型文件';
    if (ext === 'psd' || ext === 'clip' || ext === 'sai') return '源文件';
    if (IMAGE_EXT.indexOf(ext) >= 0) return '图片';
    return ext ? ext.toUpperCase() + ' 文件' : '文件';
  }

  function looksPack(name) {
    return /\.vrcpack$/i.test(String(name || ''));
  }

  /** 从菜单选文件时没有 File 对象，封面按磁盘路径读成 Blob（drop 场景直接用 File） */
  function coverBlobFromPath(p) {
    if (!p) return Promise.resolve(null);
    var ext = extOf(p);
    var mime = ext === 'png' ? 'image/png'
      : ext === 'webp' ? 'image/webp'
      : ext === 'gif' ? 'image/gif'
      : ext === 'bmp' ? 'image/bmp' : 'image/jpeg';
    if (FS.host.bytesSupported && FS.host.bytesSupported()) {
      return FS.host.readBytes(p).then(function (bytes) {
        return new Blob([bytes], { type: mime });
      }).catch(function () { return null; });
    }
    return FS.host.readFileBase64(p).then(function (r) {
      var b64 = String((r && (r.dataBase64 || r.base64)) || '');
      if (!b64) return null;
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }).catch(function () { return null; });
  }

  /* ---------------- 把拖入项整理成「素材候选」 ---------------- */

  /**
   * items: [{ path, name, size, isDir, file }]
   * 非图片文件各成候选（主名相同则归为多个版本），图片只作封面，文件夹整块算一个候选。
   */
  function groupItems(items) {
    var groups = [];
    var byKey = Object.create(null);
    var covers = [];
    var unusedCovers = [];

    (items || []).forEach(function (it) {
      if (!it || !it.name) return;
      if (!it.isDir && isImage(it.name)) { covers.push(it); return; }

      var stem = stemOf(it.name);
      var base = versionless(stem) || stem || it.name;
      var key = (it.isDir ? 'D|' : 'F|') + base.toLowerCase();
      var g = byKey[key];
      if (!g) {
        g = { base: base, files: [], cover: null, isDir: !!it.isDir, scan: null };
        byKey[key] = g;
        groups.push(g);
      }
      g.files.push({
        path: it.path, name: it.name, size: Number(it.size) || 0,
        isDir: !!it.isDir, file: it.file || null, version: guessVersion(stem)
      });
    });

    covers.forEach(function (c) {
      var target = null;
      if (groups.length === 1) {
        target = groups[0];
      } else {
        var cb = stemOf(c.name).toLowerCase();
        for (var i = 0; i < groups.length; i++) {
          var gb = String(groups[i].base || '').toLowerCase();
          if (gb && gb.length >= 2 && cb.indexOf(gb) === 0) { target = groups[i]; break; }
        }
      }
      if (target && !target.cover) target.cover = { path: c.path, name: c.name, file: c.file || null };
      else unusedCovers.push(c.name);
    });

    return { groups: groups, unusedCovers: unusedCovers };
  }

  /** 库里是否已有同名素材（只做提示，不阻止导入） */
  function findDuplicate(title) {
    var t = String(title || '').trim().toLowerCase();
    if (!t) return null;
    var list = (App && App.assets) || [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (String(a.title || '').trim().toLowerCase() === t) return a;
      if (String(a.originalTitle || '').trim().toLowerCase() === t) return a;
    }
    return null;
  }

  /* ---------------- 预览 ---------------- */

  function close() {
    var h = current;
    current = null;
    if (h) { try { Modal.close(h); } catch (e) {} }
  }
  function isOpen() { return !!current; }
  function isTop() {
    if (!current || busy) return false;            // 导入进行中不许被新拖入替换
    var stack = (typeof Modal !== 'undefined' && Modal.stack) ? Modal.stack : [];
    return stack.length > 0 && stack[stack.length - 1] === current;
  }

  /**
   * 打开导入预览。
   * items: [{ path, name, size, isDir, file }]
   */
  function open(items, opts) {
    opts = opts || {};
    if (busy) { Toast.warn('上一批还在导入，请稍等'); return Promise.resolve(false); }
    if (current) close();

    var plan = groupItems(items);
    if (!plan.groups.length) {
      if (plan.unusedCovers.length) {
        Toast.warn('拖进来的都是图片：图片只作为封面，请连同素材文件一起拖入（或用「从文件夹导入」）', 7000);
      } else {
        Toast.warn('没有识别到可导入的文件');
      }
      return Promise.resolve(false);
    }

    var root = App.libraryRoot();
    /* 库根必须是绝对路径：空值或相对名会让文件相对后端进程的工作目录落盘，
     * 结果写进程序自己的目录里，事后很难找。这里直接拦住并提示去设置里选。 */
    function isAbsPath(p) {
      return /^[a-zA-Z]:[\\/]/.test(String(p || '')) || /^\\\\[^\\]/.test(String(p || ''));
    }
    var rootOk = isAbsPath(root);
    var state = {
      groups: plan.groups,
      mode: App.settings.importMoveInsteadOfCopy ? 'move' : 'copy',
      coverOn: true,
      root: root,
      done: false,
      failed: []
    };
    plan.groups.forEach(function (g) {
      g.selected = true;
      g.title = cleanTitle(g.base);
      g.category = (typeof Smart !== 'undefined')
        ? (Smart.guessCategory({ originalTitle: g.base, tags: [], description: '' }) || 'other')
        : 'other';
      g.avatars = (typeof Smart !== 'undefined' && App.settings.autoDetectAvatar && g.category !== 'avatar')
        ? Smart.detectAvatars({ originalTitle: g.base, tags: [], description: '' })
        : [];
      g.dup = findDuplicate(g.title);
      g.size = g.files.reduce(function (s, f) { return s + (f.size || 0); }, 0);
    });

    /* ---- 目录条目的大小，异步补（不阻塞窗口打开） ---- */
    function fillDirSizes() {
      plan.groups.forEach(function (g) {
        if (!g.isDir || !g.files.length) return;
        var src = g.files[0].path;
        if (!src) return;
        FS.host.scan(src, 0).then(function (entries) {
          var total = 0, count = 0;
          (entries || []).forEach(function (e) {
            if (e && e.kind === 'file') { total += Number(e.size) || 0; count++; }
          });
          g.size = total;
          g.dirCount = count;
          if (g.rowSub) g.rowSub.textContent = '文件夹 · ' + count + ' 个文件 · ' + fmtSize(total);
          if (g.rowRight) g.rowRight.textContent = fmtSize(total);
        }).catch(function () {});
      });
    }

    var summary = el('div', { class: 'pack-summary' });
    var listBox = el('div', { class: 'di-list' });
    var prog = el('div', { class: 'pack-prog', style: { display: 'none' } });
    var btnRow = el('div', { class: 'btn-row' });
    var importBtn = el('button', { class: 'btn btn-primary', onclick: doImport }, '导入到素材库');

    function selGroups() { return state.groups.filter(function (g) { return g.selected; }); }

    function refreshSummary() {
      var sel = selGroups();
      var bytes = sel.reduce(function (s, g) { return s + (g.size || 0); }, 0);
      var parts = ['拖入 ' + state.groups.length + ' 个素材'];
      parts.push('已选 ' + sel.length + ' 个 · 合计 ' + fmtSize(bytes));
      if (state.root) parts.push('库根：' + state.root);
      summary.innerHTML = '';
      summary.appendChild(el('div', {}, [
        el('b', { text: parts[0] }),
        el('span', { class: 'pack-dim', text: ' · ' + parts.slice(1).join(' · ') })
      ]));
      if (plan.unusedCovers.length) {
        summary.appendChild(el('div', {
          class: 'pack-dim',
          text: '另有 ' + plan.unusedCovers.length + ' 张图片没认出归属，已忽略：' + plan.unusedCovers.slice(0, 3).join('、')
        }));
      }
      if (!state.root) {
        summary.appendChild(el('div', { class: 'pack-warn', text: '还没有设置素材库根目录：请先到「设置 → 本地库与整理」选择根目录。' }));
      } else if (!isAbsPath(state.root)) {
        summary.appendChild(el('div', {
          class: 'pack-warn',
          text: '素材库根目录不是绝对路径（当前：' + state.root + '）：请到「设置 → 本地库与整理」重新选择，否则文件会落进程序自己的目录。'
        }));
      }
      importBtn.disabled = !sel.length || !state.root || !isAbsPath(state.root);
    }

    function destOf(g) {
      return joinWinPath(state.root || '', [App.categoryLabel(g.category), safeName(g.title, '未命名')]);
    }

    function makeRow(g) {
      var cb = el('input', { type: 'checkbox' });
      cb.checked = !!g.selected;
      cb.addEventListener('change', function () {
        g.selected = cb.checked;
        row.classList.toggle('on', cb.checked);
        refreshSummary();
      });

      var titleIn = el('input', {
        class: 'input', type: 'text', value: g.title, placeholder: '素材标题',
        oninput: function () {
          g.title = this.value;
          if (g.rowDest) g.rowDest.textContent = destOf(g);
          if (g.dupChip) g.dupChip.parentNode && g.dupChip.parentNode.removeChild(g.dupChip);
          g.dupChip = null;
          var dup = findDuplicate(this.value);
          if (dup) {
            g.dupChip = el('span', { class: 'chip chip-warn', title: '库里已经有同名素材；导入后会多一条，不会覆盖原来的', text: '库里已有同名素材' });
            chips.appendChild(g.dupChip);
          }
        }
      });

      var catSel = el('select', {
        class: 'input',
        title: '导入到哪个分类目录',
        onchange: function () {
          g.category = this.value;
          if (g.rowDest) g.rowDest.textContent = destOf(g);
        }
      });
      App.allCategories().forEach(function (c) {
        var opt = el('option', { value: c.id }, c.label);
        if (c.id === g.category) opt.selected = true;
        catSel.appendChild(opt);
      });

      var chips = el('div', { class: 'cmp-chips' });
      var fileLines = el('div', { class: 'di-files' });
      g.files.forEach(function (f) {
        fileLines.appendChild(el('div', {
          class: 'di-file',
          title: f.path || f.name,
          text: '· ' + f.name + (f.size ? '　' + fmtSize(f.size) : '') + (f.version ? '　' + f.version : '')
        }));
      });

      var sub = el('div', { class: 'cmp-sub' });
      sub.textContent = g.files.length > 1
        ? (g.files.length + ' 个文件（同一素材的多个版本）')
        : (typeLabel(g.files[0] && g.files[0].name, g.files[0] && g.files[0].isDir));
      g.rowSub = sub;

      if (g.files.length > 1) chips.appendChild(el('span', { class: 'chip', text: g.files.length + ' 个版本' }));
      if (g.cover) chips.appendChild(el('span', { class: 'chip', text: '封面：' + g.cover.name }));
      if (g.dup) {
        g.dupChip = el('span', { class: 'chip chip-warn', title: '库里已经有同名素材；导入后会多一条，不会覆盖原来的', text: '库里已有同名素材' });
        chips.appendChild(g.dupChip);
      }

      var dest = el('div', { class: 'di-dest', title: destOf(g) });
      dest.textContent = destOf(g);
      g.rowDest = dest;

      var row = el('div', { class: 'di-row' + (g.selected ? ' on' : '') }, [
        cb,
        el('div', { class: 'di-main' }, [
          el('div', { class: 'di-title-row' }, [titleIn, catSel]),
          sub,
          fileLines,
          chips,
          dest
        ])
      ]);
      return row;
    }

    state.groups.forEach(function (g) { listBox.appendChild(makeRow(g)); });

    /* ---- 底部：搬运方式 / 封面 / 按钮 ---- */
    var modeCopyId = 'diModeCopy_' + Date.now();
    var modeMoveId = 'diModeMove_' + Date.now();
    var modeRow = el('div', { class: 'pack-sec' }, [
      el('div', { class: 'pack-label', text: '怎么放进素材库' }),
      el('label', { class: 'pack-check' }, [
        el('input', {
          type: 'radio', name: 'diMode', id: modeCopyId, checked: state.mode === 'copy',
          onchange: function () { if (this.checked) state.mode = 'copy'; }
        }),
        el('span', {}, [
          el('b', { text: '复制（保留原文件）' }),
          el('span', { class: 'pack-dim', text: ' —— 推荐：素材库里一份，原来的下载目录不受影响' })
        ])
      ]),
      el('label', { class: 'pack-check' }, [
        el('input', {
          type: 'radio', name: 'diMode', id: modeMoveId, checked: state.mode === 'move',
          onchange: function () { if (this.checked) state.mode = 'move'; }
        }),
        el('span', {}, [
          el('b', { text: '移动（源文件搬到库内）' }),
          el('span', { class: 'pack-dim', text: ' —— 适合「下载目录直接清空」，移动失败的文件会原样留着' })
        ])
      ]),
      el('label', { class: 'pack-check' }, [
        el('input', {
          type: 'checkbox', checked: state.coverOn,
          onchange: function () { state.coverOn = this.checked; }
        }),
        el('span', {}, [
          el('span', { text: '把拖进来的图片作为封面' }),
          el('span', { class: 'pack-dim', text: '（图片不会复制进素材目录，只存进素材记录）' })
        ])
      ]),
      el('p', { class: 'field-hint', text: '压缩包原样入库，不会自动解压 —— 需要里面的文件时，在详情页「打开文件」里用 7-Zip 解到你想要的位置。' })
    ]);

    function setProg(text, pct) {
      prog.style.display = '';
      prog.innerHTML = '';
      prog.appendChild(el('div', { class: 'pack-prog-text', text: text }));
      if (typeof pct === 'number') {
        prog.appendChild(el('div', { class: 'pack-prog-bar' }, [
          el('i', { style: { width: Math.max(0, Math.min(100, pct)) + '%' } })
        ]));
      }
    }

    /* ---- 真正导入 ---- */
    /* FS.host.exists 返回 'file' / 'dir' / 'missing' 字符串，
     * 直接当布尔用会把 'missing' 也算成「已存在」。 */
    function kindTaken(kind) { return kind === 'file' || kind === 'dir'; }

    function uniqueTarget(dst, name) {
      return FS.host.exists(joinWinPath(dst, [name])).then(function (kind) {
        if (!kindTaken(kind)) return name;
        var ext = (/\.[^.]+$/.exec(name) || [''])[0];
        var stem = ext ? name.slice(0, name.length - ext.length) : name;
        var n = 2;
        function next() {
          var cand = stem + '_' + n + ext;
          return FS.host.exists(joinWinPath(dst, [cand])).then(function (k2) {
            if (!kindTaken(k2)) return cand;
            n++;
            if (n > 200) return stem + '_' + Date.now() + ext;
            return next();
          });
        }
        return next();
      }).catch(function () { return name; });
    }

    /** 把一个文件夹的顶层子项搬进 dst：不展开内部结构，也不多套一层同名目录 */
    function importDirChildren(f, dst, moved, failed) {
      return FS.host.scan(f.path, 1).then(function (entries) {
        var tops = (entries || []).filter(function (e) {
          return e && e.name && String(e.rel || '').indexOf('\\') < 0;
        });
        if (!tops.length) { failed.push(f.name + '：文件夹是空的'); return; }
        var chain = Promise.resolve();
        tops.forEach(function (e, i) {
          chain = chain.then(function () {
            var src = joinWinPath(f.path, [e.name]);
            return uniqueTarget(dst, e.name).then(function (targetName) {
              var target = joinWinPath(dst, [targetName]);
              setProg('正在' + (state.mode === 'move' ? '移动' : '复制') + ' ' + (i + 1) + '/' + tops.length
                + '：' + e.name, null);
              var job = state.mode === 'move' ? FS.host.move(src, target) : FS.host.copy(src, target);
              return job.then(function () {
                moved.push({ name: targetName, size: Number(e.size) || 0, isDir: e.kind === 'directory' });
              }).catch(function (err) {
                failed.push(e.name + '：' + ((err && err.message) || err));
              });
            });
          });
        });
        return chain;
      });
    }

    /* 目标目录撞名时自动换成 _2、_3…并提示一句：直接 mkdir 会复用已有目录，
       同名文件被静默覆盖，两条素材还指向同一个 path。 */
    function importOne(g) {
      var wanted = safeName(g.title || '未命名', '未命名');
      return App.pickFreeFolderName(wanted, App.categoryLabel(g.category)).then(function (pick) {
        if (pick.renamed) setProg('素材库已有同名目录，改导入到「' + pick.name + '」', null);
        return run(g, joinWinPath(state.root || '', [App.categoryLabel(g.category), pick.name]));
      });
    }

    function run(g, dst) {
      var moved = [];
      var failed = [];
      var onlyDir = (g.files.length === 1 && g.files[0].isDir) ? g.files[0] : null;
      return FS.host.mkdir(dst).then(function () {
        if (onlyDir) {
          if (!onlyDir.path) { failed.push(onlyDir.name + '：拿不到磁盘路径'); return null; }
          return importDirChildren(onlyDir, dst, moved, failed);
        }
        var chain = Promise.resolve();
        g.files.forEach(function (f, idx) {
          chain = chain.then(function () {
            if (!f.path) { failed.push(f.name + '：拿不到磁盘路径'); return; }
            return uniqueTarget(dst, f.name).then(function (targetName) {
              var target = joinWinPath(dst, [targetName]);
              setProg('正在' + (state.mode === 'move' ? '移动' : '复制') + ' ' + (idx + 1) + '/' + g.files.length
                + '：' + f.name, null);
              var job = state.mode === 'move'
                ? FS.host.move(f.path, target)
                : FS.host.copy(f.path, target);
              return job.then(function () {
                moved.push({ name: targetName, src: f.name, size: f.size, version: f.version });
              }).catch(function (e) {
                failed.push(f.name + '：' + ((e && e.message) || e));
              });
            });
          });
        });
        return chain;
      }).then(function () {
        if (!moved.length) return { added: false, failed: failed };

        var bytes = moved.reduce(function (s, f) { return s + (f.size || 0); }, 0) || g.size || 0;
        var versions = onlyDir
          ? [{ name: g.title || onlyDir.name, fileName: onlyDir.name, size: bytes, isLatest: true }]
          : moved.map(function (f, i) {
            return {
              name: f.version || (moved.length > 1 ? f.name : '默认'),
              fileName: f.name, size: f.size || 0,
              isLatest: i === moved.length - 1
            };
          });
        var asset = Store.normalizeAsset({
          title: g.title || cleanTitle(g.base),
          originalTitle: cleanTitle(g.base),
          source: 'other',
          category: g.category || 'other',
          avatars: (g.avatars || []).slice(),
          downloaded: true,
          downloadedAt: nowISO(),
          fileSize: bytes,
          importedFrom: 'drop',
          versions: versions,
          paths: [{ path: dst, note: '存储路径' }]
        });

        var step = Promise.resolve();
        if (state.coverOn && g.cover) {
          var src = g.cover.file ? Promise.resolve(g.cover.file) : coverBlobFromPath(g.cover.path);
          step = src.then(function (blobSrc) {
            if (!blobSrc) return null;
            return compressImage(blobSrc, App.settings.imageMaxWidth, App.settings.imageQuality).then(function (blob) {
              asset.hasCover = true;
              return Store.putCover(asset.id, blob);
            });
          }).catch(function () { /* 封面失败不影响素材本体 */ });
        }
        return step.then(function () { return App.save(asset); }).then(function () {
          return { added: true, failed: failed };
        });
      });
    }

    function doImport() {
      if (busy || state.done) return;
      var sel = selGroups();
      if (!sel.length) { Toast.warn('请至少勾选一项'); return; }
      if (!state.root) { Toast.warn('还没有设置素材库根目录，无法导入'); return; }
      if (!isAbsPath(state.root)) {
        Toast.warn('素材库根目录不是绝对路径（当前：' + state.root + '）。请先到「设置 → 本地库与整理」选择根目录，否则文件会落进程序自己的目录。', 8000);
        return;
      }

      busy = true;
      importBtn.disabled = true;
      setProg('准备导入 ' + sel.length + ' 个素材…', 0);

      var added = 0, failed = [];
      var chain = Promise.resolve();
      sel.forEach(function (g, i) {
        chain = chain.then(function () {
          setProg('正在处理 ' + (i + 1) + '/' + sel.length + '：' + (g.title || g.base), (i / sel.length) * 100);
          return importOne(g).then(function (r) {
            if (r && r.added) added++;
            if (r && r.failed && r.failed.length) failed = failed.concat(r.failed);
          }).catch(function (e) {
            failed.push((g.title || g.base) + '：' + ((e && e.message) || e));
          });
        });
      });

      chain.then(function () {
        state.done = true;
        busy = false;
        setProg('完成：新增 ' + added + ' 个素材'
          + (failed.length ? '，' + failed.length + ' 个文件没进去（见下）' : ''), 100);
        if (failed.length) {
          prog.appendChild(el('div', { class: 'pack-warn', text: failed.slice(0, 6).join('；') }));
        }
        btnRow.innerHTML = '';
        btnRow.appendChild(el('span', { class: 'grow' }));
        btnRow.appendChild(el('button', { class: 'btn btn-primary', onclick: function () { close(); } }, '完成'));
        UI.renderAll();
        if (added) Toast.ok('已导入 ' + added + ' 个素材到素材库', 6000);
        if (failed.length) Toast.warn('有 ' + failed.length + ' 个文件没导进去：多数是源文件被占用或目标同名，完成前先看一眼列表', 8000);
      }).catch(function (e) {
        busy = false;
        importBtn.disabled = false;
        setProg('失败：' + ((e && e.message) || e), 0);
        Toast.err('导入失败：' + ((e && e.message) || e), 9000);
      });
    }

    refreshSummary();

    btnRow.appendChild(el('span', { class: 'grow' }));
    btnRow.appendChild(el('button', { class: 'btn', onclick: function () { close(); } }, '取消'));
    btnRow.appendChild(importBtn);

    var body = el('div', { class: 'pack-body' }, [
      summary,
      listBox,
      modeRow,
      prog,
      btnRow
    ]);

    var handle = Modal.open({
      title: '导入素材',
      size: 'lg',
      body: [body],
      onClose: function () {
        if (current === handle) current = null;
      }
    });
    current = handle;
    fillDirSizes();
    return Promise.resolve(true);
  }

  /* ---------------- 拖到卡片：放进某一条素材 ---------------- */

  /** 目标目录里重名就换成 _2、_3…；不覆盖用户已有的文件 */
  function freeName(dir, name) {
    function taken(k) { return k === 'file' || k === 'dir'; }
    return FS.host.exists(joinWinPath(dir, [name])).then(function (kind) {
      if (!taken(kind)) return name;
      var ext = (/\.[^.]+$/.exec(name) || [''])[0];
      var stem = ext ? name.slice(0, name.length - ext.length) : name;
      var n = 2;
      function step() {
        if (n > 500) return stem + '_' + Date.now() + ext;
        var cand = stem + '_' + n + ext;
        return FS.host.exists(joinWinPath(dir, [cand])).then(function (k) {
          if (!taken(k)) return cand;
          n++;
          return step();
        });
      }
      return step();
    }).catch(function () { return name; });
  }

  /** 版本名默认值：文件名里的 v1.2 优先，否则用去扩展名的名字 */
  function defaultVerName(name) {
    var stem = stemOf(name);
    return guessVersion(stem) || stem || String(name || '');
  }

  /**
   * 「放进这条素材」：拖到卡片上松手时打开。
   * 同一批文件既可能只是补个 DLC，也可能是新版本，还会是换封面 —— 由用户当场选，
   * 程序不猜（猜错就是把版本结构弄乱，事后很难还原）。
   */
  function openIntoCard(asset, items) {
    if (!asset) return Promise.resolve(false);
    if (busy) { Toast.warn('上一批还在导入，请稍等'); return Promise.resolve(false); }
    var list = (items || []).filter(function (it) { return it && it.name; });
    if (!list.length) return Promise.resolve(false);

    var packs = list.filter(function (it) { return looksPack(it.name); });
    if (packs.length) {
      Toast.warn('「' + packs[0].name + '」是整包导入的素材包，请拖到卡片以外的空白处，按「导入素材包」处理', 7200);
      return Promise.resolve(false);
    }
    if (current) close();                      // 手上还开着的导入预览，换成本次操作

    var allImg = list.every(function (it) { return !it.isDir && isImage(it.name); });
    var state = {
      mode: allImg ? 'cover' : 'attach',
      verName: list.length === 1 ? defaultVerName(list[0].name) : '',
      copied: [],
      renamed: [],
      failed: [],
      done: false
    };

    /* ---- 头部：放进哪一条 ---- */
    var head = el('div', { class: 'pack-summary' }, [
      el('div', {}, [
        el('b', { text: '放进「' + (asset.title || asset.originalTitle || '未命名') + '」' }),
        el('span', { class: 'pack-dim', text: ' · ' + App.categoryLabel(asset.category || 'other')
          + (Store.fileIdOf(asset) ? ' · 编号 ' + Store.fileIdOf(asset) : '') })
      ]),
      el('div', { class: 'pack-dim', text: '文件会复制进这条素材自己的目录，源文件不动。同名文件自动改名，不会覆盖。' })
    ]);

    var fileBox = el('div', { class: 'di-files' }, list.map(function (it) {
      return el('div', {
        class: 'di-file',
        title: it.path || it.name,
        text: '· ' + it.name + (it.size ? '　' + fmtSize(it.size) : '') + '　' + typeLabel(it.name, it.isDir)
      });
    }));

    /* ---- 去向 ---- */
    var radioName = 'diInto_' + Date.now();
    var verRow = el('div', { class: 'pack-sec', style: { display: 'none' } }, [
      el('div', { class: 'pack-label', text: '版本名' }),
      el('input', {
        class: 'input', type: 'text', value: state.verName, placeholder: '例如 v1.2 / DLC / 通常版',
        oninput: function () { state.verName = this.value; }
      }),
      el('div', { class: 'field-hint', text: '只影响「版本与下载」里这条的标题，随时可以在编辑页改。' })
    ]);

    function optionRow(value, title, dim) {
      var input = el('input', {
        type: 'radio', name: radioName, checked: state.mode === value,
        onchange: function () {
          if (!this.checked) return;
          state.mode = value;
          verRow.style.display = (value === 'version' && list.length === 1) ? '' : 'none';
        }
      });
      return el('label', { class: 'pack-check' }, [
        input,
        el('span', {}, [el('b', { text: title }), el('span', { class: 'pack-dim', text: ' —— ' + dim })])
      ]);
    }

    var optRows = [
      optionRow('attach', '作为附加文件', 'DLC / 补丁 / 说明书等：只放进素材目录，版本结构不动'),
      optionRow('version', '作为新版本', '同时登记进「版本」，最新的那个排在最前，旧的自动收进历史版本')
    ];
    if (allImg) optRows.push(optionRow('cover', '设为封面', '只换封面图，不把图片复制进素材目录'));

    var optBox = el('div', { class: 'pack-sec' }, [el('div', { class: 'pack-label', text: '这批文件怎么算' })].concat(optRows));
    if (list.length > 1 && state.mode === 'version') {
      verRow.style.display = 'none';           // 多文件各按自己的文件名当版本名
    }
    if (state.mode === 'version' && list.length === 1) verRow.style.display = '';

    var prog = el('div', { class: 'pack-prog', style: { display: 'none' } });
    function setProg(text, pct) {
      prog.style.display = '';
      prog.innerHTML = '';
      prog.appendChild(el('div', { class: 'pack-prog-text', text: text }));
      if (typeof pct === 'number') {
        prog.appendChild(el('div', { class: 'pack-prog-bar' }, [
          el('i', { style: { width: Math.max(0, Math.min(100, pct)) + '%' } })
        ]));
      }
    }

    var btnRow = el('div', { class: 'btn-row' });
    var okBtn = el('button', { class: 'btn btn-primary', onclick: run }, '放进这条素材');

    /* ---- 落盘并写记录 ---- */
    function applyRecord(mode) {
      var bytes = state.copied.reduce(function (s, f) { return s + (f.size || 0); }, 0);
      asset.downloaded = true;
      asset.downloadedAt = nowISO();
      asset.fileSize = (Number(asset.fileSize) || 0) + bytes;
      var df = (asset.downloadedFiles || []).slice();
      state.copied.forEach(function (f) { if (df.indexOf(f.name) < 0) df.push(f.name); });
      asset.downloadedFiles = df;

      if (mode === 'version') {
        var vs = (asset.versions || []).slice();
        vs.forEach(function (v) { v.isLatest = false; });
        state.copied.forEach(function (f) {
          vs.push({
            name: (state.copied.length === 1 && String(state.verName || '').trim())
              ? String(state.verName).trim()
              : defaultVerName(f.srcName || f.name),
            fileName: f.name,
            size: f.size || 0,
            isLatest: true,
            local: true,                       // 本地登记：没有订单链接，不该算「未购买变体」
            note: '本地导入',
            addedAt: nowISO()
          });
        });
        asset.versions = vs;
      }
      return App.save(asset);
    }

    function runCover() {
      var img = list.filter(function (it) { return !it.isDir && isImage(it.name); })[0];
      if (!img) throw new Error('这批文件里没有图片');
      setProg('正在设置封面…', 30);
      var srcP = img.file ? Promise.resolve(img.file) : coverBlobFromPath(img.path);
      return srcP.then(function (blob) {
        if (!blob) throw new Error('读不到图片内容');
        return App.setCoverFromBlob(asset, blob);
      }).then(function () {
        setProg('封面已更新', 100);
        finish('封面已更新：' + (asset.title || asset.id), 'ok');
      });
    }

    function runFiles() {
      return FS.hostEnsure().then(function (ok) {
        if (!ok) throw new Error('程序后端未就绪，暂时写不进素材目录（请重启程序）');
        if (typeof Importer === 'undefined' || !Importer.ensureStoragePathQuiet) {
          throw new Error('缺少存储路径模块');
        }
        return Importer.ensureStoragePathQuiet(asset);
      }).then(function (dir) {
        if (!dir) throw new Error('这条素材还没有存储目录，自动创建也失败了（检查设置里的素材库根目录）');
        setProg('准备复制 ' + list.length + ' 个文件…', 0);
        var chain = Promise.resolve();
        list.forEach(function (it, i) {
          chain = chain.then(function () {
            if (!it.path) { state.failed.push(it.name + '：拿不到磁盘路径'); return null; }
            setProg('正在复制 ' + (i + 1) + '/' + list.length + '：' + it.name, (i / list.length) * 100);
            return freeName(dir, it.name).then(function (target) {
              return FS.host.copy(it.path, joinWinPath(dir, [target])).then(function () {
                state.copied.push({ name: target, srcName: it.name, size: it.size || 0 });
                if (target !== it.name) state.renamed.push(it.name + ' → ' + target);
              });
            }).catch(function (e) {
              state.failed.push(it.name + '：' + ((e && e.message) || e));
            });
          });
        });
        return chain.then(function () {
          if (!state.copied.length) throw new Error('一个文件都没复制进去：' + (state.failed[0] || '未知原因'));
          return applyRecord(state.mode);
        }).then(function () {
          var nameList = state.copied.map(function (f) { return f.name; });
          try { UI.renderAll(); } catch (e) {}
          if (App.detailAssetId === asset.id && typeof Modals !== 'undefined' && Modals.refreshAfterChange) {
            try { Modals.refreshAfterChange(asset, { keepModal: true }); } catch (e) {}
          }
          var tail = state.failed.length ? ('；' + state.failed.length + ' 个没进去（见下）') : '';
          setProg((state.mode === 'version' ? '已作为新版本放入 ' : '已放入 ') + state.copied.length
            + ' 个文件' + (state.renamed.length ? '，重名已改名' : '') + tail, 100);
          if (state.failed.length) {
            prog.appendChild(el('div', { class: 'pack-warn', text: state.failed.slice(0, 5).join('；') }));
          }
          finish('已放进「' + (asset.title || asset.id) + '」：' + nameList.slice(0, 3).join('、')
            + (nameList.length > 3 ? ' 等 ' + nameList.length + ' 个' : ''), state.failed.length ? 'warn' : 'ok');
        });
      });
    }

    function finish(msg, kind) {
      state.done = true;
      busy = false;
      btnRow.innerHTML = '';
      btnRow.appendChild(el('span', { class: 'grow' }));
      btnRow.appendChild(el('button', { class: 'btn btn-primary', onclick: function () { close(); } }, '完成'));
      if (kind === 'ok') Toast.ok(msg, 6000);
      else Toast.warn(msg, 7000);
    }

    function run() {
      if (busy || state.done) return;
      busy = true;
      okBtn.disabled = true;
      state.copied = []; state.renamed = []; state.failed = [];
      var job;
      try { job = (state.mode === 'cover') ? runCover() : runFiles(); }
      catch (e) { job = Promise.reject(e); }
      Promise.resolve(job).catch(function (e) {
        busy = false;
        okBtn.disabled = false;
        setProg('失败：' + ((e && e.message) || e), 0);
        Toast.err('没放进去：' + ((e && e.message) || e), 8000);
      });
    }

    btnRow.appendChild(el('span', { class: 'grow' }));
    btnRow.appendChild(el('button', { class: 'btn', onclick: function () { close(); } }, '取消'));
    btnRow.appendChild(okBtn);

    var body = el('div', { class: 'pack-body' }, [head, fileBox, optBox, verRow, prog, btnRow]);
    var handle = Modal.open({
      title: '放进这条素材',
      size: 'md',
      body: [body],
      onClose: function () { if (current === handle) current = null; }
    });
    current = handle;
    return Promise.resolve(true);
  }

  /* ---------------- 从菜单选文件（和拖入同一套预览） ---------------- */

  function pickFiles() {
    if (typeof FS === 'undefined' || !FS.host) { Toast.err('当前环境不支持文件导入'); return Promise.resolve(false); }
    return FS.hostEnsure().then(function (ok) {
      if (!ok) { Toast.err('程序后端未就绪：请重启「启动素材库_Electron版.bat」', 7000); return false; }
      return FS.host.pickFiles().then(function (r) {
        if (!r || r.ok === false || !(r.paths || []).length) return false;
        var paths = r.paths.slice(0, 200);
        return Promise.all(paths.map(function (p) {
          var getInfo = (typeof FS.host.stat === 'function')
            ? FS.host.stat(p)
            : FS.host.exists(p).then(function (kind) { return { kind: kind, size: 0 }; });
          return getInfo.then(function (j) {
            return { path: p, name: fileBaseName(p), size: Number(j && j.size) || 0, isDir: !!(j && j.kind === 'dir'), file: null };
          }).catch(function () {
            return { path: p, name: fileBaseName(p), size: 0, isDir: false, file: null };
          });
        })).then(function (items) {
          return open(items);
        });
      });
    }).catch(function (e) {
      Toast.err('选择文件失败：' + ((e && e.message) || e), 6000);
      return false;
    });
  }

  return {
    open: open,
    openIntoCard: openIntoCard,
    close: close,
    isOpen: isOpen,
    isTop: isTop,
    pickFiles: pickFiles,
    groupItems: groupItems,
    looksPack: looksPack,
    typeLabel: typeLabel
  };
})();
