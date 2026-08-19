'use client';

// Quản lý Chrome extension cho TAB BROWSER.
//
// PHẠM VI: chỉ các partition `persist:browser-*`. Workspace (Zalo/Telegram),
// tab Links, Google viewer, Zalo API đều KHÔNG nạp extension — những tab đó là
// app-trong-app đang đăng nhập thật, một content script hỏng là hỏng phiên làm
// việc; tab Browser thì vốn là trình duyệt, hỏng thì đóng tab là xong.
//
// ELECTRON HỖ TRỢ ĐẾN ĐÂU — đọc kỹ trước khi kỳ vọng:
//   ✓ content script (chèn JS/CSS vào trang) — thứ chạy TỐT NHẤT
//   ✓ chrome.storage, chrome.runtime (messaging cơ bản), i18n
//   ✓ MV3 service worker — một phần
//   ✗ chrome.tabs, chrome.webRequest, declarativeNetRequest
//   ✗ nút/popup trên thanh công cụ, trang tuỳ chọn, devtools page
//
// Nên: extension TỰ VIẾT dạng content script chạy ngon. Extension tải từ Chrome
// Web Store (uBlock Origin, trình quản lý mật khẩu…) phần lớn KHÔNG chạy đúng.
// Panel này đọc manifest.json và cảnh báo trước từng cái, thay vì để người dùng
// tự đoán vì sao cài xong chẳng thấy gì.
//
// CHỈ NHẬN THƯ MỤC ĐÃ GIẢI NÉN. File .crx là zip đã ký, Electron không đọc.

import { useCallback, useEffect, useState } from 'react';

interface ExtItem {
  path: string;
  name: string;
  version: string;
  enabled: boolean;
  /** Electron đã thực sự nạp được vào session đang mở hay chưa. */
  loaded: boolean;
  /** Thư mục đã bị xoá/đổi tên trên đĩa. */
  missing: boolean;
  /** Cảnh báo tương thích đọc từ manifest.json. */
  warnings: string[];
}

interface ListResult {
  ok: boolean;
  items: ExtItem[];
  dir: string;
  /** Số session browser đang mở — 0 nghĩa là chưa mở tab Browser nào. */
  sessions: number;
}

type Res = { ok: boolean; error?: string; warning?: string | null; needsRestart?: boolean };

declare global {
  interface Window {
    browserExt?: {
      list(): Promise<ListResult>;
      pickDir(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      add(dirPath: string): Promise<Res>;
      toggle(dirPath: string, enabled: boolean): Promise<Res>;
      remove(dirPath: string): Promise<Res>;
      reload(): Promise<{ ok: boolean; count: number; sessions: number }>;
      openDir(): Promise<Res>;
    };
  }
}

export default function BrowserExtensions({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<ExtItem[]>([]);
  const [dir, setDir] = useState('');
  const [sessions, setSessions] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = window.browserExt;
    if (!api) return;
    try {
      const r = await api.list();
      if (r.ok) {
        setItems(r.items);
        setDir(r.dir);
        setSessions(r.sessions);
      }
    } catch {
      /* panel phụ trợ — im lặng */
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Esc = đóng. Không chặn khi đang bận: các thao tác ở đây đều nhanh và
  // idempotent, đóng giữa chừng không làm hỏng gì.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // <webview> của Electron vẽ ở tầng native, nằm TRÊN mọi phần tử HTML bất kể
  // z-index — ở tab Browser nó che mất modal này. Cờ trên <html> đẩy tạm các
  // pane webview ra ngoài màn hình. Cùng cách UpdatePrompt đang dùng.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-modal-over-webview', '1');
    void window.workspace?.focusHost?.().catch(() => {});
    return () => root.removeAttribute('data-modal-over-webview');
  }, []);

  /** Bọc một thao tác: khoá nút, xoá thông báo cũ, refresh lại sau khi xong. */
  const run = useCallback(async (fn: () => Promise<Res | void>, okMsg?: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await fn();
      if (r && !r.ok) setErr(r.error || 'thất bại');
      else if (r && r.warning) setErr(`Đã thêm nhưng nạp lỗi: ${r.warning}`);
      else if (r && r.needsRestart) setMsg('Đã thêm. Mở một tab Browser để extension được nạp.');
      else if (okMsg) setMsg(okMsg);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      void refresh();
    }
  }, [refresh]);

  const addExt = useCallback(async () => {
    const api = window.browserExt;
    if (!api) return;
    const picked = await api.pickDir();
    if (!picked.ok || !picked.path) return;          // huỷ hộp thoại — không báo lỗi
    const dirPath = picked.path;
    await run(() => api.add(dirPath));
  }, [run]);

  if (typeof window !== 'undefined' && !window.browserExt) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3 style={{ marginTop: 0 }}>🧩 Extension</h3>
          <p className="small" style={{ color: 'var(--muted)' }}>
            Chỉ dùng được trong app desktop (Electron), không chạy trên trình duyệt web.
          </p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button onClick={onClose}>Đóng</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal bx-modal" onClick={(e) => e.stopPropagation()}>
        <div className="status-line" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>🧩 Extension của tab Browser</h3>
          <button className="ghost sm" onClick={onClose} title="Đóng (Esc)">✕</button>
        </div>

        <p className="small bx-note">
          Chỉ áp cho <b>tab Browser</b>. Workspace (Zalo/Telegram), Links, Google và Zalo API
          không nạp extension. Electron chỉ chạy <b>content script</b> (chèn JS/CSS vào trang) —
          không có <code>chrome.tabs</code>, <code>chrome.webRequest</code> hay nút trên thanh
          công cụ, nên phần lớn extension tải từ Chrome Web Store sẽ <b>không chạy đúng</b>.
          Chỉ nhận <b>thư mục đã giải nén</b> có <code>manifest.json</code>, không nhận
          file <code>.crx</code>.
        </p>

        <div className="row bx-actions">
          <button onClick={addExt} disabled={busy}>＋ Thêm thư mục extension</button>
          <button
            className="ghost sm"
            disabled={busy}
            onClick={() => run(async () => { await window.browserExt?.reload(); }, 'Đã nạp lại.')}
          >
            ↻ Nạp lại tất cả
          </button>
          <button className="ghost sm" disabled={busy} onClick={() => void window.browserExt?.openDir()}>
            📁 Mở thư mục
          </button>
        </div>

        {sessions === 0 && (
          <p className="small bx-warn">
            Chưa có tab Browser nào mở — extension sẽ được nạp khi bạn mở tab đầu tiên.
          </p>
        )}
        {msg && <p className="small bx-ok">{msg}</p>}
        {err && <p className="small bx-err">{err}</p>}

        <div className="bx-list">
          {items.length === 0 && (
            <p className="small" style={{ color: 'var(--muted)' }}>
              Chưa có extension nào. Bấm <b>＋ Thêm thư mục extension</b> và trỏ vào thư mục chứa{' '}
              <code>manifest.json</code>. Có sẵn một extension mẫu trong{' '}
              <code>electron/extensions-sample/hello-devbox</code>.
            </p>
          )}
          {items.map((it) => (
            <div key={it.path} className={`bx-item${it.enabled ? '' : ' off'}`}>
              <div className="bx-item-main">
                <div className="bx-item-title">
                  <b>{it.name}</b>{' '}
                  <span className="small" style={{ color: 'var(--muted)' }}>v{it.version}</span>
                  {it.missing ? (
                    <span className="bx-badge bad">thiếu thư mục</span>
                  ) : it.enabled ? (
                    it.loaded
                      ? <span className="bx-badge ok">đang chạy</span>
                      : <span className="bx-badge warn">chưa nạp</span>
                  ) : null}
                </div>
                <div className="bx-item-path small" title={it.path}>{it.path}</div>
                {it.warnings.length > 0 && (
                  <ul className="bx-warns small">
                    {it.warnings.map((w) => <li key={w}>⚠ {w}</li>)}
                  </ul>
                )}
              </div>
              <div className="bx-item-act">
                <button
                  className="ghost sm"
                  disabled={busy || it.missing}
                  onClick={() => run(() => window.browserExt!.toggle(it.path, !it.enabled))}
                >
                  {it.enabled ? 'Tắt' : 'Bật'}
                </button>
                <button
                  className="ghost sm"
                  disabled={busy}
                  onClick={() => run(() => window.browserExt!.remove(it.path))}
                  title="Bỏ khỏi danh sách (không xoá thư mục trên đĩa)"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>

        {dir && <p className="small bx-dir">Danh sách lưu ở <code>{dir}</code></p>}
      </div>
    </div>
  );
}
