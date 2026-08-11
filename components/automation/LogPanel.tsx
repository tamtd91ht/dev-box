'use client';

// Log storage + reports.
//
// TWO THINGS, one panel, because they are the same decision seen from both ends:
// where history is kept, and what you can then ask of it.
//
//   local  a JSONL file, pruned after N days. Tail-able, this machine only.
//   mongo  documents in a collection. Queryable, survives the machine — and the
//          only target reports can run on.
//
// WHY SWITCHING TO MONGO NEEDS A CONFIRMED WRITE: pointing logging at an
// unreachable cluster loses exactly the records you would need to work out why.
// So "Ghi thử" must succeed before the target is allowed to change, and the
// panel says so rather than letting a silent misconfiguration through.
//
// A connection typed in here is SAVED INTO the Mongo registry
// (configs/mongoconnections.json) instead of being inlined: credentials stay in
// one place, and it becomes visible/editable in the Mongo tab like any other.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { connLabel, listConnections, refreshConnections, type ConnOption } from '@/lib/automation/connections';
import type { AutomationConfig, LogStoreConfig, LogTarget, TraceConfig } from '@/lib/automation/types';
import { formatTrace as fmtTrace, type TraceLine } from '@/lib/automation/trace';
import { Empty, Field, Section, Toggle } from './parts';

type ReportKind = 'noisiest' | 'byStack' | 'mttr' | 'timeline' | 'flapping';

const REPORTS: { kind: ReportKind; label: string; blurb: string }[] = [
  {
    kind: 'noisiest',
    label: 'Watch ồn nhất',
    blurb: 'Watch nào bắn nhiều nhất — đọc đầu tiên: một hệ monitor chết vì bị phớt, và nó bị phớt vì vài watch chiếm hết lưu lượng.',
  },
  { kind: 'byStack', label: 'Theo stack / cụm', blurb: 'Cảnh báo dồn ở stack và cụm nào.' },
  { kind: 'mttr', label: 'Thời gian tồn tại sự cố', blurb: 'Từ lúc vượt ngưỡng đến lúc hồi phục, trung bình và lâu nhất.' },
  { kind: 'timeline', label: 'Diễn biến theo thời gian', blurb: 'Cảnh báo theo giờ (≤3 ngày) hoặc theo ngày — đang tốt lên hay xấu đi.' },
  {
    kind: 'flapping',
    label: 'Watch nhảy liên tục',
    blurb: 'Bắn rồi hồi phục lặp lại ≥3 lần: ngưỡng đặt sát vùng làm việc bình thường, cần sửa ngưỡng chứ không phải sửa cụm.',
  },
];

const RANGES: { label: string; ms: number }[] = [
  { label: '24 giờ', ms: 24 * 3600e3 },
  { label: '7 ngày', ms: 7 * 24 * 3600e3 },
  { label: '30 ngày', ms: 30 * 24 * 3600e3 },
];

interface ReportRow {
  key: string;
  sub?: string;
  count: number;
  avgSec?: number;
  maxSec?: number;
  avgValue?: number;
  maxValue?: number;
  critical?: number;
  warning?: number;
  info?: number;
  recovered?: number;
}

const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

const fmtDur = (sec: number): string => {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
};

const fmtWhen = (iso?: string): string => (iso ? new Date(iso).toLocaleString() : '—');

async function api(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch('/api/automation/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(typeof j.error === 'string' ? j.error : `HTTP ${r.status}`);
  return j;
}

export default function LogPanel({
  config,
  onChange,
}: {
  config: AutomationConfig;
  onChange: (next: AutomationConfig) => void;
}) {
  const store = config.logStore;
  const set = (p: Partial<LogStoreConfig>) => onChange({ ...config, logStore: { ...store, ...p } });

  const [conns, setConns] = useState<ConnOption[]>([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);

  const trace = config.trace;
  const setTrace = (p: Partial<TraceConfig>) => onChange({ ...config, trace: { ...trace, ...p } });
  const [traceLines, setTraceLines] = useState<TraceLine[] | null>(null);

  const [report, setReport] = useState<ReportKind>('noisiest');
  const [rangeMs, setRangeMs] = useState(RANGES[1].ms);
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [reportMeta, setReportMeta] = useState<{ total: number } | null>(null);

  useEffect(() => {
    void listConnections('mongo').then(setConns);
  }, []);

  const run = useCallback(
    async (tag: string, payload: Record<string, unknown>, ok: (j: Record<string, unknown>) => string) => {
      setBusy(tag);
      setMsg(null);
      try {
        const j = await api({ ...payload, logStore: store });
        setMsg({ tone: 'ok', text: ok(j) });
        return j;
      } catch (e) {
        setMsg({ tone: 'bad', text: (e as Error).message });
        return null;
      } finally {
        setBusy('');
      }
    },
    [store],
  );

  /** The trace file lives behind its own route — separate volume, separate lifetime. */
  const traceApi = useCallback(
    async (tag: string, payload: Record<string, unknown>, ok: (j: Record<string, unknown>) => string) => {
      setBusy(tag);
      setMsg(null);
      try {
        const r = await fetch('/api/automation/trace', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, fileName: trace.fileName }),
        });
        const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        if (!r.ok) throw new Error(typeof j.error === 'string' ? j.error : `HTTP ${r.status}`);
        setMsg({ tone: 'ok', text: ok(j) });
        return j;
      } catch (e) {
        setMsg({ tone: 'bad', text: (e as Error).message });
        return null;
      } finally {
        setBusy('');
      }
    },
    [trace.fileName],
  );

  const loadTrace = async () => {
    const j = await traceApi('tail', { action: 'tail', limit: 200 }, (r) => `${String(r.total)} dòng trong file`);
    if (j) setTraceLines((j.lines as TraceLine[]) ?? []);
  };

  const loadStats = useCallback(async () => {
    const j = await run('stats', { action: 'stats' }, () => 'đã cập nhật');
    if (j) setStats(j);
  }, [run]);

  const doTest = async () => {
    const j = await run('test', { action: 'test' }, (r) => `đã ghi 1 bản ghi thử vào ${String(r.where)}`);
    // Only a real successful write marks the target verified — that flag is what
    // the "chưa xác nhận" warning below keys off.
    if (j?.verifiedAt) set({ verifiedAt: Number(j.verifiedAt) });
    if (j) void loadStats();
  };

  const runReport = async () => {
    const toMs = Date.now();
    const j = await run(
      'report',
      { action: 'report', kind: report, fromMs: toMs - rangeMs, toMs },
      (r) => `${(r.rows as unknown[])?.length ?? 0} dòng`,
    );
    if (j) {
      setRows((j.rows as ReportRow[]) ?? []);
      setReportMeta({ total: Number(j.total) || 0 });
    }
  };

  const local = stats?.local as { name: string; bytes: number; lines: number; oldest?: string } | undefined;
  const mongo = stats?.mongo as { where: string; documents: number; oldest?: string; ttlSeconds?: number } | undefined;

  /** Mongo is picked but never proven to work — the one state worth shouting about. */
  const unverifiedMongo = store.enabled && store.target === 'mongo' && !store.verifiedAt;
  const missingConn = store.target === 'mongo' && !store.connectionId;

  const reportDef = useMemo(() => REPORTS.find((r) => r.kind === report)!, [report]);

  return (
    <div className="auto-logpanel panel">
      <Section
        title="Lưu trữ log"
        blurb={
          <>
            Hành động <code>log</code> trong quy tắc sẽ ghi vào đây. Tắt = không ghi gì cả, ở đâu cũng
            không. Cấu hình này đi theo <b>Sync</b> lên git như phần còn lại của Automation.
          </>
        }
      >
        <div className="auto-switches">
          <Toggle
            checked={store.enabled}
            onChange={(v) => set({ enabled: v })}
            label="Bật lưu trữ log"
            hint="tắt = hành động log báo 'skipped'"
            tone="risk"
          />
        </div>

        {store.enabled ? (
          <>
            <Field
              label="Lưu ở đâu"
              tip="Local: một file JSONL cạnh config, tự xoá dòng cũ sau N ngày, xem bằng tail — chỉ máy này. MongoDB: ghi thành document, query được, sống lâu hơn máy, và là nơi DUY NHẤT chạy được báo cáo."
            >
              <div className="auto-checks">
                {(['local', 'mongo'] as LogTarget[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`auto-chip${store.target === t ? ' on' : ''}`}
                    onClick={() => set({ target: t })}
                  >
                    {t === 'local' ? '📄 File local' : '🍃 MongoDB'}
                  </button>
                ))}
              </div>
            </Field>

            {store.target === 'local' ? (
              <div className="auto-grid">
                <Field label="Tên file" hint="trong thư mục làm việc — .jsonl">
                  <input
                    value={store.file ?? ''}
                    placeholder=".automation-log.jsonl"
                    onChange={(e) => set({ file: e.target.value })}
                  />
                </Field>
                <Field
                  label="Giữ lại (ngày)"
                  tip="Dòng cũ hơn ngần này bị xoá khi ghi (dọn nhiều nhất 1 lần/giờ để không đọc lại cả file mỗi lần ghi). Dòng nào không đọc được ngày thì GIỮ — retention để chặn phình file, không phải để âm thầm mất bản ghi."
                >
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={store.retentionDays ?? 7}
                    onChange={(e) => set({ retentionDays: Number(e.target.value) || 7 })}
                  />
                </Field>
              </div>
            ) : (
              <>
                <div className="auto-grid">
                  <Field
                    label="Kết nối MongoDB"
                    tip="Chọn từ danh sách đã khai ở tab MongoDB. Log lưu theo ID kết nối chứ không nhúng connection string — mật khẩu chỉ nằm một chỗ, và sửa kết nối ở tab Mongo là log đi theo."
                  >
                    <select
                      value={store.connectionId ?? ''}
                      onChange={(e) => {
                        const c = conns.find((x) => x.id === e.target.value);
                        // Changing the target invalidates the previous proof.
                        set({
                          connectionId: e.target.value,
                          connectionLabel: c ? connLabel(c) : undefined,
                          verifiedAt: undefined,
                        });
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
                  <Field label="Database" hint="rỗng → devbox">
                    <input
                      value={store.database ?? ''}
                      placeholder="devbox"
                      onChange={(e) => set({ database: e.target.value, verifiedAt: undefined })}
                    />
                  </Field>
                  <Field label="Collection" hint="rỗng → automation_log">
                    <input
                      value={store.collection ?? ''}
                      placeholder="automation_log"
                      onChange={(e) => set({ collection: e.target.value, verifiedAt: undefined })}
                    />
                  </Field>
                </div>
                <p className="auto-sec-blurb">
                  Chưa có kết nối phù hợp? Khai ở <b>tab MongoDB</b> rồi bấm ↻ — nó sẽ hiện trong danh
                  sách trên. Cách này giữ mật khẩu ở một chỗ duy nhất.
                </p>
              </>
            )}

            {missingConn ? (
              <div className="auto-logwarn bad">Chưa chọn kết nối MongoDB — log sẽ báo lỗi khi chạy.</div>
            ) : unverifiedMongo ? (
              <div className="auto-logwarn">
                Chưa xác nhận ghi được. Bấm <b>Ghi thử</b> trước khi tin — trỏ log vào cụm không tới
                được thì mất đúng những bản ghi cần để tìm nguyên nhân.
              </div>
            ) : null}

            <div className="auto-switches">
              <button type="button" className="sm" disabled={!!busy} onClick={doTest}>
                {busy === 'test' ? 'đang ghi…' : 'Ghi thử'}
              </button>
              <button type="button" className="ghost sm" disabled={!!busy} onClick={loadStats}>
                {busy === 'stats' ? 'đang đọc…' : 'Xem dung lượng'}
              </button>
              <button type="button" className="ghost sm" onClick={() => { refreshConnections(); void listConnections('mongo').then(setConns); }}>
                ↻ Nạp lại kết nối
              </button>
              {store.target === 'local' ? (
                <button
                  type="button"
                  className="ghost sm"
                  disabled={!!busy}
                  onClick={() =>
                    void run('prune', { action: 'prune' }, (j) => `đã xoá ${String(j.removed)} dòng cũ`).then(
                      (j) => j && setStats(j),
                    )
                  }
                >
                  Dọn ngay
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="ghost sm"
                    disabled={!!busy || missingConn}
                    title="Tạo/điều chỉnh TTL index để Mongo tự xoá document cũ — dùng cơ chế của chính Mongo, ai xem collection cũng thấy"
                    onClick={() =>
                      void run('ttl', { action: 'ttl', days: store.retentionDays ?? 7 }, (j) =>
                        `TTL = ${Math.round(Number(j.seconds) / 86400)} ngày`,
                      ).then((j) => j && setStats(j))
                    }
                  >
                    Đặt TTL {store.retentionDays ?? 7} ngày
                  </button>
                  <button
                    type="button"
                    className="ghost sm"
                    disabled={!!busy || missingConn}
                    title="Tạo index cho các báo cáo bên dưới"
                    onClick={() => void run('indexes', { action: 'indexes' }, (j) => `đã tạo ${(j.names as string[])?.length ?? 0} index`)}
                  >
                    Tạo index báo cáo
                  </button>
                </>
              )}
            </div>

            {msg ? <div className={`auto-logmsg ${msg.tone}`}>{msg.text}</div> : null}

            {local ? (
              <pre className="auto-probe">
                {`file:     ${local.name}
dung lượng: ${fmtBytes(local.bytes)}  ·  ${local.lines} dòng
cũ nhất:   ${fmtWhen(local.oldest)}`}
              </pre>
            ) : null}
            {mongo ? (
              <pre className="auto-probe">
                {`đích:      ${mongo.where}
document:  ${mongo.documents.toLocaleString()}
cũ nhất:   ${fmtWhen(mongo.oldest)}
TTL:       ${mongo.ttlSeconds ? `${Math.round(mongo.ttlSeconds / 86400)} ngày` : 'chưa đặt — document không tự xoá'}`}
              </pre>
            ) : null}
          </>
        ) : null}
      </Section>

      <Section
        title="Theo dõi runner (trace)"
        defaultOpen={false}
        blurb={
          <>
            Trả lời câu hỏi mà tab Hoạt động không trả lời được: <b>chiến dịch hạ tầng có đang chạy
            không?</b> Watch khoẻ thì không sinh cảnh báo nào, nên feed trống — không phân biệt được
            “yên vì tốt” với “yên vì runner đã chết”.
          </>
        }
      >
        <div className="auto-switches">
          <Toggle
            checked={trace.console}
            onChange={(v) => setTrace({ console: v })}
            label="Log ra console"
            hint="mở DevTools của app (Ctrl+Shift+I) để xem"
          />
          <Toggle
            checked={trace.file}
            onChange={(v) => setTrace({ file: v })}
            label="Ghi ra file"
            hint=".automation-trace.jsonl — giữ theo giờ"
          />
        </div>

        {trace.console || trace.file ? (
          <>
            <div className="auto-grid">
              <Field
                label="Mức chi tiết"
                tip="'Chỉ thay đổi' ghi khi vượt ngưỡng / hồi phục / lỗi đọc, cộng một dòng nhịp tim mỗi 5 phút — để bật lâu dài. 'Tất cả' ghi từng lần đo kể cả bình thường: 153 watch mỗi 60s là ~150 dòng/phút, chỉ nên bật vài phút để kiểm tra."
              >
                <select
                  value={trace.verbosity}
                  onChange={(e) => setTrace({ verbosity: e.target.value as 'all' | 'changes' })}
                >
                  <option value="changes">Chỉ thay đổi (bật lâu dài được)</option>
                  <option value="all">Tất cả mỗi lần đo (nhiều — chỉ để kiểm tra)</option>
                </select>
              </Field>
              {trace.file ? (
                <>
                  <Field label="Tên file" hint="trong thư mục làm việc">
                    <input
                      value={trace.fileName ?? ''}
                      placeholder=".automation-trace.jsonl"
                      onChange={(e) => setTrace({ fileName: e.target.value })}
                    />
                  </Field>
                  <Field label="Giữ lại (giờ)" hint="mặc định 24">
                    <input
                      type="number"
                      min={1}
                      max={168}
                      value={trace.retentionHours ?? 24}
                      onChange={(e) => setTrace({ retentionHours: Number(e.target.value) || 24 })}
                    />
                  </Field>
                </>
              ) : null}
            </div>

            {trace.verbosity === 'all' ? (
              <div className="auto-logwarn">
                Mức “Tất cả” ghi mỗi lần đo của mọi watch — với {'>'}100 watch là hàng trăm dòng mỗi
                phút. Dùng để xác nhận runner chạy rồi chuyển về “Chỉ thay đổi”.
              </div>
            ) : null}

            {trace.file ? (
              <div className="auto-switches">
                <button type="button" className="sm" disabled={!!busy} onClick={loadTrace}>
                  {busy === 'tail' ? 'đang đọc…' : 'Xem dòng mới nhất'}
                </button>
                <button
                  type="button"
                  className="ghost sm"
                  disabled={!!busy}
                  onClick={() =>
                    void traceApi('clear', { action: 'clear' }, () => 'đã xoá file trace').then(() =>
                      setTraceLines([]),
                    )
                  }
                >
                  Xoá file
                </button>
              </div>
            ) : null}

            {traceLines ? (
              traceLines.length ? (
                <pre className="auto-probe auto-trace">{traceLines.map(fmtTrace).join('\n')}</pre>
              ) : (
                <Empty icon="📄" text="File trace chưa có dòng nào — chờ vòng đo kế tiếp." />
              )
            ) : null}
          </>
        ) : null}
      </Section>

      <Section
        title="Báo cáo"
        defaultOpen={false}
        blurb={
          <>
            Chạy trên log MongoDB. <b>Bỏ qua bản ghi dry-run</b> — diễn tập không phải sự cố nên
            không được tính vào số liệu.
          </>
        }
      >
        {store.target !== 'mongo' || !store.enabled ? (
          <Empty
            icon="🍃"
            text="Báo cáo cần log lưu trên MongoDB. Log local chỉ để xem bằng tail — tổng hợp nó phải đọc cả file vào RAM và cũng chỉ biết được dữ liệu của riêng máy này."
          />
        ) : (
          <>
            <div className="auto-checks">
              {REPORTS.map((r) => (
                <button
                  key={r.kind}
                  type="button"
                  className={`auto-chip${report === r.kind ? ' on' : ''}`}
                  onClick={() => {
                    setReport(r.kind);
                    setRows(null);
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <p className="auto-sec-blurb">{reportDef.blurb}</p>

            <div className="auto-switches">
              <div className="auto-checks">
                {RANGES.map((r) => (
                  <button
                    key={r.ms}
                    type="button"
                    className={`auto-chip${rangeMs === r.ms ? ' on' : ''}`}
                    onClick={() => setRangeMs(r.ms)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <button type="button" className="sm" disabled={!!busy || missingConn} onClick={runReport}>
                {busy === 'report' ? 'đang chạy…' : 'Chạy báo cáo'}
              </button>
            </div>

            {rows === null ? null : !rows.length ? (
              <Empty icon="📊" text="Không có bản ghi nào trong khoảng thời gian này." />
            ) : (
              <>
                {reportMeta ? (
                  <div className="auto-wfilter-count">
                    {rows.length} dòng · tổng {reportMeta.total.toLocaleString()} bản ghi trong khoảng
                  </div>
                ) : null}
                <div className="auto-rpt-wrap">
                  <table className="auto-rpt">
                    <thead>
                      <tr>
                        <th>{report === 'timeline' ? 'Thời điểm' : 'Watch / nhóm'}</th>
                        {report !== 'timeline' ? <th>Kết nối</th> : null}
                        <th className="n">Số lần</th>
                        {report === 'mttr' || report === 'flapping' ? <th className="n">TB</th> : null}
                        {report === 'mttr' ? <th className="n">Lâu nhất</th> : null}
                        {report === 'noisiest' ? <th className="n">Giá trị TB</th> : null}
                        {report === 'noisiest' ? <th className="n">Đỉnh</th> : null}
                        {report === 'byStack' || report === 'timeline' || report === 'flapping' ? (
                          <th className="n">Hồi phục</th>
                        ) : null}
                        {report !== 'mttr' ? <th className="n">🔴/🟠/🔵</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={`${r.key}-${r.sub ?? ''}-${i}`}>
                          <td>{r.key || '—'}</td>
                          {report !== 'timeline' ? <td className="dim">{r.sub || '—'}</td> : null}
                          <td className="n">{r.count.toLocaleString()}</td>
                          {report === 'mttr' || report === 'flapping' ? (
                            <td className="n">{r.avgSec != null ? fmtDur(r.avgSec) : '—'}</td>
                          ) : null}
                          {report === 'mttr' ? (
                            <td className="n">{r.maxSec != null ? fmtDur(r.maxSec) : '—'}</td>
                          ) : null}
                          {report === 'noisiest' ? <td className="n">{r.avgValue ?? '—'}</td> : null}
                          {report === 'noisiest' ? <td className="n">{r.maxValue ?? '—'}</td> : null}
                          {report === 'byStack' || report === 'timeline' || report === 'flapping' ? (
                            <td className="n">{r.recovered ?? 0}</td>
                          ) : null}
                          {report !== 'mttr' ? (
                            <td className="n dim">
                              {r.critical ?? 0}/{r.warning ?? 0}/{r.info ?? 0}
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </Section>
    </div>
  );
}
