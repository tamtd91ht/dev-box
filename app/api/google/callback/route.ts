// /api/google/callback — OAuth redirect target (GET, opened by Google after
// consent). Exchanges the code for tokens, stores them on disk, then renders a
// tiny "done" page that closes itself — the Google tab polls status and picks
// the login up automatically.

import { type NextRequest } from 'next/server';
import { GOOGLE_ENABLED, exchangeCode } from '@/lib/googleAuth';

export const runtime = 'nodejs';

function page(title: string, body: string, ok: boolean): Response {
  const html = `<!doctype html><html lang="vi"><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#111;color:#eee">
<div style="text-align:center;max-width:480px;padding:24px">
  <div style="font-size:42px">${ok ? '✅' : '⚠️'}</div>
  <h2 style="margin:12px 0 8px">${title}</h2>
  <p style="color:#aaa;font-size:14px;line-height:1.6">${body}</p>
</div>
${ok ? `<script>
// Mở bằng trình duyệt ngoài (tab do window.open tạo) thì tự đóng. Khi consent
// chạy TRONG app (<webview> của GoogleAuthWindow) thì window.close() không đóng
// được gì — khung đó tự phát hiện đã tới callback rồi đóng, nên đừng thử.
setTimeout(function(){ try { if (window.opener) window.close(); } catch (e) {} }, 1500);
</script>` : ''}
</body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export async function GET(req: NextRequest) {
  if (!GOOGLE_ENABLED) return page('Google tool đang tắt', 'Set GOOGLE_TOOL_ENABLED=true trong .env.local.', false);
  const err = req.nextUrl.searchParams.get('error');
  if (err) return page('Đăng nhập bị hủy', `Google trả về: ${err}. Đóng tab này và thử lại.`, false);
  const code = req.nextUrl.searchParams.get('code');
  if (!code) return page('Thiếu mã xác thực', 'URL không có ?code — mở lại từ nút "Đăng nhập Google".', false);
  try {
    const { email } = await exchangeCode(code);
    return page('Đã kết nối Google', `Đăng nhập ${email ?? 'thành công'} — quay lại DevBox, tab này tự đóng.`, true);
  } catch (e) {
    return page('Đăng nhập thất bại', (e as Error).message, false);
  }
}
