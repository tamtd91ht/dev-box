// Đồng bộ configs/ của máy này với repo dev-box-config (private, đã mã hoá).
//
// VÌ SAO KHÔNG DÙNG JUNCTION: bản đầu tiên biến configs/ thành junction trỏ vào
// repo. Nhưng dev server giữ handle thư mục đó, nên mọi thao tác cần xoá/tạo lại
// junction đều phải đóng app — bất tiện và đã một lần làm hỏng .next/. Giờ
// configs/ là thư mục THẬT như trước, còn sync là copy hai chiều. Không bao giờ
// phải đóng app.
//
// MÔ HÌNH BẢO MẬT:
//   push  chỉ cần PUBLIC key (age recipient mode) → không hỏi passphrase.
//   pull  cần PRIVATE key, mà nó bị bọc PBKDF2 → phải có passphrase.
// Nhờ vậy việc bạn làm thường xuyên (push) không có ma sát, còn việc hiếm (pull,
// thường chỉ khi sang máy mới) mới phải nhập.
//
// ĐƯỜNG DẪN THEO MÁY: gitprojects.json/apps.json… chứa đường dẫn tuyệt đối
// (E:\vihat\sources). Lúc push đổi thành ${SOURCES_ROOT}, lúc pull đổi lại theo
// machine.json của máy đang chạy — nhờ vậy máy ổ E: và máy ổ D: dùng chung vault.

import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { configDir } from './configDir';

export const REPO_DIR = process.env.DEVBOX_CONFIG_REPO
  ? path.resolve(process.env.DEVBOX_CONFIG_REPO)
  : path.join(os.homedir(), '.dev-box-config');

const VAULT_FILE = path.join(REPO_DIR, 'vault', 'devbox-configs.tar.age');
const KEY_FILE = path.join(REPO_DIR, 'age-key.enc');
const PUB_FILE = path.join(REPO_DIR, 'age-recipient.txt');
const MACHINE_FILE = path.join(REPO_DIR, 'machine.json');
const MANIFEST_FILE = path.join(REPO_DIR, 'manifest.json');

/** Thư mục tạm riêng cho mỗi lần chạy — tránh hai lần sync đè nhau. */
function tmpDir(tag: string): string {
  return path.join(os.tmpdir(), `devbox-sync-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

// ── Chạy lệnh ngoài ────────────────────────────────────────────────────────
// Nhiều tool (age, tar, git) in thông báo bình thường ra stderr, nên KHÔNG coi
// stderr là lỗi — chỉ xét exit code.
function run(exe: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${path.basename(exe)} thất bại: ${stderr || stdout || err.message}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * bsdtar của Windows (System32\tar.exe), KHÔNG phải GNU tar của Git Bash —
 * GNU tar hiểu "C:\..." là tên host mạng và báo "Cannot connect to C:".
 */
function tarPath(): string {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

let agePathCache: string | null = null;
async function agePath(): Promise<string> {
  if (agePathCache) return agePathCache;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'age.exe'),
    path.join(
      process.env.LOCALAPPDATA || '',
      'Microsoft', 'WinGet', 'Packages',
      'FiloSottile.age_Microsoft.Winget.Source_8wekyb3d8bbwe', 'age', 'age.exe',
    ),
  ];
  for (const c of candidates) {
    if (c && await exists(c)) { agePathCache = c; return c; }
  }
  // Cuối cùng thử PATH — nếu không có, ném lỗi kèm cách cài.
  try {
    await run('age.exe', ['--version']);
    agePathCache = 'age.exe';
    return agePathCache;
  } catch {
    throw new Error('Chưa cài age. Chạy: winget install FiloSottile.age');
  }
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

// ── machine.json + đổi đường dẫn ↔ biến ────────────────────────────────────
interface Machine { name?: string; paths: Record<string, string> }
interface Manifest {
  devbox: { exclude?: string[]; tokenize?: string[] };
}

async function readMachine(): Promise<Machine> {
  const raw = await fs.readFile(MACHINE_FILE, 'utf8');
  const m = JSON.parse(raw) as Machine;
  if (!m.paths) throw new Error('machine.json thiếu khối "paths".');
  return m;
}

async function readManifest(): Promise<Manifest> {
  const raw = await fs.readFile(MANIFEST_FILE, 'utf8');
  return JSON.parse(raw) as Manifest;
}

/** Đường dẫn thật → ${BIẾN}. Thay path DÀI trước để không lồng nhau sai. */
function toTokens(text: string, m: Machine): string {
  const names = Object.keys(m.paths)
    .filter((k) => !k.startsWith('_') && m.paths[k])
    .sort((a, b) => m.paths[b].length - m.paths[a].length);
  let out = text;
  for (const name of names) {
    const real = m.paths[name];
    const token = '${' + name + '}';
    // JSON escape "\" thành "\\" → phải thay cả hai dạng, và cả dạng "/".
    out = out.split(real.replace(/\\/g, '\\\\')).join(token);
    out = out.split(real).join(token);
    out = out.split(real.replace(/\\/g, '/')).join(token);
  }
  return out;
}

/** ${BIẾN} → đường dẫn thật của máy đang chạy. */
function fromTokens(text: string, m: Machine): string {
  let out = text;
  for (const [name, real] of Object.entries(m.paths)) {
    if (name.startsWith('_') || !real) continue;
    out = out.split('${' + name + '}').join(real.replace(/\\/g, '\\\\'));
  }
  return out;
}

// ── Trạng thái ─────────────────────────────────────────────────────────────
export interface SyncStatus {
  /** Repo đã clone và có machine.json chưa. */
  ready: boolean;
  /** Vì sao chưa ready — hiện cho người dùng biết phải làm gì. */
  reason?: string;
  /** Việc app TỰ LÀM ĐƯỢC để hết `reason` — nút "Thiết lập" gọi setup().
   *  'clone'   chưa có repo config trên máy
   *  'machine' có repo rồi nhưng chưa khai đường dẫn của máy này
   *  'age'     chưa cài age.exe (winget install)
   *  null      không tự làm được, phải người xử lý (xem reason) */
  fixable?: 'clone' | 'machine' | 'age' | null;
  repoDir: string;
  machineName?: string;
  /** Có public key → push được (không cần passphrase). */
  canPush: boolean;
  /** Có private key đã bọc → pull được (cần passphrase). */
  canPull: boolean;
  /** Lần push cuối (mtime của vault). */
  vaultUpdatedAt?: string;
  vaultSizeKb?: number;
  /** Số file trong configs/ của máy. */
  localFiles: number;
  /** Git: có commit chưa push / behind remote không. */
  git?: { ahead: number; behind: number; dirty: boolean; lastCommit?: string };
}

export async function getStatus(): Promise<SyncStatus> {
  const st: SyncStatus = { ready: false, repoDir: REPO_DIR, canPush: false, canPull: false, localFiles: 0 };

  try {
    st.localFiles = (await fs.readdir(configDir())).filter((f) => f.endsWith('.json')).length;
  } catch { /* configs/ chưa có — vẫn báo được các phần khác */ }

  // age.exe kiểm trước: thiếu nó thì clone về cũng không giải mã được.
  try { await agePath(); } catch {
    st.reason = 'Chưa cài age (công cụ mã hoá). Bấm "Thiết lập" để cài tự động.';
    st.fixable = 'age';
    return st;
  }

  if (!await exists(REPO_DIR)) {
    st.reason = 'Máy này chưa có repo config. Bấm "Thiết lập" để tải về.';
    st.fixable = 'clone';
    return st;
  }
  if (!await exists(MACHINE_FILE)) {
    st.reason = 'Chưa khai đường dẫn của máy này. Bấm "Thiết lập" để tạo tự động.';
    st.fixable = 'machine';
    return st;
  }

  st.canPush = await exists(PUB_FILE);
  st.canPull = await exists(KEY_FILE);
  if (!st.canPush) {
    // Khoá nằm trong repo nên clone về là có. Thiếu nó nghĩa là repo rỗng —
    // chưa máy nào chạy -Init. Việc này KHÔNG tự làm được: passphrase phải do
    // người đặt, và chỉ làm MỘT LẦN trên máy đầu tiên.
    st.reason = 'Repo config chưa có khoá mã hoá — máy đầu tiên phải tạo khoá trước '
      + '(chạy .\\scripts\\bootstrap.ps1 -Init ở repo config), rồi máy này mới kéo về được.';
    st.fixable = null;
    return st;
  }

  try { st.machineName = (await readMachine()).name; } catch { /* tên chỉ để hiển thị */ }

  if (await exists(VAULT_FILE)) {
    const s = await fs.stat(VAULT_FILE);
    st.vaultUpdatedAt = s.mtime.toISOString();
    st.vaultSizeKb = Math.round((s.size / 1024) * 10) / 10;
  }

  try {
    const { stdout: sb } = await run('git', ['status', '--porcelain', '--branch'], REPO_DIR);
    const lines = sb.split('\n');
    const branchLine = lines[0] || '';
    const ahead = /ahead (\d+)/.exec(branchLine);
    const behind = /behind (\d+)/.exec(branchLine);
    st.git = {
      ahead: ahead ? Number(ahead[1]) : 0,
      behind: behind ? Number(behind[1]) : 0,
      dirty: lines.slice(1).some((l) => l.trim()),
    };
    const { stdout: lg } = await run('git', ['log', '-1', '--format=%h %s'], REPO_DIR);
    st.git.lastCommit = lg.trim() || undefined;
  } catch { /* repo chưa có commit nào */ }

  st.ready = true;
  return st;
}

// ── SETUP: dựng repo config trên máy mới, không cần chạy lệnh tay ──────────
export const CONFIG_REPO_URL = process.env.DEVBOX_CONFIG_REPO_URL
  || 'https://github.com/tamtd91ht/dev-box-config.git';

export interface SetupResult { log: string[]; status: SyncStatus }

/**
 * Làm những việc mà trước đây bắt người dùng chạy script: cài age, clone repo
 * config, sinh machine.json cho máy này. Sau khi xong thì Pull được ngay.
 *
 * KHÔNG tạo khoá (-Init): passphrase phải do người đặt và chỉ làm một lần trên
 * máy đầu tiên. Máy thứ 2 trở đi lấy khoá từ repo (age-key.enc đã bọc).
 */
export async function setup(): Promise<SetupResult> {
  const log: string[] = [];

  // 1. age.exe
  try {
    await agePath();
    log.push('age đã có');
  } catch {
    log.push('đang cài age…');
    await run('winget', [
      'install', '--id', 'FiloSottile.age', '--source', 'winget',
      '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity',
    ]);
    agePathCache = null; // buộc dò lại sau khi cài
    await agePath();
    log.push('đã cài age');
  }

  // 2. clone repo config
  if (!await exists(REPO_DIR)) {
    log.push(`đang tải repo config về ${REPO_DIR}…`);
    await run('git', ['clone', CONFIG_REPO_URL, REPO_DIR]);
    log.push('đã tải repo config');
  } else {
    log.push('repo config đã có');
  }

  // 3. machine.json — suy đường dẫn từ chỗ app đang chạy.
  if (!await exists(MACHINE_FILE)) {
    const devboxRoot = process.cwd();          // dev-box đang chạy ở đây
    const toolRoot = path.dirname(devboxRoot); // ...\tool\vhs
    // SOURCES_ROOT: quy ước của máy đầu là <ổ>\vihat\sources. Dò vài chỗ hay
    // gặp, không thấy thì để trống — người dùng sửa sau nếu cần. Để trống vẫn
    // pull được, chỉ là đường dẫn project trong gitprojects.json không khớp.
    const guesses = [
      path.join(path.dirname(toolRoot), 'sources'),          // ...\vihat\sources
      path.join(path.parse(devboxRoot).root, 'vihat', 'sources'),
      path.join(path.dirname(devboxRoot), 'sources'),
    ];
    let sourcesRoot = '';
    for (const g of guesses) {
      if (await exists(g)) { sourcesRoot = g; break; }
    }

    const machine = {
      _comment: 'Duong dan rieng cua may nay. File nay KHONG duoc commit. '
        + 'App tu sinh khi bam "Thiet lap" — sua lai neu duong dan doan sai.',
      name: os.hostname(),
      paths: {
        DEVBOX_ROOT: devboxRoot,
        TOOL_ROOT: toolRoot,
        SOURCES_ROOT: sourcesRoot || path.join(path.dirname(toolRoot), 'sources'),
      },
    };
    await fs.writeFile(MACHINE_FILE, JSON.stringify(machine, null, 2), 'utf8');
    log.push(`đã tạo machine.json (${machine.name})`);
    log.push(`  DEVBOX_ROOT  = ${devboxRoot}`);
    log.push(`  TOOL_ROOT    = ${toolRoot}`);
    log.push(`  SOURCES_ROOT = ${machine.paths.SOURCES_ROOT}${sourcesRoot ? '' : '  (đoán — sửa nếu sai)'}`);
  } else {
    log.push('machine.json đã có');
  }

  // 4. cài pre-commit hook (git không clone hook theo repo)
  try {
    const hookSrc = path.join(REPO_DIR, 'scripts', 'pre-commit');
    const hookDst = path.join(REPO_DIR, '.git', 'hooks', 'pre-commit');
    if (await exists(hookSrc) && !await exists(hookDst)) {
      // Hook là shell script — phải LF, nếu CRLF thì sh báo "bad interpreter".
      const text = (await fs.readFile(hookSrc, 'utf8')).replace(/\r\n/g, '\n');
      await fs.writeFile(hookDst, text, 'utf8');
      log.push('đã cài pre-commit hook (lưới an toàn chống lộ secret)');
    }
  } catch { /* không có hook thì bỏ qua, không phải lỗi chặn */ }

  return { log, status: await getStatus() };
}

// ── PUSH ───────────────────────────────────────────────────────────────────
export interface PushResult { files: number; skipped: string[]; vaultKb: number; committed: boolean; pushed: boolean; log: string[] }

/**
 * Đóng gói configs/ → mã hoá → commit → push. KHÔNG cần passphrase: age mã hoá
 * bằng public key (recipient mode).
 */
export async function push(opts: { remote?: boolean } = {}): Promise<PushResult> {
  const log: string[] = [];
  const st = await getStatus();
  if (!st.ready) throw new Error(st.reason || 'Repo config chưa sẵn sàng.');

  const machine = await readMachine();
  const manifest = await readManifest();
  const exclude = new Set(manifest.devbox?.exclude || []);
  const tokenize = new Set(manifest.devbox?.tokenize || []);
  const recipient = (await fs.readFile(PUB_FILE, 'utf8')).trim();

  const stage = tmpDir('push');
  await fs.mkdir(stage, { recursive: true });
  const skipped: string[] = [];
  let count = 0;

  try {
    const src = configDir();
    for (const name of await fs.readdir(src)) {
      if (!name.endsWith('.json')) continue;
      if (exclude.has(name)) { skipped.push(name); continue; }
      let text = await fs.readFile(path.join(src, name), 'utf8');
      if (tokenize.has(name)) text = toTokens(text, machine);
      await fs.writeFile(path.join(stage, name), text, 'utf8');
      count++;
    }
    log.push(`đóng gói ${count} file` + (skipped.length ? ` (bỏ qua ${skipped.join(', ')})` : ''));

    const tar = path.join(os.tmpdir(), `devbox-push-${Date.now()}.tar`);
    await run(tarPath(), ['-cf', tar, '-C', stage, '.']);
    await fs.mkdir(path.dirname(VAULT_FILE), { recursive: true });
    // -o ghi đè vault cũ; age không tự ghi đè nên phải xoá trước.
    await fs.rm(VAULT_FILE, { force: true });
    await run(await agePath(), ['-r', recipient, '-o', VAULT_FILE, tar]);
    await fs.rm(tar, { force: true });

    const vaultKb = Math.round(((await fs.stat(VAULT_FILE)).size / 1024) * 10) / 10;
    log.push(`mã hoá → vault ${vaultKb} KB`);

    // Commit. Hook pre-commit vẫn chạy — nó là lưới an toàn cuối.
    await run('git', ['add', '-A'], REPO_DIR);
    const { stdout: staged } = await run('git', ['diff', '--cached', '--name-only'], REPO_DIR);
    if (!staged.trim()) {
      log.push('không có gì thay đổi');
      return { files: count, skipped, vaultKb, committed: false, pushed: false, log };
    }

    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    await run('git', ['commit', '-m', `sync: ${machine.name || os.hostname()} @ ${stamp}`], REPO_DIR);
    log.push('committed');

    let pushed = false;
    if (opts.remote !== false) {
      await run('git', ['push'], REPO_DIR);
      pushed = true;
      log.push('đã đẩy lên GitHub');
    }
    return { files: count, skipped, vaultKb, committed: true, pushed, log };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

// ── PULL ───────────────────────────────────────────────────────────────────
export interface PullResult { files: number; created: string[]; changed: string[]; log: string[] }

/**
 * Kéo từ remote → giải mã → ghi vào configs/. CẦN passphrase để mở private key.
 *
 * Ghi trực tiếp vào configs/ (thư mục thật, không junction) nên app đang chạy
 * vẫn đọc được — nhưng phải khởi động lại app để nó nạp config mới, vì phần lớn
 * store đọc file một lần lúc start.
 */
export async function pull(passphrase: string, opts: { force?: boolean } = {}): Promise<PullResult> {
  const log: string[] = [];
  const st = await getStatus();
  if (!st.ready) throw new Error(st.reason || 'Repo config chưa sẵn sàng.');
  if (!st.canPull) throw new Error('Không có age-key.enc trong repo — chưa thể giải mã.');

  const machine = await readMachine();
  const manifest = await readManifest();
  const tokenize = new Set(manifest.devbox?.tokenize || []);

  if (opts.force) {
    // LẤY HẲN BẢN TRÊN GITHUB, bỏ mọi commit/thay đổi chỉ có ở máy này.
    // Dùng khi hai máy cùng push và bạn đã chọn bên GitHub thắng.
    await run('git', ['fetch', 'origin'], REPO_DIR);
    const { stdout: br } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], REPO_DIR);
    const branch = br.trim() || 'main';
    await run('git', ['reset', '--hard', `origin/${branch}`], REPO_DIR);
    // Vault/machine.json không bị clean vì đã gitignore; -fd chỉ dọn rác lạ.
    await run('git', ['clean', '-fd'], REPO_DIR);
    log.push(`ghi đè: đã lấy hẳn origin/${branch}`);
  } else {
    try {
      await run('git', ['pull', '--ff-only'], REPO_DIR);
      log.push('git pull');
    } catch (e) {
      // --ff-only: hai máy cùng sửa thì DỪNG, không tự merge ciphertext (merge
      // hai file .age là ra file hỏng). Ném lỗi có dấu hiệu để UI hiện nút
      // "Kéo về và ghi đè" thay vì bắt người dùng chạy git tay.
      const err = new Error(
        'Hai máy cùng sửa config nên không kéo về thẳng được. '
        + 'Chọn "Ghi đè bằng bản trên GitHub" để lấy bản trên mạng '
        + '(thay đổi chưa đẩy của máy này sẽ mất), hoặc Đẩy lên trước nếu máy này mới hơn.',
      );
      (err as Error & { code?: string }).code = 'DIVERGED';
      throw err;
    }
  }

  const idFile = await unwrapKey(passphrase);
  const out = tmpDir('pull');
  try {
    const tar = path.join(os.tmpdir(), `devbox-pull-${Date.now()}.tar`);
    await run(await agePath(), ['-d', '-i', idFile, '-o', tar, VAULT_FILE]);
    await fs.mkdir(out, { recursive: true });
    await run(tarPath(), ['-xf', tar, '-C', out]);
    await fs.rm(tar, { force: true });

    const dst = configDir();
    await fs.mkdir(dst, { recursive: true });
    const created: string[] = [];
    const changed: string[] = [];
    let files = 0;

    for (const name of await fs.readdir(out)) {
      if (!name.endsWith('.json')) continue;
      let text = await fs.readFile(path.join(out, name), 'utf8');
      if (tokenize.has(name)) text = fromTokens(text, machine);
      const target = path.join(dst, name);
      let prev: string | null = null;
      try { prev = await fs.readFile(target, 'utf8'); } catch { /* file mới */ }
      if (prev === null) created.push(name);
      else if (prev !== text) {
        // Giữ bản cũ lại — nếu pull ghi đè mất gì thì còn chỗ lấy lại.
        await fs.copyFile(target, `${target}.bak-${Date.now()}`);
        changed.push(name);
      }
      await fs.writeFile(target, text, 'utf8');
      files++;
    }

    log.push(`ghi ${files} file` + (created.length ? `, mới: ${created.length}` : '') + (changed.length ? `, đổi: ${changed.length}` : ''));
    return { files, created, changed, log };
  } finally {
    await shred(idFile);
    await fs.rm(out, { recursive: true, force: true });
  }
}

// ── Mở bọc private key ─────────────────────────────────────────────────────
/**
 * age-key.enc = [salt 16B][IV 16B][AES-256-CBC ciphertext], khoá dẫn xuất bằng
 * PBKDF2-SHA256 200_000 vòng. Cùng định dạng với scripts/lib.ps1 nên khoá tạo
 * bằng bootstrap.ps1 -Init mở được ở đây và ngược lại.
 */
async function unwrapKey(passphrase: string): Promise<string> {
  const crypto = await import('crypto');
  const blob = await fs.readFile(KEY_FILE);
  if (blob.length < 33) throw new Error('age-key.enc bị lỗi (quá ngắn).');

  const salt = blob.subarray(0, 16);
  const iv = blob.subarray(16, 32);
  const ct = blob.subarray(32);
  const key = crypto.pbkdf2Sync(passphrase, salt, 200000, 32, 'sha256');

  let plain: Buffer;
  try {
    const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
    plain = Buffer.concat([d.update(ct), d.final()]);
  } catch {
    // final() ném khi padding sai — dấu hiệu điển hình của passphrase sai.
    throw new Error('Passphrase sai.');
  }
  if (!plain.toString('utf8').includes('AGE-SECRET-KEY')) throw new Error('Passphrase sai.');

  const f = path.join(os.tmpdir(), `devbox-id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  await fs.writeFile(f, plain, { mode: 0o600 });
  return f;
}

/** Ghi đè bằng zero trước khi xoá — giảm khả năng đọc lại từ đĩa. */
async function shred(f: string): Promise<void> {
  try {
    const { size } = await fs.stat(f);
    await fs.writeFile(f, Buffer.alloc(size));
  } catch { /* đã mất thì thôi */ }
  await fs.rm(f, { force: true });
}
