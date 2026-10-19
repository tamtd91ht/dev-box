'use client';

// Ô Response của tab API: trạng thái + Body / Cookies / Headers / Preview, và các
// nút tiện tay (format, tìm, chép, lưu file).
//
// Body LUÔN dựng bằng Monaco (kể cả khi không phải JSON): gấp/mở khối, tô màu,
// Ctrl+F có đếm khớp — và nút 🔍 ngay thanh công cụ gọi đúng hộp tìm đó, để khỏi
// phải biết phím tắt. Nút ✨ chỉ là công tắc Pretty/Raw: nguyên văn server trả
// về không bao giờ bị ghi đè (đó mới là thứ để đối chiếu khi nghi server trả lạ).

import { useMemo, useRef, type ReactNode } from 'react';
import type { editor } from 'monaco-editor';
import type { HttpResult } from '@/lib/api';
import { formatText, type FormatKind } from '@/lib/format';
import { looksLikeJson } from '@/lib/jsonEdit';
import JsonBox from './JsonBox';

export type ResTab = 'body' | 'cookies' | 'headers' | 'preview';

interface Cookie { name: string; value: string; domain: string; path: string; expires: string; flags: string }

/** Một dòng Set-Cookie → các cột để hiện bảng. */
function parseCookie(line: string): Cookie {
  const [pair, ...attrs] = line.split(';').map((x) => x.trim());
  const eq = pair.indexOf('=');
  const c: Cookie = { name: eq < 0 ? pair : pair.slice(0, eq), value: eq < 0 ? '' : pair.slice(eq + 1), domain: '', path: '', expires: '', flags: '' };
  const flags: string[] = [];
  for (const a of attrs) {
    const i = a.indexOf('=');
    const k = (i < 0 ? a : a.slice(0, i)).toLowerCase();
    const v = i < 0 ? '' : a.slice(i + 1);
    if (k === 'domain') c.domain = v;
    else if (k === 'path') c.path = v;
    else if (k === 'expires') c.expires = v;
    else if (k === 'max-age') c.expires = c.expires || `max-age ${v}s`;
    else if (k === 'httponly') flags.push('HttpOnly');
    else if (k === 'secure') flags.push('Secure');
    else if (k === 'samesite') flags.push(`SameSite=${v}`);
  }
  c.flags = flags.join(' · ');
  return c;
}

const EXT_BY_TYPE: [RegExp, string][] = [
  [/json/i, 'json'], [/html/i, 'html'], [/xml/i, 'xml'], [/png/i, 'png'], [/jpe?g/i, 'jpg'],
  [/gif/i, 'gif'], [/svg/i, 'svg'], [/webp/i, 'webp'], [/pdf/i, 'pdf'], [/zip/i, 'zip'],
  [/csv/i, 'csv'], [/javascript/i, 'js'], [/text/i, 'txt'],
];

/** Tên file gợi ý: lấy từ Content-Disposition nếu có, không thì đoán đuôi theo content-type. */
function suggestName(res: HttpResult): string {
  const cd = res.headers['content-disposition'] ?? '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  const ct = res.contentType ?? res.headers['content-type'] ?? '';
  const ext = EXT_BY_TYPE.find(([re]) => re.test(ct))?.[1] ?? (res.bodyB64 ? 'bin' : 'txt');
  return `response.${ext}`;
}

function downloadResponse(res: HttpResult): void {
  const ct = res.contentType ?? res.headers['content-type'] ?? 'application/octet-stream';
  let part: BlobPart;
  if (res.bodyB64) {
    const bin = atob(res.bodyB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    part = bytes;
  } else {
    part = res.body;
  }
  const url = URL.createObjectURL(new Blob([part], { type: ct }));
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestName(res);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ResponsePane({
  res, err, sending, tab, onTab, pretty, onPretty, modelKey, tools,
}: {
  res: HttpResult | null;
  err: string | null;
  sending: boolean;
  tab: ResTab;
  onTab: (t: ResTab) => void;
  pretty: boolean;
  onPretty: (up: (p: boolean) => boolean) => void;
  /** Khoá model Monaco — phải riêng theo từng tab request. */
  modelKey: string;
  /** Nút bố cục (⇄ / thu gọn) do cha truyền vào, đặt cuối thanh trạng thái. */
  tools: ReactNode;
}) {
  const edRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const kind = useMemo<FormatKind | null>(() => {
    if (!res) return null;
    const ct = res.headers['content-type'] ?? '';
    if (/json/i.test(ct)) return 'json';
    if (/html/i.test(ct)) return 'html';
    if (/xml/i.test(ct)) return 'xml';
    return looksLikeJson(res.body) ? 'json' : null; // server trả text/plain mà ruột là JSON
  }, [res]);

  const shown = useMemo(() => {
    if (!res) return '';
    if (!pretty || !kind) return res.body;
    const f = formatText(kind, res.body);
    return f.ok ? f.text : res.body;
  }, [res, kind, pretty]);

  const cookies = useMemo(() => (res?.cookies ?? []).map(parseCookie), [res]);
  const isImage = !!res?.bodyB64 && /^image\//i.test(res.contentType ?? '');
  const canPreview = !!res && (kind === 'html' || isImage);
  // Tab Preview chọn rồi nhưng response mới không xem trước được → rơi về Body.
  const active: ResTab = tab === 'preview' && !canPreview ? 'body' : tab;
  const language = kind === 'json' ? 'json' : kind === 'xml' ? 'xml' : kind === 'html' ? 'html' : 'plaintext';

  const find = () => {
    const ed = edRef.current;
    if (!ed) return;
    ed.focus();
    void ed.getAction('actions.find')?.run();
  };

  const headerEntries = Object.entries(res?.headers ?? {});

  return (
    <div className="api-res">
      <div className="api-res-head">
        {res ? (
          <>
            <span className={`api-status api-status--${Math.floor(res.status / 100)}`}>{res.status} {res.statusText}</span>
            <span className="small" style={{ color: 'var(--muted)' }}>{res.timeMs} ms · {fmtSize(res.size)}</span>
          </>
        ) : <b>Response</b>}
        {sending && <span className="small" style={{ color: 'var(--muted)' }}>đang gửi…</span>}
        <span style={{ flex: 1 }} />
        {res && (
          <>
            <button className={`api-tab${active === 'body' ? ' on' : ''}`} onClick={() => onTab('body')}>Body</button>
            <button className={`api-tab${active === 'cookies' ? ' on' : ''}`} onClick={() => onTab('cookies')}>
              Cookies{cookies.length ? ` (${cookies.length})` : ''}
            </button>
            <button className={`api-tab${active === 'headers' ? ' on' : ''}`} onClick={() => onTab('headers')}>
              Headers ({headerEntries.length})
            </button>
            {canPreview && (
              <button className={`api-tab${active === 'preview' ? ' on' : ''}`} onClick={() => onTab('preview')}>Preview</button>
            )}
          </>
        )}
        <span className="api-tools">{tools}</span>
      </div>

      {err && <pre className="code api-err">{err}</pre>}

      {!res && !err && (
        <div className="api-res-empty">{sending ? 'Đang chờ server trả lời…' : 'Chưa có response — nhập URL rồi bấm ▶ Send.'}</div>
      )}

      {res && active === 'body' && (
        <>
          <div className="api-res-bar">
            {kind && (
              <button className="ghost sm" onClick={() => onPretty((p) => !p)}
                title={pretty ? 'Xem nguyên văn server trả về' : `Format ${kind.toUpperCase()} cho dễ đọc`}>
                {pretty ? '↩ Raw' : `✨ Format ${kind.toUpperCase()}`}
              </button>
            )}
            <button className="ghost sm" onClick={find} title="Tìm trong response (Ctrl+F)">🔍 Tìm</button>
            <button className="ghost sm" onClick={() => void navigator.clipboard?.writeText(shown)}
              title="Chép nội dung đang hiển thị">⧉ Chép</button>
            <button className="ghost sm" onClick={() => downloadResponse(res)}
              title={`Lưu thành file (${suggestName(res)})`}>⬇ Lưu</button>
          </div>
          <div className="api-resbox">
            <div className="api-fill">
              <JsonBox path={`api-res-${modelKey}`} value={shown} language={language} height="100%"
                onEditor={(ed) => { edRef.current = ed; }} />
            </div>
          </div>
        </>
      )}

      {res && active === 'cookies' && (
        cookies.length === 0
          ? <div className="api-res-empty">Response không đặt cookie nào (không có Set-Cookie).</div>
          : (
            <div className="api-res-table">
              <table className="api-tbl">
                <thead><tr><th>Name</th><th>Value</th><th>Domain</th><th>Path</th><th>Expires</th><th>Flags</th></tr></thead>
                <tbody>
                  {cookies.map((c, i) => (
                    <tr key={i}>
                      <td>{c.name}</td><td className="api-tbl-wrap">{c.value}</td><td>{c.domain}</td>
                      <td>{c.path}</td><td>{c.expires}</td><td>{c.flags}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
      )}

      {res && active === 'headers' && (
        <div className="api-res-table">
          <table className="api-tbl">
            <thead><tr><th>Header</th><th>Value</th></tr></thead>
            <tbody>
              {headerEntries.map(([k, v]) => (
                <tr key={k}><td>{k}</td><td className="api-tbl-wrap">{v}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {res && active === 'preview' && (
        isImage
          // eslint-disable-next-line @next/next/no-img-element
          ? <div className="api-preview"><img alt="response" src={`data:${res.contentType};base64,${res.bodyB64}`} /></div>
          // sandbox KHÔNG có allow-scripts / allow-same-origin: trang xem trước
          // không chạy JS và không với tới app — chỉ để nhìn bố cục.
          : <iframe className="api-preview-frame" title="HTML preview" sandbox="" srcDoc={res.body} />
      )}
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
