'use client';

// Trình quản lý mật khẩu đã lưu (tab Browser) — "chrome://password-manager" bản
// local: xem/sửa/xóa, hiện mật khẩu (👁), copy, và thêm tay một bản ghi mới.
//
// Mật khẩu chỉ được giải mã KHI BẤM 👁 (gọi pwReveal → safeStorage), không tải
// sẵn cả danh sách plaintext vào bộ nhớ trang.

import { useCallback, useEffect, useState } from 'react';
import {
  pwList, pwRemove, pwSave, pwUpdate, pwReveal, canEncrypt, hostOfOrigin, type Credential,
} from '@/lib/passwords';
import PasswordInput from './PasswordInput';

/** Form thêm/sửa. id rỗng = thêm mới. */
interface Draft { id: string; origin: string; username: string; password: string; profile: string; label: string }

const emptyDraft = (): Draft => ({ id: '', origin: '', username: '', password: '', profile: '', label: '' });

export default function PasswordManager({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Credential[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  /** id → mật khẩu đã giải mã đang hiện (bấm 👁 lần nữa để ẩn). */
  const [shown, setShown] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    try { setItems(await pwList()); setErr(null); }
    catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  // Esc đóng cả form đang mở, rồi mới đóng modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (draft) setDraft(null); else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, onClose]);

  const toggleShow = async (c: Credential) => {
    if (shown[c.id] !== undefined) {
      setShown((s) => { const n = { ...s }; delete n[c.id]; return n; });
      return;
    }
    try {
      const plain = await pwReveal(c.id);
      setShown((s) => ({ ...s, [c.id]: plain }));
    } catch (e) { setErr((e as Error).message); }
  };

  const save = async () => {
    if (!draft) return;
    try {
      if (draft.id) {
        setItems(await pwUpdate(draft.id, {
          username: draft.username, profile: draft.profile, label: draft.label,
          password: draft.password || undefined, // bỏ trống = giữ mật khẩu cũ
        }));
      } else {
        if (!draft.password) { setErr('Chưa nhập mật khẩu.'); return; }
        setItems(await pwSave(draft.origin, draft.username, draft.password, {
          profile: draft.profile, label: draft.label,
        }));
      }
      setDraft(null); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  };

  const remove = async (c: Credential) => {
    if (!window.confirm(`Xóa mật khẩu đã lưu cho ${hostOfOrigin(c.origin)}${c.username ? ` · ${c.username}` : ''}?`)) return;
    try { setItems(await pwRemove(c.id)); } catch (e) { setErr((e as Error).message); }
  };

  const needle = q.trim().toLowerCase();
  const shownItems = needle
    ? items.filter((c) => (c.origin + c.username + (c.label ?? '') + (c.profile ?? '')).toLowerCase().includes(needle))
    : items;
  const plaintextCount = items.filter((c) => c.cipher === 'none').length;

  return (
    <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mail-compose panel pw-mgr" style={{ width: 'min(760px, 96vw)' }}>
        <div className="mail-compose-head">
          <b>🔑 Mật khẩu đã lưu</b>
          <span className="small" style={{ color: 'var(--muted)' }}>({items.length})</span>
          <span style={{ flex: 1 }} />
          <input className="input sm" style={{ width: 180 }} placeholder="Tìm theo site / user…"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="ghost sm" onClick={() => setDraft(emptyDraft())} title="Thêm thủ công">＋ Thêm</button>
          <button className="ghost sm" onClick={() => void reload()} disabled={loading} title="Tải lại">
            {loading ? <span className="spinner" aria-hidden /> : '↻'}
          </button>
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>

        <p className="small" style={{ color: 'var(--muted)', margin: '2px 0 6px' }}>
          {canEncrypt()
            ? 'Mã hóa bằng Windows DPAPI (safeStorage) — chỉ user Windows này giải mã được. Lưu tại configs/passwords.json.'
            : '⚠ Đang chạy ngoài app desktop nên KHÔNG mã hóa được — mật khẩu lưu dạng plaintext trong configs/passwords.json.'}
          {plaintextCount > 0 && canEncrypt() && (
            <> {' '}<b>{plaintextCount}</b> bản ghi còn ở dạng plaintext (lưu từ khi chạy web thuần) — sửa &amp; nhập lại mật khẩu để mã hóa.</>
          )}
        </p>

        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '2px 0' }}>{err}</pre>}

        {draft && (
          <div className="glink-meta-form">
            <div className="glink-meta-pair">
              <input className="input" placeholder="Địa chỉ site (vd https://sso.example.com)" value={draft.origin}
                disabled={Boolean(draft.id)} title={draft.id ? 'Không đổi được site của bản ghi cũ — xóa rồi thêm lại' : ''}
                onChange={(e) => setDraft({ ...draft, origin: e.target.value })} />
              <input className="input" placeholder="Username" value={draft.username} autoComplete="off"
                onChange={(e) => setDraft({ ...draft, username: e.target.value })} />
            </div>
            <div className="glink-meta-pair">
              <PasswordInput value={draft.password} onChange={(v) => setDraft({ ...draft, password: v })}
                placeholder={draft.id ? 'Mật khẩu mới (bỏ trống = giữ nguyên)' : 'Mật khẩu'} />
              <input className="input" placeholder="Profile (optional)" value={draft.profile}
                title="Cùng origin nhưng hai tài khoản → đặt profile khác nhau, khớp với profile của tab."
                onChange={(e) => setDraft({ ...draft, profile: e.target.value })} />
              <input className="input" placeholder="Ghi chú (optional)" value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="sm" onClick={() => void save()}
                disabled={!draft.origin.trim() || (!draft.id && !draft.password)}>💾 Lưu</button>
              <button className="ghost sm" onClick={() => setDraft(null)}>Hủy</button>
            </div>
          </div>
        )}

        <div className="pw-list">
          {shownItems.map((c) => (
            <div key={c.id} className="pw-row">
              <span className="pw-site" title={c.origin}>
                {hostOfOrigin(c.origin)}
                {c.origin.startsWith('http://') && <span className="pw-insecure" title="Site không dùng HTTPS">http</span>}
              </span>
              <span className="pw-user" title={c.username}>{c.username || <em style={{ color: 'var(--faint)' }}>(không user)</em>}</span>
              <span className="pw-secret">
                {shown[c.id] !== undefined
                  ? <code>{shown[c.id]}</code>
                  : <span style={{ color: 'var(--faint)' }}>••••••••</span>}
              </span>
              <span className="pw-badges">
                {c.profile && <span className="glink-badge glink-profile" title={`Profile ${c.profile}`}>🔑 {c.profile}</span>}
                {c.label && <span className="glink-badge" title={c.label}>{c.label}</span>}
                {c.cipher === 'none' && <span className="pw-insecure" title="Chưa mã hóa — sửa và nhập lại mật khẩu để mã hóa">plaintext</span>}
              </span>
              <span className="pw-acts">
                <button className="bt-mark-act" onClick={() => void toggleShow(c)}
                  title={shown[c.id] !== undefined ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}>
                  {shown[c.id] !== undefined ? '🙈' : '👁'}
                </button>
                <button className="bt-mark-act" title="Copy mật khẩu"
                  onClick={() => void (async () => {
                    try { await navigator.clipboard.writeText(await pwReveal(c.id)); }
                    catch (e) { setErr((e as Error).message); }
                  })()}>⧉</button>
                <button className="bt-mark-act" title="Sửa"
                  onClick={() => setDraft({
                    id: c.id, origin: c.origin, username: c.username, password: '',
                    profile: c.profile ?? '', label: c.label ?? '',
                  })}>✎</button>
                <button className="bt-mark-act" title="Xóa" onClick={() => void remove(c)}>✕</button>
              </span>
            </div>
          ))}
          {!loading && items.length === 0 && (
            <div className="empty" style={{ padding: '20px 8px' }}>
              <p className="small">
                Chưa lưu mật khẩu nào. Đăng nhập một trang trong tab Browser → hiện thanh
                &ldquo;Lưu mật khẩu?&rdquo; → bấm Lưu. Lần sau mở lại trang đó là tự điền.
              </p>
            </div>
          )}
          {!loading && items.length > 0 && shownItems.length === 0 && (
            <div className="empty" style={{ padding: '20px 8px' }}><p className="small">Không có bản ghi nào khớp.</p></div>
          )}
        </div>
      </div>
    </div>
  );
}
