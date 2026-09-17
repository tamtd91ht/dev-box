'use client';

// Bảng cấu hình cột cho mọi modal xuất Excel (Mongo / ES / PG).
//
// Ba tab trước đây chép gần như nguyên xi khối JSX này; thêm một cột cấu hình
// (ô phân cách) phải sửa ba chỗ và rất dễ lệch nhau. Gom về một nơi.
//
// KHÔNG ĐIỀN SẴN CỘT THEO DỮ LIỆU: trước đây mở modal là có sẵn `_id` + 5-8
// field đầu tiên bắt gặp trong kết quả — gần như luôn là cột không ai cần, phải
// xoá từng dòng trước khi khai cột thật. Giờ chỉ dựng sẵn STT (cột hầu như báo
// cáo nào cũng có) + một dòng trống; tên field vẫn gợi ý qua datalist nên gõ
// vài chữ là xong.
//
// Ô PHÂN CÁCH: chỉ có nghĩa khi field code trỏ vào list object — khi đó một ô
// Excel nhận NHIỀU giá trị và phải nối lại bằng một ký tự. Bỏ trống = ", ".
// Không ẩn ô này theo path vì lúc khai báo ta chưa biết field có phải mảng hay
// không (phải đọc dữ liệu mới biết), ẩn/hiện nhấp nháy còn khó hiểu hơn.
//
// NÚT `⋯`: mở bảng đổi giá trị của riêng cột đó (xem ValueMap trong
// lib/mongoReport.ts). Để trong ô mở rộng chứ không bày thẳng ra dòng vì phần
// lớn cột không cần tới, mà dòng cột thì đã chật sẵn.

import { useState } from 'react';
import {
  COLUMN_FORMATS, DEFAULT_SEP, NO_COLUMN_PATH, hasValueMap,
  type ColumnFormat, type ReportColumn, type ValueMap,
} from '@/lib/mongoReport';

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

/**
 * Cột lúc mới mở modal: STT (bỏ được như mọi cột khác) + một dòng trống sẵn để
 * gõ ngay. Không đoán cột theo dữ liệu nữa — xem ghi chú đầu file.
 */
export function initialColumns(): ColumnDraft[] {
  return [
    { key: 0, header: 'STT', path: NO_COLUMN_PATH, format: 'number' },
    { key: 1, header: '', path: '', format: 'auto' },
  ];
}

/**
 * Đã khai ít nhất một cột DỮ LIỆU THẬT chưa?
 *
 * Cột STT không tính: file chỉ có mỗi dãy số 1..n thì chẳng để làm gì, mà từ
 * khi bảng khai cột mở ra chỉ với STT thì bấm nhầm "Xuất" ngay là rất dễ.
 */
export function hasDataColumn(columns: ColumnDraft[]): boolean {
  return columns.some((c) => c.path.trim() && c.path.trim() !== NO_COLUMN_PATH);
}

/** Draft → ReportColumn sạch để đưa vào buildReportXlsx. */
export function toReportColumns(columns: ColumnDraft[]): ReportColumn[] {
  return columns
    .filter((c) => c.path.trim())
    .map(({ header, path, format, sep, map }) => ({
      header: header.trim() || path.trim(),
      path: path.trim(),
      format,
      // sep giữ NGUYÊN chuỗi người dùng gõ, kể cả khoảng trắng (" / " là hợp lệ).
      // Chỉ chuỗi rỗng mới coi là "không khai".
      ...(sep ? { sep } : {}),
      // Luật trống (chưa gõ gì) bị loại ở đây, không mang xuống tầng xuất file.
      ...(hasValueMap(map) && map
        ? { map: { rules: map.rules.filter((r) => r.when.trim() !== '' || r.to !== ''), fallback: map.fallback } }
        : {}),
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
  /** Cột đang mở bảng đổi giá trị — mỗi lúc chỉ một, modal không đủ chỗ cho nhiều. */
  const [openMap, setOpenMap] = useState<number | null>(null);

  const patch = (key: number, p: Partial<ColumnDraft>) =>
    setColumns((cs) => cs.map((c) => (c.key === key ? { ...c, ...p } : c)));

  const addColumn = () =>
    setColumns((cs) => [...cs, { key: Math.max(0, ...cs.map((c) => c.key)) + 1, header: '', path: '', format: 'auto' }]);

  return (
    <>
      {/* Các dòng cột cuộn BÊN TRONG modal — collection nhiều field không được
          đẩy tiêu đề/nút bấm ra khỏi khung nhìn. */}
      <div className="export-colscroll">
        {columns.map((c) => {
          const mapped = hasValueMap(c.map);
          const nRules = c.map?.rules.filter((r) => r.when.trim() !== '' || r.to !== '').length ?? 0;
          return (
            <div key={c.key} className="export-col">
              <div className={`${prefix}-form-row`} style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
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
                <button
                  className={`chip-btn export-mapbtn${mapped ? ' on' : ''}`}
                  disabled={disabled || c.path === NO_COLUMN_PATH}
                  aria-expanded={openMap === c.key}
                  title={mapped
                    ? `Đang có ${nRules} luật đổi giá trị — bấm để sửa`
                    : 'Đổi giá trị trước khi ghi ra Excel (vd. true → Đã xoá)'}
                  onClick={() => setOpenMap((k) => (k === c.key ? null : c.key))}
                >⋯{nRules > 0 ? ` ${nRules}` : ''}</button>
                <button className="chip-btn" title="Bỏ cột" disabled={disabled || columns.length <= 1}
                  onClick={() => {
                    setColumns((cs) => cs.filter((x) => x.key !== c.key));
                    setOpenMap((k) => (k === c.key ? null : k));
                  }}>✕</button>
              </div>
              {openMap === c.key && (
                <ValueMapEditor
                  value={c.map}
                  disabled={disabled}
                  onChange={(map) => patch(c.key, { map })}
                  onClose={() => setOpenMap(null)}
                />
              )}
            </div>
          );
        })}
      </div>
      <datalist id={datalistId}>
        {fieldSuggestions.map((f) => <option key={f} value={f} />)}
      </datalist>
      <div><button className="ghost sm" onClick={addColumn} disabled={disabled}>+ Thêm cột</button></div>
    </>
  );
}

/**
 * Ô mở rộng của một cột: bảng đổi giá trị.
 *
 * Luôn để sẵn MỘT dòng trống ở cuối để gõ luật mới — bắt bấm "+ Thêm luật"
 * trước rồi mới gõ được là thừa một nhịp cho việc người ta làm liên tục.
 */
function ValueMapEditor({ value, disabled, onChange, onClose }: {
  value?: ValueMap;
  disabled?: boolean;
  onChange: (map: ValueMap) => void;
  onClose: () => void;
}) {
  const rules = value?.rules ?? [];
  const shown = [...rules, { when: '', to: '' }];

  const patchRule = (i: number, p: Partial<{ when: string; to: string }>) => {
    const next = shown.map((r, j) => (j === i ? { ...r, ...p } : r));
    // Dòng trống cuối cùng chỉ được giữ lại khi người dùng đã gõ gì vào đó.
    onChange({ rules: next.filter((r) => r.when !== '' || r.to !== ''), fallback: value?.fallback });
  };

  return (
    <div className="export-map">
      <div className="export-map-head">
        <b>Đổi giá trị</b>
        <span>gặp giá trị bên trái thì ô Excel ghi giá trị bên phải</span>
        <button className="chip-btn" onClick={onClose} title="Thu lại">▲</button>
      </div>

      {shown.map((r, i) => (
        <div key={i} className="export-map-rule">
          <input className="input mono" value={r.when} disabled={disabled}
            placeholder="giá trị gốc (vd. true)"
            onChange={(e) => patchRule(i, { when: e.target.value })} />
          <span className="export-map-arrow">→</span>
          <input className="input" value={r.to} disabled={disabled}
            placeholder="ghi ra Excel (vd. Đã xoá)"
            onChange={(e) => patchRule(i, { to: e.target.value })} />
          <button className="chip-btn" title="Bỏ luật"
            disabled={disabled || i >= rules.length}
            onClick={() => onChange({ rules: rules.filter((_, j) => j !== i), fallback: value?.fallback })}
          >✕</button>
        </div>
      ))}

      <div className="export-map-rule">
        <span className="export-map-else">Còn lại</span>
        <span className="export-map-arrow">→</span>
        <input className="input" value={value?.fallback ?? ''} disabled={disabled}
          placeholder="giữ nguyên giá trị gốc"
          title="Bỏ trống thì mọi giá trị không khớp luật nào được giữ nguyên."
          onChange={(e) => onChange({ rules, fallback: e.target.value })} />
        <span style={{ width: 24 }} />
      </div>

      <p className="export-map-hint">
        So khớp bỏ qua hoa/thường và khoảng trắng hai đầu. Ô <b>giá trị gốc</b> để trống = khớp ô rỗng
        (thiếu field); ô <b>ghi ra Excel</b> để trống = ghi ô rỗng. Field là list object thì đổi từng phần tử
        rồi mới nối.
      </p>
    </div>
  );
}
