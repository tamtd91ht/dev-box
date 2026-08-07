// Client helpers cho tab Remote — sổ máy từ xa + bật client điều khiển.
//
// Cùng luật với lib/passwords: renderer là nơi DUY NHẤT thấy plaintext mật
// khẩu; niêm phong bằng safeStorage trước khi POST lên /api/remote, và chỉ mở
// niêm phong đúng lúc người dùng bấm "chép mật khẩu".

import type { RemoteHost, RemoteKind } from './remoteHosts';

export type { RemoteHost, RemoteKind };

async function rmAction<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/remote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  }
  return (data as { result: T }).result;
}

/** Đang chạy trong app desktop (có cầu Electron) hay web thuần. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && typeof window.workspace?.openRemote === 'function';
}

/** safeStorage dùng được không — quyết định mật khẩu có được mã hoá hay không. */
export function canEncrypt(): boolean {
  return typeof window !== 'undefined' && typeof window.workspace?.encryptSecret === 'function';
}

/** Niêm phong mật khẩu. Không có safeStorage thì KHÔNG lưu — thà không có
 *  tính năng còn hơn ghi mật khẩu máy chủ ra đĩa dạng đọc được. */
async function seal(plain: string): Promise<string> {
  const enc = window.workspace?.encryptSecret;
  if (!enc) throw new Error('Máy này không mã hoá được — chỉ lưu mật khẩu khi chạy app desktop.');
  const r = await enc(plain).catch(() => null);
  if (!r?.ok || !r.value) {
    throw new Error('Không niêm phong được mật khẩu (safeStorage không khả dụng).');
  }
  return r.value;
}

export const listHosts = () => rmAction<RemoteHost[]>('list');
export const removeHost = (id: string) => rmAction<RemoteHost[]>('remove', { id });

export interface HostForm {
  name: string;
  kind: RemoteKind;
  address: string;
  username?: string;
  /** Plaintext từ ô nhập; được niêm phong ở đây trước khi gửi đi. */
  password?: string;
  project?: string;
  note?: string;
  tags?: string[];
  network?: 'lan' | 'wan';
}

/** Dựng payload chung cho add/update: niêm phong mật khẩu nếu người dùng nhập. */
async function payloadOf(f: Partial<HostForm>, includeEmptyPassword: boolean) {
  const { password, ...rest } = f;
  const out: Record<string, unknown> = { ...rest };
  if (password) out.passwordEnc = await seal(password);
  // Sửa máy mà xoá trắng ô mật khẩu = bỏ mật khẩu đã lưu (null ở API).
  else if (includeEmptyPassword && password === '') out.passwordEnc = null;
  return out;
}

export const addHost = async (f: HostForm) =>
  rmAction<RemoteHost[]>('add', await payloadOf(f, false));

export const updateHost = async (id: string, patch: Partial<HostForm>) =>
  rmAction<RemoteHost[]>('update', { id, ...(await payloadOf(patch, true)) });

/**
 * Bật client điều khiển cho một máy và ghi nhận lần dùng.
 *
 * Trả về `manual: true` khi client không nhận ID qua dòng lệnh (UltraViewer) —
 * lúc đó ID đã nằm sẵn trong clipboard, UI nhắc người dùng dán vào.
 */
export async function openHost(h: RemoteHost): Promise<{ manual: boolean }> {
  const open = window.workspace?.openRemote;
  if (!open) throw new Error('Chỉ bật được phần mềm điều khiển khi chạy app desktop.');
  const r = await open({ kind: h.kind, address: h.address, username: h.username });
  if (!r?.ok) throw new Error(r?.error || 'Không bật được phần mềm điều khiển.');
  // Ghi nhận để xếp "hay dùng" — hỏng cũng không ảnh hưởng việc đã mở.
  rmAction<RemoteHost[]>('touch', { id: h.id }).catch(() => {});
  return { manual: !!r.manual };
}

/** Chép mật khẩu đã lưu vào clipboard. Đây là lần DUY NHẤT nó được mở niêm
 *  phong — không hiện ra màn hình, không ghi vào log. */
export async function copyPassword(h: RemoteHost): Promise<void> {
  if (!h.passwordEnc) throw new Error('Máy này chưa lưu mật khẩu.');
  const dec = window.workspace?.decryptSecret;
  if (!dec) throw new Error('Mật khẩu được mã hoá bằng safeStorage — mở app desktop để dùng.');
  const r = await dec(h.passwordEnc).catch(() => null);
  if (!r?.ok || r.value === undefined) {
    throw new Error('Không giải mã được (file có thể được copy từ máy/user Windows khác).');
  }
  const copy = window.workspace?.copyText;
  if (copy) await copy(r.value);
  else await navigator.clipboard.writeText(r.value);
}

/** Chép địa chỉ/ID máy — tiện khi muốn dán tay vào client khác. */
export async function copyAddress(h: RemoteHost): Promise<void> {
  const copy = window.workspace?.copyText;
  if (copy) await copy(h.address);
  else await navigator.clipboard.writeText(h.address);
}
