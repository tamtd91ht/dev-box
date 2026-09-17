'use client';

// Xuất kết quả PG quick-find ra .xlsx — cùng UX + engine với tab Mongo/ES
// (lib/mongoReport): cột STT, timestamp epoch/ISO → date-cell thật của Excel
// (dd/MM/yyyy · HH:mm:ss dd/MM/yyyy), bề rộng tối thiểu vừa khổ A4.
//
// Chạy lại CHÍNH mệnh đề WHERE đã tham số hoá, lật từng trang (200 dòng/trang),
// chỉ SELECT các cột được nhắc tới.
//
// FIELD CODE ĐI XUYÊN LIST OBJECT: cột jsonb chứa mảng object khai được dạng
// "deviceInfos.deviceId" — gom giá trị con rồi nối bằng ký tự phân cách của cột
// (xem collectByPath ở lib/mongoReport).
//
// PHÂN TRANG: vẫn LIMIT/OFFSET như trước. Quick-find của PG chưa có sort do
// người dùng khai nên không có khoá ổn định để đi keyset; OFFSET sâu dần sẽ
// chậm trên bảng rất lớn — đổi được khi PG quick-find có sort.

import { useCallback, useMemo, useState } from 'react';
import { pgQuickFind, pgQuickCount, type PgQuickEntry } from '@/lib/pg';
import {
  buildReportXlsx,
  downloadBlob,
  reportFilename,
  MAX_EXPORT_ROWS,
  NO_COLUMN_PATH,
} from '@/lib/mongoReport';
import ColumnMapper, { initialColumns, toReportColumns, type ColumnDraft } from '../export/ColumnMapper';
import ConfirmExportModal from '../export/ConfirmExportModal';
import { runExport, parseRows } from '../export/exportRun';

const PAGE = 200;
const MAX_DEFAULT_COLUMNS = 5;

export interface ExportModalProps {
  connectionId: string;
  db: string;
  schema: string;
  table: string;
  /** Điều kiện của lần chạy đang xuất (tham số hoá ở server). */
  entries: PgQuickEntry[];
  querySummary: string;
  /** Gợi ý cột (từ information_schema). */
  fieldSuggestions: string[];
  initialPaths: string[];
  defaultTitle: string;
  onClose: () => void;
  onDone: (rows: number, filename: string) => void;
}

export default function ExportModal(props: ExportModalProps) {
  const {
    connectionId, db, schema, table, entries, querySummary,
    fieldSuggestions, initialPaths, defaultTitle, onClose, onDone,
  } = props;

  const [title, setTitle] = useState(defaultTitle);
  const [columns, setColumns] = useState<ColumnDraft[]>(() => initialColumns(initialPaths, MAX_DEFAULT_COLUMNS, ''));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const validColumns = useMemo(() => columns.filter((c) => c.path.trim()), [columns]);
  const canExport = !busy && !!title.trim() && validColumns.length > 0;

  const countRows = useCallback(async () => {
    const r = await pgQuickCount(connectionId, db, { schema, table, entries });
    return r.count;
  }, [connectionId, db, schema, table, entries]);

  const doExport = async () => {
    setConfirming(false);
    setBusy(true); setError(null);
    try {
      // Cột jsonb khai dạng "doc.field" → SELECT vẫn phải lấy cột GỐC ("doc"),
      // phần sau dấu chấm là đường đi bên trong JSON, không phải tên cột.
      const selectCols = [...new Set(
        validColumns.map((c) => c.path.split('.')[0]).filter((p) => p !== NO_COLUMN_PATH),
      )];

      const { rows, capped } = await runExport<number>({
        max: MAX_EXPORT_ROWS,
        onProgress: (n) => setProgress(`Đang tải dữ liệu… ${n.toLocaleString('en-US')} dòng`),
        fetchPage: async (offset) => {
          const at = offset ?? 0;
          const page = await pgQuickFind(connectionId, db, {
            schema, table, entries, limit: PAGE, offset: at,
            columns: selectCols.length ? selectCols : undefined,
          });
          return { rows: parseRows(page.rows), next: page.hasMore ? at + PAGE : null };
        },
      });

      setProgress(`Đang dựng file Excel… ${rows.length.toLocaleString('en-US')} dòng`);
      const blob = await buildReportXlsx(
        {
          title: title.trim(),
          target: `${db}.${schema}.${table}`,
          rowCount: rows.length,
          note: capped ? `đã cắt tại ${MAX_EXPORT_ROWS.toLocaleString('en-US')} dòng` : undefined,
        },
        toReportColumns(columns),
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
    <>
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(760px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>📄 Xuất báo cáo — {schema}.{table}</h3>
          <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <label className="pg-field" style={{ marginBottom: 8 }}>
          <span>Tiêu đề báo cáo (hiện trên đầu sheet + tên file)</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)}
            disabled={busy} placeholder="Báo cáo extension theo tenant" />
        </label>

        <div className="pg-field" style={{ marginBottom: 4, minHeight: 0 }}>
          <span>Cột báo cáo (tên cột · column · định dạng · phân cách)</span>
          <ColumnMapper
            columns={columns}
            setColumns={setColumns}
            fieldSuggestions={fieldSuggestions}
            datalistId="pg-export-fields"
            prefix="pg"
            placeholder="column (vd. created_at)"
            disabled={busy}
          />
        </div>

        <p className="pg-hint" style={{ marginBottom: 8 }}>
          Xuất <b>toàn bộ</b> kết quả khớp query <code>{querySummary}</code> (không chỉ trang đang xem,
          trần {MAX_EXPORT_ROWS.toLocaleString('en-US')} dòng). Cột <b>jsonb</b> khai được dạng
          <code> doc.field</code>; nhiều giá trị nối bằng ký tự ở ô phân cách (mặc định <code>, </code>).
        </p>

        {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {progress && <span className="badge"><span className="spinner" aria-hidden /> {progress}</span>}
          <button className="ghost sm" onClick={onClose} disabled={busy}>Huỷ</button>
          <button className="sm" disabled={!canExport} onClick={() => setConfirming(true)}
            title={canExport ? 'Xem số lượng rồi xác nhận' : 'Cần tiêu đề + ít nhất 1 cột'}>
            {busy ? <span className="spinner" aria-hidden /> : '⬇'} Xuất .xlsx
          </button>
        </div>
      </div>
    </div>

    {confirming && (
      <ConfirmExportModal
        target={`${db}.${schema}.${table}`}
        querySummary={querySummary}
        columnCount={validColumns.length}
        count={countRows}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void doExport()}
      />
    )}
    </>
  );
}
