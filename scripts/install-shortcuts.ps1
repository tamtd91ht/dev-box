# Tao shortcut "VHS DevBox" ngoai Desktop + trong Start Menu (tim bang nut Windows),
# VA dang ky "Open with -> VHS DevBox" khi chuot phai file .xlsx/.csv/.docx/.md/
# .json/.xml/.html trong Explorer.
#
# Chay 1 lan tren may moi, SAU KHI da `npm install`:
#
#   npm run desktop:install
#
# Go ra bang: npm run desktop:uninstall
#
# Shortcut chay thang electron.exe cua repo nay (khong qua cmd nen khong mo cua so
# console - log xem trong app, nut "Console" o footer). Duong dan tu resolve theo
# vi tri repo tren tung may, khong hardcode.
#
# CHUYEN NHA REPO: duong dan da ghi vao registry se tro vao cho trong. Chay lai
# script nay o vi tri moi de ghi de.
#
# Luu y: giu file nay ASCII-only - Windows PowerShell 5.1 doc file khong BOM theo
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

# -- "Open with -> VHS DevBox" khi chuot phai mot file -----------------------
#
# Cach lam: khai MOT ProgID (VhsDevBox.Document) mo ta "mo file bang app nay",
# roi tro OpenWithProgids cua tung duoi file toi no. Windows gop tat ca ProgID
# duoc tro toi vao menu "Open with" - nen app hien ra nhu mot lua chon, ma
# KHONG gianh lam ung dung mac dinh cua duoi file nao.
#
# Tat ca nam trong HKCU (chi anh huong tai khoan dang dang nhap) nen khong can
# quyen admin.
#
# Vi sao khong dung dinh dang mac dinh: doi mac dinh cua .xlsx sang app khac la
# viec nguoi dung tu quyet trong Settings cua Windows. Script cai dat gianh lay
# thi lan sau cai Office vao se thanh mo nham.
$progId  = 'VhsDevBox.Document'
$exts    = @('.xlsx', '.xlsm', '.csv', '.docx', '.md', '.markdown', '.json', '.xml', '.html', '.htm')
$classes = 'HKCU:\Software\Classes'

# "%1" = duong dan file nguoi dung bam vao. Tham so truoc no la thu muc repo:
# registry khong co khai niem working-directory (khac shortcut .lnk o tren), nen
# phai tu noi duong dan app vao lenh.
$command = '"{0}" "{1}" "%1"' -f $electron, $repoRoot

New-Item -Path "$classes\$progId\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$classes\$progId" -Name '(Default)' -Value 'Tai lieu VHS DevBox'
# Ten hien trong menu "Open with". Khong co dong nay Windows hien ten file exe
# ("electron"), nguoi dung khong biet la cai gi.
Set-ItemProperty -Path "$classes\$progId" -Name 'FriendlyTypeName' -Value $name
New-Item -Path "$classes\$progId\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$classes\$progId\DefaultIcon" -Name '(Default)' -Value "$electron,0"
Set-ItemProperty -Path "$classes\$progId\shell\open\command" -Name '(Default)' -Value $command

foreach ($ext in $exts) {
  New-Item -Path "$classes\$ext\OpenWithProgids" -Force | Out-Null
  # Kieu REG_NONE + gia tri rong dung theo tai lieu cua Microsoft cho khoa nay:
  # o day chi co TEN gia tri (= ProgID) mang y nghia.
  New-ItemProperty -Path "$classes\$ext\OpenWithProgids" -Name $progId `
    -PropertyType None -Value ([byte[]]@()) -Force | Out-Null
}

Write-Host "Da dang ky 'Open with -> $name' cho: $($exts -join ' ')"

Write-Host ''
Write-Host "Xong. Double-click '$name' ngoai Desktop, hoac nhan nut Windows go '$name'."
Write-Host '(Windows Search co the can vai chuc giay de index shortcut moi.)'
Write-Host ''
Write-Host "Chuot phai mot file .xlsx -> 'Open with' -> '$name' de mo thang vao app."
Write-Host 'Lan dau mo khi app CHUA chay phai doi next dev bien dich (vai chuc giay);'
Write-Host 'app dang chay san thi file mo ra ngay.'
