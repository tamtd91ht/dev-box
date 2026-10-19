// Sổ đăng ký "ai đang chặn rời trang" — cho các nút chủ động điều hướng/thoát.
//
// VÌ SAO PHẢI CÓ: trong Electron, trang có handler `beforeunload` gọi
// preventDefault thì mọi location.replace/reload và cả app.quit() bị HUỶ IM
// LẶNG — sự kiện `will-prevent-unload` bắn về main process, main không xử lý
// (cố ý: không dùng dialog native trong app này) nên Chromium giữ trang lại mà
// không nói gì. Không dialog, không lỗi, không unload. Nút "Nạp lại sạch" từng
// treo vĩnh viễn ở "Đang dọn…" đúng vì vậy.
//
// Nên luồng nào SẮP rời trang (hard reload, relaunch, update) phải hỏi sổ này
// TRƯỚC khi làm việc không quay lại được (xoá .next, giết server): còn ai chặn
// thì dừng và nói rõ lý do, thay vì làm xong hết rồi đứng hình ở bước cuối.
//
// Ai muốn chặn unload thì đăng ký vào đây NGAY TẠI CHỖ addEventListener
// 'beforeunload' — hai thứ đó phải sống chết cùng nhau, lệch là sổ nói dối.

const blockers = new Map<symbol, string>();

/**
 * Ghi tên vào sổ chặn unload. Trả về hàm gạch tên — gọi trong cleanup của đúng
 * effect đã addEventListener('beforeunload').
 *
 * @param reason câu hiện thẳng cho người dùng, ví dụ "2 tài liệu Office chưa lưu"
 */
export function registerUnloadBlocker(reason: string): () => void {
  const id = Symbol();
  blockers.set(id, reason);
  return () => { blockers.delete(id); };
}

/** Danh sách lý do đang chặn rời trang — rỗng nghĩa là điều hướng/thoát sẽ đi được. */
export function getUnloadBlockers(): string[] {
  return [...blockers.values()];
}
