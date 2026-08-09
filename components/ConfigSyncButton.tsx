'use client';

// Nút đồng bộ config ở footer + panel chi tiết.
//
// THIẾT KẾ: nút gọn luôn thấy ở mọi tab, có dấu hiệu trạng thái ngay trên nút
// (số commit chưa đẩy / đang có thay đổi) để biết cần sync mà không phải mở ra.
// Bấm nút = mở panel; trong panel có "Đẩy lên" (một cú bấm, không hỏi gì) và
// "Kéo về" (hiện ô nhập passphrase vì phải giải mã).
//
// VÌ SAO PUSH KHÔNG HỎI PASSPHRASE: age mã hoá bằng public key (recipient mode),
// chỉ giải mã mới cần private key. Xem lib/configSync.ts.
//
// LƯU Ý ELECTRON: panel này sống ở footer nhưng bung LÊN đè vùng workspace, nên
// phải tự lo hai chuyện mà panel thường không cần — đẩy webview đi chỗ khác để
// không bị che, và đòi lại focus để ô passphrase gõ được. Chi tiết ở effect
// `data-modal-over-webview` bên dưới.

import { useCallback, useEffect, useRef, useState } from 'react';

interface GitInfo { ahead: number; behind: number; dirty: boolean; lastCommit?: string }
interface SyncStatus {
  ready: boolean;
  reason?: string;
  /** App tự xử lý được cái đang thiếu → hiện nút "Thiết lập". */
  fixable?: 'clone' | 'machine' | 'age' | null;
  repoDir: string;
  machineName?: string;
  canPush: boolean;
  canPull: boolean;
  vaultUpdatedAt?: string;
  vaultSizeKb?: number;
  localFiles: number;
  git?: GitInfo;
}

/** Vault sắp bị đẩy hụt — kèm theo lỗi SHRINK để liệt kê cái sắp mất. */
interface ShrinkDetail {
  missing: string[];
  newCount: number;
  oldCount?: number;
  newKb: number;
  oldKb: number;
  comparedTo: string;
}

/** Lỗi kèm `code` để phân biệt trường hợp xử lý được bằng nút. */
class ApiError extends Error {
  code?: string;
  detail?: ShrinkDetail;
  constructor(message: string, code?: string, detail?: ShrinkDetail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

async function api<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/config-sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) {
    throw new ApiError(data.error || `HTTP ${r.status}`, data.code, data.detail);
  }
  return data.result as T;
}

function fmtAgo(iso?: string): string {
  if (!iso) return 'chưa bao giờ';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  return `${Math.floor(h / 24)} ngày trước`;
}

export default function ConfigSyncButton() {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState<'' | 'push' | 'pull' | 'setup'>('');
  /** Pull bị chặn vì hai máy cùng sửa → hiện nút ghi đè. */
  const [diverged, setDiverged] = useState(false);
  /** Push bị lưới an toàn chặn vì sẽ làm hụt vault → hiện cái sắp mất + nút ép. */
  const [shrink, setShrink] = useState<ShrinkDetail | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [askPass, setAskPass] = useState(false);
  const [pass, setPass] = useState('');
  const [needReload, setNeedReload] = useState(false);
  const passRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try { setSt(await api<SyncStatus>('status')); }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  }, []);

  // Nạp trạng thái khi mở panel, và làm mới định kỳ trong lúc panel mở để thấy
  // ngay khi máy khác vừa push (git behind tăng).
  useEffect(() => {
    if (!open) return;
    void refresh();
    const t = setInterval(() => { void refresh(); }, 30000);
    return () => clearInterval(t);
  }, [open, refresh]);

  // Nạp một lần lúc mount để nút hiện được badge mà không cần mở panel.
  useEffect(() => { void refresh(); }, [refresh]);

  // Bấm ra ngoài thì đóng — trừ khi đang chạy, tránh mất log giữa chừng.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (busy) return;
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
        setAskPass(false);
        setPass('');
        setShrink(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, busy]);

  // Panel mở ĐÈ lên vùng workspace, mà <webview> của Electron vẽ ở tầng native
  // nằm trên mọi phần tử HTML bất kể z-index — ở tab Links/Browser/Workspace nó
  // che mất cả panel. Cờ trên <html> đẩy tạm các pane webview ra ngoài màn hình
  // (CSS lo phần còn lại); guest vẫn sống, vẫn giữ phiên. Giống UltraBar.
  //
  // Kèm theo: KÉO FOCUS VỀ HOST. Electron bug — khi một <webview> guest đang giữ
  // focus thì mọi input trên host page chết, nhìn y như bị disable (xem
  // workspace:focusHost trong electron/main.cjs). Ô passphrase bên dưới dính
  // đúng ca này: đang ở tab Zalo/Links, bấm sang tab khác rồi mở Sync — guest đã
  // đi offscreen nhưng vẫn cầm focus, gõ vào ô không ra chữ nào.
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

  // Đòi focus về host TRƯỚC rồi mới focus ô: nếu guest còn cầm focus thì
  // .focus() ở đây chỉ đặt được :focus trên DOM, phím gõ vẫn rơi vào guest.
  useEffect(() => {
    if (!askPass) return;
    void Promise.resolve(window.workspace?.focusHost?.())
      .catch(() => {})
      .finally(() => passRef.current?.focus());
  }, [askPass]);

  const doPush = async (force = false) => {
    setBusy('push');
    setMsg({ kind: 'info', text: force ? 'Đang ghi đè vault…' : 'Đang đóng gói và mã hoá…' });
    try {
      const r = await api<{ files: number; vaultKb: number; committed: boolean; pushed: boolean; skipped: string[] }>(
        'push', { force },
      );
      setShrink(null);
      if (!r.committed) setMsg({ kind: 'info', text: 'Không có gì thay đổi — vault đã khớp với máy.' });
      else {
        setMsg({
          kind: 'ok',
          text: `Đã đẩy ${r.files} file (${r.vaultKb} KB)`
            + (r.pushed ? ' lên GitHub.' : ' — đã commit, chưa đẩy được lên remote.')
            + (r.skipped.length ? ` Bỏ qua: ${r.skipped.join(', ')}.` : ''),
        });
      }
      await refresh();
    } catch (e) {
      const err = e as ApiError;
      // Máy này sắp xoá mất config của máy khác. Không tự quyết hộ — bày ra
      // đúng file nào sắp mất rồi để người dùng chọn.
      if (err.code === 'SHRINK' && err.detail) setShrink(err.detail);
      setMsg({ kind: 'err', text: err.message });
    } finally { setBusy(''); }
  };

  const doSetup = async () => {
    setBusy('setup');
    setMsg({ kind: 'info', text: 'Đang thiết lập — có thể mất một phút nếu phải cài age…' });
    try {
      const r = await api<{ log: string[]; status: SyncStatus }>('setup');
      setSt(r.status);
      setMsg({
        kind: r.status.ready ? 'ok' : 'info',
        text: r.log.join(' · ') + (r.status.ready ? ' — xong, bấm "Kéo về" để lấy config.' : ''),
      });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally { setBusy(''); }
  };

  const doPull = async (force = false) => {
    if (!pass) { setMsg({ kind: 'err', text: 'Nhập passphrase đã.' }); return; }
    setBusy('pull');
    setMsg({ kind: 'info', text: force ? 'Đang ghi đè bằng bản trên GitHub…' : 'Đang kéo về và giải mã…' });
    try {
      const r = await api<{ files: number; created: string[]; changed: string[]; skipped: string[] }>(
        'pull', { passphrase: pass, force },
      );
      setPass('');
      setAskPass(false);
      setDiverged(false);
      const parts = [`Đã ghi ${r.files} file`];
      if (r.created.length) parts.push(`mới: ${r.created.join(', ')}`);
      if (r.changed.length) parts.push(`cập nhật: ${r.changed.join(', ')}`);
      // File trong danh sách exclude giữ nguyên bản của máy này — nói rõ ra,
      // nếu không người dùng tưởng kéo về xong là mọi thứ đã giống máy kia.
      if (r.skipped?.length) parts.push(`giữ nguyên của máy này: ${r.skipped.join(', ')}`);
      setMsg({ kind: 'ok', text: parts.join(' · ') + '.' });
      // Phần lớn store đọc file mỗi request nên tải lại trang là đủ để thấy
      // config mới — không cần khởi động lại cả app. Chỉ gợi ý, không tự làm:
      // tải lại giữa lúc người dùng đang nhập dở thì mất dữ liệu.
      setNeedReload(r.files > 0);
      await refresh();
    } catch (e) {
      const err = e as ApiError;
      // Hai máy cùng sửa → không kéo về thẳng được. Giữ passphrase đã nhập và
      // hiện nút ghi đè, để người dùng quyết chứ không tự ý bỏ dữ liệu của họ.
      if (err.code === 'DIVERGED') setDiverged(true);
      setMsg({ kind: 'err', text: err.message });
    } finally { setBusy(''); }
  };

  // Badge trên nút: ưu tiên cảnh báo cần chú ý nhất.
  const badge = (() => {
    if (!st) return null;
    if (!st.ready) return { text: '!', title: st.reason || 'Chưa cấu hình', cls: 'warn' };
    if (st.git?.behind) return { text: `↓${st.git.behind}`, title: `Máy khác đã push ${st.git.behind} lần — nên kéo về`, cls: 'warn' };
    if (st.git?.ahead) return { text: `↑${st.git.ahead}`, title: `${st.git.ahead} commit chưa đẩy lên GitHub`, cls: 'warn' };
    if (st.git?.dirty) return { text: '•', title: 'Có thay đổi chưa đẩy', cls: 'dirty' };
    return null;
  })();

  return (
    <div className="cfgsync">
      <button
        className={'cfgsync-btn' + (open ? ' on' : '')}
        onClick={() => setOpen((v) => !v)}
        title={st?.ready ? `Đồng bộ config · ${st.machineName || ''}` : (st?.reason || 'Đồng bộ config')}
      >
        <span className={'cfgsync-ic' + (busy ? ' spin' : '')}>⟳</span>
        <span>Sync</span>
        {badge && <span className={`cfgsync-badge ${badge.cls}`} title={badge.title}>{badge.text}</span>}
      </button>

      {open && (
        <div className="cfgsync-panel" ref={panelRef}>
          <div className="cfgsync-head">
            <b>Đồng bộ config</b>
            <button
              className="cfgsync-x"
              onClick={() => { setOpen(false); setAskPass(false); setPass(''); setShrink(null); }}
            >
              ×
            </button>
          </div>

          {!st ? (
            <div className="cfgsync-row muted">Đang đọc trạng thái…</div>
          ) : !st.ready ? (
            <>
              <div className="cfgsync-row warn">{st.reason}</div>
              {st.fixable ? (
                <>
                  {/* Máy mới: app tự cài age, tải repo config, sinh machine.json.
                      Trước đây bắt chạy 7 lệnh PowerShell — không có lý gì. */}
                  <button className="cfgsync-go" onClick={doSetup} disabled={!!busy}>
                    {busy === 'setup' ? 'Đang thiết lập…' : '⚙ Thiết lập tự động'}
                  </button>
                  <div className="cfgsync-row muted small">
                    Sẽ cài <code>age</code> nếu thiếu, tải repo config về{' '}
                    <code>{st.repoDir}</code>, và khai đường dẫn cho máy này.
                  </div>
                </>
              ) : (
                <div className="cfgsync-row muted small">
                  Repo: <code>{st.repoDir}</code> — xem <code>HUONG-DAN.md</code>.
                </div>
              )}
            </>
          ) : (
            <>
              <div className="cfgsync-grid">
                <span className="muted">Máy này</span><span>{st.machineName || '—'}</span>
                <span className="muted">Config local</span><span>{st.localFiles} file</span>
                <span className="muted">Đẩy lên lần cuối</span>
                <span>{fmtAgo(st.vaultUpdatedAt)}{st.vaultSizeKb ? ` · ${st.vaultSizeKb} KB` : ''}</span>
                {st.git && (
                  <>
                    <span className="muted">GitHub</span>
                    <span>
                      {st.git.behind > 0 && <b className="warn">↓{st.git.behind} cần kéo về </b>}
                      {st.git.ahead > 0 && <b className="warn">↑{st.git.ahead} chưa đẩy </b>}
                      {!st.git.behind && !st.git.ahead && 'đã khớp'}
                    </span>
                  </>
                )}
              </div>

              <div className="cfgsync-actions">
                {/* doPush() không tham số — truyền thẳng hàm cho onClick thì
                    React nhét event vào chỗ `force` (event truthy → ép ghi đè). */}
                <button className="cfgsync-go" onClick={() => void doPush()} disabled={!!busy || !st.canPush}>
                  {busy === 'push' ? 'Đang đẩy…' : '↑ Đẩy lên'}
                </button>
                <button
                  className="cfgsync-go alt"
                  onClick={() => { setAskPass((v) => !v); setMsg(null); setShrink(null); }}
                  disabled={!!busy || !st.canPull}
                  title={st.canPull ? 'Cần passphrase để giải mã' : 'Repo chưa có age-key.enc'}
                >
                  ↓ Kéo về…
                </button>
              </div>

              {/* Lưới an toàn chặn push: liệt kê thẳng file sắp mất rồi mới cho
                  ép. Chuỗi "còn N file" quan trọng hơn con số KB — người dùng
                  nhận ra "ủa máy này có mỗi 1 file" nhanh hơn nhiều. */}
              {shrink && (
                <>
                  <div className="cfgsync-row warn small">
                    Bản trên <code>{shrink.comparedTo}</code>{' '}
                    {shrink.oldCount !== undefined
                      ? <>có <b>{shrink.oldCount} file</b></>
                      : <>nặng <b>{shrink.oldKb} KB</b></>}
                    {' '}· máy này gói được <b>{shrink.newCount} file</b> ({shrink.newKb} KB).
                  </div>
                  {shrink.missing.length > 0 && (
                    <div className="cfgsync-row small">
                      Đẩy lên sẽ xoá mất:{' '}
                      {shrink.missing.map((n) => <code key={n}>{n}</code>)}
                    </div>
                  )}
                  <button
                    className="cfgsync-go danger"
                    onClick={() => void doPush(true)}
                    disabled={!!busy}
                    title="Thay hẳn vault trên GitHub bằng bản của máy này"
                  >
                    ⚠ Vẫn đẩy, ghi đè
                  </button>
                  <div className="cfgsync-row muted small">
                    Máy này chưa Kéo về lần nào thì <b>Kéo về trước</b> — đẩy lên
                    bây giờ là xoá config của máy khác. Lỡ đẩy rồi vẫn lấy lại
                    được bằng <code>git revert</code>, nhưng đừng dựa vào đó.
                  </div>
                </>
              )}

              {askPass && (
                <div className="cfgsync-pass">
                  <input
                    ref={passRef}
                    type="password"
                    placeholder="Passphrase"
                    value={pass}
                    onChange={(e) => setPass(e.target.value)}
                    onKeyDown={(e) => {
                      // Gọi doPull() không tham số — KHÔNG truyền hàm trực tiếp cho
                      // onClick/onKeyDown, vì React đưa event vào chỗ `force`
                      // (event là truthy → hoá ra luôn ghi đè).
                      if (e.key === 'Enter') void doPull();
                      if (e.key === 'Escape') { setAskPass(false); setPass(''); setDiverged(false); }
                    }}
                    autoComplete="off"
                  />
                  <button className="cfgsync-go" onClick={() => void doPull()} disabled={!!busy || !pass}>
                    {busy === 'pull' ? 'Đang kéo…' : 'Giải mã'}
                  </button>
                </div>
              )}

              {askPass && diverged && (
                <>
                  <button
                    className="cfgsync-go danger"
                    onClick={() => void doPull(true)}
                    disabled={!!busy || !pass}
                    title="git reset --hard origin — bỏ commit/thay đổi chỉ có ở máy này"
                  >
                    ⚠ Ghi đè bằng bản trên GitHub
                  </button>
                  <div className="cfgsync-row muted small">
                    Máy này và GitHub đã lệch nhau. Ghi đè sẽ <b>bỏ</b> thay đổi chưa
                    đẩy của máy này và lấy hẳn bản trên GitHub. Nếu config máy này
                    mới hơn thì <b>Đẩy lên</b> trước, đừng ghi đè.
                  </div>
                </>
              )}

              {askPass && !diverged && (
                <div className="cfgsync-row muted small">
                  Kéo về sẽ ghi đè config trên máy (bản cũ lưu thành <code>.bak-*</code>).
                  Nên đẩy lên trước nếu máy này có thay đổi chưa lưu.
                </div>
              )}
            </>
          )}

          {msg && <div className={`cfgsync-msg ${msg.kind}`}>{msg.text}</div>}

          {needReload && (
            <button className="cfgsync-go" onClick={() => window.location.reload()}>
              ⟳ Tải lại để dùng config mới
            </button>
          )}
        </div>
      )}
    </div>
  );
}
