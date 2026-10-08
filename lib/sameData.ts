// So sánh nhanh hai giá trị JSON-thuần (kết quả poll) để setState chỉ chạy khi
// dữ liệu THẬT SỰ đổi. Mỗi lần poll trả về mảng mới tinh; setState thẳng vào thì
// React luôn coi là đổi và render lại cả panel dù nội dung y hệt.

export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/** Dạng dùng cho updater của setState: giữ nguyên tham chiếu cũ nếu không đổi. */
export function keepIfSame<T>(next: T): (prev: T) => T {
  return (prev) => (sameData(prev, next) ? prev : next);
}
