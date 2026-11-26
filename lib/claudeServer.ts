// ClaudeAI — phía server: gọi Claude API (Messages) bằng SDK chính thức @anthropic-ai/sdk.
// Giao diện dùng chung với menu 🤖 OpenAI (components/OpenAiWorkspace.tsx, provider "claude");
// kho cấu hình + prompt mẫu: lib/llmProfiles.ts (configs/claude.json — CHỨA KHOÁ API, không lên git).
//
// Khác OpenAI, theo API hiện tại (anthropic-version 2026-10-21, SDK gửi sẵn):
//   · KHÔNG có temperature / top_p / top_k (gửi lên là 400 trên mọi model) — nút điều chỉnh là
//     `output_config.effort` (low … max; trống = mặc định của model).
//   · max_tokens BẮT BUỘC — trống thì CLAUDE_DEFAULT_MAX_TOKENS; luôn gọi dạng stream nên không lo
//     timeout HTTP.
//   · Không truyền `thinking`: model đời mới tự suy nghĩ (adaptive); phần suy nghĩ không hiện.
//   · Đếm token input bằng endpoint count_tokens của Anthropic (đúng tokenizer của model) — không
//     dùng tiktoken (đếm thiếu với Claude).
//   · Bị từ chối (stop_reason "refusal") → ghi chú rõ; với model đời mới có thể bật `fallbacks:
//     "default"` (beta server-side-fallback-2026-07-01) để API tự chạy lại trên model khác.
// Request chạy thành JOB ở server, trang hỏi tiến độ (poll) — như OpenAI / trợ lý AI.

import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import { createProfileStore, scrubKey as scrub, str, type StoredProfile } from './llmProfiles';
import type { TokenEstimate } from './openaiTokens';
import {
  CLAUDE_DEFAULT_BASE, CLAUDE_DEFAULT_MAX_TOKENS, CLAUDE_EFFORTS, OPENAI_LIMITS,
  type ClaudeEffort, type OpenAiFile, type OpenAiPoll, type OpenAiPreset, type OpenAiProfileInput,
  type OpenAiRequest, type OpenAiUsage,
} from './openai';

const store = createProfileStore({ file: 'claude.json', defaultBase: CLAUDE_DEFAULT_BASE, label: 'Claude' });
export const { profilesList, profileSave, profileRemove, profileSetDefault, presetsList, presetRemove } = store;

/** Một request chạy tối đa chừng này (model suy nghĩ lâu có thể mất vài phút). */
const RUN_TIMEOUT_MS = 10 * 60_000;
const LIST_TIMEOUT_MS = 20_000;
const COUNT_TIMEOUT_MS = 20_000;
const JOB_TTL_MS = 10 * 60_000;
const MAX_JOBS = 20;
/** Phiên bản API SDK đang gửi (để lệnh cURL khớp request thật). */
const API_VERSION = '2026-10-21';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function client(c: StoredProfile, timeout = RUN_TIMEOUT_MS): Anthropic {
  if (!c.apiKey) throw new Error(`Cấu hình "${c.name}" chưa có khoá API — bấm ⚙ nhập khoá.`);
  return new Anthropic({ apiKey: c.apiKey, baseURL: c.baseUrl || CLAUDE_DEFAULT_BASE, timeout, maxRetries: 2 });
}

/** Lỗi API → câu tiếng Việt, đã che khoá. Dùng lớp lỗi của SDK, không dò chữ. */
function friendly(e: unknown, key: string): Error {
  if (e instanceof Anthropic.AuthenticationError) return new Error(scrub(`HTTP 401 — khoá API sai hoặc đã bị thu hồi (${e.message})`, key));
  if (e instanceof Anthropic.PermissionDeniedError) return new Error(scrub(`HTTP 403 — khoá không có quyền dùng model / tính năng này (${e.message})`, key));
  if (e instanceof Anthropic.NotFoundError) return new Error(scrub(`HTTP 404 — không có model này hoặc base URL sai (${e.message})`, key));
  if (e instanceof Anthropic.RateLimitError) return new Error(scrub(`HTTP 429 — quá giới hạn tốc độ / hết hạn mức (${e.message})`, key));
  if (e instanceof Anthropic.BadRequestError) return new Error(scrub(`HTTP 400 — ${e.message}`, key));
  if (e instanceof Anthropic.APIError) return new Error(scrub(`HTTP ${e.status ?? '?'} — ${e.message}`, key));
  return new Error(scrub((e as Error)?.message || String(e), key));
}

/** Model hỗ trợ fallbacks "default" (bị từ chối thì API tự chạy lại trên model khác). */
function supportsFallback(model: string): boolean {
  return /^claude-(fable-5|mythos-5|opus-5|sonnet-5-5)/.test(model);
}
/** Beta fallback chỉ dùng khi gọi thẳng API của Anthropic (proxy / dịch vụ trung gian có thể không nhận). */
const official = (baseUrl: string) => /^https:\/\/api\.anthropic\.com\/?$/.test(baseUrl || CLAUDE_DEFAULT_BASE);

// ── Model ────────────────────────────────────────────────────────────────────

/** Danh sách model của tài khoản (Models API). `draft`: thử cấu hình chưa lưu. */
export async function listModels(profileId: unknown, draft?: unknown): Promise<string[]> {
  const c = await store.resolve(profileId, draft as OpenAiProfileInput | undefined);
  const cl = client(c, LIST_TIMEOUT_MS);
  const ids: string[] = [];
  try {
    for await (const m of cl.models.list()) ids.push(m.id); // tự sang trang
  } catch (e) { throw friendly(e, c.apiKey); }
  return ids;
}

// ── Request ──────────────────────────────────────────────────────────────────

function normFiles(input: unknown): OpenAiFile[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error('files phải là danh sách.');
  if (input.length > OPENAI_LIMITS.maxFiles) throw new Error(`Tối đa ${OPENAI_LIMITS.maxFiles} file mỗi request.`);
  let total = 0;
  return input.map((f, i) => {
    const o = (f ?? {}) as { name?: unknown; text?: unknown };
    const name = str(o.name, 200) || `file-${i + 1}`;
    const text = typeof o.text === 'string' ? o.text : '';
    if (!text.trim()) throw new Error(`${name}: không có nội dung.`);
    if (text.length > OPENAI_LIMITS.fileChars) throw new Error(`${name}: dài quá ${OPENAI_LIMITS.fileChars} ký tự.`);
    total += text.length;
    if (total > OPENAI_LIMITS.filesTotalChars) throw new Error(`Các file cộng lại dài quá ${OPENAI_LIMITS.filesTotalChars} ký tự — bớt file.`);
    return { name: name.replace(/[\r\n<>"]/g, ' '), text };
  });
}

function normRequest(input: unknown, fallbackModel: string): OpenAiRequest {
  const b = (input ?? {}) as Record<string, unknown>;
  const prompt = typeof b.prompt === 'string' ? b.prompt : '';
  const system = typeof b.system === 'string' ? b.system : '';
  if (!prompt.trim()) throw new Error('Thiếu prompt.');
  if (prompt.length > OPENAI_LIMITS.promptChars) throw new Error(`Prompt dài quá ${OPENAI_LIMITS.promptChars} ký tự.`);
  if (system.length > OPENAI_LIMITS.systemChars) throw new Error(`Định hướng dài quá ${OPENAI_LIMITS.systemChars} ký tự.`);
  const model = str(b.model, 200) || fallbackModel;
  if (!model) throw new Error('Chưa chọn model (hoặc đặt model mặc định cho cấu hình).');
  const mt = b.maxTokens === null || b.maxTokens === '' || b.maxTokens === undefined ? null : Number(b.maxTokens);
  if (mt !== null && !(Number.isInteger(mt) && mt > 0 && mt <= OPENAI_LIMITS.maxTokens)) {
    throw new Error(`Max tokens phải là số nguyên 1…${OPENAI_LIMITS.maxTokens}.`);
  }
  const effort = CLAUDE_EFFORTS.includes(b.effort as ClaudeEffort) ? (b.effort as ClaudeEffort) : '';
  return {
    profileId: str(b.profileId, 100), model, system, prompt, temperature: null, maxTokens: mt, format: 'text',
    files: normFiles(b.files), effort, fallback: b.fallback !== false,
  };
}

/** Prompt rồi từng file trong một khối có tên — như menu OpenAI. */
function userContent(req: OpenAiRequest): string {
  if (!req.files?.length) return req.prompt;
  const blocks = req.files.map((f) => `<file name="${f.name}">\n${f.text}\n</file>`);
  return `${req.prompt}\n\n${req.files.length === 1 ? 'Nội dung file đính kèm' : `Nội dung ${req.files.length} file đính kèm`}:\n\n${blocks.join('\n\n')}`;
}

/** Tham số Messages — DÙNG CHUNG cho request thật, đếm token và lệnh cURL. */
function messageParams(req: OpenAiRequest) {
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? CLAUDE_DEFAULT_MAX_TOKENS,
    ...(req.system.trim() ? { system: req.system } : {}),
    messages: [{ role: 'user' as const, content: userContent(req) }],
    ...(req.effort ? { output_config: { effort: req.effort } } : {}),
  };
}

const useFallback = (req: OpenAiRequest, c: StoredProfile) => !!req.fallback && supportsFallback(req.model) && official(c.baseUrl);

// ── Job ──────────────────────────────────────────────────────────────────────

interface Job {
  id: string;
  text: string;
  done: boolean;
  error: string | null;
  model: string | null;
  usage: OpenAiUsage | null;
  finishReason: string | null;
  notice: string | null;
  started: number;
  ended: number | null;
  ac: AbortController;
}

const g = globalThis as unknown as { __claudeJobs?: Map<string, Job> };
const jobs = (g.__claudeJobs ??= new Map<string, Job>());

function sweep(): void {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.ended && now - j.ended > JOB_TTL_MS) jobs.delete(id);
}

export async function start(input: unknown): Promise<{ id: string }> {
  sweep();
  if ([...jobs.values()].filter((j) => !j.done).length >= MAX_JOBS) throw new Error('Đang có quá nhiều request chạy — chờ bớt rồi gửi lại.');
  const s = await store.readStore();
  const c = store.pick(s, (input as { profileId?: unknown } | null)?.profileId);
  const req = normRequest(input, c.defaultModel);
  const cl = client(c);
  const job: Job = {
    id: randomUUID(), text: '', done: false, error: null, model: null, usage: null, finishReason: null, notice: null,
    started: Date.now(), ended: null, ac: new AbortController(),
  };
  jobs.set(job.id, job);
  void run(job, c, cl, req);
  return { id: job.id };
}

async function run(job: Job, c: StoredProfile, cl: Anthropic, req: OpenAiRequest): Promise<void> {
  const timer = setTimeout(() => job.ac.abort(new Error('timeout')), RUN_TIMEOUT_MS);
  try {
    const params = messageParams(req);
    const opts = { signal: job.ac.signal };
    const fb = useFallback(req, c);
    // Có fallback: endpoint beta + fallbacks "default" (API tự chọn model dự phòng theo loại từ chối).
    const onText = (delta: string) => { job.text += delta; };
    const msg = fb
      ? await cl.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, opts).on('text', onText).finalMessage()
      : await cl.messages.stream(params, opts).on('text', onText).finalMessage();
    job.model = msg.model;
    job.finishReason = msg.stop_reason ?? null;
    const u = msg.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    job.usage = {
      // input_tokens của Claude KHÔNG gồm phần cache → cộng lại để ra tổng input.
      promptTokens: u.input_tokens + cacheRead + cacheWrite,
      completionTokens: u.output_tokens,
      totalTokens: u.input_tokens + cacheRead + cacheWrite + u.output_tokens,
      cachedTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    };
    if (msg.stop_reason === 'refusal') {
      const d = msg.stop_details;
      job.notice = `Claude từ chối trả lời${d?.category ? ` (loại: ${d.category})` : ''}${d?.explanation ? ` — ${d.explanation}` : ''}.`;
    } else if (msg.model !== req.model) {
      job.notice = `Model ${req.model} từ chối — đã tự chuyển sang ${msg.model} (fallback).`;
    }
  } catch (e) {
    const reason = job.ac.signal.reason as Error | undefined;
    job.error = reason?.message === 'stopped' ? 'Đã dừng.'
      : reason?.message === 'timeout' ? `Quá ${RUN_TIMEOUT_MS / 60_000} phút không xong — đã dừng.`
        : friendly(e, c.apiKey).message;
  } finally {
    clearTimeout(timer);
    job.done = true;
    job.ended = Date.now();
  }
}

export function poll(id: unknown, from: unknown): OpenAiPoll {
  const job = jobs.get(String(id));
  if (!job) throw new Error('Request không còn (server khởi động lại?) — gửi lại.');
  const off = Math.max(0, Number(from) || 0);
  return {
    text: job.text.slice(off),
    next: job.text.length,
    done: job.done,
    error: job.error,
    model: job.model,
    usage: job.usage,
    finishReason: job.finishReason,
    notice: job.notice,
    durationMs: (job.ended ?? Date.now()) - job.started,
  };
}

export function stop(id: unknown): void {
  const job = jobs.get(String(id));
  if (job && !job.done) job.ac.abort(new Error('stopped'));
}

// ── Token, cURL ──────────────────────────────────────────────────────────────

/** Token input THẬT của request đang soạn (endpoint count_tokens — miễn phí, đúng tokenizer của model). */
export async function estimateTokens(input: unknown): Promise<TokenEstimate | { tokens: number; encoding: string; exact: boolean }> {
  const s = await store.readStore();
  const c = store.pick(s, (input as { profileId?: unknown } | null)?.profileId);
  const req = normRequest(input, c.defaultModel);
  const { model, system, messages } = messageParams(req);
  try {
    const r = await client(c, COUNT_TIMEOUT_MS).messages.countTokens({ model, messages, ...(system ? { system } : {}) });
    return { tokens: r.input_tokens, encoding: 'Anthropic count_tokens', exact: true };
  } catch (e) { throw friendly(e, c.apiKey); }
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Lệnh cURL tương đương (stream:false; khoá là $ANTHROPIC_API_KEY trừ khi chọn kèm khoá thật). */
export async function copyCurl(input: unknown, withKey: unknown): Promise<{ curl: string; hasKey: boolean }> {
  const s = await store.readStore();
  const c = store.pick(s, (input as { profileId?: unknown } | null)?.profileId);
  const req = normRequest(input, c.defaultModel);
  const fb = useFallback(req, c);
  const body = { ...messageParams(req), stream: false, ...(fb ? { fallbacks: 'default' } : {}) };
  const real = withKey === true && !!c.apiKey;
  const lines = [
    `curl ${shq(`${(c.baseUrl || CLAUDE_DEFAULT_BASE).replace(/\/+$/, '')}/v1/messages`)}`,
    real ? `-H ${shq(`x-api-key: ${c.apiKey}`)}` : `-H "x-api-key: $ANTHROPIC_API_KEY"`,
    `-H ${shq(`anthropic-version: ${API_VERSION}`)}`,
    ...(fb ? [`-H ${shq(`anthropic-beta: ${FALLBACK_BETA}`)}`] : []),
    `-H ${shq('content-type: application/json')}`,
    `-d ${shq(JSON.stringify(body, null, 2))}`,
  ];
  return { curl: lines.join(' \\\n  '), hasKey: real };
}

// ── Prompt mẫu ───────────────────────────────────────────────────────────────

export async function presetSave(input: unknown): Promise<OpenAiPreset[]> {
  const b = (input ?? {}) as Record<string, unknown>;
  const name = str(b.name, 120);
  if (!name) throw new Error('Đặt tên cho prompt mẫu.');
  const req = normRequest({ ...b, prompt: typeof b.prompt === 'string' && b.prompt.trim() ? b.prompt : '.', model: str(b.model, 200) || '-' }, '-');
  return store.presetUpsert({
    id: typeof b.id === 'string' && b.id ? b.id : undefined,
    name,
    profileId: req.profileId,
    model: str(b.model, 200),
    system: req.system,
    prompt: typeof b.prompt === 'string' ? b.prompt.slice(0, OPENAI_LIMITS.promptChars) : '',
    temperature: null,
    maxTokens: req.maxTokens,
    format: 'text',
    effort: req.effort,
    fallback: req.fallback,
  });
}
