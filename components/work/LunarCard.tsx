'use client';

// Ngày ÂM LỊCH trên lịch tháng của tab Công việc: nhãn nhỏ trong ô ngày +
// thẻ chi tiết khi hover (can chi, hoàng đạo/hắc đạo, giờ tốt, tiết khí, lễ).
// Thẻ vẽ position:fixed ở gốc — ô ngày có overflow:hidden nên không thể là con.

import { useLayoutEffect, useRef, useState } from 'react';
import { canChiYear, lunarInfo, lunarOf, lunarShort, lunarHoliday } from '@/lib/lunar';

export interface LunarHover { date: string; rect: DOMRect }

/** Nhãn âm lịch trong ô ngày — hover gọi onHover để mở thẻ. full = luôn ghi kèm tháng + năm can chi. */
export function LunarTag({ date, onHover, full }: { date: string; onHover: (h: LunarHover | null) => void; full?: boolean }) {
  const l = lunarOf(date);
  const holiday = lunarHoliday(date);
  const cls = ['wk-lunar', l.day === 1 || l.day === 15 ? 'key' : '', holiday ? 'holiday' : ''].filter(Boolean).join(' ');
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

export function LunarCard({ hover }: { hover: LunarHover }) {
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
  }, [hover]);

  return (
    <div
      ref={ref}
      className="wk-lunar-card"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0, visibility: 'hidden' }}
      role="tooltip"
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
    </div>
  );
}
