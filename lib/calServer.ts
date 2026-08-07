// Server-side CalDAV cho mục LỊCH của tab Mail — Zimbra, và mọi server nói
// CalDAV (Nextcloud, SOGo, Radicale…). Dùng chung tài khoản đã lưu ở
// mailaccounts.json: KHÔNG bắt người dùng nhập lại user/pass.
//
// VÌ SAO KHÔNG DÙNG THƯ VIỆN: CalDAV chỉ là HTTP + vài động từ WebDAV
// (PROPFIND/REPORT/PUT/DELETE) và một mẩu XML. fetch + @xmldom/xmldom (đã có
// sẵn trong deps) là đủ, khỏi thêm dependency mới cho vài request.
//
// iCalendar parse/build cũng tự viết, CHỦ ĐÍCH giữ ở mức "một VEVENT, không
// timezone tự định nghĩa": đủ cho lịch họp nội bộ. Sự kiện lặp (RRULE) được
// ĐỌC và hiện ra, nhưng sửa/xóa là sửa/xóa CẢ CHUỖI — không tách lẻ một buổi.

import { DOMParser } from '@xmldom/xmldom';
import type { MailAccount } from './mailAccounts';
import { getMailAccessToken } from './googleAuth';

// ── Types trả về cho client ────────────────────────────────────────────────

export interface CalCollection {
  /** Đường dẫn tuyệt đối trên server (vd /dav/user@x.com/Calendar). */
  url: string;
  name: string;
  /** Màu server khai (#RRGGBB) — Zimbra có, dùng để tô sự kiện. */
  color?: string;
  /** false = chỉ đọc (lịch được chia sẻ, lịch hệ thống). */
  writable: boolean;
}

export interface CalEvent {
  /** URL tuyệt đối của file .ics — khóa để sửa/xóa. */
  url: string;
  /** Lịch chứa sự kiện này. */
  calendarUrl: string;
  uid: string;
  summary: string;
  location: string;
  description: string;
  /** ISO 8601. Với sự kiện cả ngày là nửa đêm giờ máy chủ app. */
  start: string;
  end: string;
  allDay: boolean;
  organizer?: string;
  attendees: string[];
  /** Chuỗi RRULE thô nếu là sự kiện lặp — UI chỉ hiện nhãn "lặp lại". */
  rrule?: string;
  /** etag để PUT có điều kiện, tránh ghi đè thay đổi của người khác. */
  etag?: string;
}

export interface EventInput {
  summary: string;
  location?: string;
  description?: string;
  /** ISO local (yyyy-MM-ddTHH:mm) hoặc ISO đầy đủ. */
  start: string;
  end: string;
  allDay?: boolean;
  attendees?: string[];
}

// ── HTTP/auth ──────────────────────────────────────────────────────────────

/** Header Authorization cho tài khoản: Basic (password) hoặc Bearer (OAuth). */
async function authHeader(account: MailAccount): Promise<string> {
  if (account.auth === 'oauth') {
    if (!account.googleAccountId) {
      throw new Error('Hòm thư này dùng OAuth nhưng chưa gắn tài khoản Google — kết nối lại.');
    }
    return `Bearer ${await getMailAccessToken(account.googleAccountId)}`;
  }
  return `Basic ${Buffer.from(`${account.user}:${account.pass}`).toString('base64')}`;
}

/**
 * Gốc CalDAV suy ra từ IMAP host: mail.example.com → https://mail.example.com.
 * Đúng với Zimbra (webmail và IMAP cùng host) và phần lớn mail nội bộ. Sai thì
 * người dùng tự khai bằng calDavUrl trên account — xem calRoot().
 */
export function guessCalRoot(account: MailAccount): string {
  const host = account.imap.host.replace(/^imap\./i, '');
  return `https://${host}`;
}

/** Gốc CalDAV thực dùng: URL người dùng tự khai (nếu có) hoặc suy ra từ host. */
function calRoot(account: MailAccount): string {
  const custom = (account as { calDavUrl?: string }).calDavUrl?.trim();
  return (custom || guessCalRoot(account)).replace(/\/+$/, '');
}

/** Ghép path tương đối server trả về thành URL tuyệt đối. */
function abs(root: string, href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  return `${root}${href.startsWith('/') ? '' : '/'}${href}`;
}

async function dav(
  account: MailAccount,
  url: string,
  init: { method: string; body?: string; headers?: Record<string, string> },
): Promise<{ status: number; text: string; etag: string | null }> {
  const res = await fetch(url, {
    method: init.method,
    headers: {
      authorization: await authHeader(account),
      'user-agent': 'VHS-DevBox calendar',
      ...(init.body ? { 'content-type': 'application/xml; charset=utf-8' } : {}),
      ...init.headers,
    },
    body: init.body,
    // Lịch nội bộ đôi khi chậm; 30s là quá đủ cho một PROPFIND/REPORT.
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Server từ chối đăng nhập CalDAV tại ${new URL(url).host} (HTTP ${res.status}). ` +
      'Kiểm tra mật khẩu hòm thư, hoặc khai lại địa chỉ CalDAV nếu webmail không cùng host với IMAP.',
    );
  }
  if (res.status === 404) {
    throw new Error(
      `Không tìm thấy lịch tại ${url} (HTTP 404). ` +
      'Server có thể dùng địa chỉ CalDAV khác — khai lại địa chỉ ở nút ⚙ trong mục Lịch.',
    );
  }
  if (res.status >= 400) {
    throw new Error(`CalDAV ${init.method} ${url} lỗi HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return { status: res.status, text, etag: res.headers.get('etag') };
}

// ── XML helpers ────────────────────────────────────────────────────────────

/** Mọi phần tử có localName cho trước, bất kể namespace prefix (D:/d:/không có). */
function tags(node: { getElementsByTagName(n: string): ArrayLike<Element> }, local: string): Element[] {
  const all = node.getElementsByTagName('*');
  const out: Element[] = [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as Element;
    const name = (el.localName ?? el.nodeName.replace(/^.*:/, '')).toLowerCase();
    if (name === local.toLowerCase()) out.push(el);
  }
  return out;
}

function firstText(el: Element, local: string): string {
  const found = tags(el, local)[0];
  return found?.textContent?.trim() ?? '';
}

function parseXml(text: string): Document {
  // xmldom kêu ra console với XML hơi lệch chuẩn — nuốt cho đỡ ồn, lỗi thật
  // vẫn lộ ra ở bước đọc kết quả (không có <response> nào).
  return new DOMParser({
    onError: () => {},
  }).parseFromString(text, 'text/xml') as unknown as Document;
}

// ── Khám phá lịch ──────────────────────────────────────────────────────────

const PROP_CALENDARS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <d:current-user-privilege-set/>
    <c:supported-calendar-component-set/>
    <cs:calendar-color/>
  </d:prop>
</d:propfind>`;

/**
 * Danh sách lịch của tài khoản. Zimbra đặt mọi lịch dưới /dav/<email>/ nên
 * PROPFIND Depth:1 ở đó là ra hết — không cần chuỗi principal → home-set như
 * CalDAV "chuẩn đủ bộ", vốn tốn thêm 2 request.
 */
export async function listCalendars(account: MailAccount): Promise<CalCollection[]> {
  const root = calRoot(account);
  const home = `${root}/dav/${encodeURIComponent(account.email)}/`;
  const { text } = await dav(account, home, {
    method: 'PROPFIND',
    body: PROP_CALENDARS,
    headers: { depth: '1' },
  });

  const doc = parseXml(text);
  const out: CalCollection[] = [];
  for (const resp of tags(doc.documentElement, 'response')) {
    const href = firstText(resp, 'href');
    if (!href) continue;
    // Chỉ lấy collection là <c:calendar>; bỏ qua thư mục thường, sổ địa chỉ.
    const isCalendar = tags(resp, 'calendar').length > 0;
    if (!isCalendar) continue;
    // Lịch chỉ chứa VTODO (danh sách việc) không thuộc mục này.
    const comps = tags(resp, 'comp').map((c) => c.getAttribute('name')?.toUpperCase());
    if (comps.length > 0 && !comps.includes('VEVENT')) continue;

    const url = abs(root, href);
    const privileges = tags(resp, 'privilege')
      .flatMap((p) => Array.from(p.getElementsByTagName('*')).map((c) => (c as Element).localName ?? ''))
      .map((s) => s.toLowerCase());
    // Không khai privilege = coi như ghi được; server sẽ từ chối lúc PUT nếu không.
    const writable = privileges.length === 0 || privileges.some((p) => p === 'write' || p === 'write-content');

    out.push({
      url,
      name: firstText(resp, 'displayname') || decodeURIComponent(url.replace(/\/$/, '').split('/').pop() ?? 'Lịch'),
      color: firstText(resp, 'calendar-color').slice(0, 7) || undefined,
      writable,
    });
  }
  // Lịch mặc định ("Calendar") lên đầu, còn lại theo tên.
  return out.sort((a, b) => {
    const da = /^calendar$/i.test(a.name) ? 0 : 1;
    const db = /^calendar$/i.test(b.name) ? 0 : 1;
    return da !== db ? da - db : a.name.localeCompare(b.name, 'vi');
  });
}

// ── iCalendar parse ────────────────────────────────────────────────────────

/** Gỡ folding (dòng tiếp nối bắt đầu bằng space/tab) theo RFC 5545. */
function unfold(ics: string): string[] {
  const raw = ics.replace(/\r\n/g, '\n').split('\n');
  const lines: string[] = [];
  for (const line of raw) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  return lines;
}

function unescapeText(v: string): string {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/**
 * DTSTART/DTEND → ISO. Ba dạng gặp thật:
 *   20250807T093000Z      → UTC
 *   20250807T093000       → giờ local (kèm TZID; ta coi là giờ máy chủ app)
 *   20250807               → cả ngày
 * KHÔNG tự dịch TZID sang offset: lịch nội bộ gần như luôn cùng múi giờ với
 * máy đang chạy DevBox, và dịch sai còn tệ hơn không dịch.
 */
function icalDate(value: string): { iso: string; allDay: boolean } {
  const v = value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) {
    const d = new Date(v);
    return { iso: isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(), allDay: false };
  }
  const [, y, mo, d, hh, mm, ss, z] = m;
  if (!hh) {
    return { iso: new Date(Number(y), Number(mo) - 1, Number(d)).toISOString(), allDay: true };
  }
  const iso = z
    ? new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss))).toISOString()
    : new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss)).toISOString();
  return { iso, allDay: false };
}

/** Địa chỉ từ giá trị ORGANIZER/ATTENDEE ("mailto:a@b" → "a@b"). */
function mailtoAddr(v: string): string {
  return v.replace(/^mailto:/i, '').trim();
}

/** VEVENT ĐẦU TIÊN trong một file .ics → CalEvent. Bỏ qua VTIMEZONE/VALARM. */
function parseVEvent(ics: string, url: string, calendarUrl: string, etag?: string): CalEvent | null {
  const lines = unfold(ics);
  let inEvent = false;
  let inAlarm = false;
  const props: Record<string, { params: string; value: string }> = {};
  const attendees: string[] = [];

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:VEVENT')) { inEvent = true; continue; }
    if (upper.startsWith('END:VEVENT')) break;
    // Bên trong VEVENT vẫn có thể có VALARM, và nó cũng có SUMMARY/DESCRIPTION
    // riêng — phải bỏ qua nguyên khối, không thì lời nhắc đè lên tiêu đề sự kiện.
    if (upper.startsWith('BEGIN:VALARM')) { inAlarm = true; continue; }
    if (upper.startsWith('END:VALARM')) { inAlarm = false; continue; }
    if (!inEvent || inAlarm) continue;

    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const semi = head.indexOf(';');
    const name = (semi < 0 ? head : head.slice(0, semi)).toUpperCase();
    const params = semi < 0 ? '' : head.slice(semi + 1);

    if (name === 'ATTENDEE') attendees.push(mailtoAddr(value));
    else props[name] = { params, value };
  }

  const dtstart = props.DTSTART;
  if (!dtstart) return null;

  const startInfo = icalDate(dtstart.value);
  const allDay = startInfo.allDay || /VALUE\s*=\s*DATE(?![-\w])/i.test(dtstart.params);
  const endInfo = props.DTEND
    ? icalDate(props.DTEND.value)
    // Không có DTEND: dùng DURATION nếu có, không thì mặc định 1 tiếng
    // (cả ngày thì +1 ngày) — đủ để vẽ được lên lưới.
    : { iso: new Date(new Date(startInfo.iso).getTime() + (allDay ? 86_400_000 : 3_600_000)).toISOString(), allDay };

  return {
    url,
    calendarUrl,
    uid: props.UID?.value ?? url,
    summary: unescapeText(props.SUMMARY?.value ?? '(không tiêu đề)'),
    location: unescapeText(props.LOCATION?.value ?? ''),
    description: unescapeText(props.DESCRIPTION?.value ?? ''),
    start: startInfo.iso,
    end: endInfo.iso,
    allDay,
    organizer: props.ORGANIZER ? mailtoAddr(props.ORGANIZER.value) : undefined,
    attendees,
    rrule: props.RRULE?.value,
    etag,
  };
}

// ── Đọc sự kiện theo khoảng thời gian ──────────────────────────────────────

/** yyyymmddThhmmssZ — định dạng thời gian của CalDAV filter. */
function utcStamp(d: Date): string {
  return `${d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
}

/**
 * calendar-query REPORT: server tự lọc theo khoảng thời gian và trả luôn
 * calendar-data, nên MỘT request là có đủ sự kiện của tháng — không phải
 * PROPFIND liệt kê rồi GET từng file .ics.
 */
export async function listEvents(
  account: MailAccount,
  calendarUrl: string,
  fromISO: string,
  toISO: string,
): Promise<CalEvent[]> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${utcStamp(new Date(fromISO))}" end="${utcStamp(new Date(toISO))}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

  const { text } = await dav(account, calendarUrl, {
    method: 'REPORT',
    body,
    headers: { depth: '1' },
  });

  const root = calRoot(account);
  const doc = parseXml(text);
  const events: CalEvent[] = [];
  for (const resp of tags(doc.documentElement, 'response')) {
    const href = firstText(resp, 'href');
    const data = firstText(resp, 'calendar-data');
    if (!href || !data) continue;
    const ev = parseVEvent(data, abs(root, href), calendarUrl, firstText(resp, 'getetag') || undefined);
    if (ev) events.push(ev);
  }
  return events.sort((a, b) => a.start.localeCompare(b.start));
}

// ── iCalendar build ────────────────────────────────────────────────────────

function escapeText(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Gấp dòng ở 75 octet theo RFC 5545 — Zimbra chấp nhận dòng dài, nhưng client
 *  khác thì không, và file .ics này có thể bị xuất ra ngoài. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) parts.push(' ' + line.slice(i, i + 74));
  return parts.join('\r\n');
}

const two = (n: number) => String(n).padStart(2, '0');

/** Date → giờ LOCAL dạng iCal (không hậu tố Z) hoặc chỉ ngày. */
function icalStamp(d: Date, dateOnly: boolean): string {
  const ymd = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`;
  return dateOnly ? ymd : `${ymd}T${two(d.getHours())}${two(d.getMinutes())}00`;
}

/**
 * Dựng file .ics một VEVENT. Giữ nguyên UID/RRULE/SEQUENCE khi sửa để server
 * hiểu là CẬP NHẬT sự kiện cũ chứ không phải sự kiện mới trùng giờ.
 */
function buildICS(input: EventInput, uid: string, keep?: { rrule?: string; sequence?: number }): string {
  const start = new Date(input.start);
  const end = new Date(input.end);
  const allDay = !!input.allDay;
  const dtParam = allDay ? ';VALUE=DATE' : '';
  // Sự kiện cả ngày: DTEND là ngày KẾ TIẾP ngày cuối (RFC 5545 dùng khoảng nửa
  // mở) — thiếu +1 ngày là lịch hiện thiếu mất ngày cuối.
  const endStamp = allDay
    ? icalStamp(new Date(end.getTime() + 86_400_000), true)
    : icalStamp(end, false);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//VHS DevBox//Calendar//VI',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    `DTSTART${dtParam}:${icalStamp(start, allDay)}`,
    `DTEND${dtParam}:${endStamp}`,
    `SUMMARY:${escapeText(input.summary || '(không tiêu đề)')}`,
    input.location ? `LOCATION:${escapeText(input.location)}` : '',
    input.description ? `DESCRIPTION:${escapeText(input.description)}` : '',
    keep?.rrule ? `RRULE:${keep.rrule}` : '',
    // SEQUENCE tăng mỗi lần sửa — client của người được mời mới nhận ra bản mới.
    `SEQUENCE:${(keep?.sequence ?? 0) + (keep ? 1 : 0)}`,
    ...(input.attendees ?? [])
      .map((a) => a.trim())
      .filter(Boolean)
      .map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a}`),
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);

  return lines.map(fold).join('\r\n') + '\r\n';
}

// ── Tạo / sửa / xóa ────────────────────────────────────────────────────────

/** UID mới — phần domain lấy từ email để nhìn log biết nguồn. */
function newUid(account: MailAccount): string {
  const rand = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `devbox-${rand}@${account.email.split('@')[1] ?? 'devbox'}`;
}

export async function createEvent(
  account: MailAccount,
  calendarUrl: string,
  input: EventInput,
): Promise<CalEvent> {
  const uid = newUid(account);
  const url = `${calendarUrl.replace(/\/$/, '')}/${encodeURIComponent(uid)}.ics`;
  const ics = buildICS(input, uid);
  const { etag } = await dav(account, url, {
    method: 'PUT',
    body: ics,
    // If-None-Match: * = chỉ tạo mới, không đè lên file trùng tên.
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'if-none-match': '*' },
  });
  return parseVEvent(ics, url, calendarUrl, etag ?? undefined)!;
}

/** Đọc lại .ics hiện tại để giữ UID/RRULE/SEQUENCE khi sửa. */
async function fetchRaw(account: MailAccount, url: string): Promise<string> {
  const { text } = await dav(account, url, { method: 'GET' });
  return text;
}

/**
 * Sửa sự kiện. Sự kiện LẶP thì sửa cả chuỗi (giữ nguyên RRULE) — không tách
 * riêng một buổi; muốn thế thì mở webmail.
 */
export async function updateEvent(
  account: MailAccount,
  url: string,
  calendarUrl: string,
  input: EventInput,
): Promise<CalEvent> {
  const old = await fetchRaw(account, url);
  const lines = unfold(old);
  const pick = (name: string) => {
    const hit = lines.find((l) => l.toUpperCase().startsWith(`${name}:`) || l.toUpperCase().startsWith(`${name};`));
    return hit ? hit.slice(hit.indexOf(':') + 1) : undefined;
  };
  const uid = pick('UID') ?? newUid(account);
  const ics = buildICS(input, uid, {
    rrule: pick('RRULE'),
    sequence: Number(pick('SEQUENCE') ?? 0) || 0,
  });
  const { etag } = await dav(account, url, {
    method: 'PUT',
    body: ics,
    headers: { 'content-type': 'text/calendar; charset=utf-8' },
  });
  return parseVEvent(ics, url, calendarUrl, etag ?? undefined)!;
}

export async function deleteEvent(account: MailAccount, url: string): Promise<void> {
  await dav(account, url, { method: 'DELETE' });
}

/** Chỉ để kiểm thử phần thuần logic (parse/build iCal) — không dùng ở app. */
export const __test = { parseVEvent, buildICS, icalDate };
