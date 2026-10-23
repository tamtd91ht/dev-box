'use client';

// ẢNH ĐÍNH KÈM cho tab Công việc — dùng chung ở 3 chỗ: mô tả task, nội dung ghi
// chú, ghi chú nhiệm vụ trọng tâm. Token / ref: lib/workImageCore. Lưu: lib/workImages.
//
//   · useImageAttach(value, onChange) — gắn vào một <textarea> có sẵn: DÁN ảnh
//     (chụp màn hình rồi Ctrl+V), KÉO THẢ file ảnh, hoặc nút "🖼 Chèn ảnh". Mỗi
//     ảnh được upload rồi chèn token vào đúng vị trí con trỏ lúc dán.
//   · <ImageBar>    — nút chèn + trạng thái upload + ⚙ chọn nơi lưu.
//   · <ImageThumbs> — dải thumbnail các ảnh có trong văn bản (✕ để gỡ).
//   · <RichText>    — hiển thị văn bản kèm ảnh tại chỗ (chế độ xem).
//   · <ImageStorageModal> — chọn lưu LOCAL hay MINIO (chọn cụm có sẵn + bucket,
//     hoặc thêm cụm mới bằng form của menu MinIO — lưu chung registry).

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ConnectionForm from '../minio/ConnectionForm';
import { listMinioBuckets, type PublicMinioConnection } from '@/lib/minio';
import { emitInfraFocus } from '@/lib/infraFocus';
import {
  IMAGE_EXT, IMAGE_MAX_BYTES, imageRefs, imageToken, imageUrl, removeImageRef, splitImages,
  type WorkImageMode,
} from '@/lib/workImageCore';

// ── API ─────────────────────────────────────────────────────────────────────

interface ConfigView {
  config: { mode: WorkImageMode; connectionId: string | null; bucket: string | null };
  localDir: string;
  minioEnabled: boolean;
  minioAllowWrite: boolean;
  connections: PublicMinioConnection[];
}

async function imgApi<T>(init: RequestInit): Promise<T> {
  const r = await fetch('/api/work-images', { method: 'POST', ...init });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  }
  return (data as { result: T }).result;
}

const cfgAction = (action: string, params: Record<string, unknown> = {}) =>
  imgApi<ConfigView>({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...params }) });

async function uploadImage(file: File): Promise<string> {
  if (!IMAGE_EXT[file.type]) throw new Error(`"${file.name}" không phải ảnh PNG/JPEG/GIF/WebP/BMP.`);
  if (file.size > IMAGE_MAX_BYTES) throw new Error(`"${file.name}" lớn hơn ${IMAGE_MAX_BYTES / 1024 / 1024} MB.`);
  const form = new FormData();
  form.set('file', file);
  return (await imgApi<{ ref: string }>({ body: form })).ref;
}

/** Nhãn ngắn của nơi lưu hiện tại — hiện cạnh nút chèn ảnh. */
let modeCache: string | null = null;
const modeListeners = new Set<(s: string) => void>();
function publishMode(v: ConfigView) {
  const c = v.config;
  modeCache = c.mode === 'minio'
    ? `MinIO · ${v.connections.find((x) => x.id === c.connectionId)?.name ?? '?'} / ${c.bucket}`
    : 'Local';
  modeListeners.forEach((f) => f(modeCache!));
}

function useModeLabel(): string | null {
  const [label, setLabel] = useState(modeCache);
  useEffect(() => {
    modeListeners.add(setLabel);
    if (modeCache === null) cfgAction('config').then(publishMode).catch(() => {});
    return () => { modeListeners.delete(setLabel); };
  }, []);
  return label;
}

// ── Hook gắn vào textarea ───────────────────────────────────────────────────

function imageFiles(list: FileList | null | undefined): File[] {
  return list ? [...list].filter((f) => f.type.startsWith('image/')) : [];
}

export interface ImageAttach {
  taRef: React.RefObject<HTMLTextAreaElement>;
  /** Trải vào <textarea {...attach.taProps}>. */
  taProps: {
    ref: React.RefObject<HTMLTextAreaElement>;
    onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
    onDrop: (e: React.DragEvent<HTMLTextAreaElement>) => void;
    onDragOver: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  };
  insertFiles: (files: File[]) => Promise<void>;
  uploading: number;
  err: string | null;
  clearErr: () => void;
}

export function useImageAttach(value: string, onChange: (v: string) => void): ImageAttach {
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Upload là bất đồng bộ — trong lúc chờ người dùng vẫn gõ tiếp, nên chèn vào
  // GIÁ TRỊ MỚI NHẤT chứ không phải bản chụp lúc dán.
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const insertFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    const ta = taRef.current;
    let pos = ta ? ta.selectionStart : latest.current.value.length;
    setErr(null);
    setUploading((n) => n + files.length);
    for (const f of files) {
      try {
        const ref = await uploadImage(f);
        const cur = latest.current.value;
        const at = Math.min(pos, cur.length);
        // Ảnh đứng riêng một dòng — đọc văn bản thô vẫn dễ.
        const before = cur.slice(0, at);
        const tok = `${before && !before.endsWith('\n') ? '\n' : ''}${imageToken(ref, f.name && f.name !== 'image.png' ? f.name : 'ảnh')}\n`;
        latest.current.onChange(before + tok + cur.slice(at));
        pos = at + tok.length;
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }, []);

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFiles(e.clipboardData?.files);
    if (!files.length) return;            // dán chữ → để mặc định
    e.preventDefault();
    void insertFiles(files);
  };
  const onDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    const files = imageFiles(e.dataTransfer?.files);
    if (!files.length) return;
    e.preventDefault();                   // không thì trình duyệt mở ảnh thay cho trang
    void insertFiles(files);
  };
  const onDragOver = (e: React.DragEvent<HTMLTextAreaElement>) => {
    if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) e.preventDefault();
  };

  return {
    taRef, taProps: { ref: taRef, onPaste, onDrop, onDragOver }, insertFiles, uploading, err,
    clearErr: () => setErr(null),
  };
}

// ── Thanh công cụ ───────────────────────────────────────────────────────────

export function ImageBar({ attach }: { attach: ImageAttach }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState(false);
  const label = useModeLabel();
  return (
    <div className="wi-bar">
      <button type="button" className="ghost sm" onClick={() => fileRef.current?.click()} title="Chọn file ảnh để chèn">🖼 Chèn ảnh</button>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" multiple hidden
        onChange={(e) => { void attach.insertFiles(imageFiles(e.target.files)); e.target.value = ''; }} />
      <span className="small wi-hint">hoặc dán (Ctrl+V) / kéo thả ảnh vào ô</span>
      {attach.uploading > 0 && <span className="small"><span className="spinner" aria-hidden /> Đang tải {attach.uploading} ảnh…</span>}
      <span style={{ flex: 1 }} />
      <button type="button" className="ghost sm wi-mode" onClick={() => setSettings(true)} title="Chọn nơi lưu ảnh (local / MinIO)">
        ⚙ {label ?? '…'}
      </button>
      {attach.err && (
        <span className="small wi-err" title={attach.err}>
          ⚠ {attach.err} <button type="button" className="wk-note-chip-x" onClick={attach.clearErr}>✕</button>
        </span>
      )}
      {settings && <ImageStorageModal onClose={() => setSettings(false)} />}
    </div>
  );
}

// ── Hiển thị ────────────────────────────────────────────────────────────────

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop wi-lightbox" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" />
      <a className="wi-open" href={src} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>↗ Mở ảnh gốc</a>
    </div>,
    document.body,
  );
}

function Thumb({ refId, alt, onRemove, big }: { refId: string; alt: string; onRemove?: () => void; big?: boolean }) {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const src = imageUrl(refId);
  return (
    <span className={`wi-thumb${big ? ' big' : ''}`}>
      {broken ? (
        <span className="wi-broken" title={refId}>⚠ Không tải được ảnh</span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} title={alt} loading="lazy" onError={() => setBroken(true)}
          onClick={(e) => { e.stopPropagation(); setOpen(true); }} />
      )}
      {onRemove && (
        <button type="button" className="wi-x" title="Gỡ ảnh khỏi văn bản" onClick={(e) => { e.stopPropagation(); onRemove(); }}>✕</button>
      )}
      {open && <Lightbox src={src} onClose={() => setOpen(false)} />}
    </span>
  );
}

/** Dải thumbnail dưới ô soạn — chỉ hiện khi văn bản có ảnh. */
export function ImageThumbs({ text, onChange }: { text: string; onChange?: (v: string) => void }) {
  const refs = imageRefs(text);
  if (!refs.length) return null;
  return (
    <div className="wi-thumbs">
      {refs.map((r, i) => (
        <Thumb key={`${r}-${i}`} refId={r} alt="ảnh" onRemove={onChange ? () => onChange(removeImageRef(text, r)) : undefined} />
      ))}
    </div>
  );
}

/** Văn bản + ảnh tại chỗ, cho chế độ xem (dòng task…). */
export function RichText({ text, className }: { text: string; className?: string }) {
  const parts = splitImages(text);
  if (parts.every((p) => p.kind === 'text')) return <div className={className}>{text}</div>;
  return (
    <div className={className}>
      {parts.map((p, i) => (p.kind === 'text'
        ? <span key={i}>{p.text.replace(/^\n|\n$/g, '')}</span>
        : <Thumb key={i} refId={p.ref} alt={p.alt} big />))}
    </div>
  );
}

// ── Hộp chọn nơi lưu ────────────────────────────────────────────────────────

export function ImageStorageModal({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<ConfigView | null>(null);
  const [mode, setMode] = useState<WorkImageMode>('local');
  const [connId, setConnId] = useState('');
  const [bucket, setBucket] = useState('devbox-work');
  const [buckets, setBuckets] = useState<string[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    cfgAction('config').then((v) => {
      setView(v);
      setMode(v.config.mode);
      setConnId(v.config.connectionId ?? v.connections[0]?.id ?? '');
      if (v.config.bucket) setBucket(v.config.bucket);
    }).catch((e) => setErr((e as Error).message));
  }, []);

  // Đổi cụm → nạp danh sách bucket để chọn (vẫn gõ tên mới được — lưu sẽ tạo).
  useEffect(() => {
    if (mode !== 'minio' || !connId) { setBuckets(null); return; }
    let alive = true;
    setBuckets(null);
    listMinioBuckets(connId)
      .then((l) => alive && setBuckets(l.map((b) => b.name)))
      .catch((e) => alive && (setBuckets([]), setErr(`Không liệt kê được bucket: ${(e as Error).message}`)));
    return () => { alive = false; };
  }, [mode, connId]);

  const conn = view?.connections.find((c) => c.id === connId) ?? null;

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const v = await cfgAction('config-set', { mode, connectionId: connId, bucket: bucket.trim() });
      publishMode(v);
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const openMinio = () => {
    if (connId) emitInfraFocus({ stack: 'minio', connId, view: 'browser' });
    window.dispatchEvent(new CustomEvent('devbox:open-tab', { detail: 'minio' }));
    onClose();
  };

  return createPortal(
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(640px, 96vw)' }}>
        <div className="status-line" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>🖼 Nơi lưu ảnh — tab Công việc</h3>
          <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
        </div>
        {!view ? (
          err ? <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>
            : <p className="small"><span className="spinner" /> Đang tải…</p>
        ) : (
          <div className="wi-cfg">
            <label className="wi-opt">
              <input type="radio" checked={mode === 'local'} onChange={() => setMode('local')} />
              <span>
                <b>Lưu local</b> — file trên máy này, không commit lên git.
                <br /><code className="small">{view.localDir}</code>
                <br /><span className="small" style={{ color: 'var(--muted)' }}>
                  Task / ghi chú lưu trên Mongo nên máy khác vẫn thấy văn bản, nhưng ảnh local thì chỉ máy này xem được.
                </span>
              </span>
            </label>
            <label className="wi-opt">
              <input type="radio" checked={mode === 'minio'} disabled={!view.minioEnabled} onChange={() => setMode('minio')} />
              <span>
                <b>Lưu MinIO</b> — mọi máy dùng cùng cụm/bucket đều xem được ảnh.
                {!view.minioEnabled && <><br /><span className="small" style={{ color: 'var(--warn, #d29922)' }}>Tool MinIO đang tắt (MINIO_TOOL_ENABLED).</span></>}
              </span>
            </label>

            {mode === 'minio' && (
              <div className="wi-minio">
                <label className="wk-field"><span>Cụm MinIO</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <select className="input" value={connId} onChange={(e) => setConnId(e.target.value)} style={{ flex: 1 }}>
                      {view.connections.length === 0 && <option value="">— chưa có cụm nào —</option>}
                      {view.connections.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}{c.project ? ` (${c.project})` : ''} — {c.host}:{c.port}</option>
                      ))}
                    </select>
                    <button className="ghost sm" onClick={() => setAdding((v) => !v)}>{adding ? 'Đóng form' : '＋ Cụm mới'}</button>
                  </div>
                </label>
                {adding && (
                  <div className="wk-newconn">
                    {/* Form CHUẨN của menu MinIO — lưu thẳng vào registry dùng chung,
                        nên cụm mới hiện luôn bên menu MinIO. */}
                    <ConnectionForm
                      initial={null}
                      onCancel={() => setAdding(false)}
                      onError={(m) => setErr(m)}
                      onSaved={({ list, activeId }) => {
                        setView((v) => (v ? { ...v, connections: list } : v));
                        setConnId(activeId);
                        setAdding(false);
                        setErr(null);
                        window.dispatchEvent(new Event('devbox:minio-connections-changed'));
                      }}
                    />
                  </div>
                )}
                <label className="wk-field"><span>Bucket {buckets === null && connId && <span className="spinner" aria-hidden />}</span>
                  <input className="input" list="wi-buckets" value={bucket} onChange={(e) => setBucket(e.target.value.toLowerCase())} placeholder="devbox-work" />
                  <datalist id="wi-buckets">{(buckets ?? []).map((b) => <option key={b} value={b} />)}</datalist>
                </label>
                <p className="small" style={{ color: 'var(--muted)', margin: 0 }}>
                  Ảnh nằm dưới <code>devbox-work/&lt;YYYY-MM&gt;/</code> trong bucket.
                  {buckets && bucket.trim() && !buckets.includes(bucket.trim()) && <> Bucket <b>{bucket.trim()}</b> chưa có — sẽ được tạo khi lưu.</>}
                </p>
                {(!view.minioAllowWrite || conn?.readOnly) && (
                  <p className="small" style={{ color: 'var(--warn, #d29922)', margin: 0 }}>
                    ⚠ Chưa ghi được:{' '}
                    {!view.minioAllowWrite && <>đặt <code>MINIO_ALLOW_WRITE=true</code> trong .env.local{conn?.readOnly ? ' và ' : '.'}</>}
                    {conn?.readOnly && <>cụm <b>{conn.name}</b> đang Read-only — sửa cụm ở menu MinIO, bỏ chọn Read-only.</>}
                  </p>
                )}
                {connId && <button className="ghost sm" style={{ alignSelf: 'flex-start' }} onClick={openMinio}>↗ Mở cụm này ở menu MinIO</button>}
              </div>
            )}

            <p className="small" style={{ color: 'var(--muted)', margin: 0 }}>
              Đổi chế độ không di chuyển ảnh cũ — ảnh đã gắn vẫn đọc từ nơi nó được lưu.
            </p>
            {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: 0 }}>{err}</pre>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="sm" onClick={() => void save()} disabled={busy || (mode === 'minio' && (!connId || !bucket.trim()))}>
                {busy ? <span className="spinner" aria-hidden /> : '💾'} Lưu
              </button>
              <button className="ghost sm" onClick={onClose} disabled={busy}>Hủy</button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
