'use client';

// "⚡ Thực thi SQL" — chỗ chạy câu lệnh CÓ GHI (INSERT / UPDATE / DELETE / DDL)
// khi connection đã mở khoá ghi. Ô SQL ở mục Dữ liệu luôn chạy READ ONLY nên
// không dùng được cho việc này.
//
// Quy trình bắt buộc, giống tinh thần UpdateModal:
//   1. ≈ Chạy thử — server thực thi thật trong transaction rồi ROLLBACK, trả về
//      số dòng bị ảnh hưởng theo từng lệnh (+ dòng RETURNING nếu có),
//   2. gõ lại tên database để xác nhận,
//   3. ⚠ Commit — chỉ bật khi lần chạy thử thành công là ĐÚNG câu SQL + database
//      đang có trên màn hình (sửa một ký tự là phải chạy thử lại).
// Server độc lập chặn theo PG_ALLOW_WRITE + readOnly của connection.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listPgDatabases,
  listPgTables,
  pgExec,
  fmtCount,
  prettyDoc,
  type PgDatabaseInfo,
  type PgTableInfo,
  type PgExecResult,
  type WireRow,
} from '@/lib/pg';
import { readLocal, writeLocal } from '@/lib/localKeys';
import SqlEditor from './SqlEditor';
import ColSplit from '../ColSplit';

export interface ExecViewProps {
  connectionId: string;
  defaultDb: string;
  readOnly: boolean;
  allowWrite: boolean;
}

interface Ran { db: string; sql: string; result: PgExecResult }

export default function ExecView({ connectionId, defaultDb, readOnly, allowWrite }: ExecViewProps) {
  const sqlKey = `pg.exec.${connectionId}`;
  const dbKey = `pg.exec.${connectionId}.db`;
  const [db, setDb] = useState(defaultDb);
  const [sql, setSql] = useState('');
  // Nạp câu đang soạn dở sau mount (đọc trong initializer làm lệch hydrate).
  useEffect(() => {
    setSql(readLocal(sqlKey) ?? '');
    const savedDb = readLocal(dbKey);
    if (savedDb) setDb(savedDb);
  }, [sqlKey, dbKey]);
  useEffect(() => { writeLocal(sqlKey, sql); }, [sqlKey, sql]);
  useEffect(() => { if (db) writeLocal(dbKey, db); }, [dbKey, db]);

  const [dbs, setDbs] = useState<PgDatabaseInfo[]>([]);
  const [tables, setTables] = useState<PgTableInfo[]>([]);
  useEffect(() => {
    listPgDatabases(connectionId).then(setDbs).catch(() => setDbs([]));
  }, [connectionId]);
  useEffect(() => {
    if (!db) return;
    listPgTables(connectionId, db).then(setTables).catch(() => setTables([]));
  }, [connectionId, db]);

  const [dry, setDry] = useState<Ran | null>(null);
  const [done, setDone] = useState<Ran | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<WireRow | null>(null);

  const armed = allowWrite && !readOnly;
  const dryFresh = !!dry && dry.sql === sql && dry.db === db;
  const canCommit = armed && !busy && dryFresh && typed === db;
  const shown = done && done.sql === sql && done.db === db ? done : dry;

  const run = useCallback(async (commit: boolean) => {
    if (!sql.trim() || !db) return;
    setBusy(true); setError(null);
    try {
      const result = await pgExec(connectionId, db, sql, commit);
      if (commit) { setDone({ db, sql, result }); setDry(null); setTyped(''); }
      else { setDry({ db, sql, result }); setDone(null); }
    } catch (e) {
      setError((e as Error).message);
      if (!commit) setDry(null);
    } finally { setBusy(false); }
  }, [connectionId, db, sql]);

  const parsedRows = useMemo(
    () => (shown ? shown.result.rows.map((r) => { try { return JSON.parse(r.json) as Record<string, unknown>; } catch { return null; } }) : []),
    [shown],
  );

  if (!armed) {
    return (
      <div className="panel" style={{ margin: 'auto', maxWidth: 560, textAlign: 'center' }}>
        <div className="empty-ico" aria-hidden>🔒</div>
        <h3>Chưa mở khoá ghi</h3>
        <p className="empty">
          {!allowWrite
            ? <>Đặt <code>PG_ALLOW_WRITE=true</code> trong <code>.env.local</code> rồi khởi động lại dev server.</>
            : <>Connection này đang read-only — sửa connection và bỏ chọn “Read-only”.</>}
        </p>
      </div>
    );
  }

  return (
    <ColSplit storageKey="devbox-pg-exec-split">
      <div className="pg-querybar">
        <div className="pg-danger" style={{ marginBottom: 0 }}>
          ⚠ Chạy thẳng trên server, CÓ GHI. Cả khối chạy trong một transaction: <b>≈ Chạy thử</b> thực thi
          rồi ROLLBACK để xem số dòng bị ảnh hưởng; <b>Commit</b> chỉ bật sau khi chạy thử đúng câu này.
          Timeout 15s · chờ khoá quá 1s là huỷ. Không dùng BEGIN/COMMIT, VACUUM, CREATE INDEX CONCURRENTLY.
        </div>
        <label className="pg-field">
          <span>Database</span>
          <select className="input" value={db} onChange={(e) => setDb(e.target.value)}>
            {!dbs.some((d) => d.name === db) && db && <option value={db}>{db}</option>}
            {dbs.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
          </select>
        </label>
        <div className="pg-field grow">
          <span>SQL (nhiều lệnh cách nhau “;” — Ctrl+Enter = chạy thử · Ctrl+Space gợi ý)</span>
          <SqlEditor
            key={connectionId}
            value={sql}
            onChange={setSql}
            onRun={() => void run(false)}
            tables={tables}
            rows={8}
          />
        </div>
        <div className="status-line cs-split-pin" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="sm" disabled={busy || !sql.trim() || !db} onClick={() => void run(false)}>
            {busy ? <span className="spinner" aria-hidden /> : '≈'} Chạy thử (rollback)
          </button>
          <input
            className="input mono"
            style={{ flex: '1 1 140px', fontSize: 12 }}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && canCommit && void run(true)}
            placeholder={dryFresh ? `gõ lại "${db}" để commit` : 'chạy thử trước'}
            disabled={!dryFresh}
          />
          <button
            className="sm"
            disabled={!canCommit}
            onClick={() => void run(true)}
            style={{ color: 'var(--err)', borderColor: 'var(--err)' }}
            title={canCommit ? 'Thực thi và COMMIT' : 'Cần chạy thử thành công đúng câu này + gõ đúng tên database'}
          >⚠ Commit</button>
        </div>
      </div>

      <div className="pg-resultpane">
        {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
        {!shown && !error && <p className="xhint">Kết quả chạy thử / commit sẽ hiện ở đây.</p>}
        {shown && (
          <>
            <div className="status-line" style={{ gap: 6, flexWrap: 'wrap' }}>
              {shown.result.committed
                ? <span className="badge" style={{ color: 'var(--ok)' }}>✓ Đã COMMIT</span>
                : <span className="badge">≈ Chạy thử — đã ROLLBACK, chưa ghi gì</span>}
              <span className="badge">{shown.result.tookMs}ms</span>
              {shown.result.statements.map((s, i) => (
                <span key={i} className="badge mono">
                  {s.command}{s.rowCount !== null ? ` · ${fmtCount(s.rowCount)} dòng` : ''}
                </span>
              ))}
            </div>
            {shown.result.columns.length > 0 && (
              <div className="pg-results">
                {shown.result.rowCount === 0 && <p className="empty">Không có dòng nào.</p>}
                {shown.result.rowCount > 0 && (
                  <table className="pg-table pg-grid">
                    <thead>
                      <tr>
                        <th>#</th>
                        {shown.result.columns.map((c) => <th key={c} style={{ textAlign: 'left' }}>{c}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {shown.result.rows.map((r, i) => (
                        <tr key={i} onClick={() => setSelectedRow(r)} title="Bấm để xem JSON đầy đủ" style={{ cursor: 'pointer' }}>
                          <td className="pg-rownum">{i + 1}</td>
                          {shown.result.columns.map((c) => (
                            <td key={c} style={{ textAlign: 'left' }}>
                              <span className="pg-cell">{cellText(parsedRows[i]?.[c])}</span>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {shown.result.capped && <p className="xhint">Chỉ hiện 500 dòng đầu.</p>}
              </div>
            )}
          </>
        )}
        {/* Modal nằm TRONG ô phải: ColSplit chỉ nhận đúng hai con. */}
        {selectedRow && (
          <div className="modal-backdrop" onClick={() => setSelectedRow(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(760px, 94vw)' }}>
              <div className="status-line" style={{ marginBottom: 8 }}>
                <h3 style={{ margin: 0, flex: 1 }}>Row</h3>
                <button className="ghost sm" onClick={() => { void navigator.clipboard?.writeText(prettyDoc(selectedRow.json)); }}>⧉ Copy</button>
                <button className="ghost sm" onClick={() => setSelectedRow(null)}>✕</button>
              </div>
              <pre className="code pg-doc-body" style={{ maxHeight: '70vh' }}>{prettyDoc(selectedRow.json)}</pre>
            </div>
          </div>
        )}
      </div>
    </ColSplit>
  );
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return v.length > 120 ? `${v.slice(0, 120)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}
