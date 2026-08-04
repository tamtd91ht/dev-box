// Copy monaco-editor/min/vs → public/monaco/vs để Monaco editor (tab Code,
// Tools) tải LOCAL thay vì CDN jsdelivr — app nội bộ phải chạy được cả khi
// mạng chặn/chập chờn tới CDN. Chạy tự động qua postinstall + predev/prebuild;
// idempotent: chỉ copy lại khi version monaco đổi hoặc thiếu file.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', 'monaco-editor', 'min', 'vs');
const destRoot = path.join(root, 'public', 'monaco');
const dest = path.join(destRoot, 'vs');
const verFile = path.join(destRoot, '.version');

if (!fs.existsSync(path.join(src, 'loader.js'))) {
  console.warn('[copy-monaco] node_modules/monaco-editor chưa có — bỏ qua (chạy npm install trước)');
  process.exit(0);
}

const version = require(path.join(root, 'node_modules', 'monaco-editor', 'package.json')).version;
const current = fs.existsSync(verFile) ? fs.readFileSync(verFile, 'utf8').trim() : '';
if (current === version && fs.existsSync(path.join(dest, 'loader.js'))) process.exit(0);

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(destRoot, { recursive: true });
fs.cpSync(src, dest, { recursive: true });
fs.writeFileSync(verFile, version + '\n');
console.log(`[copy-monaco] đã copy monaco-editor@${version} → public/monaco/vs`);
