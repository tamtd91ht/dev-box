// /api/apps — registry + PROCESS MANAGER cho tab Apps: start/stop
// `npm run <cmd>` của các project local ngay trong DevBox.
//
//   POST { action, ... }:
//     'list'   {}            → { apps: AppEntry[], running: {[id]}, installed: {[id]: boolean} }
//     'add'    {root,cmd,..} → như list        'update' {id,...} / 'remove' {id} → như list
//     'manifest'     {}      → { manifest: AppManifestStatus }  (đối chiếu apps.shared.json)
//     'syncManifest' {}      → ghi đè manifest bằng app của máy này
//     'adopt'  {name,cmd,root,..} → dựng app local từ một mục manifest
//     'start'  {id}          → npm run <cmd> (set PORT + -p; tự dò cổng trống nếu bận)
//     'install'{id}          → chạy npm install (khi app thiếu node_modules)
//     'stop'   {id}          → kill cả cây process (taskkill /T trên Windows)
//     'logs'   {id, afterSeq?} → { lines: [{seq,line}], running }
//
// Process/log sống trong module state của Next dev server — restart server là
// mất tracking (process con cũng bị kill theo cây terminal nếu còn).

import { NextResponse, type NextRequest } from 'next/server';
import { spawn, execFile, type ChildProcess } from 'child_process';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { listApps, addApp, updateApp, removeApp, getApp, type AppEntry, type AppMeta } from '@/lib/appRegistry';
import { recordApp, forgetApp, syncAppManifest, appManifestStatus, relocateAppRoot } from '@/lib/appManifest';

export const runtime = 'nodejs';

interface Proc { child: ChildProcess; startedAt: number; logs: { seq: number; line: string }[]; seq: number; port?: number }
const globalAny = globalThis as unknown as { __devboxApps?: Map<string, Proc> };
const PROCS = (globalAny.__devboxApps ??= new Map<string, Proc>());
const LOG_LIMIT = 2000;

function push(p: Proc, line: string) {
  p.logs.push({ seq: ++p.seq, line });
  if (p.logs.length > LOG_LIMIT) p.logs.splice(0, p.logs.length - LOG_LIMIT);
}

function runningMap() {
  const out: Record<string, { pid: number; startedAt: number; port?: number }> = {};
  for (const [id, p] of PROCS) {
    if (p.child.exitCode === null && !p.child.killed) out[id] = { pid: p.child.pid ?? 0, startedAt: p.startedAt, port: p.port };
  }
  return out;
}

/** App nào đã có node_modules (đã npm install) — nút Start mới chạy được. */
async function installedMap(apps: { id: string; root: string }[]) {
  const out: Record<string, boolean> = {};
  for (const a of apps) {
    out[a.id] = fs.existsSync(path.join(a.root, 'node_modules'));
  }
  return out;
}

/** Spawn npm với env + header tùy biến, dưới cùng cơ chế PROCS + log. */
function spawnNpmEnv(id: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, header: string, port?: number) {
  const child = spawn('npm', args, { cwd, shell: true, windowsHide: true, env });
  const p: Proc = { child, startedAt: Date.now(), logs: [], seq: 0, port };
  PROCS.set(id, p);
  push(p, header);
  const onData = (b: Buffer) => b.toString('utf8').split(/\r?\n/).filter(Boolean).forEach((l) => push(p, l));
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('exit', (code, sig) => push(p, `— process exited (code=${code ?? ''} ${sig ?? ''}) —`));
  child.on('error', (e) => push(p, `— spawn error: ${e.message} —`));
}

/** Env cho process con: PHẢI gỡ NODE_ENV của DevBox. Desktop chạy `next start`
 *  nên process này mang NODE_ENV=production — npm install kế thừa nó sẽ
 *  `omit=dev`: không cài devDependencies mà còn PRUNE cái đã cài (tsx của app
 *  con từng bị xoá kiểu này), còn `npm run dev` của app con thì bị ép chạy
 *  production. Gỡ luôn npm_config_* cùng tác dụng phòng DevBox được start qua
 *  `npm run` với cờ lạ. App con tự quyết NODE_ENV của nó. */
function childEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...process.env, FORCE_COLOR: '0' };
  // NODE_ENV bị Next khai readonly trong types → gỡ qua index signature.
  for (const k of ['NODE_ENV', 'npm_config_omit', 'npm_config_production', 'npm_config_only']) delete env[k];
  // Cast vì Next augment ProcessEnv coi NODE_ENV là bắt buộc — ở đây vắng mặt là chủ đích.
  return env as NodeJS.ProcessEnv;
}

/** Spawn npm với env mặc định (dùng cho install). */
function spawnNpm(id: string, args: string[], cwd: string, header: string) {
  spawnNpmEnv(id, args, cwd, childEnv(), header);
}

/** `root` là đường dẫn TUYỆT ĐỐI theo máy — registry copy từ máy khác (hoặc
 *  folder đã dời) là lệch. Spawn với cwd không tồn tại thì Windows báo
 *  "spawn cmd.exe ENOENT" chẳng nói lên điều gì, nên phải chặn TRƯỚC khi spawn:
 *  dò lại thư mục theo máy này (lưu luôn vào registry), trượt thì báo thẳng
 *  thư mục nào đang sai. */
async function ensureLocalRoot(app: AppEntry): Promise<AppEntry> {
  if (fs.existsSync(app.root)) return app;
  const found = await relocateAppRoot(app);
  if (!found) {
    throw new Error(`Thư mục "${app.root}" không tồn tại trên máy này — bấm ✏️ sửa lại "Thư mục gốc" theo đường dẫn trên máy bạn.`);
  }
  await updateApp(app.id, { root: found });
  return { ...app, root: found };
}

async function install(id: string) {
  const app = await ensureLocalRoot(await getApp(id));
  const cur = PROCS.get(id);
  if (cur && cur.child.exitCode === null && !cur.child.killed) throw new Error('App đang có tiến trình chạy — dừng trước khi cài.');
  spawnNpm(id, ['install'], app.root, `$ npm install  (cwd: ${app.root})`);
}

/** Cổng <port> có đang trống không. Bind KHÔNG chỉ định host → Node lắng nghe
 *  dual-stack (cả IPv4 0.0.0.0 lẫn IPv6 ::), nên bắt được mọi app đang chiếm
 *  cổng bất kể chúng bind kiểu nào. exclusive:true để không "chia" cổng với
 *  listener đang bật SO_REUSEADDR. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try { srv.listen({ port, exclusive: true }); } catch { resolve(false); }
  });
}

/** Từ <want>, trả cổng trống đầu tiên (tối đa +50). null nếu không có port mong muốn. */
async function resolvePort(want?: number): Promise<{ port: number; bumped: boolean } | null> {
  if (!want) return null;
  for (let p = want; p <= Math.min(want + 50, 65535); p++) {
    if (await portFree(p)) return { port: p, bumped: p !== want };
  }
  return { port: want, bumped: false }; // chịu thua → cứ để app tự báo lỗi
}

async function start(id: string) {
  const app = await ensureLocalRoot(await getApp(id));
  const cur = PROCS.get(id);
  if (cur && cur.child.exitCode === null && !cur.child.killed) throw new Error('App đang chạy rồi.');
  if (!fs.existsSync(path.join(app.root, 'node_modules'))) {
    throw new Error('Project chưa cài dependencies — bấm "📦 npm install" trước khi Start.');
  }

  // Cổng: dò từ port mong muốn, nhảy sang trống kế tiếp nếu bận.
  const resolved = await resolvePort(app.port);
  const env = childEnv();
  const args = ['run', app.cmd];
  let header = `$ npm run ${app.cmd}  (cwd: ${app.root})`;
  if (resolved) {
    env.PORT = String(resolved.port);
    // `-- -p <n>`: cờ SAU `--` được npm chuyển tiếp cho script (Next đọc -p).
    args.push('--', '-p', String(resolved.port));
    header = `$ PORT=${resolved.port} npm run ${app.cmd} -- -p ${resolved.port}  (cwd: ${app.root})`;
    if (resolved.bumped) header += `\n⚠ Cổng ${app.port} đang bận → dùng ${resolved.port} thay thế.`;
  }
  spawnNpmEnv(id, args, app.root, env, header, resolved?.port);
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

  // State chung sau mọi mutation: danh sách + đang chạy + đã cài node_modules.
  const state = async () => {
    const apps = await listApps();
    return { apps, running: runningMap(), installed: await installedMap(apps) };
  };

  try {
    let result: unknown;
    switch (action) {
      case 'list': result = await state(); break;
      // Thêm/sửa app xong thì ghi luôn vào manifest dùng chung, để nó không lệch
      // mà không cần ai nhớ bấm "Đồng bộ". Manifest hỏng KHÔNG được làm hỏng
      // thao tác chính — app đã lưu rồi, cùng lắm là thiếu một dòng dùng chung.
      case 'add': {
        const apps = await addApp(meta);
        await recordApp(apps[0]).catch(() => {});
        result = await state();
        break;
      }
      case 'update': {
        const apps = await updateApp(id, meta);
        const changed = apps.find((a) => a.id === id);
        if (changed) await recordApp(changed).catch(() => {});
        result = await state();
        break;
      }
      // Xoá app chỉ gỡ ở MÁY NÀY. Manifest là của chung — máy khác có thể vẫn
      // dùng app đó, nên chỉ gỡ khỏi manifest khi người dùng nói rõ (alsoShared).
      case 'remove': {
        const app = await getApp(id).catch(() => null);
        await removeApp(id);
        if (app && body.alsoShared === true) await forgetApp(app.name, app.project).catch(() => {});
        result = await state();
        break;
      }
      case 'manifest': result = { manifest: await appManifestStatus() }; break;
      case 'syncManifest':
        await syncAppManifest();
        result = { manifest: await appManifestStatus() };
        break;
      // Dựng entry local từ một mục manifest: chỉ thiếu mỗi `root` của máy này.
      case 'adopt': {
        const root = String(body.root ?? '').trim();
        if (!root) throw new Error('Cần thư mục gốc của app trên máy này.');
        await addApp({
          root,
          name: String(body.name ?? '').trim(),
          cmd: String(body.cmd ?? '').trim(),
          port: body.port as number | undefined,
          project: String(body.project ?? '').trim() || undefined,
          description: String(body.description ?? '').trim() || undefined,
          tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
        });
        result = { ...(await state()), manifest: await appManifestStatus() };
        break;
      }
      case 'start': await start(id); result = await state(); break;
      case 'install': await install(id); result = await state(); break;
      case 'stop': await stop(id); result = await state(); break;
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
