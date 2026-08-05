// Server-only: HÀNG ĐỢI JOB chuyển đổi file (tab Tools).
//
// Người dùng chọn nơi lưu TRƯỚC rồi bấm Chuyển — job chạy ngầm, UI không phải
// đứng đợi. Xong thì ConvertHost (client) poll thấy và bắn thông báo kèm đường
// dẫn file kết quả.
//
// Cùng khuôn singleton-trên-globalThis của workWatch/gitAutoPull, nhưng ở đây
// không có timer: job do request khởi động, chạy tới đâu cập nhật state tới đó.
//
// Ca PDF cần renderer: server dựng xong HTML thì job dừng ở 'need-render' và
// đợi client (Electron printToPDF) gửi bytes về qua finishRender(). Next server
// là process riêng, không gọi thẳng Electron được.

import path from 'path';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import {
  convertWithLib, runAiConvert, TARGET_EXT, MAX_INPUT_BYTES,
  type TargetFormat,
} from './convertCore';
import { writeNewFile } from './officeFiles';

export type JobStatus = 'running' | 'need-render' | 'done' | 'error';

export interface ConvertJob {
  id: string;
  srcAbs: string;
  srcName: string;
  outAbs: string;
  outName: string;
  target: TargetFormat;
  useAi: boolean;
  templateAbs: string | null;
  status: JobStatus;
  /** Mô tả bước đang chạy — UI hiện trên dòng job. */
  step: string;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** HTML chờ renderer in PDF (chỉ khi status = 'need-render'). */
  pendingHtml: string | null;
  /** Tăng khi job đổi trạng thái — client diff để biết có gì mới. */
  seq: number;
}

interface Store {
  jobs: ConvertJob[];
  seq: number;
}

const JOB_CAP = 40;

const g = globalThis as typeof globalThis & { __convertJobs?: Store };

function store(): Store {
  if (!g.__convertJobs) g.__convertJobs = { jobs: [], seq: 0 };
  return g.__convertJobs;
}

function bump(job: ConvertJob, patch: Partial<ConvertJob>): void {
  const s = store();
  s.seq += 1;
  Object.assign(job, patch, { seq: s.seq });
}

/** Snapshot cho client poll — bỏ pendingHtml (nặng) trừ job đang cần render. */
export function listJobs(): (Omit<ConvertJob, 'pendingHtml'> & { needsHtml: boolean })[] {
  return store().jobs.map(({ pendingHtml, ...j }) => ({ ...j, needsHtml: pendingHtml !== null }));
}

export function getJob(id: string): ConvertJob | null {
  return store().jobs.find((j) => j.id === id) ?? null;
}

/** HTML để renderer in PDF; đọc xong client gọi finishRender. */
export function takeRenderHtml(id: string): string {
  const job = getJob(id);
  if (!job || job.status !== 'need-render' || !job.pendingHtml) {
    throw new Error('Job không ở trạng thái chờ render.');
  }
  return job.pendingHtml;
}

/**
 * Tên file đích: giữ tên gốc, đổi đuôi. Trùng tên thì thêm ' (2)', ' (3)'…
 * thay vì đè — cùng tinh thần writeNewFile (không bao giờ ghi đè file có sẵn).
 */
async function pickOutPath(dir: string, srcAbs: string, target: TargetFormat): Promise<string> {
  const stem = path.basename(srcAbs, path.extname(srcAbs));
  const ext = TARGET_EXT[target];
  let candidate = path.join(dir, stem + ext);
  for (let n = 2; n < 100; n++) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${stem} (${n})${ext}`);
    } catch {
      return candidate; // không tồn tại → dùng được
    }
  }
  throw new Error('Quá nhiều file trùng tên trong thư mục đích.');
}

/** Validate input rồi tạo job và chạy ngầm. Trả job đã khởi tạo (chưa xong). */
export async function startJob(input: {
  srcPath: unknown;
  target: unknown;
  outDir?: unknown;
  useAi?: unknown;
  templatePath?: unknown;
}): Promise<ConvertJob> {
  const srcAbs = path.resolve(String(input.srcPath ?? '').trim());
  if (!srcAbs) throw new Error('Chưa chọn file nguồn.');
  const st = await fs.stat(srcAbs).catch(() => null);
  if (!st?.isFile()) throw new Error(`Không đọc được file nguồn: ${srcAbs}`);
  if (st.size > MAX_INPUT_BYTES) {
    throw new Error(`File quá lớn (${(st.size / 1048576).toFixed(1)} MB > ${MAX_INPUT_BYTES / 1048576} MB).`);
  }

  const target = String(input.target ?? '') as TargetFormat;
  if (!TARGET_EXT[target]) throw new Error('Chưa chọn định dạng đích hợp lệ.');

  // Nơi lưu là TÙY CHỌN — không chọn thì mặc định cùng thư mục file nguồn.
  const rawDir = String(input.outDir ?? '').trim();
  const outDir = rawDir ? path.resolve(rawDir) : path.dirname(srcAbs);
  const dirSt = await fs.stat(outDir).catch(() => null);
  if (!dirSt?.isDirectory()) throw new Error(`Thư mục lưu không tồn tại: ${outDir}`);

  const rawTpl = String(input.templatePath ?? '').trim();
  let templateAbs: string | null = null;
  if (rawTpl) {
    templateAbs = path.resolve(rawTpl);
    const tSt = await fs.stat(templateAbs).catch(() => null);
    if (!tSt?.isFile()) throw new Error(`Không đọc được file template: ${templateAbs}`);
  }
  // Có template thì bắt buộc đi đường AI — template chỉ có nghĩa khi AI đọc để
  // bắt chước bố cục; thư viện không làm được việc đó.
  const useAi = templateAbs !== null || input.useAi === true;

  const outAbs = await pickOutPath(outDir, srcAbs, target);

  const s = store();
  s.seq += 1;
  const job: ConvertJob = {
    id: randomUUID(),
    srcAbs,
    srcName: path.basename(srcAbs),
    outAbs,
    outName: path.basename(outAbs),
    target,
    useAi,
    templateAbs,
    status: 'running',
    step: useAi ? 'Đang gọi AI…' : 'Đang chuyển đổi…',
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    pendingHtml: null,
    seq: s.seq,
  };
  s.jobs = [job, ...s.jobs].slice(0, JOB_CAP);

  void run(job); // chạy ngầm — KHÔNG await, request trả về ngay
  return job;
}

/**
 * Diễn giải LÝ DO THẬT khi AI không ra file, thay vì chỉ báo "không thấy file".
 * Lỗi hạ tầng (quá tải, hết quota, chưa đăng nhập) mới là thứ người dùng cần
 * biết — và với những lỗi đó thì cứ chạy lại/đổi sang thư viện là xong.
 */
export function aiFailMessage(output: string, exitCode: number): string {
  const text = output.trim();
  const low = text.toLowerCase();

  if (/\b529\b|overloaded/.test(low)) {
    return 'AI đang quá tải (lỗi 529 từ máy chủ Claude) nên chưa tạo được file. '
      + 'Thử lại sau ít phút, hoặc bỏ chọn "Dùng AI" để chuyển bằng thư viện.';
  }
  if (/\b401\b|unauthorized|not logged in|please run .?claude login/.test(low)) {
    return 'CLI `claude` chưa đăng nhập trên máy này. Mở terminal chạy `claude` để đăng nhập rồi thử lại.';
  }
  if (/\b429\b|rate limit|quota|usage limit/.test(low)) {
    return 'Tài khoản Claude đã chạm giới hạn sử dụng. Đợi hạn mức đặt lại, hoặc dùng thư viện thay cho AI.';
  }
  if (/\b5\d\d\b|api error|econnreset|etimedout|enotfound|network/.test(low)) {
    return `Gọi AI thất bại do lỗi mạng/máy chủ.\n${tailOf(text)}`;
  }
  if (/quá 15 phút/.test(text)) {
    return 'AI chạy quá 15 phút nên bị hủy. File lớn thì nên dùng thư viện, hoặc chia nhỏ nội dung.';
  }
  return `AI kết thúc (exit ${exitCode}) nhưng không tạo ra file kết quả.\n${tailOf(text)}`;
}

function tailOf(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim());
  return lines.slice(-10).join('\n') || '(AI không in ra thông tin gì)';
}

/**
 * AI ghi file nhưng lệch tên/đuôi → tìm file được tạo SAU khi job bắt đầu trong
 * thư mục đích (không đệ quy sâu, chỉ 1 cấp), bỏ qua chính file nguồn/template.
 * Trả đường dẫn ứng viên mới nhất, hoặc null.
 */
async function findFreshOutput(job: ConvertJob): Promise<string | null> {
  const dir = path.dirname(job.outAbs);
  const skip = new Set([job.srcAbs, job.templateAbs].filter(Boolean) as string[]);
  let best: { abs: string; mtime: number } | null = null;
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const abs = path.join(dir, name);
    if (skip.has(abs)) continue;
    const st = await fs.stat(abs).catch(() => null);
    if (!st?.isFile() || st.size === 0) continue;
    // Chỉ nhận file sinh ra trong lúc job chạy (trừ hao 2s cho lệch đồng hồ).
    if (st.mtimeMs < job.startedAt - 2000) continue;
    if (!best || st.mtimeMs > best.mtime) best = { abs, mtime: st.mtimeMs };
  }
  return best?.abs ?? null;
}

/** Lỗi hạ tầng tạm thời — chạy lại có cơ hội thành công. */
function isTransient(output: string): boolean {
  return /\b529\b|overloaded|\b503\b|\b502\b|econnreset|etimedout/i.test(output);
}

const AI_RETRIES = 2;
const RETRY_WAIT_MS = 20_000;

async function run(job: ConvertJob): Promise<void> {
  try {
    if (job.useAi) {
      // Máy chủ AI quá tải (529) là chuyện hay gặp và tự hết — thử lại vài lần
      // thay vì bắt người dùng bấm lại từ đầu. Job vốn đã chạy ngầm nên chờ
      // thêm chút không phiền ai.
      let output = '';
      let exitCode = 1;
      for (let attempt = 1; attempt <= AI_RETRIES + 1; attempt++) {
        if (attempt > 1) {
          bump(job, { step: `AI quá tải — thử lại lần ${attempt}/${AI_RETRIES + 1}…` });
          await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
        }
        ({ output, exitCode } = await runAiConvert({
          srcAbs: job.srcAbs,
          outAbs: job.outAbs,
          target: job.target,
          templateAbs: job.templateAbs,
        }));
        if (exitCode === 0 || !isTransient(output)) break;
      }
      // AI tự ghi file — xác nhận nó thực sự tồn tại, đừng tin exit code suông.
      let ok = await fs.stat(job.outAbs).then((s) => s.isFile()).catch(() => false);
      if (!ok) {
        // AI hay ghi đúng nội dung nhưng lệch tên/đuôi (people.markdown thay vì
        // people.md, hoặc ghi vào thư mục con). Dò một vòng thư mục đích tìm file
        // mới sinh ra rồi đổi tên về đúng đích, thay vì bắt người dùng làm lại.
        const found = await findFreshOutput(job);
        if (found) {
          await fs.rename(found, job.outAbs).catch(() => {});
          ok = await fs.stat(job.outAbs).then((s) => s.isFile()).catch(() => false);
        }
      }
      if (!ok) throw new Error(aiFailMessage(output, exitCode));
      bump(job, { status: 'done', step: 'Xong (AI)', finishedAt: Date.now() });
      return;
    }

    const res = await convertWithLib(job.srcAbs, path.extname(job.srcAbs).toLowerCase(), job.target);
    if (res.kind === 'need-render') {
      // Chuyển sang chờ renderer in PDF.
      bump(job, { status: 'need-render', step: 'Đang tạo PDF…', pendingHtml: res.html });
      return;
    }
    await writeNewFile(job.outAbs, res.data);
    bump(job, { status: 'done', step: 'Xong', finishedAt: Date.now() });
  } catch (err) {
    bump(job, {
      status: 'error',
      step: 'Lỗi',
      error: (err as Error).message,
      finishedAt: Date.now(),
      pendingHtml: null,
    });
  }
}

/** Renderer đã in xong PDF → ghi bytes ra file, chốt job. */
export async function finishRender(id: unknown, base64: unknown): Promise<ConvertJob> {
  const job = getJob(String(id ?? ''));
  if (!job) throw new Error('Không tìm thấy job.');
  if (job.status !== 'need-render') throw new Error('Job không ở trạng thái chờ render.');
  try {
    const data = Buffer.from(String(base64 ?? ''), 'base64');
    if (data.length === 0) throw new Error('Dữ liệu PDF rỗng.');
    await writeNewFile(job.outAbs, data);
    bump(job, { status: 'done', step: 'Xong (PDF)', finishedAt: Date.now(), pendingHtml: null });
  } catch (err) {
    bump(job, {
      status: 'error', step: 'Lỗi', error: (err as Error).message,
      finishedAt: Date.now(), pendingHtml: null,
    });
  }
  return job;
}

/** Renderer không in được (bản web thuần, không có Electron) → báo lỗi rõ. */
export function failRender(id: unknown, reason: unknown): void {
  const job = getJob(String(id ?? ''));
  if (!job || job.status !== 'need-render') return;
  bump(job, {
    status: 'error',
    step: 'Lỗi',
    error: String(reason ?? 'Không tạo được PDF.'),
    finishedAt: Date.now(),
    pendingHtml: null,
  });
}

/** Dọn các job đã kết thúc khỏi danh sách. */
export function clearFinished(): void {
  const s = store();
  s.jobs = s.jobs.filter((j) => j.status === 'running' || j.status === 'need-render');
}
