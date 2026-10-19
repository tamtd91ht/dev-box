// Cầu nối "file_done" cho upload FILE đính kèm.
//
// Zalo Web upload file theo kiểu BẤT ĐỐI XỨNG (khác ảnh): HTTP upload các chunk
// chỉ trả về fileId; còn fileUrl — thứ bắt buộc phải có để gửi tin asyncfile/msg
// — về SAU qua WebSocket (khung cmd 601, controls[].content.act_type =
// 'file_done'). Port từ zca-js: appContext.uploadCallbacks keyed theo fileId.
//
// Hệ quả vận hành: LISTENER PHẢI ĐANG CHẠY thì gửi file mới hoàn tất — route
// sendFile tự bật listener nếu chưa chạy, và thông điệp timeout nói thẳng điều
// đó thay vì để người dùng đoán.

const waiters = new Map<string, (r: { fileUrl: string }) => void>();

/** Chờ sự kiện file_done cho một fileId. Reject sau timeoutMs. */
export function waitFileDone(fileId: string, timeoutMs = 30_000): Promise<{ fileUrl: string }> {
  const key = String(fileId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(key);
      reject(new Error(
        `upload xong nhưng không nhận được file_done từ Zalo sau ${Math.round(timeoutMs / 1000)}s — `
        + 'listener (nhận tin) phải đang chạy thì mới bắt được sự kiện này.',
      ));
    }, timeoutMs);
    waiters.set(key, (r) => {
      clearTimeout(timer);
      waiters.delete(key);
      resolve(r);
    });
  });
}

/** Giao kết quả cho người đang chờ. true nếu có ai nhận. */
export function deliverFileDone(fileId: string, fileUrl: string): boolean {
  const w = waiters.get(String(fileId));
  if (!w) return false;
  w({ fileUrl });
  return true;
}

/**
 * Quét một payload WS đã giải mã tìm control 'file_done' rồi giao cho waiter.
 * Gọi từ listener trên MỌI khung giải mã được — schema Zalo đổi theo bản build
 * nên dò theo hình dạng (controls[].content.act_type), không theo số cmd.
 * `content.data` có build là object, có build là chuỗi JSON — chịu cả hai.
 */
export function scanFileDone(decoded: unknown): void {
  if (!decoded || typeof decoded !== 'object') return;
  const root = decoded as Record<string, unknown>;
  const holders = [root, root['data']].filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  for (const h of holders) {
    const controls = h['controls'];
    if (!Array.isArray(controls)) continue;
    for (const c of controls) {
      if (!c || typeof c !== 'object') continue;
      const content = (c as Record<string, unknown>)['content'];
      if (!content || typeof content !== 'object') continue;
      const ct = content as Record<string, unknown>;
      if (ct['act_type'] !== 'file_done') continue;
      let data = ct['data'];
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { continue; }
      }
      const url = data && typeof data === 'object' ? (data as Record<string, unknown>)['url'] : undefined;
      const fileId = ct['fileId'];
      if (typeof url === 'string' && url && fileId != null) {
        deliverFileDone(String(fileId), url);
      }
    }
  }
}
