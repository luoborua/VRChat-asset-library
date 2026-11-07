/* 原生文件对话框：选目录、选多个文件、另存为、选单个文件。
 * 与谁交互：bridge 的路由带窗口句柄调进来，返回真实绝对路径给渲染层。
 * 边界：只负责弹窗与取路径，不校验、不创建，也不读文件内容。
 */
const { dialog } = require('electron');

async function pickDir(win, payload = {}) {
  const r = await dialog.showOpenDialog(win, {
    title: payload.title || '选择素材库目录',
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, cancelled: true };
  return { ok: true, path: r.filePaths[0] };
}

async function pickFiles(win, payload = {}) {
  const r = await dialog.showOpenDialog(win, {
    title: payload.title || '选择素材文件',
    properties: ['openFile', 'multiSelections'],
    filters: payload.filters || [{ name: '全部文件', extensions: ['*'] }]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, cancelled: true };
  return { ok: true, paths: r.filePaths };
}

/** 另存为：给「导出素材包」用，直接返回用户选定的完整路径 */
async function saveFile(win, payload = {}) {
  const r = await dialog.showSaveDialog(win, {
    title: payload.title || '保存文件',
    defaultPath: payload.defaultPath || undefined,
    filters: payload.filters || [{ name: '全部文件', extensions: ['*'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
  return { ok: true, path: r.filePath };
}

/** 打开一个文件（同样是原生对话框，供「导入素材包」用） */
async function pickOneFile(win, payload = {}) {
  const r = await dialog.showOpenDialog(win, {
    title: payload.title || '选择文件',
    properties: ['openFile'],
    filters: payload.filters || [{ name: '全部文件', extensions: ['*'] }]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, cancelled: true };
  return { ok: true, path: r.filePaths[0] };
}

module.exports = { pickDir, pickFiles, saveFile, pickOneFile };
