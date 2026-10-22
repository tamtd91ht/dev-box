'use client';

// Trạm canh cờ key-miss của Redis (notify-keyspace-events "m") — 10 phút quét một lần.
//
// Phân tích hit rate bật tạm cờ này trên production rồi trả lại; nếu app chết giữa chừng
// (hoặc một app khác bật mà quên tắt) cờ sẽ chạy ngầm mãi. Mount MỘT lần ngoài mọi pane
// (cạnh GitAutoPullHost) nên hoạt động ở bất kỳ tab nào. Mỗi lần quét, server đọc
// CONFIG GET + PUBSUB NUMSUB trên mọi kết nối Redis đã lưu (lib/redisKeymissGuard — chỉ đọc).
//
// Thấy cờ đang bật → toast HỎI, không tự tắt (cờ có thể do người khác cố ý bật):
//   · "Tắt cờ"        → trả về giá trị cũ (có dấu) hoặc bỏ cờ m, báo kết quả.
//   · "Nhắc lại sau"  → lần quét sau hỏi lại.
//   · "Để nguyên"     → không hỏi lại giá trị cờ này trong phiên làm việc (đổi cờ thì hỏi lại).
// Kiểm tra tay bất cứ lúc nào: nút "🔎 Cờ key-miss" trong chi tiết Redis của Monitor.
//
// Không render gì — toast do AutomationHost vẽ.

import { useEffect, useRef } from 'react';
import { automation } from '@/lib/automation/runtime';
import { redisKeymissRelease, redisKeymissScan, type KeymissState } from '@/lib/redis';

const SCAN_MS = 10 * 60_000;
/** Lần quét đầu sau khi mở app — đủ để server khởi động xong, vẫn sớm bắt cờ sót từ lần trước. */
const FIRST_MS = 30_000;

const keyOf = (st: KeymissState) =>
  `${st.connectionId}|${st.nodes.filter((n) => n.on).map((n) => `${n.addr}=${n.flags}`).join(',')}`;

export default function KeymissFlagHost() {
  // Đang hiện toast / người dùng đã chọn "Để nguyên" — không hỏi trùng.
  const open = useRef(new Set<string>());
  const muted = useRef(new Set<string>());

  useEffect(() => {
    let stopped = false;

    const ask = (st: KeymissState) => {
      const key = keyOf(st);
      if (open.current.has(key) || muted.current.has(key)) return;
      open.current.add(key);
      const on = st.nodes.filter((n) => n.on);
      const lines = on.map((n) => {
        const who = n.listeners ? `${n.listeners} kết nối đang nghe` : n.patterns ? `không ai nghe kênh keymiss (có ${n.patterns} pattern subscription khác)` : 'không ai nghe';
        const why = n.pending ? ` · do phân tích hit rate lúc ${new Date(n.pending.at).toLocaleString('vi-VN')} chưa trả lại (cũ: "${n.pending.orig}")` : '';
        return `${n.addr}: notify-keyspace-events="${n.flags}" · ${who}${why}`;
      });
      automation.actionNotify(
        'warn',
        `Redis ${st.name}: cờ key-miss đang bật`,
        `${lines.join('\n')}\nMỗi lần miss Redis phát thêm một sự kiện trên luồng chính. Tắt nếu không còn phân tích nào cần.`,
        'canh cờ key-miss',
        [
          {
            label: 'Tắt cờ',
            primary: true,
            run: async () => {
              open.current.delete(key);
              try {
                // Chỉ đúng các node nêu trong toast (đang bật, không ai nghe) — không đụng node khác.
                const res = (await Promise.all(on.map((n) => redisKeymissRelease(st.connectionId, n.addr)))).flat();
                const bad = res.filter((r) => !r.ok);
                automation.systemNotify(
                  bad.length ? 'warn' : 'info',
                  bad.length ? `Redis ${st.name}: chưa tắt được ${bad.length} node` : `Redis ${st.name}: đã tắt cờ key-miss`,
                  res.map((r) => (r.ok ? `${r.addr}: "${r.from}" → "${r.to}"` : `${r.addr}: ${r.error}`)).join('\n') || 'Cờ đã tắt từ trước.',
                  'canh cờ key-miss',
                );
              } catch (e) {
                automation.systemNotify('warn', `Redis ${st.name}: không tắt được cờ key-miss`, (e as Error).message, 'canh cờ key-miss');
              }
            },
          },
          { label: 'Nhắc lại sau', run: () => { open.current.delete(key); } },
          { label: 'Để nguyên', run: () => { open.current.delete(key); muted.current.add(key); } },
        ],
      );
    };

    async function tick() {
      try {
        const found = await redisKeymissScan();
        if (!stopped) found.forEach(ask);
      } catch {
        /* Redis tool tắt / server đang khởi động — thử lại ở lần quét sau */
      }
    }

    const first = setTimeout(() => void tick(), FIRST_MS);
    const timer = setInterval(() => void tick(), SCAN_MS);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  return null;
}
