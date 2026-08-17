// Client-side helpers cho export/import cấu hình connection. Browser-safe:
// KHÔNG import `fs`, không import lib/connTransfer (file đó là server-only).
// Kiểu dữ liệu khai báo lại ở đây để hai bên độc lập — cùng hình dạng JSON.

/** Các menu có hỗ trợ export/import. Phải khớp RegistryKind ở lib/connTransfer.ts. */
export type RegistryKind = 'kafka' | 'redis' | 'mongo' | 'rabbit' | 'es' | 'pg';

/** Cách xử lý bản ghi trùng id khi import. */
export type ConflictMode = 'overwrite' | 'skip' | 'duplicate';

export interface ImportPreviewItem {
  id: string;
  name: string;
  project: string;
  summary: string;
  conflict: boolean;
  existingName?: string;
  hasSecret: boolean;
}

export interface ImportPreview {
  kind: RegistryKind;
  label: string;
  exportedAt: string;
  hasSecrets: boolean;
  items: ImportPreviewItem[];
}

export interface ImportResult {
  added: number;
  overwritten: number;
  skipped: number;
  total: number;
}

/** Bóc lỗi từ response JSON, ném Error với message của server. */
async function fail(res: Response): Promise<never> {
  const j = await res.json().catch(() => null) as { error?: string } | null;
  throw new Error(j?.error || `HTTP ${res.status}`);
}

/**
 * Tải file export về máy. Gọi GET và ép trình duyệt lưu thành file — trong bản
 * desktop (Electron) thao tác này mở đúng hộp thoại "Save as…" như tải file
 * thường, nên người dùng chọn được thư mục tuỳ ý.
 *
 * @param ids Danh sách connection cần xuất (rỗng → toàn bộ).
 * @returns Tên file đã tải, lấy từ Content-Disposition của server.
 */
export async function downloadConnExport(kind: RegistryKind, ids: string[]): Promise<string> {
  const qs = new URLSearchParams({ kind });
  if (ids.length) qs.set('ids', ids.join(','));
  const res = await fetch(`/api/conn-transfer?${qs.toString()}`);
  if (!res.ok) return fail(res);

  // Tên file do server đặt (có timestamp) — đọc lại từ header để hiện trong toast.
  const cd = res.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? `${kind}-connections.json`;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return filename;
}

/** Soi nội dung file người dùng chọn (không ghi gì) để dựng hộp thoại xác nhận. */
export async function previewConnImport(kind: RegistryKind, file: unknown): Promise<ImportPreview> {
  const res = await fetch('/api/conn-transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, action: 'preview', file }),
  });
  if (!res.ok) return fail(res);
  return (await res.json() as { preview: ImportPreview }).preview;
}

/** Ghi các connection được chọn vào cấu hình local. */
export async function applyConnImport(
  kind: RegistryKind,
  file: unknown,
  ids: string[],
  mode: ConflictMode,
): Promise<ImportResult> {
  const res = await fetch('/api/conn-transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, action: 'import', file, ids, mode }),
  });
  if (!res.ok) return fail(res);
  return await res.json() as ImportResult;
}

/** Đọc file người dùng chọn từ <input type=file> và parse JSON. */
export async function readJsonFile(file: File): Promise<unknown> {
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`"${file.name}" không phải file JSON hợp lệ`);
  }
}
