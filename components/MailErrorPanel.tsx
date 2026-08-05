'use client';

// Bảng lỗi đăng nhập mail — cách các mail client thật (Thunderbird, Apple Mail)
// làm: KHÔNG in một khối text dài, mà là
//   · một câu ngắn nói chuyện gì xảy ra,
//   · các bước sửa dạng danh sách (đọc quét được, không phải đoạn văn),
//   · NÚT mở đúng trang cần tới (tạo App Password, bật IMAP…),
//   · chi tiết kỹ thuật GẬP LẠI — chỉ mở khi cần tra/nhờ hỗ trợ,
//   · form KHÔNG bị xóa, bấm "Thử lại" là gửi luôn.

import { useState } from 'react';
import type { ImapFailureInfo } from '@/lib/mail';

/** Mở link ngoài: trong Electron dùng bridge để ra browser thật. */
export function openExternalLink(url: string) {
  const ext = typeof window !== 'undefined' ? window.workspace?.openExternal : undefined;
  if (ext) void ext(url).catch(() => window.open(url, '_blank'));
  else window.open(url, '_blank');
}

const ICON: Record<ImapFailureInfo['kind'], string> = {
  'app-password': '🔑',
  'imap-disabled': '🚫',
  auth: '🔒',
  dns: '🌐',
  refused: '🔌',
  timeout: '⏱',
  tls: '🔐',
  unknown: '⚠',
};

export default function MailErrorPanel({ failure, message, onRetry, retrying }: {
  /** Có phân loại → UI hành động được. Không có → chỉ còn text thô. */
  failure?: ImapFailureInfo;
  /** Text đầy đủ (fallback khi server cũ chưa gửi `failure`). */
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const [showDetail, setShowDetail] = useState(false);

  // Server chưa gửi phân loại → giữ hiển thị cũ, không vờ như có UI mới.
  if (!failure) {
    return <pre className="code mail-err-raw">{message}</pre>;
  }

  return (
    <div className={`mail-err mail-err--${failure.kind}`} role="alert">
      <div className="mail-err-head">
        <span className="mail-err-ico" aria-hidden>{ICON[failure.kind] ?? '⚠'}</span>
        <b className="mail-err-title">{failure.title}</b>
      </div>

      {failure.steps.length > 0 && (
        <ul className="mail-err-steps">
          {failure.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      )}

      {(failure.links.length > 0 || onRetry) && (
        <div className="mail-err-actions">
          {failure.links.map((l) => (
            <button key={l.url} className="sm" onClick={() => openExternalLink(l.url)} title={l.url}>
              ↗ {l.label}
            </button>
          ))}
          {onRetry && (
            <button className="ghost sm" onClick={onRetry} disabled={retrying}
              title="Gửi lại với thông tin đang nhập — form không bị xóa">
              {retrying ? <span className="spinner" aria-hidden /> : '↻'} Thử lại
            </button>
          )}
        </div>
      )}

      {failure.detail && (
        <div className="mail-err-detail">
          <button className="mail-err-toggle" onClick={() => setShowDetail((v) => !v)}>
            {showDetail ? '▾' : '▸'} Chi tiết kỹ thuật
          </button>
          {showDetail && (
            <>
              <pre className="code mail-err-raw">{failure.detail}</pre>
              <button className="ghost sm" onClick={() => void navigator.clipboard?.writeText(`${failure.title}\n${failure.detail}`)}
                title="Copy để gửi cho người hỗ trợ">⧉ Copy lỗi</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
