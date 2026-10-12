'use client';

// Khai báo NỐI CỘT trong hộp thoại xuất Excel (xem lib/exportJoin.ts cho cách hoạt động).
// Mỗi phép nối: kết nối đích (ES / Mongo / PG — cùng hoặc khác kết nối đang xuất) + index/collection/bảng + cặp field khoá.
// Cột lấy về khai ở bảng cột như thường, field code dạng "~tên_ngắn.field" (vd. ~b.name) — gõ "~" là có gợi ý.

import { useEffect, useMemo, useState } from 'react';
import {
  JOIN_KEY_TYPES, JOIN_OPS, JOIN_VAL_TYPES, filterNeedsValue, joinProblem, newJoin, valTypeOfField,
  type JoinDraft, type JoinFilter, type JoinKeyType, type JoinSort, type JoinKind, type JoinOp, type JoinValType,
} from '@/lib/exportJoin';
import SuggestInput, { type SuggestOption } from '../SuggestInput';
import { fetchMongoConnections, listMongoDatabases, listMongoCollections, sampleMongoFields } from '@/lib/mongo';
import { fetchEsConnections, listEsIndices, esMapping } from '@/lib/es';
import { fetchPgConnections, listPgDatabases, listPgTables, listPgColumns, type PgTableInfo } from '@/lib/pg';
import { flattenEsMapping } from '@/lib/esDsl';

const KIND_LABEL: Record<JoinKind, string> = { es: 'Elasticsearch', mongo: 'MongoDB', pg: 'PostgreSQL' };

/** Chạy `load` khi `enabled` và `deps` đổi; lỗi → `fallback` (gợi ý hỏng không được làm hỏng hộp thoại). */
function useAsync<T>(load: () => Promise<T>, deps: unknown[], enabled: boolean, fallback: T): T {
  const [v, setV] = useState<T>(fallback);
  useEffect(() => {
    if (!enabled) { setV(fallback); return; }
    let alive = true;
    load().then((r) => { if (alive) setV(r); }).catch(() => { if (alive) setV(fallback); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
  return v;
}

interface JoinConn { id: string; name: string; kind: JoinKind }
const NO_CONNS: JoinConn[] = [];

/** Mọi kết nối ES · Mongo · PG của máy này. */
function useJoinConnections(): JoinConn[] {
  return useAsync<JoinConn[]>(async () => {
    const [m, e, p] = await Promise.all([
      fetchMongoConnections().catch(() => null),
      fetchEsConnections().catch(() => null),
      fetchPgConnections().catch(() => null),
    ]);
    return [
      ...(e?.connections ?? []).map((c) => ({ id: c.id, name: c.name, kind: 'es' as const })),
      ...(m?.connections ?? []).map((c) => ({ id: c.id, name: c.name, kind: 'mongo' as const })),
      ...(p?.connections ?? []).map((c) => ({ id: c.id, name: c.name, kind: 'pg' as const })),
    ];
  }, [], true, NO_CONNS);
}

function JoinRow({ j, all, patch, remove, srcSuggestions, onTargetFields, onAddColumn, columnPaths, disabled }: {
  j: JoinDraft;
  all: JoinDraft[];
  patch: (p: Partial<JoinDraft>) => void;
  remove: () => void;
  srcSuggestions: Array<string | SuggestOption>;
  /** Báo field của B lên hộp thoại để gợi ý "~alias.field" ở bảng cột. */
  onTargetFields: (id: string, fields: SuggestOption[]) => void;
  /** Thêm một cột "~alias.field" vào bảng cột của file. */
  onAddColumn: (path: string) => void;
  /** Field code của mọi cột đang khai (để biết cột nào của phép nối này đã được thêm). */
  columnPaths: string[];
  disabled?: boolean;
}) {
  const [pick, setPick] = useState('');
  const options = useJoinConnections();
  const id = j.connectionId;
  const isMongo = j.kind === 'mongo' && !!id;
  const isEs = j.kind === 'es' && !!id;
  const isPg = j.kind === 'pg' && !!id;

  // Mongo
  const dbs = useAsync(async () => (await listMongoDatabases(id)).map((d) => d.name), [id], isMongo, [] as string[]);
  const colls = useAsync(async () => (await listMongoCollections(id, j.db)).map((c) => c.name), [id, j.db], isMongo && !!j.db.trim(), [] as string[]);
  const mongoKnown = isMongo && dbs.includes(j.db) && colls.includes(j.object);
  const mongoFields = useAsync(async () => sampleMongoFields(id, j.db, j.object), [id, j.db, j.object], mongoKnown, [] as { path: string; type: string }[]);
  // ES
  const esItems = useAsync(async () => (await listEsIndices(id)).map((i) => ({ name: i.name, kind: i.health })), [id], isEs, [] as { name: string; kind: string }[]);
  const esFields = useAsync(async () => flattenEsMapping((await esMapping(id, j.object)).json), [id, j.object],
    isEs && esItems.some((i) => i.name === j.object), [] as { path: string; type: string }[]);
  // PG
  const pgDbs = useAsync(async () => (await listPgDatabases(id)).map((d) => d.name), [id], isPg, [] as string[]);
  const pgTableList = useAsync(async () => listPgTables(id, j.db), [id, j.db], isPg && !!j.db.trim(), [] as PgTableInfo[]);
  const pgTables = useMemo(() => pgTableList.map((t) => ({ value: `${t.schema}.${t.name}`, hint: `~${t.estRows.toLocaleString('en-US')} dòng` })), [pgTableList]);
  const pgTable = pgTableList.find((t) => `${t.schema}.${t.name}` === j.object);
  const pgCols = useAsync(async () => listPgColumns(id, j.db, pgTable!.schema, pgTable!.name), [id, j.db, j.object], !!pgTable, [] as { name: string; dataType: string }[]);

  const targetFields = useMemo<SuggestOption[]>(() => {
    if (isMongo) return mongoFields.map((f) => ({ value: f.path, hint: f.type }));
    if (isEs) return esFields.map((f) => ({ value: f.path, hint: f.type }));
    if (isPg) return pgCols.map((c) => ({ value: c.name, hint: c.dataType }));
    return [];
  }, [isMongo, isEs, isPg, mongoFields, esFields, pgCols]);

  useEffect(() => { onTargetFields(j.id, targetFields); }, [j.id, targetFields, onTargetFields]);

  const problem = joinProblem(j, all);
  const prefix = `~${j.alias}.`;
  const added = columnPaths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
  const filters = j.filters ?? [];
  const sorts = j.sort ?? [];
  const setSort = (i: number, p: Partial<JoinSort>) => patch({ sort: sorts.map((s, k) => (k === i ? { ...s, ...p } : s)) });
  const setFilter = (i: number, p: Partial<JoinFilter>) => patch({ filters: filters.map((f, k) => (k === i ? { ...f, ...p } : f)) });
  const hintOf = (field: string) => targetFields.find((t) => t.value === field)?.hint;
  const add = (field: string) => {
    const f = field.trim();
    if (!f) return;
    onAddColumn(`${prefix}${f}`);
    setPick('');
  };

  return (
    <div className="export-join">
      <div className="xrow">
        <div className="mongo-field" style={{ flex: '0 0 74px' }}>
          <span>Tên ngắn</span>
          <input className="input mono" value={j.alias} disabled={disabled} onChange={(e) => patch({ alias: e.target.value.trim() })} />
        </div>
        <div className="mongo-field" style={{ flex: '1 1 200px' }}>
          <span>Nối sang kết nối</span>
          <select className="input" value={j.connectionId} disabled={disabled}
            onChange={(e) => {
              const c = options.find((x) => x.id === e.target.value);
              patch({ connectionId: e.target.value, kind: c?.kind ?? j.kind, db: '', object: '', targetField: '' });
            }}>
            <option value="">— chọn kết nối —</option>
            {options.map((c) => <option key={`${c.kind}-${c.id}`} value={c.id}>{c.name} · {KIND_LABEL[c.kind]}</option>)}
          </select>
        </div>
        {(j.kind === 'mongo' || j.kind === 'pg') && (
          <div className="mongo-field" style={{ flex: '1 1 140px' }}>
            <span>Database</span>
            <SuggestInput className="input mono" value={j.db} options={j.kind === 'pg' ? pgDbs : dbs} showWhenEmpty disabled={disabled || !id}
              onChange={(v) => patch({ db: v, object: v === j.db ? j.object : '' })} />
          </div>
        )}
        <div className="mongo-field" style={{ flex: '1 1 200px' }}>
          <span>{j.kind === 'es' ? 'Index / alias' : j.kind === 'mongo' ? 'Collection' : 'Bảng (schema.table)'}</span>
          <SuggestInput className="input mono" value={j.object} showWhenEmpty disabled={disabled || !id}
            options={j.kind === 'es' ? esItems.map((i) => ({ value: i.name, hint: i.kind })) : j.kind === 'mongo' ? colls : pgTables}
            onChange={(v) => patch({ object: v })} />
        </div>
        <button className="chip-btn" title="Bỏ phép nối" disabled={disabled} onClick={remove} style={{ alignSelf: 'flex-end', height: 32 }}>✕</button>
      </div>
      <div className="xrow">
        <div className="mongo-field" style={{ flex: '1 1 200px' }}>
          <span>Khoá ở dữ liệu đang xuất (X)</span>
          <SuggestInput className="input mono" value={j.sourceField} options={srcSuggestions} showWhenEmpty disabled={disabled}
            placeholder="vd. tenant_id" onChange={(v) => patch({ sourceField: v })} />
        </div>
        <span className="xhint" style={{ alignSelf: 'flex-end', paddingBottom: 8 }}>=</span>
        <div className="mongo-field" style={{ flex: '1 1 200px' }}>
          <span>Khoá ở bên nối (Y)</span>
          <SuggestInput className="input mono" value={j.targetField} options={targetFields} showWhenEmpty disabled={disabled || !id}
            placeholder={j.kind === 'es' ? 'vd. tenant_id (keyword)' : 'vd. _id'} onChange={(v) => patch({ targetField: v })} />
        </div>
        <div className="mongo-field" style={{ flex: '0 0 150px' }}>
          <span>Kiểu khoá</span>
          <select className="input" value={j.keyType} disabled={disabled}
            title={'Tự nhận: Mongo hỏi cả dạng text, ObjectId và số; ES gửi dạng text; PG chọn số/UUID/text theo giá trị.\nChọn tay khi dữ liệu hai bên lệch kiểu.'}
            onChange={(e) => patch({ keyType: e.target.value as JoinKeyType })}>
            {JOIN_KEY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
      </div>
      {/* Lọc bớt dữ liệu bên nối (AND giữa các điều kiện) + giới hạn số dòng nối cho mỗi dòng của file. */}
      <div className="mongo-field">
        <span>Lọc bớt dữ liệu bên nối (tuỳ chọn, các điều kiện gộp bằng AND — vd. <code>is_deleted</code> ≠ <code>true</code>)</span>
        {filters.map((f, i) => (
          <div className="xrow" key={i}>
            <div style={{ flex: '1 1 160px', minWidth: 0 }}>
              <SuggestInput className="input mono" value={f.field} options={targetFields} showWhenEmpty disabled={disabled || !id}
                placeholder="field (vd. is_deleted)" onChange={(v) => setFilter(i, { field: v })}
                onPick={(v) => setFilter(i, { field: v, type: valTypeOfField(hintOf(v)) })} />
            </div>
            <select className="input" style={{ flex: '0 0 190px' }} value={f.op} disabled={disabled}
              onChange={(e) => setFilter(i, { op: e.target.value as JoinOp })}>
              {JOIN_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {filterNeedsValue(f.op) && (
              f.type === 'boolean' && f.op !== 'in' && f.op !== 'nin' ? (
                <select className="input" style={{ flex: '1 1 120px' }} value={f.value === 'false' ? 'false' : 'true'} disabled={disabled}
                  onChange={(e) => setFilter(i, { value: e.target.value })}>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input className="input mono" style={{ flex: '1 1 120px' }} value={f.value} disabled={disabled}
                  placeholder={f.op === 'in' || f.op === 'nin' ? 'giá trị 1, giá trị 2, …' : 'giá trị'}
                  onChange={(e) => setFilter(i, { value: e.target.value })} />
              )
            )}
            {filterNeedsValue(f.op) && (
              <select className="input" style={{ flex: '0 0 90px' }} value={f.type} disabled={disabled}
                onChange={(e) => {
                  const type = e.target.value as JoinValType;
                  setFilter(i, { type, ...(type === 'boolean' && f.value !== 'true' && f.value !== 'false' ? { value: 'true' } : {}) });
                }}>
                {JOIN_VAL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            )}
            <button className="chip-btn" title="Bỏ điều kiện" disabled={disabled} onClick={() => patch({ filters: filters.filter((_, k) => k !== i) })}>✕</button>
          </div>
        ))}
        <div className="xrow">
          <button className="ghost sm" disabled={disabled || !id} onClick={() => patch({ filters: [...filters, { field: '', op: 'eq', value: '', type: 'text' }] })}>+ Thêm điều kiện lọc</button>
          <div className="mongo-field" style={{ flex: '0 0 220px', flexDirection: 'row', alignItems: 'center', gap: 6 }}
            title={'Một dòng của file khớp nhiều dòng bên nối thì chỉ nối tối đa N dòng đầu. Trống / 0 = không giới hạn.'}>
            <span>Tối đa dòng nối / dòng</span>
            <input className="input" type="number" min={0} style={{ width: 80 }} value={j.maxPerRow ?? ''} disabled={disabled}
              placeholder="∞" onChange={(e) => patch({ maxPerRow: Math.max(0, Math.floor(Number(e.target.value) || 0)) || undefined })} />
          </div>
        </div>
        {sorts.map((s, i) => (
          <div className="xrow" key={`s${i}`}>
            <span className="xhint" style={{ flex: '0 0 76px' }}>{i === 0 ? 'Sắp xếp theo' : 'rồi theo'}</span>
            <div style={{ flex: '1 1 160px', minWidth: 0 }}>
              <SuggestInput className="input mono" value={s.field} options={targetFields} showWhenEmpty disabled={disabled || !id}
                placeholder="field (vd. created_at)" onChange={(v) => setSort(i, { field: v })} />
            </div>
            <select className="input" style={{ flex: '0 0 120px' }} value={s.dir} disabled={disabled}
              onChange={(e) => setSort(i, { dir: e.target.value as 'asc' | 'desc' })}>
              <option value="asc">Tăng ↑</option>
              <option value="desc">Giảm ↓</option>
            </select>
            <button className="chip-btn" title="Bỏ khoá sắp xếp" disabled={disabled} onClick={() => patch({ sort: sorts.filter((_, k) => k !== i) })}>✕</button>
          </div>
        ))}
        <div className="xrow">
          <button className="ghost sm" disabled={disabled || !id} onClick={() => patch({ sort: [...sorts, { field: '', dir: 'desc' }] })}>+ Thêm sắp xếp</button>
          {sorts.length > 0 && <span className="xhint">Các dòng nối trong một ô được nối theo thứ tự này; cùng "Tối đa dòng nối" = lấy N dòng đầu theo sắp xếp.</span>}
        </div>
        {filters.some((f) => f.op === 'ne' || f.op === 'nin' || f.op === 'missing') && (
          <span className="xhint">Phủ định (≠, ∉, không có giá trị) vẫn lấy cả bản ghi chưa có field đó. Trên PostgreSQL, ≠ và ∉ được lọc sau khi tải về nên chậm hơn nếu bảng bên nối rất lớn.</span>
        )}
      </div>
      {/* Bước lấy cột: chọn field của bên nối → tự thêm vào bảng cột ở trên (field code "~alias.field"). */}
      <div className="xrow">
        <div className="mongo-field" style={{ flex: '1 1 260px' }}>
          <span>Cột lấy từ bên nối đưa vào file (chọn field → thêm vào bảng cột ở trên)</span>
          <SuggestInput className="input mono" value={pick} options={targetFields} showWhenEmpty disabled={disabled || !!problem}
            placeholder={problem ? 'khai xong phần trên rồi chọn field' : 'vd. name — Tab/Enter để thêm cột'}
            onChange={setPick} onPick={add} onEnter={() => add(pick)} />
        </div>
        <button className="ghost sm" style={{ alignSelf: 'flex-end' }} disabled={disabled || !!problem || !pick.trim()} onClick={() => add(pick)}>+ Thêm cột</button>
      </div>
      <span className={problem ? 'xerr' : 'xhint'}>
        {problem
          ? `⚠ ${problem}`
          : added.length
            ? <>Đã đưa vào file: {added.map((f) => <code key={f} style={{ marginRight: 6 }}>{f}</code>)} — chỉnh tên cột, định dạng, ký tự phân cách ở bảng cột. Một dòng khớp nhiều dòng bên nối → các giá trị nối bằng ô <b>phân cách</b>.</>
            : <>Chưa có cột nào của phép nối này trong file. Cũng có thể gõ thẳng <code>~{j.alias}.tên_field</code> ở ô field code của bảng cột.</>}
      </span>
    </div>
  );
}

export default function JoinEditor({ joins, setJoins, srcSuggestions, onTargetFields, onAddColumn, columnPaths, disabled }: {
  joins: JoinDraft[];
  setJoins: React.Dispatch<React.SetStateAction<JoinDraft[]>>;
  srcSuggestions: Array<string | SuggestOption>;
  onTargetFields: (id: string, fields: SuggestOption[]) => void;
  onAddColumn: (path: string) => void;
  columnPaths: string[];
  disabled?: boolean;
}) {
  return (
    <div className="mongo-field">
      <span>Nối cột từ bảng / index khác (cùng hoặc khác kết nối; ES · Mongo · PG)</span>
      {joins.map((j) => (
        <JoinRow
          key={j.id}
          j={j}
          all={joins}
          srcSuggestions={srcSuggestions}
          onTargetFields={onTargetFields}
          onAddColumn={onAddColumn}
          columnPaths={columnPaths}
          disabled={disabled}
          patch={(p) => setJoins((js) => js.map((x) => (x.id === j.id ? { ...x, ...p } : x)))}
          remove={() => setJoins((js) => js.filter((x) => x.id !== j.id))}
        />
      ))}
      <div><button className="ghost sm" disabled={disabled} onClick={() => setJoins((js) => [...js, newJoin(js)])}>+ Thêm phép nối</button></div>
    </div>
  );
}
