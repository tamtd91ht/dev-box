'use client';

// Export the current quick-find result set as a styled .xlsx report.
//
// The operator names the report, then maps columns: header text ↔ field code
// (datalist-suggested from the discovered fields) ↔ format. 'Auto' detects per
// value — numbers stay numbers, epoch timestamps (s or ms) become real Excel
// date cells — and the two explicit date formats match the house convention:
// `dd/MM/yyyy` and `HH:mm:ss dd/MM/yyyy`.
//
// The export re-queries the SAME filter server-side and walks every page (200
// docs/page, capped at MAX_EXPORT_DOCS) so the file contains the full match
// set, not just the page on screen. A projection of just the referenced
// top-level fields keeps the transfer light. Building happens in the browser
// (lib/mongoReport — ExcelJS via dynamic import).

import { useMemo, useState } from 'react';
import { findMongo } from '@/lib/mongo';
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
/** Default suggested data columns — keep the mapper visible without scrolling. */
const MAX_DEFAULT_COLUMNS = 5;

export interface ExportModalProps {
  connectionId: string;
  db: string;
  coll: string;
  /** EJSON filter string of the query being exported (from the last run). */
  filter: string;
  /** Compact summary shown in the sheet subtitle, e.g. `{domain:alice}`. */
  querySummary: string;
  /** Field-name suggestions (discovered + preset paths) for the column mapper. */
  fieldSuggestions: string[];
  /** Preselected paths (from the run's projection, or preset fields). */
  initialPaths: string[];
  defaultTitle: string;
  onClose: () => void;
  onDone: (rows: number, filename: string) => void;
}

interface ColumnDraft extends ReportColumn { key: number; }

/** "is_deleted" / "createdAt" → "Is Deleted" / "Created At" — editable anyway. */
function prettyHeader(path: string): string {
  if (path === NO_COLUMN_PATH) return 'STT';
  const last = path.split('.').pop() ?? path;
  return last
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

export default function ExportModal(props: ExportModalProps) {
  const { connectionId, db, coll, filter, querySummary, fieldSuggestions, initialPaths, defaultTitle, onClose, onDone } = props;

  const [title, setTitle] = useState(defaultTitle);
  let seq = 0;
  // STT (row number) leads by default — removable like any column. Data columns
  // are capped so the mapper fits the frame; the rest stay in the datalist.
  const [columns, setColumns] = useState<ColumnDraft[]>(() => [
    { key: seq++, header: 'STT', path: NO_COLUMN_PATH, format: 'number' as ColumnFormat },
    ...(initialPaths.length ? initialPaths : ['_id']).slice(0, MAX_DEFAULT_COLUMNS).map((p) => ({
      key: seq++, header: p === '_id' ? 'ID' : prettyHeader(p), path: p, format: 'auto' as ColumnFormat,
    })),
  ]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const validColumns = useMemo(() => columns.filter((c) => c.path.trim()), [columns]);
  const canExport = !busy && !!title.trim() && validColumns.length > 0;

  const patch = (key: number, p: Partial<ColumnDraft>) =>
    setColumns((cs) => cs.map((c) => (c.key === key ? { ...c, ...p } : c)));

  const addColumn = () =>
    setColumns((cs) => [...cs, { key: Math.max(0, ...cs.map((c) => c.key)) + 1, header: '', path: '', format: 'auto' }]);

  const doExport = async () => {
    setBusy(true); setError(null);
    try {
      // Projection: only the referenced top-level fields travel over the wire
      // (__no is synthesized client-side, not a document field).
      const tops = [...new Set(validColumns.map((c) => c.path.split('.')[0]))].filter((t) => t !== NO_COLUMN_PATH);
      const proj: Record<string, 0 | 1> = {};
      for (const t of tops) if (t !== '_id') proj[t] = 1;
      if (!tops.includes('_id')) proj._id = 0;
      const projection = JSON.stringify(proj);

      // Walk every page of the SAME filter until exhausted or capped.
      const docs: Record<string, unknown>[] = [];
      let skip = 0;
      for (;;) {
        setProgress(`Đang tải dữ liệu… ${docs.length} dòng`);
        const page = await findMongo(connectionId, db, coll, { filter, projection, sort: '', limit: PAGE, skip });
        for (const d of page.docs) {
          try { docs.push(JSON.parse(d.json) as Record<string, unknown>); } catch { /* truncated — skip row */ }
        }
        if (!page.hasMore || docs.length >= MAX_EXPORT_DOCS) break;
        skip += PAGE;
      }
      const capped = docs.length >= MAX_EXPORT_DOCS;
      const rows = docs.slice(0, MAX_EXPORT_DOCS);

      setProgress(`Đang dựng file Excel… ${rows.length} dòng`);
      const blob = await buildReportXlsx(
        {
          title: title.trim(),
          target: `${db}.${coll}`,
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
          <h3 style={{ margin: 0, flex: 1 }}>📄 Xuất báo cáo — {db}.{coll}</h3>
          <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <label className="mongo-field" style={{ marginBottom: 8 }}>
          <span>Tiêu đề báo cáo (hiện trên đầu sheet + tên file)</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Báo cáo tenant theo domain" />
        </label>

        <div className="mongo-field" style={{ marginBottom: 4, minHeight: 0 }}>
          <span>Cột báo cáo (tên cột · field code · định dạng — Auto tự nhận chữ/số/epoch)</span>
          {/* Column rows scroll INSIDE the modal — a collection with many fields
              must not push the title/footer out of the viewport. */}
          <div className="export-colscroll">
            {columns.map((c) => (
              <div key={c.key} className="mongo-form-row" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
                <input className="input" style={{ flex: 1 }} value={c.header} placeholder="Tên cột (vd. Ngày tạo)"
                  onChange={(e) => patch(c.key, { header: e.target.value })} />
                <input className="input mono" style={{ flex: 1.2 }} value={c.path} list="mongo-export-fields"
                  placeholder="field code (vd. created_date)"
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
          <datalist id="mongo-export-fields">
            {fieldSuggestions.map((f) => <option key={f} value={f} />)}
          </datalist>
          <div><button className="ghost sm" onClick={addColumn}>+ Thêm cột</button></div>
        </div>

        <p className="mongo-qf-hint" style={{ marginBottom: 8 }}>
          Xuất <b>toàn bộ</b> kết quả khớp query <code>{querySummary}</code> (không chỉ trang đang xem,
          trần {MAX_EXPORT_DOCS.toLocaleString('en-US')} dòng). Cột thời gian: chọn
          “Ngày” → <code>dd/MM/yyyy</code>, “Ngày giờ” → <code>HH:mm:ss dd/MM/yyyy</code> — giá trị
          là date-cell thật của Excel (sort/filter chuẩn).
        </p>

        {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {progress && <span className="badge"><span className="spinner" aria-hidden /> {progress}</span>}
          <button className="ghost sm" onClick={onClose} disabled={busy}>Huỷ</button>
          <button className="sm" disabled={!canExport} onClick={() => void doExport()}
            title={canExport ? 'Tải file .xlsx' : 'Cần tiêu đề + ít nhất 1 cột có field code'}>
            {busy ? <span className="spinner" aria-hidden /> : '⬇'} Xuất .xlsx
          </button>
        </div>
      </div>
    </div>
  );
}
