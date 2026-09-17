'use client';

// Xuất kết quả Elasticsearch ra .xlsx có định dạng — cùng engine với tab
// Mongo/PG (lib/mongoReport).
//
// FIELD CODE ĐI XUYÊN LIST OBJECT: "deviceInfos.deviceId" gom deviceId của mọi
// phần tử, nối bằng ký tự phân cách của cột (xem collectByPath).
//
// PHÂN TRANG BẰNG SCROLL, KHÔNG PHẢI from/size:
// ES chặn cứng `from + size` ở result window 10.000 — quá ngưỡng là ném lỗi,
// nên đường from không xuất nổi một index lớn. Scroll không có trần đó, không
// cần sort, và giữ một ảnh tĩnh của index trong lúc xuất.
//
// Trước đây chỗ này đi bằng search_after và tự nối `_id` vào sort làm khoá phá
// hoà — sai: sort `_id` cần fielddata, ES 8 tắt mặc định nên MỌI lần xuất chết
// ngay từ trang đầu với "all shards failed". Xem khối ghi chú ở lib/esClient.ts
// (phần Scroll) để biết vì sao không có khoá phá hoà nào dùng được ở mọi cụm.
//
// SORT Ở ĐÂY LÀ TUỲ CHỌN, chỉ quyết định THỨ TỰ DÒNG trong file. Ô sort dưới
// đây điền sẵn sort của lần chạy đang nhìn (hoặc sort trong body) và sửa được;
// bỏ trống thì xuất theo thứ tự index — nhanh nhất, vẫn đủ dòng.

import { useCallback, useMemo, useRef, useState } from 'react';
import { scrollStartEs, scrollNextEs, scrollClearEs, countEs } from '@/lib/es';
import {
  buildReportXlsx,
  downloadBlob,
  reportFilename,
  MAX_EXPORT_ROWS,
  NO_COLUMN_PATH,
} from '@/lib/mongoReport';
import ColumnMapper, { hasDataColumn, initialColumns, toReportColumns, type ColumnDraft } from '../export/ColumnMapper';
// Trợ lý gõ JSON dùng chung với ô query Mongo (cùng lẽ như lib/mongoReport là
// engine xuất file dùng chung cho cả ba tab): Enter đóng ngoặc + thụt lề đúng
// cấp, gợi ý tên field, `asc`/`desc` ở chỗ đặt giá trị.
import { smartEnter } from '@/lib/mongo';
import { tokenAt } from '@/lib/mongoSuggest';
import { buildSortMatches } from '@/lib/esSortSuggest';
import JsonSuggest, { type JsonSuggestPick } from '../JsonSuggest';
import ConfirmExportModal from '../export/ConfirmExportModal';
import { runExport, parseRows } from '../export/exportRun';

const PAGE = 200;

export interface ExportModalProps {
  connectionId: string;
  index: string;
  /** Chỉ phần `query` (tab Tìm nhanh ráp sẵn). Bỏ trống khi dùng `body`. */
  query?: string;
  /**
   * Sort JSON của LẦN CHẠY đang nhìn — chỉ dùng để ĐIỀN SẴN ô sort của modal,
   * người dùng sửa hoặc xoá được. Với `body` thì sort lấy từ chính body.
   */
  sort?: string;
  /**
   * NGUYÊN body _search kiểu Dev Tools (tab Dữ liệu). Phần `query` trong đó là
   * cái quyết định xuất ra tập nào; `_source`/`size`/`sort` của lần xuất do
   * scrollStart đè lên (xem lib/esClient).
   */
  body?: string;
  querySummary: string;
  fieldSuggestions: string[];
  defaultTitle: string;
  onClose: () => void;
  onDone: (rows: number, filename: string) => void;
}

/**
 * Sort điền sẵn vào ô của modal: sort của lần chạy đang nhìn (tab Tìm nhanh),
 * hoặc sort nằm trong body (tab Dữ liệu). Không có thì để trống — khi đó xuất
 * theo thứ tự index, vẫn đủ dòng.
 */
function initialSort(sort?: string, body?: string): string {
  if (sort?.trim()) return sort.trim();
  if (body?.trim()) {
    try {
      const parsed = JSON.parse(body) as { sort?: unknown };
      if (parsed.sort !== undefined && parsed.sort !== null) return JSON.stringify(parsed.sort);
    } catch { /* body đang gõ dở — để trống, không đoán */ }
  }
  return '';
}

export default function ExportModal(props: ExportModalProps) {
  const {
    connectionId, index, query, sort, body, querySummary,
    fieldSuggestions, defaultTitle, onClose, onDone,
  } = props;

  const [title, setTitle] = useState(defaultTitle);
  /**
   * Sort của LẦN XUẤT — điền sẵn theo cái đang nhìn rồi để người dùng toàn
   * quyền. Trước đây sort bị ráp ngầm trong code, gõ sai chỗ nào cũng không
   * biết mà sửa; giờ nó nằm ngay trên màn hình xuất.
   */
  const [sortText, setSortText] = useState(() => initialSort(sort, body));
  const sortRef = useRef<HTMLTextAreaElement>(null);
  const [sortCaret, setSortCaret] = useState(0);
  /** Ô sort đang có con trỏ → mới hiện bảng gợi ý. */
  const [sortFocused, setSortFocused] = useState(false);
  const [columns, setColumns] = useState<ColumnDraft[]>(initialColumns);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const validColumns = useMemo(() => columns.filter((c) => c.path.trim()), [columns]);
  /** Bắt sort hỏng NGAY TRÊN FORM — để người dùng không đi qua hộp xác nhận rồi
   *  mới nhận một câu lỗi từ ES. */
  const sortError = useMemo(() => {
    if (!sortText.trim()) return null;
    try { JSON.parse(sortText); return null; } catch (e) { return `Sort không phải JSON hợp lệ: ${(e as Error).message}`; }
  }, [sortText]);
  const canExport = !busy && !!title.trim() && hasDataColumn(columns) && !sortError;

  /** Thay text ô sort rồi đặt lại con trỏ (và vùng bôi đen) sau khi React vẽ. */
  const applySort = (text: string, caret: number, selectLen = 0) => {
    setSortText(text);
    setSortCaret(caret);
    requestAnimationFrame(() => {
      sortRef.current?.focus();
      sortRef.current?.setSelectionRange(caret, caret + selectLen);
    });
  };

  const sortToken = sortFocused ? tokenAt(sortText, sortCaret) : null;
  const sortMatches = useMemo(
    () => buildSortMatches(fieldSuggestions, sortText, sortToken),
    [fieldSuggestions, sortText, sortToken],
  );

  const pickSort = (r: JsonSuggestPick) => {
    const next = sortText.slice(0, r.from) + r.text + sortText.slice(r.to);
    applySort(next, r.from + (r.caretOffset ?? r.text.length), r.selectLen ?? 0);
  };

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

      // Con trỏ của vòng lặp là scroll_id. Giữ riêng một biến ngoài để còn ĐÓNG
      // được scroll ở finally — kể cả khi lỗi giữa chừng hay người dùng bỏ dở.
      let scrollId: string | null = null;
      try {
        const { rows, capped } = await runExport<string>({
          max: MAX_EXPORT_ROWS,
          onProgress: (n) => setProgress(`Đang tải dữ liệu… ${n.toLocaleString('en-US')} dòng`),
          fetchPage: async (cursor) => {
            // Trang đầu mở scroll (server ráp body từ `body` hoặc `query` rời),
            // các trang sau chỉ cần con trỏ.
            const page = cursor === undefined
              ? await scrollStartEs(connectionId, index, { body, query, sort: sortText, source, size: PAGE })
              : await scrollNextEs(connectionId, cursor);
            scrollId = page.scrollId;
            // Còn dòng mà không có con trỏ thì DỪNG HẲN bằng lỗi, không im lặng
            // trả về trang đầu: xuất thiếu dòng mà file vẫn mở được là kiểu hỏng
            // không ai phát hiện ra.
            if (page.docs.length > 0 && !page.scrollId) {
              throw new Error('Cụm không trả scroll_id nên không lật được trang tiếp — dừng để file không bị thiếu dòng.');
            }
            return {
              rows: parseRows(page.docs),
              // Scroll báo hết bằng một trang RỖNG, không phải trang ngắn.
              next: page.docs.length === 0 ? null : page.scrollId,
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
      } finally {
        // Trả context cho cụm — có trần max_open_scroll_context, bỏ rác lại mỗi
        // lần xuất là tự bắn vào chân mình trên cụm dùng chung.
        if (scrollId) void scrollClearEs(connectionId, scrollId);
      }
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

        <label className="es-field" style={{ marginBottom: 8 }}>
          <span>Sắp xếp (JSON — gõ tên field để gợi ý; bỏ trống = theo thứ tự index, nhanh nhất)</span>
          <div className="json-suggest-wrap">
            <textarea
              ref={sortRef}
              className="input mono"
              rows={2}
              value={sortText}
              disabled={busy}
              placeholder='[{"created_at": "desc"}]'
              onChange={(e) => { setSortText(e.target.value); setSortCaret(e.target.selectionStart); }}
              onFocus={(e) => { setSortFocused(true); setSortCaret(e.target.selectionStart); }}
              onBlur={() => setSortFocused(false)}
              onSelect={(e) => setSortCaret((e.target as HTMLTextAreaElement).selectionStart)}
              onKeyDown={(e) => {
                // `defaultPrevented` là BẮT BUỘC: JsonSuggest nghe ở capture phase
                // nên khi nó vừa chèn một field bằng Enter, handler này vẫn chạy
                // tiếp — không chặn thì cùng một phím Enter vừa chèn vừa format.
                if (e.key !== 'Enter' || e.shiftKey || e.defaultPrevented) return;
                const el = e.currentTarget;
                if (el.selectionStart !== el.selectionEnd) return;
                const r = smartEnter(sortText, el.selectionStart);
                if (!r) return;
                e.preventDefault();
                applySort(r.text, r.caret);
              }}
            />
            {sortFocused && <JsonSuggest matches={sortMatches} token={sortToken} onPick={pickSort} />}
          </div>
          {sortError && <span className="mongo-json-err">{sortError}</span>}
        </label>

        <div className="es-field" style={{ marginBottom: 4, minHeight: 0 }}>
          <span>Cột báo cáo (tên cột · field code · định dạng · phân cách · ⋯ đổi giá trị)</span>
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
        sortSummary={sortText.trim() || 'theo thứ tự index'}
        count={countRows}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void doExport()}
      />
    )}
    </>
  );
}
