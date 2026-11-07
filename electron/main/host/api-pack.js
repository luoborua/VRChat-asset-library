/* 素材包（.vrcpack）：生成、查看清单、解包。
 * 包内结构：vrcpack.json 清单 + 素材/<标题>/... 文件本体（store）+ covers/<id>.<ext> 封面。
 * 与谁交互：bridge 的 /api/pack/* 调用；ZIP 读写交给 zip.js，进度靠 getProgress 轮询。
 * 安全：解包路径由这里按素材 id 与清洗过的文件名自己拼，不用 zip 里的路径，从根上避开 zip-slip；
 * 每个条目解完都校验大小与 CRC32，损坏直接报错，不留半截文件冒充完整包。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createZipWriter, listEntries, extractEntry, readEntryBuffer } = require('./zip.js');

const FORMAT = 'vrcpack';
const VERSION = 1;
const MANIFEST = 'vrcpack.json';

/* 进度：导出大包可能几十秒，页面靠轮询它来显示进度条 */
const state = { running: false, phase: '', total: 0, done: 0, bytes: 0, current: '', error: '', startedAt: 0, cancelRequested: false, cancelled: false };

/* 取消：打包与解包都是逐个条目推进的长循环，关不掉只能等，用户会以为程序卡死。
 * 用状态位而不是 AbortSignal —— 循环里只有一个 await 点，检查一句就够，
 * 而且这个模块是单任务的（同一时刻只跑一个包），不需要按任务分发。 */
class CancelledError extends Error {
  constructor() {
    super('已取消');
    this.code = 'CANCELLED';
    this.cancelled = true;
  }
}
function checkCancel() { if (state.cancelRequested) throw new CancelledError(); }

/** 只在真正跑着的时候置位：空闲时点「取消」不该影响下一次操作 */
function requestCancel() {
  if (!state.running) return { ok: true, running: false };
  state.cancelRequested = true;
  return { ok: true, running: true };
}

function resetState(phase) {
  state.running = true; state.phase = phase || ''; state.total = 0; state.done = 0;
  state.bytes = 0; state.current = ''; state.error = ''; state.startedAt = Date.now();
  state.cancelRequested = false; state.cancelled = false;
}
function endState(error) {
  state.running = false;
  if (error) {
    state.error = String((error && error.message) || error);
    if (error.cancelled) state.cancelled = true;
  }
}
function getProgress() { return Object.assign({ ok: true }, state); }

/** 封面这类「坏了也不影响主体」的分支会吞掉异常，
 * 但取消必须一路抛到最外层，否则点取消要等下一个素材才生效。 */
function rethrowIfCancelled(e) { if (e && e.cancelled) throw e; }

/** 文件名清洗：只留最后一段并去掉非法字符，避免拼出路径分隔符与上跳 */
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
 * payload = { outPath, withFiles, withCovers, withNote, withPrice, exporter, entries[] }；
 * entries 每条带 id / 标题 / 分类 / 标签 / files[{name,path}] / coverPath 等导出字段。
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
      checkCancel();
      const id = String(e.id || '').trim() || ('as_' + Math.random().toString(36).slice(2, 10));

      /* 目录名用标题而不是 id：这个包本身就该是一个解压即用的素材文件夹，
       * 对方没有本程序也能看懂。清单里的 dir 是解包时的权威目录名，避免两端各自推导出不同结果。 */
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
          checkCancel();                 // 单个素材带几百个文件时，按素材粒度检查太慢
          const src = String(f.path || '');
          if (!src) continue;
          let st;
          try { st = await fsp.stat(src); } catch (err) { continue; }
          if (!st.isFile()) continue;

          /* rel 保留素材内部的目录结构（解压后的模型常有 textures/、materials/ 子目录），
           * 这样导入时能原样还原，而不是把一树文件摊平到一个文件夹里。 */
          const rel = safeRelPath(f.rel || path.basename(src));
          let zipName = dir + '/' + rel;
          /* 改名后必须同步更新 rel：只改 zipName 会让清单里两条 rel 相同，
           * 解包时后一个盖掉前一个 —— 包里有、解出来却没有。 */
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
          const r = await zip.addFile(zipName, src, checkCancel);
          state.bytes += r.size;
          files.push({ name: path.basename(outRel), rel: outRel, zipPath: zipName, size: r.size, crc: r.crc });
        }
      }

      // 封面：只有真正有独立封面文件时才带（封面在库里是 IndexedDB 的 blob，
      // 磁盘上可能有独立的封面文件，渲染层会把路径传进来）
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
        } catch (err) { rethrowIfCancelled(err); /* 封面坏了不影响素材本体 */ }
      }
      if (withCovers && !cover && e.coverPath) {
        try {
          const st = await fsp.stat(String(e.coverPath));
          if (st.isFile()) {
            const ext = (path.extname(String(e.coverPath)) || '.jpg').toLowerCase();
            const zipName = 'covers/' + safeDirName(id, 'cover') + ext;
            const r = await zip.addFile(zipName, String(e.coverPath), checkCancel);
            state.bytes += r.size;
            cover = zipName;
          }
        } catch (err) { rethrowIfCancelled(err); /* 没封面就跳过，不影响导出 */ }
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
        /* 素材编号：好友导入时先按它认「同一份」，比商品 ID / 标题都稳。
         * 老素材还没有这个字段时退回商品号（纯数字），仍然能对上。
         * 统一大写：编号比较大小写不敏感，导出的产物里也就不该出现小写。 */
        fileId: (String(e.fileId || '').trim() || (/^\d+$/.test(String(e.itemId || '')) ? String(e.itemId) : '')).toUpperCase(),
        shop: String(e.shop || ''),
        author: String(e.author || ''),
        /* isFree 是三态（true 免费 / false 付费 / null 未记录）：压成布尔会把
         * 「没记价格」当成「付费」，价格筛选和丝带跟着错。 */
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
    /* 取消或写到一半失败：删掉半截包——留着的话用户看到的是一个能选中、
     * 但打不开（缺中央目录）的 .vrcpack，比没有文件更糟。
     * 但如果在 open 阶段就失败（路径不可写等），目标文件可能是用户原来那个完好的包，
     * 这时不能删。 */
    if (e.cancelled || state.bytes > 0) {
      try { await fsp.unlink(outPath); } catch (err) { /* 可能压根没创建 */ }
    }
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
      checkCancel();
      const id = String(a.id || '');
      /* 目录名以清单的 dir 为准；清单没写 dir 时退回标题 */
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
        let r;
        try {
          r = await extractEntry(filePath, entry, outPath, checkCancel);
        } catch (err) {
          /* 单个文件写到一半被中断（取消、校验不过）：删掉半截文件。
           * 取消时上层不清理已解出的素材，所以这里必须清干净——
           * 否则目标目录里会躺着一个有文件但打不开的素材。 */
          try { await fsp.rm(outPath, { force: true }); } catch (e2) {}
          throw err;
        }
        state.bytes += r.size;
        files.push({ name: path.basename(rel), rel: rel, outPath: outPath, size: r.size });
      }

      let coverPath = '';
      if (a.cover && byName[String(a.cover)]) {
        const ce = byName[String(a.cover)];
        const ext = path.extname(String(a.cover)) || '.jpg';
        const cp = path.join(assetDir, '_cover' + ext);
        try {
          const r = await extractEntry(filePath, ce, cp, checkCancel);
          if (r.size > 0) coverPath = cp;
        } catch (e) { rethrowIfCancelled(e); coverPath = ''; }
      }

      state.done++;
      out.push({ id: id, dir: assetDir, files: files, coverPath: coverPath });
    }
    endState(null);
    return { ok: true, destRoot: destRoot, assets: out, manifest: { exporter: manifest.exporter || {}, createdAt: manifest.createdAt, withFiles: !!manifest.withFiles } };
  } catch (e) {
    endState(e);
    /* 解包取消不删已解出的文件：目标目录里可能本来就有同名素材，
     * 倒着删容易误伤，交给用户自己决定。把数量带回前端，提示里要说清楚。 */
    if (e.cancelled) throw new Error('已取消（已解出 ' + out.length + ' 个素材，文件留在目标目录）');
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

module.exports = { packCreate, packInspect, packExtract, getProgress, requestCancel, suggestName, FORMAT, VERSION };
