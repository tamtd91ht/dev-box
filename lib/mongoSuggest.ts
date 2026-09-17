// lib/mongoSuggest.ts — phần thuần logic của autocomplete field trong ô query Mongo.
//
// Tách khỏi components/mongo/FieldSuggest.tsx vì cái sai ở đây luôn là "chèn ra
// chuỗi hỏng" hoặc "con trỏ nhảy sai một ô", mà mỗi ca chỉ tái hiện đúng ở một
// vị trí con trỏ cụ thể — chạy tay không soát hết được. Tách ra thì kiểm được
// bằng scripts/check-mongo-suggest.ts.
//
// CHÈN CẢ CẶP KEY-VALUE, KHÔNG CHỈ TÊN FIELD: gõ `email` rồi Enter ra
// `"email": ""` với con trỏ nằm SẴN giữa hai dấu nháy của value. Khuôn value
// bám theo kiểu BSON sample được (objectId → {"$oid": ""}, date → {"$date": ""},
// number → 0…) nên phần hay sai nhất của EJSON được điền sẵn đúng.
//
// Nhưng chỉ chèn cặp khi chỗ đó CHƯA có cặp. Hai ngoại lệ:
//   1. Con trỏ ở chỗ đặt GIÁ TRỊ (ngay sau `:`) → chỉ chèn tên trần.
//   2. Ngay sau tên field ĐÃ CÓ `: …` — đúng khung `{"": ""}` mà Enter bung ra.
//      Chèn cặp vào đấy ra `{"tenant_id": "",: ""}`: thừa cả `: ""` cũ lẫn dấu
//      phẩy. Lúc đó chỉ thay TÊN, và nếu value đang là chỗ trống `""` thì thay
//      luôn bằng khuôn đúng kiểu.

import type { FieldInfo } from './mongo';

/** Query operators worth suggesting once the user types a `$`. */
export const OPERATORS = [
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
  '$and', '$or', '$nor', '$not', '$exists', '$type', '$regex', '$options',
  '$elemMatch', '$all', '$size', '$mod', '$expr', '$text',
];

/** Toán tử nhận MẢNG làm toán hạng — chèn `[]` thay vì `""`. */
const ARRAY_OPERATORS = new Set(['$in', '$nin', '$and', '$or', '$nor', '$all']);
/** Toán tử nhận giá trị boolean. */
const BOOL_OPERATORS = new Set(['$exists']);

/** Số gợi ý hiện cùng lúc. */
const MAX_MATCHES = 8;

export interface Token {
  word: string;
  from: number;
  to: number;
  quoted: boolean;
}

export interface Match {
  /** Chuỗi hiện trên danh sách (tên field / tên toán tử). */
  label: string;
  /** Nhãn kiểu bên phải. */
  hint: string;
  /** Đoạn text thật sự được chèn. */
  insert: string;
  /** Vị trí con trỏ TRONG `insert` sau khi chèn. */
  caretOffset: number;
  /**
   * Số ký tự BÔI ĐEN từ `caretOffset` — gõ là thay luôn.
   *
   * Dành cho khuôn value là một literal đặc sệt (`0`, `true`, `null`): con trỏ
   * đứng trước nó mà không bôi đen thì gõ `30` ra `300`. Khuôn có chỗ trống sẵn
   * (`""`, `[]`, `{"$oid": ""}`) thì con trỏ đã nằm trong ruột — không bôi gì.
   */
  selectLen: number;
  /** Bản xem trước hiện mờ bên dưới label, cho biết sẽ chèn ra cái gì. */
  preview: string;
  /** Đoạn bị THAY — thường là token, nhưng có ca nuốt cả value rỗng phía sau. */
  from: number;
  to: number;
}

/**
 * The token under the caret, if it can start a field or operator name.
 *
 * `from`/`to` là ĐOẠN SẼ BỊ THAY, không chỉ là chữ đang gõ: nếu người dùng đã
 * tự mở dấu nháy (`{"ema` → con trỏ sau `ema`) thì dấu `"` đó phải nằm TRONG
 * đoạn bị thay. Không thế thì chèn `"email": ""` vào sau nó ra `{""email": ""}`
 * — dư một dấu nháy. Nháy đóng ngay sau con trỏ cũng bị nuốt cùng, vì khuôn
 * chèn đã tự mang nháy của nó.
 */
export function tokenAt(value: string, caret: number): Token | null {
  let from = caret;
  while (from > 0 && /[A-Za-z0-9_$.]/.test(value[from - 1])) from--;
  const word = value.slice(from, caret);
  if (!word) return null;

  // Lùi qua dấu nháy mở mà người dùng đã tự gõ (cả " và ').
  const quoted = from > 0 && (value[from - 1] === '"' || value[from - 1] === "'");
  if (quoted) from--;

  // Nuốt luôn dấu nháy đóng ngay sau con trỏ, nếu có, để không còn nháy mồ côi.
  let to = caret;
  if (value[to] === '"' || value[to] === "'") to++;

  return { word, from, to, quoted };
}

/**
 * Con trỏ có đang ở CHỖ ĐẶT GIÁ TRỊ không (ngay sau một `:` của cặp key-value)?
 * Bỏ qua khoảng trắng và phần token đang gõ để nhìn ký tự có nghĩa gần nhất.
 * Ở vị trí đó ta chỉ gợi ý tên field trần (vd `{"a": "$b"}`), không chèn cặp.
 */
export function atValuePosition(value: string, from: number): boolean {
  let i = from - 1;
  while (i >= 0 && /\s/.test(value[i])) i--;
  return i >= 0 && value[i] === ':';
}

/** Ký tự có nghĩa ngay sau con trỏ — dùng để biết có cần thêm dấu phẩy không. */
function nextMeaningful(value: string, caret: number): string {
  let i = caret;
  while (i < value.length && /\s/.test(value[i])) i++;
  return value[i] ?? '';
}

/**
 * Token đang gõ ĐÃ là key của một cặp sẵn có chưa (có `:` ngay sau)?
 *
 * Đây là ca của khung `{\n  "": ""\n}` mà Enter bung ra: người dùng gõ tên vào
 * dấu nháy đầu rồi chọn gợi ý. Chèn nguyên cặp vào đó sẽ ra
 * `{"tenant_id": "",: ""}` — thừa `: ""` cũ, thừa cả dấu phẩy (ký tự sau con
 * trỏ là `:` nên bị đếm nhầm là "còn nội dung phía sau").
 *
 * @returns null nếu phía sau không phải `:`. `emptyValueEnd` là vị trí kết thúc
 *   của value RỖNG (`""` / `''`) đi kèm — thay được cả nó bằng khuôn đúng kiểu;
 *   -1 nghĩa là value đã có nội dung, đừng đụng vào.
 */
export function existingPair(value: string, to: number): { emptyValueEnd: number } | null {
  let i = to;
  while (i < value.length && /\s/.test(value[i])) i++;
  if (value[i] !== ':') return null;
  i++;
  while (i < value.length && /\s/.test(value[i])) i++;
  const q = value[i];
  if ((q === '"' || q === "'") && value[i + 1] === q) return { emptyValueEnd: i + 2 };
  return { emptyValueEnd: -1 };
}

/**
 * Khuôn value theo kiểu BSON sample được. Trả về [text, vị trí con trỏ trong text].
 * Con trỏ luôn rơi vào GIỮA chỗ cần gõ tiếp (trong nháy, trong ngoặc).
 */
export function valueTemplate(type: string): [string, number] {
  switch (type) {
    // Con trỏ phải nằm GIỮA hai nháy, không phải sau nháy đóng — lệch một ô ở
    // đây là gõ ObjectId ra ngoài chuỗi, câu query hỏng mà nhìn thì rất giống đúng.
    case 'objectId': return ['{"$oid": ""}', 10];      // {"$oid": "|"}
    case 'date':     return ['{"$date": ""}', 11];     // {"$date": "|"}
    case 'number':
    case 'int':
    case 'long':
    case 'double':
    case 'decimal128': return ['0', 0];                // |0 — gõ đè được ngay
    case 'boolean':  return ['true', 0];
    case 'array':    return ['[]', 1];                 // [|]
    case 'object':   return ['{}', 1];                 // {|}
    case 'null':     return ['null', 0];
    default:         return ['""', 1];                 // "|"  (string và mọi kiểu lạ)
  }
}

/** Khuôn value cho một toán tử `$…`. */
export function operatorTemplate(op: string): [string, number] {
  if (ARRAY_OPERATORS.has(op)) return ['[]', 1];
  if (BOOL_OPERATORS.has(op)) return ['true', 0];
  return ['""', 1];
}

/**
 * Danh sách gợi ý cho token đang gõ. Rỗng = không có gì để gợi ý.
 */
export function buildMatches(fields: FieldInfo[], value: string, token: Token | null): Match[] {
  if (!token) return [];
  const w = token.word.toLowerCase();

  // Sau dấu `:` là chỗ của GIÁ TRỊ — chỉ chèn tên trần, giữ nguyên hành vi cũ.
  const bare = atValuePosition(value, token.from);
  // Đã có `: …` ngay sau → thay TÊN, không đẻ thêm cặp.
  const pair = bare ? null : existingPair(value, token.to);
  // `,` đứng ngay sau nghĩa là đã có cặp tiếp theo → không tự thêm dấu phẩy.
  // Đo từ `token.to` (đã qua nháy đóng) chứ không từ `caret`, nếu không thì
  // dấu nháy đóng sẽ bị coi là "còn nội dung phía sau" và sinh phẩy thừa.
  const after = nextMeaningful(value, token.to);
  const needComma = !bare && !pair && after !== '' && after !== ',' && after !== '}' && after !== ']';

  /**
   * Ở chỗ đặt GIÁ TRỊ ta chỉ chèn tên trần — nhưng `tokenAt` đã nuốt cặp nháy
   * người dùng tự gõ, nên phải trả lại, không thì `{"a": "$b"}` mất nháy.
   */
  const bareInsert = (name: string): [string, number] =>
    token.quoted ? [`"${name}"`, name.length + 1] : [name, name.length];

  /** Một mục gợi ý cho `name`, với khuôn value `[tpl, off]` của kiểu tương ứng. */
  const build = (name: string, hint: string, tpl: string, off: number): Match => {
    // Con trỏ rơi vào ĐẦU khuôn = khuôn là literal cần gõ đè (`0`, `true`) →
    // bôi đen cả nó. Còn lại con trỏ đã nằm trong ruột khuôn, không bôi gì.
    const selectLen = off === 0 ? tpl.length : 0;
    if (bare) {
      const [ins, offset] = bareInsert(name);
      return { label: name, hint, insert: ins, caretOffset: offset, selectLen: 0, preview: ins, from: token.from, to: token.to };
    }
    if (pair) {
      // Value đang là chỗ trống `""` → thay luôn bằng khuôn đúng kiểu, con trỏ
      // vào giữa. Value đã có chữ → chỉ đổi tên key, không đạp lên cái đã gõ.
      if (pair.emptyValueEnd >= 0) {
        const insert = `"${name}": ${tpl}`;
        return {
          label: name, hint, insert, caretOffset: name.length + 4 + off, selectLen,
          preview: insert, from: token.from, to: pair.emptyValueEnd,
        };
      }
      const insert = `"${name}"`;
      return {
        label: name, hint, insert, caretOffset: insert.length, selectLen: 0,
        preview: insert, from: token.from, to: token.to,
      };
    }
    const insert = `"${name}": ${tpl}${needComma ? ',' : ''}`;
    // `"` + name + `": ` = name.length + 4 ký tự trước khi tới value.
    return {
      label: name, hint, insert, caretOffset: name.length + 4 + off, selectLen,
      preview: `"${name}": ${tpl}`, from: token.from, to: token.to,
    };
  };

  if (w.startsWith('$')) {
    return OPERATORS.filter((o) => o.startsWith(w)).slice(0, MAX_MATCHES)
      .map((o) => build(o, 'operator', ...operatorTemplate(o)));
  }

  return fields
    .filter((f) => f.path.toLowerCase().includes(w))
    // Prefix matches first — typing `ten` should surface `tenantId` above `clientTenant`.
    .sort((a, b) => Number(b.path.toLowerCase().startsWith(w)) - Number(a.path.toLowerCase().startsWith(w)))
    .slice(0, MAX_MATCHES)
    .map((f) => build(f.path, f.type, ...valueTemplate(f.type)));
}
