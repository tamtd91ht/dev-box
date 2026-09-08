'use client';

// Bảng LỊCH SỬ TRUY CẬP của tab Browser — "chrome://history" bản local: xem
// lại các trang đã xem theo ngày, tìm trong lịch sử, mở lại, và xoá (một dòng
// / cả site / tất cả).
//
// Nguồn dữ liệu là cùng một store với GỢI Ý của ô địa chỉ
// (lib/historyStore.ts): những gì xoá ở đây thì thôi hiện trong gợi ý.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  historyList, historyRemove, historyRemoveHost, historyClear, type HistoryEntry,
} from '@/lib/browserHistory';
import { useModalOverWebview } from '@/lib/useOverWebview';

const shortUrl = (u: string): string => u.replace(/^https?:\/\//, '').replace(/^www\./, '');

/** Nhãn ngày kiểu trình duyệt: "Hôm nay" / "Hôm qua" / ngày cụ thể. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Không rõ ngày';
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(d)) / 86_400_000);
  if (days === 0) return 'Hôm nay';
  if (days === 1) return 'Hôm qua';
  return d.toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
}

const clockOf = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
};

export default function BrowserHistory({ onOpen, onClose }: {
  /** Bấm một dòng → mở lại trang đó (chủ khung quyết định mở tab mới hay không). */
  onOpen: (url: string) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Xác nhận "xoá tất cả" — hành động không hoàn tác được, đừng làm ngay ở
   *  cú bấm đầu. */
  const [askClear, setAskClear] = useState(false);
  const [mounted, setMounted] = useState(false);
  /** Neo vô hình để lần ngược ra pane đang chứa modal (xem effect tự đóng). */
  const anchorRef = useRef<HTMLSpanElement>(null);

  useEffect(() => setMounted(true), []);

  // <webview> vẽ ở tầng native và đè lên mọi HTML: không đặt cờ thì modal bị
  // trang web che kín, bấm/gõ đi vào trang chứ không vào modal.
  useModalOverWebview(true);
  useEffect(() => {
    void window.workspace?.focusHost?.().catch(() => {});
  }, []);

  // Tự đóng khi người dùng rời tab — modal đã portal ra body nên không bị pane
  // kéo đi cùng, để nguyên là nó nằm đè lên tab vừa chuyển sang.
  useEffect(() => {
    const pane = anchorRef.current?.closest('main.workspace');
    if (!pane) return;
    const obs = new MutationObserver(() => {
      if (pane.getAttribute('aria-hidden') === 'true') onClose();
    });
    obs.observe(pane, { attributes: true, attributeFilter: ['aria-hidden'] });
    return () => obs.disconnect();
  }, [onClose, mounted]);

  const reload = useCallback(async (query: string) => {
    setLoading(true);
    try { setItems(await historyList(query, 500)); setErr(null); }
    catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }, []);

  // Tìm trong lịch sử — hoãn một nhịp để gõ không bắn một request mỗi ký tự.
  useEffect(() => {
    const t = setTimeout(() => { void reload(q); }, 150);
    return () => clearTimeout(t);
  }, [q, reload]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (askClear) setAskClear(false); else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [askClear, onClose]);

  /** Bỏ khỏi danh sách đang hiện NGAY, không đợi API — đợi round-trip thì dòng
   *  vừa xoá còn nằm đó cả nhịp, trông như bấm không ăn. */
  const dropOne = async (url: string) => {
    setItems((cur) => cur.filter((e) => e.url !== url));
    try { await historyRemove(url); } catch (e) { setErr((e as Error).message); void reload(q); }
  };

  const dropHost = async (host: string) => {
    setItems((cur) => cur.filter((e) => e.host !== host));
    try { await historyRemoveHost(host); } catch (e) { setErr((e as Error).message); void reload(q); }
  };

  const clearAll = async () => {
    setAskClear(false);
    setItems([]);
    try { await historyClear(); } catch (e) { setErr((e as Error).message); void reload(q); }
  };

  /** Gom theo ngày để đọc như lịch sử trình duyệt. `items` đã xếp mới→cũ nên
   *  chỉ cần cắt khúc theo nhãn ngày, không phải sắp lại. */
  const groups = useMemo(() => {
    const out: { label: string; rows: HistoryEntry[] }[] = [];
    for (const e of items) {
      const label = dayLabel(e.lastVisit);
      const last = out[out.length - 1];
      if (last && last.label === label) last.rows.push(e);
      else out.push({ label, rows: [e] });
    }
    return out;
  }, [items]);

  const anchor = <span ref={anchorRef} hidden aria-hidden />;
  if (!mounted) return anchor;

  return (
    <>
      {anchor}
      {createPortal(
        <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
          <div className="mail-compose panel" style={{ width: 'min(820px, 96vw)' }}>
            <div className="mail-compose-head">
              <b>🕘 Lịch sử</b>
              <span className="small" style={{ color: 'var(--muted)' }}>({items.length})</span>
              <span style={{ flex: 1 }} />
              <input className="input sm" style={{ width: 200 }} placeholder="Tìm trong lịch sử…"
                value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
              <button className="ghost sm" onClick={() => void reload(q)} disabled={loading} title="Tải lại">
                {loading ? <span className="spinner" aria-hidden /> : '↻'}
              </button>
              <button className="ghost sm" onClick={onClose}>✕</button>
            </div>

            <p className="small" style={{ color: 'var(--muted)', margin: '2px 0 6px' }}>
              Mỗi địa chỉ một dòng, vào lại thì đếm thêm lần. Đây cũng là nguồn GỢI Ý của
              ô địa chỉ — xoá ở đây thì thôi gợi ý. Lưu tại configs/browser-history.json.
            </p>

            {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '2px 0' }}>{err}</pre>}

            <div className="pw-list">
              {groups.map((g) => (
                <div key={g.label}>
                  <div className="hist-day">{g.label}</div>
                  {g.rows.map((e) => (
                    <div key={e.url} className="hist-row">
                      <span className="hist-time">{clockOf(e.lastVisit)}</span>
                      <button className="hist-open" title={e.url} onClick={() => { onOpen(e.url); onClose(); }}>
                        <span className="hist-title">{e.title || e.host || shortUrl(e.url)}</span>
                        <span className="hist-url">{shortUrl(e.url)}</span>
                      </button>
                      {e.visitCount > 1 && (
                        <span className="addr-sug-n" title={`Đã vào ${e.visitCount} lần`}>{e.visitCount}</span>
                      )}
                      <span className="pw-acts">
                        <button className="ghost sm" title={`Xoá mọi trang của ${e.host}`}
                          onClick={() => void dropHost(e.host)}>🌐✕</button>
                        <button className="ghost sm" title="Xoá dòng này khỏi lịch sử"
                          onClick={() => void dropOne(e.url)}>✕</button>
                      </span>
                    </div>
                  ))}
                </div>
              ))}
              {!loading && items.length === 0 && (
                <div className="empty" style={{ padding: '20px 8px' }}>
                  <p className="small">
                    {q ? 'Không có trang nào khớp.' : 'Chưa có lịch sử. Mở vài trang trong tab Browser rồi quay lại đây.'}
                  </p>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 6, alignItems: 'center', paddingTop: 6 }}>
              {askClear ? (
                <>
                  <span className="small" style={{ color: 'var(--err)' }}>Xoá TOÀN BỘ lịch sử? Không hoàn tác được.</span>
                  <button className="sm danger" onClick={() => void clearAll()}>Xoá hết</button>
                  <button className="ghost sm" onClick={() => setAskClear(false)}>Hủy</button>
                </>
              ) : (
                <button className="ghost sm" onClick={() => setAskClear(true)} disabled={items.length === 0}>
                  🗑 Xoá toàn bộ lịch sử…
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
