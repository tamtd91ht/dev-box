// OpenAI — phía server: kho cấu hình (nhiều cấu hình) + prompt mẫu, gọi API, job chạy nền.
// Kiểu dữ liệu: lib/openai.ts. Route: /api/openai.
//
// Kho: configs/openai.json (per-machine; cả thư mục configs/ không lên git —
// file này CHỨA KHOÁ API). Lưu được NHIỀU cấu hình (khoá công ty / cá nhân /
// dịch vụ tương thích…); request chọn cấu hình theo id. Khoá không bao giờ trả
// về trang, không ghi log, và bị che trong mọi thông báo lỗi.
//
// Gọi Chat Completions dạng stream (SSE) bằng fetch của Node — không CORS, khoá
// không nằm trong trang. Trang không giữ một kết nối dài (cầu apiFetch của bản
// desktop có hạn thời gian, trình duyệt giới hạn 6 socket): request chạy thành
// JOB ở server, trang hỏi tiến độ (poll) như trợ lý AI (lib/aiChatServer.ts).

import { randomUUID } from 'crypto';
import { createProfileStore, scrubKey as scrub, str, type StoredProfile } from './llmProfiles';
import { countChatTokens, type TokenEstimate } from './openaiTokens';
import {
  OPENAI_DEFAULT_BASE, OPENAI_LIMITS, isChatModel,
  type OpenAiFile, type OpenAiFormat, type OpenAiPoll, type OpenAiPreset, type OpenAiProfileInput,
  type OpenAiRequest, type OpenAiUsage,
} from './openai';

/** Kho cấu hình + prompt mẫu (dùng chung với ClaudeAI — lib/llmProfiles.ts). */
const store = createProfileStore({ file: 'openai.json', defaultBase: OPENAI_DEFAULT_BASE, label: 'OpenAI' });
export const { profilesList, profileSave, profileRemove, profileSetDefault, presetsList, presetRemove } = store;
const readStore = store.readStore;
const pick = store.pick;

/** Một request chạy tối đa chừng này (model suy luận lâu có thể mất vài phút). */
const RUN_TIMEOUT_MS = 10 * 60_000;
const LIST_TIMEOUT_MS = 20_000;
/** Job đã xong được giữ chừng này để trang kịp đọc nốt. */
const JOB_TTL_MS = 10 * 60_000;
const MAX_JOBS = 20;

// ── Gọi API ──────────────────────────────────────────────────────────────────

function headers(c: StoredProfile): Record<string, string> {
  if (!c.apiKey) throw new Error(`Cấu hình "${c.name}" chưa có khoá API — vào tab Cấu hình nhập khoá.`);
  const h: Record<string, string> = { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' };
  if (c.organization) h['OpenAI-Organization'] = c.organization;
  if (c.project) h['OpenAI-Project'] = c.project;
  return h;
}

async function apiError(r: Response, key: string): Promise<Error> {
  let msg = `HTTP ${r.status}`;
  try {
    const body = (await r.json()) as { error?: { message?: string } | string };
    const e = body.error;
    const m = typeof e === 'string' ? e : e?.message;
    if (m) msg = `${msg} — ${m}`;
  } catch { /* không phải JSON */ }
  if (r.status === 401) msg += ' (khoá API sai hoặc đã bị thu hồi)';
  if (r.status === 429) msg += ' (hết hạn mức / quá nhiều request — xem billing của tài khoản OpenAI)';
  return new Error(scrub(msg, key));
}

/** Danh sách model dùng được cho chat của một cấu hình. `draft`: thử cấu hình chưa lưu
 *  (có `id` = đè lên cấu hình đó; không có = cấu hình mới chưa lưu). */
export async function listModels(profileId: unknown, draft?: unknown): Promise<string[]> {
  const c = await store.resolve(profileId, draft as OpenAiProfileInput | undefined);
  const r = await fetch(`${c.baseUrl}/models`, { headers: headers(c), signal: AbortSignal.timeout(LIST_TIMEOUT_MS) })
    .catch((e: Error) => { throw new Error(scrub(`Không gọi được ${c.baseUrl}/models: ${e.message}`, c.apiKey)); });
  if (!r.ok) throw await apiError(r, c.apiKey);
  const body = (await r.json().catch(() => ({}))) as { data?: { id?: unknown }[] };
  const ids = (body.data ?? []).map((m) => (typeof m.id === 'string' ? m.id : '')).filter(Boolean);
  return ids.filter(isChatModel).sort();
}

// ── Job ──────────────────────────────────────────────────────────────────────

interface Job {
  id: string;
  text: string;
  done: boolean;
  error: string | null;
  model: string | null;
  usage: OpenAiUsage | null;
  finishReason: string | null;
  started: number;
  ended: number | null;
  ac: AbortController;
}

const g = globalThis as unknown as { __openaiJobs?: Map<string, Job> };
const jobs = (g.__openaiJobs ??= new Map<string, Job>());

function sweep(): void {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.ended && now - j.ended > JOB_TTL_MS) jobs.delete(id);
}

function normRequest(input: unknown, fallbackModel: string): OpenAiRequest {
  const b = (input ?? {}) as Record<string, unknown>;
  const prompt = typeof b.prompt === 'string' ? b.prompt : '';
  const system = typeof b.system === 'string' ? b.system : '';
  if (!prompt.trim()) throw new Error('Thiếu prompt.');
  if (prompt.length > OPENAI_LIMITS.promptChars) throw new Error(`Prompt dài quá ${OPENAI_LIMITS.promptChars} ký tự.`);
  if (system.length > OPENAI_LIMITS.systemChars) throw new Error(`Định hướng dài quá ${OPENAI_LIMITS.systemChars} ký tự.`);
  const model = str(b.model, 200) || fallbackModel;
  if (!model) throw new Error('Chưa chọn model (hoặc đặt model mặc định cho cấu hình ở tab Cấu hình).');
  const t = b.temperature === null || b.temperature === '' || b.temperature === undefined ? null : Number(b.temperature);
  if (t !== null && !(Number.isFinite(t) && t >= 0 && t <= 2)) throw new Error('Temperature phải từ 0 đến 2.');
  const mt = b.maxTokens === null || b.maxTokens === '' || b.maxTokens === undefined ? null : Number(b.maxTokens);
  if (mt !== null && !(Number.isInteger(mt) && mt > 0 && mt <= OPENAI_LIMITS.maxTokens)) {
    throw new Error(`Max tokens phải là số nguyên 1…${OPENAI_LIMITS.maxTokens}.`);
  }
  const format: OpenAiFormat = b.format === 'json' ? 'json' : 'text';
  const files = normFiles(b.files);
  return { profileId: str(b.profileId, 100), model, system, prompt, temperature: t, maxTokens: mt, format, files };
}

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
    return { name: name.replace(/[\r\n<>]/g, ' '), text };
  });
}

/** Nội dung gửi cho model: prompt, rồi từng file trong một khối có tên (để model biết đâu là file nào). */
function userContent(req: OpenAiRequest): string {
  if (!req.files?.length) return req.prompt;
  const blocks = req.files.map((f) => `<file name="${f.name}">\n${f.text}\n</file>`);
  return `${req.prompt}\n\n${req.files.length === 1 ? 'Nội dung file đính kèm' : `Nội dung ${req.files.length} file đính kèm`}:\n\n${blocks.join('\n\n')}`;
}

/** Bắt đầu một request; trả id để poll. */
export async function start(input: unknown): Promise<{ id: string }> {
  sweep();
  if ([...jobs.values()].filter((j) => !j.done).length >= MAX_JOBS) throw new Error('Đang có quá nhiều request chạy — chờ bớt rồi gửi lại.');
  const s = await readStore();
  const c = pick(s, (input as { profileId?: unknown } | null)?.profileId);
  const req = normRequest(input, c.defaultModel);
  const h = headers(c);
  const job: Job = {
    id: randomUUID(), text: '', done: false, error: null, model: null, usage: null, finishReason: null,
    started: Date.now(), ended: null, ac: new AbortController(),
  };
  jobs.set(job.id, job);
  void run(job, c, h, req);
  return { id: job.id };
}

/** Body gửi Chat Completions — DÙNG CHUNG cho request thật và lệnh cURL (copyCurl), để hai thứ
 *  luôn khớp nhau khi người dùng so sánh ở Postman / nền tảng khác. */
function chatBody(req: OpenAiRequest, stream: boolean): Record<string, unknown> {
  const messages = [
    ...(req.system.trim() ? [{ role: 'system', content: req.system }] : []),
    { role: 'user', content: userContent(req) },
  ];
  const body: Record<string, unknown> = { model: req.model, messages };
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  } else {
    body.stream = false; // ghi rõ cho lệnh cURL — Postman nhận một JSON kết quả gọn
  }
  if (req.temperature !== null) body.temperature = req.temperature;
  // max_completion_tokens: tên mới (model suy luận không nhận max_tokens).
  if (req.maxTokens !== null) body.max_completion_tokens = req.maxTokens;
  if (req.format === 'json') body.response_format = { type: 'json_object' };
  return body;
}

async function run(job: Job, c: StoredProfile, h: Record<string, string>, req: OpenAiRequest): Promise<void> {
  const timer = setTimeout(() => job.ac.abort(new Error('timeout')), RUN_TIMEOUT_MS);
  try {
    const r = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST', headers: h, body: JSON.stringify(chatBody(req, true)), signal: job.ac.signal,
    });
    if (!r.ok || !r.body) throw await apiError(r, c.apiKey);

    // SSE: các dòng "data: {...}", kết thúc bằng "data: [DONE]".
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let ev: {
          model?: string;
          choices?: { delta?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }[];
          usage?: {
            prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number } | null;
            completion_tokens_details?: { reasoning_tokens?: number } | null;
          } | null;
          error?: { message?: string };
        };
        try { ev = JSON.parse(data); } catch { continue; }
        if (ev.error?.message) throw new Error(scrub(ev.error.message, c.apiKey));
        if (ev.model) job.model = ev.model;
        const ch = ev.choices?.[0];
        if (ch?.delta?.content) job.text += ch.delta.content;
        if (ch?.delta?.refusal) job.text += ch.delta.refusal;
        if (ch?.finish_reason) job.finishReason = ch.finish_reason;
        if (ev.usage) {
          job.usage = {
            promptTokens: ev.usage.prompt_tokens ?? 0,
            completionTokens: ev.usage.completion_tokens ?? 0,
            totalTokens: ev.usage.total_tokens ?? 0,
            cachedTokens: ev.usage.prompt_tokens_details?.cached_tokens ?? 0,
            reasoningTokens: ev.usage.completion_tokens_details?.reasoning_tokens ?? 0,
          };
        }
      }
    }
  } catch (e) {
    const err = e as Error;
    const reason = job.ac.signal.reason as Error | undefined;
    job.error = reason?.message === 'stopped' ? 'Đã dừng.'
      : reason?.message === 'timeout' ? `Quá ${RUN_TIMEOUT_MS / 60_000} phút không xong — đã dừng.`
        : scrub(err.message || String(err), c.apiKey);
  } finally {
    clearTimeout(timer);
    job.done = true;
    job.ended = Date.now();
  }
}

/** Bọc một chuỗi cho shell kiểu bash / zsh (cũng là kiểu Postman "Import → Raw text" đọc được). */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Lệnh cURL tương đương request (cùng cấu hình, model, định hướng, prompt, tham số, file) — để
 * chạy lại ở Postman / terminal mà so sánh. Khác request thật ở hai chỗ, CỐ Ý:
 *   · `stream: false` — kết quả là một JSON gọn (app nhận stream; nội dung trả lời như nhau);
 *   · khoá là biến `$OPENAI_API_KEY`, trừ khi người dùng chọn kèm khoá thật (`withKey`).
 */
export async function copyCurl(input: unknown, withKey: unknown): Promise<{ curl: string; hasKey: boolean }> {
  const s = await readStore();
  const c = pick(s, (input as { profileId?: unknown } | null)?.profileId);
  const req = normRequest(input, c.defaultModel);
  const key = withKey === true && c.apiKey ? c.apiKey : '$OPENAI_API_KEY';
  const lines = [
    `curl ${shq(`${c.baseUrl}/chat/completions`)}`,
    // Khoá thật: bọc nháy đơn (không để shell đụng tới); biến: nháy kép để shell thay giá trị.
    key === '$OPENAI_API_KEY' ? `-H "Authorization: Bearer $OPENAI_API_KEY"` : `-H ${shq(`Authorization: Bearer ${key}`)}`,
    `-H ${shq('Content-Type: application/json')}`,
    ...(c.organization ? [`-H ${shq(`OpenAI-Organization: ${c.organization}`)}`] : []),
    ...(c.project ? [`-H ${shq(`OpenAI-Project: ${c.project}`)}`] : []),
    `-d ${shq(JSON.stringify(chatBody(req, false), null, 2))}`,
  ];
  return { curl: lines.join(' \\\n  '), hasKey: key !== '$OPENAI_API_KEY' };
}

/** Ước tính token input của request đang soạn (trước khi gửi) — đúng các message chatBody dựng ra. */
export async function estimateTokens(input: unknown): Promise<TokenEstimate> {
  const s = await readStore();
  const c = pick(s, (input as { profileId?: unknown } | null)?.profileId);
  const req = normRequest(input, c.defaultModel);
  return countChatTokens(req.model, chatBody(req, false).messages as { role: string; content: string }[]);
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
    durationMs: (job.ended ?? Date.now()) - job.started,
  };
}

export function stop(id: unknown): void {
  const job = jobs.get(String(id));
  if (job && !job.done) job.ac.abort(new Error('stopped'));
}

// ── Prompt mẫu ───────────────────────────────────────────────────────────────

export async function presetSave(input: unknown): Promise<OpenAiPreset[]> {
  const b = (input ?? {}) as Record<string, unknown>;
  const name = str(b.name, 120);
  if (!name) throw new Error('Đặt tên cho prompt mẫu.');
  // Prompt mẫu có thể để trống prompt / model: dùng giá trị giả để kiểm các tham số còn lại.
  const req = normRequest({ ...b, prompt: typeof b.prompt === 'string' && b.prompt.trim() ? b.prompt : '.', model: str(b.model, 200) || '-' }, '-');
  return store.presetUpsert({
    id: typeof b.id === 'string' && b.id ? b.id : undefined,
    name,
    profileId: req.profileId,
    model: str(b.model, 200),
    system: req.system,
    prompt: typeof b.prompt === 'string' ? b.prompt.slice(0, OPENAI_LIMITS.promptChars) : '',
    temperature: req.temperature,
    maxTokens: req.maxTokens,
    format: req.format,
  });
}
