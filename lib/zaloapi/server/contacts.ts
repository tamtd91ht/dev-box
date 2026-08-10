// Zalo API — danh bạ đích (server-side), lưu configs/zaloapi-contacts.json.
//
// Vì sao KHÔNG dùng chung wstargets.json của Workspace: danh bạ Workspace định
// danh bằng TÊN (DOM Zalo không lộ id), còn ở đây định danh bằng threadId THẬT.
// Hai schema khác bản chất — trộn chung sẽ làm wsSend (bám tên) và zaloApiSend
// (bám id) lẫn nhau, đúng thứ luôn phải tránh.
//
// Danh bạ tự đầy lên: mỗi tin listener nhận được đều upsert một contact (id +
// tên + nhóm/cá nhân). Rule chỉ việc CHỌN từ dropdown — thấy tên, không thấy id.
// Có thể thêm/sửa/xoá thủ công cho hội thoại chưa ai nhắn tới.
//
//   { version:1, contacts: [ { accountKey, threadId, name, group, lastSeen, manual } ] }

import { promises as fs } from 'fs';
import path from 'path';
import { configPath } from '../../configDir';

export interface ZaloContact {
  /** `zaloapi::<instanceId>` — tài khoản nào với tới được. */
  accountKey: string;
  /** threadId THẬT — cái định tuyến khi gửi. */
  threadId: string;
  /** Tên hiển thị để người dùng nhận ra (không dùng để định tuyến). */
  name: string;
  /** Nhóm hay cá nhân — hai endpoint khác nhau khi gửi. */
  group: boolean;
  /** Lần cuối thấy tin từ hội thoại này (epoch ms). 0 nếu thêm tay. */
  lastSeen: number;
  /** Người dùng tự thêm (không phải tự học từ tin đến). */
  manual?: boolean;
}

export interface ContactStore {
  version: 1;
  contacts: ZaloContact[];
}

const FILE = process.env.ZALOAPI_CONTACTS_PATH
  ? path.resolve(process.cwd(), process.env.ZALOAPI_CONTACTS_PATH)
  : configPath('zaloapi-contacts.json', ['.zaloapi-contacts.json']);

const EMPTY: ContactStore = { version: 1, contacts: [] };
const str = (v: unknown, max = 200): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

function norm(raw: unknown): ZaloContact | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const accountKey = str(c.accountKey, 80);
  const threadId = str(c.threadId, 80);
  if (!accountKey || !threadId) return null;
  const at = Number(c.lastSeen);
  return {
    accountKey,
    threadId,
    name: str(c.name) || threadId,
    group: !!c.group,
    lastSeen: Number.isFinite(at) && at > 0 ? at : 0,
    manual: !!c.manual,
  };
}

/** Khoá duy nhất một contact. */
const keyOf = (accountKey: string, threadId: string) => `${accountKey}::${threadId}`;

export function normalizeContacts(raw: unknown): ContactStore {
  if (!raw || typeof raw !== 'object') return { ...EMPTY, contacts: [] };
  const c = raw as Record<string, unknown>;
  const list = (Array.isArray(c.contacts) ? c.contacts : []).map(norm).filter((x): x is ZaloContact => !!x);
  // Bỏ trùng (account × threadId) — giữ bản mới nhất.
  const seen = new Map<string, ZaloContact>();
  for (const ct of list) seen.set(keyOf(ct.accountKey, ct.threadId), ct);
  return { version: 1, contacts: [...seen.values()] };
}

export async function readContacts(): Promise<ContactStore> {
  try {
    return normalizeContacts(JSON.parse(await fs.readFile(FILE, 'utf8')));
  } catch {
    return { ...EMPTY, contacts: [] };
  }
}

async function write(store: ContactStore): Promise<ContactStore> {
  const clean = normalizeContacts(store);
  await fs.writeFile(FILE, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  return clean;
}

/** Contacts của một tài khoản, mới nhất trước. */
export async function contactsFor(accountKey: string): Promise<ZaloContact[]> {
  const store = await readContacts();
  return store.contacts
    .filter((c) => c.accountKey === accountKey)
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

/**
 * TỰ HỌC: một tin vừa đến → upsert contact. Không đè tên do người dùng đặt tay
 * bằng tên rỗng; cập nhật lastSeen + nhóm. Giữ nhẹ: chỉ ghi đĩa khi có đổi.
 */
export async function learnContact(input: {
  accountKey: string;
  threadId: string;
  name: string;
  group: boolean;
}): Promise<void> {
  const accountKey = str(input.accountKey, 80);
  const threadId = str(input.threadId, 80);
  if (!accountKey || !threadId) return;
  const store = await readContacts();
  const k = keyOf(accountKey, threadId);
  const idx = store.contacts.findIndex((c) => keyOf(c.accountKey, c.threadId) === k);
  const now = Date.now();
  const incomingName = str(input.name);
  if (idx >= 0) {
    const prev = store.contacts[idx];
    // Không đổi gì đáng kể → khỏi ghi đĩa (learn gọi mỗi tin, không nên spam I/O).
    const nextName = prev.manual ? prev.name : (incomingName || prev.name);
    if (prev.name === nextName && prev.group === !!input.group && now - prev.lastSeen < 30_000) return;
    store.contacts[idx] = { ...prev, name: nextName, group: !!input.group, lastSeen: now };
  } else {
    store.contacts.push({ accountKey, threadId, name: incomingName || threadId, group: !!input.group, lastSeen: now });
  }
  await write(store);
}

/** Thêm/sửa thủ công một contact (hội thoại chưa ai nhắn tới). */
export async function upsertContact(raw: unknown): Promise<ContactStore> {
  const c = norm(raw);
  if (!c) throw new Error('cần accountKey + threadId');
  const store = await readContacts();
  const k = keyOf(c.accountKey, c.threadId);
  const rest = store.contacts.filter((x) => keyOf(x.accountKey, x.threadId) !== k);
  return write({ version: 1, contacts: [...rest, { ...c, manual: true }] });
}

export async function removeContact(accountKey: string, threadId: string): Promise<ContactStore> {
  const store = await readContacts();
  const k = keyOf(str(accountKey, 80), str(threadId, 80));
  return write({ version: 1, contacts: store.contacts.filter((x) => keyOf(x.accountKey, x.threadId) !== k) });
}
