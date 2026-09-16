'use client';

// LIÊN KẾT LẠI một hòm thư đang mất xác thực.
//
// VÌ SAO CẦN: mật khẩu mail hết hạn (chính sách 90 ngày), admin reset, hoặc
// server đổi endpoint — hòm thư đang chạy bỗng chết. Trước đây UI chỉ in đúng
// hai chữ "Command failed" (chuỗi thô của imapflow) và lối thoát duy nhất là
// GỠ hòm thư rồi THÊM LẠI, mất cả chữ ký lẫn tên đã đặt.
//
// Ở đây chỉ ghi đè THÔNG TIN ĐĂNG NHẬP: chữ ký, tên hiển thị, tên người gửi,
// cấu hình CalDAV… giữ nguyên. Server login thử TRƯỚC khi ghi đè, nên nhập sai
// thì hòm thư vẫn còn nguyên thông tin cũ.
//
// Host/port hiện sẵn giá trị đang dùng và sửa được: không ít ca "mất liên kết"
// thật ra là mail server chuyển sang endpoint khác chứ không phải sai mật khẩu.

import { useState } from 'react';
import { mAccountRelink, type MailAccountPub, type ImapFailureInfo, type MailActionError } from '@/lib/mail';
import PasswordInput from '../PasswordInput';
import MailErrorPanel from '../MailErrorPanel';

export default function RelinkModal({ account, onDone, onCancel }: {
  account: MailAccountPub;
  onDone: (list: MailAccountPub[]) => void;
  onCancel: () => void;
}) {
  const [pass, setPass] = useState('');
  const [user, setUser] = useState(account.user);
  const [imapHost, setImapHost] = useState(account.imap.host);
  const [imapPort, setImapPort] = useState(String(account.imap.port));
  const [smtpHost, setSmtpHost] = useState(account.smtp.host);
  const [smtpPort, setSmtpPort] = useState(String(account.smtp.port));
  /** Phần server gập lại — đa số ca chỉ cần gõ lại mật khẩu. */
  const [showServer, setShowServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [failure, setFailure] = useState<ImapFailureInfo | undefined>();

  const submit = async () => {
    if (!pass || busy) return;
    setBusy(true); setErr(null); setFailure(undefined);
    try {
      onDone(await mAccountRelink(account.id, {
        pass,
        user: user.trim() || undefined,
        imapHost: imapHost.trim() || undefined,
        imapPort: Number(imapPort) || undefined,
        // 993/465 = TLS ngay từ đầu; 143/587 = STARTTLS. Suy từ cổng thay vì
        // bắt người dùng hiểu ô tick — cùng quy ước với form thêm tài khoản.
        imapSecure: Number(imapPort) !== 143,
        smtpHost: smtpHost.trim() || undefined,
        smtpPort: Number(smtpPort) || undefined,
        smtpSecure: Number(smtpPort) !== 587,
      }));
    } catch (e) {
      const me = e as MailActionError;
      setFailure(me.failure);
      setErr(me.message);
      setBusy(false);
    }
  };

  return (
    <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="mail-compose panel" style={{ width: 'min(560px, 94vw)' }}>
        <div className="mail-compose-head">
          <b>🔗 Liên kết lại hòm thư</b>
          <span className="small" style={{ color: 'var(--muted)' }}>{account.email}</span>
          <span style={{ flex: 1 }} />
          <button className="ghost sm" onClick={onCancel} disabled={busy}>✕</button>
        </div>

        <p className="small" style={{ color: 'var(--muted)', margin: '2px 0 8px' }}>
          Nhập lại mật khẩu để hòm thư chạy tiếp. Chữ ký, tên hiển thị và mọi cấu hình
          khác giữ nguyên — <b>không phải gỡ rồi thêm lại</b>.
        </p>

        <label className="small" style={{ color: 'var(--muted)' }}>
          Mật khẩu (hoặc App Password)
          <PasswordInput value={pass} onChange={setPass} autoFocus
            placeholder="mật khẩu mới"
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
        </label>

        <button className="ghost sm" style={{ alignSelf: 'flex-start', marginTop: 8 }}
          onClick={() => setShowServer((v) => !v)}>
          {showServer ? '▾' : '▸'} Máy chủ &amp; tên đăng nhập
        </button>

        {showServer && (
          <div className="mail-add-grid" style={{ marginTop: 6 }}>
            <label className="small" style={{ color: 'var(--muted)' }}>
              Tên đăng nhập
              <input className="input" value={user} placeholder={account.email}
                onChange={(e) => setUser(e.target.value)} />
            </label>
            <div className="mail-add-pair">
              <input className="input" value={imapHost} placeholder="IMAP host"
                onChange={(e) => setImapHost(e.target.value)} />
              <input className="input mail-port" value={imapPort} placeholder="993"
                onChange={(e) => setImapPort(e.target.value)} />
            </div>
            <div className="mail-add-pair">
              <input className="input" value={smtpHost} placeholder="SMTP host"
                onChange={(e) => setSmtpHost(e.target.value)} />
              <input className="input mail-port" value={smtpPort} placeholder="465"
                onChange={(e) => setSmtpPort(e.target.value)} />
            </div>
            <p className="small" style={{ color: 'var(--faint)', margin: 0 }}>
              Chỉ sửa khi mail server đổi địa chỉ. IMAP 993 / SMTP 465 = TLS; 143 / 587 = STARTTLS.
            </p>
          </div>
        )}

        {err && (
          <div style={{ marginTop: 8 }}>
            <MailErrorPanel failure={failure} message={err}
              onRetry={() => void submit()} retrying={busy} />
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button onClick={() => void submit()} disabled={busy || !pass}>
            {busy ? <span className="spinner" aria-hidden /> : '🔗'} {busy ? 'Đang thử đăng nhập…' : 'Liên kết lại'}
          </button>
          <button className="ghost" onClick={onCancel} disabled={busy}>Hủy</button>
        </div>
      </div>
    </div>
  );
}
