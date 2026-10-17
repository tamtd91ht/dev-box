// Kéo thả file từ Explorer vào app — nhận diện file và đưa tới đúng view.
//
// Ba chỗ thả được: nút menu Office, nút menu Tools, và thân của hai tab đó.
// Thả ở đâu cũng đi qua CÙNG một bộ định tuyến (openLocalPath trong
// app/page.tsx, đường mà "Open with" từ Explorer vẫn dùng), nên thả nhầm chỗ
// vẫn mở đúng view: kéo .json vào menu Office → nó mở ở Tools, kéo .xlsx vào
// vùng soạn của Tools → nó mở ở Office.
//
// Danh sách đuôi ở đây là của renderer — ghép với OPENABLE_EXTS trong
// electron/main.cjs (đường "Open with") nhưng rộng hơn: kéo thả thì người
// dùng cố ý chọn file, nên text thường (log, yaml, sql…) cũng mở được.

export type DropTarget = 'office' | 'tools';

export interface DropKind {
  target: DropTarget;
  /** Tên view hiện cho người dùng: "Bảng tính", "Markdown"… */
  label: string;
}

const RULES: [RegExp, DropKind][] = [
  // .xlsm vẫn vào Office: editor tự báo vì sao chưa mở được file có macro,
  // rõ hơn là chặn ở đây với một câu chung chung.
  [/\.(xlsx|xlsm|csv)$/i, { target: 'office', label: 'Bảng tính' }],
  [/\.docx$/i, { target: 'office', label: 'Văn bản' }],
  [/\.(md|markdown|mdown|mkd|mdx)$/i, { target: 'tools', label: 'Markdown' }],
  [/\.json$/i, { target: 'tools', label: 'JSON' }],
  [/\.(xml|svg)$/i, { target: 'tools', label: 'XML' }],
  [/\.html?$/i, { target: 'tools', label: 'HTML' }],
  [/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|mp4|m4v|webm|mov|mkv|avi)$/i, { target: 'tools', label: 'Media' }],
  [/\.(txt|log|ya?ml|toml|ini|conf|cfg|env|properties|sql|sh|bat|ps1|js|mjs|cjs|ts|tsx|jsx|css|scss|py|go|java|cs|tsv)$/i,
    { target: 'tools', label: 'Text' }],
];

/** Đuôi file → view mở được nó; null = app chưa có view cho loại này. */
export function classifyFile(nameOrPath: string): DropKind | null {
  for (const [re, kind] of RULES) if (re.test(nameOrPath)) return kind;
  return null;
}

/** Đang rê FILE từ ngoài vào (không phải bôi đen chữ, kéo tab, kéo ảnh trong trang). */
export function isFileDrag(dt: DataTransfer | null | undefined): boolean {
  return Array.from(dt?.types ?? []).includes('Files');
}

export interface DroppedFile {
  name: string;
  /** Đường dẫn tuyệt đối trên đĩa; '' khi chạy trên trình duyệt thường. */
  path: string;
  file: File;
}

/** Lấy danh sách file kèm đường dẫn thật (Electron ≥ 32 chỉ trả qua preload). */
export function droppedFiles(dt: DataTransfer | null | undefined): DroppedFile[] {
  const out: DroppedFile[] = [];
  for (const f of Array.from(dt?.files ?? [])) {
    let p = '';
    try { p = window.workspace?.pathForFile?.(f) ?? ''; } catch { /* preload cũ */ }
    if (!p) p = (f as File & { path?: string }).path ?? '';
    out.push({ name: f.name, path: p, file: f });
  }
  return out;
}

// ── Gửi yêu cầu mở lên app/page.tsx ──────────────────────────────────────────
//
// Workspace con không giữ tham chiếu tới nhau, nên vùng thả trong Office muốn
// chuyển một .json sang Tools thì phát event; page.tsx nghe và định tuyến.

const EVENT = 'devbox:open-local-file';

export function requestOpenPath(absPath: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: absPath }));
}

export function onOpenPathRequest(cb: (absPath: string) => void): () => void {
  const h = (e: Event) => { const p = (e as CustomEvent<string>).detail; if (p) cb(p); };
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}

/**
 * Xử lý một lượt thả: mở những file có đường dẫn + loại nhận diện được, trả
 * về câu báo cho những file bị bỏ qua ('' = mở hết).
 */
export function openDropped(files: DroppedFile[]): string {
  const skipped: string[] = [];
  let noPath = 0;
  for (const f of files) {
    if (!classifyFile(f.name)) { skipped.push(f.name); continue; }
    if (!f.path) { noPath++; continue; }
    requestOpenPath(f.path);
  }
  const msg: string[] = [];
  if (skipped.length) msg.push(`Chưa có view mở được: ${skipped.join(', ')}`);
  if (noPath) msg.push(`${noPath} file không lấy được đường dẫn trên đĩa (chỉ bản desktop mới mở thẳng file kéo vào)`);
  return msg.join(' · ');
}
