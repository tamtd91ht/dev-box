'use client';

// VHS DevBox — infra toolbox shell. Forked from omicx-local-all-in-one with the
// OMICX API Explorer and the Telegram review bot removed: this build is the
// company-wide datastore/broker manager (Webhooks · Git · Redis · Kafka ·
// RabbitMQ · MongoDB · Elastic · PostgreSQL). Each workspace mounts lazily and
// stays mounted (hidden) across tab switches so long-running state survives.

import { useEffect, useMemo, useRef, useState } from 'react';
import WebhookReceiver from '@/components/WebhookReceiver';
import GitWorkspace from '@/components/GitWorkspace';
import RedisWorkspace from '@/components/RedisWorkspace';
import KafkaWorkspace from '@/components/KafkaWorkspace';
import RabbitWorkspace from '@/components/RabbitWorkspace';
import MongoWorkspace from '@/components/MongoWorkspace';
import EsWorkspace from '@/components/EsWorkspace';
import PgWorkspace from '@/components/PgWorkspace';
import ThemeToggle from '@/components/ThemeToggle';
import { resolveAuth, authReady as isAuthReady } from '@/lib/request';
import {
  fetchFullConfig,
  saveLocalConfig,
  type LocalConfig,
  type GlobalVars,
} from '@/lib/persist';

const DEFAULT_BASE_URL = 'http://localhost:8090';

/** Trim a base URL to host[:port] for a compact header chip. */
function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
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

type Mode = 'webhooks' | 'git' | 'redis' | 'kafka' | 'rabbit' | 'mongo' | 'es' | 'pg';

const TABS: { key: Mode; icon: string; label: string; badge: string }[] = [
  { key: 'git', icon: '⎇', label: 'Git', badge: 'local' },
  { key: 'redis', icon: '◆', label: 'Redis', badge: 'local' },
  { key: 'kafka', icon: '≋', label: 'Kafka', badge: 'local' },
  { key: 'rabbit', icon: '🐇', label: 'RabbitMQ', badge: 'local' },
  { key: 'mongo', icon: '🍃', label: 'MongoDB', badge: 'local' },
  { key: 'es', icon: '🔍', label: 'Elastic', badge: 'local' },
  { key: 'pg', icon: '🐘', label: 'PostgreSQL', badge: 'local' },
  { key: 'webhooks', icon: '⚡', label: 'Webhooks', badge: 'tool' },
];

export default function Home() {
  const [mode, setMode] = useState<Mode>('git');

  // Lazy mount-and-keep per workspace: don't probe a tool's API until the user
  // opens it, then keep it mounted so its state survives tab switches.
  const [visited, setVisited] = useState<Record<Mode, boolean>>({
    webhooks: false, git: false, redis: false, kafka: false, rabbit: false, mongo: false, es: false, pg: false,
  });
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
    <div className="shell">
      {/* ── Header / top bar ─────────────────────────────────────────── */}
      <header className="appbar">
        <div className="brand">
          <div className="brand-mark">V</div>
          <div className="brand-text">
            <h1><b>VHS</b> DevBox</h1>
            <span className="sub">infra toolbox — mọi dự án</span>
          </div>
        </div>

        <div className="modeswitch" role="tablist" aria-label="Workspace">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={mode === t.key}
              className={mode === t.key ? 'on' : ''}
              onClick={() => setMode(t.key)}
            >
              <span className="ms-ico" aria-hidden>{t.icon}</span>
              {t.label}
              <span className="ms-badge">{t.badge}</span>
            </button>
          ))}
        </div>

        <div className="appbar-right">
          {mode === 'webhooks' && (
            <button
              className="chip-btn"
              onClick={() => setWebhookSettingsOpen(true)}
              title="Cài đặt kết nối tool-service + realtime socket"
            >
              <span className={`kdot ${toolAuthReady ? 'on' : 'off'}`} />
              <span className="kdot-host">{shortHost(toolBaseUrl)}</span>
              <span className="cog" aria-hidden>⚙</span>
            </button>
          )}
          <ThemeToggle />
        </div>
      </header>

      {/* ── Body: workspaces (mount-and-keep) ───────────────────────── */}
      <div className="body">
        {visited.git && (
          <main className="workspace" style={{ gridColumn: '1 / -1', display: mode === 'git' ? undefined : 'none' }} aria-hidden={mode !== 'git'}>
            <GitWorkspace />
          </main>
        )}
        {visited.redis && (
          <main className="workspace" style={{ gridColumn: '1 / -1', display: mode === 'redis' ? undefined : 'none' }} aria-hidden={mode !== 'redis'}>
            <RedisWorkspace />
          </main>
        )}
        {visited.kafka && (
          <main className="workspace" style={{ gridColumn: '1 / -1', display: mode === 'kafka' ? undefined : 'none' }} aria-hidden={mode !== 'kafka'}>
            <KafkaWorkspace />
          </main>
        )}
        {visited.rabbit && (
          <main className="workspace" style={{ gridColumn: '1 / -1', display: mode === 'rabbit' ? undefined : 'none' }} aria-hidden={mode !== 'rabbit'}>
            <RabbitWorkspace />
          </main>
        )}
        {visited.mongo && (
          <main className="workspace" style={{ gridColumn: '1 / -1', display: mode === 'mongo' ? undefined : 'none' }} aria-hidden={mode !== 'mongo'}>
            <MongoWorkspace />
          </main>
        )}
        {visited.es && (
          <main className="workspace" style={{ gridColumn: '1 / -1', display: mode === 'es' ? undefined : 'none' }} aria-hidden={mode !== 'es'}>
            <EsWorkspace />
          </main>
        )}
        {visited.pg && (
          <main className="workspace" style={{ gridColumn: '1 / -1', display: mode === 'pg' ? undefined : 'none' }} aria-hidden={mode !== 'pg'}>
            <PgWorkspace />
          </main>
        )}

        {mode === 'webhooks' && (
          <main className="workspace" style={{ gridColumn: '1 / -1' }}>
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
              onCloseSettings={() => setWebhookSettingsOpen(false)}
            />
          </main>
        )}
      </div>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <footer className="appfoot">
        <span>VHS DevBox · infra toolbox dùng chung cho mọi dự án</span>
        <span className="foot-right">
          Redis · Kafka · RabbitMQ · MongoDB · Elastic · PostgreSQL · Git · Webhooks
        </span>
      </footer>
    </div>
  );
}
