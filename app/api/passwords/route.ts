// /api/passwords — trình quản lý mật khẩu local cho tab Browser (configs/passwords.json).
//
// Mật khẩu đi qua đây ở dạng ĐÃ NIÊM PHONG ({ cipher, value }) — renderer mã hóa
// bằng safeStorage trước khi gửi, và tự giải mã khi điền. Route không bao giờ
// thấy plaintext (xem đầu lib/passwordStore.ts).
//
//   POST { action, ... }:
//     'list'    {}                                        → CredentialSafe[]
//     'match'   { url, profile? }                          → CredentialSealed[]
//     'reveal'  { id }                                     → SealedSecret
//     'save'    { url, username, password, profile?, label? } → CredentialSafe[]
//     'update'  { id, username?, password?, profile?, label? } → CredentialSafe[]
//     'remove'  { id }                                     → CredentialSafe[]
//     'touch'   { id }                                     → { ok: true }

import { NextResponse, type NextRequest } from 'next/server';
import {
  listCredentials, matchCredentials, sealedPassword, saveCredential,
  updateCredential, removeCredential, touchCredential, type SealedSecret,
} from '@/lib/passwordStore';

export const runtime = 'nodejs';

/** Chỉ nhận đúng hình dạng { cipher, value } — chặn rác/kiểu lạ ghi vào file. */
function sealFrom(v: unknown): SealedSecret | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as { cipher?: unknown; value?: unknown };
  if (typeof o.value !== 'string' || !o.value) return undefined;
  const cipher = o.cipher === 'safeStorage' ? 'safeStorage' : 'none';
  return { cipher, value: o.value };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action as string | undefined;
  if (!body || !action) return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });

  try {
    let result: unknown;
    switch (action) {
      case 'list':
        result = await listCredentials();
        break;
      case 'match':
        result = await matchCredentials(String(body.url ?? ''), str(body.profile));
        break;
      case 'reveal':
        result = await sealedPassword(String(body.id ?? ''));
        break;
      case 'save': {
        const password = sealFrom(body.password);
        if (!password) return NextResponse.json({ ok: false, error: 'Thiếu mật khẩu.' }, { status: 400 });
        result = await saveCredential({
          url: String(body.url ?? ''),
          username: String(body.username ?? ''),
          password,
          profile: str(body.profile),
          label: str(body.label),
        });
        break;
      }
      case 'update':
        result = await updateCredential(String(body.id ?? ''), {
          username: str(body.username),
          password: sealFrom(body.password),
          profile: str(body.profile),
          label: str(body.label),
        });
        break;
      case 'remove':
        result = await removeCredential(String(body.id ?? ''));
        break;
      case 'touch':
        await touchCredential(String(body.id ?? ''));
        result = { ok: true };
        break;
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
