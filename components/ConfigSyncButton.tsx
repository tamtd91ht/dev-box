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

import { useCallback, useEffect, useRef, useState } from 'react';

interface GitInfo { ahead: number; behind: number; dirty: boolean; lastCommit?: string }
interface SyncStatus {
  ready: boolean;
  reason?: string;
  repoDir: string;
  machineName?: string;
  canPush: boolean;
  canPull: boolean;
  vaultUpdatedAt?: string;
  vaultSizeKb?: number;
  localFiles: number;
  git?: GitInfo;
}

async function api<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/config-sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
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
  const [busy, setBusy] = useState<'' | 'push' | 'pull'>('');
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
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, busy]);

  useEffect(() => { if (askPass) passRef.current?.focus(); }, [askPass]);

  const doPush = async () => {
    setBusy('push');
    setMsg({ kind: 'info', text: 'Đang đóng gói và mã hoá…' });
    try {
      const r = await api<{ files: number; vaultKb: number; committed: boolean; pushed: boolean; skipped: string[] }>('push');
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
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally { setBusy(''); }
  };

  const doPull = async () => {
    if (!pass) { setMsg({ kind: 'err', text: 'Nhập passphrase đã.' }); return; }
    setBusy('pull');
    setMsg({ kind: 'info', text: 'Đang kéo về và giải mã…' });
    try {
      const r = await api<{ files: number; created: string[]; changed: string[] }>('pull', { passphrase: pass });
      setPass('');
      setAskPass(false);
      const parts = [`Đã ghi ${r.files} file`];
      if (r.created.length) parts.push(`mới: ${r.created.join(', ')}`);
      if (r.changed.length) parts.push(`cập nhật: ${r.changed.join(', ')}`);
      setMsg({ kind: 'ok', text: parts.join(' · ') + '.' });
      // Phần lớn store đọc file mỗi request nên tải lại trang là đủ để thấy
      // config mới — không cần khởi động lại cả app. Chỉ gợi ý, không tự làm:
      // tải lại giữa lúc người dùng đang nhập dở thì mất dữ liệu.
      setNeedReload(r.files > 0);
      await refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
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
            <button className="cfgsync-x" onClick={() => { setOpen(false); setAskPass(false); setPass(''); }}>×</button>
          </div>

          {!st ? (
            <div className="cfgsync-row muted">Đang đọc trạng thái…</div>
          ) : !st.ready ? (
            <>
              <div className="cfgsync-row warn">{st.reason}</div>
              <div className="cfgsync-row muted small">
                Repo: <code>{st.repoDir}</code>
              </div>
              <div className="cfgsync-row muted small">
                Xem hướng dẫn ở <code>HUONG-DAN.md</code> trong repo config.
              </div>
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
                <button className="cfgsync-go" onClick={doPush} disabled={!!busy || !st.canPush}>
                  {busy === 'push' ? 'Đang đẩy…' : '↑ Đẩy lên'}
                </button>
                <button
                  className="cfgsync-go alt"
                  onClick={() => { setAskPass((v) => !v); setMsg(null); }}
                  disabled={!!busy || !st.canPull}
                  title={st.canPull ? 'Cần passphrase để giải mã' : 'Repo chưa có age-key.enc'}
                >
                  ↓ Kéo về…
                </button>
              </div>

              {askPass && (
                <div className="cfgsync-pass">
                  <input
                    ref={passRef}
                    type="password"
                    placeholder="Passphrase"
                    value={pass}
                    onChange={(e) => setPass(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void doPull(); if (e.key === 'Escape') { setAskPass(false); setPass(''); } }}
                    autoComplete="off"
                  />
                  <button className="cfgsync-go" onClick={doPull} disabled={!!busy || !pass}>
                    {busy === 'pull' ? 'Đang kéo…' : 'Giải mã'}
                  </button>
                </div>
              )}

              {askPass && (
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
