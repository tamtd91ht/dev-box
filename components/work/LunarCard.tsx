'use client';

// Ngày ÂM LỊCH trên lịch tháng của tab Công việc: nhãn nhỏ trong ô ngày +
// thẻ chi tiết khi hover (can chi, hoàng đạo/hắc đạo, giờ tốt, tiết khí, lễ)
// + ghi chú / lời nhắc lặp theo âm lịch (lib/lunarReminderCore).
// Thẻ vẽ position:fixed ở gốc — ô ngày có overflow:hidden nên không thể là con.
// Thẻ có nút (thêm/sửa lời nhắc) nên phải rê chuột vào được: rời nhãn thì chờ
// một nhịp mới đóng, chuột vào thẻ kịp thì giữ lại (useLunarHover).

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { canChiYear, lunarInfo, lunarOf, lunarShort, lunarHoliday } from '@/lib/lunar';
import { alertText, repeatText, type LunarReminder } from '@/lib/lunarReminderCore';

export interface LunarHover { date: string; rect: DOMRect }

const CLOSE_DELAY = 220;

/** State thẻ hover + hàm mở/đóng có trễ để chuột kịp đi từ nhãn sang thẻ. */
export function useLunarHover() {
  const [hover, setHover] = useState<LunarHover | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const set = useCallback((h: LunarHover | null) => {
    window.clearTimeout(timer.current);
    if (h) setHover(h);
    else timer.current = window.setTimeout(() => setHover(null), CLOSE_DELAY);
  }, []);
  const keep = useCallback(() => window.clearTimeout(timer.current), []);
  const close = useCallback(() => { window.clearTimeout(timer.current); setHover(null); }, []);
  return { hover, set, keep, close };
}

/** Nhãn âm lịch trong ô ngày — hover gọi onHover để mở thẻ. full = luôn ghi kèm tháng + năm can chi. */
export function LunarTag({ date, onHover, full }: { date: string; onHover: (h: LunarHover | null) => void; full?: boolean }) {
  const l = lunarOf(date);
  const holiday = lunarHoliday(date);
  const cls = ['wk-lunar', l.day === 15 ? 'key' : '', l.day === 1 ? 'm1' : '', holiday ? 'holiday' : ''].filter(Boolean).join(' ');
  return (
    <span
      className={cls}
      // title="" chặn tooltip native của <button> ô ngày chồng lên thẻ.
      title=""
      onMouseEnter={(e) => onHover({ date, rect: e.currentTarget.getBoundingClientRect() })}
      onMouseLeave={() => onHover(null)}
    >
      {holiday && <span className="wk-lunar-dot" />}
      {full ? `${l.day}/${l.month}${l.leap ? ' nhuận' : ''} ${canChiYear(l.year)}` : lunarShort(l)}
    </span>
  );
}

export function LunarCard({ hover, reminders, onKeep, onLeave, onAdd, onEdit }: {
  hover: LunarHover;
  /** Lời nhắc rơi vào ngày đang hover. null = kho chưa sẵn sàng (ẩn phần nhắc). */
  reminders: LunarReminder[] | null;
  onKeep: () => void;
  onLeave: () => void;
  onAdd: (date: string) => void;
  onEdit: (r: LunarReminder) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const info = lunarInfo(hover.date);
  const [y, m, d] = hover.date.split('-');

  // Đo thẻ thật rồi kẹp trong viewport: mặc định dưới nhãn, hết chỗ thì lật lên.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, r = hover.rect, pad = 8;
    const left = Math.max(pad, Math.min(r.left, window.innerWidth - w - pad));
    const top = r.bottom + 6 + h > window.innerHeight - pad ? Math.max(pad, r.top - 6 - h) : r.bottom + 6;
    setPos({ left, top });
  }, [hover, reminders?.length]);

  return (
    <div
      ref={ref}
      className="wk-lunar-card"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0, visibility: 'hidden' }}
      role="dialog"
      aria-label="Thông tin ngày âm lịch"
      onMouseEnter={onKeep}
      onMouseLeave={onLeave}
    >
      <div className="wk-lunar-head">
        <span className="wk-lunar-moon">{info.moon}</span>
        <div>
          <div className="wk-lunar-title">{info.label}</div>
          <div className="wk-lunar-sub">Dương lịch {d}/{m}/{y} · năm con {info.conGiap}</div>
        </div>
      </div>
      {info.holiday && <div className="wk-lunar-hol">🎉 {info.holiday}</div>}
      <dl className="wk-lunar-grid">
        <dt>Ngày</dt><dd>{info.dayCanChi}</dd>
        <dt>Tháng</dt><dd>{info.monthCanChi}</dd>
        <dt>Năm</dt><dd>{info.yearCanChi}</dd>
        <dt>Trực</dt>
        <dd>
          <span className={`wk-lunar-than ${info.than.good ? 'good' : 'bad'}`}>
            {info.than.good ? 'Hoàng đạo' : 'Hắc đạo'}
          </span>{' '}{info.than.name}
        </dd>
        <dt>Tiết khí</dt><dd>{info.tietKhi.name}{info.tietKhi.starts && <b> · bắt đầu hôm nay</b>}</dd>
        <dt>Xung tuổi</dt><dd>{info.xung}</dd>
      </dl>
      <div className="wk-lunar-sec">Giờ hoàng đạo</div>
      <div className="wk-lunar-hours">
        {info.gioHoangDao.map((g) => <span key={g}>{g}</span>)}
      </div>
      {info.warnings.length > 0 && <div className="wk-lunar-warn">⚠ {info.warnings.join(' · ')}</div>}
      {reminders && (
        <>
          <div className="wk-lunar-sec">Ghi chú / lời nhắc</div>
          {reminders.map((r) => (
            <button key={r.id} className="wk-lunar-rem" onClick={() => onEdit(r)} title="Bấm để sửa">
              <span className="wk-lunar-rem-t">{r.alert ? '🔔' : '📝'} {r.title}</span>
              <span className="wk-lunar-rem-s">{repeatText(r)} · {alertText(r.alert)}</span>
            </button>
          ))}
          <button className="sm wk-lunar-add" onClick={() => onAdd(hover.date)}>
            ＋ Thêm ghi chú / nhắc ngày {lunarShort(info.lunar)} AL
          </button>
        </>
      )}
    </div>
  );
}

const REPEAT_OPTS: { v: LunarReminder['repeat']; label: string }[] = [
  { v: 'none', label: 'Không lặp' },
  { v: 'monthly', label: 'Hằng tháng' },
  { v: 'yearly', label: 'Hằng năm' },
];

export interface LunarReminderInput {
  anchorDate: string;
  title: string;
  note: string;
  repeat: LunarReminder['repeat'];
  alert: { daysBefore: number; time: string } | null;
}

/** Form thêm/sửa lời nhắc âm lịch — một màn: nội dung, lặp lại, cấu hình nhắc. */
export function LunarReminderForm({ date, initial, busy, err, onSave, onRemove, onClose }: {
  /** Ngày dương được chọn khi thêm mới; bản sửa giữ nguyên ngày gốc của nó. */
  date: string;
  initial: LunarReminder | null;
  busy: boolean;
  err: string | null;
  onSave: (v: LunarReminderInput) => void;
  onRemove: (r: LunarReminder) => void;
  onClose: () => void;
}) {
  const anchorDate = initial?.anchorDate || date;
  const l = lunarOf(anchorDate);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [repeat, setRepeat] = useState<LunarReminder['repeat']>(initial?.repeat ?? 'none');
  const [alertOn, setAlertOn] = useState(initial ? initial.alert !== null : true);
  const [daysBefore, setDaysBefore] = useState(initial?.alert?.daysBefore ?? 0);
  const [time, setTime] = useState(initial?.alert?.time ?? '08:00');
  const [localErr, setLocalErr] = useState<string | null>(null);

  const save = () => {
    if (!title.trim()) { setLocalErr('Nhập tiêu đề trước đã.'); return; }
    if (alertOn && !/^\d{2}:\d{2}$/.test(time)) { setLocalErr('Chọn giờ nhắc.'); return; }
    setLocalErr(null);
    onSave({ anchorDate, title: title.trim(), note, repeat, alert: alertOn ? { daysBefore, time } : null });
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal wk-form wk-lunar-form" onClick={(e) => e.stopPropagation()}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>
            🌙 {initial ? 'Sửa' : 'Thêm'} ghi chú ngày {l.day}/{l.month}{l.leap ? ' nhuận' : ''} AL
          </h3>
          <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <label className="wk-field"><span>Tiêu đề *</span>
          <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="VD: Giỗ ông nội, mùng 1 thắp hương, đóng tiền nhà…"
            onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
        </label>
        <label className="wk-field"><span>Ghi chú</span>
          <textarea className="input" rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Chi tiết (tùy chọn)" />
        </label>
        <label className="wk-field"><span>Lặp lại</span>
          <select className="input" value={repeat} onChange={(e) => setRepeat(e.target.value as LunarReminder['repeat'])}>
            {REPEAT_OPTS.map((o) => (
              <option key={o.v} value={o.v}>
                {o.label} — {repeatText({ lDay: l.day, lMonth: l.month, lYear: l.year, leap: l.leap, repeat: o.v }).split(' — ')[1]}
              </option>
            ))}
          </select>
        </label>
        <div className="wk-field">
          <span>Thông báo nhắc</span>
          <label className="wk-lunar-check">
            <input type="checkbox" checked={alertOn} onChange={(e) => setAlertOn(e.target.checked)} /> Bật nhắc
          </label>
          {alertOn && (
            <div className="wk-lunar-alert">
              <select className="input" value={daysBefore} onChange={(e) => setDaysBefore(Number(e.target.value))}>
                <option value={0}>Đúng ngày</option>
                {[1, 2, 3, 5, 7, 10, 15, 30].map((n) => <option key={n} value={n}>Trước {n} ngày</option>)}
              </select>
              <span className="small" style={{ color: 'var(--muted)' }}>lúc</span>
              <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          )}
        </div>
        {(localErr || err) && <div className="wk-move-err">{localErr || err}</div>}
        <div className="status-line" style={{ marginTop: 12, gap: 8 }}>
          {initial && (
            <button className="ghost sm wk-lunar-del" disabled={busy}
              onClick={() => { if (window.confirm(`Xoá "${initial.title}"?`)) onRemove(initial); }}>🗑 Xoá</button>
          )}
          <span style={{ flex: 1 }} />
          <button className="ghost sm" onClick={onClose} disabled={busy}>Huỷ</button>
          <button className="sm" onClick={save} disabled={busy}>{busy ? 'Đang lưu…' : '✓ Lưu'}</button>
        </div>
      </div>
    </div>
  );
}
