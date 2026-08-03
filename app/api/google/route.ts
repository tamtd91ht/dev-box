// /api/google — single dispatch route for the Google tab (Drive read-only).
//
// MULTI-ACCOUNT: 'status' returns every signed-in account; mọi action đụng
// tới Drive đều nhận accountId.
//
//   POST { action, ... }  where action is one of:
//     'status'     {}                            → { ok, result: GoogleStatus }  (accounts[])
//     'authUrl'    {}                            → { ok, result: { url } }       (thêm/đăng nhập lại tài khoản)
//     'logout'     { accountId }                 → { ok, result: { done: true } }
//     'roots'      { accountId }                 → { ok, result: GoogleRoot[] }  (roots của tài khoản đó)
//     'rootAdd'    { accountId, url, name? }     → { ok, result: GoogleRoot[] }  (validates via files.get)
//     'rootRemove' { id }                        → { ok, result: GoogleRoot[] }  (all accounts' roots)
//     'rootRename' { id, name }                  → { ok, result: GoogleRoot[] }
//     'browse'     { accountId, folderId }       → { ok, result: DriveList }
//     'list'       { accountId, kind: 'docs'|'sheets', q?, starred?, pageToken? } → { ok, result: DriveList }
// (Mục 🔗 link dán tay đã tách ra tab Links riêng — xem /api/links.)
//
// Everything is READ-ONLY against Google (scope drive.readonly; only
// files.list/files.get are called) — editing opens Google's own UI in the
// browser. Gated by GOOGLE_TOOL_ENABLED (403 when off).

import { NextResponse, type NextRequest } from 'next/server';
import { GOOGLE_ENABLED, authUrl, logout, status } from '@/lib/googleAuth';
import {
  browseFolder, listByKind, getFile, extractDriveId, MIME,
  downloadContent, exportContent, type DriveFile,
} from '@/lib/googleDrive';
import { xlsxToSheets } from '@/lib/xlsxHtml';
import { listRoots, addRoot, removeRoot, renameRoot } from '@/lib/googleRoots';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!GOOGLE_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'Google tool is disabled. Set GOOGLE_TOOL_ENABLED=true (local dev only).' },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  const action = body?.action as string | undefined;
  if (!action) {
    return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });
  }

  // Mọi action đụng Drive/registry theo tài khoản đều cần accountId tường minh.
  const accountId = String(body.accountId ?? '');
  const needAccount = () => {
    if (!accountId) throw new Error('Thiếu accountId — chọn tài khoản Google trước.');
    return accountId;
  };

  try {
    let result: unknown;
    switch (action) {
      case 'status':
        result = await status();
        break;
      case 'authUrl':
        result = { url: authUrl() };
        break;
      case 'logout':
        await logout(needAccount());
        result = { done: true };
        break;
      case 'roots':
        result = await listRoots(needAccount());
        break;
      case 'rootAdd': {
        const acc = needAccount();
        const url = String(body.url ?? '');
        const folderId = extractDriveId(url);
        if (!folderId) throw new Error('Không nhận ra link Google Drive — dán link dạng …/drive/folders/<id>.');
        const meta = await getFile(acc, folderId); // validates access + fetches the real name
        if (meta.mimeType !== MIME.folder) throw new Error(`Link này là "${meta.name}" (${meta.mimeType}) — cần link THƯ MỤC.`);
        const name = String(body.name ?? '').trim() || meta.name;
        result = await addRoot({ accountId: acc, name, folderId, url });
        break;
      }
      case 'rootRemove':
        result = await removeRoot(String(body.id ?? ''));
        break;
      case 'rootRename':
        result = await renameRoot(String(body.id ?? ''), String(body.name ?? ''));
        break;
      case 'browse':
        result = await browseFolder(needAccount(), String(body.folderId ?? ''));
        break;
      case 'list': {
        const kind = body.kind === 'sheets' ? 'sheets' : 'docs';
        result = await listByKind(needAccount(), {
          kind,
          q: typeof body.q === 'string' ? body.q : undefined,
          starred: body.starred === true,
          pageToken: typeof body.pageToken === 'string' ? body.pageToken : undefined,
        });
        break;
      }
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const msg = (err as Error).message || 'Google operation failed';
    const auth = msg.includes('Chưa đăng nhập') || msg.includes('Thiếu accountId');
    return NextResponse.json({ ok: false, error: msg }, { status: auth ? 401 : 502 });
  }
}

// ── API-PREVIEW: xem nội dung file private ngay trong app ──────────────────
// File private không mở được trong <webview> (Google chặn đăng nhập embedded
// browser) → tải nội dung qua API bằng token drive.readonly rồi render.
//
//   GET ?preview&accountId=&fileId=  → JSON descriptor:
//       { kind: 'sheets', name, sheets: [{name, html}] }  (Sheets/xlsx — tab mỗi sheet)
//       { kind: 'html',   name, html }               (Docs → HTML; text → <pre>)
//       { kind: 'iframe', name, src }                 (PDF, Slides→PDF)
//       { kind: 'img',    name, src }                 (ảnh)
//       { kind: 'none',   name, mimeType }            (không hỗ trợ xem trước)
//   GET ?content&accountId=&fileId=[&export=<mime>]  → stream bytes inline
//       (nguồn cho iframe/img/⬇ tải về).

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_SLIDES = 'application/vnd.google-apps.presentation';
const MIME_SHORTCUT = 'application/vnd.google-apps.shortcut';

/** files.get + tự giải shortcut về file đích. */
async function resolveFile(accountId: string, fileId: string): Promise<DriveFile> {
  let meta = await getFile(accountId, fileId);
  if (meta.mimeType === MIME_SHORTCUT && meta.shortcutDetails?.targetId) {
    meta = await getFile(accountId, meta.shortcutDetails.targetId);
  }
  return meta;
}

const contentUrl = (accountId: string, fileId: string, exportMime?: string) =>
  `/api/google?content&accountId=${encodeURIComponent(accountId)}&fileId=${encodeURIComponent(fileId)}`
  + (exportMime ? `&export=${encodeURIComponent(exportMime)}` : '');

const escText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function buildPreview(accountId: string, fileId: string): Promise<unknown> {
  const meta = await resolveFile(accountId, fileId);
  const { id, name, mimeType } = meta;

  if (mimeType === MIME.sheet) {
    const { buf } = await exportContent(accountId, id, MIME_XLSX);
    return { kind: 'sheets', name, sheets: await xlsxToSheets(buf) };
  }
  if (mimeType === MIME_XLSX || mimeType === 'application/vnd.ms-excel') {
    const { buf } = await downloadContent(accountId, id);
    return { kind: 'sheets', name, sheets: await xlsxToSheets(buf) };
  }
  if (mimeType === MIME.doc) {
    const { buf } = await exportContent(accountId, id, 'text/html');
    return { kind: 'html', name, html: buf.toString('utf8') };
  }
  if (mimeType === MIME_DOCX) {
    // .docx upload (vendor gửi) — convert bằng mammoth (ảnh nhúng thành data URI).
    const { buf } = await downloadContent(accountId, id);
    const mammoth = (await import('mammoth')).default;
    const { value } = await mammoth.convertToHtml({ buffer: buf });
    return {
      kind: 'html', name,
      html: `<style>body{font:14px/1.6 system-ui,'Segoe UI',sans-serif;margin:24px auto;max-width:820px;color:#222;background:#fff}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}</style>${value}`,
    };
  }
  if (mimeType === MIME_SLIDES) {
    return { kind: 'iframe', name, src: contentUrl(accountId, id, 'application/pdf') };
  }
  if (mimeType === 'application/pdf') {
    return { kind: 'iframe', name, src: contentUrl(accountId, id) };
  }
  if (mimeType.startsWith('image/')) {
    return { kind: 'img', name, src: contentUrl(accountId, id) };
  }
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') {
    const { buf } = await downloadContent(accountId, id);
    const body = escText(buf.toString('utf8'));
    return {
      kind: 'html', name,
      html: `<style>body{margin:12px;background:#fff}pre{font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}</style><pre>${body}</pre>`,
    };
  }
  return { kind: 'none', name, mimeType };
}

export async function GET(req: NextRequest) {
  if (!GOOGLE_ENABLED) {
    return NextResponse.json({ ok: false, error: 'Google tool is disabled.' }, { status: 403 });
  }
  const sp = req.nextUrl.searchParams;
  const accountId = sp.get('accountId') ?? '';
  const fileId = sp.get('fileId') ?? '';

  // Google trả lỗi khá mù mờ — dịch các case hay gặp sang lời khuyên hành động.
  const friendly = (msg: string): string => {
    if (/cannotDownloadFile|copyRequiresWriterPermission|abuse/i.test(msg)) {
      return 'Chủ file bật "Chặn tải xuống cho người xem" (Disable download for viewers) — API không lấy được nội dung. Dùng ✏️ mở editor/browser để xem.';
    }
    if (/File not found|notFound/i.test(msg)) {
      return 'Tài khoản này không thấy file (chưa được share cho nó, hoặc file đã bị xóa/di chuyển).';
    }
    if (/exportSizeLimitExceeded/i.test(msg)) {
      return 'File quá lớn để export qua API — mở editor/browser để xem.';
    }
    return msg;
  };

  try {
    if (sp.has('preview')) {
      if (!accountId || !fileId) throw new Error('Thiếu accountId/fileId.');
      try {
        return NextResponse.json({ ok: true, result: await buildPreview(accountId, fileId) });
      } catch (err) {
        throw new Error(friendly((err as Error).message));
      }
    }
    if (sp.has('content')) {
      if (!accountId || !fileId) throw new Error('Thiếu accountId/fileId.');
      const exportMime = sp.get('export');
      const { buf, contentType } = exportMime
        ? await exportContent(accountId, fileId, exportMime)
        : await downloadContent(accountId, fileId);
      return new NextResponse(new Uint8Array(buf), {
        headers: { 'content-type': contentType, 'content-disposition': 'inline' },
      });
    }
    return NextResponse.json({ ok: false, error: 'Unknown GET' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
