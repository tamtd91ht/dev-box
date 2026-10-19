// Logic "fill handle" kiểu Excel cho Sheet workspace — TÍNH giá trị khi kéo
// ô vuông góc dưới-phải của vùng chọn. Module thuần (không React, không DOM)
// để test được độc lập; SheetWorkspace lo phần kéo-thả và ghi op.
//
// Quy tắc series (bám Excel):
//   · Nguồn TOÀN SỐ, ≥2 ô  → tịnh tiến theo xu hướng tuyến tính (1,2 → 3,4;
//     2,4 → 6,8). Giữ Ctrl khi thả = LẶP LẠI thay vì tịnh tiến.
//   · Nguồn 1 ô là SỐ      → mặc định LẶP LẠI (như Excel); Ctrl = +1 mỗi ô.
//   · Text đuôi số ("Mục 1")→ mặc định TĂNG số đuôi (Mục 2, Mục 3…); Ctrl = lặp.
//     Giữ cả độ dài số ("SP-01" → "SP-02"). Số đứng sau / - . : (ngày giờ
//     "15/03/2024") KHÔNG coi là đuôi số — lặp nguyên văn.
//   · Công thức "=A1+B1"   → dịch tham chiếu TƯƠNG ĐỐI theo khoảng kéo (như
//     Excel); phần có $ giữ nguyên. Ref dịch ra ngoài mép → #REF!.
//   · Còn lại (text thường, ô trống) → lặp tuần hoàn theo pattern nguồn.
//
// Kéo lên/trái: caller ĐẢO NGƯỢC mảng nguồn rồi gọi như kéo xuôi (shift
// formula nhận offset dương, caller tự nhân hướng âm).

/** Số "chuẩn" — khớp CANON_NUM của SheetWorkspace / parseInput của server. */
const FILL_NUM = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** Text kết thúc bằng số nguyên (không dấu): "Mục 12" → ["Mục ", "12"]. */
const TRAIL_INT = /^(.*?)(\d{1,12})$/;

/** Chữ cột → số cột 1-based ("A"→1, "AA"→27). */
function colNum(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** Số cột 1-based → chữ ("A", "AA"…). */
function colStr(n: number): string {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

/**
 * Dịch mọi tham chiếu A1 TƯƠNG ĐỐI trong công thức đi (dr, dc) — phần có $
 * đứng yên, chuỗi trong "..." không bị đụng. Ref dịch ra ngoài lưới (dòng/cột
 * < 1) → thay bằng #REF! như Excel.
 */
export function shiftFormulaRefs(f: string, dr: number, dc: number): string {
  if (dr === 0 && dc === 0) return f;
  // Tách phần chuỗi "..." ra để không sửa nhầm text bên trong.
  const parts = f.split(/("(?:[^"]|"")*")/);
  // (?<![A-Za-z0-9_$]) — không ăn vào giữa tên hàm/định danh;
  // (?![\d(]) — "LOG10(" là tên hàm chứ không phải ref OG10.
  const REF = /(?<![A-Za-z0-9_$])(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![\d(])/g;
  return parts.map((part, i) => {
    if (i % 2 === 1) return part; // phần chuỗi "..."
    return part.replace(REF, (_m, dCol: string, letters: string, dRow: string, digits: string) => {
      const c = dCol ? colNum(letters) : colNum(letters) + dc;
      const r = dRow ? Number(digits) : Number(digits) + dr;
      if (c < 1 || r < 1) return '#REF!';
      return `${dCol}${dCol ? letters.toUpperCase() : colStr(c)}${dRow}${r}`;
    });
  }).join('');
}

/** Fit tuyến tính (least squares) qua các điểm (0..n-1, v[i]) → giá trị tại x. */
function linearAt(vals: number[], x: number): number {
  const n = vals.length;
  if (n === 1) return vals[0] + x; // 1 điểm: bước mặc định 1 (Ctrl+kéo số đơn)
  const mx = (n - 1) / 2;
  const my = vals.reduce((a, b) => a + b, 0) / n;
  let num = 0; let den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (vals[i] - my); den += (i - mx) ** 2; }
  const slope = num / den;
  const y = my + slope * (x - mx);
  return Math.round(y * 1e10) / 1e10; // cắt noise float
}

/** Đuôi số hợp lệ để tăng dần: có match, KHÔNG phải công thức, và số không
 *  đứng ngay sau / . : (ngày giờ, số phiên bản — "SP-01" thì VẪN tăng). */
function trailInt(text: string): { prefix: string; num: number; len: number } | null {
  if (text.startsWith('=')) return null;
  const m = text.match(TRAIL_INT);
  if (!m) return null;
  const last = m[1].slice(-1);
  if (last && '/.:'.includes(last)) return null;
  return { prefix: m[1], num: Number(m[2]), len: m[2].length };
}

/**
 * Sinh `count` giá trị nối tiếp một dãy nguồn (một cột khi kéo dọc, một dòng
 * khi kéo ngang). `texts` là TEXT SỬA của từng ô nguồn (công thức = "=…", số
 * đã format = raw). `shiftF(formulaBody, offset)` dịch ref của công thức khi
 * ô nguồn lặp lại cách nó `offset` ô (caller nhân hướng).
 */
export function fillSeries(
  texts: string[],
  count: number,
  ctrl: boolean,
  shiftF: (f: string, offset: number) => string,
): string[] {
  const n = texts.length;
  const out: string[] = [];
  if (n === 0 || count <= 0) return out;

  const allNum = texts.every((t) => FILL_NUM.test(t));
  // Toàn text CÙNG prefix + đuôi số → series trên phần số ("Q1","Q3" → "Q5").
  const trails = texts.map(trailInt);
  const trailSeries = !allNum
    && trails.every((t): t is NonNullable<typeof t> => t !== null)
    && trails.every((t) => t.prefix === trails[0]!.prefix);

  // Có tịnh tiến hay lặp lại? — Ctrl đảo mặc định, như Excel.
  const numSeries = allNum && (n >= 2 ? !ctrl : ctrl);
  const doTrail = trailSeries && !ctrl;

  const numVals = allNum ? texts.map(Number) : [];
  const trailVals = trailSeries ? trails.map((t) => t!.num) : [];

  for (let k = 1; k <= count; k++) {
    const a = n + k - 1;          // chỉ số tuyệt đối trong dãy (0-based)
    const srcIdx = a % n;         // ô nguồn của slot này khi lặp tuần hoàn
    const cycle = Math.floor(a / n); // đã lặp qua pattern bao nhiêu lần

    if (numSeries) {
      out.push(String(linearAt(numVals, a)));
      continue;
    }
    if (doTrail) {
      const t = trails[srcIdx]!;
      const v = Math.round(linearAt(trailVals, a));
      out.push(v >= 0 ? t.prefix + String(v).padStart(t.len, '0') : t.prefix + v);
      continue;
    }
    const src = texts[srcIdx];
    if (src.startsWith('=') && src.length > 1) {
      // Công thức lặp lại nhưng ref tương đối dịch theo khoảng cách tới nguồn.
      out.push(`=${shiftF(src.slice(1), cycle * n)}`);
      continue;
    }
    // Pattern hỗn hợp (không phải toàn số): số và text-đuôi-số lẻ loi vẫn tăng
    // theo vòng lặp ("a",1 kéo 4 ô → "a",2,"a",3) — đúng nết Excel. Toàn số
    // mà rơi xuống đây nghĩa là ĐANG ở chế độ lặp lại → giữ nguyên văn.
    if (!allNum && !ctrl) {
      if (FILL_NUM.test(src)) { out.push(String(Number(src) + cycle)); continue; }
      const t = trailInt(src);
      if (t) {
        const v = t.num + cycle;
        out.push(v >= 0 ? t.prefix + String(v).padStart(t.len, '0') : t.prefix + v);
        continue;
      }
    }
    out.push(src);
  }
  return out;
}
