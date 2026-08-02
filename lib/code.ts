// Client-side fetch helpers + shared types for Code Studio (tab Code).
// Mọi call đi qua POST /api/code {action,...} — xem app/api/code/route.ts.

export interface CodeProject {
  id: string;
  name: string;
  root: string;
}

export interface TreeEntry {
  name: string;
  rel: string;
  type: 'dir' | 'file';
  size?: number;
}

export interface ReadResult {
  content: string;
  binary: boolean;
  size: number;
  mtime: number;
}

export interface TermInfo {
  id: string;
  projectId: string;
  cwd: string;
  shell: 'powershell' | 'cmd' | 'bash';
  pty: boolean;
  exited: boolean;
  createdAt: number;
}

async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: T; error?: string };
  if (!r.ok || !data.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return data.result as T;
}

export const cProjects = () =>
  call<{ projects: CodeProject[]; configured: boolean }>('projects');
export const cTree = (projectId: string, rel: string) =>
  call<{ entries: TreeEntry[] }>('tree', { projectId, rel });
export const cRead = (projectId: string, rel: string) =>
  call<ReadResult>('read', { projectId, rel });
export const cWrite = (projectId: string, rel: string, content: string, mtime?: number) =>
  call<{ mtime: number }>('write', { projectId, rel, content, mtime });
export const cCreate = (projectId: string, rel: string, kind: 'file' | 'dir') =>
  call<{ done: true }>('create', { projectId, rel, kind });
export const cRename = (projectId: string, rel: string, newName: string) =>
  call<{ rel: string }>('rename', { projectId, rel, newName });
export const cRemove = (projectId: string, rel: string) =>
  call<{ done: true }>('remove', { projectId, rel });

export const cTermCreate = (
  projectId: string,
  rel: string,
  shell?: TermInfo['shell'],
  cols?: number,
  rows?: number,
) => call<{ id: string; pty: boolean }>('termCreate', { projectId, rel, shell, cols, rows });
export const cTermWrite = (id: string, data: string) => call<{ done: true }>('termWrite', { id, data });
export const cTermResize = (id: string, cols: number, rows: number) =>
  call<{ done: true }>('termResize', { id, cols, rows });
export const cTermKill = (id: string) => call<{ done: true }>('termKill', { id });
export const cTermList = (projectId?: string) => call<{ sessions: TermInfo[] }>('termList', { projectId });

/** Icon theo đuôi file — đủ nhận diện nhanh trong tree kiểu IntelliJ. */
export function fileIcon(name: string, type: 'dir' | 'file'): string {
  if (type === 'dir') return '📁';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const map: Record<string, string> = {
    java: '☕', kt: '🟪', gradle: '🐘', jar: '📦',
    ts: '🔷', tsx: '🔷', js: '🟨', jsx: '🟨', json: '🧾',
    xml: '📰', yml: '🧾', yaml: '🧾', properties: '⚙️', env: '⚙️',
    md: '📝', sql: '🗄️', sh: '🐚', ps1: '🐚', bat: '🐚', cmd: '🐚',
    html: '🌐', css: '🎨', scss: '🎨', png: '🖼️', jpg: '🖼️', svg: '🖼️',
    py: '🐍', go: '🐹', rs: '🦀', php: '🐘', cs: '🟦',
  };
  return map[ext] ?? '📄';
}

/** Monaco language id theo đuôi file. */
export function monacoLang(name: string): string {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const base = name.toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'pom.xml') return 'xml';
  const map: Record<string, string> = {
    java: 'java', kt: 'kotlin', kts: 'kotlin', gradle: 'java', groovy: 'java',
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonc: 'json',
    xml: 'xml', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
    yml: 'yaml', yaml: 'yaml', md: 'markdown', sql: 'sql',
    sh: 'shell', bash: 'shell', ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat',
    py: 'python', go: 'go', rs: 'rust', php: 'php', cs: 'csharp', cpp: 'cpp', c: 'c', h: 'cpp',
    properties: 'ini', ini: 'ini', toml: 'ini', env: 'ini', conf: 'ini',
  };
  return map[ext] ?? 'plaintext';
}
