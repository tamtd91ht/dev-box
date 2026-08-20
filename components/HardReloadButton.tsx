'use client';

// Nút "Nạp lại sạch" ở footer — dọn cache rồi tải lại app.
//
// VÌ SAO CẦN MỘT NÚT RIÊNG, KHÔNG DÙNG Ctrl+Shift+R: sửa code mà màn hình không
// đổi thì có hai khả năng — code sai, hoặc đang ăn bản cũ. Ngồi đoán giữa hai
// cái đó rất tốn thời gian. Nút này loại bỏ hẳn khả năng thứ hai, dọn theo đúng
// thứ tự từ ngoài vào trong:
//
//   1. HTTP cache + code cache của session UI  → chunk JS/CSS cũ của Next
//   2. localStorage / sessionStorage           → cờ giao diện đọng lại
//   3. `.next` trên đĩa (tuỳ chọn)             → cache BUILD phía server
//
// Ctrl+Shift+R chỉ làm được tầng 1, và KHÔNG chạm tới tầng 2 hay 3. Mà tầng 2 là
// thứ hay gây "sửa rồi mà vẫn thế" nhất: một cờ '0' trong localStorage sống dai
// hơn mọi lần reload. Tầng 3 thì renderer không có quyền, phải nhờ main process.

import { useCallback, useState } from 'react';

/**
 * DANH SÁCH ĐEN: đúng những khoá localStorage được phép xoá.
 *
 * Toàn bộ là cờ hiển thị, dựng lại tức thì, không mất gì của người dùng. Mọi
 * khoá khác — connection, preset, tài khoản, kích thước panel — được GIỮ.
 *
 * Cố ý là danh sách đen chứ không phải danh sách trắng: whitelist đòi người viết
 * phải kể đủ mọi thứ đáng giữ, kể cả những khoá thêm vào sau này, mà sót một cái
 * là xoá mất dữ liệu thật. Blacklist sót thì chỉ là dọn chưa hết.
 */
const DROP_EXACT = ['bt:marks', 'bt:marks:v2', 'ws:muted'];

/** Các nhóm preset cần sao lưu lên configs/ trước khi dọn. */
const PRESET_KEYS = [
  'redis.quickfinds',
  'kafka.presets',
  'mongo.quickfinds',
  'es.quickfinds',
  'pg.quickfinds',
] as const;

/**
 * Đẩy preset đang có trong localStorage lên configs/presets.json và CHỜ xong.
 *
 * Trả về false nếu có dữ liệu cần cứu mà không gửi được — lúc đó phải huỷ việc
 * dọn, vì xoá đi là không lấy lại được từ đâu.
 */
async function backupPresetsToServer(): Promise<boolean> {
  for (const kind of PRESET_KEYS) {
    let list: unknown[] = [];
    try {
      const raw = localStorage.getItem(`devbox.${kind}`) ?? localStorage.getItem(`omicx.${kind}`);
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) list = parsed;
    } catch { continue; }
    if (list.length === 0) continue;
    try {
      // POST = seed: server chỉ ghi khi nhóm đó còn trống, nên máy này không
      // ghi đè preset mà máy khác đã đồng bộ lên trước.
      const r = await fetch('/api/presets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, list }),
      });
      if (!r.ok) return false;
    } catch { return false; }
  }
  return true;
}

export default function HardReloadButton() {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  /**
   * `wipeBuild` = xoá luôn `.next`. Tách riêng vì nó đắt: lần nạp đầu sau đó
   * phải biên dịch lại, mất ~10-30s. Dùng khi nghi cache BUILD sai, chứ không
   * phải mặc định.
   */
  const run = useCallback(async (wipeBuild: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      // ── Tầng 2: localStorage ──
      //
      // CHỈ xoá đúng những khoá có trong DROP_EXACT. Bản trước làm ngược lại —
      // xoá tất cả TRỪ danh sách trắng — và đó là một sai lầm về nguyên tắc:
      // danh sách trắng phải liệt kê đủ mọi thứ đáng giữ, sót một cái là mất dữ
      // liệu thật, mà người viết không thể biết hết những khoá sẽ thêm về sau.
      // Danh sách đen thì sót chỉ có nghĩa là "dọn chưa hết" — hậu quả nhẹ hơn
      // hẳn. Preset tìm nhanh của Redis/Kafka/Mongo/ES/PG đã bị xoá đúng vì lỗi
      // này.
      //
      // Trước khi xoá, ĐẨY preset lên server và CHỜ xác nhận. Không chờ thì gặp
      // đúng ca đã xảy ra: máy đang chạy bản cũ chưa có hydratePresets, server
      // chưa có gì, xoá xong là mất sạch không còn bản nào.
      try {
        const ok = await backupPresetsToServer();
        if (!ok) {
          setNote('Chưa sao lưu được nút tìm nhanh lên configs/ — huỷ dọn để không mất dữ liệu. Thử lại sau.');
          setBusy(false);
          return;
        }
        for (const k of DROP_EXACT) localStorage.removeItem(k);
        sessionStorage.clear();
      } catch { /* bị chặn thì bỏ qua, còn hai tầng kia */ }

      // Service worker + Cache Storage: nếu có bản cũ đăng ký thì nó chặn trước
      // cả HTTP cache, dọn hai tầng kia mà bỏ cái này là vẫn ra nội dung cũ.
      try {
        const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
        await Promise.all(regs.map((r) => r.unregister()));
        const keys = (await caches?.keys?.()) ?? [];
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch { /* không có SW — bình thường */ }

      // Tầng 1 + 3 — chỉ main process làm được.
      const bridge = window.desktopUpdate;
      if (bridge?.hardReload) {
        const r = await bridge.hardReload({ wipeBuild });
        if (!r.ok) {
          setNote(r.error || 'Không dọn được cache.');
          setBusy(false);
          return;
        }
        // Đã xoá `.next` thì `next dev` cũng đã bị giết để nhả file. Reload
        // trang lúc này là nạp vào một server không còn sống → trang lỗi. Phải
        // khởi động lại cả app; relaunch() không bao giờ trả về khi thành công.
        if (r.needsRelaunch) {
          await bridge.relaunch();
          return;
        }
      } else if (wipeBuild) {
        // Chạy trên trình duyệt thường: không có cầu nối, không xoá được .next.
        // Nói thẳng thay vì reload rồi để người dùng tưởng đã dọn.
        setNote('Chạy ngoài app desktop nên không xoá được .next. Đã dọn cache trình duyệt.');
      }

      // `location.reload()` của Chromium KHÔNG bỏ qua cache. Thêm tham số dùng
      // một lần để URL khác đi, buộc tải mới toàn bộ document.
      const u = new URL(window.location.href);
      u.searchParams.set('__fresh', String(Date.now()));
      window.location.replace(u.toString());
    } catch (e) {
      setNote((e as Error).message);
      setBusy(false);
    }
  }, []);

  return (
    <span className="hrl-wrap">
      <button
        className={`ghost sm${busy ? ' busy' : ''}`}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        title="Dọn cache rồi nạp lại — dùng khi sửa code mà màn hình không đổi"
      >
        {busy ? '⏳ Đang dọn…' : '🧹 Nạp lại sạch'}
      </button>

      {open && !busy && (
        <>
          <div className="hrl-back" onClick={() => setOpen(false)} />
          <div className="hrl-pop">
            <button onClick={() => { setOpen(false); void run(false); }}>
              🧹 Dọn cache + nạp lại
              <span className="hrl-sub">Cache trình duyệt, service worker, cờ giao diện. GIỮ connection, preset, nút tìm nhanh. Nhanh.</span>
            </button>
            <div className="hrl-sep" />
            <button onClick={() => { setOpen(false); void run(true); }}>
              🔥 Dọn cả cache build (.next)
              <span className="hrl-sub">Thêm ~10-30s biên dịch lại. Dùng khi nghi build cũ.</span>
            </button>
          </div>
        </>
      )}

      {note && <span className="hrl-note" title={note}>{note}</span>}
    </span>
  );
}
