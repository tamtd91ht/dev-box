'use client';

// API-preview panel for the Google tab — hiển thị nội dung một file Drive
// PRIVATE ngay trong app, KHÔNG qua giao diện web của Google (webview không
// đăng nhập được vì Google chặn embedded browser). Server tải/export nội dung
// bằng token drive.readonly rồi trả descriptor (lib/google.ts → gPreview):
//   sheets → Sheets/xlsx: mỗi sheet một trang, thanh tab chuyển
//   html   → Docs thành HTML, docx qua mammoth, text/json thành <pre>
//   iframe → PDF (và Slides export PDF)     img → ảnh
//   none   → loại chưa hỗ trợ → chỉ còn nút mở browser / tải về
//
// MULTI-ACCOUNT FALLBACK: quyền Drive tính theo TỪNG FILE — cùng thư mục vẫn
// có file account này thấy, account kia không. Fail với account đang chọn →
// tự thử lần lượt các account còn lại; account nào đọc được thì dùng (hiện
// ghi chú). Chỉ để XEM — nút ✏️ mở editor thật.

import { useEffect, useState } from 'react';
import { gPreview, gContentUrl, withAuthuser, type GPreview, type GoogleAccount } from '@/lib/google';

interface Props {
  /** Account đang chọn trên toolbar — thử đầu tiên. */
  accountId: string;
  /** Mọi account đã đăng nhập DevBox — fallback khi account chính không đọc được. */
  accounts: GoogleAccount[];
  fileId: string;
  /** Tên hiển thị ban đầu (server trả tên chuẩn sau khi tải). */
  name: string;
  /** webViewLink gốc — editUrl dựng theo account THỰC SỰ đọc được (authuser). */
  webViewLink?: string;
  onClose: () => void;
  /** Mở editor thật NGAY TRONG APP (webview) — cần phiên nhúng đã đăng nhập
   *  Google (nút Ⓖ trong viewer). Absent khi chạy browser thường. */
  onOpenWeb?: (editUrl: string) => void;
}

export default function GoogleFilePreview({ accountId, accounts, fileId, name, webViewLink, onClose, onOpenWeb }: Props) {
  const [preview, setPreview] = useState<GPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Account thực sự đọc được file (có thể khác account đang chọn). */
  const [usedId, setUsedId] = useState(accountId);
  /** Đang thử account thứ mấy (hiện trạng thái khi fallback). */
  const [tryingEmail, setTryingEmail] = useState<string | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);

  useEffect(() => {
    let alive = true;
    setPreview(null); setErr(null); setSheetIdx(0); setUsedId(accountId);

    (async () => {
      // Account đang chọn trước, rồi tới các account còn lại.
      const order = [
        ...accounts.filter((a) => a.id === accountId),
        ...accounts.filter((a) => a.id !== accountId),
      ];
      let firstErr: string | null = null;
      for (const acc of order) {
        if (!alive) return;
        setTryingEmail(acc.email ?? acc.id);
        try {
          const p = await gPreview(acc.id, fileId);
          if (!alive) return;
          setUsedId(acc.id);
          setPreview(p);
          setTryingEmail(null);
          return;
        } catch (e) {
          firstErr ??= (e as Error).message;
        }
      }
      if (!alive) return;
      setTryingEmail(null);
      setErr(
        (firstErr ?? 'Không đọc được file.') +
        (order.length > 1 ? `\n(Đã thử cả ${order.length} tài khoản đang đăng nhập.)` : ''),
      );
    })();

    return () => { alive = false; };
  }, [accountId, accounts, fileId]);

  // Esc đóng panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = preview?.name ?? name;
  const usedAcc = accounts.find((a) => a.id === usedId);
  const usedByOther = preview && usedId !== accountId;
  const editUrl = webViewLink ? withAuthuser(webViewLink, usedAcc?.email) : undefined;

  return (
    <div className="g-viewer">
      <div className="ws-view" style={{ display: 'flex' }}>
        <div className="ws-toolbar">
          <div className="ws-title">
            <span className={`ws-dot ws-dot--${preview ? 'ready' : 'loading'}`} />
            <span className="ws-title-text" title={title}>{title}</span>
            <span className="small" style={{ color: 'var(--muted)', marginLeft: 8 }}>
              xem qua API · chỉ đọc{usedByOther ? ` · bằng ${usedAcc?.email ?? usedId}` : ''}
            </span>
          </div>
          <div className="ws-actions">
            {onOpenWeb && editUrl && (
              <button onClick={() => onOpenWeb(editUrl)} title="Mở editor thật của Google ngay trong app — cần phiên nhúng đã đăng nhập (nút Ⓖ)">
                ✏️ Sửa trong app
              </button>
            )}
            {editUrl && (
              <button onClick={() => window.open(editUrl, '_blank')} title="Sửa bằng editor thật của Google trên browser ngoài">
                ↗ Browser
              </button>
            )}
            <a className="gp-dl" href={gContentUrl(usedId, fileId)} download title="Tải file gốc về máy">⬇</a>
            <button onClick={onClose} title="Đóng (Esc)">✕</button>
          </div>
        </div>

        {usedByOther && (
          <div className="g-viewer-hint">
            Tài khoản đang chọn không đọc được file này — đang hiển thị bằng quyền của
            <b> {usedAcc?.email ?? usedId}</b>.
          </div>
        )}

        <div className="ws-canvas gp-canvas">
          {!preview && !err && (
            <div className="ws-overlay">
              <div className="ws-spinner" />
              <p>Đang tải nội dung {name}…{tryingEmail ? ` (thử ${tryingEmail})` : ''}</p>
            </div>
          )}
          {err && (
            <div className="ws-overlay">
              <div className="ws-overlay-ico">🔌</div>
              <h3>Không xem trước được</h3>
              <p className="ws-muted" style={{ whiteSpace: 'pre-wrap' }}>{err}</p>
              {editUrl && <button className="ws-retry" onClick={() => window.open(editUrl, '_blank')}>Mở trên browser</button>}
            </div>
          )}
          {preview?.kind === 'sheets' && (
            <div className="gp-sheets">
              {preview.sheets.length > 1 && (
                <div className="gp-sheettabs" role="tablist" aria-label="Sheets">
                  {preview.sheets.map((s, i) => (
                    <button key={`${i}-${s.name}`} role="tab" aria-selected={i === sheetIdx}
                      className={`gp-sheettab${i === sheetIdx ? ' on' : ''}`}
                      onClick={() => setSheetIdx(i)}>
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
              <iframe
                className="gp-frame"
                sandbox=""
                srcDoc={preview.sheets[sheetIdx]?.html ?? ''}
                title={`${title} — ${preview.sheets[sheetIdx]?.name ?? ''}`}
              />
            </div>
          )}
          {preview?.kind === 'html' && (
            <iframe className="gp-frame" sandbox="" srcDoc={preview.html} title={title} />
          )}
          {preview?.kind === 'iframe' && (
            <iframe className="gp-frame" src={preview.src} title={title} />
          )}
          {preview?.kind === 'img' && (
            <div className="gp-imgwrap"><img className="gp-img" src={preview.src} alt={title} /></div>
          )}
          {preview?.kind === 'none' && (
            <div className="ws-overlay">
              <div className="ws-overlay-ico">🗎</div>
              <h3>Chưa hỗ trợ xem trước loại file này</h3>
              <p className="ws-muted">{preview.mimeType}</p>
              <div style={{ display: 'flex', gap: 8 }}>
                {editUrl && <button className="ws-retry" onClick={() => window.open(editUrl, '_blank')}>Mở trên browser</button>}
                <a className="ws-retry" href={gContentUrl(usedId, fileId)} download style={{ textDecoration: 'none' }}>⬇ Tải về</a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
