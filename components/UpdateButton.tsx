'use client';

// Nút "Cập nhật" ở footer — kéo bản mới của CHÍNH DevBox từ Git về.
//
// THIẾT KẾ: giá trị lớn nhất của nút này là khi KHÔNG bấm — badge số commit
// đang chờ cho biết có bản mới mà không phải hỏi ai. Kiểm tra ngầm 30 phút một
// lần bằng `git fetch` (không đụng working tree nên chạy nền vô hại).
//
// Bấm vào thì panel liệt kê ĐÚNG NHỮNG COMMIT SẮP NHẬN trước khi cập nhật —
// người dùng biết mình sắp lấy về cái gì, thay vì cập nhật mù.
//
// SAU KHI PULL mới là phần đáng giá: app tự biết cần làm gì tiếp và làm hộ.
// `next dev` chạy từ chính repo này nên đa số lần chỉ cần F5; đụng electron/
// thì phải mở lại app; đụng package.json thì phải npm install trước đã.
// Xem decideFollowUp() trong lib/selfUpdate.ts.
//
// Dùng lại bộ style .cfgsync-* của ConfigSyncButton: hai nút đứng cạnh nhau ở
// footer, trông khác nhau thì vô lý. Chỉ thêm .upd-* cho danh sách commit.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getUnloadBlockers } from '@/lib/unloadGuard';

/** Cầu nối desktop cho việc khởi động lại — electron/preload.cjs. Vắng mặt
 *  khi chạy trên trình duyệt thường. */
interface DesktopUpdateBridge {
  relaunch: () => Promise<{ ok: boolean; error?: string }>;
  /**
   * Dọn cache rồi nạp lại. `wipeBuild` xoá luôn `.next` phía server.
   * `presets` là dữ liệu nút tìm nhanh gom từ localStorage để MAIN sao lưu hộ —
   * renderer không tự POST được khi 6 socket tới localhost:3000 bị SSE
   * terminal + automation chiếm hết (fetch xếp hàng vô hạn).
   */
  hardReload?: (opts?: { wipeBuild?: boolean; presets?: { kind: string; list: unknown[] }[] }) => Promise<{
    ok: boolean; error?: string; cleared?: string[]; needsRelaunch?: boolean;
  }>;
}

declare global {
  interface Window {
    desktopUpdate?: DesktopUpdateBridge;
  }
}

interface PendingCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

type FollowUp = 'reload' | 'restart' | 'install';

interface UpdateStatus {
  isRepo: boolean;
  reason?: string;
  branch: string;
  upstream: string;
  head: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  dirtyFiles: string[];
  pending: PendingCommit[];
  fetchedAt: number | null;
}

interface UpdateResult {
  updated: boolean;
  fromHead: string;
  toHead: string;
  count: number;
  followUp: FollowUp;
  followUpReason: string;
  stashed: boolean;
}

/** Lỗi kèm `code` để biết ca nào xử lý được bằng một nút nữa. */
class ApiError extends Error {
  code?: string;
  files?: string[];
  constructor(message: string, code?: string, files?: string[]) {
    super(message);
    this.code = code;
    this.files = files;
  }
}

async function api<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/self-update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) {
    throw new ApiError(data.error || `HTTP ${r.status}`, data.code, data.files);
  }
  return data.result as T;
}

function fmtAgo(ts?: number | null): string {
  if (!ts) return 'chưa kiểm tra';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  return `${Math.floor(h / 24)} ngày trước`;
}

/** Kiểm tra ngầm 30 phút một lần — chỉ fetch, không bao giờ tự pull. */
const CHECK_INTERVAL_MS = 30 * 60_000;

export default function UpdateButton() {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState<'' | 'check' | 'update' | 'install'>('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  /** Pull bị chặn vì repo bẩn → hiện danh sách file + nút cất tạm. */
  const [dirtyBlock, setDirtyBlock] = useState<string[] | null>(null);
  /** Đã pull xong, đang chờ người dùng bấm việc tiếp theo. */
  const [done, setDone] = useState<UpdateResult | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /** @param fetch true = chạm mạng lấy ref mới; false = chỉ đọc cục bộ. */
  const refresh = useCallback(async (fetch: boolean) => {
    try {
      setSt(await api<UpdateStatus>('status', { fetch }));
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    }
  }, []);

  // Lúc mount: đọc cục bộ ngay (badge hiện liền, không chờ mạng), rồi fetch
  // ngầm để con số phản ánh remote thật. Sau đó cứ 30 phút kiểm tra lại.
  useEffect(() => {
    void refresh(false);
    const first = setTimeout(() => void refresh(true), 4000);
    const timer = setInterval(() => void refresh(true), CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  // Mở panel = fetch ngay: người dùng chủ động mở ra thì muốn số liệu thật lúc
  // này, không phải cái đọc được từ 29 phút trước.
  useEffect(() => {
    if (!open) return;
    setBusy('check');
    void refresh(true).finally(() => setBusy(''));
  }, [open, refresh]);

  // Bấm ra ngoài thì đóng — trừ khi đang chạy, đóng giữa chừng là mất log.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (busy) return;
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
        setDirtyBlock(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, busy]);

  // Panel bung LÊN đè vùng workspace, mà <webview> của Electron vẽ ở tầng
  // native nằm trên mọi phần tử HTML bất kể z-index — ở tab Links/Browser nó
  // che mất panel. Cờ trên <html> đẩy tạm các pane webview ra ngoài màn hình
  // (CSS lo phần còn lại); guest vẫn sống, vẫn giữ phiên. Giống ConfigSyncButton.
  useEffect(() => {
    const root = document.documentElement;
    if (open) {
      root.setAttribute('data-modal-over-webview', '1');
      void window.workspace?.focusHost?.().catch(() => {});
    } else {
      root.removeAttribute('data-modal-over-webview');
    }
    return () => root.removeAttribute('data-modal-over-webview');
  }, [open]);

  /** @param stash người dùng đã chủ động đồng ý cất tạm thay đổi đang dở. */
  const doUpdate = async (stash = false) => {
    setBusy('update');
    setDirtyBlock(null);
    setMsg({ kind: 'info', text: stash ? 'Đang cất tạm rồi cập nhật…' : 'Đang cập nhật…' });
    try {
      const r = await api<UpdateResult>('update', { stash });
      if (!r.updated) {
        setMsg({ kind: 'ok', text: 'Đang ở bản mới nhất — không có gì để cập nhật.' });
        await refresh(false);
        return;
      }
      setDone(r);
      setMsg({
        kind: 'ok',
        text:
          `Đã cập nhật ${r.count} thay đổi (${r.fromHead} → ${r.toHead}).` +
          (r.stashed ? ' Thay đổi cũ đã cất tạm, lấy lại bằng "git stash pop".' : ''),
      });
      await refresh(false);
    } catch (e) {
      const err = e as ApiError;
      // Repo bẩn: KHÔNG tự quyết hộ. Bày ra đúng file nào đang vướng rồi để
      // người dùng chọn cất tạm hay tự xử lý — không bao giờ vứt việc của họ.
      if (err.code === 'DIRTY') setDirtyBlock(err.files ?? []);
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy('');
    }
  };

  /** Cài thư viện mới rồi khởi động lại — ca package.json đổi. */
  const doInstall = async () => {
    setBusy('install');
    setMsg({ kind: 'info', text: 'Đang cài thư viện mới — có thể mất vài phút…' });
    try {
      await api<{ log: string }>('install');
      setMsg({ kind: 'ok', text: 'Cài xong. Đang khởi động lại app…' });
      await doRelaunch();
    } catch (e) {
      setMsg({
        kind: 'err',
        text: `Cài thư viện thất bại: ${(e as Error).message}`,
      });
    } finally {
      setBusy('');
    }
  };

  /**
   * Mở lại app để nhận code mới của phần vỏ desktop.
   *
   * Chỉ có trên Electron. Chạy trên trình duyệt thường thì không có gì để khởi
   * động lại — bảo người dùng tự mở lại app desktop.
   */
  const doRelaunch = async () => {
    // beforeunload (tài liệu Office chưa lưu) làm app.quit() bị huỷ IM LẶNG
    // trong Electron — main không xử lý will-prevent-unload nên không có hộp
    // thoại nào, app cứ đứng đó như chưa bấm gì. Tra sổ unloadGuard trước để
    // nói rõ lý do thay vì để nút chết lặng.
    const blockers = getUnloadBlockers();
    if (blockers.length > 0) {
      setMsg({
        kind: 'err',
        text: `Chưa khởi động lại được: đang có ${blockers.join('; ')}. Lưu lại rồi bấm lại.`,
      });
      return;
    }
    const bridge = window.desktopUpdate;
    if (!bridge?.relaunch) {
      setMsg({
        kind: 'info',
        text: 'Đã cập nhật. Hãy đóng và mở lại app DevBox để nhận thay đổi.',
      });
      return;
    }
    const r = await bridge.relaunch().catch((e: Error) => ({ ok: false, error: e.message }));
    // Thành công thì tiến trình chết luôn, dòng này không bao giờ chạy tới.
    if (!r?.ok) {
      setMsg({
        kind: 'err',
        text: `Không khởi động lại được: ${r?.error || 'lỗi không rõ'}. Hãy đóng và mở lại app.`,
      });
      return;
    }
    // IPC trả ok nhưng tiến trình chưa chết: quit vẫn có thể bị blocker đăng ký
    // sau lượt kiểm tra trên chặn im lặng. Còn sống sau 3s thì nói thật.
    window.setTimeout(() => {
      setMsg({
        kind: 'err',
        text: 'App không tự thoát được (có thứ chặn unload). Hãy đóng và mở lại app thủ công.',
      });
    }, 3000);
  };

  // Badge trên nút — thứ khiến nút có ích khi không bấm vào.
  const badge = (() => {
    if (!st) return null;
    if (!st.isRepo || !st.upstream) {
      return { text: '!', title: st.reason || 'Không cập nhật được', cls: 'warn' };
    }
    if (st.behind > 0) {
      return {
        text: String(st.behind),
        title: `Có ${st.behind} thay đổi mới trên ${st.upstream}`,
        cls: 'warn',
      };
    }
    return null;
  })();

  const canUpdate = !!st?.isRepo && !!st.upstream && st.behind > 0;

  return (
    <div className="cfgsync">
      <button
        className={'cfgsync-btn' + (open ? ' on' : '')}
        onClick={() => setOpen((v) => !v)}
        title={
          st?.isRepo
            ? `Cập nhật DevBox · nhánh ${st.branch} · ${st.behind > 0 ? `${st.behind} thay đổi mới` : 'đã mới nhất'}`
            : st?.reason || 'Cập nhật DevBox'
        }
      >
        <span className={'cfgsync-ic' + (busy ? ' spin' : '')}>⬇</span>
        <span>Cập nhật</span>
        {badge && (
          <span className={`cfgsync-badge ${badge.cls}`} title={badge.title}>
            {badge.text}
          </span>
        )}
      </button>

      {open && (
        <div className="cfgsync-panel" ref={panelRef}>
          <div className="cfgsync-head">
            <b>Cập nhật DevBox</b>
            <button
              className="cfgsync-x"
              onClick={() => {
                setOpen(false);
                setDirtyBlock(null);
              }}
            >
              ×
            </button>
          </div>

          {!st ? (
            <div className="cfgsync-row muted">Đang đọc trạng thái…</div>
          ) : !st.isRepo || !st.upstream ? (
            <>
              <div className="cfgsync-row warn">{st.reason}</div>
              <div className="cfgsync-row muted small">
                Nút này chạy <code>git pull</code> trên chính thư mục app, nên chỉ dùng được khi app
                được cài bằng <code>git clone</code>.
              </div>
            </>
          ) : (
            <>
              <div className="cfgsync-grid">
                <span className="muted">Nhánh</span>
                <span>
                  {st.branch} <span className="muted">← {st.upstream}</span>
                </span>
                <span className="muted">Đang ở</span>
                <span>
                  <code>{st.head}</code>
                  {st.ahead > 0 && <b className="warn"> · {st.ahead} commit riêng chưa đẩy</b>}
                </span>
                <span className="muted">Trạng thái</span>
                <span>
                  {st.behind > 0 ? (
                    <b className="warn">{st.behind} thay đổi mới đang chờ</b>
                  ) : (
                    'đã là bản mới nhất'
                  )}
                </span>
                <span className="muted">Kiểm tra</span>
                <span>{busy === 'check' ? 'đang kiểm tra…' : fmtAgo(st.fetchedAt)}</span>
              </div>

              {/* Cái sắp nhận về — để người dùng không cập nhật mù. */}
              {st.pending.length > 0 && (
                <ul className="upd-list">
                  {st.pending.slice(0, 8).map((c) => (
                    <li key={c.hash} title={`${c.hash} · ${c.author}`}>
                      <code>{c.hash}</code> {c.subject}
                    </li>
                  ))}
                  {st.pending.length > 8 && (
                    <li className="muted">… và {st.pending.length - 8} thay đổi nữa</li>
                  )}
                </ul>
              )}

              <div className="cfgsync-actions">
                <button
                  className="cfgsync-go"
                  onClick={() => void doUpdate()}
                  disabled={!!busy || !canUpdate}
                  title={canUpdate ? `Kéo ${st.behind} thay đổi về` : 'Không có gì để cập nhật'}
                >
                  {busy === 'update' ? 'Đang cập nhật…' : '⬇ Cập nhật'}
                </button>
                <button
                  className="cfgsync-go alt"
                  onClick={() => {
                    setBusy('check');
                    setMsg(null);
                    void refresh(true).finally(() => setBusy(''));
                  }}
                  disabled={!!busy}
                >
                  ⟳ Kiểm tra lại
                </button>
              </div>

              {/* Repo bẩn: liệt kê thẳng file đang vướng rồi mới cho cất tạm.
                  Thấy tên file thì người dùng nhận ra ngay "à mình sửa dở cái
                  này" nhanh hơn nhiều so với một câu báo lỗi chung chung. */}
              {dirtyBlock && (
                <>
                  <div className="cfgsync-row warn small">
                    Thư mục app đang có {dirtyBlock.length} thay đổi chưa commit:
                  </div>
                  <ul className="upd-list">
                    {dirtyBlock.slice(0, 6).map((f) => (
                      <li key={f}>
                        <code>{f}</code>
                      </li>
                    ))}
                    {dirtyBlock.length > 6 && (
                      <li className="muted">… và {dirtyBlock.length - 6} file nữa</li>
                    )}
                  </ul>
                  <button
                    className="cfgsync-go alt"
                    onClick={() => void doUpdate(true)}
                    disabled={!!busy}
                    title="git stash -u rồi cập nhật — lấy lại sau bằng git stash pop"
                  >
                    📦 Cất tạm rồi cập nhật
                  </button>
                  <div className="cfgsync-row muted small">
                    Thay đổi được cất vào stash, không mất. Lấy lại ở tab Git hoặc{' '}
                    <code>git stash pop</code>.
                  </div>
                </>
              )}

              {/* Pull xong: app đã biết cần làm gì tiếp, chỉ chờ một cú bấm. */}
              {done?.updated && (
                <>
                  <div className="cfgsync-row small">{done.followUpReason}</div>
                  {done.followUp === 'reload' && (
                    <button
                      className="cfgsync-go"
                      onClick={() => {
                        // reload() cũng đi qua beforeunload → cùng kiểu bị huỷ
                        // im lặng khi còn tài liệu chưa lưu. Nói lý do ra.
                        const blocking = getUnloadBlockers();
                        if (blocking.length > 0) {
                          setMsg({ kind: 'err', text: `Chưa tải lại được: đang có ${blocking.join('; ')}. Lưu lại rồi bấm lại.` });
                          return;
                        }
                        window.location.reload();
                      }}
                    >
                      ⟳ Tải lại giao diện
                    </button>
                  )}
                  {done.followUp === 'restart' && (
                    <>
                      <button
                        className="cfgsync-go"
                        onClick={() => void doRelaunch()}
                        disabled={!!busy}
                      >
                        ⏻ Khởi động lại app
                      </button>
                      <div className="cfgsync-row muted small">
                        Các phiên terminal đang mở sẽ bị đóng.
                      </div>
                    </>
                  )}
                  {done.followUp === 'install' && (
                    <>
                      <button className="cfgsync-go" onClick={doInstall} disabled={!!busy}>
                        {busy === 'install' ? 'Đang cài…' : '📦 Cài thư viện & khởi động lại'}
                      </button>
                      <div className="cfgsync-row muted small">
                        Chạy <code>npm install</code> rồi mở lại app. Các phiên terminal đang mở sẽ
                        bị đóng.
                      </div>
                    </>
                  )}
                </>
              )}
            </>
          )}

          {msg && <div className={`cfgsync-msg ${msg.kind}`}>{msg.text}</div>}
        </div>
      )}
    </div>
  );
}
