/* 下载：/api/download（等下载完成才返回）与 /api/downloadProgress（进度轮询）
 * 行为对齐 VRCLibHost：同路径互斥、覆盖重下走 .part 临时文件、断点续传、失败重试。 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { mkdirp } = require('./api-fs.js');

const jobs = new Map();     // jobId -> 进度快照
const active = new Map();   // 目标路径 -> jobId
const ctls = new Map();     // jobId -> AbortController（v4.3.2：支持取消）
const RETRIES = 2;

function jobInit(jobId, dst, total) {
  jobs.set(jobId, {
    jobId, path: dst, received: 0, total, speed: 0, attempt: 0,
    segments: 1, done: false, error: '', startedAt: Date.now(), _sampleAt: Date.now(), _sampleBytes: 0
  });
  return jobs.get(jobId);
}

function tick(job, received, total) {
  job.received = received;
  if (total) job.total = total;
  const now = Date.now();
  const dt = (now - job._sampleAt) / 1000;
  if (dt >= 0.4) {
    job.speed = Math.max(0, Math.round((received - job._sampleBytes) / dt));
    job._sampleAt = now;
    job._sampleBytes = received;
  }
}

function apiDownloadProgress({ jobId }) {
  const job = jobs.get(jobId);
  if (!job) return { ok: true, job: { jobId, received: 0, total: 0, speed: 0, done: false, error: '' } };
  return { ok: true, ...job, job };
}

/** 下载一个文件到指定绝对路径；返回 {ok,size,path} */
async function apiDownload(payload = {}) {
  const url = String(payload.url || '');
  const dst = String(payload.path || '');
  const headers = payload.headers || {};
  const jobId = String(payload.jobId || ('dl_' + Date.now().toString(36)));
  const overwrite = !!payload.overwrite;

  if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https URL');
  if (!dst) throw new Error('缺少 path');

  const key = dst.toLowerCase();
  if (active.has(key)) throw new Error('同一文件正在下载中，已忽略重复请求：' + dst);

  const st = await fsp.stat(dst).catch(() => null);
  if (st && st.isFile() && !overwrite) return { ok: true, exists: true, size: st.size, path: dst, jobId };

  active.set(key, jobId);
  const job = jobInit(jobId, dst, 0);
  /* v4.3.2：每个任务一个可取消句柄。页面上点「移除」时真正把上游断掉，
   * 否则宿主还在替一个用户已经不要了的文件下载，且一直占着「同一路径」的互斥表，
   * 紧接着重新下载会直接报「同一文件正在下载中」。 */
  const ctrl = new AbortController();
  ctls.set(jobId, ctrl);
  try {
    await mkdirp(path.dirname(dst));
    const part = dst + '.part';
    if (overwrite) await fsp.rm(part, { force: true });

    let lastErr = null;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      job.attempt = attempt;
      try {
        const size = await once_(url, part, headers, job, ctrl.signal);
        await fsp.rm(dst, { force: true }).catch(() => {});
        await fsp.rename(part, dst);
        job.done = true; job.exists = true; job.size = size; job.received = size; job.speed = 0;
        return { ok: true, size, path: dst, jobId };
      } catch (e) {
        lastErr = e;
        /* 用户主动取消不要重试，也不要当成失败 */
        if (ctrl.signal.aborted) {
          job.error = '已取消';
          throw new Error('已取消');
        }
        if (attempt < RETRIES) await new Promise(r => setTimeout(r, 800 * attempt));
      }
    }
    job.error = String((lastErr && lastErr.message) || lastErr);
    throw lastErr;
  } finally {
    active.delete(key);
    ctls.delete(jobId);
  }
}

/** v4.3.2：取消一个下载任务（页面点「移除」时调用） */
function apiDownloadCancel(payload = {}) {
  const jobId = String(payload.jobId || '');
  const ctrl = ctls.get(jobId);
  if (!ctrl) return { ok: true, cancelled: false, reason: '任务已结束或不存在' };
  try { ctrl.abort(new Error('用户取消')); } catch (e) {}
  const job = jobs.get(jobId);
  if (job) { job.error = '已取消'; job.done = true; }
  return { ok: true, cancelled: true };
}

/** 单次尝试（支持从 .part 续传）；返回最终字节数 */
async function once_(url, part, headers, job, signal) {
  let start = 0;
  const st = await fsp.stat(part).catch(() => null);
  if (st && st.isFile()) start = st.size;

  const reqHeaders = { ...headers };
  if (start > 0) reqHeaders['Range'] = 'bytes=' + start + '-';

  const res = await fetch(url, { headers: reqHeaders, redirect: 'follow', signal });
  if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);

  const len = Number(res.headers.get('content-length') || 0);
  const resumed = res.status === 206;
  if (start > 0 && !resumed) start = 0;          // 服务器不支持续传 → 从头写
  job.total = (resumed && len ? start + len : len) || 0;
  job.received = start;
  job._sampleBytes = start;
  job._sampleAt = Date.now();

  const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
  let received = start;
  try {
    if (!res.body) throw new Error('响应无内容');
    const stream = Readable.fromWeb(res.body);
    for await (const chunk of stream) {
      received += chunk.length;
      tick(job, received, job.total);
      if (!out.write(chunk)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
    return received;
  } catch (e) {
    out.destroy();
    throw e;
  }
}

module.exports = { apiDownload, apiDownloadProgress, apiDownloadCancel };
