@echo off
setlocal
pushd "%~dp0electron"
if errorlevel 1 (
  echo [错误] 找不到 electron 目录。
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [错误] 未找到 Electron 运行时。
  echo 请先在本目录执行：npm install
  pause
  popd
  exit /b 1
)

rem 本机环境可能带着 ELECTRON_RUN_AS_NODE=1，不清掉会导致 Electron 以纯 Node 模式启动、窗口不出现。
set "ELECTRON_RUN_AS_NODE="

start "" "node_modules\electron\dist\electron.exe" "."
popd
endlocal
