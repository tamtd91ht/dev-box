// scripts/check-rate-math.ts — kiểm phép tính của rate watch.
//
// VÌ SAO CÓ FILE NÀY: lib/automation/rate.ts là chỗ dễ sai nhất của tính năng
// tốc độ tăng trưởng, và mọi lỗi ở đây đều biểu hiện thành ĐÚNG MỘT triệu
// chứng — watch im lặng — dù nguyên nhân là bỏ lọt thật hay chỉ là thiếu mẫu.
// Nhìn từ UI thì hai thứ đó giống hệt nhau, nên không thể tin vào việc "chạy
// thử thấy không kêu".
//
// Các ca ở đây bám đúng những rủi ro đã liệt kê khi thiết kế: báo giả sau
// restart, nhầm điểm-% với %-tương-đối, cửa sổ dài che cú đột biến, và ETA
// bắt được ca "tăng chậm mà sắp cạn" — ca mà ngưỡng-tốc-độ bỏ lọt vĩnh viễn.
//
//   npx tsx scripts/check-rate-math.ts

import { evaluateRate, pushSample, type RateSample } from '../lib/automation/rate';
import { DEFAULT_RATE, type InfraWatch, type WatchRate } from '../lib/automation/types';

let failures = 0;
const ok = (m: string): void => console.log(`✓ ${m}`);
const fail = (m: string): void => {
  failures += 1;
  console.error(`✗ ${m}`);
};
const check = (cond: boolean, m: string): void => (cond ? ok(m) : fail(m));

const T0 = 1_700_000_000_000;
const rate = (o: Partial<WatchRate>): WatchRate => ({ ...DEFAULT_RATE, ...o });

/** Chuỗi mẫu đều nhịp: value(i) do fn quyết định. */
function series(n: number, everySec: number, fn: (i: number) => number, left?: (i: number) => number): RateSample[] {
  return Array.from({ length: n }, (_, i) => ({
    at: T0 + i * everySec * 1000,
    value: fn(i),
    ...(left ? { left: left(i) } : {}),
  }));
}

const at = (xs: RateSample[]): number => xs[xs.length - 1].at;
const evalAt = (xs: RateSample[], r: WatchRate, op: InfraWatch['op'] = 'gt', everySec = 60) =>
  evaluateRate(xs, { op, everySec, rate: r }, at(xs));

// ── 1. Thiếu mẫu là PENDING, không phải "bình thường" ───────────────────────
//
// Ca quan trọng nhất của cả bộ test: nếu chỗ này trả về breaching:false mà
// pending:false thì watch mù sẽ trông y hệt watch khoẻ.
{
  const r = rate({ mode: 'points', windows: [{ sec: 600, threshold: 5 }], minSamples: 5 });
  const out = evalAt(series(2, 60, (i) => 80 + i), r);
  check(out.pending && !out.breaching, 'thiếu mẫu → pending (KHÔNG phải "bình thường")');
  check(out.readyInSec > 0, 'pending nói được còn thiếu bao lâu nữa');
}

// ── 2. points vs relative: cùng dữ liệu, hai con số khác hẳn ────────────────
//
// 78 → 90 là +12 ĐIỂM nhưng chỉ +15,4% tương đối. Nhầm chỗ này là ngưỡng lệch
// nhiều lần — đúng cái bẫy mà editor phải hiện ví dụ sống để tránh.
{
  const xs = series(12, 60, (i) => 78 + i * (12 / 11));
  const pts = evalAt(xs, rate({ mode: 'points', windows: [{ sec: 900, threshold: 10 }], smooth: false }));
  const rel = evalAt(xs, rate({ mode: 'relative', windows: [{ sec: 900, threshold: 10 }], smooth: false }));
  check(Math.abs((pts.lead?.delta ?? 0) - 12) < 0.1, `points: 78→90 = +12 điểm (thực tế ${pts.lead?.delta})`);
  check(Math.abs((rel.lead?.delta ?? 0) - 15.4) < 0.3, `relative: cùng dữ liệu = +15,4% (thực tế ${rel.lead?.delta})`);
  // Ngưỡng 13 nằm GIỮA hai con số: cùng một dữ liệu, cùng một ngưỡng, hai chế
  // độ cho hai kết luận ngược nhau. Đó là lý do editor phải hiện ví dụ sống
  // chứ không chỉ tên chế độ.
  const pts13 = evalAt(xs, rate({ mode: 'points', windows: [{ sec: 900, threshold: 13 }], smooth: false }));
  const rel13 = evalAt(xs, rate({ mode: 'relative', windows: [{ sec: 900, threshold: 13 }], smooth: false }));
  check(!pts13.breaching && rel13.breaching, 'cùng ngưỡng 13: relative vượt, points KHÔNG — chọn sai chế độ là lệch hẳn kết luận');
}

// ── 3. Đa cửa sổ: cửa sổ ngắn bắt đột biến mà cửa sổ dài pha loãng ──────────
//
// Đây là lý do một watch phải mang nhiều cửa sổ. 11 giờ đứng yên ở 50%, rồi
// vọt lên 70% trong 5 phút cuối: cửa sổ 12 giờ thấy trung bình hiền lành,
// cửa sổ 5 phút thấy đúng cú vọt.
{
  const everySec = 60;
  const n = 12 * 60; // 12 giờ
  const xs = series(n, everySec, (i) => (i < n - 5 ? 50 : 50 + (i - (n - 6)) * 4));
  const r = rate({
    mode: 'points',
    windows: [{ sec: 300, threshold: 10 }, { sec: 43200, threshold: 30 }],
    smooth: false,
  });
  const out = evalAt(xs, r, 'gt', everySec);
  const short = out.windows.find((w) => w.windowSec === 300);
  const long = out.windows.find((w) => w.windowSec === 43200);
  check(!!short?.breaching, 'cửa sổ 5 phút BẮT được cú vọt 20 điểm');
  check(!long?.breaching, 'cửa sổ 12 giờ pha loãng cú vọt đó thành không vượt');
  check(out.breaching, 'watch vẫn BÁO — vượt ở BẤT KỲ cửa sổ nào là đủ');
  check(out.lead?.windowSec === 300, 'cảnh báo nêu đúng cửa sổ đã kích hoạt');
}

// ── 4. Cửa sổ dài bắt rò rỉ chậm mà cửa sổ ngắn không thấy ──────────────────
//
// Chiều ngược lại của ca 3: mỗi 5 phút chỉ nhích 0,15 điểm — chẳng ngưỡng
// ngắn hạn nào bắt được, nhưng 12 tiếng là +21 điểm.
{
  const everySec = 60;
  const n = 12 * 60;
  const xs = series(n, everySec, (i) => 50 + i * (21 / n));
  const r = rate({
    mode: 'points',
    windows: [{ sec: 300, threshold: 5 }, { sec: 43200, threshold: 20 }],
    smooth: false,
  });
  const out = evalAt(xs, r, 'gt', everySec);
  check(!out.windows.find((w) => w.windowSec === 300)?.breaching, 'cửa sổ 5 phút KHÔNG thấy rò rỉ chậm');
  check(!!out.windows.find((w) => w.windowSec === 43200)?.breaching, 'cửa sổ 12 giờ BẮT được rò rỉ chậm (+21 điểm)');
}

// ── 5. ETA bắt ca mà ngưỡng-tốc-độ bỏ lọt vĩnh viễn ─────────────────────────
//
// Đĩa tăng 0,5 GB/giờ — rất chậm, không ngưỡng tốc độ hợp lý nào bắt. Nhưng
// chỉ còn trống 2 GB → cạn sau 4 giờ. Đây chính là lý do eta là mặc định cho
// chỉ số có trần.
{
  const everySec = 300;
  const n = 24; // 2 giờ
  const xs = series(n, everySec, (i) => 98 + i * 0.02, (i) => 2 - i * (0.5 / 12));
  const out = evalAt(xs, rate({ mode: 'eta', windows: [{ sec: 3600, threshold: 6 }], smooth: false }), 'lt', everySec);
  check(out.breaching, 'ETA báo: sẽ cạn trong dưới 6 giờ dù tốc độ rất chậm');
  const hours = (out.lead?.etaSec ?? 0) / 3600;
  check(hours > 2 && hours < 6, `ETA ước lượng hợp lý: ~${hours.toFixed(1)} giờ`);

  // Cùng tốc độ đó nhưng volume còn rỗng → KHÔNG được báo.
  const roomy = series(n, everySec, (i) => 10 + i * 0.02, () => 900);
  const calm = evalAt(roomy, rate({ mode: 'eta', windows: [{ sec: 3600, threshold: 6 }], smooth: false }), 'lt', everySec);
  check(!calm.breaching, 'cùng tốc độ trên volume còn rỗng → KHÔNG báo (đúng)');
}

// ── 6. ETA không báo khi chỉ số đứng im hoặc đang giảm ──────────────────────
{
  const everySec = 300;
  const flat = series(12, everySec, () => 80, () => 20);
  const out = evalAt(flat, rate({ mode: 'eta', windows: [{ sec: 3600, threshold: 24 }], smooth: false }), 'lt', everySec);
  check(!out.breaching && out.lead?.etaSec === null, 'đứng im → không có ETA, không báo');
}

// ── 7. Reset sau restart KHÔNG được đẻ ra "tăng 400%" ───────────────────────
//
// Rủi ro báo giả số một. Redis restart → memUsedMb về gần 0 → nhịp sau tăng
// vọt. Buffer phải bị xoá, và việc xoá phải nói ra được (cờ reset).
{
  const r = rate({ mode: 'relative', windows: [{ sec: 900, threshold: 50 }], smooth: false });
  let buf: RateSample[] = [];
  let sawReset = false;
  // 10 nhịp ổn định ở 4000 MB, rồi restart về 200, rồi bò lên lại.
  const vals = [...Array.from({ length: 10 }, () => 4000), 200, 260, 320, 380, 440];
  vals.forEach((v, i) => {
    const res = pushSample(buf, { at: T0 + i * 60000, value: v }, r, 60);
    buf = res.buf;
    if (res.reset) sawReset = true;
  });
  check(sawReset, 'tụt sâu được nhận ra là RESET (không im lặng nuốt)');
  check(buf.length === 5, 'buffer bị xoá về đúng phần sau restart');
  const out = evalAt(buf, r, 'gt', 60);
  check(!out.breaching, 'không đẻ ra cảnh báo giả "tăng 400%" ngay sau restart');
  check(out.pending, 'sau restart watch quay lại "đang gom dữ liệu" cho tới khi đủ một cửa sổ thật');

  // …và khi cửa sổ đã bao trọn một chu kỳ THẬT sau restart thì lại canh bình
  // thường: chống báo giả không được biến thành bịt miệng vĩnh viễn.
  let grown = buf;
  for (let i = 0; i < 20; i += 1) {
    grown = pushSample(grown, { at: T0 + (15 + i) * 60000, value: 440 + i * 60 }, r, 60).buf;
  }
  check(evalAt(grown, r, 'gt', 60).breaching, 'qua đủ một cửa sổ sau restart thì canh lại bình thường');

  // Và giảm NHẸ thì KHÔNG được coi là reset (GC nhả heap, đĩa dọn dần).
  const mild = pushSample(
    [{ at: T0, value: 100 }],
    { at: T0 + 60000, value: 85 },
    rate({ mode: 'points', windows: [{ sec: 600, threshold: 5 }] }),
    60,
  );
  check(!mild.reset && mild.buf.length === 2, 'giảm nhẹ 15% KHÔNG bị nhầm là restart');
}

// ── 8. Buffer không được phình vô hạn ───────────────────────────────────────
{
  const r = rate({ mode: 'points', windows: [{ sec: 3600, threshold: 5 }] });
  let buf: RateSample[] = [];
  for (let i = 0; i < 5000; i += 1) {
    buf = pushSample(buf, { at: T0 + i * 15000, value: 50 + (i % 7) }, r, 15).buf;
  }
  check(buf.length <= 3600 / 15 + 6, `buffer bị cắt theo cửa sổ (${buf.length} mẫu, không phải 5000)`);
}

// ── 9. Làm mượt khử nhiễu mà KHÔNG làm phẳng cú đột biến ────────────────────
//
// Lý do chọn trung bình đầu mút thay vì hồi quy: hồi quy chống nhiễu tốt hơn
// nhưng nó làm phẳng đúng cái ta cần bắt.
{
  const everySec = 60;
  // Nền 50 có nhiễu ±3, 5 phút cuối vọt lên 75.
  const n = 30;
  const xs = series(n, everySec, (i) => (i < n - 5 ? 50 + (i % 2 ? 3 : -3) : 75));
  const smoothed = evalAt(xs, rate({ mode: 'points', windows: [{ sec: 1800, threshold: 15 }], smooth: true }), 'gt', everySec);
  check(smoothed.breaching, 'làm mượt vẫn BẮT được cú vọt 25 điểm');

  // Nhiễu thuần, không có xu hướng → không được báo.
  const noise = series(30, everySec, (i) => 50 + (i % 2 ? 4 : -4));
  const calm = evalAt(noise, rate({ mode: 'points', windows: [{ sec: 1800, threshold: 5 }], smooth: true }), 'gt', everySec);
  check(!calm.breaching, 'nhiễu thuần ±4 không tạo cảnh báo giả');
}

// ── 10. Chiều GIẢM: "đĩa còn trống đang tụt" ────────────────────────────────
//
// hostDiskFreeGb tụt là cảnh báo hữu ích hơn "% tăng" — nó nói thẳng còn bao
// nhiêu. Op 'lt' với delta âm.
{
  const everySec = 60;
  const xs = series(20, everySec, (i) => 100 - i * 0.8);
  const out = evalAt(xs, rate({ mode: 'absolute', windows: [{ sec: 900, threshold: -10 }], smooth: false }), 'lt', everySec);
  check(out.breaching, 'đĩa còn trống tụt >10 GB trong 15 phút → báo (chiều giảm)');
  check((out.lead?.delta ?? 0) < 0, 'delta âm thể hiện đúng chiều tụt');
}

// ── Kết ─────────────────────────────────────────────────────────────────────

if (failures) {
  console.error(`\ncheck:rate THẤT BẠI — ${failures} ca sai.`);
  process.exit(1);
}
console.log('\ncheck:rate OK — phép tính tốc độ đúng trên mọi ca đã soát.');
