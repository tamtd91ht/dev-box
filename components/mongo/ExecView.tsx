'use client';

// "⚡ Thực thi lệnh ghi" — insert / update / replace / delete khi connection đã
// mở khoá ghi. Mục Dữ liệu chỉ có modal ✎ Update (updateOne/Many, toán tử $),
// không chèn hay xoá được.
//
// Quy trình bắt buộc, cùng tinh thần màn Thực thi SQL của PostgreSQL:
//   1. ≈ Chạy thử — KHÔNG ghi gì: đếm số document khớp filter + hiện vài
//      document sẽ bị đụng tới (insert: chính các document sắp chèn). Mongo
//      không có transaction dùng được ở mọi cụm nên không "chạy thật rồi
//      rollback" như PG.
//   2. gõ lại db.collection để xác nhận,
//   3. ⚠ Commit — chỉ bật khi lần chạy thử thành công là ĐÚNG lệnh đang trên
//      màn hình (sửa một ký tự là phải chạy thử lại).
// Server độc lập chặn theo MONGO_ALLOW_WRITE + readOnly + luật filter.

import { useCallback, useEffect, useState } from 'react';
import {
  listMongoDatabases,
  listMongoCollections,
  writeOpMongo,
  formatJsonInput,
  fmtCount,
  type DatabaseInfo,
  type CollectionInfo,
  type WriteOpKind,
  type WriteOpResult,
} from '@/lib/mongo';
import { readLocal, writeLocal } from '@/lib/localKeys';
import ColSplit from '../ColSplit';
import JsonView from './JsonView';

export interface ExecViewProps {
  connectionId: string;
  readOnly: boolean;
  allowWrite: boolean;
}

const OPS: { value: WriteOpKind; label: string; body: string | null; placeholder: string }[] = [
  { value: 'insertOne', label: 'insertOne', body: 'Document', placeholder: '{"name": "abc", "status": "ACTIVE"}' },
  { value: 'insertMany', label: 'insertMany', body: 'Mảng document (≤ 1000)', placeholder: '[{"name": "a"}, {"name": "b"}]' },
  { value: 'updateOne', label: 'updateOne', body: 'Update (toán tử $ hoặc pipeline […])', placeholder: '{"$set": {"status": "INACTIVE"}}' },
  { value: 'updateMany', label: 'updateMany', body: 'Update (toán tử $ hoặc pipeline […])', placeholder: '{"$set": {"status": "INACTIVE"}}' },
  { value: 'replaceOne', label: 'replaceOne', body: 'Document thay thế (không có _id thì giữ _id cũ)', placeholder: '{"name": "abc", "status": "ACTIVE"}' },
  { value: 'deleteOne', label: 'deleteOne', body: null, placeholder: '' },
  { value: 'deleteMany', label: 'deleteMany', body: null, placeholder: '' },
];

interface Draft { db: string; coll: string; op: WriteOpKind; filter: string; body: string; upsert: boolean }
const BLANK: Draft = { db: '', coll: '', op: 'updateOne', filter: '', body: '', upsert: false };

function isDraft(v: unknown): v is Draft {
  if (!v || typeof v !== 'object') return false;
  const x = v as Record<string, unknown>;
  return typeof x.db === 'string' && typeof x.coll === 'string' && typeof x.filter === 'string'
    && typeof x.body === 'string' && typeof x.upsert === 'boolean' && OPS.some((o) => o.value === x.op);
}

interface Ran { sig: string; result: WriteOpResult }

export default function ExecView({ connectionId, readOnly, allowWrite }: ExecViewProps) {
  const draftKey = `mongo.exec.${connectionId}`;
  const [d, setD] = useState<Draft>(BLANK);
  // Nạp bản đang soạn dở sau mount (đọc trong initializer làm lệch hydrate).
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const v: unknown = JSON.parse(readLocal(draftKey) ?? 'null');
      if (isDraft(v)) setD(v);
    } catch { /* bản lưu hỏng — bắt đầu trống */ }
    setLoaded(true);
  }, [draftKey]);
  useEffect(() => { if (loaded) writeLocal(draftKey, JSON.stringify(d)); }, [loaded, draftKey, d]);
  const patch = (p: Partial<Draft>) => setD((cur) => ({ ...cur, ...p }));

  const [dbs, setDbs] = useState<DatabaseInfo[]>([]);
  const [colls, setColls] = useState<CollectionInfo[]>([]);
  useEffect(() => {
    listMongoDatabases(connectionId).then(setDbs).catch(() => setDbs([]));
  }, [connectionId]);
  useEffect(() => {
    if (!d.db) { setColls([]); return; }
    listMongoCollections(connectionId, d.db).then(setColls).catch(() => setColls([]));
  }, [connectionId, d.db]);

  const [dry, setDry] = useState<Ran | null>(null);
  const [done, setDone] = useState<Ran | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spec = OPS.find((o) => o.value === d.op) ?? OPS[0];
  const isInsert = d.op.startsWith('insert');
  const canUpsert = d.op === 'updateOne' || d.op === 'updateMany' || d.op === 'replaceOne';
  const ns = `${d.db}.${d.coll}`;
  // Chữ ký của lệnh đang trên màn hình — Commit chỉ bật khi khớp lần chạy thử.
  const sig = JSON.stringify([d.db, d.coll, d.op, isInsert ? '' : d.filter, spec.body ? d.body : '', canUpsert && d.upsert]);
  const armed = allowWrite && !readOnly;
  const ready = !!d.db && !!d.coll.trim() && (isInsert || !!d.filter.trim()) && (!spec.body || !!d.body.trim());
  const dryFresh = !!dry && dry.sig === sig;
  const canCommit = armed && !busy && dryFresh && typed === ns;
  const shown = done && done.sig === sig ? done : dry;

  const run = useCallback(async (commit: boolean) => {
    setBusy(true); setError(null);
    try {
      const result = await writeOpMongo(connectionId, d.db, d.coll.trim(), {
        op: d.op, filter: d.filter, body: d.body, upsert: canUpsert && d.upsert,
      }, commit);
      if (commit) { setDone({ sig, result }); setDry(null); setTyped(''); }
      else { setDry({ sig, result }); setDone(null); }
    } catch (e) {
      setError((e as Error).message);
      if (!commit) setDry(null);
    } finally { setBusy(false); }
  }, [connectionId, d, canUpsert, sig]);

  const fmt = (field: 'filter' | 'body') => {
    const r = formatJsonInput(d[field]);
    if (r.error) setError(r.error); else { setError(null); patch({ [field]: r.text }); }
  };

  if (!armed) {
    return (
      <div className="panel" style={{ margin: 'auto', maxWidth: 560, textAlign: 'center' }}>
        <div className="empty-ico" aria-hidden>🔒</div>
        <h3>Chưa mở khoá ghi</h3>
        <p className="empty">
          {!allowWrite
            ? <>Đặt <code>MONGO_ALLOW_WRITE=true</code> trong <code>.env.local</code> rồi khởi động lại dev server.</>
            : <>Connection này đang read-only — sửa connection và bỏ chọn “Read-only”.</>}
        </p>
      </div>
    );
  }

  return (
    <ColSplit storageKey="devbox-mongo-exec-split">
      <div className="mongo-querybar">
        <div className="mongo-danger" style={{ marginBottom: 0 }}>
          ⚠ Ghi thẳng lên cluster. <b>≈ Chạy thử</b> không ghi gì — chỉ đếm document khớp filter và hiện vài
          document sẽ bị đụng tới; <b>Commit</b> chỉ bật sau khi chạy thử đúng lệnh này. Filter bắt buộc
          không rỗng (muốn cả collection thì ghi rõ <code>{'{"_id": {"$exists": true}}'}</code>).
        </div>
        <div className="status-line" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="mongo-field" style={{ flex: '1 1 140px' }}>
            <span>Database</span>
            <select className="input" value={d.db} onChange={(e) => patch({ db: e.target.value })}>
              <option value="">— chọn —</option>
              {!dbs.some((x) => x.name === d.db) && d.db && <option value={d.db}>{d.db}</option>}
              {dbs.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
            </select>
          </label>
          <label className="mongo-field" style={{ flex: '1 1 160px' }}>
            <span>Collection</span>
            <input className="input mono" list="mongo-exec-colls" value={d.coll}
              onChange={(e) => patch({ coll: e.target.value })} placeholder="tên collection" />
            <datalist id="mongo-exec-colls">{colls.map((c) => <option key={c.name} value={c.name} />)}</datalist>
          </label>
          <label className="mongo-field" style={{ flex: '0 0 130px' }}>
            <span>Lệnh</span>
            <select className="input" value={d.op} onChange={(e) => patch({ op: e.target.value as WriteOpKind })}>
              {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>

        {!isInsert && (
          <label className="mongo-field">
            <span className="mongo-field-head">
              Filter (bắt buộc, không được {'{}'})
              <span className="mongo-field-tools"><button type="button" className="chip-btn" onClick={() => fmt('filter')}>{'{ }'} Format</button></span>
            </span>
            <textarea className="input mono" rows={4} value={d.filter}
              onChange={(e) => patch({ filter: e.target.value })}
              placeholder='{"_id": {"$oid": "665f1c…"}}' />
          </label>
        )}
        {spec.body && (
          <label className="mongo-field grow">
            <span className="mongo-field-head">
              {spec.body}
              <span className="mongo-field-tools"><button type="button" className="chip-btn" onClick={() => fmt('body')}>{'{ }'} Format</button></span>
            </span>
            <textarea className="input mono" rows={8} value={d.body}
              onChange={(e) => patch({ body: e.target.value })}
              placeholder={spec.placeholder} />
          </label>
        )}
        {canUpsert && (
          <label className="mongo-check">
            <input type="checkbox" checked={d.upsert} onChange={(e) => patch({ upsert: e.target.checked })} />
            upsert — không khớp document nào thì chèn mới
          </label>
        )}

        <div className="status-line cs-split-pin" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="sm" disabled={busy || !ready} onClick={() => void run(false)}>
            {busy ? <span className="spinner" aria-hidden /> : '≈'} Chạy thử
          </button>
          <input
            className="input mono"
            style={{ flex: '1 1 140px', fontSize: 12 }}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && canCommit && void run(true)}
            placeholder={dryFresh ? `gõ lại "${ns}" để commit` : 'chạy thử trước'}
            disabled={!dryFresh}
          />
          <button
            className="sm"
            disabled={!canCommit}
            onClick={() => void run(true)}
            style={{ color: 'var(--err)', borderColor: 'var(--err)' }}
            title={canCommit ? `Thực thi ${d.op}` : 'Cần chạy thử thành công đúng lệnh này + gõ đúng db.collection'}
          >⚠ Commit</button>
        </div>
      </div>

      <div className="mongo-resultpane">
        {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
        {!shown && !error && <p className="xhint">Kết quả chạy thử / commit sẽ hiện ở đây.</p>}
        {shown && <ResultSummary r={shown.result} upsert={canUpsert && d.upsert} />}
        {shown && shown.result.preview.length > 0 && (
          <div className="mongo-results">
            {shown.result.preview.map((doc, i) => (
              <div key={i} className="mongo-doc" style={{ padding: 6 }}>
                {doc.truncated && <span className="badge" style={{ color: 'var(--err)' }}>truncated</span>}
                <JsonView json={doc.json} />
              </div>
            ))}
          </div>
        )}
      </div>
    </ColSplit>
  );
}

function ResultSummary({ r, upsert }: { r: WriteOpResult; upsert: boolean }) {
  const parts: string[] = [];
  if (r.committed) {
    if (r.inserted !== undefined) parts.push(`đã chèn ${fmtCount(r.inserted)}`);
    if (r.modified !== undefined) parts.push(`khớp ${fmtCount(r.matched)} · đã sửa ${fmtCount(r.modified)}`);
    if (r.upsertedId) parts.push(`upsert _id ${r.upsertedId}`);
    if (r.deleted !== undefined) parts.push(`đã xoá ${fmtCount(r.deleted)}`);
  } else if (r.op.startsWith('insert')) {
    parts.push(`sẽ chèn ${fmtCount(r.matched)} document`);
  } else {
    const one = r.op.endsWith('One');
    parts.push(`filter khớp ${fmtCount(r.matched)} document`);
    if (r.matched === 0) parts.push(upsert ? 'sẽ CHÈN MỚI 1 document (upsert)' : 'sẽ không đụng tới gì');
    else if (one) parts.push(`${r.op} chỉ đụng 1 — document đầu tiên khớp (mẫu bên dưới)`);
    else parts.push(r.op === 'deleteMany' ? `sẽ XOÁ ${fmtCount(r.matched)}` : `sẽ đụng tới ${fmtCount(r.matched)}`);
  }
  return (
    <div className="status-line" style={{ gap: 6, flexWrap: 'wrap' }}>
      {r.committed
        ? <span className="badge" style={{ color: 'var(--ok)' }}>✓ Đã ghi</span>
        : <span className="badge">≈ Chạy thử — chưa ghi gì</span>}
      <span className="badge mono">{r.op}</span>
      {parts.map((p, i) => <span key={i} className="badge">{p}</span>)}
      <span className="badge">{r.tookMs}ms</span>
    </div>
  );
}
