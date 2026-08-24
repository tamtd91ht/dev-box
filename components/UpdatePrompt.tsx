'use client';

// Hỏi cập nhật NGAY LÚC MỞ APP: "có bản mới, cập nhật không?".
//
// VÌ SAO CẦN, KHI ĐÃ CÓ NÚT ⬇ Ở FOOTER: nút đó chỉ hiện một badge số nhỏ và chờ
// người dùng để ý — mở app làm việc thì chẳng ai ngó xuống footer, nên có bản mới
// cả tuần vẫn chạy bản cũ. Hộp thoại này chủ động hỏi MỘT LẦN lúc mở app rồi
// biến mất; bỏ qua là dùng bình thường.
//
// LUỒNG:
//   1. mở app → chờ START_DELAY_MS (để app vẽ xong, đừng đập hộp thoại vào mặt
//      người dùng ngay khi màn hình còn trống) → status{fetch:true}
//   2. behind === 0 → không hiện gì cả. Đây là ca thường gặp nhất, nên nó phải
//      im lặng hoàn toàn.
//   3. behind > 0 → hộp thoại + danh sách commit sắp nhận
//        · "Cập nhật ngay"  → pull → tự làm việc tiếp (reload / restart /
//                             npm install + restart) theo followUp của server
//        · "Để sau"         → đóng, app chạy bình thường
//
// LUÔN HỎI, KHÔNG BAO GIỜ TỰ PULL. Kéo code mới rồi khởi động lại là thay thứ
// đang chạy dưới chân người dùng, nên chỉ đi khi họ bấm đồng ý. Và "để sau" là
// để sau CHO LẦN NÀY: lần mở app sau mà vẫn còn bản mới thì vẫn hỏi lại — nhớ
// lựa chọn cũ để im lặng luôn thì đúng bằng việc âm thầm tắt tính năng.
//
// Không muốn bị hỏi thì tắt hẳn: SELF_UPDATE_PROMPT=false trong .env.local
// (server trả cờ promptOnStart, xem lib/selfUpdate.ts) — lúc đó cập nhật bằng
// nút ⬇ ở footer.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useModalOverWebview } from '@/lib/useOverWebview';

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
  promptOnStart: boolean;
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

/** Chờ app vẽ xong rồi mới hỏi — mở app ra mà bị hộp thoại đập vào mặt ngay
 *  giữa lúc màn hình còn đang dựng thì rất khó chịu. */
const START_DELAY_MS = 2500;

export default function UpdatePrompt() {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'' | 'update' | 'install'>('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  /** Pull bị chặn vì repo bẩn → hiện file vướng + nút cất tạm. */
  const [dirtyBlock, setDirtyBlock] = useState<string[] | null>(null);
  /** Đã pull xong, còn một việc cuối (reload/restart/install) chờ bấm. */
  const [done, setDone] = useState<UpdateResult | null>(null);
  /** Chỉ chạy phần kiểm tra MỘT LẦN mỗi lần mở app, kể cả khi React
   *  StrictMode gọi effect hai lượt ở dev. */
  const ranRef = useRef(false);

  /** Mở lại app (Electron). Trên browser thường thì không có gì để mở lại. */
  const doRelaunch = useCallback(async () => {
    const bridge = window.desktopUpdate;
    if (!bridge?.relaunch) {
      setMsg({ kind: 'info', text: 'Đã cập nhật. Hãy đóng và mở lại app DevBox để nhận thay đổi.' });
      return;
    }
    const r = await bridge.relaunch().catch((e: Error) => ({ ok: false, error: e.message }));
    // Thành công thì tiến trình chết luôn — dòng dưới không bao giờ chạy tới.
    if (!r?.ok) {
      setMsg({
        kind: 'err',
        text: `Không khởi động lại được: ${r?.error || 'lỗi không rõ'}. Hãy đóng và mở lại app.`,
      });
    }
  }, []);

  /** Làm nốt việc sau khi pull: F5, mở lại app, hoặc npm install rồi mở lại. */
  const finish = useCallback(async (r: UpdateResult) => {
    if (r.followUp === 'reload') {
      window.location.reload();
      return;
    }
    if (r.followUp === 'restart') {
      await doRelaunch();
      return;
    }
    setBusy('install');
    setMsg({ kind: 'info', text: 'Đang cài thư viện mới — có thể mất vài phút…' });
    try {
      await api<{ log: string }>('install');
      setMsg({ kind: 'ok', text: 'Cài xong. Đang khởi động lại app…' });
      await doRelaunch();
    } catch (e) {
      setMsg({ kind: 'err', text: `Cài thư viện thất bại: ${(e as Error).message}` });
    } finally {
      setBusy('');
    }
  }, [doRelaunch]);

  /** @param stash người dùng đã chủ động đồng ý cất tạm thay đổi đang dở. */
  const doUpdate = useCallback(async (stash = false) => {
    setBusy('update');
    setDirtyBlock(null);
    setMsg({ kind: 'info', text: stash ? 'Đang cất tạm rồi cập nhật…' : 'Đang tải bản mới…' });
    try {
      const r = await api<UpdateResult>('update', { stash });
      if (!r.updated) {
        // Ai đó vừa pull ở terminal trong lúc hộp thoại đang mở.
        setOpen(false);
        return;
      }
      setDone(r);
      setMsg({
        kind: 'ok',
        text:
          `Đã tải ${r.count} thay đổi (${r.fromHead} → ${r.toHead}).` +
          (r.stashed ? ' Thay đổi cũ đã cất tạm, lấy lại bằng "git stash pop".' : ''),
      });
      // followUp='reload' thì làm luôn: người dùng đã đồng ý cập nhật, bắt bấm
      // thêm một nút "tải lại" nữa là thừa. restart/install mới cần hỏi vì nó
      // đóng app (và mọi phiên terminal đang mở).
      if (r.followUp === 'reload') await finish(r);
    } catch (e) {
      const err = e as ApiError;
      // Repo bẩn: KHÔNG tự quyết hộ — bày đúng file đang vướng rồi để người dùng
      // chọn cất tạm hay tự xử lý. Không bao giờ vứt việc chưa commit của họ.
      if (err.code === 'DIRTY') setDirtyBlock(err.files ?? []);
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy('');
    }
  }, [finish]);

  // ── Kiểm tra lúc mở app ───────────────────────────────────────────────────
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    let alive = true;
    const t = setTimeout(async () => {
      let s: UpdateStatus;
      try {
        s = await api<UpdateStatus>('status', { fetch: true });
      } catch {
        // Mất mạng / chưa cài git / thư mục không phải repo: IM LẶNG. Đây là
        // tính năng phụ trợ lúc mở app — không có quyền làm ồn khi app vẫn chạy
        // tốt. Nút ⬇ ở footer vẫn hiện lỗi cho ai chủ động bấm vào.
        return;
      }
      if (!alive) return;
      setSt(s);

      if (!s.promptOnStart) return;                 // tắt bằng .env.local
      if (!s.isRepo || !s.upstream) return;         // không cập nhật được
      if (s.behind === 0) return;                   // đã mới nhất — ca thường gặp

      // Còn bản mới là hỏi. Không nhớ lựa chọn cũ để "lần sau khỏi hỏi": cờ
      // SELF_UPDATE_PROMPT là chỗ duy nhất quyết định có hỏi hay không.
      setOpen(true);
    }, START_DELAY_MS);

    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, []);

  /** "Để sau" — đóng hộp thoại, app chạy bình thường. Lần mở app sau, nếu vẫn
   *  còn bản mới thì vẫn hỏi lại. */
  const skip = useCallback(() => setOpen(false), []);

  // Esc = để sau. Chỉ khi không có việc đang chạy — đóng giữa lúc pull/install
  // là mất log của chính việc mình vừa khởi động.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && !done) skip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, done, skip]);

  // <webview> của Electron vẽ ở tầng native, nằm TRÊN mọi phần tử HTML bất kể
  // z-index — ở tab Links/Browser nó che mất hộp thoại này. Cờ trên <html> đẩy
  // tạm các pane webview ra ngoài màn hình (CSS lo phần còn lại); guest vẫn
  // sống, vẫn giữ phiên. Cùng cách UpdateButton/ConfigSyncButton đang dùng.
  useModalOverWebview(open, { focusHost: true });

  if (!open || !st) return null;

  const count = st.behind;

  return (
    <div className="modal-backdrop" onClick={() => !busy && !done && skip()}>
      <div className="modal upd-prompt" onClick={(e) => e.stopPropagation()}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>⬇ Có phiên bản mới</h3>
          {!busy && !done && (
            <button className="ghost sm" onClick={skip} title="Để sau (Esc)">✕</button>
          )}
        </div>

        <p className="small" style={{ margin: '0 0 10px', color: 'var(--muted)' }}>
          DevBox có <b>{count}</b> thay đổi mới trên <code>{st.upstream}</code>{' '}
          (đang ở <code>{st.head}</code>). Cập nhật bây giờ không?
        </p>

        {/* Sắp nhận về cái gì — để không cập nhật mù. */}
        {st.pending.length > 0 && (
          <ul className="upd-list">
            {st.pending.slice(0, 6).map((c) => (
              <li key={c.hash} title={`${c.hash} · ${c.author}`}>
                <code>{c.hash}</code> {c.subject}
              </li>
            ))}
            {st.pending.length > 6 && (
              <li className="muted">… và {st.pending.length - 6} thay đổi nữa</li>
            )}
          </ul>
        )}

        {/* Repo bẩn: liệt kê file vướng rồi mới cho cất tạm. */}
        {dirtyBlock && (
          <>
            <div className="cfgsync-row warn small">
              Thư mục app đang có {dirtyBlock.length} thay đổi chưa commit:
            </div>
            <ul className="upd-list">
              {dirtyBlock.slice(0, 6).map((f) => (
                <li key={f}><code>{f}</code></li>
              ))}
              {dirtyBlock.length > 6 && (
                <li className="muted">… và {dirtyBlock.length - 6} file nữa</li>
              )}
            </ul>
            <div className="cfgsync-row muted small">
              Cất tạm là <code>git stash -u</code> — không mất gì, lấy lại bằng{' '}
              <code>git stash pop</code>.
            </div>
          </>
        )}

        {msg && <div className={`cfgsync-msg ${msg.kind}`}>{msg.text}</div>}

        <div className="upd-prompt-acts">
          {/* Đã pull xong: chỉ còn việc cuối. */}
          {done?.updated ? (
            <>
              <button className="cfgsync-go" onClick={() => void finish(done)} disabled={!!busy}>
                {busy === 'install'
                  ? 'Đang cài…'
                  : done.followUp === 'install'
                    ? '📦 Cài thư viện & mở lại app'
                    : '⏻ Mở lại app'}
              </button>
              <button className="cfgsync-go alt" onClick={() => setOpen(false)} disabled={!!busy}>
                Để sau
              </button>
              <span className="small" style={{ color: 'var(--muted)', flexBasis: '100%' }}>
                {done.followUpReason} Các phiên terminal đang mở sẽ bị đóng.
              </span>
            </>
          ) : dirtyBlock ? (
            <>
              <button className="cfgsync-go" onClick={() => void doUpdate(true)} disabled={!!busy}>
                📦 Cất tạm rồi cập nhật
              </button>
              <button className="cfgsync-go alt" onClick={skip} disabled={!!busy}>
                Để sau
              </button>
            </>
          ) : (
            <>
              <button className="cfgsync-go" onClick={() => void doUpdate()} disabled={!!busy}>
                {busy === 'update' ? 'Đang cập nhật…' : '⬇ Cập nhật ngay'}
              </button>
              <button className="cfgsync-go alt" onClick={skip} disabled={!!busy}>
                Để sau
              </button>
              <span className="small" style={{ color: 'var(--muted)', flexBasis: '100%' }}>
                Để sau thì app chạy bình thường, cập nhật lúc nào cũng được bằng nút ⬇ ở footer.
                Không muốn bị hỏi mỗi lần mở app: đặt <code>SELF_UPDATE_PROMPT=false</code> trong{' '}
                <code>.env.local</code>.
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
