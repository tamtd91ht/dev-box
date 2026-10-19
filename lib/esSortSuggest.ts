// lib/esSortSuggest.ts — gợi ý cho ô SẮP XẾP của màn xuất báo cáo ES.
//
// Cùng bộ máy với autocomplete ô query Mongo (lib/mongoSuggest: tokenAt /
// slotAt / buildMatch) — chỉ khác hai điều, đúng như hình dạng của sort ES:
//
//   1. GIÁ TRỊ CHỈ CÓ asc | desc. Không có kiểu BSON, không có toán tử. Con trỏ
//      sau `:` thì chỉ còn hai lựa chọn đó.
//   2. SORT THƯỜNG LÀ MỘT MẢNG các object: `[{"created_at": "desc"}]`. Ở trong
//      mảng (hoặc ô còn trống) phải chèn CẢ `{…}`, chèn trần `"f": "desc"` vào
//      giữa `[ ]` là ra JSON hỏng.
//
// Chèn xong luôn BÔI ĐEN chữ `desc` để gõ `asc` là thay ngay — chiều sắp xếp là
// thứ người ta đổi nhiều nhất sau khi chọn field.

import { enclosing } from './jsonEdit';
import { buildMatch, slotAt, type Match, type Token } from './mongoSuggest';

/** Chiều sắp xếp — hết, ES sort không nhận gì khác ở vị trí này. */
export const DIRECTIONS = ['asc', 'desc'];

/** Chiều mặc định khi chèn một field mới. */
const DEFAULT_DIR = 'desc';

/** Số gợi ý hiện cùng lúc. */
const MAX_MATCHES = 8;

/**
 * Danh sách gợi ý cho ô sort. `fields` là tên field thô (không kèm kiểu).
 *
 * @param value Toàn bộ nội dung ô sort.
 * @param token Token dưới con trỏ (tokenAt của lib/mongoSuggest).
 */
export function buildSortMatches(fields: string[], value: string, token: Token | null): Match[] {
  if (!token) return [];
  const w = token.word.toLowerCase();
  const slot = slotAt(value, token);

  // Sau dấu `:` → chỗ của chiều sắp xếp.
  if (slot.bare) {
    return DIRECTIONS.filter((d) => d.startsWith(w))
      .map((d) => buildMatch(token, slot, d, 'chiều', '', 0));
  }

  // Trong MẢNG (hoặc ô còn trống) thì mỗi phần tử là một object — phải chèn cả
  // cặp ngoặc nhọn. Trong object rồi thì chỉ chèn cặp key-value như thường.
  const box = enclosing(value, token.from);
  const wrap = box !== '{';

  return fields
    .filter((f) => f.toLowerCase().includes(w))
    // Khớp từ ĐẦU tên lên trước — gõ `crea` thì `created_at` phải đứng trên `doc_created`.
    .sort((a, b) => Number(b.toLowerCase().startsWith(w)) - Number(a.toLowerCase().startsWith(w)))
    .slice(0, MAX_MATCHES)
    .map((f) => (wrap ? wrapMatch(token, slot, f) : buildMatch(token, slot, f, 'field', `"${DEFAULT_DIR}"`, 1, DEFAULT_DIR.length)));
}

/**
 * Mục gợi ý cho một phần tử MẢNG: `{"field": "desc"}`.
 *
 * `{"` + tên + `": "` = tên.length + 6 ký tự trước khi tới chữ `desc`; bôi đen
 * đúng 4 ký tự đó để gõ `asc` là thay luôn.
 */
function wrapMatch(token: Token, slot: ReturnType<typeof slotAt>, name: string): Match {
  const preview = `{"${name}": "${DEFAULT_DIR}"}`;
  return {
    label: name,
    hint: 'field',
    insert: `${preview}${slot.needComma ? ',' : ''}`,
    caretOffset: name.length + 6,
    selectLen: DEFAULT_DIR.length,
    preview,
    from: token.from,
    to: token.to,
  };
}
