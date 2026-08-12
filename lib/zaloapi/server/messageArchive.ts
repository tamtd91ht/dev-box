// Zalo API (thử nghiệm) — KHO LƯU TRỮ TIN (TUỲ CHỌN, 3 chế độ).
//
// VÌ SAO CÓ KHO NÀY: threadStore chỉ sống trong RAM và chỉ nhận được những gì
// listener socket bắt được TỪ LÚC KẾT NỐI trở đi. Zalo không cho lấy lại lịch
// sử 1-1 (chỉ nhóm có getGroupChatHistory), nên restart app là mất sạch tin cũ
// — mở lại hội thoại thấy trắng dù hôm qua vừa nhắn. Kho này ghi bền mỗi tin
// listener/lượt gửi đi qua, để lần render sau dựng lại được màn chat.
//
// BA CHẾ ĐỘ (field 'mode', mặc định 'off'):
//   · 'off'    KHÔNG lưu gì — đúng hành vi cũ (RAM-only). Mặc định: tin nhắn là
//              dữ liệu cá nhân, không tự ý ghi xuống đĩa khi chưa ai yêu cầu.
//   · 'local'  Lưu NGAY TRÊN MÁY, một file JSONL cho mỗi tài khoản trong
//              configs/zaloapi-messages/. Không cần Mongo, chạy offline. Có ba
//              lớp chặn phình (xem "MÔ HÌNH LOCAL" dưới đây).
//   · 'mongo'  Lưu trên một cụm MongoDB chọn từ registry Mongo dùng chung.
//              Nhiều máy cùng thấy một kho.
//
// ĐỒNG BỘ SANG MÁY KHÁC (qua vault có passphrase, lib/configSync):
//   · 'mongo' — file config này chỉ giữ CON TRỎ { connectionId, database }, còn
//     host/user/password nằm trong configs/mongoconnections.json vốn đã sync.
//     Kéo về máy khác là trỏ ngay vào cùng cụm, thấy đúng kho tin.
//   · 'local' — chính FILE TIN được sync: configs/zaloapi-messages/*.jsonl nằm
//     trong configs/ nên vào vault cùng mọi config khác (xem syncableFiles()).
//     Vault mã hoá bằng age nên tin nhắn không nằm trần trên GitHub.
//
// MÔ HÌNH LOCAL — chống tràn resource khi chạy lâu (append-only + 3 cái trần):
//   1. GHI: append một dòng JSON, KHÔNG đọc/ghi lại cả file. O(1) mỗi tin, nên
//      listener bắn liên tục cũng không tốn gì. Trùng id được khử lúc ĐỌC (bản
//      sau thắng) — rẻ hơn nhiều so với tìm-rồi-sửa mỗi lượt ghi.
//   2. TRẦN FILE: file vượt LOCAL_MAX_BYTES thì COMPACT — đọc lại, giữ
//      LOCAL_KEEP_PER_THREAD tin mới nhất mỗi hội thoại, ghi đè file. Vì compact
//      chỉ chạy khi vượt trần nên chi phí được khấu hao (không phải mỗi tin).
//   3. TRẦN TUỔI: tin cũ hơn LOCAL_RETENTION_DAYS bị bỏ lúc compact — kho không
//      lớn mãi theo thời gian dù có nhắn đều.
//   4. TRẦN ĐỌC: mỗi lần khôi phục chỉ nạp LOCAL_KEEP_PER_THREAD tin mới nhất
//      mỗi hội thoại và HYDRATE_THREADS hội thoại — RAM không phụ thuộc kho to
//      cỡ nào.
//
// Chế độ 'mongo': collection cố định 'zaloapi_messages', một document = một tin,
// khoá duy nhất (accountKey, threadId, id) để ghi lại nhiều lần cũng không nhân
// bản; thêm 'zaloapi_threads' giữ tên/nhóm của hội thoại.

import { promises as fs } from 'fs';
import path from 'path';
import type { Collection, Db, Document } from 'mongodb';
import { configDir, configPath } from '../../configDir';
import { getConnection, listConnections, type PublicMongoConnection } from '../../mongoConnections';
import { internalClient } from '../../mongoClient';
import type { StoredMessage } from './threadStore';

export const ZALO_MSG_COLLECTION = 'zaloapi_messages';
export const ZALO_THREAD_COLLECTION = 'zaloapi_threads';

/** Trần hội thoại nạp lại mỗi lượt khôi phục (mới nhất trước). */
const HYDRATE_THREADS = 200;
/** Trần tin mỗi hội thoại — khớp MAX_PER_THREAD của threadStore. */
const KEEP_PER_THREAD = 400;

// Ba cái trần của chế độ 'local' (xem MÔ HÌNH LOCAL ở đầu file).
const LOCAL_MAX_BYTES = 16 * 1024 * 1024;
const LOCAL_KEEP_PER_THREAD = KEEP_PER_THREAD;
const LOCAL_RETENTION_DAYS = 90;

// ── Config ──────────────────────────────────────────────────────────────────

export type ArchiveMode = 'off' | 'local' | 'mongo';

export const ARCHIVE_MODES: ArchiveMode[] = ['off', 'local', 'mongo'];

export interface ArchiveConfig {
  mode: ArchiveMode;
  /** Chỉ dùng khi mode='mongo' — con trỏ tới registry Mongo, KHÔNG chứa secret. */
  connectionId?: string;
  database?: string;
}

const CONFIG_FILE = configPath('zaloapi-archive.json', []);

/** Thư mục chứa file tin của chế độ 'local' (nằm trong configs/ nên được sync). */
const LOCAL_DIR = path.join(configDir(), 'zaloapi-messages');

const OFF: ArchiveConfig = { mode: 'off' };

async function readConfig(): Promise<ArchiveConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8')) as Partial<ArchiveConfig> & { enabled?: boolean };
    const mode = ARCHIVE_MODES.includes(raw.mode as ArchiveMode) ? (raw.mode as ArchiveMode) : null;
    if (mode === 'local') return { mode: 'local' };
    if (mode === 'mongo' || (!mode && raw.connectionId)) {
      // (!mode && connectionId): bản ghi trước khi có field 'mode' — chỉ có thể
      // là cấu hình mongo, và 'enabled:false' của bản đó nghĩa là đang tắt.
      if (raw.enabled === false && !mode) return OFF;
      if (typeof raw.connectionId === 'string' && raw.connectionId
        && typeof raw.database === 'string' && raw.database) {
        return { mode: 'mongo', connectionId: raw.connectionId, database: raw.database };
      }
      return OFF;
    }
    return OFF;
  } catch {
    return OFF; // chưa cấu hình → không lưu gì
  }
}

export interface ArchiveConfigView {
  mode: ArchiveMode;
  /** mode='mongo' đã trỏ tới connection CÒN TỒN TẠI, hoặc mode='local'. */
  configured: boolean;
  config: ArchiveConfig;
  /** Tên connection đang trỏ (null khi đã bị xoá khỏi registry / không dùng mongo). */
  connectionName: string | null;
  connections: PublicMongoConnection[];
  /** Số tin đã lưu của tài khoản đang xem (chỉ khi đọc được kho). */
  storedCount?: number;
  /** Dung lượng kho local, KB (chỉ mode='local'). */
  localKb?: number;
  /** Vì sao không đọc được kho (cụm sập, sai auth…) — hiện cho người dùng. */
  probeError?: string;
}

export async function getArchiveConfigView(accountKey?: string): Promise<ArchiveConfigView> {
  const config = await readConfig();
  const connections = await listConnections();
  const conn = config.mode === 'mongo'
    ? connections.find((c) => c.id === config.connectionId)
    : undefined;
  const view: ArchiveConfigView = {
    mode: config.mode,
    configured: config.mode === 'local' || (config.mode === 'mongo' && !!conn),
    config,
    connectionName: conn?.name ?? null,
    connections,
  };
  // Đếm thử để người dùng thấy kho có thật đang chạy — lỗi thì báo, không ném.
  if (view.configured) {
    try {
      if (config.mode === 'local') {
        const { count, bytes } = await localStats(accountKey);
        view.storedCount = count;
        view.localKb = Math.round((bytes / 1024) * 10) / 10;
      } else {
        const c = await mongoColl();
        view.storedCount = await c.countDocuments(accountKey ? { accountKey } : {}, { maxTimeMS: 5000 });
      }
    } catch (e) {
      view.probeError = (e as Error).message;
    }
  }
  return view;
}

/**
 * Ghi cấu hình. mode='mongo' validate connection CÓ THẬT trong registry trước
 * khi lưu — trỏ vào id đã xoá thì mọi lượt ghi sau đó lỗi âm thầm.
 */
export async function setArchiveConfig(raw: {
  mode?: unknown;
  connectionId?: unknown;
  database?: unknown;
}): Promise<void> {
  const mode = ARCHIVE_MODES.includes(raw.mode as ArchiveMode) ? (raw.mode as ArchiveMode) : null;
  if (!mode) throw new Error("Chế độ lưu trữ không hợp lệ (chọn 'off', 'local' hoặc 'mongo').");

  let cfg: ArchiveConfig;
  if (mode === 'mongo') {
    const id = String(raw.connectionId ?? '').trim();
    const db = String(raw.database ?? '').trim();
    if (!id) throw new Error('Chọn một MongoDB connection.');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(db)) throw new Error('Tên database không hợp lệ (a-z, 0-9, _, -).');
    if (!(await getConnection(id))) throw new Error('Connection không tồn tại trong danh sách quản lý Mongo.');
    cfg = { mode, connectionId: id, database: db };
  } else {
    cfg = { mode };
    if (mode === 'local') await fs.mkdir(LOCAL_DIR, { recursive: true });
  }
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  // Cấu hình đổi → index có thể chưa có ở cụm mới; dựng lại ở lượt ghi kế tiếp.
  indexReady = false;
}

/** Chế độ đang chạy. Đọc file mỗi lần: file bé, và đổi chế độ có hiệu lực ngay. */
async function activeMode(): Promise<ArchiveMode> {
  return (await readConfig()).mode;
}

export async function isArchiveEnabled(): Promise<boolean> {
  return (await activeMode()) !== 'off';
}

// ── Backend: Mongo ──────────────────────────────────────────────────────────

let indexReady = false;

async function mongoDb(): Promise<Db> {
  const cfg = await readConfig();
  if (cfg.mode !== 'mongo' || !cfg.connectionId || !cfg.database) {
    throw new Error('Kho tin Zalo API chưa được cấu hình dùng MongoDB.');
  }
  const conn = await getConnection(cfg.connectionId);
  if (!conn) throw new Error('Connection đã bị xoá khỏi danh sách quản lý Mongo — cấu hình lại.');
  return internalClient(conn).db(cfg.database);
}

async function mongoColl(): Promise<Collection<Document>> {
  return (await mongoDb()).collection(ZALO_MSG_COLLECTION);
}

async function mongoThreadColl(): Promise<Collection<Document>> {
  return (await mongoDb()).collection(ZALO_THREAD_COLLECTION);
}

/**
 * Index dựng MỘT lần cho mỗi tiến trình: khoá duy nhất để upsert không nhân bản,
 * và index đọc theo (accountKey, threadId, at) cho lượt khôi phục.
 */
async function ensureIndexes(c: Collection<Document>): Promise<void> {
  if (indexReady) return;
  await c.createIndexes([
    { key: { accountKey: 1, threadId: 1, id: 1 }, name: 'uniq_msg', unique: true },
    { key: { accountKey: 1, threadId: 1, at: -1 }, name: 'by_thread_time' },
  ]);
  indexReady = true;
}

/** Các field lưu bền của một tin (dùng chung cho cả hai backend). */
function toRecord(threadId: string, group: boolean, m: StoredMessage): Record<string, unknown> {
  return {
    threadId,
    group,
    id: m.id,
    at: m.at,
    self: m.self,
    fromId: m.fromId,
    fromName: m.fromName,
    text: m.text,
    ...(m.imageUrl ? { imageUrl: m.imageUrl } : {}),
    // 'sending' là trạng thái TẠM của UI — lưu bền thì vô nghĩa, chỉ ghi khi đã chốt.
    ...(m.status && m.status !== 'sending' ? { status: m.status } : {}),
  };
}

// ── Backend: local JSONL ────────────────────────────────────────────────────
//
// Một file cho mỗi tài khoản. Mỗi dòng là một bản ghi JSON:
//   {"t":"m","threadId":…,"id":…,"at":…,…}   một tin
//   {"t":"s","threadId":…,"id":…,"status":…} đổi trạng thái tin đã ghi
//   {"t":"x","threadId":…,"id":…}            XOÁ tin đã ghi (bia mộ)
//   {"t":"h","threadId":…,"name":…,"group":…,"lastAt":…} metadata hội thoại
// Đọc = phát lại cả file theo thứ tự, bản ghi sau thắng bản ghi trước.
//
// 'x' có vì file là append-only nên không sửa/xoá tại chỗ được: khi tin gửi lạc
// quan ('out-…') được gộp với bản Zalo dội về (id thật), phải gỡ bản cũ ra —
// xem archiveReplaceId. Bia mộ biến mất hẳn ở lượt compact kế tiếp.

/** accountKey → tên file an toàn (accountKey có '::' không hợp lệ trên Windows). */
function localFile(accountKey: string): string {
  const safe = accountKey.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 100) || 'unknown';
  return path.join(LOCAL_DIR, `${safe}.jsonl`);
}

/** Append một hoặc nhiều dòng. Tự tạo thư mục, tự compact khi vượt trần. */
async function localAppend(accountKey: string, lines: string[]): Promise<void> {
  if (!lines.length) return;
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  const file = localFile(accountKey);
  await fs.appendFile(file, lines.join('\n') + '\n', 'utf8');
  try {
    const { size } = await fs.stat(file);
    if (size > LOCAL_MAX_BYTES) await compactLocal(accountKey);
  } catch { /* stat lỗi thì bỏ qua — lượt sau kiểm lại */ }
}

interface LocalState {
  /** threadId → tin (theo id, bản sau thắng). */
  threads: Map<string, Map<string, StoredMessage>>;
  meta: Map<string, { name: string; group: boolean; lastAt: number }>;
}

/** Phát lại file JSONL thành trạng thái trong RAM. File chưa có → rỗng. */
async function readLocal(accountKey: string): Promise<LocalState> {
  const state: LocalState = { threads: new Map(), meta: new Map() };
  let text: string;
  try {
    text = await fs.readFile(localFile(accountKey), 'utf8');
  } catch {
    return state;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const threadId = typeof rec.threadId === 'string' ? rec.threadId : '';
    if (!threadId) continue;
    if (rec.t === 'h') {
      const prev = state.meta.get(threadId);
      const lastAt = Number(rec.lastAt) || 0;
      state.meta.set(threadId, {
        name: (typeof rec.name === 'string' && rec.name) || prev?.name || '',
        group: rec.group === undefined ? !!prev?.group : !!rec.group,
        lastAt: Math.max(lastAt, prev?.lastAt ?? 0),
      });
      continue;
    }
    const id = typeof rec.id === 'string' ? rec.id : '';
    if (!id) continue;
    let byId = state.threads.get(threadId);
    if (!byId) { byId = new Map(); state.threads.set(threadId, byId); }
    if (rec.t === 'x') {
      byId.delete(id);
      continue;
    }
    if (rec.t === 's') {
      const prev = byId.get(id);
      const status = rec.status;
      if (prev && (status === 'sent' || status === 'failed')) byId.set(id, { ...prev, status });
      continue;
    }
    byId.set(id, fromRecord(rec));
  }
  return state;
}

/**
 * Viết lại file chỉ còn phần đáng giữ: LOCAL_KEEP_PER_THREAD tin mới nhất mỗi
 * hội thoại, bỏ tin quá LOCAL_RETENTION_DAYS. Ghi ra file tạm rồi rename —
 * ngắt điện giữa lúc compact không để lại file nửa vời.
 */
async function compactLocal(accountKey: string): Promise<void> {
  const state = await readLocal(accountKey);
  const cutoff = Date.now() - LOCAL_RETENTION_DAYS * 86_400_000;
  const lines: string[] = [];
  for (const [threadId, byId] of state.threads) {
    const meta = state.meta.get(threadId);
    const kept = [...byId.values()]
      .filter((m) => m.at >= cutoff)
      .sort((a, b) => a.at - b.at)
      .slice(-LOCAL_KEEP_PER_THREAD);
    if (!kept.length) continue;
    if (meta) lines.push(JSON.stringify({ t: 'h', threadId, name: meta.name, group: meta.group, lastAt: meta.lastAt }));
    for (const m of kept) lines.push(JSON.stringify({ t: 'm', ...toRecord(threadId, !!meta?.group, m) }));
  }
  const file = localFile(accountKey);
  const tmp = `${file}.compact-${Date.now()}`;
  await fs.writeFile(tmp, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
  await fs.rename(tmp, file);
}

/** Số tin + dung lượng kho local (cho ô trạng thái trong UI). */
async function localStats(accountKey?: string): Promise<{ count: number; bytes: number }> {
  let names: string[];
  try {
    names = (await fs.readdir(LOCAL_DIR)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return { count: 0, bytes: 0 };
  }
  // Lọc về đúng file của một tài khoản khi được chỉ định; không thì đếm cả kho.
  const wanted = accountKey ? path.basename(localFile(accountKey)) : null;
  const targets = wanted ? names.filter((n) => n === wanted) : names;
  let count = 0;
  let bytes = 0;
  for (const name of targets) {
    try { bytes += (await fs.stat(path.join(LOCAL_DIR, name))).size; } catch { /* bỏ qua */ }
    // readLocal nhận accountKey rồi tự suy ra tên file, nên với nhánh "cả kho"
    // phải đưa lại đúng tên file đang đọc (tên file = accountKey đã làm an toàn,
    // và localFile() giữ nguyên chuỗi đã an toàn).
    const state = await readLocal(accountKey ?? name.replace(/\.jsonl$/, ''));
    for (const byId of state.threads.values()) count += byId.size;
  }
  return { count, bytes };
}

function fromRecord(d: Record<string, unknown>): StoredMessage {
  const status = d.status;
  return {
    id: String(d.id),
    at: Number(d.at) || 0,
    self: !!d.self,
    fromId: typeof d.fromId === 'string' ? d.fromId : '',
    fromName: typeof d.fromName === 'string' ? d.fromName : '',
    text: typeof d.text === 'string' ? d.text : '',
    ...(typeof d.imageUrl === 'string' && d.imageUrl ? { imageUrl: d.imageUrl } : {}),
    ...(status === 'sent' || status === 'failed' ? { status } : {}),
  };
}

/**
 * File tin local cần đưa vào vault đồng bộ. configSync gói cả configs/*.json nên
 * *.jsonl trong thư mục con KHÔNG tự vào — hàm này cho nó danh sách đường dẫn.
 */
export async function syncableFiles(): Promise<string[]> {
  try {
    return (await fs.readdir(LOCAL_DIR))
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => path.join(LOCAL_DIR, n));
  } catch {
    return [];
  }
}

// ── Ghi (điều phối theo chế độ) ─────────────────────────────────────────────

/**
 * Ghi (upsert) một tin. GỌI ĐƯỢC VÔ ĐIỀU KIỆN từ luồng nóng: chế độ 'off' thì
 * về ngay, và MỌI lỗi bị nuốt — kho lưu trữ là tiện ích phụ, cụm Mongo sập hay
 * đĩa đầy không được phép làm chết luồng nhận/gửi tin.
 */
export async function archiveMessage(
  accountKey: string,
  threadId: string,
  group: boolean,
  msg: StoredMessage,
): Promise<void> {
  if (!accountKey || !threadId || !msg?.id) return;
  await archiveMessages(accountKey, threadId, group, [msg]);
}

/** Ghi nhiều tin một lượt (kéo lịch sử nhóm). Cùng kỷ luật nuốt lỗi. */
export async function archiveMessages(
  accountKey: string,
  threadId: string,
  group: boolean,
  msgs: StoredMessage[],
): Promise<void> {
  if (!accountKey || !threadId || !msgs.length) return;
  const usable = msgs.filter((m) => m?.id);
  if (!usable.length) return;
  try {
    const mode = await activeMode();
    if (mode === 'off') return;
    if (mode === 'local') {
      await localAppend(accountKey, usable.map((m) => JSON.stringify({ t: 'm', ...toRecord(threadId, group, m) })));
      return;
    }
    const c = await mongoColl();
    await ensureIndexes(c);
    // ordered:false — một tin lỗi không được chặn phần còn lại.
    await c.bulkWrite(
      usable.map((m) => ({
        updateOne: {
          filter: { accountKey, threadId, id: m.id },
          update: {
            $set: { accountKey, ...toRecord(threadId, group, m) },
            $setOnInsert: { archivedAt: Date.now() },
          },
          upsert: true as const,
        },
      })),
      { ordered: false },
    );
  } catch { /* kho lưu trữ không bao giờ chặn luồng tin */ }
}

/**
 * GỘP tin gửi lạc quan với bản Zalo dội về: ghi tin theo id THẬT (msgId) và XOÁ
 * bản 'out-…' tạm đã lưu trước đó.
 *
 * VÌ SAO PHẢI CÓ: recordOutgoing lưu tin ngay lúc bấm gửi với id tự sinh
 * ('out-<at>-<hash>'), rồi khi Zalo dội tin về, recordIncoming ĐỔI id của bong
 * bóng đó thành msgId thật. Trong RAM đó là một object bị sửa nên không sao,
 * nhưng kho lưu trữ khoá theo (accountKey, threadId, id) — bản 'out-…' vẫn nằm
 * đó và bản msgId được thêm vào bên cạnh. Nạp lại là thấy MỘT tin thành HAI.
 * Hàm này xoá bản cũ đúng lúc gộp nên kho luôn có đúng một dòng cho một tin.
 */
export async function archiveReplaceId(
  accountKey: string,
  threadId: string,
  oldId: string,
  msg: StoredMessage,
  group: boolean,
): Promise<void> {
  if (!accountKey || !threadId || !msg?.id) return;
  try {
    const mode = await activeMode();
    if (mode === 'off') return;
    if (mode === 'local') {
      // JSONL là append-only: ghi bản mới + một bản ghi 'x' (xoá) cho id cũ.
      // readLocal phát lại theo thứ tự nên 'x' sau sẽ gỡ bản 'out-…' ra.
      await localAppend(accountKey, [
        JSON.stringify({ t: 'm', ...toRecord(threadId, group, msg) }),
        ...(oldId && oldId !== msg.id ? [JSON.stringify({ t: 'x', threadId, id: oldId })] : []),
      ]);
      return;
    }
    const c = await mongoColl();
    await ensureIndexes(c);
    await c.updateOne(
      { accountKey, threadId, id: msg.id },
      { $set: { accountKey, ...toRecord(threadId, group, msg) }, $setOnInsert: { archivedAt: Date.now() } },
      { upsert: true },
    );
    if (oldId && oldId !== msg.id) await c.deleteOne({ accountKey, threadId, id: oldId });
  } catch { /* im lặng — kho không chặn luồng tin */ }
}

/** Cập nhật trạng thái một tin đã lưu (sau khi route biết gửi ok/failed). */
export async function archiveStatus(
  accountKey: string,
  threadId: string,
  id: string,
  status: StoredMessage['status'],
): Promise<void> {
  if (!accountKey || !threadId || !id || !status || status === 'sending') return;
  try {
    const mode = await activeMode();
    if (mode === 'off') return;
    if (mode === 'local') {
      await localAppend(accountKey, [JSON.stringify({ t: 's', threadId, id, status })]);
      return;
    }
    await (await mongoColl()).updateOne({ accountKey, threadId, id }, { $set: { status } });
  } catch { /* im lặng */ }
}

/**
 * Ghi metadata hội thoại (tên + nhóm) để lần khôi phục sau dựng lại được danh
 * sách bên trái với tên đúng, kể cả hội thoại chưa có trong danh bạ local.
 */
export async function archiveThreadMeta(
  accountKey: string,
  threadId: string,
  meta: { name: string; group: boolean; lastAt: number },
): Promise<void> {
  if (!accountKey || !threadId) return;
  try {
    const mode = await activeMode();
    if (mode === 'off') return;
    if (mode === 'local') {
      await localAppend(accountKey, [JSON.stringify({ t: 'h', threadId, name: meta.name, group: meta.group, lastAt: meta.lastAt || 0 })]);
      return;
    }
    await (await mongoThreadColl()).updateOne(
      { accountKey, threadId },
      {
        $set: { accountKey, threadId, group: meta.group, ...(meta.name ? { name: meta.name } : {}) },
        // lastAt chỉ tiến lên — tin cũ ghi sau không được kéo tụt mốc.
        $max: { lastAt: meta.lastAt || 0 },
      },
      { upsert: true },
    );
  } catch { /* im lặng */ }
}

// ── Đọc lại (khôi phục vào RAM) ─────────────────────────────────────────────

export interface HydratedThread {
  threadId: string;
  group: boolean;
  name: string;
  messages: StoredMessage[];
}

/**
 * Đọc lại tin của MỘT hội thoại (cũ → mới, trần KEEP_PER_THREAD tin gần nhất).
 * Ném lỗi nếu kho không với tới được — người gọi tự quyết định hiện cảnh báo hay
 * lặng lẽ dùng RAM.
 */
export async function loadThreadMessages(accountKey: string, threadId: string): Promise<StoredMessage[]> {
  const mode = await activeMode();
  if (mode === 'off') return [];
  if (mode === 'local') {
    const byId = (await readLocal(accountKey)).threads.get(threadId);
    return byId
      ? [...byId.values()].sort((a, b) => a.at - b.at).slice(-KEEP_PER_THREAD)
      : [];
  }
  const docs = await (await mongoColl())
    .find({ accountKey, threadId }, { maxTimeMS: 10_000 })
    .sort({ at: -1 })
    .limit(KEEP_PER_THREAD)
    .toArray();
  return docs.map((d) => fromRecord(d as Record<string, unknown>)).sort((a, b) => a.at - b.at);
}

/**
 * Đọc lại TOÀN BỘ hội thoại đã lưu của một tài khoản để nạp vào RAM lúc kết nối
 * lại. Mỗi hội thoại lấy KEEP_PER_THREAD tin gần nhất, tối đa HYDRATE_THREADS
 * hội thoại (mới nhất trước) — đủ dựng màn chat, không kéo cả kho về RAM.
 */
export async function loadAccountThreads(accountKey: string): Promise<HydratedThread[]> {
  const mode = await activeMode();
  if (mode === 'off') return [];

  if (mode === 'local') {
    const state = await readLocal(accountKey);
    const out: HydratedThread[] = [];
    for (const [threadId, byId] of state.threads) {
      const messages = [...byId.values()].sort((a, b) => a.at - b.at).slice(-KEEP_PER_THREAD);
      if (!messages.length) continue;
      const meta = state.meta.get(threadId);
      out.push({ threadId, group: !!meta?.group, name: meta?.name ?? '', messages });
    }
    return out
      .sort((a, b) => (b.messages[b.messages.length - 1]?.at ?? 0) - (a.messages[a.messages.length - 1]?.at ?? 0))
      .slice(0, HYDRATE_THREADS);
  }

  const tc = await mongoThreadColl();
  const metas = await tc
    .find({ accountKey }, { maxTimeMS: 10_000 })
    .sort({ lastAt: -1 })
    .limit(HYDRATE_THREADS)
    .toArray();

  const c = await mongoColl();
  // Không có bảng meta (kho ghi bởi bản cũ) → suy danh sách hội thoại từ chính
  // bảng tin, vẫn khôi phục được.
  const ids = metas.length
    ? metas.map((m) => String(m.threadId))
    : (await c.distinct('threadId', { accountKey })).slice(0, HYDRATE_THREADS).map(String);
  if (!ids.length) return [];

  const metaOf = new Map(metas.map((m) => [String(m.threadId), m]));
  const out: HydratedThread[] = [];
  for (const threadId of ids) {
    const docs = await c
      .find({ accountKey, threadId }, { maxTimeMS: 10_000 })
      .sort({ at: -1 })
      .limit(KEEP_PER_THREAD)
      .toArray();
    if (!docs.length) continue;
    const meta = metaOf.get(threadId);
    out.push({
      threadId,
      group: meta ? !!meta.group : !!docs[0].group,
      name: (meta && typeof meta.name === 'string' && meta.name) || '',
      messages: docs.map((d) => fromRecord(d as Record<string, unknown>)).sort((a, b) => a.at - b.at),
    });
  }
  return out;
}

// ── Dọn kho ─────────────────────────────────────────────────────────────────

/** Xoá tin đã lưu của một tài khoản (hoặc cả kho khi không truyền accountKey). */
export async function purgeArchive(accountKey?: string): Promise<{ messages: number; threads: number }> {
  const mode = await activeMode();
  if (mode === 'off') throw new Error('Chưa bật kho lưu trữ tin.');

  if (mode === 'local') {
    let messages = 0;
    let threads = 0;
    const names = accountKey
      ? [path.basename(localFile(accountKey))]
      : await fs.readdir(LOCAL_DIR).then((ns) => ns.filter((n) => n.endsWith('.jsonl'))).catch(() => []);
    for (const name of names) {
      const file = path.join(LOCAL_DIR, name);
      try {
        const state = await readLocal(accountKey ?? name.replace(/\.jsonl$/, ''));
        for (const byId of state.threads.values()) messages += byId.size;
        threads += state.threads.size;
        await fs.rm(file, { force: true });
      } catch { /* file đã mất thì thôi */ }
    }
    return { messages, threads };
  }

  const filter = accountKey ? { accountKey } : {};
  const m = await (await mongoColl()).deleteMany(filter);
  const t = await (await mongoThreadColl()).deleteMany(filter).catch(() => ({ deletedCount: 0 }));
  return { messages: m.deletedCount ?? 0, threads: t.deletedCount ?? 0 };
}
