/* ============ 84-update.js ============ */
/* =====================================================================
 * 84-update.js  —  手动检查程序新版本
 *
 * 为什么是「手动」而不是自动：
 *   这个程序的数据全在本机，联网只发生在你明确点按钮的时候。开机自动检查会让
 *   「完全离线也能用」这条承诺打折扣，而且用户看不到它在后台发了什么请求。
 *
 * 取数口径：GitHub Releases 的 latest 接口（公开仓库免认证，每小时 60 次/IP，
 *   手动点一次完全够）。版本号比较的是 tag_name，所以发版时 tag 必须写成
 *   v4.3.3 这种形式（前后缀 v 会自动去掉）。
 *
 * v6.7：更新源直接绑死在本项目仓库上（原先要在设置里填 owner/repo，
 *   填错只会白查一次 404，用户也根本不知道该填什么）。换仓库就改下面两个常量。
 * ===================================================================== */

var Updater = (function () {
  /* 唯一的更新源。换仓库改这两行即可（改完记得同步 README / 文档里的地址）。 */
  var REPO_OWNER = 'luoborua';
  var REPO_NAME = 'VRChat-asset-library';

  function source() {
    return { owner: REPO_OWNER, repo: REPO_NAME, configured: true };
  }

  /** "v1.0.0" / "1.0.0" / "1.0" → [1,0,0]；解析不出来返回 null */
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
   * 检查更新。
   * opts.quiet = true 时不弹「已是最新」的提示（用于启动后的一次静默探路，目前没用到）。
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
      return { ok: true, hasUpdate: hasUpdate, current: cur, latest: latest, url: page, notes: String(j.body || '') };
    }).catch(function (e) {
      busy = false;
      Toast.err('检查更新失败：' + ((e && e.message) || e) + '（离线或后端流量被拦截都可能）', 8000);
      return { ok: false, reason: 'exception' };
    });
  }

  function showUpdate(cur, latest, release, page) {
    var notes = String(release.body || '').trim();
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
      el('p', { class: 'field-hint', text:
        '本程序不内置自动替换：点下面的按钮会打开 GitHub 的发布页，下载新版压缩包，'
        + '解压覆盖到当前目录即可（vrclib-data 会被保留，素材库不受影响）。' })
    ]);

    var handle = Modal.open({
      title: '发现新版本',
      size: 'md',
      body: [body],
      footer: [
        el('button', { class: 'btn', onclick: function () { Modal.close(handle); } }, '稍后'),
        el('button', { class: 'btn', onclick: function () { openUrl(repoUrl(source().owner, source().repo)); } }, '打开仓库'),
        el('button', { class: 'btn btn-primary', onclick: function () { openUrl(page); } }, '前往下载')
      ]
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
    repoUrl: repoUrl
  };
})();
