// Client helpers cho store tài liệu của tab Tools (/api/docs). Browser-safe.

export type DocKind = 'json' | 'text';

export interface SavedDoc {
  id: string;
  name: string;
  kind: DocKind;
  content: string;
  updatedAt: string;
}

async function docsAction<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/docs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return (data as { result: T }).result;
}

export const dList = () => docsAction<SavedDoc[]>('list');
export const dSave = (input: { id?: string; name: string; kind: DocKind; content: string }) =>
  docsAction<SavedDoc[]>('save', { ...input });
export const dRemove = (id: string) => docsAction<SavedDoc[]>('remove', { id });
export const dSaveFile = (dir: string, filename: string, content: string) =>
  docsAction<{ path: string }>('saveFile', { dir, filename, content });
/** File đã tồn tại chưa? → thông tin file, hoặc null nếu chưa có. Dùng để hỏi
 *  xác nhận trước khi ghi đè. */
export const dFileExists = (dir: string, filename: string) =>
  docsAction<{ size: number; mtime: string } | null>('statFile', { dir, filename });
/** Mở file text thật từ máy local (cap 10MB). */
export const dReadFile = (path: string) =>
  docsAction<{ path: string; content: string }>('readFile', { path });
