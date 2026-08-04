'use client';

// Mail workspace — xem + gửi/phản hồi email qua IMAP/SMTP chuẩn, KHÔNG riêng
// nhà cung cấp nào: Zimbra công ty (mail.example.com), Gmail (app
// password), hay bất kỳ server IMAP nào. MULTI-ACCOUNT như tab Google —
// chip chuyển tài khoản trên toolbar, mỗi tài khoản remount view sạch.
//
// Scope CHỦ ĐÍCH chỉ 2 việc: XEM (folder → danh sách → nội dung, đánh dấu đã
// đọc, tải đính kèm) và GỬI/TRẢ LỜI (composer text, reply đúng thread qua
// In-Reply-To/References). Không quản lý folder/flag/search server-side — mở
// webmail cho việc đó.
//
// Credentials nằm server-side (.mailaccounts.json); UI chỉ thấy account public.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  mAccounts, mAccountAdd, mAccountRemove, mFolders, mList, mMessage, mSend, mDelete, mContacts, mContactAdd,
  attachmentUrl, folderIcon, fmtAddr, fmtSize,
  type MailAccountPub, type MailFolder, type MailListItem, type MailDetail, type AccountAddInput,
  type MailContact,
} from '@/lib/mail';
import { fmtRel } from '@/lib/google';

const ACTIVE_ACCOUNT_KEY = 'mail.activeAccount';

// ── Presets thêm tài khoản ──────────────────────────────────────────────────

interface Preset {
  key: string;
  label: string;
  hint: string;
  imapHost: string; imapPort: number; imapSecure: boolean;
  smtpHost: string; smtpPort: number; smtpSecure: boolean;
}

const PRESETS: Preset[] = [
  {
    key: 'vihat', label: 'ViHat (Zimbra)', hint: 'mail.example.com — đăng nhập như webmail',
    imapHost: 'mail.example.com', imapPort: 993, imapSecure: true,
    smtpHost: 'mail.example.com', smtpPort: 465, smtpSecure: true,
  },
  {
    key: 'gmail', label: 'Gmail', hint: 'cần App Password (myaccount.google.com/apppasswords)',
    imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true,
  },
  {
    key: 'custom', label: 'Khác…', hint: 'tự điền host IMAP/SMTP',
    imapHost: '', imapPort: 993, imapSecure: true,
    smtpHost: '', smtpPort: 465, smtpSecure: true,
  },
];

function AddAccountForm({ onDone, onCancel }: { onDone: (list: MailAccountPub[]) => void; onCancel?: () => void }) {
  const [preset, setPreset] = useState<Preset>(PRESETS[0]);
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [label, setLabel] = useState('');
  const [imapHost, setImapHost] = useState(PRESETS[0].imapHost);
  const [imapPort, setImapPort] = useState(PRESETS[0].imapPort);
  const [smtpHost, setSmtpHost] = useState(PRESETS[0].smtpHost);
  const [smtpPort, setSmtpPort] = useState(PRESETS[0].smtpPort);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pickPreset = (p: Preset) => {
    setPreset(p);
    setImapHost(p.imapHost); setImapPort(p.imapPort);
    setSmtpHost(p.smtpHost); setSmtpPort(p.smtpPort);
  };

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const input: AccountAddInput = {
        label, email: email.trim(), pass,
        imapHost: imapHost.trim(), imapPort, imapSecure: imapPort !== 143,
        smtpHost: smtpHost.trim(), smtpPort, smtpSecure: smtpPort === 465,
      };
      onDone(await mAccountAdd(input));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = email.trim() && pass && imapHost.trim() && smtpHost.trim();

  return (
    <div className="mail-add">
      <div className="mail-add-presets">
        {PRESETS.map((p) => (
          <button key={p.key} className={`chip-btn${preset.key === p.key ? ' on' : ''}`}
            onClick={() => pickPreset(p)} title={p.hint}>
            {p.label}
          </button>
        ))}
      </div>
      <p className="small" style={{ color: 'var(--muted)', margin: '2px 0 8px' }}>{preset.hint}</p>
      <div className="mail-add-grid">
        <input className="input" placeholder="Email (vd ban@congty.com)" value={email}
          onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        <input className="input" type="password" placeholder="Password (Gmail: App Password)" value={pass}
          onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
        <input className="input" placeholder="Tên hiển thị khi gửi (mặc định: email)" value={label}
          onChange={(e) => setLabel(e.target.value)} />
        {preset.key === 'custom' && (
          <>
            <div className="mail-add-pair">
              <input className="input" placeholder="IMAP host" value={imapHost} onChange={(e) => setImapHost(e.target.value)} />
              <input className="input mail-port" type="number" value={imapPort}
                onChange={(e) => setImapPort(Number(e.target.value) || 993)} title="993 = TLS, 143 = plain/STARTTLS" />
            </div>
            <div className="mail-add-pair">
              <input className="input" placeholder="SMTP host" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
              <input className="input mail-port" type="number" value={smtpPort}
                onChange={(e) => setSmtpPort(Number(e.target.value) || 465)} title="465 = TLS, 587 = STARTTLS" />
            </div>
          </>
        )}
      </div>
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={() => void submit()} disabled={busy || !canSubmit}>
          {busy ? <span className="spinner" aria-hidden /> : '＋'} {busy ? 'Đang kiểm tra đăng nhập…' : 'Thêm tài khoản'}
        </button>
        {onCancel && <button className="ghost" onClick={onCancel}>Hủy</button>}
      </div>
    </div>
  );
}

// ── Composer (gửi mới / trả lời) ────────────────────────────────────────────

export interface ComposeDraft {
  to: string;
  cc: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string[];
}

interface PendingAttachment { filename: string; contentBase64: string; contentType: string; size: number }

/** Đọc file → base64 (bỏ tiền tố data:*;base64,). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

const ATTACH_LIMIT = 20 * 1024 * 1024; // tổng ~20MB — cảnh báo khi vượt

/** Ô nhập địa chỉ có gợi ý từ address book. Nhiều địa chỉ cách nhau dấu phẩy;
 *  gợi ý lọc theo token ĐANG gõ (sau dấu phẩy cuối), chọn thì thay token đó. */
function AddrInput({ value, onChange, placeholder, contacts, autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder: string;
  contacts: MailContact[]; autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);

  // Token đang gõ = phần sau dấu phẩy cuối cùng.
  const cut = value.lastIndexOf(',');
  const head = cut >= 0 ? value.slice(0, cut + 1) : '';
  const token = (cut >= 0 ? value.slice(cut + 1) : value).trim().toLowerCase();

  const matches = token
    ? contacts.filter((c) => c.email.includes(token) || (c.name ?? '').toLowerCase().includes(token)).slice(0, 8)
    : [];

  const pick = (c: MailContact) => {
    onChange(`${head}${head ? ' ' : ''}${c.email}, `);
    setOpen(false); setHi(0);
  };

  return (
    <div className="mc-addr-wrap">
      <input className="mc-input" placeholder={placeholder} value={value} autoFocus={autoFocus}
        autoComplete="off"
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!open || !matches.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, matches.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter' || e.key === 'Tab') {
            if (matches[hi]) { e.preventDefault(); pick(matches[hi]); }
          } else if (e.key === 'Escape') { setOpen(false); }
        }} />
      {open && matches.length > 0 && (
        <div className="mc-addr-menu">
          {matches.map((c, i) => (
            <button key={c.email} type="button" className={`mc-addr-item${i === hi ? ' on' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(c); }}>
              <span className="mc-addr-email">{c.email}</span>
              {c.name && <span className="mc-addr-name">{c.name}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Composer({ account, draft, onClose, onSent }: {
  account: MailAccountPub;
  draft: ComposeDraft;
  onClose: () => void;
  onSent: () => void;
}) {
  const [to, setTo] = useState(draft.to);
  const [cc, setCc] = useState(draft.cc);
  const [showCc, setShowCc] = useState(!!draft.cc);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [atts, setAtts] = useState<PendingAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [contacts, setContacts] = useState<MailContact[]>([]);
  useEffect(() => { mContacts().then(setContacts).catch(() => {}); }, []);

  const isReply = !!draft.inReplyTo;

  // Reply: caret đặt ở ĐẦU body (trên phần quote) — gõ được ngay.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) { el.focus(); el.setSelectionRange(0, 0); }
  }, []);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setErr(null);
    try {
      const next: PendingAttachment[] = [];
      for (const f of Array.from(files)) {
        next.push({ filename: f.name, contentBase64: await fileToBase64(f), contentType: f.type || 'application/octet-stream', size: f.size });
      }
      const merged = [...atts, ...next];
      const total = merged.reduce((s, a) => s + a.size, 0);
      if (total > ATTACH_LIMIT) setErr(`Tổng đính kèm ${fmtSize(total)} vượt ~20MB — nhiều mail server sẽ từ chối.`);
      setAtts(merged);
    } catch (e) {
      setErr('Không đọc được file: ' + (e as Error).message);
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const send = async () => {
    setBusy(true); setErr(null);
    try {
      await mSend({
        accountId: account.id, to: to.trim(), cc: cc.trim() || undefined, subject, text: body,
        inReplyTo: draft.inReplyTo, references: draft.references,
        attachments: atts.map(({ filename, contentBase64, contentType }) => ({ filename, contentBase64, contentType })),
      });
      onSent();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const attTotal = atts.reduce((s, a) => s + a.size, 0);

  return (
    <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="mail-compose"
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); void addFiles(e.dataTransfer.files); }}>
        {/* Header gradient — phân biệt reply / soạn mới */}
        <div className="mc-head">
          <span className="mc-head-ico" aria-hidden>{isReply ? '↩' : '✉'}</span>
          <span className="mc-head-title">{isReply ? 'Trả lời' : 'Thư mới'}</span>
          <span className="mc-head-from">từ {account.email}</span>
          <button className="mc-x" onClick={onClose} disabled={busy} title="Đóng">✕</button>
        </div>

        {/* Field rows kiểu Gmail: label bên trái, input liền mạch */}
        <div className="mc-fields">
          <div className="mc-row">
            <span className="mc-label">Tới</span>
            <AddrInput value={to} onChange={setTo} contacts={contacts} autoFocus={!isReply}
              placeholder="nhiều địa chỉ cách nhau dấu phẩy — gõ để gợi ý" />
            {!showCc && <button className="mc-cc-toggle" onClick={() => setShowCc(true)}>Cc</button>}
          </div>
          {showCc && (
            <div className="mc-row">
              <span className="mc-label">Cc</span>
              <AddrInput value={cc} onChange={setCc} contacts={contacts} placeholder="Cc" />
            </div>
          )}
          <label className="mc-row">
            <span className="mc-label">Tiêu đề</span>
            <input className="mc-input" placeholder="(không tiêu đề)" value={subject}
              onChange={(e) => setSubject(e.target.value)} />
          </label>
        </div>

        <textarea ref={bodyRef} className="mc-body" value={body}
          onChange={(e) => setBody(e.target.value)} placeholder="Viết nội dung… (kéo-thả file vào đây để đính kèm)" />

        {atts.length > 0 && (
          <div className="mc-atts">
            {atts.map((a, i) => (
              <span key={i} className="mc-att" title={`${a.contentType} · ${fmtSize(a.size)}`}>
                📎 <span className="mc-att-name">{a.filename}</span>
                <span className="mc-att-size">{fmtSize(a.size)}</span>
                <button className="mc-att-x" onClick={() => setAtts(atts.filter((_, j) => j !== i))} title="Bỏ">✕</button>
              </span>
            ))}
            <span className="mc-att-total">Tổng {fmtSize(attTotal)}</span>
          </div>
        )}

        {err && <div className="mc-err">{err}</div>}

        <div className="mc-foot">
          <button className="mc-send" onClick={() => void send()} disabled={busy || !to.trim()}>
            {busy ? <span className="spinner" aria-hidden /> : '➤'} {busy ? 'Đang gửi…' : 'Gửi'}
          </button>
          <button className="mc-tool" onClick={() => fileRef.current?.click()} disabled={busy} title="Đính kèm tệp">
            📎 Đính kèm
          </button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
          <span style={{ flex: 1 }} />
          <button className="mc-tool" onClick={onClose} disabled={busy}>Hủy</button>
        </div>
      </div>
    </div>
  );
}

// ── Message detail ──────────────────────────────────────────────────────────

/** srcDoc cho iframe đọc mail: sandbox chặn script; CSP mặc định chặn ảnh/
 *  nội dung remote (tránh tracking pixel) — bấm "Hiện ảnh" để nới. */
function buildSrcDoc(html: string, allowRemote: boolean): string {
  const csp = allowRemote
    ? "default-src 'none'; img-src * data: cid:; style-src 'unsafe-inline' *; font-src *;"
    : "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline';";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>body{font:14px/1.5 system-ui,Segoe UI,sans-serif;margin:12px;word-break:break-word}</style>
</head><body>${html}</body></html>`;
}

function DetailView({ accountId, path, detail, onBack, onReply, onDelete, deleting }: {
  accountId: string;
  path: string;
  detail: MailDetail;
  onBack: () => void;
  onReply: (all: boolean) => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const [allowRemote, setAllowRemote] = useState(false);
  const [saved, setSaved] = useState(false);
  const [linkMsg, setLinkMsg] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const hasRemote = !!detail.html && /src\s*=\s*["']?https?:/i.test(detail.html);

  /** Link trong body mail: probe qua server — URL là FILE thì tải NGAY TRONG
   *  APP (stream qua /api/mail?fetch), là trang web thì mở trình duyệt như cũ.
   *  Probe lỗi (mạng/site chặn server) → fallback mở trình duyệt, không kẹt. */
  const handleBodyLink = useCallback(async (url: string) => {
    setLinkBusy(true); setLinkMsg('Đang kiểm tra link…');
    try {
      const r = await fetch(`/api/mail?fetch&mode=probe&url=${encodeURIComponent(url)}`);
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const info = data.result as { file: boolean; filename: string };
      if (info.file) {
        const a = document.createElement('a');
        a.href = `/api/mail?fetch&mode=download&url=${encodeURIComponent(url)}`;
        a.download = info.filename || '';
        document.body.appendChild(a); a.click(); a.remove();
        setLinkMsg(`⬇ Đang tải ${info.filename}`);
        setTimeout(() => setLinkMsg(null), 5000);
      } else {
        setLinkMsg(null);
        window.open(url, '_blank', 'noopener');
      }
    } catch {
      setLinkMsg(null);
      window.open(url, '_blank', 'noopener'); // không chặn người dùng khi probe lỗi
    } finally {
      setLinkBusy(false);
    }
  }, []);

  /** Gắn listener bắt click <a> trong iframe mỗi lần nó load lại (đổi
   *  allowRemote → srcDoc mới). Truy cập được contentDocument nhờ sandbox có
   *  allow-same-origin — vẫn AN TOÀN vì KHÔNG có allow-scripts và CSP chặn
   *  script: HTML của mail không thể chạy code, chỉ mình ta sờ được DOM. */
  const wireFrameLinks = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    doc.addEventListener('click', (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      if (!/^https?:/i.test(href)) return; // mailto:, cid:, … → hành vi mặc định
      e.preventDefault();
      e.stopPropagation();
      void handleBodyLink(href);
    }, true);
  }, [handleBodyLink]);

  const saveSender = async () => {
    if (!detail.from?.address) return;
    const label = detail.from.name ? `${detail.from.name} <${detail.from.address}>` : detail.from.address;
    try { await mContactAdd(label); setSaved(true); setTimeout(() => setSaved(false), 2500); } catch { /* ignore */ }
  };

  return (
    <div className="mail-detail">
      <div className="mail-detail-bar">
        <button className="ghost sm" onClick={onBack} title="Quay lại danh sách">←</button>
        <button className="ghost sm" onClick={() => onReply(false)} title="Trả lời người gửi">↩ Trả lời</button>
        <button className="ghost sm" onClick={() => onReply(true)} title="Trả lời tất cả (To + Cc)">↩ Tất cả</button>
        {detail.from?.address && (
          <button className="ghost sm" onClick={() => void saveSender()}
            title="Lưu địa chỉ người gửi vào gợi ý (dùng khi khác domain — không tự lưu)">
            {saved ? '✓ Đã lưu' : '👤 Lưu địa chỉ'}
          </button>
        )}
        {hasRemote && !allowRemote && (
          <button className="ghost sm" onClick={() => setAllowRemote(true)}
            title="Ảnh/nội dung remote đang bị chặn (tránh tracking) — bấm để tải">
            🖼 Hiện ảnh
          </button>
        )}
        {(linkBusy || linkMsg) && (
          <span className="small" style={{ color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {linkBusy && <span className="spinner" aria-hidden />}
            {linkMsg}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="ghost sm mail-del-btn" onClick={onDelete} disabled={deleting}
          title="Xóa mail này (chuyển vào Thùng rác; đang ở Thùng rác thì xóa vĩnh viễn)">
          {deleting ? <span className="spinner" aria-hidden /> : '🗑'} Xóa
        </button>
      </div>
      <div className="mail-detail-head">
        <h3 className="mail-detail-subject">{detail.subject}</h3>
        <div className="mail-detail-meta">
          <div><b>{fmtAddr(detail.from)}</b>{detail.date ? ` · ${fmtRel(detail.date)}` : ''}</div>
          <div className="small" style={{ color: 'var(--muted)' }}>
            Tới: {detail.to.map(fmtAddr).join(', ') || '—'}
            {detail.cc.length > 0 && <> · Cc: {detail.cc.map(fmtAddr).join(', ')}</>}
          </div>
        </div>
        {detail.attachments.length > 0 && (
          <div className="mail-atts">
            {detail.attachments.map((a) => (
              <a key={a.idx} className="chip-btn" href={attachmentUrl(accountId, path, detail.uid, a.idx)}
                title={`${a.contentType} · ${fmtSize(a.size)}`}>
                📎 {a.filename} <span style={{ color: 'var(--muted)' }}>({fmtSize(a.size)})</span>
              </a>
            ))}
          </div>
        )}
      </div>
      <div className="mail-detail-body">
        {detail.html ? (
          <iframe
            ref={frameRef}
            className="mail-frame"
            /* allow-same-origin: để host bắt click link (tải file trong app).
               An toàn vì KHÔNG allow-scripts + CSP default-src 'none' — mail
               không thể chạy script hay đọc gì từ app. */
            sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
            srcDoc={buildSrcDoc(detail.html, allowRemote)}
            onLoad={wireFrameLinks}
            title={detail.subject}
          />
        ) : (
          <pre className="mail-plain">{detail.text ?? '(mail trống)'}</pre>
        )}
      </div>
    </div>
  );
}

// ── One account's mailbox (rail + list + detail) ────────────────────────────

/** Dựng draft trả lời từ mail gốc: quote text, header thread, to/cc. */
function replyDraft(detail: MailDetail, all: boolean, selfEmail: string): ComposeDraft {
  const subject = /^re:/i.test(detail.subject) ? detail.subject : `Re: ${detail.subject}`;
  const quoteSrc = detail.text ?? '(nội dung HTML — xem mail gốc)';
  const quoted = quoteSrc.split('\n').map((l) => `> ${l}`).join('\n');
  const when = detail.date ? new Date(detail.date).toLocaleString('vi-VN') : '';
  const body = `\n\nVào ${when}, ${fmtAddr(detail.from)} viết:\n${quoted}`;

  const notSelf = (a: { address: string }) => a.address.toLowerCase() !== selfEmail.toLowerCase();
  const to = detail.from ? [detail.from.address] : [];
  const cc: string[] = [];
  if (all) {
    to.push(...detail.to.filter(notSelf).map((a) => a.address).filter((x) => !to.includes(x)));
    cc.push(...detail.cc.filter(notSelf).map((a) => a.address));
  }
  const references = [...detail.references];
  if (detail.messageId && !references.includes(detail.messageId)) references.push(detail.messageId);

  return {
    to: to.join(', '), cc: cc.join(', '), subject, body,
    inReplyTo: detail.messageId ?? undefined,
    references,
  };
}

function MailboxView({ account, onCompose }: {
  account: MailAccountPub;
  onCompose: (draft: ComposeDraft) => void;
}) {
  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [path, setPath] = useState('INBOX');
  const [items, setItems] = useState<MailListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [oldestSeq, setOldestSeq] = useState<number | null>(null);
  const [detail, setDetail] = useState<MailDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadFolders = useCallback(() => {
    mFolders(account.id).then(setFolders).catch((e) => setErr((e as Error).message));
  }, [account.id]);
  useEffect(() => { loadFolders(); }, [loadFolders]);

  const loadList = useCallback(async (p: string, beforeSeq?: number) => {
    setLoading(true); setErr(null);
    try {
      const page = await mList(account.id, p, beforeSeq);
      setItems((cur) => (beforeSeq ? [...cur, ...page.items] : page.items));
      setTotal(page.total);
      setOldestSeq(page.oldestSeq);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [account.id]);

  useEffect(() => { void loadList('INBOX'); }, [loadList]);

  const openFolder = (p: string) => {
    setPath(p); setDetail(null); setItems([]); setOldestSeq(null);
    void loadList(p);
  };

  const openMessage = async (m: MailListItem) => {
    setOpening(m.uid); setErr(null);
    try {
      setDetail(await mMessage(account.id, path, m.uid));
      // Đã đọc server-side (\Seen) — cập nhật luôn UI khỏi chờ reload:
      // hàng trong danh sách hết đậm + badge 🔔 của folder giảm 1.
      if (!m.seen) {
        setItems((cur) => cur.map((x) => (x.uid === m.uid ? { ...x, seen: true } : x)));
        setFolders((cur) => cur.map((f) => (f.path === path ? { ...f, unseen: Math.max(0, f.unseen - 1) } : f)));
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setOpening(null);
    }
  };

  const curFolder = folders.find((f) => f.path === path);
  // Đang đứng trong Thùng rác → xóa là VĨNH VIỄN (server sẽ expunge).
  const inTrash = curFolder?.specialUse === '\\Trash' || /^trash$/i.test(curFolder?.name ?? '');

  /** Xóa 1 mail theo UID — không mở/không đọc nội dung (an toàn với mail lừa
   *  đảo). Optimistic: rút khỏi danh sách ngay, trừ badge chưa đọc nếu cần. */
  const removeMail = async (m: Pick<MailListItem, 'uid' | 'seen' | 'subject'>) => {
    const label = m.subject ? `"${m.subject}"` : `mail #${m.uid}`;
    const q = inTrash
      ? `Xóa VĨNH VIỄN ${label}? (đang ở Thùng rác — không khôi phục được)`
      : `Xóa ${label}? Mail sẽ được chuyển vào Thùng rác.`;
    if (!window.confirm(q)) return;
    setDeleting(m.uid); setErr(null);
    try {
      await mDelete(account.id, path, m.uid);
      setItems((cur) => cur.filter((x) => x.uid !== m.uid));
      setTotal((t) => Math.max(0, t - 1));
      if (!m.seen) {
        setFolders((cur) => cur.map((f) => (f.path === path ? { ...f, unseen: Math.max(0, f.unseen - 1) } : f)));
      }
      setDetail((d) => (d?.uid === m.uid ? null : d));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="g-projects">
      <aside className="g-rail">
        <div className="group-title" style={{ margin: '0 4px 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1 }}>Thư mục</span>
          <button className="ghost sm" onClick={loadFolders} title="Tải lại danh sách thư mục">↻</button>
        </div>
        {folders.map((f) => (
          <div key={f.path} className={`g-root${f.path === path ? ' on' : ''}`}>
            <button className="g-root-btn" onClick={() => openFolder(f.path)} title={f.path}>
              <span aria-hidden>{folderIcon(f)}</span>
              <span className={`g-root-name${f.unseen > 0 ? ' mail-folder-unread' : ''}`}>{f.name}</span>
              {f.unseen > 0 && (
                <span className="mail-unseen" title={`${f.unseen} mail chưa đọc`}>
                  🔔 {f.unseen > 99 ? '99+' : f.unseen}
                </span>
              )}
            </button>
          </div>
        ))}
        {folders.length === 0 && !err && <p className="small" style={{ color: 'var(--muted)', margin: '4px 6px' }}>Đang tải thư mục…</p>}
      </aside>

      <div className="g-main">
        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
        {detail ? (
          <DetailView
            accountId={account.id}
            path={path}
            detail={detail}
            onBack={() => setDetail(null)}
            onReply={(all) => onCompose(replyDraft(detail, all, account.email))}
            onDelete={() => void removeMail({ uid: detail.uid, seen: true, subject: detail.subject })}
            deleting={deleting === detail.uid}
          />
        ) : (
          <>
            <div className="g-crumbs">
              <b>{curFolder ? `${folderIcon(curFolder)} ${curFolder.name}` : path}</b>
              <span className="small" style={{ color: 'var(--muted)' }}>{total ? `· ${total} mail` : ''}</span>
              {loading && <span className="spinner" aria-hidden />}
              <span style={{ flex: 1 }} />
              <button className="ghost sm" disabled={loading}
                onClick={() => { void loadList(path); loadFolders(); }}
                title="Tải lại danh sách mail + số chưa đọc">↻</button>
            </div>
            <div className="g-list">
              {items.map((m) => (
                /* div role=button (không phải <button>) vì bên trong còn nút 🗑
                   — button lồng button là HTML sai và click sẽ loạn. */
                <div key={m.uid} role="button" tabIndex={0}
                  className={`g-row mail-row${m.seen ? '' : ' unread'}`}
                  onClick={() => void openMessage(m)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openMessage(m); } }}
                  title={m.subject}>
                  <span className={`mail-dot${m.seen ? ' off' : ''}`} aria-hidden
                    title={m.seen ? undefined : 'Chưa đọc'} />
                  <span className="mail-from">{m.from?.name || m.from?.address || '(không rõ)'}</span>
                  <span className="g-name">
                    <span className="g-base">
                      {m.answered && <span title="Đã trả lời" aria-hidden>↩ </span>}
                      {m.subject}
                      {m.hasAttachments && <span aria-hidden> 📎</span>}
                    </span>
                  </span>
                  <span className="mail-date">{opening === m.uid ? <span className="spinner" aria-hidden /> : fmtRel(m.date ?? undefined)}</span>
                  {/* Xóa KHÔNG cần mở — cho mail nghi lừa đảo/độc hại. */}
                  <button className="mail-row-del" disabled={deleting === m.uid}
                    onClick={(e) => { e.stopPropagation(); void removeMail(m); }}
                    title={inTrash ? 'Xóa vĩnh viễn (không cần mở mail)' : 'Xóa — chuyển vào Thùng rác (không cần mở mail)'}>
                    {deleting === m.uid ? <span className="spinner" aria-hidden /> : '🗑'}
                  </button>
                </div>
              ))}
              {!loading && items.length === 0 && !err && (
                <div className="empty" style={{ padding: '24px 8px' }}><p className="small">Thư mục trống.</p></div>
              )}
            </div>
            {oldestSeq !== null && oldestSeq > 1 && (
              <div style={{ padding: '8px 0' }}>
                <button className="ghost sm" disabled={loading} onClick={() => void loadList(path, oldestSeq)}>
                  ↓ Tải thêm mail cũ hơn
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Top-level workspace ─────────────────────────────────────────────────────

export default function MailWorkspace() {
  const [accounts, setAccounts] = useState<MailAccountPub[] | null>(null);
  const [activeId, setActiveId] = useState('');
  const [adding, setAdding] = useState(false);
  const [compose, setCompose] = useState<ComposeDraft | null>(null);
  const [sentFlash, setSentFlash] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    mAccounts()
      .then((list) => {
        setAccounts(list);
        const remembered = window.localStorage.getItem(ACTIVE_ACCOUNT_KEY) ?? '';
        setActiveId(list.some((a) => a.id === remembered) ? remembered : list[0]?.id ?? '');
      })
      .catch((e) => { setAccounts([]); setErr((e as Error).message); });
  }, []);

  useEffect(() => {
    if (activeId) window.localStorage.setItem(ACTIVE_ACCOUNT_KEY, activeId);
  }, [activeId]);

  const onAccountsChanged = (list: MailAccountPub[]) => {
    setAccounts(list);
    setAdding(false);
    if (!list.some((a) => a.id === activeId)) setActiveId(list[0]?.id ?? '');
  };

  const removeAccount = async (a: MailAccountPub) => {
    if (!window.confirm(`Gỡ tài khoản ${a.email} khỏi DevBox? (chỉ xóa credentials trên máy này)`)) return;
    try {
      onAccountsChanged(await mAccountRemove(a.id));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (accounts === null) {
    return <div className="panel" style={{ margin: 'auto' }}><span className="spinner" /> Đang tải…</div>;
  }

  // ── First-run: chưa có tài khoản nào ──────────────────────────────────────
  if (accounts.length === 0) {
    return (
      <div className="panel office-hero-panel" style={{ margin: 'auto', width: 'min(680px, 94%)' }}>
        <div className="office-hero">
          <div className="office-hero-ico" aria-hidden>✉️</div>
          <div className="office-hero-title">Kết nối hòm thư</div>
          <p className="office-hero-sub">
            Xem + gửi/trả lời email ngay trong DevBox qua IMAP/SMTP chuẩn — Zimbra công ty
            (mail.example.com), Gmail, hay bất kỳ mail server nào. Credentials lưu trên máy này,
            không rời server process.
          </p>
          <div className="office-hero-points">
            <span className="office-point">👥 Nhiều tài khoản</span>
            <span className="office-point">📥 Xem theo thư mục</span>
            <span className="office-point">↩ Trả lời đúng thread</span>
            <span className="office-point">🔒 Password không xuống browser</span>
          </div>
        </div>
        <AddAccountForm onDone={onAccountsChanged} />
        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
      </div>
    );
  }

  const active = accounts.find((a) => a.id === activeId) ?? accounts[0];

  return (
    <div className="panel sheet-panel">
      <div className="sheet-toolbar">
        <button onClick={() => setCompose({ to: '', cc: '', subject: '', body: '' })} title="Soạn thư mới">
          ✉️ Soạn thư
        </button>
        {sentFlash && <span className="small" style={{ color: 'var(--ok, #3c9)' }}>✓ Đã gửi</span>}
        <span style={{ flex: 1 }} />
        <div className="g-accounts" role="tablist" aria-label="Mail accounts">
          {accounts.map((a) => (
            <span key={a.id} className={`g-acc${a.id === active.id ? ' on' : ''}`} title={a.email}>
              <button className="g-acc-btn" role="tab" aria-selected={a.id === active.id} onClick={() => setActiveId(a.id)}>
                ✉ {a.email.split('@')[0]}
              </button>
              {a.id === active.id && (
                <button className="g-acc-x" onClick={() => void removeAccount(a)} title={`Gỡ ${a.email}`}>✕</button>
              )}
            </span>
          ))}
          <button className="ghost sm" onClick={() => setAdding(true)} title="Thêm tài khoản mail khác">＋ Tài khoản</button>
        </div>
      </div>
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '6px 0' }}>{err}</pre>}

      {/* key=account id → đổi tài khoản là remount sạch folder/list/detail */}
      <div className="office-body">
        <MailboxView key={active.id} account={active} onCompose={setCompose} />
      </div>

      {adding && (
        <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && setAdding(false)}>
          <div className="mail-compose panel">
            <div className="mail-compose-head">
              <b>＋ Thêm tài khoản mail</b>
              <span style={{ flex: 1 }} />
              <button className="ghost sm" onClick={() => setAdding(false)} title="Đóng">✕</button>
            </div>
            <AddAccountForm onDone={onAccountsChanged} onCancel={() => setAdding(false)} />
          </div>
        </div>
      )}

      {compose && (
        <Composer
          account={active}
          draft={compose}
          onClose={() => setCompose(null)}
          onSent={() => {
            setCompose(null);
            setSentFlash(true);
            setTimeout(() => setSentFlash(false), 3000);
          }}
        />
      )}
    </div>
  );
}
