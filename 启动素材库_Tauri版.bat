@echo off
setlocal
pushd "%~dp0"

rem Tauri 版的日常入口：直接跑同目录的 VRChat改模素材管理库.exe
rem 数据目录固定为 <本目录>\vrclib-data，与旧版一致，不会丢库。

if exist "VRChat改模素材管理库.exe" goto checks
if exist "dist\VRChat改模素材管理库.exe" goto rundist

echo [提示] 还没构建程序。先在 src-tauri 目录执行：
echo     powershell -ExecutionPolicy Bypass -File build\build-tauri.ps1
pause
popd
exit /b 1

:checks
if not exist "WebView2Loader.dll" goto nodll
goto run

:nodll
echo [提示] 缺少 WebView2Loader.dll，程序会启动即退出。
echo        请重新执行 src-tauri\build\build-tauri.ps1 生成。
pause
popd
exit /b 1

:rundist
set "VRCLIB_ROOT=%~dp0"
start "" "dist\VRChat改模素材管理库.exe"
popd
endlocal
exit /b 0

:run
start "" "VRChat改模素材管理库.exe"
popd
endlocal
