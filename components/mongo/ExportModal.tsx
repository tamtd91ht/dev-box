'use client';

// Xuất kết quả Mongo ra .xlsx có định dạng.
//
// Người dùng đặt tên báo cáo rồi khai cột: tên cột ↔ field code ↔ định dạng ↔
// ký tự phân cách. 'Auto' tự nhận theo giá trị — số giữ là số, epoch (giây hoặc
// mili) thành date-cell thật của Excel — còn hai định dạng ngày tường minh theo
// quy ước nhà: `dd/MM/yyyy` và `HH:mm:ss dd/MM/yyyy`.
//
// FIELD CODE ĐI XUYÊN LIST OBJECT: "deviceInfos.deviceId" gom deviceId của mọi
// phần tử trong mảng deviceInfos, nối lại bằng ký tự phân cách của cột (xem
// collectByPath ở lib/mongoReport).
//
// Export chạy lại CHÍNH filter đó ở server và lật hết trang, nên file chứa toàn
// bộ tập khớp chứ không phải mỗi trang đang xem. Projection chỉ lấy các field
// cấp 1 được nhắc tới cho nhẹ đường truyền. Dựng file ở trình duyệt
// (lib/mongoReport — ExcelJS nạp động).
//
// PHÂN TRANG: không sort riêng thì đi bằng CURSOR _id (sort _id tăng dần, trang
// sau lọc `_id > _id cuối`) — skip sâu dần trên collection lớn chậm dần đều. Có
// sort riêng của người dùng thì buộc phải dùng skip, vì cursor chỉ đúng khi sắp
// theo đúng khoá làm cursor.

import { useCallback, useMemo, useState } from 'react';
import { findMongo, countMongo, withIdCursor } from '@/lib/mongo';
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
/** Số cột dữ liệu gợi ý sẵn — để bảng khai báo không phải cuộn ngay từ đầu. */
const MAX_DEFAULT_COLUMNS = 5;

export interface ExportModalProps {
  connectionId: string;
  db: string;
  coll: string;
  /** EJSON filter của truy vấn đang xuất (lấy từ lần chạy gần nhất). */
  filter: string;
  /** Sort EJSON của LẦN CHẠY vừa rồi — file xuất phải cùng thứ tự bảng đang
   *  nhìn. Rỗng = không sort (khi đó export đi bằng cursor _id). */
  sort?: string;
  /** Mô tả sort cho hộp thoại xác nhận, vd "created_at ↓ · name ↑". */
  sortSummary?: string;
  /** Tóm tắt ngắn hiện ở phụ đề sheet, vd `{domain:alice}`. */
  querySummary: string;
  /** Gợi ý tên field (đã phát hiện + path của preset) cho bảng khai cột. */
  fieldSuggestions: string[];
  /** Path chọn sẵn (từ projection của lần chạy, hoặc field của preset). */
  initialPaths: string[];
  defaultTitle: string;
  onClose: () => void;
  onDone: (rows: number, filename: string) => void;
}

export default function ExportModal(props: ExportModalProps) {
  const {
    connectionId, db, coll, filter, sort, sortSummary, querySummary,
    fieldSuggestions, initialPaths, defaultTitle, onClose, onDone,
  } = props;

  const [title, setTitle] = useState(defaultTitle);
  const [columns, setColumns] = useState<ColumnDraft[]>(() => initialColumns(initialPaths, MAX_DEFAULT_COLUMNS));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bật hộp thoại xác nhận — chỉ sau khi đã khai xong cột. */
  const [confirming, setConfirming] = useState(false);

  const validColumns = useMemo(() => columns.filter((c) => c.path.trim()), [columns]);
  const canExport = !busy && !!title.trim() && validColumns.length > 0;

  /** Đếm cho hộp thoại xác nhận — cùng filter, để người dùng liệu trước. */
  const countRows = useCallback(async () => {
    const r = await countMongo(connectionId, db, coll, filter);
    return r.count;
  }, [connectionId, db, coll, filter]);

  const doExport = async () => {
    setConfirming(false);
    setBusy(true); setError(null);
    try {
      // Projection: chỉ field cấp 1 được nhắc tới mới đi qua đường truyền
      // (__no là số thứ tự dựng ở client, không phải field của document).
      const tops = [...new Set(validColumns.map((c) => c.path.split('.')[0]))].filter((t) => t !== NO_COLUMN_PATH);
      const proj: Record<string, 0 | 1> = {};
      for (const t of tops) if (t !== '_id') proj[t] = 1;
      // _id phải có mặt khi đi bằng cursor — nó là khoá lật trang.
      const needIdForCursor = !sort?.trim();
      if (!tops.includes('_id') && !needIdForCursor) proj._id = 0;
      const projection = JSON.stringify(proj);

      const userSort = sort?.trim() ?? '';
      const effSort = userSort || JSON.stringify({ _id: 1 });

      const { rows, capped } = await runExport<{ skip: number; lastId: unknown }>({
        max: MAX_EXPORT_ROWS,
        onProgress: (n) => setProgress(`Đang tải dữ liệu… ${n.toLocaleString('en-US')} dòng`),
        fetchPage: async (cursor) => {
          // Có sort của người dùng → buộc dùng skip (cursor _id chỉ đúng khi
          // sắp theo chính _id). Không sort → cursor _id, nhanh và ổn định.
          const useCursor = !userSort;
          const pageFilter = useCursor && cursor?.lastId !== undefined
            ? withIdCursor(filter, cursor.lastId)
            : filter;
          const page = await findMongo(connectionId, db, coll, {
            filter: pageFilter,
            projection,
            sort: effSort,
            limit: PAGE,
            skip: useCursor ? 0 : (cursor?.skip ?? 0),
          });
          const parsed = parseRows(page.docs);
          const lastId = parsed.length ? parsed[parsed.length - 1]._id : undefined;
          return {
            rows: parsed,
            next: page.hasMore ? { skip: (cursor?.skip ?? 0) + PAGE, lastId } : null,
          };
        },
      });

      setProgress(`Đang dựng file Excel… ${rows.length.toLocaleString('en-US')} dòng`);
      const blob = await buildReportXlsx(
        {
          title: title.trim(),
          target: `${db}.${coll}`,
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
          <h3 style={{ margin: 0, flex: 1 }}>📄 Xuất báo cáo — {db}.{coll}</h3>
          <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <label className="mongo-field" style={{ marginBottom: 8 }}>
          <span>Tiêu đề báo cáo (hiện trên đầu sheet + tên file)</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)}
            disabled={busy} placeholder="Báo cáo tenant theo domain" />
        </label>

        <div className="mongo-field" style={{ marginBottom: 4, minHeight: 0 }}>
          <span>Cột báo cáo (tên cột · field code · định dạng · phân cách)</span>
          <ColumnMapper
            columns={columns}
            setColumns={setColumns}
            fieldSuggestions={fieldSuggestions}
            datalistId="mongo-export-fields"
            prefix="mongo"
            placeholder="field code (vd. deviceInfos.deviceId)"
            disabled={busy}
          />
        </div>

        <p className="mongo-qf-hint" style={{ marginBottom: 8 }}>
          Xuất <b>toàn bộ</b> kết quả khớp query <code>{querySummary}</code> (không chỉ trang đang xem,
          trần {MAX_EXPORT_ROWS.toLocaleString('en-US')} dòng). Field trong <b>list object</b> khai dạng
          <code> deviceInfos.deviceId</code> — các giá trị nối bằng ký tự ở ô phân cách (mặc định <code>, </code>).
        </p>

        {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {progress && <span className="badge"><span className="spinner" aria-hidden /> {progress}</span>}
          <button className="ghost sm" onClick={onClose} disabled={busy}>Huỷ</button>
          <button className="sm" disabled={!canExport} onClick={() => setConfirming(true)}
            title={canExport ? 'Xem số lượng rồi xác nhận' : 'Cần tiêu đề + ít nhất 1 cột có field code'}>
            {busy ? <span className="spinner" aria-hidden /> : '⬇'} Xuất .xlsx
          </button>
        </div>
      </div>
    </div>

    {confirming && (
      <ConfirmExportModal
        target={`${db}.${coll}`}
        querySummary={querySummary}
        columnCount={validColumns.length}
        sortSummary={sortSummary}
        count={countRows}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void doExport()}
      />
    )}
    </>
  );
}
