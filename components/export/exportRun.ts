// Vòng lặp phân trang dùng chung cho xuất Excel (Mongo / ES / PG).
//
// Ba tab có ba cách lật trang khác nhau — Mongo đi bằng cursor _id, ES bằng
// search_after, PG bằng OFFSET — nhưng phần bao quanh thì giống hệt: lặp cho
// tới khi hết trang hoặc chạm trần, báo tiến độ, dừng khi người dùng huỷ. Gom
// phần đó về đây, mỗi tab chỉ cắm vào một hàm lấy-một-trang.
//
// VỀ BỘ NHỚ: mọi dòng vẫn phải nằm trong RAM một lúc vì ExcelJS dựng workbook
// trong bộ nhớ rồi mới sinh Blob — không có đường ghi thẳng ra đĩa từ trình
// duyệt. Cái vòng lặp này giải quyết vế khác của vấn đề: KHÔNG kéo hết mọi thứ
// về trong MỘT request (server sẽ ôm cả tập kết quả), và không dùng skip/from
// sâu dần (càng về sau càng chậm, ES thì chặn cứng ở 10.000).

/** Một trang dữ liệu + con trỏ để lấy trang kế. */
export interface ExportPage<C> {
  rows: Record<string, unknown>[];
  /** Con trỏ cho trang sau. undefined/null = hết dữ liệu. */
  next?: C | null;
}

export interface ExportRunOptions<C> {
  /** Lấy một trang. `cursor` là undefined ở lần gọi đầu. */
  fetchPage: (cursor: C | undefined) => Promise<ExportPage<C>>;
  /** Trần số dòng — dừng ngay khi chạm. */
  max: number;
  /** Báo tiến độ để UI hiện "Đang tải… N dòng". */
  onProgress?: (loaded: number) => void;
  /** Trả true để dừng giữa chừng (người dùng đóng modal). */
  isCancelled?: () => boolean;
}

export interface ExportRunResult {
  rows: Record<string, unknown>[];
  /** Đã chạm trần và còn dữ liệu chưa lấy. */
  capped: boolean;
  /** Dừng vì người dùng huỷ. */
  cancelled: boolean;
}

/**
 * Chạy vòng phân trang tới khi hết hoặc chạm trần.
 *
 * Chốt chặn vòng lặp vô hạn: một trang trả 0 dòng NHƯNG vẫn đưa con trỏ mới là
 * dừng luôn. Không có chốt này thì một con trỏ hỏng (hoặc backend trả rỗng mà
 * vẫn báo còn) sẽ quay vòng mãi mãi và treo tab của người dùng.
 */
export async function runExport<C>(opts: ExportRunOptions<C>): Promise<ExportRunResult> {
  const { fetchPage, max, onProgress, isCancelled } = opts;
  const rows: Record<string, unknown>[] = [];
  let cursor: C | undefined;
  let capped = false;

  for (;;) {
    if (isCancelled?.()) return { rows, capped, cancelled: true };
    onProgress?.(rows.length);

    const page = await fetchPage(cursor);
    for (const r of page.rows) rows.push(r);

    if (rows.length >= max) {
      // Chạm trần. `capped` chỉ đúng nghĩa "còn dữ liệu bị bỏ lại" khi backend
      // báo còn trang nữa — cắt đúng ở ranh giới cuối cùng thì không phải cắt.
      capped = page.next !== undefined && page.next !== null;
      rows.length = max;
      break;
    }
    if (page.next === undefined || page.next === null) break;
    if (page.rows.length === 0) break; // xem chốt chặn ở doc-comment
    cursor = page.next;
  }

  onProgress?.(rows.length);
  return { rows, capped, cancelled: false };
}

/** Parse JSON an toàn cho một dòng wire — dòng hỏng bị bỏ, không làm hỏng cả file. */
export function parseRows(items: { json: string }[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const it of items) {
    try { out.push(JSON.parse(it.json) as Record<string, unknown>); }
    catch { /* document bị cắt cụt ở tầng wire — bỏ dòng này */ }
  }
  return out;
}
