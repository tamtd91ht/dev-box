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
// ĐƯỜNG DẪN THEO MÁY: apps.json/links.json… chứa đường dẫn tuyệt đối
// (E:\vihat\sources). Lúc push đổi thành ${SOURCES_ROOT}, lúc pull đổi lại theo
// machine.json của máy đang chạy — nhờ vậy máy ổ E: và máy ổ D: dùng chung vault.
//
// File nào token hoá cũng không cứu nổi thì cho hẳn vào `exclude` của
// manifest.json — exclude chặn CẢ push LẪN pull, file đó là của riêng từng máy.
// Quy tắc: config có trường trỏ tới THƯ MỤC trên ổ đĩa (gitprojects.json,
// apps.json, apiintegrations.json — đều là `root`) thì exclude, vì mỗi máy clone
// source ra một chỗ, có máy còn không clone repo đó. Chỉ chứa URL / ID /
// connection string thì cứ sync bình thường.

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
/** Danh sách TÊN file có trong vault — plaintext, cạnh vault. Xem baselineVault(). */
const INDEX_FILE = path.join(REPO_DIR, 'vault', 'devbox-configs.index.json');

/**
 * THƯ MỤC CON trong configs/ cũng được sync (mặc định chỉ gói configs/*.json
 * phẳng). Khai ở đây thay vì quét đệ quy cả configs/: thư mục đó còn có file
 * .bak-*, log, cache… mà gói hết lên là phình vault và lộ thêm thứ không cần.
 *
 *   zaloapi-messages/  tin nhắn Zalo API ở chế độ lưu LOCAL (JSONL, một file
 *                      mỗi tài khoản — xem lib/zaloapi/server/messageArchive).
 *                      Sync để đổi máy vẫn thấy lịch sử chat; vault mã hoá bằng
 *                      age nên tin nhắn không nằm trần trên GitHub.
 *
 * Vẫn tôn trọng `exclude` của manifest.json: khai tên thư mục ("zaloapi-messages")
 * vào đó là chặn cả hai chiều, dùng khi muốn giữ tin nhắn riêng từng máy.
 */
const SYNC_SUBDIRS: Array<{ dir: string; exts: string[] }> = [
  { dir: 'zaloapi-messages', exts: ['.jsonl'] },
];

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

// ── Lưới an toàn: đừng để một máy rỗng xoá sạch vault ──────────────────────
//
// SỰ CỐ 2026-08-07: máy mới setup xong, configs/ mới có đúng một file rỗng, bấm
// "Đẩy lên" → vault 38.600 bytes của máy kia bị thay bằng 2.760 bytes. Lấy lại
// được bằng git revert (push không dùng --force nên lịch sử còn nguyên), nhưng
// không được để xảy ra lần nữa.
//
// Vì sao push mù: nó gói những gì đang có trong configs/ rồi GHI ĐÈ TRỌN vault,
// mà vault là ciphertext — muốn biết mình sắp xoá gì thì phải giải mã, mà giải
// mã cần passphrase, mà push thì cố tình không hỏi passphrase. Bế tắc.
//
// Lối ra: mỗi lần push ghi kèm một INDEX PHẲNG cạnh vault, chỉ gồm TÊN file,
// không có nội dung. Không lộ thêm gì — mấy cái tên đó đã nằm sẵn trong
// manifest.json được commit từ đầu. Lần push sau đọc index trên origin là biết
// chính xác mình sắp làm mất file nào, không cần passphrase.
//
// Repo còn ở commit cũ chưa có index thì lùi về so KÍCH THƯỚC vault — thô hơn,
// không nói được mất file nào, nhưng vẫn bắt đúng ca đã xảy ra.

/** Không có index để so thì vault mới nhỏ hơn ngần này lần bản cũ là đáng ngờ
 *  (0.6 = mất hơn 40% dung lượng). Nới tay có chủ ý: ciphertext co giãn theo
 *  nội dung, xoá bớt vài link không nên bị chặn — chỉ chặn ca sụp hẳn. */
const SHRINK_RATIO = 0.6;

/** Kèm theo lỗi SHRINK để UI kể được chuyện gì sắp mất. */
export interface ShrinkDetail {
  /** File có ở bản cũ mà bản sắp đẩy không có — cái sẽ mất. */
  missing: string[];
  newCount: number;
  oldCount?: number;
  newKb: number;
  oldKb: number;
  /** So với `origin/<branch>`, hay chỉ `HEAD` khi máy đang offline. */
  comparedTo: string;
}

interface VaultSnapshot { files?: string[]; bytes: number; ref: string }

/**
 * Ảnh chụp vault đang được coi là "bản chuẩn" để đối chiếu trước khi ghi đè.
 *
 * Ưu tiên `origin/<branch>` (mới fetch) vì đó mới là cái người khác đang dùng;
 * offline thì lùi về HEAD — vẫn hơn không so gì. `null` = repo chưa có vault
 * nào (máy đầu tiên), không có gì để mất, cho đẩy thoải mái.
 */
async function baselineVault(): Promise<VaultSnapshot | null> {
  let branch = 'main';
  try {
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], REPO_DIR);
    branch = stdout.trim() || 'main';
  } catch { /* repo chưa có commit nào */ }

  const refs: string[] = [];
  try {
    await run('git', ['fetch', 'origin', '--quiet'], REPO_DIR);
    refs.push(`origin/${branch}`);
  } catch { /* offline — vẫn so được với HEAD */ }
  refs.push('HEAD');

  for (const ref of refs) {
    let bytes: number;
    try {
      const { stdout } = await run('git', ['cat-file', '-s', `${ref}:vault/devbox-configs.tar.age`], REPO_DIR);
      bytes = Number(stdout.trim());
    } catch { continue; }
    if (!Number.isFinite(bytes) || bytes <= 0) continue;

    let files: string[] | undefined;
    try {
      const { stdout } = await run('git', ['show', `${ref}:vault/devbox-configs.index.json`], REPO_DIR);
      const idx = JSON.parse(stdout) as { files?: unknown };
      if (Array.isArray(idx.files)) files = idx.files.filter((n): n is string => typeof n === 'string');
    } catch { /* commit cũ chưa có index → so bằng kích thước */ }

    return { files, bytes, ref };
  }
  return null;
}

const toKb = (bytes: number): number => Math.round((bytes / 1024) * 10) / 10;

// ── PUSH ───────────────────────────────────────────────────────────────────
export interface PushResult { files: number; skipped: string[]; vaultKb: number; committed: boolean; pushed: boolean; log: string[] }

/**
 * Đóng gói configs/ → mã hoá → commit → push. KHÔNG cần passphrase: age mã hoá
 * bằng public key (recipient mode).
 *
 * `force` bỏ qua lưới an toàn chống ghi đè hụt (xem baselineVault) — chỉ đặt
 * khi người dùng đã đọc danh sách file sắp mất và bấm xác nhận.
 */
export async function push(opts: { remote?: boolean; force?: boolean } = {}): Promise<PushResult> {
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
  // Vault mới dựng ở chỗ tạm rồi mới chuyển vào repo. Nếu lưới an toàn chặn lại
  // thì working tree còn nguyên vẹn — không phải git checkout để dọn nửa chừng.
  const tar = path.join(os.tmpdir(), `devbox-push-${Date.now()}.tar`);
  const newVault = `${tar}.age`;
  const skipped: string[] = [];
  const names: string[] = [];

  try {
    const src = configDir();
    for (const name of await fs.readdir(src)) {
      if (!name.endsWith('.json')) continue;
      if (exclude.has(name)) { skipped.push(name); continue; }
      let text = await fs.readFile(path.join(src, name), 'utf8');
      if (tokenize.has(name)) text = toTokens(text, machine);
      await fs.writeFile(path.join(stage, name), text, 'utf8');
      names.push(name);
    }
    // Thư mục con được khai trong SYNC_SUBDIRS (xem hằng đó): tên trong vault
    // mang cả đường dẫn con ("zaloapi-messages/x.jsonl") nên index/lưới an toàn
    // vẫn so được như file phẳng.
    for (const sub of SYNC_SUBDIRS) {
      if (exclude.has(sub.dir) || exclude.has(`${sub.dir}/`)) { skipped.push(`${sub.dir}/`); continue; }
      let entries: string[];
      try { entries = await fs.readdir(path.join(src, sub.dir)); } catch { continue; }
      const picked = entries.filter((n) => sub.exts.some((e) => n.endsWith(e)));
      if (!picked.length) continue;
      await fs.mkdir(path.join(stage, sub.dir), { recursive: true });
      for (const n of picked) {
        await fs.copyFile(path.join(src, sub.dir, n), path.join(stage, sub.dir, n));
        names.push(`${sub.dir}/${n}`);
      }
    }
    names.sort();
    log.push(`đóng gói ${names.length} file` + (skipped.length ? ` (bỏ qua ${skipped.join(', ')})` : ''));

    await run(tarPath(), ['-cf', tar, '-C', stage, '.']);
    await run(await agePath(), ['-r', recipient, '-o', newVault, tar]);
    const newBytes = (await fs.stat(newVault)).size;
    const vaultKb = toKb(newBytes);

    // ── Lưới an toàn ────────────────────────────────────────────────────────
    const base = opts.force ? null : await baselineVault();
    if (base) {
      const missing = base.files ? base.files.filter((n) => !names.includes(n)) : [];
      // Không có index để so tên thì mới xét kích thước — có index rồi thì tin
      // danh sách tên, vì ciphertext co lại do sửa nội dung là chuyện bình thường.
      const collapsed = !base.files && newBytes < base.bytes * SHRINK_RATIO;
      if (missing.length || collapsed) {
        const detail: ShrinkDetail = {
          missing,
          newCount: names.length,
          oldCount: base.files?.length,
          newKb: vaultKb,
          oldKb: toKb(base.bytes),
          comparedTo: base.ref,
        };
        const err = new Error(
          `Chặn đẩy lên: bản trên ${base.ref} `
          + (base.files ? `có ${base.files.length} file` : `nặng ${toKb(base.bytes)} KB`)
          + `, còn máy này chỉ gói được ${names.length} file (${vaultKb} KB). `
          + (missing.length
            ? `Đẩy lên sẽ XOÁ: ${missing.join(', ')}. `
            : 'Vault sẽ hụt đi quá nửa. ')
          + 'Nếu máy này chưa Kéo về lần nào thì Kéo về trước đã. '
          + 'Chắc chắn muốn thay hẳn thì bấm "Vẫn đẩy, ghi đè".',
        );
        (err as Error & { code?: string; detail?: ShrinkDetail }).code = 'SHRINK';
        (err as Error & { code?: string; detail?: ShrinkDetail }).detail = detail;
        throw err;
      }
    }

    await fs.mkdir(path.dirname(VAULT_FILE), { recursive: true });
    await fs.rm(VAULT_FILE, { force: true });
    await fs.copyFile(newVault, VAULT_FILE);
    log.push(`mã hoá → vault ${vaultKb} KB`);

    // Index cho lần push sau đối chiếu. Chỉ TÊN file, tuyệt đối không nội dung.
    await fs.writeFile(
      INDEX_FILE,
      `${JSON.stringify({
        _comment: 'Tu dong sinh boi lib/configSync.ts. CHI ten file trong vault, '
          + 'khong co noi dung — de lan push sau biet minh sap xoa mat gi ma '
          + 'khong can passphrase. Dung sua tay.',
        machine: machine.name || os.hostname(),
        at: new Date().toISOString(),
        count: names.length,
        files: names,
      }, null, 2)}\n`,
      'utf8',
    );

    // Commit. Hook pre-commit vẫn chạy — nó là lưới an toàn cuối.
    await run('git', ['add', '-A'], REPO_DIR);
    const { stdout: staged } = await run('git', ['diff', '--cached', '--name-only'], REPO_DIR);
    if (!staged.trim()) {
      log.push('không có gì thay đổi');
      return { files: names.length, skipped, vaultKb, committed: false, pushed: false, log };
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
    return { files: names.length, skipped, vaultKb, committed: true, pushed, log };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
    await fs.rm(tar, { force: true });
    await fs.rm(newVault, { force: true });
  }
}

// ── PULL ───────────────────────────────────────────────────────────────────
export interface PullResult { files: number; created: string[]; changed: string[]; skipped: string[]; log: string[] }

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

  // machine.json là của riêng máy này (gitignore) nên đọc trước được — và đọc
  // trước là cố ý: thiếu nó thì dừng ngay, chưa đụng tới `git reset --hard`.
  const machine = await readMachine();

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

  // ĐỌC MANIFEST SAU KHI GIT PULL, không phải trước.
  //
  // manifest.json nằm trong chính repo config, nên lần kéo về ngay sau khi ai đó
  // sửa danh sách exclude là lần mà bản trên đĩa còn CŨ. Đọc trước git pull thì
  // luật vừa thêm chưa có hiệu lực, file đáng lẽ được giữ lại vẫn bị đè — phải
  // kéo lần thứ hai mới đúng. Đọc sau thì luật mới ăn ngay từ lần đầu.
  //
  // `exclude` chặn CẢ HAI CHIỀU: push không gói file đó lên, pull không ghi đè
  // bản của máy này — kể cả khi vault cũ vẫn còn chứa nó.
  const manifest = await readManifest();
  const tokenize = new Set(manifest.devbox?.tokenize || []);
  const exclude = new Set(manifest.devbox?.exclude || []);

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
    const skipped: string[] = [];
    let files = 0;

    for (const name of await fs.readdir(out)) {
      if (!name.endsWith('.json')) continue;
      if (exclude.has(name)) { skipped.push(name); continue; }
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

    // Thư mục con (xem SYNC_SUBDIRS). Không tokenize (nội dung là dữ liệu, không
    // phải đường dẫn) và KHÔNG .bak mỗi file — kho tin có thể nhiều file, giữ
    // bản cũ từng lượt pull sẽ rác dần; file đã ghi rồi thì bản trong vault mới
    // là bản chuẩn.
    for (const sub of SYNC_SUBDIRS) {
      if (exclude.has(sub.dir) || exclude.has(`${sub.dir}/`)) { skipped.push(`${sub.dir}/`); continue; }
      let entries: string[];
      try { entries = await fs.readdir(path.join(out, sub.dir)); } catch { continue; }
      const picked = entries.filter((n) => sub.exts.some((e) => n.endsWith(e)));
      if (!picked.length) continue;
      await fs.mkdir(path.join(dst, sub.dir), { recursive: true });
      for (const n of picked) {
        const rel = `${sub.dir}/${n}`;
        const target = path.join(dst, sub.dir, n);
        const had = await exists(target);
        await fs.copyFile(path.join(out, sub.dir, n), target);
        if (had) changed.push(rel); else created.push(rel);
        files++;
      }
    }

    log.push(
      `ghi ${files} file`
      + (created.length ? `, mới: ${created.length}` : '')
      + (changed.length ? `, đổi: ${changed.length}` : '')
      + (skipped.length ? `, giữ nguyên bản máy này: ${skipped.join(', ')}` : ''),
    );
    return { files, created, changed, skipped, log };
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
