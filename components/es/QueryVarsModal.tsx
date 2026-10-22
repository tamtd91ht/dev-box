'use client';

// Khai báo BIẾN TRUY VẤN cho tab Dữ liệu (xem lib/esQueryVars.ts cho cách chạy và thay).
// Mỗi biến: tên + nguồn (kết nối ES · Mongo · PG) + query + field mặc định. Dùng trong body _search bằng
// `{{tên}}` / `{{tên.field}}`; query của biến này cũng được dùng biến khác.
//
// Sửa trên bản nháp — chỉ ghi khi bấm Lưu. "▶ Thử" chạy trên bản nháp nên thử được trước khi lưu.

import { useState } from 'react';
import {
  newQueryVar, queryVarProblem, resolveVars, DEFAULT_MAX, HARD_MAX,
  type QueryVar, type QueryVarKind, type Prim,
} from '@/lib/esQueryVars';
import { useAsync, useJoinConnections } from '../export/JoinEditor';
import SuggestInput, { type SuggestOption } from '../SuggestInput';
import { listMongoDatabases, listMongoCollections, sampleMongoFields } from '@/lib/mongo';
import { listEsIndices, esMapping } from '@/lib/es';
import { listPgDatabases } from '@/lib/pg';
import { flattenEsMapping } from '@/lib/esDsl';

const KIND_LABEL: Record<QueryVarKind, string> = { es: 'Elasticsearch', mongo: 'MongoDB', pg: 'PostgreSQL' };

const QUERY_PLACEHOLDER: Record<QueryVarKind, string> = {
  es: '{ "query": { "term": { "status": "active" } } }   — trống = match_all',
  mongo: '{ "status": "active" }   — hoặc pipeline [ { "$match": … }, { "$group": … } ]',
  pg: "SELECT tenant_id FROM tenants WHERE status = 'active'",
};

const PREVIEW_MAX = 20;

type TestState = { busy: true } | { values: Prim[]; note: string } | { error: string };

function VarRow({ v, all, patch, remove }: {
  v: QueryVar;
  all: QueryVar[];
  patch: (p: Partial<QueryVar>) => void;
  remove: () => void;
}) {
  const options = useJoinConnections();
  const id = v.connectionId;
  const isMongo = v.kind === 'mongo' && !!id;
  const isEs = v.kind === 'es' && !!id;
  const isPg = v.kind === 'pg' && !!id;
  const [test, setTest] = useState<TestState | null>(null);

  const dbs = useAsync(async () => (await listMongoDatabases(id)).map((d) => d.name), [id], isMongo, [] as string[]);
  const colls = useAsync(async () => (await listMongoCollections(id, v.db)).map((c) => c.name), [id, v.db], isMongo && !!v.db.trim(), [] as string[]);
  const mongoFields = useAsync(async () => sampleMongoFields(id, v.db, v.object), [id, v.db, v.object],
    isMongo && colls.includes(v.object), [] as { path: string; type: string }[]);
  const esItems = useAsync(async () => (await listEsIndices(id)).map((i) => ({ value: i.name, hint: i.health })), [id], isEs, [] as SuggestOption[]);
  const esFields = useAsync(async () => flattenEsMapping((await esMapping(id, v.object)).json), [id, v.object],
    isEs && esItems.some((i) => i.value === v.object), [] as { path: string; type: string }[]);
  const pgDbs = useAsync(async () => (await listPgDatabases(id)).map((d) => d.name), [id], isPg, [] as string[]);

  const fieldOptions: SuggestOption[] = (isMongo ? mongoFields : isEs ? esFields : []).map((f) => ({ value: f.path, hint: f.type }));
  const problem = queryVarProblem(v, all);
  const placeholder = `{{${v.name}${v.field.trim() ? '' : '.field'}}}`;

  const runTest = async () => {
    setTest({ busy: true });
    try {
      // Placeholder trần → mảng JSON các giá trị.
      const r = await resolveVars(`{{${v.name}}}`, all);
      const values = JSON.parse(r.text) as Prim[];
      const s = r.stats.find((x) => x.name === v.name);
      setTest({ values, note: s ? `quét ${s.scanned.toLocaleString('en-US')} dòng · ${s.tookMs}ms` : '' });
    } catch (e) {
      setTest({ error: (e as Error).message });
    }
  };

  return (
    <div className="export-join">
      <div className="xrow">
        <div className="mongo-field" style={{ flex: '0 0 110px' }}>
          <span>Tên biến</span>
          <input className="input mono" value={v.name} onChange={(e) => patch({ name: e.target.value.trim() })} />
        </div>
        <div className="mongo-field" style={{ flex: '1 1 200px' }}>
          <span>Kết nối nguồn</span>
          <select className="input" value={v.connectionId}
            onChange={(e) => {
              const c = options.find((x) => x.id === e.target.value);
              patch({ connectionId: e.target.value, kind: c?.kind ?? v.kind, db: '', object: '' });
            }}>
            <option value="">— chọn kết nối —</option>
            {options.map((c) => <option key={`${c.kind}-${c.id}`} value={c.id}>{c.name} · {KIND_LABEL[c.kind]}</option>)}
          </select>
        </div>
        {(v.kind === 'mongo' || v.kind === 'pg') && (
          <div className="mongo-field" style={{ flex: '1 1 140px' }}>
            <span>Database</span>
            <SuggestInput className="input mono" value={v.db} options={v.kind === 'pg' ? pgDbs : dbs} showWhenEmpty disabled={!id}
              onChange={(x) => patch({ db: x, object: x === v.db ? v.object : '' })} />
          </div>
        )}
        {v.kind !== 'pg' && (
          <div className="mongo-field" style={{ flex: '1 1 180px' }}>
            <span>{v.kind === 'es' ? 'Index / alias' : 'Collection'}</span>
            <SuggestInput className="input mono" value={v.object} showWhenEmpty disabled={!id}
              options={v.kind === 'es' ? esItems : colls} onChange={(x) => patch({ object: x })} />
          </div>
        )}
        <button className="chip-btn" title="Xoá biến" onClick={remove} style={{ alignSelf: 'flex-end', height: 32 }}>✕</button>
      </div>
      <div className="mongo-field">
        <span>
          {v.kind === 'es' ? 'Body _search' : v.kind === 'mongo' ? 'Filter (hoặc pipeline aggregate)' : 'SQL (chỉ đọc)'}
          {' '}— được dùng biến khác, vd. <code>{'{{q0.id}}'}</code>
        </span>
        <textarea className="input mono" rows={4} value={v.query} spellCheck={false}
          placeholder={QUERY_PLACEHOLDER[v.kind]} onChange={(e) => patch({ query: e.target.value })} />
      </div>
      <div className="xrow">
        <div className="mongo-field" style={{ flex: '1 1 200px' }}>
          <span>Field mặc định (dùng khi viết <code>{`{{${v.name}}}`}</code>)</span>
          <SuggestInput className="input mono" value={v.field} options={fieldOptions} showWhenEmpty
            placeholder={v.kind === 'pg' ? 'tên cột, vd. tenant_id' : 'vd. tenantId'} onChange={(x) => patch({ field: x })} />
        </div>
        <div className="mongo-field" style={{ flex: '0 0 150px' }}
          title={`Số giá trị khác nhau tối đa của một field. Vượt là báo lỗi, không cắt bớt. Trần ${HARD_MAX.toLocaleString('en-US')} (giới hạn terms của ES).`}>
          <span>Tối đa giá trị</span>
          <input className="input" type="number" min={1} max={HARD_MAX} value={v.max ?? ''} placeholder={DEFAULT_MAX.toLocaleString('en-US')}
            onChange={(e) => patch({ max: Math.min(HARD_MAX, Math.max(0, Math.floor(Number(e.target.value) || 0))) || undefined })} />
        </div>
        <button className="ghost sm" style={{ alignSelf: 'flex-end' }} disabled={!!problem || (test !== null && 'busy' in test)}
          title="Chạy query nguồn (theo bản đang sửa, chưa cần lưu) và xem giá trị lấy được" onClick={() => void runTest()}>
          {test && 'busy' in test ? <span className="spinner" aria-hidden /> : '▶'} Thử
        </button>
        <button className="chip-btn" style={{ alignSelf: 'flex-end' }} title="Copy placeholder để dán vào body"
          onClick={() => void navigator.clipboard?.writeText(placeholder)}>⧉ <code>{placeholder}</code></button>
      </div>
      {problem && <span className="xerr">⚠ {problem}</span>}
      {test && 'error' in test && <span className="xerr">⚠ {test.error}</span>}
      {test && 'values' in test && (
        <span className="xhint">
          <b>{test.values.length.toLocaleString('en-US')}</b> giá trị ({test.note}):{' '}
          {test.values.slice(0, PREVIEW_MAX).map((x, i) => <code key={i} style={{ marginRight: 6 }}>{JSON.stringify(x)}</code>)}
          {test.values.length > PREVIEW_MAX && '…'}
        </span>
      )}
    </div>
  );
}

export default function QueryVarsModal({ vars, onSave, onClose }: {
  vars: QueryVar[];
  onSave: (list: QueryVar[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<QueryVar[]>(() => (vars.length ? vars : [newQueryVar([])]));
  const dirty = JSON.stringify(draft) !== JSON.stringify(vars);
  const close = () => {
    if (dirty && !window.confirm('Bỏ các thay đổi chưa lưu?')) return;
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(860px, 96vw)', maxHeight: '90vh', overflow: 'auto' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>𝑥 Biến truy vấn</h3>
          <button className="ghost sm" onClick={close}>✕</button>
        </div>
        <p className="xhint" style={{ marginTop: 0 }}>
          Lấy giá trị từ một query ở nơi khác (ES · Mongo · PG) rồi dùng trong body _search. Bấm Search là biến chạy trước, thay
          vào body rồi mới gửi đi.<br />
          <code>{'"terms": { "tenantId": {{q1.tenantId}} }'}</code> → mảng mọi giá trị (bỏ trùng) ·{' '}
          <code>{'"term": { "tenantId": "{{q1.tenantId}}" }'}</code> → giá trị đầu tiên · SQL: <code>{'IN ({{q1.id}})'}</code>
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {draft.map((v) => (
            <VarRow
              key={v.id}
              v={v}
              all={draft}
              patch={(p) => setDraft((list) => list.map((x) => (x.id === v.id ? { ...x, ...p } : x)))}
              remove={() => setDraft((list) => list.filter((x) => x.id !== v.id))}
            />
          ))}
        </div>
        <div className="status-line" style={{ marginTop: 12, gap: 8 }}>
          <button className="ghost sm" onClick={() => setDraft((list) => [...list, newQueryVar(list)])}>+ Thêm biến</button>
          <span style={{ marginLeft: 'auto' }} />
          <button className="ghost sm" onClick={close}>Huỷ</button>
          <button className="sm" disabled={!dirty} onClick={() => onSave(draft)}>Lưu</button>
        </div>
      </div>
    </div>
  );
}
