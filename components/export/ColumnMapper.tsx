'use client';

// Bảng cấu hình cột cho mọi modal xuất Excel (Mongo / ES / PG).
//
// Ba tab trước đây chép gần như nguyên xi khối JSX này; thêm một cột cấu hình
// (ô phân cách) phải sửa ba chỗ và rất dễ lệch nhau. Gom về một nơi.
//
// Ô PHÂN CÁCH: chỉ có nghĩa khi field code trỏ vào list object — khi đó một ô
// Excel nhận NHIỀU giá trị và phải nối lại bằng một ký tự. Bỏ trống = ", ".
// Không ẩn ô này theo path vì lúc khai báo ta chưa biết field có phải mảng hay
// không (phải đọc dữ liệu mới biết), ẩn/hiện nhấp nháy còn khó hiểu hơn.

import { COLUMN_FORMATS, DEFAULT_SEP, NO_COLUMN_PATH, type ColumnFormat, type ReportColumn } from '@/lib/mongoReport';

export interface ColumnDraft extends ReportColumn { key: number }

/** "is_deleted" / "createdAt" → "Is Deleted" / "Created At" — vẫn sửa tay được. */
export function prettyHeader(path: string): string {
  if (path === NO_COLUMN_PATH) return 'STT';
  const last = path.split('.').pop() ?? path;
  return last
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/** Cột mặc định: STT dẫn đầu (bỏ được như mọi cột khác) + các path gợi ý. */
export function initialColumns(initialPaths: string[], max: number, fallback = '_id'): ColumnDraft[] {
  let seq = 0;
  return [
    { key: seq++, header: 'STT', path: NO_COLUMN_PATH, format: 'number' as ColumnFormat },
    ...(initialPaths.length ? initialPaths : [fallback]).slice(0, max).map((p) => ({
      key: seq++,
      header: p === '_id' ? 'ID' : prettyHeader(p),
      path: p,
      format: 'auto' as ColumnFormat,
    })),
  ];
}

/** Draft → ReportColumn sạch để đưa vào buildReportXlsx. */
export function toReportColumns(columns: ColumnDraft[]): ReportColumn[] {
  return columns
    .filter((c) => c.path.trim())
    .map(({ header, path, format, sep }) => ({
      header: header.trim() || path,
      path: path.trim(),
      format,
      // sep giữ NGUYÊN chuỗi người dùng gõ, kể cả khoảng trắng (" / " là hợp lệ).
      // Chỉ chuỗi rỗng mới coi là "không khai".
      ...(sep ? { sep } : {}),
    }));
}

export interface ColumnMapperProps {
  columns: ColumnDraft[];
  setColumns: React.Dispatch<React.SetStateAction<ColumnDraft[]>>;
  /** Gợi ý field code cho datalist. */
  fieldSuggestions: string[];
  /** id datalist — phải là duy nhất trên trang (mongo/es/pg mở cùng lúc được). */
  datalistId: string;
  /** Class prefix của tab để giữ đúng style sẵn có: 'mongo' | 'es' | 'pg'. */
  prefix: string;
  placeholder: string;
  disabled?: boolean;
}

export default function ColumnMapper(props: ColumnMapperProps) {
  const { columns, setColumns, fieldSuggestions, datalistId, prefix, placeholder, disabled } = props;

  const patch = (key: number, p: Partial<ColumnDraft>) =>
    setColumns((cs) => cs.map((c) => (c.key === key ? { ...c, ...p } : c)));

  const addColumn = () =>
    setColumns((cs) => [...cs, { key: Math.max(0, ...cs.map((c) => c.key)) + 1, header: '', path: '', format: 'auto' }]);

  return (
    <>
      {/* Các dòng cột cuộn BÊN TRONG modal — collection nhiều field không được
          đẩy tiêu đề/nút bấm ra khỏi khung nhìn. */}
      <div className="export-colscroll">
        {columns.map((c) => (
          <div key={c.key} className={`${prefix}-form-row`} style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
            <input className="input" style={{ flex: 1 }} value={c.header} placeholder="Tên cột (vd. Ngày tạo)"
              disabled={disabled}
              onChange={(e) => patch(c.key, { header: e.target.value })} />
            <input className="input mono" style={{ flex: 1.2 }} value={c.path} list={datalistId}
              placeholder={placeholder} disabled={disabled}
              onChange={(e) => patch(c.key, { path: e.target.value, header: c.header || prettyHeader(e.target.value) })} />
            <select className="input" style={{ flex: '0 0 150px' }} value={c.format} disabled={disabled}
              onChange={(e) => patch(c.key, { format: e.target.value as ColumnFormat })}>
              {COLUMN_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            <input
              className="input mono export-sep"
              value={c.sep ?? ''}
              placeholder={DEFAULT_SEP}
              disabled={disabled || c.path === NO_COLUMN_PATH}
              title={'Ký tự phân cách khi field là list object.\nVD "deviceInfos.deviceId" có 3 phần tử, gõ "-" → ô Excel ra: id1-id2-id3.\nBỏ trống = ", "'}
              onChange={(e) => patch(c.key, { sep: e.target.value })} />
            <button className="chip-btn" title="Bỏ cột" disabled={disabled || columns.length <= 1}
              onClick={() => setColumns((cs) => cs.filter((x) => x.key !== c.key))}>✕</button>
          </div>
        ))}
      </div>
      <datalist id={datalistId}>
        {fieldSuggestions.map((f) => <option key={f} value={f} />)}
      </datalist>
      <div><button className="ghost sm" onClick={addColumn} disabled={disabled}>+ Thêm cột</button></div>
    </>
  );
}
