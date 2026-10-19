'use client';

// Object browser: bucket picker → "thư mục" (prefix) breadcrumb → bảng object, kèm
// panel chi tiết (metadata, xem trước ảnh/văn bản), tải xuống, copy link tạm
// (presigned) và — chỉ khi ghi đang mở — upload / xoá / tạo-xoá bucket.
//
// Mọi thao tác GHI đều qua hai cổng ở server (MINIO_ALLOW_WRITE + connection
// không read-only); UI chỉ ẩn/khoá nút cho khỏi bấm nhầm. Xoá thư mục và xoá
// bucket bắt gõ lại tên để xác nhận.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fmtBytes,
  listMinioBuckets,
  listMinioObjects,
  minioDownloadUrl,
  minioMakeBucket,
  minioPresign,
  minioRemoveBucket,
  minioRemoveObject,
  minioRemovePrefix,
  statMinioObject,
  uploadMinioFiles,
  type MinioBucketInfo,
  type MinioListing,
  type MinioObjectInfo,
  type MinioObjectStat,
} from '@/lib/minio';

export interface BrowserViewProps {
  connectionId: string;
  readOnly: boolean;
  allowWrite: boolean;
  initialBucket?: string;
}

type Danger =
  | { kind: 'prefix'; bucket: string; target: string }
  | { kind: 'bucket'; bucket: string; target: string };

const IMG = /\.(png|jpe?g|gif|webp|bmp)$/i;
const TEXT = /\.(txt|log|json|ya?ml|md|csv|xml|ini|conf|sql|sh|js|ts|py|java|properties)$/i;
const PREVIEW_MAX = 512 * 1024;

const baseName = (key: string) => key.replace(/\/$/, '').split('/').pop() ?? key;

export default function BrowserView({ connectionId, readOnly, allowWrite, initialBucket }: BrowserViewProps) {
  const canWrite = allowWrite && !readOnly;
  const [buckets, setBuckets] = useState<MinioBucketInfo[]>([]);
  const [bucket, setBucket] = useState(initialBucket ?? '');
  const [prefix, setPrefix] = useState('');
  const [prefixes, setPrefixes] = useState<string[]>([]);
  const [objects, setObjects] = useState<MinioObjectInfo[]>([]);
  const [more, setMore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [sel, setSel] = useState<MinioObjectInfo | null>(null);
  const [stat, setStat] = useState<MinioObjectStat | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const [newBucket, setNewBucket] = useState<string | null>(null);
  const [danger, setDanger] = useState<Danger | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const reqSeq = useRef(0);

  const flash = useCallback((m: string) => {
    setNotice(m);
    setTimeout(() => setNotice((n) => (n === m ? null : n)), 3500);
  }, []);

  const loadBuckets = useCallback(async () => {
    try {
      const list = await listMinioBuckets(connectionId);
      setBuckets(list);
      setBucket((cur) => (cur && list.some((b) => b.name === cur) ? cur : list[0]?.name ?? ''));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [connectionId]);

  useEffect(() => { void loadBuckets(); }, [loadBuckets]);

  const load = useCallback(async (b: string, p: string, after?: string) => {
    if (!b) return;
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    try {
      const r: MinioListing = await listMinioObjects(connectionId, b, p, after);
      if (seq !== reqSeq.current) return;
      setPrefixes((cur) => (after ? [...cur, ...r.prefixes] : r.prefixes));
      setObjects((cur) => (after ? [...cur, ...r.objects] : r.objects));
      setMore(r.truncated ? r.nextAfter : null);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setError((e as Error).message);
      if (!after) { setPrefixes([]); setObjects([]); setMore(null); }
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    setSel(null); setStat(null); setPreview(null);
    if (bucket) void load(bucket, prefix);
  }, [bucket, prefix, load]);

  // Chi tiết + xem trước của object đang chọn.
  useEffect(() => {
    setStat(null); setPreview(null);
    if (!sel || !bucket) return;
    let dead = false;
    void statMinioObject(connectionId, bucket, sel.name).then((s) => { if (!dead) setStat(s); }).catch(() => {});
    if (TEXT.test(sel.name) && sel.size <= PREVIEW_MAX) {
      fetch(minioDownloadUrl(connectionId, bucket, sel.name, true))
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((t) => { if (!dead) setPreview(t); })
        .catch(() => {});
    }
    return () => { dead = true; };
  }, [sel, bucket, connectionId]);

  const crumbs = useMemo(() => {
    const parts = prefix.split('/').filter(Boolean);
    return parts.map((p, i) => ({ label: p, prefix: parts.slice(0, i + 1).join('/') + '/' }));
  }, [prefix]);

  const q = filter.trim().toLowerCase();
  const shownPrefixes = q ? prefixes.filter((p) => baseName(p).toLowerCase().includes(q)) : prefixes;
  const shownObjects = q ? objects.filter((o) => baseName(o.name).toLowerCase().includes(q)) : objects;

  async function doUpload(files: FileList | null) {
    if (!files || !files.length || !bucket) return;
    setBusy(true);
    setError(null);
    try {
      const r = await uploadMinioFiles(connectionId, bucket, prefix, [...files]);
      flash(`Đã tải lên ${r.uploaded.length} file`);
      await load(bucket, prefix);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function deleteObject(o: MinioObjectInfo) {
    if (!window.confirm(`Xoá object "${o.name}"?\nKhông khôi phục được (trừ khi bucket bật versioning).`)) return;
    setBusy(true);
    try {
      await minioRemoveObject(connectionId, bucket, o.name);
      flash(`Đã xoá ${baseName(o.name)}`);
      setSel(null);
      await load(bucket, prefix);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(o: MinioObjectInfo) {
    try {
      const { url } = await minioPresign(connectionId, bucket, o.name, 3600);
      await navigator.clipboard?.writeText(url);
      flash('Đã copy link tạm (hiệu lực 1 giờ)');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function createBucket() {
    const name = (newBucket ?? '').trim();
    if (!name) return;
    setBusy(true);
    try {
      await minioMakeBucket(connectionId, name);
      setNewBucket(null);
      flash(`Đã tạo bucket ${name}`);
      await loadBuckets();
      setPrefix('');
      setBucket(name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runDanger() {
    if (!danger || typed !== danger.target) return;
    setBusy(true);
    setError(null);
    try {
      if (danger.kind === 'prefix') {
        const r = await minioRemovePrefix(connectionId, danger.bucket, danger.target);
        flash(`Đã xoá ${r.removed} object`);
        setDanger(null); setTyped('');
        await load(bucket, prefix);
      } else {
        await minioRemoveBucket(connectionId, danger.bucket);
        flash(`Đã xoá bucket ${danger.bucket}`);
        setDanger(null); setTyped('');
        setPrefix('');
        await loadBuckets();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mio-browser">
      <div className="status-line" style={{ gap: 8, flexWrap: 'wrap' }}>
        <select className="input" value={bucket} onChange={(e) => { setPrefix(''); setBucket(e.target.value); }} style={{ minWidth: 180 }}>
          {buckets.length === 0 && <option value="">(chưa có bucket)</option>}
          {buckets.map((b) => <option key={b.name} value={b.name}>🪣 {b.name}</option>)}
        </select>
        <button className="chip-btn" onClick={() => { void loadBuckets(); void load(bucket, prefix); }} disabled={loading} title="Tải lại">↻</button>
        <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="🔍 Lọc trong thư mục này…" style={{ flex: 1, minWidth: 140 }} />
        {canWrite && (
          <>
            <button className="chip-btn" disabled={busy || !bucket} onClick={() => fileRef.current?.click()} title={`Tải lên ${bucket}/${prefix}`}>⬆ Upload</button>
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => void doUpload(e.target.files)} />
            <button className="chip-btn" disabled={busy} onClick={() => setNewBucket(newBucket === null ? '' : null)}>＋ Bucket</button>
            {bucket && <button className="chip-btn danger" disabled={busy} onClick={() => { setDanger({ kind: 'bucket', bucket, target: bucket }); setTyped(''); }} title="Xoá bucket (phải rỗng)">🗑 Bucket</button>}
          </>
        )}
        {!canWrite && <span className="badge" title={readOnly ? 'Server đang read-only' : 'MINIO_ALLOW_WRITE chưa bật'}>🔒 chỉ đọc</span>}
      </div>

      {newBucket !== null && (
        <div className="status-line" style={{ gap: 8 }}>
          <input className="input mono" autoFocus value={newBucket} placeholder="ten-bucket (chữ thường, số, - .)"
            onChange={(e) => setNewBucket(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void createBucket(); if (e.key === 'Escape') setNewBucket(null); }} />
          <button className="sm" disabled={busy || !newBucket.trim()} onClick={() => void createBucket()}>Tạo</button>
          <button className="ghost sm" onClick={() => setNewBucket(null)}>Huỷ</button>
        </div>
      )}

      {danger && (
        <div className="mio-danger">
          <div>
            {danger.kind === 'prefix'
              ? <>Xoá <b>toàn bộ object</b> dưới <code>{danger.target}</code> — không khôi phục được.</>
              : <>Xoá bucket <code>{danger.target}</code> (chỉ được khi bucket rỗng).</>}
            {' '}Gõ lại <code>{danger.target}</code> để xác nhận:
          </div>
          <div className="status-line" style={{ gap: 8 }}>
            <input className="input mono" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
            <button className="sm danger" disabled={busy || typed !== danger.target} onClick={() => void runDanger()}>Xoá</button>
            <button className="ghost sm" onClick={() => { setDanger(null); setTyped(''); }}>Huỷ</button>
          </div>
        </div>
      )}

      {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
      {notice && <div className="badge" style={{ color: 'var(--ok)' }}>{notice}</div>}

      <div className="mio-crumbs">
        <button className="pg-link" onClick={() => setPrefix('')}>🪣 {bucket || '—'}</button>
        {crumbs.map((c) => (
          <span key={c.prefix}> / <button className="pg-link" onClick={() => setPrefix(c.prefix)}>{c.label}</button></span>
        ))}
        {canWrite && prefix && (
          <button className="chip-btn danger" style={{ marginLeft: 10 }} disabled={busy}
            onClick={() => { setDanger({ kind: 'prefix', bucket, target: prefix }); setTyped(''); }}
            title="Xoá cả thư mục này">🗑 thư mục</button>
        )}
      </div>

      <div className="mio-split">
        <div className="mio-list">
          <table className="pg-table">
            <thead>
              <tr><th style={{ textAlign: 'left' }}>Tên</th><th>Dung lượng</th><th>Sửa lần cuối</th></tr>
            </thead>
            <tbody>
              {prefix && (
                <tr onClick={() => setPrefix(prefix.replace(/[^/]+\/$/, ''))} style={{ cursor: 'pointer' }}>
                  <td style={{ textAlign: 'left' }} colSpan={3}>↩ ..</td>
                </tr>
              )}
              {shownPrefixes.map((p) => (
                <tr key={p} onClick={() => setPrefix(p)} style={{ cursor: 'pointer' }}>
                  <td style={{ textAlign: 'left' }}>📁 {baseName(p)}</td><td>—</td><td>—</td>
                </tr>
              ))}
              {shownObjects.map((o) => (
                <tr key={o.name} className={sel?.name === o.name ? 'sel' : ''} onClick={() => setSel(o)} style={{ cursor: 'pointer' }}>
                  <td style={{ textAlign: 'left' }}>{IMG.test(o.name) ? '🖼' : '📄'} {baseName(o.name)}</td>
                  <td>{fmtBytes(o.size)}</td>
                  <td>{o.lastModified ? new Date(o.lastModified).toLocaleString('vi-VN') : '—'}</td>
                </tr>
              ))}
              {!loading && shownPrefixes.length === 0 && shownObjects.length === 0 && (
                <tr><td colSpan={3} className="empty">{q ? 'Không có mục nào khớp bộ lọc.' : 'Thư mục trống.'}</td></tr>
              )}
              {loading && <tr><td colSpan={3} className="empty"><span className="spinner" /> Đang tải…</td></tr>}
            </tbody>
          </table>
          {more && !loading && (
            <button className="chip-btn" style={{ margin: 8 }} onClick={() => void load(bucket, prefix, more)}>Tải thêm…</button>
          )}
        </div>

        {sel && (
          <aside className="mio-detail">
            <div className="status-line" style={{ justifyContent: 'space-between' }}>
              <strong title={sel.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{baseName(sel.name)}</strong>
              <button className="chip-btn" onClick={() => setSel(null)}>✕</button>
            </div>
            <dl className="mio-meta">
              <dt>Key</dt><dd className="mono">{sel.name}</dd>
              <dt>Dung lượng</dt><dd>{fmtBytes(sel.size)} ({sel.size.toLocaleString('vi-VN')} B)</dd>
              {stat?.contentType && (<><dt>Content-Type</dt><dd className="mono">{stat.contentType}</dd></>)}
              {(stat?.etag ?? sel.etag) && (<><dt>ETag</dt><dd className="mono">{stat?.etag ?? sel.etag}</dd></>)}
              {sel.lastModified && (<><dt>Sửa lần cuối</dt><dd>{new Date(sel.lastModified).toLocaleString('vi-VN')}</dd></>)}
            </dl>
            <div className="status-line" style={{ gap: 6, flexWrap: 'wrap' }}>
              <a className="chip-btn" href={minioDownloadUrl(connectionId, bucket, sel.name)} download>⬇ Tải xuống</a>
              <button className="chip-btn" onClick={() => void copyLink(sel)}>🔗 Copy link tạm</button>
              <button className="chip-btn" onClick={() => void navigator.clipboard?.writeText(`${bucket}/${sel.name}`)}>⧉ Copy path</button>
              {canWrite && <button className="chip-btn danger" disabled={busy} onClick={() => void deleteObject(sel)}>🗑 Xoá</button>}
            </div>
            {IMG.test(sel.name) && sel.size <= 8 * 1024 * 1024 && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="mio-img" alt={baseName(sel.name)} src={minioDownloadUrl(connectionId, bucket, sel.name, true)} />
            )}
            {preview !== null && <pre className="code mio-preview">{preview}</pre>}
          </aside>
        )}
      </div>
    </div>
  );
}
