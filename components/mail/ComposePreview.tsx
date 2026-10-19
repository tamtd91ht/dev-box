'use client';

// XEM TRƯỚC thư sắp gửi — đúng như bên người nhận mở ra.
//
// VÌ SAO CẦN: ô soạn thảo là một <div contentEditable> nằm trong app, nên nó
// thừa hưởng theme TỐI, font và CSS của DevBox. Người nhận thì mở thư trong
// Outlook/Gmail: nền TRẮNG, font mail client, và không có tí CSS nào của app.
// Hai bên nhìn khác hẳn nhau — soạn xong thấy đẹp, gửi đi mới lòi ra chữ trắng
// trên nền trắng, bảng vỡ, chữ ký lệch.
//
// CÁCH LÀM: đẩy CHÍNH chuỗi HTML sắp gửi (`html` của SendInput, nguyên văn)
// qua đúng component MailBody dùng để ĐỌC mail. Một đường render duy nhất cho
// cả đọc lẫn xem trước, nên thấy gì là nhận được thế — không phải một bản
// "gần giống" tự dựng riêng, vốn sẽ trôi lệch mỗi lần sửa CSS một bên.
//
// Phần header (Từ/Tới/Cc/Tiêu đề/đính kèm) dựng lại theo cách webmail hiển thị
// để soát nốt những lỗi hay gặp mà body không lộ ra: quên tiêu đề, quên đính
// kèm, gửi nhầm người.

import MailBody from './MailBody';
import { fmtSize } from '@/lib/mail';
import type { MailAccountPub } from '@/lib/mail';
import { htmlToText } from './RichTextEditor';
import { useState } from 'react';

export interface ComposePreviewProps {
  /** HTML sẽ đi vào phần text/html của thư — nguyên văn, không xử lý thêm. */
  html: string;
  account: MailAccountPub;
  to: string;
  cc: string;
  subject: string;
  attachments: { filename: string; size: number }[];
}

export default function ComposePreview({
  html, account, to, cc, subject, attachments,
}: ComposePreviewProps) {
  /**
   * Thư gửi đi là multipart/alternative: bản HTML cho client đọc được định
   * dạng, bản TEXT cho client text-only (và cho một số bộ lọc spam chấm điểm).
   * Bản text được suy ra tự động từ HTML lúc gửi, nên cũng phải xem được —
   * đây đúng là chỗ hay hỏng mà không ai biết cho tới khi có người phàn nàn.
   */
  const [asText, setAsText] = useState(false);
  const text = htmlToText(html);

  return (
    <div className="mc-preview">
      <div className="mc-preview-bar">
        <span className="mc-preview-tag">👁 Xem trước</span>
        <span className="small" style={{ color: 'var(--muted)' }}>
          đúng như bên người nhận mở ra
        </span>
        <span style={{ flex: 1 }} />
        {/* Hai bản THẬT SỰ được gửi — không phải hai kiểu hiển thị tự chế. */}
        <button className={`mc-preview-tab${asText ? '' : ' is-on'}`} onClick={() => setAsText(false)}>
          HTML
        </button>
        <button className={`mc-preview-tab${asText ? ' is-on' : ''}`} onClick={() => setAsText(true)}
          title="Bản text gửi kèm — client text-only và bộ lọc spam đọc bản này">
          Text thuần
        </button>
      </div>

      <div className="mc-preview-scroll">
        {/* Header như webmail dựng: bắt lỗi quên tiêu đề / quên đính kèm / sai
            người nhận, những thứ body không bao giờ lộ ra. */}
        <div className="mc-preview-head">
          <div className="mc-preview-subject">
            {subject.trim() || <i style={{ color: 'var(--faint)' }}>(không tiêu đề)</i>}
          </div>
          <div className="mc-preview-meta">
            <b>{account.label || account.email}</b>
            <span className="mc-preview-addr">&lt;{account.email}&gt;</span>
          </div>
          <div className="mc-preview-meta">
            tới {to.trim() || <i style={{ color: 'var(--faint)' }}>(chưa có người nhận)</i>}
            {cc.trim() && <> · cc {cc.trim()}</>}
          </div>
          {attachments.length > 0 && (
            <div className="mc-preview-meta">
              📎 {attachments.map((a) => `${a.filename}${a.size > 0 ? ` (${fmtSize(a.size)})` : ''}`).join(' · ')}
            </div>
          )}
        </div>

        {asText ? (
          <pre className="mc-preview-text">{text || '(trống)'}</pre>
        ) : (
          <MailBody
            html={html}
            text={null}
            subject={subject || 'Xem trước thư'}
            // Ảnh trong thư mình tự soạn là do chính mình chèn — không phải
            // pixel theo dõi của người lạ, nên hiện luôn. Chặn ở đây thì xem
            // trước lại KHÔNG giống bên nhận, đúng cái việc nó sinh ra để làm.
            allowRemote
            // Xem trước thì không mở link đi đâu cả — mới là bản nháp.
            onLink={() => {}}
          />
        )}
      </div>
    </div>
  );
}
