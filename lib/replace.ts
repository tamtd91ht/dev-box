// Tìm & thay chuỗi cho tab Tools — phần lõi, hàm thuần để test được.
//
// Hai chế độ, cùng một đường ra:
//   · 'plain'  tìm đúng từng ký tự. Người dùng gõ ".*" là muốn tìm dấu chấm và
//              dấu sao thật, nên chuỗi tìm được ESCAPE trước khi dựng RegExp.
//   · 'regex'  biểu thức chính quy thật, có $1/$2 trong chuỗi thay.
//
// Vì sao vẫn dựng RegExp cho chế độ thường thay vì split/join: cần đếm số lần
// khớp, biết vị trí từng khớp (để tô sáng) và hỗ trợ "không phân biệt hoa
// thường" — split/join không cho cái nào trong ba thứ đó.
//
// Mọi hàm ở đây KHÔNG ném lỗi ra ngoài: regex hỏng là chuyện thường khi người
// dùng đang gõ dở, nên trả về `{ error }` để UI hiện nhẹ nhàng thay vì đỏ màn.

/** Tìm đúng từng ký tự, hay hiểu chuỗi tìm là biểu thức chính quy. */
export type ReplaceMode = 'plain' | 'regex';

export interface ReplaceOptions {
  mode: ReplaceMode;
  /** Không phân biệt hoa/thường (cờ i). */
  ignoreCase: boolean;
  /** Thay MỌI chỗ khớp (cờ g). Tắt = chỉ thay lần khớp đầu tiên. */
  all: boolean;
  /** regex: ^ và $ khớp từng DÒNG thay vì cả chuỗi (cờ m). */
  multiline: boolean;
  /** regex: dấu chấm khớp cả xuống dòng (cờ s). */
  dotAll: boolean;
}

export const DEFAULT_OPTIONS: ReplaceOptions = {
  mode: 'plain',
  ignoreCase: false,
  all: true,
  multiline: false,
  dotAll: false,
};

/** Một đoạn khớp — dùng để tô sáng và để đếm. */
export interface Match {
  start: number;
  end: number;
  text: string;
}

export interface ReplaceResult {
  output: string;
  matches: Match[];
  /** Regex không hợp lệ → thông báo gọn, output giữ nguyên chuỗi vào. */
  error?: string;
  /**
   * Khớp RỖNG (vd regex `a*` hay chuỗi tìm để trống) — cảnh báo chứ không chặn.
   * Khớp rỗng vẫn thay được (chèn vào giữa mọi ký tự) nhưng gần như luôn là gõ
   * nhầm, và nó là nguồn của vòng lặp vô hạn nếu con trỏ không được đẩy tới.
   */
  emptyMatch?: boolean;
}

/** Chặn ký tự đặc biệt của regex — cho chế độ 'plain'. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Trong chế độ THƯỜNG, `$` trong chuỗi thay phải là ký tự `$` thật.
 *
 * String.replace hiểu `$&`, `$1`, `` $` `` … là ký hiệu đặc biệt kể cả khi mẫu
 * tìm không có nhóm nào. Người gõ "giá: $5" mà nhận được "giá: 5" thì rất khó
 * hiểu, nên nhân đôi `$` để nó về đúng nghĩa đen. Chế độ regex giữ nguyên —
 * ở đó $1 là tính năng người dùng chủ động dùng.
 */
export function escapeDollar(s: string): string {
  return s.replace(/\$/g, '$$$$');
}

/** Dựng cờ RegExp từ tuỳ chọn. `g` luôn bật khi cần quét tìm tất cả khớp. */
function flagsFor(o: ReplaceOptions, forceGlobal: boolean): string {
  let f = '';
  if (o.all || forceGlobal) f += 'g';
  if (o.ignoreCase) f += 'i';
  if (o.mode === 'regex' && o.multiline) f += 'm';
  if (o.mode === 'regex' && o.dotAll) f += 's';
  return f;
}

/**
 * Dựng RegExp theo chế độ, hoặc trả lỗi đọc được.
 *
 * Thông báo lỗi của JS ("Invalid regular expression: /a(/: Unterminated group")
 * dài và lặp lại cả mẫu, nên cắt lấy phần đuôi có nghĩa.
 */
export function buildRegExp(
  find: string,
  o: ReplaceOptions,
  forceGlobal = false,
): { re: RegExp } | { error: string } {
  if (!find) return { error: '' }; // chưa gõ gì — không phải lỗi, chỉ là chưa làm gì
  const source = o.mode === 'regex' ? find : escapeRegExp(find);
  try {
    return { re: new RegExp(source, flagsFor(o, forceGlobal)) };
  } catch (e) {
    const raw = (e as Error).message;
    const tail = raw.match(/:\s*([^:]+)$/);
    return { error: tail ? tail[1].trim() : raw };
  }
}

/**
 * Quét mọi chỗ khớp — nguồn của cả số đếm lẫn phần tô sáng.
 *
 * `limit` chặn trường hợp bệnh lý (mẫu khớp rỗng trên file lớn) làm treo tab.
 * Chạm trần thì dừng, UI hiện "999+" thay vì đứng hình.
 */
export function findMatches(
  text: string,
  find: string,
  o: ReplaceOptions,
  limit = 5000,
): { matches: Match[]; error?: string; emptyMatch?: boolean } {
  if (!find) return { matches: [] };
  const built = buildRegExp(find, o, true);
  if ('error' in built) return { matches: [], error: built.error };

  const re = built.re;
  const matches: Match[] = [];
  let emptyMatch = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '') {
      emptyMatch = true;
      // Bắt buộc đẩy con trỏ: khớp rỗng không tự tăng lastIndex → lặp vô hạn.
      re.lastIndex += 1;
      if (re.lastIndex > text.length) break;
      continue;
    }
    matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    if (matches.length >= limit) break;
    // Chỉ thay lần đầu thì không cần quét tiếp.
    if (!o.all) break;
  }
  return { matches, emptyMatch };
}

/** Chạy phép thay, trả kết quả + danh sách khớp để tô sáng ô nguồn. */
export function runReplace(
  text: string,
  find: string,
  replacement: string,
  o: ReplaceOptions,
): ReplaceResult {
  if (!find) return { output: text, matches: [] };

  const scan = findMatches(text, find, o);
  if (scan.error) return { output: text, matches: [], error: scan.error };

  const built = buildRegExp(find, o);
  if ('error' in built) return { output: text, matches: [], error: built.error };

  const repl = o.mode === 'regex' ? replacement : escapeDollar(replacement);
  try {
    return {
      output: text.replace(built.re, repl),
      matches: scan.matches,
      emptyMatch: scan.emptyMatch,
    };
  } catch (e) {
    return { output: text, matches: [], error: (e as Error).message };
  }
}

/** "3 chỗ khớp" / "không có chỗ nào khớp" — câu tóm tắt dưới ô nhập. */
export function summarize(n: number, capped: boolean): string {
  if (n === 0) return 'không có chỗ nào khớp';
  return `${capped ? `${n}+` : n} chỗ khớp`;
}
