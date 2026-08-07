// Type + hằng số THUẦN của tab Remote — KHÔNG import fs/path/crypto.
//
// Vì sao tách khỏi lib/remoteHosts.ts: RemoteWorkspace.tsx là client component
// ('use client') và cần KIND_META/REMOTE_KINDS để vẽ form. Chúng là GIÁ TRỊ
// runtime nên không thể `import type` như lib/remote.ts làm với RemoteHost.
// Nếu import từ remoteHosts.ts thì Next.js bundle cả file đó cho browser, kéo
// theo `fs` → "Module not found: Can't resolve 'fs'".
//
// Luật: file này chỉ chứa thứ CHẠY ĐƯỢC Ở CẢ HAI PHÍA. Hàm nào đọc/ghi đĩa thì
// để bên remoteHosts.ts.

/** Cách kết nối tới một máy. Quyết định DevBox gọi client nào. */
export type RemoteKind = 'ultraviewer' | 'rdp' | 'vnc' | 'anydesk' | 'teamviewer';

export interface RemoteHost {
  id: string;
  /** Tên gợi nhớ — "Máy build CI", "PC anh Tuấn kế toán". */
  name: string;
  kind: RemoteKind;
  /**
   * Địa chỉ máy. Ý nghĩa tuỳ `kind`:
   *   ultraviewer / anydesk / teamviewer → ID phần mềm sinh ra (chuỗi số)
   *   rdp / vnc                          → host[:port] hoặc IP
   */
  address: string;
  /** Tài khoản đăng nhập (RDP hay dùng; UltraViewer thì bỏ trống). */
  username?: string;
  /** Mật khẩu ĐÃ niêm phong bằng safeStorage — base64, không phải plaintext. */
  passwordEnc?: string;
  /** Dự án/nhóm để lọc, giống `project` bên links.json. */
  project?: string;
  /** Ghi chú: máy này dùng làm gì, lưu ý khi vào, giờ được phép truy cập… */
  note?: string;
  tags?: string[];
  /** Máy nội bộ hay ngoài internet — chỉ để hiển thị và lọc. */
  network?: 'lan' | 'wan';
  addedAt: string;
  /** Lần mở gần nhất (ISO) — xếp máy hay dùng lên đầu. */
  lastUsedAt?: string;
  /** Số lần đã mở. */
  useCount?: number;
}

export interface RemoteHostInput {
  name?: string;
  kind?: RemoteKind;
  address?: string;
  username?: string;
  passwordEnc?: string | null;
  project?: string;
  note?: string;
  tags?: string[];
  network?: 'lan' | 'wan';
}

export const REMOTE_KINDS: RemoteKind[] = ['ultraviewer', 'rdp', 'vnc', 'anydesk', 'teamviewer'];

/** Nhãn tiếng Việt + gợi ý điền địa chỉ cho từng loại, dùng chung cho UI. */
export const KIND_META: Record<RemoteKind, { label: string; hint: string; icon: string }> = {
  ultraviewer: { label: 'UltraViewer', hint: 'ID UltraViewer (vd 123 456 789)', icon: '🖥' },
  rdp: { label: 'Remote Desktop (RDP)', hint: 'IP hoặc tên máy, vd 10.0.0.5:3389', icon: '🪟' },
  vnc: { label: 'VNC', hint: 'IP[:port], vd 10.0.0.5:5900', icon: '👁' },
  anydesk: { label: 'AnyDesk', hint: 'ID AnyDesk (vd 123456789)', icon: '🔷' },
  teamviewer: { label: 'TeamViewer', hint: 'ID TeamViewer', icon: '🔵' },
};

/**
 * Địa chỉ hợp lệ chưa. Chặn ngay ở đây vì chuỗi này sẽ được ghép vào tham số
 * dòng lệnh của client (mstsc /v:…) — ký tự lạ ở đây là chỗ để chèn tham số
 * bậy. Chỉ cho chữ, số, dấu chấm, gạch, hai chấm, @ và khoảng trắng (ID
 * UltraViewer hay viết cách nhóm ba số).
 *
 * Để ở file dùng chung để form phía client kiểm tra được TRƯỚC khi gửi lên,
 * mà server vẫn kiểm lại lần nữa (không tin input từ client).
 */
const ADDRESS_OK = /^[A-Za-z0-9._\-:@ ]{1,128}$/;

export function validAddress(addr: string): boolean {
  return ADDRESS_OK.test(addr.trim());
}
