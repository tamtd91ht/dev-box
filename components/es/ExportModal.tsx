'use client';

// Xuất kết quả Elasticsearch ra .xlsx — dùng hộp thoại chung (components/export/ExportDialog: khai cột, cột thời gian
// theo pattern, tách dòng theo list, nối cột từ bảng/index khác, lưu cấu hình). Ở đây chỉ còn: ô sort riêng của ES,
// cách đếm và cách phân trang.
//
// PHÂN TRANG BẰNG SCROLL, KHÔNG PHẢI from/size:
// ES chặn cứng `from + size` ở result window 10.000 — quá ngưỡng là ném lỗi, nên đường from không xuất nổi một index
// lớn. Scroll không có trần đó, không cần sort, và giữ một ảnh tĩnh của index trong lúc xuất. (Trước đây đi bằng
// search_after + `_id` làm khoá phá hoà — sai: sort `_id` cần fielddata, ES 8 tắt mặc định nên mọi lần xuất chết ngay
// trang đầu. Xem khối ghi chú phần Scroll ở lib/esClient.ts.)
//
// SORT Ở ĐÂY LÀ TUỲ CHỌN, chỉ quyết định THỨ TỰ DÒNG trong file. Ô sort điền sẵn sort của lần chạy đang nhìn (hoặc sort
// trong body) và sửa được; bỏ trống thì xuất theo thứ tự index — nhanh nhất, vẫn đủ dòng.

import { useMemo, useRef, useState } from 'react';
import { scrollStartEs, scrollNextEs, scrollClearEs, countEs } from '@/lib/es';
// Trợ lý gõ JSON dùng chung với ô query Mongo: Enter đóng ngoặc + thụt lề đúng cấp, gợi ý tên field, `asc`/`desc`.
import { smartEnter } from '@/lib/mongo';
import { tokenAt } from '@/lib/mongoSuggest';
import { buildSortMatches } from '@/lib/esSortSuggest';
import JsonSuggest, { type JsonSuggestPick } from '../JsonSuggest';
import { runExport, parseRows } from '../export/exportRun';
import ExportDialog from '../export/ExportDialog';
import type { SuggestOption } from '../SuggestInput';

const PAGE = 200;

export interface ExportModalProps {
  connectionId: string;
  index: string;
  /** Chỉ phần `query` (tab Tìm nhanh ráp sẵn). Bỏ trống khi dùng `body`. */
  query?: string;
  /** Sort JSON của LẦN CHẠY đang nhìn — chỉ để ĐIỀN SẴN ô sort của modal. Với `body` thì sort lấy từ chính body. */
  sort?: string;
  /** NGUYÊN body _search kiểu Dev Tools (tab Dữ liệu); `_source`/`size`/`sort` của lần xuất do scrollStart đè lên. */
  body?: string;
  querySummary: string;
  /** Gợi ý field code; có thể kèm nhãn kiểu field (mapping). */
  fieldSuggestions: Array<string | SuggestOption>;
  defaultTitle: string;
  onClose: () => void;
  onDone: (rows: number, filename: string) => void;
}

/** Sort điền sẵn: sort của lần chạy đang nhìn (Tìm nhanh) hoặc sort nằm trong body (tab Dữ liệu); không có thì để trống. */
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
  const { connectionId, index, query, sort, body, fieldSuggestions } = props;

  const [sortText, setSortText] = useState(() => initialSort(sort, body));
  const sortRef = useRef<HTMLTextAreaElement>(null);
  const [sortCaret, setSortCaret] = useState(0);
  /** Ô sort đang có con trỏ → mới hiện bảng gợi ý. */
  const [sortFocused, setSortFocused] = useState(false);

  /** Bắt sort hỏng NGAY TRÊN FORM — khỏi đi qua hộp xác nhận rồi mới nhận lỗi từ ES. */
  const sortError = useMemo(() => {
    if (!sortText.trim()) return null;
    try { JSON.parse(sortText); return null; } catch (e) { return `Sort không phải JSON hợp lệ: ${(e as Error).message}`; }
  }, [sortText]);

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
    () => buildSortMatches(fieldSuggestions.map((f) => (typeof f === 'string' ? f : f.value)), sortText, sortToken),
    [fieldSuggestions, sortText, sortToken],
  );

  const pickSort = (r: JsonSuggestPick) => {
    const next = sortText.slice(0, r.from) + r.text + sortText.slice(r.to);
    applySort(next, r.from + (r.caretOffset ?? r.text.length), r.selectLen ?? 0);
  };

  const sortBox = (
    <label className="mongo-field">
      <span>Sắp xếp (JSON — gõ tên field để gợi ý; bỏ trống = theo thứ tự index, nhanh nhất)</span>
      <div className="json-suggest-wrap">
        <textarea
          ref={sortRef}
          className="input mono"
          rows={2}
          value={sortText}
          placeholder='[{"created_at": "desc"}]'
          onChange={(e) => { setSortText(e.target.value); setSortCaret(e.target.selectionStart); }}
          onFocus={(e) => { setSortFocused(true); setSortCaret(e.target.selectionStart); }}
          onBlur={() => setSortFocused(false)}
          onSelect={(e) => setSortCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={(e) => {
            // `defaultPrevented` là BẮT BUỘC: JsonSuggest nghe ở capture phase nên khi nó vừa chèn một field bằng
            // Enter, handler này vẫn chạy tiếp — không chặn thì cùng một phím Enter vừa chèn vừa format.
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
  );

  return (
    <ExportDialog
      target={index}
      querySummary={props.querySummary}
      sortSummary={sortText.trim() || 'theo thứ tự index'}
      fieldSuggestions={fieldSuggestions}
      defaultTitle={props.defaultTitle}
      placeholder="field code (vd. deviceInfos.deviceId)"
      allowExplode
      allowJoin
      extra={sortBox}
      blocked={!!sortError}
      countRows={async () => (await countEs(connectionId, index, query ?? '', body)).count}
      fetchRows={async ({ paths, max, onProgress }) => {
        const tops = paths.filter((t) => t !== '_id');
        const source = tops.length ? JSON.stringify(tops) : '';
        // Con trỏ của vòng lặp là scroll_id. Giữ riêng một biến ngoài để còn ĐÓNG được scroll ở finally — kể cả khi
        // lỗi giữa chừng hay người dùng bỏ dở.
        let scrollId: string | null = null;
        try {
          return await runExport<string>({
            max,
            onProgress,
            fetchPage: async (cursor) => {
              // Trang đầu mở scroll (server ráp body từ `body` hoặc `query` rời), các trang sau chỉ cần con trỏ.
              const page = cursor === undefined
                ? await scrollStartEs(connectionId, index, { body, query, sort: sortText, source, size: PAGE })
                : await scrollNextEs(connectionId, cursor);
              scrollId = page.scrollId;
              // Còn dòng mà không có con trỏ thì DỪNG HẲN bằng lỗi, không im lặng trả về trang đầu: xuất thiếu dòng
              // mà file vẫn mở được là kiểu hỏng không ai phát hiện ra.
              if (page.docs.length > 0 && !page.scrollId) {
                throw new Error('Cụm không trả scroll_id nên không lật được trang tiếp — dừng để file không bị thiếu dòng.');
              }
              // Scroll báo hết bằng một trang RỖNG, không phải trang ngắn.
              return { rows: parseRows(page.docs), next: page.docs.length === 0 ? null : page.scrollId };
            },
          });
        } finally {
          // Trả context cho cụm — có trần max_open_scroll_context, bỏ rác lại mỗi lần xuất là tự bắn vào chân mình.
          if (scrollId) void scrollClearEs(connectionId, scrollId);
        }
      }}
      onClose={props.onClose}
      onDone={props.onDone}
    />
  );
}
