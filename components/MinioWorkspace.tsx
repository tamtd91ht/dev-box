'use client';

// MinIO / S3 workspace — local dev only (server gates on MINIO_TOOL_ENABLED).
// Talks to MinIO via /api/minio (the Next server owns the S3 clients).
//
// This file is the SHELL: connection selection + sub-view routing. Views live in
// components/minio/*. Reads are always available; writes (upload, delete,
// create/remove bucket) sit behind MINIO_ALLOW_WRITE (server) + per-connection
// readOnly (defaults ON). Layout/styling reuse the `.pg-*` rail classes.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchMinioConnections,
  listMinioBuckets,
  minioInfo,
  minioMetrics,
  minioHostMetrics,
  pingMinio,
  type MinioBucketInfo,
  type MinioHostMetrics,
  type MinioMetrics,
  type MinioTestResult,
  type PublicMinioConnection,
} from '@/lib/minio';
import ConnRail from './minio/ConnRail';
import OverviewView from './minio/OverviewView';
import BrowserView from './minio/BrowserView';
import ConsoleView from './minio/ConsoleView';

import { readLocal, writeLocal } from '@/lib/localKeys';
import { onInfraFocus } from '@/lib/infraFocus';
import { useSplit } from '@/lib/useSplit';
import Splitter from './Splitter';
import { useConnRailCollapse, CollapsedConnRail } from './ConnRailCollapse';

const LAST_CONN_KEY = 'minio.lastConn';
const LAST_VIEW_KEY = 'minio.lastView';

type SubView = 'overview' | 'browser' | 'console';

const SUB_VIEWS: { key: SubView; label: string }[] = [
  { key: 'overview', label: 'Tổng quan' },
  { key: 'browser', label: 'Object' },
  { key: 'console', label: '🖥 Console' },
];

export default function MinioWorkspace() {
  const rail = useSplit({ varName: '--pg-rail', min: 180, max: 560, gap: 14 });
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [allowWrite, setAllowWrite] = useState(false);
  const [connections, setConnections] = useState<PublicMinioConnection[]>([]);
  const railHide = useConnRailCollapse('minio', connections.length);

  const [activeId, setActiveId] = useState<string>('');
  const [manageOpen, setManageOpen] = useState(false);
  const [editConn, setEditConn] = useState<PublicMinioConnection | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [pings, setPings] = useState<Record<string, number | 'err'>>({});

  // Khởi tạo 'overview' rồi mới nạp lại trong effect — không đọc localStorage ngay
  // trong initializer (HTML dựng ở server khác client ⇒ lỗi hydrate).
  const [subView, setSubView] = useState<SubView>('overview');
  useEffect(() => {
    const saved = readLocal(LAST_VIEW_KEY);
    if (saved && SUB_VIEWS.some((v) => v.key === saved)) setSubView(saved as SubView);
  }, []);
  useEffect(() => { writeLocal(LAST_VIEW_KEY, subView); }, [subView]);
  /** Set by the Overview "open bucket" jump; consumed by BrowserView. */
  const [jumpBucket, setJumpBucket] = useState<string | undefined>(undefined);

  const [info, setInfo] = useState<MinioTestResult | null>(null);
  const [buckets, setBuckets] = useState<MinioBucketInfo[]>([]);
  const [metrics, setMetrics] = useState<MinioMetrics | null>(null);
  const [hosts, setHosts] = useState<MinioHostMetrics[]>([]);
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
  // Mục Console chỉ có khi server khai Console URL; đã ghé một lần thì GIỮ mounted
  // (ẩn bằng CSS) để chuyển mục qua lại không phải đăng nhập + tải lại Console.
  const hasConsole = !!active?.consoleUrl;
  const view: SubView = subView === 'console' && !hasConsole ? 'overview' : subView;
  const [consoleSeen, setConsoleSeen] = useState<string>('');
  useEffect(() => { if (view === 'console' && activeId) setConsoleSeen(activeId); }, [view, activeId]);
  // Fail safe: no connection resolved yet ⇒ treat as locked.
  const readOnly = active?.readOnly !== false;

  const loadConnections = useCallback(async () => {
    const res = await fetchMinioConnections();
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

  // Monitor bấm "↗ Mở …" → chọn ĐÚNG CỤM đang báo và mục liên quan (lib/infraFocus).
  // Chỉ nghe khi đã có danh sách kết nối, để biết id đó còn tồn tại.
  useEffect(() => {
    if (!connections.length) return;
    return onInfraFocus('minio', (f) => {
      if (!connections.some((c) => c.id === f.connId)) return;
      setActiveId(f.connId);
      if (f.view && SUB_VIEWS.some((v) => v.key === f.view)) setSubView(f.view as SubView);
    });
  }, [connections]);

  useEffect(() => {
    setInfo(null); setBuckets([]); setMetrics(null); setHosts([]); setJumpBucket(undefined);
    setError(null);
  }, [activeId]);

  const loadOverview = useCallback(async () => {
    if (!activeId) return;
    setOvLoading(true); setError(null);
    // Metrics cụm + máy chủ là phần THÊM: không đọc được (chưa có token, exporter tắt)
    // không được làm hỏng tổng quan cơ bản nên không đẩy vào `error`.
    const [inf, bks, mt, hm] = await Promise.allSettled([
      minioInfo(activeId),
      listMinioBuckets(activeId),
      minioMetrics(activeId),
      minioHostMetrics(activeId),
    ]);
    if (inf.status === 'fulfilled') setInfo(inf.value); else setError((inf.reason as Error).message);
    if (bks.status === 'fulfilled') setBuckets(bks.value);
    setMetrics(mt.status === 'fulfilled' ? mt.value : null);
    setHosts(hm.status === 'fulfilled' ? hm.value : []);
    setOvLoading(false);
  }, [activeId]);

  useEffect(() => {
    if (!activeId) return;
    if (subView === 'overview' && !info && !ovLoading) void loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subView, activeId]);

  const doPing = useCallback(async (c: PublicMinioConnection) => {
    try {
      const r = await pingMinio(c.id);
      setPings((p) => ({ ...p, [c.id]: r.latencyMs }));
    } catch {
      setPings((p) => ({ ...p, [c.id]: 'err' }));
    }
  }, []);

  if (enabled === false) {
    return (
      <div className="panel" style={{ margin: 'auto', maxWidth: 560, textAlign: 'center' }}>
        <div className="empty-ico" aria-hidden>🪣</div>
        <h3>MinIO tab đang tắt</h3>
        <p className="empty">
          Đặt <code>MINIO_TOOL_ENABLED=true</code> trong <code>.env.local</code> rồi khởi động lại dev server để bật.
          Muốn cho phép upload / xoá / tạo-xoá bucket thì đặt thêm <code>MINIO_ALLOW_WRITE=true</code> — chỉ dùng local.
        </p>
      </div>
    );
  }
  if (enabled === null) {
    return <div className="panel" style={{ margin: 'auto' }}><span className="spinner" /> Đang tải…</div>;
  }

  return (
    <div className="pg-layout" ref={rail.ref} style={{ ...rail.style, ...(railHide.collapsed ? { '--pg-rail': '34px' } : null) }}>
      {railHide.collapsed ? (
        <CollapsedConnRail label="MinIO" count={connections.length} onShow={railHide.show} />
      ) : (
      <ConnRail
        onHide={railHide.hide}
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
      )}

      <main className="panel pg-workspace-main">
        {!active ? (
          <>
            {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
            {notice && <div className="badge" style={{ color: 'var(--ok)' }}>{notice}</div>}
            <p className="empty" style={{ margin: 'auto' }}>Chọn hoặc thêm một server để bắt đầu.</p>
          </>
        ) : (
          <>
            <div className="status-line" style={{ justifyContent: 'space-between' }}>
              <div className="pg-subnav">
                {SUB_VIEWS.filter((v) => v.key !== 'console' || hasConsole).map((v) => (
                  <button key={v.key} className={view === v.key ? 'on' : ''} onClick={() => setSubView(v.key)}>
                    {v.label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {readOnly
                  ? <span className="badge" title="Upload/xoá bị chặn trên connection này (xem, tải xuống vẫn thoải mái)">🔒 read-only</span>
                  : allowWrite
                    ? <span className="badge" style={{ color: 'var(--err)' }} title="Upload / xoá / tạo-xoá bucket đang mở trên connection này">✎ write armed</span>
                    : <span className="badge" title="MINIO_ALLOW_WRITE chưa bật — write khoá toàn tool">🔒 write off (env)</span>}
                {active.consoleUrl && (
                  <a className="chip-btn" href={active.consoleUrl} target="_blank" rel="noreferrer"
                    title={`Mở MinIO Console (giao diện web quản trị)\n${active.consoleUrl}`}>🖥 Console ↗</a>
                )}
                {view === 'overview' && <button className="chip-btn" onClick={() => void loadOverview()}>↻ Tải lại</button>}
              </div>
            </div>

            {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
            {notice && <div className="badge" style={{ color: 'var(--ok)' }}>{notice}</div>}

            {view === 'overview' && (
              <OverviewView
                connectionId={activeId}
                info={info}
                metrics={metrics}
                hosts={hosts}
                hasMetricsUrls={(active.metricsUrls?.length ?? 0) > 0}
                buckets={buckets}
                loading={ovLoading}
                onReload={loadOverview}
                onOpenBucket={(b) => { setJumpBucket(b); setSubView('browser'); }}
              />
            )}

            {view === 'browser' && (
              <BrowserView
                key={activeId}
                connectionId={activeId}
                readOnly={readOnly}
                allowWrite={allowWrite}
                initialBucket={jumpBucket}
              />
            )}
            {hasConsole && consoleSeen === activeId && (
              <div style={{ display: view === 'console' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
                <ConsoleView key={activeId} conn={active} />
              </div>
            )}
          </>
        )}
      </main>
      {!railHide.collapsed && <Splitter {...rail.grip} />}
    </div>
  );
}
