'use client';

// MinIO Console ngay trong tab, đã đăng nhập sẵn.
//
// Console có đăng nhập riêng (cổng 9001) nên mở bằng link là phải gõ lại key dù
// DevBox đã giữ sẵn. Ở đây:
//   1. SERVER đăng nhập hộ (POST /api/v1/login bằng key đã lưu) và chỉ trả về
//      cookie phiên — secret không bao giờ xuống trình duyệt.
//   2. Cookie được nạp vào một <webview> có partition riêng của server này, rồi
//      tải lại: Console thấy phiên hợp lệ và vào thẳng giao diện quản trị.
// Dùng <webview> (chỉ có ở app desktop) vì Console gửi X-Frame-Options nên <iframe>
// bị chặn. Bản chạy trên trình duyệt thường thì rơi về nút mở link.

import { useCallback, useEffect, useRef, useState } from 'react';
import { minioConsoleLogin, type PublicMinioConnection } from '@/lib/minio';

interface WebviewEl extends HTMLElement {
  executeJavaScript(code: string): Promise<unknown>;
  loadURL(url: string): Promise<void>;
  reloadIgnoringCache(): void;
  openDevTools(): void;
  getURL(): string;
  getTitle(): string;
}

type Phase = 'login' | 'loading' | 'ready' | 'error';

export default function ConsoleView({ conn }: { conn: PublicMinioConnection }) {
  const desktop = typeof window !== 'undefined' && !!(window as unknown as { workspace?: { isDesktop?: boolean } }).workspace?.isDesktop;
  const consoleUrl = conn.consoleUrl ?? '';
  const [phase, setPhase] = useState<Phase>('login');
  const [error, setError] = useState<string | null>(null);
  const [src, setSrc] = useState('');
  /** URL + tiêu đề trang khung đang hiển thị — để thấy ngay nó đang ở đâu khi nghi trắng/kẹt. */
  const [where, setWhere] = useState('');
  const wv = useRef<WebviewEl | null>(null);
  /** Cookie phiên đang chờ nạp khi webview tải xong lần đầu (trang đăng nhập). */
  const pending = useRef<{ name: string; value: string }[] | null>(null);
  const attached = useRef(false);
  /** Đã nạp cookie + chuyển hướng chưa — chặn vòng lặp nạp lại ở mỗi lần dom-ready. */
  const injected = useRef(false);

  const login = useCallback(async () => {
    setPhase('login');
    setError(null);
    injected.current = false;
    try {
      const s = await minioConsoleLogin(conn.id);
      pending.current = s.cookies;
      if (!src) setSrc(s.url);          // lần đầu: gắn webview vào
      else if (wv.current) void wv.current.loadURL(s.url).catch(() => {});  // đăng nhập lại: về trang gốc rồi nạp
      setPhase('loading');
    } catch (e) {
      setError((e as Error).message);
      setPhase('error');
    }
  }, [conn.id, src]);

  useEffect(() => { void login(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [conn.id]);

  // dom-ready của webview: lần đầu là trang đăng nhập của Console → nạp cookie phiên
  // rồi tải lại; các lần sau (người dùng điều hướng trong Console) để yên.
  useEffect(() => {
    const el = wv.current;
    if (!el || !src) return;
    const onReady = () => {
      if (injected.current || !pending.current) { setPhase('ready'); return; }
      const cookies = pending.current;
      injected.current = true;
      const js = cookies
        .map((c) => `document.cookie = ${JSON.stringify(`${c.name}=${c.value}; path=/; SameSite=Lax`)};`)
        .join('\n');
      el.executeJavaScript(js)
        .then(() => { pending.current = null; return el.loadURL(src); })
        .catch(() => { setError('Không nạp được phiên đăng nhập vào khung Console'); setPhase('error'); });
    };
    const onFail = (ev: Event) => {
      const e = ev as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean };
      if (e.isMainFrame === false || e.errorCode === -3) return; // -3 = bị huỷ bởi điều hướng tiếp theo
      setError(`Không tải được Console: ${e.errorDescription ?? 'lỗi mạng'} (${consoleUrl})`);
      setPhase('error');
    };
    const onNav = () => {
      try { setWhere(`${el.getURL()}${el.getTitle() ? ` · ${el.getTitle()}` : ''}`); } catch { /* guest chưa sẵn sàng */ }
    };
    el.addEventListener('dom-ready', onReady);
    el.addEventListener('did-fail-load', onFail);
    el.addEventListener('did-navigate', onNav);
    el.addEventListener('did-navigate-in-page', onNav);
    el.addEventListener('page-title-updated', onNav);
    attached.current = true;
    return () => {
      el.removeEventListener('dom-ready', onReady);
      el.removeEventListener('did-fail-load', onFail);
      el.removeEventListener('did-navigate', onNav);
      el.removeEventListener('did-navigate-in-page', onNav);
      el.removeEventListener('page-title-updated', onNav);
    };
  }, [src, consoleUrl]);

  if (!consoleUrl) {
    return <p className="empty">Server này chưa khai <b>Console URL</b> — sửa server và điền địa chỉ Console (IP:port hoặc domain).</p>;
  }

  if (!desktop) {
    return (
      <p className="empty" style={{ textAlign: 'left' }}>
        Khung Console nhúng chỉ chạy trong <b>app desktop</b> (trình duyệt thường bị Console chặn nhúng bằng X-Frame-Options).{' '}
        <a href={consoleUrl} target="_blank" rel="noreferrer">Mở Console ↗</a>
      </p>
    );
  }

  const partition = `persist:minio-console-${conn.id.replace(/[^a-z0-9-]/gi, '-')}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: 6 }}>
      <div className="status-line" style={{ gap: 8 }}>
        <span className="small" style={{ color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={consoleUrl}>
          {phase === 'login' && <><span className="spinner" /> Đang đăng nhập Console…</>}
          {phase === 'loading' && <><span className="spinner" /> Đang tải Console…</>}
          {phase === 'ready' && <>🖥 {where || consoleUrl} · đã đăng nhập bằng key đã lưu</>}
          {phase === 'error' && <span style={{ color: 'var(--err)' }}>Chưa vào được Console</span>}
        </span>
        <button className="chip-btn" onClick={() => wv.current?.reloadIgnoringCache()} disabled={!src} title="Tải lại trang Console">↻</button>
        <button className="chip-btn" onClick={() => wv.current?.openDevTools()} disabled={!src} title="Mở DevTools của khung Console (để soi lỗi khi trang trắng)">🛠</button>
        <button className="chip-btn" onClick={() => void login()} title="Đăng nhập lại bằng key đã lưu (khi phiên hết hạn)">🔑 Đăng nhập lại</button>
        <a className="chip-btn" href={consoleUrl} target="_blank" rel="noreferrer" title="Mở Console ở trình duyệt ngoài">↗</a>
      </div>
      {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: 0 }}>{error}</pre>}
      <div className="ws-canvas" style={{ minHeight: 'max(420px, calc(100vh - 240px))' }}>
        {src && (
          <webview
            ref={wv as unknown as React.Ref<HTMLElement>}
            className="ws-webview"
            src={src}
            partition={partition}
          />
        )}
      </div>
    </div>
  );
}
