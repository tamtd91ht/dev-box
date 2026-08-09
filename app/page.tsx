'use client';

// VHS DevBox — infra toolbox shell. Forked from an internal all-in-one toolbox with the
// API Explorer and the Telegram review bot removed: this build is the
// company-wide datastore/broker manager (Webhooks · Git · Redis · Kafka ·
// RabbitMQ · MongoDB · Elastic · PostgreSQL). Each workspace mounts lazily and
// stays mounted (hidden) across tab switches so long-running state survives.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import WebhookReceiver from '@/components/WebhookReceiver';
import ApiExplorerWorkspace, { type IntegrationView } from '@/components/ApiExplorerWorkspace';
import PackManager from '@/components/PackManager';
import GitWorkspace from '@/components/GitWorkspace';
import CodeStudio from '@/components/CodeStudio';
import RedisWorkspace from '@/components/RedisWorkspace';
import KafkaWorkspace from '@/components/KafkaWorkspace';
import RabbitWorkspace from '@/components/RabbitWorkspace';
import MongoWorkspace from '@/components/MongoWorkspace';
import EsWorkspace from '@/components/EsWorkspace';
import PgWorkspace from '@/components/PgWorkspace';
import OfficeWorkspace from '@/components/OfficeWorkspace';
import GoogleWorkspace from '@/components/GoogleWorkspace';
import MailWorkspace from '@/components/MailWorkspace';
import LinksWorkspace from '@/components/LinksWorkspace';
import AppsWorkspace from '@/components/AppsWorkspace';
import ToolsWorkspace from '@/components/ToolsWorkspace';
import ApiWorkspace from '@/components/ApiWorkspace';
import BrowserTabWorkspace from '@/components/BrowserTabWorkspace';
import BrowserWorkspace from '@/components/BrowserWorkspace';
import RemoteWorkspace from '@/components/RemoteWorkspace';
import AutomationWorkspace from '@/components/automation/AutomationWorkspace';
import AutomationHost from '@/components/AutomationHost';
import GitAutoPullHost from '@/components/GitAutoPullHost';
import MailWatchHost from '@/components/MailWatchHost';
import WorkWorkspace from '@/components/WorkWorkspace';
import WorkAlertHost from '@/components/WorkAlertHost';
import ConvertHost from '@/components/ConvertHost';
import OpenLinkDialog from '@/components/OpenLinkDialog';
import NotificationCenter from '@/components/NotificationCenter';
import QuickTabs, { type TabInfo } from '@/components/QuickTabs';
import UltraBar from '@/components/UltraBar';
import * as recentTabs from '@/lib/recentTabs';
import * as ultraView from '@/lib/ultraView';
import { notices } from '@/lib/noticeStore';
import ThemeToggle from '@/components/ThemeToggle';
import DesktopConsole from '@/components/DesktopConsole';
import ConfigSyncButton from '@/components/ConfigSyncButton';
import { resolveAuth, authReady as isAuthReady } from '@/lib/request';
import {
  fetchFullConfig,
  saveLocalConfig,
  type LocalConfig,
  type GlobalVars,
} from '@/lib/persist';

const DEFAULT_BASE_URL = 'http://localhost:8090';

/** Style for a mounted-and-kept workspace pane. All panes occupy the SAME grid
 *  cell; the inactive ones stay fully laid out but hidden.
 *
 *  Hiding strategy depends on the content:
 *  - Plain HTML panes → `visibility: hidden` (keeps layout + scroll state).
 *  - Panes hosting Electron <webview> guests (`hostsWebviews`) → move OFFSCREEN.
 *    A guest paints in its own native layer which IGNORES ancestor visibility
 *    (it kept covering other tabs) and breaks inside display:none (no layout →
 *    black surface, misfit viewport). Offscreen keeps it alive, full-size and
 *    genuinely invisible. */
function paneStyle(on: boolean, hostsWebviews = false): CSSProperties {
  if (on) return { gridColumn: '1 / -1', gridRow: '1' };
  if (!hostsWebviews) {
    return { gridColumn: '1 / -1', gridRow: '1', visibility: 'hidden', pointerEvents: 'none' };
  }
  return {
    position: 'fixed',
    top: 0,
    left: '-200vw',
    width: '100vw',
    height: '100vh',
    overflow: 'hidden',
    pointerEvents: 'none',
  };
}

/** Chỗ đặt một pane khi ULTRA VIEW đang bật.
 *
 *  Pane đang xem không chiếm trọn bề ngang nữa mà xếp cạnh nhau trong lưới do
 *  `.body[data-ultra]` khai (xem globals.css). Vị trí truyền qua `order` chứ
 *  KHÔNG ghim gridColumn/gridRow: số cột đổi theo bề ngang màn hình (4 khung
 *  tụt xuống 2×2 trên máy hẹp), ghim cứng cột 3–4 thì lúc đó trỏ vào cột không
 *  tồn tại. Có `order` thì thứ tự trái→phải vẫn đúng ở mọi số cột, và CSS tự
 *  lo chuyện xuống hàng.
 *
 *  Pane KHÔNG nằm trong khung nhìn thì giấu y hệt chế độ một tab — nhờ vậy nó
 *  vẫn mount, vẫn giữ kết nối và trạng thái, chỉ là không thấy.
 *
 *  `col < 0` nghĩa là pane không được chọn. */
function ultraPaneStyle(col: number, hostsWebviews = false): CSSProperties {
  if (col >= 0) return { order: col, minWidth: 0 };
  // Pane không được chọn phải RA KHỎI dòng chảy của lưới, nếu không nó vẫn
  // chiếm một ô và đẩy các khung thật sang chỗ khác. Pane thường thì gỡ bằng
  // position:absolute (vẫn có layout, giữ nguyên trạng thái cuộn); pane có
  // <webview> vẫn phải đi offscreen như cũ — xem paneStyle.
  if (hostsWebviews) return paneStyle(false, true);
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    visibility: 'hidden',
    pointerEvents: 'none',
  };
}

/** Default webhook WS URL: derive host from the tool-service base URL, use the
 *  dedicated socket port 9090 + /ws/webhooks. Falls back to localhost. */
function defaultWsUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    const scheme = u.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${u.hostname}:9090/ws/webhooks`;
  } catch {
    return 'ws://localhost:9090/ws/webhooks';
  }
}

/** Default public ingest base: baseUrl + apiPrefix (trailing slashes trimmed). */
function defaultPublicBase(baseUrl: string, apiPrefix: string): string {
  const base = (baseUrl || '').replace(/\/+$/, '');
  const prefix = (apiPrefix || '').trim();
  if (!prefix) return base;
  const p = prefix.startsWith('/') ? prefix : `/${prefix}`;
  return `${base}${p}`.replace(/\/+$/, '');
}

/** Extract host[:port] for comparing two URLs by origin, ignoring path/prefix. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return (url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

/** Resolve the public ingest base — a stored publicBaseUrl override only wins
 *  when it points at a genuinely DIFFERENT host (a dedicated ingress). */
function resolvePublicBase(baseUrl: string, apiPrefix: string, override?: string): string {
  const derived = defaultPublicBase(baseUrl, apiPrefix);
  const ov = (override || '').trim();
  if (!ov) return derived;
  if (hostOf(ov) === hostOf(baseUrl)) return derived;
  return ov.replace(/\/+$/, '');
}

/** Core (project-neutral) tool tabs. Project packs render as their OWN tabs in
 *  the header's "Projects" zone — mode `pack:<id>` — plus ＋ (packs manager). */
type Mode = string;

const TABS: { key: Mode; icon: string; label: string; badge: string }[] = [
  { key: 'work', icon: '📋', label: 'Công việc', badge: 'todo' },
  { key: 'git', icon: '⎇', label: 'Git', badge: 'local' },
  { key: 'code', icon: '⌨', label: 'Code', badge: 'ide' },
  { key: 'redis', icon: '◆', label: 'Redis', badge: 'local' },
  { key: 'kafka', icon: '≋', label: 'Kafka', badge: 'local' },
  { key: 'rabbit', icon: '🐇', label: 'RabbitMQ', badge: 'local' },
  { key: 'mongo', icon: '🍃', label: 'MongoDB', badge: 'local' },
  { key: 'es', icon: '🔍', label: 'Elastic', badge: 'local' },
  { key: 'pg', icon: '🐘', label: 'PostgreSQL', badge: 'local' },
  { key: 'office', icon: '🗂', label: 'Office', badge: 'local' },
  { key: 'google', icon: 'Ⓖ', label: 'Google', badge: 'cloud' },
  { key: 'mail', icon: '✉️', label: 'Mail', badge: 'imap' },
  { key: 'links', icon: '🔗', label: 'Links', badge: 'web' },
  { key: 'browser', icon: '🌐', label: 'Browser', badge: 'web' },
  { key: 'remote', icon: '🖥', label: 'Remote', badge: 'máy' },
  { key: 'apps', icon: '⚙', label: 'Apps', badge: 'run' },
  { key: 'tools', icon: '🧰', label: 'Tools', badge: 'fmt' },
  { key: 'api', icon: '📮', label: 'API', badge: 'http' },
  { key: 'webhooks', icon: '⚡', label: 'Webhooks', badge: 'tool' },
  { key: 'workspace', icon: '🧭', label: 'Workspace', badge: 'browser' },
  { key: 'automation', icon: '🤖', label: 'Automation', badge: 'engine' },
];

type NavPos = 'top' | 'left' | 'right';
const NAV_KEY = 'devbox.navPos';

export default function Home() {
  const [mode, setMode] = useState<Mode>('git');

  // Vị trí thanh menu tính năng: ngang trên (mặc định) / dọc trái / dọc phải.
  // Menu dọc trả nhiều chiều cao cho vùng làm việc — lưu localStorage.
  const [navPos, setNavPos] = useState<NavPos>('top');
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem(NAV_KEY) : null;
    if (saved === 'left' || saved === 'right' || saved === 'top') setNavPos(saved);
  }, []);
  const cycleNav = () => {
    setNavPos((cur) => {
      const next: NavPos = cur === 'top' ? 'left' : cur === 'left' ? 'right' : 'top';
      if (typeof window !== 'undefined') window.localStorage.setItem(NAV_KEY, next);
      return next;
    });
  };

  // ── Tiếp cận nhanh các tab đang làm (Ctrl+`) ────────────────────────────────
  // Ghi nhận tab vừa dùng để nhảy qua nhảy lại: đang ở Kafka, có mail thì qua
  // Mail đọc, xong Ctrl+` (hoặc Ctrl+Tab) là về thẳng Kafka.
  const [quickOpen, setQuickOpen] = useState(false);
  const recents = useSyncExternalStore(
    recentTabs.subscribe, recentTabs.getSnapshot, recentTabs.getServerSnapshot,
  );

  // Chỉ ghi nhận khi ở lại tab đủ lâu — lướt qua để tìm đường thì không tính,
  // nếu không danh sách "vừa dùng" sẽ đầy rác.
  useEffect(() => {
    const t = setTimeout(() => recentTabs.touch(mode), recentTabs.MIN_DWELL_MS);
    return () => clearTimeout(t);
  }, [mode]);

  // Ctrl+` mở màn hình tiếp cận nhanh · Ctrl+Tab về tab trước đó.
  //
  // Chọn phím ` (ngay trên Tab) để hai thao tác cùng một ngón. KHÔNG dùng Ctrl+W
  // (đóng cửa sổ, preventDefault không chặn nổi) và Ctrl+Q (thoát app trên
  // Linux, cả ⌘Q trên macOS — đều ở tầng hệ điều hành, JS chặn không được).
  //
  // Bắt theo e.code='Backquote' chứ không phải e.key: layout AZERTY/JIS cho ra
  // ký tự khác ở đúng vị trí phím đó, dùng e.code thì vẫn đúng ngón.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'Backquote') {
        e.preventDefault();
        setQuickOpen((v) => !v);
        return;
      }
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        const prev = recentTabs.previous(mode);
        if (prev) setMode(prev);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);

  // ── Ultra View: xem nhiều workspace cùng lúc ────────────────────────────────
  // Chỉ đổi chỗ ĐẶT pane, không đụng gì tới cách mount — xem lib/ultraView.
  const ultra = useSyncExternalStore(
    ultraView.subscribe, ultraView.getSnapshot, ultraView.getServerSnapshot,
  );

  // Ctrl+Shift+U bật/tắt nhanh, lấy tab đang mở làm pane đầu tiên.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyU') {
        e.preventDefault();
        ultraView.toggle(mode);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);

  // Ba phím tắt trên chỉ chạy khi bàn phím đang thuộc về HOST PAGE. Đang gõ dở
  // trong Zalo/Telegram/Browser thì phím đi thẳng vào <webview> — keydown ở đây
  // không bao giờ nổ. Main process bắt hộ tại before-input-event của guest rồi
  // bắn về qua kênh này (xem electron/main.cjs · appShortcutOf), nên xử lý y hệt
  // nhánh keydown phía trên. Bản chạy trên trình duyệt thường không có bridge —
  // optional chaining là đủ.
  useEffect(() => window.workspace?.onShortcut?.((name) => {
    if (name === 'quickTabs') setQuickOpen((v) => !v);
    else if (name === 'prevTab') {
      const prev = recentTabs.previous(mode);
      if (prev) setMode(prev);
    } else if (name === 'ultraView') ultraView.toggle(mode);
  }), [mode]);

  /** Chỗ đặt pane `key`: Ultra View thì theo cột, không thì theo tab đang chọn.
   *  Mọi <main> bên dưới đều đi qua đây nên hai chế độ dùng CHUNG một cây pane
   *  — bật/tắt không dựng lại workspace nào. */
  const pane = useMemo(
    () => (key: string, hostsWebviews = false): CSSProperties => (
      ultra.on
        ? ultraPaneStyle(ultra.panes.indexOf(key), hostsWebviews)
        : paneStyle(mode === key, hostsWebviews)
    ),
    [ultra, mode],
  );

  /** Pane có đang hiện trên màn hình không — cho aria-hidden và cho các
   *  workspace cần biết mình có đang được nhìn (vd BrowserWorkspace). */
  const shown = useMemo(
    () => (key: string): boolean => (ultra.on ? ultra.panes.includes(key) : mode === key),
    [ultra, mode],
  );

  /** Bấm một tab trên thanh menu.
   *
   *  Chế độ thường: đổi tab như cũ. Đang bật Ultra View: thêm tab đó vào khung
   *  nhìn (đủ 4 thì thay khung ngoài cùng phải) — bấm là thấy ngay, không cần
   *  mở bảng chọn. Giữ Ctrl khi bấm để THOÁT Ultra View và xem mỗi tab đó,
   *  lối ra nhanh khi đang cần một màn hình rộng. `mode` luôn được cập nhật để
   *  danh sách "vừa dùng" và tắt Ultra View sau đó rơi về đúng tab. */
  const pickTab = useMemo(
    () => (key: string, e?: React.MouseEvent): void => {
      setMode(key);
      if (!ultra.on) return;
      if (e?.ctrlKey || e?.metaKey) ultraView.disable();
      else ultraView.add(key);
    },
    [ultra.on],
  );

  // Hòm thông báo local (lib/noticeStore) — badge đỏ trên tab đích ('git', …)
  // như thư đến. Mở đúng tab là đã đọc thư của tab đó.
  const noticeSnap = useSyncExternalStore(notices.subscribe, notices.getSnapshot, notices.getServerSnapshot);
  useEffect(() => {
    notices.markTabRead(mode);
  }, [mode, noticeSnap.unreadTotal]);

  // Mail đến chưa đọc (server đếm INBOX UNSEEN 10 phút/lần — lib/mailWatch).
  // Bộ đếm SỐNG trên tab Mail: chỉ về 0 khi mail thực sự được đọc, không phải
  // khi mở tab (khác hòm thông báo noticeStore).
  const [mailUnread, setMailUnread] = useState(0);

  // Unread messages across all browser workspaces (Zalo, …) — badges the
  // Workspace tab + the window title so new messages are visible from any tab.
  const [wsUnread, setWsUnread] = useState(0);
  useEffect(() => {
    document.title = wsUnread > 0 ? `(${wsUnread}) VHS DevBox` : 'VHS DevBox';
  }, [wsUnread]);

  // Registered integration packs — each one is a top-level "Projects" tab.
  const [packs, setPacks] = useState<IntegrationView[]>([]);
  useEffect(() => {
    fetch('/api/api-integrations')
      .then((r) => r.json())
      .then((d) => setPacks((d.integrations ?? []) as IntegrationView[]))
      .catch(() => {});
  }, []);

  /** Nhãn của một khoá tab cho màn hình tiếp cận nhanh — tab lõi tra trong
   *  TABS, pack thì tra trong danh sách packs đã nạp. Trả undefined nếu tab
   *  không còn (pack bị gỡ) để màn hình đó tự lọc bỏ. */
  const tabInfo = useMemo(() => (key: string): TabInfo | undefined => {
    const core = TABS.find((t) => t.key === key);
    if (core) {
      const unread = (noticeSnap.unreadByTab[key] ?? 0)
        + (key === 'mail' ? mailUnread : 0)
        + (key === 'workspace' ? wsUnread : 0);
      return { key, icon: core.icon, label: core.label, badge: core.badge, unread };
    }
    if (key === 'packs') return { key, icon: '＋', label: 'Quản lý packs', badge: 'pack' };
    if (key.startsWith('pack:')) {
      const p = packs.find((x) => `pack:${x.id}` === key);
      if (!p) return undefined; // pack đã bị gỡ → bỏ khỏi danh sách
      return { key, icon: '▤', label: p.manifest?.name ?? p.name, badge: 'pack' };
    }
    return undefined;
  }, [packs, noticeSnap, mailUnread, wsUnread]);

  /** Mọi khoá tab đưa vào Ultra View được — tab lõi rồi tới pack, đúng thứ tự
   *  trên thanh menu. Trừ 'packs' (màn hình quản lý, không phải nơi làm việc). */
  const ultraKeys = useMemo(
    () => [...TABS.map((t) => t.key), ...packs.map((p) => `pack:${p.id}`)],
    [packs],
  );

  // Lazy mount-and-keep per workspace: don't probe a tool's API until the user
  // opens it, then keep it mounted so its state survives tab switches.
  // Exception: the browser Workspace mounts from startup — its whole point is
  // alerting about new messages (Zalo) while you work on OTHER tabs, so its
  // guests must be running before the tab is ever clicked.
  const [visited, setVisited] = useState<Record<string, boolean>>({ workspace: true });
  useEffect(() => {
    setVisited((v) => (v[mode] ? v : { ...v, [mode]: true }));
  }, [mode]);

  // Pane trong Ultra View cũng phải được mount, kể cả tab chưa ghé lần nào —
  // khôi phục bố cục đã lưu sau khi khởi động lại app là rơi đúng vào ca này.
  useEffect(() => {
    if (!ultra.on) return;
    setVisited((v) => {
      const missing = ultra.panes.filter((k) => !v[k]);
      if (missing.length === 0) return v;
      const next = { ...v };
      for (const k of missing) next[k] = true;
      return next;
    });
  }, [ultra]);

  // Bố cục đã lưu có thể trỏ tới một pack đã bị gỡ: khoá đó không dựng ra pane
  // nào nhưng vẫn được đếm vào số cột, để lại một cột trống. Dọn nó đi.
  // Chỉ chạy khi packs đã nạp xong, không thì lượt render đầu (packs rỗng) sẽ
  // xoá oan mọi pane pack.
  useEffect(() => {
    if (!ultra.on || packs.length === 0) return;
    const alive = new Set(ultraKeys);
    const stale = ultra.panes.filter((k) => k.startsWith('pack:') && !alive.has(k));
    if (stale.length > 0) ultraView.setPanes(ultra.panes.filter((k) => !stale.includes(k)));
  }, [ultra, ultraKeys, packs.length]);

  // Persisted connection config (webhooks/tool-service keys live here), loaded
  // from the on-disk local store so a restart re-maps it automatically.
  const [saved, setSaved] = useState<LocalConfig>({});
  const [global, setGlobal] = useState<GlobalVars>({});
  const savedRef = useRef<LocalConfig>({});
  useEffect(() => {
    fetchFullConfig()
      .then((cfg) => {
        setSaved(cfg.services);
        setGlobal(cfg.global);
        savedRef.current = cfg.services;
      })
      .catch(() => {});
  }, []);
  useEffect(() => { savedRef.current = saved; }, [saved]);

  const [webhookSettingsOpen, setWebhookSettingsOpen] = useState(false);
  // Switching tabs must never resurrect a stale settings drawer: the open-state
  // lives HERE (survives WebhookReceiver unmount), so without this reset an
  // abandoned drawer + its fullscreen backdrop instantly cover the pane every
  // time the Webhooks tab is reopened.
  useEffect(() => {
    setWebhookSettingsOpen(false);
  }, [mode]);

  // ── Webhooks workspace (targets tool-service, config persisted on disk) ─────
  const TOOL = 'tool-service';
  const toolCfg = saved[TOOL] ?? {};
  const toolBaseUrl = toolCfg.baseUrl || DEFAULT_BASE_URL;
  const toolApiPrefix = toolCfg.apiPrefix ?? '';
  const toolAuth = useMemo(
    () => resolveAuth('tool', { toolKey: toolCfg.toolKey, toolSecret: toolCfg.toolSecret }, global),
    [toolCfg.toolKey, toolCfg.toolSecret, global],
  );
  const toolAuthReady = isAuthReady(toolAuth);
  const toolWsUrl = toolCfg.wsUrl || defaultWsUrl(toolBaseUrl);
  const toolPublicBase = resolvePublicBase(toolBaseUrl, toolApiPrefix, toolCfg.publicBaseUrl);

  // Patch + persist tool-service connection config (blank value → delete the key).
  function setToolConfig(patch: Record<string, string>) {
    setSaved((prev) => ({ ...prev, [TOOL]: { ...(prev[TOOL] ?? {}), ...patch } }));
    const disk: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(patch)) disk[k] = v.trim() ? v.trim() : null;
    saveLocalConfig(TOOL, disk).catch(() => {});
  }

  return (
    <div className="shell" data-nav={navPos}>
      {/* ── Header / top bar ─────────────────────────────────────────── */}
      <header className="appbar">
        <div className="brand">
          <div className="brand-mark">V</div>
          <div className="brand-text">
            <h1><b>VHS</b> DevBox</h1>
            <span className="sub">infra toolbox — mọi dự án</span>
          </div>
          {/* Nút đổi vị trí menu: ngang trên → dọc trái → dọc phải → … */}
          <button className="nav-pos-btn" onClick={cycleNav} title={`Menu đang ${navPos === 'top' ? 'ngang trên' : navPos === 'left' ? 'dọc trái' : 'dọc phải'} — bấm để đổi (menu dọc cho thêm chiều cao)`}>
            {navPos === 'top' ? '⬍' : navPos === 'left' ? '⬅' : '➡'}
          </button>
        </div>

        <div className="modeswitch" role="tablist" aria-label="Workspace">
          {TABS.map((t) => {
            // Thông báo chưa đọc gắn với tab này (hòm thư local) — badge đỏ
            // kiểu "có thư đến" trên đúng menu mục tiêu (vd Git khi có conflict).
            const nUnread = noticeSnap.unreadByTab[t.key] ?? 0;
            return (
            <button
              key={t.key}
              role="tab"
              aria-selected={shown(t.key)}
              className={[
                // Ultra View: mọi tab đang có khung đều sáng, không chỉ một.
                shown(t.key) ? 'on' : '',
                ultra.on && ultra.panes.includes(t.key) ? 'ms-ultra' : '',
                // Chuông chỉ nháy khi tab đó KHÔNG hiện trên màn hình — Ultra
                // View đang mở sẵn Mail thì thôi đừng réo nữa.
                t.key === 'workspace' && wsUnread > 0 && !shown('workspace') ? 'ms-alert' : '',
                // Mail đến chưa đọc — nháy khi đang ở tab khác.
                t.key === 'mail' && mailUnread > 0 && !shown('mail') ? 'ms-alert' : '',
                nUnread > 0 && !shown(t.key) ? 'ms-alert' : '',
              ].filter(Boolean).join(' ')}
              onClick={(e) => pickTab(t.key, e)}
            >
              <span className="ms-ico" aria-hidden>{t.icon}</span>
              {t.label}
              {t.key === 'workspace' && wsUnread > 0 ? (
                <span
                  className={`ms-unread ms-bell${!shown('workspace') ? ' ringing' : ''}`}
                  title={`${wsUnread} tin nhắn mới`}
                >
                  <span className="ms-bell-ico" aria-hidden>🔔</span>
                  {wsUnread > 99 ? '99+' : wsUnread}
                </span>
              ) : t.key === 'mail' && mailUnread > 0 ? (
                // Bộ đếm sống: hiện cả khi ĐANG ở tab Mail (như hòm thư thật),
                // chỉ về 0 khi mail được đọc trên server.
                <span
                  className={`ms-unread ms-bell${!shown('mail') ? ' ringing' : ''}`}
                  title={`${mailUnread} email chưa đọc`}
                >
                  <span className="ms-bell-ico" aria-hidden>✉️</span>
                  {mailUnread > 99 ? '99+' : mailUnread}
                </span>
              ) : nUnread > 0 ? (
                <span
                  className={`ms-unread ms-bell${!shown(t.key) ? ' ringing' : ''}`}
                  title={`${nUnread} thông báo mới`}
                >
                  <span className="ms-bell-ico" aria-hidden>🔔</span>
                  {nUnread > 99 ? '99+' : nUnread}
                </span>
              ) : (
                <span className="ms-badge">{t.badge}</span>
              )}
            </button>
            );
          })}

          {/* ── Projects zone: one tab per registered integration pack ── */}
          <span className="ms-divider" aria-hidden />
          <span className="ms-zone-label" aria-hidden>Projects</span>
          {packs.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={shown(`pack:${p.id}`)}
              className={`${shown(`pack:${p.id}`) ? 'on ' : ''}ms-pack`}
              title={p.manifestError ? `manifest lỗi: ${p.manifestError}` : p.root}
              onClick={(e) => pickTab(`pack:${p.id}`, e)}
            >
              <span className="ms-ico" aria-hidden>▤</span>
              {p.manifest?.name ?? p.name}
              <span className="ms-badge">{p.manifestError ? '⚠' : 'pack'}</span>
            </button>
          ))}
          <button
            role="tab"
            aria-selected={mode === 'packs'}
            className={mode === 'packs' ? 'on' : ''}
            onClick={() => setMode('packs')}
            title="Đăng ký / quản lý integration packs"
          >
            <span className="ms-ico" aria-hidden>＋</span>
          </button>
        </div>

        {/* Global bar carries ONLY stable, app-wide controls. Mode-scoped config
            (e.g. the webhooks connection chip) lives inside its own pane —
            anything conditional here resizes the header and can push the tab
            strip (with the Workspace bell) out of view. */}
        <div className="appbar-right">
          {/* Tiếp cận nhanh các tab đang làm — nhảy qua nhảy lại khỏi dò menu. */}
          <button
            className="qt-open-btn"
            onClick={() => setQuickOpen(true)}
            title="Tab đang làm — tiếp cận nhanh (Ctrl+`)"
            aria-label="Tab đang làm"
          >
            🕘
          </button>
          {/* Ultra View: xem nhiều workspace cùng lúc (Ctrl+Shift+U). */}
          <UltraBar state={ultra} current={mode} allKeys={ultraKeys} info={tabInfo} />
          {/* Hòm thông báo: xem lại lịch sử (local, 2 ngày) + xóa tất cả. */}
          <NotificationCenter />
          <ThemeToggle />
        </div>
      </header>

      {/* Màn hình tiếp cận nhanh (Ctrl+`) — nổi trên mọi workspace. */}
      <QuickTabs
        open={quickOpen}
        current={mode}
        recents={recents}
        info={tabInfo}
        onPick={setMode}
        onRemove={recentTabs.remove}
        onClear={recentTabs.clear}
        onClose={() => setQuickOpen(false)}
      />

      {/* ── Body: workspaces (mount-and-keep) ───────────────────────── */}
      {/* data-ultra = số pane đang xem → globals.css chia đúng ngần ấy cột.
          Không bật thì không có thuộc tính, lưới giữ nguyên như cũ. */}
      <div className="body" data-ultra={ultra.on ? ultra.panes.length : undefined}>
        {visited.work && (
          <main className="workspace" style={pane('work')} aria-hidden={!shown('work')}>
            <WorkWorkspace />
          </main>
        )}
        {visited.git && (
          <main className="workspace" style={pane('git')} aria-hidden={!shown('git')}>
            <GitWorkspace />
          </main>
        )}
        {visited.code && (
          <main className="workspace" style={pane('code')} aria-hidden={!shown('code')}>
            <CodeStudio />
          </main>
        )}
        {visited.redis && (
          <main className="workspace" style={pane('redis')} aria-hidden={!shown('redis')}>
            <RedisWorkspace />
          </main>
        )}
        {visited.kafka && (
          <main className="workspace" style={pane('kafka')} aria-hidden={!shown('kafka')}>
            <KafkaWorkspace />
          </main>
        )}
        {visited.rabbit && (
          <main className="workspace" style={pane('rabbit')} aria-hidden={!shown('rabbit')}>
            <RabbitWorkspace />
          </main>
        )}
        {visited.mongo && (
          <main className="workspace" style={pane('mongo')} aria-hidden={!shown('mongo')}>
            <MongoWorkspace />
          </main>
        )}
        {visited.es && (
          <main className="workspace" style={pane('es')} aria-hidden={!shown('es')}>
            <EsWorkspace />
          </main>
        )}
        {visited.pg && (
          <main className="workspace" style={pane('pg')} aria-hidden={!shown('pg')}>
            <PgWorkspace />
          </main>
        )}
        {visited.office && (
          <main className="workspace" style={pane('office')} aria-hidden={!shown('office')}>
            <OfficeWorkspace />
          </main>
        )}
        {visited.google && (
          <main className="workspace" style={pane('google')} aria-hidden={!shown('google')}>
            <GoogleWorkspace />
          </main>
        )}
        {visited.mail && (
          <main className="workspace" style={pane('mail')} aria-hidden={!shown('mail')}>
            <MailWorkspace />
          </main>
        )}
        {visited.links && (
          /* hostsWebviews: viewer nhúng (LinkViewer) có thể đang mở khi chuyển
             tab — webview vẽ ở native layer, phải đưa offscreen chứ không
             visibility:hidden được. */
          <main className="workspace" data-webview style={pane('links', true)} aria-hidden={!shown('links')}>
            <LinksWorkspace />
          </main>
        )}
        {visited.apps && (
          <main className="workspace" style={pane('apps')} aria-hidden={!shown('apps')}>
            <AppsWorkspace />
          </main>
        )}
        {visited.tools && (
          <main className="workspace" style={pane('tools')} aria-hidden={!shown('tools')}>
            <ToolsWorkspace />
          </main>
        )}
        {visited.api && (
          <main className="workspace" style={pane('api')} aria-hidden={!shown('api')}>
            <ApiWorkspace />
          </main>
        )}
        {visited.browser && (
          <main className="workspace" data-webview style={pane('browser', true)} aria-hidden={!shown('browser')}>
            <BrowserTabWorkspace />
          </main>
        )}
        {visited.remote && (
          <main className="workspace" style={pane('remote')} aria-hidden={!shown('remote')}>
            <RemoteWorkspace />
          </main>
        )}
        {visited.workspace && (
          <main className="workspace" data-webview style={pane('workspace', true)} aria-hidden={!shown('workspace')}>
            <BrowserWorkspace onUnread={setWsUnread} visible={shown('workspace')} />
          </main>
        )}
        {visited.automation && (
          <main className="workspace" style={pane('automation')} aria-hidden={!shown('automation')}>
            <AutomationWorkspace />
          </main>
        )}
        {/* Project packs — one mounted workspace per visited pack. */}
        {packs.map((p) => visited[`pack:${p.id}`] && (
          <main
            key={p.id}
            className="workspace"
            style={pane(`pack:${p.id}`)}
            aria-hidden={!shown(`pack:${p.id}`)}
          >
            <ApiExplorerWorkspace packId={p.id} />
          </main>
        ))}

        {shown('packs') && (
          <main className="workspace" style={pane('packs')}>
            <PackManager
              packs={packs}
              onChanged={setPacks}
              onOpen={(id) => setMode(`pack:${id}`)}
            />
          </main>
        )}

        {shown('webhooks') && (
          <main className="workspace" style={pane('webhooks')}>
            <WebhookReceiver
              baseUrl={toolBaseUrl}
              onBaseUrl={(u) => setToolConfig({ baseUrl: u })}
              apiPrefix={toolApiPrefix}
              onApiPrefix={(p) => setToolConfig({ apiPrefix: p })}
              toolKey={toolCfg.toolKey ?? ''}
              toolSecret={toolCfg.toolSecret ?? ''}
              onCreds={(c) => setToolConfig(c)}
              auth={toolAuth}
              authReady={toolAuthReady}
              wsUrl={toolWsUrl}
              onWsUrl={(u) => setToolConfig({ wsUrl: u })}
              publicBaseUrl={toolPublicBase}
              onPublicBaseUrl={(u) => setToolConfig({ publicBaseUrl: u })}
              settingsOpen={webhookSettingsOpen}
              onOpenSettings={() => setWebhookSettingsOpen(true)}
              onCloseSettings={() => setWebhookSettingsOpen(false)}
            />
          </main>
        )}
      </div>

      {/* Engine presence: infra watch runner + notification toasts. Lives
          outside every pane so it keeps working on any tab. */}
      <AutomationHost />

      {/* Tiến trình nền: server tự pull mọi Git project 10 phút/lần; host này
          poll kết quả và báo urgent khi có repo conflict. */}
      <GitAutoPullHost />

      {/* Tiến trình nền: server đếm mail chưa đọc 10 phút/lần → badge tab Mail. */}
      <MailWatchHost onUnread={setMailUnread} />

      {/* Cảnh báo Công việc (ngày bắt đầu + gần deadline) → toast + hòm thông báo. */}
      <WorkAlertHost />

      {/* Bấm link trong tin nhắn Zalo/Telegram → hỏi mở ở tab Links hay tab
          Browser. Cửa sổ Zalo không bị đụng tới, vẫn nguyên khung chat. setMode
          bật tab đích, và effect `visited` ở trên mount nó nếu là lần ghé đầu. */}
      <OpenLinkDialog onGoTab={setMode} />

      {/* Job chuyển đổi file chạy ngầm: host này in PDF hộ (Chromium của
          Electron) và báo đường dẫn khi xong. */}
      <ConvertHost />

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <footer className="appfoot">
        <span>VHS DevBox · infra toolbox dùng chung cho mọi dự án</span>
        <span className="foot-right">
          Redis · Kafka · RabbitMQ · MongoDB · Elastic · PostgreSQL · Office · Google · Mail · Links · Git · Webhooks · Automation
          {/* Đồng bộ configs/ với repo dev-box-config: đẩy lên một cú bấm,
              kéo về thì hỏi passphrase. Badge trên nút cho biết khi nào cần. */}
          <ConfigSyncButton />
          {/* Desktop only: log của shell + next dev, ẩn mặc định. */}
          <DesktopConsole />
        </span>
      </footer>
    </div>
  );
}
