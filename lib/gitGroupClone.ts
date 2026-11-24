// Server-only job "clone hàng loạt" cho màn Clone cả group.
//
// VÌ SAO LÀ JOB CHẠY NỀN chứ không phải một request cho mỗi repo:
//   - Cầu desktopApi (electron/main.cjs) cắt request ở 120s; clone repo lớn lâu hơn.
//   - fetch trần từ renderer thì dính pool 6 socket tới localhost — đang mở vài
//     terminal SSE là request clone xếp hàng vô hạn.
// Nên: một request ngắn KHỞI ĐỘNG job, server tự clone lần lượt, UI hỏi tiến độ
// bằng các request ngắn. Đóng hộp thoại giữa chừng job vẫn chạy tiếp.
//
// Trạng thái nằm trong bộ nhớ tiến trình (gắn vào globalThis để sống qua HMR của
// Next dev). Mất khi khởi động lại app — chấp nhận được: repo nào clone xong đã
// nằm trên đĩa, quét lại sẽ thấy "đã có".

import { randomUUID } from 'crypto';
import { cloneRepo, isSelfRepo } from './gitCore';
import { validateRoot } from './gitProjects';

/** Số repo clone song song. Thấp có chủ ý: máy hay thiếu RAM, và GitLab tự host
 *  dễ từ chối khi bị mở quá nhiều kết nối cùng lúc. */
const CONCURRENCY = 3;
const MAX_ITEMS = 2000;
const JOB_TTL_MS = 60 * 60_000;

export type CloneItemState = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

export interface CloneJobItem {
  /** Khoá do client đặt (id project GitLab) để ghép lại với dòng trên UI. */
  key: string;
  name: string;
  state: CloneItemState;
  /** Lỗi (state=error) hoặc ghi chú (vd đã lùi về branch mặc định). */
  message: string;
  /** Đường dẫn repo sau khi clone xong. */
  path: string;
}

export interface CloneJob {
  id: string;
  parent: string;
  branch: string;
  items: CloneJobItem[];
  finished: boolean;
  cancelled: boolean;
  startedAt: number;
  finishedAt: number;
}

interface JobInternal extends CloneJob {
  urls: string[];
  fallbackDefault: boolean;
}

const g = globalThis as unknown as { __devboxGroupCloneJobs?: Map<string, JobInternal> };
const jobs: Map<string, JobInternal> = (g.__devboxGroupCloneJobs ??= new Map());

function publicView(j: JobInternal): CloneJob {
  return {
    id: j.id,
    parent: j.parent,
    branch: j.branch,
    items: j.items,
    finished: j.finished,
    cancelled: j.cancelled,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
  };
}

async function cloneOne(job: JobInternal, i: number): Promise<void> {
  const item = job.items[i];
  item.state = 'running';
  try {
    let res;
    try {
      res = await cloneRepo(job.parent, job.urls[i], item.name, job.branch);
    } catch (e) {
      // Repo không có branch yêu cầu → (nếu được phép) lấy branch mặc định. git
      // tự dọn thư mục đích khi clone hỏng nên clone lại ngay được.
      const msg = (e as Error).message || '';
      if (!job.branch || !job.fallbackDefault || !/Remote branch .* not found|Could not find remote branch/i.test(msg)) throw e;
      res = await cloneRepo(job.parent, job.urls[i], item.name, '');
      item.message = `không có branch "${job.branch}" → dùng branch mặc định`;
    }
    item.path = res.path;
    item.state = 'done';
  } catch (e) {
    item.state = 'error';
    item.message = (e as Error).message || 'clone thất bại';
  }
}

async function runJob(job: JobInternal): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= job.items.length) return;
      if (job.cancelled) {
        job.items[i].state = 'cancelled';
        continue;
      }
      await cloneOne(job, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, job.items.length) }, worker));
  job.finished = true;
  job.finishedAt = Date.now();
}

export interface StartCloneInput {
  parent: unknown;
  /** [{ key, url, name }] — name là tên thư mục đích (validate ở cloneRepo). */
  items: unknown;
  branch?: unknown;
  /** Mặc định true: repo thiếu branch yêu cầu thì lấy branch mặc định. */
  fallbackDefault?: unknown;
}

export async function startCloneJob(input: StartCloneInput): Promise<CloneJob> {
  const parent = await validateRoot(input.parent);
  if (await isSelfRepo(parent)) {
    throw new Error(`${parent} chính là một repo git — chọn thư mục cha khác để chứa các repo.`);
  }
  const raw = Array.isArray(input.items) ? input.items : [];
  if (!raw.length) throw new Error('chưa chọn repo nào');
  if (raw.length > MAX_ITEMS) throw new Error(`tối đa ${MAX_ITEMS} repo mỗi lần`);

  const items: CloneJobItem[] = [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const r of raw as Array<Record<string, unknown>>) {
    const url = typeof r?.url === 'string' ? r.url.trim() : '';
    const name = typeof r?.name === 'string' ? r.name.trim() : '';
    const key = typeof r?.key === 'string' || typeof r?.key === 'number' ? String(r.key) : name;
    if (!url || !name) throw new Error('mỗi repo cần url và tên thư mục');
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw new Error(`trùng tên thư mục đích: ${name}`);
    seen.add(lower);
    items.push({ key, name, state: 'pending', message: '', path: '' });
    urls.push(url);
  }

  // Dọn job cũ đã xong để Map không phình mãi.
  const now = Date.now();
  for (const [id, j] of jobs) if (j.finished && now - j.finishedAt > JOB_TTL_MS) jobs.delete(id);

  const job: JobInternal = {
    id: randomUUID(),
    parent,
    branch: typeof input.branch === 'string' ? input.branch.trim() : '',
    items,
    urls,
    fallbackDefault: input.fallbackDefault !== false,
    finished: false,
    cancelled: false,
    startedAt: now,
    finishedAt: 0,
  };
  jobs.set(job.id, job);
  // Không await: job chạy nền, request trả về ngay.
  void runJob(job).catch(() => {
    job.finished = true;
    job.finishedAt = Date.now();
  });
  return publicView(job);
}

export function getCloneJob(id: unknown): CloneJob {
  const j = typeof id === 'string' ? jobs.get(id) : undefined;
  if (!j) throw new Error('không tìm thấy job clone (app vừa khởi động lại?) — quét lại để xem repo nào đã về.');
  return publicView(j);
}

/** Dừng: repo đang clone dở chạy nốt, các repo còn chờ bị bỏ. */
export function cancelCloneJob(id: unknown): CloneJob {
  const j = typeof id === 'string' ? jobs.get(id) : undefined;
  if (!j) throw new Error('không tìm thấy job clone');
  j.cancelled = true;
  return publicView(j);
}
