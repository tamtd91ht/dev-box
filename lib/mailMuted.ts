// Ẩn thông báo cho từng hòm thư — trạng thái dùng chung giữa hai component.
//
// Cùng ý tưởng với nút ẩn thông báo của Workspace (lib/workspace/accounts.ts):
// ẨN ≠ TẮT ĐẾM. Server vẫn đếm INBOX UNSEEN như cũ, MailWorkspace vẫn hiện số
// trên đúng tab tài khoản đó — chỉ là số ấy KHÔNG cộng vào huy hiệu đỏ trên tab
// Mail và không đổi tiêu đề cửa sổ nữa.
//
// VÌ SAO PHẢI LÀ MODULE RIÊNG chứ không để state trong MailWorkspace: cái đọc
// cờ này (MailWatchHost) và cái bật/tắt nó (MailWorkspace) là hai component
// nằm ở hai nhánh khác nhau của cây, MailWatchHost lại mount NGOÀI mọi pane và
// chạy cả khi tab Mail chưa từng mở. Không có cha chung nào để nhấc state lên,
// nên nguồn sự thật đặt ở localStorage + một event để hai bên bám theo nhau.
//
// Danh sách lưu theo ID tài khoản, không phải email: đổi tên hiển thị hay sửa
// địa chỉ thì cờ vẫn dính đúng hòm thư đó.

const KEY = 'mail:mutedAccounts';

/** Bắn khi danh sách đổi — MailWatchHost nghe để tính lại tổng ngay lập tức. */
export const MAIL_MUTED_EVENT = 'devbox:mail-muted-changed';

/** ID các hòm thư đang ẩn thông báo. Hỏng/không có → tập rỗng (báo bình thường). */
export function loadMutedMail(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : null;
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Ghi lại + báo cho mọi nơi đang bám theo (kể cả tab/cửa sổ này). */
export function saveMutedMail(ids: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    /* quota / private mode — thôi thì phiên này không nhớ được */
  }
  // `storage` event chỉ bắn sang tab KHÁC, không bắn cho chính tab vừa ghi —
  // nên phải tự bắn một event nội bộ, nếu không badge sẽ không đổi cho tới lần
  // poll sau (tận 60 giây).
  window.dispatchEvent(new Event(MAIL_MUTED_EVENT));
}

/** Bật/tắt cờ ẩn của một hòm thư, trả về danh sách mới. */
export function toggleMutedMail(id: string): Set<string> {
  const next = loadMutedMail();
  if (next.has(id)) next.delete(id);
  else next.add(id);
  saveMutedMail(next);
  return next;
}
