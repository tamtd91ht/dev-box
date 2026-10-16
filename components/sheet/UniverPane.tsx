'use client';

// Khung bao quanh giao diện Univer trong tab Excel: gọi server lấy dữ liệu workbook
// (action 'openUniver'), hiện trạng thái tải / lỗi, dựng UniverSheet, theo dõi số
// thay đổi chưa lưu và có nút 💾 Lưu.
//
// LƯU = so bản chụp hiện tại với mốc lúc nạp → "bản vá" chỉ gồm ô/định dạng/gộp ô/
// kích thước/freeze đã đổi → server đọc lại file từ đĩa, ghi đúng phần đó, backup
// `.bak` trước (xem lib/sheetUniverDiff + lib/sheetUniverSave). CSV gửi cả lưới giá trị.
//
// `version` đổi (vd file vừa được nạp lại vì bị sửa ngoài app) thì tải lại workbook;
// riêng version do CHÍNH LẦN LƯU của ta tạo ra thì bỏ qua (state đang đúng rồi).

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { openUniverSheet, saveUniverSheet, fmtBytes, type UniverOpened } from '@/lib/sheet';
import type { DiffResult } from '@/lib/sheetUniverDiff';
import type { UniverHandle } from './UniverSheet';
import ExcelRibbon from './ExcelRibbon';

// Univer chạm DOM/canvas ngay lúc import → chỉ nạp ở client, và chỉ khi thật sự cần
// (người dùng bật chế độ này) để không tăng dung lượng tải của các tab khác.
const UniverSheet = dynamic(() => import('./UniverSheet'), {
  ssr: false,
  loading: () => <div className="univer-state"><span className="spinner" aria-hidden /> Đang nạp giao diện bảng tính…</div>,
});

const EMPTY: DiffResult = { patch: { sheets: [] }, changed: 0, otherChanges: 0, blockers: [], warnings: [] };

export default function UniverPane({
  path, version, allowWrite, onDirty, onSaved, onExit, onOpenExternal, onOpenFile, onReload,
}: {
  path: string;
  version: number;
  allowWrite: boolean;
  /** Về lưới cũ. */
  onExit: () => void;
  /** Mở bằng Excel/WPS trên máy. */
  onOpenExternal: () => void;
  /** Chọn file khác. */
  onOpenFile: () => void;
  /** Đọc lại file từ đĩa. */
  onReload: () => void;
  /** Số thay đổi chưa lưu (ô + khác) — cha dùng để cảnh báo khi tải lại / đóng. */
  onDirty: (n: number) => void;
  /** Đã lưu xong: cha cập nhật mtime để không tưởng là file bị sửa ngoài app. */
  onSaved: (r: { mtimeMs: number; sizeBytes: number; backupPath: string; cells: number }) => void;
}) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; doc: UniverOpened }
  >({ kind: 'loading' });
  const [diff, setDiff] = useState<DiffResult>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const handle = useRef<UniverHandle | null>(null);
  /** Facade API của Univer cho ribbon — state (không phải ref) để ribbon bật nút khi sẵn sàng. */
  const [api, setApi] = useState<UniverHandle['api'] | null>(null);
  /** mtime mà file đang có theo hiểu biết của pane (đổi sau mỗi lần lưu). */
  const mtime = useRef(0);
  /** mtime do chính lần lưu của ta tạo ra — để effect tải bỏ qua. */
  const ownMtime = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    const h = handle.current;
    if (!h) return;
    const d = h.diff();
    setDiff(d);
    onDirty(d.changed + d.otherChanges);
  }, [onDirty]);

  /** Mỗi lệnh sửa đến dồn dập (gõ, kéo, dán): đợi ngơi tay rồi mới so sánh một lần. */
  const scheduleRefresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(refresh, 600);
  }, [refresh]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useEffect(() => {
    if (ownMtime.current === version) return; // version vừa do chính ta lưu ra
    let alive = true;
    setState({ kind: 'loading' });
    setApi(null);
    setDiff(EMPTY); onDirty(0); setErr(null);
    openUniverSheet(path)
      .then((doc) => { if (alive) { mtime.current = doc.mtimeMs; setState({ kind: 'ready', doc }); } })
      .catch((e) => { if (alive) setState({ kind: 'error', message: (e as Error).message }); });
    return () => { alive = false; };
  }, [path, version, onDirty]);

  const dirty = diff.changed + diff.otherChanges;

  const save = async () => {
    const h = handle.current;
    if (!h || state.kind !== 'ready') return;
    // Tính lại ngay trước khi lưu: số trên nút có thể trễ 600ms so với lần sửa cuối.
    const d = h.diff();
    setDiff(d);
    if (d.blockers.length) { setErr(d.blockers.join('\n')); return; }
    if (d.changed + d.otherChanges === 0) { setNote('Chưa có thay đổi nào để lưu.'); return; }
    const csv = state.doc.kind === 'csv';
    const lines = [
      `Ghi đè file ${csv ? 'CSV' : 'Excel'} này với ${d.changed.toLocaleString('vi')} ô${d.otherChanges ? ` + ${d.otherChanges} thay đổi khác (gộp ô/kích thước/freeze)` : ''}?`,
      'Bản gốc được sao lưu thành <tên file>.bak trước khi ghi.',
      ...(csv ? ['CSV không có định dạng/công thức: công thức được lưu thành giá trị đang hiển thị.'] : []),
      ...d.warnings,
    ];
    if (!window.confirm(lines.join('\n\n'))) return;
    setSaving(true); setErr(null); setNote(null);
    try {
      const r = await saveUniverSheet(path, mtime.current, csv ? { grid: h.grid() } : { patch: d.patch });
      mtime.current = r.mtimeMs;
      ownMtime.current = r.mtimeMs;
      h.rebase();
      setDiff(EMPTY); onDirty(0);
      onSaved({ mtimeMs: r.mtimeMs, sizeBytes: r.sizeBytes, backupPath: r.backupPath, cells: r.cells });
      setNote(`Đã lưu ${r.cells.toLocaleString('vi')} ô. Bản gốc: ${r.backupPath}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const doc = state.kind === 'ready' ? state.doc : null;
  const blocked = diff.blockers.length > 0;
  const fileName = path.split(/[\\/]/).pop() ?? path;
  return (
    <div className="univer-wrap">
      <ExcelRibbon
        api={api}
        fileName={fileName}
        kind={doc?.kind ?? (/\.csv$/i.test(path) ? 'csv' : 'xlsx')}
        dirty={dirty}
        saving={saving}
        canSave={!saving && dirty > 0 && !blocked && allowWrite && !!doc}
        saveTitle={!allowWrite
          ? 'Saving is disabled — set OFFICE_ALLOW_WRITE=true in .env.local'
          : blocked ? diff.blockers.join(' ') : dirty === 0 ? 'No changes to save' : `Save (Ctrl+S) — overwrite the file, original backed up as .bak`}
        onSave={() => void save()}
        onExit={onExit}
        onOpenExternal={onOpenExternal}
        onOpenFile={onOpenFile}
        onReload={onReload}
        info={doc ? (
          <>
            <p>{doc.cells.toLocaleString('vi')} ô · {fmtBytes(doc.sizeBytes)}
              {doc.truncated && <b style={{ color: 'var(--err)' }}> · file quá lớn, đã bỏ bớt phần cuối</b>}</p>
            <p>Lưu ghi vào file: <b>giá trị, công thức, màu/font/viền/căn lề, số, gộp ô, kích thước, freeze</b>.</p>
            <p>Conditional formatting, data validation (checkbox, dropdown), ghi chú, hyperlink, bảo vệ vùng, biểu đồ <b>chưa được ghi</b> vào file.</p>
          </>
        ) : null}
      />
      {state.kind === 'loading' && <div className="univer-state"><span className="spinner" aria-hidden /> Đang đọc file…</div>}
      {state.kind === 'error' && <div className="univer-state"><pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{state.message}</pre></div>}
      {blocked && <div className="sheet-extbar" role="alert">{diff.blockers.join(' ')}</div>}
      {diff.warnings.length > 0 && !blocked && <div className="sheet-extbar" role="status">⚠ {diff.warnings.join(' ')}</div>}
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: 0 }}>{err}</pre>}
      {note && <div className="badge" style={{ color: 'var(--ok)', alignSelf: 'flex-start' }}>{note}</div>}
      {doc && (
        <div className="univer-body">
          <UniverSheet workbook={doc.workbook} onReady={(h) => { handle.current = h; setApi(() => h.api); }} onEdited={scheduleRefresh} />
        </div>
      )}
    </div>
  );
}
