'use client';

// Kết quả aggregations của tab Dữ liệu — đọc nhanh kiểu Kibana:
//   · bucket agg (terms/date_histogram/range/filters…) → bảng key · doc_count ·
//     các metric con; bucket còn agg lồng sâu hơn thì bấm vào hàng để mở JSON
//   · metric một giá trị (avg/sum/cardinality…) → con số to
//   · stats/percentiles → bảng key–value · agg bọc (filter/nested/global) → đệ quy
// Bảng chỉ là cách ĐỌC nhanh — JSON mới đầy đủ, nên card nào cũng có nút { } và ⧉.

import { Fragment, useMemo, useState } from 'react';
import { fmtCount } from '@/lib/es';

type AggNode = Record<string, unknown>;
type Bucket = Record<string, unknown>;

/** Key "hạ tầng" của một bucket — không phải agg con. */
const META_KEYS = new Set(['key', 'key_as_string', 'doc_count', 'doc_count_error_upper_bound', 'from', 'from_as_string', 'to', 'to_as_string']);

/** Số hàng bucket tối đa hiển thị — chỉ là chốt an toàn UI, ES đã giới hạn theo `size` của agg. */
const MAX_ROWS = 500;

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }
  return String(v);
}

/** buckets dạng mảng (terms/date_histogram…) hoặc object có tên (filters/range keyed). */
function toBuckets(node: AggNode): Bucket[] | null {
  const b = node.buckets;
  if (Array.isArray(b)) return b as Bucket[];
  if (b && typeof b === 'object') {
    return Object.entries(b as Record<string, Bucket>).map(([key, v]) => ({ key, ...v }));
  }
  return null;
}

function bucketLabel(b: Bucket): string {
  if (typeof b.key_as_string === 'string') return b.key_as_string;
  if (b.key !== undefined) return fmtVal(b.key);
  return `${fmtVal(b.from_as_string ?? b.from)} → ${fmtVal(b.to_as_string ?? b.to)}`; // range không keyed
}

/** Metric con hiện được thành CỘT: object có `value` (avg/sum/cardinality…). */
function metricColumns(buckets: Bucket[]): string[] {
  const cols: string[] = [];
  for (const b of buckets) {
    for (const [k, v] of Object.entries(b)) {
      if (META_KEYS.has(k) || cols.includes(k)) continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in (v as AggNode)) cols.push(k);
    }
  }
  return cols;
}

function metricCell(b: Bucket, col: string): string {
  const v = b[col] as { value?: unknown; value_as_string?: string } | undefined;
  if (!v || typeof v !== 'object') return '—';
  return v.value_as_string ?? fmtVal(v.value);
}

/** Phần bucket KHÔNG lên được bảng (agg con lồng sâu) — cho mở xem JSON theo hàng. */
function bucketRest(b: Bucket, cols: string[]): AggNode | null {
  const rest: AggNode = {};
  for (const [k, v] of Object.entries(b)) {
    if (META_KEYS.has(k) || cols.includes(k)) continue;
    rest[k] = v;
  }
  return Object.keys(rest).length ? rest : null;
}

export interface AggsResultProps {
  /** JSON của `aggregations` (compact, từ server). */
  json: string;
  truncated: boolean;
}

export default function AggsResult({ json, truncated }: AggsResultProps) {
  const parsed = useMemo<Record<string, AggNode> | null>(() => {
    try {
      const v: unknown = JSON.parse(json);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, AggNode>) : null;
    } catch {
      return null; // JSON bị server cắt bớt — hiện thô còn hơn không
    }
  }, [json]);

  if (!parsed) return <pre className="code es-doc-body">{json}</pre>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {truncated && <span className="badge" style={{ color: 'var(--err)' }}>kết quả aggs quá dài — đã bị cắt bớt</span>}
      {Object.entries(parsed).map(([name, node]) => (
        <AggCard key={name} name={name} node={node} />
      ))}
    </div>
  );
}

function AggCard({ name, node }: { name: string; node: AggNode }) {
  const [open, setOpen] = useState(true);
  const [raw, setRaw] = useState(false);
  const buckets = toBuckets(node);

  const summary = buckets
    ? `${fmtCount(buckets.length)} nhóm`
    : 'value' in node
      ? String((node as { value_as_string?: string }).value_as_string ?? fmtVal(node.value))
      : null;

  return (
    <div className="es-doc">
      <div className="es-doc-head" onClick={() => setOpen((v) => !v)}>
        <span className="es-tree-caret">{open ? '▾' : '▸'}</span>
        <strong style={{ fontSize: 12.5 }}>Σ {name}</strong>
        {summary && <span className="badge">{summary}</span>}
        <span style={{ flex: 1 }} />
        <button
          className="chip-btn"
          title="Xem JSON thô của agg này"
          style={raw ? { color: 'var(--accent)' } : undefined}
          onClick={(e) => { e.stopPropagation(); setRaw((v) => !v); setOpen(true); }}
        >{'{ }'}</button>
        <button
          className="chip-btn"
          title="Copy JSON"
          onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(JSON.stringify(node, null, 2)); }}
        >⧉</button>
      </div>
      {open && (raw
        ? <pre className="code es-doc-body">{JSON.stringify(node, null, 2)}</pre>
        : <AggBody node={node} buckets={buckets} />)}
    </div>
  );
}

function AggBody({ node, buckets }: { node: AggNode; buckets: Bucket[] | null }) {
  if (buckets) return <BucketTable node={node} buckets={buckets} />;

  // Metric một giá trị: avg / sum / min / max / cardinality / value_count…
  if ('value' in node) {
    return (
      <div style={{ padding: '10px 12px', fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>
        {(node as { value_as_string?: string }).value_as_string ?? fmtVal(node.value)}
      </div>
    );
  }

  // percentiles: { values: { "50.0": … } } → bảng phân vị.
  if (node.values && typeof node.values === 'object' && !Array.isArray(node.values)) {
    return <KvTable entries={Object.entries(node.values as Record<string, unknown>)} />;
  }

  // stats (toàn scalar) hoặc agg bọc (filter/nested/global: doc_count + agg con).
  const scalars = Object.entries(node).filter(([, v]) => typeof v !== 'object' || v === null);
  const subs = Object.entries(node).filter(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v));
  if (!scalars.length && !subs.length) {
    return <pre className="code es-doc-body">{JSON.stringify(node, null, 2)}</pre>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: subs.length ? '8px 10px' : 0 }}>
      {scalars.length > 0 && <KvTable entries={scalars} />}
      {subs.map(([k, v]) => <AggCard key={k} name={k} node={v as AggNode} />)}
    </div>
  );
}

function KvTable({ entries }: { entries: [string, unknown][] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="es-table">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtVal(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BucketTable({ node, buckets }: { node: AggNode; buckets: Bucket[] }) {
  const [openRow, setOpenRow] = useState<number | null>(null);
  const cols = metricColumns(buckets);
  const hasDocCount = buckets.some((b) => typeof b.doc_count === 'number');
  const rows = buckets.slice(0, MAX_ROWS);
  const colSpan = 1 + (hasDocCount ? 1 : 0) + cols.length;
  // terms: số document rơi ngoài top N nhóm đã trả về.
  const other = typeof node.sum_other_doc_count === 'number' ? node.sum_other_doc_count : 0;

  return (
    <div style={{ overflow: 'auto', maxHeight: 420 }}>
      <table className="es-table">
        <thead>
          <tr>
            <th>key</th>
            {hasDocCount && <th>doc_count</th>}
            {cols.map((c) => <th key={c}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((b, i) => {
            const rest = bucketRest(b, cols);
            return (
              <Fragment key={i}>
                <tr
                  onClick={rest ? () => setOpenRow(openRow === i ? null : i) : undefined}
                  style={rest ? { cursor: 'pointer' } : undefined}
                  title={rest ? 'Bucket này còn agg con lồng bên trong — bấm để xem' : undefined}
                >
                  <td>{rest ? (openRow === i ? '▾ ' : '▸ ') : ''}{bucketLabel(b)}</td>
                  {hasDocCount && <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtVal(b.doc_count)}</td>}
                  {cols.map((c) => <td key={c} style={{ fontVariantNumeric: 'tabular-nums' }}>{metricCell(b, c)}</td>)}
                </tr>
                {rest && openRow === i && (
                  <tr>
                    <td colSpan={colSpan} style={{ textAlign: 'left' }}>
                      <pre className="code es-doc-body" style={{ maxHeight: 260 }}>{JSON.stringify(rest, null, 2)}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {buckets.length > MAX_ROWS && (
        <p className="es-hint" style={{ padding: '6px 8px' }}>… còn {fmtCount(buckets.length - MAX_ROWS)} nhóm nữa — bấm {'{ }'} để xem JSON đầy đủ.</p>
      )}
      {other > 0 && (
        <p className="es-hint" style={{ padding: '6px 8px' }}>+ {fmtCount(other)} document thuộc các nhóm ngoài top này (sum_other_doc_count).</p>
      )}
    </div>
  );
}
