'use client';

// Cấu hình @monaco-editor/react tải Monaco từ LOCAL (/monaco/vs — copy từ
// node_modules bởi scripts/copy-monaco.cjs) thay vì CDN jsdelivr mặc định.
//
// Lý do: loader của @monaco-editor reject promise bằng chính error EVENT của
// thẻ <script> khi tải CDN thất bại (mạng nội bộ chặn CDN / offline) → redbox
// "[object Event]" (unhandled rejection) mỗi lần mở tab Code/Tools. Local hóa
// vừa chạy offline vừa hết lớp lỗi đó.
//
// Import module này (side-effect) TRƯỚC khi render <Editor> ở mọi pane dùng
// Monaco — cấu hình phải đặt trước lần init đầu tiên.

import { loader } from '@monaco-editor/react';

loader.config({ paths: { vs: '/monaco/vs' } });

// loader giữ MỘT wrapper promise chung cho cả app — gắn catch ở đây là mọi
// thất bại init đều "đã xử lý": log rõ nguyên nhân thay vì redbox [object Event].
loader.init().catch((e: unknown) => {
  console.error(
    '[monaco] không tải được editor từ /monaco/vs — chạy `npm install` (hoặc `node scripts/copy-monaco.cjs`) để copy lại.',
    e,
  );
});
