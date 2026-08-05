'use client';

// Ô nhập mật khẩu dùng chung: 👁 xem plaintext vừa nhập, ✕ xóa hết để nhập lại.
//
// Vì sao cần: mật khẩu App Password của Gmail dài 16 ký tự, dán/gõ sai một ký
// tự là báo "sai mật khẩu" mà không biết sai ở đâu. Xem được plaintext là kiểm
// tra được ngay; ✕ xóa sạch nhanh hơn Ctrl+A rồi Delete.

import { useState } from 'react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Đưa vào input gốc (autoFocus, title, onKeyDown…). */
  autoFocus?: boolean;
  title?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Class thêm cho wrapper — mặc định đã có .input để khớp form xung quanh. */
  className?: string;
}

export default function PasswordInput({
  value, onChange, placeholder, autoFocus, title, onKeyDown, className,
}: Props) {
  const [show, setShow] = useState(false);

  return (
    <span className={`pw-input${className ? ` ${className}` : ''}`}>
      <input
        className="pw-input-field"
        type={show ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        title={title}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        autoComplete="new-password"
        spellCheck={false}
      />
      {value && (
        <>
          <button type="button" className="pw-input-btn" tabIndex={-1}
            onClick={() => setShow((v) => !v)}
            title={show ? 'Ẩn mật khẩu' : 'Xem mật khẩu vừa nhập'}>
            {show ? '🙈' : '👁'}
          </button>
          <button type="button" className="pw-input-btn" tabIndex={-1}
            onClick={() => { onChange(''); setShow(false); }}
            title="Xóa hết để nhập lại">✕</button>
        </>
      )}
    </span>
  );
}
