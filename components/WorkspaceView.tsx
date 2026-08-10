'use client';

// Browser Workspace Framework — single-workspace view.
//
// Renders ONE plugin as a real Electron <webview> guest plus a thin toolbar
// (back / forward / reload / home / devtools / logout / open-external) and the
// loading / failed / crashed overlays. It is plugin-agnostic: everything it
// shows comes from the passed-in `plugin` declaration and `config`. No Zalo
// specifics live here.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BrandMark from './BrandMark';
import { menuFor } from '@/lib/workspace/plugins';
import type { WebviewElement, WorkspaceConfig, WorkspacePlugin } from '@/lib/workspace/types';
import { type WorkspaceAccount, accountKey, partitionForAccount } from '@/lib/workspace/accounts';
import { type AvatarProbe, buildAvatarScript } from '@/lib/workspace/avatar';
import { type CollectResult, buildCollectorScript, captureFlagScript } from '@/lib/workspace/capture';
import { registerGuest } from '@/lib/workspace/guests';
import WorkspaceScan from './WorkspaceScan';

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
  /** Ảnh đại diện tài khoản đọc được trong guest (data URL), để rail hiện mặt
   *  thật thay vì huy hiệu app. Chỉ bắn khi ĐỔI so với lần trước. */
  onAvatar?: (dataUrl: string) => void;
}

// Default unread detector (evaluated inside the guest): parse a leading "(N)"
// from the document title. A plugin can override with plugin.unreadScript when
// its title doesn't carry the count (e.g. Zalo). Kept as a compact expression
// because it is passed to webview.executeJavaScript().
const DEFAULT_UNREAD_EXPR =
  '(function(){try{var m=(document.title||"").match(/\\((\\d+)\\+?\\)/);return m?parseInt(m[1],10):0;}catch(e){return 0;}})()';

/** How often we poll the guest for its unread count (ms). */
const UNREAD_POLL_MS = 3000;

/** Nhịp dò ảnh đại diện khi CHƯA đọc được (chưa đăng nhập / trang chưa dựng).
 *  Đọc được là dừng, nên đây chỉ là nhịp chờ — để thưa cho nhẹ guest. */
const AVATAR_POLL_MS = 15000;

export default function WorkspaceView({
  plugin,
  account,
  config,
  active,
  viewing,
  onUnread,
  capture = false,
  onMessages,
  onAvatar,
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
  const [scanOpen, setScanOpen] = useState(false);
  const autoReloaded = useRef(false);

  // Keep the latest onUnread/viewing without re-subscribing the (mount-once) listeners.
  const onUnreadRef = useRef(onUnread);
  onUnreadRef.current = onUnread;
  const onMessagesRef = useRef(onMessages);
  onMessagesRef.current = onMessages;
  const onAvatarRef = useRef(onAvatar);
  onAvatarRef.current = onAvatar;
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

  /**
   * Đọc ảnh đại diện tài khoản trong guest, đẩy ra rail.
   *
   * Nhịp CHẬM (AVATAR_POLL_MS) chứ không đi ké nhịp đếm tin: ảnh đại diện gần
   * như không đổi, mà mỗi lần đọc là một lượt fetch trong trang của người ta —
   * chạy 3 giây một lần thì phí. Đọc được rồi thì dừng hẳn, chỉ bật lại khi
   * guest điều hướng (đăng nhập tài khoản khác, hoặc vừa đổi ảnh).
   *
   * Hụt thì log ra console host kèm LÝ DO + số phần tử mỗi selector khớp. Đây
   * là thứ duy nhất chỉnh được selector cho một trang mình không kiểm soát:
   * không có nó thì "không lên ảnh" là một hộp đen.
   */
  useEffect(() => {
    const el = ref.current;
    if (!plugin.avatar) return;
    if (!el) return;
    const expr = buildAvatarScript(plugin.avatar);
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const read = () => {
      if (stopped) return;
      let p: Promise<unknown> | undefined;
      try {
        p = el.executeJavaScript(expr, false);
      } catch {
        return; // guest chưa gắn
      }
      const done = (dataUrl: string) => {
        if (stopped) return;
        onAvatarRef.current?.(dataUrl);
        // Có ảnh rồi thì thôi đọc — 'did-navigate' bên dưới sẽ bật lại.
        if (timer) clearInterval(timer);
        timer = undefined;
      };
      const miss = (probe: unknown) => {
        // eslint-disable-next-line no-console
        console.debug('[ws:avatar] chưa lấy được', plugin.id, account.instanceId, probe);
      };

      p?.then(async (raw) => {
        if (stopped) return;
        const probe = raw as AvatarProbe | null;
        if (probe?.ok && probe.dataUrl?.startsWith('data:image/')) {
          done(probe.dataUrl);
          return;
        }
        // Tìm thấy avatar nhưng guest không tải nổi (CORS) — nhờ main process.
        if (probe?.why === 'need-fetch' && probe.src) {
          const r = await window.workspace?.fetchImage?.(partition, probe.src);
          if (stopped) return;
          if (r?.ok && r.dataUrl?.startsWith('data:image/')) {
            done(r.dataUrl);
            return;
          }
          miss({ ...probe, fetchError: r?.error ?? 'bridge thiếu fetchImage' });
          return;
        }
        miss(probe);
      }).catch(() => {
        /* đang điều hướng / mất kết nối — bỏ nhịp này */
      });
    };

    const start = () => {
      if (stopped) return;
      if (timer) clearInterval(timer);
      read();
      timer = setInterval(read, AVATAR_POLL_MS);
    };

    // Chưa đăng nhập thì không có ảnh — đăng nhập xong trang điều hướng, đó là
    // lúc đọc lại. Cũng bắt luôn ca đổi ảnh rồi F5.
    const first = setTimeout(start, 2500); // đợi trang dựng xong
    el.addEventListener('did-navigate', start);
    el.addEventListener('did-navigate-in-page', start);
    return () => {
      stopped = true;
      clearTimeout(first);
      if (timer) clearInterval(timer);
      el.removeEventListener('did-navigate', start);
      el.removeEventListener('did-navigate-in-page', start);
    };
  }, [plugin.avatar, plugin.id, account.instanceId, partition]);

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

  // Publish this guest so code OUTSIDE the workspace tree (directory sync, and
  // later the automation send action) can run script in it. Re-registered when
  // the label or readiness changes so callers never act on a stale snapshot.
  const key = accountKey(plugin.id, account.instanceId);
  useEffect(
    () =>
      registerGuest({
        accountKey: key,
        pluginId: plugin.id,
        instanceId: account.instanceId,
        label: account.label,
        ready: status === 'ready',
        exec: (script: string, userGesture = false) => {
          const el = ref.current;
          if (!el) return Promise.reject(new Error('guest chưa gắn'));
          try {
            return el.executeJavaScript(script, userGesture) as Promise<unknown>;
          } catch (e) {
            return Promise.reject(e as Error);
          }
        },
        pressKey: async (keyCode: string) => {
          // PRIMARY: main process injects the key into this guest's webContents.
          const bridge = window.workspace as unknown as {
            sendKey?: (
              partition: string,
              keyCode: string,
            ) => Promise<{ ok: boolean; focused?: boolean; error?: string }>;
          };
          if (bridge?.sendKey) {
            const r = await bridge.sendKey(partition, keyCode);
            if (r?.ok) return { ...r, via: 'main' };
            // fall through to the element path on failure
          }
          const el = ref.current as unknown as {
            focus?: () => void;
            sendInputEvent?: (e: Record<string, unknown>) => void;
          } | null;
          if (!el?.sendInputEvent) return { ok: false, error: 'không gửi được phím vào guest', via: 'none' };
          try {
            el.focus?.();
          } catch {
            /* focus is best-effort */
          }
          el.sendInputEvent({ type: 'keyDown', keyCode });
          el.sendInputEvent({ type: 'char', keyCode });
          el.sendInputEvent({ type: 'keyUp', keyCode });
          return { ok: true, via: 'element' };
        },
      }),
    [key, account.label, plugin.id, account.instanceId, status],
  );

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

  /**
   * Menu điều hướng nhanh (hiện chỉ Facebook khai): đi tới một trang trong CÙNG
   * guest — không mở tab mới, không dựng lại webview — nên phiên đăng nhập và
   * cả trạng thái cuộn của app đều còn nguyên.
   *
   * Mục khai đường dẫn tương đối thì nối vào origin của plugin; khai URL tuyệt
   * đối thì đi thẳng tới đó (Facebook ↔ Messenger là hai miền dùng chung phiên
   * Meta, xem WORKSPACE_MENUS). Cả hai đều qua `new URL(path, plugin.url)`.
   */
  const menu = useMemo(() => menuFor(plugin.id), [plugin.id]);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Bấm ra ngoài / Esc → đóng menu, như mọi dropdown khác.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const goTo = useCallback(
    (p: string) => {
      setMenuOpen(false);
      try {
        ref.current?.loadURL(new URL(p, plugin.url).toString());
      } catch {
        /* guest chưa gắn — bỏ qua, người dùng bấm lại được */
      }
    },
    [plugin.url],
  );

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
          {menu.length > 0 && (
            <div className="ws-menu" ref={menuRef}>
              <button
                className={menuOpen ? 'is-on' : ''}
                onClick={() => setMenuOpen((v) => !v)}
                title={`Các trang ${plugin.name}`}
              >
                ☰
              </button>
              {menuOpen && (
                <div className="ws-menu-pop">
                  {menu.map((m) => (
                    <button
                      key={m.path}
                      className={`ws-menu-item${m.divider ? ' has-div' : ''}`}
                      onClick={() => goTo(m.path)}
                    >
                      <span className="ws-menu-ico">{m.icon}</span>
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="ws-title">
          <BrandMark plugin={plugin} size={16} />
          <span className={`ws-dot ws-dot--${status}`} />
          <span className="ws-title-text">{title}</span>
        </div>

        <div className="ws-actions">
          {plugin.directory && (
            <button
              className={scanOpen ? 'is-on' : ''}
              onClick={() => setScanOpen((v) => !v)}
              title="Quét danh sách hội thoại — dựng danh bạ đích gửi"
            >
              🔎
            </button>
          )}
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

        {scanOpen && plugin.directory && (
          <WorkspaceScan
            accountKey={key}
            accountLabel={account.label}
            spec={plugin.directory}
            labelSpec={plugin.labels}
            onClose={() => setScanOpen(false)}
          />
        )}

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
