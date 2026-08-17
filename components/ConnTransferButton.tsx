'use client';

// Nút "⇅ Chuyển máy" + hộp thoại export/import cấu hình connection, DÙNG CHUNG
// cho cả 6 rail (Kafka, Redis, Mongo, Rabbit, ES, PG). Mỗi rail chỉ cần đặt
// <ConnTransferButton kind="kafka" connections={...} onImported={reload} />.
//
// LUỒNG EXPORT: tick chọn cụm → bấm "Tải file cấu hình" → xác nhận (có cảnh báo
// file chứa mật khẩu) → trình duyệt mở hộp thoại lưu file, chọn thư mục tuỳ ý.
// LUỒNG IMPORT: chọn file .json → server soi file, liệt kê từng cụm và đánh dấu
// cái nào TRÙNG với cấu hình đang có → chọn cách xử lý trùng → xác nhận → ghi.
//
// Việc ghi chỉ xảy ra ở bước bấm nút xác nhận cuối; mọi bước trước đó là đọc.

import { useRef, useState } from 'react';
import {
  downloadConnExport,
  previewConnImport,
  applyConnImport,
  readJsonFile,
  type RegistryKind,
  type ConflictMode,
  type ImportPreview,
} from '@/lib/connTransferClient';

/** Hình dạng tối thiểu của một connection mà nút này cần để hiện danh sách. */
export interface TransferableConnection {
  id: string;
  name: string;
  project: string;
}

export interface ConnTransferButtonProps {
  kind: RegistryKind;
  /** Danh sách đang hiện trên rail — nguồn cho checkbox export. */
  connections: TransferableConnection[];
  /** Gọi sau khi import xong để rail nạp lại danh sách từ server. */
  onImported: (summary: string) => void;
  onError: (msg: string) => void;
}

type Tab = 'export' | 'import';

/** Nhãn danh từ cho từng loại, dùng trong câu tiếng Việt ("3 cụm", "2 server"). */
const NOUN: Record<RegistryKind, string> = {
  kafka: 'cụm', redis: 'kết nối', mongo: 'cụm', rabbit: 'broker', es: 'cụm', pg: 'server',
};

export default function ConnTransferButton({ kind, connections, onImported, onError }: ConnTransferButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="chip-btn"
        title="Xuất cấu hình ra file / nhập cấu hình từ file (chuyển sang máy khác)"
        onClick={() => setOpen(true)}
      >⇅</button>
      {open && (
        <ConnTransferModal
          kind={kind}
          connections={connections}
          onClose={() => setOpen(false)}
          onImported={(s) => { setOpen(false); onImported(s); }}
          onError={onError}
        />
      )}
    </>
  );
}

function ConnTransferModal(props: {
  kind: RegistryKind;
  connections: TransferableConnection[];
  onClose: () => void;
  onImported: (summary: string) => void;
  onError: (msg: string) => void;
}) {
  const { kind, connections, onClose, onImported, onError } = props;
  const [tab, setTab] = useState<Tab>('export');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noun = NOUN[kind];

  // ── Export state ──────────────────────────────────────────────────────────
  // Mặc định tick hết: trường hợp thường gặp nhất là bê nguyên cấu hình sang máy mới.
  const [picked, setPicked] = useState<Set<string>>(() => new Set(connections.map((c) => c.id)));
  const [confirmExport, setConfirmExport] = useState(false);

  // ── Import state ──────────────────────────────────────────────────────────
  const fileRef = useRef<HTMLInputElement>(null);
  /** Nội dung file đã parse — giữ lại để gửi kèm ở bước ghi. */
  const [fileJson, setFileJson] = useState<unknown>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [impPicked, setImpPicked] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<ConflictMode>('overwrite');
  const [confirmImport, setConfirmImport] = useState(false);

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  };

  const doExport = async () => {
    setBusy(true); setError(null);
    try {
      const name = await downloadConnExport(kind, [...picked]);
      onImported(`Đã xuất ${picked.size} ${noun} → ${name}`);
    } catch (e) {
      setError((e as Error).message);
      setConfirmExport(false);
    } finally {
      setBusy(false);
    }
  };

  const onPickFile = async (f: File | null) => {
    if (!f) return;
    setBusy(true); setError(null); setPreview(null); setConfirmImport(false);
    try {
      const json = await readJsonFile(f);
      const p = await previewConnImport(kind, json);
      setFileJson(json);
      setFileName(f.name);
      setPreview(p);
      setImpPicked(new Set(p.items.map((i) => i.id)));
    } catch (e) {
      setError((e as Error).message);
      setFileJson(null); setFileName('');
    } finally {
      setBusy(false);
      // Cho phép chọn LẠI cùng một file (input file không bắn change nếu value trùng).
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const doImport = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const r = await applyConnImport(kind, fileJson, [...impPicked], mode);
      const parts = [
        r.added ? `thêm ${r.added}` : '',
        r.overwritten ? `ghi đè ${r.overwritten}` : '',
        r.skipped ? `bỏ qua ${r.skipped}` : '',
      ].filter(Boolean);
      onImported(`Đã import: ${parts.join(' · ') || 'không có thay đổi'}`);
    } catch (e) {
      setError((e as Error).message);
      setConfirmImport(false);
    } finally {
      setBusy(false);
    }
  };

  const conflicts = preview ? preview.items.filter((i) => i.conflict && impPicked.has(i.id)).length : 0;

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal ctf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>⇅ Chuyển cấu hình sang máy khác</h3>
          <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <div className="ctf-tabs">
          <button
            className={'chip-btn' + (tab === 'export' ? ' on' : '')}
            onClick={() => { setTab('export'); setError(null); }}
            disabled={busy}
          >⬇ Xuất ra file</button>
          <button
            className={'chip-btn' + (tab === 'import' ? ' on' : '')}
            onClick={() => { setTab('import'); setError(null); }}
            disabled={busy}
          >⬆ Nhập từ file</button>
        </div>

        {error && <div className="ctf-warn err" style={{ marginTop: 10 }}>{error}</div>}

        {/* ── EXPORT ─────────────────────────────────────────────────────── */}
        {tab === 'export' && (
          <>
            {connections.length === 0 ? (
              <p className="empty" style={{ marginTop: 14 }}>Chưa có cấu hình nào để xuất.</p>
            ) : (
              <>
                <div className="ctf-listhead">
                  <span>Chọn {noun} muốn xuất ({picked.size}/{connections.length})</span>
                  <span className="ctf-listhead-acts">
                    <button className="ghost sm" disabled={busy}
                      onClick={() => setPicked(new Set(connections.map((c) => c.id)))}>Chọn tất cả</button>
                    <button className="ghost sm" disabled={busy}
                      onClick={() => setPicked(new Set())}>Bỏ chọn</button>
                  </span>
                </div>

                <div className="ctf-list">
                  {connections.map((c) => (
                    <label key={c.id} className="ctf-row">
                      <input
                        type="checkbox"
                        checked={picked.has(c.id)}
                        disabled={busy}
                        onChange={() => setPicked((s) => toggle(s, c.id))}
                      />
                      <span className="ctf-row-main">
                        <span className="ctf-row-name">{c.name}</span>
                        <span className="ctf-row-sub">{c.project}</span>
                      </span>
                    </label>
                  ))}
                </div>

                <div className="ctf-warn">
                  <strong>⚠ File xuất ra chứa mật khẩu ở dạng thường</strong> — để sang máy khác
                  import là dùng được ngay, không phải gõ lại. Hãy coi file này như một file mật
                  khẩu: đừng gửi qua kênh công khai, đừng commit vào git.
                </div>

                <div className="ctf-actions">
                  {!confirmExport ? (
                    <button
                      disabled={busy || picked.size === 0}
                      onClick={() => { setError(null); setConfirmExport(true); }}
                    >⬇ Tải file cấu hình…</button>
                  ) : (
                    <>
                      <span className="ctf-confirm">
                        Xuất <b>{picked.size}</b> {noun} ra file JSON và tải về máy?
                      </span>
                      <button className="ghost" disabled={busy} onClick={() => setConfirmExport(false)}>Huỷ</button>
                      <button disabled={busy} onClick={doExport}>
                        {busy ? <><span className="spinner" /> Đang xuất…</> : 'Xác nhận xuất'}
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {/* ── IMPORT ─────────────────────────────────────────────────────── */}
        {tab === 'import' && (
          <>
            <div className="ctf-pickfile">
              <button className="ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
                📂 Chọn file cấu hình (.json)
              </button>
              {fileName && <span className="ctf-filename">{fileName}</span>}
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
              />
            </div>

            {busy && !preview && <p className="empty" style={{ marginTop: 12 }}><span className="spinner" /> Đang đọc file…</p>}

            {preview && (
              <>
                <div className="ctf-listhead">
                  <span>
                    File xuất lúc {formatStamp(preview.exportedAt)} · chọn {impPicked.size}/{preview.items.length}
                  </span>
                  <span className="ctf-listhead-acts">
                    <button className="ghost sm" disabled={busy}
                      onClick={() => setImpPicked(new Set(preview.items.map((i) => i.id)))}>Chọn tất cả</button>
                    <button className="ghost sm" disabled={busy}
                      onClick={() => setImpPicked(new Set())}>Bỏ chọn</button>
                  </span>
                </div>

                <div className="ctf-list">
                  {preview.items.map((i) => (
                    <label key={i.id} className="ctf-row">
                      <input
                        type="checkbox"
                        checked={impPicked.has(i.id)}
                        disabled={busy}
                        onChange={() => setImpPicked((s) => toggle(s, i.id))}
                      />
                      <span className="ctf-row-main">
                        <span className="ctf-row-name">
                          {i.name}
                          {i.conflict && <span className="ctf-tag warn" title={`Máy này đã có "${i.existingName}" cùng id`}>trùng</span>}
                          {i.hasSecret && <span className="ctf-tag" title="Bản ghi có kèm mật khẩu">🔑</span>}
                        </span>
                        <span className="ctf-row-sub">{i.project}{i.summary ? ` · ${i.summary}` : ''}</span>
                      </span>
                    </label>
                  ))}
                </div>

                {conflicts > 0 && (
                  <div className="ctf-warn">
                    <strong>{conflicts} {noun} bị trùng</strong> với cấu hình đang có trên máy này. Xử lý:
                    <div className="ctf-modes">
                      {([
                        ['overwrite', 'Ghi đè', 'Thay cấu hình cũ bằng cấu hình trong file'],
                        ['skip', 'Bỏ qua', 'Giữ nguyên cấu hình cũ, chỉ thêm cái chưa có'],
                        ['duplicate', 'Thêm bản sao', 'Giữ cả hai — bản mới được đặt id khác'],
                      ] as [ConflictMode, string, string][]).map(([m, label, hint]) => (
                        <label key={m} className="ctf-mode" title={hint}>
                          <input type="radio" name="ctf-mode" checked={mode === m} disabled={busy}
                            onChange={() => { setMode(m); setConfirmImport(false); }} />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <div className="ctf-actions">
                  {!confirmImport ? (
                    <button
                      disabled={busy || impPicked.size === 0}
                      onClick={() => { setError(null); setConfirmImport(true); }}
                    >⬆ Import vào máy này…</button>
                  ) : (
                    <>
                      <span className="ctf-confirm">
                        Ghi <b>{impPicked.size}</b> {noun} vào cấu hình máy này
                        {conflicts > 0 && <> — {conflicts} cái trùng sẽ <b>{
                          mode === 'overwrite' ? 'bị ghi đè' : mode === 'skip' ? 'được giữ nguyên' : 'thành bản sao'
                        }</b></>}?
                      </span>
                      <button className="ghost" disabled={busy} onClick={() => setConfirmImport(false)}>Huỷ</button>
                      <button disabled={busy} onClick={doImport}>
                        {busy ? <><span className="spinner" /> Đang import…</> : 'Xác nhận import'}
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** ISO → "17/08/2026 15:30". Chuỗi rỗng/không parse được → "?". */
function formatStamp(iso: string): string {
  if (!iso) return '?';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  const two = (x: number) => String(x).padStart(2, '0');
  return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
