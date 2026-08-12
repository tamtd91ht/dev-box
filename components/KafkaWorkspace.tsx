'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchKafkaConnections,
  mutateKafkaConnection,
  testKafkaConnection,
  listKafkaTopics,
  describeKafkaTopic,
  listKafkaGroups,
  describeKafkaGroup,
  peekKafkaMessages,
  searchKafkaMessages,
  produceKafkaMessage,
  fmtInt,
  fmtTs,
  type PublicKafkaConnection,
  type TopicSummary,
  type TopicDetail,
  type GroupSummary,
  type GroupDetail,
  type MessagePage,
  type PreviewMessage,
  type TopicConsumerGroup,
  listKafkaTopicGroups,
} from '@/lib/kafka';
import DateTimeField from '@/components/DateTimeField';
import HealthStrip from './kafka/HealthStrip';
import {
  loadPresets,
  addPreset,
  updatePreset,
  removePreset,
  clampWindowMinutes,
  DEFAULT_WINDOW_MINUTES,
  MAX_WINDOW_MINUTES,
  type KafkaPreset,
} from '@/lib/kafkaPresets';

/** localStorage key remembering the last-selected connection. */
import { readLocal, writeLocal } from '@/lib/localKeys';
import { useSplit } from '@/lib/useSplit';
import Splitter from './Splitter';

const LAST_CONN_KEY = 'kafka.lastConn';
/** Default number of messages a "peek" pulls. */
const DEFAULT_PEEK = 20;

type SubView = 'topics' | 'groups';
/** Inner tabs of a selected topic (Kafka-HQ style: messages front-and-center). */
type TopicTab = 'messages' | 'partitions' | 'groups';

/**
 * One browser-style tab: everything scoped to ONE topic being inspected. Several
 * can be open at once (topic A on cluster 1 next to topic B on cluster 2), so all
 * of this is per-tab rather than component-wide — switching tabs is pure state
 * swapping, no refetch.
 */
interface TabState {
  id: string;
  /** Cluster this tab is pinned to — a tab keeps its cluster even if the rail moves on. */
  connectionId: string;
  /** null = tab is showing the topic picker (a "new tab"). */
  topic: string | null;
  detail: TopicDetail | null;
  detailLoading: boolean;
  /** Which inner tab of the topic is showing. */
  view: TopicTab;
  // Message filter + results.
  fromInput: string;
  toInput: string;
  keyword: string;
  peekN: string;
  messages: MessagePage | null;
  msgLoading: boolean;
  msgMode: 'peek' | 'search' | null;
  /** Consumer groups consuming this topic (+ lag) — lazy-loaded when its view opens. */
  groups: TopicConsumerGroup[] | null;
  groupsLoading: boolean;
  /** Set once the auto-peek has fired for the current topic, so it runs exactly once. */
  peeked: boolean;
  error: string | null;
}

let tabSeq = 0;
/** A fresh empty tab (topic picker) for the given cluster. */
function newTab(connectionId: string, topic: string | null = null): TabState {
  tabSeq += 1;
  const now = Date.now();
  return {
    id: `t${tabSeq}`,
    connectionId,
    topic,
    detail: null,
    detailLoading: false,
    view: 'messages',
    fromInput: toLocalInput(now - 15 * 60 * 1000),
    toInput: toLocalInput(now),
    keyword: '',
    peekN: String(DEFAULT_PEEK),
    messages: null,
    msgLoading: false,
    msgMode: null,
    groups: null,
    groupsLoading: false,
    peeked: false,
    error: null,
  };
}

/** Search is ONLY enabled once BOTH a valid time window AND a keyword are present —
 *  the window is what keeps search fast (seek to the offset range, no full scan). */
function canSearchTab(t: TabState): boolean {
  const from = t.fromInput ? new Date(t.fromInput).getTime() : NaN;
  const to = t.toInput ? new Date(t.toInput).getTime() : NaN;
  return Number.isFinite(from) && Number.isFinite(to) && to > from && t.keyword.trim().length > 0;
}

/** Format an epoch-ms into a `datetime-local` input value (local time, minute precision). */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Kafka inspector — local dev only (server gates on KAFKA_TOOL_ENABLED). Configure
 * multiple clusters grouped by project (name + bootstrap brokers). Inspect topics
 * (partition count, offsets, replication), consumer groups + lag, peek the latest
 * messages, produce a test message, and search messages within a REQUIRED time
 * window + keyword (the time window is what keeps search fast — it seeks straight
 * to the matching offset range instead of scanning the whole topic). The browser
 * never talks to Kafka directly — every op goes through /api/kafka.
 */
export default function KafkaWorkspace() {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const railSplit = useSplit({ varName: '--kafka-rail', min: 180, max: 560, gap: 18 });
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [connections, setConnections] = useState<PublicKafkaConnection[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [manageOpen, setManageOpen] = useState(false);
  const [editConn, setEditConn] = useState<PublicKafkaConnection | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);

  /** Test latency (ms) or 'err' per connection id — shown as a live badge. */
  const [pings, setPings] = useState<Record<string, number | 'err'>>({});

  const [subView, setSubView] = useState<SubView>('topics');

  // ── Topics ────────────────────────────────────────────────────────────────
  // Topic list is per-CLUSTER (not per-tab) — two tabs on the same cluster share
  // one fetched list. Keyed by connection id so switching clusters doesn't refetch.
  const [topicsByConn, setTopicsByConn] = useState<Record<string, TopicSummary[]>>({});
  const [topicsLoading, setTopicsLoading] = useState(false);
  const [topicFilter, setTopicFilter] = useState('');
  const [showInternal, setShowInternal] = useState(false);

  // ── Tabs: each holds one topic + its own messages/search state ──────────────
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>('');

  const [produceOpen, setProduceOpen] = useState(false);
  /** Message currently open in the detail drawer (null = drawer closed). */
  const [selectedMsg, setSelectedMsg] = useState<PreviewMessage | null>(null);

  // ── Groups ────────────────────────────────────────────────────────────────
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [groupDetail, setGroupDetail] = useState<GroupDetail | null>(null);
  const [groupLoading, setGroupLoading] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ── Quick-search presets ────────────────────────────────────────────────────
  const [presets, setPresets] = useState<KafkaPreset[]>([]);
  /** Whether the floating preset dock is expanded. */
  const [presetOpen, setPresetOpen] = useState(false);
  /** Preset being edited/added in the manage view (null = not editing). */
  const [presetEdit, setPresetEdit] = useState<KafkaPreset | 'new' | null>(null);
  /** Preset currently being run — drives the single-screen run modal. */
  const [runPresetState, setRunPresetState] = useState<{ preset: KafkaPreset } | null>(null);

  // Presets live in localStorage — hydrate on mount (client-only).
  useEffect(() => {
    setPresets(loadPresets());
  }, []);

  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, []);

  const active = useMemo(() => connections.find((c) => c.id === activeId) ?? null, [connections, activeId]);

  // ── Tab plumbing ────────────────────────────────────────────────────────────
  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? null, [tabs, activeTabId]);

  /** Patch one tab by id. Safe to call from an async callback after the tab closed
   *  (the map simply matches nothing). */
  const patchTab = useCallback((id: string, patch: Partial<TabState> | ((t: TabState) => Partial<TabState>)) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)));
  }, []);

  /** Open a new tab on a cluster (optionally already pointed at a topic) and focus it. */
  const openTab = useCallback((connectionId: string, topic: string | null = null) => {
    const tab = newTab(connectionId, topic);
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    return tab;
  }, []);

  /** Close a tab; focus the neighbour on its left (or right if it was first). */
  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const at = prev.findIndex((t) => t.id === id);
      if (at === -1) return prev;
      const next = prev.filter((t) => t.id !== id);
      setActiveTabId((cur) => (cur === id ? next[Math.max(0, at - 1)]?.id ?? '' : cur));
      return next;
    });
  }, []);

  // Always keep at least one tab open once a cluster is available, and never leave
  // the focus dangling on a closed tab.
  useEffect(() => {
    if (!activeId) return;
    if (tabs.length === 0) { openTab(activeId); return; }
    if (!tabs.some((t) => t.id === activeTabId)) setActiveTabId(tabs[0].id);
  }, [activeId, tabs, activeTabId, openTab]);

  /** Topics of the cluster the ACTIVE TAB is on (the list the picker shows). */
  const tabConnId = activeTab?.connectionId ?? activeId;
  const topics = useMemo(() => topicsByConn[tabConnId] ?? [], [topicsByConn, tabConnId]);

  // ── Connection loading ──────────────────────────────────────────────────────
  const loadConnections = useCallback(async (preferId?: string) => {
    const res = await fetchKafkaConnections();
    setEnabled(res.enabled);
    setConnections(res.connections);
    if (!res.enabled) return;
    setActiveId((cur) => {
      const remembered = readLocal(LAST_CONN_KEY) ?? '';
      const pick = [preferId, cur, remembered].find((id) => id && res.connections.some((c) => c.id === id));
      return pick || res.connections[0]?.id || '';
    });
  }, []);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  useEffect(() => {
    if (activeId) writeLocal(LAST_CONN_KEY, activeId);
  }, [activeId]);

  // Switching cluster in the rail only resets the CLUSTER-scoped panes (consumer
  // groups). Open topic tabs keep their own cluster + results and are untouched —
  // that's the whole point of tabs. The active tab follows the rail only if it's
  // still an empty "new tab" (nothing to lose); otherwise a fresh tab is opened.
  useEffect(() => {
    if (!activeId) return;
    setSelectedGroup(null);
    setGroupDetail(null);
    setGroups([]);
    setTabs((prev) => {
      const cur = prev.find((t) => t.id === activeTabId);
      if (!cur || cur.connectionId === activeId) return prev;
      if (cur.topic === null) return prev.map((t) => (t.id === cur.id ? { ...t, connectionId: activeId } : t));
      const tab = newTab(activeId);
      setActiveTabId(tab.id);
      return [...prev, tab];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // ── Topics ──────────────────────────────────────────────────────────────────
  /** Fetch (or refetch) the topic list for a cluster into the shared per-cluster cache. */
  const loadTopics = useCallback(async (connId?: string) => {
    const id = connId ?? tabConnId;
    if (!id) return;
    setTopicsLoading(true);
    setError(null);
    try {
      const list = await listKafkaTopics(id);
      setTopicsByConn((prev) => ({ ...prev, [id]: list }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTopicsLoading(false);
    }
  }, [tabConnId]);

  // Auto-load topics when the Topics view shows a cluster we haven't listed yet.
  useEffect(() => {
    if (subView === 'topics' && tabConnId && !topicsByConn[tabConnId] && !topicsLoading) void loadTopics(tabConnId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subView, tabConnId]);

  /** Point a tab at a topic and load its detail (which then triggers the auto-peek). */
  const selectTopicIn = useCallback(
    async (tabId: string, connId: string, name: string) => {
      setSelectedMsg(null);
      const now = Date.now();
      patchTab(tabId, {
        topic: name,
        detail: null,
        detailLoading: true,
        view: 'messages',
        groups: null,
        messages: null,
        msgMode: null,
        peeked: false,
        error: null,
        // Seed a sensible default time window for search: last 15 minutes.
        fromInput: toLocalInput(now - 15 * 60 * 1000),
        toInput: toLocalInput(now),
        keyword: '',
      });
      try {
        const detail = await describeKafkaTopic(connId, name);
        patchTab(tabId, { detail, detailLoading: false });
      } catch (e) {
        patchTab(tabId, { detailLoading: false, error: (e as Error).message });
      }
    },
    [patchTab],
  );

  const filteredTopics = useMemo(() => {
    const q = topicFilter.trim().toLowerCase();
    return topics.filter((t) => (showInternal || !t.internal) && (!q || t.name.toLowerCase().includes(q)));
  }, [topics, topicFilter, showInternal]);

  // ── Messages ──────────────────────────────────────────────────────────────
  /** Peek the newest N messages of a tab's topic. */
  const doPeek = useCallback(async (tab: TabState) => {
    if (!tab.topic) return;
    patchTab(tab.id, { msgLoading: true, msgMode: 'peek', error: null, peeked: true });
    try {
      const page = await peekKafkaMessages(tab.connectionId, tab.topic, Number(tab.peekN) || DEFAULT_PEEK);
      // Re-seed the search window around the newest real message so the default
      // window lands on data (a fixed "last 15 min" is empty on an idle topic).
      const newest = page.messages.reduce((mx, m) => (Number.isFinite(m.timestamp) && m.timestamp > mx ? m.timestamp : mx), 0);
      patchTab(tab.id, {
        messages: page,
        msgLoading: false,
        ...(newest > 0
          ? { fromInput: toLocalInput(newest - 15 * 60 * 1000), toInput: toLocalInput(newest + 60 * 1000) }
          : null),
      });
    } catch (e) {
      patchTab(tab.id, { msgLoading: false, messages: null, error: (e as Error).message });
    }
  }, [patchTab]);

  /** Search a tab's topic within its time window + keyword. */
  const doSearch = useCallback(async (tab: TabState) => {
    const fromMs = tab.fromInput ? new Date(tab.fromInput).getTime() : NaN;
    const toMs = tab.toInput ? new Date(tab.toInput).getTime() : NaN;
    if (!tab.topic || !canSearchTab(tab)) return;
    patchTab(tab.id, { msgLoading: true, msgMode: 'search', error: null });
    try {
      const page = await searchKafkaMessages(tab.connectionId, {
        topic: tab.topic, fromMs, toMs, keyword: tab.keyword.trim(),
      });
      patchTab(tab.id, { messages: page, msgLoading: false });
    } catch (e) {
      patchTab(tab.id, { msgLoading: false, messages: null, error: (e as Error).message });
    }
  }, [patchTab]);

  // Kafka-HQ style: as soon as a topic's detail lands, show its latest messages.
  // `peeked` makes this fire exactly once per topic — a preset-driven tab is created
  // with peeked:true so its own search result is never overwritten.
  useEffect(() => {
    const t = tabs.find((x) => x.detail && x.topic && !x.peeked && !x.msgLoading);
    if (t) void doPeek(t);
  }, [tabs, doPeek]);

  /** Consumer groups on a tab's topic (+ lag) — lazy, when its inner tab opens. */
  const loadTopicGroups = useCallback(async (tab: TabState) => {
    if (!tab.topic) return;
    patchTab(tab.id, { groupsLoading: true, error: null });
    try {
      const groups = await listKafkaTopicGroups(tab.connectionId, tab.topic);
      patchTab(tab.id, { groups, groupsLoading: false });
    } catch (e) {
      patchTab(tab.id, { groups: null, groupsLoading: false, error: (e as Error).message });
    }
  }, [patchTab]);

  useEffect(() => {
    if (activeTab && activeTab.view === 'groups' && activeTab.topic && activeTab.groups === null && !activeTab.groupsLoading) {
      void loadTopicGroups(activeTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, activeTab?.view, activeTab?.topic]);

  // ── Groups ──────────────────────────────────────────────────────────────────
  const loadGroups = useCallback(async () => {
    if (!activeId) return;
    setGroupsLoading(true);
    setError(null);
    try {
      setGroups(await listKafkaGroups(activeId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGroupsLoading(false);
    }
  }, [activeId]);

  useEffect(() => {
    if (subView === 'groups' && activeId && groups.length === 0 && !groupsLoading) void loadGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subView, activeId]);

  const selectGroup = useCallback(
    async (groupId: string) => {
      setSelectedGroup(groupId);
      setGroupDetail(null);
      setGroupLoading(true);
      setError(null);
      try {
        setGroupDetail(await describeKafkaGroup(activeId, groupId));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setGroupLoading(false);
      }
    },
    [activeId],
  );

  // ── Connection test (badge) ─────────────────────────────────────────────────
  const doTest = useCallback(async (conn: PublicKafkaConnection) => {
    try {
      const r = await testKafkaConnection(conn.brokers);
      setPings((p) => ({ ...p, [conn.id]: r.latencyMs }));
    } catch {
      setPings((p) => ({ ...p, [conn.id]: 'err' }));
    }
  }, []);

  // Close the ⋯ menu on outside click / Escape.
  useEffect(() => {
    if (!menuId) return;
    const close = () => setMenuId(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuId(null);
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuId]);

  // Esc-to-close + Ctrl+F find are owned by MessageDrawer itself (it needs Esc to
  // close the find bar first, then the drawer), so no drawer keyboard handler here.

  /** Return the active tab from its topic back to the topic picker. */
  const backToTopics = useCallback(() => {
    if (!activeTab) return;
    setSelectedMsg(null);
    patchTab(activeTab.id, { topic: null, detail: null, messages: null, msgMode: null, groups: null, peeked: false });
  }, [activeTab, patchTab]);

  // ── Preset execution ────────────────────────────────────────────────────────
  /**
   * Run a saved preset with a resolved keyword + time window: open a NEW tab on the
   * preset's cluster + topic and search there — so a preset never disturbs whatever
   * you already had open. The tab starts with peeked:true so the auto-peek effect
   * leaves the search result alone.
   */
  const executePreset = useCallback(
    (preset: KafkaPreset, kw: string, fromLocal: string, toLocal: string) => {
      const from = new Date(fromLocal).getTime();
      const to = new Date(toLocal).getTime();
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
        setError('Khoảng thời gian không hợp lệ.');
        return;
      }
      setActiveId(preset.connectionId);
      setSubView('topics');
      setSelectedMsg(null);
      setError(null);

      const tab: TabState = {
        ...newTab(preset.connectionId, preset.topic),
        fromInput: fromLocal,
        toInput: toLocal,
        keyword: kw,
        detailLoading: true,
        msgLoading: true,
        msgMode: 'search',
        peeked: true, // this tab runs its own search — don't auto-peek over it
      };
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(tab.id);

      // Topic detail (partition/offset badges) loads alongside — don't block on it.
      void describeKafkaTopic(preset.connectionId, preset.topic)
        .then((detail) => patchTab(tab.id, { detail, detailLoading: false }))
        .catch((e) => patchTab(tab.id, { detailLoading: false, error: (e as Error).message }));
      void searchKafkaMessages(preset.connectionId, { topic: preset.topic, fromMs: from, toMs: to, keyword: kw.trim() })
        .then((page) => patchTab(tab.id, { messages: page, msgLoading: false }))
        .catch((e) => patchTab(tab.id, { messages: null, msgLoading: false, error: (e as Error).message }));
    },
    [patchTab],
  );

  // ── Render ────────────────────────────────────────────────────────────────
  if (enabled === false) {
    return (
      <div className="panel" style={{ margin: 'auto', maxWidth: 560, textAlign: 'center' }}>
        <div className="empty-ico" aria-hidden>≋</div>
        <h3>Kafka tab đang tắt</h3>
        <p className="empty">
          Đặt <code>KAFKA_TOOL_ENABLED=true</code> trong <code>.env.local</code> rồi khởi động lại dev server để bật.
          Đây là công cụ chỉ dùng local — không bật trên bản deploy.
        </p>
      </div>
    );
  }
  if (enabled === null) {
    return <div className="panel" style={{ margin: 'auto' }}><span className="spinner" /> Đang tải…</div>;
  }

  const grouped = groupByProject(connections);

  return (
    <div className="kafka-layout" ref={railSplit.ref} style={railSplit.style}>
      {/* ── Left rail: connections ─────────────────────────────────────── */}
      <aside className="panel">
        <div className="status-line" style={{ justifyContent: 'space-between' }}>
          <strong>Kafka clusters</strong>
          <button className="chip-btn" onClick={() => { setManageOpen((v) => !v); setEditConn(null); }}>
            {manageOpen ? '✕ Đóng' : '+ Thêm'}
          </button>
        </div>

        {connections.length === 0 && !manageOpen && (
          <p className="empty" style={{ marginTop: 10 }}>Chưa có cluster nào. Bấm “+ Thêm” để cấu hình brokers.</p>
        )}

        {grouped.map(([project, list]) => (
          <div key={project} className="kafka-conn-group">
            <div className="kafka-group-label">{project}</div>
            {list.map((c) => (
              <div
                key={c.id}
                className={`kafka-conn-row${c.id === activeId ? ' active' : ''}`}
                onClick={() => setActiveId(c.id)}
              >
                <div className="kafka-conn-main">
                  <span className="kafka-conn-name">{c.name}</span>
                  <span className="kafka-conn-host">{c.brokers.join(', ')}</span>
                </div>
                {pings[c.id] != null && (
                  <span className="badge" style={{ color: pings[c.id] === 'err' ? 'var(--err)' : 'var(--ok)' }}>
                    {pings[c.id] === 'err' ? 'err' : `${pings[c.id]}ms`}
                  </span>
                )}
                <button
                  className="chip-btn"
                  title="Test kết nối"
                  onClick={(e) => { e.stopPropagation(); void doTest(c); }}
                >⚡</button>
                <div className="kafka-conn-menu" style={{ position: 'relative' }}>
                  <button
                    className="chip-btn"
                    onClick={(e) => { e.stopPropagation(); setMenuId(menuId === c.id ? null : c.id); }}
                  >⋯</button>
                  {menuId === c.id && (
                    <div className="kafka-menu-pop" onClick={(e) => e.stopPropagation()}>
                      <button className="kafka-menu-item" onClick={() => { setEditConn(c); setManageOpen(true); setMenuId(null); }}>Sửa</button>
                      <button
                        className="kafka-menu-item danger"
                        onClick={async () => {
                          setMenuId(null);
                          try {
                            const next = await mutateKafkaConnection('DELETE', { id: c.id });
                            setConnections(next);
                            if (activeId === c.id) setActiveId(next[0]?.id ?? '');
                            flash('Đã xoá cluster');
                          } catch (e) { setError((e as Error).message); }
                        }}
                      >Xoá</button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}

        {manageOpen && (
          <ConnectionForm
            initial={editConn}
            onCancel={() => { setManageOpen(false); setEditConn(null); }}
            onSaved={async (saved) => {
              setManageOpen(false);
              setEditConn(null);
              setConnections(saved.list);
              setActiveId(saved.activeId);
              flash(editConn ? 'Đã cập nhật' : 'Đã thêm cluster');
            }}
            onError={setError}
          />
        )}
      </aside>

      {/* ── Right pane ──────────────────────────────────────────────────── */}
      <main className="panel kafka-browser">
        {!active ? (
          <p className="empty" style={{ margin: 'auto' }}>Chọn hoặc thêm một cluster để bắt đầu.</p>
        ) : (
          <>
            <div className="status-line" style={{ justifyContent: 'space-between' }}>
              <div className="kafka-subnav">
                <button className={subView === 'topics' ? 'on' : ''} onClick={() => setSubView('topics')}>Topics</button>
                <button className={subView === 'groups' ? 'on' : ''} onClick={() => setSubView('groups')}>Consumer groups</button>
              </div>
              <button
                className="chip-btn"
                onClick={() => (subView === 'topics' ? void loadTopics(tabConnId) : void loadGroups())}
              >↻ Tải lại</button>
            </div>

            {/* Cluster health (brokers / URP / offline + node_exporter host
                metrics khi connection có metricsUrls) — collapsed, 60s when open. */}
            <HealthStrip connectionId={activeId} hasMetricsUrls={(active?.metricsUrls?.length ?? 0) > 0} />

            {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
            {notice && <div className="badge" style={{ color: 'var(--ok)' }}>{notice}</div>}

            {subView === 'topics' && (
              /* ── Browser-style tab strip: one topic per tab ─────────────── */
              <div className="kafka-tabstrip">
                {tabs.map((t) => {
                  const conn = connections.find((c) => c.id === t.connectionId);
                  return (
                    <div
                      key={t.id}
                      className={`kafka-tab${t.id === activeTabId ? ' active' : ''}`}
                      onClick={() => { setActiveTabId(t.id); setSelectedMsg(null); }}
                      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } }}
                      title={t.topic ? `${t.topic}${conn ? ` · ${conn.name}` : ''}` : 'Tab mới'}
                    >
                      {t.msgLoading || t.detailLoading ? <span className="spinner" /> : null}
                      <span className="kafka-tab-label">{t.topic ?? 'Tab mới'}</span>
                      {/* Show which cluster the tab is on only when it differs from the rail. */}
                      {conn && t.connectionId !== activeId && <span className="kafka-tab-conn">{conn.name}</span>}
                      <button
                        className="kafka-tab-x"
                        title="Đóng tab"
                        onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                      >✕</button>
                    </div>
                  );
                })}
                <button className="kafka-tab-new" title="Mở tab mới" onClick={() => openTab(activeId)}>+</button>
              </div>
            )}

            {subView === 'topics' && activeTab && !activeTab.topic && (
              /* ── Topic picker for the active tab ───────────────────────── */
              <div className="kafka-pane">
                <div className="kafka-toolbar">
                  <input
                    className="input"
                    placeholder="Tìm topic theo tên…"
                    value={topicFilter}
                    onChange={(e) => setTopicFilter(e.target.value)}
                  />
                  <label className="kafka-check" title="Hiện topic nội bộ (__consumer_offsets…)">
                    <input type="checkbox" checked={showInternal} onChange={(e) => setShowInternal(e.target.checked)} /> internal
                  </label>
                  <span className="kafka-meta" style={{ margin: 0 }}>
                    {topicsLoading ? <span className="spinner" /> : `${filteredTopics.length}/${topics.length}`}
                  </span>
                </div>
                <div className="endpoint-list kafka-scroll" style={{ flex: 1, marginTop: 8 }}>
                  {filteredTopics.map((t) => (
                    <button
                      key={t.name}
                      className="ep-item"
                      onClick={() => void selectTopicIn(activeTab.id, activeTab.connectionId, t.name)}
                    >
                      <span className="kafka-topic-name">{t.name}</span>
                      <span className="kafka-topic-meta">{t.partitions}p · RF{t.replicationFactor}</span>
                    </button>
                  ))}
                  {!topicsLoading && filteredTopics.length === 0 && <p className="empty">Không có topic khớp.</p>}
                </div>
              </div>
            )}

            {subView === 'topics' && activeTab && activeTab.topic && (
              /* ── The active tab's topic: header + inner tabs + message viewer ─ */
              <div className="kafka-pane">
                <div className="kafka-topic-header">
                  <button className="chip-btn" title="Về danh sách topic" onClick={backToTopics}>←</button>
                  <strong className="code kafka-topic-title" title={activeTab.topic}>{activeTab.topic}</strong>
                  {activeTab.detail && (
                    <>
                      <span className="badge">{activeTab.detail.partitions.length}p</span>
                      <span className="badge">≈ {fmtInt(activeTab.detail.totalMessages)} msg</span>
                    </>
                  )}
                  <span style={{ flex: 1 }} />
                  <button className="chip-btn" disabled={!activeTab.detail} onClick={() => setProduceOpen(true)}>+ Produce</button>
                </div>

                {activeTab.error && (
                  <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{activeTab.error}</pre>
                )}

                <div className="kafka-subnav kafka-topic-tabs">
                  <button className={activeTab.view === 'messages' ? 'on' : ''} onClick={() => patchTab(activeTab.id, { view: 'messages' })}>Messages</button>
                  <button className={activeTab.view === 'partitions' ? 'on' : ''} onClick={() => patchTab(activeTab.id, { view: 'partitions' })}>Partitions</button>
                  <button className={activeTab.view === 'groups' ? 'on' : ''} onClick={() => patchTab(activeTab.id, { view: 'groups' })}>Consumer groups</button>
                </div>

                {activeTab.detailLoading && !activeTab.detail ? (
                  <p><span className="spinner" /> Đang tải chi tiết…</p>
                ) : activeTab.view === 'messages' ? (
                  <>
                    {/* Compact one-line filter: time window + keyword + search + peek */}
                    <div className="kafka-filter">
                      <DateTimeField className="input kafka-dt" value={activeTab.fromInput} onChange={(v) => patchTab(activeTab.id, { fromInput: v })} />
                      <span className="kafka-filter-sep">→</span>
                      <DateTimeField className="input kafka-dt" value={activeTab.toInput} onChange={(v) => patchTab(activeTab.id, { toInput: v })} />
                      <input
                        className="input kafka-kw"
                        type="search"
                        name="kafka-filter-keyword"
                        placeholder="Keyword…"
                        value={activeTab.keyword}
                        onChange={(e) => patchTab(activeTab.id, { keyword: e.target.value })}
                        autoComplete="off"
                        data-lpignore="true"
                        data-form-type="other"
                        onKeyDown={(e) => e.key === 'Enter' && canSearchTab(activeTab) && void doSearch(activeTab)}
                      />
                      <button
                        className="sm"
                        disabled={!canSearchTab(activeTab) || activeTab.msgLoading}
                        onClick={() => void doSearch(activeTab)}
                        title="Tìm theo khoảng thời gian + keyword"
                      >Tìm</button>
                      <span className="kafka-filter-sep">·</span>
                      <input
                        className="input kafka-peekn"
                        type="number"
                        min={1}
                        max={200}
                        value={activeTab.peekN}
                        onChange={(e) => patchTab(activeTab.id, { peekN: e.target.value })}
                        title="Số message mới nhất"
                      />
                      <button className="chip-btn" disabled={activeTab.msgLoading} onClick={() => void doPeek(activeTab)} title="Xem message mới nhất">
                        Mới nhất
                      </button>
                    </div>

                    <MessageList
                      page={activeTab.messages}
                      loading={activeTab.msgLoading}
                      mode={activeTab.msgMode}
                      selected={selectedMsg}
                      onSelect={setSelectedMsg}
                    />
                  </>
                ) : activeTab.view === 'partitions' ? (
                  <div className="kafka-scroll" style={{ flex: 1 }}>
                    {!activeTab.detail ? <p className="empty">Chưa tải được chi tiết topic.</p> : (
                      <table className="kafka-table">
                        <thead>
                          <tr><th>P</th><th>Leader</th><th>ISR</th><th>Low</th><th>High</th><th>Count</th></tr>
                        </thead>
                        <tbody>
                          {activeTab.detail.partitions.map((p) => (
                            <tr key={p.partition}>
                              <td>{p.partition}</td>
                              <td>{p.leader}</td>
                              <td>{p.isr.length}/{p.replicas.length}</td>
                              <td>{fmtInt(p.low)}</td>
                              <td>{fmtInt(p.high)}</td>
                              <td>{fmtInt(p.count)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                ) : (
                  <div className="kafka-scroll" style={{ flex: 1 }}>
                    <TopicGroups
                      groups={activeTab.groups}
                      loading={activeTab.groupsLoading}
                      onRefresh={() => void loadTopicGroups(activeTab)}
                    />
                  </div>
                )}
              </div>
            )}

            {subView === 'groups' && !selectedGroup && (
              /* ── Consumer group list ─────────────────────────────────── */
              <div className="kafka-pane">
                <div className="kafka-meta">
                  {groupsLoading ? <span className="spinner" /> : `${groups.length} group`}
                </div>
                <div className="endpoint-list kafka-scroll" style={{ flex: 1 }}>
                  {groups.map((g) => (
                    <button
                      key={g.groupId}
                      className="ep-item"
                      onClick={() => void selectGroup(g.groupId)}
                    >
                      <span className="kafka-topic-name">{g.groupId}</span>
                      <span className="kafka-topic-meta">
                        <span className={`kafka-state s-${g.state.toLowerCase()}`}>{g.state}</span> · {g.members}m
                      </span>
                    </button>
                  ))}
                  {!groupsLoading && groups.length === 0 && <p className="empty">Không có consumer group.</p>}
                </div>
              </div>
            )}

            {subView === 'groups' && selectedGroup && (
              /* ── Consumer group detail (lag) ─────────────────────────── */
              <div className="kafka-pane kafka-scroll">
                {groupLoading ? (
                  <p><span className="spinner" /> Đang tính lag…</p>
                ) : groupDetail ? (
                    <>
                      <div className="kafka-topic-header">
                        <button className="chip-btn" title="Về danh sách group" onClick={() => { setSelectedGroup(null); setGroupDetail(null); }}>←</button>
                        <strong className="code kafka-topic-title" title={groupDetail.groupId}>{groupDetail.groupId}</strong>
                        <span style={{ flex: 1 }} />
                        <span className={`kafka-state s-${groupDetail.state.toLowerCase()}`}>{groupDetail.state}</span>
                      </div>
                      <div className="kafka-stat-row">
                        <span className="badge">{groupDetail.members.length} members</span>
                        <span className="badge" style={{ color: groupDetail.totalLag > 0 ? 'var(--err)' : 'var(--ok)' }}>
                          total lag {fmtInt(groupDetail.totalLag)}
                        </span>
                      </div>
                      {groupDetail.topics.length === 0 && <p className="empty">Group chưa commit offset cho topic nào.</p>}
                      {groupDetail.topics.map((t) => (
                        <div key={t.topic} style={{ marginTop: 10 }}>
                          <div className="status-line" style={{ justifyContent: 'space-between' }}>
                            <span className="code">{t.topic}</span>
                            <span className="badge" style={{ color: t.totalLag > 0 ? 'var(--err)' : 'var(--ok)' }}>lag {fmtInt(t.totalLag)}</span>
                          </div>
                          <table className="kafka-table">
                            <thead>
                              <tr><th>P</th><th>Committed</th><th>Log end</th><th>Lag</th></tr>
                            </thead>
                            <tbody>
                              {t.partitions.map((p) => (
                                <tr key={p.partition}>
                                  <td>{p.partition}</td>
                                  <td>{p.committed == null ? '—' : fmtInt(p.committed)}</td>
                                  <td>{fmtInt(p.logEnd)}</td>
                                  <td style={{ color: (p.lag ?? 0) > 0 ? 'var(--err)' : undefined }}>
                                    {p.lag == null ? '—' : fmtInt(p.lag)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))}
                    </>
                  ) : null}
              </div>
            )}
          </>
        )}
      </main>

      {produceOpen && activeTab?.topic && (
        <ProduceModal
          topic={activeTab.topic}
          partitions={activeTab.detail?.partitions.length ?? 1}
          onClose={() => setProduceOpen(false)}
          onSent={(where) => { setProduceOpen(false); flash(`Đã gửi → p${where.partition}@${where.offset}`); }}
          onProduce={(payload) => produceKafkaMessage(activeTab.connectionId, { topic: activeTab.topic!, ...payload })}
        />
      )}

      {selectedMsg && <MessageDrawer msg={selectedMsg} onClose={() => setSelectedMsg(null)} />}

      {/* ── Quick-search preset dock (bottom-left floating) ─────────────── */}
      {connections.length > 0 && (
        <div className="kafka-preset-dock">
          {presetOpen && (
            <div className="kafka-preset-panel">
              <div className="kafka-preset-head">
                <strong>Tìm nhanh</strong>
                <span style={{ flex: 1 }} />
                <button className="chip-btn" title="Thêm chức năng" onClick={() => setPresetEdit('new')}>+ Thêm</button>
                <button className="chip-btn" title="Đóng" onClick={() => setPresetOpen(false)}>✕</button>
              </div>
              {presets.length === 0 ? (
                <p className="empty" style={{ margin: '8px 0' }}>
                  Chưa có chức năng nào. Bấm “+ Thêm” để tạo (đặt tên · chọn cluster · chọn topic).
                </p>
              ) : (
                <div className="kafka-preset-list">
                  {presets.map((p) => {
                    const conn = connections.find((c) => c.id === p.connectionId);
                    const mins = clampWindowMinutes(p.windowMinutes ?? DEFAULT_WINDOW_MINUTES);
                    return (
                      <div key={p.id} className="kafka-preset-row">
                        <button
                          className="kafka-preset-run"
                          title={p.description ? `${p.description} · ${mins} phút gần nhất` : `Chạy tìm nhanh · ${mins} phút gần nhất`}
                          onClick={() => setRunPresetState({ preset: p })}
                        >
                          <span className="kafka-preset-name">{p.name}</span>
                          <span className="kafka-preset-sub">
                            {conn ? conn.name : <em style={{ color: 'var(--err)' }}>cluster đã xoá</em>} · {p.topic}
                          </span>
                          {p.description && <span className="kafka-preset-desc">{p.description}</span>}
                        </button>
                        <button className="chip-btn" title="Sửa" onClick={() => setPresetEdit(p)}>✎</button>
                        <button
                          className="chip-btn"
                          title="Xoá"
                          onClick={() => { setPresets(removePreset(p.id)); flash('Đã xoá chức năng'); }}
                        >🗑</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          <button
            className="kafka-preset-fab"
            title="Tìm kiếm nhanh (preset)"
            onClick={() => setPresetOpen((v) => !v)}
          >
            <span className="kafka-preset-fab-ico">⚡</span>
            <span className="kafka-preset-fab-label">Tìm nhanh</span>
            {presets.length > 0 && <span className="kafka-preset-fab-count">{presets.length}</span>}
          </button>
        </div>
      )}

      {/* Add / edit a preset. */}
      {presetEdit && (
        <PresetForm
          initial={presetEdit === 'new' ? null : presetEdit}
          connections={connections}
          topicsByConn={topicsByConn}
          onCancel={() => setPresetEdit(null)}
          onSave={(input) => {
            const next = presetEdit === 'new' ? addPreset(input) : updatePreset(presetEdit.id, input);
            setPresets(next);
            setPresetEdit(null);
            flash(presetEdit === 'new' ? 'Đã tạo chức năng' : 'Đã cập nhật');
          }}
          onNeedTopics={(connId) => { void loadTopics(connId); }}
        />
      )}

      {/* Run modal: window pre-seeded from the preset, keyword typed at run time. */}
      {runPresetState && (
        <PresetRunWizard
          preset={runPresetState.preset}
          onCancel={() => setRunPresetState(null)}
          onRun={(kw, from, to) => {
            const { preset } = runPresetState;
            setRunPresetState(null);
            setPresetOpen(false);
            executePreset(preset, kw, from, to);
          }}
        />
      )}
      <Splitter {...railSplit.grip} />
    </div>
  );
}

// ── Message list ──────────────────────────────────────────────────────────────

/** Parse a value string as JSON, returning the pretty-printed form + a flag.
 *  Only objects/arrays count as "structured" — a bare number/string/bool stays
 *  plaintext so we don't reformat a plain "hello" into "\"hello\"". */
function tryPrettyJson(value: string | null): { pretty: string; isJson: boolean } {
  if (value == null) return { pretty: '(null)', isJson: false };
  const t = value.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return { pretty: value, isJson: false };
  try {
    return { pretty: JSON.stringify(JSON.parse(t), null, 2), isJson: true };
  } catch {
    return { pretty: value, isJson: false };
  }
}

/** Collapse a value to a single line for the table row preview. */
function oneLine(value: string | null): string {
  if (value == null) return '(null)';
  return value.replace(/\s+/g, ' ').trim();
}

function MessageList({
  page,
  loading,
  mode,
  selected,
  onSelect,
}: {
  page: MessagePage | null;
  loading: boolean;
  mode: 'peek' | 'search' | null;
  selected: PreviewMessage | null;
  onSelect: (m: PreviewMessage) => void;
}) {
  if (loading) return <p style={{ marginTop: 10 }}><span className="spinner" /> Đang đọc message…</p>;
  if (!page) return null;
  const selKey = selected ? `${selected.partition}-${selected.offset}` : null;
  return (
    <div className="kafka-msg-wrap">
      <div className="kafka-meta">
        {mode === 'search' ? 'Tìm thấy' : 'Peek'} {page.messages.length} · đã quét {fmtInt(page.scanned)}
        {page.truncated && <span className="badge" style={{ color: 'var(--err)', marginLeft: 6 }}>truncated (chạm giới hạn)</span>}
      </div>
      {page.note && <p className="empty">{page.note}</p>}
      {page.messages.length === 0 && !page.note && <p className="empty">Không có message khớp.</p>}
      {page.messages.length > 0 && (
        <div className="kafka-msg-table">
          <div className="kafka-msg-row kafka-msg-th">
            <span className="c-part">P</span>
            <span className="c-off">Offset</span>
            <span className="c-time">Thời gian</span>
            <span className="c-key">Key</span>
            <span className="c-val">Value</span>
          </div>
          {page.messages.map((m, i) => {
            const isSel = selKey === `${m.partition}-${m.offset}`;
            return (
              <button
                key={`${m.partition}-${m.offset}-${i}`}
                className={`kafka-msg-row kafka-msg-item${isSel ? ' active' : ''}`}
                onClick={() => onSelect(m)}
                title="Bấm để xem đầy đủ"
              >
                <span className="c-part">{m.partition}</span>
                <span className="c-off">{m.offset}</span>
                <span className="c-time">{fmtTs(m.timestamp)}</span>
                <span className="c-key">{m.key ?? '—'}</span>
                <span className="c-val">{oneLine(m.value)}{m.valueTruncated ? ' …' : ''}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Message detail drawer (JSON pretty / plaintext) ───────────────────────────

function MessageDrawer({ msg, onClose }: { msg: PreviewMessage; onClose: () => void }) {
  const { pretty, isJson } = useMemo(() => tryPrettyJson(msg.value), [msg.value]);
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(msg.value ?? '').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [msg.value]);

  // ── In-drawer find (Ctrl+F) ────────────────────────────────────────────────
  const fullText = pretty + (msg.valueTruncated ? '\n\n…(giá trị bị cắt bớt do quá dài)' : '');
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLPreElement>(null);

  // Split the body into text + <mark> segments for the current query (case-insensitive).
  // Returns the node list and how many matches it produced.
  const { nodes, matchCount } = useMemo(() => {
    const q = query.trim();
    if (!q) return { nodes: [fullText] as React.ReactNode[], matchCount: 0 };
    const lower = fullText.toLowerCase();
    const needle = q.toLowerCase();
    const out: React.ReactNode[] = [];
    let from = 0;
    let hit = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at === -1) { out.push(fullText.slice(from)); break; }
      if (at > from) out.push(fullText.slice(from, at));
      const idx = hit;
      out.push(
        <mark key={`m${idx}`} data-mi={idx} className={idx === activeMatch ? 'kafka-find-active' : undefined}>
          {fullText.slice(at, at + needle.length)}
        </mark>,
      );
      hit += 1;
      from = at + needle.length;
    }
    return { nodes: out, matchCount: hit };
  }, [fullText, query, activeMatch]);

  // Keep activeMatch in range as the query changes.
  useEffect(() => { setActiveMatch(0); }, [query]);

  // Scroll the active match into view whenever it (or the match set) changes.
  useEffect(() => {
    if (!findOpen || matchCount === 0) return;
    const el = bodyRef.current?.querySelector(`mark[data-mi="${activeMatch}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeMatch, matchCount, findOpen]);

  const step = useCallback((dir: 1 | -1) => {
    if (matchCount === 0) return;
    setActiveMatch((i) => (i + dir + matchCount) % matchCount);
  }, [matchCount]);

  const openFind = useCallback(() => {
    setFindOpen(true);
    // focus after the bar mounts
    setTimeout(() => findInputRef.current?.select(), 0);
  }, []);

  // Ctrl/Cmd+F opens find; Esc closes find (then the drawer).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        openFind();
        return;
      }
      if (e.key === 'Escape') {
        if (findOpen) { setFindOpen(false); setQuery(''); }
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [findOpen, openFind, onClose]);

  return (
    <div className="kafka-drawer-backdrop" onClick={onClose}>
      <aside className="kafka-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="kafka-drawer-head">
          <strong>Message</strong>
          <span className={`badge ${isJson ? 'kafka-fmt-json' : 'kafka-fmt-text'}`}>{isJson ? 'JSON' : 'plaintext'}</span>
          <span style={{ flex: 1 }} />
          <button className="chip-btn" onClick={openFind} title="Tìm trong message (Ctrl+F)">🔍 Tìm</button>
          <button className="chip-btn" onClick={copy}>{copied ? 'Đã copy' : 'Copy'}</button>
          <button className="chip-btn" onClick={onClose} title="Đóng (Esc)">✕</button>
        </div>

        <div className="kafka-drawer-meta">
          <span className="badge">p{msg.partition}</span>
          <span className="kafka-topic-meta">offset {msg.offset}</span>
          <span className="kafka-topic-meta">{fmtTs(msg.timestamp)}</span>
        </div>
        {msg.key != null && (
          <div className="kafka-drawer-meta">
            <span className="kafka-topic-meta">key</span>
            <code className="kafka-drawer-key">{msg.key}</code>
          </div>
        )}

        {findOpen && (
          <div className="kafka-find">
            <input
              ref={findInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
              }}
              placeholder="Tìm trong message…"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="kafka-find-count">{matchCount ? `${activeMatch + 1}/${matchCount}` : (query.trim() ? '0/0' : '')}</span>
            <button onClick={() => step(-1)} disabled={matchCount === 0} title="Trước (Shift+Enter)">↑</button>
            <button onClick={() => step(1)} disabled={matchCount === 0} title="Sau (Enter)">↓</button>
            <button onClick={() => { setFindOpen(false); setQuery(''); }} title="Đóng tìm kiếm (Esc)">✕</button>
          </div>
        )}

        <pre ref={bodyRef} className={`code kafka-drawer-body${isJson ? ' kafka-json' : ''}`}>{nodes}</pre>
      </aside>
    </div>
  );
}

// ── Consumer groups on a topic (with lag) ─────────────────────────────────────
function TopicGroups({
  groups,
  loading,
  onRefresh,
}: {
  groups: TopicConsumerGroup[] | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (loading) return <p style={{ marginTop: 10 }}><span className="spinner" /> Đang tính lag…</p>;
  if (!groups) return null;

  return (
    <div className="kafka-results">
      <div className="kafka-meta">
        {groups.length} consumer group đang consume topic này
        <button className="chip-btn" style={{ marginLeft: 8 }} onClick={onRefresh}>Làm mới</button>
      </div>
      {groups.length === 0 && (
        <p className="empty">Chưa có consumer group nào commit offset trên topic này.</p>
      )}
      {groups.map((g) => {
        const isOpen = open.has(g.groupId);
        return (
          <div key={g.groupId} className="kafka-msg">
            <div
              className="kafka-msg-head"
              style={{ cursor: 'pointer', marginBottom: isOpen ? 6 : 0 }}
              onClick={() => toggle(g.groupId)}
            >
              <span className="kafka-topic-name" style={{ flex: 1 }}>{g.groupId}</span>
              <span className={`kafka-state s-${g.state.toLowerCase()}`}>{g.state}</span>
              <span className="kafka-topic-meta">{g.members}m</span>
              <span className="badge" style={{ color: g.totalLag > 0 ? 'var(--warn)' : 'var(--ok)' }}>
                lag {fmtInt(g.totalLag)}
              </span>
            </div>
            {isOpen && (
              <table className="kafka-table">
                <thead>
                  <tr><th>P</th><th>Committed</th><th>Log-end</th><th>Lag</th></tr>
                </thead>
                <tbody>
                  {g.partitions.map((p) => (
                    <tr key={p.partition}>
                      <td>{p.partition}</td>
                      <td>{p.committed == null ? '—' : fmtInt(p.committed)}</td>
                      <td>{fmtInt(p.logEnd)}</td>
                      <td style={{ color: (p.lag ?? 0) > 0 ? 'var(--warn)' : undefined }}>
                        {p.lag == null ? '—' : fmtInt(p.lag)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Produce modal ─────────────────────────────────────────────────────────────

function ProduceModal({
  topic,
  partitions,
  onClose,
  onSent,
  onProduce,
}: {
  topic: string;
  partitions: number;
  onClose: () => void;
  onSent: (where: { partition: number; offset: string }) => void;
  onProduce: (payload: { key?: string; value: string; partition?: number }) => Promise<{ partition: number; offset: string }>;
}) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [partition, setPartition] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <h3>Produce message → <span className="code">{topic}</span></h3>
        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
        <label className="kafka-field">
          <span>Key (tuỳ chọn)</span>
          <input className="input" value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <label className="kafka-field">
          <span>Partition (tuỳ chọn — để trống = tự phân phối)</span>
          <input className="input" type="number" min={0} max={partitions - 1} value={partition} onChange={(e) => setPartition(e.target.value)} />
        </label>
        <label className="kafka-field">
          <span>Value</span>
          <textarea className="input" rows={6} value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div className="status-line" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
          <button className="ghost sm" onClick={onClose}>Huỷ</button>
          <button
            className="sm"
            disabled={busy || !value}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const where = await onProduce({
                  key: key || undefined,
                  value,
                  partition: partition !== '' ? Number(partition) : undefined,
                });
                onSent(where);
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Đang gửi…' : 'Gửi'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Connection form ───────────────────────────────────────────────────────────

function ConnectionForm({
  initial,
  onCancel,
  onSaved,
  onError,
}: {
  initial: PublicKafkaConnection | null;
  onCancel: () => void;
  onSaved: (r: { list: PublicKafkaConnection[]; activeId: string }) => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [project, setProject] = useState(initial?.project ?? '');
  const [brokers, setBrokers] = useState(initial?.brokers.join(', ') ?? '');
  const [metricsUrls, setMetricsUrls] = useState(initial?.metricsUrls?.join(', ') ?? '');
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  return (
    <div className="kafka-form">
      <label className="kafka-field">
        <span>Tên</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="vn-core" />
      </label>
      <label className="kafka-field">
        <span>Project</span>
        <input className="input" value={project} onChange={(e) => setProject(e.target.value)} placeholder="vn" />
      </label>
      <label className="kafka-field">
        <span>Brokers (host:port, cách nhau bởi dấu phẩy)</span>
        <textarea className="input" rows={2} value={brokers} onChange={(e) => setBrokers(e.target.value)} placeholder="localhost:9092, localhost:9093" />
      </label>
      <label className="kafka-field">
        <span>Metrics URLs (tuỳ chọn — node_exporter per broker host, để monitor RAM/disk/CPU/load)</span>
        <textarea className="input" rows={2} value={metricsUrls} onChange={(e) => setMetricsUrls(e.target.value)}
          placeholder="http://192.168.2.70:9100/metrics, http://192.168.2.71:9100/metrics" />
      </label>
      {testMsg && <div className="badge">{testMsg}</div>}
      <div className="status-line" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button
          className="ghost sm"
          disabled={busy || !brokers.trim()}
          onClick={async () => {
            setBusy(true);
            setTestMsg(null);
            try {
              const r = await testKafkaConnection(brokers);
              setTestMsg(`OK · ${r.brokers} broker · ${r.latencyMs}ms`);
            } catch (e) {
              setTestMsg(`Lỗi: ${(e as Error).message}`);
            } finally {
              setBusy(false);
            }
          }}
        >Test</button>
        <button className="ghost sm" onClick={onCancel}>Huỷ</button>
        <button
          className="sm"
          disabled={busy || !name.trim() || !brokers.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              const body = { name, project, brokers, metricsUrls };
              const list = initial
                ? await mutateKafkaConnection('PUT', { id: initial.id, ...body })
                : await mutateKafkaConnection('POST', body);
              const activeId = initial?.id ?? list.find((c) => c.name === name.trim())?.id ?? list[0]?.id ?? '';
              onSaved({ list, activeId });
            } catch (e) {
              onError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >{initial ? 'Lưu' : 'Thêm'}</button>
      </div>
    </div>
  );
}

// ── Preset form (add / edit) ──────────────────────────────────────────────────

function PresetForm({
  initial,
  connections,
  topicsByConn,
  onCancel,
  onSave,
  onNeedTopics,
}: {
  initial: KafkaPreset | null;
  connections: PublicKafkaConnection[];
  /** Per-cluster topic cache — suggestions come from here for whichever cluster is picked. */
  topicsByConn: Record<string, TopicSummary[]>;
  onCancel: () => void;
  onSave: (input: Omit<KafkaPreset, 'id'>) => void;
  /** Ask the parent to load the topic list for the chosen cluster (for suggestions). */
  onNeedTopics: (connectionId: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [connectionId, setConnectionId] = useState(initial?.connectionId ?? connections[0]?.id ?? '');
  const [topic, setTopic] = useState(initial?.topic ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [windowMin, setWindowMin] = useState(String(initial?.windowMinutes ?? DEFAULT_WINDOW_MINUTES));

  // Suggestions come from the picked cluster's cached topic list — fetch it on demand
  // so choosing any cluster (not just the active one) gives a usable datalist.
  const topics = topicsByConn[connectionId] ?? [];
  const suggest = topics.length > 0;
  useEffect(() => {
    if (connectionId && !topicsByConn[connectionId]) onNeedTopics(connectionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  const valid = name.trim().length > 0 && connectionId && topic.trim().length > 0;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h3>{initial ? 'Sửa chức năng tìm nhanh' : 'Chức năng tìm nhanh mới'}</h3>
        <label className="kafka-field">
          <span>Tên chức năng</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Bản tin FSEventComplete"
            autoFocus
          />
        </label>
        <label className="kafka-field">
          <span>Kafka cluster</span>
          <select className="input" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.project})</option>
            ))}
          </select>
        </label>
        <label className="kafka-field">
          <span>Topic{suggest ? ' — gõ để lọc trong danh sách gợi ý' : ' — đang tải gợi ý, có thể nhập thủ công'}</span>
          <input
            className="input"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="fs-event-complete"
            list={suggest ? 'kafka-preset-topics' : undefined}
          />
          {suggest && (
            <datalist id="kafka-preset-topics">
              {topics.map((t) => <option key={t.name} value={t.name} />)}
            </datalist>
          )}
        </label>
        <label className="kafka-field">
          <span>Mô tả (tuỳ chọn)</span>
          <textarea
            className="input"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Tìm bản tin theo mã giao dịch…"
          />
        </label>
        <label className="kafka-field">
          <span>Khoảng thời gian mặc định (phút gần nhất)</span>
          <input
            className="input"
            type="number"
            min={1}
            max={MAX_WINDOW_MINUTES}
            step={1}
            value={windowMin}
            onChange={(e) => setWindowMin(e.target.value)}
            placeholder={String(DEFAULT_WINDOW_MINUTES)}
          />
          <span className="kafka-topic-meta">
            Khi chạy sẽ mặc định tìm trong {clampWindowMinutes(Number(windowMin))} phút gần nhất — có thể đổi lúc chạy.
          </span>
        </label>
        <div className="status-line" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button className="ghost sm" onClick={onCancel}>Huỷ</button>
          <button
            className="sm"
            disabled={!valid}
            onClick={() => onSave({
              name: name.trim(),
              connectionId,
              topic: topic.trim(),
              description: description.trim() || undefined,
              windowMinutes: clampWindowMinutes(Number(windowMin)),
            })}
          >
            {initial ? 'Lưu' : 'Tạo'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Preset run modal: window pre-seeded from the preset, keyword + Tìm ────────

function PresetRunWizard({
  preset,
  onCancel,
  onRun,
}: {
  preset: KafkaPreset;
  onCancel: () => void;
  onRun: (kw: string, fromLocal: string, toLocal: string) => void;
}) {
  const presetMins = clampWindowMinutes(preset.windowMinutes ?? DEFAULT_WINDOW_MINUTES);
  const [kw, setKw] = useState('');
  // Window defaults to the preset's "last N minutes"; chips/DateTimeFields override it.
  const [from, setFrom] = useState(() => toLocalInput(Date.now() - presetMins * 60_000));
  const [to, setTo] = useState(() => toLocalInput(Date.now()));
  /** Minutes of the active quick chip — null once the user edits Từ/Đến by hand. */
  const [chipMins, setChipMins] = useState<number | null>(presetMins);

  const applyChip = (mins: number) => {
    const now = Date.now();
    setFrom(toLocalInput(now - mins * 60_000));
    setTo(toLocalInput(now));
    setChipMins(mins);
  };

  const windowValid = (() => {
    const f = new Date(from).getTime();
    const t = new Date(to).getTime();
    return Number.isFinite(f) && Number.isFinite(t) && t > f;
  })();
  const canRun = windowValid && kw.trim().length > 0;

  // "Mặc định" first; the fixed chips skip a duplicate of the preset's own value.
  const chips: { label: string; mins: number }[] = [
    { label: `Mặc định (${presetMins} phút)`, mins: presetMins },
    ...[
      { label: '15 phút', mins: 15 },
      { label: '30 phút', mins: 30 },
      { label: '1 giờ', mins: 60 },
      { label: '24 giờ', mins: 1440 },
    ].filter((c) => c.mins !== presetMins),
  ];

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <h3>{preset.name}</h3>
        <p className="kafka-topic-meta" style={{ marginTop: -4, marginBottom: 10 }}>
          {preset.description || `${preset.topic} · ${presetMins} phút gần nhất`}
        </p>

        <label className="kafka-field">
          <span>Khoảng thời gian</span>
          <span className="kafka-window-chips">
            {chips.map((c) => (
              <button
                key={c.label}
                type="button"
                className="chip-btn"
                aria-pressed={chipMins === c.mins}
                onClick={() => applyChip(c.mins)}
              >{c.label}</button>
            ))}
          </span>
        </label>
        <label className="kafka-field">
          <span>Từ</span>
          <DateTimeField className="input" value={from} onChange={(v) => { setFrom(v); setChipMins(null); }} />
        </label>
        <label className="kafka-field">
          <span>Đến</span>
          <DateTimeField className="input" value={to} onChange={(v) => { setTo(v); setChipMins(null); }} />
        </label>

        <label className="kafka-field">
          <span>Keyword tìm kiếm</span>
          <input
            className="input"
            type="search"
            name="kafka-quicksearch-keyword"
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder="Dán keyword…"
            autoFocus
            autoComplete="off"
            data-lpignore="true"
            data-form-type="other"
            onKeyDown={(e) => e.key === 'Enter' && canRun && onRun(kw.trim(), from, to)}
          />
        </label>
        <div className="status-line" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button className="ghost sm" onClick={onCancel}>Huỷ</button>
          <button className="sm" disabled={!canRun} onClick={() => onRun(kw.trim(), from, to)}>Tìm</button>
        </div>
      </div>
    </div>
  );
}

/** Group connections by project, projects sorted, connections sorted by name. */
function groupByProject(list: PublicKafkaConnection[]): [string, PublicKafkaConnection[]][] {
  const map = new Map<string, PublicKafkaConnection[]>();
  for (const c of list) {
    const arr = map.get(c.project) ?? [];
    arr.push(c);
    map.set(c.project, arr);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([p, arr]) => [p, arr.sort((a, b) => a.name.localeCompare(b.name))] as [string, PublicKafkaConnection[]]);
}
