'use client';

// Popup xác nhận trước khi ĐÓNG một phiên terminal.
//
// VÌ SAO CẦN: nút ✕ nằm sát ngay cạnh tên tab, bấm nhầm là giết shell thật —
// mất luôn tiến trình đang chạy dở (build, ssh, script dài…) và KHÔNG khôi phục
// được, vì phiên chết là ring buffer đi theo. Mở terminal mới thì rẻ, giết nhầm
// thì đắt, nên chặn một nhịp ở đây là đáng.
//
// Mặc định focus vào nút "Huỷ": lỡ bấm ✕ rồi đập Enter theo quán tính thì
// KHÔNG đóng nhầm lần thứ hai. Muốn đóng phải chủ động bấm hoặc Tab qua.

import { useEffect, useRef } from 'react';

interface Props {
  /** Tên phiên sắp đóng — nêu đích danh để người dùng thấy rõ mình đang giết cái nào. */
  label: string;
  /** Thư mục phiên đang chạy — thêm một mốc nhận dạng khi nhiều tab trùng tên. */
  cwd?: string;
  /** Phiên đã tự kết thúc: chỉ còn dọn tab, không giết gì cả → lời lẽ nhẹ đi. */
  exited?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export default function CloseTerminalDialog({ label, cwd, exited = false, onConfirm, onClose }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="tw-modal-back" onClick={onClose} />
      <div className="tw-modal tw-modal-sm" role="dialog" aria-modal="true" aria-label="Xác nhận đóng terminal">
        <div className="tw-modal-head">
          <span className="tw-modal-title">{exited ? 'Đóng tab?' : 'Đóng phiên terminal?'}</span>
          <button className="tw-modal-x" onClick={onClose} aria-label="Đóng">✕</button>
        </div>

        <div className="tw-modal-body">
          <div className="tw-confirm">
            <span className="tw-confirm-ico" aria-hidden>{exited ? '🧹' : '⚠'}</span>
            <div className="tw-confirm-text">
              <p className="tw-confirm-main">
                {exited ? <>Dọn tab <b>{label}</b> khỏi danh sách.</> : <>Sắp tắt hẳn phiên <b>{label}</b>.</>}
              </p>
              {cwd && <code className="tw-confirm-cwd" title={cwd}>{cwd}</code>}
              <p className="tw-hint">
                {exited
                  ? 'Phiên này đã kết thúc từ trước — đóng tab không giết thêm gì.'
                  : 'Shell và mọi tiến trình đang chạy trong đó sẽ bị dừng, nội dung màn hình mất luôn — không mở lại được.'}
              </p>
            </div>
          </div>
        </div>

        <div className="tw-modal-foot">
          <span className="tw-keyhint"><kbd>Esc</kbd> để huỷ</span>
          <span className="tw-gap" />
          <button className="tw-new alt" ref={cancelRef} onClick={onClose}>Huỷ</button>
          <button className="tw-new danger" onClick={onConfirm}>
            {exited ? 'Đóng tab' : '✕ Đóng phiên'}
          </button>
        </div>
      </div>
    </>
  );
}
