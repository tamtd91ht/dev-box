'use client';

// Hộp thoại xuất Excel DÙNG CHUNG (Mongo/ES/PG/Redis/Kafka): đặt tiêu đề, khai cột (tên · field code · định dạng · phân cách ·
// đổi giá trị), lưu/nạp cấu hình theo tên, xác nhận số dòng rồi tải toàn bộ + dựng .xlsx ở trình duyệt (ExcelJS nạp động).
// Từng loại chỉ cung cấp: đếm (countRows) và cách tải hết các dòng (fetchRows) — phân trang tuỳ backend.

import { useCallback, useMemo, useState } from 'react';
import { buildReportXlsx, downloadBlob, explodeRows, reportFilename, MAX_EXPORT_ROWS, NO_COLUMN_PATH } from '@/lib/mongoReport';
import {
  loadExportConfigs,
  removeExportConfig,
  saveExportConfig,
  type MongoExportConfig,
} from '@/lib/mongoExportConfigs';
import ColumnMapper, { hasDataColumn, initialColumns, prettyHeader, toReportColumns, type ColumnDraft } from './ColumnMapper';
import ConfirmExportModal from './ConfirmExportModal';
import SuggestInput, { type SuggestOption } from '../SuggestInput';
import JoinEditor from './JoinEditor';
import { enrichRows, isJoinPath, joinProblem, splitJoinPath, type JoinDraft } from '@/lib/exportJoin';

export interface ExportDialogProps {
  /** Đích hiển thị: "db.coll" / "index" / "topic"… — cũng là khoá nhóm cấu hình đã lưu. */
  target: string;
  /** Tóm tắt query đang xuất (hiện ở hộp xác nhận). */
  querySummary: string;
  /** Mô tả sắp xếp, vd "created_at ↓". */
  sortSummary?: string;
  /** Gợi ý field code (Tab/Enter để điền). */
  fieldSuggestions: Array<string | SuggestOption>;
  defaultTitle: string;
  /** Đếm số dòng sẽ xuất; null = không đếm được (vẫn cho xuất). */
  countRows: () => Promise<number | null>;
  /**
   * Tải toàn bộ tập kết quả, tối đa `max` dòng. `paths` là các field cấp 1 cột đang dùng (để backend chỉ lấy phần cần).
   * `capped` = còn dữ liệu bị bỏ lại do chạm trần.
   */
  fetchRows: (ctx: { paths: string[]; max: number; onProgress: (loaded: number) => void }) => Promise<{ rows: Record<string, unknown>[]; capped: boolean }>;
  placeholder?: string;
  /** Hiện tuỳ chọn "tách field list thành nhiều dòng" (ES, Mongo bật). */
  allowExplode?: boolean;
  /** Hiện phần "nối cột từ bảng/index khác" (ES, Mongo, PG bật). */
  allowJoin?: boolean;
  /** Khối riêng của từng loại (vd. ô sort của ES) — đặt ngay trên bảng cột. */
  extra?: React.ReactNode;
  /** true = khối `extra` đang không hợp lệ, chặn nút Xuất. */
  blocked?: boolean;
  onClose: () => void;
  onDone: (rows: number, filename: string) => void;
}

const withKeys = (cols: MongoExportConfig['columns']): ColumnDraft[] => cols.map((c, i) => ({ ...c, key: i }));

export default function ExportDialog(props: ExportDialogProps) {
  const { target, querySummary, sortSummary, fieldSuggestions, defaultTitle, countRows, fetchRows, placeholder, allowExplode, allowJoin, extra, blocked, onClose, onDone } = props;

  const [title, setTitle] = useState(defaultTitle);
  const [columns, setColumns] = useState<ColumnDraft[]>(initialColumns);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Tách dòng: bật + field list. Chỉ MỘT field — tách nhiều field cùng lúc là nhân chéo, báo cáo rối.
  const [explodeOn, setExplodeOn] = useState(false);
  const [explodePath, setExplodePath] = useState('');
  const explode = allowExplode && explodeOn ? explodePath.trim() : '';

  // Nối cột: các phép nối + field của bên nối (để gợi ý "~alias.field" ở bảng cột).
  const [joins, setJoins] = useState<JoinDraft[]>([]);
  const [joinFields, setJoinFields] = useState<Record<string, SuggestOption[]>>({});
  const onTargetFields = useCallback((id: string, f: SuggestOption[]) => setJoinFields((m) => (m[id] === f ? m : { ...m, [id]: f })), []);

  // Cấu hình đã lưu: cấu hình của đúng collection này xếp lên trước.
  const [configs, setConfigs] = useState<MongoExportConfig[]>(() =>
    loadExportConfigs().sort((a, b) => Number(b.target === target) - Number(a.target === target)),
  );
  const [cfgName, setCfgName] = useState('');
  const [cfgNote, setCfgNote] = useState<string | null>(null);

  const validColumns = useMemo(() => columns.filter((c) => c.path.trim()), [columns]);
  // Thêm cột "~alias.field" từ khung phép nối: chiếm dòng cột trống đầu tiên nếu có, không thì thêm cuối; không thêm trùng.
  const addJoinColumn = useCallback((path: string) => {
    setColumns((cs) => {
      if (cs.some((c) => c.path.trim() === path)) return cs;
      const header = prettyHeader(path);
      const blank = cs.findIndex((c) => !c.path.trim());
      if (blank >= 0) return cs.map((c, i) => (i === blank ? { ...c, path, header: c.header || header } : c));
      return [...cs, { key: Math.max(0, ...cs.map((c) => c.key)) + 1, header, path, format: 'auto' }];
    });
  }, []);

  // Phép nối được dùng = có cột trỏ vào "~alias…"; phép nối khai mà không cột nào dùng thì bỏ qua (không tốn request).
  const usedJoins = useMemo(() => {
    if (!allowJoin) return [];
    const used = new Set(validColumns.map((c) => splitJoinPath(c.path.trim())?.alias).filter((a): a is string => !!a));
    return joins.filter((j) => used.has(j.alias));
  }, [allowJoin, joins, validColumns]);
  const unknownJoinCols = useMemo(
    () => (allowJoin ? validColumns.filter((c) => { const a = splitJoinPath(c.path.trim())?.alias; return a !== undefined && !joins.some((j) => j.alias === a); }) : []),
    [allowJoin, joins, validColumns],
  );
  const joinError = useMemo(() => {
    for (const j of usedJoins) { const p = joinProblem(j, joins); if (p) return `Nối cột "${j.alias}": ${p}`; }
    if (unknownJoinCols.length) return `Cột "${unknownJoinCols[0].path}" trỏ vào phép nối chưa khai báo`;
    return null;
  }, [usedJoins, unknownJoinCols, joins]);
  // Gợi ý field code: field của dữ liệu đang xuất + "~alias.field" của từng phép nối đã chọn bảng.
  const allSuggestions = useMemo<Array<string | SuggestOption>>(() => [
    ...fieldSuggestions,
    ...(allowJoin ? joins.flatMap((j) => (joinFields[j.id] ?? []).map((f) => ({ value: `~${j.alias}.${f.value}`, hint: f.hint ? `${j.alias} · ${f.hint}` : j.alias }))) : []),
  ], [fieldSuggestions, allowJoin, joins, joinFields]);

  const canExport = !busy && !!title.trim() && hasDataColumn(columns) && !(allowExplode && explodeOn && !explode) && !joinError && !blocked;

  const loadConfig = (c: MongoExportConfig) => {
    setTitle(c.title || defaultTitle);
    setColumns(c.columns.length ? withKeys(c.columns) : initialColumns());
    if (allowExplode) { setExplodeOn(!!c.explode); setExplodePath(c.explode ?? ''); }
    if (allowJoin) setJoins(c.joins ?? []);
    setCfgName(c.name);
    setCfgNote(`Đã nạp cấu hình "${c.name}"`);
  };

  const saveConfig = () => {
    const name = cfgName.trim();
    if (!name || !hasDataColumn(columns)) return;
    setConfigs(saveExportConfig({ name, target, title, columns: toReportColumns(columns), explode: explode || undefined, joins: allowJoin && joins.length ? joins : undefined }));
    setCfgNote(`Đã lưu cấu hình "${name}"`);
  };

  const doExport = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      // __no là số thứ tự dựng ở client, không phải field của dữ liệu.
      // Field list cần tách cũng phải được tải về dù không có cột nào trỏ vào nó.
      // Cột "~alias.…" là cột nối (lấy từ bên kia), không phải field của dữ liệu này — thay bằng field khoá của phép nối.
      const paths = [...new Set([
        ...validColumns.map((c) => c.path).filter((p) => !isJoinPath(p)),
        ...(explode ? [explode] : []),
        ...usedJoins.map((j) => j.sourceField),
      ].map((p) => p.trim().split('.')[0]))].filter((t) => t !== NO_COLUMN_PATH && t);
      const fetched = await fetchRows({
        paths,
        max: MAX_EXPORT_ROWS,
        onProgress: (n) => setProgress(`Đang tải dữ liệu… ${n.toLocaleString('en-US')} dòng`),
      });

      // Nối cột: gom khoá khác nhau của A, hỏi bên kia theo lô, gắn kết quả vào từng dòng (trước khi tách dòng).
      let joinNote = '';
      if (usedJoins.length) {
        const need: Record<string, string[] | null> = {};
        for (const j of usedJoins) {
          const mine = validColumns.map((c) => splitJoinPath(c.path.trim())).filter((s) => s && s.alias === j.alias);
          need[j.alias] = mine.some((s) => s && !s.rest) ? null : [...new Set(mine.map((s) => s!.rest.split('.')[0]))];
        }
        const stats = await enrichRows(fetched.rows, usedJoins, need, { onProgress: setProgress });
        joinNote = stats.map((s) => `nối ${s.alias}: ${s.matched.toLocaleString('en-US')}/${fetched.rows.length.toLocaleString('en-US')} dòng khớp${s.truncated ? ' (có khoá khớp quá nhiều, đã cắt)' : ''}`).join(' · ');
      }

      // Tách dòng sau khi tải xong: trần MAX_EXPORT_ROWS áp cho số dòng RA (sau tách), không phải số bản ghi.
      const records = fetched.rows.length;
      const { rows, capped: explodeCapped, exploded } = explode
        ? explodeRows(fetched.rows, explode, MAX_EXPORT_ROWS)
        : { rows: fetched.rows, capped: false, exploded: 0 };
      const capped = fetched.capped || explodeCapped;
      const notes = [
        explode ? `tách theo ${explode} từ ${records.toLocaleString('en-US')} bản ghi` : '',
        joinNote,
        explode && exploded === 0 ? `⚠ không bản ghi nào có list tại "${explode}" nên chưa tách` : '',
        capped ? `đã cắt tại ${MAX_EXPORT_ROWS.toLocaleString('en-US')} dòng` : '',
      ].filter(Boolean);

      setProgress(`Đang dựng file Excel… ${rows.length.toLocaleString('en-US')} dòng`);
      const blob = await buildReportXlsx(
        {
          title: title.trim(),
          target,
          rowCount: rows.length,
          note: notes.length ? notes.join('   ·   ') : undefined,
        },
        toReportColumns(columns),
        rows,
      );
      const filename = reportFilename(title);
      downloadBlob(blob, filename);
      onDone(rows.length, filename);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <>
      <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}
          style={{ width: 'min(860px, 96vw)', maxHeight: '92vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="status-line">
            <h3 style={{ margin: 0, flex: 1 }}>📄 Xuất báo cáo — {target}</h3>
            <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
          </div>

          <label className="mongo-field">
            <span>Tiêu đề báo cáo (hiện trên đầu sheet + tên file)</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} placeholder="Báo cáo tenant theo domain" />
          </label>

          <div className="mongo-field">
            <span>Cấu hình đã lưu</span>
            <div className="xrow">
              <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                <SuggestInput
                  value={cfgName}
                  onChange={setCfgName}
                  options={configs.map((c) => ({ value: c.name, hint: c.target }))}
                  placeholder="Tên cấu hình (gõ để tìm, Tab/Enter để nạp)"
                  showWhenEmpty
                  disabled={busy}
                  onPick={(name) => {
                    const c = configs.find((x) => x.name === name);
                    if (c) loadConfig(c);
                  }}
                />
              </div>
              <button className="ghost sm" disabled={busy || !cfgName.trim() || !hasDataColumn(columns)} onClick={saveConfig}
                title="Lưu tiêu đề + các cột đang khai với tên này">💾 Lưu</button>
              <button className="ghost sm" disabled={busy || !configs.some((c) => c.name === cfgName)}
                onClick={() => {
                  const c = configs.find((x) => x.name === cfgName);
                  if (c) { setConfigs(removeExportConfig(c.id)); setCfgNote(`Đã xoá cấu hình "${c.name}"`); setCfgName(''); }
                }}>🗑 Xoá</button>
            </div>
            {cfgNote && <span className="xhint">{cfgNote}</span>}
          </div>

          {extra}

          <div className="mongo-field">
            <span>Cột báo cáo (tên cột · field code · định dạng · phân cách · ⋯ đổi giá trị)</span>
            <ColumnMapper
              columns={columns}
              setColumns={setColumns}
              fieldSuggestions={allSuggestions}
              placeholder={placeholder ?? 'field code (vd. user.name)'}
              disabled={busy}
            />
          </div>

          {allowJoin && (
            <JoinEditor joins={joins} setJoins={setJoins} srcSuggestions={fieldSuggestions} onTargetFields={onTargetFields} onAddColumn={addJoinColumn}
              columnPaths={validColumns.map((c) => c.path.trim())} disabled={busy} />
          )}
          {joinError && <span className="xerr">{joinError}</span>}

          {allowExplode && (
            <div className="mongo-field">
              <span>Tách list thành nhiều dòng</span>
              <div className="xrow">
                <label className="xchk" title="Mỗi phần tử của field list thành một dòng riêng, các cột khác lặp lại giá trị của bản ghi">
                  <input type="checkbox" checked={explodeOn} disabled={busy} onChange={(e) => setExplodeOn(e.target.checked)} /> Bật tách dòng
                </label>
                <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                  <SuggestInput className="input mono" value={explodePath} onChange={setExplodePath} options={fieldSuggestions}
                    placeholder="field list cần tách (vd. items hoặc childs.name)" disabled={busy || !explodeOn} showWhenEmpty />
                </div>
              </div>
              {explodeOn && (
                <span className="xhint">
                  Bản ghi có list N phần tử → N dòng; cột trỏ vào <code>{explode || 'field'}</code> (hoặc <code>{explode || 'field'}.con</code> nếu là list object)
                  nhận từng phần tử. Bản ghi không có list / list rỗng vẫn giữ 1 dòng.
                </span>
              )}
            </div>
          )}

          <p className="xhint">
            Xuất <b>toàn bộ</b> kết quả khớp <code>{querySummary || 'toàn bộ'}</code> (không chỉ trang đang xem, trần{' '}
            {MAX_EXPORT_ROWS.toLocaleString('en-US')} dòng). Field trong <b>mảng object</b> khai dạng <code>a.b</code> — các giá trị nối bằng ký tự ở ô phân cách (mặc định <code>, </code>).
          </p>

          {error && <span className="xerr">{error}</span>}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
            {progress && <span className="badge"><span className="spinner" aria-hidden /> {progress}</span>}
            <button className="ghost sm" onClick={onClose} disabled={busy}>Huỷ</button>
            <button className="sm" disabled={!canExport} onClick={() => setConfirming(true)}
              title={canExport ? 'Xem số lượng rồi xác nhận' : 'Cần tiêu đề + ít nhất 1 cột có field code (+ field list nếu bật tách dòng)'}>
              {busy ? <span className="spinner" aria-hidden /> : '⬇'} Xuất .xlsx
            </button>
          </div>
        </div>
      </div>

      {confirming && (
        <ConfirmExportModal
          target={target}
          querySummary={querySummary}
          columnCount={validColumns.length}
          sortSummary={sortSummary}
          count={countRows}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void doExport()}
        />
      )}
    </>
  );
}
