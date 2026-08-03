// /api/apps — registry + PROCESS MANAGER cho tab Apps: start/stop
// `npm run <cmd>` của các project local ngay trong DevBox.
//
//   POST { action, ... }:
//     'list'   {}            → { apps: AppEntry[], running: {[id]: {pid, startedAt}} }
//     'add'    {root,cmd,..} → như list        'update' {id,...} / 'remove' {id} → như list
//     'start'  {id}          → chạy npm run <cmd> (cwd=root), log giữ ring buffer
//     'stop'   {id}          → kill cả cây process (taskkill /T trên Windows)
//     'logs'   {id, afterSeq?} → { lines: [{seq,line}], running }
//
// Process/log sống trong module state của Next dev server — restart server là
// mất tracking (process con cũng bị kill theo cây terminal nếu còn).

import { NextResponse, type NextRequest } from 'next/server';
import { spawn, execFile, type ChildProcess } from 'child_process';
import { listApps, addApp, updateApp, removeApp, getApp, type AppMeta } from '@/lib/appRegistry';

export const runtime = 'nodejs';

interface Proc { child: ChildProcess; startedAt: number; logs: { seq: number; line: string }[]; seq: number }
const globalAny = globalThis as unknown as { __devboxApps?: Map<string, Proc> };
const PROCS = (globalAny.__devboxApps ??= new Map<string, Proc>());
const LOG_LIMIT = 2000;

function push(p: Proc, line: string) {
  p.logs.push({ seq: ++p.seq, line });
  if (p.logs.length > LOG_LIMIT) p.logs.splice(0, p.logs.length - LOG_LIMIT);
}

function runningMap() {
  const out: Record<string, { pid: number; startedAt: number }> = {};
  for (const [id, p] of PROCS) {
    if (p.child.exitCode === null && !p.child.killed) out[id] = { pid: p.child.pid ?? 0, startedAt: p.startedAt };
  }
  return out;
}

async function start(id: string) {
  const app = await getApp(id);
  const cur = PROCS.get(id);
  if (cur && cur.child.exitCode === null && !cur.child.killed) throw new Error('App đang chạy rồi.');
  const child = spawn('npm', ['run', app.cmd], {
    cwd: app.root, shell: true, windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const p: Proc = { child, startedAt: Date.now(), logs: [], seq: 0 };
  PROCS.set(id, p);
  push(p, `$ npm run ${app.cmd}  (cwd: ${app.root})`);
  const onData = (b: Buffer) => b.toString('utf8').split(/\r?\n/).filter(Boolean).forEach((l) => push(p, l));
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('exit', (code, sig) => push(p, `— process exited (code=${code ?? ''} ${sig ?? ''}) —`));
  child.on('error', (e) => push(p, `— spawn error: ${e.message} —`));
}

async function stop(id: string) {
  const p = PROCS.get(id);
  if (!p || p.child.exitCode !== null || p.child.killed) throw new Error('App không chạy.');
  const pid = p.child.pid;
  if (process.platform === 'win32' && pid) {
    // shell:true → npm là cây process; phải taskkill /T mới chết cả node con.
    await new Promise<void>((res) => execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => res()));
  } else {
    p.child.kill('SIGTERM');
  }
  push(p, '— stopped by DevBox —');
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action as string | undefined;
  if (!body || !action) return NextResponse.json({ ok: false, error: 'Missing action' }, { status: 400 });
  const id = String(body.id ?? '');
  const meta = body as AppMeta;

  try {
    let result: unknown;
    switch (action) {
      case 'list': result = { apps: await listApps(), running: runningMap() }; break;
      case 'add': result = { apps: await addApp(meta), running: runningMap() }; break;
      case 'update': result = { apps: await updateApp(id, meta), running: runningMap() }; break;
      case 'remove': result = { apps: await removeApp(id), running: runningMap() }; break;
      case 'start': await start(id); result = { apps: await listApps(), running: runningMap() }; break;
      case 'stop': await stop(id); result = { apps: await listApps(), running: runningMap() }; break;
      case 'logs': {
        const p = PROCS.get(id);
        const after = Number(body.afterSeq ?? 0);
        result = {
          lines: p ? p.logs.filter((l) => l.seq > after) : [],
          running: !!p && p.child.exitCode === null && !p.child.killed,
        };
        break;
      }
      default: return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
