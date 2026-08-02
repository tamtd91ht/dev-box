// Server-only terminal session manager for Code Studio.
//
// A session is ONE live shell (PowerShell / cmd / Git Bash) chạy trong thư mục
// project. Ưu tiên node-pty (ConPTY thật — TUI như Claude Code, vim, gradle
// progress render chuẩn); nếu native module không load được trong runtime hiện
// tại (vd. server được desktop shell spawn bằng ELECTRON_RUN_AS_NODE → ABI
// khác) thì fallback sang child_process pipes: lệnh thường vẫn chạy, TUI thì
// không vẽ được — UI sẽ ghi rõ chế độ nào đang dùng.
//
// Registry sống trong globalThis để survive Next dev hot-reload. Output giữ
// trong ring buffer ~200KB/phiên: client (SSE) kết nối lại là replay được đúng
// màn hình đang có.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';

export type ShellKind = 'powershell' | 'cmd' | 'bash';

interface PtyLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  readonly pid: number;
}

export interface TermSession {
  id: string;
  projectId: string;
  cwd: string;
  shell: ShellKind;
  /** true = node-pty (ConPTY thật); false = pipes fallback. */
  pty: boolean;
  createdAt: number;
  buffer: string[];
  bufferBytes: number;
  subscribers: Set<(chunk: string) => void>;
  exited: boolean;
  exitCode?: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

const BUFFER_LIMIT = 200 * 1024;
const MAX_SESSIONS = 12;

const g = globalThis as typeof globalThis & { __vhsTermSessions?: Map<string, TermSession> };
const REG: Map<string, TermSession> = (g.__vhsTermSessions ??= new Map());

// node-pty là optional native dep — require lười + cache kết quả để mỗi runtime
// chỉ thử một lần.
let ptyModule: typeof import('node-pty') | null | undefined;
function loadPty(): typeof import('node-pty') | null {
  if (ptyModule !== undefined) return ptyModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyModule = require('node-pty') as typeof import('node-pty');
  } catch {
    ptyModule = null;
  }
  return ptyModule;
}

/** Shell command + args cho từng loại trên máy hiện tại. */
function shellCommand(kind: ShellKind): { cmd: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { cmd: process.env.SHELL || 'bash', args: [] };
  }
  switch (kind) {
    case 'cmd':
      return { cmd: process.env.COMSPEC || 'cmd.exe', args: [] };
    case 'bash': {
      const guesses = [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      ];
      const found = guesses.find((p) => existsSync(p));
      if (!found) throw new Error('Không tìm thấy Git Bash trên máy này.');
      return { cmd: found, args: ['--login', '-i'] };
    }
    default:
      return { cmd: 'powershell.exe', args: ['-NoLogo'] };
  }
}

function pushChunk(s: TermSession, chunk: string) {
  s.buffer.push(chunk);
  s.bufferBytes += chunk.length;
  while (s.bufferBytes > BUFFER_LIMIT && s.buffer.length > 1) {
    s.bufferBytes -= s.buffer[0].length;
    s.buffer.shift();
  }
  for (const cb of s.subscribers) cb(chunk);
}

export function createSession(opts: {
  projectId: string;
  cwd: string;
  shell?: ShellKind;
  cols?: number;
  rows?: number;
}): TermSession {
  // Dọn phiên đã chết trước khi đếm giới hạn.
  for (const [id, s] of REG) if (s.exited) REG.delete(id);
  if (REG.size >= MAX_SESSIONS) {
    throw new Error(`Quá ${MAX_SESSIONS} terminal đang mở — đóng bớt trước.`);
  }

  const shell: ShellKind = opts.shell ?? 'powershell';
  const { cmd, args } = shellCommand(shell);
  const cols = Math.max(20, Math.min(500, opts.cols ?? 120));
  const rows = Math.max(5, Math.min(200, opts.rows ?? 30));
  const id = randomUUID();

  const base = {
    id,
    projectId: opts.projectId,
    cwd: opts.cwd,
    shell,
    createdAt: Date.now(),
    buffer: [] as string[],
    bufferBytes: 0,
    subscribers: new Set<(chunk: string) => void>(),
    exited: false,
  };

  const ptyMod = loadPty();
  let session: TermSession;

  if (ptyMod) {
    const p: PtyLike = ptyMod.spawn(cmd, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd,
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    });
    session = {
      ...base,
      pty: true,
      write: (d) => p.write(d),
      resize: (c, r) => {
        try {
          p.resize(Math.max(20, c), Math.max(5, r));
        } catch {
          /* đang thoát */
        }
      },
      kill: () => {
        try {
          p.kill();
        } catch {
          /* đã chết */
        }
      },
    };
    p.onData((d) => pushChunk(session, d));
    p.onExit(({ exitCode }) => {
      session.exited = true;
      session.exitCode = exitCode;
      pushChunk(session, `\r\n\x1b[90m[phiên đã kết thúc — exit ${exitCode}]\x1b[0m\r\n`);
    });
  } else {
    const child: ChildProcessWithoutNullStreams = spawn(cmd, args, {
      cwd: opts.cwd,
      env: process.env,
      windowsHide: true,
    });
    session = {
      ...base,
      pty: false,
      write: (d) => {
        // Pipes không có line discipline — xterm gửi '\r' khi Enter, shell chờ '\n'.
        child.stdin.write(d.replace(/\r/g, '\n'));
      },
      resize: () => {
        /* pipes không resize được */
      },
      kill: () => {
        try {
          child.kill();
        } catch {
          /* đã chết */
        }
      },
    };
    const fwd = (b: Buffer) => pushChunk(session, b.toString('utf8').replace(/(?<!\r)\n/g, '\r\n'));
    child.stdout.on('data', fwd);
    child.stderr.on('data', fwd);
    child.on('exit', (code) => {
      session.exited = true;
      session.exitCode = code ?? -1;
      pushChunk(session, `\r\n\x1b[90m[phiên đã kết thúc — exit ${code}]\x1b[0m\r\n`);
    });
    pushChunk(
      session,
      '\x1b[33m[chế độ pipes — node-pty không load được trong runtime này; lệnh thường OK, app TUI sẽ không vẽ đúng]\x1b[0m\r\n',
    );
  }

  REG.set(id, session);
  return session;
}

export function getSession(id: string): TermSession | undefined {
  return REG.get(id);
}

export function listSessions(projectId?: string): Array<{
  id: string;
  projectId: string;
  cwd: string;
  shell: ShellKind;
  pty: boolean;
  exited: boolean;
  createdAt: number;
}> {
  return [...REG.values()]
    .filter((s) => !projectId || s.projectId === projectId)
    .map(({ id, projectId: pid, cwd, shell, pty, exited, createdAt }) => ({
      id,
      projectId: pid,
      cwd,
      shell,
      pty,
      exited,
      createdAt,
    }));
}

export function killSession(id: string): void {
  const s = REG.get(id);
  if (!s) return;
  s.kill();
  REG.delete(id);
}
