'use client';

// MongoDB workspace — local dev only (server gates on MONGO_TOOL_ENABLED).
// Talks to MongoDB via /api/mongo (the Next server owns the driver client).
//
// This file is the SHELL: connection selection + sub-view routing. The views
// live in components/mongo/*. Layout model is Robo3T-lite: connection rail on
// the left, then Overview (server + databases) or Data browser (db/collection
// tree + query + results).
//
// Styling is self-owned under `.mongo-*` (appended at the end of globals.css).
//
// WRITE SAFETY: the ONLY write is update-with-query, behind three independent
// gates — MONGO_ALLOW_WRITE env flag (server) + per-connection readOnly
// (defaults ON) + a typed-confirm modal with dry-run count (UI). Reads are
// unrestricted in scope, bounded in cost server-side (maxTimeMS + page caps).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchMongoConnections,
  pingMongo,
  mongoServerInfo,
  mongoMonitor,
  listMongoDatabases,
  type PublicMongoConnection,
  type ServerInfoResult,
  type DatabaseInfo,
  type MongoMonitorResult,
} from '@/lib/mongo';
import ConnRail from './mongo/ConnRail';
import OverviewView from './mongo/OverviewView';
import BrowserView from './mongo/BrowserView';
import QuickFindView from './mongo/QuickFindView';

import { readLocal, writeLocal } from '@/lib/localKeys';
import { useSplit } from '@/lib/useSplit';
import Splitter from './Splitter';

const LAST_CONN_KEY = 'mongo.lastConn';

type SubView = 'overview' | 'browser' | 'quickfind';

const SUB_VIEWS: { key: SubView; label: string }[] = [
  { key: 'overview', label: 'Tổng quan' },
  { key: 'browser', label: 'Dữ liệu' },
  { key: 'quickfind', label: '🔎 Tìm nhanh' },
];

export default function MongoWorkspace() {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const rail = useSplit({ varName: '--mongo-rail', min: 180, max: 560, gap: 14 });
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [allowWrite, setAllowWrite] = useState(false);
  const [connections, setConnections] = useState<PublicMongoConnection[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [manageOpen, setManageOpen] = useState(false);
  const [editConn, setEditConn] = useState<PublicMongoConnection | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [pings, setPings] = useState<Record<string, number | 'err'>>({});

  const [subView, setSubView] = useState<SubView>('overview');
  /** Set by the Overview "open db" jump; consumed by BrowserView. */
  const [jumpDb, setJumpDb] = useState<string | undefined>(undefined);

  // Overview data
  const [info, setInfo] = useState<ServerInfoResult | null>(null);
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [ovLoading, setOvLoading] = useState(false);
  // Live monitor (30s): snapshot + previous snapshot for ops/s rates.
  const [monitorData, setMonitorData] = useState<MongoMonitorResult | null>(null);
  const prevMonitorRef = useRef<MongoMonitorResult | null>(null);
  const [opsPerSec, setOpsPerSec] = useState<Record<string, number> | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshAt, setLastRefreshAt] = useState(0);

  const takeMonitorSnapshot = useCallback(async (id: string) => {
    try {
      const m = await mongoMonitor(id);
      const prev = prevMonitorRef.current;
      if (prev && m.at > prev.at) {
        const dt = (m.at - prev.at) / 1000;
        const rates: Record<string, number> = {};
        for (const k of ['insert', 'query', 'update', 'delete', 'command'] as const) {
          rates[k] = Math.max(0, (m.opcounters[k] - prev.opcounters[k]) / dt);
        }
        setOpsPerSec(rates);
      }
      prevMonitorRef.current = m;
      setMonitorData(m);
      setLastRefreshAt(Date.now());
    } catch { /* monitor is best-effort — a denied serverStatus must not error the tab */ }
  }, []);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((m: string) => {
    setNotice(m);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  const active = useMemo(() => connections.find((c) => c.id === activeId) ?? null, [connections, activeId]);
  // Fail safe: no connection resolved yet ⇒ treat as locked, never render armed buttons.
  const readOnly = active?.readOnly !== false;

  // ── Load connections ──────────────────────────────────────────────────────
  const loadConnections = useCallback(async () => {
    const res = await fetchMongoConnections();
    setEnabled(res.enabled);
    setAllowWrite(res.allowWrite);
    setConnections(res.connections);
    if (!res.enabled) return;
    setActiveId((cur) => {
      const remembered = readLocal(LAST_CONN_KEY) ?? '';
      const pick = [cur, remembered].find((id) => id && res.connections.some((c) => c.id === id));
      return pick || res.connections[0]?.id || '';
    });
  }, []);

  useEffect(() => { void loadConnections(); }, [loadConnections]);

  useEffect(() => {
    if (activeId) writeLocal(LAST_CONN_KEY, activeId);
  }, [activeId]);

  // Reset every pane on connection change — stale data from another cluster is
  // worse than an empty pane.
  useEffect(() => {
    setInfo(null); setDatabases([]); setJumpDb(undefined);
    setMonitorData(null); setOpsPerSec(null); prevMonitorRef.current = null; setLastRefreshAt(0);
    setError(null);
  }, [activeId]);

  // ── Overview loader ────────────────────────────────────────────────────────
  const loadOverview = useCallback(async () => {
    if (!activeId) return;
    setOvLoading(true); setError(null);
    // Two independent reads; a missing listDatabases privilege must not blank
    // the server-info card, so each settles on its own.
    const [inf, dbs] = await Promise.allSettled([
      mongoServerInfo(activeId),
      listMongoDatabases(activeId),
    ]);
    if (inf.status === 'fulfilled') setInfo(inf.value); else setError((inf.reason as Error).message);
    if (dbs.status === 'fulfilled') setDatabases(dbs.value);
    void takeMonitorSnapshot(activeId);
    setOvLoading(false);
  }, [activeId, takeMonitorSnapshot]);

  // Lazy-load overview once per connection.
  useEffect(() => {
    if (!activeId) return;
    if (subView === 'overview' && !info && !ovLoading) void loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subView, activeId]);

  // Live monitor: refresh serverStatus/dbStats/replSetGetStatus every 30s —
  // ONLY while the Overview is open, the browser tab is visible, and the
  // toggle is on. Silent so gauges glide instead of flashing.
  useEffect(() => {
    if (!activeId || subView !== 'overview' || !autoRefresh) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void takeMonitorSnapshot(activeId);
    }, 30_000);
    return () => clearInterval(timer);
  }, [activeId, subView, autoRefresh, takeMonitorSnapshot]);

  const doPing = useCallback(async (c: PublicMongoConnection) => {
    try {
      const r = await pingMongo(c.id);
      setPings((p) => ({ ...p, [c.id]: r.latencyMs }));
    } catch {
      setPings((p) => ({ ...p, [c.id]: 'err' }));
    }
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  if (enabled === false) {
    return (
      <div className="panel" style={{ margin: 'auto', maxWidth: 560, textAlign: 'center' }}>
        <div className="empty-ico" aria-hidden>🍃</div>
        <h3>MongoDB tab đang tắt</h3>
        <p className="empty">
          Đặt <code>MONGO_TOOL_ENABLED=true</code> trong <code>.env.local</code> rồi khởi động lại dev server để bật.
          Muốn cho phép update (có query) thì đặt thêm <code>MONGO_ALLOW_WRITE=true</code> — chỉ dùng local.
        </p>
      </div>
    );
  }
  if (enabled === null) {
    return <div className="panel" style={{ margin: 'auto' }}><span className="spinner" /> Đang tải…</div>;
  }

  return (
    <div className="mongo-layout" ref={rail.ref} style={rail.style}>
      <ConnRail
        connections={connections}
        activeId={activeId}
        pings={pings}
        manageOpen={manageOpen}
        editConn={editConn}
        menuId={menuId}
        onActivate={setActiveId}
        onPing={doPing}
        onMenu={setMenuId}
        onEdit={(c) => { setEditConn(c); setManageOpen(true); }}
        onToggleManage={() => { setManageOpen((v) => !v); setEditConn(null); }}
        onCloseForm={() => { setManageOpen(false); setEditConn(null); }}
        onSaved={(saved) => {
          setManageOpen(false); setEditConn(null);
          setConnections(saved.list); setActiveId(saved.activeId);
          flash(editConn ? 'Đã cập nhật' : 'Đã thêm cluster');
        }}
        onDeleted={(list, deletedId) => {
          setConnections(list);
          if (activeId === deletedId) setActiveId(list[0]?.id ?? '');
          flash('Đã xoá cluster khỏi danh sách');
        }}
        onError={setError}
      />

      <main className="panel mongo-workspace-main">
        {!active ? (
          <p className="empty" style={{ margin: 'auto' }}>Chọn hoặc thêm một cluster để bắt đầu.</p>
        ) : (
          <>
            <div className="status-line" style={{ justifyContent: 'space-between' }}>
              <div className="mongo-subnav">
                {SUB_VIEWS.map((v) => (
                  <button key={v.key} className={subView === v.key ? 'on' : ''} onClick={() => setSubView(v.key)}>
                    {v.label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {readOnly
                  ? <span className="badge" title="Update bị chặn trên connection này">🔒 read-only</span>
                  : allowWrite
                    ? <span className="badge" style={{ color: 'var(--err)' }} title="Update-with-query đang mở trên connection này">✎ write armed</span>
                    : <span className="badge" title="MONGO_ALLOW_WRITE chưa bật — write khoá toàn tool">🔒 write off (env)</span>}
                {subView === 'overview' && <button className="chip-btn" onClick={() => void loadOverview()}>↻ Tải lại</button>}
              </div>
            </div>

            {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
            {notice && <div className="badge" style={{ color: 'var(--ok)' }}>{notice}</div>}

            {subView === 'overview' && (
              <OverviewView
                info={info}
                databases={databases}
                monitor={monitorData}
                opsPerSec={opsPerSec}
                autoRefresh={autoRefresh}
                onAutoRefresh={setAutoRefresh}
                lastRefreshAt={lastRefreshAt}
                loading={ovLoading}
                onReload={loadOverview}
                onOpenDb={(db) => { setJumpDb(db); setSubView('browser'); }}
              />
            )}

            {subView === 'browser' && (
              // key= remounts the browser per connection so tree/query state can't leak.
              <BrowserView
                key={activeId}
                connectionId={activeId}
                readOnly={readOnly}
                allowWrite={allowWrite}
                initialDb={jumpDb}
              />
            )}

            {/* Quick-find targets its OWN saved connection (per preset), so it is
                NOT keyed by activeId — switching cluster in the rail keeps a
                running quick-find intact. */}
            {subView === 'quickfind' && <QuickFindView connections={connections} />}
          </>
        )}
      </main>
      <Splitter {...rail.grip} />
    </div>
  );
}
