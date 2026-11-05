# 编译检查 Unity 助手（不启动 Unity，只做类型检查）
#
# 用本机已安装的 Unity 编辑器程序集 + .NET 6 参考集，通过 Roslyn 把
# assets/unity/*.cs 编成一个临时 dll。只验证语法/类型/API 名称，
# 不验证运行期行为。
#
# 用法：
#   pwsh -File scripts\check-unity-helpers.ps1
#   pwsh -File scripts\check-unity-helpers.ps1 -UnityEditor "G:\Unity\UnityEdit\2022.3.21f1c1\Editor\Unity.exe"
#
# 退出码：0 = 编译通过（允许 CS0649 之类「字段未赋值」警告），非 0 = 有错误。

param(
  [string]$UnityEditor = '',
  [string]$DotnetSdk = 'C:\Program Files\dotnet'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Find-UnityEditor {
  param([string]$Hint)
  if ($Hint -and (Test-Path $Hint)) { return (Resolve-Path $Hint).Path }
  $candidates = @()
  $hubConfig = Join-Path $env:APPDATA 'UnityHub\editors-v2.json'
  if (Test-Path $hubConfig) {
    try {
      $data = (Get-Content $hubConfig -Raw | ConvertFrom-Json).data
      foreach ($item in $data) {
        foreach ($loc in $item.location) {
          $candidates += (Join-Path $loc 'Editor\Unity.exe')
        }
      }
    } catch { }
  }
  foreach ($drive in @('C:', 'D:', 'E:', 'F:', 'G:')) {
    $candidates += "$drive\Unity\UnityEdit\*\Editor\Unity.exe"
  }
  foreach ($pattern in $candidates) {
    $hit = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return ''
}

$editor = Find-UnityEditor $UnityEditor
if (-not $editor) {
  Write-Error '没有找到 Unity 编辑器。请用 -UnityEditor 指到 ...\Editor\Unity.exe'
}
$data = Join-Path (Split-Path -Parent $editor) 'Data'

$csc = Join-Path $DotnetSdk 'sdk\6.0.407\Roslyn\bincore\csc.dll'
if (-not (Test-Path $csc)) {
  $sdk = Get-ChildItem (Join-Path $DotnetSdk 'sdk') -Directory |
    Sort-Object Name -Descending | Select-Object -First 1
  if (-not $sdk) { Write-Error "没有找到 dotnet SDK（$DotnetSdk\sdk）" }
  $csc = Join-Path $sdk.FullName 'Roslyn\bincore\csc.dll'
}

$refPack = Get-ChildItem (Join-Path $DotnetSdk 'packs\Microsoft.NETCore.App.Ref') -Directory |
  Sort-Object Name -Descending | Select-Object -First 1
if (-not $refPack) { Write-Error '没有找到 Microsoft.NETCore.App.Ref 参考集' }
$refDir = Join-Path $refPack.FullName 'ref\net6.0'

$out = Join-Path $env:TEMP ('vrclib-unity-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $out | Out-Null

$refs = @()
$refs += (Get-ChildItem $refDir -Filter *.dll | ForEach-Object { $_.FullName })
$refs += (Join-Path $data 'Managed\UnityEditor.dll')
$refs += (Join-Path $data 'Managed\UnityEngine.dll')
$refs += (Get-ChildItem (Join-Path $data 'Managed\UnityEngine') -Filter *.dll | ForEach-Object { $_.FullName })

$sources = Get-ChildItem (Join-Path $root 'assets\unity') -Filter *.cs | ForEach-Object { $_.FullName }
if (-not $sources) { Write-Error 'assets\unity 下没有 .cs' }

$args = @($csc, '-nologo', '-nostdlib+', '-target:library', '-langversion:9',
  "-out:$out\helpers.dll", '-warn:4')
$args += ($refs | ForEach-Object { "-r:$_" })
$args += $sources

$log = & dotnet @args 2>&1
$code = $LASTEXITCODE
$errors = @($log | Where-Object { $_ -match ': error ' })
$warnings = @($log | Where-Object { $_ -match ': warning ' })

Write-Output "Unity:  $editor"
Write-Output "源码:   $($sources.Count) 个文件"
if ($warnings.Count) {
  Write-Output "警告 $($warnings.Count) 条（CS0649 属正常：JsonUtility 反射赋值）"
  $warnings | Select-Object -First 10 | ForEach-Object { Write-Output "  $_" }
}
if ($errors.Count) {
  Write-Output "错误 $($errors.Count) 条："
  $errors | ForEach-Object { Write-Output "  $_" }
} else {
  Write-Output '编译通过（类型检查）'
}
Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
exit $code
