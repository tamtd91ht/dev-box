# Tao shortcut "VHS DevBox" ngoai Desktop + trong Start Menu (tim bang nut Windows).
# Chay 1 lan tren may moi, SAU KHI da `npm install`:
#
#   npm run desktop:install
#
# Shortcut chay thang electron.exe cua repo nay (khong qua cmd nen khong mo cua so
# console — log xem trong app, nut "Console" o footer). Duong dan tu resolve theo
# vi tri repo tren tung may, khong hardcode.
#
# Luu y: giu file nay ASCII-only — Windows PowerShell 5.1 doc file khong BOM theo
# ANSI codepage, tieng Viet co dau se thanh mojibake.

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path $electron)) {
  Write-Host "KHONG thay $electron"
  Write-Host "Hay chay 'npm install' truoc, roi chay lai 'npm run desktop:install'."
  exit 1
}

$name = 'VHS DevBox'
$links = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) "$name.lnk"),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) "Programs\$name.lnk")
)

$ws = New-Object -ComObject WScript.Shell
foreach ($lnk in $links) {
  $sc = $ws.CreateShortcut($lnk)
  $sc.TargetPath = $electron
  $sc.Arguments = '.'
  $sc.WorkingDirectory = $repoRoot
  $sc.WindowStyle = 1
  $sc.IconLocation = "$electron,0"
  $sc.Description = 'VHS DevBox desktop app'
  $sc.Save()
  Write-Host "Da tao: $lnk"
}

Write-Host ''
Write-Host "Xong. Double-click '$name' ngoai Desktop, hoac nhan nut Windows go '$name'."
Write-Host '(Windows Search co the can vai chuc giay de index shortcut moi.)'
