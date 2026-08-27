'use client';

// Export the current ES quick-find result set as a styled .xlsx report.
// Same UX + workbook styling as the Mongo tab (lib/mongoReport is generic):
// title, column mapper (header ↔ field code ↔ format with epoch detection and
// the dd/MM/yyyy · HH:mm:ss dd/MM/yyyy date formats). Re-queries the SAME
// query server-side page by page (200/hit page, capped) so the file holds the
// full match set — with a `_source` of just the referenced fields.

import { useMemo, useState } from 'react';
import { searchEs } from '@/lib/es';
import {
  buildReportXlsx,
  downloadBlob,
  reportFilename,
  COLUMN_FORMATS,
  NO_COLUMN_PATH,
  type ReportColumn,
  type ColumnFormat,
} from '@/lib/mongoReport';

/** ES from+size window is 10 000 — stay under it. */
const MAX_EXPORT_DOCS = 5000;
const PAGE = 200;
/** Default suggested data columns — keep the mapper visible without scrolling. */
const MAX_DEFAULT_COLUMNS = 5;

export interface ExportModalProps {
  connectionId: string;
  index: string;
  /**
   * Chỉ phần `query` (tab Tìm nhanh ráp sẵn). Bỏ trống khi dùng `body`.
   */
  query?: string;
  /**
   * Sort JSON kèm theo `query` (tab Tìm nhanh) — rỗng = không sort. File xuất
   * ra phải cùng thứ tự với bảng người dùng đang nhìn, nên chỗ gọi truyền sort
   * của LẦN CHẠY vừa rồi. Bỏ qua khi dùng `body` (sort đã nằm trong body).
   */
  sort?: string;
  /**
   * NGUYÊN body _search kiểu Dev Tools (tab Dữ liệu). Có `body` thì server bỏ
   * qua mọi field rời — nên `_source` và `size` phải chèn thẳng vào body, xem
   * buildBodyPage() bên dưới.
   */
  body?: string;
  querySummary: string;
  fieldSuggestions: string[];
  initialPaths: string[];
  defaultTitle: string;
  onClose: () => void;
  onDone: (rows: number, filename: string) => void;
}

/**
 * Ráp body cho MỘT trang export khi nguồn là body _search nguyên bản.
 *
 * Vì sao phải viết lại body thay vì truyền `source`/`size` rời: server ưu tiên
 * `body` và BỎ QUA các field rời khi body có nội dung (xem search() ở
 * lib/esClient). Nên muốn export chỉ lấy đúng field đang cần + phân trang đủ
 * lớn thì phải sửa ngay trong body.
 *
 * Giữ nguyên phần còn lại của body người dùng gõ (query, sort, aggs…): export
 * phải ra ĐÚNG tập kết quả họ đang nhìn, không phải một truy vấn khác.
 * `aggs` bị bỏ — export là bảng dòng, phần thống kê không dùng tới và giữ lại
 * chỉ tốn thời gian tính ở mỗi trang.
 */
function buildBodyPage(raw: string, tops: string[], size: number, from: number): string {
  let parsed: Record<string, unknown> = {};
  if (raw.trim()) {
    try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { parsed = {}; }
  }
  const next: Record<string, unknown> = { ...parsed, size, from };
  delete next.aggs;
  delete next.track_total_hits;
  if (tops.length) next._source = tops;
  return JSON.stringify(next);
}

interface ColumnDraft extends ReportColumn { key: number; }

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
  const { connectionId, index, query, sort, body, querySummary, fieldSuggestions, initialPaths, defaultTitle, onClose, onDone } = props;

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

  const doExport = async () => {
    setBusy(true); setError(null);
    try {
      const tops = [...new Set(validColumns.map((c) => c.path.split('.')[0]))]
        .filter((t) => t !== '_id' && t !== NO_COLUMN_PATH); // __no is synthesized client-side
      const source = tops.length ? JSON.stringify(tops) : '';

      const docs: Record<string, unknown>[] = [];
      let from = 0;
      for (;;) {
        setProgress(`Đang tải dữ liệu… ${docs.length} dòng`);
        // Hai nguồn: body nguyên bản (tab Dữ liệu) thì phân trang bằng cách
        // viết lại body; query rời (tab Tìm nhanh) thì truyền field rời như cũ.
        const page = body !== undefined
          ? await searchEs(connectionId, index, { body: buildBodyPage(body, tops, PAGE, from) })
          : await searchEs(connectionId, index, { query, sort: sort ?? '', source, size: PAGE, from });
        for (const d of page.docs) {
          try { docs.push(JSON.parse(d.json) as Record<string, unknown>); } catch { /* truncated — skip row */ }
        }
        if (page.docs.length < PAGE || docs.length >= MAX_EXPORT_DOCS) break;
        from += PAGE;
      }
      const capped = docs.length >= MAX_EXPORT_DOCS;
      const rows = docs.slice(0, MAX_EXPORT_DOCS);

      setProgress(`Đang dựng file Excel… ${rows.length} dòng`);
      const blob = await buildReportXlsx(
        {
          title: title.trim(),
          target: index,
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
          <h3 style={{ margin: 0, flex: 1 }}>📄 Xuất báo cáo — {index}</h3>
          <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <label className="es-field" style={{ marginBottom: 8 }}>
          <span>Tiêu đề báo cáo (hiện trên đầu sheet + tên file)</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Báo cáo customer theo tenant" />
        </label>

        <div className="es-field" style={{ marginBottom: 4, minHeight: 0 }}>
          <span>Cột báo cáo (tên cột · field code · định dạng — Auto tự nhận chữ/số/epoch)</span>
          {/* Column rows scroll INSIDE the modal — an index with many fields
              must not push the title/footer out of the viewport. */}
          <div className="export-colscroll">
            {columns.map((c) => (
              <div key={c.key} className="es-form-row" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
                <input className="input" style={{ flex: 1 }} value={c.header} placeholder="Tên cột (vd. Ngày tạo)"
                  onChange={(e) => patch(c.key, { header: e.target.value })} />
                <input className="input mono" style={{ flex: 1.2 }} value={c.path} list="es-export-fields"
                  placeholder="field code (vd. createdAt)"
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
          <datalist id="es-export-fields">
            {fieldSuggestions.map((f) => <option key={f} value={f} />)}
          </datalist>
          <div>
            <button className="ghost sm" onClick={() => setColumns((cs) => [...cs, { key: Math.max(0, ...cs.map((c) => c.key)) + 1, header: '', path: '', format: 'auto' }])}>
              + Thêm cột
            </button>
          </div>
        </div>

        <p className="es-hint" style={{ marginBottom: 8 }}>
          Xuất <b>toàn bộ</b> kết quả khớp query <code>{querySummary}</code> (không chỉ trang đang xem,
          trần {MAX_EXPORT_DOCS.toLocaleString('en-US')} dòng). Cột thời gian: “Ngày” → <code>dd/MM/yyyy</code>,
          “Ngày giờ” → <code>HH:mm:ss dd/MM/yyyy</code> — date-cell thật của Excel.
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
