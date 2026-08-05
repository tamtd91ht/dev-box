// Trình quản lý mật khẩu local cho tab Browser — "như Chrome": lưu user/pass
// theo ORIGIN của trang, để lần sau vào lại tự điền, khỏi đi tìm ở nguồn khác.
//
// KHÁC bookmark: bookmark là link bạn tự lưu, credentials gắn vào từng dấu
// trang. Store này keyed theo origin nên MỌI trang bạn mở trong tab Browser
// (kể cả không phải dấu trang) đều dùng được, và một origin giữ được NHIỀU tài
// khoản (vd hai account SSO) — phân biệt thêm bằng profile của tab.
//
// ── VAULT MÙ ──────────────────────────────────────────────────────────────
// Store này KHÔNG BAO GIỜ thấy plaintext. Mật khẩu được RENDERER mã hóa bằng
// Electron safeStorage (DPAPI Windows) trước khi gửi lên, và chỉ renderer giải
// mã được — safeStorage chỉ có trong main process, còn Next server ở đây là
// process riêng do main spawn bằng ELECTRON_RUN_AS_NODE (xem ensureDevServer
// trong electron/main.cjs) nên không với tới được. Ở đây mật khẩu chỉ là một
// đối tượng mờ:
//   { cipher: 'safeStorage', value: '<base64 DPAPI>' }  ← desktop, đã mã hóa
//   { cipher: 'none',        value: '<plaintext>'    }  ← chạy `next dev` thuần
// Nhãn `cipher` đi kèm TỪNG bản ghi (không phải cả file) để máy đã mã hóa rồi
// mà lỡ mở bằng web thuần thì bản ghi cũ vẫn giải mã đúng, và UI biết bản nào
// đang nằm dạng plaintext để cảnh báo.
//
// File configs/passwords.json — nằm trong configs/ đã gitignored toàn bộ.

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { configPath } from './configDir';

/** Mật khẩu ở dạng lưu trữ — server chỉ chuyển tiếp, không giải mã. */
export interface SealedSecret {
  cipher: 'safeStorage' | 'none';
  value: string;
}

export interface Credential {
  id: string;
  /** Origin chuẩn hóa: https://host[:port] — khóa so khớp khi autofill. */
  origin: string;
  username: string;
  /** Profile session của tab lúc lưu — cho phép 2 tài khoản trên cùng origin. */
  profile?: string;
  /** Nhãn tự đặt (vd "acc test") — chỉ để người dùng nhận ra. */
  label?: string;
  savedAt: string;
  usedAt?: string;
}

/** Bản ghi cho danh sách UI: KHÔNG kèm mật khẩu, chỉ cho biết có/không + dạng. */
export type CredentialSafe = Credential & { hasPassword: boolean; cipher: SealedSecret['cipher'] };

/** Bản ghi kèm mật khẩu còn niêm phong — renderer tự giải mã để điền. */
export type CredentialSealed = Credential & { password: SealedSecret };

interface StoredCredential extends Credential {
  password: SealedSecret;
}

interface FileShape { items?: StoredCredential[] }

const REG_PATH = process.env.PASSWORDS_PATH
  ? path.resolve(process.cwd(), process.env.PASSWORDS_PATH)
  : configPath('passwords.json');

/** Bản ghi cũ có thể lưu password dạng chuỗi trần — nâng lên SealedSecret. */
function coerce(c: StoredCredential & { password: SealedSecret | string }): StoredCredential {
  const p = c.password;
  return { ...c, password: typeof p === 'string' ? { cipher: 'none', value: p } : p };
}

async function readAll(): Promise<StoredCredential[]> {
  try {
    const d = JSON.parse(await fs.readFile(REG_PATH, 'utf8')) as FileShape;
    return Array.isArray(d.items) ? d.items.map(coerce) : [];
  } catch { return []; }
}

async function writeAll(items: StoredCredential[]): Promise<void> {
  await fs.writeFile(REG_PATH, JSON.stringify({ items }, null, 2), 'utf8');
}

/** https://user:pw@host:443/path?q → https://host:443 — bỏ path/query/credentials. */
export function originOf(raw: string): string {
  try {
    const u = new URL(raw.trim());
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.origin;
  } catch { return ''; }
}

const strip = (c: StoredCredential): CredentialSafe => {
  const { password, ...rest } = c;
  return { ...rest, hasPassword: Boolean(password?.value), cipher: password?.cipher ?? 'none' };
};

export async function listCredentials(): Promise<CredentialSafe[]> {
  return (await readAll())
    .slice()
    .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username))
    .map(strip);
}

/** Bản ghi khớp một URL — dùng khi autofill và khi bấm 🔑. Trả mật khẩu CÒN
 *  NIÊM PHONG; renderer giải mã. Ưu tiên bản ghi cùng profile của tab, rồi bản
 *  ghi dùng chung (không gán profile). */
export async function matchCredentials(url: string, profile?: string): Promise<CredentialSealed[]> {
  const origin = originOf(url);
  if (!origin) return [];
  const prof = (profile ?? '').trim() || undefined;
  const hits = (await readAll()).filter((c) => c.origin === origin);
  return [
    ...hits.filter((c) => c.profile && c.profile === prof),
    ...hits.filter((c) => !c.profile),
    ...hits.filter((c) => c.profile && c.profile !== prof),
  ];
}

/** Mật khẩu niêm phong của MỘT bản ghi — cho nút 👁 trong trình quản lý. */
export async function sealedPassword(id: string): Promise<SealedSecret> {
  const c = (await readAll()).find((x) => x.id === id);
  if (!c) throw new Error('Không tìm thấy mật khẩu đã lưu.');
  return c.password;
}

interface SaveInput {
  url: string;
  username: string;
  password: SealedSecret;
  profile?: string;
  label?: string;
}

/** Lưu/cập nhật — trùng (origin, username, profile) thì GHI ĐÈ mật khẩu mới,
 *  đúng như Chrome khi bạn đổi mật khẩu rồi đăng nhập lại. */
export async function saveCredential(input: SaveInput): Promise<CredentialSafe[]> {
  const origin = originOf(input.url);
  if (!origin) throw new Error('URL không hợp lệ (chỉ http/https).');
  const username = input.username.trim();
  if (!input.password?.value) throw new Error('Chưa có mật khẩu để lưu.');

  const items = await readAll();
  const prof = (input.profile ?? '').trim() || undefined;
  const now = new Date().toISOString();

  const found = items.find((c) => c.origin === origin && c.username === username && c.profile === prof);
  if (found) {
    found.password = input.password;
    found.savedAt = now;
    if (input.label !== undefined) found.label = input.label.trim() || undefined;
  } else {
    items.unshift({
      id: randomUUID(), origin, username, profile: prof,
      label: (input.label ?? '').trim() || undefined,
      password: input.password, savedAt: now,
    });
  }
  await writeAll(items);
  return listCredentials();
}

export async function updateCredential(
  id: string,
  patch: { username?: string; password?: SealedSecret; profile?: string; label?: string },
): Promise<CredentialSafe[]> {
  const items = await readAll();
  const c = items.find((x) => x.id === id);
  if (!c) throw new Error('Không tìm thấy mật khẩu đã lưu.');
  if (patch.username !== undefined) c.username = patch.username.trim() || c.username;
  if (patch.profile !== undefined) c.profile = patch.profile.trim() || undefined;
  if (patch.label !== undefined) c.label = patch.label.trim() || undefined;
  // Bỏ trống mật khẩu trong form sửa = giữ nguyên mật khẩu cũ.
  if (patch.password?.value) c.password = patch.password;
  c.savedAt = new Date().toISOString();
  await writeAll(items);
  return listCredentials();
}

export async function removeCredential(id: string): Promise<CredentialSafe[]> {
  const items = await readAll();
  const next = items.filter((c) => c.id !== id);
  if (next.length === items.length) throw new Error('Không tìm thấy mật khẩu đã lưu.');
  await writeAll(next);
  return listCredentials();
}

/** Đánh dấu vừa dùng để autofill — cột "dùng lần cuối" trong trình quản lý. */
export async function touchCredential(id: string): Promise<void> {
  const items = await readAll();
  const c = items.find((x) => x.id === id);
  if (!c) return;
  c.usedAt = new Date().toISOString();
  await writeAll(items);
}
