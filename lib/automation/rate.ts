'use client';

// DevBox Automation — TỐC ĐỘ TĂNG TRƯỞNG (rate watch).
//
// Watch thường hỏi "chỉ số ĐANG là bao nhiêu". Watch ở đây hỏi hai câu khác,
// và đó là hai câu mà một ngưỡng tĩnh không bao giờ trả lời được:
//
//   rate  "đĩa TĂNG bao nhiêu trong N phút qua"   → bắt đà bất thường
//   eta   "còn bao lâu nữa thì CẠN"               → bắt nguy cơ thật sự
//
// VÌ SAO CÓ CẢ HAI, và vì sao `eta` mới là cái mặc định cho chỉ số có trần:
// tốc độ tự nó KHÔNG phải là thứ nguy hiểm — cạn tài nguyên mới là. Đĩa tăng
// 20%/giờ trên volume còn trống 900GB thì không sao; đĩa tăng 1%/giờ trên
// volume còn 3% là sự cố trong đêm nay. Một watch chỉ đặt ngưỡng trên tốc độ
// sẽ bỏ lọt ca thứ hai VĨNH VIỄN, dù ngưỡng đặt thấp cỡ nào, vì tốc độ đó
// thực sự thấp. `eta` gộp cả tốc độ lẫn phần còn trống vào MỘT con số mà
// người trực đêm đọc phát hiểu ngay.
//
// ĐA CỬA SỔ, và vì sao không phải một cửa sổ:
// một cửa sổ cố định luôn mù với một lớp sự cố. Cửa sổ 60 phút pha loãng cú
// tăng dốc trong 5 phút thành trung bình hiền lành; cửa sổ 5 phút không bao
// giờ thấy được đà rò rỉ 12 tiếng (mỗi nhịp chỉ nhích 0,1% — chẳng ngưỡng nào
// bắt được, mà cuối ngày là đầy đĩa). Nên một watch mang NHIỀU cửa sổ và báo
// khi BẤT KỲ cửa sổ nào vượt: một watch bắt cả ba dạng — đột biến, đà bất
// thường, rò rỉ chậm. Chi phí gần bằng không: cùng một ring buffer, vài phép
// trừ. KHÔNG thêm một probe call nào — rate dùng đúng số liệu mà probe hiện
// tại đã trả về.
//
// File này THUẦN TÍNH TOÁN: không đọc config, không gọi mạng, không giữ state
// toàn cục. Watcher đưa vào một mảng mẫu, nó trả về "vượt hay không, cửa sổ
// nào, con số bao nhiêu". Nhờ vậy phần dễ sai nhất của tính năng này kiểm thử
// được mà không cần dựng cả hệ thống.

import {
  DEFAULT_MIN_SAMPLES,
  DEFAULT_RATE,
  type InfraWatch,
  type RateMode,
  type RateWindow,
  type WatchRate,
} from './types';

/** Một lần đo đã lưu lại. Ring buffer chỉ gồm những thứ này. */
export interface RateSample {
  at: number;
  value: number;
  /** Phần còn trống (total − used) tại chính lần đo đó, cho ETA. Vắng = không tính được ETA. */
  left?: number;
  /**
   * Mẫu ĐẦU TIÊN sau một lần đặt lại mốc (restart / dọn dữ liệu).
   *
   * Cửa sổ nào còn chứa mẫu này thì chưa bao trọn một chu kỳ thật, nên chưa
   * được phép kết luận — xem evalWindow.
   */
  fresh?: boolean;
}

/** Kết quả tính trên MỘT cửa sổ. */
export interface WindowOutcome {
  windowSec: number;
  threshold: number;
  /** Số mẫu thực sự nằm trong cửa sổ. */
  samples: number;
  /** Khoảng thời gian thực giữa hai mốc so sánh (giây) — có thể ngắn hơn windowSec. */
  spanSec: number;
  /** Giá trị mốc đầu và mốc cuối (đã làm mượt nếu bật). */
  from: number;
  to: number;
  /** Chênh lệch theo `mode` — điểm %, tuyệt đối, hay % tương đối. */
  delta: number;
  /** Tốc độ quy về MỘT GIỜ — con số người ta thật sự đọc ("tăng 2GB/giờ"). */
  perHour: number;
  /** Chỉ mode eta: số giây còn lại đến khi cạn. null = không tính được / không cạn. */
  etaSec: number | null;
  /** Con số đem đi so với ngưỡng: `delta` với rate, `etaSec/3600` với eta. */
  measured: number;
  breaching: boolean;
  /** Không đủ mẫu để kết luận — KHÁC HẲN "không vượt". Xem ghi chú ở evaluateRate. */
  pending: boolean;
}

export interface RateOutcome {
  /** Có cửa sổ nào vượt không (OR trên mọi cửa sổ). */
  breaching: boolean;
  /**
   * Mọi cửa sổ đều thiếu mẫu → CHƯA KẾT LUẬN ĐƯỢC.
   *
   * Phân biệt với `breaching:false` là điểm sống còn của tính năng: "im vì
   * khoẻ" và "im vì chưa có dữ liệu" nhìn từ ngoài giống hệt nhau, mà cái sau
   * là đang MÙ. Watcher dựa vào cờ này để hiện trạng thái gom dữ liệu trên UI
   * và để tự cảnh báo khi mù quá lâu.
   */
  pending: boolean;
  /** Cửa sổ đại diện — cái vượt NẶNG NHẤT, hoặc (khi không vượt) cái nhiều dữ liệu nhất. */
  lead: WindowOutcome | null;
  /** Mọi cửa sổ, theo thứ tự đã khai. */
  windows: WindowOutcome[];
  /** Số mẫu đang có trong buffer (mọi cửa sổ). */
  samples: number;
  /** Cần thêm bao nhiêu giây nữa thì cửa sổ ngắn nhất đủ dữ liệu. 0 = đã đủ. */
  readyInSec: number;
}

/**
 * Tụt bao nhiêu phần thì coi là RESET chứ không phải "giảm".
 *
 * Redis restart → memUsedMb về gần 0 → nhịp sau tăng vọt → "RAM tăng 400%",
 * một cảnh báo hoàn toàn bịa. Xoay log, xoá collection, thay volume cũng vậy.
 * Ngưỡng 40% đủ rộng để không nhầm với dao động thật (GC nhả heap, đĩa được
 * dọn dần) và đủ chặt để bắt được restart.
 */
const RESET_DROP_RATIO = 0.4;

/** Bao nhiêu mẫu ở MỖI đầu mút được lấy trung bình khi bật làm mượt. */
const SMOOTH_SPAN = 3;

/** Watch này có phải rate watch không (dùng khắp nơi — một chỗ định nghĩa). */
export const isRateWatch = (w: Pick<InfraWatch, 'kind'>): boolean => w.kind === 'rate';

/** Cửa sổ dài nhất — quyết định buffer phải giữ bao lâu. */
export function maxWindowSec(rate: WatchRate | undefined): number {
  const ws = rate?.windows ?? [];
  return ws.reduce((m, w) => Math.max(m, w.sec), 0);
}

/** Cửa sổ ngắn nhất — quyết định bao giờ watch bắt đầu nói được gì đó. */
export function minWindowSec(rate: WatchRate | undefined): number {
  const ws = rate?.windows ?? [];
  return ws.length ? ws.reduce((m, w) => Math.min(m, w.sec), Infinity) : 0;
}

/**
 * Đưa mẫu mới vào buffer, cắt phần đã ra khỏi cửa sổ dài nhất.
 *
 * Trả về buffer MỚI (không sửa tại chỗ) cùng cờ `reset` để watcher ghi trace —
 * bản thân việc Redis restart lúc 3h sáng là tin đáng biết, nên chỗ này không
 * im lặng nuốt sự kiện mà báo ra ngoài.
 *
 * Cắt theo CẢ thời gian lẫn SỐ MẪU: một watch cấu hình sai (everySec 15,
 * cửa sổ 24h = 5760 mẫu) không được phép âm thầm phình bộ nhớ.
 */
export function pushSample(
  buf: RateSample[],
  next: RateSample,
  rate: WatchRate,
  everySec: number,
): { buf: RateSample[]; reset: boolean } {
  const prev = buf.length ? buf[buf.length - 1] : null;
  const dropped =
    !!prev &&
    rate.resetOnDrop !== false &&
    prev.value > 0 &&
    next.value < prev.value * (1 - RESET_DROP_RATIO);

  // Tụt sâu = mốc cũ không còn cùng một "đời" với mốc mới. Giữ lại thì mọi
  // phép trừ đều bắc qua điểm gãy và cho ra số vô nghĩa.
  //
  // Mẫu đầu tiên sau khi xoá được ĐÁNH DẤU `fresh`. Xoá buffer thôi chưa đủ:
  // ngay sau restart, Redis nạp lại cache rất nhanh (200 → 440 MB trong 5
  // phút = +120%), và với minSamples = 3 thì watch đủ tư cách phát ngay —
  // một cảnh báo "RAM tăng vọt" cho cái thực ra là quá trình khởi động bình
  // thường. Dấu này để evalWindow biết cửa sổ chưa bao trọn một chu kỳ thật.
  const kept = dropped ? [] : buf;
  const out = [...kept, dropped ? { ...next, fresh: true } : next];

  const span = maxWindowSec(rate);
  const cutoff = next.at - span * 1000;
  // Giữ thêm MỘT mẫu ngay trước cutoff: mốc đầu cửa sổ nên là mẫu bao trọn
  // khoảng, cắt đúng cutoff làm cửa sổ luôn ngắn hơn thực tế một nhịp.
  let start = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i].at >= cutoff) break;
    start = i;
  }
  const byTime = out.slice(start);

  const maxSamples = Math.ceil(span / Math.max(1, everySec)) + SMOOTH_SPAN + 2;
  const byCount = byTime.length > maxSamples ? byTime.slice(byTime.length - maxSamples) : byTime;

  return { buf: byCount, reset: dropped };
}

/** Trung bình `n` mẫu đầu/cuối — khử nhiễu đo mà KHÔNG làm phẳng đột biến. */
function edge(xs: RateSample[], from: 'head' | 'tail', n: number): number {
  const span = Math.max(1, Math.min(n, xs.length));
  const part = from === 'head' ? xs.slice(0, span) : xs.slice(xs.length - span);
  return part.reduce((a, s) => a + s.value, 0) / part.length;
}

/** Phần còn trống tại mốc cuối — lấy mẫu mới nhất có ghi `left`. */
function latestLeft(xs: RateSample[]): number | undefined {
  for (let i = xs.length - 1; i >= 0; i -= 1) {
    if (typeof xs[i].left === 'number') return xs[i].left;
  }
  return undefined;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Tính chênh lệch theo `mode`.
 *
 * `points` và `relative` là hai thứ RẤT dễ nhầm trên chỉ số %: 78% → 90% là
 * +12 ĐIỂM nhưng chỉ +15,4% tương đối. Nhầm một chỗ này là ngưỡng lệch nhiều
 * lần, nên editor phải hiện ví dụ sống chứ không chỉ tên chế độ.
 */
function deltaOf(from: number, to: number, mode: RateMode): number {
  if (mode === 'relative') {
    // Mẫu số quá nhỏ làm % tương đối phát điên (lag 2 → 4 là +100%, vô nghĩa).
    if (Math.abs(from) < 1e-9) return to > from ? Infinity : 0;
    return ((to - from) / Math.abs(from)) * 100;
  }
  return to - from; // points và absolute cùng một phép trừ, khác cách ĐỌC
}

/** Cùng ngữ nghĩa với breaches() bên infra.ts — nhân bản để file này thuần tuý. */
function compare(value: number, op: InfraWatch['op'], threshold: number): boolean {
  switch (op) {
    case 'gt': return value > threshold;
    case 'gte': return value >= threshold;
    case 'lt': return value < threshold;
    case 'lte': return value <= threshold;
    case 'eq': return value === threshold;
    case 'neq': return value !== threshold;
    default: return false;
  }
}

function evalWindow(
  buf: RateSample[],
  win: RateWindow,
  rate: WatchRate,
  now: number,
  op: InfraWatch['op'],
): WindowOutcome {
  const minSamples = Math.max(2, rate.minSamples ?? DEFAULT_MIN_SAMPLES);
  const inWin = buf.filter((s) => s.at >= now - win.sec * 1000);
  const blank: WindowOutcome = {
    windowSec: win.sec,
    threshold: win.threshold,
    samples: inWin.length,
    spanSec: 0,
    from: 0,
    to: 0,
    delta: 0,
    perHour: 0,
    etaSec: null,
    measured: 0,
    breaching: false,
    pending: true,
  };
  if (inWin.length < minSamples) return blank;

  const spanMs = inWin[inWin.length - 1].at - inWin[0].at;
  // Mọi mẫu dồn vào một khoảnh khắc (đồng hồ nhảy, poll dồn) → không có thời
  // gian để chia, mọi tốc độ đều là vô cực. Coi như chưa đủ dữ liệu.
  if (spanMs <= 0) return blank;

  // Cửa sổ vẫn còn chứa mốc vừa đặt lại → nó CHƯA bao trọn một chu kỳ thật,
  // mà chỉ là phần đuôi kể từ lúc restart. Đợi đủ cửa sổ rồi hãy kết luận:
  // "Redis nạp lại cache sau restart" và "Redis đang rò rỉ bộ nhớ" nhìn giống
  // hệt nhau nếu chỉ xem 5 phút đầu tiên, và chỉ cái sau mới đáng báo.
  if (inWin.some((s) => s.fresh) && spanMs < win.sec * 1000 * 0.9) return blank;

  const n = rate.smooth === false ? 1 : SMOOTH_SPAN;
  // Làm mượt không được phép ăn quá nửa cửa sổ, nếu không hai mốc chồng nhau.
  const span = Math.max(1, Math.min(n, Math.floor(inWin.length / 2)));
  const from = edge(inWin, 'head', span);
  const to = edge(inWin, 'tail', span);

  const delta = deltaOf(from, to, rate.mode);
  const spanSec = spanMs / 1000;
  const perHour = Number.isFinite(delta) ? (delta / spanSec) * 3600 : Infinity;

  let etaSec: number | null = null;
  if (rate.mode === 'eta') {
    const left = latestLeft(inWin);
    const risePerSec = (to - from) / spanSec;
    // Chỉ có ETA khi đang thực sự TIẾN VỀ phía cạn. Đứng im hoặc đang lùi ra
    // thì không có "bao giờ cạn" — null, và null KHÔNG vượt ngưỡng.
    if (typeof left === 'number' && left >= 0 && risePerSec > 0) {
      etaSec = left / risePerSec;
    }
  }

  // ETA so bằng GIỜ: người ta đặt "báo khi sẽ đầy trong dưới 24h", không ai
  // nghĩ bằng giây. Ngưỡng trong config vì thế cũng là giờ.
  const measured = rate.mode === 'eta' ? (etaSec === null ? Infinity : etaSec / 3600) : delta;
  const breaching = Number.isFinite(measured)
    ? compare(measured, op, win.threshold)
    : // ETA vô cực (không cạn) không bao giờ là cảnh báo; delta vô cực (mẫu số
      // 0 mà có tăng) thì có — nó là tăng trưởng từ số không.
      rate.mode !== 'eta' && (op === 'gt' || op === 'gte');

  return {
    windowSec: win.sec,
    threshold: win.threshold,
    samples: inWin.length,
    spanSec: Math.round(spanSec),
    from: round2(from),
    to: round2(to),
    delta: Number.isFinite(delta) ? round2(delta) : delta,
    perHour: Number.isFinite(perHour) ? round2(perHour) : perHour,
    etaSec: etaSec === null ? null : Math.round(etaSec),
    measured: Number.isFinite(measured) ? round2(measured) : measured,
    breaching,
    pending: false,
  };
}

/**
 * Cửa sổ nào đại diện cho cảnh báo.
 *
 * Trong các cửa sổ đang vượt, chọn cái VƯỢT XA NGƯỠNG NHẤT — đó là góc nhìn
 * mô tả đúng nhất mức nghiêm trọng. Với ETA thì "xa nhất" nghĩa là SỚM NHẤT
 * (còn ít giờ nhất), nên so ngược lại.
 */
function pickLead(ws: WindowOutcome[], mode: RateMode): WindowOutcome | null {
  const hot = ws.filter((w) => w.breaching);
  if (hot.length) {
    return hot.reduce((best, w) => {
      if (mode === 'eta') return w.measured < best.measured ? w : best;
      return Math.abs(w.measured - w.threshold) > Math.abs(best.measured - best.threshold) ? w : best;
    });
  }
  // Không vượt: lấy cửa sổ có dữ liệu chắc nhất để UI vẫn hiện được con số.
  const ready = ws.filter((w) => !w.pending);
  if (!ready.length) return null;
  return ready.reduce((best, w) => (w.samples > best.samples ? w : best));
}

/**
 * Đánh giá toàn bộ cửa sổ của một rate watch.
 *
 * KHÔNG có ngưỡng "giá trị tối thiểu", KHÔNG giới hạn số lần báo, KHÔNG tự
 * chỉnh ngưỡng. Mỗi lớp lọc thêm vào đây là một cơ hội bỏ lọt âm thầm; việc
 * thưa cảnh báo đã có RuleLimits lo, và đó là chỗ nhìn thấy được.
 */
export function evaluateRate(
  buf: RateSample[],
  watch: Pick<InfraWatch, 'op' | 'everySec'> & { rate: WatchRate },
  now: number,
): RateOutcome {
  const rate = watch.rate;
  const wins = rate.windows.length ? rate.windows : DEFAULT_RATE.windows;
  const windows = wins.map((w) => evalWindow(buf, w, rate, now, watch.op));
  const pending = windows.every((w) => w.pending);

  const minSamples = Math.max(2, rate.minSamples ?? DEFAULT_MIN_SAMPLES);
  const shortest = wins.reduce((m, w) => Math.min(m, w.sec), Infinity);
  const have = buf.filter((s) => s.at >= now - shortest * 1000).length;
  const readyInSec = have >= minSamples ? 0 : (minSamples - have) * Math.max(1, watch.everySec);

  return {
    breaching: windows.some((w) => w.breaching),
    pending,
    lead: pickLead(windows, rate.mode),
    windows,
    samples: buf.length,
    readyInSec,
  };
}
