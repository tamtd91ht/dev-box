// Client helpers cho tính năng Chuyển đổi file (/api/convert). Browser-safe.

export type TargetFormat = 'pdf' | 'html' | 'md' | 'txt' | 'csv' | 'json' | 'yaml' | 'xlsx' | 'xml' | 'docx';

export type JobStatus = 'running' | 'need-render' | 'done' | 'error';

export interface ConvertJobView {
  id: string;
  srcAbs: string;
  srcName: string;
  outAbs: string;
  outName: string;
  target: TargetFormat;
  useAi: boolean;
  templateAbs: string | null;
  status: JobStatus;
  step: string;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  needsHtml: boolean;
  seq: number;
}

/** Đuôi file nguồn mở được — dùng cho FolderPicker. */
export const CONVERT_SOURCE_EXTS = [
  'docx', 'xlsx', 'csv', 'json', 'yaml', 'yml', 'xml', 'html', 'htm', 'md', 'txt',
];

export const TARGET_LABEL: Record<TargetFormat, string> = {
  pdf: 'PDF', html: 'HTML', md: 'Markdown', txt: 'Text thuần', csv: 'CSV',
  json: 'JSON', yaml: 'YAML', xlsx: 'Excel (xlsx)', xml: 'XML', docx: 'Word (docx)',
};

export const ALL_TARGETS = Object.keys(TARGET_LABEL) as TargetFormat[];

async function convertAction<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/convert', {
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

export const cMatrix = () => convertAction<{ matrix: Record<string, TargetFormat[]> }>('matrix');

export const cStart = (input: {
  srcPath: string;
  target: TargetFormat;
  outDir?: string;
  useAi?: boolean;
  templatePath?: string;
}) => convertAction<{ job: ConvertJobView }>('start', { ...input });

export const cRenderHtml = (id: string) => convertAction<{ html: string }>('render-html', { id });
export const cRenderDone = (id: string, base64: string) =>
  convertAction<{ job: ConvertJobView }>('render-done', { id, base64 });
export const cRenderFail = (id: string, reason: string) =>
  convertAction<{ ok: true }>('render-fail', { id, reason });
export const cClear = () => convertAction<{ jobs: ConvertJobView[] }>('clear');

export async function cList(): Promise<ConvertJobView[]> {
  const r = await fetch('/api/convert');
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  }
  return (data as { result: { jobs: ConvertJobView[] } }).result.jobs;
}

/** Bản desktop mới có Chromium để in PDF. */
export function canRenderPdf(): boolean {
  return typeof window !== 'undefined' && typeof window.workspace?.htmlToPdf === 'function';
}
