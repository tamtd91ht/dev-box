'use client';

// Bảng key/value có checkbox bật/tắt từng dòng — dùng cho Params và Biến.
// (Headers và form-data ở ApiWorkspace có thêm cột riêng nên vẫn tự dựng.)

import type { ApiHeader } from '@/lib/api';

export default function KvTable({
  rows, onChange, keyPlaceholder = 'Key', valuePlaceholder = 'Value', addLabel = '＋ Thêm dòng',
}: {
  rows: ApiHeader[];
  onChange: (rows: ApiHeader[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
}) {
  const set = (i: number, patch: Partial<ApiHeader>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="api-kv">
      {rows.map((r, i) => (
        <div key={i} className="api-kv-row">
          <input type="checkbox" checked={r.on !== false} onChange={(e) => set(i, { on: e.target.checked })}
            title="Bật/tắt dòng này" />
          <input className="input" placeholder={keyPlaceholder} value={r.key} onChange={(e) => set(i, { key: e.target.value })} />
          <input className="input" placeholder={valuePlaceholder} value={r.value} onChange={(e) => set(i, { value: e.target.value })} />
          <button className="ghost sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} title="Xoá dòng">✕</button>
        </div>
      ))}
      <button className="ghost sm" style={{ alignSelf: 'flex-start' }}
        onClick={() => onChange([...rows, { key: '', value: '', on: true }])}>{addLabel}</button>
    </div>
  );
}
