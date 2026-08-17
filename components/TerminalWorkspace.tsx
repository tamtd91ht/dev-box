'use client';

// Tab Terminal — shell thật ngay trong DevBox, không phải chọn project Git nào.
//
// HAI CHẾ ĐỘ MỞ, cùng một loại phiên:
//
//   ▸ Trong app  — phiên hiện thành một tab ở đây.
//   ▸ Cửa sổ rời — phiên hiện ở một cửa sổ Electron riêng (app/terminal/[id]).
//
// Khác biệt CHỈ là chỗ vẽ. Phiên luôn sống trong tiến trình Next server, nên
// đóng cửa sổ / app crash / F5 đều không giết shell: mở lại là replay ring
// buffer ra đúng màn hình đang có (xem lib/termSessions.ts). Phiên đang ở cửa
// sổ rời vẫn nằm trong danh sách bên dưới và "Đưa về tab" được bất cứ lúc nào.
//
// Mọi lựa chọn (shell · thư mục · mở ở đâu) hỏi trong popup NewTerminalDialog
// ngay lúc bấm ＋, không cấu hình sẵn trên thanh. Thư mục chạy đổi theo từng
// việc chứ không phải thiết lập ổn định, nên hỏi lúc bấm mới đúng nhịp làm
// việc — xem chú thích đầu NewTerminalDialog.tsx.

import { useCallback, useEffect, useMemo, useState } from 'react';
import XTermView from '@/components/terminal/XTermView';
import NewTerminalDialog, {
  type NewTerminalChoice, type OpenMode,
} from '@/components/terminal/NewTerminalDialog';
import CloseTerminalDialog from '@/components/terminal/CloseTerminalDialog';
import { tCreate, tList, tKill, tRename, tDetach, type ShellKind, type TermSessionInfo } from '@/lib/terminal';

// Lựa chọn LẦN TRƯỚC — chỉ dùng làm điểm khởi đầu cho popup (FolderPicker mở
// sẵn ở đó, shell chọn sẵn), KHÔNG phải giá trị mặc định áp thẳng. Mặc định
// luôn là thư mục app.
const LAST_CWD_KEY = 'devbox.terminal.lastCwd';
const LAST_SHELL_KEY = 'devbox.terminal.lastShell';

export default function TerminalWorkspace({ visible = true }: { visible?: boolean }) {
  const [sessions, setSessions] = useState<TermSessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [deadIds, setDeadIds] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [cwdDefault, setCwdDefault] = useState('');
  const [cwdHome, setCwdHome] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  // Phiên đang chờ xác nhận đóng — nút ✕ chỉ đặt vào đây, việc giết shell thật
  // nằm sau một cái bấm nữa trong popup (xem CloseTerminalDialog).
  const [pendingClose, setPendingClose] = useState<TermSessionInfo | null>(null);
  const [lastCwd, setLastCwd] = useState<string | undefined>();
  const [lastShell, setLastShell] = useState<ShellKind | undefined>();

  // Đổi tên tab tại chỗ.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');

  // ── Nạp lại danh sách phiên từ server ────────────────────────────────────
  // Đây là thứ làm cho "app crash vẫn giữ phiên" NHÌN THẤY ĐƯỢC: mở lại app,
  // tab này hỏi server và dựng lại đúng các tab đang chạy.
  const refresh = useCallback(async () => {
    try {
      const { sessions: list, cwdDefault: def, cwdHome: home } = await tList();
      setCwdDefault(def);
      setCwdHome(home);
      setSessions(list);
      setActiveId((cur) => {
        if (cur && list.some((s) => s.id === cur && !s.detached)) return cur;
        const firstInApp = list.find((s) => !s.detached && !s.exited);
        return firstInApp?.id ?? null;
      });
      setDeadIds((prev) => {
        const next = new Set(prev);
        for (const s of list) if (s.exited) next.add(s.id);
        return next;
      });
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    try {
      const c = window.localStorage.getItem(LAST_CWD_KEY);
      if (c) setLastCwd(c);
      const s = window.localStorage.getItem(LAST_SHELL_KEY);
      if (s === 'powershell' || s === 'cmd' || s === 'bash') setLastShell(s);
    } catch { /* localStorage bị chặn — không sao */ }
    void refresh();
  }, [refresh]);

  // Cửa sổ rời có thể đóng/mở phiên bất kỳ lúc nào → đồng bộ lại khi quay về
  // tab này. Rẻ (một POST 'list') và làm danh sách không bao giờ lệch thực tế.
  useEffect(() => {
    if (!visible || !loaded) return;
    void refresh();
  }, [visible, loaded, refresh]);

  /** Mở cửa sổ rời. Desktop → BrowserWindow riêng qua IPC; trình duyệt thường →
   *  window.open. Trả false nếu không mở được. */
  const openWindow = useCallback(async (id: string, label: string): Promise<boolean> => {
    if (window.workspace?.openTerminalWindow) {
      const r = await window.workspace.openTerminalWindow({ id, title: label });
      if (r?.ok) return true;
      setErr(r?.error || 'Không mở được cửa sổ terminal.');
      return false;
    }
    const w = window.open(`/terminal/${id}`, `vhs-term-${id}`, 'width=960,height=600');
    if (!w) {
      setErr('Trình duyệt chặn popup — cho phép popup rồi thử lại.');
      return false;
    }
    return true;
  }, []);

  // ── Mở phiên mới (từ popup) ──────────────────────────────────────────────
  const create = useCallback(async ({ shell, cwd, mode }: NewTerminalChoice) => {
    setBusy(true);
    setErr(null);
    try {
      const s = await tCreate({ cwd: cwd || undefined, shell });
      // Nhớ lựa chọn CHỈ để lần sau popup mở sẵn ở đó cho đỡ bấm lại.
      try {
        window.localStorage.setItem(LAST_CWD_KEY, cwd);
        window.localStorage.setItem(LAST_SHELL_KEY, shell);
      } catch { /* ignore */ }
      setLastCwd(cwd || undefined);
      setLastShell(shell);

      if (mode === 'window') {
        // Đánh dấu detached TRƯỚC khi mở cửa sổ: danh sách ở tab này hiện ngay
        // trạng thái đúng, không chờ cửa sổ kia báo về.
        await tDetach(s.id, true).catch(() => {});
        const ok = await openWindow(s.id, s.label);
        if (!ok) {
          // Không mở nổi cửa sổ → đừng bỏ rơi phiên vừa tạo: kéo về tab này.
          await tDetach(s.id, false).catch(() => {});
          setActiveId(s.id);
        }
      } else {
        setActiveId(s.id);
      }
      setDialogOpen(false);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
      // Lỗi (thư mục sai, hết slot…) thì GIỮ popup mở để sửa ngay tại chỗ.
    } finally {
      setBusy(false);
    }
  }, [openWindow, refresh]);

  // ── Thao tác trên một phiên ──────────────────────────────────────────────
  /** Bấm ✕ — KHÔNG đóng ngay, chỉ mở popup xác nhận. */
  const askClose = (s: TermSessionInfo) => setPendingClose(s);

  const close = async (s: TermSessionInfo) => {
    setPendingClose(null);
    await tKill(s.id).catch(() => {});
    setDeadIds((prev) => {
      const n = new Set(prev);
      n.delete(s.id);
      return n;
    });
    await refresh();
  };

  /** Đưa phiên đang ở cửa sổ rời về tab này (cửa sổ kia tự đóng khi thấy cờ đổi
   *  — xem app/terminal/[id]). Không đụng tới shell. */
  const attach = async (s: TermSessionInfo) => {
    await tDetach(s.id, false).catch(() => {});
    setActiveId(s.id);
    await refresh();
  };

  /** Đẩy phiên đang ở trong tab ra cửa sổ rời. */
  const detach = async (s: TermSessionInfo) => {
    await tDetach(s.id, true).catch(() => {});
    const ok = await openWindow(s.id, s.label);
    if (!ok) await tDetach(s.id, false).catch(() => {});
    await refresh();
  };

  const commitRename = async () => {
    if (!editingId) return;
    const label = draftLabel.trim();
    if (label) await tRename(editingId, label).catch(() => {});
    setEditingId(null);
    await refresh();
  };

  const markDead = useCallback((id: string) => {
    setDeadIds((s) => (s.has(id) ? s : new Set(s).add(id)));
  }, []);

  const inApp = useMemo(() => sessions.filter((s) => !s.detached), [sessions]);
  const detachedOnes = useMemo(() => sessions.filter((s) => s.detached), [sessions]);
  const active = inApp.find((s) => s.id === activeId) ?? null;

  /** Mở popup cho một chế độ cụ thể — nút ＋ trên thanh dùng chung một popup,
   *  người dùng chọn "trong app" hay "cửa sổ riêng" ngay trong đó. */
  const openDialog = () => {
    setErr(null);
    setDialogOpen(true);
  };

  return (
    <div className="tw">
      {/* ── Thanh: chỉ còn tab phiên + nút mở. Không cấu hình sẵn gì cả. ──── */}
      <div className="tw-bar">
        <span className="tw-title" aria-hidden>⌨ Terminal</span>

        {inApp.length > 0 && (
          <div className="tw-tabs" role="tablist">
            {inApp.map((s) => (
              <span
                key={s.id}
                className={`tw-tab${s.id === activeId ? ' on' : ''}${deadIds.has(s.id) ? ' dead' : ''}`}
              >
                {editingId === s.id ? (
                  <input
                    className="tw-tab-edit"
                    autoFocus
                    value={draftLabel}
                    onChange={(e) => setDraftLabel(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRename();
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                ) : (
                  <button
                    className="tw-tab-main"
                    role="tab"
                    aria-selected={s.id === activeId}
                    onClick={() => setActiveId(s.id)}
                    onDoubleClick={() => { setEditingId(s.id); setDraftLabel(s.label); }}
                    title={`${s.cwd}\n${s.pty ? 'PTY thật — TUI OK' : 'pipes fallback — TUI không vẽ đúng'}\nBấm đúp để đổi tên`}
                  >
                    {deadIds.has(s.id) && <span aria-hidden>⚠ </span>}
                    {s.label}
                  </button>
                )}
                <button
                  className="tw-tab-pop"
                  title="Đưa ra cửa sổ riêng (phiên không bị ngắt)"
                  onClick={() => void detach(s)}
                >
                  ⧉
                </button>
                <button className="tw-tab-x" title="Đóng phiên" onClick={() => askClose(s)}>✕</button>
              </span>
            ))}
          </div>
        )}

        <button
          className="tw-new"
          disabled={busy}
          onClick={openDialog}
          title="Mở terminal mới — chọn shell và thư mục trong hộp thoại"
        >
          ＋ Terminal mới
        </button>

        <span className="tw-gap" />
        {err && <span className="tw-err" title={err}>{err}</span>}
      </div>

      {/* ── Phiên đang ở cửa sổ rời ────────────────────────────────────────── */}
      {detachedOnes.length > 0 && (
        <div className="tw-detached">
          <span className="tw-detached-label" aria-hidden>⧉ Đang ở cửa sổ riêng:</span>
          {detachedOnes.map((s) => (
            <span key={s.id} className={`tw-chip${s.exited ? ' dead' : ''}`}>
              <span className="tw-chip-name" title={s.cwd}>{s.label}</span>
              <button
                className="tw-chip-btn"
                title="Mở lại cửa sổ cho phiên này"
                onClick={() => void openWindow(s.id, s.label)}
              >
                mở cửa sổ
              </button>
              <button className="tw-chip-btn" title="Đưa phiên về tab này" onClick={() => void attach(s)}>
                đưa về tab
              </button>
              <button className="tw-chip-x" title="Đóng phiên" onClick={() => askClose(s)}>✕</button>
            </span>
          ))}
        </div>
      )}

      {/* ── Khung terminal ─────────────────────────────────────────────────── */}
      <div className="tw-body">
        {loaded && inApp.length === 0 && (
          <div className="tw-empty">
            <div className="tw-empty-ico" aria-hidden>⌨</div>
            <h3>Chưa có terminal nào đang mở</h3>
            <p>
              Bấm <b>＋ Terminal mới</b> — hộp thoại sẽ hỏi shell và thư mục chạy,
              rồi cho chọn mở <b>trong app</b> hay ra <b>cửa sổ riêng</b>.
            </p>
            <p className="tw-empty-note">
              Thư mục mặc định là thư mục app
              {cwdDefault ? <> (<code>{cwdDefault}</code>)</> : null} — không cần chọn gì thêm.
              Phiên sống trong tiến trình server nên đóng cửa sổ hay app văng vẫn
              giữ nguyên: mở lại là thấy đúng màn hình cũ.
            </p>
            <button className="tw-new" disabled={busy} onClick={openDialog}>＋ Terminal mới</button>
            {detachedOnes.length > 0 && (
              <p className="tw-empty-note">
                Đang có {detachedOnes.length} phiên chạy ở cửa sổ riêng — xem danh sách phía trên.
              </p>
            )}
          </div>
        )}

        {active && active.pty === false && (
          <div className="tw-warn">
            Đang chạy chế độ <b>pipes</b> (node-pty không nạp được trong runtime này):
            lệnh thường vẫn chạy, nhưng app giao diện dòng lệnh (vim, claude…) sẽ không vẽ đúng.
          </div>
        )}

        {activeId && deadIds.has(activeId) && (
          <div className="tw-deadbar">
            Phiên này đã kết thúc.
            <button onClick={() => { const s = inApp.find((x) => x.id === activeId); if (s) void close(s); }}>
              Đóng tab
            </button>
            <button disabled={busy} onClick={openDialog}>⟳ Mở phiên mới</button>
          </div>
        )}

        {inApp.map((s) => (
          <XTermView
            key={s.id}
            id={s.id}
            base="/api/term"
            active={s.id === activeId}
            visible={visible}
            onDead={markDead}
          />
        ))}
      </div>

      {dialogOpen && (
        <NewTerminalDialog
          cwdDefault={cwdDefault}
          cwdHome={cwdHome}
          lastCwd={lastCwd}
          lastShell={lastShell}
          busy={busy}
          onConfirm={create}
          onClose={() => setDialogOpen(false)}
        />
      )}

      {pendingClose && (
        <CloseTerminalDialog
          label={pendingClose.label}
          cwd={pendingClose.cwd}
          exited={pendingClose.exited || deadIds.has(pendingClose.id)}
          onConfirm={() => void close(pendingClose)}
          onClose={() => setPendingClose(null)}
        />
      )}
    </div>
  );
}
