'use client';

// Sắp xếp chỉnh được ngay lúc chạy Tìm nhanh (mặc định lấy từ nút đã lưu). Đổi ở đây chỉ áp cho lần chạy/xuất hiện tại,
// không ghi đè nút — muốn đổi vĩnh viễn thì sửa nút (✎). Port từ vhs-monitor.

import SuggestInput from '../SuggestInput';

export interface SortRow {
  path: string;
  dir: 'asc' | 'desc';
}

export default function QuickSortEditor<T extends SortRow>({ value, onChange, suggestions, disabled }: {
  value: T[];
  onChange: (v: T[]) => void;
  suggestions: string[];
  disabled?: boolean;
}) {
  const set = (i: number, p: Partial<SortRow>) => onChange(value.map((s, k) => (k === i ? { ...s, ...p } : s)));
  return (
    <div className="mongo-qf-sort" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {value.length === 0 && <span className="xhint">Chưa sắp xếp — giữ thứ tự tự nhiên. Thêm khoá để sắp theo field.</span>}
      {value.map((s, i) => (
        <div className="xrow" key={i}>
          <span className="xhint" style={{ flex: '0 0 76px' }}>{i === 0 ? 'Sắp xếp theo' : 'rồi theo'}</span>
          <div style={{ flex: '1 1 160px', minWidth: 0 }}>
            <SuggestInput className="input mono" value={s.path} options={suggestions} showWhenEmpty disabled={disabled}
              placeholder="field (vd. created_at)" onChange={(v) => set(i, { path: v })} />
          </div>
          <select className="input" style={{ flex: '0 0 120px' }} value={s.dir} disabled={disabled}
            onChange={(e) => set(i, { dir: e.target.value as 'asc' | 'desc' })}>
            <option value="asc">Tăng ↑</option>
            <option value="desc">Giảm ↓</option>
          </select>
          <button className="chip-btn" title="Bỏ khoá sắp xếp" disabled={disabled} onClick={() => onChange(value.filter((_, k) => k !== i))}>✕</button>
        </div>
      ))}
      <div>
        <button className="ghost sm" disabled={disabled} onClick={() => onChange([...value, { path: '', dir: 'desc' } as T])}>+ Thêm sắp xếp</button>
      </div>
    </div>
  );
}
