# Go nhung gi scripts/install-shortcuts.ps1 da tao: shortcut Desktop + Start Menu,
# va dang ky "Open with -> VHS DevBox" trong registry HKCU.
#
#   npm run desktop:uninstall
#
# Chay duoc ca khi chua tung cai (khong bao loi, chi bao "khong thay").
#
# Luu y: giu file nay ASCII-only - Windows PowerShell 5.1 doc file khong BOM theo
# ANSI codepage, tieng Viet co dau se thanh mojibake.

$ErrorActionPreference = 'Stop'

$name    = 'VHS DevBox'
$progId  = 'VhsDevBox.Document'
$classes = 'HKCU:\Software\Classes'

# -- Shortcut ----------------------------------------------------------------
$links = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) "$name.lnk"),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) "Programs\$name.lnk")
)
foreach ($lnk in $links) {
  if (Test-Path $lnk) {
    Remove-Item $lnk -Force
    Write-Host "Da xoa: $lnk"
  } else {
    Write-Host "Khong thay (bo qua): $lnk"
  }
}

# -- Open with ---------------------------------------------------------------
# Go tro toi ProgID o tung duoi file TRUOC, roi moi xoa chinh ProgID. Chi dong
# vao dung gia tri mang ten cua minh - khoa OpenWithProgids con giu lua chon
# "Open with" cua cac app khac tren may.
$exts = @('.xlsx', '.xlsm', '.csv', '.docx', '.md', '.markdown', '.json', '.xml', '.html', '.htm')
foreach ($ext in $exts) {
  $key = "$classes\$ext\OpenWithProgids"
  if (-not (Test-Path $key)) { continue }
  $entry = Get-ItemProperty -Path $key -Name $progId -ErrorAction SilentlyContinue
  if ($entry) {
    Remove-ItemProperty -Path $key -Name $progId -Force
    Write-Host "Da go '$name' khoi menu Open with cua $ext"
  }
}

if (Test-Path "$classes\$progId") {
  Remove-Item "$classes\$progId" -Recurse -Force
  Write-Host "Da xoa ProgID $progId"
} else {
  Write-Host "Khong thay ProgID $progId (bo qua)"
}

Write-Host ''
Write-Host 'Xong. Explorer co the con nho menu cu vai phut - dang xuat/dang nhap lai la sach.'
