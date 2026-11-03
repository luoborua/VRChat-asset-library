/* 素材包（.vrcpack）的生成、查看与解包。
 *
 * 一个格式两种形态：勾「包含文件本体」就是完整包，不勾就是清单包。
 * 导入端不需要用户区分——有文件就落地，没文件就当成「未下载素材」。
 *
 * 包内结构：
 *   vrcpack.json                  清单（UTF-8）
 *   files/<素材id>/<原始文件名>    文件本体（store，不二次压缩）
 *   covers/<素材id>.<ext>         封面
 *
 * 安全：
 *   · 解包目标路径由**我们自己拼**（素材 id + 清洗过的文件名），不使用 zip 里的路径，
 *     从根上避免 zip-slip；文件名仍会 basename 一遍，防止清单被篡改后带 ../。
 *   · 每个条目解完都校验大小与 CRC32，损坏直接报错，不会留下半截文件冒充完整包。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createZipWriter, listEntries, extractEntry, readEntryBuffer } = require('./zip.js');

const FORMAT = 'vrcpack';
const VERSION = 1;
const MANIFEST = 'vrcpack.json';

/* 进度：导出大包可能几十秒，页面靠轮询它来显示进度条 */
const state = { running: false, phase: '', total: 0, done: 0, bytes: 0, current: '', error: '', startedAt: 0 };
function resetState(phase) {
  state.running = true; state.phase = phase || ''; state.total = 0; state.done = 0;
  state.bytes = 0; state.current = ''; state.error = ''; state.startedAt = Date.now();
}
function endState(error) {
  state.running = false;
  if (error) state.error = String((error && error.message) || error);
}
function getProgress() { return Object.assign({ ok: true }, state); }

/** 文件名清洗：只保留最后一段，去掉非法字符 */
function safeFileName(s, fallback) {
  let v = String(s == null ? '' : s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  v = v.replace(/^\.+/, '');                       // 防 ".." 与隐藏文件
  if (!v) v = fallback || 'file';
  return v;
}
function safeDirName(s, fallback) {
  let v = String(s == null ? '' : s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  v = v.replace(/^\.+/, '');
  if (!v) v = fallback || '素材';
  return v.length > 60 ? v.slice(0, 60) : v;
}

/** 包内相对路径：允许子目录，但逐段清洗、丢掉 . 与 ..（防 zip-slip） */
function safeRelPath(s) {
  const parts = String(s == null ? '' : s).replace(/\\/g, '/').split('/')
    .filter(function (p) { return p && p !== '.' && p !== '..'; });
  if (!parts.length) return 'file.bin';
  return parts.map(function (p) { return safeFileName(p, 'x'); }).join('/');
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

/**
 * payload = {
 *   outPath,                     // 目标 .vrcpack 绝对路径
 *   withFiles: bool,
 *   withCovers: bool,
 *   withNote: bool,              // 备注（常含私下信息，默认 false）
 *   withPrice: bool,             // 购买价格（默认 false）
 *   exporter: { deviceId, nickname },
 *   entries: [{
 *     id, title, originalTitle, category, source, tags, avatars,
 *     itemId, shop, author, isFree, fileSize, note, purchasePrice, purchaseCurrency,
 *     files: [{ name, path }],   // 本机绝对路径
 *     coverPath: ''              // 本机绝对路径（可选）
 *   }]
 * }
 */
async function packCreate(payload) {
  const p = payload || {};
  const outPath = String(p.outPath || '').trim();
  if (!outPath) throw new Error('缺少导出路径');
  if (!/\.vrcpack$/i.test(outPath)) throw new Error('导出文件必须以 .vrcpack 结尾');

  const entries = Array.isArray(p.entries) ? p.entries : [];
  if (!entries.length) throw new Error('没有可导出的素材');

  const withFiles = !!p.withFiles;
  const withCovers = p.withCovers !== false;
  const withNote = !!p.withNote;
  const withPrice = !!p.withPrice;

  resetState('正在写入素材包');
  state.total = entries.length;

  const zip = createZipWriter(outPath);
  await zip.open();

  const assets = [];
  const usedZipNames = Object.create(null);
  const usedDirs = Object.create(null);

  try {
    for (const e of entries) {
      const id = String(e.id || '').trim() || ('as_' + Math.random().toString(36).slice(2, 10));

      /* 素材目录名 = 标题（重名加序号）。
       * 用 `素材/<标题>/<原始相对路径>` 而不是 `files/<id>/...`，是为了让这个包**本身就是一个能直接用的压缩包**：
       * 对方没有本程序、或只是想看看里面有什么，解压出来就是排好的素材文件夹（PCL 整合包的思路）。
       * 清单里的 dir 字段是解包时的权威目录名，避免两端各自推导出不同结果。 */
      const titleDir = safeDirName(e.title || id, '素材');
      let dirName = titleDir;
      if (usedDirs[dirName.toLowerCase()]) {
        let n = 2;
        while (usedDirs[(titleDir + ' (' + n + ')').toLowerCase()]) n++;
        dirName = titleDir + ' (' + n + ')';
      }
      usedDirs[dirName.toLowerCase()] = 1;
      const dir = '素材/' + dirName;

      const files = [];
      if (withFiles) {
        const list = Array.isArray(e.files) ? e.files : [];
        for (const f of list) {
          const src = String(f.path || '');
          if (!src) continue;
          let st;
          try { st = await fsp.stat(src); } catch (err) { continue; }
          if (!st.isFile()) continue;

          /* rel 保留素材内部的目录结构（解压后的模型常有 textures/、materials/ 子目录），
           * 这样导入时能原样还原，而不是把一树文件摊平到一个文件夹里。 */
          const rel = safeRelPath(f.rel || path.basename(src));
          let zipName = dir + '/' + rel;
          /* v4.3.2：改名后必须同步更新 rel。
           * 以前只改了 zipName，清单里的 rel 还是原名，解包时两个条目的 rel 相同，
           * 后一个直接盖掉前一个 —— 包里有、解出来却没有。 */
          let outRel = rel;
          if (usedZipNames[zipName]) {
            const ext = path.extname(rel);
            const stem = rel.slice(0, rel.length - ext.length);
            let n = 2;
            while (usedZipNames[dir + '/' + stem + '_' + n + ext]) n++;
            outRel = stem + '_' + n + ext;
            zipName = dir + '/' + outRel;
          }
          usedZipNames[zipName] = 1;

          state.current = path.basename(outRel);
          const r = await zip.addFile(zipName, src);
          state.bytes += r.size;
          files.push({ name: path.basename(outRel), rel: outRel, zipPath: zipName, size: r.size, crc: r.crc });
        }
      }

      // 封面：只有真正有独立封面文件时才带（封面在 assets.json 里是 IndexedDB 的 blob，
      // 磁盘上可能有 磁盘封面 文件，渲染层会把路径传进来）
      let cover = '';
      /* 封面优先用 base64（渲染层从 IndexedDB 的 blob 直接读出来），
       * 磁盘路径只作为兼容分支：封面在库里本来就没有稳定的文件路径。 */
      if (withCovers && e.coverBase64) {
        try {
          const buf = Buffer.from(String(e.coverBase64), 'base64');
          if (buf.length && buf.length <= 8 * 1024 * 1024) {
            const rawExt = String(e.coverExt || '').toLowerCase();
            const ext = /^\.(png|jpg|jpeg|webp|gif|bmp)$/.test(rawExt) ? rawExt : '.jpg';
            const zipName = 'covers/' + safeDirName(id, 'cover') + ext;
            await zip.addBuffer(zipName, buf);
            state.bytes += buf.length;
            cover = zipName;
          }
        } catch (err) { /* 封面坏了不影响素材本体 */ }
      }
      if (withCovers && !cover && e.coverPath) {
        try {
          const st = await fsp.stat(String(e.coverPath));
          if (st.isFile()) {
            const ext = (path.extname(String(e.coverPath)) || '.jpg').toLowerCase();
            const zipName = 'covers/' + safeDirName(id, 'cover') + ext;
            const r = await zip.addFile(zipName, String(e.coverPath));
            state.bytes += r.size;
            cover = zipName;
          }
        } catch (err) { /* 没封面就跳过，不影响导出 */ }
      }

      const meta = {
        id: id,
        dir: dirName,                       // 解包时的权威目录名
        title: String(e.title || ''),
        originalTitle: String(e.originalTitle || ''),
        category: String(e.category || 'other'),
        source: String(e.source || 'other'),
        tags: Array.isArray(e.tags) ? e.tags.slice(0, 40) : [],
        avatars: Array.isArray(e.avatars) ? e.avatars.slice(0, 20) : [],
        itemId: String(e.itemId || ''),
        shop: String(e.shop || ''),
        author: String(e.author || ''),
        /* v4.3.2：免费与否是**三态**（true 免费 / false 付费 / null 未记录）。
         * 以前写成布尔，undefined 被压成 false，导入方就把「没记价格」当成「付费」，
         * 价格筛选和丝带跟着错。 */
        isFree: e.isFree === true || e.isFree === 'free' ? true
          : (e.isFree === false || e.isFree === 'paid' ? false : null),
        fileSize: files.reduce(function (s, f) { return s + f.size; }, 0) || (Number(e.fileSize) || 0),
        files: files,
        cover: cover
      };
      if (withNote) meta.note = String(e.note || '');
      if (withPrice) {
        meta.purchasePrice = (typeof e.purchasePrice === 'number') ? e.purchasePrice : null;
        meta.purchaseCurrency = String(e.purchaseCurrency || '');
      }
      assets.push(meta);
      state.done++;
    }

    const manifest = {
      format: FORMAT,
      version: VERSION,
      createdAt: new Date().toISOString(),
      exporter: {
        deviceId: String((p.exporter && p.exporter.deviceId) || ''),
        nickname: String((p.exporter && p.exporter.nickname) || '')
      },
      withFiles: withFiles,
      withCovers: withCovers,
      count: assets.length,
      totalBytes: assets.reduce(function (s, a) { return s + (a.fileSize || 0); }, 0),
      assets: assets
    };

    state.phase = '正在写入清单';
    await zip.addBuffer(MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    const r = await zip.close();
    endState(null);

    const st = await fsp.stat(outPath);
    return {
      ok: true, path: outPath, count: manifest.count, withFiles: withFiles,
      files: assets.reduce(function (s, a) { return s + a.files.length; }, 0),
      totalBytes: manifest.totalBytes, packageBytes: st.size, entries: r.entries
    };
  } catch (e) {
    endState(e);
    await zip.abort();
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 查看（只读清单，不解包）                                             */
/* ------------------------------------------------------------------ */

async function packInspect(payload) {
  const filePath = String((payload && payload.path) || '').trim();
  if (!filePath) throw new Error('缺少素材包路径');
  let st;
  try { st = await fsp.stat(filePath); } catch (e) { throw new Error('找不到这个文件：' + filePath); }
  if (!st.isFile()) throw new Error('不是文件：' + filePath);

  const entries = await listEntries(filePath);
  const mf = entries.filter(function (x) { return x.name === MANIFEST; })[0];
  if (!mf) throw new Error('这不是素材包（缺少 vrcpack.json）—— 别把素材压缩包本身选进来');

  const buf = await readEntryBuffer(filePath, mf, 32 * 1024 * 1024);
  let j;
  try { j = JSON.parse(buf.toString('utf8')); } catch (e) { throw new Error('清单已损坏，无法解析'); }
  if (j.format !== FORMAT) throw new Error('清单格式不对（format=' + String(j.format) + '）');
  if (!Array.isArray(j.assets)) throw new Error('清单里没有素材列表');

  return {
    ok: true,
    path: filePath,
    packageBytes: st.size,
    manifest: {
      format: j.format, version: j.version, createdAt: j.createdAt,
      exporter: j.exporter || {}, withFiles: !!j.withFiles, withCovers: !!j.withCovers,
      count: j.count || j.assets.length, totalBytes: j.totalBytes || 0,
      assets: j.assets
    }
  };
}

/* ------------------------------------------------------------------ */
/* 解包                                                                */
/* ------------------------------------------------------------------ */

/**
 * payload = { path, destRoot, onlyIds: [] }
 * 只解文件本体与封面，清单不落地。返回每条素材解出来的文件绝对路径。
 */
async function packExtract(payload) {
  const filePath = String((payload && payload.path) || '').trim();
  const destRoot = String((payload && payload.destRoot) || '').trim();
  if (!filePath) throw new Error('缺少素材包路径');
  if (!destRoot) throw new Error('缺少解包目标目录');
  if (!path.isAbsolute(destRoot)) throw new Error('解包目标必须是绝对路径');

  const onlyIds = Array.isArray(payload && payload.onlyIds) ? payload.onlyIds : null;
  const only = onlyIds ? new Set(onlyIds.map(String)) : null;

  const entries = await listEntries(filePath);
  const byName = Object.create(null);
  entries.forEach(function (e) { byName[e.name] = e; });

  const mf = byName[MANIFEST];
  if (!mf) throw new Error('这不是素材包（缺少 vrcpack.json）');
  const buf = await readEntryBuffer(filePath, mf, 32 * 1024 * 1024);
  const manifest = JSON.parse(buf.toString('utf8'));
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];

  resetState('正在解包');
  const picked = assets.filter(function (a) { return !only || only.has(String(a.id)); });
  state.total = picked.length;
  await fsp.mkdir(destRoot, { recursive: true });

  const out = [];
  try {
    for (const a of picked) {
      const id = String(a.id || '');
      /* 目录名以清单的 dir 为准；老包没有 dir 字段时退回标题 */
      const dirName = safeDirName(a.dir || a.title || id, '素材');
      const assetDir = path.join(destRoot, dirName);
      const files = [];

      for (const f of (Array.isArray(a.files) ? a.files : [])) {
        const zipPath = String(f.zipPath || '');
        const entry = byName[zipPath];
        if (!entry) continue;                       // 清单里声明了但包里没有 → 跳过，不编造
        const rel = safeRelPath(f.rel || f.name || path.basename(zipPath));
        const outPath = path.join(assetDir, rel.split('/').join(path.sep));
        state.current = path.basename(rel);
        const r = await extractEntry(filePath, entry, outPath);
        state.bytes += r.size;
        files.push({ name: path.basename(rel), rel: rel, outPath: outPath, size: r.size });
      }

      let coverPath = '';
      if (a.cover && byName[String(a.cover)]) {
        const ce = byName[String(a.cover)];
        const ext = path.extname(String(a.cover)) || '.jpg';
        const cp = path.join(assetDir, '_cover' + ext);
        try {
          const r = await extractEntry(filePath, ce, cp);
          if (r.size > 0) coverPath = cp;
        } catch (e) { coverPath = ''; }
      }

      state.done++;
      out.push({ id: id, dir: assetDir, files: files, coverPath: coverPath });
    }
    endState(null);
    return { ok: true, destRoot: destRoot, assets: out, manifest: { exporter: manifest.exporter || {}, createdAt: manifest.createdAt, withFiles: !!manifest.withFiles } };
  } catch (e) {
    endState(e);
    throw e;
  }
}

/** 让「另存为」能给出默认文件名 */
function suggestName(nickname) {
  const d = new Date();
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  return '素材包_' + (nickname ? safeFileName(nickname, '') + '_' : '') + stamp + '.vrcpack';
}

module.exports = { packCreate, packInspect, packExtract, getProgress, suggestName, FORMAT, VERSION };
