// Client helpers cho trình quản lý mật khẩu tab Browser.
//
// ĐÂY là nơi DUY NHẤT thấy plaintext: niêm phong bằng safeStorage (qua
// window.workspace.encryptSecret → main process) TRƯỚC khi POST lên
// /api/passwords, và mở niêm phong sau khi nhận về. Server chỉ giữ ciphertext.

export interface SealedSecret {
  cipher: 'safeStorage' | 'none';
  value: string;
}

export interface Credential {
  id: string;
  origin: string;
  username: string;
  profile?: string;
  label?: string;
  savedAt: string;
  usedAt?: string;
  hasPassword: boolean;
  cipher: SealedSecret['cipher'];
}

/** Bản ghi kèm mật khẩu đã mở niêm phong — chỉ tồn tại trong bộ nhớ renderer. */
export interface CredentialOpen {
  id: string;
  username: string;
  password: string;
  profile?: string;
  label?: string;
}

async function pwAction<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/passwords', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return (data as { result: T }).result;
}

/** safeStorage có dùng được không (desktop + OS hỗ trợ keyring/DPAPI). */
export function canEncrypt(): boolean {
  return typeof window !== 'undefined' && typeof window.workspace?.encryptSecret === 'function';
}

/** Niêm phong mật khẩu. Không có safeStorage (chạy web thuần) → cipher:'none';
 *  UI hiển thị cảnh báo cho bản ghi dạng này chứ không lặng lẽ giả vờ đã mã hóa. */
async function seal(plain: string): Promise<SealedSecret> {
  const enc = window.workspace?.encryptSecret;
  if (enc) {
    const r = await enc(plain).catch(() => null);
    if (r?.ok && r.value) return { cipher: 'safeStorage', value: r.value };
  }
  return { cipher: 'none', value: plain };
}

async function unseal(s: SealedSecret): Promise<string> {
  if (s.cipher !== 'safeStorage') return s.value;
  const dec = window.workspace?.decryptSecret;
  if (!dec) throw new Error('Mật khẩu này được mã hóa bằng safeStorage — mở app desktop để dùng.');
  const r = await dec(s.value).catch(() => null);
  if (!r?.ok || r.value === undefined) {
    throw new Error('Không giải mã được mật khẩu (file có thể được copy từ máy/user Windows khác).');
  }
  return r.value;
}

export const pwList = () => pwAction<Credential[]>('list');
export const pwRemove = (id: string) => pwAction<Credential[]>('remove', { id });
export const pwTouch = (id: string) => pwAction<{ ok: true }>('touch', { id }).catch(() => undefined);

export const pwSave = async (
  url: string, username: string, password: string,
  meta: { profile?: string; label?: string } = {},
) => pwAction<Credential[]>('save', { url, username, password: await seal(password), ...meta });

export const pwUpdate = async (
  id: string,
  patch: { username?: string; password?: string; profile?: string; label?: string },
) => {
  const { password, ...rest } = patch;
  // Bỏ trống ô mật khẩu = giữ nguyên mật khẩu cũ (không gửi field lên).
  return pwAction<Credential[]>('update', {
    id, ...rest, ...(password ? { password: await seal(password) } : {}),
  });
};

/** Mật khẩu đã lưu khớp một URL, đã mở niêm phong — để autofill / bấm 🔑.
 *  Bản ghi nào không giải mã được thì BỎ QUA (không làm hỏng cả danh sách). */
export async function pwMatch(url: string, profile?: string): Promise<CredentialOpen[]> {
  const sealed = await pwAction<(Omit<CredentialOpen, 'password'> & { password: SealedSecret })[]>(
    'match', { url, profile },
  );
  const out: CredentialOpen[] = [];
  for (const c of sealed) {
    try {
      out.push({ ...c, password: await unseal(c.password) });
    } catch { /* bản ghi lỗi mã hóa — bỏ qua */ }
  }
  return out;
}

/** Lộ mật khẩu của một bản ghi (nút 👁 trong trình quản lý). */
export async function pwReveal(id: string): Promise<string> {
  return unseal(await pwAction<SealedSecret>('reveal', { id }));
}

/** https://host:port — hiển thị gọn trong danh sách. */
export function hostOfOrigin(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}
