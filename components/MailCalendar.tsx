'use client';

// Mục LỊCH của tab Mail — lịch tháng đọc/ghi qua CalDAV trên chính mail server
// đã khai ở tab Mail (Zimbra là ca dùng chính). Dùng lại hòm thư đang chọn nên
// không phải đăng nhập lần nữa.
//
// Scope: xem theo THÁNG (rail chọn lịch bên trái, lưới 6 tuần bên phải), bấm
// ngày để xem sự kiện, tạo/sửa/xóa qua một modal. CHỦ ĐÍCH không làm view
// tuần/ngày, kéo-thả, hay tách một buổi khỏi chuỗi lặp — mở webmail cho việc đó.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MailAccountPub } from '@/lib/mail';
import {
  cCalendars, cEvents, cCreate, cUpdate, cDelete, cSetUrl,
  monthGrid, gridRange, monthLabel, WEEKDAYS, isSameDay, coversDay, hhmm,
  localInput, rangeLabel,
  type CalCollection, type CalEvent, type EventInput,
} from '@/lib/cal';
import { useSplit } from '@/lib/useSplit';
import Splitter from './Splitter';

/** Màu của lịch, fallback theo màu nhấn của app. */
const calColor = (c?: CalCollection) => c?.color || 'var(--acc, #4a9eff)';

// ── Modal tạo/sửa ──────────────────────────────────────────────────────────

function EventModal({ account, calendar, event, day, onClose, onSaved }: {
  account: MailAccountPub;
  calendar: CalCollection;
  /** null = tạo mới. */
  event: CalEvent | null;
  /** Ngày đang chọn — mốc mặc định khi tạo mới. */
  day: Date;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!event;
  const [summary, setSummary] = useState(event?.summary ?? '');
  const [location, setLocation] = useState(event?.location ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [attendees, setAttendees] = useState((event?.attendees ?? []).join(', '));
  const [start, setStart] = useState(() => {
    if (event) return localInput(new Date(event.start));
    // Mặc định: 9:00 của ngày đang chọn, dài 1 tiếng.
    return localInput(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0));
  });
  const [end, setEnd] = useState(() => {
    if (event) {
      // Sự kiện cả ngày lưu DTEND nửa mở → lùi lại 1 ngày để người dùng thấy
      // đúng ngày cuối như trên webmail.
      const e = new Date(event.end);
      return localInput(event.allDay ? new Date(e.getTime() - 86_400_000) : e);
    }
    return localInput(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10, 0));
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const input: EventInput = {
        summary: summary.trim(),
        location: location.trim() || undefined,
        description: description.trim() || undefined,
        // Cả ngày: bỏ phần giờ đi, server dựng DTSTART;VALUE=DATE.
        start: allDay ? `${start.slice(0, 10)}T00:00` : start,
        end: allDay ? `${end.slice(0, 10)}T00:00` : end,
        allDay,
        attendees: attendees.split(',').map((s) => s.trim()).filter(Boolean),
      };
      if (editing) await cUpdate(account.id, calendar.url, event.url, input);
      else await cCreate(account.id, calendar.url, input);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!event) return;
    const extra = event.rrule ? '\n\nĐây là sự kiện LẶP — xóa sẽ xóa CẢ CHUỖI.' : '';
    if (!window.confirm(`Xóa "${event.summary}"?${extra}`)) return;
    setBusy(true); setErr(null);
    try {
      await cDelete(account.id, event.url);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="mail-compose panel" style={{ width: 'min(560px, 94vw)' }}>
        <div className="mail-compose-head">
          <b>{editing ? '✎ Sửa sự kiện' : '＋ Sự kiện mới'}</b>
          <span className="small" style={{ color: 'var(--muted)' }}>{calendar.name}</span>
          <span style={{ flex: 1 }} />
          <button className="ghost sm" onClick={onClose} disabled={busy} title="Đóng">✕</button>
        </div>

        <input className="input" autoFocus placeholder="Tiêu đề" value={summary}
          onChange={(e) => setSummary(e.target.value)} />

        <label className="small cal-check" style={{ color: 'var(--muted)' }}>
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          Cả ngày
        </label>

        <div className="cal-time-pair">
          <label className="small" style={{ color: 'var(--muted)' }}>
            Bắt đầu
            <input className="input" type={allDay ? 'date' : 'datetime-local'}
              value={allDay ? start.slice(0, 10) : start}
              onChange={(e) => setStart(allDay ? `${e.target.value}T00:00` : e.target.value)} />
          </label>
          <label className="small" style={{ color: 'var(--muted)' }}>
            Kết thúc
            <input className="input" type={allDay ? 'date' : 'datetime-local'}
              value={allDay ? end.slice(0, 10) : end}
              onChange={(e) => setEnd(allDay ? `${e.target.value}T00:00` : e.target.value)} />
          </label>
        </div>

        <input className="input" placeholder="Địa điểm / phòng họp" value={location}
          onChange={(e) => setLocation(e.target.value)} />
        <input className="input" placeholder="Người dự (email, cách nhau dấu phẩy)" value={attendees}
          onChange={(e) => setAttendees(e.target.value)}
          title="Server sẽ gửi thư mời nếu lịch của bạn bật tính năng đó." />
        <textarea className="mc-body" style={{ minHeight: 90 }} placeholder="Ghi chú…"
          value={description} onChange={(e) => setDescription(e.target.value)} />

        {event?.rrule && (
          <p className="small" style={{ color: 'var(--muted)', margin: '4px 0 0' }}>
            🔁 Sự kiện lặp — lưu/xóa ở đây áp dụng cho CẢ CHUỖI.
          </p>
        )}
        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button onClick={() => void submit()} disabled={busy || !summary.trim()}>
            {busy ? <span className="spinner" aria-hidden /> : '💾'} Lưu
          </button>
          {editing && (
            <button className="ghost mail-del-btn" onClick={() => void remove()} disabled={busy}>🗑 Xóa</button>
          )}
          <span style={{ flex: 1 }} />
          <button className="ghost" onClick={onClose} disabled={busy}>Hủy</button>
        </div>
      </div>
    </div>
  );
}

// ── Modal khai địa chỉ CalDAV ──────────────────────────────────────────────

/** Mở khi đoán host từ IMAP không trúng (webmail nằm ở địa chỉ khác). */
function CalUrlModal({ account, current, onClose, onSaved }: {
  account: MailAccountPub;
  current: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setErr(null);
    try { await cSetUrl(account.id, url); onSaved(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="mail-compose panel" style={{ width: 'min(520px, 94vw)' }}>
        <div className="mail-compose-head">
          <b>⚙ Địa chỉ lịch (CalDAV)</b>
          <span style={{ flex: 1 }} />
          <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
        </div>
        <p className="small" style={{ color: 'var(--muted)', margin: '0 0 6px' }}>
          Mặc định DevBox đoán từ host IMAP của hòm thư — với Zimbra thì thường trúng.
          Nếu webmail nằm ở địa chỉ khác, điền gốc của nó vào đây (chỉ phần
          <code> https://ten-may-chu</code>, không kèm /dav/…).
        </p>
        <input className="input" autoFocus placeholder="https://mail.congty.com" value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button onClick={() => void save()} disabled={busy}>
            {busy ? <span className="spinner" aria-hidden /> : '💾'} Lưu
          </button>
          <button className="ghost" onClick={() => { setUrl(''); void cSetUrl(account.id, '').then(onSaved).catch(() => {}); }}
            disabled={busy} title="Quay về đoán tự động từ host IMAP">↺ Mặc định</button>
          <span style={{ flex: 1 }} />
          <button className="ghost" onClick={onClose} disabled={busy}>Hủy</button>
        </div>
      </div>
    </div>
  );
}

// ── Lịch tháng ─────────────────────────────────────────────────────────────

export default function MailCalendar({ account }: { account: MailAccountPub }) {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const railSplit = useSplit({ varName: '--gp-rail', min: 170, max: 520, gap: 12 });
  const [calendars, setCalendars] = useState<CalCollection[] | null>(null);
  const [root, setRoot] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(() => new Set()); // lịch đang tắt
  const [anchor, setAnchor] = useState(() => new Date());
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [selected, setSelected] = useState<Date>(() => new Date());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ event: CalEvent | null; calendar: CalCollection } | null>(null);
  const [urlModal, setUrlModal] = useState(false);

  const loadCalendars = useCallback(async () => {
    setErr(null);
    try {
      const r = await cCalendars(account.id);
      setCalendars(r.calendars);
      setRoot(r.root);
      if (r.calendars.length === 0) setErr(`Không thấy lịch nào ở ${r.root} — kiểm tra lại địa chỉ CalDAV (nút ⚙).`);
    } catch (e) {
      setCalendars([]);
      setErr((e as Error).message);
    }
  }, [account.id]);

  useEffect(() => { void loadCalendars(); }, [loadCalendars]);

  // Các lịch ĐANG hiện — chuỗi url ổn định để useEffect dưới không chạy lại vô ích.
  const visible = useMemo(
    () => (calendars ?? []).filter((c) => !hidden.has(c.url)),
    [calendars, hidden],
  );
  const visibleKey = visible.map((c) => c.url).join('|');

  // Đổi tháng hoặc đổi tập lịch đang hiện → tải lại sự kiện của cả lưới.
  useEffect(() => {
    if (!calendars || visible.length === 0) { setEvents([]); return; }
    let stopped = false;
    const { from, to } = gridRange(anchor);
    setLoading(true); setErr(null);
    Promise.all(visible.map((c) => cEvents(account.id, c.url, from, to).catch((e) => {
      // Một lịch hỏng (bị thu hồi quyền chẳng hạn) không được làm hỏng cả tháng.
      if (!stopped) setErr(`${c.name}: ${(e as Error).message}`);
      return [] as CalEvent[];
    })))
      .then((lists) => { if (!stopped) setEvents(lists.flat()); })
      .finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
    // visibleKey thay cho `visible` (mảng mới mỗi render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, anchor, visibleKey, calendars]);

  const reload = () => setAnchor(new Date(anchor.getTime())); // đổi tham chiếu → effect chạy lại

  const grid = useMemo(() => monthGrid(anchor), [anchor]);
  const today = new Date();
  const calByUrl = useMemo(
    () => Object.fromEntries((calendars ?? []).map((c) => [c.url, c])),
    [calendars],
  );

  const dayEvents = useCallback(
    (d: Date) => events.filter((e) => coversDay(e, d)).sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1; // cả ngày lên đầu
      return a.start.localeCompare(b.start);
    }),
    [events],
  );

  const selectedEvents = dayEvents(selected);
  // Lịch để TẠO sự kiện mới: lịch ghi được đầu tiên đang hiện.
  const writeCal = visible.find((c) => c.writable) ?? (calendars ?? []).find((c) => c.writable);

  const shift = (months: number) =>
    setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + months, 1));

  if (calendars === null) {
    return <div className="panel" style={{ margin: 'auto' }}><span className="spinner" /> Đang tải lịch…</div>;
  }

  return (
    <div className="g-projects" ref={railSplit.ref} style={railSplit.style}>
      <aside className="g-rail">
        <div className="group-title" style={{ margin: '0 4px 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1 }}>Lịch</span>
          <button className="ghost sm" onClick={() => setUrlModal(true)} title={`Địa chỉ CalDAV: ${root}`}>⚙</button>
          <button className="ghost sm" onClick={() => void loadCalendars()} title="Tải lại danh sách lịch">↻</button>
        </div>
        {calendars.map((c) => {
          const off = hidden.has(c.url);
          return (
            <div key={c.url} className={`g-root${off ? '' : ' on'}`}>
              <button className="g-root-btn" title={`${c.name}${c.writable ? '' : ' (chỉ đọc)'}`}
                onClick={() => setHidden((cur) => {
                  const next = new Set(cur);
                  if (next.has(c.url)) next.delete(c.url); else next.add(c.url);
                  return next;
                })}>
                <span className="cal-swatch" aria-hidden
                  style={{ background: off ? 'transparent' : calColor(c), borderColor: calColor(c) }} />
                <span className="g-root-name" style={{ opacity: off ? 0.55 : 1 }}>{c.name}</span>
                {!c.writable && <span className="small" style={{ color: 'var(--faint)' }}>👁</span>}
              </button>
            </div>
          );
        })}
        {calendars.length === 0 && (
          <p className="small" style={{ color: 'var(--muted)', margin: '4px 6px' }}>Chưa thấy lịch nào.</p>
        )}
      </aside>

      <div className="g-main">
        <div className="g-crumbs">
          <button className="ghost sm" onClick={() => shift(-1)} title="Tháng trước">←</button>
          <b style={{ minWidth: 140, textAlign: 'center' }}>{monthLabel(anchor)}</b>
          <button className="ghost sm" onClick={() => shift(1)} title="Tháng sau">→</button>
          <button className="ghost sm" onClick={() => { const n = new Date(); setAnchor(n); setSelected(n); }}
            title="Về tháng hiện tại">Hôm nay</button>
          {loading && <span className="spinner" aria-hidden />}
          <span style={{ flex: 1 }} />
          {writeCal && (
            <button onClick={() => setEditing({ event: null, calendar: writeCal })}
              title={`Tạo sự kiện trong "${writeCal.name}"`}>＋ Sự kiện</button>
          )}
          <button className="ghost sm" onClick={reload} disabled={loading} title="Tải lại sự kiện">↻</button>
        </div>

        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}

        <div className="cal-grid">
          {WEEKDAYS.map((w) => <div key={w} className="cal-wd">{w}</div>)}
          {grid.map((d) => {
            const evs = dayEvents(d);
            const outside = d.getMonth() !== anchor.getMonth();
            return (
              <div key={d.toISOString()} role="button" tabIndex={0}
                className={`cal-cell${outside ? ' out' : ''}${isSameDay(d, selected) ? ' sel' : ''}${isSameDay(d, today) ? ' today' : ''}`}
                onClick={() => setSelected(d)}
                onDoubleClick={() => writeCal && setEditing({ event: null, calendar: writeCal })}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(d); } }}
                title={evs.length ? `${evs.length} sự kiện` : 'Bấm đúp để tạo sự kiện'}>
                <span className="cal-daynum">{d.getDate()}</span>
                <div className="cal-chips">
                  {evs.slice(0, 3).map((ev) => (
                    <button key={ev.url} className="cal-chip" title={ev.summary}
                      style={{ borderLeftColor: calColor(calByUrl[ev.calendarUrl]) }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected(d);
                        const cal = calByUrl[ev.calendarUrl];
                        if (cal?.writable) setEditing({ event: ev, calendar: cal });
                      }}>
                      {!ev.allDay && <span className="cal-chip-time">{hhmm(ev.start)}</span>}
                      <span className="cal-chip-name">{ev.summary}</span>
                    </button>
                  ))}
                  {evs.length > 3 && <span className="cal-more">+{evs.length - 3} nữa</span>}
                </div>
              </div>
            );
          })}
        </div>

        {/* Chi tiết ngày đang chọn — chỗ đọc kỹ và sửa/xóa. */}
        <div className="cal-day-panel">
          <div className="group-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1 }}>
              {selected.toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })}
            </span>
            {writeCal && (
              <button className="ghost sm" onClick={() => setEditing({ event: null, calendar: writeCal })}>＋ Thêm</button>
            )}
          </div>
          {selectedEvents.length === 0 && (
            <p className="small" style={{ color: 'var(--muted)', margin: '4px 2px' }}>Không có sự kiện nào.</p>
          )}
          {selectedEvents.map((ev) => {
            const cal = calByUrl[ev.calendarUrl];
            return (
              <div key={ev.url} className="cal-item" style={{ borderLeftColor: calColor(cal) }}>
                <div className="cal-item-main">
                  <b>{ev.summary}</b>
                  <span className="small" style={{ color: 'var(--muted)' }}>{rangeLabel(ev)}</span>
                  {ev.location && <span className="small" style={{ color: 'var(--muted)' }}>📍 {ev.location}</span>}
                  {ev.attendees.length > 0 && (
                    <span className="small" style={{ color: 'var(--muted)' }}>👥 {ev.attendees.join(', ')}</span>
                  )}
                  {ev.description && <span className="small cal-item-desc">{ev.description}</span>}
                  <span className="small" style={{ color: 'var(--faint)' }}>
                    {cal?.name ?? 'Lịch'}{ev.rrule ? ' · 🔁 lặp lại' : ''}
                  </span>
                </div>
                {cal?.writable && (
                  <button className="ghost sm" onClick={() => setEditing({ event: ev, calendar: cal })}
                    title="Sửa / xóa">✎</button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {editing && (
        <EventModal
          account={account}
          calendar={editing.calendar}
          event={editing.event}
          day={selected}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
      {urlModal && (
        <CalUrlModal
          account={account}
          current={root}
          onClose={() => setUrlModal(false)}
          onSaved={() => { setUrlModal(false); void loadCalendars(); }}
        />
      )}
      <Splitter {...railSplit.grip} />
    </div>
  );
}
