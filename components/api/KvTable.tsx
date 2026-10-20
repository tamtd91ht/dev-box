'use client';

// Bảng key/value có checkbox bật/tắt từng dòng — dùng cho Params và Biến.
// (Headers và form-data ở ApiWorkspace có thêm cột riêng nên vẫn tự dựng.)

import type { ApiHeader } from '@/lib/api';
import VarInput from './VarInput';

export default function KvTable({
  rows, onChange, keyPlaceholder = 'Key', valuePlaceholder = 'Value', addLabel = '＋ Thêm dòng', nameSuggestions, withVars,
}: {
  rows: ApiHeader[];
  onChange: (rows: ApiHeader[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  /** Có prop này thì hiện thêm cột "Name" (nhãn dev/stg…) — dùng cho bảng Biến. */
  nameSuggestions?: string[];
  /** Ô key/value có gợi ý + đổi nhanh biến {{…}} (VarInput) — bảng Params. */
  withVars?: boolean;
}) {
  const set = (i: number, patch: Partial<ApiHeader>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="api-kv">
      {nameSuggestions && <datalist id="api-kv-names">{nameSuggestions.map((n) => <option key={n} value={n} />)}</datalist>}
      {rows.map((r, i) => (
        <div key={i} className="api-kv-row">
          <input type="checkbox" checked={r.on !== false} onChange={(e) => set(i, { on: e.target.checked })}
            title="Bật/tắt dòng này" />
          {nameSuggestions && (
            <input className="input api-kv-name" placeholder="Name" list="api-kv-names" value={r.name ?? ''}
              title="Nhãn của giá trị (vd dev, stg). Cùng tên biến có thể khai nhiều dòng với name khác nhau; để trống = dùng cho mọi name."
              onChange={(e) => set(i, { name: e.target.value })} />
          )}
          {withVars ? (
            <>
              <VarInput className="input" placeholder={keyPlaceholder} value={r.key} onChange={(v) => set(i, { key: v })} />
              <VarInput className="input" placeholder={valuePlaceholder} value={r.value} onChange={(v) => set(i, { value: v })} />
            </>
          ) : (
            <>
              <input className="input" placeholder={keyPlaceholder} value={r.key} onChange={(e) => set(i, { key: e.target.value })} />
              <input className="input" placeholder={valuePlaceholder} value={r.value} onChange={(e) => set(i, { value: e.target.value })} />
            </>
          )}
          <button className="ghost sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} title="Xoá dòng">✕</button>
        </div>
      ))}
      <button className="ghost sm" style={{ alignSelf: 'flex-start' }}
        onClick={() => onChange([...rows, { key: '', value: '', on: true }])}>{addLabel}</button>
    </div>
  );
}
