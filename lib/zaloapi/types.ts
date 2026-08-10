// Zalo API — kiểu dữ liệu dùng chung (phía renderer).
//
// Nhánh này đăng nhập Zalo Web bằng QR rồi tái dùng API nội bộ của Zalo (login
// + nhận WebSocket + gửi tin), tách hẳn khỏi luồng Workspace cũ (điều khiển
// DOM). Xử lý crypto/HTTP nằm ở server (lib/zaloapi/server/*, chạy Node).
//
// VÌ SAO TÁCH KHỎI WORKSPACE: khung Workspace giả định "một plugin = một
// <webview> hiển thị một web app". Client API không có trang để hiện; nhét vào
// WorkspaceView khiến mỗi nhánh mọc thêm `if (isApi)` và làm lung lay luồng cũ.
// Tách ra ⇒ luồng Workspace cũ không đổi một dòng.
//
// RỦI RO cần biết (vẫn đúng, không phải cảnh báo suông):
//   1. Vi phạm điều khoản Zalo — không có vùng xám.
//   2. Tài khoản CÓ THỂ bị hạn chế/khoá: gửi nhanh/nhiều/tới người lạ là mẫu bị
//      đánh dấu. Vì vậy runtime tự áp trần gửi (sendGate) và có công tắc riêng.
//   3. Credential là toàn quyền tài khoản Zalo cá nhân → chỉ giữ trong RAM
//      server, không ghi xuống đĩa (xem server/session.ts).
//   4. Gãy thì gãy sạch: Zalo đổi endpoint/crypto là mất, khác DOM (chỉ đổi
//      selector). Hằng số phiên bản nằm ở server/client.ts để cập nhật một chỗ.

/** Credential renderer đọc được từ guest — chỉ imei/uid (cookie do main lấy). */
export interface ZaloSession {
  /**
   * Định danh thiết bị Zalo Web đã sinh và lưu. PHẢI dùng đúng cái này, không
   * sinh lại — cookie gắn chặt với nó, lệch là mọi request bị từ chối.
   */
  imei: string;
  /** Số tài khoản đang đăng nhập (để hiển thị đối chiếu). */
  uid: string;
  /** User-Agent của guest — phải khớp khi login server-side. */
  userAgent: string;
}

/** Kết quả một lần trích xuất từ guest. */
export interface ExtractResult {
  /** Đã đăng nhập chưa (chưa thì mọi thứ sau vô nghĩa). */
  loggedIn: boolean;
  /** imei/uid/UA đọc được — null nếu lỗi. */
  session: ZaloSession | null;
  /** Câu giải thích ngắn cho người dùng. */
  detail: string;
}
