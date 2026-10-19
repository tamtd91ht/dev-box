'use client';

// Hộp Export / Import collection của tab API — để mang request + biến sang máy
// khác. Export: chọn phạm vi (toàn bộ / một dự án / một thư mục con), có kèm
// biến hay không → tải file JSON. Import: chọn file (DevBox export, Postman
// Collection v2, hoặc nguyên .apicollections.json) → xem trước, đánh dấu cái
// trùng id → chọn cách xử lý trùng + thư mục đích → ghi.
//
// Chỉ bước bấm nút xác nhận cuối mới ghi; mọi thứ trước đó là đọc.

import { useMemo, useRef, useState } from 'react';
import { apiImportBundle, type ApiData, type ApiImportMode, type ApiImportResult } from '@/lib/api';
import { buildExport, downloadJson, exportFileName, inScope, parseImport, type ParsedImport } from '@/lib/apiTransfer';
import { readJsonFile } from '@/lib/connTransferClient';
import { allFolderPaths } from './CollectionRail';

const MODES: { v: ApiImportMode; label: string; hint: string }[] = [
  { v: 'overwrite', label: 'Ghi đè', hint: 'Request trùng id được thay bằng bản trong file (đồng bộ giữa các máy)' },
  { v: 'skip', label: 'Bỏ qua', hint: 'Giữ bản đang có, chỉ thêm request mới' },
  { v: 'duplicate', label: 'Tạo bản sao', hint: 'Thêm bản trong file thành request mới (id mới)' },
];

export default function ApiTransferModal({ data, initialTab, initialScope, onImported, onClose }: {
  data: ApiData;
  initialTab: 'export' | 'import';
  initialScope: string;
  onImported: (d: ApiData, r: ApiImportResult) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ── Export ──
  const folders = useMemo(() => allFolderPaths(data.requests).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [data.requests]);
  const [scope, setScope] = useState(initialScope);
  const [withProj, setWithProj] = useState(true);
  const [withGlobal, setWithGlobal] = useState(!initialScope);
  const nScope = data.requests.filter((r) => inScope(r.folder, scope)).length;
  const doExport = () => {
    const b = buildExport(data, scope, { projectVars: withProj, globalVars: withGlobal });
    downloadJson(b, exportFileName(scope));
    onClose();
  };

  // ── Import ──
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [mode, setMode] = useState<ApiImportMode>('overwrite');
  const [prefix, setPrefix] = useState('');
  const [withVars, setWithVars] = useState(true);
  const existing = useMemo(() => new Map(data.requests.map((r) => [r.id, r])), [data.requests]);
  const conflicts = parsed ? parsed.requests.filter((r) => existing.has(r.id)).length : 0;
  const byFolder = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of parsed?.requests ?? []) m.set(r.folder || '(chưa phân dự án)', (m.get(r.folder || '(chưa phân dự án)') ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [parsed]);
  const nVars = parsed ? Object.keys(parsed.projectVars).length + (parsed.globalVars.length ? 1 : 0) : 0;

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null); setParsed(null); setFileName(f.name);
    try { setParsed(parseImport(await readJsonFile(f))); } catch (e) { setErr((e as Error).message); }
  };
  const doImport = async () => {
    if (!parsed) return;
    setBusy(true); setErr(null);
    try {
      const r = await apiImportBundle({
        requests: parsed.requests,
        projectVars: withVars ? parsed.projectVars : undefined,
        globalVars: withVars ? parsed.globalVars : undefined,
        mode, prefix: prefix.trim(),
      });
      onImported(r.data, r.result);
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal ctf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>⇅ Export / Import collection</h3>
          <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
        </div>
        <div className="ctf-tabs">
          <button className={'chip-btn' + (tab === 'export' ? ' on' : '')} onClick={() => setTab('export')} disabled={busy}>⤒ Export</button>
          <button className={'chip-btn' + (tab === 'import' ? ' on' : '')} onClick={() => setTab('import')} disabled={busy}>⤓ Import</button>
        </div>
        {err && <div className="ctf-warn err" style={{ marginTop: 10 }}>{err}</div>}

        {tab === 'export' ? (
          <div className="atf-body">
            <label className="atf-field"><span>Phạm vi</span>
              <select className="input" value={scope} onChange={(e) => { setScope(e.target.value); setWithGlobal(!e.target.value); }}>
                <option value="">Toàn bộ collection ({data.requests.length} request)</option>
                {folders.map((f) => {
                  const depth = f.split('/').length - 1;
                  const n = data.requests.filter((r) => inScope(r.folder, f)).length;
                  return <option key={f} value={f}>{'  '.repeat(depth)}{depth ? '└ ' : '📁 '}{f.split('/').pop()} ({n})</option>;
                })}
              </select>
            </label>
            <label className="ctf-mode"><input type="checkbox" checked={withProj} onChange={(e) => setWithProj(e.target.checked)} /> Kèm biến của dự án / thư mục trong phạm vi</label>
            <label className="ctf-mode"><input type="checkbox" checked={withGlobal} onChange={(e) => setWithGlobal(e.target.checked)} /> Kèm biến chung ({(data.globalVars ?? []).length})</label>
            {(withProj || withGlobal) && (
              <div className="ctf-warn"><strong>Lưu ý:</strong> biến có thể chứa token / mật khẩu — file xuất ra là JSON thường, đừng gửi lên chỗ công khai.</div>
            )}
            <div className="ctf-actions">
              <span className="ctf-confirm">{nScope} request{scope ? ` trong "${scope}"` : ''} · file đính kèm (form-data) không được xuất.</span>
              <button className="ghost" onClick={onClose}>Huỷ</button>
              <button onClick={doExport} disabled={nScope === 0}>⤒ Tải file</button>
            </div>
          </div>
        ) : (
          <div className="atf-body">
            <div className="ctf-pickfile">
              <button className="ghost" disabled={busy} onClick={() => fileRef.current?.click()}>📂 Chọn file .json…</button>
              {fileName && <span className="ctf-filename">{fileName}</span>}
              <input ref={fileRef} type="file" accept=".json,application/json" hidden
                onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
            <p className="small" style={{ color: 'var(--muted)', margin: '6px 0 0' }}>
              Nhận file export của DevBox, Postman Collection v2.x, hoặc nguyên file .apicollections.json.
            </p>
            {parsed && (
              <>
                <div className="ctf-listhead"><span>{parsed.label}</span></div>
                <div className="ctf-list">
                  {byFolder.map(([f, n]) => (
                    <div key={f} className="ctf-row">
                      <span className="ctf-row-main"><span className="ctf-row-name">📁 {f}</span></span>
                      <span className="small" style={{ color: 'var(--muted)' }}>{n} request</span>
                    </div>
                  ))}
                </div>
                <label className="atf-field"><span>Đặt vào thư mục (tuỳ chọn)</span>
                  <input className="input" value={prefix} onChange={(e) => setPrefix(e.target.value)} list="atf-folders"
                    placeholder="Để trống = giữ nguyên cây thư mục của file" />
                  <datalist id="atf-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
                </label>
                {nVars > 0 && (
                  <label className="ctf-mode"><input type="checkbox" checked={withVars} onChange={(e) => setWithVars(e.target.checked)} />
                    Nhập cả biến ({Object.keys(parsed.projectVars).length} dự án{parsed.globalVars.length ? ` · ${parsed.globalVars.length} biến chung` : ''})</label>
                )}
                {conflicts > 0 && (
                  <div className="ctf-warn">
                    <strong>{conflicts}</strong> request đã có trên máy này (trùng id). Xử lý trùng:
                    <div className="ctf-modes">
                      {MODES.map((m) => (
                        <label key={m.v} className="ctf-mode" title={m.hint}>
                          <input type="radio" name="atf-mode" checked={mode === m.v} onChange={() => setMode(m.v)} /> {m.label}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <div className="ctf-actions">
                  <span className="ctf-confirm">
                    {parsed.requests.length} request · {parsed.requests.length - conflicts} mới{conflicts ? ` · ${conflicts} trùng` : ''}
                  </span>
                  <button className="ghost" onClick={onClose} disabled={busy}>Huỷ</button>
                  <button onClick={() => void doImport()} disabled={busy || parsed.requests.length === 0}>
                    {busy ? <><span className="spinner" /> Đang nhập…</> : '⤓ Nhập'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
