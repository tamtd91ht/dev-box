// Per-machine store cho LỊCH SỬ TRUY CẬP của tab Browser — mỗi trang đã xem
// được ghi lại (URL, tiêu đề, số lần vào, lần cuối) để ô địa chỉ GỢI Ý được
// như trình duyệt thật, khỏi phải gõ mò lại cả địa chỉ dài.
//
// Tách khỏi bookmarkStore: dấu trang là thứ người dùng CHỦ ĐỘNG lưu và sửa
// (tên riêng, thư mục, mật khẩu), còn lịch sử tự sinh, chỉ-đọc với người dùng
// và bị cắt bớt khi quá dài. Trộn hai loại vào một file thì mỗi lần dọn lịch
// sử lại phải cẩn thận đừng chạm vào dấu trang.
//
// MỘT BẢN GHI = MỘT URL (khoá theo `urlKey` bỏ hash + bỏ '/' cuối). Vào lại
// cùng trang thì tăng `visitCount` và dời `lastVisit`, KHÔNG thêm dòng mới:
// gợi ý cần "mỗi địa chỉ một dòng, hay vào thì lên trên", chứ không phải một
// dòng cho từng lần bấm.

import { promises as fs } from 'fs';
import path from 'path';
import { configPath } from './configDir';

export interface HistoryEntry {
  /** URL đầy đủ, đã chuẩn hoá (bỏ hash, bỏ '/' cuối của path gốc). */
  url: string;
  /** Tiêu đề trang lần cuối thấy — rỗng nếu chưa kịp bắt được. */
  title: string;
  /** host để gợi ý khớp theo tên miền và để nhóm/dọn theo site. */
  host: string;
  visitCount: number;
  /** ISO — lần vào gần nhất. */
  lastVisit: string;
  /** ISO — lần vào đầu tiên. */
  firstVisit: string;
}

const HIST_PATH = process.env.BROWSER_HISTORY_PATH
  ? path.resolve(process.cwd(), process.env.BROWSER_HISTORY_PATH)
  : configPath('browser-history.json');

/** Trần số bản ghi. Vượt thì bỏ các mục CŨ NHẤT (theo lastVisit) — file lịch
 *  sử phình vô hạn sẽ làm mỗi lần gõ một chữ phải đọc/ghi cả megabyte. */
const MAX_ENTRIES = 5000;

/** Bao nhiêu gợi ý trả về nếu caller không nói. */
const DEFAULT_LIMIT = 8;

/**
 * Khoá so trùng của một URL.
 *
 * Bỏ dấu '/' cuối, vì "example.com/a" và "example.com/a/" là cùng một trang
 * nhưng nếu tính là hai dòng thì danh sách gợi ý đầy các cặp trùng nhau.
 *
 * Hash thì BỎ, TRỪ KHI nó trông như một route (`#/...`): Kibana, Grafana bản
 * cũ, nhiều admin panel đặt cả đường dẫn trong hash — cắt đi thì mọi trang của
 * cả site gộp thành một dòng và gợi ý trở nên vô dụng. Còn `#section` thường
 * chỉ là mục lục trong cùng một trang, giữ lại là sinh ra hàng loạt dòng trùng.
 */
export function urlKey(raw: string): string {
  try {
    const u = new URL(raw);
    const keepHash = /^#\/./.test(u.hash) ? u.hash : '';
    const pathPart = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : '';
    return `${u.protocol}//${u.host}${pathPart}${u.search}${keepHash}`;
  } catch {
    return raw.trim().replace(/\/+$/, '');
  }
}

function hostOf(raw: string): string {
  try { return new URL(raw).host; } catch { return ''; }
}

async function readAll(): Promise<HistoryEntry[]> {
  try {
    const d = JSON.parse(await fs.readFile(HIST_PATH, 'utf8')) as { history?: Partial<HistoryEntry>[] };
    const raw = Array.isArray(d.history) ? d.history : [];
    const zero = new Date(0).toISOString();
    return raw
      .filter((e): e is Partial<HistoryEntry> & { url: string } => typeof e?.url === 'string' && !!e.url)
      .map((e) => ({
        url: e.url,
        title: typeof e.title === 'string' ? e.title : '',
        host: typeof e.host === 'string' && e.host ? e.host : hostOf(e.url),
        visitCount: typeof e.visitCount === 'number' && e.visitCount > 0 ? e.visitCount : 1,
        lastVisit: typeof e.lastVisit === 'string' ? e.lastVisit : zero,
        firstVisit: typeof e.firstVisit === 'string' ? e.firstVisit
          : (typeof e.lastVisit === 'string' ? e.lastVisit : zero),
      }));
  } catch { return []; }
}

async function writeAll(history: HistoryEntry[]): Promise<void> {
  await fs.writeFile(HIST_PATH, JSON.stringify({ history }, null, 2), 'utf8');
}

/**
 * Ghi một lần truy cập.
 *
 * Bỏ qua thứ không đáng vào lịch sử: URL không phải http(s) (about:blank,
 * data:, chrome-error: khi trang lỗi) và trang tìm kiếm Google do chính ô địa
 * chỉ sinh ra khi người dùng gõ TỪ KHÓA — gợi ý lại chính câu tìm kiếm cũ dưới
 * dạng một URL google.com/search dài loằng ngoằng thì vừa rối vừa không ai bấm.
 *
 * @param title Tiêu đề trang; rỗng = giữ tiêu đề đang có (điều hướng bắn sự
 *        kiện trước khi <title> kịp cập nhật, ghi rỗng vào là XOÁ tiêu đề tốt
 *        đã lưu từ lần trước).
 */
export async function recordVisit(rawUrl: string, title = ''): Promise<HistoryEntry | null> {
  const url = urlKey(rawUrl);
  if (!/^https?:\/\//i.test(url)) return null;
  if (/^https?:\/\/(www\.)?google\.[a-z.]+\/search\b/i.test(url)) return null;

  const list = await readAll();
  const now = new Date().toISOString();
  const found = list.find((e) => e.url === url);

  let entry: HistoryEntry;
  if (found) {
    found.visitCount += 1;
    found.lastVisit = now;
    if (title.trim()) found.title = title.trim();
    if (!found.host) found.host = hostOf(url);
    entry = found;
  } else {
    entry = {
      url, title: title.trim(), host: hostOf(url),
      visitCount: 1, lastVisit: now, firstVisit: now,
    };
    list.push(entry);
  }

  // Cắt bớt khi quá trần: giữ các mục vào gần đây nhất.
  let out = list;
  if (out.length > MAX_ENTRIES) {
    out = [...out].sort((a, b) => b.lastVisit.localeCompare(a.lastVisit)).slice(0, MAX_ENTRIES);
  }
  await writeAll(out);
  return entry;
}

/** Cập nhật RIÊNG tiêu đề của một URL đã có — trang load xong mới có <title>. */
export async function recordTitle(rawUrl: string, title: string): Promise<void> {
  const t = title.trim();
  if (!t) return;
  const url = urlKey(rawUrl);
  const list = await readAll();
  const found = list.find((e) => e.url === url);
  if (!found || found.title === t) return;
  found.title = t;
  await writeAll(list);
}

/** Toàn bộ lịch sử, mới nhất trước — cho bảng "Lịch sử". */
export async function listHistory(limit = 200, query = ''): Promise<HistoryEntry[]> {
  const q = query.trim().toLowerCase();
  const list = await readAll();
  const hit = q
    ? list.filter((e) => e.url.toLowerCase().includes(q) || e.title.toLowerCase().includes(q))
    : list;
  return hit.sort((a, b) => b.lastVisit.localeCompare(a.lastVisit)).slice(0, Math.max(1, limit));
}

/**
 * Điểm xếp hạng một mục với câu đang gõ — quyết định thứ tự gợi ý.
 *
 * Ba yếu tố, đúng thứ tự ưu tiên của trình duyệt:
 *  1. KHỚP Ở ĐÂU. Gõ "kib" thì "kibana.noc..." phải đứng trên một trang nào đó
 *     có chữ "kib" lẫn giữa query string. Khớp từ đầu host ăn điểm cao nhất,
 *     rồi đến đầu URL, rồi khớp giữa host/tiêu đề, cuối cùng là khớp bất kỳ.
 *  2. HAY VÀO (visitCount) — nhưng lấy log để trang vào 100 lần không đè chết
 *     mọi kết quả khớp sát hơn.
 *  3. VÀO GẦN ĐÂY — nửa đời 7 ngày, để địa chỉ của việc đang làm nổi lên trên
 *     những trang từng hay vào nhưng đã cũ.
 */
function score(e: HistoryEntry, q: string): number {
  const url = e.url.toLowerCase();
  const host = e.host.toLowerCase();
  const title = e.title.toLowerCase();
  // Bỏ scheme + "www." khi so đầu chuỗi: người dùng gõ "gitlab", không ai gõ
  // "https://" trước.
  const bare = url.replace(/^https?:\/\//, '').replace(/^www\./, '');

  let where: number;
  if (host.replace(/^www\./, '').startsWith(q)) where = 100;
  else if (bare.startsWith(q)) where = 80;
  else if (title.startsWith(q)) where = 70;
  else if (host.includes(q)) where = 50;
  else if (title.includes(q)) where = 40;
  else if (url.includes(q)) where = 20;
  else return -1; // không khớp

  const freq = Math.log2(e.visitCount + 1) * 8;

  const ageDays = (Date.now() - Date.parse(e.lastVisit)) / 86_400_000;
  const recency = Number.isFinite(ageDays) ? 30 * Math.pow(0.5, Math.max(0, ageDays) / 7) : 0;

  return where + freq + recency;
}

/**
 * Gợi ý cho ô địa chỉ.
 *
 * Câu rỗng → các trang vào GẦN ĐÂY nhất (bấm vào ô địa chỉ chưa gõ gì đã có
 * sẵn danh sách để chọn, như Chrome).
 */
export async function suggest(query: string, limit = DEFAULT_LIMIT): Promise<HistoryEntry[]> {
  const q = query.trim().toLowerCase();
  const list = await readAll();
  const n = Math.max(1, Math.min(limit, 20));

  if (!q) {
    return [...list]
      .sort((a, b) => b.lastVisit.localeCompare(a.lastVisit))
      .slice(0, n);
  }

  return list
    .map((e) => ({ e, s: score(e, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || b.e.lastVisit.localeCompare(a.e.lastVisit))
    .slice(0, n)
    .map((x) => x.e);
}

/** Xoá một địa chỉ khỏi lịch sử (Shift+Delete trên gợi ý, như trình duyệt). */
export async function removeHistory(rawUrl: string): Promise<void> {
  const url = urlKey(rawUrl);
  const list = await readAll();
  const next = list.filter((e) => e.url !== url);
  if (next.length !== list.length) await writeAll(next);
}

/** Xoá cả site (mọi trang cùng host) — dọn nhanh khỏi phải xoá từng dòng. */
export async function removeHistoryHost(host: string): Promise<void> {
  const h = host.trim().toLowerCase();
  if (!h) return;
  const list = await readAll();
  const next = list.filter((e) => e.host.toLowerCase() !== h);
  if (next.length !== list.length) await writeAll(next);
}

/** Xoá toàn bộ lịch sử. */
export async function clearHistory(): Promise<void> {
  await writeAll([]);
}
