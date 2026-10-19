// NHIỆM VỤ TRỌNG TÂM (tab con của Công việc) — phần lõi THUẦN: kiểu dữ liệu, tính
// kỳ tuần/tháng, validate/chuẩn hoá. Không đụng fs/Mongo nên dùng được ở cả server
// (lib/workFocus) lẫn client (components/work/FocusPanel) và test được trực tiếp.
//
// Một nhiệm vụ thuộc MỘT kỳ:
//   · 'week'  — khoá là NGÀY THỨ HAI của tuần ('2026-10-05'), tuần bắt đầu Thứ 2.
//   · 'month' — khoá là 'YYYY-MM'.
// Mỗi nhiệm vụ có deadline (ngày) — mặc định là ngày cuối kỳ nhưng sửa/bỏ được —
// cùng tag để lọc. Trạng thái 4 bước đúng 4 cột Kanban.

export type FocusPeriod = 'week' | 'month';
export type FocusStatus = 'todo' | 'doing' | 'done' | 'dropped';
export type FocusPriority = 'normal' | 'high' | 'urgent';

export const FOCUS_STATUSES: FocusStatus[] = ['todo', 'doing', 'done', 'dropped'];
export const FOCUS_PRIORITIES: FocusPriority[] = ['normal', 'high', 'urgent'];

export interface FocusSub { id: string; text: string; done: boolean }

export interface FocusItem {
  id: string;
  period: FocusPeriod;
  /** Tuần: ngày Thứ 2 'YYYY-MM-DD'. Tháng: 'YYYY-MM'. */
  periodKey: string;
  title: string;
  note: string;
  project: string;
  tags: string[];
  priority: FocusPriority;
  status: FocusStatus;
  /** 'YYYY-MM-DD' hoặc null (không đặt deadline). */
  deadline: string | null;
  subtasks: FocusSub[];
  /** Số lần đã chuyển sang kỳ sau — thấy việc cứ bị lùi mãi thì biết mà xử. */
  carried: number;
  createdAt: number;
  updatedAt: number;
  /** Lúc chuyển sang 'done' (null khi chưa xong / đã mở lại). */
  doneAt: number | null;
}

export const LIMITS = { title: 200, note: 5000, project: 80, tag: 40, tags: 20, subs: 50, sub: 200 };

// ── Ngày (giờ địa phương) ───────────────────────────────────────────────────

const p2 = (n: number) => String(n).padStart(2, '0');
export const dstr = (d: Date): string => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function parseDate(s: string): Date | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null;
}

/** Thứ 2 của tuần chứa ngày `s` (tuần bắt đầu Thứ 2). */
export function mondayOf(s: string): string {
  const d = parseDate(s);
  if (!d) throw new Error(`Ngày không hợp lệ: ${s}`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dstr(d);
}

export function addDays(s: string, n: number): string {
  const d = parseDate(s);
  if (!d) throw new Error(`Ngày không hợp lệ: ${s}`);
  d.setDate(d.getDate() + n);
  return dstr(d);
}

/** Khoá kỳ chứa ngày `s`. */
export function keyOf(period: FocusPeriod, s: string): string {
  return period === 'week' ? mondayOf(s) : s.slice(0, 7);
}

/** Kỳ kế tiếp (delta=1) / trước (delta=-1) của một khoá. */
export function shiftKey(period: FocusPeriod, key: string, delta: number): string {
  if (period === 'week') return addDays(key, 7 * delta);
  const m = MONTH_RE.exec(key);
  if (!m) throw new Error(`Khoá tháng không hợp lệ: ${key}`);
  const d = new Date(+m[1], +m[2] - 1 + delta, 1);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
}

/** Ngày CUỐI của kỳ — deadline mặc định. Tuần: Chủ nhật. Tháng: ngày cuối tháng. */
export function periodEnd(period: FocusPeriod, key: string): string {
  if (period === 'week') return addDays(key, 6);
  const m = MONTH_RE.exec(key);
  if (!m) throw new Error(`Khoá tháng không hợp lệ: ${key}`);
  return dstr(new Date(+m[1], +m[2], 0));
}

export function validKey(period: FocusPeriod, key: string): boolean {
  return period === 'week' ? parseDate(key) !== null : MONTH_RE.test(key);
}

/** Số tuần ISO của một ngày (Thứ 5 của tuần quyết định năm). */
export function isoWeek(s: string): number {
  const d = parseDate(s);
  if (!d) return 0;
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - w1.getTime()) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7);
}

const dm = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;

/** Nhãn kỳ để hiện: 'Tuần 41 · 05/10 – 11/10/2026' hoặc 'Tháng 10/2026'. */
export function periodLabel(period: FocusPeriod, key: string): string {
  if (period === 'month') return `Tháng ${key.slice(5, 7)}/${key.slice(0, 4)}`;
  const end = addDays(key, 6);
  return `Tuần ${isoWeek(key)} · ${dm(key)} – ${dm(end)}/${end.slice(0, 4)}`;
}

// ── Chuẩn hoá input ─────────────────────────────────────────────────────────

export function cleanTags(raw: unknown): string[] {
  // Nhận cả mảng (chip) lẫn chuỗi ngăn bởi dấu phẩy (dán tay) — như ghi chú.
  const parts = Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(',');
  const out: string[] = [];
  for (const t of parts) {
    const tag = t.trim().replace(/^#/, '').slice(0, LIMITS.tag);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= LIMITS.tags) break;
  }
  return out;
}

function cleanSubs(raw: unknown): FocusSub[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: FocusSub[] = [];
  for (const r of raw as Partial<FocusSub>[]) {
    const text = String(r?.text ?? '').trim().slice(0, LIMITS.sub);
    if (!text) continue;
    let id = typeof r?.id === 'string' && r.id ? r.id : globalThis.crypto.randomUUID();
    if (seen.has(id)) id = globalThis.crypto.randomUUID();
    seen.add(id);
    out.push({ id, text, done: r?.done === true });
    if (out.length >= LIMITS.subs) break;
  }
  return out;
}

function cleanDeadline(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw);
  if (!parseDate(s)) throw new Error('Deadline không hợp lệ (cần dạng YYYY-MM-DD).');
  return s;
}

function cleanTitle(raw: unknown): string {
  const title = String(raw ?? '').trim();
  if (!title) throw new Error('Tên nhiệm vụ là bắt buộc.');
  if (title.length > LIMITS.title) throw new Error(`Tên nhiệm vụ quá dài (tối đa ${LIMITS.title} ký tự).`);
  return title;
}

const pickEnum = <T extends string>(v: unknown, all: readonly T[], fallback: T): T =>
  (all as readonly string[]).includes(String(v)) ? (v as T) : fallback;

/** Tạo nhiệm vụ mới từ input client. Thiếu deadline → mặc định ngày cuối kỳ. */
export function buildItem(raw: Record<string, unknown>, now = Date.now()): FocusItem {
  const period = raw.period === 'month' ? 'month' : raw.period === 'week' ? 'week' : null;
  if (!period) throw new Error('Kỳ phải là week hoặc month.');
  let key = String(raw.periodKey ?? '');
  if (!validKey(period, key)) throw new Error('Khoá kỳ không hợp lệ.');
  if (period === 'week') key = mondayOf(key); // lệch ngày trong tuần thì kéo về Thứ 2
  const note = String(raw.note ?? '');
  if (note.length > LIMITS.note) throw new Error(`Ghi chú quá dài (tối đa ${LIMITS.note} ký tự).`);
  const status = pickEnum(raw.status, FOCUS_STATUSES, 'todo');
  return {
    id: globalThis.crypto.randomUUID(),
    period,
    periodKey: key,
    title: cleanTitle(raw.title),
    note,
    project: String(raw.project ?? '').trim().slice(0, LIMITS.project),
    tags: cleanTags(raw.tags),
    priority: pickEnum(raw.priority, FOCUS_PRIORITIES, 'normal'),
    status,
    // `'deadline' in raw` để phân biệt "không gửi" (→ mặc định) với "gửi null" (→ cố ý không deadline).
    deadline: 'deadline' in raw ? cleanDeadline(raw.deadline) : periodEnd(period, key),
    subtasks: cleanSubs(raw.subtasks),
    carried: 0,
    createdAt: now,
    updatedAt: now,
    doneAt: status === 'done' ? now : null,
  };
}

/** Áp các field CÓ MẶT trong `raw` lên nhiệm vụ hiện có (kỳ gốc `period` không đổi). */
export function patchItem(cur: FocusItem, raw: Record<string, unknown>, now = Date.now()): FocusItem {
  const next: FocusItem = { ...cur, tags: [...cur.tags], subtasks: cur.subtasks.map((s) => ({ ...s })) };
  if ('title' in raw) next.title = cleanTitle(raw.title);
  if ('note' in raw) {
    const note = String(raw.note ?? '');
    if (note.length > LIMITS.note) throw new Error(`Ghi chú quá dài (tối đa ${LIMITS.note} ký tự).`);
    next.note = note;
  }
  if ('project' in raw) next.project = String(raw.project ?? '').trim().slice(0, LIMITS.project);
  if ('tags' in raw) next.tags = cleanTags(raw.tags);
  if ('priority' in raw) next.priority = pickEnum(raw.priority, FOCUS_PRIORITIES, cur.priority);
  if ('deadline' in raw) next.deadline = cleanDeadline(raw.deadline);
  if ('subtasks' in raw) next.subtasks = cleanSubs(raw.subtasks);
  if ('periodKey' in raw) {
    const key = String(raw.periodKey ?? '');
    if (!validKey(cur.period, key)) throw new Error('Khoá kỳ không hợp lệ.');
    const k = cur.period === 'week' ? mondayOf(key) : key;
    if (k !== cur.periodKey) {
      next.periodKey = k;
      // Chuyển sang kỳ khác = "lùi/dời" nhiệm vụ: đếm số lần nếu là đi tới kỳ sau.
      if (k > cur.periodKey) next.carried = cur.carried + 1;
      // Deadline còn nằm trong kỳ CŨ thì đã vô nghĩa với kỳ mới → dời theo cuối kỳ mới
      // (trừ khi client gửi deadline riêng cùng lúc).
      if (!('deadline' in raw) && cur.deadline && cur.deadline <= periodEnd(cur.period, cur.periodKey)) {
        next.deadline = periodEnd(cur.period, k);
      }
    }
  }
  if ('status' in raw) {
    const status = pickEnum(raw.status, FOCUS_STATUSES, cur.status);
    next.status = status;
    if (status === 'done' && cur.status !== 'done') next.doneAt = now;
    if (status !== 'done') next.doneAt = null;
  }
  next.updatedAt = now;
  return next;
}
