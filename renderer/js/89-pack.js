/* ============ 89-pack.js ============ */
/* =====================================================================
 * 89-pack.js  —  素材包（.vrcpack）：导出与导入
 *
 * 定位（用户原话：「像 MC 的 PCL 启动器那样，打完整包」）：
 *   · 导出 = 把选中的素材连**文件本体**一起打成一个包，别人导入即用；
 *   · 包就是**标准 zip**，只是扩展名不同 —— 对方没装本程序，或只想看看里面有什么，
 *     双击 / 7-Zip 直接解压就是排好的「素材/<标题>/<原始文件>」，不会是打不开的私有格式；
 *   · 素材里的文件形态不限（zip / 7z / rar / unitypackage / 散文件目录都行），
 *     目录会**递归收全并保留子目录结构**，不会把 textures/ 这类结构摊平。
 *
 * 不做的事：不做在线传输。包怎么给到对方（微信 / 网盘 / U 盘）由用户自己决定。
 * ===================================================================== */

var Packer = (function () {
  var st = { busy: '', pct: 0, note: '', polling: null };

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
  function baseName(p) {
    var s = String(p == null ? '' : p).replace(/[\\/]+$/, '');
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function dirName(p) {
    var s = String(p == null ? '' : p).replace(/[\\/]+$/, '');
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i > 0 ? s.slice(0, i) : s;
  }
  function nowStamp() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }

  /* v6.6：单个素材包上限 1 GB。
     超了就按体积拆成 xxx-part1.vrcpack / part2 …，每个包都是**完整可独立导入**的，
     不是必须凑齐才能解的分卷。理由很实际：U 盘 FAT32 单文件上限 4 GB、
     微信/QQ 传文件有大小限制、部分网盘单文件也卡 1～4 GB，
     给对方一个 3 GB 的包等于让他没法接收。 */
  var PART_LIMIT = 1024 * 1024 * 1024;

  /** 按 fileSize 顺序装箱：同一素材不会被拆到两个包里，单个超限的素材自己占一包。 */
  function chunkBySize(items, limit) {
    var out = [], cur = [], curSize = 0;
    (items || []).forEach(function (a) {
      var sz = Number(a && a.fileSize) || 0;
      if (cur.length && curSize + sz > limit) { out.push(cur); cur = []; curSize = 0; }
      cur.push(a); curSize += sz;
    });
    if (cur.length) out.push(cur);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 收集待打包的文件                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * 一条素材 → [{ rel, path }]
   * 路径可能是单个压缩包，也可能是解压后的整个文件夹：
   *   · 文件  → 直接收，rel = 文件名
   *   · 目录  → **递归全收**，rel = 相对该目录的路径（保留 textures/、materials/ 这类子结构）
   */
  function collectFiles(asset) {
    var roots = ((asset && asset.paths) || [])
      .map(function (p) { return p && p.path ? String(p.path).trim() : ''; })
      .filter(function (p) { return !!p; });

    var out = [];
    var seen = Object.create(null);
    var chain = Promise.resolve();

    roots.forEach(function (root) {
      chain = chain.then(function () {
        return FS.host.exists(root).then(function (kind) {
          if (kind === 'file') {
            var name = baseName(root);
            /* v4.3.2：去重键必须带来源路径。以前只按文件名比，
             * 一条素材同时登记了「原始位置」和「存储路径」时，两个目录里的同名文件
             * 只会被打进包里一份，另一份静默消失。 */
            var fkey = root + '\u0000' + name;
            if (name && !seen[fkey]) { seen[fkey] = 1; out.push({ rel: name, path: root, size: 0 }); }
            return;
          }
          if (kind !== 'dir') return;
          return FS.host.scan(root, 0).then(function (entries) {     // maxDepth=0 → 全递归
            (entries || []).forEach(function (e) {
              if (!e || e.kind !== 'file') return;
              var rel = String(e.rel || e.name || '');
              var key = root + '\u0000' + rel;
              if (!rel || seen[key]) return;
              seen[key] = 1;
              out.push({ rel: rel, path: joinWinPath(root, [rel]), size: e.size || 0 });
            });
          });
        }).catch(function () {});
      });
    });

    return chain.then(function () { return out; });
  }

  /** 封面转 base64（封面只存在 IndexedDB 的 blob 里，没有稳定磁盘路径，直接读出来塞进包） */
  function coverData(asset) {
    if (!asset || !asset.hasCover) return Promise.resolve(null);
    /* v6.1：磁盘上已有 covers\<id>.<ext> 就直接交路径，让 Rust 侧流式写进包。
     * 只有「封面仅存在于 IndexedDB」的老数据才退回 base64。 */
    var preferPath = !!(typeof FS !== 'undefined' && FS.host && FS.host.bytesSupported && FS.host.bytesSupported());
    if (preferPath && App.diskCoverFile) {
      return App.diskCoverFile(asset).then(function (f) {
        if (f && f.path) {
          var e = String(f.name || f.path).toLowerCase().match(/\.([a-z0-9]+)$/);
          return { path: f.path, ext: '.' + (e ? e[1].replace('jpeg', 'jpg') : 'jpg') };
        }
        return coverBase64(asset);
      }).catch(function () { return coverBase64(asset); });
    }
    return coverBase64(asset);
  }

  function coverBase64(asset) {
    return App.coverURLFor(asset).then(function (url) {
      if (!url) return null;
      return fetch(url).then(function (r) { return r.blob(); }).then(function (blob) {
        if (!blob || !blob.size || blob.size > 8 * 1024 * 1024) return null;
        return new Promise(function (resolve) {
          var fr = new FileReader();
          fr.onload = function () {
            var s = String(fr.result || '');
            var i = s.indexOf(',');
            if (i < 0) return resolve(null);
            var m = /^data:image\/([a-z0-9+]+)/i.exec(s);
            var ext = '.' + ((m && m[1] ? m[1] : 'jpg').replace('jpeg', 'jpg'));
            resolve({ b64: s.slice(i + 1), ext: ext });
          };
          fr.onerror = function () { resolve(null); };
          fr.readAsDataURL(blob);
        });
      });
    }).catch(function () { return null; });
  }

  /* ------------------------------------------------------------------ */
  /* 导出                                                                */
  /* ------------------------------------------------------------------ */

  function exportDialog(list, presetScope) {
    list = (list || []).filter(Boolean);
    if (!list.length) { Toast.warn('先选中要导出的素材'); return; }

    var opt = { withFiles: true, withCovers: true, withNote: false, withPrice: false };
    /* 署名：对方导入时会显示「来自「X」」，并作为他的落地目录名。
     * 记进设置里，下次导出自动带出。 */
    var signName = String((App.settings && App.settings.nickname) || '').trim();
    var totalBytes = 0;
    list.forEach(function (a) { totalBytes += Number(a.fileSize || 0); });

    var body = el('div', { class: 'pack-body' });
    var prog = el('div', { class: 'pack-prog', style: { display: 'none' } });
    var btnRow = el('div', { class: 'btn-row' });

    function render() {
      body.innerHTML = '';
      body.appendChild(el('div', { class: 'pack-summary' }, [
        el('b', { text: '共 ' + list.length + ' 个素材' }),
        el('span', { class: 'pack-dim', text: ' · 记录体积约 ' + fmtSize(totalBytes) + '（实际以打包结果为准）' })
      ]));

      var partCount = chunkBySize(list, PART_LIMIT).length;
      if (partCount > 1) {
        body.appendChild(el('div', { class: 'pack-sec' }, [
          el('div', { class: 'pack-label', text: '分包导出' }),
          el('p', { class: 'field-hint', text:
            '超过 1 GB，会拆成 ' + partCount + ' 个包：文件名后面加 -part1、-part2…… '
            + '每个包都能单独拖进程序导入，不用按顺序、也不用凑齐。' })
        ]));
      }

      body.appendChild(el('div', { class: 'pack-sec' }, [
        el('label', { class: 'pack-check' }, [
          el('input', {
            type: 'checkbox', checked: opt.withFiles,
            onchange: function () { opt.withFiles = this.checked; render(); }
          }),
          el('span', {}, [
            el('b', { text: '包含文件本体（完整包）' }),
            el('span', { class: 'pack-dim', text: ' —— 不勾只导出清单和封面，对方能看不能直接用' })
          ])
        ]),
        el('label', { class: 'pack-check' }, [
          el('input', {
            type: 'checkbox', checked: opt.withCovers,
            onchange: function () { opt.withCovers = this.checked; }
          }),
          el('span', { text: '包含封面' })
        ]),
        el('label', { class: 'pack-check' }, [
          el('input', {
            type: 'checkbox', checked: opt.withNote,
            onchange: function () { opt.withNote = this.checked; }
          }),
          el('span', {}, [
            el('span', { text: '包含备注' }),
            el('span', { class: 'pack-dim', text: '（备注常写私下信息，默认不带）' })
          ])
        ]),
        /* 对方想要「我库里都有啥」时，只要这份清单就够了 —— 一键切到纯清单模式，不用逐项取消 */
        el('div', { class: 'btn-row' }, [
          el('button', {
            class: 'btn btn-sm',
            title: '只导出元数据与封面，几百 KB；对方拿到后可以和自己的库对比',
            onclick: function () {
              opt.withFiles = false; opt.withCovers = false;
              render();
              Toast.info('已切到「只导清单」：对方导入后是未下载状态，或用于「清单对比」', 6000);
            }
          }, '只导清单（不打包文件）')
        ])
      ]));

      body.appendChild(el('div', { class: 'pack-sec' }, [
        el('div', { class: 'pack-label', text: '署名（对方能看到，也决定他那边解到哪个子目录）' }),
        el('input', {
          class: 'input', type: 'text', placeholder: '例如：阿岚', value: signName,
          oninput: function () { signName = this.value; }
        })
      ]));

      body.appendChild(el('p', { class: 'field-hint', text:
        '包就是标准 zip，只是扩展名不同：对方没有本程序也能直接解压，里面是「素材\\<标题>\\<原始文件>」，'
        + '解压后的目录结构会完整保留。' }));

      body.appendChild(prog);
      btnRow.innerHTML = '';
      btnRow.appendChild(el('span', { class: 'grow' }));
      btnRow.appendChild(el('button', { class: 'btn', onclick: function () { Modal.close(handle); } }, '取消'));
      btnRow.appendChild(el('button', { class: 'btn btn-primary', onclick: doExport }, '选择保存位置并导出'));
      body.appendChild(btnRow);
    }

    function setProg(text, pct) {
      prog.style.display = '';
      prog.innerHTML = '';
      prog.appendChild(el('div', { class: 'pack-prog-text', text: text }));
      prog.appendChild(el('div', { class: 'pack-prog-bar' }, [
        el('i', { style: { width: Math.max(0, Math.min(100, pct || 0)) + '%' } })
      ]));
    }

    function setButtonsDisabled(dis) {
      Array.prototype.forEach.call(btnRow.querySelectorAll('button'), function (b) { b.disabled = dis; });
    }

    function doExport() {
      var name = '素材包_' + nowStamp() + '.vrcpack';
      FS.host.saveFile({
        title: '保存素材包',
        defaultPath: joinWinPath(App.libraryRoot(), [name]),
        filters: [
          { name: '素材包', extensions: ['vrcpack'] },
          { name: '普通 zip（对方没装本程序也能解压）', extensions: ['zip'] }
        ]
      }).then(function (r) {
        if (!r || r.ok === false) return null;
        var outPath = r.path;
        if (!/\.(vrcpack|zip)$/i.test(outPath)) outPath += '.vrcpack';

        setButtonsDisabled(true);

        /* 超过 1 GB 就分批：文件名加 -part1 / -part2…，每个包都能单独导入 */
        var chunks = chunkBySize(list, PART_LIMIT);
        var multi = chunks.length > 1;
        var m = outPath.match(/\.(vrcpack|zip)$/i);
        var ext = m ? m[0] : '.vrcpack';
        var base = outPath.slice(0, outPath.length - ext.length);
        var results = [];

        var chain = Promise.resolve();
        chunks.forEach(function (items, idx) {
          chain = chain.then(function () {
            var partPath = multi ? base + '-part' + (idx + 1) + ext : outPath;
            var tag = multi ? '分包 ' + (idx + 1) + '/' + chunks.length : '';
            return exportChunk(items, partPath, tag).then(function (res) { results.push(res); });
          });
        });

        return chain.then(function () {
          stopPoll();
          var nm = String(signName || '').trim();
          if (nm && App.settings.nickname !== nm) { App.settings.nickname = nm; App.saveSettings(); }
          Modal.close(handle);
          var cnt = 0, files = 0, bytes = 0;
          results.forEach(function (x) {
            cnt += Number(x.count || 0);
            files += Number(x.files || 0);
            bytes += Number(x.packageBytes || 0);
          });
          if (!multi) {
            Toast.ok('已导出 ' + cnt + ' 个素材、' + files + ' 个文件，包体 ' + fmtSize(bytes), 7000);
            Toast.info('位置：' + results[0].path, 9000);
          } else {
            Toast.ok('已导出 ' + cnt + ' 个素材、' + files + ' 个文件，分成 ' + results.length + ' 个包（合计 ' + fmtSize(bytes) + '）', 9000);
            results.forEach(function (x, i2) { Toast.info('第 ' + (i2 + 1) + ' 包：' + x.path, 9000); });
          }
          Toast.info('对方收到后，把包直接拖进程序窗口就能导入（也可以双击解压当普通压缩包用）', 9000);
          /* openPath 是「触发式」的：它内部自己处理失败并给提示，返回 undefined（没有 Promise）——
           * 这里加 .catch 会直接抛 "Cannot read properties of undefined"。 */
          try { FS.openPath(dirName(results[0].path)); } catch (e) {}
        });
      }).catch(function (e) {
        stopPoll();
        setButtonsDisabled(false);
        setProg('失败：' + ((e && e.message) || e), 0);
        Toast.err('导出失败：' + ((e && e.message) || e), 7000);
      });
    }

    /** 收集这一批素材的文件与封面，写成一个包（分包由 doExport 决定调用几次） */
    function exportChunk(items, partPath, tag) {
      var entries = [];
      var chain = Promise.resolve();
      items.forEach(function (a, i) {
        chain = chain.then(function () {
          setProg((tag ? tag + ' · ' : '') + '正在整理 ' + (i + 1) + '/' + items.length + '：' + (a.title || '未命名'), (i / items.length) * 100);
          return Promise.all([
            opt.withFiles ? collectFiles(a) : Promise.resolve([]),
            opt.withCovers ? coverData(a) : Promise.resolve(null)
          ]).then(function (r) {
            entries.push({
              id: a.id,
              title: a.title, originalTitle: a.originalTitle,
              category: a.category, source: a.source,
              tags: a.tags, avatars: a.avatars,
              itemId: a.itemId, shop: a.shop, author: a.author,
              /* v6.6：带上商店链接 —— 接收方靠它判重（对方库里同链接的素材能认出来）。
                 下载直链（downloadLinks）故意不带：那是本人的订单地址，给出去等于把付费内容送人。 */
              links: (a.links || []).slice(),
              isFree: a.isFree, fileSize: a.fileSize,
              note: a.note,
              purchasePrice: a.purchasePrice, purchaseCurrency: a.purchaseCurrency,
              files: r[0],
              /* v6.1：Tauri 下封面走磁盘路径（后端直接流式写进包），不再转 base64；
               * Electron 仍走 base64 分支，两边产物完全一致。 */
              coverPath: r[1] && r[1].path ? r[1].path : '',
              coverBase64: r[1] && r[1].b64 ? r[1].b64 : '',
              coverExt: r[1] ? r[1].ext : ''
            });
          });
        });
      });
      return chain.then(function () {
        setProg((tag ? tag + ' · ' : '') + '正在写入素材包…（大文件请稍候，不要关闭窗口）', 0);
        startPoll(tag);
        return FS.host.pack('export', {
          outPath: partPath,
          withFiles: opt.withFiles,
          withCovers: opt.withCovers,
          withNote: opt.withNote,
          withPrice: false,
          exporter: {
            deviceId: (App.settings.deviceId || ''),
            nickname: String(signName || '').trim()
          },
          entries: entries
        });
      });
    }

    function startPoll(tag) {
      stopPoll();
      st.polling = setInterval(function () {
        FS.host.pack('progress', {}).then(function (p) {
          if (!p) return;
          if (p.running) {
            var pct = p.total ? (p.done / p.total) * 100 : 0;
            setProg((tag ? tag + ' · ' : '') + '正在打包 ' + (p.done || 0) + '/' + (p.total || 0)
              + ' · 已写入 ' + fmtSize(p.bytes || 0)
              + (p.current ? ' · ' + p.current : ''), pct);
          }
        }).catch(function () {});
      }, 500);
    }
    function stopPoll() { if (st.polling) { clearInterval(st.polling); st.polling = null; } }

    var handle = Modal.open({
      title: '导出素材包',
      size: 'md',
      body: [body],
      onClose: stopPoll
    });
    render();
  }

  /* ------------------------------------------------------------------ */
  /* 导入                                                                */
  /* ------------------------------------------------------------------ */

  /* 当前打开的「导入素材包」预览弹窗 —— 拖入新包时允许直接替换它自己 */
  var packModal = null;

  /** 读取并预览一个素材包。path 可能来自原生对话框，也可能来自拖拽。
   *  两个入口共用这一段：先 inspect（只读清单，不解包），再由用户确认。 */
  function importPath(path) {
    var p = String(path || '').trim();
    if (!p) { Toast.warn('没有拿到文件路径'); return Promise.resolve(false); }
    /* 已经开着一个预览时（拖入第二个包）先关掉，否则两个预览会叠在一起，
     * 用户在下面那个点了「开始导入」却不知道导入的其实是哪个包。 */
    if (packModal) { try { Modal.close(packModal); } catch (e) {} packModal = null; }
    Toast.info('正在读取素材包…', 2000);
    return FS.host.pack('inspect', { path: p }).then(function (res) {
      showPreview(p, res);
      return true;
    }).catch(function (e) {
      Toast.err('读取失败：' + ((e && e.message) || e), 8000);
      return false;
    });
  }

  function importDialog() {
    FS.host.pickOneFile({
      title: '选择素材包',
      filters: [
        { name: '素材包', extensions: ['vrcpack', 'zip'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    }).then(function (r) {
      if (!r || r.ok === false) return;
      return importPath(r.path);
    }).catch(function (e) {
      Toast.err('读取失败：' + ((e && e.message) || e), 8000);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 拖拽导入（v4.2.1）                                                   */
  /* ------------------------------------------------------------------ */

  /** 把 drop 事件里的 File 换成磁盘路径。
   *  Electron 32 起 File.path 被移除，必须走 preload 的 webUtils.getPathForFile；
   *  其它环境（旧壳 / 浏览器）退回 file.path。 */
  function filePathOf(file) {
    try {
      if (window.vrcElectron && typeof window.vrcElectron.getPathForFile === 'function') {
        var p = window.vrcElectron.getPathForFile(file);
        if (p) return String(p);
      }
    } catch (e) {}
    try { return String((file && file.path) || ''); } catch (e2) { return ''; }
  }

  /** 有别的弹窗开着时不抢拖拽 —— 否则在素材编辑页拖一下就被导入打断了。
   *  例外：「导入素材包」预览 与 通用「导入素材」预览 允许被新拖入的文件替换。 */
  function modalBlocked() {
    var stack = (typeof Modal !== 'undefined' && Modal.stack) ? Modal.stack : [];
    if (!stack.length) return false;
    var top = stack[stack.length - 1];
    if (top === packModal) return false;
    if (typeof DropImport !== 'undefined' && DropImport.isTop && DropImport.isTop()) return false;
    return true;
  }

  function extOfName(name) {
    var m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  /**
   * v4.4：拖入的文件按「内容」而不是按「扩展名白名单」分流。
   *   · 单个 .vrcpack        → 素材包预览（原有行为）
   *   · 单个 .zip            → 先当素材包试读；没有 vrcpack.json 就是普通压缩包 → 通用导入
   *   · unitypackage / rar / 7z / 文件夹 / 其它 → 通用导入（89b-drop-import.js）
   * 以前这里只放行 .vrcpack / .zip，拖 unitypackage 或普通 zip 直接报「只支持素材包」。
   */
  function routeDropped(items) {
    var paths = items.map(function (it) { return it.path; }).filter(Boolean);
    if (!paths.length) {
      Toast.err('没拿到文件路径，请改用「导入 → 从文件导入」', 6000);
      return false;
    }
    return Promise.all(paths.map(function (p) {
      return FS.host.exists(p).catch(function () { return null; });
    })).then(function (kinds) {
      items.forEach(function (it, i) { it.isDir = kinds[i] === 'dir'; });

      /* 素材包优先：拖进来的只要有 .vrcpack，就按素材包导入（多拖的其它文件只提示） */
      var packItem = null;
      items.forEach(function (it) { if (!it.isDir && /\.vrcpack$/i.test(it.name)) packItem = packItem || it; });
      if (packItem) {
        if (items.length > 1) Toast.info('一次只导入一个素材包，已先处理：' + packItem.name, 5000);
        return importPath(packItem.path);
      }

      /* 单个 zip：能读出 vrcpack.json 就是素材包，否则当普通压缩包进通用导入 */
      if (items.length === 1 && !items[0].isDir && extOfName(items[0].name) === 'zip') {
        Toast.info('正在检查「' + items[0].name + '」…', 2000);
        return FS.host.pack('inspect', { path: items[0].path }).then(function (res) {
          showPreview(items[0].path, res);
          return true;
        }).catch(function () {
          return (typeof DropImport !== 'undefined')
            ? DropImport.open(items)
            : (Toast.warn('只支持 .vrcpack / .zip 素材包', 6000), false);
        });
      }

      if (typeof DropImport === 'undefined') {
        Toast.warn('只支持 .vrcpack / .zip 素材包', 6000);
        return false;
      }
      return DropImport.open(items);
    });
  }

  function installDropZone() {
    var HINT = '松开即可导入素材（素材包 / zip / unitypackage / 文件夹）';
    var hideTimer = null;

    function hasFiles(e) {
      var dt = e && e.dataTransfer;
      if (!dt || !dt.types) return false;
      /* v5.2：页面内拖出来的图片也会带 Files，但同时带 text/html —— 那不是「拖文件进来」 */
      for (var j = 0; j < dt.types.length; j++) {
        if (dt.types[j] === 'text/html' || dt.types[j] === 'text/uri-list') return false;
      }
      for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
      return false;
    }

    /* ---- v4.7：把图片拖到缩略图上 = 设为封面（卡片封面 + 详情页大图） ---- */
    var IMG_RE = /\.(png|jpe?g|webp|gif|bmp|tga|tiff?)$/i;
    function coverOf(e) {
      var el = e && e.target;
      while (el && el.nodeType === 1) {
        if (el.classList && (el.classList.contains('card-cover') || el.classList.contains('detail-cover'))) return el;
        el = el.parentNode;
      }
      return null;
    }
    function onlyImages(dt) {
      var items = (dt && dt.items) || [], n = 0;
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind !== 'file') continue;
        n++;
        if (!/^image\//.test(items[i].type || '')) return false;
      }
      return n > 0;
    }
    function filesOnlyImages(files) {
      if (!files || !files.length) return false;
      for (var i = 0; i < files.length; i++) if (!IMG_RE.test(String(files[i].name || ''))) return false;
      return true;
    }
    var markedCover = null;
    function markCover(cv) {
      if (markedCover === cv) return;
      if (markedCover) markedCover.classList.remove('cov-drop');
      markedCover = cv;
      if (cv) cv.classList.add('cov-drop');
    }
    function unmarkCover() {
      if (markedCover) { markedCover.classList.remove('cov-drop'); markedCover = null; }
    }
    function coverAssetOf(cv) {
      /* 详情页的大图：弹窗 handle 上只有 assetId 不在 DOM 里，用 App.detailAssetId（syncDetailId 维护） */
      if (cv && cv.classList && cv.classList.contains('detail-cover')) {
        var did = String(App.detailAssetId || '');
        if (!did) return null;
        return (App.assets || []).filter(function (x) { return x.id === did; })[0] || null;
      }
      var el = cv;
      while (el && el.nodeType === 1) {
        var id = el.dataset && el.dataset.id;
        if (id) return (App.assets || []).filter(function (x) { return x.id === id; })[0] || null;
        el = el.parentNode;
      }
      return null;
    }
    function show(text) {
      document.body.setAttribute('data-drop-hint', text || HINT);
      document.body.classList.add('dragging');
    }
    function hide() {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      document.body.classList.remove('dragging');
      document.body.removeAttribute('data-drop-hint');
      unmarkCover();
    }

    /* dragover 在鼠标移动时持续触发，所以用「400ms 没新事件」判断离开了窗口，
     * 比 dragleave 可靠 —— dragleave 会在移入子元素时误触发，且此时 types 常常是空的。 */
    window.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();

      /* v4.7：悬停在缩略图 / 详情页大图上、且拖的全是图片 → 改成「设为封面」的落点提示。
       * 详情页大图本身就在弹窗里，所以这一条要放行；其它元素仍按「有窗口开着」拦。 */
      var cvHit = coverOf(e);
      var cv = null;
      if (cvHit) {
        if (cvHit.classList.contains('detail-cover') || !modalBlocked()) cv = cvHit;
      }
      if (cv && onlyImages(e.dataTransfer)) {
        markCover(cv);
        document.body.classList.remove('dragging');     // 别让整屏遮罩盖住缩略图
        document.body.removeAttribute('data-drop-hint');
        try { e.dataTransfer.dropEffect = 'copy'; } catch (err) {}
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, 400);
        return;
      }
      unmarkCover();

      try { e.dataTransfer.dropEffect = modalBlocked() ? 'none' : 'copy'; } catch (err) {}
      show(modalBlocked() ? '先关掉当前窗口，再松开导入' : HINT);
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 400);
    }, false);

    window.addEventListener('dragleave', function (e) {
      if (!e.relatedTarget) hide();     // relatedTarget 为空 = 真的离开了页面
    }, false);

    /* 走冒泡阶段：素材编辑页的图集拖拽区自己 stopPropagation，不会误触发这里 */
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      hide();

      var files = e.dataTransfer.files || [];
      if (!files.length) return;

      /* v4.7：拖到某个卡片的缩略图上、且全是图片 → 设为该素材的封面，不进导入流程 */
      var cvDrop = coverOf(e);
      if (cvDrop && filesOnlyImages(files)) {
        var coverAsset = coverAssetOf(cvDrop);
        if (coverAsset) {
          Toast.info('正在设置封面 …', 1800);
          App.setCoverFromBlob(coverAsset, files[0]).then(function () {
            Toast.ok('封面已更新：' + (coverAsset.title || coverAsset.id), 3600);
          }).catch(function (err) {
            Toast.err('设置封面失败：' + ((err && err.message) || err), 6000);
          });
          return;
        }
      }

      if (modalBlocked()) { Toast.warn('还有窗口开着，请先关掉它再拖入素材', 4200); return; }

      /* 允许新拖入替换掉自己开着的预览，避免两个预览叠在一起 */
      if (packModal) { try { Modal.close(packModal); } catch (err) {} packModal = null; }
      if (typeof DropImport !== 'undefined') DropImport.close();

      var items = [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var p = filePathOf(f);
        var nm = String(f.name || '') || (p ? baseName(p) : '');
        if (!p && !nm) continue;
        items.push({ path: p, name: nm, size: Number(f.size) || 0, file: f, isDir: false });
      }
      if (!items.length) { Toast.err('没拿到文件路径，请改用「导入 → 从文件导入」', 6000); return; }
      if (typeof FS === 'undefined' || !FS.host) {
        Toast.warn('当前环境不支持拖拽导入，请用「导入」菜单里的入口', 6000);
        return;
      }
      /* 兜一层 Promise.resolve：routeDropped 有的分支会同步 return true/false（比如单个 zip 检查失败），
       * 直接 .catch 会在这种分支上抛「catch is not a function」。 */
      Promise.resolve(routeDropped(items)).catch(function (err) {
        Toast.err('导入失败：' + ((err && err.message) || err), 8000);
      });
    }, false);
  }

  /* ------------------------------------------------------------------ */
  /* 清单对比（v4.3.0）                                                  */
  /*                                                                     */
  /* 场景：朋友把「他库里已经有什么」导出成清单发给你，你想知道**自己有什么是他没有的**， */
  /*       挑出来打包补给他。方向和导入正好相反 —— 这里只读清单、只读本库，不写任何数据。 */
  /* ------------------------------------------------------------------ */

  function normKey(s) {
    return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
  }

  function hasLocalFiles(a) {
    return !!(a && Array.isArray(a.paths) && a.paths.length);
  }

  /** 清单里出现过就算「对方已有」。判据：商品 ID → 标题 → 原标题（后两者忽略空格与大小写）。
   *  只认这三样是为了让清单格式保持最小；商品 ID 填了的情况下几乎不会误判。 */
  function diffAgainst(manifest) {
    var metas = (manifest && Array.isArray(manifest.assets)) ? manifest.assets : [];
    var ids = Object.create(null);
    var titles = Object.create(null);
    metas.forEach(function (m) {
      var iid = String(m.itemId || '').trim();
      if (iid) ids[iid] = 1;
      var t = normKey(m.title); if (t) titles[t] = 1;
      var o = normKey(m.originalTitle); if (o) titles[o] = 1;
    });

    var mine = (App.assets || []).slice();
    var missing = [];
    var matched = 0;
    mine.forEach(function (a) {
      var iid = String(a.itemId || '').trim();
      var t = normKey(a.title);
      var o = normKey(a.originalTitle);
      var has = (iid && ids[iid]) || (t && titles[t]) || (o && titles[o]);
      if (has) { matched++; return; }
      missing.push(a);
    });
    return { mineTotal: mine.length, listedTotal: metas.length, matched: matched, missing: missing };
  }

  /* ---------------- 相似项提示（v4.3.1） ----------------
   * 严格判据（商品 ID / 标题全等）解决不了「同一件东西两边起了不同名字」。这里再给每条差集
   * 找「对方清单里最像的一条」，命中就标出来交给人判断 —— 只提示，**不改变**有无的判定。 */

  var SIM_THRESHOLD = 0.45;    // 低于这个值不值得打扰用户
  /* 比较次数上限：实测 1000×1000 约 450ms，再多会让打开窗口明显停顿。
   * 超过就跳过相似提示（严格匹配照常），并在摘要里说明一句。 */
  var SIM_WORK_LIMIT = 700000;

  /** 二元组多重集：中文没有空格，bigram 比编辑距离更抗换序与错字 */
  function bigramMap(s) {
    var t = String(s || '');
    var map = Object.create(null);
    var n = 0;
    if (t.length === 1) { map[t] = 1; return { map: map, len: 1 }; }
    for (var i = 0; i < t.length - 1; i++) {
      var g = t.substr(i, 2);
      map[g] = (map[g] || 0) + 1;
      n++;
    }
    return { map: map, len: n };
  }

  function prepTitle(s) {
    var t = normKey(s);
    return { s: t, g: t ? bigramMap(t) : null };
  }

  function diceMaps(a, b) {
    if (!a || !b || !a.len || !b.len) return 0;
    var hit = 0;
    for (var k in a.map) if (b.map[k]) hit += Math.min(a.map[k], b.map[k]);
    return (2 * hit) / (a.len + b.len);
  }

  /** 一方包含另一方 → 0.9。长度差再大也是强信号（「冬季毛衣」⊂「冬季毛衣套装（日版）」）。
   *  但被包含的一侧至少 3 个字：两字标题（「帽子」「眼镜」）会命中一切含它的长标题，纯噪声。 */
  function containsScore(a, b) {
    if (!a || !b || !a.s || !b.s || a.s === b.s) return 0;
    var shorter = a.s.length <= b.s.length ? a.s : b.s;
    var longer = shorter === a.s ? b.s : a.s;
    if (shorter.length < 3) return 0;
    return longer.indexOf(shorter) >= 0 ? 0.9 : 0;
  }

  function simPrep(a, b) {
    if (!a || !b || !a.s || !b.s) return 0;
    if (a.s === b.s) return 1;
    var c = containsScore(a, b);
    if (c) return c;
    return diceMaps(a.g, b.g);
  }

  /** → { hits: {素材id → {title,itemId,score}}, skipped: bool } */
  function annotateSimilar(missing, metas) {
    var hits = Object.create(null);
    var pool = (metas || []).map(function (m) {
      return {
        title: String(m.title || ''),
        itemId: String(m.itemId || ''),
        t: prepTitle(m.title),
        o: prepTitle(m.originalTitle)
      };
    }).filter(function (p) { return p.t.s || p.o.s; });

    if (!pool.length || !missing.length) return { hits: hits, skipped: false };
    if (missing.length * pool.length > SIM_WORK_LIMIT) return { hits: hits, skipped: true };

    missing.forEach(function (a) {
      var at = prepTitle(a.title);
      var ao = prepTitle(a.originalTitle);
      var alen = Math.max(at.s.length, ao.s.length);
      var best = null;
      var bestScore = 0;

      for (var i = 0; i < pool.length; i++) {
        var p = pool[i];
        var plen = Math.max(p.t.s.length, p.o.s.length);

        /* 包含关系要先判：'冬季毛衣' 被 '冬季毛衣套装（日版）' 包含是强信号，
         * 但两者长度比只有 0.4 —— 如果先做长度剪枝，这种最典型的情况会被误杀。 */
        var cs = Math.max(
          containsScore(at, p.t), containsScore(at, p.o),
          containsScore(ao, p.t), containsScore(ao, p.o)
        );
        if (cs) { if (cs > bestScore) { bestScore = cs; best = p; } continue; }

        /* 长度差太大不可能是同一件，剪掉 —— 绝大多数比较挡在这里 */
        if (alen && plen && Math.min(alen, plen) / Math.max(alen, plen) < 0.45) continue;
        var s = Math.max(
          simPrep(at, p.t), simPrep(at, p.o),
          simPrep(ao, p.t), simPrep(ao, p.o)
        );
        if (s > bestScore) { bestScore = s; best = p; }
      }

      if (best && bestScore >= SIM_THRESHOLD) {
        hits[a.id] = {
          title: best.title || best.itemId || '（无标题）',
          itemId: best.itemId,
          score: bestScore
        };
      }
    });
    return { hits: hits, skipped: false };
  }

  function compareDialog(path) {
    if (!path) {
      return FS.host.pickOneFile({
        title: '选择对方的清单',
        filters: [
          { name: '素材包 / 清单', extensions: ['vrcpack', 'zip'] },
          { name: '全部文件', extensions: ['*'] }
        ]
      }).then(function (r) {
        if (!r || r.ok === false) return false;
        return compareDialog(r.path);
      }).catch(function (e) {
        Toast.err('打开失败：' + ((e && e.message) || e), 6000);
        return false;
      });
    }
    Toast.info('正在读取清单…', 2000);
    return FS.host.pack('inspect', { path: path }).then(function (res) {
      showCompare(path, res);
      return true;
    }).catch(function (e) {
      Toast.err('读取清单失败：' + ((e && e.message) || e), 8000);
      return false;
    });
  }

  function showCompare(path, res) {
    var mf = res.manifest || {};
    var from = String((mf.exporter && mf.exporter.nickname) || '').trim();
    var diff = diffAgainst(mf);
    var simRes = annotateSimilar(diff.missing, mf.assets || []);
    var similar = simRes.hits;
    var simCount = Object.keys(similar).length;

    var sel = Object.create(null);      // id → 1
    var rowMap = Object.create(null);   // id → 行元素（只改 class，避免重渲染丢滚动位置）
    var keyword = '';
    var hideSimilar = false;

    /* 默认勾选策略：有本地文件 **且** 没有疑似重复的。
     * 疑似项一律先不勾 —— 这正是「人工筛选」的落点：让用户逐条确认后再决定发不发。 */
    diff.missing.forEach(function (a) {
      if (hasLocalFiles(a) && !similar[a.id]) sel[a.id] = 1;
    });

    var listBox = el('div', { class: 'cmp-list' });
    var infoLine = el('div', { class: 'cmp-info' });
    var btnExport = el('button', { class: 'btn btn-primary' }, ICONS.label('\u{1F4E6} 导出选中项'));
    var searchIn = el('input', {
      class: 'input', type: 'search', placeholder: '搜索标题 / 店铺 / 标签…',
      oninput: function () { keyword = this.value; renderList(); }
    });

    function picked() {
      return diff.missing.filter(function (a) { return sel[a.id]; });
    }
    function refreshInfo() {
      var p = picked();
      var bytes = 0;
      p.forEach(function (a) { bytes += Number(a.fileSize || 0); });
      var noFile = p.filter(function (a) { return !hasLocalFiles(a); }).length;
      var simSel = p.filter(function (a) { return similar[a.id]; }).length;
      infoLine.textContent = '已选 ' + p.length + ' / ' + diff.missing.length + ' 项'
        + (p.length ? ' · 记录体积约 ' + fmtSize(bytes) : '')
        + (noFile ? '（其中 ' + noFile + ' 项没有本地文件，包里只有它的信息）' : '')
        + (simSel ? '（含 ' + simSel + ' 项疑似他已有，确认后再发）' : '');
      btnExport.disabled = !p.length;
    }
    function setSel(a, on) {
      if (on) sel[a.id] = 1; else delete sel[a.id];
      var row = rowMap[a.id];
      if (row) row.classList.toggle('on', !!on);
      refreshInfo();
    }
    function visibleList() {
      var kw = String(keyword || '').trim().toLowerCase();
      var out = diff.missing;
      if (hideSimilar) out = out.filter(function (a) { return !similar[a.id]; });
      if (!kw) return out;
      return out.filter(function (a) {
        var hay = [a.title, a.originalTitle, a.shop, a.author, a.category,
          (a.tags || []).join(' '), (a.avatars || []).join(' ')].join(' ').toLowerCase();
        return hay.indexOf(kw) >= 0;
      });
    }
    function rowOf(a) {
      var has = hasLocalFiles(a);
      var cb = el('input', { type: 'checkbox' });
      cb.checked = !!sel[a.id];
      cb.addEventListener('change', function () { setSel(a, cb.checked); });

      var chips = [];
      if (a.category) chips.push(el('span', { class: 'chip', text: App.categoryLabel(a.category) }));
      (a.avatars || []).slice(0, 2).forEach(function (id) {
        chips.push(el('span', { class: 'chip', text: App.avatarLabel(id) }));
      });
      if (!has) chips.push(el('span', { class: 'chip chip-dim', text: '无本地文件' }));

      /* 疑似重复：给最像的那条清单项，连相似度一起显示 —— 这是给人判断用的，不是自动结论 */
      var sim = similar[a.id];
      if (sim) {
        chips.push(el('span', {
          class: 'chip chip-warn',
          title: '对方清单里最像的一条：' + sim.title + (sim.itemId ? '（ID ' + sim.itemId + '）' : '')
            + ' · 相似度 ' + Math.round(sim.score * 100) + '%\n如果确实是同一件，就不要发；确认他没有，勾上即可。',
          text: '疑似他有 · ' + sim.title + ' ' + Math.round(sim.score * 100) + '%'
        }));
      }

      var row = el('label', { class: 'cmp-row' + (sel[a.id] ? ' on' : '') }, [
        cb,
        el('div', { class: 'cmp-main' }, [
          el('div', { class: 'cmp-title', title: a.title || '', text: a.title || '（无标题）' }),
          el('div', { class: 'cmp-sub', text: [a.originalTitle, a.shop].filter(Boolean).join(' · ') }),
          chips.length ? el('div', { class: 'cmp-chips' }, chips) : null
        ]),
        el('div', { class: 'cmp-right', text: a.fileSize ? fmtSize(a.fileSize) : '—' })
      ]);
      /* 点整行也能勾选；点在 checkbox 上时交给它自己处理，别叠加成「切换两次」 */
      row.addEventListener('click', function (e) {
        if (e.target === cb) return;
        e.preventDefault();
        cb.checked = !cb.checked;
        setSel(a, cb.checked);
      });
      return row;
    }
    function renderList() {
      rowMap = Object.create(null);
      listBox.innerHTML = '';
      var list = visibleList();
      if (!list.length) {
        var emptyText;
        if (!diff.missing.length) {
          emptyText = '对方清单已经包含你库里的全部素材，没有需要补的。';
        } else if (hideSimilar && simCount && !String(keyword || '').trim()) {
          emptyText = '疑似他已有的 ' + simCount + ' 项已隐藏 —— 取消勾选「隐藏疑似他有的」就能看到。';
        } else if (String(keyword || '').trim()) {
          emptyText = '没有匹配「' + keyword + '」的素材';
        } else {
          emptyText = '当前条件下没有可显示的素材。';
        }
        listBox.appendChild(el('div', { class: 'cmp-empty', text: emptyText }));
        return;
      }
      list.forEach(function (a) { var r = rowOf(a); rowMap[a.id] = r; listBox.appendChild(r); });
    }
    function selectVisible(on) {
      visibleList().forEach(function (a) {
        if (on) sel[a.id] = 1; else delete sel[a.id];
        var r = rowMap[a.id];
        if (r) { r.classList.toggle('on', !!on); var cb = r.querySelector('input'); if (cb) cb.checked = !!on; }
      });
      refreshInfo();
    }

    var toolbar = el('div', { class: 'cmp-toolbar' }, [
      searchIn,
      el('button', { class: 'btn btn-sm', onclick: function () { selectVisible(true); } }, '全选'),
      el('button', { class: 'btn btn-sm', onclick: function () { selectVisible(false); } }, '全不选'),
      el('button', {
        class: 'btn btn-sm',
        title: '勾选「有本地文件，且不像他已有的」—— 通常就是该发的那批',
        onclick: function () {
          diff.missing.forEach(function (a) {
            if (hasLocalFiles(a) && !similar[a.id]) sel[a.id] = 1; else delete sel[a.id];
          });
          renderList(); refreshInfo();
        }
      }, '只选该发的'),
      simCount ? el('label', {
        class: 'cmp-check',
        title: '疑似 = 对方清单里有一条高度相似的（标题相近或一方包含另一方），但商品 ID 对不上'
      }, [
        el('input', {
          type: 'checkbox',
          onchange: function () { hideSimilar = this.checked; renderList(); refreshInfo(); }
        }),
        el('span', { text: '隐藏疑似他有的（' + simCount + '）' })
      ]) : null
    ]);

    btnExport.addEventListener('click', function () {
      var p = picked();
      if (!p.length) return;
      var noFile = p.filter(function (a) { return !hasLocalFiles(a); }).length;
      if (noFile) Toast.info('已选 ' + noFile + ' 项没有本地文件：包里只有它们的信息，没有内容', 7000);
      var simSel = p.filter(function (a) { return similar[a.id]; }).length;
      if (simSel) Toast.warn('其中 ' + simSel + ' 项疑似他已有（列表里带黄色的那几条），确认过了再发', 8000);
      /* 直接复用导出弹窗：路径解析、打包、署名、进度都在那边，不重复实现 */
      exportDialog(p);
    });

    var scopeLine = el('div', { class: 'pack-summary' }, [
      el('b', { text: '对方清单 ' + diff.listedTotal + ' 项' }),
      el('span', { class: 'pack-dim', text: '（' + (from ? '来自「' + from + '」' : '未署名') + '）'
        + ' · 你的库 ' + diff.mineTotal + ' 项 · 对方已收录 ' + diff.matched + ' 项' }),
      el('div', {
        class: 'pack-dim',
        text: diff.missing.length
          ? '下面列出的是「你有、他清单里没有」的 ' + diff.missing.length + ' 项；勾选后导出成包发给他即可。'
            + (simCount ? '其中 ' + simCount + ' 项带黄色标记，是清单里有相近条目但商品 ID 对不上的，默认没勾，需要你确认。' : '')
          : '他清单已经覆盖了你库里的全部素材，这次没有需要补的。'
      }),
      simRes.skipped
        ? el('div', { class: 'pack-dim', text: '（条目太多，本次跳过相似项判断；严格匹配结果不受影响。）' })
        : null
    ]);

    var box = el('div', { class: 'pack-body' }, [
      scopeLine, toolbar, listBox,
      el('div', { class: 'cmp-foot' }, [infoLine, btnExport])
    ]);

    var handle = Modal.open({
      title: '清单对比 · 找出对方没有的',
      size: 'lg',
      body: [box]
    });

    renderList();
    refreshInfo();
    return handle;
  }

  /* ------------------------------------------------------------------
   * v4.6：素材包导入预览（逐条选择 + 逐条动作 + 同源 ID 判重）
   *
   * 判重顺序（findExisting2）：同源素材 ID → 商品 ID → 标题。
   *   同源 ID 只在「对方的库是从您这份复制出去」时才对得上；对不上就照旧回落。
   * 每条单独一个复选框 + 动作（仅对「已有」的条目）：
   *   跳过 / 更新元数据 / 更新元数据 + 追加文件 / 新增一条。
   * 顶部三个单选项是「批量套用」，改一次会把所有条目重置成该策略。
   * ------------------------------------------------------------------ */

  function findExisting2(meta, assets) {
    var id = String(meta.id || '').trim();
    if (id) {
      for (var i = 0; i < assets.length; i++) {
        if (String(assets[i].id) === id) return { asset: assets[i], by: '同源 ID' };
      }
    }
    var iid = String(meta.itemId || '').trim();
    if (iid) {
      for (var j = 0; j < assets.length; j++) {
        if (String(assets[j].itemId || '').trim() === iid) return { asset: assets[j], by: '商品 ID' };
      }
    }
    /* v6.6：商店链接重叠也算同一条（老包没有 links 字段，取到空数组自然跳过）。
       这一档补的是「对方改过标题、又没有商品 ID」的情况 —— 链接一样就是同一件东西。 */
    var mLinks = (meta.links || []).map(function (l) {
      return String((l && l.url) || l || '').trim();
    }).filter(isHttpUrl);
    if (mLinks.length) {
      for (var n = 0; n < assets.length; n++) {
        var bLinks = ((assets[n] && assets[n].links) || []).map(function (l) {
          return String((l && l.url) || l || '').trim();
        });
        for (var q = 0; q < bLinks.length; q++) {
          if (bLinks[q] && mLinks.indexOf(bLinks[q]) >= 0) return { asset: assets[n], by: '商店链接' };
        }
      }
    }
    var t = String(meta.title || '').trim().toLowerCase();
    if (!t) return null;
    for (var k = 0; k < assets.length; k++) {
      if (String(assets[k].title || '').trim().toLowerCase() === t) return { asset: assets[k], by: '标题' };
    }
    return null;
  }

  var PACK_ACTIONS = [
    ['skip', '跳过（保留我的）'],
    ['update', '更新元数据'],
    ['append', '更新元数据 + 追加文件'],
    ['keep', '新增一条']
  ];

  function showPreview(path, res) {
    var mf = res.manifest || {};
    var assets = App.assets || [];
    /* 包内自查重（v6.6）：对方库里本身就有两条同商品/同链接的记录时，以前会原样建两条。
       现在后出现的那条标成「包内重复」并默认不勾 —— 要留着自己勾上就行。 */
    var seenInPack = Object.create(null);
    function packKeys(m) {
      var keys = [];
      var iid = String(m.itemId || '').trim();
      if (iid) keys.push({ key: 'iid:' + iid, by: '商品 ID' });
      (m.links || []).forEach(function (l) {
        var u = String((l && l.url) || l || '').trim();
        if (isHttpUrl(u)) keys.push({ key: 'url:' + u, by: '商店链接' });
      });
      return keys;
    }
    var plan = (mf.assets || []).map(function (m) {
      var hit = findExisting2(m, assets);
      var dupeOf = null;
      if (!hit) {
        var keys = packKeys(m);
        for (var i = 0; i < keys.length && !dupeOf; i++) {
          var prev = seenInPack[keys[i].key];
          if (prev) dupeOf = { title: prev.title, by: keys[i].by };
        }
        keys.forEach(function (k) {
          if (!seenInPack[k.key]) seenInPack[k.key] = { title: String(m.title || '（无标题）') };
        });
      }
      return {
        meta: m,
        existing: hit ? hit.asset : null,
        by: hit ? hit.by : '',
        dupeOf: dupeOf,
        sel: !hit && !dupeOf,
        act: (hit || dupeOf) ? 'skip' : 'keep'
      };
    });
    var nickname = String((mf.exporter && mf.exporter.nickname) || '').trim();
    var destRoot = joinWinPath(App.libraryRoot(), ['_来自', packSafeDir(nickname || '好友素材包')]);
    var strategy = 'skip';
    var pollTimer = null;
    var busy = false;

    var listBox = el('div', { class: 'di-list' });
    var statsLine = el('div', { class: 'pack-dim' });
    var prog = el('div', { class: 'pack-prog', style: { display: 'none' } });
    var btnRow = el('div', { class: 'btn-row' });
    var body = el('div', { class: 'pack-body' });

    function packSafeDir(s) {
      var v = String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim().replace(/^\.+/, '');
      return v || '好友素材包';
    }

    function setProg(text, pct) {
      prog.style.display = '';
      prog.innerHTML = '';
      prog.appendChild(el('div', { class: 'pack-prog-text', text: text }));
      prog.appendChild(el('div', { class: 'pack-prog-bar' }, [
        el('i', { style: { width: Math.max(0, Math.min(100, pct || 0)) + '%' } })
      ]));
    }
    function startPoll() {
      stopPoll();
      pollTimer = setInterval(function () {
        FS.host.pack('progress', {}).then(function (p) {
          if (p && p.running) {
            setProg('正在解包 ' + (p.done || 0) + '/' + (p.total || 0)
              + ' · 已写入 ' + fmtSize(p.bytes || 0) + (p.current ? ' · ' + p.current : ''),
              p.total ? (p.done / p.total) * 100 : 0);
          }
        }).catch(function () {});
      }, 500);
    }
    function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

    function counts() {
      var c = { add: 0, upd: 0, app: 0, skip: 0 };
      plan.forEach(function (p) {
        if (!p.sel) { c.skip++; return; }
        if (!p.existing) { c.add++; return; }
        if (p.act === 'skip') c.skip++;
        else if (p.act === 'update') c.upd++;
        else if (p.act === 'append') c.app++;
        else c.add++;
      });
      return c;
    }
    function refreshStats() {
      var c = counts();
      var picked = plan.filter(function (p) { return p.sel; }).length;
      var dupe = plan.filter(function (p) { return p.dupeOf; }).length;
      statsLine.textContent = '已勾选 ' + picked + ' 条'
        + ' · 新增 ' + c.add + ' · 更新元数据 ' + c.upd + ' · 更新+文件 ' + c.app + ' · 跳过 ' + c.skip
        + (dupe ? '（其中 ' + dupe + ' 条包内重复，默认不勾）' : '');
    }

    function applyStrategy(val) {
      strategy = val;
      plan.forEach(function (p) {
        if (!p.existing) { p.sel = true; p.act = 'keep'; return; }
        p.sel = (val !== 'skip');
        p.act = (val === 'update') ? 'update' : (val === 'keep' ? 'keep' : 'skip');
      });
      renderList();
      refreshStats();
    }

    function makeRow(p) {
      var m = p.meta;
      var cb = el('input', { type: 'checkbox' });
      cb.checked = !!p.sel;

      var actSel = null;
      if (p.existing) {
        actSel = el('select', { class: 'input', title: '这一条要怎么处理', style: { maxWidth: '190px' } });
        PACK_ACTIONS.forEach(function (a) {
          var opt = el('option', { value: a[0] }, a[1]);
          if (a[0] === p.act) opt.selected = true;
          actSel.appendChild(opt);
        });
        actSel.value = p.act;
        actSel.disabled = !p.sel;
        actSel.addEventListener('change', function () {
          p.act = actSel.value;
          if (p.act !== 'skip' && !p.sel) { p.sel = true; cb.checked = true; actSel.disabled = false; }
          refreshStats();
        });
      }
      cb.addEventListener('change', function () {
        p.sel = cb.checked;
        if (actSel) actSel.disabled = !cb.checked;
        refreshStats();
      });

      var chips = el('div', { class: 'cmp-chips' }, [
        p.existing
          ? el('span', { class: 'chip chip-warn', title: '按「' + p.by + '」判定为你库里已有的一条', text: '已有 · ' + p.by })
          : el('span', { class: 'chip', text: '新素材' }),
        p.dupeOf
          ? el('span', {
            class: 'chip chip-warn',
            title: '这个包里前面已经有一条同' + p.dupeOf.by + '的素材：' + p.dupeOf.title
              + '\n默认跳过。确认是两件不同的东西，勾上就会照样新建一条。',
            text: '包内重复 · ' + p.dupeOf.title
          })
          : null,
        el('span', { class: 'chip chip-dim', text: (m.files && m.files.length ? m.files.length + ' 个文件' : '无文件') })
      ]);

      return el('div', { class: 'di-row' + (p.sel ? ' on' : '') }, [
        cb,
        el('div', { class: 'di-main' }, [
          el('div', { class: 'di-title-row' }, [
            el('div', { class: 'cmp-title', title: m.title || '', style: { flex: '1 1 auto', minWidth: '0' }, text: m.title || '（未命名）' }),
            actSel
          ]),
          el('div', { class: 'cmp-sub', text: [m.originalTitle, m.shop].filter(Boolean).join(' · ') }),
          chips
        ])
      ]);
    }

    function renderList() {
      listBox.innerHTML = '';
      plan.forEach(function (p) { listBox.appendChild(makeRow(p)); });
    }

    function build() {
      body.innerHTML = '';
      body.appendChild(el('div', { class: 'pack-summary' }, [
        el('b', { text: '来自「' + (nickname || '未署名') + '」' }),
        el('span', { class: 'pack-dim', text: ' · ' + localTime(mf.createdAt) }),
        el('br'),
        el('span', { class: 'pack-dim', text:
          (mf.withFiles ? '含文件本体' : '仅清单（无文件）') + ' · '
          + plan.length + ' 个素材 · 合计 ' + fmtSize(mf.totalBytes || 0)
          + ' · 包体 ' + fmtSize(res.packageBytes || 0) })
      ]));

      if (!mf.withFiles) {
        body.appendChild(el('div', { class: 'pack-warn', text:
          '这个包只有清单和封面，导入后素材会是「未下载」状态（能看到信息，但没有文件）。' }));
      }

      body.appendChild(el('div', { class: 'pack-sec' }, [
        el('div', { class: 'pack-label', text: '落到哪里' }),
        el('div', { class: 'pack-dest' }, [
          el('span', { class: 'pack-dest-path', text: destRoot, title: destRoot }),
          el('button', { class: 'btn btn-sm', onclick: function () {
            FS.host.pickDir({ title: '选择导入目录' }).then(function (r) {
              if (r && r.ok && r.path) {
                destRoot = r.path;
                var sp = body.querySelector('.pack-dest-path');
                if (sp) { sp.textContent = destRoot; sp.title = destRoot; }
              }
            });
          } }, '更改…')
        ]),
        el('p', { class: 'field-hint', text: '新素材 / 追加文件会解到这里；默认在库内「_来自」下，不打乱你原来的分类。' })
      ]));

      body.appendChild(el('div', { class: 'pack-sec' }, [
        el('div', { class: 'pack-label', text: '批量套用（改一次会把下面所有条目重置成这个策略）' }),
        (function () {
          var mk = function (val, title, desc, checked) {
            return el('label', { class: 'pack-check' }, [
              el('input', {
                type: 'radio', name: 'packStrategy', value: val, checked: !!checked,
                onchange: function () { if (this.checked) applyStrategy(val); }
              }),
              el('span', {}, [
                el('span', { text: title }),
                el('span', { class: 'pack-dim', text: ' —— ' + desc })
              ])
            ]);
          };
          return el('div', {}, [
            mk('skip', '只导入新的', '已有的一律跳过，不改任何字段、不动文件', true),
            mk('update', '更新已有素材的元数据', '标题/标签/分类等；不动备注、价格、路径与文件', false),
            mk('keep', '全部新增一条', '已有也再建一条（新的 ID），文件另解一份', false)
          ]);
        })()
      ]));

      body.appendChild(el('div', { class: 'pack-label', text: '逐条确认' }));
      body.appendChild(statsLine);
      body.appendChild(listBox);

      body.appendChild(prog);
      btnRow.innerHTML = '';
      btnRow.appendChild(el('span', { class: 'grow' }));
      btnRow.appendChild(el('button', { class: 'btn', onclick: function () { Modal.close(handle); } }, '取消'));
      btnRow.appendChild(el('button', { class: 'btn btn-primary', onclick: start }, '开始导入'));
      body.appendChild(btnRow);
    }

    function applyMeta(live, m) {
      ['title', 'originalTitle', 'category', 'source', 'shop', 'author', 'itemId'].forEach(function (k) {
        if (m[k]) live[k] = m[k];
      });
      /* v6.6：链接按 url 去重后并入，不覆盖已有的（对方那条可能只是同一商品的另一个页面） */
      if (Array.isArray(m.links) && m.links.length) {
        var have = Object.create(null);
        (live.links || []).forEach(function (l) { if (l && l.url) have[l.url] = 1; });
        var extra = [];
        m.links.forEach(function (l) {
          var u = String((l && l.url) || l || '').trim();
          if (!isHttpUrl(u) || have[u]) return;
          have[u] = 1;
          extra.push({ url: u, label: (l && l.label) || hostOf(u) });
        });
        if (extra.length) live.links = (live.links || []).concat(extra);
      }
      if (Array.isArray(m.tags) && m.tags.length) live.tags = m.tags.slice();
      if (Array.isArray(m.avatars) && m.avatars.length) live.avatars = m.avatars.slice();
      if (m.isFree != null) live.isFree = m.isFree;
      live.updatedAt = nowISO();
    }

    function start() {
      if (busy) return;
      var picked = plan.filter(function (p) { return p.sel; });
      if (!picked.length) { Toast.warn('一条都没勾选'); return; }

      var toCreate = [], toUpdate = [], toAppend = [];
      picked.forEach(function (p) {
        if (!p.existing) { toCreate.push(p); return; }
        if (p.act === 'update') { toUpdate.push(p); return; }
        if (p.act === 'append') { toAppend.push(p); return; }
        if (p.act === 'keep') { toCreate.push(p); return; }
      });
      var skipped = plan.length - picked.length + picked.filter(function (p) {
        return p.existing && p.act === 'skip';
      }).length;

      var needExtract = !!mf.withFiles && (toCreate.length + toAppend.length) > 0;
      var onlyIds = toCreate.concat(toAppend).map(function (p) { return p.meta.id; });

      busy = true;
      Array.prototype.forEach.call(btnRow.querySelectorAll('button'), function (b) { b.disabled = true; });
      setProg(needExtract ? '正在解包文件…' : '正在写入素材库…', 0);
      if (needExtract) startPoll();

      var extractP = needExtract
        ? FS.host.pack('extract', { path: path, destRoot: destRoot, onlyIds: onlyIds })
        : Promise.resolve({ ok: true, assets: [] });

      extractP.then(function (ex) {
        stopPoll();
        var byId = Object.create(null);
        (ex.assets || []).forEach(function (x) { byId[String(x.id)] = x; });

        var added = [], updating = [], updatedCount = 0, appended = 0;
        var now = nowISO();

        toUpdate.forEach(function (p) {
          applyMeta(p.existing, p.meta);
          updating.push(p.existing);
          updatedCount++;
        });

        toAppend.forEach(function (p) {
          var ex2 = byId[String(p.meta.id)];
          applyMeta(p.existing, p.meta);
          if (ex2 && ex2.files && ex2.files.length) {
            var paths = Array.isArray(p.existing.paths) ? p.existing.paths : [];
            var dirKey = normalizeWinPath(ex2.dir).toLowerCase();
            var has = paths.some(function (x) { return normalizeWinPath(x.path).toLowerCase() === dirKey; });
            if (!has) paths.push({ path: ex2.dir, note: '存储路径（素材包）' });
            p.existing.paths = paths;
            p.existing.downloaded = true;
            p.existing.downloadedAt = p.existing.downloadedAt || now;
            appended++;
          } else {
            /* 包里没带文件（只有清单）时，这一条实际等价于「只更新元数据」，别在提示里谎报追加了文件 */
            updatedCount++;
          }
          p.existing.updatedAt = now;
          updating.push(p.existing);
        });

        toCreate.forEach(function (p) {
          var m = p.meta;
          var ex2 = byId[String(m.id)];
          var files = (ex2 && ex2.files) || [];
          added.push({
            id: uid('as'),
            _packSrcId: m.id,
            title: m.title || '',
            originalTitle: m.originalTitle || '',
            category: m.category || 'other',
            source: m.source || 'other',
            tags: (m.tags || []).slice(),
            avatars: (m.avatars || []).slice(),
            itemId: m.itemId || '',
            /* 包里可能是 {url,label}，也可能只有一串 url（别人手改过清单），统一成 {url,label} */
            links: (m.links || []).map(function (l) { return String((l && l.url) || l || '').trim(); })
              .filter(isHttpUrl)
              .map(function (u) { return { url: u, label: hostOf(u) }; }),
            shop: m.shop || '',
            author: m.author || '',
            isFree: (m.isFree === true) ? true : (m.isFree === false ? false : null),
            fileSize: m.fileSize || 0,
            note: m.note || '',
            purchasePrice: (typeof m.purchasePrice === 'number') ? m.purchasePrice : null,
            purchaseCurrency: m.purchaseCurrency || '',
            paths: files.length ? [{ path: ex2.dir, note: '存储路径' }] : [],
            downloaded: files.length > 0,
            downloadedAt: files.length ? now : '',
            importedFrom: 'vrcpack',
            createdAt: now,
            updatedAt: now,
            extra: { packFrom: nickname || '', packCreatedAt: mf.createdAt || '' }
          });
        });

        return renameCovers2(added, byId).then(function () {
          added.forEach(function (a) { delete a._packSrcId; });
          var seen = Object.create(null);
          var uniqUpd = updating.filter(function (a) {
            if (seen[a.id]) return false;
            seen[a.id] = 1;
            return true;
          });
          return finish(added, uniqUpd, updatedCount, appended, skipped);
        });
      }).catch(function (e) {
        stopPoll();
        busy = false;
        Array.prototype.forEach.call(btnRow.querySelectorAll('button'), function (b) { b.disabled = false; });
        setProg('失败：' + ((e && e.message) || e), 0);
        Toast.err('导入失败：' + ((e && e.message) || e), 9000);
      });
    }

    function renameCovers2(added, byId) {
      var jobs = [];
      added.forEach(function (a) {
        var ex = byId[String(a._packSrcId)];
        if (!ex || !ex.coverPath) return;
        var key = String(a.itemId || '').trim();
        if (!key) return;
        var extMatch = /\.[a-z0-9]+$/i.exec(ex.coverPath);
        var ext = extMatch ? extMatch[0] : '.jpg';
        jobs.push(FS.host.move(ex.coverPath, joinWinPath(ex.dir, [key + '_cover' + ext])).catch(function () {}));
      });
      return Promise.all(jobs);
    }

    function finish(added, updating, updatedCount, appended, skipped) {
      var all = added.concat(updating || []);
      var write = all.length ? Store.putAssets(all) : Promise.resolve();
      return write.then(function () {
        Modal.close(handle);
        Toast.ok('导入完成：新增 ' + added.length + ' 个'
          + (updatedCount ? '，更新 ' + updatedCount + ' 个' : '')
          + (appended ? '（其中 ' + appended + ' 个追加了文件）' : '')
          + (skipped ? '，跳过 ' + skipped + ' 个' : ''), 8000);
        if ((added.length || appended) && mf.withFiles) Toast.info('文件已解到：' + destRoot, 8000);
        return App.reload().then(function () {
          UI.renderAll();
          if (added.length) { try { $('#bulkExit').click(); } catch (e) {} }
        });
      });
    }

    var handle = Modal.open({
      title: '导入素材包',
      size: 'md',
      body: [body],
      onClose: function () {
        stopPoll();
        if (packModal === handle) packModal = null;
      }
    });
    packModal = handle;
    build();
    renderList();
    refreshStats();
  }

  function localTime(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (e) { return String(iso); }
  }

  return {
    exportDialog: exportDialog,
    importDialog: importDialog,
    importPath: importPath,
    installDropZone: installDropZone,
    compareDialog: compareDialog,
    diffAgainst: diffAgainst,
    collectFiles: collectFiles,
    /* 给自测用：分包规则单独暴露一份，免得为了测它真去导 1 GB 的包 */
    partLimit: PART_LIMIT,
    chunkBySize: chunkBySize
  };
})();
