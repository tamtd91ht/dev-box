// Client-side helpers cho tab Terminal.
// Mọi call đi qua POST /api/term {action,...} — xem app/api/term/route.ts.
// Output đi đường riêng: EventSource('/api/term/<id>') (SSE).

export type ShellKind = 'powershell' | 'cmd' | 'bash';

export interface TermSessionInfo {
  id: string;
  projectId: string;
  cwd: string;
  shell: ShellKind;
  label: string;
  /** true = PTY thật (ConPTY) → TUI vẽ đúng. false = pipes fallback. */
  pty: boolean;
  /** Đang xem ở cửa sổ rời. */
  detached: boolean;
  exited: boolean;
  createdAt: number;
}

/** Nhãn hiển thị của từng loại shell — dùng chung ở mọi chỗ trong UI. */
export const SHELL_LABEL: Record<ShellKind, string> = {
  powershell: 'PowerShell',
  cmd: 'Command Prompt',
  bash: 'Git Bash',
};

async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/term', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!r.ok || !data.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return data as T;
}

export const tCreate = (opts: {
  cwd?: string;
  shell?: ShellKind;
  label?: string;
  cols?: number;
  rows?: number;
}) => call<{ session: TermSessionInfo }>('create', opts).then((d) => d.session);

/** `cwdDefault` = thư mục app (mặc định khi không chọn gì).
 *  `cwdHome`    = thư mục gốc người dùng trên máy (vd C:\Users\Admin). */
export const tList = () =>
  call<{ sessions: TermSessionInfo[]; cwdDefault: string; cwdHome: string }>('list');

export const tWrite = (id: string, data: string) => call('write', { id, data });
export const tResize = (id: string, cols: number, rows: number) =>
  call('resize', { id, cols, rows });
export const tRename = (id: string, label: string) => call('rename', { id, label });
export const tDetach = (id: string, detached: boolean) => call('detach', { id, detached });
export const tKill = (id: string) => call('kill', { id });
