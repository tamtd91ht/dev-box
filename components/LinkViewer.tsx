'use client';

// In-app viewer for the Links tab — mở một link bất kỳ (Jenkins, Rancher,
// Google Docs, …) trong Electron <webview> thay vì nhảy ra browser ngoài.
// Desktop-shell only; caller fallback window.open khi không có window.workspace.
//
// Session: partition truyền từ ngoài theo PROFILE của link (lib/links.ts →
// partitionFor). Login user/pass một lần trong khung là cookie lưu bền cho cả
// nhóm link cùng profile; "Logout" (⎋) chỉ xóa phiên của profile đó.
//
// Tổng quát hóa từ GoogleDocViewer (tab Google giữ viewer riêng cho Drive) —
// khác biệt: partition động + không có hint đăng nhập Google.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebviewElement } from '@/lib/workspace/types';

// Nhiều trang (Google sign-in, một số SSO) chặn "embedded browser" bằng cách
// sniff UA có token Electron/app-name — trình mình đúng là Chrome bên dưới.
const CHROME_UA =
  typeof navigator === 'undefined'
    ? undefined
    : navigator.userAgent.replace(/ vhs-dev-box\/[\d.]+/i, '').replace(/ Electron\/[\d.]+/i, '');

type Status = 'loading' | 'ready' | 'failed';

interface Props {
  /** Display name for the toolbar. */
  name: string;
  url: string;
  /** Session partition — persist:links-<profile> (see partitionFor). */
  partition: string;
  onClose: () => void;
  /** Lưu URL đang xem vào registry. Ẩn nút khi absent. */
  onSaveLink?: (name: string, url: string) => Promise<void>;
  /** Tab nền trong chế độ nhiều tab: đẩy offscreen (webview vẽ ở native layer
   *  nên visibility:hidden không ăn), tắt Esc — chỉ tab nổi nhận Esc. */
  hidden?: boolean;
  /** Tài khoản site đã lưu theo link — nút 🔑 tự điền vào form login. */
  creds?: { username?: string; password?: string };
}

export default function LinkViewer({ name, url, partition, onClose, onSaveLink, hidden, creds }: Props) {
  const ref = useRef<WebviewElement | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [failInfo, setFailInfo] = useState('');
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const syncNav = () => {
      try {
        setCanBack(el.canGoBack());
        setCanForward(el.canGoForward());
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

  // Electron bug: hủy <webview> đang giữ focus xong host vẫn tưởng guest giữ
  // focus → mọi input "chết". Khi viewer unmount, kéo focus về host.
  useEffect(() => () => {
    void window.workspace?.focusHost?.().catch(() => {});
  }, []);

  // Esc đóng viewer (phím trong guest không bubble ra host). Tab nền bỏ qua.
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, hidden]);

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

  const logout = useCallback(async () => {
    if (!window.workspace) return;
    const prof = partition.replace(/^persist:links-/, '');
    if (!window.confirm(`Đăng xuất phiên "${prof}" trên máy này? (xóa cookie/storage của các link dùng profile này)`)) return;
    const res = await window.workspace.clearSession(partition);
    if (res.ok) {
      setStatus('loading');
      try {
        ref.current?.reloadIgnoringCache();
      } catch {
        /* ignore */
      }
    }
  }, [partition]);

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

  /** Điền username/password đã lưu vào form login của trang trong guest.
   *  Set value qua native setter + bắn event input/change để React/Angular
   *  (Rancher, Jenkins…) nhận giá trị như gõ tay. */
  const fillLogin = useCallback(async () => {
    if (!creds?.username && !creds?.password) return;
    const code = `(() => {
      const set = (el, v) => {
        if (!el || v == null) return;
        const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        d.set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const pw = document.querySelector('input[type=password]');
      const texts = [...document.querySelectorAll('input')].filter((i) =>
        ['text','email','tel',''].includes((i.type||'').toLowerCase()) && i.offsetParent);
      const user = texts.find((i) => /user|email|login|name/i.test(i.name + i.id + (i.placeholder||''))) || texts[0];
      set(user, ${JSON.stringify(creds.username ?? null)});
      set(pw, ${JSON.stringify(creds.password ?? null)});
      return pw ? 'ok' : 'no-password-field';
    })()`;
    try {
      const r = await ref.current?.executeJavaScript(code, true);
      if (r === 'no-password-field') window.alert('Không thấy ô password trên trang này — mở đúng trang login rồi bấm 🔑 lại.');
    } catch (e) {
      window.alert('Không điền được: ' + (e as Error).message);
    }
  }, [creds]);

  const webviewAttrs: Record<string, string> = { allowpopups: 'true' };
  if (CHROME_UA) webviewAttrs.useragent = CHROME_UA;

  return (
    <div
      className="g-viewer"
      style={hidden ? { left: '-200vw', right: 'auto', width: '100%', pointerEvents: 'none' } : undefined}
    >
      <div className="ws-view" style={{ display: 'flex' }}>
        <div className="ws-toolbar">
          <div className="ws-nav">
            <button onClick={() => ref.current?.goBack()} disabled={!canBack} title="Quay lại">←</button>
            <button onClick={() => ref.current?.goForward()} disabled={!canForward} title="Tiến tới">→</button>
            <button onClick={() => ref.current?.reload()} title="Tải lại">⟳</button>
          </div>
          <div className="ws-title">
            <span className={`ws-dot ws-dot--${status === 'failed' ? 'loading' : status}`} />
            <span className="ws-title-text" title={`${name} · phiên ${partition.replace(/^persist:links-/, '')}`}>{name}</span>
          </div>
          <div className="ws-actions">
            <button
              onClick={() => { setStatus('loading'); void ref.current?.loadURL('https://accounts.google.com/'); }}
              title="Đăng nhập Google trong khung này (phiên của profile hiện tại)"
            >
              Ⓖ
            </button>
            {onSaveLink && (
              <button onClick={() => void saveLink()} disabled={saveState === 'saving'}
                title="Lưu link đang xem vào danh sách">
                {saveState === 'done' ? '✓' : '💾'}
              </button>
            )}
            {(creds?.username || creds?.password) && (
              <button onClick={() => void fillLogin()} title="Điền username/password đã lưu vào form login">🔑</button>
            )}
            <button
              onClick={() => { try { ref.current?.openDevTools(); } catch { /* guest chưa sẵn sàng */ } }}
              title="DevTools của trang đang xem (Network/Console/Elements) — hoặc F12 / chuột phải → Inspect ngay trong trang"
            >
              🔧
            </button>
            <button onClick={openExternal} title="Mở bằng trình duyệt ngoài">↗</button>
            <button onClick={() => void logout()} title="Đăng xuất phiên của profile này">⎋</button>
            <button onClick={onClose} title="Đóng (Esc)">✕</button>
          </div>
        </div>

        <div className="ws-canvas">
          {/* partition MUST be an initial attribute — it cannot change after
              attach; caller remounts (key) khi đổi profile. */}
          <webview
            ref={ref as unknown as React.Ref<HTMLElement>}
            className="ws-webview"
            src={url}
            partition={partition}
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
