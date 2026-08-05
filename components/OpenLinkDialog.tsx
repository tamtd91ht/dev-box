'use client';

// Bấm link trong workspace (Zalo/Telegram…) → hỏi mở ở đâu.
//
// Main process chặn link ra ngoài (electron/main.cjs → askOpenTarget) rồi gửi
// URL sang đây. Ba lựa chọn:
//
//   📑 Mở trong tab Links   — viewer có PROFILE đăng nhập, dùng cho trang nội bộ
//                             cần nhớ session (CRM, Jira, admin…)
//   🌐 Mở trong Browser     — trình duyệt đa tab trong app, xem nhanh rồi đóng
//   ↗ Mở bằng trình duyệt ngoài — Chrome/Edge thật của máy
//
// Lựa chọn cuối được nhớ trong localStorage và đưa lên làm mặc định (Enter),
// nhưng KHÔNG bao giờ tự động bỏ qua hộp thoại — người dùng vẫn thấy và đổi
// được mỗi lần, vì cùng một người lúc muốn xem trong app lúc muốn ra ngoài.

import { useCallback, useEffect, useRef, useState } from 'react';
import { emitOpenUrl, type OpenTarget } from '@/lib/openTarget';

const LAST_KEY = 'devbox:open-target:last';

interface Choice {
  target: OpenTarget;
  icon: string;
  label: string;
  hint: string;
}

const CHOICES: Choice[] = [
  {
    target: 'links',
    icon: '📑',
    label: 'Mở trong tab Links',
    hint: 'Viewer có profile đăng nhập — cho trang nội bộ cần nhớ session',
  },
  {
    target: 'browser',
    icon: '🌐',
    label: 'Mở trong Browser của app',
    hint: 'Trình duyệt đa tab ngay trong DevBox — xem nhanh rồi đóng',
  },
  {
    target: 'external',
    icon: '↗',
    label: 'Mở bằng trình duyệt ngoài',
    hint: 'Chrome/Edge thật của máy',
  },
];

const hostOf = (u: string): string => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/** Đổi tab đang xem của DevBox — page.tsx truyền hàm này xuống. */
type GoTab = (tab: 'links' | 'browser') => void;

export default function OpenLinkDialog({ onGoTab }: { onGoTab: GoTab }) {
  const [url, setUrl] = useState<string | null>(null);
  const [last, setLast] = useState<OpenTarget>('external');
  const firstRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    try {
      const v = localStorage.getItem(LAST_KEY);
      if (v === 'links' || v === 'browser' || v === 'external') setLast(v);
    } catch {
      /* localStorage bị chặn — dùng mặc định */
    }
  }, []);

  // Main process gửi URL mỗi khi chặn được một link ra ngoài.
  useEffect(() => {
    const off = window.workspace?.onOpenRequest?.((u) => setUrl(u));
    return off;
  }, []);

  const close = useCallback(() => setUrl(null), []);

  const pick = useCallback(
    (target: OpenTarget) => {
      const u = url;
      if (!u) return;
      setUrl(null);
      try {
        localStorage.setItem(LAST_KEY, target);
      } catch {
        /* không nhớ được thì thôi */
      }
      setLast(target);

      if (target === 'external') {
        void window.workspace?.openExternal?.(u);
        return;
      }

      // Bật tab đích TRƯỚC, rồi mới phát event: tab chỉ được mount sau lần ghé
      // đầu tiên (`visited` trong page.tsx), nên nếu phát ngay thì chưa có ai
      // nghe. Phát lại sau một nhịp render để tab vừa mount cũng nhận được.
      onGoTab(target);
      emitOpenUrl({ url: u, target });
      requestAnimationFrame(() => emitOpenUrl({ url: u, target }));
    },
    [url, onGoTab],
  );

  // Esc đóng; Enter chọn lựa chọn đã dùng lần trước.
  useEffect(() => {
    if (!url) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        pick(last);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [url, last, close, pick]);

  useEffect(() => {
    if (url) firstRef.current?.focus();
  }, [url]);

  if (!url) return null;

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal open-dlg" onClick={(e) => e.stopPropagation()}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>Mở liên kết ở đâu?</h3>
          <button className="ghost sm" onClick={close} title="Bỏ qua (Esc)">
            ✕
          </button>
        </div>

        <div className="open-dlg-url" title={url}>
          <span className="open-dlg-host">{hostOf(url)}</span>
          <code className="small">{url}</code>
        </div>

        <div className="open-dlg-opts">
          {CHOICES.map((c, i) => (
            <button
              key={c.target}
              ref={i === 0 ? firstRef : undefined}
              className={`open-dlg-opt${c.target === last ? ' is-last' : ''}`}
              onClick={() => pick(c.target)}
            >
              <span className="open-dlg-ico">{c.icon}</span>
              <span className="open-dlg-text">
                <b>{c.label}</b>
                <span className="open-dlg-hint">{c.hint}</span>
              </span>
              {c.target === last && <span className="open-dlg-badge">Enter</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
