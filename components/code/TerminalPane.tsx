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
function XTermView({ id, active, visible }: { id: string; active: boolean; visible: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

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

    try {
      fit.fit();
    } catch { /* host 0×0 khi chưa hiển thị */ }

    // Gõ phím → server. Fire-and-forget: lệnh kế tiếp vẫn theo thứ tự vì cùng
    // một kết nối HTTP keep-alive, độ trễ local không đáng kể.
    const dataSub = term.onData((d) => void cTermWrite(id, d).catch(() => {}));
    const resizeSub = term.onResize(({ cols, rows }) => void cTermResize(id, cols, rows).catch(() => {}));

    // Output stream: SSE, mỗi chunk base64.
    const es = new EventSource(`/api/code/term/${id}`);
    es.onmessage = (ev) => {
      try {
        const bin = atob(ev.data as string);
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        term.write(new TextDecoder().decode(bytes));
      } catch { /* chunk hỏng — bỏ qua */ }
    };
    es.addEventListener('exit', () => es.close());
    es.onerror = () => { /* EventSource tự reconnect; buffer replay đảm bảo không mất nội dung */ };

    // Fit theo kích thước thật của host.
    const ro = new ResizeObserver(() => {
      if (host.clientWidth < 40 || host.clientHeight < 40) return;
      try {
        fit.fit();
      } catch { /* ignore */ }
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
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

  return <div className="cs-xterm" ref={hostRef} style={{ display: active ? 'block' : 'none' }} />;
}

export default function TerminalPane({
  projectId, tabs, activeId, onTabs, onActive, pendingCwd, onPendingConsumed, visible,
}: Props) {
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const seq = useRef(1);

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

  const activePty = tabs.find((t) => t.id === activeId)?.pty;

  return (
    <div className="cs-term">
      <div className="cs-term-bar">
        <span className="cs-term-title" aria-hidden>⌨ Terminal</span>
        {tabs.map((t) => (
          <span key={t.id} className={`cs-term-tab${t.id === activeId ? ' on' : ''}`}>
            <button className="cs-term-tab-main" onClick={() => onActive(t.id)} title={t.pty ? 'PTY (ConPTY) — TUI OK' : 'pipes fallback'}>
              {t.label}
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
        {tabs.map((t) => (
          <XTermView key={t.id} id={t.id} active={t.id === activeId} visible={visible} />
        ))}
      </div>
    </div>
  );
}
