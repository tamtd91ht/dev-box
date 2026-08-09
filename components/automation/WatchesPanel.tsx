'use client';

// Infrastructure watches: "poll THIS metric on THIS connection, and when it
// stays out of range for long enough, emit an event". The watch itself never
// notifies anybody — an `infra` rule decides what the alert is worth.

import { useEffect, useState } from 'react';
import { STACKS, metricDef, stackDef } from '@/lib/automation/catalog';
import { blankWatch } from '@/lib/automation/engine';
import { MIN_WATCH_INTERVAL_SEC } from '@/lib/automation/normalize';
import { connLabel, listConnections, refreshConnections, type ConnOption } from '@/lib/automation/connections';
import { watcher } from '@/lib/automation/watcher';
import { useWatcher } from '@/lib/automation/useAutomation';
import type { AutomationConfig, InfraStack, InfraWatch } from '@/lib/automation/types';
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
  const stack = stackDef(watch.stack);
  const set = (p: Partial<InfraWatch>) => onChange({ ...watch, ...p });

  useEffect(() => {
    void listConnections(watch.stack).then(setConns);
  }, [watch.stack]);

  const changeStack = (s: InfraStack) => {
    // Metrics and connections are both stack-specific — reset to that stack's
    // defaults instead of keeping a metric the new probe never reports.
    const fresh = blankWatch(s);
    onChange({ ...fresh, id: watch.id, name: watch.name, enabled: watch.enabled });
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
      <div className="auto-grid">
        <Field label="Tên" wide>
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
        <Field label="Chỉ số">
          <select value={watch.metric} onChange={(e) => changeMetric(e.target.value)}>
            {(stack?.metrics ?? []).map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
                {m.unit ? ` (${m.unit})` : ''}
              </option>
            ))}
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
        <Field label="Chu kỳ (giây)" hint={`tối thiểu ${MIN_WATCH_INTERVAL_SEC}s`}>
          <Num value={watch.everySec} onChange={(v) => set({ everySec: v })} min={MIN_WATCH_INTERVAL_SEC} />
        </Field>
        <Field label="Giữ đủ (giây)" hint="phải vi phạm liên tục ngần này mới báo — 0 = báo ngay">
          <Num value={watch.forSec ?? 0} onChange={(v) => set({ forSec: v })} />
        </Field>
        <Field label="Nghỉ giữa 2 lần báo (giây)" hint="còn vi phạm thì nhắc lại sau ngần này">
          <Num value={watch.cooldownSec ?? 600} onChange={(v) => set({ cooldownSec: v })} />
        </Field>
      </div>

      <div className="auto-switches">
        <Toggle checked={watch.enabled} onChange={(v) => set({ enabled: v })} label="Bật theo dõi" />
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
}: {
  config: AutomationConfig;
  onChange: (next: AutomationConfig) => void;
}) {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const railSplit = useSplit({ varName: '--auto-list', min: 200, max: 640, gap: 12 });
  const [selected, setSelected] = useState<string | null>(null);
  const { samples, running } = useWatcher();
  const watches = config.watches;
  const setWatches = (next: InfraWatch[]) => onChange({ ...config, watches: next });
  const current = watches.find((w) => w.id === selected) ?? null;

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

        {!watches.length ? (
          <Empty icon="📡" text="Chưa theo dõi chỉ số nào. Ví dụ: Redis RAM > 80%, Kafka under-replicated > 0." />
        ) : (
          <div className="auto-rules">
            {watches.map((w) => {
              const s = samples[w.id];
              return (
                <div
                  key={w.id}
                  className={`auto-rule${selected === w.id ? ' on' : ''}${w.enabled ? '' : ' off'}`}
                  onClick={() => setSelected(w.id)}
                >
                  <span className="auto-rule-ico" aria-hidden>
                    {stackDef(w.stack)?.icon ?? '🖥'}
                  </span>
                  <span className="auto-rule-main">
                    <span className="auto-rule-name">
                      {w.name}
                      {s?.firing ? <em className="auto-firing">đang cảnh báo</em> : null}
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
