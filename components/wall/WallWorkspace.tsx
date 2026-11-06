'use client';

// DevBox Toàn cảnh — mọi tài nguyên hạ tầng trên MỘT màn hình, để treo lên màn hình theo dõi chung.
//
// Ba kiểu xem:
//   • Lưới: một lưới phẳng phủ kín vùng nhìn, ô tự co giãn cả hai chiều, đỏ/vàng xếp đầu.
//   • Theo dự án: mỗi dự án một cột (dự án nặng nhất bên trái); trong cột xếp theo mức hoặc gom theo loại.
//   • Slide: mỗi slide một dự án / một loại / một mức, tự chuyển sau N giây rồi quay vòng (N và các
//     nhóm chỉnh ở ⋯). Slide nhiều tài nguyên hơn sức chứa màn hình thì chia trang, không cuộn.
//     Nút "Trình chiếu" mở toàn màn hình: thanh công cụ và nút trước/dừng/sau ẩn, rê chuột mới hiện.
//
// KHÔNG có vòng đo riêng: đọc số liệu Monitor qua lib/monitor/store (MonitorWorkspace luôn mount).
// Hover ô → nguyên nhân; bấm → bảng chi tiết của Monitor.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMonitorSnapshot } from '@/lib/monitor/store';
import type { Row } from '@/lib/monitor/useMonitor';
import { LEVEL_LABEL, LEVEL_RANK, STACK_META, ago, countLevels, rollup, type Counts, type Level } from '@/lib/monitor/status';
import type { InfraStack } from '@/lib/automation/types';
import { emitInfraFocus } from '@/lib/infraFocus';
import { focusFromRow } from '@/lib/monitor/focus';
import { AllTile, MonTip, fitAll, type AllSize } from '@/components/monitor/MonitorWorkspace';
import MonitorDetail from '@/components/monitor/MonitorDetail';

type View = 'grid' | 'project' | 'slides';
type Order = 'level' | 'stack';
type SlideGroup = 'project' | 'stack' | 'level';
const SLIDE_GROUPS: SlideGroup[] = ['project', 'stack', 'level'];
const GROUP_TEXT: Record<SlideGroup, string> = { project: 'Dự án', stack: 'Loại', level: 'Mức cảnh báo' };

interface Prefs {
  view: View;
  order: Order;
  /** Mỗi slide đứng bao nhiêu giây (5–3600). */
  slideSec: number;
  /** Nhóm slide được chiếu, theo thứ tự SLIDE_GROUPS. */
  slideGroups: SlideGroup[];
}
const PREFS_KEY = 'devbox.wall.prefs';
const DEFAULT_PREFS: Prefs = { view: 'grid', order: 'level', slideSec: 15, slideGroups: [...SLIDE_GROUPS] };
const SLIDE_SEC_MIN = 5;
const SLIDE_SEC_MAX = 3600;

function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    const p = raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } as Prefs : DEFAULT_PREFS;
    return {
      view: (['grid', 'project', 'slides'] as View[]).includes(p.view) ? p.view : 'grid',
      order: p.order === 'stack' ? 'stack' : 'level',
      slideSec: clampSec(Number(p.slideSec)),
      slideGroups: Array.isArray(p.slideGroups) ? SLIDE_GROUPS.filter((g) => p.slideGroups.includes(g)) : [...SLIDE_GROUPS],
    };
  } catch { return DEFAULT_PREFS; }
}
const clampSec = (n: number): number => (Number.isFinite(n) ? Math.min(SLIDE_SEC_MAX, Math.max(SLIDE_SEC_MIN, Math.round(n))) : DEFAULT_PREFS.slideSec);

// Khớp với lưới "Toàn bộ" của Monitor (MonitorWorkspace › fitAll).
const MIN_W = 136;
const MIN_H = 66;
const GAP = 6;
/** Slide chiếu lên TV: ô được cao hơn (chữ cỡ xl) để đọc từ xa. */
const SLIDE_MAX_H = 300;
const sizeOf = (h: number): AllSize => (h >= 190 ? 'xl' : h >= 124 ? 'lg' : h >= 92 ? 'md' : 'sm');

const LEVELS: Level[] = ['down', 'crit', 'warn', 'ok', 'unknown'];

interface Tip { key: string; x: number; y: number; above: boolean }

interface Props {
  /** Pane đang hiện — ẩn thì slide đứng yên và phím tắt không bắt. */
  visible?: boolean;
  onOpenTab?: (tab: string) => void;
}

function summaryOf(n: Counts, total: number): { text: string; bad: boolean } {
  const bad = n.down + n.crit + n.warn > 0;
  return bad
    ? { bad, text: [n.down && `${n.down} mất kết nối`, n.crit && `${n.crit} nghiêm trọng`, n.warn && `${n.warn} cảnh báo`].filter(Boolean).join(' · ') }
    : { bad, text: `Bình thường · ${n.ok}/${total}` };
}

function LevelBar({ n }: { n: Counts }) {
  return (
    <div className="wall-bar-lv" role="img" aria-label={LEVELS.filter((l) => n[l]).map((l) => `${n[l]} ${LEVEL_LABEL[l]}`).join(', ')}>
      {LEVELS.map((l) => n[l] > 0 && <span key={l} className={`lv-${l}`} style={{ flexGrow: n[l] }} />)}
    </div>
  );
}

/** Đo kích thước khung (ResizeObserver). */
function useBox(deps: unknown[]): [React.RefObject<HTMLDivElement>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const next = {
        w: Math.floor(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
        h: Math.floor(el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)),
      };
      setBox((o) => (o.w === next.w && o.h === next.h ? o : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return [ref, box];
}

export default function WallWorkspace({ visible = true, onOpenTab }: Props) {
  const snap = useMonitorSnapshot();
  const rows = useMemo(() => snap?.rows ?? [], [snap]);
  const order = useMemo<InfraStack[]>(() => snap?.order ?? [], [snap]);

  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  useEffect(() => { setPrefs(loadPrefs()); }, []);
  const setPref = useCallback(<K extends keyof Prefs>(k: K, v: Prefs[K]) => {
    setPrefs((p) => {
      const n = { ...p, [k]: v };
      try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(n)); } catch { /* private mode */ }
      return n;
    });
  }, []);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  // ── Lọc ──
  const [levelF, setLevelF] = useState<Level | null>(null);
  const [stackF, setStackF] = useState<InfraStack | ''>('');
  const [projF, setProjF] = useState('');
  const projects = useMemo(() => [...new Set(rows.map((r) => r.res.project))].sort(), [rows]);
  const presentStacks = useMemo(() => order.filter((s) => rows.some((r) => r.res.stack === s)), [order, rows]);
  useEffect(() => { if (projF && !projects.includes(projF)) setProjF(''); }, [projF, projects]);
  useEffect(() => { if (stackF && !presentStacks.includes(stackF)) setStackF(''); }, [stackF, presentStacks]);

  const byLevel = useCallback((a: Row, b: Row) =>
    LEVEL_RANK[b.ev.level] - LEVEL_RANK[a.ev.level]
    || order.indexOf(a.res.stack) - order.indexOf(b.res.stack)
    || a.res.name.localeCompare(b.res.name), [order]);

  const counts = useMemo(() => countLevels(rows.map((r) => r.ev.level)), [rows]);
  const shown = useMemo(
    () => rows
      .filter((r) => (!levelF || r.ev.level === levelF) && (!stackF || r.res.stack === stackF) && (!projF || r.res.project === projF))
      .sort(byLevel),
    [rows, levelF, stackF, projF, byLevel],
  );

  // Cột theo dự án: dự án có tài nguyên nặng nhất trước, rồi nhiều tài nguyên có vấn đề hơn, rồi tên.
  const columns = useMemo<Column[]>(() => {
    const by = new Map<string, Row[]>();
    for (const r of shown) (by.get(r.res.project) ?? by.set(r.res.project, []).get(r.res.project)!).push(r);
    return [...by.entries()]
      .map(([name, list]) => {
        const n = countLevels(list.map((r) => r.ev.level));
        return { name, rows: list, n, worst: rollup(list.map((r) => r.ev.level)) };
      })
      .sort((a, b) =>
        LEVEL_RANK[b.worst] - LEVEL_RANK[a.worst]
        || b.n.down + b.n.crit + b.n.warn - (a.n.down + a.n.crit + a.n.warn)
        || a.name.localeCompare(b.name));
  }, [shown]);

  // ── Trình chiếu (toàn màn hình) ──
  const rootRef = useRef<HTMLDivElement>(null);
  const [fs, setFs] = useState(false);
  useEffect(() => {
    const on = () => setFs(!!rootRef.current && document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const togglePresent = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void rootRef.current?.requestFullscreen().catch(() => {});
  };
  const kiosk = fs && prefs.view === 'slides';

  // ── Tooltip + chi tiết ──
  const [tip, setTip] = useState<Tip | null>(null);
  const showTip = useCallback((key: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const above = r.bottom + 260 > window.innerHeight && r.top > 280;
    setTip({ key, x: Math.max(8, Math.min(r.left, window.innerWidth - 348)), y: above ? r.top - 6 : r.bottom + 6, above });
  }, []);
  const hideTip = useCallback(() => setTip(null), []);
  const tipRow = tip ? rows.find((r) => r.res.key === tip.key) : undefined;
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRow = selected ? rows.find((r) => r.res.key === selected) : undefined;
  useEffect(() => { if (selected && !selectedRow && snap?.loaded) setSelected(null); }, [selected, selectedRow, snap?.loaded]);
  const open = useCallback((key: string) => { setTip(null); setSelected(key); }, []);
  // Rời tab thì bỏ tooltip đang treo.
  useEffect(() => { if (!visible) setTip(null); }, [visible]);

  // ── ⋯ ──
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
  const [secDraft, setSecDraft] = useState('');
  useEffect(() => { setSecDraft(String(prefs.slideSec)); }, [prefs.slideSec]);
  const commitSec = () => {
    const v = clampSec(Number(secDraft));
    setSecDraft(String(v));
    if (v !== prefs.slideSec) setPref('slideSec', v);
  };
  const toggleGroup = (g: SlideGroup) => {
    const has = prefs.slideGroups.includes(g);
    if (has && prefs.slideGroups.length === 1) return; // ít nhất một nhóm
    setPref('slideGroups', SLIDE_GROUPS.filter((x) => (x === g ? !has : prefs.slideGroups.includes(x))));
  };

  const [boxRef, box] = useBox([prefs.view, snap?.loaded, fs]);
  const fit = useMemo(() => fitAll(shown.length, box.w, box.h), [shown.length, box]);

  const loaded = !!snap?.loaded;
  const bad = counts.down + counts.crit;
  const overall = rollup(rows.map((r) => r.ev.level).filter((l) => l !== 'unknown'));
  const headline = !loaded
    ? 'Đang tải danh sách kết nối…'
    : rows.length === 0
      ? 'Chưa có kết nối hạ tầng nào'
      : bad + counts.warn === 0
        ? counts.unknown === rows.length ? 'Đang đo lần đầu…' : `Tất cả bình thường · ${counts.ok}/${rows.length}`
        : [counts.down && `${counts.down} mất kết nối`, counts.crit && `${counts.crit} nghiêm trọng`, counts.warn && `${counts.warn} cảnh báo`].filter(Boolean).join(' · ');

  const tileProps = { now, onOpen: open, onEnter: showTip, onLeave: hideTip };

  return (
    <div ref={rootRef} className={`mon wall${kiosk ? ' wall-kiosk' : ''}${fs ? ' wall-fs' : ''}`} data-level={overall}>
      {kiosk && <div className="wall-reveal" aria-hidden />}
      <div className="mon-bar wall-tools">
        <span className={`mon-bar-status lv-${overall}`} title={headline}>
          <span className="mon-banner-dot" aria-hidden />
          <strong>{headline}</strong>
        </span>
        <div className="mon-chips">
          {LEVELS.map((l) => (counts[l] > 0 || l === levelF) && (
            <button
              key={l}
              className={`mon-chip lv-${l}${levelF === l ? ' on' : ''}`}
              onClick={() => setLevelF(levelF === l ? null : l)}
              title={levelF === l ? 'Bỏ lọc' : `Chỉ xem: ${LEVEL_LABEL[l]}`}
            >
              <span className="mon-dot sm" aria-hidden /> {counts[l]} {LEVEL_LABEL[l]}
            </button>
          ))}
        </div>
        <span className="mon-spacer" />
        <div className="mon-seg" role="tablist" aria-label="Kiểu xem">
          <button role="tab" aria-selected={prefs.view === 'grid'} className={prefs.view === 'grid' ? 'on' : ''} onClick={() => setPref('view', 'grid')} title="Mọi tài nguyên trên một lưới">⊞ Lưới</button>
          <button role="tab" aria-selected={prefs.view === 'project'} className={prefs.view === 'project' ? 'on' : ''} onClick={() => setPref('view', 'project')} title="Mỗi dự án một cột">▥ Theo dự án</button>
          <button role="tab" aria-selected={prefs.view === 'slides'} className={prefs.view === 'slides' ? 'on' : ''} onClick={() => setPref('view', 'slides')} title={`Tự chuyển slide sau mỗi ${prefs.slideSec} giây`}>▶ Slide</button>
        </div>
        {prefs.view === 'project' && (
          <div className="mon-seg" role="group" aria-label="Xếp trong cột">
            <button className={prefs.order === 'level' ? 'on' : ''} onClick={() => setPref('order', 'level')} title="Trong cột: nặng trước">Theo mức</button>
            <button className={prefs.order === 'stack' ? 'on' : ''} onClick={() => setPref('order', 'stack')} title="Trong cột: gom theo loại">Theo loại</button>
          </div>
        )}
        {presentStacks.length > 1 && (
          <select className="mon-select" value={stackF} onChange={(e) => setStackF(e.target.value as InfraStack | '')} aria-label="Lọc theo loại">
            <option value="">Mọi loại</option>
            {presentStacks.map((s) => <option key={s} value={s}>{STACK_META[s].label}</option>)}
          </select>
        )}
        {projects.length > 1 && (
          <select className="mon-select" value={projF} onChange={(e) => setProjF(e.target.value)} aria-label="Lọc theo dự án">
            <option value="">Mọi dự án</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
        <button
          className="mon-btn icon"
          onClick={() => snap?.refreshAll()}
          disabled={!snap || snap.roundBusy}
          title={`Đo lại tất cả ngay${snap?.lastRoundAt ? ` · cập nhật ${ago(snap.lastRoundAt, now)}` : ''}`}
          aria-label="Làm mới"
        >
          <span className={snap?.roundBusy ? 'mon-spin' : ''}>⟳</span>
        </button>
        <button className={`mon-btn${fs ? ' on' : ''}`} onClick={togglePresent} title={fs ? 'Thoát trình chiếu (Esc)' : 'Trình chiếu toàn màn hình — hợp với kiểu Slide'}>
          {fs ? '⤡ Thoát' : '⛶ Trình chiếu'}
        </button>
        <div className="mon-more" ref={moreRef}>
          <button className={`mon-btn icon${moreOpen ? ' on' : ''}`} onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreOpen} aria-label="Cấu hình trình chiếu slide" title="Cấu hình trình chiếu slide">⋯</button>
          {moreOpen && (
            <div className="mon-pop" role="menu">
              <div className="mon-pop-title"><span>Trình chiếu slide</span></div>
              <div className="mon-pop-row">
                <span>Chuyển slide sau</span>
                <span className="mon-pop-inline wall-sec">
                  <input
                    className="mon-select"
                    type="number"
                    min={SLIDE_SEC_MIN}
                    max={SLIDE_SEC_MAX}
                    value={secDraft}
                    onChange={(e) => setSecDraft(e.target.value)}
                    onBlur={commitSec}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitSec(); }}
                    aria-label="Số giây mỗi slide"
                  />
                  giây
                </span>
              </div>
              <div className="mon-pop-row wall-groups">
                <span>Chiếu theo</span>
                <span className="mon-pop-inline">
                  {SLIDE_GROUPS.map((g) => (
                    <label key={g} className="wall-check">
                      <input type="checkbox" checked={prefs.slideGroups.includes(g)} onChange={() => toggleGroup(g)} disabled={prefs.slideGroups.length === 1 && prefs.slideGroups.includes(g)} />
                      {GROUP_TEXT[g]}
                    </label>
                  ))}
                </span>
              </div>
              <div className="mon-pop-foot mon-faint">
                Quay vòng: {prefs.slideGroups.map((g) => GROUP_TEXT[g].toLowerCase()).join(' → ')}; nhóm trống tự bỏ qua. Phím ← → đổi slide, Space tạm dừng.
                Số liệu lấy từ tab Monitor (chu kỳ đo chỉnh ở đó).
              </div>
            </div>
          )}
        </div>
      </div>

      <div ref={boxRef} className={`wall-box view-${prefs.view}`}>
        {!loaded ? (
          <div className="mon-empty"><p className="mon-faint">Đang tải danh sách kết nối…</p></div>
        ) : rows.length === 0 ? (
          <div className="mon-empty">
            <div className="mon-empty-ico">🖥</div>
            <p><strong>Chưa có kết nối nào để hiển thị.</strong></p>
            <p className="mon-faint">Thêm kết nối ở các tab Redis · Kafka · RabbitMQ · MongoDB · Elastic · PostgreSQL · MinIO — Toàn cảnh tự hiện ở lần đo kế tiếp.</p>
          </div>
        ) : shown.length === 0 ? (
          <div className="mon-empty"><p className="mon-faint">Không có tài nguyên nào khớp bộ lọc.</p></div>
        ) : prefs.view === 'slides' ? (
          <WallSlides
            rows={shown}
            columns={projects.length > 1 ? columns : []}
            order={order}
            groups={prefs.slideGroups}
            sec={prefs.slideSec}
            active={visible && !selectedRow}
            byLevel={byLevel}
            tile={tileProps}
            selected={selected}
          />
        ) : prefs.view === 'project' ? (
          <div className="wall-board">
            {columns.map((col) => (
              <ProjectCol
                key={col.name}
                col={col}
                order={prefs.order}
                stackOrder={order}
                byLevel={byLevel}
                focused={!!projF}
                onFocus={projects.length > 1 ? () => setProjF(projF ? '' : col.name) : undefined}
                tile={tileProps}
                selected={selected}
              />
            ))}
          </div>
        ) : (
          <div
            className="mon-all wall-grid"
            style={fit ? { gridTemplateColumns: `repeat(${fit.cols}, minmax(0, 1fr))`, gridAutoRows: `${fit.rowH}px` } : undefined}
          >
            {shown.map((r) => (
              <AllTile key={r.res.key} row={r} size={fit ? sizeOf(fit.rowH) : 'sm'} selected={selected === r.res.key} {...tileProps} />
            ))}
          </div>
        )}
      </div>

      {tip && tipRow && !selectedRow && <MonTip row={tipRow} now={now} x={tip.x} y={tip.y} above={tip.above} />}

      {selectedRow && snap && (
        <>
          <div className="mon-scrim" onClick={() => setSelected(null)} />
          <MonitorDetail
            row={selectedRow}
            now={now}
            overrides={snap.overrides}
            onClose={() => setSelected(null)}
            onRefresh={() => snap.refreshOne(selectedRow.res.key)}
            onOpenTab={(t) => {
              emitInfraFocus(focusFromRow(selectedRow));
              setSelected(null);
              if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
              onOpenTab?.(t);
            }}
          />
        </>
      )}
    </div>
  );
}

interface Column { name: string; rows: Row[]; n: Counts; worst: Level }

interface TileCtx {
  now: number;
  onOpen: (key: string) => void;
  onEnter: (key: string, el: HTMLElement) => void;
  onLeave: () => void;
}

function ProjectCol({ col, order, stackOrder, byLevel, focused, onFocus, tile, selected }: {
  col: Column;
  order: Order;
  stackOrder: InfraStack[];
  byLevel: (a: Row, b: Row) => number;
  focused: boolean;
  onFocus?: () => void;
  tile: TileCtx;
  selected: string | null;
}) {
  const { text, bad } = summaryOf(col.n, col.rows.length);
  // Theo mức: một danh sách nặng trước. Theo loại: nhóm theo loại (nhóm có ô nặng nhất lên đầu), trong nhóm nặng trước.
  const groups = useMemo(() => {
    const sorted = [...col.rows].sort(byLevel);
    if (order === 'level') return [{ stack: null as InfraStack | null, rows: sorted }];
    const by = new Map<InfraStack, Row[]>();
    for (const r of sorted) (by.get(r.res.stack) ?? by.set(r.res.stack, []).get(r.res.stack)!).push(r);
    return [...by.entries()]
      .map(([stack, rows]) => ({ stack: stack as InfraStack | null, rows }))
      .sort((a, b) => LEVEL_RANK[b.rows[0].ev.level] - LEVEL_RANK[a.rows[0].ev.level] || stackOrder.indexOf(a.stack!) - stackOrder.indexOf(b.stack!));
  }, [col.rows, order, byLevel, stackOrder]);

  return (
    <section className={`wall-col lv-${col.worst}`} aria-label={`Dự án ${col.name}`}>
      <header className="wall-col-head">
        <div className="wall-col-title">
          <span className="mon-dot" aria-hidden />
          <span aria-hidden>▣</span>
          <b title={col.name}>{col.name}</b>
          <span className="wall-count">{col.rows.length}</span>
          {onFocus && (
            <button
              type="button"
              className={`wall-col-focus${focused ? ' on' : ''}`}
              onClick={onFocus}
              aria-label={focused ? 'Xem mọi dự án' : `Chỉ xem dự án ${col.name}`}
              title={focused ? 'Xem mọi dự án' : 'Chỉ xem dự án này'}
            >
              ◎
            </button>
          )}
        </div>
        <div className={`wall-sum${bad ? ' bad' : ''}`}>{text}</div>
        <LevelBar n={col.n} />
      </header>
      <div className="wall-col-body">
        {groups.map((g) => (
          <div key={g.stack ?? 'all'} className="wall-col-group">
            {g.stack && (
              <div className="wall-col-sub">
                <span>{STACK_META[g.stack].icon} {STACK_META[g.stack].label}</span>
                <span className="wall-count">{g.rows.length}</span>
              </div>
            )}
            <div className="wall-col-tiles">
              {g.rows.map((r) => (
                <AllTile key={r.res.key} row={r} size="md" hideProject hideStack={!!g.stack} selected={selected === r.res.key} {...tile} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ───────────── Slide ─────────────

interface Slide {
  /** Ổn định qua các vòng đo — để đứng yên ở slide đang xem khi danh sách đổi. */
  key: string;
  group: SlideGroup;
  label: string;
  stack?: InfraStack;
  rows: Row[];
  page: number;
  pages: number;
}

/** Bao nhiêu ô cỡ nhỏ nhất vừa khung w×h — slide nhiều hơn thế thì chia trang (màn hình treo không ai cuộn). */
function capacity(w: number, h: number): number {
  if (w < MIN_W || h < MIN_H) return Infinity;
  return Math.max(1, Math.floor((w + GAP) / (MIN_W + GAP))) * Math.max(1, Math.floor((h + GAP) / (MIN_H + GAP)));
}

function buildSlides(groups: SlideGroup[], rows: Row[], columns: Column[], order: InfraStack[], byLevel: (a: Row, b: Row) => number, cap: number): Slide[] {
  type Draft = Omit<Slide, 'key' | 'page' | 'pages'> & { base: string };
  const drafts: Draft[] = [];
  for (const g of groups) {
    if (g === 'project') for (const col of columns) drafts.push({ base: `p:${col.name}`, group: g, label: col.name, rows: [...col.rows].sort(byLevel) });
    if (g === 'stack') for (const st of order) drafts.push({ base: `s:${st}`, group: g, label: STACK_META[st].label, stack: st, rows: rows.filter((r) => r.res.stack === st) });
    if (g === 'level') for (const l of LEVELS) drafts.push({ base: `l:${l}`, group: g, label: LEVEL_LABEL[l], rows: rows.filter((r) => r.ev.level === l) });
  }
  let used = drafts.filter((d) => d.rows.length);
  // Mọi nhóm đều rỗng (vd chỉ bật "Dự án" mà chỉ có một dự án) → một slide tất cả, còn hơn màn hình trống.
  if (!used.length && rows.length) used = [{ base: 'all', group: groups[0] ?? 'level', label: 'Tất cả tài nguyên', rows }];
  return used.flatMap(({ base, ...d }) => {
    const pages = Number.isFinite(cap) ? Math.max(1, Math.ceil(d.rows.length / cap)) : 1;
    const per = Math.ceil(d.rows.length / pages);
    return Array.from({ length: pages }, (_, p) => ({ ...d, key: `${base}#${p}`, rows: d.rows.slice(p * per, (p + 1) * per), page: p, pages }));
  });
}

function WallSlides({ rows, columns, order, groups, sec, active, byLevel, tile, selected }: {
  rows: Row[];
  /** Rỗng khi chỉ có một dự án — slide theo dự án khi đó trùng slide "tất cả". */
  columns: Column[];
  order: InfraStack[];
  groups: SlideGroup[];
  sec: number;
  /** Pane đang hiện và không mở chi tiết — hẹn giờ + phím tắt chỉ chạy khi true. */
  active: boolean;
  byLevel: (a: Row, b: Row) => number;
  tile: TileCtx;
  selected: string | null;
}) {
  const [stageRef, stage] = useBox([]);
  const cap = capacity(stage.w, stage.h);
  const slides = useMemo(() => buildSlides(groups, rows, columns, order, byLevel, cap), [groups, rows, columns, order, byLevel, cap]);

  // Giữ slide đang xem theo key; slide biến mất (hết lỗi, đổi số trang…) thì đứng ở vị trí cũ.
  const [curKey, setCurKey] = useState<string | null>(null);
  /** Tăng mỗi lần chuyển / tạm dừng / chạy tiếp → hẹn giờ và thanh tiến trình chạy lại đủ N giây. */
  const [round, setRound] = useState(0);
  const [paused, setPaused] = useState(false);
  const lastPos = useRef(0);
  let pos = slides.findIndex((s) => s.key === curKey);
  if (pos < 0) pos = Math.max(0, Math.min(lastPos.current, slides.length - 1));
  lastPos.current = pos;
  const slide = slides[pos] as Slide | undefined;

  const jump = (key: string) => { setCurKey(key); setRound((r) => r + 1); };
  const go = (d: number) => { if (slides.length) jump(slides[(pos + d + slides.length) % slides.length].key); };
  const togglePause = () => { setPaused((p) => !p); setRound((r) => r + 1); };
  // Hẹn giờ và phím tắt gọi bản mới nhất (dữ liệu đổi mỗi vòng đo — không khoá vào danh sách slide cũ).
  const act = useRef({ go, togglePause });
  act.current = { go, togglePause };

  const running = active && !paused && slides.length > 1;
  useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => act.current.go(1), sec * 1000);
    return () => window.clearTimeout(t);
  }, [slide?.key, round, running, sec]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') act.current.go(1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') act.current.go(-1);
      else if (e.key === ' ' && !(e.target as HTMLElement | null)?.closest('button')) {
        e.preventDefault();
        act.current.togglePause();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const n = countLevels((slide?.rows ?? []).map((r) => r.ev.level));
  const sum = summaryOf(n, slide?.rows.length ?? 0);
  const fit = slide ? fitAll(slide.rows.length, stage.w, stage.h, SLIDE_MAX_H) : null;
  const inGroup = slide ? slides.filter((s) => s.group === slide.group) : [];
  const shownGroups = groups.filter((g) => slides.some((s) => s.group === g));
  const worst = rollup((slide?.rows ?? []).map((r) => r.ev.level));

  return (
    <div className="wall-slides" aria-roledescription="trình chiếu">
      {slide && (
        <header className={`slide-head lv-${worst}`}>
          <div className="slide-main">
            <div className="slide-kind">{slide.key.startsWith('all#') ? 'Toàn bộ' : GROUP_TEXT[slide.group]}</div>
            <h2 className="slide-title" aria-live="polite">
              <span className="mon-dot" aria-hidden />
              {slide.stack ? <span aria-hidden>{STACK_META[slide.stack].icon}</span> : slide.group === 'project' && !slide.key.startsWith('all#') ? <span aria-hidden>▣</span> : null}
              <span className="slide-name">{slide.label}</span>
              {slide.pages > 1 && <span className="slide-page">trang {slide.page + 1}/{slide.pages}</span>}
            </h2>
            <div className={`slide-sum${sum.bad ? ' bad' : ''}`}>{sum.text} · {slide.rows.length} tài nguyên</div>
            <LevelBar n={n} />
          </div>
          <div className="slide-side">
            {shownGroups.length > 1 && (
              <div className="slide-groups">
                {shownGroups.map((g) => (
                  <button key={g} type="button" className={`slide-group${g === slide.group ? ' on' : ''}`} onClick={() => jump(slides.find((s) => s.group === g)!.key)}>
                    {GROUP_TEXT[g]}
                    {g === slide.group && inGroup.length > 1 && <span className="slide-group-n">{inGroup.indexOf(slide) + 1}/{inGroup.length}</span>}
                  </button>
                ))}
              </div>
            )}
            <div className="slide-ctrl">
              <button type="button" className="slide-btn" onClick={() => go(-1)} aria-label="Slide trước" title="Slide trước (←)">‹</button>
              <button type="button" className="slide-btn" onClick={togglePause} aria-label={paused ? 'Chạy tiếp' : 'Tạm dừng'} title={paused ? 'Chạy tiếp (Space)' : 'Tạm dừng (Space)'}>{paused ? '▶' : '❚❚'}</button>
              <button type="button" className="slide-btn" onClick={() => go(1)} aria-label="Slide sau" title="Slide sau (→)">›</button>
              <span className="slide-count">{pos + 1}/{slides.length} · {paused ? 'đang dừng' : `${sec}s/slide`}</span>
            </div>
          </div>
        </header>
      )}
      <div className="slide-progress" aria-hidden>
        {slide && running && <span key={`${slide.key}:${round}`} style={{ animationDuration: `${sec}s` }} />}
      </div>
      <div ref={stageRef} className="slide-stage">
        {slide && (
          <div
            key={slide.key}
            className="mon-all wall-grid slide-grid"
            style={fit ? { gridTemplateColumns: `repeat(${fit.cols}, minmax(0, 1fr))`, gridAutoRows: `${fit.rowH}px` } : undefined}
          >
            {slide.rows.map((r) => (
              <AllTile
                key={r.res.key}
                row={r}
                size={fit ? sizeOf(fit.rowH) : 'sm'}
                hideProject={slide.group === 'project'}
                hideStack={!!slide.stack}
                selected={selected === r.res.key}
                {...tile}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
