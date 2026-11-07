/* 自动更新：下载官方 Release 的便携包，解压，交给外部脚本在主进程退出后覆盖安装目录。
 * 与谁交互：bridge 的 /api/update/*；下载复用 api-download.js（带进度/取消），
 *   解压复用 zip.js（流式，不整包进内存）；覆盖动作由一段 PowerShell 完成 ——
 *   electron.exe 运行时被锁，只有等本进程退出后才能替换它自己。
 * 边界：只支持「便携目录形态」（安装目录下有 electron.exe 与 app/package.json）；
 *   不写注册表、不需要管理员；数据目录（app/vrclib-data、本地素材库、runtime）永不覆盖。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const dl = require('./api-download.js');
const zip = require('./zip.js');

/* 本文件在 <appRoot>/electron/main/host/ 下，退三层才是 app 根。
 * 注意别照抄 main.js 的 '..','..' —— 那边少一层。 */
const APP_ROOT = path.resolve(__dirname, '..', '..', '..');   // <安装目录>/app
const INSTALL_ROOT = path.resolve(APP_ROOT, '..');             // <安装目录>
const UPDATE_ROOT = path.join(INSTALL_ROOT, 'runtime', '_update');
const UPDATE_LOG = path.join(INSTALL_ROOT, 'runtime', 'update.log');

/* 覆盖时一律跳过这些前缀：它们是用户数据，不是程序文件。
 * 官方包里本来就没有，这里再拦一道，防止有人把数据打进去误覆盖。 */
const KEEP_PREFIXES = ['app/vrclib-data/', 'vrclib-data/', '本地素材库/', 'runtime/'];

const MAX_ENTRIES = 8000;                       // 条目数上限，挡住异常包
const MAX_BYTES = 2 * 1024 * 1024 * 1024;       // 解压后 2GB 上限

let state = { phase: 'idle', received: 0, total: 0, pct: 0, text: '', error: '', version: '' };
let jobId = '';
let cancelled = false;

function isPackaged() {
  try { return !!require('electron').app.isPackaged; } catch (e) { return false; }
}

/** 能否在安装目录里写文件（Program Files 之类需要管理员，这里提前讲清楚） */
function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const t = path.join(dir, '.wtest-' + process.pid);
    fs.writeFileSync(t, 'x');
    fs.unlinkSync(t);
    return true;
  } catch (e) { return false; }
}

/** 自我描述：渲染层据此决定「立即更新」按钮给不给。
 *  supports 只看目录结构而不是 app.isPackaged：判断标准是「能不能原地换掉 app/ 与 electron.exe」，
 *  用 electron.exe 指向 app 目录的启动方式同样成立（安装目录里没有 app/ 时自然为 false）。 */
function info() {
  const exe = path.join(INSTALL_ROOT, 'electron.exe');
  const hasApp = fs.existsSync(path.join(APP_ROOT, 'package.json'));
  return {
    ok: true,
    packaged: isPackaged(),
    supports: fs.existsSync(exe) && hasApp,
    installRoot: INSTALL_ROOT,
    appRoot: APP_ROOT,
    exe: process.execPath,
    log: UPDATE_LOG,
    writable: canWrite(UPDATE_ROOT),
    running: state.phase !== 'idle' && state.phase !== 'failed' && state.phase !== 'cancelled'
  };
}

function progress() { return Object.assign({ ok: true }, state); }

function cancel() {
  if (state.phase !== 'downloading') return { ok: true, cancelled: false, reason: '当前不在下载阶段' };
  cancelled = true;
  try { dl.apiDownloadCancel({ jobId: jobId }); } catch (e) {}
  state = Object.assign({}, state, { phase: 'cancelled', text: '已取消更新' });
  return { ok: true, cancelled: true };
}

/** 只接受 GitHub 的发布资产地址：更新源固定，别把它变成任意下载器 */
function assertUpdateUrl(u) {
  let host = '';
  try { host = new URL(u).hostname.toLowerCase(); } catch (e) { throw new Error('更新地址无效'); }
  const okHost = host === 'github.com' || host === 'www.github.com' || /\.githubusercontent\.com$/.test(host);
  if (!okHost) throw new Error('只允许从 GitHub 下载更新包（当前：' + host + '）');
}

function sha256File(file) {
  return new Promise(function (resolve, reject) {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('error', reject);
    rs.on('data', function (c) { h.update(c); });
    rs.on('end', function () { resolve(h.digest('hex')); });
  });
}

/** 解压整包到 dest；返回解出的文件数 */
async function extractAll(zipPath, dest) {
  const entries = await zip.listEntries(zipPath);
  const norm = function (e) { return String(e.name || '').replace(/\\/g, '/'); };
  const files = entries.filter(function (e) { return !/\/$/.test(norm(e)); });
  if (!files.length) throw new Error('更新包里没有文件');
  if (files.length > MAX_ENTRIES) throw new Error('更新包内文件数异常（' + files.length + ' 个），已停止');

  let declared = 0;
  files.forEach(function (e) { declared += e.uncompSize || 0; });
  if (declared > MAX_BYTES) throw new Error('更新包解压后超过 2GB，已停止');

  const rootAbs = path.resolve(dest);
  const skipped = [];
  let done = 0;
  let processed = 0;                 // 含跳过的条目：进度条按它走，跳过的也算「处理完了」
  for (const e of files) {
    const rel = norm(e);
    processed++;
    if (KEEP_PREFIXES.some(function (p) { return rel.toLowerCase().indexOf(p.toLowerCase()) === 0; })) {
      skipped.push(rel);
    } else if (/[^\x20-\x7E]/.test(rel)) {
      /* 只收 ASCII 路径：官方包内全是英文。非 ASCII 要么是有人把中文文件打进了包，
       * 要么是条目编码与解压端不一致（会解成乱码名），两种都不该铺进安装目录。 */
      skipped.push(rel);
    } else {
      const out = path.resolve(rootAbs, rel);
      if (out !== rootAbs && !out.startsWith(rootAbs + path.sep)) {
        throw new Error('更新包条目越界：' + rel);
      }
      await fsp.mkdir(path.dirname(out), { recursive: true });
      await zip.extractEntry(zipPath, e, out);
      done++;
    }
    state.pct = Math.round((processed / files.length) * 100);
    state.text = '正在解压 ' + processed + '/' + files.length;
  }
  if (skipped.length) {
    try {
      fs.appendFileSync(UPDATE_LOG, '跳过用户数据条目：' + skipped.slice(0, 10).join(', ') + '\n');
    } catch (err) {}
  }
  return done;
}

/** 包内可能多套一层目录（有人手工重打包）：找到含水 electron.exe 的那层 */
function findPayloadRoot(dir) {
  const hits = [];
  (function walk(d, depth) {
    if (depth > 2 || hits.length) return;
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    if (list.some(function (x) { return x.isFile() && x.name.toLowerCase() === 'electron.exe'; })) {
      hits.push(d);
      return;
    }
    list.filter(function (x) { return x.isDirectory(); })
      .forEach(function (x) { walk(path.join(d, x.name), depth + 1); });
  })(dir, 0);
  return hits[0] || '';
}

/* 覆盖脚本：等本进程退出 → 备份 app/ → robocopy 覆盖 → 失败回滚 → 重启 → 清理。
 * 参数走环境变量，避免中文路径与引号在命令行里的转义问题。 */
const PS_SCRIPT = [
  "$ErrorActionPreference = 'Continue'",
  "$TargetPid = 0",
  "[void][int]::TryParse($env:VRCLIB_UPD_PID, [ref]$TargetPid)",
  "$Src = $env:VRCLIB_UPD_SRC",
  "$Dst = $env:VRCLIB_UPD_DST",
  "$Exe = $env:VRCLIB_UPD_EXE",
  "$ArgRaw = $env:VRCLIB_UPD_ARGS",
  "$Log = $env:VRCLIB_UPD_LOG",
  "$Stage = $env:VRCLIB_UPD_STAGE",
  "function L([string]$m) {",
  "  try { Add-Content -LiteralPath $Log -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  ' + $m) -Encoding UTF8 } catch {}",
  "}",
  "L ('--- update start pid=' + $TargetPid)",
  "L ('src=' + $Src)",
  "L ('dst=' + $Dst)",
  "$argList = @()",
  "if ($ArgRaw) { $argList = @($ArgRaw -split \"`t\" | Where-Object { $_ -ne '' }) }",
  "if ($argList.Count -eq 0) { $argList = @((Join-Path $Dst 'app')) }",
  "",
  "# 1) 等主进程退出；超过 30 秒还在就强杀 —— 它已经收到退出指令，卡住只会挡住更新",
  "$sw = [Diagnostics.Stopwatch]::StartNew()",
  "while ($sw.Elapsed.TotalSeconds -lt 90) {",
  "  if (-not (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue)) { break }",
  "  if ($sw.Elapsed.TotalSeconds -gt 30) {",
  "    L 'still alive after 30s, killing'",
  "    try { Stop-Process -Id $TargetPid -Force -ErrorAction SilentlyContinue } catch {}",
  "    Start-Sleep -Milliseconds 900",
  "    break",
  "  }",
  "  Start-Sleep -Milliseconds 200",
  "}",
  "",
  "# 2) 等同一个 exe 的所有进程都释放（渲染/GPU 子进程也锁着 electron.exe）",
  "$sw2 = [Diagnostics.Stopwatch]::StartNew()",
  "while ($sw2.Elapsed.TotalSeconds -lt 20) {",
  "  $busy = @()",
  "  try {",
  "    $busy = @(Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" -ErrorAction Stop | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $Exe) })",
  "  } catch { break }",
  "  if ($busy.Count -eq 0) { break }",
  "  Start-Sleep -Milliseconds 250",
  "}",
  "Start-Sleep -Milliseconds 700",
  "",
  "# 3) 先备份旧 app/：覆盖失败要能退回去，不能让程序停在半新半旧",
  "$bak = Join-Path $Stage 'backup-app'",
  "$appDir = Join-Path $Dst 'app'",
  "if (Test-Path -LiteralPath $appDir) {",
  "  robocopy $appDir $bak /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null",
  "  L ('backup app -> ' + $LASTEXITCODE)",
  "}",
  "",
  "# 4) 覆盖。不加 /MIR：数据目录、素材库、runtime 里的用户文件一个都不删",
  "$rc = 16",
  "for ($i = 1; $i -le 10; $i++) {",
  "  robocopy $Src $Dst /E /IS /IT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null",
  "  $rc = $LASTEXITCODE",
  "  L ('robocopy try ' + $i + ' -> ' + $rc)",
  "  if ($rc -lt 8) { break }",
  "  Start-Sleep -Milliseconds 800",
  "}",
  "$ok = ($rc -lt 8)",
  "if (-not $ok) {",
  "  L 'copy failed, rolling back app/'",
  "  robocopy $bak $appDir /E /IS /IT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null",
  "  L ('rollback -> ' + $LASTEXITCODE)",
  "}",
  "",
  "# 5) 用原来的参数重启（--no-sandbox 这类启动开关不能丢）",
  "try {",
  "  Start-Process -FilePath $Exe -ArgumentList $argList -WorkingDirectory $Dst -ErrorAction Stop",
  "  L ('relaunch ok, replaced=' + $ok)",
  "} catch {",
  "  L ('relaunch failed: ' + $_.Exception.Message)",
  "}",
  "",
  "# 6) 清掉下载与解压的临时目录，日志留在 runtime/update.log",
  "Start-Sleep -Seconds 2",
  "try { Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue } catch {}",
  "L '--- done'",
  ""
].join('\r\n');

/** 起一段 PowerShell，等本进程退出后完成覆盖与重启。
 *  opts 只给自测用（换成临时安装目录 / 探针 exe），正常调用不传。 */
function spawnApplier(stage, srcDir, opts) {
  opts = opts || {};
  const ps1 = path.join(stage, 'apply-update.ps1');
  /* 带 BOM 写：PowerShell 5.1 靠 BOM 判断 UTF-8，否则中文注释会变成乱码（脚本仍能跑，但日志难读） */
  fs.writeFileSync(ps1, '\uFEFF' + PS_SCRIPT, 'utf8');
  const env = Object.assign({}, process.env, {
    VRCLIB_UPD_PID: String(opts.pid != null ? opts.pid : process.pid),
    VRCLIB_UPD_SRC: srcDir,
    VRCLIB_UPD_DST: opts.installRoot || INSTALL_ROOT,
    VRCLIB_UPD_EXE: opts.exe || process.execPath,
    VRCLIB_UPD_ARGS: opts.args != null ? opts.args : process.argv.slice(1).join('\t'),
    VRCLIB_UPD_LOG: opts.log || UPDATE_LOG,
    VRCLIB_UPD_STAGE: stage
  });
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden', '-File', ps1
  ], { stdio: 'ignore', windowsHide: true, env: env });
  /* 不能加 detached：Windows 下 detached + stdio:ignore 会让 powershell 直接退出、脚本一行都不跑
   * （实测退出码 0、文件不生成）。不加它子进程照样活到父进程退出之后，脚本第一步就是等父进程走。 */
  child.unref();
  return { ps1: ps1, child: child };
}

/**
 * 下载并准备更新；成功返回后约 1 秒本进程会自己退出，由脚本完成覆盖与重启。
 * payload: { url, size, sha256, version, name }
 */
async function applyInner(payload) {
  payload = payload || {};
  if (state.phase === 'downloading' || state.phase === 'extracting' || state.phase === 'staging') {
    throw new Error('更新已经在进行中');
  }
  const inf = info();
  if (!inf.supports) throw new Error('当前是开发模式或非便携目录，不支持自动替换');
  if (!inf.writable) throw new Error('程序目录不可写：把它移到用户目录（如桌面、D 盘）后再更新，或以管理员身份运行');

  const url = String(payload.url || '').trim();
  if (!url) throw new Error('缺少更新包地址');
  assertUpdateUrl(url);

  cancelled = false;
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const stage = path.join(UPDATE_ROOT, stamp);
  try { await fsp.rm(UPDATE_ROOT, { recursive: true, force: true }); } catch (e) {}
  await fsp.mkdir(stage, { recursive: true });

  const zipPath = path.join(stage, 'update.zip');
  jobId = 'upd_' + stamp + '_' + Math.random().toString(36).slice(2, 7);
  const wantSize = Number(payload.size) || 0;

  state = {
    phase: 'downloading', received: 0, total: wantSize, pct: 0,
    text: '正在下载 ' + (payload.version ? 'v' + payload.version : '更新包'),
    error: '', version: String(payload.version || ''), stage: stage
  };

  const timer = setInterval(function () {
    try {
      const p = dl.apiDownloadProgress({ jobId: jobId });
      const j = (p && p.job) || {};
      if (j.received) state.received = j.received;
      if (j.total) state.total = j.total;
      if (state.total) state.pct = Math.min(99, Math.round((state.received / state.total) * 100));
      state.text = '正在下载 ' + fmtMB(state.received) + ' / ' + fmtMB(state.total || wantSize);
    } catch (e) {}
  }, 400);

  try {
    await dl.apiDownload({
      url: url,
      path: zipPath,
      jobId: jobId,
      overwrite: true,
      headers: { 'User-Agent': 'VRChat-Asset-Library-Updater', 'Accept': 'application/octet-stream' }
    });
  } finally {
    clearInterval(timer);
  }
  if (cancelled) throw new Error('已取消更新');

  const st = await fsp.stat(zipPath);
  if (st.size < 1024 * 64) throw new Error('更新包过小（' + st.size + ' 字节），可能不是有效文件');
  if (wantSize && Math.abs(st.size - wantSize) > 1024) {
    throw new Error('更新包大小不符（应为 ' + wantSize + '，实为 ' + st.size + '），可能下载不完整');
  }
  const wantSha = String(payload.sha256 || '').replace(/^sha256:/i, '').toLowerCase();
  if (wantSha) {
    state.text = '正在校验文件…';
    const got = await sha256File(zipPath);
    if (got !== wantSha) throw new Error('更新包校验失败（SHA-256 不符），已停止替换');
  }

  state.phase = 'extracting';
  state.pct = 0;
  state.text = '正在解压更新包…';
  const filesDir = path.join(stage, 'files');
  await fsp.mkdir(filesDir, { recursive: true });
  await extractAll(zipPath, filesDir);

  const srcDir = findPayloadRoot(filesDir);
  if (!srcDir) throw new Error('更新包里没找到 electron.exe，可能不是这个程序的安装包');
  if (!fs.existsSync(path.join(srcDir, 'app', 'package.json'))) {
    throw new Error('更新包结构不对（缺少 app/package.json），已停止替换');
  }

  state.phase = 'staging';
  state.pct = 100;
  state.text = '准备替换，稍后自动重启…';
  spawnApplier(stage, srcDir);

  /* 给页面一点时间把「正在重启」画出来，再走正常退出链路（will-quit 里收边车、刷字节） */
  setTimeout(function () {
    try { require('electron').app.quit(); } catch (e) {}
  }, 1200);

  return { ok: true, version: state.version, stage: stage, log: UPDATE_LOG };
}

/** 失败必须落到 state 上：页面轮询看到的是「已失败 + 原因」，
 *  而不是永远停在「正在解压 2/3」—— 用户会以为还在跑。 */
async function apply(payload) {
  try {
    return await applyInner(payload);
  } catch (e) {
    const msg = String((e && e.message) || e);
    state = Object.assign({}, state, { phase: 'failed', error: msg, text: '更新失败：' + msg });
    try { fs.appendFileSync(UPDATE_LOG, 'apply failed: ' + msg + '\n'); } catch (err) {}
    /* 失败了就别把上百兆的包和解压产物留在安装目录里；原因已经写进日志 */
    if (state.stage) {
      try { await fsp.rm(state.stage, { recursive: true, force: true }); } catch (err) {}
    }
    throw e;
  }
}

function fmtMB(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
  return v + ' B';
}

module.exports = {
  info, progress, apply, cancel, UPDATE_LOG,
  /* 给自测用：解压/结构探测/覆盖脚本单独暴露，才能在不开 Electron、不联网的情况下验证
   * 「包能解开、数据不被覆盖、失败能回滚」（见 runtime/test-update.js）。 */
  __test: {
    extractAll: extractAll, findPayloadRoot: findPayloadRoot, PS_SCRIPT: PS_SCRIPT,
    KEEP_PREFIXES: KEEP_PREFIXES, spawnApplier: spawnApplier
  }
};
