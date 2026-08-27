// Zalo API (thử nghiệm) — listener WebSocket server-side, port từ zca-js.
//
// Đây là nửa NHẬN tin của Đường B: mở wss:// từ Node (không phải webview), lấy
// cipherKey từ khung handshake, giải mã các khung tin bằng AES-GCM
// (decodeEventData), rồi gọi onMessage cho tầng trên đẩy vào automation.
//
// ⚠ zca-js cảnh báo: MỘT listener/tài khoản. Nếu webview vẫn mở Zalo Web thì hai
// bên tranh socket → phải nhả webview sau khi lấy cookie (đã chốt trong thiết kế).
//
// GIAO THỨC KHUNG (nhị phân) — port chính xác:
//   4 byte đầu: [version:u8][cmd:u16 LE (đọc từ offset 1)][subCmd:u8 @ offset 3]
//   phần sau  : JSON UTF-8
// cipherKey đến ở khung version=1,cmd=1,subCmd=1 (field `key`) — KHÁC secretKey.
// cmd 501 = tin cá nhân, 521 = tin nhóm.

import WebSocket from 'ws';
import { decodeEventData } from './crypto';
import { scanFileDone } from './uploadHub';
import { trace } from './trace';
import { API_TYPE, API_VERSION, type ZaloContext } from './client';

/** Một tin nhận được, đã chuẩn hoá tối thiểu cho tầng trên. */
export interface IncomingMessage {
  /** Thời điểm nhận (epoch ms). */
  at: number;
  group: boolean;
  /**
   * threadId thật — cái để GOM tin theo hội thoại và để GỬI trả lời:
   *   nhóm            → groupId
   *   cá nhân, tin đến → uid người gửi (uidFrom)
   *   cá nhân, tin MÌNH gửi (Zalo phản hồi về) → uid người nhận (idTo)
   * Nhờ tính đúng cho cả tin của chính mình, màn chat gom được hai chiều vào
   * cùng một hội thoại thay vì tách tin mình gửi ra một "hội thoại" riêng.
   */
  threadId: string;
  /** uid người gửi. */
  fromId: string;
  /** uid người nhận (idTo) — cần để định threadId cho tin mình gửi. */
  toId: string;
  /** Tin này do CHÍNH tài khoản đang đăng nhập gửi (fromId === uid). */
  isSelf: boolean;
  /** id tin (nếu payload có) — để khử trùng echo với tin gửi lạc quan. */
  msgId: string;
  /**
   * ID THẬT của Zalo, tách riêng khỏi `msgId` (vốn nhận cả cliMsgId làm bản dự
   * phòng để khử trùng). Thả cảm xúc cần ĐÚNG hai id này ở dạng số:
   *   realMsgId/msgId → gMsgID   ·   cliMsgId → cMsgID
   * Gộp chung rồi đoán là nguyên nhân cảm xúc gửi đi mà Zalo im lặng bỏ qua.
   */
  zMsgId: string;
  zCliMsgId: string;
  /** Tên hiển thị người gửi (nếu payload có). */
  fromName: string;
  /**
   * Tin GỐC mà tin này TRẢ LỜI (khối trích dẫn), nếu có.
   *
   * Không có phần này thì tin người khác trả lời ta hiện ra như một câu rời
   * khỏi ngữ cảnh — đọc "ok em làm rồi" mà không biết đang nói về việc gì.
   */
  quote?: { msgId: string; fromName: string; text: string };
  /** Nội dung văn bản. */
  text: string;
  /**
   * CẢM XÚC (reaction) thay vì tin thường. Có giá trị thì `text` KHÔNG phải nội
   * dung tin mà là mô tả ngắn để ghi log — tầng trên phải xử theo nhánh riêng
   * (gắn cảm xúc vào tin đích `targetMsgId`), đừng dựng bong bóng chat mới.
   */
  reaction?: {
    /** msgId của tin BỊ thả cảm xúc. */
    targetMsgId: string;
    /** rIcon Zalo gửi về, vd '/-heart'. Rỗng nghĩa là BỎ cảm xúc. */
    icon: string;
    rType: number;
    /** true = chính ta vừa thả (đồng bộ từ thiết bị khác). */
    isSelf: boolean;
  };
  /** Payload thô đã giải mã — để chẩn đoán / mở rộng sau. */
  raw: unknown;
}

type OnMessage = (msg: IncomingMessage) => void;
type OnState = (state: ListenerState, detail: string) => void;

export type ListenerState = 'connecting' | 'open' | 'ready' | 'closed' | 'error';

const DEFAULT_PING_MS = 180_000;

/** Đọc header 4 byte — port getHeader của zca-js (cmd = readUInt16LE(1)). */
function getHeader(buf: Buffer): [number, number, number] {
  return [buf[0], buf.readUInt16LE(1), buf[3]];
}

/** Đọc một trường chuỗi/số từ object, thử lần lượt nhiều tên khoá. */
function pickStr(m: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = m[k];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  }
  return '';
}

/**
 * Rút NỘI DUNG VĂN BẢN từ một object tin. Zalo để text ở `content` khi là tin
 * thường (string), nhưng tin có kèm (ảnh/file/link) thì `content` là OBJECT
 * `{ title, description, ... }` — khi đó lấy `title`. Trả '' nếu không có chữ
 * (ảnh trần, typing, seen…) để tầng trên bỏ qua.
 */
function pickText(m: Record<string, unknown>): string {
  const c = m['content'];
  if (typeof c === 'string' && c) {
    // `content` có thể là JSON ĐÃ ĐÓNG GÓI của một sự kiện (cảm xúc, thu hồi,
    // sự kiện nhóm…). Trả nguyên chuỗi đó ra làm "nội dung tin" thì màn chat
    // hiện một bong bóng chứa JSON thô — rác, và Automation còn khớp rule theo
    // nó. Đã gặp đúng ca này: một khung cảm xúc thiếu `rMsg` (không biết tin
    // đích) rơi xuống đây và hiện thành tin `{"rIcon":"/-heart",...}`.
    //
    // Nên: chuỗi trông như JSON object thì thử bóc lấy chữ THẬT bên trong
    // (title/text/description — dạng tin có kèm), không có thì coi như KHÔNG CÓ
    // CHỮ để tầng trên bỏ qua. Tin chat bình thường không bao giờ bắt đầu bằng
    // '{' nên không mất tin thật.
    const s = c.trim();
    if (s.startsWith('{')) {
      try {
        const parsed = JSON.parse(s) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const inner = parsed as Record<string, unknown>;
          const t = pickStr(inner, 'title', 'text', 'description');
          if (t) return t;
          // Không có chữ nào bên trong → đây là payload sự kiện, không phải tin.
          return '';
        }
      } catch {
        // KHÔNG parse được → người ta thật sự gõ một chuỗi bắt đầu bằng '{'
        // (vd dán một đoạn JSON hỏng, hay chat về code). Đó là tin thật, giữ.
      }
    }
    return c;
  }
  if (c && typeof c === 'object') {
    const t = pickStr(c as Record<string, unknown>, 'title', 'text', 'description');
    if (t) return t;
  }
  return pickStr(m, 'message', 'msg', 'body');
}

/**
 * Nhận diện một khung CẢM XÚC (reaction) và rút ra tin đích + mặt đã thả.
 *
 * Zalo gói cảm xúc y như một "tin" nhưng nội dung là JSON LỒNG trong `content`:
 *   content: '{"rMsg":[{"gMsgID":"123","cMsgID":"456"}],"rIcon":"/-heart","rType":5}'
 * Có bản build để `content` là object luôn (không phải chuỗi), nên thử cả hai.
 * Đặc trưng nhận dạng là có `rIcon`/`rType` + mảng `rMsg` — không dựa vào số cmd
 * vì cmd của Zalo đổi theo bản build (đã bị bỏ sót một lần vì tin đi qua cmd 621).
 *
 * `rType: -1` (hoặc rIcon rỗng) = người ta BỎ cảm xúc đã thả.
 */
function pickReaction(m: Record<string, unknown>): { targetMsgId: string; icon: string; rType: number } | null {
  let c: unknown = m['content'];
  if (typeof c === 'string') {
    const s = c.trim();
    // Chỉ thử parse khi trông như JSON — tin thường cũng là string, đừng parse bừa.
    if (!s.startsWith('{')) return null;
    try { c = JSON.parse(s); } catch { return null; }
  }
  // Phần tử lấy từ kho `reacts`/`reactGroups` (cmd 612) mang rIcon/rType NGAY Ở
  // CẤP GỐC, không gói trong `content` như khung tin. Cùng một sự kiện, hai
  // đường vận chuyển — nhận cả hai thay vì bỏ mất một nửa số cảm xúc.
  if ((!c || typeof c !== 'object') && ('rIcon' in m || 'rType' in m)) c = m;
  if (!c || typeof c !== 'object') return null;
  const obj = c as Record<string, unknown>;
  const hasIcon = 'rIcon' in obj;
  const hasType = 'rType' in obj;
  if (!hasIcon && !hasType) return null;

  const rMsg = obj['rMsg'];
  const first = Array.isArray(rMsg) && rMsg.length && rMsg[0] && typeof rMsg[0] === 'object'
    ? (rMsg[0] as Record<string, unknown>)
    : null;
  // Tin đích: ưu tiên id server (gMsgID), rơi về id client. Không có `rMsg` thì
  // tìm ngay trên chính object — dạng đến từ kho `reacts` để id đích ở cấp gốc.
  const targetMsgId = first
    ? pickStr(first, 'gMsgID', 'gMsgId', 'cMsgID', 'cMsgId')
    : pickStr(obj, 'gMsgID', 'gMsgId', 'cMsgID', 'cMsgId', 'msgId', 'globalMsgId');
  if (!targetMsgId) return null; // không biết thả vào tin nào → vô dụng, bỏ

  const rTypeRaw = Number(obj['rType']);
  return {
    targetMsgId,
    icon: typeof obj['rIcon'] === 'string' ? obj['rIcon'] : '',
    rType: Number.isFinite(rTypeRaw) ? rTypeRaw : -1,
  };
}

/**
 * Rút khối TRÍCH DẪN của một tin trả lời.
 *
 * Zalo để nó trong `content` dưới nhiều tên tuỳ bản build — `qmsg` (payload gửi
 * đi) hoặc `quote`/`quotedMsg` (payload nhận về), và phần chữ có khi nằm ở
 * `qmsg`, có khi ở `msg`/`title`. Nhận hết thay vì bám một tên: sai tên thì
 * khối trích dẫn im lặng biến mất, y như lỗi từng gặp với `groupMsgs`.
 */
function pickQuote(m: Record<string, unknown>): { msgId: string; fromName: string; text: string } | undefined {
  // Khối quote có thể ở CẤP TIN (m.quote) hoặc trong `content`. Bản build hiện
  // tại đặt ở đâu thì chưa chắc — nhận cả hai thay vì bám một chỗ.
  //
  // Quan trọng: tin trả lời vẫn là tin VĂN BẢN, nên `content` thường là CHUỖI
  // thuần chứ không phải JSON. Bản trước thoát ngay khi content không bắt đầu
  // bằng '{' và bỏ lọt toàn bộ ca đó — đúng triệu chứng "gửi thì có quote, nhận
  // thì không".
  const roots: Record<string, unknown>[] = [];

  const atMsg = m['quote'] ?? m['quotedMsg'] ?? m['qmsg'];
  if (atMsg && typeof atMsg === 'object') roots.push(atMsg as Record<string, unknown>);
  // Dạng phẳng ngay trên tin: qmsgId/qmsgOwner… nằm cạnh msgId.
  if ('qmsgId' in m || 'qmsgOwner' in m) roots.push(m);

  let c: unknown = m['content'];
  if (typeof c === 'string' && c.trim().startsWith('{')) {
    try { c = JSON.parse(c.trim()); } catch { c = null; }
  }
  if (c && typeof c === 'object') {
    const obj = c as Record<string, unknown>;
    const nested = obj['quote'] ?? obj['quotedMsg'];
    if (nested && typeof nested === 'object') roots.push(nested as Record<string, unknown>);
    roots.push(obj);
  }

  for (const q of roots) {
    const msgId = pickStr(q, 'globalMsgId', 'qmsgId', 'gMsgID', 'gMsgId', 'msgId', 'cMsgID', 'cliMsgId');
    const text = pickStr(q, 'qmsg', 'msg', 'title', 'text', 'content', 'qmsgContent');
    // Cần ÍT NHẤT id — chỉ có chữ thì không phân biệt được với chính nội dung
    // tin, và dựng khối trích dẫn từ đó là bịa ra một tin gốc không tồn tại.
    if (!msgId) continue;
    return {
      msgId,
      fromName: pickStr(q, 'ownerName', 'qmsgOwnerName', 'dName', 'fromName'),
      text: text.slice(0, 300),
    };
  }
  return undefined;
}

/**
 * Ghi hình dạng một tin CHƯA rút được quote, để dò tiếp khi bản build đổi tên
 * field. Chỉ ghi TÊN KHOÁ, không ghi giá trị — trace nằm trên đĩa và nội dung
 * tin là dữ liệu riêng tư của người dùng.
 */
function quoteShape(m: Record<string, unknown>): Record<string, unknown> {
  const c = m['content'];
  let contentKeys: unknown = typeof c;
  if (typeof c === 'string') {
    contentKeys = c.trim().startsWith('{') ? 'json-string' : 'plain-string';
  } else if (c && typeof c === 'object') {
    contentKeys = Object.keys(c as object).slice(0, 20);
  }
  return { msgKeys: Object.keys(m).slice(0, 25), contentKeys };
}

/**
 * Lôi TẤT CẢ tin văn bản ra khỏi payload đã giải mã, chịu được nhiều schema.
 *
 * Trước đây chỉ lấy tin CUỐI của khung và quyết group bằng số cmd (501/521).
 * Bản build hiện tại đẩy tin qua cmd khác (thấy 621 trong trace) nên lọc theo
 * cmd là bỏ sót. Nay: quét mọi tin trong khung, và suy NHÓM/CÁ NHÂN theo PAYLOAD
 * (có groupId/gid → nhóm) — số cmd chỉ còn là gợi ý.
 *
 * `selfUid` để nhận ra tin do CHÍNH mình gửi (Zalo phản hồi tin của ta về các
 * phiên khác): khi đó threadId phải là người NHẬN (idTo), không phải người gửi.
 *
 * Export vì đây là hàm THUẦN (không phụ thuộc socket) nên test được trực tiếp.
 */
export function extractMessages(groupHint: boolean, decoded: unknown, at: number, selfUid: string): IncomingMessage[] {
  const root = decoded as Record<string, unknown> | null;
  if (!root) return [];

  // Bóc lớp bọc {error_code, error_message, data} cho tới khi hết. Zalo lồng
  // MỘT tầng ở hầu hết cmd, nhưng cmd 621 lồng HAI — đi đúng một tầng thì payload
  // thật vẫn nằm sâu bên trong và mọi thứ rơi vào nhánh "không phải tin".
  let core: Record<string, unknown> = root;
  for (let depth = 0; depth < 4; depth += 1) {
    const inner = core['data'];
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) break;
    const obj = inner as Record<string, unknown>;
    // Chỉ bóc tiếp khi tầng này ĐÚNG LÀ lớp bọc (có error_code/error_message).
    // Bóc bừa sẽ ăn mất một object tin thật có field `data` của riêng nó.
    if (!('error_code' in obj) && !('error_message' in obj)) { core = obj; break; }
    core = obj;
  }

  // Gom MỌI kho tin trong payload. Đây là chỗ từng bỏ lọt cả ba thứ:
  //
  //   msgs        tin 1-1                      (cmd 501, và 502 khi đồng bộ)
  //   groupMsgs   tin NHÓM                     (cmd 521, 502)  ← từng bỏ lọt
  //   pageMsgs    tin từ Official Account
  //   reacts      CẢM XÚC 1-1                  (cmd 612)       ← từng bỏ lọt
  //   reactGroups CẢM XÚC trong nhóm           (cmd 612)       ← từng bỏ lọt
  //
  // Trước đây chỉ đọc `msgs`; với cmd 502/521 thì `msgs` là mảng RỖNG còn tin
  // thật nằm ở `groupMsgs`, nên hàm rơi xuống nhánh "coi cả object là một tin"
  // và bỏ đi — đúng triệu chứng "tin nhóm và tin từ mobile không hiện".
  const bucket = (key: string): unknown[] => {
    const v = core[key];
    return Array.isArray(v) ? v : [];
  };
  const plain = [...bucket('msgs'), ...bucket('groupMsgs'), ...bucket('pageMsgs')];
  // Cảm xúc đi kho RIÊNG, và mỗi phần tử ở đây LUÔN là reaction — không phải
  // tin có kèm reaction. Đánh dấu để vòng dưới không đòi hỏi nội dung chữ.
  const reactItems = [...bucket('reacts'), ...bucket('reactGroups')];
  const fromGroupBucket = new Set<unknown>([...bucket('groupMsgs'), ...bucket('reactGroups')]);

  let list: unknown[];
  if (plain.length || reactItems.length) list = [...plain, ...reactItems];
  else if (Array.isArray(core['data'])) list = core['data'] as unknown[];
  else list = [core];

  const out: IncomingMessage[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const react = pickReaction(m);
    const text = pickText(m);
    // Không có chữ VÀ cũng không phải cảm xúc → bỏ (ảnh trần/typing/seen…).
    // Trước đây chỉ xét chữ, nên mọi khung cảm xúc bị rơi ở đúng dòng này.
    if (!text && !react) continue;

    // Tin nằm trong kho groupMsgs/reactGroups thì CHẮC CHẮN là nhóm, kể cả khi
    // payload không mang groupId (khung reaction nhóm thường không có). Dựa mỗi
    // groupId là tin nhóm bị xếp nhầm thành 1-1 và tạo hội thoại rác.
    const groupId = pickStr(m, 'groupId', 'gid');
    const group = groupHint || !!groupId || fromGroupBucket.has(item);
    const fromId = pickStr(m, 'uidFrom', 'fromId');
    const toId = pickStr(m, 'idTo', 'toId', 'toUid', 'dId');
    // Zalo đánh dấu tin do CHÍNH mình gửi (đồng bộ từ thiết bị khác) bằng
    // uidFrom = "0" (nghĩa là "tôi"), KHÔNG phải uid thật. Không nhận ra thì tin
    // mình gửi bị coi là tin đến, sinh hội thoại rác threadId "0" tách khỏi luồng
    // thật của người kia — đúng lỗi "một người thành hai dòng".
    const isSelf = fromId === '0' || (!!selfUid && fromId === selfUid);
    // 1-1 luôn khoá hội thoại theo UID NGƯỜI KIA: tin đến → người gửi (fromId),
    // tin mình gửi → người nhận (toId). Nhờ vậy hai chiều gom về một threadId.
    const threadId = group ? (groupId || toId) : (isSelf ? toId : fromId);
    if (!threadId || threadId === '0') continue; // không định được hội thoại → bỏ

    out.push({
      at,
      group,
      threadId,
      fromId,
      toId,
      isSelf,
      msgId: pickStr(m, 'msgId', 'msgID', 'cliMsgId', 'clientMsgId', 'realMsgId'),
      // Hai id THẬT, KHÔNG lẫn nhau: msgId/realMsgId là id server (gMsgID),
      // cliMsgId là id client (cMsgID). Thiếu cái nào thì để rỗng, đừng mượn
      // cái kia — mượn sai chỗ là Zalo tra không ra và bỏ qua im lặng.
      zMsgId: pickStr(m, 'msgId', 'msgID', 'realMsgId', 'globalMsgId'),
      zCliMsgId: pickStr(m, 'cliMsgId', 'clientMsgId'),
      fromName: pickStr(m, 'dName', 'fromName', 'senderName'),
      // Cảm xúc không có nội dung → dựng một dòng mô tả để Console đọc được.
      text: text || (react ? (react.icon ? `đã thả ${react.icon}` : 'đã bỏ cảm xúc') : ''),
      ...(() => {
        // Chỉ tin THẬT mới có trích dẫn; khung cảm xúc dùng chung `content` cho
        // payload riêng của nó nên đừng đọc nhầm thành quote.
        const q = react ? undefined : pickQuote(m);
        return q ? { quote: q } : {};
      })(),
      ...(react ? { reaction: { ...react, isSelf } } : {}),
      raw: m,
    });
  }
  return dropBroadcastDuplicates(out);
}

/**
 * Mô tả HÌNH DẠNG một payload đã giải mã, để chẩn đoán khung chưa đọc được.
 *
 * Bóc qua lớp bọc {error_code,error_message,data} rồi mô tả phần lõi: khoá gì,
 * mảng hay object, và một mẫu khoá của phần tử đầu. Không ghi NỘI DUNG tin —
 * trace nằm trên đĩa và tin nhắn là dữ liệu riêng tư của người dùng.
 */
function probeShape(decoded: unknown): Record<string, unknown> {
  const outer = decoded && typeof decoded === 'object' ? (decoded as Record<string, unknown>) : null;
  if (!outer) return { type: typeof decoded };
  const inner = outer['data'];
  const describe = (v: unknown): Record<string, unknown> => {
    if (Array.isArray(v)) {
      const first = v[0];
      return {
        kind: 'array',
        len: v.length,
        itemKeys: first && typeof first === 'object' ? Object.keys(first as object).slice(0, 20) : typeof first,
      };
    }
    if (v && typeof v === 'object') return { kind: 'object', keys: Object.keys(v as object).slice(0, 20) };
    return { kind: typeof v };
  };
  return {
    outerKeys: Object.keys(outer).slice(0, 8),
    errorCode: outer['error_code'],
    data: describe(inner),
  };
}

/**
 * Gộp THÔNG BÁO HỆ THỐNG bị Zalo phát tán ra nhiều hội thoại trong CÙNG một khung.
 *
 * Ca thật: bạn bấm đồng ý kết bạn → Zalo gửi MỘT khung chứa BA object tin cùng
 * nội dung "… đã đồng ý kết bạn", mỗi cái trỏ một hội thoại (người đó, một nhóm
 * có người đó, và OA "Zalo"). Ta coi mỗi phần tử là một tin riêng nên dòng đó
 * hiện ở cả ba — trong khi nó chỉ liên quan tới người kia.
 *
 * Luật: trong một khung, cùng NGƯỜI GỬI + cùng NỘI DUNG thì chỉ giữ MỘT bản, và
 * ưu tiên bản 1-1 (hội thoại của chính người đó) vì thông báo là về người đó, không
 * phải về nhóm. Không có bản 1-1 nào thì giữ bản đầu.
 *
 * CỐ Ý HẸP — chỉ gộp khi cả ba điều kiện đúng:
 *   · nhiều tin trong CÙNG một khung (tin chat thật hầu như đến từng khung riêng),
 *   · TRÙNG cả người gửi lẫn nội dung,
 *   · và chúng nằm ở NHIỀU hội thoại khác nhau.
 * Nhờ vậy người ta nhắn cùng một câu vào nhóm và vào riêng cho mình ở hai lần gửi
 * khác nhau thì KHÔNG bị gộp — đó là hai tin thật.
 */
function dropBroadcastDuplicates(msgs: IncomingMessage[]): IncomingMessage[] {
  if (msgs.length < 2) return msgs;

  const groups = new Map<string, IncomingMessage[]>();
  for (const m of msgs) {
    // Cảm xúc có nhánh xử lý riêng (gắn vào tin đích) — đừng gộp chúng ở đây.
    const key = m.reaction ? `r:${m.reaction.targetMsgId}:${m.threadId}` : `t:${m.fromId}|${m.text}`;
    const arr = groups.get(key);
    if (arr) arr.push(m); else groups.set(key, [m]);
  }

  const keep = new Set<IncomingMessage>();
  for (const [key, arr] of groups) {
    if (arr.length < 2 || key.startsWith('r:')) { for (const m of arr) keep.add(m); continue; }
    // Cùng một hội thoại thì KHÔNG phải phát tán — có thể là tin thật gửi liền
    // nhau, giữ hết (khử trùng theo msgId đã làm ở threadStore).
    if (new Set(arr.map((m) => m.threadId)).size < 2) { for (const m of arr) keep.add(m); continue; }
    keep.add(arr.find((m) => !m.group) ?? arr[0]);
  }
  // Giữ nguyên thứ tự ban đầu của khung.
  return msgs.filter((m) => keep.has(m));
}

/**
 * Nhịp ping tầng ỨNG DỤNG (khung cmd 2) để giữ phiên phía Zalo. Bản trước dựa
 * vào pong tầng WebSocket (`ws.ping()`) để phán sống/chết, nhưng gateway Zalo
 * KHÔNG trả pong WS → watchdog tự cắt kết nối khoẻ mỗi ~90s (thấy rõ trong
 * trace: close 1006 đúng nhịp 3×30s). Đó chính là "mất realtime". Nay chỉ ping
 * cmd 2 đều đặn và KHÔNG tự terminate vì thiếu pong.
 */
const APP_PING_MS = 60_000;

/**
 * Chỉ coi là đường chết khi IM HOÀN TOÀN (không một khung nào, kể cả phản hồi
 * ping cmd 2) quá lâu. Nới rộng để im-vì-rảnh không bị nhầm là chết; nối lại
 * là thao tác rẻ và không phá gì (reauth + mở lại), nên thà nới còn hơn cắt oan.
 */
const IDLE_TIMEOUT_MS = 240_000;

/** Đổi context mới (login lại) khi listener nối lại. Trả null = không lấy được. */
export type Reauth = () => Promise<ZaloContext | null>;

/**
 * Một listener cho MỘT tài khoản. Tự nối lại khi rớt (backoff), giữ sống bằng
 * heartbeat ping/pong: chỉ cắt-và-nối-lại khi ping KHÔNG có phản hồi, KHÔNG cắt
 * chỉ vì "im lặng không có tin" (Zalo im khi rảnh là bình thường — cắt lúc đó
 * làm tin đến rơi vào khoảng nối-lại = MISS, đúng lỗi đã gặp).
 *
 * Trước mỗi lần nối lại, gọi `reauth()` để lấy context tươi (cookie/secretKey
 * mới) — cookie Zalo có thể đã bị xoay.
 *
 * Gọi stop() để đóng hẳn (khi đăng xuất / đổi phiên).
 */
export class ZaloListener {
  private ws: WebSocket | null = null;
  private cipherKey: string | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private id = 1;
  private attempt = 0;
  /** Lúc nhận khung gần nhất (epoch ms) — watchdog đo im lặng từ đây. */
  private lastFrameAt = 0;

  /**
   * Đếm chẩn đoán — để trả lời "vì sao không có tin" mà không phải đoán:
   *   frames      tổng khung nhận
   *   msgFrames   khung cmd 501/521 (khung TIN)
   *   decoded     giải mã được (JSON đọc ra)
   *   extracted   rút được thành tin (có nội dung)
   *   decodeErr   lỗi giải mã (thiếu cipherKey / GCM sai)
   * frames đứng yên ⇒ socket không nhận; msgFrames>0 mà extracted=0 ⇒ parse sai
   * schema (sửa extractMessage); cipherKey null ⇒ chưa qua handshake.
   */
  readonly stats = { frames: 0, msgFrames: 0, decoded: 0, extracted: 0, decodeErr: 0, hasCipher: false };

  constructor(
    private ctx: ZaloContext,
    private onMessage: OnMessage,
    private onState: OnState = () => {},
    /** Lấy context tươi trước khi nối lại (login lại). Mặc định: giữ ctx cũ. */
    private reauth: Reauth = async () => null,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.onState('closed', 'đã dừng listener');
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.watchdogTimer = null;
    this.reconnectTimer = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const base = this.ctx.wsUrls[0];
    if (!base) {
      this.onState('error', 'không có zpw_ws — bản build này không lộ URL WebSocket');
      trace('connect', 'KHÔNG có zpw_ws — không nối được', { wsUrls: this.ctx.wsUrls });
      return;
    }
    // URL WebSocket PHẢI kèm zpw_ver + zpw_type (như makeURL apiVersion=true của
    // zca-js) + t. Thiếu version params là Zalo từ chối handshake → 1002.
    const u = new URL(base);
    u.searchParams.set('t', String(Date.now()));
    if (!u.searchParams.has('zpw_ver')) u.searchParams.set('zpw_ver', String(API_VERSION));
    if (!u.searchParams.has('zpw_type')) u.searchParams.set('zpw_type', String(API_TYPE));
    const url = u.toString();
    this.onState('connecting', `đang nối ${u.host}`);
    trace('connect', `đang nối ${u.host}`, { base });

    let ws: WebSocket;
    try {
      // Bộ header KHỚP zca-js — thiếu/khác là Zalo đá handshake (1002). Đặc biệt
      // `sec-websocket-extensions` (permessage-deflate) + connection/upgrade.
      ws = new WebSocket(url, {
        headers: {
          'accept-encoding': 'gzip, deflate, br, zstd',
          'accept-language': 'en-US,en;q=0.9',
          'cache-control': 'no-cache',
          connection: 'Upgrade',
          host: u.host,
          origin: 'https://chat.zalo.me',
          pragma: 'no-cache',
          'sec-websocket-extensions': 'permessage-deflate; client_max_window_bits',
          'sec-websocket-version': '13',
          upgrade: 'websocket',
          'user-agent': this.ctx.userAgent,
          cookie: this.ctx.cookie,
        },
      });
    } catch (e) {
      this.onState('error', 'không tạo được WebSocket: ' + (e as Error).message);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.lastFrameAt = Date.now();

    ws.on('open', () => {
      this.attempt = 0;
      this.lastFrameAt = Date.now();
      this.onState('open', 'đã mở, chờ cipher key');
      trace('open', 'socket đã mở, chờ cipher key');
    });

    ws.on('message', (data: WebSocket.RawData) => {
      // Có khung tới = đường còn sống → làm tươi mốc im lặng.
      this.lastFrameAt = Date.now();
      void this.onFrame(data);
    });
    // Pong/ping tầng WS (nếu Zalo có gửi) cũng tính là dấu hiệu sống.
    ws.on('pong', () => { this.lastFrameAt = Date.now(); });
    ws.on('ping', () => { this.lastFrameAt = Date.now(); });

    ws.on('close', (code: number, reason: Buffer) => {
      this.clearTimers();
      trace('close', `socket đóng code=${code}`, { reason: reason?.toString?.().slice(0, 120), stats: this.stats });
      if (!this.stopped) {
        this.onState('closed', 'rớt kết nối, sẽ nối lại');
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err: Error) => {
      this.onState('error', 'lỗi socket: ' + err.message);
      trace('error', 'lỗi socket: ' + err.message);
      // 'close' sẽ theo sau và lo việc nối lại.
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.attempt += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5)); // 2s…30s
    this.onState('connecting', `nối lại sau ${Math.round(delay / 1000)}s (lần ${this.attempt})`);
    this.reconnectTimer = setTimeout(() => void this.reconnect(), delay);
  }

  /** Login lại (lấy cookie/secretKey mới) rồi nối lại. */
  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    try {
      const fresh = await this.reauth();
      if (fresh) this.ctx = fresh;
    } catch (e) {
      this.onState('error', 'login lại thất bại: ' + (e as Error).message);
      // Vẫn thử nối bằng ctx cũ — có thể chỉ là trục trặc mạng tạm thời.
    }
    this.connect();
  }

  private startPing(): void {
    // Dọn timer cũ trước — handshake có thể tới nhiều lần / reconnect chưa kịp
    // 'close'; nếu không sẽ chạy chồng nhiều interval ping.
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.lastFrameAt = Date.now();

    // Ping ứng dụng (khung cmd 2) — giữ phiên phía Zalo. Nhịp = nhỏ hơn giữa cái
    // Zalo quảng cáo và APP_PING_MS (đừng để tới 180s mới ping lần đầu; trace
    // cho thấy Zalo đóng ở ~90s khi chưa nhận ping ứng dụng nào).
    const advertised = this.ctx.pingIntervalMs > 0 ? this.ctx.pingIntervalMs : DEFAULT_PING_MS;
    const appEvery = Math.min(advertised, APP_PING_MS);
    this.pingTimer = setInterval(() => this.sendPing(), appEvery);
    // Ping ngay một phát để Zalo thấy hoạt động sớm.
    this.sendPing();

    // Watchdog IM-LẶNG (không còn cắt-vì-thiếu-pong): chỉ nối lại khi tuyệt đối
    // không có khung nào quá IDLE_TIMEOUT_MS. Ping cmd 2 của ta thường kéo về một
    // khung phản hồi → đường bận rộn thì mốc luôn được làm tươi; chỉ khi đường
    // chết thật (half-open, không cả phản hồi ping) mới chạm ngưỡng.
    this.watchdogTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastFrameAt > IDLE_TIMEOUT_MS) {
        this.onState('error', `im lặng quá ${IDLE_TIMEOUT_MS / 1000}s — nối lại`);
        trace('idle', `im lặng quá ${IDLE_TIMEOUT_MS / 1000}s — terminate để nối lại`);
        try { ws.terminate(); } catch { /* ignore */ }
      }
    }, APP_PING_MS);
  }

  private sendPing(): void {
    this.sendWs({ version: 1, cmd: 2, subCmd: 1, data: { eventId: Date.now() } }, false);
  }

  /** Đóng gói payload thành khung nhị phân — port sendWs của zca-js. */
  private sendWs(payload: { version: number; cmd: number; subCmd: number; data: Record<string, unknown> }, requireId = true): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (requireId) payload.data['req_id'] = `req_${this.id++}`;
    const encoded = new TextEncoder().encode(JSON.stringify(payload.data));
    const buf = Buffer.alloc(4 + encoded.length);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    view.setUint8(0, payload.version);
    view.setInt32(1, payload.cmd, true);
    view.setInt8(3, payload.subCmd);
    encoded.forEach((e, i) => view.setUint8(4 + i, e));
    try {
      this.ws.send(buf);
    } catch {
      /* rớt giữa chừng — 'close' sẽ lo nối lại */
    }
  }

  private async onFrame(data: WebSocket.RawData): Promise<void> {
    const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (buf.length < 4) return;
    this.stats.frames += 1;
    const [version, cmd, subCmd] = getHeader(buf);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8').decode(buf.subarray(4)));
    } catch {
      // Khung không phải JSON — ghi lại cmd để biết Zalo gửi dạng gì.
      if (this.stats.frames <= 12) trace('frame', `khung #${this.stats.frames} KHÔNG-JSON`, { version, cmd, subCmd, bytes: buf.length });
      return;
    }
    // Ghi 12 khung đầu (kèm cmd + các khoá top-level) để biết Zalo dùng cmd nào
    // cho tin — nếu không phải 501/521 thì đây là chỗ lộ ra.
    if (this.stats.frames <= 12) {
      trace('frame', `khung #${this.stats.frames}`, { version, cmd, subCmd, keys: Object.keys(parsed).slice(0, 8), encrypt: parsed['encrypt'] });
    }

    // Handshake: nhận cipherKey (KHÁC secretKey) để giải mã tin.
    if (version === 1 && cmd === 1 && subCmd === 1 && typeof parsed['key'] === 'string') {
      this.cipherKey = parsed['key'] as string;
      this.stats.hasCipher = true;
      this.startPing();
      this.onState('ready', 'đã nhận cipher key — đang nghe tin');
      trace('handshake', 'nhận cipher key — bắt đầu nghe tin');
      return;
    }

    // cmd 3000 = "trùng kết nối" — Zalo báo có client khác cùng tài khoản (webview
    // Zalo còn mở). Ghi để xác nhận đã hết sau khi webview nhả về about:blank.
    if (cmd === 3000) {
      trace('dup', 'Zalo báo TRÙNG KẾT NỐI (cmd 3000) — còn client khác mở cùng tài khoản (webview Zalo?)');
      return;
    }

    // MỌI khung mang dữ liệu mã hoá là ỨNG VIÊN tin — KHÔNG lọc theo cmd nữa.
    // Lý do: bản build hiện tại đẩy tin qua cmd 621 (không phải 501/521), và tên
    // cmd đổi theo phiên bản Zalo. Ta giải mã rồi để extractMessages quyết theo
    // PAYLOAD: có chữ thì là tin, không thì bỏ (ping/seen/typing…). cmd 521 vẫn
    // dùng làm gợi ý "nhóm".
    if (typeof parsed['data'] === 'string' && typeof parsed['encrypt'] === 'number') {
      this.stats.msgFrames += 1;
      const groupHint = cmd === 521;
      try {
        const decoded = await decodeEventData(parsed as { data: unknown; encrypt: unknown }, this.cipherKey ?? undefined);
        this.stats.decoded += 1;
        // Sự kiện file_done (upload FILE đính kèm xong, mang fileUrl) đi qua
        // đúng đường khung mã hoá này — giao cho uploadHub trước khi rút tin.
        try { scanFileDone(decoded); } catch { /* khung lạ — không được chết listener */ }
        const msgs = extractMessages(groupHint, decoded, Date.now(), this.ctx.uid);
        if (msgs.length) {
          for (const msg of msgs) {
            this.stats.extracted += 1;
            this.onMessage(msg);
          }
          const last = msgs[msgs.length - 1];
          // MỘT khung rút ra nhiều tin đi NHIỀU hội thoại là dấu hiệu khung
          // THÔNG BÁO HỆ THỐNG (vd "… đã đồng ý kết bạn") bị hiểu thành tin chat:
          // Zalo gửi kèm danh sách hội thoại liên quan, ta lại coi mỗi phần tử là
          // một tin riêng → cùng một dòng hiện ở cả người VÀ nhóm. Ghi rõ để soi,
          // vì trace chỉ log tin CUỐI nên trước đây ca này ẩn hoàn toàn.
          const threads = [...new Set(msgs.map((x) => x.threadId))];
          if (threads.length > 1) {
            trace('msg', `⚠ MỘT khung → ${msgs.length} tin ở ${threads.length} hội thoại (cmd=${cmd})`, {
              threads,
              texts: msgs.map((x) => x.text.slice(0, 30)),
              sameText: new Set(msgs.map((x) => x.text)).size === 1,
            });
          }
          trace('msg', `RÚT ${msgs.length} tin cmd=${cmd}`, { group: last.group, threadId: last.threadId, from: last.fromName || last.fromId, self: last.isSelf, text: last.text.slice(0, 40) });
          // Tin ĐẾN mà không rút được khối trích dẫn: có thể vốn không phải tin
          // trả lời, cũng có thể bản build đổi tên field. Ghi hình dạng (chỉ TÊN
          // khoá) để phân biệt được hai ca đó mà không lộ nội dung tin.
          if (this.stats.extracted <= 40) {
            for (const msg of msgs) {
              if (msg.reaction || msg.quote || msg.isSelf) continue;
              const src = msg.raw as Record<string, unknown> | undefined;
              if (src) trace('msg', 'tin đến KHÔNG có khối trích dẫn — hình dạng để dò', quoteShape(src));
            }
          }
        } else if (this.stats.decoded <= 20) {
          // Giải mã được nhưng KHÔNG rút ra tin nào → có thể là seen/typing, hoặc
          // một loại sự kiện ta chưa đọc được (reaction, tin từ mobile, tin nhóm).
          //
          // Ghi tới BÊN TRONG `data`, không chỉ lớp ngoài: mọi khung đều bọc
          // {error_code,error_message,data} nên chỉ ghi lớp ngoài thì mọi cmd
          // trông giống hệt nhau và chẩn đoán được đúng con số 0. Phần lõi mới
          // nói được đây là loại sự kiện gì.
          trace('msg', `giải mã OK nhưng KHÔNG rút được tin cmd=${cmd}`, probeShape(decoded));
        }
      } catch (e) {
        this.stats.decodeErr += 1;
        if (this.stats.decodeErr <= 20) trace('msg', `LỖI giải mã cmd=${cmd}`, { hasCipher: this.stats.hasCipher, err: (e as Error).message });
        /* một khung giải mã lỗi không được làm chết listener */
      }
    }
  }

  /** Ảnh chụp đếm chẩn đoán (đọc từ hub → poll → Console). */
  getStats() {
    return { ...this.stats };
  }
}
