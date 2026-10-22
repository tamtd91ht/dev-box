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
// NÚT `⋯`: mở tuỳ chọn mở rộng của riêng cột đó — Wrap text (mặc định tắt) và
// bảng đổi giá trị (xem ValueMap trong lib/mongoReport.ts). Để trong ô mở rộng
// chứ không bày thẳng ra dòng vì phần lớn cột không cần tới, mà dòng cột thì đã
// chật sẵn. Nút hiện số luật + dấu ↵ khi đang bật wrap, khỏi phải mở ra xem.

import { useState } from 'react';
import SuggestInput, { type SuggestOption } from '../SuggestInput';
import {
  COLUMN_FORMATS, DEFAULT_SEP, DEFAULT_TIME_PATTERN, NO_COLUMN_PATH, TIME_UNITS, hasValueMap, isValidTimeZone,
  type ColumnFormat, type ReportColumn, type TimeUnit, type ValueMap,
} from '@/lib/mongoReport';

const PATTERN_OPTIONS: SuggestOption[] = [
  { value: 'dd/MM/yyyy', hint: 'ngày' },
  { value: 'dd/MM/yyyy HH:mm:ss', hint: 'ngày giờ' },
  { value: 'HH:mm:ss dd/MM/yyyy', hint: 'giờ ngày' },
  { value: 'yyyy-MM-dd', hint: 'ISO ngày' },
  { value: 'yyyy-MM-dd HH:mm:ss', hint: 'ISO ngày giờ' },
  { value: "yyyy-MM-dd'T'HH:mm:ss.SSS", hint: 'ISO + ms' },
  { value: 'MM/yyyy', hint: 'tháng' },
  { value: 'HH:mm:ss', hint: 'giờ' },
  { value: 'hh:mm a dd/MM/yyyy', hint: '12 giờ' },
];

const TZ_OPTIONS: SuggestOption[] = [
  { value: 'Asia/Ho_Chi_Minh', hint: 'UTC+7' },
  { value: 'UTC', hint: 'UTC' },
  { value: 'Asia/Bangkok', hint: 'UTC+7' },
  { value: 'Asia/Singapore', hint: 'UTC+8' },
  { value: 'Asia/Tokyo', hint: 'UTC+9' },
  { value: 'Europe/London', hint: 'UTC+0/+1' },
  { value: 'America/New_York', hint: 'UTC-5/-4' },
];

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
    .map(({ header, path, format, sep, map, timeUnit, pattern, tz, wrap }) => ({
      header: header.trim() || path.trim(),
      path: path.trim(),
      format,
      // Tuỳ chọn thời gian chỉ mang theo khi cột thật sự chọn "theo pattern".
      ...(format === 'custom'
        ? { timeUnit: timeUnit ?? 'auto', pattern: pattern?.trim() || DEFAULT_TIME_PATTERN, ...(tz?.trim() ? { tz: tz.trim() } : {}) }
        : {}),
      // sep giữ NGUYÊN chuỗi người dùng gõ, kể cả khoảng trắng (" / " là hợp lệ).
      // Chỉ chuỗi rỗng mới coi là "không khai".
      ...(sep ? { sep } : {}),
      // Luật trống (chưa gõ gì) bị loại ở đây, không mang xuống tầng xuất file.
      ...(hasValueMap(map) && map
        ? { map: { rules: map.rules.filter((r) => r.when.trim() !== '' || r.to !== ''), fallback: map.fallback } }
        : {}),
      ...(wrap ? { wrap: true } : {}),
    }));
}

export interface ColumnMapperProps {
  columns: ColumnDraft[];
  setColumns: React.Dispatch<React.SetStateAction<ColumnDraft[]>>;
  /** Gợi ý field code (Tab/Enter để điền). */
  fieldSuggestions: Array<string | SuggestOption>;
  placeholder: string;
  disabled?: boolean;
}

export default function ColumnMapper(props: ColumnMapperProps) {
  const { columns, setColumns, fieldSuggestions, placeholder, disabled } = props;
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
              <div className="xrow">
                <input className="input" style={{ flex: "1 1 140px" }} value={c.header} placeholder="Tên cột (vd. Ngày tạo)"
                  disabled={disabled}
                  onChange={(e) => patch(c.key, { header: e.target.value })} />
                <div style={{ flex: "1.2 1 180px", minWidth: 0 }}>
                  <SuggestInput className="input mono" value={c.path} options={fieldSuggestions} placeholder={placeholder} disabled={disabled} showWhenEmpty
                    // Tên cột tự điền theo field; chỉ coi là "người dùng đã sửa tay" khi khác tên suy ra từ field hiện tại —
                    // nếu không, chữ đầu gõ dở ("c" → "C") sẽ khoá tên cột và chọn gợi ý xong không điền lại được.
                    onChange={(v) => patch(c.key, { path: v, header: !c.header || c.header === prettyHeader(c.path) ? prettyHeader(v) : c.header })} />
                </div>
                <select className="input" style={{ flex: '0 0 130px' }} value={c.format} disabled={disabled}
                  onChange={(e) => {
                    const format = e.target.value as ColumnFormat;
                    // Chọn "theo pattern" lần đầu → điền sẵn pattern + đơn vị tự nhận để dùng được ngay.
                    patch(c.key, format === 'custom' ? { format, pattern: c.pattern || DEFAULT_TIME_PATTERN, timeUnit: c.timeUnit ?? 'auto' } : { format });
                  }}>
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
                  className={`chip-btn export-mapbtn${mapped || c.wrap ? ' on' : ''}`}
                  disabled={disabled || c.path === NO_COLUMN_PATH}
                  aria-expanded={openMap === c.key}
                  title={[
                    'Tuỳ chọn cột: wrap text, đổi giá trị trước khi ghi ra Excel (vd. true → Đã xoá)',
                    c.wrap ? '· đang bật wrap text' : '',
                    mapped ? `· đang có ${nRules} luật đổi giá trị` : '',
                  ].filter(Boolean).join('\n')}
                  onClick={() => setOpenMap((k) => (k === c.key ? null : c.key))}
                >⋯{nRules > 0 ? ` ${nRules}` : ''}{c.wrap ? ' ↵' : ''}</button>
                <button className="chip-btn" title="Bỏ cột" disabled={disabled || columns.length <= 1}
                  onClick={() => {
                    setColumns((cs) => cs.filter((x) => x.key !== c.key));
                    setOpenMap((k) => (k === c.key ? null : k));
                  }}>✕</button>
              </div>
              {c.format === 'custom' && (
                <div className="xrow export-time">
                  <span className="xhint">Timestamp gốc</span>
                  <select className="input" style={{ flex: '0 0 140px' }} value={c.timeUnit ?? 'auto'} disabled={disabled}
                    title={'Tự nhận: đoán theo độ lớn của số (giây / mili giây / micro giây / nano giây). Chọn tay nếu dữ liệu có giá trị bất thường.'}
                    onChange={(e) => patch(c.key, { timeUnit: e.target.value as TimeUnit })}>
                    {TIME_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                  </select>
                  <span className="xhint">→ pattern</span>
                  <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                    <SuggestInput className="input mono" value={c.pattern ?? ''} options={PATTERN_OPTIONS} showWhenEmpty disabled={disabled}
                      placeholder={DEFAULT_TIME_PATTERN} title={"yyyy yy MM M dd d HH H hh h mm m ss s SSS a — chữ cố định đặt trong 'nháy đơn'"}
                      onChange={(v) => patch(c.key, { pattern: v })} />
                  </div>
                  <span className="xhint">múi giờ</span>
                  <div style={{ flex: '0 1 180px', minWidth: 0 }}>
                    <SuggestInput className={`input mono${isValidTimeZone(c.tz ?? '') ? '' : ' bad'}`} value={c.tz ?? ''} options={TZ_OPTIONS} showWhenEmpty disabled={disabled}
                      placeholder="giờ máy" title="Múi giờ IANA, vd. Asia/Ho_Chi_Minh, UTC. Bỏ trống = múi giờ của máy đang xuất."
                      onChange={(v) => patch(c.key, { tz: v })} />
                  </div>
                </div>
              )}
              {openMap === c.key && (
                <ValueMapEditor
                  value={c.map}
                  disabled={disabled}
                  onChange={(map) => patch(c.key, { map })}
                  onClose={() => setOpenMap(null)}
                  wrap={!!c.wrap}
                  onWrap={(wrap) => patch(c.key, { wrap })}
                />
              )}
            </div>
          );
        })}
      </div>
      <div><button className="ghost sm" onClick={addColumn} disabled={disabled}>+ Thêm cột</button></div>
    </>
  );
}

/**
 * Ô mở rộng của một cột: Wrap text + bảng đổi giá trị.
 *
 * Luôn để sẵn MỘT dòng trống ở cuối để gõ luật mới — bắt bấm "+ Thêm luật"
 * trước rồi mới gõ được là thừa một nhịp cho việc người ta làm liên tục.
 */
function ValueMapEditor({ value, disabled, onChange, onClose, wrap, onWrap }: {
  value?: ValueMap;
  disabled?: boolean;
  onChange: (map: ValueMap) => void;
  onClose: () => void;
  wrap: boolean;
  onWrap: (wrap: boolean) => void;
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
        <b>Wrap text</b>
        <select className="input" style={{ flex: '0 0 auto', width: 'auto' }} value={wrap ? 'on' : 'off'} disabled={disabled}
          onChange={(e) => onWrap(e.target.value === 'on')}>
          <option value="off">Tắt</option>
          <option value="on">Bật</option>
        </select>
        <span>bật thì nội dung dài xuống dòng trong ô (độ rộng cột vẫn tối đa ~50 ký tự)</span>
        <button className="chip-btn" onClick={onClose} title="Thu lại">▲</button>
      </div>

      <div className="export-map-head">
        <b>Đổi giá trị</b>
        <span>gặp giá trị bên trái thì ô Excel ghi giá trị bên phải</span>
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
