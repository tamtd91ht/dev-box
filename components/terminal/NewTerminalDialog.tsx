'use client';

// Popup "Terminal mới" — hiện lên MỖI LẦN mở terminal.
//
// VÌ SAO HỎI MỖI LẦN thay vì để cấu hình sẵn trên thanh: thư mục chạy là thứ
// đổi theo từng việc, không phải thiết lập ổn định. Cấu hình sẵn bắt người dùng
// nhớ "lần trước mình để cái gì ở đó" TRƯỚC khi bấm, và bấm nhầm thì phải đóng
// phiên mở lại. Hỏi ngay lúc bấm thì mỗi lần mở là một quyết định độc lập,
// nhìn thấy rõ mình sắp chạy ở đâu.
//
// Thư mục MẶC ĐỊNH là folder app: mở popup lên bấm Enter phát là chạy được
// ngay, ai cần chỗ khác mới phải chọn. Nhanh cho ca thường gặp, vẫn linh động
// cho ca còn lại.
//
// Nút chọn thư mục mở FolderPicker (đã có sẵn, dùng chung với tab Git/Office):
// server liệt kê thư mục, người dùng bấm chuột — trình duyệt không đưa được
// đường dẫn tuyệt đối nên đây là cách duy nhất.

import { useEffect, useRef, useState } from 'react';
import FolderPicker from '@/components/FolderPicker';
import { SHELL_LABEL, type ShellKind } from '@/lib/terminal';

/** Nơi phiên mới sẽ hiển thị. */
export type OpenMode = 'inapp' | 'window';

export interface NewTerminalChoice {
  shell: ShellKind;
  /** '' = thư mục app (server tự điền). */
  cwd: string;
  mode: OpenMode;
}

interface Props {
  /** Thư mục app — hiện làm mặc định. */
  cwdDefault: string;
  /** Thư mục gốc người dùng trên máy (vd C:\Users\Admin) — nút nhảy nhanh. */
  cwdHome?: string;
  /** Thư mục gợi ý mở sẵn (lần trước đã chọn) — CHỈ để FolderPicker bắt đầu từ
   *  đó cho đỡ phải bấm lại từ ổ đĩa, KHÔNG phải giá trị mặc định. */
  lastCwd?: string;
  /** Shell dùng lần trước — chỉ là điểm khởi đầu, đổi thoải mái. */
  lastShell?: ShellKind;
  busy?: boolean;
  onConfirm: (choice: NewTerminalChoice) => void;
  onClose: () => void;
}

const SHELLS: { kind: ShellKind; icon: string; hint: string }[] = [
  { kind: 'powershell', icon: '❯', hint: 'Mặc định trên Windows' },
  { kind: 'cmd', icon: '▸', hint: 'cmd.exe cổ điển' },
  { kind: 'bash', icon: '$', hint: 'Cần cài Git for Windows' },
];

export default function NewTerminalDialog({
  cwdDefault, cwdHome, lastCwd, lastShell, busy = false, onConfirm, onClose,
}: Props) {
  const [shell, setShell] = useState<ShellKind>(lastShell ?? 'powershell');
  const [cwd, setCwd] = useState('');            // '' = thư mục app
  const [pickerOpen, setPickerOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Esc đóng · Enter mở ngay trong app (ca hay dùng nhất) ·
  // Ctrl+Enter mở ra cửa sổ riêng.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (pickerOpen) return; // đang ở picker thì để nó xử lý phím
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm({ shell, cwd, mode: e.ctrlKey || e.metaKey ? 'window' : 'inapp' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shell, cwd, pickerOpen, onConfirm, onClose]);

  // Focus vào hộp thoại để phím tắt ăn ngay, khỏi phải bấm chuột một cái trước.
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  const effective = cwd || cwdDefault;

  return (
    <>
      <div className="tw-modal-back" onClick={onClose} />
      <div className="tw-modal" role="dialog" aria-modal="true" aria-label="Terminal mới" ref={cardRef} tabIndex={-1}>
        <div className="tw-modal-head">
          <span className="tw-modal-title">Terminal mới</span>
          <button className="tw-modal-x" onClick={onClose} aria-label="Đóng">✕</button>
        </div>

        <div className="tw-modal-body">
          {/* ── Shell ────────────────────────────────────────────────────── */}
          <div className="tw-field">
            <label className="tw-label">Shell</label>
            <div className="tw-seg" role="group">
              {SHELLS.map((s) => (
                <button
                  key={s.kind}
                  className={`tw-seg-btn${shell === s.kind ? ' on' : ''}`}
                  title={s.hint}
                  onClick={() => setShell(s.kind)}
                >
                  <span className="tw-seg-ico" aria-hidden>{s.icon}</span>
                  {SHELL_LABEL[s.kind]}
                </button>
              ))}
            </div>
          </div>

          {/* ── Thư mục chạy ─────────────────────────────────────────────── */}
          <div className="tw-field">
            <label className="tw-label">
              Thư mục chạy
              <span className="tw-label-opt">tuỳ chọn</span>
            </label>
            <div className="tw-path-row">
              <code className={`tw-path${cwd ? ' set' : ''}`} title={effective}>
                {effective || '—'}
              </code>
              <button className="tw-mini" onClick={() => setPickerOpen(true)}>
                📁 Chọn…
              </button>
            </div>

            {/* Nhảy nhanh tới vài chỗ hay dùng — khỏi phải lội FolderPicker.
                'Thư mục app' để cwd rỗng (server tự điền) chứ không ghi cứng
                đường dẫn: giá trị rỗng mới đúng nghĩa "mặc định". */}
            <div className="tw-quick">
              <button
                className={`tw-quick-btn${!cwd ? ' on' : ''}`}
                onClick={() => setCwd('')}
                title={cwdDefault}
              >
                <span aria-hidden>📦</span> Thư mục app
              </button>
              {cwdHome && (
                <button
                  className={`tw-quick-btn${cwd === cwdHome ? ' on' : ''}`}
                  onClick={() => setCwd(cwdHome)}
                  title={cwdHome}
                >
                  <span aria-hidden>🏠</span> System
                </button>
              )}
              {/* Chỗ vừa chạy lần trước — mở tiếp việc đang làm dở là ca rất hay
                  gặp. Ẩn khi nó trùng một nút đã có, khỏi bày hai nút y hệt nhau. */}
              {lastCwd && lastCwd !== cwdHome && lastCwd !== cwdDefault && (
                <button
                  className={`tw-quick-btn${cwd === lastCwd ? ' on' : ''}`}
                  onClick={() => setCwd(lastCwd)}
                  title={lastCwd}
                >
                  <span aria-hidden>🕘</span> Lần trước
                </button>
              )}
            </div>

            <p className="tw-hint">
              {!cwd
                ? 'Đang dùng thư mục app — bấm “Chọn…” nếu muốn chạy ở chỗ khác.'
                : cwd === cwdHome
                  ? 'Chạy tại thư mục gốc của người dùng trên máy này.'
                  : 'Terminal sẽ chạy tại thư mục bạn vừa chọn.'}
            </p>
          </div>
        </div>

        {/* ── Hai cách mở ────────────────────────────────────────────────── */}
        <div className="tw-modal-foot">
          <span className="tw-keyhint">
            <kbd>Enter</kbd> mở trong app · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> ra cửa sổ riêng
          </span>
          <span className="tw-gap" />
          <button
            className="tw-new alt"
            disabled={busy}
            title="Mở ở cửa sổ riêng — đóng app hay app crash thì phiên vẫn sống"
            onClick={() => onConfirm({ shell, cwd, mode: 'window' })}
          >
            ⧉ Cửa sổ riêng
          </button>
          <button
            className="tw-new"
            disabled={busy}
            onClick={() => onConfirm({ shell, cwd, mode: 'inapp' })}
          >
            ▸ Mở trong app
          </button>
        </div>
      </div>

      {pickerOpen && (
        <FolderPicker
          initial={cwd || lastCwd || cwdDefault || undefined}
          title="Chọn thư mục chạy terminal"
          hint="Không chọn cũng được — terminal sẽ chạy tại thư mục app."
          onPick={(p) => {
            setCwd(p);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}
