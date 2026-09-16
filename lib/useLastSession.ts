'use client';

// NHỚ PHIÊN LÀM VIỆC GẦN NHẤT của một tab dữ liệu (Postgres, Mongo…).
//
// VÌ SAO: tab Elasticsearch đã nhớ nội dung Console theo từng cluster
// (lib/esConsole.ts), nên thoát ra vào lại là gõ tiếp được ngay. Postgres và
// Mongo thì không: `BrowserView` bị remount sạch mỗi lần đổi connection
// (key={activeId}) và mỗi lần rời tab, nên câu query đang viết dở, bảng đang
// mở, tab đang xem — mất hết. Query dài vài chục dòng mà gõ lại từ đầu chỉ vì
// liếc sang tab khác một cái là quá phí.
//
// PHẠM VI: chỉ lưu thứ NGƯỜI DÙNG GÕ hoặc CHỌN (câu query, bảng đang mở, tab
// đang xem). KHÔNG lưu KẾT QUẢ trả về — dữ liệu cũ hiện lại như mới thì nguy
// hiểm hơn là tiện (bảng có thể đã đổi), và một trang kết quả 500 dòng thừa sức
// thổi bay hạn ngạch localStorage.
//
// KHOÁ THEO CONNECTION: mỗi server một phiên riêng. Dùng chung một khoá thì đổi
// server xong lại thấy câu SQL trỏ vào bảng của server cũ — chạy là lỗi, hoặc
// tệ hơn, trúng một bảng trùng tên ở nhầm môi trường.

import { useCallback, useEffect, useRef, useState } from 'react';
import { readLocal, writeLocal, removeLocal } from './localKeys';

/** Ghi trễ sau khi ngừng gõ — gõ SQL mà mỗi phím một lần ghi localStorage
 *  (đồng bộ, chặn main thread) thì editor bắt đầu khựng. */
const SAVE_DEBOUNCE_MS = 400;

function storeKey(ns: string, connectionId: string): string {
  return `${ns}.session.${connectionId}`;
}

/**
 * Trạng thái làm việc đã lưu + hàm ghi đè.
 *
 * `ready` = đã đọc xong localStorage. Component phải CHỜ cờ này rồi mới dựng
 * state ban đầu: đọc localStorage ngay trong render đầu sẽ lệch giữa HTML dựng
 * ở server (không có window) và ở client → React báo lỗi hydrate.
 */
export interface LastSession<T> {
  /** Giá trị đã lưu, hoặc null nếu chưa có gì / chưa đọc xong. */
  saved: T | null;
  ready: boolean;
  /** Ghi đè phiên đang lưu (được gộp trễ ~400ms). */
  save: (value: T) => void;
  /** Xoá phiên của connection này — nút "làm lại từ đầu". */
  clear: () => void;
}

/**
 * @param ns    Tiền tố khoá, vd 'pg' hoặc 'mongo'.
 * @param connectionId  Rỗng = chưa chọn server; hook nằm im, không đọc/ghi gì.
 * @param isValid  Kiểm tra hình dạng dữ liệu đọc lên. localStorage là dữ liệu
 *   NGOÀI: người dùng sửa tay được, và bản cũ của app có thể đã ghi hình dạng
 *   khác. Không kiểm thì một field thiếu sẽ thành crash lúc render.
 */
export function useLastSession<T>(
  ns: string,
  connectionId: string,
  isValid: (v: unknown) => v is T,
): LastSession<T> {
  const [saved, setSaved] = useState<T | null>(null);
  const [ready, setReady] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Giữ bản mới nhất để lượt ghi trễ dùng, khỏi phải đưa `saved` vào deps
  // (làm thế thì mỗi lần gõ lại dựng lại `save` và effect chạy vòng).
  const pending = useRef<T | null>(null);

  // Đọc MỘT lần cho mỗi connection, trong effect (client-only) chứ không phải
  // trong render — xem ghi chú `ready` ở trên.
  useEffect(() => {
    setReady(false);
    setSaved(null);
    if (!connectionId) { setReady(true); return; }
    try {
      const raw = readLocal(storeKey(ns, connectionId));
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isValid(parsed)) setSaved(parsed);
      }
    } catch {
      /* JSON hỏng / storage bị chặn — coi như chưa có phiên nào, không phá tab */
    }
    setReady(true);
    // `isValid` là hàm thuần khai báo ở cấp module; đưa vào deps chỉ tổ chạy lại
    // vô ích nếu chỗ gọi lỡ truyền hàm inline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ns, connectionId]);

  const flush = useCallback(() => {
    const v = pending.current;
    if (v === null || !connectionId) return;
    writeLocal(storeKey(ns, connectionId), JSON.stringify(v));
  }, [ns, connectionId]);

  const save = useCallback((value: T) => {
    if (!connectionId) return;
    pending.current = value;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }, [connectionId, flush]);

  // Rời tab / đóng app giữa lúc đang chờ ghi trễ → ghi nốt, không thì mất đúng
  // những phím cuối cùng vừa gõ.
  useEffect(() => {
    const flushNow = () => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      flush();
    };
    // Chỉ ghi lúc trang ĐI KHUẤT. visibilitychange cũng bắn khi quay lại nhìn
    // thấy — ghi lúc đó là thừa (chưa có gì mới) và đè lên bằng giá trị cũ.
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushNow(); };
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushNow);
      document.removeEventListener('visibilitychange', onVisibility);
      flushNow(); // unmount (đổi connection, rời tab) cũng phải ghi nốt
    };
  }, [flush]);

  const clear = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    pending.current = null;
    setSaved(null);
    if (connectionId) removeLocal(storeKey(ns, connectionId));
  }, [ns, connectionId]);

  return { saved, ready, save, clear };
}
