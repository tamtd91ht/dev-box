'use client';

// Infrastructure watches: "poll THIS metric on THIS connection, and when it
// stays out of range for long enough, emit an event". The watch itself never
// notifies anybody — an `infra` rule decides what the alert is worth.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  COST_ICON,
  COST_LABEL,
  STACKS,
  metricCost,
  metricDef,
  stackDef,
  watchLoadIssue,
} from '@/lib/automation/catalog';
import { blankWatch } from '@/lib/automation/engine';
import { MIN_WATCH_INTERVAL_SEC } from '@/lib/automation/normalize';
import { connLabel, listConnections, refreshConnections, type ConnOption } from '@/lib/automation/connections';
import { watcher } from '@/lib/automation/watcher';
import { useWatcher } from '@/lib/automation/useAutomation';
import type { AutomationConfig, InfraStack, InfraWatch, WatchSeverity } from '@/lib/automation/types';
import { buildDescription } from '@/lib/automation/meta';
import { Empty, Field, Num, Toggle } from './parts';
import { useSplit } from '@/lib/useSplit';
import Splitter from '../Splitter';

const OPS: { op: InfraWatch['op']; label: string }[] = [
  { op: 'gt', label: '>' },
  { op: 'gte', label: '≥' },
  { op: 'lt', label: '<' },
  { op: 'lte', label: '≤' },
  { op: 'eq', label: '=' },
  { op: 'neq', label: '≠' },
];

/** Alert identity. Ordered worst-first, the way an operator scans a list. */
export const SEVERITY_OPTIONS: { value: WatchSeverity; label: string; short: string }[] = [
  { value: 'critical', label: '🔴 Nghiêm trọng', short: '🔴' },
  { value: 'warning', label: '🟠 Cảnh báo', short: '🟠' },
  { value: 'info', label: '🔵 Thông tin', short: '🔵' },
];
export const severityShort = (s: WatchSeverity | undefined): string =>
  SEVERITY_OPTIONS.find((o) => o.value === (s ?? 'warning'))?.short ?? '🟠';

const parseTags = (s: string): string[] => {
  const seen = new Set<string>();
  for (const t of s.split(',')) {
    const v = t.trim().toLowerCase();
    if (v) seen.add(v);
  }
  return [...seen].slice(0, 12);
};

const ago = (at: number): string => {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 60 ? `${s}s trước` : `${Math.round(s / 60)}m trước`;
};

function WatchEditor({
  watch,
  onChange,
}: {
  watch: InfraWatch;
  onChange: (w: InfraWatch) => void;
}) {
  const [conns, setConns] = useState<ConnOption[]>([]);
  const [probe, setProbe] = useState<{ busy: boolean; text?: string }>({ busy: false });
  const [tagText, setTagText] = useState((watch.tags ?? []).join(', '));
  const stack = stackDef(watch.stack);
  const set = (p: Partial<InfraWatch>) => onChange({ ...watch, ...p });

  const cost = metricCost(watch.stack, watch.metric);
  const def = metricDef(watch.stack, watch.metric);
  const costNote = def?.costNote;
  const floor = def?.minEverySec ?? MIN_WATCH_INTERVAL_SEC;
  const costIssue = watchLoadIssue(watch.stack, watch.metric, watch.everySec);

  // Reload the raw tag text when a DIFFERENT watch is selected — the editor is
  // reused rather than remounted, so local state would otherwise stay behind.
  useEffect(() => {
    setTagText((watch.tags ?? []).join(', '));
  }, [watch.id]);

  useEffect(() => {
    void listConnections(watch.stack).then(setConns);
  }, [watch.stack]);

  const changeStack = (s: InfraStack) => {
    // Metrics and connections are both stack-specific — reset to that stack's
    // defaults instead of keeping a metric the new probe never reports.
    // severity/tags are NOT stack-specific: they are what the user just typed,
    // and silently downgrading a critical watch to warning would quietly stop
    // its alerts announcing themselves as critical.
    const fresh = blankWatch(s);
    onChange({
      ...fresh,
      id: watch.id,
      name: watch.name,
      enabled: watch.enabled,
      severity: watch.severity,
      tags: watch.tags,
      forSec: watch.forSec,
      notifyRecovery: watch.notifyRecovery,
    });
  };

  const changeMetric = (key: string) => {
    const m = metricDef(watch.stack, key);
    set({ metric: key, ...(m?.suggest ? { op: m.suggest.op, threshold: m.suggest.threshold } : {}) });
  };

  const runProbe = async () => {
    if (!watch.connectionId) return;
    setProbe({ busy: true });
    const r = await watcher.probe(watch);
    const value = r.metrics[watch.metric];
    const list = Object.entries(r.metrics)
      .map(([k, v]) => `${k}=${v}`)
      .join('  ');
    setProbe({
      busy: false,
      text: r.error
        ? `lỗi: ${r.error}`
        : `${watch.metric} = ${value ?? '—'}${list ? `\n${list}` : ''}`,
    });
  };

  return (
    <div className="auto-editor">
      <p className="auto-sec-blurb">
        Watch chỉ <b>đo và phát sự kiện</b> — nó không gửi thông báo cho ai. Việc gửi đi đâu và bao
        nhiêu lần là của <b>Quy tắc</b>, và quy tắc nhắm vào watch theo <b>ID</b> bên dưới nên đổi
        tên ở đây hoàn toàn an toàn.
      </p>
      <div className="auto-grid">
        <Field label="Tên" tip="Chỉ để bạn nhận ra watch này. Quy tắc liên kết theo ID (xem dưới), nên đổi tên không làm đứt cảnh báo." wide>
          <input value={watch.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Stack">
          <select value={watch.stack} onChange={(e) => changeStack(e.target.value as InfraStack)}>
            {STACKS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.icon} {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kết nối" hint={conns.length ? undefined : 'chưa khai báo kết nối nào ở tab tương ứng'}>
          <select
            value={watch.connectionId}
            onChange={(e) => {
              const c = conns.find((x) => x.id === e.target.value);
              set({ connectionId: e.target.value, connectionLabel: c ? connLabel(c) : undefined });
            }}
          >
            <option value="">— chọn —</option>
            {conns.map((c) => (
              <option key={c.id} value={c.id}>
                {connLabel(c)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Chỉ số"
          tip="Dấu 🟡/🔴 trước tên nghĩa là đo chỉ số đó tốn tài nguyên của chính cụm đang theo dõi — chọn vào sẽ hiện rõ vì sao và nên đặt chu kỳ bao nhiêu."
        >
          <select value={watch.metric} onChange={(e) => changeMetric(e.target.value)}>
            {(stack?.metrics ?? []).map((m) => {
              // Marked in the list itself: the choice of metric is where the load
              // is decided, so it has to be visible before the click, not after.
              const c = m.cost ?? 'cheap';
              return (
                <option key={m.key} value={m.key}>
                  {c === 'cheap' ? '' : `${COST_ICON[c]} `}
                  {m.label}
                  {m.unit ? ` (${m.unit})` : ''}
                </option>
              );
            })}
          </select>
        </Field>
        <Field label="So sánh">
          <select value={watch.op} onChange={(e) => set({ op: e.target.value as InfraWatch['op'] })}>
            {OPS.map((o) => (
              <option key={o.op} value={o.op}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Ngưỡng" hint={metricDef(watch.stack, watch.metric)?.hint}>
          <Num value={watch.threshold} onChange={(v) => set({ threshold: v })} min={-1e9} />
        </Field>
        <Field
          label="Chu kỳ (giây)"
          tip="Bao lâu đo một lần. Mỗi watch đo ĐỘC LẬP — 12 watch trên cùng một cụm là 12 lượt gọi riêng mỗi vòng, không chia sẻ kết quả. Chỉ số càng nặng thì càng phải giãn."
          hint={`tối thiểu ${MIN_WATCH_INTERVAL_SEC}s`}
        >
          <Num value={watch.everySec} onChange={(v) => set({ everySec: v })} min={MIN_WATCH_INTERVAL_SEC} />
        </Field>
        <Field
          label="Giữ đủ (giây)"
          tip="Chống nhiễu: phải vi phạm LIÊN TỤC ngần này giây mới phát sự kiện. Một chỉ số nhảy vọt 20 giây rồi về bình thường thì chưa thực sự là sự cố. 0 = phát ngay. Đây là phần của việc ĐO, nên nó nằm ở watch chứ không ở quy tắc."
          hint="0 = báo ngay"
        >
          <Num value={watch.forSec ?? 0} onChange={(v) => set({ forSec: v })} />
        </Field>
        <Field
          label="Mức độ"
          tip="Chỉ để NHẬN DIỆN cảnh báo — nó đi theo sự kiện thành {{fields.severityLabel}} để tin nhắn tự giới thiệu mình (🔴 NGHIÊM TRỌNG…). Nó KHÔNG quyết định quy tắc nào chạy: quy tắc chọn watch theo id ở phần Phạm vi."
          hint="metadata nhận diện, không định tuyến"
        >
          <select
            value={watch.severity ?? 'warning'}
            onChange={(e) => set({ severity: e.target.value as WatchSeverity })}
          >
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Tag"
          tip="Nhãn tự do để tìm watch trong danh sách dài (ô tìm kiếm ở phần Phạm vi của quy tắc cũng tra được tag). Chỉ để TÌM KIẾM — quy tắc không bao giờ định tuyến theo tag."
          hint="cách nhau bằng dấu phẩy"
        >
          {/* Raw string while typing: parsing on every keystroke would drop the
              comma the instant it is typed (filter(Boolean) removes the empty
              tail), making a second tag impossible to enter. */}
          <input
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
            onBlur={() => set({ tags: parseTags(tagText) })}
            placeholder="prod, omicrm"
          />
        </Field>
        <Field
          label="Ghi chú"
          wide
          tip="Ngữ cảnh nghiệp vụ mà catalog không thể biết — hệ thống này phục vụ cái gì, đầy/sập thì ảnh hưởng ai. Được NỐI vào mô tả tự sinh bên dưới, đi theo mọi cảnh báo của watch này ({{note}} / metaJson) — bot AI phân tích cảnh báo dựa nhiều vào dòng này."
          hint="tối đa 280 ký tự — đi kèm mọi cảnh báo của watch này"
        >
          <input
            value={watch.note ?? ''}
            maxLength={280}
            onChange={(e) => set({ note: e.target.value })}
            placeholder="vd: Redis này cấp session cho tổng đài FusionPBX — đầy RAM là chặn gửi ngay"
          />
        </Field>
      </div>

      <div className="auto-watch-id">
        <span>ID</span>
        <code title="quy tắc nhắm vào watch bằng id này — đổi tên watch không ảnh hưởng">{watch.id}</code>
      </div>

      {/* The exact description every alert of this watch will carry
          ({{description}} / metaJson) — shown live so what you read here is
          what the Zalo group (and its AI bot) reads at 2am. */}
      <div className="auto-watch-desc">
        <span className="auto-hint">Mô tả cơ chế phát hiện (tự sinh — đi kèm mọi cảnh báo qua {'{{description}}'} và metaJson):</span>
        <pre className="auto-probe">{buildDescription(watch)}</pre>
      </div>

      {/* Only for metrics that actually cost something. A cheap metric carrying a
          permanent "cost: light" box is noise, and noise is what makes the real
          warning invisible. */}
      {cost !== 'cheap' ? (
        <div className={`auto-cost lvl-${cost}${costIssue ? ` has-${costIssue.level}` : ''}`}>
          <div className="auto-cost-head">
            <b>
              {COST_ICON[cost]} Bật chỉ số này có thể làm tăng tải {stack?.label ?? watch.stack}
            </b>
            {costIssue ? <em className={costIssue.level === 'risk' ? 'bad' : ''}>{costIssue.text}</em> : null}
          </div>
          {costNote ? <p>{costNote}</p> : null}
          {costIssue ? (
            <button type="button" className="ghost sm" onClick={() => set({ everySec: floor })}>
              Đặt chu kỳ về {floor}s
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="auto-switches">
        <Toggle
          checked={watch.enabled}
          onChange={(v) => set({ enabled: v })}
          label="Bật theo dõi"
          // The warning belongs on the switch itself: this is the moment the load
          // starts, and hovering here is the last chance to reconsider.
          hint={
            cost === 'cheap'
              ? undefined
              : costIssue
                ? `⚠ ${costIssue.text} Chỉ số này làm tăng tải cụm.`
                : `⚠ Chỉ số ${COST_LABEL[cost].toLowerCase()} — bật sẽ thêm tải cho cụm`
          }
          tone={cost === 'heavy' ? 'risk' : undefined}
        />
        <Toggle
          checked={watch.notifyRecovery !== false}
          onChange={(v) => set({ notifyRecovery: v })}
          label="Báo khi hồi phục"
          hint="phát sự kiện infra.recovered"
        />
        <button type="button" className="ghost sm" disabled={!watch.connectionId || probe.busy} onClick={runProbe}>
          {probe.busy ? 'đang đo…' : 'Thử ngay'}
        </button>
      </div>

      {probe.text ? <pre className="auto-probe">{probe.text}</pre> : null}
    </div>
  );
}

export default function WatchesPanel({
  config,
  onChange,
  focusWatchId,
  onFocusHandled,
}: {
  config: AutomationConfig;
  onChange: (next: AutomationConfig) => void;
  /** Watch cần mở sẵn, do nút "Xem" bên tab Quy tắc yêu cầu. */
  focusWatchId?: string | null;
  /** Báo đã mở xong để cha xoá yêu cầu — bấm lại cùng watch vẫn phải nhảy được. */
  onFocusHandled?: () => void;
}) {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const railSplit = useSplit({ varName: '--auto-list', min: 200, max: 640, gap: 12 });
  const [selected, setSelected] = useState<string | null>(null);
  /** Dòng đang chọn, để cuộn tới khi được mở từ tab Quy tắc. */
  const selectedRow = useRef<HTMLDivElement | null>(null);
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  const { samples, running } = useWatcher();
  const watches = config.watches;
  const setWatches = (next: InfraWatch[]) => onChange({ ...config, watches: next });
  const current = watches.find((w) => w.id === selected) ?? null;

  // Filters. A declared-watch list runs to 150+ entries, which is a scroll
  // rather than a list — every filter here exists to cut that to something you
  // can actually pick from.
  const [q, setQ] = useState('');
  const [fStack, setFStack] = useState<InfraStack | ''>('');
  const [fSev, setFSev] = useState<WatchSeverity | ''>('');
  const [fState, setFState] = useState<'' | 'on' | 'off' | 'firing' | 'orphan'>('');

  /**
   * Watches no rule answers for. Matching by id is precise but not automatic:
   * deleting a watch from a rule's list, or adding a watch after the rule was
   * written, leaves it measuring into the void — it fires, and nobody is told.
   * That failure is invisible without saying so here.
   */
  const orphans = useMemo(() => {
    const live = config.rules.filter(
      (r) => r.category === 'infra' && r.trigger === 'infra.metric' && r.enabled,
    );
    // Mirrors engine.inScope: ALL three scope levels must pass, so narrowing
    // "Kết nối" to one cluster drops every watch on the others — the failure that
    // is impossible to see from the rule editor alone.
    const coveredBy = (r: (typeof live)[number], w: InfraWatch): boolean => {
      const { sourceIds, instanceIds, watchIds } = r.scope ?? { sourceIds: [], instanceIds: [] };
      if (sourceIds?.length && !sourceIds.includes(w.stack)) return false;
      if (instanceIds?.length && !instanceIds.includes(w.connectionId)) return false;
      if (watchIds?.length && !watchIds.includes(w.id)) return false;
      return true;
    };
    return new Set(watches.filter((w) => !live.some((r) => coveredBy(r, w))).map((w) => w.id));
  }, [config.rules, watches]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return watches.filter((w) => {
      if (fStack && w.stack !== fStack) return false;
      if (fSev && (w.severity ?? 'warning') !== fSev) return false;
      if (fState === 'on' && !w.enabled) return false;
      if (fState === 'off' && w.enabled) return false;
      if (fState === 'firing' && !samples[w.id]?.firing) return false;
      if (fState === 'orphan' && !orphans.has(w.id)) return false;
      if (!needle) return true;
      const hay = `${w.name} ${w.id} ${w.connectionLabel ?? ''} ${w.metric} ${(w.tags ?? []).join(' ')}`;
      return hay.toLowerCase().includes(needle);
    });
  }, [watches, q, fStack, fSev, fState, samples, orphans]);

  const filtering = !!(q.trim() || fStack || fSev || fState);
  const clearFilters = () => {
    setQ('');
    setFStack('');
    setFSev('');
    setFState('');
  };

  /**
   * Nút "Xem" bên tab Quy tắc vừa chỉ tới một watch: mở nó ra để sửa.
   *
   * XOÁ LỌC luôn, không chỉ setSelected. Bộ lọc ở đây sống theo phiên, nên
   * watch được nhắm tới rất dễ đang bị một bộ lọc cũ ẩn đi — lúc đó bên phải
   * hiện đúng watch còn danh sách bên trái không có dòng nào sáng, đọc ra như
   * app chọn nhầm. Xoá lọc thì thấy nó nằm trong danh sách, cuộn tới được.
   */
  useEffect(() => {
    if (!focusWatchId) return;
    if (!watches.some((w) => w.id === focusWatchId)) return; // watch đã bị xoá
    setSelected(focusWatchId);
    clearFilters();
    setScrollTo(focusWatchId);
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusWatchId]);

  /**
   * Cuộn tới dòng vừa được chọn từ xa. Danh sách dài 150+ dòng nên chỉ tô sáng
   * thôi là chưa đủ — dòng sáng thường nằm ngoài màn hình.
   *
   * Tách khỏi effect trên và chạy sau khi `visible` đã tính lại: lúc effect kia
   * chạy, bộ lọc mới vừa được xoá nên dòng cần tới có thể CHƯA có trong DOM.
   */
  useEffect(() => {
    if (!scrollTo) return;
    const el = selectedRow.current;
    if (el) el.scrollIntoView({ block: 'nearest' });
    setScrollTo(null);
  }, [scrollTo, visible]);
  // Only the stacks actually declared — offering all six when five are unused
  // is noise, and the count tells you where the watches are.
  const stackCounts = useMemo(() => {
    const m = new Map<InfraStack, number>();
    for (const w of watches) m.set(w.stack, (m.get(w.stack) ?? 0) + 1);
    return m;
  }, [watches]);
  const enabledCount = watches.filter((w) => w.enabled).length;
  const firingCount = watches.filter((w) => samples[w.id]?.firing).length;


  const add = () => {
    refreshConnections();
    const w = blankWatch('redis');
    w.name = `Theo dõi ${watches.length + 1}`;
    setWatches([...watches, w]);
    setSelected(w.id);
  };

  return (
    <div className="auto-split" ref={railSplit.ref} style={railSplit.style}>
      <div className="auto-list panel">
        <div className="auto-list-head">
          <span className={`auto-runstate${running ? ' on' : ''}`}>
            {running ? '● đang chạy' : '○ đang dừng'}
            {!config.watchEnabled ? ' — bật "theo dõi hạ tầng" ở trên' : ''}
          </span>
          <button type="button" className="sm" onClick={add}>
            ＋ Theo dõi
          </button>
        </div>

        {watches.length ? (
          <div className="auto-wfilter">
            <input
              className="auto-wfilter-q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Tìm theo tên · id · kết nối · chỉ số · tag…"
            />
            <div className="auto-wfilter-row">
              <select value={fStack} onChange={(e) => setFStack(e.target.value as InfraStack | '')}>
                <option value="">Mọi stack ({watches.length})</option>
                {STACKS.filter((s) => stackCounts.has(s.id)).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.icon} {s.label} ({stackCounts.get(s.id)})
                  </option>
                ))}
              </select>
              <select value={fSev} onChange={(e) => setFSev(e.target.value as WatchSeverity | '')}>
                <option value="">Mọi mức độ</option>
                {SEVERITY_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label} ({watches.filter((w) => (w.severity ?? 'warning') === s.value).length})
                  </option>
                ))}
              </select>
              <select value={fState} onChange={(e) => setFState(e.target.value as typeof fState)}>
                <option value="">Bật và tắt</option>
                <option value="on">Đang bật ({enabledCount})</option>
                <option value="off">Đang tắt ({watches.length - enabledCount})</option>
                <option value="firing">Đang cảnh báo ({firingCount})</option>
                {orphans.size ? <option value="orphan">⚠ Không quy tắc nào lo ({orphans.size})</option> : null}
              </select>
              {filtering ? (
                <button type="button" className="ghost sm" onClick={clearFilters}>
                  Xoá lọc
                </button>
              ) : null}
            </div>
            {orphans.size && fState !== 'orphan' ? (
              <button type="button" className="auto-wfilter-warn" onClick={() => setFState('orphan')}>
                ⚠ {orphans.size} watch không quy tắc nào lo — sẽ đo mà không ai được báo. Xem →
              </button>
            ) : null}

            {filtering ? (
              <span className="auto-wfilter-count">
                {visible.length}/{watches.length} watch
              </span>
            ) : null}
          </div>
        ) : null}

        {!watches.length ? (
          <Empty icon="📡" text="Chưa theo dõi chỉ số nào. Ví dụ: Redis RAM > 80%, Kafka under-replicated > 0." />
        ) : !visible.length ? (
          <Empty icon="🔍" text="Không watch nào khớp bộ lọc." />
        ) : (
          <div className="auto-rules">
            {visible.map((w) => {
              const s = samples[w.id];
              return (
                <div
                  key={w.id}
                  ref={w.id === selected ? selectedRow : undefined}
                  className={`auto-rule${selected === w.id ? ' on' : ''}${w.enabled ? '' : ' off'}`}
                  onClick={() => setSelected(w.id)}
                >
                  <span className="auto-rule-ico" aria-hidden>
                    {stackDef(w.stack)?.icon ?? '🖥'}
                  </span>
                  <span className="auto-rule-main">
                    <span className="auto-rule-name">
                      <span title={`mức độ: ${w.severity ?? 'warning'}`}>{severityShort(w.severity)}</span>{' '}
                      {w.name}
                      {s?.firing ? <em className="auto-firing">đang cảnh báo</em> : null}
                      {orphans.has(w.id) ? (
                        <em
                          className="auto-orphan"
                          title="Không quy tắc nào đang bật nhắm vào watch này — nó sẽ đo và phát sự kiện nhưng không ai được thông báo. Thêm nó vào ô Watch của một quy tắc."
                        >
                          không ai lo
                        </em>
                      ) : null}
                    </span>
                    <span className="auto-rule-sub">
                      {w.connectionLabel || w.connectionId || '—'} · {w.metric}{' '}
                      {OPS.find((o) => o.op === w.op)?.label} {w.threshold}
                      {s ? (
                        <>
                          {' · '}
                          <b className={s.breaching ? 'bad' : 'ok'}>{s.value ?? '—'}</b> {ago(s.at)}
                          {s.error ? ` · ${s.error}` : ''}
                        </>
                      ) : null}
                    </span>
                    {/* Id is what rules point at — visible so a rule's watch list
                        can be read against this panel without guessing. */}
                    <code className="auto-rule-id">{w.id}</code>
                  </span>
                  <span className="auto-rule-ops" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={w.enabled}
                      onChange={(e) => setWatches(watches.map((x) => (x.id === w.id ? { ...x, enabled: e.target.checked } : x)))}
                    />
                    <button
                      type="button"
                      className="ghost sm"
                      title="Xoá"
                      onClick={() => {
                        setWatches(watches.filter((x) => x.id !== w.id));
                        if (selected === w.id) setSelected(null);
                      }}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="auto-detail panel">
        {current ? (
          <WatchEditor
            watch={current}
            onChange={(next) => setWatches(watches.map((w) => (w.id === next.id ? next : w)))}
          />
        ) : (
          <Empty icon="👈" text="Chọn một mục theo dõi, hoặc tạo mới." />
        )}
      </div>
      <Splitter {...railSplit.grip} />
    </div>
  );
}
