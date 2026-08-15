// Server-only: tự cập nhật CHÍNH DevBox bằng `git pull` trên thư mục cài đặt.
//
// VÌ SAO KHÔNG DÙNG LẠI lib/gitCore.ts: gitCore cố ý bị khoá sau
// GIT_TOOL_ENABLED và một allowlist các repo *anh em* dưới GIT_TOOL_ROOT —
// bản thân dev-box không nằm trong danh sách đó. Nút tự-cập-nhật phải chạy
// được cả khi tab Git tắt, nên nó có module riêng.
//
// MÔ HÌNH AN TOÀN — chặt hơn gitCore vì ở đây không cần linh hoạt:
//   1. Chỉ MỘT thư mục duy nhất: process.cwd(), tức repo đang chạy server này.
//      Không có tham số path nào từ request đi vào đây → không có gì để lợi
//      dụng. Client chỉ chọn được `action`.
//   2. execFile('git', [argv]) — KHÔNG BAO GIỜ chuỗi shell. Tên nhánh lấy từ
//      chính git chứ không từ người dùng, nhưng vẫn đi qua argv riêng.
//   3. Chỉ merge --ff-only. Không reset --hard, không checkout -f, không
//      clean. Không có đường nào trong file này làm mất việc chưa commit của
//      người dùng — trường hợp xấu nhất là nó từ chối chạy.

import { execFile } from 'child_process';
import path from 'path';

/** Thư mục app = cwd của tiến trình Next. Hằng số, không nhận từ đâu khác. */
const APP_DIR = path.resolve(process.cwd());

const MAX_BUFFER = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
/** fetch/pull đi qua mạng — chậm hơn lệnh cục bộ nhiều. */
const NET_TIMEOUT_MS = 120_000;

interface GitOpts {
  timeoutMs?: number;
  /** Nhận cả stderr — git ghi tiến trình fetch/pull ra đó. */
  withStderr?: boolean;
}

/** Chạy một lệnh git trong thư mục app. Lỗi → reject kèm stderr đã trim. */
function git(args: string[], opts: GitOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: APP_DIR,
        maxBuffer: MAX_BUFFER,
        timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
        windowsHide: true,
        env: {
          ...process.env,
          // Không bao giờ để git bật hộp thoại hỏi mật khẩu: tiến trình này
          // không có ai ngồi trước màn hình để trả lời, nó sẽ treo tới lúc
          // timeout. Thà fail nhanh và báo "cần đăng nhập lại".
          GIT_TERMINAL_PROMPT: '0',
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || (err as Error).message || '').toString().trim();
          reject(new Error(msg || 'lệnh git thất bại'));
          return;
        }
        resolve(opts.withStderr ? stdout.toString() + stderr.toString() : stdout.toString());
      },
    );
  });
}

/** Một commit đang chờ được kéo về. */
export interface PendingCommit {
  hash: string;
  subject: string;
  author: string;
  /** ISO — client tự định dạng "x giờ trước". */
  date: string;
}

/** Việc cần làm SAU khi pull xong, suy ra từ các file đã đổi. */
export type FollowUp = 'reload' | 'restart' | 'install';

export interface UpdateStatus {
  /** false khi thư mục app không phải một git working tree (bản zip chẳng hạn). */
  isRepo: boolean;
  /** Lý do không cập nhật được — chỉ có khi isRepo=false hoặc thiếu upstream. */
  reason?: string;
  branch: string;
  /** Ví dụ 'origin/dev'. Rỗng khi nhánh chưa có upstream. */
  upstream: string;
  head: string;
  /** Số commit local đi trước/sau upstream. */
  ahead: number;
  behind: number;
  /** Có thay đổi chưa commit (kể cả file mới chưa add). */
  dirty: boolean;
  /** Tên file đang bẩn — panel liệt kê ra để người dùng biết vướng cái gì. */
  dirtyFiles: string[];
  /** Các commit sắp được kéo về, mới nhất trước. */
  pending: PendingCommit[];
  /** Lần fetch gần nhất, epoch ms. */
  fetchedAt: number | null;
}

/** Kết quả một lần bấm "Cập nhật". */
export interface UpdateResult {
  /** Đã thực sự tiến lên commit mới hay không (false = vốn đã mới nhất). */
  updated: boolean;
  fromHead: string;
  toHead: string;
  /** Số commit vừa nhận. */
  count: number;
  /** Việc cần làm tiếp, tính từ các file đã đổi. */
  followUp: FollowUp;
  /** Vì sao lại là followUp đó — panel hiện cho người dùng đọc. */
  followUpReason: string;
  /** Đã cất tạm thay đổi trước khi pull (người dùng chủ động chọn). */
  stashed: boolean;
}

/** Lỗi có `code` để client phân biệt ca xử lý được bằng nút. */
export class UpdateError extends Error {
  code: string;
  /** Kèm danh sách file bẩn cho code='DIRTY'. */
  files?: string[];
  constructor(message: string, code: string, files?: string[]) {
    super(message);
    this.code = code;
    this.files = files;
  }
}

/** Lần fetch gần nhất trong tiến trình này — chỉ để hiện "vừa kiểm tra". */
let lastFetchedAt: number | null = null;

/** Bỏ dòng trống, trim từng dòng. */
function lines(out: string): string[] {
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * Đọc trạng thái hiện tại. KHÔNG chạm mạng trừ khi `fetch` = true.
 *
 * Không bao giờ throw vì lý do "chưa cấu hình": thư mục không phải repo, hay
 * nhánh chưa có upstream, đều là trạng thái hợp lệ mà UI cần hiện tử tế
 * (isRepo=false + reason). Chỉ lỗi thật (git chết, mất mạng lúc fetch) mới ném.
 */
export async function getStatus(fetch = false): Promise<UpdateStatus> {
  const empty: UpdateStatus = {
    isRepo: false,
    branch: '',
    upstream: '',
    head: '',
    ahead: 0,
    behind: 0,
    dirty: false,
    dirtyFiles: [],
    pending: [],
    fetchedAt: lastFetchedAt,
  };

  try {
    const inside = (await git(['rev-parse', '--is-inside-work-tree'])).trim();
    if (inside !== 'true') {
      return { ...empty, reason: 'Thư mục app không phải một repo Git.' };
    }
  } catch {
    return {
      ...empty,
      reason: 'Không chạy được Git ở thư mục app (chưa cài git, hoặc app tải về dạng nén).',
    };
  }

  if (fetch) {
    // --prune để nhánh đã xoá trên remote không còn lảng vảng ở local.
    await git(['fetch', '--prune', 'origin'], {
      timeoutMs: NET_TIMEOUT_MS,
      withStderr: true,
    });
    lastFetchedAt = Date.now();
  }

  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const head = (await git(['rev-parse', '--short', 'HEAD'])).trim();

  // Nhánh chưa gắn upstream (hoặc HEAD rời) → không biết kéo từ đâu.
  let upstream = '';
  try {
    upstream = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
  } catch {
    return {
      ...empty,
      isRepo: true,
      branch,
      head,
      fetchedAt: lastFetchedAt,
      reason:
        branch === 'HEAD'
          ? 'Đang ở trạng thái HEAD rời (không đứng trên nhánh nào) — không tự cập nhật được.'
          : `Nhánh "${branch}" chưa gắn với nhánh nào trên remote — không biết kéo từ đâu.`,
    };
  }

  // --porcelain: mỗi dòng đúng dạng "XY <path>" — X là trạng thái ở index, Y ở
  // working tree, path bắt đầu từ cột 4.
  //
  // KHÔNG dùng lines() ở đây: nó trim từng dòng, mà cột 1-2 CÓ THỂ là space
  // (" M file" = sửa chưa add, "A  file" = mới thêm vào index). Trim trước rồi
  // slice(3) thì cắt lẹm mất ký tự đầu của tên file — "app/globals.css" thành
  // "pp/globals.css". Cắt theo cột trước, trim sau.
  const dirtyFiles = (await git(['status', '--porcelain']))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.slice(3).trim())
    // Đổi tên hiện dạng "cũ -> mới"; chỉ tên mới mới là thứ đang có trên đĩa.
    .map((p) => {
      const arrow = p.indexOf(' -> ');
      return arrow === -1 ? p : p.slice(arrow + 4);
    })
    // Path có khoảng trắng được git bọc trong ngoặc kép.
    .map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p));

  // Một lệnh, hai số: đếm commit mỗi bên kể từ điểm rẽ nhánh.
  const [aheadRaw, behindRaw] = (
    await git(['rev-list', '--left-right', '--count', `HEAD...${upstream}`])
  )
    .trim()
    .split(/\s+/);

  const behind = Number(behindRaw) || 0;

  // Danh sách commit sắp nhận — %x1f (unit separator) để subject chứa ký tự gì
  // cũng không vỡ khi tách trường.
  let pending: PendingCommit[] = [];
  if (behind > 0) {
    const out = await git([
      'log',
      `HEAD..${upstream}`,
      '--no-merges',
      '--max-count=50',
      '--date=iso-strict',
      '--pretty=format:%h%x1f%s%x1f%an%x1f%ad',
    ]);
    pending = lines(out).map((line) => {
      const [hash, subject, author, date] = line.split('\x1f');
      return { hash, subject, author, date };
    });
  }

  return {
    isRepo: true,
    branch,
    upstream,
    head,
    ahead: Number(aheadRaw) || 0,
    behind,
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
    pending,
    fetchedAt: lastFetchedAt,
  };
}

/**
 * Suy ra việc cần làm tiếp từ danh sách file đã đổi.
 *
 * Thứ tự ưu tiên là có chủ đích — nặng nhất thắng: đụng package.json thì phải
 * cài lại rồi mới khởi động lại được, nên 'install' bao trùm 'restart'.
 *
 *   package.json / package-lock.json → 'install'  (cần npm install)
 *   electron/**                      → 'restart'  (main process không hot-reload)
 *   còn lại, server DEV              → 'reload'   (next dev tự biên dịch, F5 là đủ)
 *   còn lại, server PRODUCTION       → 'restart'  (đang phục vụ bản build cũ —
 *                                       khởi động lại để shell `next build` lại)
 */
function decideFollowUp(files: string[]): { followUp: FollowUp; reason: string } {
  const norm = files.map((f) => f.replace(/\\/g, '/'));

  const deps = norm.filter((f) => f === 'package.json' || f === 'package-lock.json');
  if (deps.length > 0) {
    return {
      followUp: 'install',
      reason: 'Danh sách thư viện đã đổi — cần cài lại rồi khởi động lại app.',
    };
  }

  const electron = norm.filter((f) => f.startsWith('electron/'));
  if (electron.length > 0) {
    return {
      followUp: 'restart',
      reason: 'Phần vỏ desktop đã đổi — cần khởi động lại app để nhận.',
    };
  }

  // `next start` (mặc định của desktop shell từ khi tối ưu RAM) phục vụ code
  // ĐÃ build — F5 vẫn là trang cũ. Khởi động lại thì shell thấy HEAD lệch
  // build-info và tự build lại trước khi start.
  if (process.env.NODE_ENV === 'production') {
    return {
      followUp: 'restart',
      reason: 'App đang chạy bản build — cần khởi động lại (tự build lại) để nhận giao diện mới.',
    };
  }

  return { followUp: 'reload', reason: 'Chỉ đổi phần giao diện — tải lại là xong.' };
}

/**
 * Kéo bản mới về.
 *
 * CHỈ fast-forward. Nhánh local đã đi lệch khỏi remote thì thà thất bại rõ
 * ràng còn hơn đẻ ra một commit merge lộn xộn ngay trong thư mục app — người
 * dùng bấm nút này để "lấy bản mới", không phải để hoà nhánh.
 *
 * @param stashFirst Người dùng đã chủ động bấm "Cất tạm rồi cập nhật".
 */
export async function pullUpdate(stashFirst = false): Promise<UpdateResult> {
  const before = await getStatus(true);

  if (!before.isRepo || !before.upstream) {
    throw new UpdateError(before.reason || 'Không cập nhật được.', 'NOT_REPO');
  }

  if (before.dirty) {
    if (!stashFirst) {
      throw new UpdateError(
        'Thư mục app đang có thay đổi chưa commit.',
        'DIRTY',
        before.dirtyFiles,
      );
    }
    // -u để gom cả file mới chưa add — bỏ sót chúng thì pull vẫn có thể đè lên.
    await git([
      'stash',
      'push',
      '-u',
      '-m',
      `devbox-selfupdate ${new Date().toISOString()}`,
    ]);
  }

  if (before.behind === 0) {
    return {
      updated: false,
      fromHead: before.head,
      toHead: before.head,
      count: 0,
      followUp: 'reload',
      followUpReason: 'Đang ở bản mới nhất.',
      stashed: stashFirst && before.dirty,
    };
  }

  try {
    await git(['merge', '--ff-only', before.upstream], {
      timeoutMs: NET_TIMEOUT_MS,
      withStderr: true,
    });
  } catch (err) {
    const msg = (err as Error).message;
    // --ff-only từ chối = hai nhánh đã rẽ đôi. Nói bằng tiếng người, vì đây là
    // ca duy nhất người dùng buộc phải tự xử lý bằng tab Git/terminal.
    if (/not possible to fast-forward|Not possible to fast-forward|divergent/i.test(msg)) {
      throw new UpdateError(
        `Nhánh "${before.branch}" ở máy đã đi khác với ${before.upstream} ` +
          `(${before.ahead} commit riêng). Cần xử lý tay ở tab Git rồi cập nhật lại.`,
        'DIVERGED',
      );
    }
    throw err;
  }

  const after = await git(['rev-parse', '--short', 'HEAD']);
  const toHead = after.trim();

  // Các file đã đổi giữa hai mốc → quyết định việc cần làm tiếp.
  const changed = lines(
    await git(['diff', '--name-only', `${before.head}..${toHead}`]),
  );
  const { followUp, reason } = decideFollowUp(changed);

  return {
    updated: true,
    fromHead: before.head,
    toHead,
    count: before.behind,
    followUp,
    followUpReason: reason,
    stashed: stashFirst && before.dirty,
  };
}
