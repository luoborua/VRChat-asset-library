/* ============ 91-workbench.js ============ */
/* =====================================================================
 * 91-workbench.js  —  改模工作台
 *
 * 这一页只做三件事（对应 docs/改模工作台-逻辑拆分.md）：
 *   1. 登记 Unity 工程、检查准备情况      —— L01~L13
 *   2. 把素材文件夹复制进工程并记账        —— L14~L34
 *   3. 把「没做什么」说清楚               —— 预检、回执、失败原因
 *
 * 真正的改模发生在 Unity 里。这里不假装能自动适配、不假装能判断穿模，
 * 只保证：导入不重复、位置能找到、失败有理由。
 *
 * 磁盘重活全在 Rust（src-tauri/src/host/workbench_api.rs），
 * 这边只负责状态机、话术和界面。
 * ===================================================================== */

var WB = (function () {

  /* ---------------- 常量 ---------------- */

  var FILE_NAME = 'workbench.json';
  var MAX_JOBS = 100;
  var DEP_STATE_TEXT = {
    'files-found': '发现包文件',
    'declared': '仅有依赖声明',
    'unknown': '尚未确认'
  };
  var JOB_STATE_TEXT = {
    'copying': '正在复制',
    'waiting-unity': '等待 Unity',
    'completed': '已完成',
    'failed': '失败',
    'cancelled': '已取消'
  };

  /* ---------------- 状态 ---------------- */

  var state = {
    projects: [],
    jobs: [],
    projectId: '',
    readiness: null,
    busy: false,
    filter: 'all',
    opened: false,
    loaded: false,
    root: null,
    /* 上次没跑完的导入队列：{ projectId, projectPath, at, items:[{title, src}] } */
    resume: null
  };

  /* ---------------- 持久化（L31） ---------------- */

  function dataFile() {
    /* 与 20-store.js 同一标准：用户选过的数据目录（settings.localDataDir）优先，否则与 settings.json 同目录 */
    try {
      if (window.Store && Store.local && Store.local.jsonPath) {
        return Store.local.jsonPath(FILE_NAME) || '';
      }
    } catch (e) { /* Store 未就绪时走兜底 */ }
    var dir = (window.vrcElectron && window.vrcElectron.dataDir) || '';
    if (!dir) return '';
    return joinWinPath(dir, [FILE_NAME]);
  }

  function b64(str) {
    try { return btoa(unescape(encodeURIComponent(str))); } catch (e) { return ''; }
  }

  function load() {
    var f = dataFile();
    if (!f) return Promise.resolve();
    return FS.host.readText(f).then(function (txt) {
      if (!txt) return;
      var data = safeJSON(txt, null);
      if (!data || data.schema !== 1) return;
      state.projects = Array.isArray(data.projects) ? data.projects.filter(validProjectRecord) : [];
      state.jobs = Array.isArray(data.jobs) ? data.jobs.slice(0, MAX_JOBS) : [];
      state.resume = (data.resume && Array.isArray(data.resume.items) && data.resume.items.length)
        ? data.resume
        : null;
      var saved = data.lastProjectId || '';
      state.projectId = state.projects.some(function (p) { return p.id === saved; }) ? saved : '';
    }).catch(function () { /* 首次运行没有这个文件，正常 */ }).then(function () {
      state.loaded = true;
      offerResume();
    });
  }

  /* 工作台数据懒加载：以前只在打开工作台时读，导致没开过工作台就导入时
     state.projects 还是空的，被误判成「没有配置工程」。这里做成幂等加载。 */
  var loadingPromise = null;
  function ensureLoaded() {
    if (state.loaded) return Promise.resolve();
    if (!loadingPromise) loadingPromise = load();
    return loadingPromise;
  }
  function validProjectRecord(p) {
    return p && typeof p.id === 'string' && typeof p.path === 'string' && p.path.length > 1;
  }

  function save() {
    var f = dataFile();
    if (!f) return Promise.resolve();
    var text = JSON.stringify({
      schema: 1,
      lastProjectId: state.projectId,
      projects: state.projects,
      jobs: state.jobs.slice(0, MAX_JOBS),
      resume: state.resume || null
    }, null, 1);
    var tmp = f + '.tmp';
    return FS.host.writeFile(tmp, b64(text))
      .then(function () { return FS.host.move(tmp, f); })
      .catch(function () {
        /* rename 失败（比如目标被占用）：直接覆盖写，宁可少一层原子性也不要丢记录 */
        return FS.host.writeFile(f, b64(text));
      });
  }

  /* ---------------- 小工具 ---------------- */

  function wb(op, payload) {
    if (!FS.host.wb) return Promise.reject(new Error('当前后端不支持工作台功能，请更新程序。'));
    return FS.host.wb(op, payload);
  }

  function cur() {
    return state.projects.filter(function (p) { return p.id === state.projectId; })[0] || null;
  }

  function fmtMB(bytes) {
    var n = Number(bytes || 0);
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }

  function fmtTime(ms) {
    if (!ms) return '';
    try {
      var d = new Date(Number(ms));
      var pad = function (x) { return x < 10 ? '0' + x : '' + x; };
      return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    } catch (e) { return ''; }
  }

  function projectName(p) {
    if (!p) return '';
    return p.name || p.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  }

  function jobStatusKind(job) {
    if (job.blocked) return 'attention';
    if (job.state === 'failed') return 'attention';
    if (job.state === 'completed') return 'completed';
  if (job.state === 'cancelled' || job.state === 'blocked') return 'attention';
    return 'waiting';
  }

  function maLineText(job) {
    var where = job.maHierarchy || job.maAvatar || '';
    if (job.maState === 'applied')
      return 'MA 装配：已完成' + (where ? (' → ' + where) : '')
        + (job.maMenuMode === 'created' ? '（已建显隐菜单开关）' : (job.maMenuMode === 'preserved' ? '（保留作者菜单）' : ''));
    if (job.maState === 'skipped') return 'MA 装配：已在 Unity 里跳过';
    if (job.maState === 'error') return 'MA 装配：失败 —— ' + (job.maMessage || '见 Unity 控制台');
    if (job.maState === 'failed') return job.maMessage || 'MA 装配请求失败';
    return 'MA 装配：等待 Unity 处理' + (job.maMessage ? (' —— ' + job.maMessage) : '（打开 Unity 后自动继续）');
  }

  function toastErr(e) {
    Toast.err(String((e && e.message) || e || '操作失败'));
  }

  /* =====================================================================
   * 工程登记（L01~L08）
   * ===================================================================== */

  function addProject() {
    if (state.busy) return;
    FS.host.pickDir().then(function (dir) {
      if (!dir) return;                       // 用户取消：静默
      setBusy(true);
      return wb('probe', { path: dir }).then(function (r) {
        if (!r || !r.valid) {
          var missing = (r && r.missing) ? r.missing.join('、') : 'Assets / Packages / ProjectSettings';
          var bad = Modal.open({
            title: '这个目录不是 Unity 工程',
            size: 'sm',
            body: [
              el('p', { text: '缺少：' + missing }),
              el('p', { class: 'wb-hint', text: '请选择同时包含 Assets、Packages、ProjectSettings 的那一层文件夹；不要选 Assets 本身，也不要选 ZIP 压缩包。' })
            ],
            footer: [el('button', { class: 'btn btn-primary', onclick: function () { Modal.close(bad); } }, '知道了')]
          });
          return;
        }
        var key = cmpPath(r.root);
        var exist = state.projects.filter(function (p) { return cmpPath(p.path) === key; })[0];
        if (exist) {
          // L05：已登记就复用原记录（保留首次添加时间），只是选中它
          state.projectId = exist.id;
          Toast.info('这个工程已经在列表里了，已为你选中。');
        } else {
          var rec = {
            id: uid('wb'),
            path: r.root,
            name: r.name,
            unityVersion: r.unityVersion || '',
            addedAt: Date.now()
          };
          state.projects.push(rec);
          state.projectId = rec.id;
          Toast.ok('已添加工程：' + projectName(rec));
        }
        return save().then(check);
      });
    }).catch(toastErr).then(function () { setBusy(false); render(); });
  }

  function cmpPath(p) {
    return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  }

  function selectProject(id) {
    if (state.projectId === id) return;
    state.projectId = id;
    state.readiness = null;
    save();
    render();
    if (id) check();
  }

  function removeProject() {
    var p = cur();
    if (!p) return;
    Modal.confirm('移除「' + projectName(p) + '」的登记？\n\n只删除程序里的记录，不会动磁盘上的工程文件，也不会删除导入记录。', {
      okText: '移除登记'
    }).then(function (ok) {
      if (!ok) return;
      state.projects = state.projects.filter(function (x) { return x.id !== p.id; });
      state.projectId = state.projects.length === 1 ? state.projects[0].id : '';
      state.readiness = null;
      save();
      render();
      if (state.projectId) check();
    });
  }

  /* =====================================================================
   * 准备情况（L09~L13）
   * ===================================================================== */

  function check() {
    var p = cur();
    if (!p) { state.readiness = null; render(); return Promise.resolve(); }
    setBusy(true);
    return wb('probe', { path: p.path }).then(function (r) {
      if (!r || !r.valid) {
        p.missing = true;
        state.readiness = null;
        Toast.err('工程目录不见了：' + p.path);
        return save();
      }
      p.missing = false;
      p.unityVersion = r.unityVersion || p.unityVersion || '';
      state.readiness = {
        unityVersion: r.unityVersion || '',
        checkedAt: r.checkedAt || 0,
        dependencies: r.dependencies || [],
        notes: r.notes || [],
        bridgeInstalled: !!r.bridgeInstalled,
        maInstalled: !!r.maInstalled
      };
      return save();
    }).catch(function (e) {
      state.readiness = null;
      toastErr(e);
    }).then(function () { setBusy(false); render(); });
  }

  /* =====================================================================
   * 安装 Unity 助手（导入桥 + MA 装配，一次装两个）
   * ===================================================================== */

  function helperButtonLabel() {
    var r = state.readiness;
    if (!r) return '安装 Unity 助手';
    if (r.bridgeInstalled && r.maInstalled) return '更新 Unity 助手';
    if (r.bridgeInstalled || r.maInstalled) return '补装 Unity 助手';
    return '安装 Unity 助手';
  }

  function helperStatusText() {
    var r = state.readiness;
    if (!r) return 'Unity 助手状态未知，点「重新检查」后再看。';
    var b = r.bridgeInstalled ? '导入助手 ✓' : '导入助手 ✗';
    var m = r.maInstalled ? 'MA 装配助手 ✓' : 'MA 装配助手 ✗';
    var tail = (r.bridgeInstalled && r.maInstalled)
      ? '都在。程序更新后可用按钮升级助手；删除 Assets/Editor/ 里的文件即可移除。'
      : '缺的可用按钮补装；装完回 Unity 编译一次（右下角转圈结束）即生效。';
    return b + ' · ' + m + ' —— ' + tail;
  }

  function installHelpers() {
    var p = cur();
    if (!p || state.busy) return;
    setBusy(true);
    wb('installBridge', { projectRoot: p.path, update: true }).then(function (r) {
      Toast.ok(r.message || 'Unity 助手已安装。', 6000);
      return check();
    }).catch(toastErr).then(function () { setBusy(false); render(); });
  }

  /* =====================================================================
   * 打开 Unity（L45~L49）
   * ===================================================================== */

  function openUnity() {
    var p = cur();
    if (!p || state.busy) return;
    var version = (state.readiness && state.readiness.unityVersion) || p.unityVersion || '';
    setBusy(true);
    wb('findUnity', { version: version }).then(function (r) {
      if (!r || !r.path) {
        Toast.warn(r && r.reason ? r.reason : '没找到对应版本的 Unity，请在 Unity Hub 里打开这个工程。', 5200);
        return null;
      }
      return wb('launchUnity', { editor: r.path, projectRoot: p.path }).then(function (res) {
        if (res && res.already) Toast.info(res.message || '这个工程已经打开了。');
        else Toast.ok('已启动 Unity：' + (version || ''));
      });
    }).catch(toastErr).then(function () { setBusy(false); });
  }

  /* =====================================================================
   * 导入（L14~L30）
   * ===================================================================== */

  function importFlow() {
    var p = cur();
    if (!p) { Toast.err('先在上方选一个 Unity 工程，再导入素材'); return; }
    var h = Modal.open({
      title: '导入素材',
      size: 'sm',
      body: [
        el('p', { class: 'wb-hint', text: '选择素材的形式。两种都不会改动原素材。' })
      ],
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(h); importFolder(p); } }, '📁 文件夹素材（复制）'),
        el('button', { class: 'btn btn-primary', onclick: function () { Modal.close(h); importPackage(p); } }, '📦 Unity 素材包（.unitypackage）')
      ]
    });
  }

  function importFolder(p) {
    FS.host.pickDir().then(function (dir) {
      if (!dir) return;
      setBusy(true);
      var id = uid('job');
      return wb('plan', { projectRoot: p.path, source: dir, id: id }).then(function (r) {
        setBusy(false);
        if (!r) return;
        showPreview(r, id);
      });
    }).catch(toastErr).then(function () { setBusy(false); });
  }

  function importPackage(p) {
    FS.host.pickFiles().then(function (files) {
      if (!files || !files.length) return;      // 用户取消：静默
      var pkg = files[0];
      if (files.length > 1) Toast.info('一次只导入一个素材包，已取第一个。');
      if (!/\.unitypackage$/i.test(pkg)) {
        Toast.warn('请选择 .unitypackage 文件。');
        return;
      }
      setBusy(true);
      var id = uid('job');
      return wb('plan', { projectRoot: p.path, source: pkg, id: id }).then(function (r) {
        setBusy(false);
        if (!r) return;
        showPreview(r, id);
      });
    }).catch(toastErr).then(function () { setBusy(false); });
  }

  function showPreview(plan, jobId) {
    if (plan.mode === 'unitypackage') return showPackagePreview(plan, jobId);
    var ready = !!plan.ready;
    /* B5：冲突全部来自同一素材的上一次导入时，允许「替换旧版本」（旧目录进回收站） */
    var replaceable = !!plan.replaceDir;
    var rows = [
      ['目标工程', plan.projectRoot],
      ['素材', plan.sourceName + '（' + plan.fileCount + ' 个文件 · ' + fmtMB(plan.bytes) + '）'],
      ['将放到', plan.destRel]
    ];

    var body = [
      el('table', { class: 'wb-table' }, rows.map(function (r) {
        return el('tr', null, [
          el('th', { text: r[0] }),
          el('td', { class: 'wb-mono', text: r[1] })
        ]);
      })),
      el('h3', { class: 'wb-h3', text: '导入前检查' })
    ];

    // L23：三项结论，角色适配永远只在「未知」，因为程序确实不知道
    var checks = [
      ['目标工程', 'pass', '目录存在，含 Assets / Packages / ProjectSettings'],
      plan.conflicts.length
        ? (replaceable
          ? ['文件引用', 'warn', '这些 GUID 来自上次导入的同一素材，可以替换旧版本']
          : ['文件引用', 'blocked', '发现 ' + plan.conflicts.length + ' 个重复 GUID，禁止导入'])
        : (replaceable
          ? ['文件引用', 'warn', '目标目录里已经是这份素材，可以替换成新导入的内容']
          : ['文件引用', 'pass', '本次复制内容的 GUID 与工程现有文件不冲突']),
      ['角色适配', 'unknown', '商品支持列表不等于本地包版本；体型与穿模需要你自己在 Unity 里看']
    ];
    body.push(el('ul', { class: 'wb-checks' }, checks.map(function (c) {
      return el('li', { class: 'wb-check wb-check-' + c[1] }, [
        el('b', { text: c[0] }),
        el('span', { text: c[2] })
      ]);
    })));

    if (plan.conflicts.length) {
      body.push(el('div', { class: 'wb-warn' }, [
        el('b', { text: 'GUID 冲突' }),
        el('ul', null, plan.conflicts.slice(0, 5).map(function (c) {
          return el('li', { class: 'wb-mono', text: c.sourcePath + ' ↔ ' + c.path });
        })),
        el('p', {
          text: replaceable
            ? '这些 GUID 全部来自「' + plan.replaceDir + '」，也就是这个素材上一次的导入。替换会把旧目录整体挪到回收站（不会直接删掉），再写入新内容。'
            : '这是「同一个文件被两份素材各自带进来」的典型情况。覆盖会让 Unity 的引用指向错误的资源，所以这里不提供「强行导入」。'
        })
      ]));
    }

    if (plan.warnings && plan.warnings.length) {
      body.push(el('div', { class: 'wb-note' }, [
        el('b', { text: '提示' }),
        el('ul', null, plan.warnings.map(function (w) { return el('li', { text: w }); }))
      ]));
    }

    body.push(el('p', {
      class: 'wb-hint',
      text: replaceable
        ? '点「替换旧版本」之前，程序不会写任何文件。旧目录会进回收站，原素材不动。'
        : '点「导入到工程」之前，程序不会写任何文件。导入只是复制，不会移动或改动原素材。'
    }));

    // 阶段 4：导入后可顺手发起 MA 装配（在 Unity 里执行，这里只写请求）
    var maRow = el('label', { class: 'wb-ma-opt' }, [
      el('input', {
        type: 'checkbox',
        onchange: function (e) { plan.ma = e.target.checked; menuWrap.style.display = e.target.checked ? '' : 'none'; }
      }),
      el('span', { text: '导入后用 Modular Avatar 装配到角色（在 Unity 里完成，可一次撤销）' })
    ]);
    var menuWrap = el('label', { class: 'wb-ma-opt wb-ma-sub', style: { display: 'none' } }, [
      el('input', {
        type: 'checkbox',
        checked: true,
        onchange: function (e) { plan.maMenu = e.target.checked; }
      }),
      el('span', { text: '同时接入游戏内显隐菜单开关（作者已带 MA 菜单则保留原样）' })
    ]);
    plan.maMenu = true;
    body.push(maRow);
    body.push(menuWrap);

    var h = Modal.open({
      title: '导入预览 · ' + plan.sourceName,
      size: 'lg',
      cls: 'wb-modal',
      body: body,
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '取消'),
        el('button', {
          class: 'btn btn-primary',
          disabled: !ready,
          onclick: function () {
            Modal.close(h);
            doImport(plan, jobId, replaceable ? plan.replaceDir : '');
          }
        }, !ready ? '有冲突，不能导入' : (replaceable ? '替换旧版本并导入' : '导入到工程'))
      ]
    });
  }

  /* .unitypackage 的预览：不列文件（包是 gzip 的 tar，解包是 Unity 的活），
   * 只讲清楚「谁来导、导到哪、你要做什么」 */
  function showPackagePreview(plan, jobId) {
    var installed = !!plan.bridgeInstalled;
    var rows = [
      ['目标工程', plan.projectRoot],
      ['素材包', plan.sourceName + '（' + fmtMB(plan.bytes) + '）'],
      ['导入方式', 'Unity 官方导入窗口 —— 请求会先放进工程，Unity 打开后弹窗，你确认后才写入']
    ];
    var body = [
      el('table', { class: 'wb-table' }, rows.map(function (r) {
        return el('tr', null, [
          el('th', { text: r[0] }),
          el('td', { class: 'wb-mono', text: r[1] })
        ]);
      })),
      el('h3', { class: 'wb-h3', text: '导入前检查' })
    ];
    var checks = [
      ['目标工程', 'pass', '目录存在，含 Assets / Packages / ProjectSettings'],
      installed
        ? ['Unity 助手', 'pass', '已安装（VrclibImportBridge.cs），Unity 打开后 1 秒内认领请求']
        : ['Unity 助手', 'blocked', '工程里还没有助手 —— 点下面的按钮安装（会往 Assets/Editor 放一个 .cs 文件）'],
      ['导入内容', 'unknown', '以 Unity 弹窗列出的清单为准；导入位置由包内结构决定，本程序不指定']
    ];
    body.push(el('ul', { class: 'wb-checks' }, checks.map(function (c) {
      return el('li', { class: 'wb-check wb-check-' + c[1] }, [
        el('b', { text: c[0] }),
        el('span', { text: c[2] })
      ]);
    })));
    if (!installed) {
      body.push(el('div', { class: 'wb-note' }, [
        el('b', { text: '关于这个助手' }),
        el('ul', null, [
          el('li', { text: '它是一个普通的 Unity Editor 脚本，不联网、不执行命令，只盯着工程 Library/VrclibBridge 目录里的导入请求。' }),
          el('li', { text: '装完后 Unity 会编译一次（右下角转圈），之后每次导入都会弹出 Unity 官方窗口让你确认。' }),
          el('li', { text: '不想要了直接删掉 Assets/Editor/VrclibImportBridge.cs 即可，没有任何残留。' })
        ])
      ]));
    }
    body.push(el('p', { class: 'wb-hint', text: '点「发送到 Unity」只会写入一个很小的请求文件；素材包本身不动，导入动作由你在 Unity 弹窗里确认。' }));

    // 阶段 4：包导入完成后可顺手发起 MA 装配
    var maRow = el('label', { class: 'wb-ma-opt' }, [
      el('input', {
        type: 'checkbox',
        onchange: function (e) { plan.ma = e.target.checked; menuWrap.style.display = e.target.checked ? '' : 'none'; }
      }),
      el('span', { text: '导入完成后用 Modular Avatar 装配到角色（在 Unity 里完成，可一次撤销）' })
    ]);
    var menuWrap = el('label', { class: 'wb-ma-opt wb-ma-sub', style: { display: 'none' } }, [
      el('input', {
        type: 'checkbox',
        checked: true,
        onchange: function (e) { plan.maMenu = e.target.checked; }
      }),
      el('span', { text: '同时接入游戏内显隐菜单开关（作者已带 MA 菜单则保留原样）' })
    ]);
    plan.maMenu = true;
    body.push(maRow);
    body.push(menuWrap);

    var h = Modal.open({
      title: '导入预览 · ' + plan.sourceName,
      size: 'lg',
      cls: 'wb-modal',
      body: body,
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(h); } }, '取消'),
        el('button', {
          class: 'btn btn-primary',
          onclick: function () {
            Modal.close(h);
            if (installed) {
              doImport(plan, jobId);
            } else {
              setBusy(true);
              wb('installBridge', { projectRoot: plan.projectRoot }).then(function (r) {
                Toast.ok((r && r.message) || 'Unity 助手已安装。');
                plan.bridgeInstalled = true;
                plan.ready = true;
                doImport(plan, jobId);
              }).catch(toastErr).then(function () { setBusy(false); });
            }
          }
        }, installed ? '发送到 Unity' : '安装助手并发送')
      ]
    });
  }

  function doImport(plan, jobId, replaceDir) {
    if (plan.mode === 'unitypackage') return doPackageImport(plan, jobId);
    var p = cur();
    if (!p) return;
    setBusy(true);
    var job = {
      id: jobId,
      projectId: p.id,
      projectPath: p.path,
      sourceName: plan.sourceName,
      // 记录里显示用户选的那个目录；实际复制用的是剥掉 Assets 之后的 sourcePath
      sourcePath: plan.sourceRoot || plan.sourcePath,
      mode: 'copy',
      state: 'copying',
      fileCount: plan.fileCount,
      completedFiles: 0,
      bytes: plan.bytes,
      signature: plan.signature,
      destRel: plan.destRel,
      createdAt: Date.now()
    };
    state.jobs.unshift(job);
    save();
    render();

    wb('execute', {
      projectRoot: p.path,
      source: plan.sourcePath,
      destRel: plan.destRel,
      signature: plan.signature,
      id: jobId,
      replace: replaceDir || ''
    }).then(function (r) {
      job.state = 'completed';
      job.completedFiles = r.copied || 0;
      job.copiedBytes = r.bytes || 0;
      job.skipped = r.skipped || 0;
      job.finishedAt = Date.now();
      job.message = (r.skipped ? ('跳过 ' + r.skipped + ' 个同名文件。') : '') +
        ((r.warnings && r.warnings.length) ? ' ' + r.warnings.join(' ') : '');
      if (r.replaced) {
        job.replaced = true;
        job.trashPath = r.trashPath || '';
        Toast.ok('已导入 ' + job.completedFiles + ' 个文件，旧版本移到了回收站', 6000);
      } else {
        Toast.ok('已导入 ' + job.completedFiles + ' 个文件到 ' + r.destRel);
      }
      // 阶段 4：勾了 MA 装配 → 复制完成后立刻发装配请求
      if (plan.ma) {
        var prefabs = (r.prefabs && r.prefabs.length) ? r.prefabs : null;
        if (!prefabs) {
          Toast.warn('这份素材里没有 .prefab 预制件，MA 装配没有发起。', 5200);
        } else {
          return sendMaRequest(job, {
            mode: 'copy',
            signature: r.signature || plan.signature,
            prefabPaths: prefabs,
            menu: !!plan.maMenu
          });
        }
      }
      return save();
    }).catch(function (e) {
      job.state = 'failed';
      job.finishedAt = Date.now();
      job.message = String((e && e.message) || e);
      toastErr(e);
      return save();
    }).then(function () {
      setBusy(false);
      render();
      startPolling();
    });
  }

  /* 发起 MA 装配请求（阶段 4）。job.maRequestId / job.maState 由这里维护 */
  function sendMaRequest(job, opts) {
    var p = state.projects.filter(function (x) { return x.id === job.projectId; })[0];
    if (!p) return Promise.resolve();
    return wb('maRequest', {
      projectRoot: job.projectPath,
      sourceName: job.sourceName || '素材',
      mode: opts.mode,
      signature: opts.signature,
      importId: opts.importId || '',
      prefabPaths: opts.prefabPaths || [],
      menu: !!opts.menu
    }).then(function (r) {
      job.maRequestId = (r && r.requestId) || '';
      job.maState = 'waiting';
      job.maMessage = (r && r.message) || '';
      startPolling();
      return save();
    }).catch(function (e) {
      job.maState = 'failed';
      job.maMessage = 'MA 装配请求失败：' + String((e && e.message) || e);
      Toast.warn(job.maMessage, 6000);
      return save();
    });
  }

  /* .unitypackage 的执行：写请求 → 记录进入「等待 Unity」→ 轮询回执 */
  function doPackageImport(plan, jobId) {
    var p = cur();
    if (!p) return;
    setBusy(true);
    var job = {
      id: jobId,
      projectId: p.id,
      projectPath: p.path,
      sourceName: plan.sourceName,
      sourcePath: plan.sourcePath,
      mode: 'unitypackage',
      state: 'waiting-unity',
      fileCount: 1,
      bytes: plan.bytes,
      signature: plan.signature,     // 阶段 4：MA 请求要用同一个身份
      maWanted: !!plan.ma,           // 导入完成后要发起 MA 装配
      maMenu: !!plan.maMenu,
      requestId: '',
      createdAt: Date.now()
    };
    state.jobs.unshift(job);
    save();
    render();

    wb('execute', {
      projectRoot: p.path,
      source: plan.sourcePath,
      signature: plan.signature,
      id: jobId
    }).then(function (r) {
      job.requestId = (r && r.requestId) || '';
      job.message = (r && r.message) || '';
      return save();
    }).catch(function (e) {
      job.state = 'failed';
      job.finishedAt = Date.now();
      job.message = String((e && e.message) || e);
      toastErr(e);
      return save();
    }).then(function () {
      setBusy(false);
      render();
      startPolling();
    });
  }

  /* ---------------- 回执轮询（waiting-unity 的任务） ---------------- */

  var pollTimer = null;

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (!state.opened || !state.root) { stopPolling(); return; }
      var pendingImports = state.jobs.filter(function (j) {
        return j.state === 'waiting-unity' && j.requestId;
      });
      var pendingMa = state.jobs.filter(function (j) {
        return j.maRequestId && j.maState !== 'applied' && j.maState !== 'skipped'
          && j.maState !== 'error' && j.maState !== 'failed';
      });
      if (!pendingImports.length && !pendingMa.length) { stopPolling(); return; }
      pendingImports.slice(0, 5).forEach(checkReceipt);
      pendingMa.slice(0, 5).forEach(checkMaReceipt);
    }, 3000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function checkReceipt(job) {
    wb('receipt', { projectRoot: job.projectPath, requestId: job.requestId }).then(function (r) {
      if (!r || !r.found) return;

      /* Unity 发现 GUID 冲突、没有导入、并且已删掉 .claimed（不会自动再执行）。
       * 这不是失败：任务继续挂在 waiting-unity，由用户决定「仍要导入」还是「放弃」。 */
      if (r.state === 'blocked') {
        var wasBlocked = !!job.blocked;
        job.blocked = true;
        job.conflicts = r.conflicts || [];
        job.blockedMessage = r.message || '';
        job.state = 'waiting-unity';
        var blockedMsg = r.message || ('有 ' + job.conflicts.length + ' 处 GUID 冲突，尚未导入。');
        var blockedChanged = job.message !== blockedMsg;
        job.message = blockedMsg;
        if (!wasBlocked) {
          Toast.warn('有 ' + job.conflicts.length + ' 处 GUID 冲突，导入暂停：' + (job.sourceName || '素材包'), 7000);
          save().then(render);
        } else if (blockedChanged) {
          render();
        }
        return;
      }

      if (r.state === 'importing') {
        var msg = r.message || '';
        if (job.message !== msg) { job.message = msg; render(); }
        return;
      }
      if (r.state === 'completed') {
        job.blocked = false;
        job.conflicts = [];
        job.blockedMessage = '';
        job.state = 'completed';
        var assets = (r.assets && r.assets.length) ? r.assets : null;
        job.importedAssets = assets || [];
        job.assetsComplete = !!r.assetsComplete;
        job.overwrote = r.overwrote || [];
        job.manifestComplete = r.manifestComplete !== false;
        job.packagePath = r.package || '';
        job.packageBytes = (typeof r.packageBytes === 'number' && r.packageBytes >= 0)
          ? r.packageBytes
          : (job.packageBytes || 0);
        job.message = assets
          ? ('已导入 ' + assets.length + ' 个资源'
            + (r.assetsComplete === false ? '（列表超长已截断）' : '')
            + (job.overwrote.length ? ('，覆盖了 ' + job.overwrote.length + ' 个已有资源') : ''))
          : (r.message || '导入完成，具体位置请在 Unity 的 Project 窗口确认。');
        // 阶段 4：包导入完成后，按需发起 MA 装配
        if (job.maWanted && !job.maRequestId && job.maState !== 'failed') {
          sendMaRequest(job, {
            mode: 'unitypackage',
            signature: job.signature,
            importId: job.requestId,
            prefabPaths: [],
            menu: !!job.maMenu
          });
        }
      } else if (r.state === 'cancelled') {
        job.state = 'cancelled';
        job.message = r.message || '在 Unity 弹窗里取消了导入。';
      } else if (r.state === 'failed') {
        job.state = 'failed';
        job.message = r.message || '导入失败。';
      } else {
        // 未知状态：保持等待，只把 Unity 的话显示出来，不要一律判失败
        var unknownMsg = r.message || '';
        if (job.message !== unknownMsg) { job.message = unknownMsg; render(); }
        return;
      }
      job.finishedAt = Date.now();
      save().then(render);
      Toast[job.state === 'completed' ? 'ok' : (job.state === 'cancelled' ? 'info' : 'err')](
        (job.sourceName || '素材包') + '：' + job.message
      );
    }).catch(function () { /* 单次查询失败不打扰，下一轮再试 */ });
  }

  /* 冲突闸门：同一 requestId 重新下发 allowOverwrite:true，让 Unity 覆盖同名资源 */
  function allowOverwrite(job) {
    setBusy(true);
    wb('allowOverwrite', { projectRoot: job.projectPath, requestId: job.requestId }).then(function () {
      job.blocked = false;
      job.conflicts = [];
      job.blockedMessage = '';
      job.state = 'waiting-unity';
      job.message = '已允许覆盖，等待 Unity 重新处理';
      Toast.ok('已允许覆盖，等待 Unity 重新处理。');
      startPolling();
      return save().then(render);
    }).catch(toastErr).then(function () { setBusy(false); render(); });
  }

  /* 放弃这次导入：Unity 侧已经没有 .claimed，不会再执行 */
  function giveUp(job) {
    job.state = 'cancelled';
    job.blocked = false;
    job.conflicts = [];
    job.blockedMessage = '';
    job.message = '已放弃，Unity 不会再导入这个请求';
    job.finishedAt = Date.now();
    save().then(render);
  }

  function checkMaReceipt(job) {
    wb('maReceipt', { projectRoot: job.projectPath, requestId: job.maRequestId }).then(function (r) {
      if (!r || !r.found) return;
      if (r.state === 'waiting-import' || r.state === 'waiting-selection') {
        var msg = r.message || '';
        if (job.maMessage !== msg) { job.maMessage = msg; render(); }
        return;
      }
      job.maState = r.state === 'applied' ? 'applied' : (r.state === 'skipped' ? 'skipped' : 'error');
      job.maMessage = r.message || '';
      job.maAvatar = r.avatarName || '';
      job.maHierarchy = r.hierarchyPath || '';
      job.maMenuMode = r.menuMode || '';
      save().then(render);
      if (job.maState === 'applied') {
        Toast.ok('MA 装配完成：' + (job.maHierarchy || job.maAvatar || job.sourceName));
      } else if (job.maState === 'error') {
        Toast.err('MA 装配失败：' + job.maMessage, 7000);
      }
    }).catch(function () { /* 单次查询失败不打扰 */ });
  }

  /* ---------------- 记录操作 ---------------- */

  function openLocation(job) {
    var p = state.projects.filter(function (x) { return x.id === job.projectId; })[0];
    if (!p) { Toast.warn('这条记录对应的工程已经不在列表里了。'); return; }
    // 包模式：有 Unity 上报的资源路径就打开第一个资源的所在目录
    if (!job.destRel) {
      var first = (job.importedAssets && job.importedAssets[0]) || '';
      var parts = first ? first.split('/').slice(0, -1) : [];
      FS.host.open(parts.length ? joinWinPath(p.path, parts) : p.path);
      return;
    }
    FS.host.open(joinWinPath(p.path, job.destRel.split('/')));
  }

  function removeJob(job) {
    state.jobs = state.jobs.filter(function (x) { return x.id !== job.id; });
    save();
    render();
  }

  function showLog() {
    wb('logTail', { lines: 300 }).then(function (r) {
      if (!r || !r.exists) {
        Toast.info((r && r.message) || '还没有 Unity 日志。', 4200);
        return;
      }
      Modal.open({
        title: 'Unity Editor.log（末尾 300 行）',
        size: 'lg',
        body: [el('pre', { class: 'wb-log', text: r.text || '' })],
        footer: [el('button', { class: 'btn', onclick: function () { FS.host.open(r.path); } }, '打开日志文件')]
      });
    }).catch(toastErr);
  }

  /* =====================================================================
   * 渲染
   * ===================================================================== */

  function setBusy(v) {
    state.busy = v;
    if (state.root) state.root.classList.toggle('wb-busy', v);
  }

  function render() {
    if (!state.opened || !state.root) return;
    var body = state.root.querySelector('.wb-body');
    body.innerHTML = '';
    body.appendChild(renderProject());
    if (cur()) {
      body.appendChild(renderReadiness());
      body.appendChild(renderImport());
    }
    body.appendChild(renderJobs());
  }

  function renderProject() {
    var p = cur();
    var select = el('select', {
      class: 'input wb-select',
      onchange: function (e) { selectProject(e.target.value); }
    }, [el('option', { value: '' }, '请选择目标工程')].concat(
      state.projects.map(function (x) {
        return el('option', { value: x.id, selected: x.id === state.projectId }, projectName(x));
      })
    ));

    return el('section', { class: 'wb-card' }, [
      el('div', { class: 'wb-card-head' }, [
        el('h2', { text: '目标 Unity 工程' }),
        el('small', { text: '工程是包含 Assets、Packages、ProjectSettings 的整个文件夹' })
      ]),
      el('div', { class: 'wb-row' }, [
        select,
        el('button', { class: 'btn', onclick: addProject, disabled: state.busy }, '添加工程'),
        el('button', { class: 'btn', onclick: openUnity, disabled: !p || state.busy }, '打开 Unity'),
        el('button', { class: 'btn', onclick: function () { check(); }, disabled: !p || state.busy }, '重新检查'),
        el('button', {
          class: 'btn',
          onclick: installHelpers,
          disabled: !p || state.busy
        }, helperButtonLabel()),
        p ? el('button', { class: 'btn btn-danger-ghost', onclick: removeProject }, '移除登记') : null
      ]),
      p ? el('p', { class: 'wb-path wb-mono', text: p.path }) : null,
      p ? el('p', { class: 'wb-hint', text: helperStatusText() }) : null,
      p && p.missing ? el('p', { class: 'wb-warn-line', text: '这个目录现在打不开了：可能被移动或删除。重新添加一次即可沿用原记录。' }) : null,
      !p && !state.projects.length
        ? el('p', { class: 'wb-hint', text: '还没有登记任何工程。点「添加工程」选择你用来改模的那个 Unity 工程根目录。' })
        : null
    ]);
  }

  function renderReadiness() {
    var r = state.readiness;
    var p = cur();
    var cards = (r ? r.dependencies : []).map(function (d) {
      return el('div', { class: 'wb-dep wb-dep-' + d.state }, [
        el('b', { text: d.label }),
        el('span', { text: DEP_STATE_TEXT[d.state] || d.state }),
        el('small', { class: 'wb-mono', text: d.version || '版本未知' })
      ]);
    });

    return el('section', { class: 'wb-card' }, [
      el('div', { class: 'wb-card-head' }, [
        el('h2', { text: '工程准备情况' }),
        el('small', {
          text: r
            ? ('Unity ' + (r.unityVersion || '版本未知') + ' · ' + fmtTime(r.checkedAt) + ' 检查')
            : '正在检查所选工程…'
        })
      ]),
      el('div', { class: 'wb-deps' }, cards),
      el('p', { class: 'wb-hint', text: '只核对 VRChat Avatar SDK、Modular Avatar、NDMF 三个公开依赖的包说明，不扫描你的其他插件。包文件存在不代表编译通过，最终以 Unity 的结果为准。' }),
      (r && r.notes && r.notes.length)
        ? el('ul', { class: 'wb-note-list' }, r.notes.map(function (n) { return el('li', { text: n }); }))
        : null,
      p && !r ? el('p', { class: 'wb-hint', text: '点「重新检查」重试。' }) : null
    ]);
  }

  function renderImport() {
    return el('section', { class: 'wb-card' }, [
      el('div', { class: 'wb-card-head' }, [
        el('h2', { text: '导入素材' }),
        el('small', { text: '文件夹复制进工程，或 .unitypackage 交给 Unity 弹窗确认' })
      ]),
      el('div', { class: 'wb-row' }, [
        el('button', { class: 'btn btn-primary', onclick: importFlow, disabled: state.busy }, '导入素材'),
        el('button', { class: 'btn', onclick: showLog }, '查看 Unity 日志')
      ]),
      el('p', { class: 'wb-hint', text: '文件夹素材会列出「要复制哪些文件、会不会撞 GUID」，确认后复制到 Assets/VRCAL_Imports；Unity 素材包则写一个请求文件，等你在 Unity 的官方弹窗里确认。两种都不会改动原素材。' })
    ]);
  }

  function renderJobs() {
    var jobs = state.jobs.slice();
    var counts = { all: jobs.length, waiting: 0, attention: 0, completed: 0 };
    jobs.forEach(function (j) { counts[jobStatusKind(j)]++; });
    var shown = jobs.filter(function (j) {
      return state.filter === 'all' || jobStatusKind(j) === state.filter;
    });

    var filter = el('select', {
      class: 'input wb-select-sm',
      onchange: function (e) { state.filter = e.target.value; render(); }
    }, [
      el('option', { value: 'all', selected: state.filter === 'all' }, '全部记录 · ' + counts.all),
      el('option', { value: 'waiting', selected: state.filter === 'waiting' }, '等待处理 · ' + counts.waiting),
      el('option', { value: 'attention', selected: state.filter === 'attention' }, '需要处理 · ' + counts.attention),
      el('option', { value: 'completed', selected: state.filter === 'completed' }, '已完成 · ' + counts.completed)
    ]);

    return el('section', { class: 'wb-card' }, [
      el('div', { class: 'wb-card-head' }, [
        el('h2', { text: '导入记录' }),
        el('small', { text: '最近 ' + MAX_JOBS + ' 条；记录保存在程序数据目录' })
      ]),
      el('div', { class: 'wb-row wb-row-tight' }, [filter]),
      shown.length
        ? el('div', { class: 'wb-jobs' }, shown.map(renderJob))
        : el('p', { class: 'wb-hint', text: jobs.length ? '当前筛选没有记录。' : '还没有导入过。选一个素材文件夹试试。' })
    ]);
  }

  function renderJob(job) {
    var kind = jobStatusKind(job);
    var p = state.projects.filter(function (x) { return x.id === job.projectId; })[0];

    return el('article', { class: 'wb-job wb-job-' + kind }, [
      el('div', { class: 'wb-job-main' }, [
        el('div', { class: 'wb-job-title' }, [
          el('b', { text: job.sourceName || '（未命名）' }),
          el('span', { class: 'wb-badge wb-badge-' + kind, text: job.blocked ? '待确认冲突' : (JOB_STATE_TEXT[job.state] || job.state) })
        ]),
        el('div', { class: 'wb-job-meta' }, [
          el('span', { text: '→ ' + (p ? projectName(p) : '（工程已移除）') }),
          el('span', { text: fmtTime(job.finishedAt || job.createdAt) }),
          el('span', { text: job.mode === 'unitypackage'
            ? ('Unity 素材包 · ' + fmtMB(job.bytes))
            : ((job.completedFiles || 0) + '/' + (job.fileCount || 0) + ' 文件 · ' + fmtMB(job.copiedBytes || job.bytes)) })
        ]),
        job.destRel ? el('div', { class: 'wb-job-dest wb-mono', text: job.destRel }) : null,
        job.packagePath
          ? el('div', { class: 'wb-job-dest wb-mono', text: '包：' + job.packagePath + (job.packageBytes ? (' · ' + fmtMB(job.packageBytes)) : '') })
          : null,
        job.message ? el('div', { class: 'wb-job-msg', text: job.message }) : null,
        (job.state === 'waiting-unity' && !job.blocked)
          ? el('div', { class: 'wb-job-msg', text: '等待 Unity：打开工程后助手会自动弹出导入窗口。发送请求后 Unity 没开也没关系，请求会一直排队。' })
          : null,
        job.blocked
          ? el('div', { class: 'wb-job-msg wb-conflict' }, [
              el('div', { text: '有 ' + ((job.conflicts && job.conflicts.length) || 0) + ' 处 GUID 冲突，尚未导入' }),
              (job.conflicts && job.conflicts.length)
                ? el('ul', { class: 'wb-conflict-list' }, job.conflicts.slice(0, 3).map(function (c) {
                    return el('li', { class: 'wb-mono', text: (c.guid || '（无 guid）') + '　现有：' + (c.existingPath || '?') + '　包内：' + (c.packagePath || '?') });
                  }))
                : null
            ])
          : null,
        (job.overwrote && job.overwrote.length)
          ? el('div', { class: 'wb-job-dest wb-mono', text: '覆盖了 ' + job.overwrote.length + ' 个已有资源' + (job.overwrote.length > 3 ? '（只列前 3 条）' : '') + '\n' + job.overwrote.slice(0, 3).join('\n') })
          : null,
        job.maRequestId || job.maState
          ? el('div', { class: 'wb-job-msg wb-ma-line', text: maLineText(job) })
          : null,
        (job.importedAssets && job.importedAssets.length)
          ? el('div', { class: 'wb-job-dest wb-mono', text: job.importedAssets.slice(0, 3).join('\n') + (job.importedAssets.length > 3 ? ('\n… 共 ' + job.importedAssets.length + ' 个') : '') })
          : null
      ]),
      el('div', { class: 'wb-job-actions' }, [
        job.blocked
          ? el('button', { class: 'btn btn-sm btn-primary', onclick: function () { allowOverwrite(job); } }, '仍要导入（覆盖同名资源）')
          : null,
        job.blocked
          ? el('button', { class: 'btn btn-sm btn-danger-ghost', onclick: function () { giveUp(job); } }, '放弃这次导入')
          : null,
        (job.destRel || (job.importedAssets && job.importedAssets.length))
          ? el('button', { class: 'btn btn-sm', onclick: function () { openLocation(job); } }, '打开位置')
          : null,
        el('button', { class: 'btn btn-sm btn-danger-ghost', onclick: function () { removeJob(job); } }, '删记录')
      ])
    ]);
  }

  /* =====================================================================
   * 页面容器
   * ===================================================================== */

  function open() {
    if (state.opened) return;
    state.opened = true;

    var root = el('div', { class: 'wb-page' }, [
      el('header', { class: 'wb-head' }, [
        el('div', { class: 'wb-head-title' }, [
          el('b', { text: '改模工作台' }),
          el('small', { text: '选工程 · 看准备情况 · 导入素材 · 记账' })
        ]),
        el('div', { class: 'grow' }),
        /* 导入队列的常驻入口：悬浮窗被收起或拖走了，这里也能点开 */
        queueEntry = el('button', {
          class: 'btn wb-queue-btn', style: { display: 'none' },
          onclick: function () { if (taskPanel) openTaskPanel(); }
        }, '导入队列'),
        el('button', { class: 'btn', onclick: showLog }, 'Unity 日志'),
        el('button', { class: 'icon-btn', title: '关闭 (Esc)', onclick: close }, ICONS.label('\u2715'))
      ]),
      el('div', { class: 'wb-body' }, [
        el('p', { class: 'wb-hint', text: '正在读取…' })
      ])
    ]);

    state.root = root;
    document.body.appendChild(root);
    document.body.classList.add('wb-open');
    refreshQueueEntry();
    requestAnimationFrame(function () { root.classList.add('in'); });

    load().then(function () {
      render();
      if (state.projectId) check();
      startPolling();   // 有等待 Unity 的任务就接着轮询回执
    });
  }

  function close() {
    if (!state.root) return;
    stopPolling();
    state.root.classList.remove('in');
    var node = state.root;
    state.root = null;
    state.opened = false;
    queueEntry = null;   // 标题栏随页面一起被拆，入口归悬浮窗管
    document.body.classList.remove('wb-open');
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 200);
  }

  function boot() {
    initCloseGuard();
    var btn = document.getElementById('btnWorkbench');
    if (btn) btn.addEventListener('click', open);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.opened && !document.querySelector('.modal-overlay')) close();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 队列状态：后台运行，允许边浏览边追加 */
  var importBusy = false;
  var importPending = [];
  var hostBusyTimer = null;
  var queueResumeFn = null;
  var closePromptOpen = false;

  /* ---------------- 关闭窗口：导入没完先问一句 ---------------- */

  /* busy 在后端是「租约」：每 40 秒续一次，2 分钟有效。
     页面崩了不续期，租约过期后窗口就能正常关掉，不会把用户锁死。 */
  function setHostBusy(on) {
    var busy = !!on;
    wb('setImportBusy', { busy: busy, keepMs: 120000 }).catch(function () {});
    if (busy) {
      if (!hostBusyTimer) {
        hostBusyTimer = setInterval(function () {
          wb('setImportBusy', { busy: true, keepMs: 120000 }).catch(function () {});
        }, 40000);
      }
    } else if (hostBusyTimer) {
      clearInterval(hostBusyTimer);
      hostBusyTimer = null;
    }
  }

  function initCloseGuard() {
    try {
      var T = window.__TAURI__;
      if (!T || !T.event || typeof T.event.listen !== 'function') return;
      T.event.listen('wb-busy-close', function () {
        if (closePromptOpen) return;   // 连点两下 × 别弹两层
        closePromptOpen = true;
        Modal.confirm('导入还在进行中。现在退出会中断当前这一项——已经复制完的文件不会损坏，下次导入会接着复制。', {
          title: '确定退出吗？',
          okText: '退出',
          cancelText: '继续导入'
        }).then(function (ok) {
          closePromptOpen = false;
          if (!ok) return;
          setHostBusy(false);
          wb('quitNow', {}).catch(function () {});
        });
      });
    } catch (e) { /* 网页版没有宿主事件，忽略 */ }
  }

  /* ---------------- 续传：记住「还剩哪些没导」 ---------------- */

  function saveResume(project, remaining) {
    var list = (remaining || []).map(function (a, i) {
      return { title: assetLabel(a, i), src: srcOf(a) || '' };
    }).filter(function (x) { return !!x.src; });
    if (!list.length) { clearResume(); return; }
    state.resume = {
      projectId: project.id,
      projectPath: project.path,
      at: Date.now(),
      items: list
    };
    save();
  }

  function clearResume() {
    if (!state.resume) return;
    state.resume = null;
    save();
  }

  var resumeOffered = false;

  function offerResume() {
    if (resumeOffered) return;
    var r = state.resume;
    if (!r || !Array.isArray(r.items) || !r.items.length) return;
    if (Date.now() - (r.at || 0) > 7 * 24 * 3600 * 1000) { clearResume(); return; }
    if (importBusy) return;
    resumeOffered = true;

    var panel = openTaskPanel();
    queueResumeFn = function () {
      var items = r.items.map(function (x) {
        return { title: x.title, paths: [{ path: x.src }] };
      });
      importToUnity(items, { projectId: r.projectId });
    };
    panel.status.textContent = '上次导入没有跑完：还剩 ' + r.items.length + ' 项';
    panel.sub.textContent = '点「继续上次导入」接着来：已经导完的文件会跳过，只补剩下的。'
      + '如果这些其实已经导完了（比如 Unity 那边显示成功），点「忽略」即可。';
    if (panel.requeueBtn) {
      panel.requeueBtn.style.display = '';
      panel.requeueBtn.textContent = '继续上次导入（' + r.items.length + ' 项）';
    }
    if (panel.resumeDismissBtn) panel.resumeDismissBtn.style.display = '';
  }

  /* 素材库 → Unity：支持单张 / 多选，导入前必须选工程。
     解压期间显示进度弹窗（后端把进度写在 extract-progress.json 里，这里轮询）。 */
  function srcOf(asset) {
    var src = '';
    try {
      if (asset && Array.isArray(asset.paths) && asset.paths.length) {
        var pick = null;
        for (var i = 0; i < asset.paths.length; i++) {
          var q = asset.paths[i] && asset.paths[i].path;
          if (!q) continue;
          if (/\.(unitypackage|zip)$/i.test(q)) { pick = q; break; }
          if (!pick) pick = q;
        }
        if (pick) src = pick;
      }
    } catch (e) {}
    if (!src && asset && asset.path) src = asset.path;
    return src;
  }

  function assetLabel(asset, i) {
    return (asset && (asset.title || asset.originalTitle)) || ('第 ' + (i + 1) + ' 项');
  }

  function pushJobs(project, r) {
    var jobs = (r && r.jobs) || [];
    var added = 0;
    jobs.forEach(function (j) {
      var res = j.result || {};
      /* 后端现在会把「单个包失败」记成 ok:false 的 job，而不是整批抛错。
         这种条目不能写成一条正常记录，交给调用方计入失败清单。 */
      if (res.ok === false) return;
      added++;
      var name = j.kind === 'folder'
        ? String(j.destRel || j.dest || '').split('/').pop()
        : String(j.path || '').split(/[\\/]/).pop();
      var done = res.state === 'completed' && typeof res.files === 'number';
      state.jobs.unshift({
        id: 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        projectId: project.id,
        projectPath: project.path,
        sourceName: name || '素材',
        sourcePath: j.path || j.destRel || j.dest || '',
        mode: j.kind === 'folder' ? 'copy' : 'unitypackage',
        state: done ? 'completed' : 'waiting-unity',
        requestId: done ? '' : (res.requestId || res.id || ''),
        fileCount: res.files || 0,
        bytes: res.bytes || 0,
        createdAt: Date.now()
      });
    });
    state.jobs = state.jobs.slice(0, MAX_JOBS);
    save();
    try { render(); } catch (e) {}
    return added;
  }

  /* 后端在 jobs 里回的失败项（目前只有包）：转成人能读的一句话 */
  function failedJobsOf(r) {
    return ((r && r.jobs) || []).filter(function (j) {
      return (j.result || {}).ok === false;
    });
  }

  /* 后端 notes：跳过了什么、忽略了什么。不能丢，不然用户以为导全了 */
  function notesOf(r) {
    return ((r && r.notes) || []).filter(Boolean).map(String);
  }

  /* =====================================================================
   * 导入队列悬浮窗
   * 和右下角的下载面板是同一形态：可拖动、默认贴右边、可以收成一条竖条。
   * 收起 ≠ 关闭：队列还在跑，竖条一直留着，点一下（或再点「导入到 Unity」）就展开。
   * ===================================================================== */
  var taskPanel = null;
  /* 工作台标题栏上的常驻入口：悬浮窗被收起、被拖走的时候，从页面里也能点开 */
  var queueEntry = null;

  /* 选择弹窗被误关时的「暂停点」：{ label, open }。有它，面板上就会出现「继续选择」。 */
  var pendingPick = null;

  function setPendingPick(label, openFn) {
    pendingPick = openFn ? { label: label || '', open: openFn } : null;
    syncPendingEntry();
  }

  function clearPendingPick() { setPendingPick('', null); }

  function syncPendingEntry() {
    if (!taskPanel || !taskPanel.resumeBtn) return;
    var on = !!pendingPick;
    taskPanel.resumeBtn.style.display = on ? '' : 'none';
    if (!on) return;
    taskPanel.resumeBtn.textContent = '继续选择：' + (pendingPick.label || '导入内容');
    // 误关之后要主动把入口露出来，别让它藏在收起条里
    taskPanelSetCollapsed(false);
  }

  function refreshQueueEntry() {
    if (!queueEntry) return;
    var alive = !!(taskPanel && taskPanel.root && document.body.contains(taskPanel.root));
    queueEntry.style.display = alive ? '' : 'none';
    if (!alive) return;
    var t = (taskPanel.badge && taskPanel.badge.textContent) || '';
    queueEntry.textContent = '导入队列' + (t ? ' ' + t : '');
  }

  function taskPanelSetCollapsed(on) {
    if (!taskPanel) return;
    taskPanel.root.classList.toggle('wb-task-collapsed', !!on);
    taskPanel.root.title = on ? '导入队列还在跑，点这里展开' : '';
    taskPanel.place();
    refreshQueueEntry();
  }

  function openTaskPanel() {
    if (taskPanel && document.body.contains(taskPanel.root)) {
      taskPanelSetCollapsed(false);
      return taskPanel;
    }

    var badge = el('span', { class: 'wb-task-badge', text: '0' });
    var status = el('div', { class: 'wb-task-line', text: '准备中…' });
    var sub = el('div', { class: 'wb-task-sub', text: '' });
    /* 收起态整条就是一个 <button>：以前收起后复用的是标题栏，而标题栏上绑着拖动
       （mousedown 里 preventDefault），点一下会先走拖动判定，看起来就是「点不动」。
       现在收起时标题栏整个隐藏，露出来的是一条纯按钮。 */
    var stripBadge = el('span', { class: 'wb-task-badge', text: '0' });
    var stripArrow = el('span', { class: 'wb-task-strip-arrow', text: '\u2039' });
    var strip = el('button', {
      class: 'wb-task-strip', type: 'button', title: '展开导入队列（队列还在跑）',
      onclick: function (e) { e.stopPropagation(); taskPanelSetCollapsed(false); }
    }, [
      stripBadge,
      el('span', { class: 'wb-task-strip-text', text: '导入队列' }),
      stripArrow
    ]);
    var foldBtn = el('button', {
      class: 'wb-task-btn', title: '收起（队列继续跑，点竖条再展开）',
      onclick: function (e) { e.stopPropagation(); taskPanelSetCollapsed(true); }
    }, '—');
    var closeBtn = el('button', {
      class: 'wb-task-btn', title: '关闭',
      onclick: function (e) { e.stopPropagation(); taskPanelDestroy(); }
    }, '×');
    var requeueBtn = el('button', {
      class: 'btn btn-sm btn-primary wb-task-resume', style: { display: 'none' },
      onclick: function () {
        var f = queueResumeFn;
        queueResumeFn = null;
        requeueBtn.style.display = 'none';
        resumeDismissBtn.style.display = 'none';
        if (f) f();
      }
    }, '继续上次导入');
    /* 上次的记录可能是「其实已经导完、只是程序没收到回执」（旧版等待逻辑会漏收）。
       留个「忽略」，不然每次启动都弹一次已完成的任务。 */
    var resumeDismissBtn = el('button', {
      class: 'btn btn-sm', style: { display: 'none' },
      onclick: function () {
        queueResumeFn = null;
        requeueBtn.style.display = 'none';
        resumeDismissBtn.style.display = 'none';
        clearResume();
        status.textContent = '已忽略上次未完成的记录';
        sub.textContent = '';
      }
    }, '忽略');
    /* 临时动作位：等回执时如果发现助手是旧版 / 没心跳，这里会出现「更新 Unity 助手」 */
    var actionBtn = el('button', {
      class: 'btn btn-sm wb-task-resume', style: { display: 'none' }
    }, '');
    var resumeBtn = el('button', {
      class: 'btn btn-sm wb-task-resume', style: { display: 'none' },
      onclick: function () { if (pendingPick && pendingPick.open) pendingPick.open(); }
    }, '继续选择');
    var head = el('div', { class: 'wb-task-head' }, [
      el('span', { class: 'wb-task-title', text: '导入队列' }),
      badge,
      el('span', { class: 'wb-task-spacer' }),
      foldBtn, closeBtn
    ]);
    var root = el('div', { class: 'wb-task wb-task-docked-right', id: 'wbImportPanel' }, [
      strip, head,
      el('div', { class: 'wb-task-body' }, [status, sub, requeueBtn, resumeDismissBtn, resumeBtn, actionBtn])
    ]);
    document.body.appendChild(root);

    /* 角标在「展开」和「竖条」两处各有一份，统一从这里写，免得对不上 */
    function setBadge(text) {
      badge.textContent = text;
      stripBadge.textContent = text;
      refreshQueueEntry();
    }

    var st = { dock: 'right', x: null, y: null };
    function place() {
      var w = root.offsetWidth || 320;
      var h = root.offsetHeight || 90;
      var x = st.dock === 'left' ? 0 : Math.max(0, window.innerWidth - w);
      if (!st.dock && st.x != null) x = Math.max(0, Math.min(window.innerWidth - w, st.x));
      var y = (st.y == null) ? Math.max(0, window.innerHeight - h - 96) : st.y;
      root.style.left = x + 'px';
      root.style.top = Math.max(0, Math.min(window.innerHeight - h, y)) + 'px';
      // 贴左边时向右指，贴右边时向左指
      stripArrow.textContent = st.dock === 'left' ? '\u203a' : '\u2039';
    }

    // 按住标题拖动；松手后吸附到最近的一侧，避免悬在中间挡住素材
    head.addEventListener('mousedown', function (ev) {
      if (ev.target && ev.target.tagName === 'BUTTON') return;
      // 收起态标题栏是隐藏的；再兜一层，别让拖动抢走「展开」
      if (root.classList.contains('wb-task-collapsed')) return;
      var r = root.getBoundingClientRect();
      var ox = ev.clientX - r.left, oy = ev.clientY - r.top;
      st.dock = '';
      st.x = r.left;
      st.y = r.top;
      root.classList.add('wb-task-dragging');
      function mv(e) {
        st.x = Math.max(0, Math.min(window.innerWidth - r.width, e.clientX - ox));
        st.y = Math.max(0, Math.min(window.innerHeight - r.height, e.clientY - oy));
        place();
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        root.classList.remove('wb-task-dragging');
        var rr = root.getBoundingClientRect();
        st.dock = (st.x + rr.width / 2) < window.innerWidth / 2 ? 'left' : 'right';
        st.x = null;
        root.classList.toggle('wb-task-docked-left', st.dock === 'left');
        root.classList.toggle('wb-task-docked-right', st.dock === 'right');
        place();
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
      ev.preventDefault();
    });

    // 收起状态下，点整条竖条就展开
    root.addEventListener('click', function () {
      if (root.classList.contains('wb-task-collapsed')) taskPanelSetCollapsed(false);
    });
    window.addEventListener('resize', place);

    taskPanel = {
      root: root, badge: badge, status: status, sub: sub, resumeBtn: resumeBtn, requeueBtn: requeueBtn,
      resumeDismissBtn: resumeDismissBtn, running: false, place: place,
      /* 显示一个临时动作按钮；传空则收起 */
      action: function (text, fn) {
        if (!text || !fn) { actionBtn.style.display = 'none'; actionBtn.disabled = false; return; }
        actionBtn.textContent = text;
        actionBtn.disabled = false;
        actionBtn.style.display = '';
        actionBtn.onclick = function () { fn(actionBtn); };
      },
      start: function (total) {
        this.running = true;
        closeBtn.style.display = 'none';   // 跑的时候只允许收起，不允许关掉入口
        // 队列真跑起来了，之前的「继续上次导入」入口就该收掉
        queueResumeFn = null;
        requeueBtn.style.display = 'none';
        resumeDismissBtn.style.display = 'none';
        setBadge('0/' + total);
        clearPendingPick();
        status.textContent = '准备中…';
        sub.textContent = '';
        taskPanelSetCollapsed(false);
      },
      progress: function (done, total) {
        setBadge(Math.min(done, total) + '/' + total);
      },
      finish: function (ok, bad) {
        this.running = false;
        closeBtn.style.display = '';
        setBadge(bad ? (ok + ' ✓ ' + bad + ' ✗') : (ok + ' ✓'));
        taskPanelSetCollapsed(false);
      }
    };
    place();
    return taskPanel;
  }

  function taskPanelDestroy() {
    if (!taskPanel) return;
    // 队列还在跑：只收起，绝不把入口弄丢
    if (taskPanel.running) { taskPanelSetCollapsed(true); return; }
    if (taskPanel.root.parentNode) taskPanel.root.parentNode.removeChild(taskPanel.root);
    taskPanel = null;
    refreshQueueEntry();
  }

  /* 素材库 → Unity：两阶段。先按队列把所有 zip 解压（带进度），
     再按队列逐个导入；包导入要等 Unity 回执落地才轮到下一个。 */
  function importToUnity(input, opts) {
    var items = (Array.isArray(input) ? input.slice() : [input]).filter(Boolean);
    if (!items.length) { Toast.err('没有可导入的素材'); return; }
    if (importBusy) {
      importPending = importPending.concat(items);
      if (typeof taskPanelSetCollapsed === 'function') taskPanelSetCollapsed(false);
      Toast.ok('已加入导入队列，前面还有任务在跑');
      return;
    }
    ensureLoaded().then(function () {
      if (!state.projects.length) { Toast.err('先在工作台里添加 Unity 工程，再回来导入'); return; }
      /* 续传：上次用的工程还在，就直接续，不再让用户选一遍 */
      var wantId = (opts && opts.projectId) || '';
      var reuse = wantId ? state.projects.filter(function (p) { return p.id === wantId; })[0] : null;
      if (reuse) { runQueue(reuse); return; }
      openPicker();
    });

    function openPicker() {
      var sel = el('select', { class: 'wb-project-select' }, state.projects.map(function (p) {
        return el('option', { value: p.id }, p.name || p.path);
      }));
      var cur = state.projects.filter(function (p) { return p.id === state.projectId; })[0];
      if (cur) sel.value = cur.id;
      Modal.open({
        title: '导入到哪个工程',
        size: 'sm',
        body: [
          el('p', { class: 'wb-hint', text: '导入分两步：先解压全部压缩包，再按队列逐个导入 Unity。' }),
          sel
        ],
        footer: [
          el('button', { class: 'btn', onclick: function () { Modal.closeTop(); } }, '取消'),
          el('button', {
            class: 'btn btn-primary',
            onclick: function () {
              var p = state.projects.filter(function (q) { return q.id === sel.value; })[0];
              if (!p) { Toast.err('先选一个工程'); return; }
              Modal.closeTop();
              runQueue(p);
            }
          }, '开始导入')
        ]
      });
    }

    function runQueue(project) {
      importBusy = true;
      setHostBusy(true);
      var total = items.length;
      /* 后台悬浮窗：不挡浏览，可以继续挑素材；收起后留一条竖条，随时能再点开 */
      var panel = openTaskPanel();
      var status = panel.status;
      var sub = panel.sub;
      panel.start(total);

      var timer = null;
      function beginPoll() {
        if (timer) return;
        timer = setInterval(function () {
          wb('importProgress', {}).then(function (g) {
            if (!g || !g.active) return;
            var pct = g.total ? Math.round((g.entries || 0) * 100 / g.total) : 0;
            sub.textContent = '解压中：' + (g.name || '压缩包') + '  ' + (g.entries || 0) + '/' + (g.total || 0) + '（' + pct + '%）';
          }).catch(function () {});
        }, 400);
      }
      function endPoll() { if (timer) { clearInterval(timer); timer = null; } }

      var failures = [];
      var notesAll = [];
      var idx = 0;
      var ok = 0;

      /* 队列到了哪一条，才解压哪一条；导入到终态才轮到下一条 */
      nextItem();

      function nextItem() {
        if (idx >= total) {
          if (importPending.length) {
            items = items.concat(importPending);
            importPending = [];
            total = items.length;
          } else {
            endPoll();
            finish();
            return;
          }
        }
        var a = items[idx];
        panel.progress(idx + 1, total);
        // 记住「还剩哪些」：进程被杀掉后下次启动能接着来
        saveResume(project, items.slice(idx));
        var label = assetLabel(a, idx);
        /* 伪条目：一个文件夹里有多个压缩包时，第 2 个起会被拆成独立队列项 */
        var src = a.__zip || a.__pkgFolder || srcOf(a);
        var remain = total - idx - 1;
        if (!src) {
          failures.push(label + '：没有本地路径');
          idx += 1;
          nextItem();
          return;
        }
        if (a.__pkgFolder) {
          // 这个文件夹里混着 .unitypackage：包优先，直接走包链路
          importOne(src, '', true);
          return;
        }
        var queueNote = remain > 0 ? '（队列还剩 ' + remain + '）' : '（最后一个）';
        wb('inspectPath', { path: src }).then(function (info) {
          var kind = (info && info.kind) || 'file';
          var zips = (info && info.zips) || [];
          var hasPkg = !!(info && info.hasPackages);
          if (kind === 'zip') { runZip(src); return; }
          if (kind === 'dir' && zips.length) {
            /* 一个文件夹里有好几个压缩包时，只导第一个等于静默丢素材：
               把其余的拆成独立队列项排在当前项后面。混着 .unitypackage 时再补一项。 */
            var extra = [];
            for (var i = 1; i < zips.length; i++) {
              extra.push({ __zip: zips[i], title: label + ' · 第 ' + (i + 1) + ' 个压缩包' });
            }
            if (hasPkg) extra.push({ __pkgFolder: src, title: label + ' · 素材包部分' });
            if (extra.length) {
              items = items.slice(0, idx + 1).concat(extra, items.slice(idx + 1));
              total = items.length;
            }
            runZip(zips[0]);
            return;
          }
          if (kind === 'dir') { chooseFolder(src, label); return; }
          importOne(src, '', kind === 'unitypackage');
        }).catch(function () {
          if (/\.zip$/i.test(src)) { runZip(src); return; }
          importOne(src, '', /\.unitypackage$/i.test(src));
        });

        function runZip(zipPath) {
          status.textContent = '解压 ' + (idx + 1) + ' / ' + total + '：' + label + queueNote;
          sub.textContent = '准备解压…';
          beginPoll();
          wb('importPath', { projectRoot: project.path, path: zipPath, extractOnly: true }).then(function (r) {
            endPoll();
            notesAll = notesAll.concat(notesOf(r));
            var dir = r && r.extractedTo;
            if (!dir) { failures.push(label + '：解压失败'); advance(); return; }
            chooseExtracted(dir, label);
          }).catch(function (e) {
            endPoll();
            failures.push(label + '：' + ((e && e.message) || e));
            advance();
          });
        }
      }

      function advance() { idx += 1; nextItem(); }

      function sizeText(n) {
        if (!n) return '';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
        return (n / 1024 / 1024).toFixed(1) + ' MB';
      }

      /* 解压完成后先让用户挑要导入哪几项 */
      /* 原始素材是文件夹：里面有多项时也让用户挑 */
      function chooseFolder(dir, label) {
        wb('listExtract', { dir: dir }).then(function (r) {
          var entries = (r && r.entries) || [];
          // 只有「顶层不止一项」才值得让用户挑；嵌套项再多也还是一个素材
          var tops = entries.filter(function (en) { return (en.depth || 0) === 0; });
          if (tops.length > 1) { chooseExtracted(dir, label, true); return; }
          importOne(dir, '', false);
        }).catch(function () { importOne(dir, '', false); });
      }

      /* 解压目录归我们管：跳过、解压后为空、导入报错时都该收掉，别在素材库旁边堆临时目录 */
      function discardDir(dir, keep) {
        if (keep || !dir) return;
        wb('discardExtract', { dir: dir }).catch(function () {});
      }

      /* 选择要导入的内容：按层级展开整棵解压目录树。
         后端 listExtract 返回的是「先序遍历 + depth + path」的扁平列表，
         这里接成树：父节点靠 path 前缀找，children 顺序与后端一致。 */
      function chooseExtracted(dir, label, keep) {
        wb('listExtract', { dir: dir }).then(function (r) {
          var entries = (r && r.entries) || [];
          if (!entries.length) {
            clearPendingPick();
            discardDir(dir, keep);
            failures.push(label + '：解压后没有可导入的内容');
            advance();
            return;
          }

          var byPath = Object.create(null);
          var order = [];
          var roots = [];
          entries.forEach(function (en) {
            var n = {
              path: en.path,
              name: en.name,
              dir: !!en.dir,
              depth: en.depth || 0,
              files: en.files || 0,
              size: en.size || 0,
              package: !!en.package,
              checked: true,
              indeterminate: false,
              parent: null,
              children: [],
              // 顶层默认展开，再往下折起来：既能看见结构，又不至于一屏几百行
              open: (en.depth || 0) === 0
            };
            byPath[n.path] = n;
            order.push(n);
          });
          order.forEach(function (n) {
            var i = n.path.lastIndexOf('/');
            var p = i < 0 ? null : byPath[n.path.slice(0, i)];
            if (p) { n.parent = p; p.children.push(n); } else { roots.push(n); }
          });

          /* ---- 勾选状态：勾父带子，子变了要往上重算 ---- */
          function setSubtree(n, v) {
            n.checked = !!v;
            n.indeterminate = false;
            n.children.forEach(function (c) { setSubtree(c, v); });
          }
          function refreshUp(n) {
            if (!n) return;
            if (n.children.length) {
              var all = n.children.every(function (c) { return c.checked && !c.indeterminate; });
              var none = n.children.every(function (c) { return !c.checked && !c.indeterminate; });
              n.checked = all;
              n.indeterminate = !all && !none;
            }
            refreshUp(n.parent);
          }
          /* 只取「自己勾上、父级没勾」的最上层节点，避免同一份内容被复制两遍 */
          function collectPicks() {
            var paths = [];
            var total = 0;
            order.forEach(function (n) {
              if (!n.checked || n.indeterminate) return;
              // 父级整块勾选时由父级代表，否则自己上
              if (n.parent && n.parent.checked && !n.parent.indeterminate) return;
              paths.push(n.path);
              total += n.dir ? n.files : 1;
            });
            return { paths: paths, totalFiles: total };
          }
          function visible(n) {
            var p = n.parent;
            while (p) {
              if (!p.open) return false;
              p = p.parent;
            }
            return true;
          }
          function metaOf(n) {
            if (!n.dir) return n.package ? 'Unity 包' : sizeText(n.size);
            var subs = n.children.filter(function (c) { return c.dir; }).length;
            return n.files + ' 个文件' + (subs ? ' · ' + subs + ' 个子目录' : '');
          }

          var importBtn = el('button', { class: 'btn btn-primary', onclick: function () {
            var picked = collectPicks();
            if (!picked.paths.length) { Toast.err('至少勾一项'); return; }
            decided = true;
            Modal.close(h);
            clearPendingPick();
            runSelected(dir, picked.paths, label, keep);
          } }, '导入选中的');

          var summary = el('span', { class: 'wb-hint wb-pick-count' });
          var box = el('div', { class: 'wb-pick-box' });

          order.forEach(function (n) {
            var caret = el('span', { class: 'wb-pick-caret' });
            if (n.dir && n.children.length) {
              caret.textContent = n.open ? '\u25be' : '\u25b8';
              caret.title = n.open ? '折叠' : '展开';
              caret.addEventListener('click', function (e) {
                // 别让点击冒泡到 label 上（否则会顺带切换勾选）
                e.preventDefault();
                e.stopPropagation();
                n.open = !n.open;
                syncAll();
              });
            } else {
              caret.classList.add('is-leaf');
            }

            var cb = el('input', { type: 'checkbox' });
            cb.checked = true;
            cb.addEventListener('change', function () {
              setSubtree(n, cb.checked);
              refreshUp(n.parent);
              syncAll();
            });

            n.row = el('label', {
              class: 'wb-pick-row',
              style: { paddingLeft: (8 + n.depth * 16) + 'px' }
            }, [
              caret,
              cb,
              el('span', { class: 'wb-pick-name', text: n.name }),
              el('span', { class: 'wb-hint wb-pick-meta', text: metaOf(n) })
            ]);
            n.box = cb;
            n.caret = caret;
            box.appendChild(n.row);
          });

          function syncAll() {
            order.forEach(function (n) {
              n.row.style.display = visible(n) ? '' : 'none';
              n.box.checked = n.checked;
              n.box.indeterminate = !!n.indeterminate;
              if (n.dir && n.children.length) n.caret.textContent = n.open ? '\u25be' : '\u25b8';
            });
            var picked = collectPicks();
            summary.textContent = '已选 ' + picked.paths.length + ' 项 · ' + picked.totalFiles + ' 个文件';
            importBtn.textContent = '导入选中的（' + picked.paths.length + ' 项）';
            importBtn.disabled = !picked.paths.length;
          }

          var body = [
            el('p', { class: 'wb-hint', text: '已解压。点 ▸ 展开子目录，勾选要导入工程的部分。' }),
            box
          ];
          if (r.truncated) {
            body.push(el('p', {
              class: 'wb-hint',
              text: '目录太多，只列出了前 2000 项；没显示部分可以先手动整理压缩包再导入。'
            }));
          }
          body.push(el('div', { class: 'wb-pick-actions' }, [
            el('button', { class: 'btn btn-sm', onclick: function () {
              roots.forEach(function (n) { setSubtree(n, true); });
              syncAll();
            } }, '全选'),
            el('button', { class: 'btn btn-sm', onclick: function () {
              roots.forEach(function (n) { setSubtree(n, false); });
              syncAll();
            } }, '全不选'),
            el('button', { class: 'btn btn-sm', onclick: function () {
              order.forEach(function (n) { n.open = true; });
              syncAll();
            } }, '全部展开'),
            el('button', { class: 'btn btn-sm', onclick: function () {
              order.forEach(function (n) { n.open = false; });
              syncAll();
            } }, '全部折叠'),
            summary
          ]));

          /* 这个窗口是队列的暂停点：用 × / Esc / 点遮罩关掉时不会走 advance()，
             队列就停在这儿。所以关掉时必须留一个能重新打开的入口，
             否则误操作一次就再也回不到这个选择界面。 */
          var decided = false;
          var h = Modal.open({
            title: '选择要导入的内容',
            size: 'md',
            body: body,
            footer: [
              el('button', { class: 'btn', onclick: function () {
                decided = true;
                Modal.close(h);
                clearPendingPick();
                discardDir(dir, keep);
                failures.push(label + '：已跳过');
                advance();
              } }, '跳过'),
              importBtn
            ],
            onClose: function () {
              if (decided) return;
              // 没做决定就关了：队列在这里停住，面板上出现「继续选择」
              setPendingPick(label, function () { chooseExtracted(dir, label, keep); });
              status.textContent = '已暂停：等你选择「' + label + '」里要导入的内容';
              sub.textContent = '点「继续选择」回到选择窗口；这一项没有被跳过，工程也没动。';
            }
          });
          clearPendingPick();
          syncAll();
        }).catch(function (e) {
          clearPendingPick();
          failures.push(label + '：列出内容失败 ' + ((e && e.message) || e));
          advance();
        });
      }

      function runSelected(dir, picks, label, keep) {
        var needsUnity = picks.some(function (n) { return /\.unitypackage$/i.test(n); });
        if (!needsUnity) { doSelected(); return; }
        wb('projectStatus', { projectRoot: project.path }).then(function (s) {
          if (s && s.open) { doSelected(); return; }
          failures.push(label + '：Unity 没有打开这个工程（Temp\\UnityLockfile 不存在），导入未执行。');
          advance();
        }).catch(function () { doSelected(); });

        function doSelected() {
          status.textContent = '导入 ' + (idx + 1) + ' / ' + total + '：' + label;
          sub.textContent = '已选 ' + picks.length + ' 项';
          wb('importSelected', { projectRoot: project.path, dir: dir, pick: picks, keep: !!keep }).then(function (r2) {
            var jobs = (r2 && r2.jobs) || [];
            /* 包失败会被后端记成 ok:false 的条目：复制部分照常算成功，包单独报错 */
            failedJobsOf(r2).forEach(function (j) {
              var filename = String(j.path || '').split(/[\\/]/).pop() || '素材包';
              failures.push(label + '：' + filename + ' ' + ((j.result && j.result.message) || '导入失败'));
            });
            notesAll = notesAll.concat(notesOf(r2));
            var addedCount = pushJobs(project, r2);
            var waiting = jobs.filter(function (j) {
              return ((j.result || {}).ok !== false) && ((j.result || {}).state) !== 'completed';
            }).map(function (j) { return (j.result || {}).requestId || ''; }).filter(Boolean);
            if (!waiting.length) { ok += addedCount; advance(); return; }
            waitTerminal(waiting, function (status, msg) {
              if (status === 'ok') { ok += addedCount; }
              else if (status === 'pending') { notesAll.push(label + '：' + msg); }
              else { failures.push(label + '：' + (msg || 'Unity 未完成导入')); }
              advance();
            });
          }).catch(function (e) {
            // 后端守卫会自己清，但 keep=false 时再兜一次（重复调用无副作用）
            discardDir(dir, keep);
            failures.push(label + '：' + ((e && e.message) || e));
            advance();
          });
        }
      }
      function importOne(target, cleanupDir, needsUnity) {
        var label = assetLabel(items[idx], idx);
        var remain = total - idx - 1;
        endPoll();
        if (!needsUnity) { doImport(); return; }
        wb('projectStatus', { projectRoot: project.path }).then(function (s) {
          if (s && s.open) { doImport(); return; }
          failures.push(label + '：Unity 没有打开这个工程（Temp\\UnityLockfile 不存在），导入未执行。请先打开工程再导入。');
          idx += 1;
          nextItem();
        }).catch(function () { doImport(); });

        function doImport() {
          status.textContent = '导入 ' + (idx + 1) + ' / ' + total + '：' + label
            + (remain > 0 ? '（队列还剩 ' + remain + '）' : '（最后一个）');
          sub.textContent = '';
          wb('importPath', { projectRoot: project.path, path: target, cleanupDir: cleanupDir }).then(function (r) {
            var jobs = (r && r.jobs) || [];
            failedJobsOf(r).forEach(function (j) {
              var filename = String(j.path || '').split(/[\\/]/).pop() || '素材包';
              failures.push(label + '：' + filename + ' ' + ((j.result && j.result.message) || '导入失败'));
            });
            notesAll = notesAll.concat(notesOf(r));
            var addedCount = pushJobs(project, r);
            var waiting = jobs.filter(function (j) {
              return ((j.result || {}).ok !== false) && ((j.result || {}).state) !== 'completed';
            }).map(function (j) { return (j.result || {}).requestId || ''; }).filter(Boolean);
            if (!waiting.length) { ok += addedCount; idx += 1; nextItem(); return; }
            waitTerminal(waiting, function (status, msg) {
              if (status === 'ok') { ok += addedCount; }
              else if (status === 'pending') { notesAll.push(label + '：' + msg); }
              else { failures.push(label + '：' + (msg || 'Unity 未完成导入')); }
              idx += 1;
              nextItem();
            });
          }).catch(function (e) {
            failures.push(label + '：' + ((e && e.message) || e));
            idx += 1;
            nextItem();
          });
        }
      }
      /* 等 Unity 回执。done(status, message)，status ∈ ok | fail | pending。
         三路同时看，任何一路给出结论就收尾，不再依赖单一通道：
           1) 本地记录里同一个 requestId 的终态（checkReceipt 的轮询结果）
           2) Unity 助手写回的回执（最权威，带资源清单核对）
           3) 看门狗：15 分钟还没有结论就收尾，队列不能永远挂在这里
         旧实现给回调传的是字符串，而回调按数组用（rs.every）——抛异常后
         再也没人调 advance()：记录早就显示「已导入 6 个资源」，队列却一直停在
         「已把包发给 Unity」。这就是「导入完成了队列还在显示」的原因。 */
      function waitTerminal(ids, done) {
        var started = Date.now();
        var queuedSince = 0;
        var settled = false;
        var timer = null;
        var lastHint = '已把包发给 Unity：请切到 Unity 窗口，在弹出的导入窗口里点 Import 完成这一步。';
        sub.textContent = lastHint;

        function settle(status, message) {
          if (settled) return;
          settled = true;
          if (timer) { clearInterval(timer); timer = null; }
          try { panel.action('', null); } catch (e) {}
          done(status, message || '');
        }

        /* 助手是旧版 / 没心跳时，面板上直接给一个「更新 Unity 助手」，
           不用让用户自己回工作台找按钮。更新完 Unity 会重编译，几秒后心跳就回来了。 */
        function offerAssistUpdate() {
          try {
            panel.action('更新 Unity 助手', function (btn) {
              btn.disabled = true;
              btn.textContent = '正在更新 Unity 助手…';
              wb('installBridge', { projectRoot: project.path, update: true }).then(function () {
                Toast.ok('已更新 Unity 助手，Unity 会重新编译，几秒后自动继续', 6000);
                btn.textContent = '已更新，等待 Unity 重编译…';
              }).catch(function (e) {
                btn.disabled = false;
                btn.textContent = '更新失败，重试';
                Toast.err('更新 Unity 助手失败：' + ((e && e.message) || e));
              });
            });
          } catch (e) {}
        }

        function hint(text) {
          if (!text || text === lastHint) return;
          lastHint = text;
          sub.textContent = text;
        }

        /* 回执 → 结论；非终态返回 null */
        function fromReceipt(x) {
          var st = (x && x.state) || '';
          if (st === 'completed') return { status: 'ok' };
          if (st === 'skipped') return { status: 'ok', message: '包内资源都已存在，Unity 没有重复导入。' };
          if (st === 'cancelled') { return { status: 'fail', message: '你在 Unity 导入窗口里取消了导入，工程未改动。' }; }
          if (st === 'blocked') { return { status: 'fail', message: x.message || '工程里有同名 GUID 冲突，Unity 没有执行导入。' }; }
          if (st === 'failed') { return { status: 'fail', message: x.message || 'Unity 导入失败。' }; }
          return null;
        }

        function fromJob(j) {
          if (!j) return null;
          if (j.state === 'completed') return { status: 'ok' };
          if (j.state === 'cancelled') return { status: 'fail', message: '导入已取消。' };
          if (j.state === 'failed') return { status: 'fail', message: j.message || 'Unity 导入失败。' };
          return null;
        }

        function settleFrom(verdicts) {
          var bad = verdicts.filter(function (v) { return v.status !== 'ok'; })[0];
          settle(bad ? 'fail' : 'ok', bad ? bad.message : '');
        }

        function tick() {
          if (settled) return;

          /* 1) 本地记录先看一眼：checkReceipt 已经在轮询同一批请求，它拿到终态就不用再问 */
          var local = [];
          for (var i = 0; i < ids.length; i += 1) {
            var hit = null;
            for (var k = 0; k < state.jobs.length; k += 1) {
              if (state.jobs[k].requestId === ids[i]) { hit = state.jobs[k]; break; }
            }
            local.push(hit);
          }
          var localVerdicts = local.map(fromJob);
          if (ids.length && localVerdicts.every(Boolean)) { settleFrom(localVerdicts); return; }

          /* 2) 问回执（Unity 助手写的） */
          Promise.all(ids.map(function (rid) {
            return wb('receipt', { projectRoot: project.path, requestId: rid })
              .catch(function () { return null; });
          })).then(function (rs) {
            if (settled) return;

            var verdicts = rs.map(fromReceipt);
            if (rs.every(function (x) { return x && x.found; }) && verdicts.every(Boolean)) {
              settleFrom(verdicts);
              return;
            }

            /* 助手心跳：拿不到回执时，至少能说清是「助手没在跑」还是「还没导完」 */
            var beat = rs.filter(function (x) { return x && x.bridge; })[0];

            var anyQueued = rs.some(function (x) { return x && x.found === false && x.queued === true; });
            if (anyQueued) {
              if (!queuedSince) queuedSince = Date.now();
              hint('请求已排进工程，等 Unity 认领…');
              if (Date.now() - queuedSince > 20000) {
                settle('pending', 'Unity 现在没打开这个工程，请求已排队；打开后助手会自动执行，结果以「记录」为准。');
              }
              return;
            }

            /* 已经认领、还没终态：把助手的状态说清楚，别让用户干等 */
            if (beat && beat.bridge === 'missing') {
              hint('没检测到 Unity 助手的心跳（工程里装的可能是旧版助手）。');
              offerAssistUpdate();
            } else if (beat && beat.bridge === 'stale') {
              hint('Unity 助手 30 秒内没有心跳（Unity 可能正在编译、导包，或者卡住了）…');
              try { panel.action('', null); } catch (e) {}
            } else if (beat && beat.bridgeCurrent === false) {
              hint('Unity 助手版本与程序不一致，需要更新一次。');
              offerAssistUpdate();
            } else if (beat && beat.active === false) {
              hint('Unity 助手空闲：请求还没被轮询到，稍等，或切到 Unity 窗口看一眼。');
              try { panel.action('', null); } catch (e) {}
            } else {
              hint('Unity 正在导入：请在弹出的导入窗口里点 Import 完成这一步。');
              try { panel.action('', null); } catch (e) {}
            }

            if (Date.now() - started > 15 * 60 * 1000) {
              settle('fail', '等待 Unity 超过 15 分钟，无法确认是否导入；可在「记录」里查看结果。');
            }
          }).catch(function () {
            if (Date.now() - started > 15 * 60 * 1000) {
              settle('fail', '等待 Unity 超过 15 分钟，无法确认是否导入；可在「记录」里查看结果。');
            }
          });
        }

        timer = setInterval(tick, 1500);
        tick();
      }

      function finish() {
        importBusy = false;
        setHostBusy(false);
        clearResume();
        panel.finish(ok, failures.length);
        status.textContent = '完成：成功 ' + ok + ' 项' + (failures.length ? '，失败 ' + failures.length + ' 项' : '');
        /* 后端跳过的内容（非法文件名、被忽略的 Packages/ 等）必须让用户看见 */
        var notes = notesAll.filter(function (n, i) { return notesAll.indexOf(n) === i; });
        var parts = [];
        if (failures.length) parts.push(failures.join('；'));
        if (notes.length) {
          parts.push('注意：' + notes.slice(0, 3).join('；')
            + (notes.length > 3 ? ('…另有 ' + (notes.length - 3) + ' 条提示') : ''));
        }
        sub.textContent = parts.join('　');
        if (notes.length) sub.title = notes.join('\n');
        var msg = '已导入 ' + ok + ' 项' + (failures.length ? '，' + failures.length + ' 项失败' : '');
        if (failures.length) Toast.err(msg); else Toast.ok(msg);
        try { render(); } catch (e) {}
      }
    }
  }
  ensureLoaded();
  return { open: open, close: close, addProject: addProject, check: check, importFlow: importFlow, importToUnity: importToUnity };
})();
