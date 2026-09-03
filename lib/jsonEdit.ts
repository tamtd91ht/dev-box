// lib/jsonEdit.ts — trợ lý gõ JSON cho ô body raw của tab API.
//
// Đây là phần thuần logic (không đụng DOM) của cái mà một editor JSON tử tế
// làm được: gõ `{` ra sẵn khung `{ "": "" }`, Enter ở cuối một cặp key/value
// thì tự thêm dấu phẩy + dòng field mới, gõ dấu đóng thì nhảy qua thay vì đẻ
// thêm, Backspace giữa một cặp thì xoá cả hai. Tách khỏi component để còn kiểm
// được bằng scripts/check-json-edit.ts — con trỏ nhảy sai một ô là loại lỗi
// không thể "chạy thử thấy ổn" rồi yên tâm.
//
// Quy ước chung: mọi hàm nhận (text, from, to) và trả { text, caret }. Trả null
// nghĩa là "để nguyên hành vi mặc định của trình duyệt".

export interface EditResult {
  text: string;
  /** Vị trí con trỏ sau khi chèn (selectionStart = selectionEnd = caret). */
  caret: number;
}

const INDENT = '  ';

/**
 * Con trỏ có đang NẰM TRONG một chuỗi "..." không?
 *
 * Quan trọng vì trong chuỗi thì `{` là ký tự thường — nhất là biến {{var}} của
 * environment: bung khung JSON ở đó là phá đúng thứ người ta đang gõ.
 */
export function isInsideString(text: string, pos: number): boolean {
  let inStr = false;
  for (let i = 0; i < pos && i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\' && inStr) { i += 1; continue; } // escape — bỏ qua cặp
    if (c === '"') inStr = !inStr;
  }
  return inStr;
}

/** Thụt lề của dòng đang chứa `pos` (chỉ phần khoảng trắng đầu dòng). */
export function lineIndent(text: string, pos: number): string {
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(start, pos));
  return m ? m[0] : '';
}

/** Ngoặc đang bao quanh `pos`: '{' (trong object), '[' (trong mảng), null. */
export function enclosing(text: string, pos: number): '{' | '[' | null {
  const stack: ('{' | '[')[] = [];
  let inStr = false;
  for (let i = 0; i < pos && i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i += 1;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }
  return stack.length ? stack[stack.length - 1] : null;
}

/** Ký tự khác khoảng trắng gần nhất về phía trước / phía sau `pos`. */
const prevNonSpace = (t: string, pos: number): string => {
  for (let i = pos - 1; i >= 0; i -= 1) if (!/\s/.test(t[i])) return t[i];
  return '';
};
const nextNonSpace = (t: string, pos: number): string => {
  for (let i = pos; i < t.length; i += 1) if (!/\s/.test(t[i])) return t[i];
  return '';
};

const splice = (text: string, from: number, to: number, ins: string): string =>
  text.slice(0, from) + ins + text.slice(to);

/**
 * Gõ `{` → bung khung object chuẩn, con trỏ nằm sẵn trong nháy của key:
 *
 *   {
 *     "|": ""
 *   }
 *
 * Trong chuỗi (kể cả "{{var}}") thì trả null để gõ như thường.
 */
export function openBrace(text: string, from: number, to: number): EditResult | null {
  if (isInsideString(text, from)) return null;
  const ind = lineIndent(text, from);
  const body = `{\n${ind}${INDENT}"": ""\n${ind}}`;
  return { text: splice(text, from, to, body), caret: from + 2 + ind.length + INDENT.length + 1 };
}

/** Gõ `[` → khung mảng có sẵn dòng trống bên trong để gõ phần tử. */
export function openBracket(text: string, from: number, to: number): EditResult | null {
  if (isInsideString(text, from)) return null;
  const ind = lineIndent(text, from);
  const body = `[\n${ind}${INDENT}\n${ind}]`;
  return { text: splice(text, from, to, body), caret: from + 2 + ind.length + INDENT.length };
}

/**
 * Gõ `"`: bọc phần đang bôi đen, đóng cặp khi ở ngoài chuỗi, nhảy qua dấu nháy
 * đóng nếu con trỏ đang đứng ngay trước nó.
 */
export function quote(text: string, from: number, to: number): EditResult | null {
  if (from !== to) {
    return { text: splice(text, from, to, `"${text.slice(from, to)}"`), caret: to + 2 };
  }
  if (text[from] === '"') return { text, caret: from + 1 }; // nhảy qua dấu đóng
  if (isInsideString(text, from)) return null; // đang trong chuỗi — gõ dấu đóng thật
  return { text: splice(text, from, to, '""'), caret: from + 1 };
}

/** Gõ `}` / `]` khi ký tự kế tiếp đúng là nó → nhảy qua, không chèn trùng. */
export function closeBracket(text: string, from: number, to: number, ch: '}' | ']'): EditResult | null {
  if (from !== to || isInsideString(text, from)) return null;
  if (text[from] === ch) return { text, caret: from + 1 };
  return null;
}

/** Một dòng đã là cặp `"key": value` HOÀN CHỈNH? (để Enter đẻ field mới) */
function isCompletePair(line: string): boolean {
  const s = line.trim().replace(/,$/, '');
  if (!/^"(?:[^"\\]|\\.)*"\s*:/.test(s)) return false;
  const val = s.slice(s.indexOf(':') + 1).trim();
  return val !== '' && !/[{[]$/.test(val); // mở object/mảng thì cặp chưa xong
}

/**
 * Enter trong body JSON:
 *
 * 1. Giữa cặp ngoặc rỗng (`{|}`) → banh ra thành khối có thụt lề.
 * 2. Cuối một cặp `"key": value` trong object → thêm dấu phẩy nếu thiếu rồi mở
 *    sẵn field mới `"": ""` — đúng cái "thêm field là format sẵn giùm".
 * 3. Còn lại → xuống dòng giữ thụt lề (thêm một cấp nếu dòng kết bằng `{`/`[`).
 */
export function enter(text: string, from: number, to: number): EditResult | null {
  if (from !== to || isInsideString(text, from)) return null;
  const ind = lineIndent(text, from);
  const prev = prevNonSpace(text, from);
  const next = nextNonSpace(text, from);

  // 1. Banh cặp ngoặc rỗng.
  if ((prev === '{' && next === '}') || (prev === '[' && next === ']')) {
    const closeAt = text.indexOf(next, from);
    return {
      text: splice(text, from, closeAt, `\n${ind}${INDENT}\n${ind}`),
      caret: from + 1 + ind.length + INDENT.length,
    };
  }

  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  const nl = text.indexOf('\n', from);
  const lineEnd = nl === -1 ? text.length : nl;
  const line = text.slice(lineStart, lineEnd);

  // 2. Field mới trong object — chỉ khi con trỏ ở cuối dòng, tránh cắt đôi dòng.
  const atLineEnd = text.slice(from, lineEnd).trim() === '';
  if (atLineEnd && enclosing(text, from) === '{' && isCompletePair(line) && next !== ',') {
    const comma = /,\s*$/.test(line) ? '' : ',';
    const ins = `${comma}\n${ind}"": ""`;
    return { text: splice(text, from, lineEnd, ins), caret: from + comma.length + 1 + ind.length + 1 };
  }

  // 3. Xuống dòng thường, giữ (hoặc tăng) thụt lề.
  const deeper = /[{[]$/.test(line.trimEnd()) ? INDENT : '';
  return { text: splice(text, from, to, `\n${ind}${deeper}`), caret: from + 1 + ind.length + deeper.length };
}

const PAIRS: Record<string, string> = { '{': '}', '[': ']', '"': '"' };

/** Backspace đứng giữa một cặp vừa được đóng tự động → xoá cả hai. */
export function backspace(text: string, from: number, to: number): EditResult | null {
  if (from !== to || from === 0) return null;
  const open = text[from - 1];
  if (PAIRS[open] && text[from] === PAIRS[open]) {
    return { text: text.slice(0, from - 1) + text.slice(from + 1), caret: from - 1 };
  }
  return null;
}

/**
 * Con trỏ ở vị trí tương ứng sau khi text bị format lại.
 *
 * Neo theo SỐ KÝ TỰ KHÔNG-TRẮNG đứng trước con trỏ: format chỉ xê dịch khoảng
 * trắng, nên đếm phần còn lại là đủ để con trỏ đứng nguyên chỗ cũ về mặt nội
 * dung — không thì mỗi lần tự format là một lần người ta mất chỗ đang gõ.
 */
export function remapCaret(oldText: string, caret: number, newText: string): number {
  let want = 0;
  for (let i = 0; i < caret && i < oldText.length; i += 1) if (!/\s/.test(oldText[i])) want += 1;
  if (want === 0) return 0;
  let seen = 0;
  for (let i = 0; i < newText.length; i += 1) {
    if (!/\s/.test(newText[i])) {
      seen += 1;
      if (seen === want) return i + 1;
    }
  }
  return newText.length;
}

/** Text có "ra dáng" JSON không — để khỏi đi format cái form-urlencoded. */
export function looksLikeJson(text: string): boolean {
  const s = text.trim();
  return s.startsWith('{') || s.startsWith('[');
}
