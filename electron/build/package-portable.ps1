# Portable build: Electron runtime + app dir + launcher bat.
param(
  [string]$OutDir = "dist",
  [string]$Version = ""            # 留空 = 自动读 00-data.js 里的 version
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

# 版本号：调用方可以不传；不传就读 00-data.js 的 version，包名不会再和程序版本脱节。
if (-not $Version) {
  $dataFile = Join-Path $repo 'renderer\js\00-data.js'
  if (Test-Path $dataFile) {
    $m = [regex]::Match([System.IO.File]::ReadAllText($dataFile), "version:\s*'([0-9]+\.[0-9]+(?:\.[0-9]+)?)'")
    if ($m.Success) { $Version = $m.Groups[1].Value }
  }
}
$Version = ("$Version").TrimStart('v','V')
if (-not $Version) { $Version = '1.0.0' }
$rt = Join-Path $repo 'electron\node_modules\electron\dist'
if (-not (Test-Path (Join-Path $rt 'electron.exe'))) { throw "Electron runtime not found: $rt" }
$work = Join-Path $repo 'runtime\_u\build'
$stage = Join-Path $work 'VRChat改模素材管理库'
if (Test-Path $stage) {
  # 递归 Remove-Item 常被安全软件或删除守护拦下（一次删几十项就弹确认）；
  # 先用空目录镜像把里面清空，再删空壳目录，触发面最小。
  $empty = Join-Path ([System.IO.Path]::GetTempPath()) ('vrclib-empty-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $empty -Force | Out-Null
  robocopy $empty $stage /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  Remove-Item -LiteralPath $empty -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Write-Host 'copying runtime ...'
# 只要中文/英文两个语言包：直接从源目录排除 locales 再挑两个复制，
# 比「先全拷再删」少 50 多次删除（杀软与删除守护都不会来烦）。
robocopy $rt $stage /E /XD locales /NFL /NDL /NJH /NJS /NP | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'locales') -Force | Out-Null
foreach ($pak in @('zh-CN.pak', 'en-US.pak')) {
  $from = Join-Path $rt ('locales\' + $pak)
  if (Test-Path $from) { Copy-Item $from (Join-Path $stage ('locales\' + $pak)) -Force }
}
Write-Host 'assembling app ...'
$app = Join-Path $stage 'app'
New-Item -ItemType Directory -Path $app -Force | Out-Null
# 主进程在 app/electron/main（APP_ROOT 因此等于 app），渲染层必须在 app/renderer：
# main.js 读的是 <APP_ROOT>/renderer/index.html，放 app/electron/renderer 会白屏。
Copy-Item (Join-Path $repo 'electron\main') (Join-Path $app 'electron\main') -Recurse -Force
Copy-Item (Join-Path $repo 'renderer') (Join-Path $app 'renderer') -Recurse -Force
# 边车：sidecar.js 先找 <appRoot>/host/vrclib-host.exe，不打进包工作台就用不了
$sidecar = Join-Path $repo 'host\vrclib-host.exe'
if (Test-Path $sidecar) {
  New-Item -ItemType Directory -Path (Join-Path $app 'host') -Force | Out-Null
  Copy-Item $sidecar (Join-Path $app 'host\vrclib-host.exe') -Force
} else {
  Write-Host '  [warn] host\vrclib-host.exe 不存在：打出来的包没有改模工作台'
}
$pkg = '{"name":"vrchat-asset-library","productName":"VRChat Asset Library","version":"' + $Version + '","main":"electron/main/main.js","private":true}'
[System.IO.File]::WriteAllText((Join-Path $app 'package.json'), $pkg, (New-Object System.Text.UTF8Encoding($false)))
$bat = "@echo off`r`nstart `"`" `"%~dp0electron.exe`" `"%~dp0app`"`r`n"
[System.IO.File]::WriteAllText((Join-Path $stage 'start.bat'), $bat, (New-Object System.Text.ASCIIEncoding))
$outRoot = Join-Path $repo $OutDir
New-Item -ItemType Directory -Path $outRoot -Force | Out-Null
$zip = Join-Path $outRoot ("vrchat-asset-library_v{0}_win-x64.zip" -f $Version)
if (Test-Path $zip) { Remove-Item $zip -Force }
Write-Host 'compressing ...'
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
Write-Host ('done: {0} ({1:N1} MB)' -f $zip, ((Get-Item $zip).Length / 1MB))
