// Server-only Google OAuth 2.0 for the Google tab (Drive read-only),
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
//   { accounts: [{ id, email, refresh_token, access_token, expiry }] }
// Scope is drive.readonly — the tab MANAGES documents (browse/search/open);
// editing happens on Google's own UI in the browser, so DevBox never writes.

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

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly'];

const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH ? path.resolve(process.cwd(), process.env.GOOGLE_TOKEN_PATH) : configPath('googleauth.json', ['.googleauth.json']);

interface AccountTokens {
  id: string;
  email?: string;
  refresh_token: string;
  access_token: string;
  /** Epoch ms when access_token expires. */
  expiry: number;
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

export function authUrl(): string {
  if (!GOOGLE_CONFIGURED) throw new Error('Chưa cấu hình GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET trong .env.local.');
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');            // refresh_token
  u.searchParams.set('prompt', 'consent select_account');  // luôn cho CHỌN tài khoản (multi-account) + re-issue refresh_token
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
  const acc: AccountTokens = {
    id: existing?.id ?? (email ?? randomUUID()),
    email,
    refresh_token: data.refresh_token,
    access_token: data.access_token,
    expiry: Date.now() + (data.expires_in - 60) * 1000,
  };
  store.accounts = [...store.accounts.filter((a) => a.id !== acc.id), acc];
  await writeStore(store);
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

export interface GoogleAccountInfo {
  id: string;
  email?: string;
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
    accounts: store.accounts.map((a) => ({ id: a.id, email: a.email })),
    redirectUri: REDIRECT_URI,
  };
}
