'use client';

// Khung đọc nội dung mail — iframe cách ly + CSS theo chuẩn mail client.
//
// VÌ SAO PHẢI CÓ FILE RIÊNG (trước đây là vài dòng inline trong MailWorkspace):
//
//  1. CHIỀU CAO. iframe có chiều cao cố định thì mail dài bị CẮT, mail ngắn để
//     lại khoảng trắng mênh mông, và cuộn thì thành hai thanh cuộn lồng nhau.
//     Ở đây đo chiều cao THẬT của nội dung sau khi load rồi set lại cho iframe
//     → trang chỉ còn MỘT thanh cuộn, đúng như mọi webmail.
//  2. CSS CHUẨN MAIL. Mail thật dựng bằng <table> và thuộc tính HTML đời cũ
//     (align/bgcolor/width="600"). Trước đây chỉ có mỗi `font` + `word-break`
//     áp lên body, mà `word-break: break-all` thì CẮT GIỮA TỪ — bảng và chữ vỡ
//     hết. Reset dưới đây bám theo cách mail client thật render.
//  3. GẤP PHẦN TRÍCH DẪN. Mail trả lời qua lại chục lần thì 90% nội dung là
//     lịch sử. Gấp lại như Gmail (nút "···") để thấy ngay phần mới.
//
// BẢO MẬT giữ nguyên như cũ: sandbox KHÔNG có allow-scripts và CSP chặn script
// → HTML của mail không chạy được code. allow-same-origin chỉ để host bắt click
// <a> (tải file trong app) và đo chiều cao.

import { useCallback, useEffect, useRef, useState } from 'react';

/** CSS tiêm vào iframe. Bám theo cách mail client thật render HTML mail. */
const MAIL_CSS = `
  html, body { margin: 0; padding: 0; }
  body {
    font: 14px/1.5 -apple-system, "Segoe UI", Roboto, system-ui, sans-serif;
    color: #202124; background: #fff;
    padding: 12px 14px;
    /* break-word (KHÔNG phải break-all): chỉ xuống dòng ở URL/chuỗi dài quá
       khổ, không cắt giữa từ tiếng Việt. */
    word-wrap: break-word; overflow-wrap: break-word;
    -webkit-text-size-adjust: 100%;
  }
  /* Ảnh không được tràn khung; giữ nguyên tỉ lệ khi bị co lại. */
  img { max-width: 100%; height: auto; border: 0; }
  /* Bảng là bộ khung của hầu hết mail HTML — không ép width:100% (vỡ layout
     600px cố định), chỉ chặn tràn ngang. */
  table { max-width: 100%; border-collapse: collapse; }
  td, th { word-wrap: break-word; overflow-wrap: break-word; }
  /* <pre> trong mail thường là log/code dán vào — cho cuộn ngang riêng thay vì
     đẩy rộng cả trang. */
  pre { white-space: pre-wrap; word-wrap: break-word; overflow-x: auto; }
  blockquote {
    margin: 8px 0 8px 8px; padding-left: 12px;
    border-left: 2px solid #dadce0; color: #5f6368;
  }
  a { color: #1a73e8; }
  /* Mail dùng màu chữ tối trên nền tối của app sẽ mất chữ → luôn nền trắng
     (giống mọi webmail), không kế thừa theme của DevBox. */
`;

/** Bọc HTML mail vào một tài liệu hoàn chỉnh có CSP + base target. */
function buildSrcDoc(html: string, allowRemote: boolean): string {
  const csp = allowRemote
    ? "default-src 'none'; img-src * data: cid: blob:; style-src 'unsafe-inline' *; font-src * data:;"
    : "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:;";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>${MAIL_CSS}</style>
</head><body>${html}</body></html>`;
}

/** Text thuần → HTML an toàn, giữ xuống dòng và tự tạo link. */
export function textToHtml(text: string): string {
  const esc = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linked = esc.replace(
    /(https?:\/\/[^\s<]+)/g,
    (u) => `<a href="${u}">${u}</a>`,
  );
  // Dòng bắt đầu bằng '>' là trích dẫn kiểu mail text — vẽ như blockquote.
  const lines = linked.split('\n').map((l) =>
    /^\s*&gt;/.test(l) ? `<span style="color:#5f6368">${l}</span>` : l,
  );
  return `<div style="white-space:pre-wrap">${lines.join('\n')}</div>`;
}

export interface MailBodyProps {
  html: string | null;
  text: string | null;
  /** Tiêu đề mail — làm title cho iframe (a11y). */
  subject: string;
  /** Cho phép tải ảnh/nội dung remote (người dùng bấm "Hiện ảnh"). */
  allowRemote: boolean;
  /** Bấm vào một link http(s) trong body. */
  onLink: (url: string) => void;
}

const MIN_H = 120;
const MAX_H = 20000;

export default function MailBody({ html, text, subject, allowRemote, onLink }: MailBodyProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(MIN_H);

  // Mail chỉ có text → dựng HTML tối thiểu, nhưng vẫn đi qua CÙNG một khung
  // iframe: một đường render duy nhất, khỏi lệch kiểu chữ giữa hai loại mail.
  const source = html ?? (text ? textToHtml(text) : '<p style="color:#80868b">(mail trống)</p>');

  /** Đo nội dung rồi set chiều cao iframe — bỏ thanh cuộn lồng nhau. */
  const fit = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc?.body) return;
    const h = Math.max(
      doc.body.scrollHeight,
      doc.documentElement?.scrollHeight ?? 0,
    );
    if (h > 0) setHeight(Math.min(MAX_H, Math.max(MIN_H, h + 8)));
  }, []);

  /** Sau khi iframe load: bắt click link + đo chiều cao (đo lại khi ảnh về). */
  const onLoad = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;

    doc.addEventListener('click', (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      if (!/^https?:/i.test(href)) return; // mailto:, cid:, … → hành vi mặc định
      e.preventDefault();
      e.stopPropagation();
      onLink(href);
    }, true);

    fit();
    // Ảnh về sau khi load xong sẽ làm nội dung cao lên → đo lại. Không có bước
    // này thì mail nhiều ảnh bị cắt mất phần dưới.
    for (const img of Array.from(doc.images)) {
      if (img.complete) continue;
      img.addEventListener('load', fit, { once: true });
      img.addEventListener('error', fit, { once: true });
    }
    // Web font / layout chậm một nhịp — đo thêm vài lần cho chắc, rẻ hơn nhiều
    // so với ResizeObserver trên document của guest.
    const timers = [80, 300, 900].map((ms) => window.setTimeout(fit, ms));
    return () => timers.forEach(clearTimeout);
  }, [fit, onLink]);

  // Khung app đổi bề ngang (kéo splitter, Ultra View) → nội dung wrap lại, cao
  // thấp khác đi. Đo lại theo kích thước của chính iframe.
  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  return (
    <iframe
      ref={frameRef}
      className="mail-frame"
      style={{ height }}
      /* allow-same-origin: để host bắt click link + đo chiều cao.
         An toàn vì KHÔNG allow-scripts + CSP default-src 'none' — mail không
         thể chạy script hay đọc gì từ app. */
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
      srcDoc={buildSrcDoc(source, allowRemote)}
      onLoad={onLoad}
      title={subject}
    />
  );
}
