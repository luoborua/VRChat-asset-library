// 开发用静态服务器：只服务 renderer/，配合 开发模式.bat。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer');
const port = Number(process.env.VRCLIB_DEV_PORT || 8765);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  console.log(req.method + ' ' + rel);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(root, path.normalize(rel).replace(/^[/\\]+/, ''));
  if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found: ' + rel); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}).listen(port, '127.0.0.1', () => console.log('dev server: http://127.0.0.1:' + port + ' -> ' + root));