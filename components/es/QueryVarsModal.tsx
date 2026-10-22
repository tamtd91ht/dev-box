'use client';

// Khai báo BIẾN TRUY VẤN cho tab Dữ liệu (xem lib/esQueryVars.ts cho cách chạy và thay).
// Mỗi biến: tên + nguồn (kết nối ES · Mongo · PG) + query + field mặc định. Dùng trong body _search bằng
// `{{tên}}` / `{{tên.field}}`; query của biến này cũng được dùng biến khác.
//
// Sửa trên bản nháp — chỉ ghi khi bấm Lưu. "▶ Thử" chạy trên bản nháp nên thử được trước khi lưu.
// "⤵ Lưu & chèn vào body" lưu rồi đưa biến vào ô body của tab đang xem — người dùng không phải nhớ cú pháp.
// Khung "Cách dùng" tự mở khi chưa có biến nào (hoặc chưa từng gập lại), nhớ trạng thái gập theo máy.

import { useMemo, useRef, useState } from 'react';
import { readLocal, writeLocal } from '@/lib/localKeys';
import {
  newQueryVar, queryVarProblem, resolveVars, DEFAULT_MAX, HARD_MAX,
  type QueryVar, type QueryVarKind, type Prim,
} from '@/lib/esQueryVars';
import { useAsync, useJoinConnections } from '../export/JoinEditor';
import SuggestInput, { type SuggestOption } from '../SuggestInput';
import { listMongoDatabases, listMongoCollections, sampleMongoFields, type FieldInfo } from '@/lib/mongo';
import { listEsIndices, esMapping } from '@/lib/es';
import { listPgDatabases, listPgTables, listPgColumns, type PgTableInfo, type PgColumnInfo } from '@/lib/pg';
import { flattenEsMapping, type EsField } from '@/lib/esDsl';
import QueryEditor from './QueryEditor';
import FieldSuggest from '../mongo/FieldSuggest';
import SqlEditor from '../pg/SqlEditor';
import type { JsonSuggestPick } from '../JsonSuggest';

const KIND_LABEL: Record<QueryVarKind, string> = { es: 'Elasticsearch', mongo: 'MongoDB', pg: 'PostgreSQL' };

const QUERY_PLACEHOLDER: Record<QueryVarKind, string> = {
  es: '{ "query": { "term": { "status": "active" } } }   — trống = match_all',
  mongo: '{ "status": "active" }   — hoặc pipeline [ { "$match": … }, { "$group": … } ]',
  pg: "SELECT tenant_id FROM tenants WHERE status = 'active'",
};

const PREVIEW_MAX = 20;

type TestState = { busy: true } | { values: Prim[]; note: string } | { error: string };

const GUIDE_KEY = 'es.queryvars.guide';

/** Bảng đầu tiên sau FROM / JOIN trong câu SQL mà có thật trong database (thiếu schema → ưu tiên public). */
function fromTable(sql: string, tables: PgTableInfo[]): PgTableInfo | null {
  const re = /\b(?:from|join)\s+("?[\w$]+"?(?:\s*\.\s*"?[\w$]+"?)?)/gi;
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    const parts = m[1].split('.').map((p) => p.trim().replace(/^"|"$/g, ''));
    const [schema, name] = parts.length === 2 ? parts : [null, parts[0]];
    const hit = tables.filter((t) => t.name.toLowerCase() === name.toLowerCase() && (!schema || t.schema.toLowerCase() === schema.toLowerCase()));
    if (hit.length) return hit.find((t) => t.schema === 'public') ?? hit[0];
  }
  return null;
}

/**
 * Ô query của biến — cùng trình soạn và gợi ý như tab Dữ liệu của từng nguồn:
 * ES → QueryEditor (DSL + field theo mapping) · Mongo → textarea + FieldSuggest · PG → SqlEditor (bảng + cột).
 * Cả ba đều gợi ý `{{biến khác}}` ở dạng nào đó: ES qua `{{`, Mongo/PG ghi ở nhãn.
 */
function VarQueryInput({ v, onChange, onRun, esFields, mongoFields, pgTables, pgCols, otherVars }: {
  v: QueryVar;
  onChange: (q: string) => void;
  onRun: () => void;
  esFields: EsField[];
  mongoFields: FieldInfo[];
  pgTables: PgTableInfo[];
  pgCols: PgColumnInfo[];
  otherVars: QueryVar[];
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  // Khoá theo NỘI DUNG chứ không theo mảng: `otherVars` là mảng mới mỗi lần gõ, memo theo nó thì vô nghĩa.
  const varKey = otherVars.map((x) => `${x.name}|${x.field}|${x.object}|${x.kind}`).join(',');
  const varNames = useMemo(
    () => otherVars.map((x) => ({ name: x.name, detail: x.field ? `${x.name}.${x.field}` : x.object || x.kind })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [varKey],
  );

  if (v.kind === 'es') {
    return (
      <QueryEditor
        mode="body"
        value={v.query}
        onChange={onChange}
        onRun={onRun}
        fields={esFields}
        varNames={varNames}
        label={esFields.length ? `${esFields.length} field từ mapping của ${v.object}` : 'Chọn index để có gợi ý field'}
        placeholder={QUERY_PLACEHOLDER.es}
      />
    );
  }
  if (v.kind === 'pg') {
    return (
      <SqlEditor value={v.query} onChange={onChange} onRun={onRun} rows={4}
        tables={pgTables.map((t) => ({ schema: t.schema, name: t.name }))}
        columns={pgCols.map((c) => ({ name: c.name, dataType: c.dataType }))} />
    );
  }
  const pick = (r: JsonSuggestPick) => {
    const next = v.query.slice(0, r.from) + r.text + v.query.slice(r.to);
    onChange(next);
    const at = r.from + (r.caretOffset ?? r.text.length);
    setCaret(at);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(at, at + (r.selectLen ?? 0));
    });
  };
  const track = (e: React.SyntheticEvent<HTMLTextAreaElement>) => setCaret(e.currentTarget.selectionStart);
  return (
    <div style={{ position: 'relative' }}>
      <textarea ref={taRef} className="input mono" rows={4} value={v.query} spellCheck={false}
        placeholder={QUERY_PLACEHOLDER.mongo}
        onChange={(e) => { onChange(e.target.value); track(e); }}
        onSelect={track} onClick={track}
        onFocus={(e) => { setFocused(true); track(e); }}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onRun(); } }} />
      {focused && <FieldSuggest fields={mongoFields} value={v.query} caret={caret} onPick={pick} textareaRef={taRef} />}
    </div>
  );
}

/** Hướng dẫn ngắn: 3 bước + một ví dụ trước/sau + bảng cách viết. */
function VarGuide({ open, onToggle }: { open: boolean; onToggle: (open: boolean) => void }) {
  return (
    <details className="qv-guide" open={open} onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}>
      <summary>📖 Cách dùng biến truy vấn</summary>
      <p>
        Dùng khi cần lọc index này theo một danh sách lấy từ <b>nơi khác</b> — vd. chỉ lấy log của các tenant đang
        active, mà danh sách tenant active nằm ở Mongo.
      </p>
      <ol className="qv-steps">
        <li>
          <b>Khai biến</b> ở dưới: chọn kết nối nguồn (ES · Mongo · PG), viết query lấy dữ liệu, ghi <b>field</b> cần lấy
          giá trị. Bấm <b>▶ Thử</b> để xem biến lấy được những giá trị nào.
        </li>
        <li>
          Bấm <b>⤵ Lưu &amp; chèn vào body</b>. Body đang trống thì có sẵn khung <code>terms</code> — chỉ cần sửa tên field
          của index này. Hoặc tự gõ <code>{'{{'}</code> trong ô body để chọn biến.
        </li>
        <li>
          Bấm <b>▶ Search</b> như thường. Biến chạy trước, giá trị được thay vào body rồi mới tìm. Dưới ô body có
          dòng tóm tắt số giá trị và nút <b>Xem body đã thay biến</b>.
        </li>
      </ol>
      <div className="qv-example">
        <div>
          <span className="qv-ex-h">Biến <code>q1</code></span>
          <code className="qv-ex-code">MongoDB · tenants<br />{'{ "status": "active" }'}<br />field: _id</code>
        </div>
        <span className="qv-ex-arrow">→</span>
        <div>
          <span className="qv-ex-h">Bạn viết</span>
          <code className="qv-ex-code">{'"terms": {'}<br />{'  "tenantId": {{q1}}'}<br />{'}'}</code>
        </div>
        <span className="qv-ex-arrow">→</span>
        <div>
          <span className="qv-ex-h">Gửi đi khi Search</span>
          <code className="qv-ex-code">{'"terms": {'}<br />{'  "tenantId": ["t1", "t2", …]'}<br />{'}'}</code>
        </div>
      </div>
      <table className="qv-syntax">
        <tbody>
          <tr><td><code>{'{{q1}}'}</code></td><td>mọi giá trị của field mặc định, bỏ trùng → mảng (dùng cho <code>terms</code>)</td></tr>
          <tr><td><code>{'{{q1.email}}'}</code></td><td>lấy field khác của cùng biến, không phải khai thêm</td></tr>
          <tr><td><code>{'"{{q1}}"'}</code></td><td>trong dấu nháy → chỉ giá trị <b>đầu tiên</b> (dùng cho <code>term</code> / <code>match</code>)</td></tr>
          <tr><td><code>{'IN ({{q1}})'}</code></td><td>trong SQL của biến PG khác → <code>'t1', 't2'</code></td></tr>
          <tr><td><code>{'{{q0.id}}'}</code> trong query của q1</td><td>biến dùng biến: q0 chạy trước rồi mới tới q1</td></tr>
        </tbody>
      </table>
      <p className="xhint" style={{ margin: 0 }}>
        Mặc định tối đa {DEFAULT_MAX.toLocaleString('en-US')} giá trị / field (nâng được tới {HARD_MAX.toLocaleString('en-US')}).
        Vượt quá thì báo lỗi chứ không tự cắt bớt.
      </p>
    </details>
  );
}

function VarRow({ v, all, patch, remove, onInsert, insertBlocked }: {
  v: QueryVar;
  all: QueryVar[];
  patch: (p: Partial<QueryVar>) => void;
  remove: () => void;
  onInsert: () => void;
  /** Lý do không chèn được (chưa chọn index…); null = chèn được. */
  insertBlocked: string | null;
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
    isMongo && colls.includes(v.object), [] as FieldInfo[]);
  const esItems = useAsync(async () => (await listEsIndices(id)).map((i) => ({ value: i.name, hint: i.health })), [id], isEs, [] as SuggestOption[]);
  const esFields = useAsync(async () => flattenEsMapping((await esMapping(id, v.object)).json), [id, v.object],
    isEs && esItems.some((i) => i.value === v.object), [] as { path: string; type: string }[]);
  const pgDbs = useAsync(async () => (await listPgDatabases(id)).map((d) => d.name), [id], isPg, [] as string[]);
  const pgTables = useAsync(async () => listPgTables(id, v.db), [id, v.db], isPg && pgDbs.includes(v.db), [] as PgTableInfo[]);
  // Cột gợi ý = cột của bảng đứng sau FROM trong câu SQL (bảng đầu tiên nhận ra được).
  const pgFrom = useMemo(() => fromTable(v.query, pgTables), [v.query, pgTables]);
  const pgCols = useAsync(async () => listPgColumns(id, v.db, pgFrom!.schema, pgFrom!.name),
    [id, v.db, pgFrom?.schema, pgFrom?.name], !!pgFrom, [] as PgColumnInfo[]);

  const fieldOptions = useMemo<SuggestOption[]>(() => (isPg
    ? pgCols.map((c) => ({ value: c.name, hint: c.dataType }))
    : (isMongo ? mongoFields : isEs ? esFields : []).map((f) => ({ value: f.path, hint: f.type }))),
  [isPg, isMongo, isEs, pgCols, mongoFields, esFields]);
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
        <VarQueryInput
          v={v}
          onChange={(query) => patch({ query })}
          onRun={() => { if (!problem) void runTest(); }}
          esFields={esFields}
          mongoFields={mongoFields}
          pgTables={pgTables}
          pgCols={pgCols}
          otherVars={all.filter((x) => x.id !== v.id && x.name)}
        />
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
        <button className="sm" style={{ alignSelf: 'flex-end' }} disabled={!!problem || !!insertBlocked}
          title={insertBlocked ?? `Lưu danh sách biến rồi chèn ${placeholder} vào ô body của tab đang xem (body trống → dựng sẵn khung terms)`}
          onClick={onInsert}>⤵ Lưu &amp; chèn vào body</button>
        <button className="chip-btn" style={{ alignSelf: 'flex-end' }} title="Copy placeholder để tự dán vào body"
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

export default function QueryVarsModal({ vars, onSave, onInsert, insertBlocked, onClose }: {
  vars: QueryVar[];
  onSave: (list: QueryVar[]) => void;
  /** Lưu `list` rồi chèn biến `v` vào body của tab đang xem. */
  onInsert: (list: QueryVar[], v: QueryVar) => void;
  insertBlocked: string | null;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<QueryVar[]>(() => (vars.length ? vars : [newQueryVar([])]));
  const [guideOpen, setGuideOpen] = useState(() => vars.length === 0 || readLocal(GUIDE_KEY) !== 'closed');
  const toggleGuide = (open: boolean) => {
    setGuideOpen(open);
    writeLocal(GUIDE_KEY, open ? 'open' : 'closed');
  };
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
        <VarGuide open={guideOpen} onToggle={toggleGuide} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {draft.map((v) => (
            <VarRow
              key={v.id}
              v={v}
              all={draft}
              patch={(p) => setDraft((list) => list.map((x) => (x.id === v.id ? { ...x, ...p } : x)))}
              remove={() => setDraft((list) => list.filter((x) => x.id !== v.id))}
              onInsert={() => onInsert(draft, v)}
              insertBlocked={insertBlocked}
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
