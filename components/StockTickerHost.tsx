'use client';

// Bảng giá cổ phiếu VN thu nhỏ — widget nổi ở một góc app, sống NGOÀI mọi pane
// (mount cạnh AutomationHost trong page.tsx) nên đổi tab vẫn thấy giá.
//
// Tham chiếu UX từ bảng giá SSI iBoard / VNDirect / VPS: mỗi mã một pill
// "MÃ giá ±%", màu theo QUY ƯỚC BẢNG GIÁ VN (tím trần · xanh tăng · vàng tham
// chiếu · đỏ giảm · lơ sàn) và NHÁY nền khi giá đổi tick — dân trade đọc màu
// trước khi đọc số. Click pill mở card chi tiết (TC/trần/sàn/cao thấp/KL +
// ngưỡng); ⚙ mở modal cấu hình; ▁ thu widget thành bong bóng 📈.
//
// MẶC ĐỊNH TẮT: enabled=false trong configs/stocks.json. Lối vào duy nhất khi
// đang tắt là nút 📈 trên header (StockHeaderButton) — nó chỉ bắn một event,
// host này nghe và mở modal, nên header không phải biết gì về widget.
//
// Ngưỡng cảnh báo trên/dưới: pill dính ngưỡng đổ viền ⚠ nhấp nháy + một notice
// vào hòm thông báo (một lần mỗi lần CHẠM — về lại trong band thì nạp lại đạn,
// không spam mỗi tick).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { notices } from '@/lib/noticeStore';
import {
  DEFAULT_STOCKS_CONFIG,
  effectiveEnabled,
  fetchStockQuotes,
  fetchStocksConfig,
  marketOpen,
  quoteTone,
  saveStocksConfig,
  thresholdHit,
  type StockCorner,
  type StockQuote,
  type StockSymbolCfg,
  type StocksConfig,
} from '@/lib/stocks';

const OPEN_EVENT = 'devbox:stocks-settings';
/** localStorage: trạng thái thu gọn — UI riêng từng máy, không thuộc config. */
const COLLAPSED_KEY = 'stocks.collapsed';
/** Ngoài giờ giao dịch giá không đổi — poll thưa lại còn 5 phút/lần. */
const OFF_HOURS_MIN_MS = 5 * 60_000;
/** Pill nháy bao lâu khi giá đổi tick. */
const FLASH_MS = 900;

/** Nút 📈 trên header — mở cấu hình kể cả khi widget đang tắt. */
export function StockHeaderButton() {
  return (
    <button
      className="qt-open-btn"
      title="Giá cổ phiếu — bật/tắt & cấu hình mã theo dõi"
      aria-label="Giá cổ phiếu"
      onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}
    >
      📈
    </button>
  );
}

const fmtPrice = (n: number) => (n > 0 ? n.toFixed(2) : '—');
const fmtPct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
const fmtVol = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString('vi-VN', { hour12: false });

export default function StockTickerHost() {
  const [cfg, setCfg] = useState<StocksConfig | null>(null);
  const [quotes, setQuotes] = useState<Record<string, StockQuote>>({});
  const [missing, setMissing] = useState<string[]>([]);
  /** Nháy tick: mã → hướng ('u' tăng / 'd' giảm so với lần trước). */
  const [flash, setFlash] = useState<Record<string, 'u' | 'd'>>({});
  const [lastAt, setLastAt] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [detailSym, setDetailSym] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Bump sau khi Lưu để vòng poll chạy lại NGAY thay vì đợi hết chu kỳ. */
  const [refreshTick, setRefreshTick] = useState(0);

  const prevPrices = useRef<Record<string, number>>({});
  const lastOkAt = useRef(0);
  /** Ngưỡng đã báo theo mã — chống spam notice mỗi tick khi giá lì ở ngưỡng. */
  const alerted = useRef<Record<string, 'above' | 'below' | null>>({});

  // Config + trạng thái thu gọn: nạp một lần khi mount.
  useEffect(() => {
    fetchStocksConfig().then(setCfg).catch(() => setCfg({ ...DEFAULT_STOCKS_CONFIG }));
    try { setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === '1'); } catch { /* private mode */ }
  }, []);

  // Nút 📈 header bắn event này — mở modal dù widget đang tắt.
  useEffect(() => {
    const open = () => setSettingsOpen(true);
    window.addEventListener(OPEN_EVENT, open);
    return () => window.removeEventListener(OPEN_EVENT, open);
  }, []);

  const symbolCfg = useCallback(
    (sym: string): StockSymbolCfg | undefined => cfg?.symbols.find((s) => s.symbol === sym),
    [cfg],
  );

  // ── Vòng poll giá ──────────────────────────────────────────────────────────
  const symsKey = cfg?.symbols.map((s) => s.symbol).join(',') ?? '';
  useEffect(() => {
    if (!cfg || !effectiveEnabled(cfg) || !symsKey) return;
    let dead = false;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (force = false) => {
      // Ngoài giờ khớp lệnh giá đứng im — có dữ liệu rồi thì giãn còn 5 phút/lần.
      if (!force && !marketOpen() && lastOkAt.current && Date.now() - lastOkAt.current < OFF_HOURS_MIN_MS) return;
      try {
        const r = await fetchStockQuotes();
        if (dead) return;
        const next: Record<string, StockQuote> = {};
        const fl: Record<string, 'u' | 'd'> = {};
        for (const q of r.quotes) {
          next[q.symbol] = q;
          const prev = prevPrices.current[q.symbol];
          if (prev !== undefined && Math.abs(q.last - prev) > 1e-6) fl[q.symbol] = q.last > prev ? 'u' : 'd';
          prevPrices.current[q.symbol] = q.last;

          // Ngưỡng cảnh báo: báo MỘT lần mỗi lần chạm, về trong band thì nạp lại.
          const sc = cfg.symbols.find((s) => s.symbol === q.symbol);
          const hit = sc ? thresholdHit(sc, q) : null;
          if (hit && alerted.current[q.symbol] !== hit) {
            const bound = hit === 'above' ? `≥ ${sc?.above}` : `≤ ${sc?.below}`;
            notices.add({
              tab: 'stocks',
              level: 'warn',
              title: `📈 ${q.symbol} chạm ngưỡng ${hit === 'above' ? 'TRÊN' : 'DƯỚI'}`,
              body: `Giá ${fmtPrice(q.last)} ${bound}${sc?.note ? ` — ${sc.note}` : ''}`,
              source: 'giá cổ phiếu',
            });
          }
          alerted.current[q.symbol] = hit;
        }
        setQuotes(next);
        setMissing(r.missing);
        setLastAt(r.at);
        setErr(null);
        lastOkAt.current = Date.now();
        if (Object.keys(fl).length) {
          setFlash(fl);
          if (flashTimer) clearTimeout(flashTimer);
          flashTimer = setTimeout(() => { if (!dead) setFlash({}); }, FLASH_MS);
        }
      } catch (e) {
        if (!dead) setErr((e as Error).message);
      }
    };

    void tick(true);
    const timer = setInterval(() => void tick(), Math.max(5, cfg.intervalSec) * 1000);
    return () => { dead = true; clearInterval(timer); if (flashTimer) clearTimeout(flashTimer); };
  }, [cfg, symsKey, refreshTick]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      try { window.localStorage.setItem(COLLAPSED_KEY, v ? '0' : '1'); } catch { /* private mode */ }
      return !v;
    });
  }, []);

  const onSaved = useCallback((next: StocksConfig) => {
    setCfg(next);
    setSettingsOpen(false);
    setDetailSym(null);
    setMissing([]);
    // Mã bị bỏ khỏi config thì giá cũ + trạng thái ngưỡng của nó không còn nghĩa.
    const keep = new Set(next.symbols.map((s) => s.symbol));
    setQuotes((qs) => Object.fromEntries(Object.entries(qs).filter(([k]) => keep.has(k))));
    prevPrices.current = Object.fromEntries(Object.entries(prevPrices.current).filter(([k]) => keep.has(k)));
    alerted.current = Object.fromEntries(Object.entries(alerted.current).filter(([k]) => keep.has(k)));
    lastOkAt.current = 0; // ép tick đầu chạy thật kể cả ngoài giờ
    setRefreshTick((t) => t + 1);
  }, []);

  const open = marketOpen();
  const detail = detailSym ? quotes[detailSym] : undefined;
  const detailCfg = detailSym ? symbolCfg(detailSym) : undefined;
  const corner: StockCorner = cfg?.position ?? 'bl';

  return (
    <>
      {cfg && effectiveEnabled(cfg) && (
        collapsed ? (
          <button
            className={`stk-bubble stk-${corner}`}
            title="Giá cổ phiếu — bấm để mở lại"
            onClick={toggleCollapsed}
          >📈</button>
        ) : (
          <div className={`stk-strip stk-${corner}`} role="status" aria-label="Giá cổ phiếu">
            <span
              className={`stk-dot${err ? ' err' : ''}`}
              title={err
                ? `Lỗi lấy giá: ${err}`
                : `${lastAt ? `Cập nhật ${fmtClock(lastAt)}` : 'Đang lấy giá…'}${open ? '' : ' · NGOÀI GIỜ GD — poll 5 phút/lần'}`}
            />
            {(cfg.symbols.length === 0) && (
              <button className="stk-pill stk-empty" onClick={() => setSettingsOpen(true)}>
                chưa có mã — bấm để cấu hình
              </button>
            )}
            {cfg.symbols.map((s) => {
              const q = quotes[s.symbol];
              if (!q) {
                return (
                  <span key={s.symbol} className="stk-pill stk-wait" title={missing.includes(s.symbol) ? `Nguồn giá không có mã ${s.symbol} — kiểm tra lại mã` : 'đang lấy giá…'}>
                    {s.symbol} {missing.includes(s.symbol) ? '∅' : '…'}
                  </span>
                );
              }
              const tone = quoteTone(q);
              const hit = thresholdHit(s, q);
              const fl = flash[s.symbol];
              return (
                <button
                  key={s.symbol}
                  className={`stk-pill stk-${tone}${hit ? ' stk-alert' : ''}${fl ? ` stk-flash-${fl}` : ''}${detailSym === s.symbol ? ' on' : ''}`}
                  title={`${s.symbol}: ${fmtPrice(q.last)} (${fmtPct(q.changePc)})${hit ? ` · ⚠ chạm ngưỡng ${hit === 'above' ? `trên ≥ ${s.above}` : `dưới ≤ ${s.below}`}` : ''}${s.note ? ` · ${s.note}` : ''} — bấm xem chi tiết`}
                  onClick={() => setDetailSym((d) => (d === s.symbol ? null : s.symbol))}
                >
                  {hit && <span className="stk-warnmark" aria-hidden>⚠</span>}
                  <b>{s.symbol}</b>
                  <span className="stk-price">{fmtPrice(q.last)}</span>
                  <span className="stk-pct">{fmtPct(q.changePc)}</span>
                </button>
              );
            })}
            <button className="stk-ctl" title="Cấu hình mã & ngưỡng cảnh báo" onClick={() => setSettingsOpen(true)}>⚙</button>
            <button className="stk-ctl" title="Thu gọn thành bong bóng" onClick={toggleCollapsed}>▁</button>

            {/* Card chi tiết một mã — neo vào strip, mở về phía trong màn hình. */}
            {detail && (
              <div className="stk-detail">
                <div className="stk-detail-head">
                  <b className={`stk-t-${quoteTone(detail)}`}>{detail.symbol}</b>
                  <span className={`stk-t-${quoteTone(detail)}`}>{fmtPrice(detail.last)} · {fmtPct(detail.changePc)}</span>
                  <button className="stk-ctl" onClick={() => setDetailSym(null)}>✕</button>
                </div>
                <div className="stk-detail-grid">
                  <span>TC <b className="stk-t-ref">{fmtPrice(detail.ref)}</b></span>
                  <span>Trần <b className="stk-t-ceil">{fmtPrice(detail.ceil)}</b></span>
                  <span>Sàn <b className="stk-t-floor">{fmtPrice(detail.floor)}</b></span>
                  <span>Mở <b>{fmtPrice(detail.open)}</b></span>
                  <span>Cao <b>{fmtPrice(detail.high)}</b></span>
                  <span>Thấp <b>{fmtPrice(detail.low)}</b></span>
                  <span>KL <b>{fmtVol(detail.volume)}</b></span>
                  <span>Ngưỡng <b>{detailCfg?.below !== undefined || detailCfg?.above !== undefined
                    ? `${detailCfg?.below ?? '·'} ↔ ${detailCfg?.above ?? '·'}`
                    : 'chưa đặt'}</b></span>
                </div>
                {detailCfg?.note && <div className="stk-detail-note">{detailCfg.note}</div>}
              </div>
            )}
          </div>
        )
      )}

      {settingsOpen && (
        <StockSettingsModal
          initial={cfg ?? { ...DEFAULT_STOCKS_CONFIG }}
          onClose={() => setSettingsOpen(false)}
          onSaved={onSaved}
        />
      )}
    </>
  );
}

// ── Modal cấu hình ────────────────────────────────────────────────────────────

/** Một dòng mã trong form — giữ string thô để gõ dở "23." không bị nuốt. */
interface RowDraft { symbol: string; below: string; above: string; note: string }

const toRow = (s: StockSymbolCfg): RowDraft => ({
  symbol: s.symbol,
  below: s.below !== undefined ? String(s.below) : '',
  above: s.above !== undefined ? String(s.above) : '',
  note: s.note ?? '',
});

function StockSettingsModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: StocksConfig;
  onClose: () => void;
  onSaved: (cfg: StocksConfig) => void;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [intervalSec, setIntervalSec] = useState(initial.intervalSec);
  const [position, setPosition] = useState<StockCorner>(initial.position);
  const [rows, setRows] = useState<RowDraft[]>(
    initial.symbols.length ? initial.symbols.map(toRow) : [{ symbol: '', below: '', above: '', note: '' }],
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const setRow = (i: number, patch: Partial<RowDraft>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const validRows = useMemo(() => rows.filter((r) => r.symbol.trim()), [rows]);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const saved = await saveStocksConfig({
        enabled,
        intervalSec,
        position,
        symbols: validRows.map((r) => ({
          symbol: r.symbol.trim().toUpperCase(),
          ...(r.note.trim() ? { note: r.note.trim() } : {}),
          ...(r.above.trim() && Number(r.above) > 0 ? { above: Number(r.above) } : {}),
          ...(r.below.trim() && Number(r.below) > 0 ? { below: Number(r.below) } : {}),
        })),
      });
      onSaved(saved);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal stk-modal" onClick={(e) => e.stopPropagation()}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>📈 Giá cổ phiếu</h3>
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>

        <div className="stk-form-row">
          <label className="stk-switch" title="Tắt là widget biến mất hẳn — cấu hình vẫn giữ nguyên">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>{enabled ? 'Đang BẬT — widget hiện ở góc màn hình' : 'Đang TẮT (mặc định)'}</span>
          </label>
        </div>
        {initial.envLock && (
          <p className="stk-envnote">
            ⚡ Máy này đang bị <code>STOCKS_ENABLED={initial.envLock === 'on' ? 'true' : 'false'}</code> trong{' '}
            <code>.env.local</code> ép {initial.envLock === 'on' ? 'BẬT' : 'TẮT'} — công tắc ở trên chỉ đổi
            config dùng chung (theo config-sync đi các máy), không đổi được máy này. Muốn máy này theo config
            thì xoá dòng đó rồi mở lại app.
          </p>
        )}

        <div className="stk-form-row">
          <label className="stk-field">
            <span>Chu kỳ cập nhật (giây, 5–3600)</span>
            <input
              className="input" type="number" min={5} max={3600} value={intervalSec}
              onChange={(e) => setIntervalSec(Math.min(3600, Math.max(5, Number(e.target.value) || 30)))}
            />
          </label>
          <label className="stk-field">
            <span>Vị trí</span>
            <select className="input" value={position} onChange={(e) => setPosition(e.target.value as StockCorner)}>
              <option value="bl">Góc trái dưới</option>
              <option value="br">Góc phải dưới</option>
              <option value="tl">Góc trái trên</option>
              <option value="tr">Góc phải trên</option>
            </select>
          </label>
        </div>

        <div className="stk-field">
          <span>
            Mã theo dõi (tối đa 30) — ngưỡng theo GIÁ BẢNG (nghìn đồng, vd 71.5).
            Giá khớp ≤ ngưỡng dưới hoặc ≥ ngưỡng trên là pill nháy ⚠ + báo vào hòm thông báo.
          </span>
          <div className="stk-rows-head" aria-hidden>
            <i>Mã</i><i>Ngưỡng dưới ≤</i><i>Ngưỡng trên ≥</i><i>Ghi chú</i><i />
          </div>
          {rows.map((r, i) => (
            <div key={i} className="stk-row">
              <input
                className="input mono" value={r.symbol} placeholder="FPT" maxLength={12}
                onChange={(e) => setRow(i, { symbol: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })}
              />
              <input
                className="input mono" value={r.below} placeholder="vd 68" inputMode="decimal"
                onChange={(e) => setRow(i, { below: e.target.value })}
              />
              <input
                className="input mono" value={r.above} placeholder="vd 75" inputMode="decimal"
                onChange={(e) => setRow(i, { above: e.target.value })}
              />
              <input
                className="input" value={r.note} placeholder="canh mua / chốt lời…" maxLength={120}
                onChange={(e) => setRow(i, { note: e.target.value })}
              />
              <button className="chip-btn" title="Bỏ mã này" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div>
            <button
              className="ghost sm"
              disabled={rows.length >= 30}
              onClick={() => setRows((rs) => [...rs, { symbol: '', below: '', above: '', note: '' }])}
            >+ Thêm mã</button>
          </div>
        </div>

        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}

        <div className="status-line" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
          <span className="badge" style={{ marginRight: 'auto' }}>
            Nguồn: bảng giá VPS (public) · giá trễ vài giây so với sàn
          </span>
          <button className="ghost sm" onClick={onClose}>Huỷ</button>
          <button className="sm" disabled={busy || (enabled && validRows.length === 0)}
            title={enabled && validRows.length === 0 ? 'Bật thì cần ít nhất 1 mã' : 'Lưu vào configs/stocks.json'}
            onClick={() => void save()}
          >{busy ? <span className="spinner" aria-hidden /> : ''} Lưu</button>
        </div>
      </div>
    </div>
  );
}
