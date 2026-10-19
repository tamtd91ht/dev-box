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
import { getUnloadBlockers } from '@/lib/unloadGuard';

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

/** Gom preset từ localStorage để gửi đi sao lưu. Chỉ lấy nhóm có dữ liệu. */
function collectPresets(): { kind: string; list: unknown[] }[] {
  const out: { kind: string; list: unknown[] }[] = [];
  for (const kind of PRESET_KEYS) {
    try {
      const raw = localStorage.getItem(`devbox.${kind}`) ?? localStorage.getItem(`omicx.${kind}`);
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed) && parsed.length > 0) out.push({ kind, list: parsed });
    } catch { /* nhóm hỏng thì bỏ qua, các nhóm khác vẫn cứu */ }
  }
  return out;
}

/**
 * Đẩy preset lên configs/presets.json và CHỜ xong — đường DỰ PHÒNG khi chạy
 * trên trình duyệt thường (không có cầu nối desktop).
 *
 * Trong app desktop thì KHÔNG dùng đường này: fetch của renderer chỉ có 6
 * socket HTTP/1.1 tới mỗi host, mà SSE terminal + automation watch chiếm sạch
 * cả 6 — request xếp hàng VÔ HẠN và nút đứng ở "Đang dọn…" mãi (đã xảy ra
 * thật, xác minh bằng CDP: POST phát đi không bao giờ có response trong khi
 * curl từ ngoài trả 200 sau 11ms). App desktop gửi preset kèm IPC để main
 * process POST bằng Node HTTP — pool riêng, không dính giới hạn đó.
 *
 * Timeout 8s cho từng nhóm: trình duyệt thường cũng có thể nghẽn pool y hệt,
 * thà báo "chưa sao lưu được" còn hơn treo không lời giải thích.
 *
 * Trả về false nếu có dữ liệu cần cứu mà không gửi được — lúc đó phải huỷ việc
 * dọn, vì xoá đi là không lấy lại được từ đâu.
 */
async function backupPresetsToServer(presets: { kind: string; list: unknown[] }[]): Promise<boolean> {
  for (const { kind, list } of presets) {
    try {
      // POST = seed: server chỉ ghi khi nhóm đó còn trống, nên máy này không
      // ghi đè preset mà máy khác đã đồng bộ lên trước.
      const r = await fetch('/api/presets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, list }),
        signal: AbortSignal.timeout(8000),
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
    // Còn ai chặn unload (tài liệu Office chưa lưu) thì DỪNG TRƯỚC KHI LÀM GÌ:
    // beforeunload trong Electron huỷ im lặng cả location.replace lẫn
    // app.quit() — main không xử lý will-prevent-unload nên không có hộp thoại
    // nào hiện ra. Không kiểm tra ở đây thì nhánh nhẹ treo ở "Đang dọn…" mãi,
    // còn nhánh xoá .next tệ hơn: server đã chết, .next đã mất, mà app không
    // thoát được — lúc đó muốn LƯU tài liệu cũng không còn backend để lưu.
    const blockers = getUnloadBlockers();
    if (blockers.length > 0) {
      setNote(`Đang có ${blockers.join('; ')} — lưu hoặc đóng lại rồi hãy nạp lại sạch.`);
      return;
    }

    setBusy(true);
    setNote(null);
    try {
      // SAO LƯU preset TRƯỚC, chờ xác nhận, rồi mới được xoá bất cứ gì.
      //
      // Trong app desktop, việc POST do MAIN PROCESS làm (gửi dữ liệu kèm IPC):
      // fetch của renderer chỉ có 6 socket tới localhost:3000 mà SSE terminal +
      // automation chiếm sạch, POST xếp hàng vô hạn — chính là vụ nút này treo
      // ở "Đang dọn…" không lời giải thích. Xem backupPresetsToServer.
      const presets = collectPresets();

      // Tầng 1 + 3 (+ sao lưu) — chỉ main process làm được.
      const bridge = window.desktopUpdate;
      let needsRelaunch = false;
      if (bridge?.hardReload) {
        const r = await bridge.hardReload({ wipeBuild, presets });
        if (!r.ok) {
          setNote(r.error || 'Không dọn được cache.');
          setBusy(false);
          return;
        }
        needsRelaunch = !!r.needsRelaunch;
      } else {
        // Trình duyệt thường: tự POST (có timeout), không gửi được thì HUỶ —
        // xoá đi là không lấy lại được từ đâu.
        const ok = await backupPresetsToServer(presets);
        if (!ok) {
          setNote('Chưa sao lưu được nút tìm nhanh lên configs/ — huỷ dọn để không mất dữ liệu. Thử lại sau.');
          setBusy(false);
          return;
        }
        if (wipeBuild) {
          // Không có cầu nối thì không xoá được .next. Nói thẳng thay vì
          // reload rồi để người dùng tưởng đã dọn.
          setNote('Chạy ngoài app desktop nên không xoá được .next. Đã dọn cache trình duyệt.');
        }
      }

      // ── Tầng 2: localStorage — CHỈ SAU khi sao lưu đã được xác nhận ──
      //
      // CHỈ xoá đúng những khoá có trong DROP_EXACT. Bản trước làm ngược lại —
      // xoá tất cả TRỪ danh sách trắng — và đó là một sai lầm về nguyên tắc:
      // danh sách trắng phải liệt kê đủ mọi thứ đáng giữ, sót một cái là mất dữ
      // liệu thật, mà người viết không thể biết hết những khoá sẽ thêm về sau.
      // Danh sách đen thì sót chỉ có nghĩa là "dọn chưa hết" — hậu quả nhẹ hơn
      // hẳn. Preset tìm nhanh của Redis/Kafka/Mongo/ES/PG đã bị xoá đúng vì lỗi
      // này.
      try {
        for (const k of DROP_EXACT) localStorage.removeItem(k);
        sessionStorage.clear();
      } catch { /* bị chặn thì bỏ qua, còn các tầng kia */ }

      // Service worker + Cache Storage: nếu có bản cũ đăng ký thì nó chặn trước
      // cả HTTP cache, dọn hai tầng kia mà bỏ cái này là vẫn ra nội dung cũ.
      try {
        const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
        await Promise.all(regs.map((r) => r.unregister()));
        const keys = (await caches?.keys?.()) ?? [];
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch { /* không có SW — bình thường */ }

      // Đã xoá `.next` thì `next dev` cũng đã bị giết để nhả file. Reload
      // trang lúc này là nạp vào một server không còn sống → trang lỗi. Phải
      // khởi động lại cả app; relaunch() không bao giờ trả về khi thành công.
      if (needsRelaunch && bridge) {
        await bridge.relaunch();
        // Tới được đây nghĩa là IPC đã trả lời mà tiến trình chưa chết.
        // app.quit() vẫn có thể bị một beforeunload đăng ký SAU lượt kiểm tra
        // đầu hàm chặn im lặng — chờ một nhịp, còn sống thì nói thật tình
        // trạng thay vì treo: .next đã mất nên phải tự khởi động lại app.
        window.setTimeout(() => {
          setNote('App không tự thoát được (có thứ chặn unload). .next đã xoá — hãy đóng và mở lại app thủ công.');
          setBusy(false);
        }, 3000);
        return;
      }

      // `location.reload()` của Chromium KHÔNG bỏ qua cache. Thêm tham số dùng
      // một lần để URL khác đi, buộc tải mới toàn bộ document.
      const u = new URL(window.location.href);
      u.searchParams.set('__fresh', String(Date.now()));
      window.location.replace(u.toString());
      // replace() có thể bị huỷ im lặng (blocker đăng ký sau lượt kiểm tra đầu
      // hàm, hoặc thứ gì đó ngoài sổ unloadGuard). Trang rời đi thì timer này
      // chết theo document; còn chạy tức là vẫn đứng yên — báo ra thay vì để
      // "Đang dọn…" treo vô hạn. Server còn sống nên bấm lại là được.
      window.setTimeout(() => {
        setNote('Trang không rời đi được — có thứ chặn unload (thường là tài liệu chưa lưu). Xử lý xong bấm lại.');
        setBusy(false);
      }, 2500);
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
