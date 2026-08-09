'use client';

// Tab "Thời gian" trong Tools — đổi epoch ⇄ ngày giờ HAI CHIỀU, giống trang
// epochconverter quen dùng nhưng nằm luôn trong app:
//
//   · TRÁI  epoch (số) → ngày giờ: gõ 1754… vào là ra ngày, đơn vị tự đoán
//           theo số chữ số (10 = giây, 13 = millis, 16 = micro, 19 = nano),
//           đè tay được nếu đoán sai.
//   · PHẢI  ngày giờ → epoch: gõ "2026-08-09 14:30" (hoặc 09/08/2026 14:30)
//           là ra số ở cả 4 đơn vị, copy phát một.
//
// MÚI GIỜ chọn ở thanh trên, dùng chung cho cả hai chiều: UTC (giờ chuẩn),
// giờ máy, hay bất kỳ vùng IANA nào. Bên trái luôn hiện SONG SONG ba mốc
// (múi đã chọn · giờ máy · UTC) để khỏi phải đổi qua đổi lại khi soi log.
// Chuỗi gõ vào mà đã mang sẵn offset (…Z, +07:00) thì là mốc tuyệt đối — ô
// múi giờ bị bỏ qua và có ghi chú báo rõ.
//
// Mọi phép tính nằm ở lib/epoch.ts (hàm thuần, đi qua Intl nên đúng cả DST).

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  UNIT_LABEL, detectUnit, dayOfYear, fmtHuman, fmtIso, fmtPlain, fmtRelative,
  fromMillis, isLeapYear, isValidMs, isoWeek, localZone, offsetLabel,
  parseDateInput, partsInZone, toMillis, zoneAbbr, zoneList, zonedPartsToMillis,
  type EpochUnit,
} from '@/lib/epoch';

const UNITS: EpochUnit[] = ['s', 'ms', 'us', 'ns'];
const ZONE_KEY = 'tools.epochZone';

/** Nút copy nhỏ, tự nháy ✓ 1.2s cho biết đã chép. */
function CopyBtn({ value, title }: { value: string; title?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      className="ghost sm epoch-copy"
      title={title ?? 'Copy'}
      disabled={!value}
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setDone(true); } catch { /* ignore */ }
      }}
    >
      {done ? '✓' : '⧉'}
    </button>
  );
}

/** Một dòng kết quả: nhãn — giá trị (mono, chọn được) — nút copy. */
function Row({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return (
    <div className="epoch-row">
      <span className="epoch-row-k">{k}</span>
      <code className="epoch-row-v" title={hint ?? v}>{v}</code>
      <CopyBtn value={v} title={`Copy ${k}`} />
    </div>
  );
}

/** Khối ngày giờ của MỘT múi giờ (dùng lại cho múi đã chọn / máy / UTC). */
function ZoneBlock({ ms, zone, tag }: { ms: number; zone: string; tag: string }) {
  const abbr = zoneAbbr(ms, zone);
  return (
    <div className="epoch-zoneblock">
      <div className="epoch-zoneblock-head">
        <span className="epoch-tag">{tag}</span>
        <b>{zone}</b>
        <span className="small">{offsetLabel(ms, zone)}{abbr ? ` · ${abbr}` : ''}</span>
      </div>
      <Row k="Ngày giờ" v={fmtPlain(ms, zone)} />
      <Row k="ISO 8601" v={fmtIso(ms, zone)} />
      <Row k="Đọc" v={fmtHuman(ms, zone)} />
    </div>
  );
}

export default function EpochPanel() {
  const local = useMemo(() => localZone(), []);
  const zones = useMemo(() => zoneList(), []);

  /** Múi giờ đang chọn — dùng cho cả hai chiều, nhớ qua localStorage. */
  const [zone, setZone] = useState('UTC');
  const [epochIn, setEpochIn] = useState('');
  const [unitSel, setUnitSel] = useState<'auto' | EpochUnit>('auto');
  const [dateIn, setDateIn] = useState('');
  /** Đồng hồ hiện tại — null tới khi chạy ở client (tránh lệch hydrate). */
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(ZONE_KEY);
    setZone(saved || local);
  }, [local]);
  useEffect(() => {
    try { window.localStorage.setItem(ZONE_KEY, zone); } catch { /* nicety */ }
  }, [zone]);

  // Đồng hồ chạy + điền sẵn mốc hiện tại cho cả hai ô, để mở lên là thấy ngay.
  useEffect(() => {
    const t = Date.now();
    setNow(t);
    setEpochIn((v) => v || String(t));
    setDateIn((v) => v || fmtPlain(t, window.localStorage.getItem(ZONE_KEY) || localZone(), false));
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /** Đặt cả hai ô về một mốc — dùng cho nút "Bây giờ". */
  const setBoth = useCallback((ms: number, z: string) => {
    setEpochIn(String(ms));
    setUnitSel('auto');
    setDateIn(fmtPlain(ms, z, false));
  }, []);

  // ── Chiều 1: epoch → ngày giờ ────────────────────────────────────────────
  const unit = unitSel === 'auto' ? detectUnit(epochIn) : unitSel;
  const epochMs = toMillis(epochIn, unit);
  const epochOk = isValidMs(epochMs);

  // ── Chiều 2: ngày giờ → epoch ────────────────────────────────────────────
  const parsed = useMemo(() => parseDateInput(dateIn), [dateIn]);
  const dateMs = useMemo(() => {
    if (!parsed) return NaN;
    return parsed.absoluteMs ?? zonedPartsToMillis(parsed.parts, zone);
  }, [parsed, zone]);
  const dateOk = isValidMs(dateMs);

  /** Vài thông tin lịch hay phải tra khi soi log. */
  const extra = useMemo(() => {
    if (!epochOk) return null;
    const p = partsInZone(epochMs, zone);
    return {
      doy: dayOfYear(epochMs, zone),
      week: isoWeek(epochMs, zone),
      leap: isLeapYear(p.year),
      year: p.year,
    };
  }, [epochOk, epochMs, zone]);

  return (
    <div className="epoch-wrap">
      {/* Thanh trên: đồng hồ hiện tại + chọn múi giờ dùng chung */}
      <div className="epoch-top">
        <div className="epoch-nowbox">
          <span className="epoch-tag">Bây giờ</span>
          <code className="epoch-now-val">{now == null ? '—' : now}</code>
          <span className="small">ms</span>
          {now != null && (
            <>
              <CopyBtn value={String(now)} title="Copy epoch millis" />
              <span className="epoch-sep" aria-hidden />
              <code className="epoch-now-sec">{fromMillis(now, 's')}</code>
              <span className="small">s</span>
              <CopyBtn value={fromMillis(now, 's')} title="Copy epoch giây" />
              <span className="epoch-sep" aria-hidden />
              <span className="small">{fmtPlain(now, zone, false)}</span>
              <button className="ghost sm" onClick={() => setBoth(Date.now(), zone)}
                title="Điền mốc hiện tại vào cả hai ô">
                ⟳ Dùng mốc này
              </button>
            </>
          )}
        </div>
        <div className="epoch-zonebar">
          <span className="small">Múi giờ</span>
          <button className={`chip-btn${zone === 'UTC' ? ' on' : ''}`} onClick={() => setZone('UTC')}
            title="Giờ chuẩn quốc tế (UTC/GMT, offset +00:00)">
            🌐 UTC
          </button>
          <button className={`chip-btn${zone === local ? ' on' : ''}`} onClick={() => setZone(local)}
            title={`Giờ máy đang dùng — ${local}`}>
            💻 Giờ máy
          </button>
          <select className="input epoch-zonesel" value={zone} onChange={(e) => setZone(e.target.value)}
            title="Chọn múi giờ IANA — áp dụng cho cả hai chiều đổi">
            {zones.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>
      </div>

      <div className="epoch-cols">
        {/* ── TRÁI: epoch → ngày giờ ─────────────────────────────────────── */}
        <section className="epoch-card">
          <div className="tools-pane-head">
            🔢 Epoch → Ngày giờ <span className="tools-pane-hint">tự đoán đơn vị theo số chữ số</span>
          </div>
          <div className="epoch-card-body">
            <div className="epoch-inrow">
              <input
                className="input mono" inputMode="numeric" placeholder="1754712345678"
                value={epochIn} onChange={(e) => setEpochIn(e.target.value)}
                aria-label="Giá trị epoch"
              />
              <select className="input epoch-unitsel" value={unitSel}
                onChange={(e) => setUnitSel(e.target.value as 'auto' | EpochUnit)}
                title="Đơn vị của số vừa gõ">
                <option value="auto">Tự đoán</option>
                {UNITS.map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
              </select>
              <button className="ghost sm" onClick={() => setEpochIn(String(Date.now()))} title="Điền mốc hiện tại">
                Bây giờ
              </button>
            </div>
            {epochIn.trim() !== '' && unitSel === 'auto' && (
              <p className="small epoch-note">
                Hiểu là <b>{UNIT_LABEL[unit]}</b> ({epochIn.replace(/[^0-9]/g, '').length} chữ số) — sai thì chọn tay ở ô bên cạnh.
              </p>
            )}

            {!epochOk ? (
              <p className="small epoch-err">
                {epochIn.trim() === '' ? 'Gõ một số epoch để xem ngày giờ.' : '⚠ Không phải mốc thời gian hợp lệ.'}
              </p>
            ) : (
              <div className="epoch-out">
                {zone !== 'UTC' && zone !== local && <ZoneBlock ms={epochMs} zone={zone} tag="Đã chọn" />}
                <ZoneBlock ms={epochMs} zone={local} tag={zone === local ? 'Đã chọn · giờ máy' : 'Giờ máy'} />
                <ZoneBlock ms={epochMs} zone="UTC" tag={zone === 'UTC' ? 'Đã chọn · giờ chuẩn' : 'Giờ chuẩn'} />
                <div className="epoch-facts">
                  <span className="badge">{fmtRelative(epochMs, now ?? Date.now())}</span>
                  {extra && <span className="badge">Ngày thứ {extra.doy} trong năm</span>}
                  {extra && <span className="badge">Tuần ISO {extra.week}</span>}
                  {extra && <span className="badge">{extra.year} {extra.leap ? 'là năm nhuận' : 'không nhuận'}</span>}
                </div>
                <div className="epoch-inrow">
                  <button className="ghost sm" onClick={() => setDateIn(fmtPlain(epochMs, zone, false))}
                    title="Đưa kết quả này sang ô bên phải để đổi ngược lại">
                    → Đưa sang ô phải
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ── PHẢI: ngày giờ → epoch ─────────────────────────────────────── */}
        <section className="epoch-card">
          <div className="tools-pane-head">
            📅 Ngày giờ → Epoch <span className="tools-pane-hint">đọc theo múi giờ đã chọn</span>
          </div>
          <div className="epoch-card-body">
            <div className="epoch-inrow">
              <input
                className="input mono" placeholder="2026-08-09 14:30:05"
                value={dateIn} onChange={(e) => setDateIn(e.target.value)}
                aria-label="Ngày giờ"
              />
              <button className="ghost sm" onClick={() => setDateIn(fmtPlain(Date.now(), zone, false))} title="Điền mốc hiện tại">
                Bây giờ
              </button>
            </div>
            <p className="small epoch-note">
              Nhận: <code>2026-08-09</code> · <code>2026-08-09 14:30:05</code> ·
              {' '}<code>09/08/2026 14:30</code> · <code>2026-08-09T14:30:05.123Z</code>
            </p>

            {!dateOk ? (
              <p className="small epoch-err">
                {dateIn.trim() === '' ? 'Gõ ngày giờ để xem số epoch.' : '⚠ Chưa đọc được — thử đúng một trong các dạng trên.'}
              </p>
            ) : (
              <div className="epoch-out">
                <p className="small epoch-note">
                  {parsed?.absoluteMs != null ? (
                    <>Chuỗi đã có sẵn offset nên là <b>mốc tuyệt đối</b> — bỏ qua ô múi giờ.</>
                  ) : (
                    <>Hiểu là giờ ở <b>{zone}</b> ({offsetLabel(dateMs, zone)}
                      {zoneAbbr(dateMs, zone) ? ` · ${zoneAbbr(dateMs, zone)}` : ''}).</>
                  )}
                </p>
                <div className="epoch-zoneblock">
                  {UNITS.map((u) => (
                    <Row key={u} k={UNIT_LABEL[u]} v={fromMillis(dateMs, u)} />
                  ))}
                </div>
                <div className="epoch-zoneblock">
                  <Row k="ISO (UTC)" v={fmtIso(dateMs, 'UTC')} />
                  <Row k="Giờ máy" v={fmtPlain(dateMs, local)} hint={local} />
                </div>
                <div className="epoch-facts">
                  <span className="badge">{fmtRelative(dateMs, now ?? Date.now())}</span>
                </div>
                <div className="epoch-inrow">
                  <button className="ghost sm" onClick={() => { setEpochIn(String(dateMs)); setUnitSel('auto'); }}
                    title="Đưa số này sang ô bên trái để đổi ngược lại">
                    ← Đưa sang ô trái
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
