'use client';

// In-app viewer for the Google tab — opens a Drive file (or folder) in an
// Electron <webview> INSTEAD of bouncing to the external browser, so Docs/
// Sheets editing and Drive file management (upload/rename/delete/new) happen
// without leaving the DevBox. Desktop-shell only; the caller falls back to
// window.open when window.workspace is absent (plain-browser dev).
//
// Session: ONE shared persistent partition for everything Google opened here —
// log into Google inside the frame once and every later file opens signed-in.
// This browser session is independent of the server-side OAuth tokens
// (.googleauth.json) that power the file LISTS; the embedded editor runs under
// whichever Google account you sign in with here, with that account's real
// Drive permissions. "Logout" of this frame = Workspace-style clearSession.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebviewElement } from '@/lib/workspace/types';

/** Everything Google opened in-app shares this login session. */
const PARTITION = 'persist:ws-google-viewer';

// Google's sign-in refuses "insecure" embedded browsers by sniffing the UA for
// the Electron / app-name tokens — present ourselves as the plain Chrome we
// actually are underneath.
const CHROME_UA =
  typeof navigator === 'undefined'
    ? undefined
    : navigator.userAgent.replace(/ vhs-dev-box\/[\d.]+/i, '').replace(/ Electron\/[\d.]+/i, '');

type Status = 'loading' | 'ready' | 'failed';

interface Props {
  /** Display name (file/folder name) for the toolbar. */
  name: string;
  /** Drive webViewLink / folder URL to load. */
  url: string;
  onClose: () => void;
  /** Lưu URL đang xem vào danh sách link (mục 🔗 Liên kết). Ẩn nút khi absent. */
  onSaveLink?: (name: string, url: string) => Promise<void>;
}

export default function GoogleDocViewer({ name, url, onClose, onSaveLink }: Props) {
  const ref = useRef<WebviewElement | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [failInfo, setFailInfo] = useState('');
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [onLoginPage, setOnLoginPage] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const syncNav = () => {
      try {
        setCanBack(el.canGoBack());
        setCanForward(el.canGoForward());
        setOnLoginPage(/accounts\.google\.com/.test(el.getURL()));
      } catch {
        /* not attached yet */
      }
    };
    const onStart = () => setStatus('loading');
    const onStop = () => {
      setStatus((s) => (s === 'failed' ? s : 'ready'));
      syncNav();
    };
    const onFail = (e: Event) => {
      const ev = e as unknown as { errorCode: number; errorDescription: string; isMainFrame: boolean };
      if (!ev.isMainFrame || ev.errorCode === -3 /* ABORTED */) return;
      setFailInfo(`${ev.errorDescription || 'Network error'} (${ev.errorCode})`);
      setStatus('failed');
    };

    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('did-navigate', syncNav);
    el.addEventListener('did-navigate-in-page', syncNav);
    el.addEventListener('did-fail-load', onFail as EventListener);
    return () => {
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('did-navigate', syncNav);
      el.removeEventListener('did-navigate-in-page', syncNav);
      el.removeEventListener('did-fail-load', onFail as EventListener);
    };
  }, []);

  // Electron bug: hủy <webview> đang giữ focus xong, host page vẫn tưởng guest
  // giữ focus → mọi input trên trang "chết" (nhìn như bị disable) cho tới khi
  // click ra ngoài cửa sổ. Khi viewer unmount, chủ động kéo focus về host qua
  // main process (window.focus + webContents.focus).
  useEffect(() => () => {
    void window.workspace?.focusHost?.().catch(() => {});
  }, []);

  // Esc đóng viewer. Phím bấm BÊN TRONG guest không bubble ra host document,
  // nên gõ Esc khi đang soạn trong Docs không vô tình đóng khung.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const retry = useCallback(() => {
    setStatus('loading');
    setFailInfo('');
    try {
      void ref.current?.loadURL(url);
    } catch {
      ref.current?.reload();
    }
  }, [url]);

  const openExternal = useCallback(() => {
    let cur = url;
    try {
      cur = ref.current?.getURL() || url;
    } catch {
      /* ignore */
    }
    window.open(cur, '_blank');
  }, [url]);

  // 'idle' → chưa bấm; 'saving' → đang gọi API; 'done' → vừa lưu xong (✓ vài giây).
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'done'>('idle');
  const saveLink = useCallback(async () => {
    if (!onSaveLink) return;
    let cur = url;
    let title = name;
    try {
      cur = ref.current?.getURL() || url;
      title = ref.current?.getTitle?.() || name;
    } catch {
      /* not attached yet — save the original url */
    }
    setSaveState('saving');
    try {
      await onSaveLink(title, cur);
      setSaveState('done');
      setTimeout(() => setSaveState('idle'), 2500);
    } catch (e) {
      setSaveState('idle');
      window.alert((e as Error).message);
    }
  }, [onSaveLink, url, name]);

  const logout = useCallback(async () => {
    if (!window.workspace) return;
    if (!window.confirm('Đăng xuất phiên Google nhúng trên máy này? (không đụng token API)')) return;
    const res = await window.workspace.clearSession(PARTITION);
    if (res.ok) {
      setStatus('loading');
      try {
        ref.current?.reloadIgnoringCache();
      } catch {
        /* ignore */
      }
    }
  }, []);

  const webviewAttrs: Record<string, string> = { allowpopups: 'true' };
  if (CHROME_UA) webviewAttrs.useragent = CHROME_UA;

  return (
    <div className="g-viewer">
      <div className="ws-view" style={{ display: 'flex' }}>
        <div className="ws-toolbar">
          <div className="ws-nav">
            <button onClick={() => ref.current?.goBack()} disabled={!canBack} title="Quay lại">←</button>
            <button onClick={() => ref.current?.goForward()} disabled={!canForward} title="Tiến tới">→</button>
            <button onClick={() => ref.current?.reload()} title="Tải lại">⟳</button>
          </div>
          <div className="ws-title">
            <span className={`ws-dot ws-dot--${status === 'failed' ? 'loading' : status}`} />
            <span className="ws-title-text" title={name}>{name}</span>
          </div>
          <div className="ws-actions">
            <button
              onClick={() => { setStatus('loading'); void ref.current?.loadURL('https://accounts.google.com/'); }}
              title="Đăng nhập Google trong khung này — một lần là phiên lưu bền, file private + editor mở thẳng trong app"
            >
              Ⓖ
            </button>
            {onSaveLink && (
              <button onClick={() => void saveLink()} disabled={saveState === 'saving'}
                title="Lưu link đang xem vào mục 🔗 Liên kết">
                {saveState === 'done' ? '✓' : '💾'}
              </button>
            )}
            <button onClick={openExternal} title="Mở bằng trình duyệt ngoài">↗</button>
            <button onClick={() => void logout()} title="Đăng xuất phiên Google nhúng">⎋</button>
            <button onClick={onClose} title="Đóng (Esc)">✕</button>
          </div>
        </div>

        {onLoginPage && (
          <div className="g-viewer-hint">
            Đăng nhập Google ngay trong khung này (chỉ cần lần đầu) — phiên được lưu trên máy,
            các file sau sẽ mở thẳng vào editor.
          </div>
        )}

        <div className="ws-canvas">
          {/* partition MUST be an initial attribute — it cannot change after attach. */}
          <webview
            ref={ref as unknown as React.Ref<HTMLElement>}
            className="ws-webview"
            src={url}
            partition={PARTITION}
            {...webviewAttrs}
          />
          {status === 'loading' && (
            <div className="ws-overlay">
              <div className="ws-spinner" />
              <p>Đang tải {name}…</p>
            </div>
          )}
          {status === 'failed' && (
            <div className="ws-overlay">
              <div className="ws-overlay-ico">🔌</div>
              <h3>Không tải được</h3>
              <p className="ws-muted">{failInfo}</p>
              <button className="ws-retry" onClick={retry}>Thử lại</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
