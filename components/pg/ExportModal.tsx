'use client';

// Export the current PG quick-find result set as a styled .xlsx report — same
// UX + workbook engine as the Mongo/ES tabs (lib/mongoReport): STT column,
// epoch/ISO timestamps → real Excel date cells (dd/MM/yyyy · HH:mm:ss
// dd/MM/yyyy), A4 min width. Re-queries the SAME parameterized WHERE page by
// page (200/page, capped) selecting only the referenced columns.

import { useMemo, useState } from 'react';
import { pgQuickFind, type PgQuickEntry } from '@/lib/pg';
import {
  buildReportXlsx,
  downloadBlob,
  reportFilename,
  COLUMN_FORMATS,
  NO_COLUMN_PATH,
  type ReportColumn,
  type ColumnFormat,
} from '@/lib/mongoReport';

const MAX_EXPORT_DOCS = 5000;
const PAGE = 200;
const MAX_DEFAULT_COLUMNS = 5;

export interface ExportModalProps {
  connectionId: string;
  db: string;
  schema: string;
  table: string;
  /** Structured entries of the run being exported (parameterized server-side). */
  entries: PgQuickEntry[];
  querySummary: string;
  /** Column suggestions (from information_schema). */
  fieldSuggestions: string[];
  initialPaths: string[];
  defaultTitle: string;
  onClose: () => void;
  onDone: (rows: number, filename: string) => void;
}

interface ColumnDraft extends ReportColumn { key: number; }

function prettyHeader(path: string): string {
  if (path === NO_COLUMN_PATH) return 'STT';
  return path
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

export default function ExportModal(props: ExportModalProps) {
  const { connectionId, db, schema, table, entries, querySummary, fieldSuggestions, initialPaths, defaultTitle, onClose, onDone } = props;

  const [title, setTitle] = useState(defaultTitle);
  let seq = 0;
  const [columns, setColumns] = useState<ColumnDraft[]>(() => [
    { key: seq++, header: 'STT', path: NO_COLUMN_PATH, format: 'number' as ColumnFormat },
    ...initialPaths.slice(0, MAX_DEFAULT_COLUMNS).map((p) => ({
      key: seq++, header: prettyHeader(p), path: p, format: 'auto' as ColumnFormat,
    })),
  ]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const validColumns = useMemo(() => columns.filter((c) => c.path.trim()), [columns]);
  const canExport = !busy && !!title.trim() && validColumns.length > 0;

  const patch = (key: number, p: Partial<ColumnDraft>) =>
    setColumns((cs) => cs.map((c) => (c.key === key ? { ...c, ...p } : c)));

  const doExport = async () => {
    setBusy(true); setError(null);
    try {
      const selectCols = [...new Set(validColumns.map((c) => c.path).filter((p) => p !== NO_COLUMN_PATH))];

      const docs: Record<string, unknown>[] = [];
      let offset = 0;
      for (;;) {
        setProgress(`Đang tải dữ liệu… ${docs.length} dòng`);
        const page = await pgQuickFind(connectionId, db, {
          schema, table, entries, limit: PAGE, offset, columns: selectCols.length ? selectCols : undefined,
        });
        for (const r of page.rows) {
          try { docs.push(JSON.parse(r.json) as Record<string, unknown>); } catch { /* truncated — skip */ }
        }
        if (!page.hasMore || docs.length >= MAX_EXPORT_DOCS) break;
        offset += PAGE;
      }
      const capped = docs.length >= MAX_EXPORT_DOCS;
      const rows = docs.slice(0, MAX_EXPORT_DOCS);

      setProgress(`Đang dựng file Excel… ${rows.length} dòng`);
      const blob = await buildReportXlsx(
        {
          title: title.trim(),
          target: `${db}.${schema}.${table}`,
          rowCount: rows.length,
          note: capped ? `đã cắt tại ${MAX_EXPORT_DOCS.toLocaleString('en-US')} dòng` : undefined,
        },
        validColumns.map(({ header, path, format }) => ({ header: header.trim() || path, path: path.trim(), format })),
        rows,
      );
      const filename = reportFilename(title);
      downloadBlob(blob, filename);
      onDone(rows.length, filename);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false); setProgress(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(720px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>📄 Xuất báo cáo — {schema}.{table}</h3>
          <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <label className="pg-field" style={{ marginBottom: 8 }}>
          <span>Tiêu đề báo cáo (hiện trên đầu sheet + tên file)</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Báo cáo extension theo tenant" />
        </label>

        <div className="pg-field" style={{ marginBottom: 4, minHeight: 0 }}>
          <span>Cột báo cáo (tên cột · column · định dạng — Auto tự nhận chữ/số/timestamp)</span>
          <div className="export-colscroll">
            {columns.map((c) => (
              <div key={c.key} className="pg-form-row" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
                <input className="input" style={{ flex: 1 }} value={c.header} placeholder="Tên cột (vd. Ngày tạo)"
                  onChange={(e) => patch(c.key, { header: e.target.value })} />
                <input className="input mono" style={{ flex: 1.2 }} value={c.path} list="pg-export-fields"
                  placeholder="column (vd. created_at)"
                  onChange={(e) => patch(c.key, { path: e.target.value, header: c.header || prettyHeader(e.target.value) })} />
                <select className="input" style={{ flex: '0 0 190px' }} value={c.format}
                  onChange={(e) => patch(c.key, { format: e.target.value as ColumnFormat })}>
                  {COLUMN_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
                <button className="chip-btn" title="Bỏ cột" disabled={columns.length <= 1}
                  onClick={() => setColumns((cs) => cs.filter((x) => x.key !== c.key))}>✕</button>
              </div>
            ))}
          </div>
          <datalist id="pg-export-fields">
            {fieldSuggestions.map((f) => <option key={f} value={f} />)}
          </datalist>
          <div>
            <button className="ghost sm" onClick={() => setColumns((cs) => [...cs, { key: Math.max(0, ...cs.map((c) => c.key)) + 1, header: '', path: '', format: 'auto' }])}>
              + Thêm cột
            </button>
          </div>
        </div>

        <p className="pg-hint" style={{ marginBottom: 8 }}>
          Xuất <b>toàn bộ</b> kết quả khớp query <code>{querySummary}</code> (không chỉ trang đang xem,
          trần {MAX_EXPORT_DOCS.toLocaleString('en-US')} dòng). Cột thời gian: “Ngày” → <code>dd/MM/yyyy</code>,
          “Ngày giờ” → <code>HH:mm:ss dd/MM/yyyy</code> — date-cell thật của Excel.
        </p>

        {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {progress && <span className="badge"><span className="spinner" aria-hidden /> {progress}</span>}
          <button className="ghost sm" onClick={onClose} disabled={busy}>Huỷ</button>
          <button className="sm" disabled={!canExport} onClick={() => void doExport()}
            title={canExport ? 'Tải file .xlsx' : 'Cần tiêu đề + ít nhất 1 cột'}>
            {busy ? <span className="spinner" aria-hidden /> : '⬇'} Xuất .xlsx
          </button>
        </div>
      </div>
    </div>
  );
}
