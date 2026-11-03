/* 预加载：只暴露三个只读能力。
 * 1) shell 标识 —— 页面用它判断「现在跑在原生桌面壳里」，影响文案与按钮；
 *    但它**不改变**任何数据通道：文件/联网仍走主进程的 HTTP 宿主，契约与原 VRCLibHost 一致。
 * 2) getPathForFile —— 拖拽进来的文件在 Electron 32+ 里已经没有 File.path 了，
 *    必须用 webUtils 把 File 换成磁盘路径（官方推荐写法：只读，不碰文件内容）。
 * 3) token —— v4.3.2 起宿主 /api/* 要求带这个令牌，用来挡住「任意网页调本地端口读写磁盘」。
 *    它只存在 preload 里，页面通过 window.vrcElectron.token 读到一个字符串（拿不到也无法伪造新的）。 */
const { contextBridge, webUtils, shell, ipcRenderer } = require('electron');

function argToken() {
  try {
    const hit = process.argv.find(a => a.startsWith('--vrclib-token='));
    return hit ? hit.slice('--vrclib-token='.length) : '';
  } catch (e) { return ''; }
}

contextBridge.exposeInMainWorld('vrcElectron', {
  shell: 'electron',
  version: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  token: argToken(),
  getPathForFile: function (file) {
    try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; }
  },
  /* v4.3.2：用系统浏览器打开外部链接（检查更新时跳 GitHub 发布页）。
   * 只放行 http/https —— 不能让页面借这个口子执行本地程序或 file:// 协议。 */
  openExternal: function (url) {
    try {
      const u = String(url || '');
      if (!/^https?:\/\//i.test(u)) return false;
      shell.openExternal(u);
      return true;
    } catch (e) { return false; }
  },
  /* v4.4：窗口用的是「隐藏系统标题栏 + 系统窗口按钮覆盖层」（titleBarOverlay），
   * 覆盖层颜色由主进程设置，页面切主题时把底色/符号色报过去即可。
   * 只传颜色字符串，不涉及任何文件或执行能力。 */
  setTitleBar: function (opt) {
    try {
      const o = opt || {};
      ipcRenderer.send('titlebar:colors', {
        color: String(o.color || ''),
        symbolColor: String(o.symbolColor || '')
      });
      return true;
    } catch (e) { return false; }
  }
});
