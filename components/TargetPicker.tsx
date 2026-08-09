'use client';

// Chọn ĐÍCH dữ liệu (index của ES, database/collection của Mongo) từ DANH SÁCH
// THẬT lấy về từ server — dùng chung cho cả lúc cấu hình nút tìm nhanh lẫn lúc
// bấm chạy.
//
// KHÔNG CHO GÕ TAY. Ô tìm ở trên chỉ để LỌC danh sách, gõ xong vẫn phải bấm vào
// một dòng mới thành chọn. Gõ mò một cái tên không tồn tại thì query trả rỗng
// (hoặc lỗi index_not_found) mà không ai biết vì sao — thà không cho gõ.
//
// Nhiều index đặt theo thời gian (…_11_2025, …_12_2025) nên ở chế độ nhiều
// (multi) có thêm "Chọn hết" — lọc `transaction_2025` rồi chọn cả loạt, khỏi
// bấm từng cái.

import { useEffect, useMemo, useRef, useState } from 'react';

export interface TargetPickerProps {
  /** Nhãn ngắn hiện trên nút, vd 'Index' / 'Collection'. */
  label: string;
  /** Danh sách lấy từ server. Rỗng + loading=false ⇒ hiện lời nhắc, không cho chọn. */
  options: string[];
  value: string[];
  onChange: (next: string[]) => void;
  /** Cho chọn nhiều (ES index). Mặc định chỉ một. */
  multi?: boolean;
  loading?: boolean;
  /** Bấm mở lần đầu → nạp danh sách (lazy, khỏi gọi khi chưa cần). */
  onOpen?: () => void;
  /** Nạp lại danh sách — index mới theo tháng có thể vừa được tạo. */
  onReload?: () => void;
  disabled?: boolean;
  /** Câu hiện khi chưa chọn gì. */
  placeholder?: string;
}

export default function TargetPicker({
  label, options, value, onChange, multi = false, loading = false,
  onOpen, onReload, disabled = false, placeholder,
}: TargetPickerProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
  }, [options, filter]);

  const toggle = (name: string) => {
    if (!multi) { onChange([name]); setOpen(false); return; }
    onChange(value.includes(name) ? value.filter((v) => v !== name) : [...value, name]);
  };

  const summary = value.length === 0
    ? (placeholder ?? `— chưa chọn ${label.toLowerCase()} —`)
    : value.length === 1 ? value[0] : `${value.length} ${label.toLowerCase()}`;

  return (
    <div className="tp" ref={boxRef}>
      <button
        className={`tp-btn${value.length ? ' on' : ''}`}
        disabled={disabled}
        title={value.length ? value.join('\n') : `Chọn ${label.toLowerCase()} từ danh sách`}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) { setFilter(''); onOpen?.(); }
        }}
      >
        <span className="tp-btn-label">{label}</span>
        <span className="tp-btn-val">{summary}</span>
        <span className="tp-btn-caret" aria-hidden>▾</span>
      </button>

      {value.length > 1 && (
        <div className="tp-chips">
          {value.map((v) => (
            <span key={v} className="tp-chip" title={v}>
              <span className="tp-chip-name">{v}</span>
              <button className="tp-chip-x" title={`Bỏ ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>✕</button>
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className="tp-pop">
          <div className="tp-pop-head">
            <input
              className="input mono tp-filter"
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`lọc ${label.toLowerCase()}…`}
              // Enter chọn khi lọc còn ĐÚNG MỘT dòng — gõ gần đủ rồi Enter, vẫn
              // là chọn từ danh sách chứ không phải nhận chữ vừa gõ.
              onKeyDown={(e) => { if (e.key === 'Enter' && shown.length === 1) toggle(shown[0]); }}
            />
            {onReload && (
              <button className="chip-btn" title="Nạp lại danh sách" onClick={onReload} disabled={loading}>↻</button>
            )}
          </div>

          {loading && <p className="empty"><span className="spinner" /> Đang lấy danh sách…</p>}
          {!loading && options.length === 0 && (
            <p className="empty">Không lấy được danh sách — kiểm tra lại connection.</p>
          )}
          {!loading && options.length > 0 && shown.length === 0 && (
            <p className="empty">Không có {label.toLowerCase()} nào khớp “{filter}”.</p>
          )}

          <div className="tp-list">
            {shown.map((o) => {
              const on = value.includes(o);
              return (
                <button key={o} className={`tp-item${on ? ' on' : ''}`} onClick={() => toggle(o)} title={o}>
                  <span className="tp-item-box" aria-hidden>{multi ? (on ? '☑' : '☐') : (on ? '◉' : '○')}</span>
                  <span className="tp-item-name">{o}</span>
                </button>
              );
            })}
          </div>

          {multi && shown.length > 0 && (
            <div className="tp-pop-foot">
              <button
                className="ghost sm"
                title={filter.trim() ? `Chọn hết ${shown.length} dòng đang lọc` : 'Chọn hết danh sách'}
                onClick={() => onChange([...new Set([...value, ...shown])])}
              >☑ Chọn hết ({shown.length})</button>
              {value.length > 0 && (
                <button className="ghost sm" onClick={() => onChange([])}>Bỏ chọn hết</button>
              )}
              <span className="small" style={{ marginLeft: 'auto', color: 'var(--faint)' }}>đã chọn {value.length}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
