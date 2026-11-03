/* WebDAV：/api/webdav/{test,list,put,get,mkcol}
 * 只用标准方法（PROPFIND / PUT / GET / MKCOL）+ Basic 认证，不依赖第三方库。 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { mkdirp } = require('./api-fs.js');

function authHeader({ username, password }) {
  if (!username && !password) return {};
  const raw = String(username || '') + ':' + String(password || '');
  return { Authorization: 'Basic ' + Buffer.from(raw, 'utf8').toString('base64') };
}

function ensureUrl(u) {
  const s = String(u || '').trim();
  if (!/^https?:\/\//i.test(s)) throw new Error('仅支持 http/https 地址');
  return s;
}

function withSlash(u) { return /\/$/.test(u) ? u : u + '/'; }

function decodeName(href) {
  const clean = String(href || '').replace(/\/$/, '');
  const seg = clean.split('/').pop() || '';
  try { return decodeURIComponent(seg); } catch { return seg; }
}

/** 极简 PROPFIND 解析：兼容 d:/D:/无前缀三种命名空间写法 */
function parseMultiStatus(xml) {
  const out = [];
  const blocks = String(xml || '').match(/<(?:[a-z0-9]+:)?response\b[\s\S]*?<\/(?:[a-z0-9]+:)?response>/gi) || [];
  for (const block of blocks) {
    const hrefM = block.match(/<(?:[a-z0-9]+:)?href>([\s\S]*?)<\/(?:[a-z0-9]+:)?href>/i);
    if (!hrefM) continue;
    const isDir = /<(?:[a-z0-9]+:)?collection\b/i.test(block);
    const sizeM = block.match(/<(?:[a-z0-9]+:)?getcontentlength>(\d+)<\//i);
    out.push({
      href: hrefM[1].trim(),
      name: decodeName(hrefM[1]),
      isDir,
      size: sizeM ? Number(sizeM[1]) : 0
    });
  }
  return out;
}

async function propfind(url, depth, cred) {
  const res = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      ...authHeader(cred),
      Depth: String(depth),
      'Content-Type': 'application/xml; charset=utf-8'
    },
    body: depth === 0
      ? '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>'
      : '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
    redirect: 'follow'
  });
  const text = await res.text();
  return { res, text };
}

async function webdavTest(payload = {}) {
  const url = withSlash(ensureUrl(payload.url));
  const { res } = await propfind(url, 0, payload);
  if (res.status === 401 || res.status === 403) throw new Error('认证失败（HTTP ' + res.status + '）');
  if (!res.ok && res.status !== 207) throw new Error('连接失败（HTTP ' + res.status + '）');
  return { ok: true, status: res.status, url };
}

async function webdavList(payload = {}) {
  const url = withSlash(ensureUrl(payload.url));
  const { res, text } = await propfind(url, 1, payload);
  if (res.status === 401 || res.status === 403) throw new Error('认证失败（HTTP ' + res.status + '）');
  if (!res.ok && res.status !== 207) throw new Error('读取目录失败（HTTP ' + res.status + '）');

  const all = parseMultiStatus(text);
  // 第一条通常是目录自身（href 与本级同名），前端不需要它
  const selfName = decodeName(url);
  let entries = all.filter(e => !(e.isDir && e.name === selfName) && e.name);
  // 部分服务器（如坚果云）会多回一条指向父级的 href
  entries = entries.filter(e => e.name !== '..' && e.name !== '.');
  entries.sort((a, b) => (Number(b.isDir) - Number(a.isDir)) || a.name.localeCompare(b.name, 'zh'));
  return { ok: true, entries };
}

async function webdavPut(payload = {}) {
  const url = ensureUrl(payload.url);
  const local = String(payload.localPath || '');
  const st = await fsp.stat(local);
  if (!st.isFile()) throw new Error('本地不是文件：' + local);

  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...authHeader(payload), 'Content-Length': String(st.size) },
    body: Readable.toWeb(fs.createReadStream(local)),
    duplex: 'half'
  });
  if (!res.ok && res.status !== 201 && res.status !== 204) throw new Error('上传失败（HTTP ' + res.status + '）');
  return { ok: true, status: res.status, size: st.size };
}

async function webdavGet(payload = {}) {
  const url = ensureUrl(payload.url);
  const local = String(payload.localPath || '');
  if (!local) throw new Error('缺少 localPath');

  const res = await fetch(url, { method: 'GET', headers: authHeader(payload), redirect: 'follow' });
  if (!res.ok) throw new Error('下载失败（HTTP ' + res.status + '）');

  await mkdirp(path.dirname(local));
  const part = local + '.part';
  const out = fs.createWriteStream(part);
  let size = 0;
  const stream = Readable.fromWeb(res.body);
  for await (const chunk of stream) {
    size += chunk.length;
    if (!out.write(chunk)) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');
  await fsp.rm(local, { force: true }).catch(() => {});
  await fsp.rename(part, local);
  return { ok: true, size, path: local };
}

async function webdavMkcol(payload = {}) {
  const url = withSlash(ensureUrl(payload.url));
  const res = await fetch(url, { method: 'MKCOL', headers: authHeader(payload) });
  // 405 = 已存在，视为成功
  if (!res.ok && res.status !== 201 && res.status !== 405) throw new Error('新建目录失败（HTTP ' + res.status + '）');
  return { ok: true, status: res.status };
}

module.exports = { webdavTest, webdavList, webdavPut, webdavGet, webdavMkcol };
