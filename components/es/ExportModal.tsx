'use client';

// Xuất kết quả Elasticsearch ra .xlsx có định dạng — cùng engine với tab
// Mongo/PG (lib/mongoReport).
//
// FIELD CODE ĐI XUYÊN LIST OBJECT: "deviceInfos.deviceId" gom deviceId của mọi
// phần tử, nối bằng ký tự phân cách của cột (xem collectByPath).
//
// PHÂN TRANG BẰNG search_after, KHÔNG PHẢI from/size:
// ES chặn cứng `from + size` ở result window 10.000 — quá ngưỡng là ném lỗi,
// nên đường from cũ không xuất nổi một index lớn. `search_after` không có trần
// đó và không bắt ES sắp lại toàn bộ ở mỗi trang.
//
// search_after BẮT BUỘC có sort, và sort phải ĐỊNH DANH được từng document, nếu
// không hai document "bằng điểm" sẽ nhảy qua nhảy lại giữa các trang → xuất
// trùng dòng hoặc sót dòng. Người dùng khai sort bao nhiêu khoá tuỳ ý; ta luôn
// NỐI THÊM `_id` vào cuối làm khoá phá hoà (xem withTieBreaker).

import { useCallback, useMemo, useState } from 'react';
import { searchEs, countEs } from '@/lib/es';
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
  index: string;
  /** Chỉ phần `query` (tab Tìm nhanh ráp sẵn). Bỏ trống khi dùng `body`. */
  query?: string;
  /**
   * Sort JSON kèm `query` (tab Tìm nhanh) — rỗng = không sort. File xuất phải
   * cùng thứ tự với bảng đang nhìn, nên chỗ gọi truyền sort của LẦN CHẠY vừa
   * rồi. Bỏ qua khi dùng `body` (sort đã nằm trong body).
   */
  sort?: string;
  /** Mô tả sort cho hộp thoại xác nhận. */
  sortSummary?: string;
  /**
   * NGUYÊN body _search kiểu Dev Tools (tab Dữ liệu). Có `body` thì server bỏ
   * qua mọi field rời — nên `_source`/`size`/`sort` phải chèn thẳng vào body,
   * xem buildBodyPage().
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
 * Nối `_id` vào cuối danh sách sort làm khoá PHÁ HOÀ cho search_after.
 *
 * Không có khoá định danh thì các document có cùng giá trị sort không có thứ tự
 * ổn định giữa hai request — con trỏ search_after sẽ nhảy lung tung, file xuất
 * ra trùng dòng hoặc sót dòng mà không báo lỗi gì. Đây là lỗi âm thầm, nguy
 * hiểm hơn hẳn một lỗi ném ra mặt.
 *
 * Đã có `_id` (hoặc `_doc`, `_shard_doc`) trong sort rồi thì giữ nguyên.
 * Ghi chú hiệu năng: trên ES 7+ `_id` sort được mà không cần fielddata, nhưng
 * với index rất lớn nó chậm hơn `_shard_doc` — đổi sau nếu thực tế thấy chậm.
 */
export function withTieBreaker(sortKeys: unknown[]): unknown[] {
  const names = sortKeys.map((k) => {
    if (typeof k === 'string') return k;
    if (k && typeof k === 'object') return Object.keys(k as object)[0] ?? '';
    return '';
  });
  if (names.some((n) => n === '_id' || n === '_doc' || n === '_shard_doc')) return sortKeys;
  return [...sortKeys, { _id: 'asc' }];
}

/** sort JSON (chuỗi) → mảng khoá đã kèm tie-breaker. Rỗng → chỉ `_id`. */
function sortWithTie(raw?: string): unknown[] {
  const s = (raw ?? '').trim();
  if (!s) return [{ _id: 'asc' }]; // không khai sort → đi theo _id cho ổn định
  try {
    const parsed = JSON.parse(s);
    return withTieBreaker(Array.isArray(parsed) ? parsed : [parsed]);
  } catch {
    return [{ _id: 'asc' }]; // sort hỏng — vẫn xuất được, chỉ là theo _id
  }
}

/**
 * Ráp body cho MỘT trang export khi nguồn là body _search nguyên bản.
 *
 * Phải viết lại body thay vì truyền field rời vì server ưu tiên `body` và BỎ
 * QUA field rời khi body có nội dung (xem search() ở lib/esClient).
 *
 * Giữ nguyên phần còn lại của body người dùng gõ (query, sort, …) để export ra
 * ĐÚNG tập kết quả họ đang nhìn. `aggs` bị bỏ — export là bảng dòng, tính lại
 * aggs ở mỗi trang chỉ tốn thời gian.
 */
function buildBodyPage(raw: string, tops: string[], size: number, after?: unknown[]): string {
  let parsed: Record<string, unknown> = {};
  if (raw.trim()) {
    try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { parsed = {}; }
  }
  const next: Record<string, unknown> = { ...parsed, size };
  delete next.aggs;
  delete next.track_total_hits;
  delete next.from; // search_after không đi chung với from
  // Sort của người dùng (nếu có) + tie-breaker; không có thì _id.
  const userSort = next.sort;
  next.sort = withTieBreaker(
    userSort === undefined || userSort === null ? []
      : Array.isArray(userSort) ? userSort : [userSort],
  );
  if (tops.length) next._source = tops;
  if (after) next.search_after = after;
  return JSON.stringify(next);
}

export default function ExportModal(props: ExportModalProps) {
  const {
    connectionId, index, query, sort, sortSummary, body, querySummary,
    fieldSuggestions, initialPaths, defaultTitle, onClose, onDone,
  } = props;

  const [title, setTitle] = useState(defaultTitle);
  const [columns, setColumns] = useState<ColumnDraft[]>(() => initialColumns(initialPaths, MAX_DEFAULT_COLUMNS));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const validColumns = useMemo(() => columns.filter((c) => c.path.trim()), [columns]);
  const canExport = !busy && !!title.trim() && validColumns.length > 0;

  const countRows = useCallback(async () => {
    const r = await countEs(connectionId, index, query ?? '', body);
    return r.count;
  }, [connectionId, index, query, body]);

  const doExport = async () => {
    setConfirming(false);
    setBusy(true); setError(null);
    try {
      const tops = [...new Set(validColumns.map((c) => c.path.split('.')[0]))]
        .filter((t) => t !== '_id' && t !== NO_COLUMN_PATH); // __no dựng ở client
      const source = tops.length ? JSON.stringify(tops) : '';
      const effSort = sortWithTie(sort);

      const { rows, capped } = await runExport<unknown[]>({
        max: MAX_EXPORT_ROWS,
        onProgress: (n) => setProgress(`Đang tải dữ liệu… ${n.toLocaleString('en-US')} dòng`),
        fetchPage: async (after) => {
          // Hai nguồn: body nguyên bản (tab Dữ liệu) thì phân trang bằng cách
          // viết lại body; query rời (tab Tìm nhanh) thì truyền field rời.
          const page = body !== undefined
            ? await searchEs(connectionId, index, { body: buildBodyPage(body, tops, PAGE, after) })
            : await searchEs(connectionId, index, {
                query, sort: JSON.stringify(effSort), source, size: PAGE, searchAfter: after,
              });
          return {
            rows: parseRows(page.docs),
            // Hết dữ liệu khi trang không đầy — khi đó cũng không cần con trỏ nữa.
            next: page.docs.length < PAGE ? null : page.lastSort,
          };
        },
      });

      setProgress(`Đang dựng file Excel… ${rows.length.toLocaleString('en-US')} dòng`);
      const blob = await buildReportXlsx(
        {
          title: title.trim(),
          target: index,
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
          <h3 style={{ margin: 0, flex: 1 }}>📄 Xuất báo cáo — {index}</h3>
          <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <label className="es-field" style={{ marginBottom: 8 }}>
          <span>Tiêu đề báo cáo (hiện trên đầu sheet + tên file)</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)}
            disabled={busy} placeholder="Báo cáo customer theo tenant" />
        </label>

        <div className="es-field" style={{ marginBottom: 4, minHeight: 0 }}>
          <span>Cột báo cáo (tên cột · field code · định dạng · phân cách)</span>
          <ColumnMapper
            columns={columns}
            setColumns={setColumns}
            fieldSuggestions={fieldSuggestions}
            datalistId="es-export-fields"
            prefix="es"
            placeholder="field code (vd. deviceInfos.deviceId)"
            disabled={busy}
          />
        </div>

        <p className="es-hint" style={{ marginBottom: 8 }}>
          Xuất <b>toàn bộ</b> kết quả khớp query <code>{querySummary}</code> (không chỉ trang đang xem,
          trần {MAX_EXPORT_ROWS.toLocaleString('en-US')} dòng, đi bằng <code>search_after</code> nên
          không vướng trần 10.000 của ES). Field trong <b>list object</b> khai dạng
          <code> deviceInfos.deviceId</code> — nối bằng ký tự ở ô phân cách (mặc định <code>, </code>).
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
        target={index}
        querySummary={querySummary}
        columnCount={validColumns.length}
        sortSummary={sortSummary || (body ? 'theo sort trong body' : '')}
        count={countRows}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void doExport()}
      />
    )}
    </>
  );
}
