/* 写路径护栏：渲染层能带着绝对路径调写入 / 删除 / 移动，这里挡住绝不该被程序改写的位置。
 * 与谁交互：api-fs、bridge 的字节写入通道在落盘前调用 assertWritable。
 * 边界：这不是沙箱 —— 用户自己选的目录本来就在任意位置，只拦系统根与 Program Files 一类。
 */
const path = require('node:path');

function norm(p) {
  return path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
}

function protectedRoots() {
  const env = process.env;
  const list = [env.SystemRoot, env.windir, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData];
  list.push(path.join(env.SystemRoot || 'C:\\Windows', 'System32'));
  return list.filter(Boolean).map(norm);
}

function isProtected(p) {
  const t = norm(p);
  if (!t) return false;
  /* 盘符根（C:\）本身也不许写 */
  if (/^[a-z]:$/.test(t)) return true;
  return protectedRoots().some(function (r) {
    return t === r || t.startsWith(r + '\\');
  });
}

function assertWritable(p) {
  if (isProtected(p)) {
    throw new Error('拒绝写入系统目录：' + p);
  }
}

module.exports = { isProtected, assertWritable };
