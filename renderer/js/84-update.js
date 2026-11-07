/*
 * 84-update.js  —  检查更新与自动替换
 *
 * 负责：取 GitHub Releases 的 latest，比较版本号，给出「立即更新」入口。
 * 自动替换的实际动作在主进程（electron/main/host/api-update.js）：这里只负责
 * 挑 zip 资产、显示进度、调用 /api/update/*。
 * 与谁交互：请求走 FS.host.fetchURL，更新走 FS.host.update，外链走 vrcElectron.openExternal。
 * 边界：网络只在用户点按钮时发起（启动时 quiet 检查除外）；不做后台轮询。
 */

var Updater = (function () {
  /* 唯一的更新源：换仓库改这两行即可（记得同步文档里的地址）。
   * 版本号比的是 tag_name，发版时 tag 要带上 v 前缀。 */
  var REPO_OWNER = 'luoborua';
  var REPO_NAME = 'VRChat-asset-library';

  function source() {
    return { owner: REPO_OWNER, repo: REPO_NAME, configured: true };
  }

  /** 把 "vX.Y.Z" / "X.Y.Z" / "X.Y" 解析成数字三元组；解析不出来返回 null */
  function parseVer(s) {
    var m = String(s == null ? '' : s).replace(/^v/i, '').trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m) return null;
    return [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0];
  }
  /** a > b 返回 1，相等 0，小于 -1；任一侧解析失败返回 0（当作相同，不误报有新版本） */
  function compareVer(a, b) {
    var x = parseVer(a), y = parseVer(b);
    if (!x || !y) return 0;
    for (var i = 0; i < 3; i++) {
      if (x[i] > y[i]) return 1;
      if (x[i] < y[i]) return -1;
    }
    return 0;
  }

  function currentVersion() { return String((typeof APP !== 'undefined' && APP.version) || '0.0.0'); }

  function releaseUrl(owner, repo) { return 'https://github.com/' + owner + '/' + repo + '/releases/latest'; }
  function repoUrl(owner, repo) { return 'https://github.com/' + owner + '/' + repo; }

  /** 从 Release 资产里挑可自动覆盖的便携包。
   *  发布包名形如 vrchat-asset-library_v1.3.0_win-x64.zip。只认带 win-x64 的 zip：
   *  历史上还有过「单 exe 的 WebView2 壳」包（VRCLib-1.3.0-win64.zip），结构完全不同，
   *  拿它去覆盖只会把安装目录弄坏 —— 宁可不给按钮，让用户走发布页手动选。 */
  function pickAsset(assets) {
    var list = (assets || []).filter(function (a) {
      return a && /\.zip$/i.test(String(a.name || '')) && a.browser_download_url;
    });
    var best = list.filter(function (a) { return /win[-_ ]?x64/i.test(a.name); })[0] || null;
    if (!best) return null;
    return {
      name: String(best.name || ''),
      url: String(best.browser_download_url),
      size: Number(best.size) || 0,
      /* GitHub 新版接口给 digest（sha256:...），有就校验，没有就只比大小 */
      sha256: String(best.digest || '').replace(/^sha256:/i, '')
    };
  }

  function openUrl(url) {
    try {
      if (window.vrcElectron && typeof window.vrcElectron.openExternal === 'function') {
        window.vrcElectron.openExternal(url);
        return true;
      }
    } catch (e) {}
    try { FS.openPath(url); return true; } catch (e) { return false; }
  }

  var busy = false;

  /**
   * 检查更新；opts.quiet 为 true 时不弹「已是最新」的提示。
   * 返回 { ok, hasUpdate, current, latest, url, reason }
   */
  function check(opts) {
    opts = opts || {};
    var src = source();
    if (busy) { Toast.info('正在检查，请稍候…', 2500); return Promise.resolve({ ok: false, reason: 'busy' }); }
    busy = true;

    var api = 'https://api.github.com/repos/' + encodeURIComponent(src.owner) + '/' + encodeURIComponent(src.repo) + '/releases/latest';
    Toast.info('正在检查更新…', 4000);
    return FS.host.fetchURL(api, {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'VRChat-Asset-Library/' + currentVersion()
    }, 'GET').then(function (res) {
      busy = false;
      var status = res && res.status;
      var text = String((res && res.text) || '');

      if (status === 404) {
        Toast.warn('仓库或已发布的版本不存在（HTTP 404）。发包前需要先在 GitHub 上建一个 Release。', 8000);
        return { ok: false, reason: 'not-found' };
      }
      if (status === 403 || status === 429) {
        Toast.warn('GitHub 接口被限流或拒绝访问（HTTP ' + status + '）。公开仓库每小时 60 次，稍后再试。', 8000);
        return { ok: false, reason: 'rate-limited' };
      }
      if (!res || !res.okFlag) {
        Toast.err('检查更新失败（HTTP ' + (status || '?') + '）', 7000);
        return { ok: false, reason: 'http-' + status };
      }

      var j = null;
      try { j = JSON.parse(text); } catch (e) {
        Toast.err('GitHub 返回的内容不是 JSON，可能被网络拦截了', 7000);
        return { ok: false, reason: 'bad-json' };
      }

      var latest = String(j.tag_name || j.name || '').trim();
      var cur = currentVersion();
      var hasUpdate = compareVer(latest, cur) > 0;
      var page = String(j.html_url || releaseUrl(src.owner, src.repo));

      if (!opts.quiet) {
        if (hasUpdate) showUpdate(cur, latest, j, page);
        else Toast.ok('已是最新版本（' + cur + '）', 5000);
      }
      return {
        ok: true, hasUpdate: hasUpdate, current: cur, latest: latest, url: page,
        notes: String(j.body || ''), asset: pickAsset(j.assets)
      };
    }).catch(function (e) {
      busy = false;
      Toast.err('检查更新失败：' + ((e && e.message) || e) + '（离线或后端流量被拦截都可能）', 8000);
      return { ok: false, reason: 'exception' };
    });
  }

  function showUpdate(cur, latest, release, page) {
    var notes = String(release.body || '').trim();
    var asset = pickAsset(release.assets);
    var hint = el('p', { class: 'field-hint', text:
      '点「立即更新」会自动下载、替换到当前目录并重启，不用手动解压。'
      + '替换只覆盖程序文件，vrclib-data、本地素材库与 runtime 里的数据都不动。' });

    var body = el('div', { class: 'pack-body' }, [
      el('div', { class: 'pack-summary' }, [
        el('b', { text: '发现新版本 ' + latest }),
        el('span', { class: 'pack-dim', text: ' · 当前 ' + cur + (release.published_at ? ' · 发布于 ' + String(release.published_at).slice(0, 10) : '') })
      ]),
      notes
        ? el('div', { class: 'pack-sec' }, [
            el('div', { class: 'pack-label', text: '更新说明' }),
            el('pre', { class: 'upd-notes', text: notes.slice(0, 4000) })
          ])
        : null,
      hint
    ]);

    var dlBtn = el('button', { class: 'btn btn-primary', onclick: function () { openUrl(page); } }, '前往下载');
    var handle = Modal.open({
      title: '发现新版本',
      size: 'md',
      body: [body],
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(handle); } }, '稍后'),
        el('button', { class: 'btn', onclick: function () { openUrl(repoUrl(source().owner, source().repo)); } }, '打开仓库'),
        dlBtn
      ]
    });

    /* 能不能自己替换，由桌面壳回答：开发模式、非便携目录、目录不可写都要说清楚，
     * 而不是给一个点了会失败的按钮。 */
    if (!asset) {
      hint.textContent = '这个版本没有提供 win-x64 便携包（zip），只能到发布页手动下载安装。';
      return;
    }
    if (!(window.vrcElectron && window.vrcElectron.shell) || !FS.host || !FS.host.update) return;
    FS.host.update('info').then(function (inf) {
      if (!inf || !inf.supports) {
        hint.textContent = '当前是开发模式或非便携目录，没法自动替换：请到发布页下载 zip 手动覆盖。';
        return;
      }
      if (!inf.writable) {
        hint.textContent = '程序目录不可写（可能放在 Program Files），无法自动替换：'
          + '把整个程序文件夹移到桌面或 D 盘后再更新，或用管理员身份运行。';
        return;
      }
      dlBtn.className = 'btn';
      var go = el('button', { class: 'btn btn-primary', onclick: function () {
        Modal.close(handle);
        applyUpdate(asset, latest);
      } }, '立即更新并重启');
      handle.foot.insertBefore(go, handle.foot.firstChild);
    }).catch(function () {});
  }

  /** 下载 → 解压 → 交给主进程替换 → 自动重启。进度全程可见，可取消。 */
  function applyUpdate(asset, latest) {
    var textLine = el('div', { class: 'pack-prog-text', text: '准备下载…' });
    var bar = el('i');
    var prog = el('div', { class: 'pack-prog' }, [textLine, el('div', { class: 'pack-prog-bar' }, [bar])]);
    var note = el('p', { class: 'field-hint', text:
      '下载完成后程序会自动退出、替换文件并重新启动。中途取消不会改动任何程序文件。' });
    var cancelBtn = el('button', { class: 'btn', onclick: function () {
      if (cancelBtn.disabled) return;
      cancelBtn.disabled = true;
      cancelBtn.textContent = '正在取消…';
      FS.host.update('cancel').catch(function () {});
    } }, '取消');
    var handle = Modal.open({
      title: '正在更新到 ' + latest,
      size: 'md',
      closable: false,
      closeOnBackdrop: false,
      body: [el('div', { class: 'pack-body' }, [prog, note])],
      footer: [cancelBtn]
    });

    var timer = null, stopped = false;
    function paint(pct, text) {
      bar.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + '%';
      if (text) textLine.textContent = text;
    }
    function stop() { stopped = true; if (timer) { clearInterval(timer); timer = null; } }

    timer = setInterval(function () {
      if (stopped) return;
      FS.host.update('progress').then(function (st) {
        if (stopped || !st) return;
        if (st.phase === 'cancelled') {
          stop();
          Modal.close(handle);
          Toast.warn('已取消更新，程序文件没有改动', 5000);
          return;
        }
        if (st.phase === 'failed') {
          stop();
          Modal.close(handle);
          Toast.err('更新失败：' + (st.error || '未知原因'), 9000);
          return;
        }
        if (st.phase === 'staging') { paint(100, '替换中，程序即将自动重启…'); return; }
        paint(st.pct, st.text || '处理中…');
      }).catch(function () {});
    }, 400);

    FS.host.update('apply', {
      url: asset.url, size: asset.size, sha256: asset.sha256, version: latest, name: asset.name
    }).then(function () {
      stop();
      paint(100, '替换中，程序即将自动重启…');
      cancelBtn.style.display = 'none';
    }).catch(function (e) {
      if (stopped) return;      // 轮询已经先看到 failed 并提示过，不要再弹一次
      stop();
      Modal.close(handle);
      Toast.err('更新失败：' + ((e && e.message) || e), 9000);
    });
  }

  /** 设置页用：把当前更新源显示出来（固定值，只读） */
  function describe() {
    var s = source();
    return s.owner + '/' + s.repo;
  }

  return {
    check: check,
    compareVer: compareVer,
    parseVer: parseVer,
    currentVersion: currentVersion,
    source: source,
    describe: describe,
    openUrl: openUrl,
    repoUrl: repoUrl,
    /* 给自测用：挑包的规则单独暴露，才能不起真的更新就验证「多平台 zip 里挑对 win-x64」 */
    pickAsset: pickAsset
  };
})();
