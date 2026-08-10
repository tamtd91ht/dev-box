// Server-only Google OAuth 2.0 for the Google tab,
// MULTI-ACCOUNT: mỗi lần "＋ Thêm tài khoản" chạy lại consent flow và lưu thêm
// một entry — mọi API call sau đó chỉ định accountId.
//
// Flow (standard "loopback" for local dev tools):
//   1. Dev creates an OAuth client (type Web) on console.cloud.google.com,
//      adds http://localhost:3000/api/google/callback as redirect URI, puts
//      GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env.local.
//   2. UI opens authUrl() in a new tab → Google consent (select_account cho
//      phép chọn tài khoản khác) → /api/google/callback?code=… →
//      exchangeCode() upserts the account (keyed by email) on disk.
//   3. Drive calls go through getAccessToken(accountId), which silently
//      refreshes that account's token when stale.
//
// Tokens live in .googleauth.json (gitignored, per-machine):
//   { accounts: [{ id, email, refresh_token, access_token, expiry, scope }] }
//
// SCOPE: drive.readonly (duyệt mọi thứ đã có) + drive.file (TẠO mới; Google chỉ
// cho sửa/xoá đúng những file do app này tạo, nên tài liệu cũ của người dùng
// không thể bị DevBox làm hỏng). Sửa nội dung vẫn mở UI của Google.
//
// `scope` được lưu lại vì đó là scope Google THỰC SỰ cấp — tài khoản đăng nhập
// từ trước khi có tính năng tạo mới chỉ có readonly, và UI phải biết điều đó để
// mời consent lại thay vì để người dùng ăn lỗi 403 khi bấm Tạo.

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { configPath } from './configDir';

const on = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? '');

export const GOOGLE_ENABLED = on(process.env.GOOGLE_TOOL_ENABLED);
const CLIENT_ID = (process.env.GOOGLE_CLIENT_ID ?? '').trim();
const CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET ?? '').trim();
const REDIRECT_URI = (process.env.GOOGLE_OAUTH_REDIRECT ?? 'http://localhost:3000/api/google/callback').trim();

export const GOOGLE_CONFIGURED = CLIENT_ID.length > 0 && CLIENT_SECRET.length > 0;

const BASE_SCOPES = ['openid', 'email'];
/** Tab Google — DUYỆT toàn bộ Drive (My Drive + Shared Drives), chỉ đọc. */
const DRIVE_READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
/**
 * TẠO file/thư mục mới, và chỉ sửa được thứ DevBox tự tạo ra.
 *
 * Vì sao không xin scope `drive` toàn quyền: `drive.file` cho tạo mới thoải mái
 * nhưng Google chỉ cấp quyền sửa/xoá trên đúng những file do app này tạo. Tức là
 * một lỗi trong code DevBox KHÔNG thể làm hỏng tài liệu cũ của bạn — giới hạn đó
 * do Google bảo đảm ở tầng token, không phải do mình tự giữ kỷ luật.
 *
 * Cặp readonly + file là có ý: readonly để DUYỆT được mọi thứ đã có, file để
 * TẠO được cái mới. Thiếu readonly thì cây Drive trống trơn (drive.file không
 * thấy file cũ); thiếu file thì không tạo được gì.
 */
const DRIVE_WRITE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** Tab Mail — IMAP/SMTP qua XOAUTH2. Google KHÔNG có scope hẹp hơn cho IMAP:
 *  https://mail.google.com/ là scope duy nhất mail server chấp nhận. */
const MAIL_SCOPE = 'https://mail.google.com/';

/** Tính năng nào cần quyền gì. Xin quyền THEO NHU CẦU (incremental auth) thay
 *  vì gộp hết vào một lần: người chỉ dùng Drive không phải cấp quyền mail, và
 *  người đã đăng nhập Drive trước đó không bị bắt consent lại. */
export type GoogleFeature = 'drive' | 'mail';

/** Một feature có thể cần NHIỀU scope (drive = duyệt + tạo). */
const FEATURE_SCOPES: Record<GoogleFeature, string[]> = {
  drive: [DRIVE_READ_SCOPE, DRIVE_WRITE_SCOPE],
  mail: [MAIL_SCOPE],
};

const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH ? path.resolve(process.cwd(), process.env.GOOGLE_TOKEN_PATH) : configPath('googleauth.json', ['.googleauth.json']);

interface AccountTokens {
  id: string;
  email?: string;
  refresh_token: string;
  access_token: string;
  /** Epoch ms when access_token expires. */
  expiry: number;
  /** Scope Google THỰC SỰ đã cấp (không phải cái ta xin) — dùng để biết tài
   *  khoản này đã có quyền mail chưa. Bản ghi cũ không có field này. */
  scope?: string;
}

interface TokenFile {
  accounts: AccountTokens[];
}

async function readStore(): Promise<TokenFile> {
  try {
    const raw = await fs.readFile(TOKEN_PATH, 'utf8');
    const data = JSON.parse(raw) as TokenFile & { refresh_token?: string; access_token?: string; expiry?: number; email?: string };
    if (Array.isArray(data.accounts)) {
      return { accounts: data.accounts.filter((a) => a && a.refresh_token) };
    }
    // Legacy single-account shape → wrap as one account.
    if (data.refresh_token && data.access_token) {
      return {
        accounts: [{
          id: data.email ?? 'default',
          email: data.email,
          refresh_token: data.refresh_token,
          access_token: data.access_token,
          expiry: data.expiry ?? 0,
        }],
      };
    }
    return { accounts: [] };
  } catch {
    return { accounts: [] };
  }
}

async function writeStore(store: TokenFile): Promise<void> {
  await fs.writeFile(TOKEN_PATH, JSON.stringify(store, null, 2), 'utf8');
}

/** URL consent. features = tính năng cần quyền ('drive' mặc định như trước;
 *  'mail' để dùng IMAP/SMTP Gmail qua XOAUTH2).
 *  loginHint: gợi ý sẵn địa chỉ để Google khỏi bắt chọn lại tài khoản. */
export function authUrl(features: GoogleFeature[] = ['drive'], loginHint?: string): string {
  if (!GOOGLE_CONFIGURED) throw new Error('Chưa cấu hình GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET trong .env.local.');
  const wanted = features.length > 0 ? features : ['drive' as GoogleFeature];
  const scopes = [...new Set([...BASE_SCOPES, ...wanted.flatMap((f) => FEATURE_SCOPES[f] ?? [])])];
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scopes.join(' '));
  u.searchParams.set('access_type', 'offline');            // refresh_token
  u.searchParams.set('prompt', 'consent select_account');  // luôn cho CHỌN tài khoản (multi-account) + re-issue refresh_token
  // Giữ lại quyền đã cấp trước đó — thêm quyền mail KHÔNG làm mất quyền Drive.
  u.searchParams.set('include_granted_scopes', 'true');
  if (loginHint) u.searchParams.set('login_hint', loginHint);
  return u.toString();
}

/** Decode a JWT payload without verification — only to READ the email Google
 *  just handed us over TLS (we never trust it for authz decisions). */
function jwtEmail(idToken: string | undefined): string | undefined {
  try {
    if (!idToken) return undefined;
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  /** Danh sách scope Google cấp, cách nhau khoảng trắng. */
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }).toString(),
  });
  const data = (await r.json().catch(() => ({}))) as TokenResponse;
  if (!r.ok || data.error) {
    throw new Error(`Google token endpoint: ${data.error ?? r.status} ${data.error_description ?? ''}`.trim());
  }
  return data;
}

/** Upsert the freshly consented account (keyed by email — đăng nhập lại cùng
 *  email thì thay token cũ, email mới thì thêm tài khoản mới). */
export async function exchangeCode(code: string): Promise<{ id: string; email?: string }> {
  const data = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  if (!data.refresh_token) {
    throw new Error('Google không trả refresh_token — thu hồi quyền cũ tại myaccount.google.com/permissions rồi đăng nhập lại.');
  }
  const email = jwtEmail(data.id_token);
  const store = await readStore();
  const existing = email ? store.accounts.find((a) => a.email === email) : undefined;
  const granted = [...new Set([...(existing?.scope ?? '').split(' '), ...(data.scope ?? '').split(' ')])]
    .filter(Boolean);
  const acc: AccountTokens = {
    id: existing?.id ?? (email ?? randomUUID()),
    email,
    refresh_token: data.refresh_token,
    access_token: data.access_token,
    expiry: Date.now() + (data.expires_in - 60) * 1000,
    // Gộp với scope đã có: include_granted_scopes=true nên lần cấp quyền mail
    // vẫn giữ quyền Drive, nhưng response chỉ liệt kê scope của lần này.
    scope: granted.join(' '),
  };
  store.accounts = [...store.accounts.filter((a) => a.id !== acc.id), acc];
  await writeStore(store);

  /**
   * CHẶN Ở ĐÂY, KHÔNG ĐỂ LỘ RA THÀNH LỖI Ở TẦNG DRIVE.
   *
   * Nếu Google chỉ cấp openid/email mà không có scope Drive nào, mọi lệnh Drive
   * sau đó sẽ chết bằng "Request had insufficient authentication scopes" — một
   * thông báo không hề nói rằng vấn đề nằm ở bước đăng nhập, nên rất khó truy.
   * Đây là ca ĐÃ XẢY RA THẬT: token lưu trên máy chỉ có `openid email`.
   *
   * Hai nguyên nhân thường gặp, cả hai đều nằm ngoài code:
   *   1. Màn hình consent có ô tick cho từng quyền, người dùng bấm "Tiếp tục"
   *      mà chưa tick ô Drive → Google cấp đúng phần đã tick.
   *   2. OAuth client trên console chưa khai scope Drive (hoặc app ở chế độ
   *      Testing mà tài khoản không nằm trong danh sách test user).
   * Token vẫn được LƯU (để không mất phiên đăng nhập), nhưng ta báo ngay và nói
   * rõ phải làm gì.
   */
  const hasDrive = granted.some((s) => s === DRIVE_READ_SCOPE || s === DRIVE_WRITE_SCOPE);
  if (!hasDrive) {
    throw new Error(
      'Google chỉ cấp quyền đăng nhập, KHÔNG cấp quyền Drive — nên tab Google sẽ báo ' +
        '"insufficient authentication scopes" khi duyệt hay tạo file.\n\n' +
        `Đã cấp: ${granted.join(', ') || '(không có gì)'}\n\n` +
        'Cách sửa: bấm đăng nhập lại, và ở màn hình Google nhớ TICK các ô quyền ' +
        'Google Drive rồi mới bấm Tiếp tục. Nếu màn hình không hiện ô Drive nào, ' +
        'kiểm tra OAuth consent screen trên console.cloud.google.com đã thêm hai scope ' +
        `"${DRIVE_READ_SCOPE}" và "${DRIVE_WRITE_SCOPE}" chưa (và nếu app đang ở chế độ ` +
        'Testing thì email của bạn phải nằm trong Test users).',
    );
  }
  return { id: acc.id, email };
}

/** Valid access token for ONE account, silently refreshed. */
export async function getAccessToken(accountId: string): Promise<string> {
  const store = await readStore();
  const acc = store.accounts.find((a) => a.id === accountId);
  if (!acc) throw new Error('Chưa đăng nhập Google (tài khoản không tồn tại trên máy này) — bấm "＋ Thêm tài khoản".');
  if (Date.now() < acc.expiry) return acc.access_token;
  const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: acc.refresh_token });
  acc.access_token = data.access_token;
  acc.expiry = Date.now() + (data.expires_in - 60) * 1000;
  await writeStore(store);
  return acc.access_token;
}

/** Remove ONE account: best-effort revoke + drop from the store. */
export async function logout(accountId: string): Promise<void> {
  const store = await readStore();
  const acc = store.accounts.find((a) => a.id === accountId);
  if (acc) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(acc.refresh_token)}`, { method: 'POST' })
      .catch(() => {});
  }
  store.accounts = store.accounts.filter((a) => a.id !== accountId);
  if (store.accounts.length === 0) await fs.unlink(TOKEN_PATH).catch(() => {});
  else await writeStore(store);
}

/** Tài khoản này đã được cấp quyền mail (IMAP/SMTP) chưa? */
export async function hasMailScope(accountId: string): Promise<boolean> {
  const store = await readStore();
  const acc = store.accounts.find((a) => a.id === accountId);
  return (acc?.scope ?? '').split(' ').includes(MAIL_SCOPE);
}

/**
 * Tài khoản này TẠO được file mới chưa (đã có `drive.file`)?
 *
 * Mọi tài khoản đã đăng nhập TRƯỚC khi có tính năng tạo mới chỉ mang
 * `drive.readonly`, nên phải consent lại một lần. UI đọc cờ này để hiện nút
 * "Cấp quyền tạo file" đúng chỗ, thay vì để người dùng bấm Tạo rồi ăn lỗi 403
 * từ Google mà không hiểu vì sao.
 */
export async function hasDriveWriteScope(accountId: string): Promise<boolean> {
  const store = await readStore();
  const acc = store.accounts.find((a) => a.id === accountId);
  return (acc?.scope ?? '').split(' ').includes(DRIVE_WRITE_SCOPE);
}

/** Token cho các lệnh GHI vào Drive. Chặn sớm với thông báo hiểu được, thay vì
 *  để Google trả 403 "Insufficient Permission" trần trụi. */
export async function getDriveWriteToken(accountId: string): Promise<string> {
  if (!(await hasDriveWriteScope(accountId))) {
    throw new Error(
      'Tài khoản này chưa cấp quyền tạo file. Bấm "Cấp quyền tạo file" để consent lại — ' +
        'DevBox chỉ sửa được file do chính nó tạo, không đụng tới tài liệu cũ của bạn.',
    );
  }
  return getAccessToken(accountId);
}

/** Tìm tài khoản Google đã đăng nhập theo địa chỉ email (khớp không phân biệt
 *  hoa/thường). Dùng khi tab Mail muốn tái sử dụng phiên đã có. */
export async function findAccountByEmail(email: string): Promise<GoogleAccountInfo | undefined> {
  const want = email.trim().toLowerCase();
  const store = await readStore();
  const a = store.accounts.find((x) => (x.email ?? '').toLowerCase() === want);
  return a ? { id: a.id, email: a.email, scopes: (a.scope ?? '').split(' ').filter(Boolean) } : undefined;
}

/** Access token để dùng XOAUTH2 với IMAP/SMTP Gmail. Báo lỗi rõ nếu tài khoản
 *  chưa được cấp quyền mail (thay vì để mail server từ chối cụt ngủn). */
export async function getMailAccessToken(accountId: string): Promise<string> {
  if (!(await hasMailScope(accountId))) {
    throw new Error(
      'Tài khoản Google này chưa cấp quyền truy cập mail. Bấm "Kết nối lại bằng Google" để cấp quyền IMAP/SMTP.',
    );
  }
  return getAccessToken(accountId);
}

export interface GoogleAccountInfo {
  id: string;
  email?: string;
  /** Scope đã được cấp — UI biết tài khoản dùng được cho mail hay chưa. */
  scopes?: string[];
  /** Tạo được file/thư mục mới chưa (đã có drive.file). */
  canWrite?: boolean;
  /** Duyệt được Drive chưa (đã có drive.readonly). */
  canRead?: boolean;
}

export interface GoogleStatus {
  configured: boolean;
  accounts: GoogleAccountInfo[];
  redirectUri: string;
}

export async function status(): Promise<GoogleStatus> {
  const store = await readStore();
  return {
    configured: GOOGLE_CONFIGURED,
    accounts: store.accounts.map((a) => {
      const scopes = (a.scope ?? '').split(' ').filter(Boolean);
      return {
        id: a.id,
        email: a.email,
        scopes,
        canWrite: scopes.includes(DRIVE_WRITE_SCOPE),
        canRead: scopes.includes(DRIVE_READ_SCOPE),
      };
    }),
    redirectUri: REDIRECT_URI,
  };
}
