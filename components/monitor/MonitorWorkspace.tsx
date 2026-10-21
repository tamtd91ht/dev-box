'use client';

// DevBox Monitor — bảng giám sát toàn bộ hạ tầng đã cấu hình (Redis · Kafka ·
// RabbitMQ · MongoDB · Elastic · PostgreSQL · MinIO).
//
// Ba cách xem:
//   • Toàn bộ (mặc định): mọi tài nguyên trong MỘT lưới, không chia nhóm, ô tự co
//     cho vừa một màn hình (có cỡ tối thiểu) — đỏ/vàng xếp đầu. Hover → nguyên nhân, bấm → chi tiết.
//   • Ô: mỗi tài nguyên một ô màu, gom theo loại (hoặc theo dự án) —
//     liếc một cái biết cả hệ thống xanh/vàng/đỏ. Hover ô → nguyên nhân, bấm → chi tiết.
//   • Bảng: một dòng một tài nguyên, sắp được, có cột vấn đề.
//
// Số liệu từ lib/monitor/useMonitor (probe của Automation); luật xanh/vàng/đỏ
// ở lib/monitor/status. Ngưỡng chỉnh được (⚙) và lưu cục bộ.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMonitor, type Row } from '@/lib/monitor/useMonitor';
import {
  LEVEL_LABEL, LEVEL_RANK, SPARK_METRIC, STACK_META, STACK_ORDER, ago, countLevels, normOrder, rollup,
  type Counts, type Level, type Overrides,
} from '@/lib/monitor/status';
import type { InfraStack } from '@/lib/automation/types';
import { Spark } from './Spark';
import MonitorDetail from './MonitorDetail';
import { emitInfraFocus } from '@/lib/infraFocus';
import { focusFromRow } from '@/lib/monitor/focus';
import MonitorThresholds from './MonitorThresholds';
import type { CritStack } from './CritBar';

type View = 'all' | 'tiles' | 'table';
type Density = 'full' | 'compact';
type GroupBy = 'stack' | 'project';
type SortCol = 'level' | 'name' | 'stack' | 'project';

interface Prefs {
  view: View;
  density: Density;
  groupBy: GroupBy;
  intervalSec: number;
  paused: boolean;
  collapsed: string[];
  /** Thứ tự các loại hạ tầng (kéo thả ở ⋯) — quyết định thứ tự nhóm, nút lọc, cột Loại. */
  order: InfraStack[];
  /** Đã áp lần đổi kiểu xem mặc định nào — xem VIEW_REV. */
  viewRev: number;
}

/** Số ô cảnh báo hiện sẵn trước khi bấm "Xem hết". */
const ISSUES_SHOWN = 8;
const PREFS_KEY = 'devbox.monitor.prefs';
const OV_KEY = 'devbox.monitor.thresholds';
/** Tăng khi đổi kiểu xem mặc định: prefs cũ hơn được chuyển sang mặc định mới đúng một lần. */
const VIEW_REV = 1;
const DEFAULT_PREFS: Prefs = { viewRev: 0, view: 'all', density: 'full', groupBy: 'stack', intervalSec: 30, paused: false, collapsed: [], order: [...STACK_ORDER] };
const INTERVALS = [10, 15, 30, 60, 300];

// Lưới "Toàn bộ": ô cao cố định, bề ngang co giãn trong [MIN, MAX] sao cho cả lưới
// vừa chiều cao vùng nhìn; MIN đủ cho 3 dòng (loại · tên · trạng thái) không vỡ chữ.
const ALL_MIN_W = 136;
const ALL_MAX_W = 260;
const ALL_TILE_H = 66;
const ALL_GAP = 6;
/** padding-top của .mon-all — trừ ra khi đo chiều cao còn lại. */
const ALL_PAD_TOP = 10;

/**
 * Số cột cho n ô trong khung w×h: ít cột nhất (ô rộng nhất) mà vẫn vừa chiều cao,
 * nhưng không ít tới mức ô rộng quá MAX (để còn lấp kín bề ngang). Không vừa nổi
 * ngay cả ở cỡ MIN thì dùng cỡ MIN và chấp nhận cuộn.
 */
function fitAll(n: number, w: number, h: number): { cols: number; colW: number } | null {
  if (n === 0 || w < ALL_MIN_W || h <= 0) return null;
  const maxCols = Math.max(1, Math.floor((w + ALL_GAP) / (ALL_MIN_W + ALL_GAP)));
  const fillCols = Math.ceil((w + ALL_GAP) / (ALL_MAX_W + ALL_GAP));
  let cols = maxCols;
  for (let c = 1; c <= maxCols; c++) {
    const r = Math.ceil(n / c);
    if (r * ALL_TILE_H + (r - 1) * ALL_GAP <= h) { cols = c; break; }
  }
  cols = Math.min(n, maxCols, Math.max(cols, fillCols));
  const colW = Math.min(ALL_MAX_W, Math.floor((w - (cols - 1) * ALL_GAP) / cols));
  return { cols, colW };
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch { return fallback; }
}
function saveJson(key: string, v: unknown): void {
  try { window.localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode / quota */ }
}

const LEVELS_SHOWN: Level[] = ['down', 'crit', 'warn', 'ok', 'unknown'];
const SHORT: Record<Level, string> = { down: 'Mất kết nối', crit: 'Nghiêm trọng', warn: 'Cảnh báo', ok: 'Bình thường', unknown: 'Chưa đo' };

/** Nặng trước, cùng mức thì theo tên. */
const bySeverity = (a: Row, b: Row): number =>
  LEVEL_RANK[b.ev.level] - LEVEL_RANK[a.ev.level] || a.res.name.localeCompare(b.res.name);

interface Tip { key: string; x: number; y: number; above: boolean }

export interface MonitorSummary {
  bad: number;
  warn: number;
  total: number;
  /** Loại đang có kết nối đỏ (crit/down), theo thứ tự loại người dùng chọn — cho thanh critical toàn cục. */
  critStacks: CritStack[];
}

interface Props {
  /** Pane đang hiện — tab ẩn vẫn đo nhưng thưa hơn. */
  visible?: boolean;
  /** Mở tab công cụ tương ứng (redis, kafka…). */
  onOpenTab?: (tab: string) => void;
  /** Báo tổng quan lên menu để vẽ chấm đỏ/vàng khi đang ở tab khác. */
  onSummary?: (s: MonitorSummary) => void;
}

export default function MonitorWorkspace({ visible = true, onOpenTab, onSummary }: Props) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const p = loadJson(PREFS_KEY, DEFAULT_PREFS);
    if (p.viewRev < VIEW_REV) {
      const n = { ...p, view: 'all' as View, viewRev: VIEW_REV };
      saveJson(PREFS_KEY, n);
      setPrefs(n);
    } else setPrefs(p);
    setOverrides(loadJson<Overrides>(OV_KEY, {}));
    setHydrated(true);
  }, []);
  const setPref = useCallback(<K extends keyof Prefs>(k: K, v: Prefs[K]) => {
    setPrefs((p) => { const n = { ...p, [k]: v }; saveJson(PREFS_KEY, n); return n; });
  }, []);

  const { rows, counts, loaded, roundBusy, lastRoundAt, refreshAll, refreshOne } = useMonitor({
    visible,
    intervalSec: prefs.intervalSec,
    paused: prefs.paused || !hydrated,
    overrides,
  });

  // Đồng hồ cho nhãn "x giây trước".
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const order = useMemo(() => normOrder(prefs.order), [prefs.order]);

  useEffect(() => {
    const bad = new Map<InfraStack, number>();
    for (const r of rows) {
      if (r.ev.level === 'crit' || r.ev.level === 'down') bad.set(r.res.stack, (bad.get(r.res.stack) ?? 0) + 1);
    }
    const critStacks = order.filter((s) => bad.has(s)).map((s) => ({ stack: s, n: bad.get(s)! }));
    onSummary?.({ bad: counts.down + counts.crit, warn: counts.warn, total: rows.length, critStacks });
  }, [counts, rows, order, onSummary]);

  // ── Lọc ──
  const [stackFilter, setStackFilter] = useState<InfraStack[]>([]);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [levelFilter, setLevelFilter] = useState<Level | null>(null);
  const [project, setProject] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const down = (e: MouseEvent) => { if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [moreOpen]);
  const [sort, setSort] = useState<{ col: SortCol; asc: boolean }>({ col: 'level', asc: false });

  const projects = useMemo(() => [...new Set(rows.map((r) => r.res.project))].sort(), [rows]);
  // Dự án bị xoá khỏi cấu hình thì bỏ bộ lọc, nếu không màn hình trống mà không rõ vì sao.
  useEffect(() => { if (project && !projects.includes(project)) setProject(''); }, [project, projects]);

  /** Chỉ những loại thực sự có kết nối mới có nút lọc — nút cho loại trống chỉ là nhiễu. */
  const presentStacks = useMemo(() => order.filter((s) => rows.some((r) => r.res.stack === s)), [order, rows]);
  // Loại biến mất khỏi cấu hình thì bỏ khỏi bộ lọc, nếu không màn hình trống mà không rõ vì sao.
  useEffect(() => {
    setStackFilter((f) => (f.every((s) => presentStacks.includes(s)) ? f : f.filter((s) => presentStacks.includes(s))));
  }, [presentStacks]);
  const toggleStack = (s: InfraStack) =>
    setStackFilter((f) => (f.includes(s) ? f.filter((x) => x !== s) : [...f, s]));

  const moveStack = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return;
    const next = [...order];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    setPref('order', next);
  };

  const filtered = useMemo(
    () => rows.filter((r) => {
      if (levelFilter && r.ev.level !== levelFilter) return false;
      if (project && r.res.project !== project) return false;
      if (stackFilter.length && !stackFilter.includes(r.res.stack)) return false;
      return true;
    }),
    [rows, levelFilter, project, stackFilter],
  );

  // ── Nhóm ──
  const sections = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const r of filtered) {
      const id = prefs.groupBy === 'stack' ? r.res.stack : r.res.project;
      (map.get(id) ?? map.set(id, []).get(id)!).push(r);
    }
    const ids = prefs.groupBy === 'stack'
      ? order.filter((s) => map.has(s))
      : [...map.keys()].sort((a, b) => a.localeCompare(b));
    return ids.map((id) => {
      const list = (map.get(id) ?? []).sort(bySeverity);
      return {
        id,
        label: prefs.groupBy === 'stack' ? STACK_META[id as InfraStack].label : id,
        icon: prefs.groupBy === 'stack' ? STACK_META[id as InfraStack].icon : '▣',
        rows: list,
        counts: countLevels(list.map((r) => r.ev.level)),
        level: rollup(list.map((r) => r.ev.level)),
      };
    });
  }, [filtered, prefs.groupBy, order]);

  const issues = useMemo(
    () => rows.filter((r) => r.ev.level === 'down' || r.ev.level === 'crit' || r.ev.level === 'warn').sort(bySeverity),
    [rows],
  );
  const [issuesOpen, setIssuesOpen] = useState(false);

  const tableRows = useMemo(() => {
    const dir = sort.asc ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sort.col) {
        case 'name': return dir * a.res.name.localeCompare(b.res.name);
        case 'project': return dir * a.res.project.localeCompare(b.res.project) || a.res.name.localeCompare(b.res.name);
        case 'stack': return dir * (order.indexOf(a.res.stack) - order.indexOf(b.res.stack)) || a.res.name.localeCompare(b.res.name);
        default: return dir * (LEVEL_RANK[a.ev.level] - LEVEL_RANK[b.ev.level]) || a.res.name.localeCompare(b.res.name);
      }
    });
  }, [filtered, sort, order]);

  // ── Toàn bộ: một lưới phẳng, nặng trước → theo thứ tự loại → tên ──
  const allRows = useMemo(
    () => [...filtered].sort((a, b) =>
      LEVEL_RANK[b.ev.level] - LEVEL_RANK[a.ev.level]
      || order.indexOf(a.res.stack) - order.indexOf(b.res.stack)
      || a.res.name.localeCompare(b.res.name)),
    [filtered, order],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || prefs.view !== 'all') return;
    const measure = () => {
      const cs = getComputedStyle(el);
      setBox({
        w: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        h: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - ALL_PAD_TOP,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [prefs.view]);
  const allFit = useMemo(() => fitAll(allRows.length, box.w, box.h), [allRows.length, box]);

  // ── Tooltip ──
  const [tip, setTip] = useState<Tip | null>(null);
  const showTip = useCallback((key: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const above = r.bottom + 260 > window.innerHeight && r.top > 280;
    setTip({ key, x: Math.max(8, Math.min(r.left, window.innerWidth - 348)), y: above ? r.top - 6 : r.bottom + 6, above });
  }, []);
  const hideTip = useCallback(() => setTip(null), []);
  const tipRow = tip ? rows.find((r) => r.res.key === tip.key) : undefined;

  const selectedRow = selected ? rows.find((r) => r.res.key === selected) : undefined;
  // Kết nối bị xoá trong lúc đang mở chi tiết → đóng.
  useEffect(() => { if (selected && !selectedRow && loaded) setSelected(null); }, [selected, selectedRow, loaded]);

  const toggleCollapse = (id: string) =>
    setPref('collapsed', prefs.collapsed.includes(id) ? prefs.collapsed.filter((x) => x !== id) : [...prefs.collapsed, id]);

  const saveOverrides = (o: Overrides) => { setOverrides(o); saveJson(OV_KEY, o); };
  const customCount = Object.keys(overrides).length;
  // Chấm trên ⋯: có thiết lập ẩn đang ảnh hưởng tới những gì bạn thấy.
  const hasCustom = customCount > 0 || prefs.paused || !!project;

  // Mức tổng: bỏ qua "chưa đo" để hệ thống không bị tô xám chỉ vì một kết nối mới thêm.
  const overall = rollup(rows.map((r) => r.ev.level).filter((l) => l !== 'unknown'));
  const bad = counts.down + counts.crit;

  const headline = !loaded
    ? 'Đang tải danh sách kết nối…'
    : rows.length === 0
      ? 'Chưa có kết nối hạ tầng nào'
      : bad + counts.warn === 0
        ? counts.unknown === rows.length ? 'Đang đo lần đầu…' : `Tất cả bình thường · ${counts.ok}/${rows.length}`
        : [
          counts.down ? `${counts.down} mất kết nối` : '',
          counts.crit ? `${counts.crit} nghiêm trọng` : '',
          counts.warn ? `${counts.warn} cảnh báo` : '',
        ].filter(Boolean).join(' · ');

  const nextIn = lastRoundAt && !prefs.paused
    ? Math.max(0, Math.round((lastRoundAt + (visible ? prefs.intervalSec : Math.max(prefs.intervalSec, 120)) * 1000 - now) / 1000))
    : null;

  const sortBtn = (col: SortCol, text: string) => (
    <button className="mon-th" onClick={() => setSort((s) => (s.col === col ? { col, asc: !s.asc } : { col, asc: col !== 'level' }))}>
      {text}{sort.col === col ? (sort.asc ? ' ▲' : ' ▼') : ''}
    </button>
  );

  const open = (key: string) => { hideTip(); setSelected(key); };

  return (
    <div className="mon" data-level={overall}>
      {/* ── Một thanh duy nhất: tổng quan + lọc nhanh + ⋯ (mọi thứ còn lại) ── */}
      <div className="mon-bar">
        <span className={`mon-bar-status lv-${overall}`} title={headline}>
          <span className="mon-banner-dot" aria-hidden />
          <strong>{headline}</strong>
        </span>
        <div className="mon-chips">
          {LEVELS_SHOWN.map((l) => (counts[l] > 0 || l === levelFilter) && (
            <button
              key={l}
              className={`mon-chip lv-${l}${levelFilter === l ? ' on' : ''}`}
              onClick={() => setLevelFilter(levelFilter === l ? null : l)}
              title={levelFilter === l ? 'Bỏ lọc' : `Chỉ xem: ${LEVEL_LABEL[l]}`}
            >
              <span className="mon-dot sm" aria-hidden /> {counts[l]} {SHORT[l]}
            </button>
          ))}
        </div>
        <span className="mon-spacer" />
        <div className="mon-stacks" role="group" aria-label="Lọc theo loại">
          {presentStacks.map((st) => (
            <button
              key={st}
              className={`mon-sbtn${stackFilter.includes(st) ? ' on' : ''}`}
              aria-pressed={stackFilter.includes(st)}
              onClick={() => toggleStack(st)}
              title={`${stackFilter.includes(st) ? 'Bỏ lọc' : 'Chỉ xem'} ${STACK_META[st].label} (bấm nhiều nút để xem nhiều loại)`}
            >
              {STACK_META[st].short}
            </button>
          ))}
        </div>
        <div className="mon-seg" role="tablist" aria-label="Kiểu xem">
          <button role="tab" aria-selected={prefs.view === 'all'} className={prefs.view === 'all' ? 'on' : ''} onClick={() => setPref('view', 'all')} title="Xem toàn bộ trên một màn hình">⊞</button>
          <button role="tab" aria-selected={prefs.view === 'tiles'} className={prefs.view === 'tiles' ? 'on' : ''} onClick={() => setPref('view', 'tiles')} title="Xem dạng ô">▦</button>
          <button role="tab" aria-selected={prefs.view === 'table'} className={prefs.view === 'table' ? 'on' : ''} onClick={() => setPref('view', 'table')} title="Xem dạng bảng">☰</button>
        </div>
        <button
          className="mon-btn icon"
          onClick={refreshAll}
          disabled={roundBusy}
          title={`Đo lại tất cả ngay${lastRoundAt ? ` · cập nhật ${ago(lastRoundAt, now)}` : ''}`}
          aria-label="Làm mới"
        >
          <span className={roundBusy ? 'mon-spin' : ''}>⟳</span>
        </button>
        <div className="mon-more" ref={moreRef}>
          <button
            className={`mon-btn icon${moreOpen ? ' on' : ''}`}
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-label="Tuỳ chọn khác"
            title="Thứ tự loại · nhóm · mật độ · dự án · chu kỳ đo · ngưỡng"
          >
            ⋯{hasCustom && <span className="mon-more-dot" aria-hidden />}
          </button>
          {moreOpen && (
            <div className="mon-pop" role="menu">
              <div className="mon-pop-title">
                <span>Thứ tự các loại</span>
                <button className="mon-link" onClick={() => setPref('order', [...STACK_ORDER])} disabled={order.every((s, i) => s === STACK_ORDER[i])}>Mặc định</button>
              </div>
              <div className="mon-order" aria-label="Kéo để đổi thứ tự">
                {order.map((st, i) => (
                  <div
                    key={st}
                    className={`mon-order-item${dragFrom === i ? ' drag' : ''}${dragOver === i && dragFrom !== null && dragFrom !== i ? (dragFrom < i ? ' over-below' : ' over-above') : ''}`}
                    draggable
                    onDragStart={(e) => { setDragFrom(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', st); }}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOver !== i) setDragOver(i); }}
                    onDrop={(e) => { e.preventDefault(); if (dragFrom !== null) moveStack(dragFrom, i); setDragFrom(null); setDragOver(null); }}
                    onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
                  >
                    <span className="mon-grip" aria-hidden>⋮⋮</span>
                    <span className="mon-order-name">{STACK_META[st].icon} {STACK_META[st].label}</span>
                    <button className="mon-order-btn" onClick={() => moveStack(i, i - 1)} disabled={i === 0} aria-label={`Đưa ${STACK_META[st].label} lên`}>▲</button>
                    <button className="mon-order-btn" onClick={() => moveStack(i, i + 1)} disabled={i === order.length - 1} aria-label={`Đưa ${STACK_META[st].label} xuống`}>▼</button>
                  </div>
                ))}
              </div>
              {prefs.view === 'tiles' && (
                <>
                  <div className="mon-pop-row">
                    <span>Nhóm theo</span>
                    <div className="mon-seg">
                      <button className={prefs.groupBy === 'stack' ? 'on' : ''} onClick={() => setPref('groupBy', 'stack')}>Loại</button>
                      <button className={prefs.groupBy === 'project' ? 'on' : ''} onClick={() => setPref('groupBy', 'project')}>Dự án</button>
                    </div>
                  </div>
                  <div className="mon-pop-row">
                    <span>Mật độ ô</span>
                    <div className="mon-seg">
                      <button className={prefs.density === 'full' ? 'on' : ''} onClick={() => setPref('density', 'full')}>Chi tiết</button>
                      <button className={prefs.density === 'compact' ? 'on' : ''} onClick={() => setPref('density', 'compact')}>Gọn</button>
                    </div>
                  </div>
                </>
              )}
              {projects.length > 1 && (
                <div className="mon-pop-row">
                  <span>Dự án</span>
                  <select className="mon-select" value={project} onChange={(e) => setProject(e.target.value)}>
                    <option value="">Tất cả</option>
                    {projects.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
              )}
              <div className="mon-pop-row">
                <span>Chu kỳ đo</span>
                <div className="mon-pop-inline">
                  <select className="mon-select" value={prefs.intervalSec} onChange={(e) => setPref('intervalSec', Number(e.target.value))}>
                    {INTERVALS.map((s) => <option key={s} value={s}>{s < 60 ? `${s}s` : `${s / 60} phút`}</option>)}
                  </select>
                  <button className="mon-btn" onClick={() => setPref('paused', !prefs.paused)}>{prefs.paused ? '▶ Tiếp tục' : '⏸ Tạm dừng'}</button>
                </div>
              </div>
              <button className="mon-pop-item" onClick={() => { setMoreOpen(false); setShowSettings(true); }}>
                ⚙ Chỉnh ngưỡng xanh/vàng/đỏ{customCount ? ` (${customCount} đã đổi)` : ''}
              </button>
              <div className="mon-pop-foot mon-faint">
                {rows.length} tài nguyên
                {roundBusy ? ' · đang đo…' : lastRoundAt ? ` · cập nhật ${ago(lastRoundAt, now)}` : ''}
                {prefs.paused ? ' · đã tạm dừng' : nextIn !== null && nextIn > 0 ? ` · lần sau ${nextIn}s` : ''}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className={`mon-scroll${prefs.view === 'all' ? ' all' : ''}`} ref={scrollRef}>
        {/* ── Cần chú ý: mỗi tài nguyên đang vàng/đỏ một ô gọn, nêu thẳng chỉ số + giá trị ── */}
        {issues.length > 0 && prefs.view === 'tiles' && !levelFilter && (
          <section className="mon-issues" aria-label="Cần chú ý">
            <div className="mon-issues-head">
              <strong>⚠ Cần chú ý</strong>
              <span className="mon-faint">{issues.length} tài nguyên đang vàng/đỏ — bấm để xem chi tiết</span>
              {issues.length > ISSUES_SHOWN && (
                <button className="mon-link" onClick={() => setIssuesOpen((v) => !v)}>
                  {issuesOpen ? 'Thu gọn' : `Xem hết (${issues.length})`}
                </button>
              )}
            </div>
            <div className="mon-alerts">
              {(issuesOpen ? issues : issues.slice(0, ISSUES_SHOWN)).map((r) => (
                <button
                  key={r.res.key}
                  className={`mon-alert lv-${r.ev.level}`}
                  onClick={() => open(r.res.key)}
                  onMouseEnter={(e) => showTip(r.res.key, e.currentTarget)}
                  onMouseLeave={hideTip}
                  onFocus={(e) => showTip(r.res.key, e.currentTarget)}
                  onBlur={hideTip}
                  aria-label={`${r.res.name} — ${LEVEL_LABEL[r.ev.level]}`}
                >
                  <div className="mon-alert-top">
                    <span className="mon-dot" aria-hidden />
                    <span className="mon-alert-name" title={r.res.name}>{r.res.name}</span>
                    <span className="mon-alert-stack" title={`${STACK_META[r.res.stack].label} · ${r.res.project}`}>
                      {STACK_META[r.res.stack].icon} {r.res.project}
                    </span>
                  </div>
                  <ul className="mon-alert-rows">
                    {r.ev.reasons.slice(0, 3).map((x) => (
                      <li key={x.metric} className={`lv-${x.level}`}>
                        <span className="mon-alert-label">{x.label}</span>
                        <b className="mon-alert-val">{x.value}</b>
                      </li>
                    ))}
                  </ul>
                  <div className="mon-alert-foot">
                    {r.ev.reasons.length > 3 ? `+${r.ev.reasons.length - 3} vấn đề khác · ` : ''}
                    {r.st.since ? `từ ${ago(r.st.since, now)}` : LEVEL_LABEL[r.ev.level]}
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {loaded && rows.length === 0 && (
          <div className="mon-empty">
            <div className="mon-empty-ico">📡</div>
            <p><strong>Chưa có kết nối nào để giám sát.</strong></p>
            <p className="mon-faint">
              Thêm kết nối ở các tab Redis · Kafka · RabbitMQ · MongoDB · Elastic · PostgreSQL · MinIO —
              Monitor tự nhận ngay ở lần đo kế tiếp. Tab công cụ bị tắt (<code>*_TOOL_ENABLED</code>) thì không hiện ở đây.
            </p>
          </div>
        )}

        {loaded && rows.length > 0 && filtered.length === 0 && (
          <div className="mon-empty"><p className="mon-faint">Không có tài nguyên nào khớp bộ lọc.</p></div>
        )}

        {/* ── Xem dạng ô ── */}
        {prefs.view === 'tiles' && sections.map((sec) => {
          const closed = prefs.collapsed.includes(sec.id);
          return (
            <section key={sec.id} id={`mon-sec-${sec.id}`} className="mon-sec">
              <button className="mon-sec-head" onClick={() => toggleCollapse(sec.id)} aria-expanded={!closed}>
                <span className={`mon-caret${closed ? ' closed' : ''}`} aria-hidden>▾</span>
                <span className={`mon-dot lv-${sec.level}`} aria-hidden />
                <span className="mon-sec-ico" aria-hidden>{sec.icon}</span>
                <span className="mon-sec-name">{sec.label}</span>
                <span className="mon-faint">{sec.rows.length}</span>
                <LevelBar counts={sec.counts} />
                <span className="mon-sec-sum">
                  {sec.counts.down > 0 && <span className="lv-down">{sec.counts.down} mất kết nối</span>}
                  {sec.counts.crit > 0 && <span className="lv-crit">{sec.counts.crit} nghiêm trọng</span>}
                  {sec.counts.warn > 0 && <span className="lv-warn">{sec.counts.warn} cảnh báo</span>}
                </span>
              </button>
              {!closed && (
                <div className={`mon-grid ${prefs.density}`}>
                  {sec.rows.map((r) => (
                    <Tile
                      key={r.res.key}
                      row={r}
                      now={now}
                      compact={prefs.density === 'compact'}
                      showStack={prefs.groupBy === 'project'}
                      selected={selected === r.res.key}
                      onOpen={open}
                      onEnter={showTip}
                      onLeave={hideTip}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}

        {/* ── Xem toàn bộ ── */}
        {prefs.view === 'all' && allRows.length > 0 && (
          <div
            className="mon-all"
            style={allFit ? { gridTemplateColumns: `repeat(${allFit.cols}, ${allFit.colW}px)` } : undefined}
          >
            {allRows.map((r) => (
              <AllTile
                key={r.res.key}
                row={r}
                now={now}
                selected={selected === r.res.key}
                onOpen={open}
                onEnter={showTip}
                onLeave={hideTip}
              />
            ))}
          </div>
        )}

        {/* ── Xem dạng bảng ── */}
        {prefs.view === 'table' && tableRows.length > 0 && (
          <table className="mon-table">
            <thead>
              <tr>
                <th>{sortBtn('level', 'Trạng thái')}</th>
                <th>{sortBtn('name', 'Tên')}</th>
                <th>{sortBtn('stack', 'Loại')}</th>
                <th>{sortBtn('project', 'Dự án')}</th>
                <th>Địa chỉ</th>
                <th>Chỉ số</th>
                <th>Vấn đề</th>
                <th>Đo lúc</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r) => (
                <tr
                  key={r.res.key}
                  className={`lv-${r.ev.level}${selected === r.res.key ? ' sel' : ''}`}
                  onClick={() => open(r.res.key)}
                  onMouseEnter={(e) => showTip(r.res.key, e.currentTarget)}
                  onMouseLeave={hideTip}
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') open(r.res.key); }}
                >
                  <td><span className="mon-pill"><span className="mon-dot sm" aria-hidden /> {SHORT[r.ev.level]}</span></td>
                  <td className="mon-td-name">{r.res.name}</td>
                  <td>{STACK_META[r.res.stack].icon} {STACK_META[r.res.stack].label}</td>
                  <td>{r.res.project}</td>
                  <td className="mon-td-addr" title={r.res.address}><code>{r.res.address || '—'}</code></td>
                  <td>
                    {r.ev.kpis.map((k) => (
                      <span key={k.metric} className={`mon-kpi-inline lv-${k.level}`}>{k.label} <b>{k.text}</b></span>
                    ))}
                  </td>
                  <td className="mon-td-issue">
                    {r.ev.reasons[0]?.text ?? ''}
                    {r.ev.reasons.length > 1 ? <span className="mon-faint"> (+{r.ev.reasons.length - 1})</span> : null}
                  </td>
                  <td className="mon-faint">{r.st.last ? ago(r.st.last.at, now) : r.st.busy ? 'đang đo…' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Tooltip nguyên nhân ── */}
      {tip && tipRow && !selectedRow && (
        <div
          className={`mon-tip lv-${tipRow.ev.level}`}
          style={{ left: tip.x, top: tip.y, transform: tip.above ? 'translateY(-100%)' : undefined }}
          role="tooltip"
        >
          <div className="mon-tip-head">
            <span className="mon-dot" aria-hidden />
            <strong>{tipRow.res.name}</strong>
            <span className="mon-tip-lv">{LEVEL_LABEL[tipRow.ev.level]}</span>
          </div>
          <div className="mon-tip-sub">
            {STACK_META[tipRow.res.stack].icon} {STACK_META[tipRow.res.stack].label} · {tipRow.res.project}
            {tipRow.res.address ? ` · ${tipRow.res.address}` : ''}
          </div>
          {tipRow.ev.reasons.length > 0 ? (
            <ul className="mon-tip-reasons">
              {tipRow.ev.reasons.slice(0, 5).map((r) => (
                <li key={r.metric} className={`lv-${r.level}`}>
                  <span className="mon-dot sm" aria-hidden />
                  <div>{r.text}{r.why ? <div className="mon-tip-why">{r.why}</div> : null}</div>
                </li>
              ))}
              {tipRow.ev.reasons.length > 5 && <li className="mon-faint">… và {tipRow.ev.reasons.length - 5} vấn đề khác</li>}
            </ul>
          ) : (
            <div className="mon-tip-ok">
              {tipRow.ev.level === 'unknown' ? 'Chưa có số liệu — đang chờ lần đo đầu.' : 'Mọi chỉ số đang trong ngưỡng.'}
            </div>
          )}
          <div className="mon-tip-foot">
            {tipRow.st.since && tipRow.ev.level !== 'unknown' ? `${LEVEL_LABEL[tipRow.ev.level]} từ ${ago(tipRow.st.since, now)} · ` : ''}
            {tipRow.st.last ? `đo ${ago(tipRow.st.last.at, now)}` : ''} · bấm để xem chi tiết
          </div>
        </div>
      )}

      {/* ── Chi tiết ── */}
      {selectedRow && (
        <>
          <div className="mon-scrim" onClick={() => setSelected(null)} />
          <MonitorDetail
            row={selectedRow}
            now={now}
            overrides={overrides}
            onClose={() => setSelected(null)}
            onRefresh={() => refreshOne(selectedRow.res.key)}
            onOpenTab={(t) => {
              // Báo tab đích chọn ĐÚNG CỤM + mục liên quan tới cảnh báo, rồi mới
              // chuyển tab (yêu cầu nằm chờ nếu tab đó chưa mount).
              emitInfraFocus(focusFromRow(selectedRow));
              setSelected(null);
              onOpenTab?.(t);
            }}
          />
        </>
      )}

      {showSettings && (
        <MonitorThresholds overrides={overrides} onSave={saveOverrides} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}

/** Thanh chồng tỷ lệ xanh/vàng/đỏ của một nhóm. */
function LevelBar({ counts }: { counts: Counts }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  return (
    <span className="mon-levelbar" aria-hidden>
      {LEVELS_SHOWN.map((l) => counts[l] > 0 && (
        <span key={l} className={`lv-${l}`} style={{ width: `${(counts[l] / total) * 100}%` }} />
      ))}
    </span>
  );
}

interface TileProps {
  row: Row;
  now: number;
  compact: boolean;
  showStack: boolean;
  selected: boolean;
  onOpen: (key: string) => void;
  onEnter: (key: string, el: HTMLElement) => void;
  onLeave: () => void;
}

function Tile({ row, now, compact, showStack, selected, onOpen, onEnter, onLeave }: TileProps) {
  const { res, st, ev } = row;
  const spark = useMemo(
    () => st.samples.map((s) => s.metrics[SPARK_METRIC[res.stack]]).filter((x): x is number => typeof x === 'number'),
    [st.samples, res.stack],
  );
  const issue = ev.reasons[0];

  return (
    <button
      className={`mon-tile lv-${ev.level}${selected ? ' sel' : ''}${st.busy ? ' busy' : ''}`}
      onClick={() => onOpen(res.key)}
      onMouseEnter={(e) => onEnter(res.key, e.currentTarget)}
      onMouseLeave={onLeave}
      onFocus={(e) => onEnter(res.key, e.currentTarget)}
      onBlur={onLeave}
      aria-label={`${res.name} — ${LEVEL_LABEL[ev.level]}`}
    >
      <div className="mon-tile-top">
        <span className="mon-dot" aria-hidden />
        <span className="mon-tile-name" title={res.name}>{res.name}</span>
        {ev.reasons.length > 1 && <span className="mon-tile-n" title={`${ev.reasons.length} vấn đề`}>{ev.reasons.length}</span>}
      </div>
      {!compact && (
        <>
          <div className="mon-tile-meta">
            {showStack ? `${STACK_META[res.stack].icon} ${STACK_META[res.stack].label}` : res.project}
          </div>
          {ev.level === 'down' || ev.level === 'unknown' ? (
            <div className="mon-tile-msg">
              {ev.level === 'unknown' ? (st.busy ? 'Đang đo…' : 'Chưa đo') : 'Mất kết nối'}
              {ev.level === 'down' && st.since ? <span className="mon-faint"> · từ {ago(st.since, now)}</span> : null}
            </div>
          ) : (
            <div className="mon-tile-kpis">
              {ev.kpis.map((k) => (
                <div key={k.metric} className={`mon-kpi lv-${k.level}`}>
                  <b>{k.text}</b>
                  <span>{k.label}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mon-tile-foot">
            {ev.level === 'ok' || ev.level === 'unknown' ? (
              <Spark values={spark} width={150} height={22} level={ev.level} />
            ) : (
              <div className="mon-tile-issue" title={issue?.text}>{issue?.text}</div>
            )}
          </div>
        </>
      )}
    </button>
  );
}

type AllTileProps = Omit<TileProps, 'compact' | 'showStack'>;

/** Ô gọn của "Toàn bộ": loại · tên · một dòng trạng thái. Chi tiết nằm ở tooltip. */
function AllTile({ row, now, selected, onOpen, onEnter, onLeave }: AllTileProps) {
  const { res, st, ev } = row;
  const meta = STACK_META[res.stack];
  const issue = ev.reasons[0];
  let line: React.ReactNode;
  if (ev.level === 'down') line = <>Mất kết nối{st.since ? ` · ${ago(st.since, now)}` : ''}</>;
  else if (ev.level === 'unknown') line = st.busy ? 'Đang đo…' : 'Chưa đo';
  else if (issue) line = <>{issue.label} <b>{issue.value}</b></>;
  else line = ev.kpis.slice(0, 2).map((k, i) => <span key={k.metric}>{i ? ' · ' : ''}{k.label} <b>{k.text}</b></span>);

  return (
    <button
      className={`mon-tile mon-at lv-${ev.level}${selected ? ' sel' : ''}${st.busy ? ' busy' : ''}`}
      onClick={() => onOpen(res.key)}
      onMouseEnter={(e) => onEnter(res.key, e.currentTarget)}
      onMouseLeave={onLeave}
      onFocus={(e) => onEnter(res.key, e.currentTarget)}
      onBlur={onLeave}
      aria-label={`${meta.label} ${res.name} — ${LEVEL_LABEL[ev.level]}`}
    >
      <div className="mon-at-top">
        <span className="mon-dot" aria-hidden />
        <span className="mon-at-stack">{meta.icon} {meta.short}</span>
        <span className="mon-at-proj">{res.project}</span>
        {ev.reasons.length > 1 && <span className="mon-tile-n">{ev.reasons.length}</span>}
      </div>
      <div className="mon-at-name">{res.name}</div>
      <div className="mon-at-st">{line}</div>
    </button>
  );
}
