'use client';

// Browser Workspace Framework — single-workspace view.
//
// Renders ONE plugin as a real Electron <webview> guest plus a thin toolbar
// (back / forward / reload / home / devtools / logout / open-external) and the
// loading / failed / crashed overlays. It is plugin-agnostic: everything it
// shows comes from the passed-in `plugin` declaration and `config`. No Zalo
// specifics live here.

import { useCallback, useEffect, useRef, useState } from 'react';
import BrandMark from './BrandMark';
import type { WebviewElement, WorkspaceConfig, WorkspacePlugin } from '@/lib/workspace/types';
import { type WorkspaceAccount, partitionForAccount } from '@/lib/workspace/accounts';
import { type CollectResult, buildCollectorScript, captureFlagScript } from '@/lib/workspace/capture';

type Status = 'loading' | 'ready' | 'failed' | 'crashed';

interface Props {
  plugin: WorkspacePlugin;
  /** Which account of the plugin this view hosts. */
  account: WorkspaceAccount;
  config: WorkspaceConfig;
  /** Whether this account is the selected one in the rail (drives which view shows). */
  active: boolean;
  /** Whether the user is actually LOOKING at this account: Workspace tab visible
   *  AND this account selected. Only this clears/suppresses its unread state. */
  viewing: boolean;
  /** Report the unread count parsed from the page title (0 = none). */
  onUnread?: (count: number) => void;
  /**
   * Automation: record message CONTENT inside the guest. Off → the collector
   * still counts unread but stores no text at all (see lib/workspace/capture).
   */
  capture?: boolean;
  /** Messages collected since the previous poll (only when `capture` is on). */
  onMessages?: (batch: CollectResult['m']) => void;
}

// Default unread detector (evaluated inside the guest): parse a leading "(N)"
// from the document title. A plugin can override with plugin.unreadScript when
// its title doesn't carry the count (e.g. Zalo). Kept as a compact expression
// because it is passed to webview.executeJavaScript().
const DEFAULT_UNREAD_EXPR =
  '(function(){try{var m=(document.title||"").match(/\\((\\d+)\\+?\\)/);return m?parseInt(m[1],10):0;}catch(e){return 0;}})()';

/** How often we poll the guest for its unread count (ms). */
const UNREAD_POLL_MS = 3000;

export default function WorkspaceView({
  plugin,
  account,
  config,
  active,
  viewing,
  onUnread,
  capture = false,
  onMessages,
}: Props) {
  const ref = useRef<WebviewElement | null>(null);
  const partition = partitionForAccount(plugin, account.instanceId, config);

  // <webview> string attributes. React's typings mark allowpopups as boolean,
  // but the Electron webview tag needs the literal string "true" on the DOM —
  // spread them untyped so runtime gets strings without a React attr warning.
  const webviewAttrs: Record<string, string> = { allowpopups: 'true' };
  if (plugin.userAgent) webviewAttrs.useragent = plugin.userAgent;

  const [status, setStatus] = useState<Status>('loading');
  const [title, setTitle] = useState(account.label);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [failInfo, setFailInfo] = useState<string>('');
  const autoReloaded = useRef(false);

  // Keep the latest onUnread/viewing without re-subscribing the (mount-once) listeners.
  const onUnreadRef = useRef(onUnread);
  onUnreadRef.current = onUnread;
  const onMessagesRef = useRef(onMessages);
  onMessagesRef.current = onMessages;
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;

  // Attach webview event listeners once the element exists.
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

    const onStartLoading = () => setStatus((s) => (s === 'crashed' ? s : 'loading'));
    const onStopLoading = () => {
      setStatus((s) => (s === 'failed' || s === 'crashed' ? s : 'ready'));
      syncNav();
    };
    const onDomReady = () => {
      setStatus('ready');
      syncNav();
    };
    const onTitle = (e: Event) => {
      const t = (e as unknown as { title?: string }).title;
      if (t) setTitle(t); // toolbar label only; unread comes from the poll below
    };
    const onNavigate = () => syncNav();
    const onFailLoad = (e: Event) => {
      const ev = e as unknown as { errorCode: number; errorDescription: string; isMainFrame: boolean };
      if (!ev.isMainFrame || ev.errorCode === -3 /* ABORTED */) return;
      setFailInfo(`${ev.errorDescription || 'Network error'} (${ev.errorCode})`);
      setStatus('failed');
    };
    const onGone = () => {
      setStatus('crashed');
      // Recover automatically once; a repeat crash needs the user's attention.
      if (!autoReloaded.current) {
        autoReloaded.current = true;
        setTimeout(() => {
          try {
            el.reload();
          } catch {
            /* ignore */
          }
        }, 800);
      }
    };

    // Auxiliary new-message signal: chat apps play a short sound when a message
    // arrives, which fires media-started-playing on the guest. For a workspace
    // the user is NOT currently viewing, push a bump into the page-side counter
    // (__wsNoti) so the regular unread poll — the single source of truth —
    // reports it. Viewing the workspace resets the counter anyway.
    const onMediaPlay = () => {
      if (viewingRef.current) return;
      try {
        void el.executeJavaScript('window.__wsNoti=(window.__wsNoti||0)+1;', false);
      } catch {
        /* not attached yet */
      }
    };

    el.addEventListener('did-start-loading', onStartLoading);
    el.addEventListener('did-stop-loading', onStopLoading);
    el.addEventListener('dom-ready', onDomReady);
    el.addEventListener('page-title-updated', onTitle as EventListener);
    el.addEventListener('did-navigate', onNavigate);
    el.addEventListener('did-navigate-in-page', onNavigate);
    el.addEventListener('did-fail-load', onFailLoad as EventListener);
    el.addEventListener('render-process-gone', onGone);
    el.addEventListener('media-started-playing', onMediaPlay);

    // The whole Workspace panel is hidden with display:none when another DevBox
    // tab is active, so this <webview> is sized 0×0 while mounted. Electron then
    // gives the guest a wrong (too-wide) viewport and does NOT reliably resize it
    // when the panel reappears — the guest renders wider than its box and its
    // right edge is clipped (cut-off chat). When the element resizes to a real
    // width (panel shown / window resized), nudge the element size so Electron
    // re-fits the guest, and log the sizes once for diagnosis.
    let lastW = 0;
    let nudging = false;
    const ro = new ResizeObserver((entries) => {
      if (nudging) return;
      const w = Math.round(entries[0].contentRect.width);
      if (w === 0 || w === lastW) return;
      lastW = w;
      try {
        void el.executeJavaScript(
          'console.log("[ws-size] el=' + w + ' win=' + window.innerWidth + ' guest="+innerWidth+" dpr="+devicePixelRatio)',
          false,
        );
      } catch {
        /* not attached yet */
      }
      // Force a distinct size then restore CSS sizing → two resize events make
      // Electron recompute the guest's viewport to match the visible box.
      nudging = true;
      const prev = el.style.width;
      el.style.width = w - 1 + 'px';
      setTimeout(() => {
        el.style.width = prev;
        setTimeout(() => {
          nudging = false;
        }, 0);
      }, 60);
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      el.removeEventListener('did-start-loading', onStartLoading);
      el.removeEventListener('did-stop-loading', onStopLoading);
      el.removeEventListener('dom-ready', onDomReady);
      el.removeEventListener('page-title-updated', onTitle as EventListener);
      el.removeEventListener('did-navigate', onNavigate);
      el.removeEventListener('did-navigate-in-page', onNavigate);
      el.removeEventListener('did-fail-load', onFailLoad as EventListener);
      el.removeEventListener('render-process-gone', onGone);
      el.removeEventListener('media-started-playing', onMediaPlay);
    };
  }, []);

  // ONE poll drives everything the guest can tell us: the unread count and the
  // messages captured since the last tick. We read it straight from the page
  // rather than relying on page-title-updated — that never fires if the title
  // stays constant. Works for hidden guests too (backgroundThrottling is off).
  //
  //   plugin.unreadScript → raw escape hatch, returns a number
  //   plugin.capture      → the shared collector, returns { u, m }
  //   neither             → "(N)" from the document title
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const expr = plugin.unreadScript ?? (plugin.capture ? buildCollectorScript(plugin.capture) : DEFAULT_UNREAD_EXPR);
    let stopped = false;

    const poll = () => {
      if (stopped) return;
      let p: Promise<unknown> | undefined;
      try {
        p = el.executeJavaScript(expr, false);
      } catch {
        return; // guest not attached yet
      }
      p?.then((raw) => {
        // Both shapes are accepted so a plugin can use either collector.
        const res = typeof raw === 'number' ? { u: raw, m: [] } : (raw as CollectResult | null);
        const n = Number.isFinite(res?.u) ? Math.max(0, Math.floor(res!.u)) : 0;
        onUnreadRef.current?.(n);
        const batch = Array.isArray(res?.m) ? res!.m : [];
        if (batch.length) onMessagesRef.current?.(batch);
      }).catch(() => {
        /* navigating / detached — ignore this tick */
      });
    };

    const first = setTimeout(poll, 1500); // let the page settle after mount
    const timer = setInterval(poll, UNREAD_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [plugin.unreadScript, plugin.capture]);

  // Push the privacy switch into the page. A guest reloads on its own (and the
  // flag is a plain page global), so re-assert it on every poll interval too —
  // cheap, and it guarantees "capture off" really means off after a reload.
  useEffect(() => {
    const el = ref.current;
    if (!el || !plugin.capture) return;
    const apply = () => {
      try {
        void el.executeJavaScript(captureFlagScript(capture), false);
      } catch {
        /* guest not attached yet */
      }
    };
    apply();
    const timer = setInterval(apply, UNREAD_POLL_MS);
    el.addEventListener('dom-ready', apply);
    return () => {
      clearInterval(timer);
      el.removeEventListener('dom-ready', apply);
    };
  }, [capture, plugin.capture]);

  // Actually viewing an account (tab visible + selected) clears its
  // notification-based unread: reset the in-page counter the unread script
  // accumulates, and report 0 immediately so the rail badge + tab bell drop
  // without waiting for the next poll. A genuine unread still in the DOM will
  // be re-reported on the next tick. Mere selection while the user works on
  // another DevBox tab must NOT clear anything.
  useEffect(() => {
    if (!viewing) return;
    const el = ref.current;
    if (!el) return;
    try {
      void el.executeJavaScript('window.__wsNoti=0;window.__wsU=0;', false);
    } catch {
      /* guest not attached yet */
    }
    onUnreadRef.current?.(0);
  }, [viewing]);

  const retry = useCallback(() => {
    autoReloaded.current = false;
    setStatus('loading');
    setFailInfo('');
    try {
      ref.current?.loadURL(plugin.url);
    } catch {
      ref.current?.reload();
    }
  }, [plugin.url]);

  const logout = useCallback(async () => {
    if (!window.workspace) return;
    const res = await window.workspace.clearSession(partition);
    if (res.ok) {
      autoReloaded.current = false;
      setStatus('loading');
      try {
        ref.current?.reloadIgnoringCache();
      } catch {
        /* ignore */
      }
    }
  }, [partition]);

  const openExternal = useCallback(() => {
    let url = plugin.url;
    try {
      url = ref.current?.getURL() || plugin.url;
    } catch {
      /* ignore */
    }
    window.open(url, '_blank');
  }, [plugin.url]);

  return (
    <div
      className="ws-view"
      // Non-selected views move OFFSCREEN (not display:none — that zero-sizes
      // the guest; not visibility — a <webview>'s native layer ignores ancestor
      // visibility and would paint over the selected account). Offscreen keeps
      // the guest alive, sanely sized and truly invisible.
      style={
        active
          ? { display: 'flex' }
          : {
              display: 'flex',
              position: 'fixed',
              top: 0,
              left: '-150vw',
              width: '90vw',
              height: '85vh',
              pointerEvents: 'none',
            }
      }
    >
      <div className="ws-toolbar">
        <div className="ws-nav">
          <button onClick={() => ref.current?.goBack()} disabled={!canBack} title="Quay lại">
            ←
          </button>
          <button onClick={() => ref.current?.goForward()} disabled={!canForward} title="Tiến tới">
            →
          </button>
          <button onClick={() => ref.current?.reload()} title="Tải lại">
            ⟳
          </button>
          <button onClick={() => ref.current?.loadURL(plugin.url)} title="Trang chủ">
            ⌂
          </button>
        </div>

        <div className="ws-title">
          <BrandMark plugin={plugin} size={16} />
          <span className={`ws-dot ws-dot--${status}`} />
          <span className="ws-title-text">{title}</span>
        </div>

        <div className="ws-actions">
          {config.enableDevTools && (
            <button onClick={() => ref.current?.openDevTools()} title="DevTools">
              ⚙
            </button>
          )}
          <button onClick={openExternal} title="Mở bằng trình duyệt ngoài">
            ↗
          </button>
          <button onClick={logout} title="Đăng xuất — xoá phiên trên máy này">
            ⎋
          </button>
        </div>
      </div>

      <div className="ws-canvas">
        {/* partition MUST be an initial attribute — it cannot change after attach. */}
        <webview
          ref={ref as unknown as React.Ref<HTMLElement>}
          className="ws-webview"
          src={plugin.url}
          partition={partition}
          {...webviewAttrs}
        />

        {status === 'loading' && (
          <div className="ws-overlay">
            <div className="ws-spinner" />
            <p>Đang tải {plugin.name}…</p>
          </div>
        )}

        {status === 'failed' && (
          <div className="ws-overlay">
            <div className="ws-overlay-ico">🔌</div>
            <h3>Không tải được {plugin.name}</h3>
            <p className="ws-muted">{failInfo}</p>
            <button className="ws-retry" onClick={retry}>
              Thử lại
            </button>
          </div>
        )}

        {status === 'crashed' && (
          <div className="ws-overlay">
            <div className="ws-overlay-ico">💥</div>
            <h3>{plugin.name} bị treo</h3>
            <p className="ws-muted">Đang tự khởi động lại…</p>
            <button className="ws-retry" onClick={retry}>
              Tải lại ngay
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
