'use client';

// VHS DevBox — infra toolbox shell. Forked from an internal all-in-one toolbox with the
// API Explorer and the Telegram review bot removed: this build is the
// company-wide datastore/broker manager (Webhooks · Git · Redis · Kafka ·
// RabbitMQ · MongoDB · Elastic · PostgreSQL). Each workspace loads + mounts lazily and
// stays mounted (hidden) across tab switches so long-running state survives.

import dynamic from 'next/dynamic';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import WebhookReceiver from '@/components/WebhookReceiver';
import type { IntegrationView } from '@/components/ApiExplorerWorkspace';
import type { MonitorSummary } from '@/components/monitor/MonitorWorkspace';
import type { OfficeApi } from '@/components/OfficeWorkspace';
import type { ToolsApi } from '@/components/ToolsWorkspace';
import PackManager from '@/components/PackManager';
import AutomationHost from '@/components/AutomationHost';
import GitAutoPullHost from '@/components/GitAutoPullHost';
import KeymissFlagHost from '@/components/KeymissFlagHost';
import MailWatchHost from '@/components/MailWatchHost';
import WorkAlertHost from '@/components/WorkAlertHost';
import ConvertHost from '@/components/ConvertHost';
import StockTickerHost, { StockHeaderButton } from '@/components/StockTickerHost';
import QuickTranslate from '@/components/QuickTranslate';
import OpenLinkDialog from '@/components/OpenLinkDialog';
import NotificationCenter from '@/components/NotificationCenter';
import QuickTabs, { type TabInfo } from '@/components/QuickTabs';
import UltraBar from '@/components/UltraBar';
import TabVisibilityBar from '@/components/TabVisibilityBar';
import * as recentTabs from '@/lib/recentTabs';
import { classifyFile, droppedFiles, isFileDrag, onOpenPathRequest, openDropped } from '@/lib/fileDrop';
import * as ultraView from '@/lib/ultraView';
import * as hiddenTabs from '@/lib/hiddenTabs';
import { notices } from '@/lib/noticeStore';
import ThemeToggle from '@/components/ThemeToggle';
import DesktopConsole from '@/components/DesktopConsole';
import ConfigSyncButton from '@/components/ConfigSyncButton';
import UpdateButton from '@/components/UpdateButton';
import HardReloadButton from '@/components/HardReloadButton';
import ServerModeButton from '@/components/ServerModeButton';
import { loadPane } from '@/components/PaneChunk';
import { hydratePresets } from '@/lib/presetSync';
import UpdatePrompt from '@/components/UpdatePrompt';
import CritBadge, { useCritAlerts, type CritStack } from '@/components/monitor/CritBar';
import { resolveAuth, authReady as isAuthReady } from '@/lib/request';
import {
  fetchFullConfig,
  saveLocalConfig,
  type LocalConfig,
  type GlobalVars,
} from '@/lib/persist';

// Mỗi workspace bọc memo: page này đổi state rất hay (đổi tab, badge chưa đọc,
// hòm thông báo, Ultra View…) mà các pane đã mở đều đang mount (chỉ bị ẩn). Không
// memo thì mỗi lần như vậy cả chục workspace nghìn dòng bị render lại vô ích.
// Props truyền xuống đều ổn định (không có object/hàm tạo mới mỗi lượt) nên memo ăn.
//
// Và mỗi workspace là một chunk tải động (ssr: false): import tĩnh cả 25 cái
// (Monaco, Univer, xterm…) bắt trang / biên dịch ~6.5k module và tải hết JS
// ngay lúc mở app, dù phần lớn tab chưa ai bấm tới. Giờ tab nào được ghé
// (`visited`) mới tải chunk của tab đó. Không render trên server còn cắt luôn
// cả họ lỗi hydration kiểu đọc window.workspace ngay trong render.
// loadPane: chunk tải hụt (dev server vừa khởi động lại…) thì thử lại rồi báo
// trong pane, không đỏ cả app — xem components/PaneChunk.tsx.
function PaneLoading() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: '100%', color: 'var(--muted)' }}>
      <span className="spinner" /> Đang tải…
    </div>
  );
}
const WorkWorkspace = memo(dynamic(() => loadPane(() => import('@/components/WorkWorkspace')), { ssr: false, loading: PaneLoading }));
const GitWorkspace = memo(dynamic(() => loadPane(() => import('@/components/GitWorkspace')), { ssr: false, loading: PaneLoading }));
const CodeStudio = memo(dynamic(() => loadPane(() => import('@/components/CodeStudio')), { ssr: false, loading: PaneLoading }));
const TerminalWorkspace = memo(dynamic(() => loadPane(() => import('@/components/TerminalWorkspace')), { ssr: false, loading: PaneLoading }));
const MonitorWorkspace = memo(dynamic(() => loadPane(() => import('@/components/monitor/MonitorWorkspace')), { ssr: false, loading: PaneLoading }));
const RedisWorkspace = memo(dynamic(() => loadPane(() => import('@/components/RedisWorkspace')), { ssr: false, loading: PaneLoading }));
const KafkaWorkspace = memo(dynamic(() => loadPane(() => import('@/components/KafkaWorkspace')), { ssr: false, loading: PaneLoading }));
const RabbitWorkspace = memo(dynamic(() => loadPane(() => import('@/components/RabbitWorkspace')), { ssr: false, loading: PaneLoading }));
const MongoWorkspace = memo(dynamic(() => loadPane(() => import('@/components/MongoWorkspace')), { ssr: false, loading: PaneLoading }));
const EsWorkspace = memo(dynamic(() => loadPane(() => import('@/components/EsWorkspace')), { ssr: false, loading: PaneLoading }));
const PgWorkspace = memo(dynamic(() => loadPane(() => import('@/components/PgWorkspace')), { ssr: false, loading: PaneLoading }));
const MinioWorkspace = memo(dynamic(() => loadPane(() => import('@/components/MinioWorkspace')), { ssr: false, loading: PaneLoading }));
const OfficeWorkspace = memo(dynamic(() => loadPane(() => import('@/components/OfficeWorkspace')), { ssr: false, loading: PaneLoading }));
const GoogleWorkspace = memo(dynamic(() => loadPane(() => import('@/components/GoogleWorkspace')), { ssr: false, loading: PaneLoading }));
const MailWorkspace = memo(dynamic(() => loadPane(() => import('@/components/MailWorkspace')), { ssr: false, loading: PaneLoading }));
const LinksWorkspace = memo(dynamic(() => loadPane(() => import('@/components/LinksWorkspace')), { ssr: false, loading: PaneLoading }));
const AppsWorkspace = memo(dynamic(() => loadPane(() => import('@/components/AppsWorkspace')), { ssr: false, loading: PaneLoading }));
const ToolsWorkspace = memo(dynamic(() => loadPane(() => import('@/components/ToolsWorkspace')), { ssr: false, loading: PaneLoading }));
const ApiWorkspace = memo(dynamic(() => loadPane(() => import('@/components/ApiWorkspace')), { ssr: false, loading: PaneLoading }));
const BrowserTabWorkspace = memo(dynamic(() => loadPane(() => import('@/components/BrowserTabWorkspace')), { ssr: false, loading: PaneLoading }));
const BrowserWorkspace = memo(dynamic(() => loadPane(() => import('@/components/BrowserWorkspace')), { ssr: false, loading: PaneLoading }));
const ZaloApiWorkspace = memo(dynamic(() => loadPane(() => import('@/components/ZaloApiWorkspace')), { ssr: false, loading: PaneLoading }));
const RemoteWorkspace = memo(dynamic(() => loadPane(() => import('@/components/RemoteWorkspace')), { ssr: false, loading: PaneLoading }));
const ApiExplorerWorkspace = memo(dynamic(() => loadPane(() => import('@/components/ApiExplorerWorkspace')), { ssr: false, loading: PaneLoading }));
const AutomationWorkspace = memo(dynamic(() => loadPane(() => import('@/components/automation/AutomationWorkspace')), { ssr: false, loading: PaneLoading }));

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
  { key: 'terminal', icon: '❯', label: 'Terminal', badge: 'shell' },
  { key: 'monitor', icon: '📊', label: 'Monitor', badge: 'infra' },
  { key: 'redis', icon: '◆', label: 'Redis', badge: 'local' },
  { key: 'kafka', icon: '≋', label: 'Kafka', badge: 'local' },
  { key: 'rabbit', icon: '🐇', label: 'RabbitMQ', badge: 'local' },
  { key: 'mongo', icon: '🍃', label: 'MongoDB', badge: 'local' },
  { key: 'es', icon: '🔍', label: 'Elastic', badge: 'local' },
  { key: 'pg', icon: '🐘', label: 'PostgreSQL', badge: 'local' },
  { key: 'minio', icon: '🪣', label: 'MinIO', badge: 'local' },
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
  { key: 'zaloapi', icon: '🟦', label: 'Zalo API', badge: 'api' },
  { key: 'automation', icon: '🤖', label: 'Automation', badge: 'engine' },
];

type NavPos = 'top' | 'left' | 'right';
const NO_CRIT: CritStack[] = [];
const NAV_KEY = 'devbox.navPos';

export default function Home() {
  // Mở app là vào thẳng Công việc (lịch + việc trong ngày). Nếu người dùng đã
  // ẩn tab này thì effect fallback bên dưới tự chuyển sang tab hiện khác.
  const [mode, setMode] = useState<Mode>('work');

  // Kéo "nút tìm nhanh" (preset Redis/Kafka/Mongo/ES/PG) từ configs/presets.json
  // về localStorage một lần lúc khởi động. Chạy ở đây — gốc cây — để tab nào mở
  // cũng đã có dữ liệu, không phải mỗi tab tự đồng bộ.
  useEffect(() => { void hydratePresets(); }, []);

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

  // Ẩn HẲN thanh menu (mọi vị trí trên/trái/phải) để nhường chỗ cho vùng làm
  // việc. Khi ẩn, một dải mỏng thế chỗ đúng cạnh đó (nằm trong ô lưới của
  // appbar) — luôn có lối mở lại, và không bị <webview> che vì nó không nằm
  // đè lên vùng nội dung. Lưu localStorage.
  const [navHidden, setNavHidden] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.localStorage.getItem('devbox.navHidden') === '1') {
      setNavHidden(true);
    }
  }, []);
  const toggleNavHidden = () => {
    setNavHidden((v) => {
      if (typeof window !== 'undefined') window.localStorage.setItem('devbox.navHidden', v ? '0' : '1');
      return !v;
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

  // ── Tính năng bị ẩn khỏi menu ───────────────────────────────────────────────
  // CHỈ ảnh hưởng thanh menu. Pane vẫn mount theo `visited` như cũ nên automation
  // / watcher / mail poll của tab bị ẩn vẫn chạy — xem lib/hiddenTabs.
  const hidden = useSyncExternalStore(
    hiddenTabs.subscribe, hiddenTabs.getSnapshot, hiddenTabs.getServerSnapshot,
  );
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const visibleTabs = useMemo(() => TABS.filter((t) => !hiddenSet.has(t.key)), [hiddenSet]);
  /** Tab đang chờ xác nhận ẩn (bấm ✕ trên menu) — TabVisibilityBar dựng hộp hỏi. */
  const [pendingHide, setPendingHide] = useState<string | null>(null);

  // Ẩn đúng tab ĐANG MỞ thì không được để màn hình trống: nhảy sang tab hiện
  // gần nhất vừa dùng, không có thì lấy tab hiện đầu tiên. Pack và màn hình
  // quản lý packs không ẩn được nên không tính ở đây.
  useEffect(() => {
    if (!hiddenSet.has(mode)) return;
    const fallback = recents.find((r) => r.key !== mode && !hiddenSet.has(r.key))?.key
      ?? visibleTabs[0]?.key;
    if (fallback) setMode(fallback);
  }, [hiddenSet, mode, visibleTabs, recents]);

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

  // ── Chuột phải file trong Explorer → "Open with → VHS DevBox" ────────────
  //
  // Main process gửi đường dẫn tuyệt đối xuống (electron/main.cjs ·
  // dispatchOpenFile). Ở đây chỉ làm hai việc: chọn tab theo đuôi file, rồi
  // nhờ workspace tương ứng mở nó.
  //
  // Hai workspace đăng ký API của chúng qua onReady vào ref bên dưới. Ref chứ
  // không phải state: nhận được API mà lại setState thì cả cây pane render lại
  // ngay giữa lượt mount đầu, không được lợi gì.
  const officeApi = useRef<OfficeApi | null>(null);
  const toolsApi = useRef<ToolsApi | null>(null);
  const onOfficeReady = useCallback((api: OfficeApi) => { officeApi.current = api; }, []);
  const onToolsReady = useCallback((api: ToolsApi) => { toolsApi.current = api; }, []);

  /** Mở một file trên đĩa ở đúng view theo đuôi file. Đường chung cho "Open
   *  with" từ Explorer và kéo thả (lib/fileDrop.ts). */
  const openLocalPath = useCallback((filePath: string) => {
    const office = classifyFile(filePath)?.target === 'office';
    const target = office ? 'office' : 'tools';
    // Chuyển tab TRƯỚC khi mở: pane chỉ mount lần đầu được ghé thăm (xem
    // `visited`), chưa vào tab Tools lần nào thì ToolsWorkspace còn chưa tồn
    // tại nên chưa kịp đăng ký API.
    setMode(target);
    // Pane vừa mới được mount lần đầu thì API của nó chưa kịp đăng ký (effect
    // onReady chạy sau lượt render này). Thử lại vài nhịp thay vì đoán đúng
    // một mốc thời gian — lượt sau, khi workspace đã mount sẵn, ngay lần thử
    // đầu đã ăn nên không ai phải chờ.
    let tries = 0;
    const tick = () => {
      const api = office ? officeApi.current : toolsApi.current;
      if (api) { api.openFile(filePath); return; }
      // Bỏ cuộc sau ~15s: workspace là chunk tải động, lần đầu dưới `next dev`
      // còn phải biên dịch nên 2s như trước là hụt.
      if (++tries < 300) setTimeout(tick, 50);
    };
    tick();
  }, []);

  useEffect(() => window.workspace?.onOpenLocalFile?.(openLocalPath), [openLocalPath]);
  useEffect(() => onOpenPathRequest(openLocalPath), [openLocalPath]);

  // ── Kéo thả file từ Explorer ─────────────────────────────────────────────
  //
  // Rê file vào cửa sổ → nút menu Office/Tools sáng lên báo "thả vào đây được".
  // Thả lên nút: mở luôn (thả nhầm nút vẫn vào đúng view — bộ định tuyến chọn
  // theo đuôi file). Giữ file trên nút một lúc mà chưa thả: chuyển sang tab
  // đó, để thả tiếp vào vùng làm việc bên trong như kéo lên taskbar Windows.
  const [fileDragging, setFileDragging] = useState(false);
  const [dropHover, setDropHover] = useState<string | null>(null);
  const [dropMsg, setDropMsg] = useState<string | null>(null);
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showDropMsg = useCallback((m: string) => {
    setDropMsg(m || null);
    if (dropMsgTimer.current) clearTimeout(dropMsgTimer.current);
    if (m) dropMsgTimer.current = setTimeout(() => setDropMsg(null), 6000);
  }, []);
  useEffect(() => {
    // dragenter/dragleave bắn cả khi rê qua phần tử con — đếm mới biết con trỏ
    // đã thật sự rời cửa sổ hay chưa.
    let depth = 0;
    const enter = (e: DragEvent) => { if (isFileDrag(e.dataTransfer)) { depth++; setFileDragging(true); } };
    const leave = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      if (--depth <= 0) { depth = 0; setFileDragging(false); }
    };
    const end = () => { depth = 0; setFileDragging(false); setDropHover(null); };
    window.addEventListener('dragenter', enter, true);
    window.addEventListener('dragleave', leave, true);
    window.addEventListener('drop', end, true);
    window.addEventListener('dragend', end, true);
    return () => {
      window.removeEventListener('dragenter', enter, true);
      window.removeEventListener('dragleave', leave, true);
      window.removeEventListener('drop', end, true);
      window.removeEventListener('dragend', end, true);
    };
  }, []);
  useEffect(() => {
    if (springTimer.current) clearTimeout(springTimer.current);
    if (!dropHover) return;
    const key = dropHover;
    springTimer.current = setTimeout(() => setMode(key), 700);
    return () => { if (springTimer.current) clearTimeout(springTimer.current); };
  }, [dropHover]);

  /** Props kéo thả cho nút menu `key` — chỉ Office/Tools nhận file. */
  const menuDropProps = (key: string) => (key !== 'office' && key !== 'tools' ? {} : {
    onDragOver: (e: React.DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (dropHover !== key) setDropHover(key);
    },
    // Rê qua icon/chữ bên trong nút cũng bắn dragleave — chỉ tính khi ra hẳn
    // khỏi nút, không thì hẹn giờ chuyển tab bị đặt lại liên tục.
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDropHover((h) => (h === key ? null : h));
    },
    onDrop: (e: React.DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      setDropHover(null);
      showDropMsg(openDropped(droppedFiles(e.dataTransfer)));
    },
  });

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
  // Workspace con nhảy sang tab khác (vd hộp "Lưu ảnh" của Công việc → menu
  // MinIO): phát `devbox:open-tab` với detail là key tab — khỏi phải luồn
  // callback qua props của từng workspace.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const key = (e as CustomEvent<string>).detail;
      if (typeof key === 'string' && key) setMode(key);
    };
    window.addEventListener('devbox:open-tab', onOpen);
    return () => window.removeEventListener('devbox:open-tab', onOpen);
  }, []);

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
  // Tin chưa đọc của tab Zalo API (nhánh API) — riêng với Workspace vì hai luồng
  // độc lập, nhưng dồn chung vào tiêu đề cửa sổ.
  const [zaUnread, setZaUnread] = useState(0);
  // Tóm tắt Monitor (số tài nguyên đỏ/vàng) → chấm màu trên nút menu khi đang ở tab khác.
  const [monSum, setMonSum] = useState<MonitorSummary | null>(null);
  useEffect(() => {
    const total = wsUnread + zaUnread;
    document.title = total > 0 ? `(${total}) VHS DevBox` : 'VHS DevBox';
  }, [wsUnread, zaUnread]);

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
  // 'workspace' + 'zaloapi' đều mount NGAY từ đầu: cả hai cần guest sống nền để
  // nhận tin (WebSocket của Zalo API) và gửi được từ tab khác — giống keepAlive.
  const [visited, setVisited] = useState<Record<string, boolean>>({ workspace: true, zaloapi: true });
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

  // Cảnh báo critical (components/monitor/CritBar): badge ở góc trái footer + nháy
  // taskbar / toast hệ thống khi app không ở trước mặt. Bấm → tab Monitor.
  const critStacks = monSum?.critStacks ?? NO_CRIT;
  const openMonitor = useCallback(() => pickTab('monitor'), [pickTab]);
  useCritAlerts(critStacks, openMonitor);

  return (
    <div className="shell" data-nav={navPos}>
      {/* Menu đang ẩn: dải mỏng thế chỗ — bấm là menu về. Nằm đúng ô lưới của
          appbar nên chế độ trên/trái/phải đều tự dính đúng cạnh. */}
      {navHidden && (
        <button
          className="appbar-restore"
          onClick={toggleNavHidden}
          title="Hiện lại thanh menu (đang ẩn để nhường chỗ cho vùng làm việc)"
        >
          <span aria-hidden>☰</span>
          <span className="appbar-restore-label">menu</span>
        </button>
      )}

      {/* ── Header / top bar ─────────────────────────────────────────── */}
      {!navHidden && (
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
          {/* Ẩn hẳn menu — dải mỏng ☰ ở đúng cạnh này để mở lại. */}
          <button className="nav-pos-btn" onClick={toggleNavHidden}
            title="Ẩn thanh menu — nhường chỗ cho vùng làm việc; dải mỏng ☰ ở cạnh này để mở lại">
            {navPos === 'top' ? '⌃' : navPos === 'left' ? '«' : '»'}
          </button>
        </div>

        <div className="modeswitch" role="tablist" aria-label="Workspace">
          {visibleTabs.map((t) => {
            // Thông báo chưa đọc gắn với tab này (hòm thư local) — badge đỏ
            // kiểu "có thư đến" trên đúng menu mục tiêu (vd Git khi có conflict).
            const nUnread = noticeSnap.unreadByTab[t.key] ?? 0;
            return (
            <span key={t.key} className="ms-wrap">
            <button
              role="tab"
              aria-selected={shown(t.key)}
              className={[
                // Ultra View: mọi tab đang có khung đều sáng, không chỉ một.
                shown(t.key) ? 'on' : '',
                ultra.on && ultra.panes.includes(t.key) ? 'ms-ultra' : '',
                // Chuông chỉ nháy khi tab đó KHÔNG hiện trên màn hình — Ultra
                // View đang mở sẵn Mail thì thôi đừng réo nữa.
                t.key === 'workspace' && wsUnread > 0 && !shown('workspace') ? 'ms-alert' : '',
                // Zalo API: tin đến (nhánh API) — nháy khi đang ở tab khác.
                t.key === 'zaloapi' && zaUnread > 0 && !shown('zaloapi') ? 'ms-alert' : '',
                // Mail đến chưa đọc — nháy khi đang ở tab khác.
                t.key === 'mail' && mailUnread > 0 && !shown('mail') ? 'ms-alert' : '',
                nUnread > 0 && !shown(t.key) ? 'ms-alert' : '',
                // Đang rê file: sáng các nút nhận được file, đậm nút đang trỏ vào.
                fileDragging && (t.key === 'office' || t.key === 'tools') ? 'ms-droppable' : '',
                dropHover === t.key ? 'ms-drophover' : '',
              ].filter(Boolean).join(' ')}
              onClick={(e) => pickTab(t.key, e)}
              {...menuDropProps(t.key)}
            >
              <span className="ms-ico" aria-hidden>{t.icon}</span>
              {t.label}
              {t.key === 'monitor' && monSum && (monSum.bad > 0 || monSum.warn > 0) ? (
                <span
                  className={`ms-mon ${monSum.bad > 0 ? 'bad' : 'warn'}`}
                  title={`${monSum.bad} đỏ · ${monSum.warn} vàng trên ${monSum.total} tài nguyên`}
                  aria-label={`${monSum.bad} tài nguyên đỏ, ${monSum.warn} vàng`}
                />
              ) : null}
              {t.key === 'workspace' && wsUnread > 0 ? (
                <span
                  className={`ms-unread ms-bell${!shown('workspace') ? ' ringing' : ''}`}
                  title={`${wsUnread} tin nhắn mới`}
                >
                  <span className="ms-bell-ico" aria-hidden>🔔</span>
                  {wsUnread > 99 ? '99+' : wsUnread}
                </span>
              ) : t.key === 'zaloapi' && zaUnread > 0 ? (
                <span
                  className={`ms-unread ms-bell${!shown('zaloapi') ? ' ringing' : ''}`}
                  title={`${zaUnread} tin nhắn mới (Zalo API)`}
                >
                  <span className="ms-bell-ico" aria-hidden>🔔</span>
                  {zaUnread > 99 ? '99+' : zaUnread}
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
            {/* Ẩn tính năng: chỉ hiện khi rê chuột lên tab. Nằm NGOÀI <button>
                vì button lồng button là HTML không hợp lệ — trình duyệt sẽ tự
                tháo lồng và nút ✕ rơi ra ngoài menu. */}
            <button
              className="ms-hide"
              tabIndex={-1}
              title={`Ẩn "${t.label}" khỏi menu — bật lại ở nút ⚙ trên thanh tiêu đề. Automation của tab này vẫn chạy.`}
              aria-label={`Ẩn ${t.label}`}
              onClick={(e) => { e.stopPropagation(); setPendingHide(t.key); }}
            >✕</button>
            </span>
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
          {/* Hiện/ẩn tính năng — NƠI DUY NHẤT bật lại tab đã ẩn, nên luôn hiện. */}
          <TabVisibilityBar
            hidden={hidden}
            allKeys={TABS.map((t) => t.key)}
            info={tabInfo}
            pending={pendingHide}
            onResolvePending={(ok) => {
              if (ok && pendingHide) hiddenTabs.hide(pendingHide);
              setPendingHide(null);
            }}
          />
          {/* Giá cổ phiếu: mở cấu hình widget góc màn hình — lối vào duy nhất
              khi widget đang tắt (mặc định tắt). */}
          <StockHeaderButton />
          {/* Hòm thông báo: xem lại lịch sử (local, 2 ngày) + xóa tất cả. */}
          <NotificationCenter />
          <ThemeToggle />
        </div>
      </header>
      )}

      {/* File kéo thả mà không mở được (loại lạ / không có đường dẫn). */}
      {dropMsg && (
        <div className="drop-toast" role="status" onClick={() => setDropMsg(null)}>{dropMsg}</div>
      )}

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
        {visited.terminal && (
          <main className="workspace" style={pane('terminal')} aria-hidden={!shown('terminal')}>
            <TerminalWorkspace visible={shown('terminal')} />
          </main>
        )}
        {/* Monitor luôn mount (không chờ `visited`): cảnh báo critical ở footer cần
            vòng đo chạy ngay từ lúc mở app, dù chưa vào tab Monitor lần nào. */}
        <main className="workspace" style={pane('monitor')} aria-hidden={!shown('monitor')}>
          <MonitorWorkspace visible={shown('monitor')} onOpenTab={pickTab} onSummary={setMonSum} />
        </main>
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
        {visited.minio && (
          <main className="workspace" style={pane('minio')} aria-hidden={!shown('minio')}>
            <MinioWorkspace />
          </main>
        )}
        {visited.office && (
          <main className="workspace" style={pane('office')} aria-hidden={!shown('office')}>
            <OfficeWorkspace onReady={onOfficeReady} />
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
            <AppsWorkspace visible={shown('apps')} />
          </main>
        )}
        {visited.tools && (
          <main className="workspace" style={pane('tools')} aria-hidden={!shown('tools')}>
            <ToolsWorkspace onReady={onToolsReady} />
          </main>
        )}
        {visited.api && (
          <main className="workspace" style={pane('api')} aria-hidden={!shown('api')}>
            <ApiWorkspace />
          </main>
        )}
        {visited.browser && (
          <main className="workspace" data-webview style={pane('browser', true)} aria-hidden={!shown('browser')}>
            <BrowserTabWorkspace visible={shown('browser')} />
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
        {visited.zaloapi && (
          <main className="workspace" data-webview style={pane('zaloapi', true)} aria-hidden={!shown('zaloapi')}>
            <ZaloApiWorkspace onUnread={setZaUnread} visible={shown('zaloapi')} />
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

      {/* Tiến trình nền: 10 phút/lần kiểm tra cờ key-miss của Redis (phân tích hit rate bật tạm)
          còn bật không — thấy thì toast HỎI có tắt không, không tự tắt. */}
      <KeymissFlagHost />

      {/* Tiến trình nền: server đếm mail chưa đọc 10 phút/lần → badge tab Mail. */}
      <MailWatchHost onUnread={setMailUnread} />

      {/* Cảnh báo Công việc (ngày bắt đầu + gần deadline) → toast + hòm thông báo. */}
      <WorkAlertHost />

      {/* Bảng giá cổ phiếu thu nhỏ ở góc màn hình — MẶC ĐỊNH TẮT, bật ở nút 📈
          trên header. Sống ngoài mọi pane nên đổi tab vẫn thấy giá. */}
      <StockTickerHost />
      {/* Chấm dịch nhanh — nổi ở mọi view (Ctrl+Shift+Y). */}
      <QuickTranslate />

      {/* Bấm link trong tin nhắn Zalo/Telegram → hỏi mở ở tab Links hay tab
          Browser. Cửa sổ Zalo không bị đụng tới, vẫn nguyên khung chat. setMode
          bật tab đích, và effect `visited` ở trên mount nó nếu là lần ghé đầu. */}
      <OpenLinkDialog onGoTab={setMode} />

      {/* Job chuyển đổi file chạy ngầm: host này in PDF hộ (Chromium của
          Electron) và báo đường dẫn khi xong. */}
      <ConvertHost />

      {/* Mở app → kiểm tra Git, có bản mới thì hỏi "cập nhật không?" một lần.
          Đã mới nhất / không phải repo / mất mạng thì không hiện gì.
          Tắt bằng SELF_UPDATE_PROMPT=false trong .env.local. */}
      <UpdatePrompt />

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <footer className="appfoot">
        <span className="foot-left">
          {/* Cảnh báo critical ở góc trái footer — footer có mặt ở mọi tab và mọi
              vị trí menu (kể cả menu ẩn), không bị <webview> che. */}
          <CritBadge stacks={critStacks} onOpen={openMonitor} />
          <span>VHS DevBox · infra toolbox dùng chung cho mọi dự án</span>
        </span>
        <span className="foot-right">
          Redis · Kafka · RabbitMQ · MongoDB · Elastic · PostgreSQL · Office · Google · Mail · Links · Git · Webhooks · Automation
          {/* Đồng bộ configs/ với repo dev-box-config: đẩy lên một cú bấm,
              kéo về thì hỏi passphrase. Badge trên nút cho biết khi nào cần. */}
          <ConfigSyncButton />
          {/* Kéo bản mới của CHÍNH app này từ Git về. Badge = số commit đang
              chờ, nên liếc là biết có bản mới mà không phải bấm vào. */}
          <UpdateButton />
          {/* Dọn cache rồi nạp lại — để phân biệt "code sai" với "đang ăn bản
              cũ" mà không phải ngồi đoán. */}
          <HardReloadButton />
          {/* Desktop only: chế độ server (prod/dev/turbo), nhớ cho lần mở sau. */}
          <ServerModeButton />
          {/* Desktop only: log của shell + next dev, ẩn mặc định. */}
          <DesktopConsole />
        </span>
      </footer>
    </div>
  );
}
