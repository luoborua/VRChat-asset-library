# Portable build: Electron runtime + app dir + launcher bat.
param(
  [string]$OutDir = "dist",
  [string]$Version = ""            # 留空 = 自动读 00-data.js 里的 version
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

# 版本号：调用方可以不传；不传就读 00-data.js 的 version，包名不会再和程序版本脱节。
if (-not $Version) {
  $dataFile = Join-Path $repo 'electron\renderer\js\00-data.js'
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
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Write-Host 'copying runtime ...'
robocopy $rt $stage /E /NFL /NDL /NJH /NJS /NP | Out-Null
Get-ChildItem (Join-Path $stage 'locales') -File | Where-Object { $_.Name -notin @('zh-CN.pak','en-US.pak') } | Remove-Item -Force
Write-Host 'assembling app ...'
$app = Join-Path $stage 'app'
New-Item -ItemType Directory -Path $app -Force | Out-Null
Copy-Item (Join-Path $repo 'VRChat改模素材管理库.html') $app -Force
Copy-Item (Join-Path $repo 'electron\main') (Join-Path $app 'electron\main') -Recurse -Force
Copy-Item (Join-Path $repo 'electron\renderer') (Join-Path $app 'electron\renderer') -Recurse -Force
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
