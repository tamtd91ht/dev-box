'use client';

// Giao diện HỒ SƠ của tab Browser: nút avatar + menu chuyển hồ sơ (như Chrome),
// hộp thoại quản lý, ô chọn hồ sơ dùng cho form. Logic sổ nằm ở lib/browserProfiles.ts.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  PROFILE_COLORS, DEFAULT_PROFILE_ID, refOf, newProfileId, nextColor, nextName,
  type BrowserProfile,
} from '@/lib/browserProfiles';

const initialOf = (name: string) => (Array.from(name.trim())[0] ?? '•').toUpperCase();

/** Chấm tròn màu + chữ cái đầu — avatar của hồ sơ. */
export function ProfileDot({ p, size = 18 }: { p: BrowserProfile; size?: number }) {
  return (
    <span aria-hidden style={{
      flex: 'none', width: size, height: size, borderRadius: '50%', background: p.color,
      color: '#fff', fontSize: Math.round(size * 0.55), fontWeight: 700, lineHeight: `${size}px`,
      textAlign: 'center', display: 'inline-block',
    }}>{initialOf(p.name)}</span>
  );
}

/** Nút avatar ở thanh tab + menu thả xuống: chọn hồ sơ để mở TAB MỚI bằng nó. */
export function ProfileButton({ profiles, current, open, onOpenChange, onPick, onManage }: {
  profiles: BrowserProfile[];
  current: BrowserProfile;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPick: (p: BrowserProfile) => void;
  onManage: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const r = open ? btnRef.current?.getBoundingClientRect() : undefined;
  const W = 250;
  return (
    <div className="bt-menu-wrap">
      <button ref={btnRef} className={`ghost sm${open ? ' on' : ''}`} style={{ display: 'flex', alignItems: 'center', gap: 5 }}
        onClick={() => onOpenChange(!open)} aria-haspopup="menu" aria-expanded={open}
        title={`Hồ sơ: ${current.name} — mỗi hồ sơ giữ một phiên đăng nhập riêng`}>
        <ProfileDot p={current} />
      </button>
      {mounted && open && createPortal(
        <>
          <div className="bt-menu-backdrop" onMouseDown={() => onOpenChange(false)} />
          <div className="bt-menu bt-menu-fixed" role="menu" onMouseDown={(e) => e.stopPropagation()}
            style={{
              left: Math.max(6, Math.min((r?.right ?? window.innerWidth) - W, window.innerWidth - W - 6)),
              top: (r?.bottom ?? 40) + 4,
            }}>
            <div className="small" style={{ color: 'var(--muted)', padding: '4px 10px' }}>
              Mở tab mới bằng hồ sơ…
            </div>
            {profiles.map((p) => (
              <button key={p.id} role="menuitemradio" aria-checked={p.id === current.id}
                onClick={() => { onOpenChange(false); onPick(p); }}>
                <span className="bt-menu-check">{p.id === current.id ? '✓' : ''}</span>
                <ProfileDot p={p} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              </button>
            ))}
            <div className="bt-menu-sep" />
            <button onClick={() => { onOpenChange(false); onManage(); }}>
              <span className="bt-menu-check" />⚙ Quản lý hồ sơ…
            </button>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

/** Ô chọn hồ sơ cho form (ô địa chỉ, sửa dấu trang). `value` là ref ('' = mặc định). */
export function ProfileSelect({ profiles, value, onChange, style, title }: {
  profiles: BrowserProfile[];
  value: string;
  onChange: (ref: string) => void;
  style?: React.CSSProperties;
  title?: string;
}) {
  // Ref không có trong sổ (dấu trang trỏ tới hồ sơ đã xoá) vẫn phải hiện được,
  // nếu không <select> âm thầm nhảy về mục đầu và lưu lại làm đổi hồ sơ.
  const known = value === '' || profiles.some((p) => refOf(p) === value);
  return (
    <select className="input" style={{ width: 150, ...style }} value={value} title={title}
      onChange={(e) => onChange(e.target.value)}>
      {profiles.map((p) => <option key={p.id} value={refOf(p)}>{p.name}</option>)}
      {!known && <option value={value}>{value}</option>}
    </select>
  );
}

/** Hộp thoại quản lý: thêm, đổi tên/màu, đăng xuất (xoá phiên), xoá hồ sơ. */
export function ProfileManager({ profiles, tabCounts, onChange, onSignOut, onDelete, onClose }: {
  profiles: BrowserProfile[];
  /** Số tab đang mở theo id hồ sơ. */
  tabCounts: Record<string, number>;
  onChange: (list: BrowserProfile[]) => void;
  onSignOut: (p: BrowserProfile) => void;
  onDelete: (p: BrowserProfile) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const patch = (id: string, part: Partial<BrowserProfile>) =>
    onChange(profiles.map((p) => (p.id === id ? { ...p, ...part } : p)));
  const add = () => {
    const label = name.trim() || nextName(profiles);
    onChange([...profiles, { id: newProfileId(profiles), name: label, color: nextColor(profiles) }]);
    setName('');
  };

  return (
    <div className="bt-modal-back" onMouseDown={onClose}>
      <div className="bt-modal" style={{ width: 'min(560px, 94vw)', maxWidth: 'none' }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <b>👤 Hồ sơ trình duyệt</b><span style={{ flex: 1 }} />
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>
        <p className="small" style={{ color: 'var(--muted)', margin: 0 }}>
          Mỗi hồ sơ giữ <b>một phiên đăng nhập riêng</b>: đăng nhập Gmail/ChatGPT/Claude ở hồ sơ A và
          hồ sơ B bằng hai tài khoản khác nhau, mở song song được. Đổi tên hồ sơ không làm mất đăng nhập.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '50vh', overflowY: 'auto' }}>
          {profiles.map((p) => {
            const isDefault = p.id === DEFAULT_PROFILE_ID;
            const n = tabCounts[p.id] ?? 0;
            return (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ProfileDot p={p} size={24} />
                <input className="input" style={{ flex: 1, minWidth: 0 }} value={p.name}
                  onChange={(e) => patch(p.id, { name: e.target.value })}
                  onBlur={() => { if (!p.name.trim()) patch(p.id, { name: isDefault ? 'Mặc định' : p.id }); }} />
                <span style={{ display: 'flex', gap: 3 }}>
                  {PROFILE_COLORS.map((c) => (
                    <button key={c} title={c} onClick={() => patch(p.id, { color: c })}
                      style={{
                        width: 14, height: 14, borderRadius: '50%', background: c, padding: 0, cursor: 'pointer',
                        border: c === p.color ? '2px solid var(--text)' : '2px solid transparent',
                      }} />
                  ))}
                </span>
                <span className="small" style={{ color: 'var(--faint)', width: 44, textAlign: 'right' }}>
                  {n > 0 ? `${n} tab` : ''}
                </span>
                <button className="ghost sm" title="Đăng xuất: xoá cookie/dữ liệu trang của hồ sơ này"
                  onClick={() => onSignOut(p)}>⎋</button>
                <button className="ghost sm" disabled={isDefault} style={{ color: isDefault ? undefined : 'var(--err)' }}
                  title={isDefault ? 'Hồ sơ mặc định không xoá được' : 'Xoá hồ sơ + toàn bộ phiên đăng nhập của nó'}
                  onClick={() => onDelete(p)}>🗑</button>
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <input className="input" style={{ flex: 1 }} placeholder={`Tên hồ sơ mới (vd. ${nextName(profiles)}, Claude cá nhân…)`}
            value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
          <button onClick={add}>＋ Thêm hồ sơ</button>
        </div>
      </div>
    </div>
  );
}
