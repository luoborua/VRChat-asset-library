# Tauri 版构建脚本（无需管理员权限）
#
# 说明：本机没有 MSVC C++ 工具集，因此走 MinGW-w64（GNU 工具链）。
# 两个必须的绕行：
#   1) 工具链用 stable-x86_64-pc-windows-gnu（宿主也是 GNU，否则构建脚本找不到链接器）
#   2) 产物目录必须是纯 ASCII（中文路径会让 dlltool 打不开 .def 文件）
param(
  [string]$Configuration = "release"
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcTauri = Split-Path -Parent $here
$repo = Split-Path -Parent $srcTauri

$cargo = Join-Path $env:USERPROFILE ".cargo\bin"
$mingw = Join-Path $env:USERPROFILE "mingw64\bin"
$env:PATH = "$cargo;$mingw;$env:PATH"

$env:CARGO_TARGET_DIR = "C:\vrclib-build"

Write-Host "==> 正在编译（$Configuration）… 首次约 5-10 分钟" -ForegroundColor Cyan
Push-Location $srcTauri
try {
  if ($Configuration -eq "release") {
    cargo build --release
  } else {
    cargo build
  }
} finally {
  Pop-Location
}

$exe = Join-Path $env:CARGO_TARGET_DIR "$Configuration\vrclib.exe"
if (-not (Test-Path $exe)) {
  Write-Host "[失败] 没有找到产物：$exe" -ForegroundColor Red
  exit 1
}

$dest = Join-Path $repo "VRChat改模素材管理库.exe"
Copy-Item $exe $dest -Force
$size = [math]::Round((Get-Item $dest).Length / 1MB, 1)
Write-Host "[完成] $dest（$size MB）" -ForegroundColor Green

# WebView2Loader.dll 必须和 exe 放在一起，否则启动即 0xC0000135（缺 DLL）
$dll = Join-Path $env:CARGO_TARGET_DIR "$Configuration\WebView2Loader.dll"
if (Test-Path $dll) {
  Copy-Item $dll (Join-Path $repo "WebView2Loader.dll") -Force
  Write-Host "[完成] WebView2Loader.dll 已同步到根目录" -ForegroundColor Green
} else {
  Write-Host "[警告] 未找到 WebView2Loader.dll，程序会启动失败" -ForegroundColor Yellow
}

Write-Host "双击根目录的 启动素材库_Tauri版.bat 即可运行。"
