/* 原生对话框：/api/pickDir 与 /api/pickFiles（返回真实绝对路径，这是 Electron 版相对浏览器版的核心优势） */
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
