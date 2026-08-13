'use client';

// Mail workspace — xem + gửi/phản hồi email qua IMAP/SMTP chuẩn, KHÔNG riêng
// nhà cung cấp nào: Zimbra/mail nội bộ, Gmail (app password), Outlook, hay bất
// kỳ server IMAP nào. MULTI-ACCOUNT như tab Google —
// chip chuyển tài khoản trên toolbar, mỗi tài khoản remount view sạch.
//
// Scope CHỦ ĐÍCH chỉ 2 việc: XEM (folder → danh sách → nội dung, đánh dấu đã
// đọc, tải đính kèm) và GỬI/TRẢ LỜI (composer text, reply đúng thread qua
// In-Reply-To/References). Không quản lý folder/flag/search server-side — mở
// webmail cho việc đó.
//
// Credentials nằm server-side (.mailaccounts.json); UI chỉ thấy account public.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  mAccounts, mAccountAdd, mAccountAddOAuth, mGoogleAuthUrl, mAccountRemove, mAccountRename,
  mFolders, mList, mMessage, mNestedMessage, mSend, mDelete, mMarkAllSeen, mContacts, mContactAdd,
  mSignatureSet, mSignatureFetch,
  attachmentUrl, folderIcon, fmtAddr, fmtSize, accTitle, groupThreads,
  type MailAccountPub, type MailFolder, type MailListItem, type MailDetail, type AccountAddInput,
  type MailContact, type ImapFailureInfo, type MailActionError, type ForwardAttachmentRef,
  type MailThread, type ZimbraSignature,
} from '@/lib/mail';
import MailBody, { textToHtml } from './mail/MailBody';
import RichTextEditor, { htmlToText } from './mail/RichTextEditor';
import MailErrorPanel from './MailErrorPanel';
import MailCalendar from './MailCalendar';
import GoogleAuthWindow from './GoogleAuthWindow';
import { fmtRel } from '@/lib/google';
import PasswordInput from './PasswordInput';
import { MAIL_REFRESH_EVENT } from './MailWatchHost';
import { MAIL_MUTED_EVENT, loadMutedMail, toggleMutedMail } from '@/lib/mailMuted';
import { useSplit } from '@/lib/useSplit';
import Splitter from './Splitter';

/** Báo cho MailWatchHost đếm lại số mail chưa đọc NGAY (badge tab Mail). */
function pingMailWatch() {
  try { window.dispatchEvent(new Event(MAIL_REFRESH_EVENT)); } catch { /* SSR/không có window */ }
}

const ACTIVE_ACCOUNT_KEY = 'mail.activeAccount';
/** Đang xem Thư hay Lịch — nhớ lại giữa các lần mở app. */
const VIEW_KEY = 'mail.view';

// ── Presets thêm tài khoản ──────────────────────────────────────────────────

interface Preset {
  key: string;
  label: string;
  hint: string;
  imapHost: string; imapPort: number; imapSecure: boolean;
  smtpHost: string; smtpPort: number; smtpSecure: boolean;
}

// Chỉ preset của nhà cung cấp PHỔ BIẾN, không gắn với tổ chức nào. Mail server
// nội bộ (Zimbra, Exchange…) dùng "Khác…" rồi tự điền host — cấu hình đó là dữ
// liệu của người dùng, lưu trong configs/, không hardcode vào source.
const PRESETS: Preset[] = [
  {
    key: 'gmail', label: 'Gmail', hint: 'cần App Password (myaccount.google.com/apppasswords)',
    imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true,
  },
  {
    key: 'outlook', label: 'Outlook / Microsoft 365', hint: 'outlook.office365.com',
    imapHost: 'outlook.office365.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false,
  },
  {
    key: 'zimbra', label: 'Zimbra / mail nội bộ', hint: 'dùng lại host của hòm thư nội bộ đã có',
    imapHost: '', imapPort: 993, imapSecure: true,
    smtpHost: '', smtpPort: 465, smtpSecure: true,
  },
  {
    key: 'custom', label: 'Khác…', hint: 'tự điền host IMAP/SMTP',
    imapHost: '', imapPort: 993, imapSecure: true,
    smtpHost: '', smtpPort: 465, smtpSecure: true,
  },
];

/**
 * Host IMAP/SMTP cho preset Zimbra, SUY RA TỪ hòm thư nội bộ đã cấu hình.
 *
 * VÌ SAO không hardcode: host mail nội bộ là dữ liệu của tổ chức, thuộc
 * configs/ chứ không thuộc source (xem chú thích của PRESETS). VÌ SAO không suy
 * từ domain email: hai hòm thư có thể khác domain mà CHUNG một server —
 * tamtd@vihat.vn vẫn nhận thư trên mail.vihatgroup.com — nên "mail." + domain
 * sẽ trỏ sai server.
 *
 * Bỏ qua các nhà cung cấp công cộng: tài khoản Gmail/Outlook đã có không nói
 * lên điều gì về mail server nội bộ.
 */
const PUBLIC_MAIL_HOST = /(^|\.)(gmail|googlemail|google|outlook|office365|hotmail|live|yahoo|icloud)\.[a-z.]+$/i;

function guessInternalEndpoints(accounts: MailAccountPub[] | undefined): Pick<
  Preset, 'imapHost' | 'imapPort' | 'imapSecure' | 'smtpHost' | 'smtpPort' | 'smtpSecure'
> | null {
  // Gần nhất trước: hòm thư thêm sau cùng phản ánh cấu hình đang dùng.
  for (let i = (accounts?.length ?? 0) - 1; i >= 0; i--) {
    const a = accounts![i];
    if (!a.imap?.host || PUBLIC_MAIL_HOST.test(a.imap.host)) continue;
    return {
      imapHost: a.imap.host, imapPort: a.imap.port, imapSecure: a.imap.secure,
      // SMTP thường cùng host với IMAP ở Zimbra, nhưng nếu tài khoản cũ khai
      // khác thì tôn trọng đúng cái nó khai.
      smtpHost: a.smtp?.host || a.imap.host,
      smtpPort: a.smtp?.port ?? 465,
      smtpSecure: a.smtp?.secure ?? true,
    };
  }
  return null;
}

function AddAccountForm({ onDone, onCancel, accounts }: {
  onDone: (list: MailAccountPub[]) => void;
  onCancel?: () => void;
  /** Hòm thư đã có — nguồn suy ra host cho preset Zimbra. */
  accounts?: MailAccountPub[];
}) {
  const [preset, setPreset] = useState<Preset>(PRESETS[0]);
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [label, setLabel] = useState('');
  const [title, setTitle] = useState('');
  const [imapHost, setImapHost] = useState(PRESETS[0].imapHost);
  const [imapPort, setImapPort] = useState(PRESETS[0].imapPort);
  const [smtpHost, setSmtpHost] = useState(PRESETS[0].smtpHost);
  const [smtpPort, setSmtpPort] = useState(PRESETS[0].smtpPort);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [failure, setFailure] = useState<ImapFailureInfo | undefined>();
  const formRef = useRef<HTMLDivElement | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null); // consent Google trong app
  const [showAppPw, setShowAppPw] = useState(false);           // mở lại cách cũ nếu cần

  /** Host nội bộ suy từ hòm thư đã có — null khi đây là tài khoản đầu tiên. */
  const guessed = useMemo(() => guessInternalEndpoints(accounts), [accounts]);

  const pickPreset = (p: Preset) => {
    setPreset(p);
    // Zimbra: điền sẵn host của hòm thư nội bộ đã có, để chỉ còn phải nhập
    // user/pass. Chưa có hòm thư nào thì rơi về rỗng và form hiện ô nhập host.
    const src = p.key === 'zimbra' && guessed ? guessed : p;
    setImapHost(src.imapHost); setImapPort(src.imapPort);
    setSmtpHost(src.smtpHost); setSmtpPort(src.smtpPort);
  };

  const submit = async () => {
    setBusy(true); setErr(null); setFailure(undefined);
    try {
      const input: AccountAddInput = {
        label, title, email: email.trim(), pass,
        imapHost: imapHost.trim(), imapPort, imapSecure: imapPort !== 143,
        smtpHost: smtpHost.trim(), smtpPort, smtpSecure: smtpPort === 465,
      };
      onDone(await mAccountAdd(input));
    } catch (e) {
      // KHÔNG xóa gì trong form — người dùng chỉ cần sửa đúng ô sai rồi Thử lại.
      const me = e as MailActionError;
      setErr(me.message);
      setFailure(me.failure);
      // Đưa con trỏ về ô có vấn đề (mật khẩu/host/cổng) như mail client thật.
      const sel: Record<string, string> = {
        pass: '.pw-input-field', email: 'input[data-f="email"]',
        imapHost: 'input[data-f="imapHost"]', imapPort: 'input[data-f="imapPort"]',
      };
      const target = me.failure?.focus && formRef.current?.querySelector<HTMLInputElement>(sel[me.failure.focus]);
      if (target) { target.focus(); target.select?.(); }
    } finally {
      setBusy(false);
    }
  };

  const emailLooksValid = /^\S+@\S+\.\S+$/.test(email.trim());

  /** Bước 1: mở consent Google (kèm scope mail). Bước 2 chạy ở finishOAuth. */
  const oauthConnect = async () => {
    setErr(null); setFailure(undefined); setBusy(true);
    try {
      const { url } = await mGoogleAuthUrl(email.trim());
      if (typeof window !== 'undefined' && window.workspace?.isDesktop) {
        setAuthUrl(url); // consent TRONG app — khỏi phụ thuộc Edge/profile
      } else {
        window.open(url, '_blank', 'noopener');
        // Web thuần: không biết lúc nào consent xong → để người dùng bấm lại.
        setErr('Hoàn tất đăng nhập ở tab vừa mở, rồi bấm "Kết nối bằng Google" lần nữa để thêm hòm thư.');
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Bước 2: consent xong → tạo hòm thư dùng XOAUTH2. */
  const finishOAuth = async () => {
    setAuthUrl(null);
    setBusy(true); setErr(null); setFailure(undefined);
    try {
      onDone(await mAccountAddOAuth(email.trim(), { label, title }));
    } catch (e) {
      const me = e as MailActionError;
      setErr(me.message);
      setFailure(me.failure);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = email.trim() && pass && imapHost.trim() && smtpHost.trim();
  // Nhắc App Password khi CHỌN preset Gmail hoặc khi gõ địa chỉ @gmail.com vào
  // preset "Khác…" (người dùng hay tự điền host Gmail bằng tay).
  const isGmailTarget =
    preset.key === 'gmail' ||
    /@(gmail|googlemail)\.com$/i.test(email.trim()) ||
    /(^|\.)(gmail|googlemail)\.com$|google/i.test(imapHost.trim());

  return (
    <div className="mail-add" ref={formRef}>
      <div className="mail-add-presets">
        {PRESETS.map((p) => (
          <button key={p.key} className={`chip-btn${preset.key === p.key ? ' on' : ''}`}
            onClick={() => pickPreset(p)} title={p.hint}>
            {p.label}
          </button>
        ))}
      </div>
      {/* Zimbra đã suy được host thì NÓI RA host nào — người dùng không nhập nó
          nên phải thấy được app đang định nối tới đâu, và có đường đổi khi hòm
          thư mới nằm trên server khác. */}
      {preset.key === 'zimbra' && imapHost.trim() ? (
        <p className="small" style={{ color: 'var(--muted)', margin: '2px 0 8px' }}>
          Máy chủ: <b>{imapHost.trim()}</b>{' '}
          <button className="ghost sm" style={{ marginLeft: 4 }}
            onClick={() => { setImapHost(''); setSmtpHost(''); }}
            title="Nhập host IMAP/SMTP khác cho hòm thư này">
            đổi máy chủ
          </button>
        </p>
      ) : (
        <p className="small" style={{ color: 'var(--muted)', margin: '2px 0 8px' }}>{preset.hint}</p>
      )}

      {/* Gmail: ưu tiên OAuth. Google Workspace thường TẮT App Password
          ("The setting you are looking for is not available for your account")
          nên OAuth là đường duy nhất, và cũng khỏi phải lưu mật khẩu. */}
      {isGmailTarget && (
        <div className="mail-err mail-err--app-password" style={{ marginTop: 0 }}>
          <div className="mail-err-head">
            <span className="mail-err-ico" aria-hidden>Ⓖ</span>
            <b className="mail-err-title">Gmail / Google Workspace: đăng nhập bằng Google, không cần mật khẩu.</b>
          </div>
          <ul className="mail-err-steps">
            <li>Bấm nút dưới → chọn tài khoản → cấp quyền. DevBox chỉ giữ token, KHÔNG lưu mật khẩu.</li>
            <li>Dùng được cả khi công ty đã tắt App Password.</li>
          </ul>
          <div className="mail-err-actions">
            <button className="sm" onClick={() => void oauthConnect()} disabled={busy || !emailLooksValid}
              title={emailLooksValid ? 'Đăng nhập Google cho địa chỉ đã nhập' : 'Nhập địa chỉ email trước'}>
              {busy ? <span className="spinner" aria-hidden /> : 'Ⓖ'} Kết nối bằng Google
            </button>
            <button className="ghost sm" onClick={() => setShowAppPw((v) => !v)}>
              {showAppPw ? '▾' : '▸'} Dùng App Password (cách cũ)
            </button>
          </div>
        </div>
      )}
      <div className="mail-add-grid">
        <input className="input" data-f="email" placeholder="Email (vd ban@congty.com)" value={email}
          onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        {/* Gmail đi đường OAuth thì không cần ô mật khẩu — chỉ hiện khi người
            dùng chủ động chọn "Dùng App Password (cách cũ)". */}
        {(!isGmailTarget || showAppPw) && (
          <PasswordInput value={pass} onChange={setPass}
            placeholder={isGmailTarget ? 'App Password 16 ký tự' : 'Password'}
            title="Bấm 👁 để soi lại chuỗi vừa dán — sai một ký tự là bị từ chối." />
        )}
        <input className="input" placeholder="Tên trong app, vd 'Mail công ty' (mặc định: cả email)" value={title}
          onChange={(e) => setTitle(e.target.value)}
          title="Chỉ để bạn phân biệt các hòm thư trên tab — không ảnh hưởng mail gửi ra." />
        <input className="input" placeholder="Tên người gửi khi gửi mail (mặc định: email)" value={label}
          onChange={(e) => setLabel(e.target.value)}
          title="Người nhận thấy tên này ở header From." />
        {/* Hiện ô nhập host khi CHƯA CÓ host — chốt theo giá trị thực tế chứ
            không theo key preset, vì Zimbra có thể đã được điền sẵn từ hòm thư
            nội bộ đã có (guessInternalEndpoints). canSubmit đòi imapHost +
            smtpHost, nên giấu ô lúc host còn rỗng là nút "Thêm tài khoản" mờ
            vĩnh viễn, không có đường nào bấm được. */}
        {!imapHost.trim() && (
          <>
            <div className="mail-add-pair">
              <input className="input" data-f="imapHost" placeholder="IMAP host" value={imapHost} onChange={(e) => setImapHost(e.target.value)} />
              <input className="input mail-port" data-f="imapPort" type="number" value={imapPort}
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
      {err && (
        <MailErrorPanel failure={failure} message={err}
          onRetry={canSubmit ? () => void submit() : undefined} retrying={busy} />
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {/* Gmail + OAuth: nút thêm nằm ở panel Ⓖ trên kia, ở đây chỉ hiện khi
            dùng mật khẩu — tránh hai nút "thêm" cạnh nhau gây lẫn. */}
        {(!isGmailTarget || showAppPw) && (
          <button onClick={() => void submit()} disabled={busy || !canSubmit}>
            {busy ? <span className="spinner" aria-hidden /> : '＋'} {busy ? 'Đang kiểm tra đăng nhập…' : 'Thêm tài khoản'}
          </button>
        )}
        {onCancel && <button className="ghost" onClick={onCancel}>Hủy</button>}
      </div>

      {/* Consent Google chạy trong app — dùng lại khung của tab Google. */}
      {authUrl && (
        <GoogleAuthWindow url={authUrl}
          onDone={() => void finishOAuth()}
          onCancel={() => setAuthUrl(null)} />
      )}
    </div>
  );
}

// ── Composer (gửi mới / trả lời) ────────────────────────────────────────────

export interface ComposeDraft {
  to: string;
  cc: string;
  subject: string;
  /** Nội dung dạng HTML (ô soạn là editor định dạng). */
  body: string;
  inReplyTo?: string;
  references?: string[];
  /** Chuyển tiếp: giữ nguyên file đính kèm của mail gốc (chỉ gửi toạ độ,
   *  server tự đọc lại từ IMAP — không tải về rồi upload ngược lên). */
  forwardAttachments?: ForwardAttachmentRef[];
  /** Nhãn hiển thị của các đính kèm chuyển tiếp (server không trả lại tên khi
   *  mới chỉ có toạ độ, nên mang theo để composer hiện cho người dùng thấy). */
  forwardLabels?: { filename: string; size: number }[];
  /** Đây là reply/forward — quyết định có chèn chữ ký hay không theo
   *  `signatureOnReply` của tài khoản. */
  isResponse?: boolean;
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
  const [atts, setAtts] = useState<PendingAttachment[]>([]);
  /** Đính kèm mang theo từ mail gốc khi chuyển tiếp — bỏ được từng cái. */
  const [fwdAtts, setFwdAtts] = useState(
    (draft.forwardAttachments ?? []).map((ref, i) => ({
      ref,
      filename: draft.forwardLabels?.[i]?.filename ?? `đính kèm ${i + 1}`,
      size: draft.forwardLabels?.[i]?.size ?? 0,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [contacts, setContacts] = useState<MailContact[]>([]);
  useEffect(() => { mContacts().then(setContacts).catch(() => {}); }, []);

  const isReply = !!draft.inReplyTo;
  const isForward = (draft.forwardAttachments?.length ?? 0) > 0 || /^fwd?:/i.test(draft.subject);

  /**
   * Nội dung ban đầu = draft + CHỮ KÝ của tài khoản.
   *
   * Chèn một lần lúc mở composer (useState initializer) chứ không phải trong
   * effect: chèn ở effect thì người dùng thấy chữ ký "nhảy vào" sau một nhịp,
   * và nếu họ gõ kịp thì bị chèn đè lên.
   *
   * Trả lời/chuyển tiếp thì theo cờ `signatureOnReply` — nhiều người không
   * muốn ký lại ở mỗi lượt reply qua lại.
   */
  const [body, setBody] = useState(() => {
    const sig = account.signature?.trim();
    if (!sig) return draft.body;
    if (draft.isResponse && account.signatureOnReply === false) return draft.body;
    const block = `<div class="mail-sig">${sig}</div>`;
    // Chữ ký đứng TRƯỚC phần trích dẫn (chuẩn "top-posting"): người đọc thấy
    // nội dung mới + chữ ký, lịch sử nằm dưới cùng.
    const at = draft.body.indexOf('<p>Vào ');
    const cut = at >= 0 ? at : draft.body.indexOf('<div style="color:#5f6368;border-top');
    if (cut > 0) return `${draft.body.slice(0, cut)}${block}${draft.body.slice(cut)}`;
    return `${draft.body}${block}`;
  });

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
        accountId: account.id, to: to.trim(), cc: cc.trim() || undefined, subject,
        // Gửi CẢ HAI bản: `html` cho client đọc được định dạng, `text` suy ra
        // từ nó cho client text-only. nodemailer tự dựng multipart/alternative
        // — đúng chuẩn mail, không phải chọn một trong hai.
        text: htmlToText(body),
        html: body,
        inReplyTo: draft.inReplyTo, references: draft.references,
        attachments: atts.map(({ filename, contentBase64, contentType }) => ({ filename, contentBase64, contentType })),
        forwardAttachments: fwdAtts.length ? fwdAtts.map((a) => a.ref) : undefined,
      });
      onSent();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const attTotal = atts.reduce((s, a) => s + a.size, 0)
    + fwdAtts.reduce((s, a) => s + a.size, 0);

  return (
    <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="mail-compose"
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); void addFiles(e.dataTransfer.files); }}>
        {/* Header gradient — phân biệt reply / soạn mới */}
        <div className="mc-head">
          <span className="mc-head-ico" aria-hidden>{isReply ? '↩' : isForward ? '↳' : '✉'}</span>
          <span className="mc-head-title">{isReply ? 'Trả lời' : isForward ? 'Chuyển tiếp' : 'Thư mới'}</span>
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

        <div className="mc-body-wrap">
          <RichTextEditor
            value={body}
            onChange={setBody}
            onSubmit={() => { if (to.trim() && !busy) void send(); }}
            placeholder="Viết nội dung… (kéo-thả file vào đây để đính kèm · Ctrl+Enter gửi)"
            minHeight={240}
          />
        </div>

        {(atts.length > 0 || fwdAtts.length > 0) && (
          <div className="mc-atts">
            {/* Đính kèm mang theo từ mail gốc (chuyển tiếp) — chưa nằm trên máy
                này, server sẽ lấy lúc gửi. Đánh dấu ↳ cho khác file tự chọn. */}
            {fwdAtts.map((a, i) => (
              <span key={`f${i}`} className="mc-att" title="Đính kèm của thư gốc — giữ nguyên khi chuyển tiếp">
                ↳ <span className="mc-att-name">{a.filename}</span>
                {a.size > 0 && <span className="mc-att-size">{fmtSize(a.size)}</span>}
                <button className="mc-att-x" onClick={() => setFwdAtts(fwdAtts.filter((_, j) => j !== i))} title="Bỏ">✕</button>
              </span>
            ))}
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

function DetailView({
  accountId, path, detail, onBack, onReply, onForward, onDelete, deleting,
  trail = [], onOpenNested, onBackNested, nestedBusy = false,
}: {
  accountId: string;
  path: string;
  detail: MailDetail;
  onBack: () => void;
  onReply: (all: boolean) => void;
  onForward: () => void;
  onDelete: () => void;
  deleting: boolean;
  /** Đường đi tới mail LỒNG đang xem ([] = mail gốc trên server). */
  trail?: number[];
  /** Mở một đính kèm message/rfc822 thành mail để đọc. */
  onOpenNested?: (idx: number) => void;
  /** Quay lại một lớp lồng. */
  onBackNested?: () => void;
  /** Đang bóc một mail lồng. */
  nestedBusy?: boolean;
}) {
  const [allowRemote, setAllowRemote] = useState(false);
  const [saved, setSaved] = useState(false);
  const [linkMsg, setLinkMsg] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const hasRemote = !!detail.html && /src\s*=\s*["']?https?:/i.test(detail.html);
  const nestedView = trail.length > 0;

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

  const saveSender = async () => {
    if (!detail.from?.address) return;
    const label = detail.from.name ? `${detail.from.name} <${detail.from.address}>` : detail.from.address;
    try { await mContactAdd(label); setSaved(true); setTimeout(() => setSaved(false), 2500); } catch { /* ignore */ }
  };

  return (
    <div className="mail-detail">
      <div className="mail-detail-bar">
        <button
          className="ghost sm"
          onClick={() => (nestedView ? onBackNested?.() : onBack())}
          title={nestedView ? 'Quay lại thư chứa thư này' : 'Quay lại danh sách'}
        >←</button>
        {nestedView && <span className="badge" title="Đây là thư được đính kèm bên trong một thư khác">✉ thư lồng</span>}
        {!nestedView && (
          <>
            <button className="ghost sm" onClick={() => onReply(false)} title="Trả lời người gửi">↩ Trả lời</button>
            <button className="ghost sm" onClick={() => onReply(true)} title="Trả lời tất cả (To + Cc)">↩ Tất cả</button>
            <button className="ghost sm" onClick={onForward} title="Chuyển tiếp thư này (giữ nguyên nội dung + file đính kèm)">↳ Chuyển tiếp</button>
          </>
        )}
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
        {/* Thư lồng nằm bên trong thư khác — không có UID riêng trên server nên
            không xoá riêng được. Muốn xoá thì xoá thư chứa nó. */}
        {!nestedView && (
          <button className="ghost sm mail-del-btn" onClick={onDelete} disabled={deleting}
            title="Xóa mail này (chuyển vào Thùng rác; đang ở Thùng rác thì xóa vĩnh viễn)">
            {deleting ? <span className="spinner" aria-hidden /> : '🗑'} Xóa
          </button>
        )}
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
              a.nested ? (
                // Đính kèm LÀ MỘT MAIL (thư chuyển tiếp giữ nguyên bản gốc):
                // mở ra đọc ngay trong app thay vì tải .eml về máy rồi bó tay.
                <button
                  key={a.idx}
                  className="chip-btn mail-att-nested"
                  disabled={nestedBusy}
                  onClick={() => onOpenNested?.(a.idx)}
                  title={`Thư đính kèm — bấm để mở đọc\n${a.contentType} · ${fmtSize(a.size)}`}
                >
                  {nestedBusy ? <span className="spinner" aria-hidden /> : '✉'} {a.filename}{' '}
                  <span style={{ color: 'var(--muted)' }}>({fmtSize(a.size)}) · mở</span>
                </button>
              ) : (
                <a key={a.idx} className="chip-btn" href={attachmentUrl(accountId, path, detail.uid, a.idx, trail)}
                  title={`${a.contentType} · ${fmtSize(a.size)}`}>
                  📎 {a.filename} <span style={{ color: 'var(--muted)' }}>({fmtSize(a.size)})</span>
                </a>
              )
            ))}
          </div>
        )}
      </div>
      <div className="mail-detail-body">
        <MailBody
          html={detail.html}
          text={detail.text}
          subject={detail.subject}
          allowRemote={allowRemote}
          onLink={(u) => void handleBodyLink(u)}
        />
      </div>
    </div>
  );
}

// ── One account's mailbox (rail + list + detail) ────────────────────────────

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Nội dung mail gốc dưới dạng HTML để trích dẫn. Ưu tiên bản HTML thật (giữ
 *  được định dạng/bảng/ảnh như mọi mail client); chỉ có text thì dựng lại. */
function quotableHtml(detail: MailDetail): string {
  if (detail.html) return detail.html;
  if (detail.text) return textToHtml(detail.text);
  return '<p>(mail trống)</p>';
}

/**
 * Khối trích dẫn chuẩn: một dòng "Vào <ngày>, <người> đã viết:" rồi
 * <blockquote> ôm nội dung gốc — đúng cách Gmail/Outlook/Thunderbird dựng, nên
 * mail client bên kia gấp/tô xám được phần lịch sử.
 */
function quoteBlock(detail: MailDetail): string {
  const when = detail.date ? new Date(detail.date).toLocaleString('vi-VN') : '';
  const who = esc(fmtAddr(detail.from));
  return `<p>Vào ${esc(when)}, ${who} đã viết:</p>`
    + `<blockquote style="margin:0 0 0 8px;padding-left:12px;border-left:2px solid #dadce0;color:#5f6368">`
    + `${quotableHtml(detail)}</blockquote>`;
}

/** Dựng draft trả lời từ mail gốc: quote HTML, header thread, to/cc. */
function replyDraft(detail: MailDetail, all: boolean, selfEmail: string): ComposeDraft {
  const subject = /^re:/i.test(detail.subject) ? detail.subject : `Re: ${detail.subject}`;
  // Hai dòng trống ở đầu: chỗ để gõ, con trỏ đặt sẵn ở đó.
  const body = `<p><br></p><p><br></p>${quoteBlock(detail)}`;

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
    isResponse: true,
  };
}

/**
 * Dựng draft CHUYỂN TIẾP: header "Forwarded message" chuẩn + nguyên nội dung
 * gốc + giữ nguyên file đính kèm.
 *
 * Đính kèm chỉ mang theo TOẠ ĐỘ (path/uid/idx) chứ không tải nội dung về —
 * server đọc lại từ IMAP lúc gửi. Chuyển tiếp mail có file 20MB mà bắt trình
 * duyệt tải về rồi upload ngược lên là đi hai vòng mạng vô ích.
 *
 * Đính kèm là MAIL LỒNG cũng đi theo được: với server nó vẫn chỉ là một
 * attachment ở vị trí idx.
 */
function forwardDraft(detail: MailDetail, path: string): ComposeDraft {
  const subject = /^fwd?:/i.test(detail.subject) ? detail.subject : `Fwd: ${detail.subject}`;
  const when = detail.date ? new Date(detail.date).toLocaleString('vi-VN') : '';
  const row = (k: string, v: string) => (v ? `<div><b>${k}:</b> ${esc(v)}</div>` : '');

  const header =
    `<div style="color:#5f6368;border-top:1px solid #dadce0;padding-top:8px;margin-top:8px">`
    + `<p style="margin:0 0 6px">---------- Thư đã chuyển tiếp ----------</p>`
    + row('Từ', fmtAddr(detail.from))
    + row('Ngày', when)
    + row('Tiêu đề', detail.subject)
    + row('Tới', detail.to.map(fmtAddr).join(', '))
    + (detail.cc.length ? row('Cc', detail.cc.map(fmtAddr).join(', ')) : '')
    + `</div>`;

  return {
    to: '', cc: '', subject,
    body: `<p><br></p><p><br></p>${header}${quotableHtml(detail)}`,
    forwardAttachments: detail.attachments.map((a) => ({ path, uid: detail.uid, idx: a.idx })),
    forwardLabels: detail.attachments.map((a) => ({ filename: a.filename, size: a.size })),
    isResponse: true,
  };
}

function MailboxView({ account, onCompose }: {
  account: MailAccountPub;
  onCompose: (draft: ComposeDraft) => void;
}) {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const railSplit = useSplit({ varName: '--gp-rail', min: 170, max: 520, gap: 12 });
  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [path, setPath] = useState('INBOX');
  const [items, setItems] = useState<MailListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [oldestSeq, setOldestSeq] = useState<number | null>(null);
  const [detail, setDetail] = useState<MailDetail | null>(null);
  /**
   * Ngăn xếp mail LỒNG đang mở (thư chuyển tiếp đính kèm bản gốc).
   *
   * Mỗi phần tử là một lớp đi sâu thêm: `trail` là đường đi từ mail gốc tới nó
   * (dùng cho URL tải đính kèm), `detail` là nội dung đã bóc. Rỗng = đang xem
   * mail gốc. Dùng ngăn xếp chứ không phải một biến vì mail chuyển tiếp nhiều
   * lần thì có mail lồng trong mail lồng, và nút ← phải lùi từng lớp.
   */
  const [nested, setNested] = useState<{ trail: number[]; detail: MailDetail }[]>([]);
  const [nestedBusy, setNestedBusy] = useState(false);

  /** Gom mail cùng chuỗi hội thoại thành một dòng (như Gmail). Tắt được vì
   *  folder kiểu Sent/Archive nhiều khi muốn xem phẳng theo thời gian. */
  const [threaded, setThreaded] = useState(true);
  /** Chuỗi đang bung ra xem hết (theo khoá chuỗi). */
  const [openThreads, setOpenThreads] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
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

  /**
   * Mở một đính kèm message/rfc822 thành mail để đọc — chính là "thư chuyển
   * tiếp" mà trước đây chỉ tải được file .eml về máy.
   *
   * `base` là đường đi tới mail ĐANG xem; đi tiếp vào attachment `idx` của nó.
   * Server bóc từng lớp và trả về MailDetail y như mail thường, nên khung đọc
   * dùng lại nguyên vẹn.
   */
  const openNested = async (base: number[], idx: number) => {
    if (!detail) return;
    const trail = [...base, idx];
    setNestedBusy(true); setErr(null);
    try {
      const nd = await mNestedMessage(account.id, path, detail.uid, trail);
      setNested((s) => [...s, { trail, detail: nd }]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setNestedBusy(false);
    }
  };

  const openMessage = async (m: MailListItem) => {
    setOpening(m.uid); setErr(null);
    setNested([]); // mail khác → bỏ ngăn xếp mail lồng của mail cũ
    try {
      setDetail(await mMessage(account.id, path, m.uid));
      // Đã đọc server-side (\Seen) — cập nhật luôn UI khỏi chờ reload:
      // hàng trong danh sách hết đậm + badge 🔔 của folder giảm 1.
      if (!m.seen) {
        setItems((cur) => cur.map((x) => (x.uid === m.uid ? { ...x, seen: true } : x)));
        setFolders((cur) => cur.map((f) => (f.path === path ? { ...f, unseen: Math.max(0, f.unseen - 1) } : f)));
        pingMailWatch(); // badge tab Mail giảm ngay, khỏi chờ chu kỳ 10 phút
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setOpening(null);
    }
  };

  /** Đánh dấu toàn bộ mail trong folder hiện tại là đã đọc — optimistic UI. */
  const markAllRead = async () => {
    setMarkingAll(true); setErr(null);
    try {
      await mMarkAllSeen(account.id, path);
      setItems((cur) => cur.map((x) => ({ ...x, seen: true })));
      setFolders((cur) => cur.map((f) => (f.path === path ? { ...f, unseen: 0 } : f)));
      pingMailWatch();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setMarkingAll(false);
    }
  };

  const curFolder = folders.find((f) => f.path === path);
  // Đang đứng trong Thùng rác → xóa là VĨNH VIỄN (server sẽ expunge).
  const inTrash = curFolder?.specialUse === '\\Trash' || /^trash$/i.test(curFolder?.name ?? '');

  const threads = useMemo(() => groupThreads(items), [items]);

  /**
   * Danh sách dòng thực sự vẽ ra: mỗi chuỗi cho một dòng "đầu" (thư mới nhất),
   * cộng thêm các thư còn lại NẾU chuỗi đang bung. Tắt gom chuỗi thì mỗi thư
   * một dòng như cũ.
   *
   * Tính ở đây (thay vì lồng hai vòng map trong JSX) để phần render giữ nguyên
   * một vòng lặp phẳng — thêm/bớt nút trên dòng khỏi phải sửa hai chỗ.
   */
  const rows = useMemo(() => {
    const out: { thread: MailThread; item: MailListItem; depth: number }[] = [];
    if (!threaded) {
      for (const m of items) {
        out.push({ thread: { key: `uid:${m.uid}`, items: [m], unseen: !m.seen }, item: m, depth: 0 });
      }
      return out;
    }
    for (const t of threads) {
      out.push({ thread: t, item: t.items[0], depth: 0 });
      if (openThreads.has(t.key)) {
        for (const m of t.items.slice(1)) out.push({ thread: t, item: m, depth: 1 });
      }
    }
    return out;
  }, [threaded, threads, items, openThreads]);

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
        pingMailWatch(); // xóa mail chưa đọc cũng phải giảm badge ngay
      }
      setDetail((d) => (d?.uid === m.uid ? null : d));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="g-projects" ref={railSplit.ref} style={railSplit.style}>
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
          // Đang mở mail lồng thì hiện nó; ngăn xếp rỗng thì hiện mail gốc.
          (() => {
            const top = nested[nested.length - 1];
            const shown = top?.detail ?? detail;
            const trail = top?.trail ?? [];
            return (
              <DetailView
                accountId={account.id}
                path={path}
                detail={shown}
                trail={trail}
                onBack={() => { setDetail(null); setNested([]); }}
                onBackNested={() => setNested((s) => s.slice(0, -1))}
                onOpenNested={(idx) => void openNested(trail, idx)}
                onReply={(all) => onCompose(replyDraft(detail, all, account.email))}
                onForward={() => onCompose(forwardDraft(detail, path))}
                onDelete={() => void removeMail({ uid: detail.uid, seen: true, subject: detail.subject })}
                deleting={deleting === detail.uid}
                nestedBusy={nestedBusy}
              />
            );
          })()
        ) : (
          <>
            <div className="g-crumbs">
              <b>{curFolder ? `${folderIcon(curFolder)} ${curFolder.name}` : path}</b>
              <span className="small" style={{ color: 'var(--muted)' }}>{total ? `· ${total} mail` : ''}</span>
              {loading && <span className="spinner" aria-hidden />}
              <span style={{ flex: 1 }} />
              {(curFolder?.unseen ?? 0) > 0 && (
                <button className="ghost sm" disabled={markingAll}
                  onClick={() => void markAllRead()}
                  title="Đánh dấu tất cả mail trong thư mục này là đã đọc">
                  {markingAll ? <span className="spinner" aria-hidden /> : '✓ Đánh dấu tất cả đã đọc'}
                </button>
              )}
              <button
                className="ghost sm"
                aria-pressed={threaded}
                onClick={() => setThreaded((v) => !v)}
                title={threaded
                  ? 'Đang gom thư cùng chuỗi hội thoại — bấm để xem phẳng theo thời gian'
                  : 'Đang xem phẳng — bấm để gom thư cùng chuỗi hội thoại'}
              >
                {threaded ? '🧵 Chuỗi' : '☰ Phẳng'}
              </button>
              <button className="ghost sm" disabled={loading}
                onClick={() => { void loadList(path); loadFolders(); }}
                title="Tải lại danh sách mail + số chưa đọc">↻</button>
            </div>
            <div className="g-list">
              {rows.map(({ thread, item, depth }) => {
                const m = item;
                const count = thread.items.length;
                const isHead = depth === 0;
                const expanded = openThreads.has(thread.key);
                return (
                /* div role=button (không phải <button>) vì bên trong còn nút 🗑
                   — button lồng button là HTML sai và click sẽ loạn. */
                <div key={m.uid} role="button" tabIndex={0}
                  className={`g-row mail-row${m.seen ? '' : ' unread'}${depth > 0 ? ' mail-row-child' : ''}`}
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
                  {/* Chuỗi nhiều thư: bấm số để mở/gập các thư còn lại. Nút
                      riêng chứ không phải bấm cả dòng — bấm dòng vẫn phải mở
                      thư mới nhất như thói quen. */}
                  {isHead && count > 1 && (
                    <button
                      className={`mail-thread-count${expanded ? ' on' : ''}`}
                      title={expanded ? 'Gập chuỗi hội thoại' : `Chuỗi ${count} thư — bấm để xem hết`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenThreads((s) => {
                          const n = new Set(s);
                          if (n.has(thread.key)) n.delete(thread.key); else n.add(thread.key);
                          return n;
                        });
                      }}
                    >
                      {expanded ? '▾' : '▸'} {count}
                    </button>
                  )}
                  <span className="mail-date">{opening === m.uid ? <span className="spinner" aria-hidden /> : fmtRel(m.date ?? undefined)}</span>
                  {/* Xóa KHÔNG cần mở — cho mail nghi lừa đảo/độc hại. */}
                  <button className="mail-row-del" disabled={deleting === m.uid}
                    onClick={(e) => { e.stopPropagation(); void removeMail(m); }}
                    title={inTrash ? 'Xóa vĩnh viễn (không cần mở mail)' : 'Xóa — chuyển vào Thùng rác (không cần mở mail)'}>
                    {deleting === m.uid ? <span className="spinner" aria-hidden /> : '🗑'}
                  </button>
                </div>
                );
              })}
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
      <Splitter {...railSplit.grip} />
    </div>
  );
}

/** Modal ✎ — đổi tên QUẢN LÝ (tab) và tên NGƯỜI GỬI (header From). Hai thứ
 *  khác nhau nên tách rõ: đổi tên tab không ảnh hưởng mail gửi ra. */
function RenameAccountModal({ account, onDone, onCancel }: {
  account: MailAccountPub;
  onDone: (list: MailAccountPub[]) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(account.title ?? '');
  const [label, setLabel] = useState(account.label);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    try { onDone(await mAccountRename(account.id, { title, label })); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="mail-compose panel" style={{ width: 'min(520px, 94vw)' }}>
        <div className="mail-compose-head">
          <b>✎ Đổi tên tài khoản</b>
          <span className="small" style={{ color: 'var(--muted)' }}>{account.email}</span>
          <span style={{ flex: 1 }} />
          <button className="ghost sm" onClick={onCancel}>✕</button>
        </div>
        <label className="small" style={{ color: 'var(--muted)' }}>
          Tên hiển thị trong app (trên tab chọn tài khoản)
          <input className="input" autoFocus value={title} placeholder={account.email}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
        </label>
        <p className="small" style={{ color: 'var(--faint)', margin: '2px 0 6px' }}>
          Bỏ trống = hiện cả địa chỉ email. Chỉ để bạn phân biệt các hòm thư — không ảnh hưởng mail gửi ra.
        </p>
        <label className="small" style={{ color: 'var(--muted)' }}>
          Tên người gửi (người nhận thấy ở header From)
          <input className="input" value={label} placeholder={account.email}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
        </label>
        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button onClick={() => void submit()} disabled={busy}>
            {busy ? <span className="spinner" aria-hidden /> : '💾'} Lưu
          </button>
          <button className="ghost" onClick={onCancel}>Hủy</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Cấu hình CHỮ KÝ của một tài khoản.
 *
 * Chữ ký lưu dạng HTML để giữ được định dạng thật (tên đậm, chức danh, link
 * công ty) — soạn bằng chính editor dùng cho composer nên cái nhìn thấy lúc
 * soạn đúng bằng cái người nhận thấy.
 */
function SignatureModal({ account, onDone, onCancel }: {
  account: MailAccountPub;
  onDone: (list: MailAccountPub[]) => void;
  onCancel: () => void;
}) {
  const [html, setHtml] = useState(account.signature ?? '');
  // Mặc định BẬT khi chưa khai — người dùng mới sẽ thấy chữ ký ở cả reply,
  // giống hành vi quen thuộc của webmail.
  const [onReply, setOnReply] = useState(account.signatureOnReply !== false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Chữ ký kéo về từ webmail — nhiều cái thì cho chọn. */
  const [fetched, setFetched] = useState<ZimbraSignature[] | null>(null);
  const [pulling, setPulling] = useState(false);

  const submit = async () => {
    setBusy(true); setErr(null);
    try { onDone(await mSignatureSet(account.id, html, onReply)); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  /**
   * Kéo chữ ký đã cấu hình sẵn trên webmail về.
   *
   * Chỉ có MỘT chữ ký thì áp thẳng vào ô soạn (khỏi bắt bấm thêm một nhịp);
   * nhiều hơn thì hiện danh sách để chọn, vì Zimbra cho phép nhiều chữ ký và
   * ta không đoán được cái nào là cái bạn muốn dùng ở DevBox.
   */
  const pull = async () => {
    setPulling(true); setErr(null); setFetched(null);
    try {
      const { signatures } = await mSignatureFetch(account.id);
      if (signatures.length === 1) setHtml(signatures[0].html);
      else setFetched(signatures);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPulling(false);
    }
  };

  return (
    <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="mail-compose panel" style={{ width: 'min(640px, 94vw)' }}>
        <div className="mail-compose-head">
          <b>✍ Chữ ký</b>
          <span className="small" style={{ color: 'var(--muted)' }}>{account.email}</span>
          <span style={{ flex: 1 }} />
          <button className="ghost sm" onClick={onCancel} disabled={busy}>✕</button>
        </div>
        <div className="status-line" style={{ gap: 8, margin: '0 0 8px' }}>
          <p className="small" style={{ color: 'var(--faint)', margin: 0, flex: 1 }}>
            Tự chèn vào cuối thư khi soạn mới. Riêng từng tài khoản — hòm thư công ty
            và cá nhân ký khác nhau được.
          </p>
          {/* Chữ ký không đi qua IMAP/SMTP (nó là thiết lập tài khoản), nên phải
              hỏi webmail bằng API riêng của Zimbra. Hòm thư OAuth thì không có. */}
          {account.auth !== 'oauth' && (
            <button className="ghost sm" disabled={pulling || busy} onClick={() => void pull()}
              title="Lấy chữ ký bạn đã cấu hình trên webmail (Zimbra) về đây">
              {pulling ? <span className="spinner" aria-hidden /> : '⇩'} Lấy từ webmail
            </button>
          )}
        </div>

        {/* Webmail có nhiều chữ ký → chọn một. */}
        {fetched && fetched.length > 0 && (
          <div className="sig-pick">
            <span className="small" style={{ color: 'var(--muted)' }}>
              Webmail có {fetched.length} chữ ký — chọn một:
            </span>
            {fetched.map((s, i) => (
              <button key={i} className="sig-pick-item"
                onClick={() => { setHtml(s.html); setFetched(null); }}
                title="Dùng chữ ký này">
                <b>{s.name}</b>
                {s.plainOnly && <span className="badge">text thuần</span>}
                <span className="sig-pick-prev">{htmlToText(s.html).slice(0, 90)}</span>
              </button>
            ))}
          </div>
        )}

        <RichTextEditor
          value={html}
          onChange={setHtml}
          compact
          minHeight={150}
          placeholder="VD: Trần Văn A — Phòng Kỹ thuật · 09xx xxx xxx"
        />
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '10px 0 0', color: 'var(--muted)' }}>
          <input type="checkbox" checked={onReply} onChange={(e) => setOnReply(e.target.checked)} />
          Chèn cả khi trả lời / chuyển tiếp
        </label>
        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button onClick={() => void submit()} disabled={busy}>
            {busy ? <span className="spinner" aria-hidden /> : '💾'} Lưu
          </button>
          {account.signature && (
            <button className="ghost" disabled={busy}
              title="Xoá chữ ký của tài khoản này"
              onClick={() => { setHtml(''); }}>
              Xoá chữ ký
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="ghost" onClick={onCancel} disabled={busy}>Hủy</button>
        </div>
      </div>
    </div>
  );
}

// ── Top-level workspace ─────────────────────────────────────────────────────

export default function MailWorkspace() {
  const [accounts, setAccounts] = useState<MailAccountPub[] | null>(null);
  const [activeId, setActiveId] = useState('');
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<MailAccountPub | null>(null); // modal ✎ đổi tên
  const [signing, setSigning] = useState<MailAccountPub | null>(null); // modal ✍ chữ ký
  const [compose, setCompose] = useState<ComposeDraft | null>(null);
  const [sentFlash, setSentFlash] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Thư (IMAP) hay Lịch (CalDAV) — cùng tài khoản, cùng credentials.
  const [view, setView] = useState<'mail' | 'cal'>('mail');

  useEffect(() => {
    if (window.localStorage.getItem(VIEW_KEY) === 'cal') setView('cal');
  }, []);
  useEffect(() => { window.localStorage.setItem(VIEW_KEY, view); }, [view]);

  // Ẩn thông báo theo từng hòm thư + số chưa đọc của riêng từng hòm.
  //
  // Số lấy từ chính snapshot mà MailWatchHost đang poll (/api/mail/watch) — nó
  // đã có sẵn mảng per-account, nên không mở thêm kết nối IMAP nào. Ẩn rồi thì
  // số vẫn hiện ngay trên tab của hòm thư đó, chỉ là không dội ra huy hiệu tab
  // Mail nữa — giống hệt cách làm bên Workspace.
  const [mutedIds, setMutedIds] = useState<Set<string>>(() => new Set());
  const [unseenById, setUnseenById] = useState<Record<string, number>>({});

  useEffect(() => {
    setMutedIds(loadMutedMail());
    const sync = () => setMutedIds(loadMutedMail());
    window.addEventListener(MAIL_MUTED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(MAIL_MUTED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    const pull = async () => {
      try {
        const res = await fetch('/api/mail/watch');
        if (!res.ok) return;
        const snap = (await res.json()) as { accounts?: { id: string; unseen: number }[] };
        if (stopped || !Array.isArray(snap.accounts)) return;
        setUnseenById(Object.fromEntries(snap.accounts.map((a) => [a.id, a.unseen || 0])));
      } catch {
        /* server chưa sẵn sàng — thử lại ở nhịp sau */
      }
    };
    void pull();
    // Cùng nhịp với MailWatchHost; đọc snapshot in-memory nên rất nhẹ.
    const timer = setInterval(() => void pull(), 60_000);
    const onRefresh = () => void pull();
    window.addEventListener(MAIL_REFRESH_EVENT, onRefresh);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener(MAIL_REFRESH_EVENT, onRefresh);
    };
  }, []);

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
    // Hòm thư OAuth: KHÔNG revoke token Google ở đây — token dùng chung với tab
    // Google (Drive). Muốn thu hồi hẳn thì đăng xuất ở tab Google.
    const note = a.auth === 'oauth'
      ? 'Chỉ gỡ hòm thư khỏi tab Mail. Phiên đăng nhập Google vẫn giữ (tab Google dùng chung) — muốn thu hồi hẳn thì đăng xuất ở tab Google.'
      : 'Chỉ xóa credentials trên máy này.';
    if (!window.confirm(`Gỡ tài khoản ${a.email} khỏi DevBox?\n\n${note}`)) return;
    try {
      onAccountsChanged(await mAccountRemove(a.id));
      // Dọn cờ ẩn của hòm thư vừa gỡ, đừng để lại rác trong localStorage — id
      // là ngẫu nhiên nên nó sẽ nằm đó mãi mà không ai dùng tới nữa.
      if (loadMutedMail().has(a.id)) setMutedIds(toggleMutedMail(a.id));
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
            Xem + gửi/trả lời email ngay trong DevBox qua IMAP/SMTP chuẩn — Zimbra/mail nội bộ,
            Gmail, Outlook, hay bất kỳ mail server nào. Credentials lưu trên máy này,
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
        {/* Thư / Lịch — hai mặt của cùng một hòm thư (IMAP và CalDAV). */}
        <div className="mail-view-switch" role="tablist" aria-label="Thư hoặc Lịch">
          <button className={`chip-btn${view === 'mail' ? ' on' : ''}`} role="tab" aria-selected={view === 'mail'}
            onClick={() => setView('mail')} title="Hòm thư">📥 Thư</button>
          <button className={`chip-btn${view === 'cal' ? ' on' : ''}`} role="tab" aria-selected={view === 'cal'}
            onClick={() => setView('cal')} title="Lịch (CalDAV — Zimbra và tương đương)">📅 Lịch</button>
        </div>
        {view === 'mail' && (
          <button onClick={() => setCompose({ to: '', cc: '', subject: '', body: '' })} title="Soạn thư mới">
            ✉️ Soạn thư
          </button>
        )}
        {sentFlash && <span className="small" style={{ color: 'var(--ok, #3c9)' }}>✓ Đã gửi</span>}
        <span style={{ flex: 1 }} />
        <div className="g-accounts" role="tablist" aria-label="Mail accounts">
          {accounts.map((a) => {
            const muted = mutedIds.has(a.id);
            const unseen = unseenById[a.id] ?? 0;
            return (
            <span key={a.id} className={`g-acc${a.id === active.id ? ' on' : ''}${muted ? ' is-muted' : ''}`}
              title={`${a.email}${a.title ? ` — "${a.title}"` : ''}${muted ? ' · đang ẩn thông báo' : ''}`}>
              <button className="g-acc-btn" role="tab" aria-selected={a.id === active.id} onClick={() => setActiveId(a.id)}>
                {a.auth === 'oauth' ? 'Ⓖ' : '✉'} {accTitle(a)}
              </button>
              {/* Số chưa đọc của RIÊNG hòm thư này — ẩn thông báo thì vẫn hiện
                  ở đây (dạng lặng), chỉ là không cộng vào badge tab Mail. */}
              {unseen > 0 && (
                <span className={`mail-acc-unseen${muted ? ' is-quiet' : ''}`}
                  title={`${unseen} mail chưa đọc`}>
                  {unseen > 99 ? '99+' : unseen}
                </span>
              )}
              {/* Nút ẩn hiện thường trực khi ĐANG bật (nó là trạng thái, giấu đi
                  thì không biết hòm nào đang im); còn lại theo nếp cũ của ✎/✕ —
                  chỉ hiện ở tài khoản đang chọn. */}
              {(muted || a.id === active.id) && (
                <button
                  className={`g-acc-x${muted ? ' is-on' : ''}`}
                  aria-pressed={muted}
                  title={muted
                    ? 'Đang ẩn thông báo — bấm để báo lại như bình thường'
                    : 'Ẩn thông báo: chỉ hiện số ngay tại đây, không báo ra tab Mail'}
                  onClick={() => setMutedIds(toggleMutedMail(a.id))}
                >
                  {muted ? '🔕' : '🔔'}
                </button>
              )}
              {a.id === active.id && (
                <>
                  <button className="g-acc-x" onClick={() => setRenaming(a)} title="Đổi tên hiển thị">✎</button>
                  <button className="g-acc-x" onClick={() => setSigning(a)}
                    title={a.signature ? 'Sửa chữ ký cuối thư' : 'Đặt chữ ký cuối thư'}>✍</button>
                  <button className="g-acc-x" onClick={() => void removeAccount(a)} title={`Gỡ ${a.email}`}>✕</button>
                </>
              )}
            </span>
            );
          })}
          <button className="ghost sm" onClick={() => setAdding(true)} title="Thêm tài khoản mail khác">＋ Tài khoản</button>
        </div>
      </div>
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '6px 0' }}>{err}</pre>}

      {/* key=account id → đổi tài khoản là remount sạch folder/list/detail */}
      <div className="office-body">
        {view === 'cal'
          ? <MailCalendar key={`cal-${active.id}`} account={active} />
          : <MailboxView key={active.id} account={active} onCompose={setCompose} />}
      </div>

      {adding && (
        <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && setAdding(false)}>
          <div className="mail-compose panel">
            <div className="mail-compose-head">
              <b>＋ Thêm tài khoản mail</b>
              <span style={{ flex: 1 }} />
              <button className="ghost sm" onClick={() => setAdding(false)} title="Đóng">✕</button>
            </div>
            <AddAccountForm onDone={onAccountsChanged} onCancel={() => setAdding(false)}
              accounts={accounts} />
          </div>
        </div>
      )}

      {renaming && (
        <RenameAccountModal
          account={renaming}
          onDone={(list) => { setAccounts(list); setRenaming(null); }}
          onCancel={() => setRenaming(null)}
        />
      )}

      {signing && (
        <SignatureModal
          account={signing}
          onDone={(list) => { setAccounts(list); setSigning(null); }}
          onCancel={() => setSigning(null)}
        />
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
