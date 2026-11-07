// 一次性迁移脚本：把单文件 HTML 拆成 Electron 工程的源码结构。
// 用法：node build/split-single.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..', '..');
const SRC_HTML = path.join(APP_ROOT, 'VRChat改模素材管理库.html');
const OUT = path.resolve(__dirname, '..', 'renderer');

const html = fs.readFileSync(SRC_HTML, 'utf8');

const styleStart = html.indexOf('<style>');
const styleEnd = html.indexOf('</style>');
const bodyStart = html.indexOf('<body>');
const bodyEnd = html.indexOf('</body>');
const scriptStart = html.lastIndexOf('<script>');
const scriptEnd = html.indexOf('</script>', scriptStart);

if ([styleStart, styleEnd, bodyStart, bodyEnd, scriptStart, scriptEnd].some(i => i < 0)) {
  throw new Error('页面结构标记未找到，无法拆分');
}

const css = html.slice(styleStart + '<style>'.length, styleEnd).replace(/^\r?\n/, '');
// 主脚本块内嵌在 <body> 里，body 只能取到 <script> 之前，否则入口页会把全量脚本再包一遍
const body = html.slice(bodyStart + '<body>'.length, scriptStart);
const js = html.slice(scriptStart + '<script>'.length, scriptEnd);

// 头部原样保留（title / favicon / meta），只把 <style> 换成外链
const headOpen = html.slice(0, styleStart);
const headRest = html.slice(styleEnd + '</style>'.length, html.indexOf('</head>'));
const head = (headOpen + headRest).trimEnd();

fs.mkdirSync(path.join(OUT, 'js'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'styles.css'), css.trimStart(), 'utf8');

const MARKER = /^\/\* =+ (\S+\.js) =+ \*\/$/;
const lines = js.split('\n');
const modules = [];
let cur = null;
for (const line of lines) {
  const m = line.match(MARKER);
  if (m) {
    if (cur && cur.name === m[1]) { cur.lines.push(line); continue; }
    cur = { name: m[1], lines: [line] };
    modules.push(cur);
  } else {
    if (!cur) { cur = { name: '00-brand.js', lines: [] }; modules.push(cur); }
    cur.lines.push(line);
  }
}

const written = [];
for (const mod of modules) {
  const file = path.join(OUT, 'js', mod.name);
  fs.writeFileSync(file, mod.lines.join('\n'), 'utf8');
  written.push({ name: mod.name, lines: mod.lines.length, bytes: Buffer.byteLength(mod.lines.join('\n')) });
}

const scriptTags = written
  .map(w => `  <script src="electron/renderer/js/${w.name}"></script>`)
  .join('\n');

const indexHtml = `${head}
<link rel="stylesheet" href="electron/renderer/styles.css">
</head>
<body>${body}</body>
${scriptTags}
</html>
`;
fs.writeFileSync(path.join(APP_ROOT, 'VRChat改模素材管理库.html'), indexHtml, 'utf8');
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(written, null, 2), 'utf8');

// 回验：把拆分结果拼回去，应与原脚本逐字节一致
const rebuilt = modules.map(m => m.lines.join('\n')).join('\n');
console.log('原 JS 字节:', Buffer.byteLength(js), '→ 拼接:', Buffer.byteLength(rebuilt), rebuilt === js ? '✔ 一致' : '✘ 不一致');
console.log('CSS 字节:', Buffer.byteLength(css));
console.log('模块数:', written.length);
for (const w of written) console.log('  ' + w.name.padEnd(16), String(w.lines).padStart(5) + ' 行', String(w.bytes).padStart(7) + ' B');
