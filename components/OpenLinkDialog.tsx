'use client';

// Bấm link trong tin nhắn Zalo/Telegram → hỏi mở ở đâu.
//
// Zalo dựng link trong khung chat bằng handler JS rồi gọi window.open(), chứ
// không phải <a href> thường — nên click "không ăn gì" nếu popup bị chặn.
// Main process bắt đúng chỗ đó (electron/main.cjs → setWindowOpenHandler) và
// gửi URL sang đây. Hai lựa chọn, CẢ HAI đều ở trong app:
//
//   📑 Mở trong tab Links   — viewer có PROFILE đăng nhập, cho trang nội bộ
//                             cần nhớ session (CRM, Jira, admin…)
//   🌐 Mở trong Browser     — trình duyệt đa tab trong app, xem nhanh rồi đóng
//
// KHÔNG có lựa chọn "trình duyệt ngoài": yêu cầu là mọi thứ vẫn xem trong
// DevBox. Muốn ra Chrome/Edge thật thì dùng nút ↗ trên thanh công cụ của
// viewer sau khi trang đã mở.
//
// Cửa sổ Zalo KHÔNG bị đụng tới — nó vẫn chạy nguyên trong webview của nó, còn
// đăng nhập, còn khung chat. Đây là điểm khác lần sửa trước (loadURL đè lên
// chính guest Zalo, làm mất chat).
//
// Lựa chọn cuối được nhớ trong localStorage và đưa lên làm mặc định (Enter),
// nhưng KHÔNG bao giờ tự động bỏ qua hộp thoại — cùng một người lúc muốn xem
// bằng viewer có phiên đăng nhập, lúc chỉ muốn liếc nhanh.

import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultTargetFor, emitOpenUrl, type OpenTarget } from '@/lib/openTarget';

const LAST_KEY = 'devbox:open-target:last';

interface Choice {
  target: OpenTarget;
  icon: string;
  label: string;
  hint: string;
}

const CHOICES: Choice[] = [
  {
    target: 'browser',
    icon: '🌐',
    label: 'Mở trong Browser của app',
    hint: 'Trình duyệt đa tab ngay trong DevBox — xem nhanh rồi đóng',
  },
  {
    target: 'links',
    icon: '📑',
    label: 'Mở trong tab Links',
    hint: 'Viewer có profile đăng nhập — cho trang nội bộ cần nhớ session',
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
type GoTab = (tab: OpenTarget) => void;

export default function OpenLinkDialog({ onGoTab }: { onGoTab: GoTab }) {
  const [url, setUrl] = useState<string | null>(null);
  const [remembered, setRemembered] = useState<OpenTarget | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    try {
      const v = localStorage.getItem(LAST_KEY);
      if (v === 'links' || v === 'browser') setRemembered(v);
    } catch {
      /* localStorage bị chặn — dùng mặc định */
    }
  }, []);

  // Mặc định của Enter: lựa chọn lần trước nếu có, chưa có thì theo quy tắc
  // chung (link Google cần đăng nhập → Links, còn lại → Browser).
  const last: OpenTarget = remembered ?? (url ? defaultTargetFor(url) : 'browser');

  // Main process gửi URL mỗi khi bắt được một link bấm từ workspace.
  useEffect(() => {
    const off = window.workspace?.onOpenRequest?.((u) => setUrl(u));
    return off;
  }, []);

  /**
   * Mở URL vào một tab trong app.
   *
   * Bật tab đích rồi phát yêu cầu MỘT lần. Không cần phát lại sau
   * requestAnimationFrame như bản trước: emitOpenUrl giữ yêu cầu lại
   * (xem `pending` trong lib/openTarget.ts) nên tab mount trễ bao lâu cũng
   * nhận được. Phát lại theo nhịp render là đoán thời điểm — một frame không
   * đủ cho tab còn phải chạy effect khởi tạo, và đó chính là lý do lần bấm đầu
   * ra trang trắng.
   */
  const route = useCallback(
    (u: string, target: OpenTarget) => {
      onGoTab(target);
      emitOpenUrl({ url: u, target });
    },
    [onGoTab],
  );

  // window.open() từ chính UI DevBox (nút "mở trên browser" ở tab Google, link
  // trong Mail, bookmark…). KHÔNG hỏi gì — đây là hành động người dùng đã chủ
  // động bấm, chỉ cần nó đừng bắn ra Edge/Chrome. Đích theo quy tắc mặc định.
  useEffect(() => {
    const off = window.workspace?.onOpenInApp?.((u) => route(u, defaultTargetFor(u)));
    return off;
  }, [route]);

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
      setRemembered(target);
      route(u, target);
    },
    [url, route],
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
