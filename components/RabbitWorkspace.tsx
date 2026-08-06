'use client';

// RabbitMQ workspace — local dev only (server gates on RABBIT_TOOL_ENABLED).
// Talks to the RabbitMQ HTTP management API via /api/rabbit.
//
// This file is the SHELL: broker selection, sub-view routing, data loading and
// the mutation handlers. The views live in components/rabbit/*.
//
// Styling is self-owned under `.rabbit-*` (appended at the end of globals.css) —
// it deliberately no longer borrows the `.kafka-*` layout classes, so a Kafka
// redesign can't change this tab's appearance by accident.
//
// WRITE SAFETY: every mutating action passes two independent SERVER-side gates
// (RABBIT_ALLOW_DESTRUCTIVE env flag + per-connection readOnly, which defaults to
// on) plus a typed-confirm modal here. The `readOnly` flag drives the disabled
// state of every write control below; the server is still the authority.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchRabbitConnections,
  rabbitOverview,
  listRabbitQueues,
  describeRabbitQueue,
  listRabbitExchanges,
  describeRabbitExchange,
  listRabbitConnectionsLive,
  listRabbitChannels,
  listRabbitNodes,
  rabbitClusterHealth,
  listRabbitVhosts,
  listRabbitBindings,
  rabbitAliveness,
  peekRabbitMessages,
  publishRabbitMessage,
  createRabbitQueue,
  createRabbitExchange,
  createRabbitBinding,
  purgeRabbitQueue,
  deleteRabbitQueue,
  deleteRabbitExchange,
  deleteRabbitBinding,
  diffRabbitExchange,
  type PublicRabbitConnection,
  type OverviewResult,
  type QueueSummary,
  type QueueDetail,
  type ExchangeSummary,
  type ExchangeDetail,
  type ConnectionInfo,
  type ChannelInfo,
  type NodeInfo,
  type ClusterHealthResult,
  type VhostInfo,
  type BindingInfo,
  type PeekResult,
  type QueueDeclarationInput,
  type ExchangeDeclarationInput,
  type BindingDeclarationInput,
} from '@/lib/rabbit';
import BrokerRail from './rabbit/BrokerRail';
import OverviewView from './rabbit/OverviewView';
import QueuesView from './rabbit/QueuesView';
import ExchangesView from './rabbit/ExchangesView';
import BindingsView from './rabbit/BindingsView';
import ConnectionsLiveView from './rabbit/ConnectionsLiveView';
import PublishModal from './rabbit/PublishModal';

import { readLocal, writeLocal } from '@/lib/localKeys';

const LAST_CONN_KEY = 'rabbit.lastConn';
const DEFAULT_PEEK = 10;

type SubView = 'overview' | 'queues' | 'exchanges' | 'bindings' | 'connections';

const SUB_VIEWS: { key: SubView; label: string }[] = [
  { key: 'overview', label: 'Tổng quan' },
  { key: 'queues', label: 'Queues' },
  { key: 'exchanges', label: 'Exchanges' },
  { key: 'bindings', label: 'Bindings / Routing' },
  { key: 'connections', label: 'Connections' },
];

export default function RabbitWorkspace() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [connections, setConnections] = useState<PublicRabbitConnection[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [manageOpen, setManageOpen] = useState(false);
  const [editConn, setEditConn] = useState<PublicRabbitConnection | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [pings, setPings] = useState<Record<string, number | 'err'>>({});

  const [subView, setSubView] = useState<SubView>('overview');
  /** '' = every vhost the account can see. Scopes binding reads + new declarations. */
  const [vhostScope, setVhostScope] = useState('');

  // Overview / cluster
  const [overview, setOverview] = useState<OverviewResult | null>(null);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [health, setHealth] = useState<ClusterHealthResult | null>(null);
  const [vhosts, setVhosts] = useState<VhostInfo[]>([]);
  const [ovLoading, setOvLoading] = useState(false);

  // Queues
  const [queues, setQueues] = useState<QueueSummary[]>([]);
  const [queuesLoading, setQueuesLoading] = useState(false);
  const [selectedQueue, setSelectedQueue] = useState<{ vhost: string; name: string } | null>(null);
  const [queueDetail, setQueueDetail] = useState<QueueDetail | null>(null);
  const [qDetailLoading, setQDetailLoading] = useState(false);

  // Exchanges
  const [exchanges, setExchanges] = useState<ExchangeSummary[]>([]);
  const [exchangesLoading, setExchangesLoading] = useState(false);
  const [selectedExchange, setSelectedExchange] = useState<{ vhost: string; name: string } | null>(null);
  const [exchangeDetail, setExchangeDetail] = useState<ExchangeDetail | null>(null);
  const [xDetailLoading, setXDetailLoading] = useState(false);

  // Bindings
  const [bindings, setBindings] = useState<BindingInfo[]>([]);
  const [bindingsLoading, setBindingsLoading] = useState(false);

  // Live connections + channels
  const [liveConns, setLiveConns] = useState<ConnectionInfo[]>([]);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);

  // Peek + publish
  const [peek, setPeek] = useState<PeekResult | null>(null);
  const [peekLoading, setPeekLoading] = useState(false);
  const [publishTarget, setPublishTarget] = useState<{ kind: 'queue' | 'exchange'; vhost: string; name: string } | null>(null);

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
  // Fail safe: no broker resolved yet ⇒ treat as locked, never render armed buttons.
  const readOnly = active?.readOnly !== false;

  // ── Load connections ──────────────────────────────────────────────────────
  const loadConnections = useCallback(async () => {
    const res = await fetchRabbitConnections();
    setEnabled(res.enabled);
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

  // Reset every pane on broker change — stale data from another cluster is worse
  // than an empty pane.
  useEffect(() => {
    setOverview(null); setNodes([]); setHealth(null); setVhosts([]);
    setQueues([]); setExchanges([]); setBindings([]); setLiveConns([]); setChannels([]);
    setSelectedQueue(null); setQueueDetail(null);
    setSelectedExchange(null); setExchangeDetail(null);
    setPeek(null); setVhostScope('');
    setError(null);
  }, [activeId]);

  // ── Loaders ────────────────────────────────────────────────────────────────
  const loadOverview = useCallback(async () => {
    if (!activeId) return;
    setOvLoading(true); setError(null);
    // Four independent reads; a failing health probe or a broker that hides
    // /api/nodes must not blank the whole panel, so each settles on its own.
    const [ov, nd, hl, vh] = await Promise.allSettled([
      rabbitOverview(activeId),
      listRabbitNodes(activeId),
      rabbitClusterHealth(activeId),
      listRabbitVhosts(activeId),
    ]);
    if (ov.status === 'fulfilled') setOverview(ov.value); else setError((ov.reason as Error).message);
    if (nd.status === 'fulfilled') setNodes(nd.value);
    if (hl.status === 'fulfilled') setHealth(hl.value);
    if (vh.status === 'fulfilled') setVhosts(vh.value);
    setOvLoading(false);
  }, [activeId]);

  const loadQueues = useCallback(async () => {
    if (!activeId) return;
    setQueuesLoading(true); setError(null);
    try { setQueues(await listRabbitQueues(activeId)); }
    catch (e) { setError((e as Error).message); }
    finally { setQueuesLoading(false); }
  }, [activeId]);

  const loadExchanges = useCallback(async () => {
    if (!activeId) return;
    setExchangesLoading(true); setError(null);
    try { setExchanges(await listRabbitExchanges(activeId)); }
    catch (e) { setError((e as Error).message); }
    finally { setExchangesLoading(false); }
  }, [activeId]);

  /**
   * The bindings view needs three datasets: the binding graph itself plus the
   * exchange list (for types — the route tester can't match without them) and the
   * queue list (for the default-exchange path and the bind form's datalist).
   */
  const loadBindings = useCallback(async () => {
    if (!activeId) return;
    setBindingsLoading(true); setError(null);
    try {
      const [bs, xs, qs] = await Promise.all([
        listRabbitBindings(activeId, vhostScope || undefined),
        listRabbitExchanges(activeId),
        listRabbitQueues(activeId),
      ]);
      setBindings(bs); setExchanges(xs); setQueues(qs);
    } catch (e) { setError((e as Error).message); }
    finally { setBindingsLoading(false); }
  }, [activeId, vhostScope]);

  const loadLive = useCallback(async () => {
    if (!activeId) return;
    setLiveLoading(true); setError(null);
    const [cs, chs] = await Promise.allSettled([listRabbitConnectionsLive(activeId), listRabbitChannels(activeId)]);
    if (cs.status === 'fulfilled') setLiveConns(cs.value); else setError((cs.reason as Error).message);
    if (chs.status === 'fulfilled') setChannels(chs.value);
    setLiveLoading(false);
  }, [activeId]);

  // Lazy-load the active sub-view once per broker.
  useEffect(() => {
    if (!activeId) return;
    if (subView === 'overview' && !overview && !ovLoading) void loadOverview();
    if (subView === 'queues' && queues.length === 0 && !queuesLoading) void loadQueues();
    if (subView === 'exchanges' && exchanges.length === 0 && !exchangesLoading) void loadExchanges();
    if (subView === 'bindings' && bindings.length === 0 && !bindingsLoading) void loadBindings();
    if (subView === 'connections' && liveConns.length === 0 && !liveLoading) void loadLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subView, activeId]);

  const reloadCurrent = useCallback(() => {
    if (subView === 'overview') void loadOverview();
    else if (subView === 'queues') void loadQueues();
    else if (subView === 'exchanges') void loadExchanges();
    else if (subView === 'bindings') void loadBindings();
    else void loadLive();
  }, [subView, loadOverview, loadQueues, loadExchanges, loadBindings, loadLive]);

  // ── Detail selection ───────────────────────────────────────────────────────
  const selectQueue = useCallback(async (vhost: string, name: string) => {
    setSelectedQueue({ vhost, name });
    setQueueDetail(null); setPeek(null);
    setQDetailLoading(true); setError(null);
    try { setQueueDetail(await describeRabbitQueue(activeId, vhost, name)); }
    catch (e) { setError((e as Error).message); }
    finally { setQDetailLoading(false); }
  }, [activeId]);

  const selectExchange = useCallback(async (vhost: string, name: string) => {
    setSelectedExchange({ vhost, name });
    setExchangeDetail(null);
    setXDetailLoading(true); setError(null);
    try { setExchangeDetail(await describeRabbitExchange(activeId, vhost, name)); }
    catch (e) { setError((e as Error).message); }
    finally { setXDetailLoading(false); }
  }, [activeId]);

  // Leaving focus mode. Clearing the detail too (rather than keeping it warm for a
  // re-open) means re-selecting always shows live numbers — a queue's depth is the
  // whole reason you opened it, and a cached count is worse than a spinner.
  const clearQueue = useCallback(() => {
    setSelectedQueue(null); setQueueDetail(null); setPeek(null);
  }, []);

  const clearExchange = useCallback(() => {
    setSelectedExchange(null); setExchangeDetail(null);
  }, []);

  /**
   * Cross-view jump used by the DLX links and binding tables. The target's vhost
   * isn't in the link, so we resolve it from the loaded list; if that list hasn't
   * loaded yet we fall back to the current scope (defaulting to '/').
   */
  const openQueueByName = useCallback((name: string) => {
    const found = queues.find((q) => q.name === name);
    setSubView('queues');
    void selectQueue(found?.vhost ?? vhostScope ?? '/', name);
  }, [queues, vhostScope, selectQueue]);

  const openExchangeByName = useCallback((name: string) => {
    const found = exchanges.find((x) => x.name === name);
    setSubView('exchanges');
    void selectExchange(found?.vhost ?? vhostScope ?? '/', name);
  }, [exchanges, vhostScope, selectExchange]);

  const doPeek = useCallback(async (count: number) => {
    if (!selectedQueue) return;
    setPeekLoading(true); setError(null);
    try { setPeek(await peekRabbitMessages(activeId, selectedQueue.vhost, selectedQueue.name, count || DEFAULT_PEEK)); }
    catch (e) { setError((e as Error).message); setPeek(null); }
    finally { setPeekLoading(false); }
  }, [activeId, selectedQueue]);

  const doPing = useCallback(async (c: PublicRabbitConnection) => {
    try {
      const r = await rabbitOverview(c.id);
      setPings((p) => ({ ...p, [c.id]: r.latencyMs }));
    } catch {
      setPings((p) => ({ ...p, [c.id]: 'err' }));
    }
  }, []);

  // ── Mutations ──────────────────────────────────────────────────────────────
  // Each rethrows so the calling form can show the error inline (including the
  // server's 403 text when a guard is closed), while also surfacing it at the top.
  const runMutation = useCallback(async (label: string, fn: () => Promise<unknown>, after: () => void) => {
    setError(null);
    try {
      await fn();
      flash(label);
      after();
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, [flash]);

  const onCreateQueue = useCallback(async (d: QueueDeclarationInput) => {
    await runMutation(`Đã tạo queue ${d.name}`, () => createRabbitQueue(activeId, d), () => void loadQueues());
  }, [activeId, runMutation, loadQueues]);

  const onCreateExchange = useCallback(async (d: ExchangeDeclarationInput) => {
    await runMutation(`Đã tạo exchange ${d.name}`, () => createRabbitExchange(activeId, d), () => void loadExchanges());
  }, [activeId, runMutation, loadExchanges]);

  const onCreateBinding = useCallback(async (d: BindingDeclarationInput) => {
    await runMutation(
      `Đã bind ${d.source} → ${d.destination}`,
      () => createRabbitBinding(activeId, d),
      () => void loadBindings(),
    );
  }, [activeId, runMutation, loadBindings]);

  const onPurgeQueue = useCallback(async (vhost: string, name: string) => {
    await runMutation(`Đã purge ${name}`, () => purgeRabbitQueue(activeId, vhost, name), () => {
      void loadQueues();
      void selectQueue(vhost, name);
    });
  }, [activeId, runMutation, loadQueues, selectQueue]);

  const onDeleteQueue = useCallback(async (vhost: string, name: string, opts: { ifEmpty: boolean; ifUnused: boolean }) => {
    await runMutation(`Đã xoá queue ${name}`, () => deleteRabbitQueue(activeId, vhost, name, opts), () => {
      setSelectedQueue(null); setQueueDetail(null); setPeek(null);
      void loadQueues();
    });
  }, [activeId, runMutation, loadQueues]);

  const onDeleteExchange = useCallback(async (vhost: string, name: string, opts: { ifUnused: boolean }) => {
    await runMutation(`Đã xoá exchange ${name}`, () => deleteRabbitExchange(activeId, vhost, name, opts), () => {
      setSelectedExchange(null); setExchangeDetail(null);
      void loadExchanges();
    });
  }, [activeId, runMutation, loadExchanges]);

  const onDeleteBinding = useCallback(async (b: BindingInfo) => {
    await runMutation(
      `Đã xoá binding ${b.source} → ${b.destination}`,
      () => deleteRabbitBinding(activeId, {
        vhost: vhostScope || '/',
        source: b.source,
        destination: b.destination,
        destinationType: b.destinationType === 'exchange' ? 'exchange' : 'queue',
        propertiesKey: b.propertiesKey,
      }),
      () => void loadBindings(),
    );
  }, [activeId, vhostScope, runMutation, loadBindings]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (enabled === false) {
    return (
      <div className="panel" style={{ margin: 'auto', maxWidth: 560, textAlign: 'center' }}>
        <div className="empty-ico" aria-hidden>🐇</div>
        <h3>RabbitMQ tab đang tắt</h3>
        <p className="empty">
          Đặt <code>RABBIT_TOOL_ENABLED=true</code> trong <code>.env.local</code> rồi khởi động lại dev server để bật.
          Tab này gọi HTTP management API (mặc định cổng 15672) — chỉ dùng local.
        </p>
      </div>
    );
  }
  if (enabled === null) {
    return <div className="panel" style={{ margin: 'auto' }}><span className="spinner" /> Đang tải…</div>;
  }

  return (
    <div className="rabbit-layout">
      <BrokerRail
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
          flash(editConn ? 'Đã cập nhật' : 'Đã thêm broker');
        }}
        onDeleted={(list, deletedId) => {
          setConnections(list);
          if (activeId === deletedId) setActiveId(list[0]?.id ?? '');
          flash('Đã xoá broker khỏi danh sách');
        }}
        onError={setError}
      />

      <main className="panel rabbit-browser">
        {!active ? (
          <p className="empty" style={{ margin: 'auto' }}>Chọn hoặc thêm một broker để bắt đầu.</p>
        ) : (
          <>
            <div className="status-line" style={{ justifyContent: 'space-between' }}>
              <div className="rabbit-subnav">
                {SUB_VIEWS.map((v) => (
                  <button key={v.key} className={subView === v.key ? 'on' : ''} onClick={() => setSubView(v.key)}>
                    {v.label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {readOnly && <span className="badge" title="Thao tác ghi bị chặn">🔒 read-only</span>}
                <button className="chip-btn" onClick={reloadCurrent}>↻ Tải lại</button>
              </div>
            </div>

            {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
            {notice && <div className="badge" style={{ color: 'var(--ok)' }}>{notice}</div>}

            {subView === 'overview' && (
              <OverviewView
                overview={overview}
                nodes={nodes}
                health={health}
                vhosts={vhosts}
                loading={ovLoading}
                vhostScope={vhostScope}
                onVhostScope={(v) => { setVhostScope(v); setBindings([]); }}
                onReload={loadOverview}
                onAliveness={(v) => rabbitAliveness(activeId, v)}
              />
            )}

            {subView === 'queues' && (
              <QueuesView
                queues={queues}
                loading={queuesLoading}
                selected={selectedQueue}
                detail={queueDetail}
                detailLoading={qDetailLoading}
                readOnly={readOnly}
                vhostScope={vhostScope}
                peek={peek}
                peekLoading={peekLoading}
                onSelect={(v, n) => void selectQueue(v, n)}
                onClearSelect={clearQueue}
                onPeek={(n) => void doPeek(n)}
                onPublish={(v, n) => setPublishTarget({ kind: 'queue', vhost: v, name: n })}
                onCreate={onCreateQueue}
                onPurge={onPurgeQueue}
                onDelete={onDeleteQueue}
                onOpenExchange={openExchangeByName}
              />
            )}

            {subView === 'exchanges' && (
              <ExchangesView
                exchanges={exchanges}
                loading={exchangesLoading}
                selected={selectedExchange}
                detail={exchangeDetail}
                detailLoading={xDetailLoading}
                readOnly={readOnly}
                vhostScope={vhostScope}
                onSelect={(v, n) => void selectExchange(v, n)}
                onClearSelect={clearExchange}
                onPublish={(v, n) => setPublishTarget({ kind: 'exchange', vhost: v, name: n })}
                onCreate={onCreateExchange}
                onDelete={onDeleteExchange}
                onDiff={(d) => diffRabbitExchange(activeId, d)}
                onOpenQueue={openQueueByName}
              />
            )}

            {subView === 'bindings' && (
              <BindingsView
                bindings={bindings}
                exchanges={exchanges}
                queues={queues}
                loading={bindingsLoading}
                readOnly={readOnly}
                vhostScope={vhostScope}
                onCreate={onCreateBinding}
                onDelete={onDeleteBinding}
                onOpenQueue={openQueueByName}
              />
            )}

            {subView === 'connections' && (
              <ConnectionsLiveView connections={liveConns} channels={channels} loading={liveLoading} />
            )}
          </>
        )}
      </main>

      {publishTarget && active && (
        <PublishModal
          target={publishTarget}
          onClose={() => setPublishTarget(null)}
          onSent={(routed) => {
            setPublishTarget(null);
            flash(routed ? 'Đã publish — message được route' : 'Đã publish nhưng KHÔNG route được (unroutable)');
          }}
          onPublish={(payload) => publishRabbitMessage(activeId, payload)}
        />
      )}
    </div>
  );
}
