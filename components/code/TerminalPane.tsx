'use client';

// Code Studio — terminal pane: nhiều phiên shell thật (node-pty/ConPTY khi có),
// UI xterm.js. Output stream về qua SSE (base64 từng chunk), phím gõ đẩy lên
// bằng POST termWrite. Mỗi phiên một <XTermView> giữ nguyên trạng thái khi
// chuyển tab phiên (ẩn bằng display, xterm buffer còn nguyên).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { cTermCreate, cTermWrite, cTermResize, cTermKill } from '@/lib/code';

export interface TermTab {
  id: string;
  label: string;
  shell: 'powershell' | 'cmd' | 'bash';
  pty: boolean;
}

interface Props {
  projectId: string;
  tabs: TermTab[];
  activeId: string | null;
  onTabs: (tabs: TermTab[]) => void;
  onActive: (id: string | null) => void;
  /** Folder (rel) terminal mới sẽ mở tại — do FileTree "Terminal tại đây" đặt. */
  pendingCwd: string | null;
  onPendingConsumed: () => void;
  /** Pane có đang hiển thị không (để fit lại khi mở). */
  visible: boolean;
}

const DARCULA_THEME = {
  background: '#2B2B2B',
  foreground: '#A9B7C6',
  cursor: '#BBBBBB',
  cursorAccent: '#2B2B2B',
  selectionBackground: '#214283',
  black: '#000000', red: '#F0524F', green: '#5C962C', yellow: '#A68A0D',
  blue: '#3993D4', magenta: '#A771BF', cyan: '#00A3A3', white: '#808080',
  brightBlack: '#595959', brightRed: '#FF4050', brightGreen: '#4FC414',
  brightYellow: '#E5BF00', brightBlue: '#1FB0FF', brightMagenta: '#ED7EED',
  brightCyan: '#00E5E5', brightWhite: '#FFFFFF',
};

/** One live xterm bound to one server session. */
function XTermView({
  id, active, visible, onDead,
}: {
  id: string;
  active: boolean;
  visible: boolean;
  /** Phiên server không còn (exit / server restart) — để tab báo ⚠ và chặn gõ vô vọng. */
  onDead: (id: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onDeadRef = useRef(onDead);
  onDeadRef.current = onDead;
  // Đang xem lịch sử (không dính đáy) → hiện nút "về cuối". Thuần client.
  const [scrolledUp, setScrolledUp] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      theme: DARCULA_THEME,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', Consolas, 'Courier New', monospace",
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    // Theo dõi vị trí cuộn để bật/tắt nút "về cuối".
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
    // Font monospace load xong metric đổi → phải fit lại, không thì cols tính
    // sai lúc đầu, PTY wrap lệch → dòng chữ vỡ/đè nhau.
    document.fonts?.ready.then(doFit).catch(() => {});

    let dead = false;
    const markDead = (msg: string) => {
      if (dead) return;
      dead = true;
      term.write(`\r\n\x1b[31m${msg}\x1b[0m\r\n`);
      onDeadRef.current(id);
    };

    // INPUT: hàng đợi tuần tự — TUYỆT ĐỐI không bắn mỗi phím một POST song
    // song: fetch không đảm bảo thứ tự đến, escape sequence (mũi tên, F-key)
    // mà đảo phím là TUI (claude, vim) nhận input rác. Queue còn tự gộp các
    // phím gõ nhanh thành một request.
    const pending: string[] = [];
    let sending = false;
    const flush = async () => {
      if (sending || dead) return;
      sending = true;
      while (pending.length) {
        const data = pending.splice(0, pending.length).join('');
        try {
          await cTermWrite(id, data);
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
    const resizeSub = term.onResize(({ cols, rows }) => void cTermResize(id, cols, rows).catch(() => {}));

    // OUTPUT: SSE, mỗi chunk base64. Decoder DÙNG CHUNG + {stream:true} để ký
    // tự UTF-8/ký tự vẽ khung bị cắt đôi giữa 2 chunk vẫn ghép lại đúng —
    // decoder mới cho mỗi chunk là khung TUI vỡ ngay. Server gửi 'reset' trước
    // mỗi lần replay buffer → clear màn hình, không vẽ chồng.
    let decoder = new TextDecoder();
    const es = new EventSource(`/api/code/term/${id}`);
    es.addEventListener('reset', () => {
      term.reset();
      decoder = new TextDecoder(); // bỏ state dở dang của kết nối trước
      // Đồng bộ lại size PTY ↔ xterm ngay khi (re)connect — TUI khởi động với
      // size lệch là vẽ sai cột, chữ đè nhau.
      void cTermResize(id, term.cols, term.rows).catch(() => {});
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
      markDead('[shell đã thoát — mở terminal mới bằng nút ＋]');
    });
    es.onerror = () => {
      // CLOSED = server trả 404/403 (phiên mất sau khi dev server restart) —
      // EventSource sẽ KHÔNG tự reconnect nữa. CONNECTING = đứt tạm, cứ để nó thử lại.
      if (es.readyState === EventSource.CLOSED) {
        markDead('[mất kết nối phiên (server khởi động lại?) — mở terminal mới bằng nút ＋]');
      }
    };

    // Fit theo kích thước thật của host.
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
  }, [id]);

  // Khi tab/panel vừa hiện lại → fit + focus.
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

  /** Cuộn xem lịch sử — chỉ đổi viewport phía client, không gửi gì lên server
   *  nên lệnh đang chạy không bị ảnh hưởng. */
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
        className="cs-xterm"
        ref={hostRef}
        onClick={() => termRef.current?.focus()}
      />
      <div className="tw-scrollbtns" role="group" aria-label="Cuộn terminal">
        <button type="button" className="tw-scrollbtn" title="Cuộn lên một trang (Shift+PageUp)" aria-label="Cuộn lên" onClick={() => scrollPage(-1)}>▲</button>
        <button type="button" className="tw-scrollbtn" title="Cuộn xuống một trang (Shift+PageDown)" aria-label="Cuộn xuống" onClick={() => scrollPage(1)}>▼</button>
        {scrolledUp && (
          <button type="button" className="tw-scrollbtn now" title="Về dòng mới nhất" aria-label="Về cuối" onClick={scrollBottom}>⤓</button>
        )}
      </div>
    </div>
  );
}

export default function TerminalPane({
  projectId, tabs, activeId, onTabs, onActive, pendingCwd, onPendingConsumed, visible,
}: Props) {
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deadIds, setDeadIds] = useState<Set<string>>(new Set());
  const seq = useRef(1);

  const markDead = useCallback((id: string) => {
    setDeadIds((s) => (s.has(id) ? s : new Set(s).add(id)));
  }, []);

  const create = useCallback(async (shell: TermTab['shell'], cwd = '') => {
    setCreating(true);
    setErr(null);
    try {
      const { id, pty } = await cTermCreate(projectId, cwd, shell);
      const label = `${shell === 'powershell' ? 'PS' : shell} ${seq.current++}${cwd ? ` · ${cwd.split('/').pop()}` : ''}`;
      onTabs([...tabs, { id, label, shell, pty }]);
      onActive(id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCreating(false);
    }
  }, [projectId, tabs, onTabs, onActive]);

  // "Terminal tại đây" từ FileTree.
  useEffect(() => {
    if (pendingCwd === null) return;
    onPendingConsumed();
    void create('powershell', pendingCwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCwd]);

  const close = async (t: TermTab) => {
    await cTermKill(t.id).catch(() => {});
    const left = tabs.filter((x) => x.id !== t.id);
    onTabs(left);
    if (activeId === t.id) onActive(left.length ? left[left.length - 1].id : null);
  };

  /** Đóng tab chết + mở phiên mới cùng shell trong MỘT thao tác (tránh 2 lần
   *  setTabs với closure cũ đè nhau). */
  const relaunch = async (t: TermTab) => {
    setCreating(true);
    setErr(null);
    await cTermKill(t.id).catch(() => {});
    try {
      const { id, pty } = await cTermCreate(projectId, '', t.shell);
      const label = `${t.shell === 'powershell' ? 'PS' : t.shell} ${seq.current++}`;
      onTabs([...tabs.filter((x) => x.id !== t.id), { id, label, shell: t.shell, pty }]);
      onActive(id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const activePty = tabs.find((t) => t.id === activeId)?.pty;

  return (
    <div className="cs-term">
      <div className="cs-term-bar">
        <span className="cs-term-title" aria-hidden>⌨ Terminal</span>
        {tabs.map((t) => (
          <span key={t.id} className={`cs-term-tab${t.id === activeId ? ' on' : ''}${deadIds.has(t.id) ? ' dead' : ''}`}>
            <button
              className="cs-term-tab-main"
              onClick={() => onActive(t.id)}
              title={deadIds.has(t.id) ? 'Phiên đã chết — đóng rồi mở lại' : t.pty ? 'PTY (ConPTY) — TUI OK' : 'pipes fallback'}
            >
              {deadIds.has(t.id) && <span aria-hidden>⚠ </span>}{t.label}
            </button>
            <button className="cs-term-tab-x" title="Đóng phiên" onClick={() => void close(t)}>✕</button>
          </span>
        ))}
        <button className="cs-term-new" disabled={creating} title="PowerShell mới" onClick={() => void create('powershell')}>＋</button>
        <button className="cs-term-new alt" disabled={creating} title="Git Bash mới" onClick={() => void create('bash')}>bash</button>
        <span style={{ flex: 1 }} />
        {activePty === false && <span className="cs-term-mode" title="node-pty không load được — TUI app sẽ không vẽ đúng">pipes</span>}
        {err && <span className="cs-term-err" title={err}>{err}</span>}
      </div>
      <div className="cs-term-body">
        {tabs.length === 0 && (
          <div className="cs-term-hint">
            Bấm ＋ để mở PowerShell tại gốc project — chạy <code>mvn</code>/<code>gradle</code>/<code>git</code>… hay cả <code>claude</code> (Claude Code) ngay tại đây.
          </div>
        )}
        {activeId && deadIds.has(activeId) && (
          <div className="cs-term-deadbar">
            Phiên này đã chết (shell thoát hoặc dev server khởi động lại).
            <button
              disabled={creating}
              onClick={() => {
                const t = tabs.find((x) => x.id === activeId);
                if (t) void relaunch(t);
              }}
            >
              ⟳ Mở lại {tabs.find((x) => x.id === activeId)?.shell === 'bash' ? 'Git Bash' : 'PowerShell'}
            </button>
          </div>
        )}
        {tabs.map((t) => (
          <XTermView key={t.id} id={t.id} active={t.id === activeId} visible={visible} onDead={markDead} />
        ))}
      </div>
    </div>
  );
}
