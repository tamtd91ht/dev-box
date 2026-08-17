'use client';

// PostgreSQL workspace — local dev only (server gates on PG_TOOL_ENABLED).
// Talks to PG via /api/pg (the Next server owns the pg pools).
//
// This file is the SHELL: connection selection + sub-view routing. Views live
// in components/pg/*. Reads run inside READ ONLY transactions server-side; the
// ONLY write is UPDATE-with-WHERE behind three independent gates —
// PG_ALLOW_WRITE env (server) + per-connection readOnly (defaults ON) + a
// typed-confirm modal with dry-run count (UI). Styling self-owned under `.pg-*`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchPgConnections,
  pingPg,
  pgInfo,
  listPgDatabases,
  type PublicPgConnection,
  type PgTestResult,
  type PgDatabaseInfo,
} from '@/lib/pg';
import ConnRail from './pg/ConnRail';
import OverviewView from './pg/OverviewView';
import BrowserView from './pg/BrowserView';
import QuickFindView from './pg/QuickFindView';

import { readLocal, writeLocal } from '@/lib/localKeys';
import { useSplit } from '@/lib/useSplit';
import Splitter from './Splitter';

const LAST_CONN_KEY = 'pg.lastConn';

type SubView = 'overview' | 'browser' | 'quickfind';

const SUB_VIEWS: { key: SubView; label: string }[] = [
  { key: 'overview', label: 'Tổng quan' },
  { key: 'browser', label: 'Dữ liệu' },
  { key: 'quickfind', label: '🔎 Tìm nhanh' },
];

export default function PgWorkspace() {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const rail = useSplit({ varName: '--pg-rail', min: 180, max: 560, gap: 14 });
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [allowWrite, setAllowWrite] = useState(false);
  const [connections, setConnections] = useState<PublicPgConnection[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [manageOpen, setManageOpen] = useState(false);
  const [editConn, setEditConn] = useState<PublicPgConnection | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [pings, setPings] = useState<Record<string, number | 'err'>>({});

  const [subView, setSubView] = useState<SubView>('overview');
  /** Set by the Overview "open db" jump; consumed by BrowserView. */
  const [jumpDb, setJumpDb] = useState<string | undefined>(undefined);

  const [info, setInfo] = useState<PgTestResult | null>(null);
  const [databases, setDatabases] = useState<PgDatabaseInfo[]>([]);
  const [ovLoading, setOvLoading] = useState(false);

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
  // Fail safe: no connection resolved yet ⇒ treat as locked.
  const readOnly = active?.readOnly !== false;

  const loadConnections = useCallback(async () => {
    const res = await fetchPgConnections();
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

  useEffect(() => {
    setInfo(null); setDatabases([]); setJumpDb(undefined);
    setError(null);
  }, [activeId]);

  const loadOverview = useCallback(async () => {
    if (!activeId) return;
    setOvLoading(true); setError(null);
    const [inf, dbs] = await Promise.allSettled([pgInfo(activeId), listPgDatabases(activeId)]);
    if (inf.status === 'fulfilled') setInfo(inf.value); else setError((inf.reason as Error).message);
    if (dbs.status === 'fulfilled') setDatabases(dbs.value);
    setOvLoading(false);
  }, [activeId]);

  useEffect(() => {
    if (!activeId) return;
    if (subView === 'overview' && !info && !ovLoading) void loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subView, activeId]);

  const doPing = useCallback(async (c: PublicPgConnection) => {
    try {
      const r = await pingPg(c.id);
      setPings((p) => ({ ...p, [c.id]: r.latencyMs }));
    } catch {
      setPings((p) => ({ ...p, [c.id]: 'err' }));
    }
  }, []);

  if (enabled === false) {
    return (
      <div className="panel" style={{ margin: 'auto', maxWidth: 560, textAlign: 'center' }}>
        <div className="empty-ico" aria-hidden>🐘</div>
        <h3>PostgreSQL tab đang tắt</h3>
        <p className="empty">
          Đặt <code>PG_TOOL_ENABLED=true</code> trong <code>.env.local</code> rồi khởi động lại dev server để bật.
          Muốn cho phép UPDATE (bắt buộc WHERE) thì đặt thêm <code>PG_ALLOW_WRITE=true</code> — chỉ dùng local.
        </p>
      </div>
    );
  }
  if (enabled === null) {
    return <div className="panel" style={{ margin: 'auto' }}><span className="spinner" /> Đang tải…</div>;
  }

  return (
    <div className="pg-layout" ref={rail.ref} style={rail.style}>
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
          flash(editConn ? 'Đã cập nhật' : 'Đã thêm server');
        }}
        onDeleted={(list, deletedId) => {
          setConnections(list);
          if (activeId === deletedId) setActiveId(list[0]?.id ?? '');
          flash('Đã xoá server khỏi danh sách');
        }}
        onImported={(summary) => { void loadConnections(); flash(summary); }}
        onError={setError}
      />

      <main className="panel pg-workspace-main">
        {!active ? (
          <p className="empty" style={{ margin: 'auto' }}>Chọn hoặc thêm một server để bắt đầu.</p>
        ) : (
          <>
            <div className="status-line" style={{ justifyContent: 'space-between' }}>
              <div className="pg-subnav">
                {SUB_VIEWS.map((v) => (
                  <button key={v.key} className={subView === v.key ? 'on' : ''} onClick={() => setSubView(v.key)}>
                    {v.label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {readOnly
                  ? <span className="badge" title="UPDATE bị chặn trên connection này (SELECT vẫn thoải mái)">🔒 read-only</span>
                  : allowWrite
                    ? <span className="badge" style={{ color: 'var(--err)' }} title="UPDATE-with-WHERE đang mở trên connection này">✎ write armed</span>
                    : <span className="badge" title="PG_ALLOW_WRITE chưa bật — write khoá toàn tool">🔒 write off (env)</span>}
                {subView === 'overview' && <button className="chip-btn" onClick={() => void loadOverview()}>↻ Tải lại</button>}
              </div>
            </div>

            {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
            {notice && <div className="badge" style={{ color: 'var(--ok)' }}>{notice}</div>}

            {subView === 'overview' && (
              <OverviewView
                info={info}
                databases={databases}
                loading={ovLoading}
                onReload={loadOverview}
                onOpenDb={(db) => { setJumpDb(db); setSubView('browser'); }}
              />
            )}

            {subView === 'browser' && (
              <BrowserView
                key={activeId}
                connectionId={activeId}
                defaultDb={active.database}
                readOnly={readOnly}
                allowWrite={allowWrite}
                initialDb={jumpDb}
              />
            )}

            {/* Quick-find targets its OWN saved connection (per preset). */}
            {subView === 'quickfind' && <QuickFindView connections={connections} />}
          </>
        )}
      </main>
      <Splitter {...rail.grip} />
    </div>
  );
}
