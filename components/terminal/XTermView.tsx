'use client';

// Một khung xterm gắn vào MỘT phiên trên server. Dùng chung cho tab Terminal và
// cho cửa sổ rời (app/terminal/[id]) — cùng một cách nối, nên hai nơi hiển thị
// giống hệt nhau và bug sửa một lần.
//
// Ba thứ ở đây đã trả giá mới có, đừng "đơn giản hoá":
//
//  1. INPUT phải TUẦN TỰ. Mỗi phím một POST song song thì fetch không đảm bảo
//     thứ tự đến; escape sequence (mũi tên, F-key) đảo phím là TUI (claude,
//     vim) nhận input rác. Hàng đợi bên dưới còn gộp các phím gõ nhanh thành
//     một request.
//  2. Decoder UTF-8 DÙNG CHUNG + {stream:true}. Ký tự nhiều byte / ký tự vẽ
//     khung bị cắt đôi giữa hai chunk vẫn ghép lại đúng; decoder mới mỗi chunk
//     là khung TUI vỡ ngay.
//  3. Fit lại sau khi font load xong. Metric đổi → cols tính sai lúc đầu, PTY
//     wrap lệch, chữ đè nhau.

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/** Darcula — khớp tông tối của Code Studio. */
export const DARCULA_THEME = {
  background: '#1E1F22',
  foreground: '#BCBEC4',
  cursor: '#BBBBBB',
  cursorAccent: '#1E1F22',
  selectionBackground: '#214283',
  black: '#000000', red: '#F0524F', green: '#5C962C', yellow: '#A68A0D',
  blue: '#3993D4', magenta: '#A771BF', cyan: '#00A3A3', white: '#808080',
  brightBlack: '#595959', brightRed: '#FF4050', brightGreen: '#4FC414',
  brightYellow: '#E5BF00', brightBlue: '#1FB0FF', brightMagenta: '#ED7EED',
  brightCyan: '#00E5E5', brightWhite: '#FFFFFF',
};

export interface XTermViewProps {
  /** Id phiên trên server. */
  id: string;
  /** Endpoint gốc: '/api/term' (tab Terminal) hoặc '/api/code/term' (Code Studio). */
  base?: string;
  /** Gọi khi phiên không còn (shell thoát / server mất phiên). */
  onDead?: (id: string) => void;
  /** Đang là khung được xem — quyết định hiện/ẩn và có focus không. */
  active?: boolean;
  /** Cả pane có đang hiển thị không (tab bị ẩn thì đừng fit). */
  visible?: boolean;
  fontSize?: number;
}

/** Gửi input lên server. Tách riêng để đổi endpoint mà không đụng phần còn lại. */
async function writeTo(base: string, id: string, data: string): Promise<void> {
  const url = base === '/api/code/term' ? '/api/code' : '/api/term';
  const body =
    base === '/api/code/term'
      ? { action: 'termWrite', id, data }
      : { action: 'write', id, data };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean };
  if (!j.ok) throw new Error('phiên không còn');
}

async function resizeTo(base: string, id: string, cols: number, rows: number): Promise<void> {
  const url = base === '/api/code/term' ? '/api/code' : '/api/term';
  const body =
    base === '/api/code/term'
      ? { action: 'termResize', id, cols, rows }
      : { action: 'resize', id, cols, rows };
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export default function XTermView({
  id,
  base = '/api/term',
  onDead,
  active = true,
  visible = true,
  fontSize = 13,
}: XTermViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onDeadRef = useRef(onDead);
  onDeadRef.current = onDead;
  // Đang xem lịch sử (không dính đáy) → hiện nút "về cuối". Chỉ là trạng thái
  // hiển thị phía client, KHÔNG đụng gì tới PTY/stream nên lệnh đang chạy vẫn yên.
  const [scrolledUp, setScrolledUp] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      theme: DARCULA_THEME,
      fontSize,
      fontFamily: "'JetBrains Mono', Consolas, 'Courier New', monospace",
      cursorBlink: true,
      scrollback: 8000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    // Theo dõi vị trí cuộn để bật/tắt nút "về cuối". term.buffer.active.viewportY
    // là dòng trên cùng đang hiển thị; baseY là viewportY khi dính đáy.
    const syncScroll = () => {
      const b = term.buffer.active;
      setScrolledUp(b.viewportY < b.baseY);
    };
    const scrollSub = term.onScroll(syncScroll);
    const wroteSub = term.onWriteParsed(syncScroll);

    const doFit = () => {
      try {
        fit.fit();
      } catch { /* host 0×0 khi chưa hiển thị */ }
    };
    doFit();
    document.fonts?.ready.then(doFit).catch(() => {});

    let dead = false;
    const markDead = (msg: string) => {
      if (dead) return;
      dead = true;
      term.write(`\r\n\x1b[31m${msg}\x1b[0m\r\n`);
      onDeadRef.current?.(id);
    };

    // ── INPUT: hàng đợi tuần tự (xem chú thích đầu file) ────────────────────
    const pending: string[] = [];
    let sending = false;
    const flush = async () => {
      if (sending || dead) return;
      sending = true;
      while (pending.length) {
        const data = pending.splice(0, pending.length).join('');
        try {
          await writeTo(base, id, data);
        } catch {
          markDead('[phiên không còn trên server — mở terminal mới bằng nút ＋]');
          break;
        }
      }
      sending = false;
    };
    const dataSub = term.onData((d) => {
      pending.push(d);
      void flush();
    });
    const resizeSub = term.onResize(({ cols, rows }) =>
      void resizeTo(base, id, cols, rows).catch(() => {}),
    );

    // ── OUTPUT: SSE, chunk base64 ───────────────────────────────────────────
    let decoder = new TextDecoder();
    const es = new EventSource(`${base}/${id}`);
    es.addEventListener('reset', () => {
      term.reset();
      decoder = new TextDecoder(); // bỏ state dở dang của kết nối trước
      // Đồng bộ lại size PTY ↔ xterm ngay khi (re)connect — TUI khởi động với
      // size lệch là vẽ sai cột.
      void resizeTo(base, id, term.cols, term.rows).catch(() => {});
    });
    es.onmessage = (ev) => {
      try {
        const bin = atob(ev.data as string);
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        term.write(decoder.decode(bytes, { stream: true }));
      } catch { /* chunk hỏng — bỏ qua */ }
    };
    es.addEventListener('exit', () => {
      es.close();
      markDead('[shell đã thoát]');
    });
    es.onerror = () => {
      // CLOSED = server trả 404/403 → EventSource KHÔNG tự reconnect nữa.
      // CONNECTING = đứt tạm, cứ để nó thử lại.
      if (es.readyState === EventSource.CLOSED) {
        markDead('[mất kết nối phiên (server khởi động lại?)]');
      }
    };

    const ro = new ResizeObserver(() => {
      if (host.clientWidth < 40 || host.clientHeight < 40) return;
      doFit();
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      scrollSub.dispose();
      wroteSub.dispose();
      es.close();
      term.dispose();
    };
  }, [id, base, fontSize]);

  // Khung vừa hiện lại → fit + focus.
  useEffect(() => {
    if (!active || !visible) return;
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit();
        termRef.current?.focus();
      } catch { /* ignore */ }
    }, 30);
    return () => clearTimeout(t);
  }, [active, visible]);

  /** Cuộn xem lịch sử. Chỉ đổi viewport của xterm phía client — không gửi gì
   *  lên server, nên lệnh đang chạy trong shell không bị ảnh hưởng. */
  const scrollPage = (dir: -1 | 1) => {
    termRef.current?.scrollLines(dir * Math.max(1, (termRef.current?.rows ?? 10) - 1));
  };
  const scrollBottom = () => {
    termRef.current?.scrollToBottom();
    termRef.current?.focus();
  };

  return (
    <div className="tw-xterm-wrap" style={{ display: active ? 'block' : 'none' }}>
      <div
        className="tw-xterm"
        ref={hostRef}
        onClick={() => termRef.current?.focus()}
      />
      <div className="tw-scrollbtns" role="group" aria-label="Cuộn terminal">
        <button
          type="button"
          className="tw-scrollbtn"
          title="Cuộn lên một trang (Shift+PageUp)"
          aria-label="Cuộn lên"
          onClick={() => scrollPage(-1)}
        >
          ▲
        </button>
        <button
          type="button"
          className="tw-scrollbtn"
          title="Cuộn xuống một trang (Shift+PageDown)"
          aria-label="Cuộn xuống"
          onClick={() => scrollPage(1)}
        >
          ▼
        </button>
        {scrolledUp && (
          <button
            type="button"
            className="tw-scrollbtn now"
            title="Về dòng mới nhất"
            aria-label="Về cuối"
            onClick={scrollBottom}
          >
            ⤓
          </button>
        )}
      </div>
    </div>
  );
}
