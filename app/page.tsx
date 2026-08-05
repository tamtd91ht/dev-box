'use client';

// VHS DevBox — infra toolbox shell. Forked from omicx-local-all-in-one with the
// OMICX API Explorer and the Telegram review bot removed: this build is the
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
import AutomationWorkspace from '@/components/automation/AutomationWorkspace';
import AutomationHost from '@/components/AutomationHost';
import GitAutoPullHost from '@/components/GitAutoPullHost';
import MailWatchHost from '@/components/MailWatchHost';
import WorkWorkspace from '@/components/WorkWorkspace';
import WorkAlertHost from '@/components/WorkAlertHost';
import ConvertHost from '@/components/ConvertHost';
import NotificationCenter from '@/components/NotificationCenter';
import { notices } from '@/lib/noticeStore';
import ThemeToggle from '@/components/ThemeToggle';
import DesktopConsole from '@/components/DesktopConsole';
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

  // Lazy mount-and-keep per workspace: don't probe a tool's API until the user
  // opens it, then keep it mounted so its state survives tab switches.
  // Exception: the browser Workspace mounts from startup — its whole point is
  // alerting about new messages (Zalo) while you work on OTHER tabs, so its
  // guests must be running before the tab is ever clicked.
  const [visited, setVisited] = useState<Record<string, boolean>>({ workspace: true });
  useEffect(() => {
    setVisited((v) => (v[mode] ? v : { ...v, [mode]: true }));
  }, [mode]);

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
              aria-selected={mode === t.key}
              className={[
                mode === t.key ? 'on' : '',
                // Alert the Workspace tab while you're viewing ANY other tab.
                t.key === 'workspace' && wsUnread > 0 && mode !== 'workspace' ? 'ms-alert' : '',
                // Mail đến chưa đọc — nháy khi đang ở tab khác.
                t.key === 'mail' && mailUnread > 0 && mode !== 'mail' ? 'ms-alert' : '',
                nUnread > 0 && mode !== t.key ? 'ms-alert' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => setMode(t.key)}
            >
              <span className="ms-ico" aria-hidden>{t.icon}</span>
              {t.label}
              {t.key === 'workspace' && wsUnread > 0 ? (
                <span
                  className={`ms-unread ms-bell${mode !== 'workspace' ? ' ringing' : ''}`}
                  title={`${wsUnread} tin nhắn mới`}
                >
                  <span className="ms-bell-ico" aria-hidden>🔔</span>
                  {wsUnread > 99 ? '99+' : wsUnread}
                </span>
              ) : t.key === 'mail' && mailUnread > 0 ? (
                // Bộ đếm sống: hiện cả khi ĐANG ở tab Mail (như hòm thư thật),
                // chỉ về 0 khi mail được đọc trên server.
                <span
                  className={`ms-unread ms-bell${mode !== 'mail' ? ' ringing' : ''}`}
                  title={`${mailUnread} email chưa đọc`}
                >
                  <span className="ms-bell-ico" aria-hidden>✉️</span>
                  {mailUnread > 99 ? '99+' : mailUnread}
                </span>
              ) : nUnread > 0 ? (
                <span
                  className={`ms-unread ms-bell${mode !== t.key ? ' ringing' : ''}`}
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
              aria-selected={mode === `pack:${p.id}`}
              className={`${mode === `pack:${p.id}` ? 'on ' : ''}ms-pack`}
              title={p.manifestError ? `manifest lỗi: ${p.manifestError}` : p.root}
              onClick={() => setMode(`pack:${p.id}`)}
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
          {/* Hòm thông báo: xem lại lịch sử (local, 2 ngày) + xóa tất cả. */}
          <NotificationCenter />
          <ThemeToggle />
        </div>
      </header>

      {/* ── Body: workspaces (mount-and-keep) ───────────────────────── */}
      <div className="body">
        {visited.work && (
          <main className="workspace" style={paneStyle(mode === 'work')} aria-hidden={mode !== 'work'}>
            <WorkWorkspace />
          </main>
        )}
        {visited.git && (
          <main className="workspace" style={paneStyle(mode === 'git')} aria-hidden={mode !== 'git'}>
            <GitWorkspace />
          </main>
        )}
        {visited.code && (
          <main className="workspace" style={paneStyle(mode === 'code')} aria-hidden={mode !== 'code'}>
            <CodeStudio />
          </main>
        )}
        {visited.redis && (
          <main className="workspace" style={paneStyle(mode === 'redis')} aria-hidden={mode !== 'redis'}>
            <RedisWorkspace />
          </main>
        )}
        {visited.kafka && (
          <main className="workspace" style={paneStyle(mode === 'kafka')} aria-hidden={mode !== 'kafka'}>
            <KafkaWorkspace />
          </main>
        )}
        {visited.rabbit && (
          <main className="workspace" style={paneStyle(mode === 'rabbit')} aria-hidden={mode !== 'rabbit'}>
            <RabbitWorkspace />
          </main>
        )}
        {visited.mongo && (
          <main className="workspace" style={paneStyle(mode === 'mongo')} aria-hidden={mode !== 'mongo'}>
            <MongoWorkspace />
          </main>
        )}
        {visited.es && (
          <main className="workspace" style={paneStyle(mode === 'es')} aria-hidden={mode !== 'es'}>
            <EsWorkspace />
          </main>
        )}
        {visited.pg && (
          <main className="workspace" style={paneStyle(mode === 'pg')} aria-hidden={mode !== 'pg'}>
            <PgWorkspace />
          </main>
        )}
        {visited.office && (
          <main className="workspace" style={paneStyle(mode === 'office')} aria-hidden={mode !== 'office'}>
            <OfficeWorkspace />
          </main>
        )}
        {visited.google && (
          <main className="workspace" style={paneStyle(mode === 'google')} aria-hidden={mode !== 'google'}>
            <GoogleWorkspace />
          </main>
        )}
        {visited.mail && (
          <main className="workspace" style={paneStyle(mode === 'mail')} aria-hidden={mode !== 'mail'}>
            <MailWorkspace />
          </main>
        )}
        {visited.links && (
          /* hostsWebviews: viewer nhúng (LinkViewer) có thể đang mở khi chuyển
             tab — webview vẽ ở native layer, phải đưa offscreen chứ không
             visibility:hidden được. */
          <main className="workspace" style={paneStyle(mode === 'links', true)} aria-hidden={mode !== 'links'}>
            <LinksWorkspace />
          </main>
        )}
        {visited.apps && (
          <main className="workspace" style={paneStyle(mode === 'apps')} aria-hidden={mode !== 'apps'}>
            <AppsWorkspace />
          </main>
        )}
        {visited.tools && (
          <main className="workspace" style={paneStyle(mode === 'tools')} aria-hidden={mode !== 'tools'}>
            <ToolsWorkspace />
          </main>
        )}
        {visited.api && (
          <main className="workspace" style={paneStyle(mode === 'api')} aria-hidden={mode !== 'api'}>
            <ApiWorkspace />
          </main>
        )}
        {visited.browser && (
          <main className="workspace" style={paneStyle(mode === 'browser', true)} aria-hidden={mode !== 'browser'}>
            <BrowserTabWorkspace />
          </main>
        )}
        {visited.workspace && (
          <main className="workspace" style={paneStyle(mode === 'workspace', true)} aria-hidden={mode !== 'workspace'}>
            <BrowserWorkspace onUnread={setWsUnread} visible={mode === 'workspace'} />
          </main>
        )}
        {visited.automation && (
          <main className="workspace" style={paneStyle(mode === 'automation')} aria-hidden={mode !== 'automation'}>
            <AutomationWorkspace />
          </main>
        )}
        {/* Project packs — one mounted workspace per visited pack. */}
        {packs.map((p) => visited[`pack:${p.id}`] && (
          <main
            key={p.id}
            className="workspace"
            style={paneStyle(mode === `pack:${p.id}`)}
            aria-hidden={mode !== `pack:${p.id}`}
          >
            <ApiExplorerWorkspace packId={p.id} />
          </main>
        ))}

        {mode === 'packs' && (
          <main className="workspace" style={paneStyle(true)}>
            <PackManager
              packs={packs}
              onChanged={setPacks}
              onOpen={(id) => setMode(`pack:${id}`)}
            />
          </main>
        )}

        {mode === 'webhooks' && (
          <main className="workspace" style={paneStyle(true)}>
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

      {/* Job chuyển đổi file chạy ngầm: host này in PDF hộ (Chromium của
          Electron) và báo đường dẫn khi xong. */}
      <ConvertHost />

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <footer className="appfoot">
        <span>VHS DevBox · infra toolbox dùng chung cho mọi dự án</span>
        <span className="foot-right">
          Redis · Kafka · RabbitMQ · MongoDB · Elastic · PostgreSQL · Office · Google · Mail · Links · Git · Webhooks · Automation
          {/* Desktop only: log của shell + next dev, ẩn mặc định. */}
          <DesktopConsole />
        </span>
      </footer>
    </div>
  );
}
