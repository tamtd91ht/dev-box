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
import type { ZaloContext } from './client';

/** Một tin nhận được, đã chuẩn hoá tối thiểu cho tầng trên. */
export interface IncomingMessage {
  /** Thời điểm nhận (epoch ms). */
  at: number;
  group: boolean;
  /** threadId thật (uidFrom cho cá nhân, groupId cho nhóm). */
  threadId: string;
  /** uid người gửi. */
  fromId: string;
  /** Tên hiển thị người gửi (nếu payload có). */
  fromName: string;
  /** Nội dung văn bản. */
  text: string;
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

/** Lôi các trường tin nhắn ra khỏi payload đã giải mã, chịu được nhiều schema. */
function extractMessage(group: boolean, decoded: unknown, at: number): IncomingMessage | null {
  // Payload thường là { msgs: [...] } hoặc { data: {...} }; bọc nhiều lớp.
  const root = decoded as Record<string, unknown> | null;
  if (!root) return null;
  const list =
    (Array.isArray(root['msgs']) && (root['msgs'] as unknown[])) ||
    (Array.isArray((root['data'] as Record<string, unknown>)?.['msgs']) &&
      ((root['data'] as Record<string, unknown>)['msgs'] as unknown[])) ||
    [root];
  const m = (list[list.length - 1] ?? null) as Record<string, unknown> | null;
  if (!m) return null;

  const str = (...keys: string[]): string => {
    for (const k of keys) {
      const v = m[k];
      if (typeof v === 'string' && v) return v;
      if (typeof v === 'number' || typeof v === 'bigint') return String(v);
    }
    return '';
  };
  const text = str('content', 'message', 'msg', 'body');
  if (!text) return null; // không có nội dung → bỏ (typing/seen… xử lý nơi khác)
  return {
    at,
    group,
    threadId: group ? str('groupId', 'idTo', 'gid') : str('uidFrom', 'fromId', 'idTo'),
    fromId: str('uidFrom', 'fromId'),
    fromName: str('dName', 'fromName', 'senderName'),
    text,
    raw: m,
  };
}

/**
 * Nhịp heartbeat tầng WebSocket. Mỗi nhịp gửi một ping; nếu nhịp TRƯỚC đã ping
 * mà không có phản hồi (pong hoặc khung) thì mới coi là chết → thời gian phát
 * hiện đường chết thật ≈ 2×WS_PING_MS (~60s), đủ nhanh mà không nhầm im lặng.
 */
const WS_PING_MS = 30_000;

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
  /** Đã gửi ping ở nhịp trước và đang CHỜ phản hồi. Có khung/pong về → false. */
  private awaitingPong = false;

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
      return;
    }
    const url = base + (base.includes('?') ? '&' : '?') + 't=' + Date.now();
    this.onState('connecting', `đang nối ${new URL(base).host}`);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        headers: {
          'accept-encoding': 'gzip, deflate, br',
          'accept-language': 'vi-VN,vi;q=0.9',
          'cache-control': 'no-cache',
          host: new URL(url).host,
          origin: 'https://chat.zalo.me',
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
    this.awaitingPong = false;

    ws.on('open', () => {
      this.attempt = 0;
      this.awaitingPong = false;
      this.onState('open', 'đã mở, chờ cipher key');
    });

    ws.on('message', (data: WebSocket.RawData) => {
      // Có khung tới = đường CHẮC CHẮN sống → coi như pong.
      this.awaitingPong = false;
      void this.onFrame(data);
    });
    // Pong trả lời cho ping của ta → đường còn sống.
    ws.on('pong', () => { this.awaitingPong = false; });
    ws.on('ping', () => { this.awaitingPong = false; });

    ws.on('close', () => {
      this.clearTimers();
      if (!this.stopped) {
        this.onState('closed', 'rớt kết nối, sẽ nối lại');
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err: Error) => {
      this.onState('error', 'lỗi socket: ' + err.message);
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
    this.awaitingPong = false;
    // Ping ứng dụng (khung cmd=2) theo nhịp Zalo yêu cầu — giữ phiên phía Zalo.
    const appEvery = this.ctx.pingIntervalMs > 0 ? this.ctx.pingIntervalMs : DEFAULT_PING_MS;
    this.pingTimer = setInterval(() => this.sendPing(), appEvery);

    // Heartbeat tầng WebSocket — CHỈ cắt khi ping có gửi mà KHÔNG có pong về.
    //
    // Bản trước cắt theo "im quá lâu không có KHUNG NÀO", nhưng Zalo im lặng khi
    // không có tin là chuyện thường → nó tự ngắt liên tục, và tin đến rơi vào
    // khoảng nối-lại = MISS. Sai lầm đó chính là "không còn realtime". Nay: mỗi
    // nhịp gửi một ping; nếu chu kỳ TRƯỚC đã gửi ping mà chưa nhận gì (pong hoặc
    // khung) thì mới coi là chết. Im lặng KHÔNG còn bị nhầm là chết.
    this.watchdogTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        // Đã ping ở nhịp trước, không có phản hồi nào → đường chết thật.
        this.onState('error', 'ping không có phản hồi — nối lại');
        try { ws.terminate(); } catch { /* ignore */ }
        this.awaitingPong = false;
        return;
      }
      this.awaitingPong = true;
      try { ws.ping(); } catch { this.awaitingPong = false; }
    }, WS_PING_MS);
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
      return; // khung không phải JSON — bỏ
    }

    // Handshake: nhận cipherKey (KHÁC secretKey) để giải mã tin.
    if (version === 1 && cmd === 1 && subCmd === 1 && typeof parsed['key'] === 'string') {
      this.cipherKey = parsed['key'] as string;
      this.stats.hasCipher = true;
      this.startPing();
      this.onState('ready', 'đã nhận cipher key — đang nghe tin');
      return;
    }

    // Tin cá nhân (501) / nhóm (521).
    if (cmd === 501 || cmd === 521) {
      this.stats.msgFrames += 1;
      const group = cmd === 521;
      try {
        const decoded = await decodeEventData(parsed as { data: unknown; encrypt: unknown }, this.cipherKey ?? undefined);
        this.stats.decoded += 1;
        const msg = extractMessage(group, decoded, Date.now());
        if (msg) {
          this.stats.extracted += 1;
          this.onMessage(msg);
        }
      } catch {
        this.stats.decodeErr += 1;
        /* một khung giải mã lỗi không được làm chết listener */
      }
    }
  }

  /** Ảnh chụp đếm chẩn đoán (đọc từ hub → poll → Console). */
  getStats() {
    return { ...this.stats };
  }
}
