'use client';

// Tab Indexes → "＋ Tạo index (chạy nền)".
//
// Dãy chip CẤU TRÚC dựng sẵn (đơn, ghép, unique, TTL, partial, text, hashed,
// 2dsphere, wildcard…) điền khung khoá + options; người dùng sửa tên field rồi
// bấm Tạo. Server bắn createIndexes với `background: true` (mặc định bật) và trả
// về ngay — build chạy nền, panel hỏi lại tiến độ mỗi 2 giây ($currentOp:
// done/total) cho tới khi xong, rồi nạp lại bảng index. Xem createIndexBackground
// ở lib/mongoClient.
//
// Ghi qua cùng hai cổng env MONGO_ALLOW_WRITE + connection không read-only, có
// hộp xác nhận. Danh sách build đang chạy thì ai cũng xem được (chỉ đọc).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createMongoIndex,
  mongoIndexBuilds,
  fmtCount,
  type IndexBuildsResult,
} from '@/lib/mongo';

interface IndexShape {
  label: string;
  title: string;
  keys: string;
  options: string;
}

/** Các cấu trúc index hay dùng — bấm là điền khung, sửa tên field cho đúng. */
const SHAPES: IndexShape[] = [
  { label: 'Đơn', title: 'Index một field (1 tăng, -1 giảm)', keys: '{"field": 1}', options: '{}' },
  {
    label: 'Ghép', title: 'Index ghép — quy tắc ESR: Equality → Sort → Range',
    keys: '{"tenantId": 1, "createdAt": -1}', options: '{}',
  },
  { label: 'Unique', title: 'Không cho trùng giá trị (build lỗi nếu dữ liệu đang trùng)', keys: '{"email": 1}', options: '{"unique": true}' },
  {
    label: 'Unique + partial', title: 'Unique chỉ trên document thoả điều kiện (bỏ qua document thiếu field)',
    keys: '{"code": 1}', options: '{"unique": true, "partialFilterExpression": {"code": {"$exists": true}}}',
  },
  { label: 'TTL', title: 'Tự xoá document sau N giây kể từ field ngày (một field, kiểu Date)', keys: '{"createdAt": 1}', options: '{"expireAfterSeconds": 2592000}' },
  {
    label: 'Partial', title: 'Chỉ index document thoả điều kiện — nhỏ hơn, nhẹ hơn',
    keys: '{"status": 1, "updatedAt": -1}', options: '{"partialFilterExpression": {"status": {"$in": ["pending", "processing"]}}}',
  },
  { label: 'Sparse', title: 'Bỏ qua document không có field', keys: '{"phone": 1}', options: '{"sparse": true}' },
  {
    label: 'Text', title: 'Tìm kiếm full-text ($text) — mỗi collection chỉ một text index',
    keys: '{"title": "text", "content": "text"}', options: '{"weights": {"title": 10, "content": 1}, "default_language": "none"}',
  },
  { label: 'Hashed', title: 'Hashed — dùng cho shard key / so khớp bằng', keys: '{"userId": "hashed"}', options: '{}' },
  { label: '2dsphere', title: 'Truy vấn địa lý ($near, $geoWithin) trên GeoJSON', keys: '{"location": "2dsphere"}', options: '{}' },
  { label: 'Wildcard', title: 'Wildcard — index mọi field con của một object (MongoDB 4.2+)', keys: '{"attrs.$**": 1}', options: '{}' },
  { label: 'Hidden', title: 'Tạo ở trạng thái ẩn — planner không dùng, để thử trước khi bật (4.4+)', keys: '{"field": 1}', options: '{"hidden": true}' },
];

export interface IndexBuildPanelProps {
  connectionId: string;
  db: string;
  coll: string;
  writeArmed: boolean;
  /** Lý do khoá ghi để hiện tooltip khi !writeArmed. */
  lockReason: string;
  /** Có build vừa xong → nạp lại bảng index + báo. */
  onBuilt: (msg: string) => void;
}

function validJson(s: string, label: string): string | null {
  if (!s.trim()) return null;
  try {
    const v = JSON.parse(s) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `${label} phải là object {…}`;
    return null;
  } catch (e) {
    return `${label}: JSON không hợp lệ — ${(e as Error).message}`;
  }
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export default function IndexBuildPanel({ connectionId, db, coll, writeArmed, lockReason, onBuilt }: IndexBuildPanelProps) {
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState('{"field": 1}');
  const [options, setOptions] = useState('{}');
  const [name, setName] = useState('');
  const [background, setBackground] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [builds, setBuilds] = useState<IndexBuildsResult | null>(null);
  /** Job đã thấy ở trạng thái running — để báo đúng một lần khi nó xong. */
  const seenRunning = useRef<Set<string>>(new Set());
  const onBuiltRef = useRef(onBuilt);
  onBuiltRef.current = onBuilt;

  const refresh = useCallback(async () => {
    try {
      const r = await mongoIndexBuilds(connectionId, db, coll);
      setBuilds(r);
      const finished = r.jobs.filter((j) => j.status !== 'running' && seenRunning.current.has(j.id));
      for (const j of r.jobs) if (j.status === 'running') seenRunning.current.add(j.id);
      for (const j of finished) {
        seenRunning.current.delete(j.id);
        onBuiltRef.current(j.status === 'done'
          ? `Index ${j.name} build xong · ${fmtDur((j.endedAt ?? Date.now()) - j.startedAt)}`
          : `Build index ${j.keyJson} lỗi: ${j.error ?? ''}`);
      }
    } catch {
      /* tiến độ chỉ là phụ — lỗi mạng thì lần sau hỏi lại */
    }
  }, [connectionId, db, coll]);

  // Đổi collection → bỏ trạng thái cũ, đọc lại một lần.
  useEffect(() => {
    seenRunning.current = new Set();
    setBuilds(null);
    void refresh();
  }, [refresh]);

  const active = !!builds && (builds.jobs.some((j) => j.status === 'running') || builds.ops.length > 0);
  // Chỉ hỏi lại khi có build đang chạy — xong là dừng.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(t);
  }, [active, refresh]);

  const applyShape = (s: IndexShape) => {
    setKeys(s.keys);
    setOptions(s.options);
    setErr(null);
  };

  const submit = async () => {
    if (submitting || !writeArmed) return;
    const bad = validJson(keys, 'Khoá') ?? validJson(options, 'Options');
    if (bad) { setErr(bad); return; }
    if (!keys.trim()) { setErr('Khoá index trống'); return; }
    const opts = (options.trim() ? JSON.parse(options) : {}) as Record<string, unknown>;
    if (name.trim()) opts.name = name.trim();
    opts.background = background;
    const optsJson = JSON.stringify(opts);
    if (!window.confirm(
      `Tạo index trên ${db}.${coll}?\n\nKhoá: ${keys.trim()}\nOptions: ${optsJson}\n\n` +
      'Build chạy nền trên server — collection lớn có thể mất nhiều phút và tốn CPU/IO.',
    )) return;
    setSubmitting(true);
    setErr(null);
    try {
      const job = await createMongoIndex(connectionId, db, coll, keys, optsJson);
      seenRunning.current.add(job.id);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const jobs = builds?.jobs ?? [];
  const ops = builds?.ops ?? [];

  return (
    <div className="mongo-ixbuild">
      <div className="status-line" style={{ gap: 8 }}>
        <button
          className="sm"
          disabled={!writeArmed}
          title={writeArmed ? 'Tạo index mới, build chạy nền trên server' : lockReason}
          onClick={() => setOpen((v) => !v)}
        >{open ? '▾' : '＋'} Tạo index (chạy nền){!writeArmed && ' 🔒'}</button>
        {active && <span className="xhint"><span className="spinner" aria-hidden /> Đang build index…</span>}
        <button className="chip-btn" title="Đọc lại tiến độ build" onClick={() => void refresh()}>⟳</button>
      </div>

      {open && writeArmed && (
        <div className="mongo-ixbuild-form">
          <div className="mongo-snips">
            {SHAPES.map((s) => (
              <button
                key={s.label}
                type="button"
                className="chip-btn mongo-snip"
                title={`${s.title}\n\nKhoá: ${s.keys}\nOptions: ${s.options}`}
                onClick={() => applyShape(s)}
              >{s.label}</button>
            ))}
          </div>
          <label className="xhint">Khoá — 1 / -1 / &quot;text&quot; / &quot;hashed&quot; / &quot;2dsphere&quot; / &quot;2d&quot;</label>
          <textarea
            className="input mono mongo-json-input"
            spellCheck={false}
            rows={Math.min(8, Math.max(2, keys.split('\n').length))}
            value={keys}
            disabled={submitting}
            onChange={(e) => { setKeys(e.target.value); setErr(null); }}
          />
          <label className="xhint">Options — unique, sparse, expireAfterSeconds, partialFilterExpression, hidden, collation, weights…</label>
          <textarea
            className="input mono mongo-json-input"
            spellCheck={false}
            rows={Math.min(8, Math.max(2, options.split('\n').length))}
            value={options}
            disabled={submitting}
            onChange={(e) => { setOptions(e.target.value); setErr(null); }}
          />
          <div className="status-line" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input
              className="input"
              style={{ width: 220 }}
              placeholder="Tên index (bỏ trống = tự đặt)"
              value={name}
              disabled={submitting}
              onChange={(e) => setName(e.target.value)}
            />
            <label className="xhint" title="Server < 4.2: build không khoá cả database. Từ 4.2 server tự build kiểu tối ưu, cờ này bị bỏ qua.">
              <input type="checkbox" checked={background} onChange={(e) => setBackground(e.target.checked)} /> background
            </label>
            <button className="sm" disabled={submitting} onClick={() => void submit()}>
              {submitting ? <span className="spinner" aria-hidden /> : '⚙'} Tạo
            </button>
            <button className="ghost sm" disabled={submitting} onClick={() => setOpen(false)}>Đóng</button>
          </div>
          {err && <span className="mongo-json-err">{err}</span>}
        </div>
      )}

      {(ops.length > 0 || jobs.length > 0) && (
        <table className="mongo-table mongo-ixbuild-list">
          <thead>
            <tr><th style={{ textAlign: 'left' }}>Build</th><th style={{ textAlign: 'left' }}>Trạng thái</th><th>Thời gian</th></tr>
          </thead>
          <tbody>
            {ops.map((o) => {
              const pct = o.total ? Math.min(100, Math.round((o.done ?? 0) * 100 / o.total)) : null;
              return (
                <tr key={`op-${o.opid}`}>
                  <td style={{ textAlign: 'left' }}><code className="small">{o.names.join(', ') || `opid ${o.opid}`}</code></td>
                  <td style={{ textAlign: 'left' }}>
                    <span className="spinner" aria-hidden /> {o.msg || 'đang build'}
                    {pct !== null && ` · ${pct}% (${fmtCount(o.done ?? 0)}/${fmtCount(o.total ?? 0)})`}
                  </td>
                  <td>{fmtDur(o.secs * 1000)}</td>
                </tr>
              );
            })}
            {jobs.map((j) => (
              <tr key={j.id}>
                <td style={{ textAlign: 'left' }}>
                  <code className="small">{j.name || '(tự đặt)'} {j.keyJson}</code>
                </td>
                <td style={{ textAlign: 'left', color: j.status === 'error' ? 'var(--err)' : undefined }}>
                  {j.status === 'running' ? '⏳ đang chạy' : j.status === 'done' ? '✓ xong' : `✗ ${j.error ?? 'lỗi'}`}
                </td>
                <td>{fmtDur((j.endedAt ?? Date.now()) - j.startedAt)}</td>
              </tr>
            ))}
            {builds?.notes.map((n) => (
              <tr key={n}><td colSpan={3} className="empty">{n}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
