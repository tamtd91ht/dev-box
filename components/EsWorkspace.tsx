'use client';

// Elasticsearch workspace — local dev only (server gates on ES_TOOL_ENABLED).
// Talks to ES via /api/es (the Next server issues the REST calls; clusters sit
// on the VPN with no auth, so a connection is just host + port).
//
// This file is the SHELL: connection selection + sub-view routing. Views live
// in components/es/*. The whole tab is READ-ONLY (search/count/mapping/health)
// — there is no write action to gate. Styling self-owned under `.es-*`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchEsConnections,
  pingEs,
  esHealth,
  listEsIndices,
  listEsNodes,
  type PublicEsConnection,
  type EsHealthResult,
  type EsIndexInfo,
  type EsNodeInfo,
} from '@/lib/es';
import ConnRail from './es/ConnRail';
import OverviewView from './es/OverviewView';
import BrowserView from './es/BrowserView';
import QuickFindView from './es/QuickFindView';

const LAST_CONN_KEY = 'omicx.es.lastConn';

type SubView = 'overview' | 'browser' | 'quickfind';

const SUB_VIEWS: { key: SubView; label: string }[] = [
  { key: 'overview', label: 'Tổng quan' },
  { key: 'browser', label: 'Dữ liệu' },
  { key: 'quickfind', label: '🔎 Tìm nhanh' },
];

export default function EsWorkspace() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [connections, setConnections] = useState<PublicEsConnection[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [manageOpen, setManageOpen] = useState(false);
  const [editConn, setEditConn] = useState<PublicEsConnection | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [pings, setPings] = useState<Record<string, number | 'err'>>({});

  const [subView, setSubView] = useState<SubView>('overview');
  /** Set by the Overview "open index" jump; consumed by BrowserView. */
  const [jumpIndex, setJumpIndex] = useState<string | undefined>(undefined);

  const [health, setHealth] = useState<EsHealthResult | null>(null);
  const [nodes, setNodes] = useState<EsNodeInfo[]>([]);
  const [indices, setIndices] = useState<EsIndexInfo[]>([]);
  const [ovLoading, setOvLoading] = useState(false);
  /** 10s live monitor (heap/disk/cpu/load) — on by default, pausable. */
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshAt, setLastRefreshAt] = useState(0);

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

  const loadConnections = useCallback(async () => {
    const res = await fetchEsConnections();
    setEnabled(res.enabled);
    setConnections(res.connections);
    if (!res.enabled) return;
    setActiveId((cur) => {
      const remembered = typeof window !== 'undefined' ? window.localStorage.getItem(LAST_CONN_KEY) ?? '' : '';
      const pick = [cur, remembered].find((id) => id && res.connections.some((c) => c.id === id));
      return pick || res.connections[0]?.id || '';
    });
  }, []);

  useEffect(() => { void loadConnections(); }, [loadConnections]);

  useEffect(() => {
    if (activeId && typeof window !== 'undefined') window.localStorage.setItem(LAST_CONN_KEY, activeId);
  }, [activeId]);

  useEffect(() => {
    setHealth(null); setNodes([]); setIndices([]); setJumpIndex(undefined);
    setLastRefreshAt(0);
    setError(null);
  }, [activeId]);

  const loadOverview = useCallback(async () => {
    if (!activeId) return;
    setOvLoading(true); setError(null);
    const [h, nd, ix] = await Promise.allSettled([esHealth(activeId), listEsNodes(activeId), listEsIndices(activeId)]);
    if (h.status === 'fulfilled') setHealth(h.value); else setError((h.reason as Error).message);
    if (nd.status === 'fulfilled') { setNodes(nd.value); setLastRefreshAt(Date.now()); }
    if (ix.status === 'fulfilled') setIndices(ix.value);
    setOvLoading(false);
  }, [activeId]);

  useEffect(() => {
    if (!activeId) return;
    if (subView === 'overview' && !health && !ovLoading) void loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subView, activeId]);

  /**
   * Live monitor: refresh _cat/nodes + _cluster/health every 10s — ONLY while
   * the Overview is the active sub-view, the browser tab is visible, and the
   * toggle is on. Silent (no spinner) so gauges glide instead of flashing.
   */
  useEffect(() => {
    if (!activeId || subView !== 'overview' || !autoRefresh) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void (async () => {
        const [h, nd] = await Promise.allSettled([esHealth(activeId), listEsNodes(activeId)]);
        if (h.status === 'fulfilled') setHealth(h.value);
        if (nd.status === 'fulfilled') { setNodes(nd.value); setLastRefreshAt(Date.now()); }
      })();
    }, 10_000);
    return () => clearInterval(timer);
  }, [activeId, subView, autoRefresh]);

  const doPing = useCallback(async (c: PublicEsConnection) => {
    try {
      const r = await pingEs(c.id);
      setPings((p) => ({ ...p, [c.id]: r.latencyMs }));
    } catch {
      setPings((p) => ({ ...p, [c.id]: 'err' }));
    }
  }, []);

  if (enabled === false) {
    return (
      <div className="panel" style={{ margin: 'auto', maxWidth: 560, textAlign: 'center' }}>
        <div className="empty-ico" aria-hidden>🔍</div>
        <h3>Elastic tab đang tắt</h3>
        <p className="empty">
          Đặt <code>ES_TOOL_ENABLED=true</code> trong <code>.env.local</code> rồi khởi động lại dev server để bật.
          Tab này gọi REST API cluster (mặc định cổng 9200, qua VPN) — read-only, chỉ dùng local.
        </p>
      </div>
    );
  }
  if (enabled === null) {
    return <div className="panel" style={{ margin: 'auto' }}><span className="spinner" /> Đang tải…</div>;
  }

  return (
    <div className="es-layout">
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

      <main className="panel es-workspace-main">
        {!active ? (
          <p className="empty" style={{ margin: 'auto' }}>Chọn hoặc thêm một cluster để bắt đầu.</p>
        ) : (
          <>
            <div className="status-line" style={{ justifyContent: 'space-between' }}>
              <div className="es-subnav">
                {SUB_VIEWS.map((v) => (
                  <button key={v.key} className={subView === v.key ? 'on' : ''} onClick={() => setSubView(v.key)}>
                    {v.label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="badge" title="Tab này chỉ đọc — không có thao tác ghi nào">👁 read-only</span>
                {subView === 'overview' && <button className="chip-btn" onClick={() => void loadOverview()}>↻ Tải lại</button>}
              </div>
            </div>

            {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
            {notice && <div className="badge" style={{ color: 'var(--ok)' }}>{notice}</div>}

            {subView === 'overview' && (
              <OverviewView
                health={health}
                nodes={nodes}
                indices={indices}
                loading={ovLoading}
                autoRefresh={autoRefresh}
                onAutoRefresh={setAutoRefresh}
                lastRefreshAt={lastRefreshAt}
                onReload={loadOverview}
                onOpenIndex={(ix) => { setJumpIndex(ix); setSubView('browser'); }}
              />
            )}

            {subView === 'browser' && (
              <BrowserView key={activeId} connectionId={activeId} initialIndex={jumpIndex} />
            )}

            {/* Quick-find targets its OWN saved connection (per preset). */}
            {subView === 'quickfind' && <QuickFindView connections={connections} />}
          </>
        )}
      </main>
    </div>
  );
}
