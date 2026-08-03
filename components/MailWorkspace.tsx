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
  mAccounts, mAccountAdd, mAccountRemove, mFolders, mList, mMessage, mSend,
  attachmentUrl, folderIcon, fmtAddr, fmtSize,
  type MailAccountPub, type MailFolder, type MailListItem, type MailDetail, type AccountAddInput,
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

function Composer({ accountId, draft, onClose, onSent }: {
  accountId: string;
  draft: ComposeDraft;
  onClose: () => void;
  onSent: () => void;
}) {
  const [to, setTo] = useState(draft.to);
  const [cc, setCc] = useState(draft.cc);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  // Reply: caret đặt ở ĐẦU body (trên phần quote) — gõ được ngay.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) { el.focus(); el.setSelectionRange(0, 0); }
  }, []);

  const send = async () => {
    setBusy(true); setErr(null);
    try {
      await mSend({
        accountId, to: to.trim(), cc: cc.trim() || undefined, subject, text: body,
        inReplyTo: draft.inReplyTo, references: draft.references,
      });
      onSent();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mail-compose panel">
        <div className="mail-compose-head">
          <b>{draft.inReplyTo ? '↩ Trả lời' : '✉️ Soạn thư'}</b>
          <span style={{ flex: 1 }} />
          <button className="ghost sm" onClick={onClose} title="Đóng">✕</button>
        </div>
        <input className="input" placeholder="Tới (To) — nhiều địa chỉ cách nhau dấu phẩy" value={to}
          onChange={(e) => setTo(e.target.value)} />
        <input className="input" placeholder="Cc" value={cc} onChange={(e) => setCc(e.target.value)} />
        <input className="input" placeholder="Tiêu đề" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <textarea ref={bodyRef} className="input mail-compose-body" value={body}
          onChange={(e) => setBody(e.target.value)} placeholder="Nội dung…" />
        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => void send()} disabled={busy || !to.trim()}>
            {busy ? <span className="spinner" aria-hidden /> : '📨'} {busy ? 'Đang gửi…' : 'Gửi'}
          </button>
          <button className="ghost" onClick={onClose} disabled={busy}>Hủy</button>
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

function DetailView({ accountId, path, detail, onBack, onReply }: {
  accountId: string;
  path: string;
  detail: MailDetail;
  onBack: () => void;
  onReply: (all: boolean) => void;
}) {
  const [allowRemote, setAllowRemote] = useState(false);
  const hasRemote = !!detail.html && /src\s*=\s*["']?https?:/i.test(detail.html);

  return (
    <div className="mail-detail">
      <div className="mail-detail-bar">
        <button className="ghost sm" onClick={onBack} title="Quay lại danh sách">←</button>
        <button className="ghost sm" onClick={() => onReply(false)} title="Trả lời người gửi">↩ Trả lời</button>
        <button className="ghost sm" onClick={() => onReply(true)} title="Trả lời tất cả (To + Cc)">↩ Tất cả</button>
        {hasRemote && !allowRemote && (
          <button className="ghost sm" onClick={() => setAllowRemote(true)}
            title="Ảnh/nội dung remote đang bị chặn (tránh tracking) — bấm để tải">
            🖼 Hiện ảnh
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
            className="mail-frame"
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            srcDoc={buildSrcDoc(detail.html, allowRemote)}
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
                <button key={m.uid} className={`g-row mail-row${m.seen ? '' : ' unread'}`}
                  onClick={() => void openMessage(m)} title={m.subject}>
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
                </button>
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
          accountId={active.id}
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
