'use client';

// NHIỀU TAB QUERY cùng lúc cho một tab dữ liệu (Postgres, Mongo…), có nhớ lại
// khi thoát ra vào lại.
//
// VÌ SAO: trước đây mỗi connection chỉ có MỘT chỗ ngồi (lib/useLastSession) —
// đang dở câu join trên bảng A mà cần liếc bảng B là phải xoá câu đang viết,
// chọn bảng khác, xong lại gõ lại từ đầu. Công việc thật hiếm khi chỉ đụng một
// bảng: đối chiếu hai bảng, vừa xem cấu hình vừa xem log, chạy một câu nặng ở
// tab này trong lúc gõ câu khác ở tab kia.
//
// PHẠM VI LƯU — y hệt ranh giới của lib/useLastSession, chỉ nhân lên nhiều tab:
//   · Lưu: thứ NGƯỜI DÙNG gõ/chọn (câu query, bảng đang mở, tab con đang xem).
//   · KHÔNG lưu: KẾT QUẢ trả về. Dữ liệu cũ hiện lại như vừa chạy xong là sai
//     lệch nguy hiểm (bảng có thể đã đổi, và ở Mongo còn sửa/xoá ngay trên kết
//     quả), chưa kể một trang 500 dòng × N tab thừa sức thổi bay hạn ngạch
//     localStorage (~5MB). Kết quả sống trong RAM của từng tab, mất khi rời tab.
//
// KHOÁ THEO CONNECTION: mỗi server một bộ tab riêng (`<ns>.tabs.<connectionId>`).
// Dùng chung một khoá thì đổi server xong lại thấy câu SQL trỏ vào bảng của
// server cũ — chạy là lỗi, hoặc tệ hơn, trúng một bảng trùng tên ở nhầm môi
// trường.
//
// TƯƠNG THÍCH NGƯỢC: bộ tab trống thì hook đọc nốt khoá phiên ĐƠN đời cũ
// (`<ns>.session.<connectionId>` của useLastSession) và dựng nó thành tab đầu
// tiên — người đang có câu query dở lúc nâng cấp app không bị mất.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readLocal, writeLocal, removeLocal } from './localKeys';

/** Ghi trễ sau khi ngừng gõ — mỗi phím một lần ghi localStorage (đồng bộ, chặn
 *  main thread) thì editor bắt đầu khựng. Giống useLastSession. */
const SAVE_DEBOUNCE_MS = 400;

/** Trần số tab mở cùng lúc. Quá tay thì thanh tab thành một hàng chữ vụn không
 *  đọc được, và mỗi tab còn giữ kết quả riêng trong RAM. */
export const MAX_TABS = 12;

export interface QueryTab<T> {
  id: string;
  /** Nhãn hiện trên thanh tab. Tự sinh theo bảng đang chọn, trừ khi người dùng
   *  đặt tay (rename) — lúc đó `pinnedTitle` bật và thôi tự đổi. */
  title: string;
  /** Người dùng đã tự đặt tên → đừng ghi đè khi họ đổi bảng. */
  pinnedTitle?: boolean;
  /** Trạng thái làm việc, hình dạng do từng tab dữ liệu tự định nghĩa. */
  state: T;
}

export interface QueryTabsApi<T> {
  /** Đã đọc xong localStorage chưa — component phải chờ cờ này rồi mới dựng
   *  state ban đầu, nếu không sẽ lệch hydrate giữa server và client. */
  ready: boolean;
  tabs: QueryTab<T>[];
  activeId: string;
  active: QueryTab<T> | null;
  /** Ghi đè state của tab đang mở (gộp trễ ~400ms). */
  update: (patch: Partial<T> | ((prev: T) => T)) => void;
  /**
   * Ghi đè state của MỘT tab bất kỳ theo id.
   *
   * Cần riêng khỏi `update` vì một query nặng có thể trả về SAU khi người dùng
   * đã bấm sang tab khác: kết quả (và `skip` đi kèm) phải rơi đúng tab đã bấm
   * chạy, không được đè lên tab đang xem.
   */
  patchTab: (id: string, patch: Partial<T> | ((prev: T) => T)) => void;
  /** Bản mới nhất của danh sách tab, đọc được từ trong callback async mà không
   *  dính closure cũ. */
  tabsRef: React.MutableRefObject<QueryTab<T>[]>;
  /** Đổi nhãn tab đang mở theo bảng vừa chọn — bỏ qua nếu người dùng đã tự đặt tên. */
  autoTitle: (title: string) => void;
  /** Người dùng đặt tên tay → khoá nhãn lại. */
  rename: (id: string, title: string) => void;
  select: (id: string) => void;
  /** Mở tab mới (state khởi tạo mặc định, hoặc sao chép từ `seed`). */
  open: (seed?: Partial<T>, title?: string) => void;
  close: (id: string) => void;
  /** Xoá sạch mọi tab của connection này và bắt đầu lại bằng một tab trống. */
  reset: () => void;
}

const storeKey = (ns: string, connectionId: string) => `${ns}.tabs.${connectionId}`;
/** Khoá phiên ĐƠN đời cũ (lib/useLastSession) — chỉ đọc, để migrate một lần. */
const legacySessionKey = (ns: string, connectionId: string) => `${ns}.session.${connectionId}`;

function newId(): string {
  return `t_${Math.random().toString(36).slice(2, 9)}`;
}

interface Stored<T> {
  activeId: string;
  tabs: QueryTab<T>[];
}

/**
 * Dựng lại bộ tab từ hai chuỗi JSON thô trong localStorage. Tách ra khỏi hook
 * để KIỂM ĐƯỢC không cần React — đây là chỗ dễ âm thầm nuốt mất câu query đang
 * dở của người dùng nhất (xem scripts/check-query-tabs.ts).
 *
 * @param raw     Nội dung khoá `<ns>.tabs.<conn>` (null = chưa có).
 * @param legacy  Nội dung khoá phiên ĐƠN đời cũ `<ns>.session.<conn>`, chỉ dùng
 *                khi `raw` không cho ra tab nào.
 *
 * Mọi đường hỏng đều đi về MỘT tab trống chứ không bao giờ trả danh sách rỗng:
 * màn hình không có tab nào thì chẳng còn gì để bấm.
 */
export function restoreTabs<T>(
  raw: string | null,
  legacy: string | null,
  fns: {
    blank: () => T;
    isValid: (v: unknown) => v is T;
    titleOf: (state: T) => string;
    newId: () => string;
  },
): Stored<T> {
  let list: QueryTab<T>[] = [];
  let wantActive = '';

  try {
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Stored<T>> | null;
      if (parsed && Array.isArray(parsed.tabs)) {
        list = (parsed.tabs as unknown[])
          .filter((t): t is QueryTab<T> => {
            if (!t || typeof t !== 'object') return false;
            const x = t as Record<string, unknown>;
            return typeof x.id === 'string' && typeof x.title === 'string' && fns.isValid(x.state);
          })
          .slice(0, MAX_TABS);
        if (typeof parsed.activeId === 'string') wantActive = parsed.activeId;
      }
    }
  } catch {
    /* JSON hỏng — coi như chưa có tab nào, không phá màn hình */
  }

  // Chưa có bộ tab nào → vớt nốt phiên ĐƠN đời cũ để không mất câu đang dở.
  if (list.length === 0 && legacy) {
    try {
      const parsed: unknown = JSON.parse(legacy);
      if (fns.isValid(parsed)) {
        list = [{ id: fns.newId(), title: fns.titleOf(parsed) || 'Tab 1', state: parsed }];
      }
    } catch { /* như trên */ }
  }

  if (list.length === 0) list = [{ id: fns.newId(), title: 'Tab 1', state: fns.blank() }];
  return {
    tabs: list,
    activeId: list.some((t) => t.id === wantActive) ? wantActive : list[0].id,
  };
}

/**
 * @param ns        Tiền tố khoá, vd 'pg' hoặc 'mongo'.
 * @param connectionId  Rỗng = chưa chọn server; hook nằm im, không đọc/ghi gì.
 * @param blank     Dựng state rỗng cho một tab mới. Phải là hàm THUẦN khai báo
 *                  ở cấp module (đưa vào deps mà là hàm inline thì chạy lại vô ích).
 * @param isValid   Kiểm hình dạng state đọc lên. localStorage là dữ liệu NGOÀI:
 *                  người dùng sửa tay được, và bản cũ của app có thể đã ghi hình
 *                  dạng khác. Không kiểm thì một field thiếu thành crash lúc render.
 * @param titleOf   Nhãn mặc định cho một state (vd "public.users").
 */
export function useQueryTabs<T>(
  ns: string,
  connectionId: string,
  blank: () => T,
  isValid: (v: unknown) => v is T,
  titleOf: (state: T) => string,
): QueryTabsApi<T> {
  const [tabs, setTabs] = useState<QueryTab<T>[]>([]);
  const [activeId, setActiveId] = useState('');
  const [ready, setReady] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bản mới nhất để lượt ghi trễ dùng — khỏi phải đưa `tabs` vào deps của
   *  `flush` (làm thế thì mỗi lần gõ lại dựng lại hàm và effect chạy vòng). */
  const pending = useRef<Stored<T> | null>(null);
  /**
   * Gương của `tabs`/`activeId` để callback ASYNC đọc được bản mới nhất.
   *
   * Một query nặng mất vài giây; trong lúc đó người dùng có thể gõ thêm hoặc
   * bấm sang tab khác. Callback nào đọc `tabs` qua closure sẽ thấy ảnh chụp lúc
   * gửi request — sai tab, sai nội dung. Ref luôn trỏ vào hiện tại.
   */
  const tabsRef = useRef<QueryTab<T>[]>([]);
  const activeIdRef = useRef('');
  tabsRef.current = tabs;
  activeIdRef.current = activeId;

  // Đọc MỘT lần cho mỗi connection, trong effect (client-only) chứ không phải
  // trong render — xem ghi chú `ready` ở trên.
  useEffect(() => {
    setReady(false);
    if (!connectionId) { setTabs([]); setActiveId(''); setReady(true); return; }
    const restored = restoreTabs<T>(
      readLocal(storeKey(ns, connectionId)),
      readLocal(legacySessionKey(ns, connectionId)),
      { blank, isValid, titleOf, newId },
    );
    setTabs(restored.tabs);
    setActiveId(restored.activeId);
    setReady(true);
    // `blank`/`isValid`/`titleOf` là hàm thuần khai báo ở cấp module.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ns, connectionId]);

  const flush = useCallback(() => {
    const v = pending.current;
    if (!v || !connectionId) return;
    writeLocal(storeKey(ns, connectionId), JSON.stringify(v));
  }, [ns, connectionId]);

  const queueSave = useCallback((list: QueryTab<T>[], active: string) => {
    if (!connectionId) return;
    pending.current = { activeId: active, tabs: list.slice(0, MAX_TABS) };
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
    // Chỉ ghi lúc trang ĐI KHUẤT: visibilitychange cũng bắn khi quay lại nhìn
    // thấy — ghi lúc đó là thừa và đè lên bằng giá trị cũ.
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushNow(); };
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushNow);
      document.removeEventListener('visibilitychange', onVisibility);
      flushNow(); // unmount (đổi connection, rời tab) cũng phải ghi nốt
    };
  }, [flush]);

  const patchTab = useCallback((id: string, patch: Partial<T> | ((prev: T) => T)) => {
    setTabs((cur) => {
      // Tab đã bị đóng trong lúc chờ → bỏ qua, đừng dựng lại nó từ cõi chết.
      if (!cur.some((t) => t.id === id)) return cur;
      const next = cur.map((t) => {
        if (t.id !== id) return t;
        const state = typeof patch === 'function'
          ? (patch as (prev: T) => T)(t.state)
          : { ...t.state, ...patch };
        return { ...t, state };
      });
      queueSave(next, activeIdRef.current);
      return next;
    });
  }, [queueSave]);

  const update = useCallback(
    (patch: Partial<T> | ((prev: T) => T)) => patchTab(activeId, patch),
    [activeId, patchTab],
  );

  const autoTitle = useCallback((title: string) => {
    if (!title) return;
    setTabs((cur) => {
      const t = cur.find((x) => x.id === activeId);
      // Người dùng đã tự đặt tên, hoặc nhãn vốn đã đúng → đừng đụng vào.
      if (!t || t.pinnedTitle || t.title === title) return cur;
      const next = cur.map((x) => (x.id === activeId ? { ...x, title } : x));
      queueSave(next, activeId);
      return next;
    });
  }, [activeId, queueSave]);

  const rename = useCallback((id: string, title: string) => {
    const clean = title.trim().slice(0, 40);
    if (!clean) return;
    setTabs((cur) => {
      const next = cur.map((x) => (x.id === id ? { ...x, title: clean, pinnedTitle: true } : x));
      queueSave(next, activeId);
      return next;
    });
  }, [activeId, queueSave]);

  /** Chuyển sang tab khác. Việc GHI do effect ngay bên dưới lo — `select` mà tự
   *  ghi thì phải đoán danh sách hiện tại và dễ ghi nhầm một mảng rỗng. */
  const select = useCallback((id: string) => setActiveId(id), []);

  // Nhớ tab ĐANG XEM: mở app lại phải mở đúng tab lúc thoát ra, không phải tab
  // đầu tiên. Ghi kèm danh sách mới nhất (qua ref) nên không cần `tabs` vào deps
  // — nội dung đổi đã có `patchTab` lo rồi, thêm vào đây chỉ tổ ghi hai lần.
  useEffect(() => {
    if (!ready || !connectionId || tabsRef.current.length === 0) return;
    queueSave(tabsRef.current, activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, ready, connectionId]);

  const open = useCallback((seed?: Partial<T>, title?: string) => {
    setTabs((cur) => {
      if (cur.length >= MAX_TABS) return cur;
      const state = { ...blank(), ...(seed ?? {}) } as T;
      const id = newId();
      const next = [...cur, {
        id,
        title: title ?? (titleOf(state) || `Tab ${cur.length + 1}`),
        state,
      }];
      setActiveId(id);
      queueSave(next, id);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueSave]);

  const close = useCallback((id: string) => {
    setTabs((cur) => {
      // Tab cuối cùng đóng lại thì thay bằng một tab trống, không để màn hình
      // rơi vào trạng thái "không có tab nào" — chẳng còn gì để bấm.
      const rest = cur.filter((t) => t.id !== id);
      const next = rest.length > 0 ? rest : [{ id: newId(), title: 'Tab 1', state: blank() }];
      setActiveId((curActive) => {
        if (curActive !== id) { queueSave(next, curActive); return curActive; }
        // Đóng tab đang xem → nhảy sang tab BÊN TRÁI (hoặc tab đầu), giống trình
        // duyệt: chỗ vừa đóng thường là nhánh phụ của việc đang làm ở bên trái.
        const at = cur.findIndex((t) => t.id === id);
        const fallback = next[Math.max(0, Math.min(at - 1, next.length - 1))]?.id ?? '';
        queueSave(next, fallback);
        return fallback;
      });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueSave]);

  const reset = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    pending.current = null;
    if (connectionId) {
      removeLocal(storeKey(ns, connectionId));
      // Dọn luôn phiên đơn đời cũ, không thì lần mở sau nó lại được vớt lên.
      removeLocal(legacySessionKey(ns, connectionId));
    }
    const fresh = [{ id: newId(), title: 'Tab 1', state: blank() }];
    setTabs(fresh);
    setActiveId(fresh[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ns, connectionId]);

  const active = useMemo(() => tabs.find((t) => t.id === activeId) ?? null, [tabs, activeId]);

  return {
    ready, tabs, activeId, active, tabsRef,
    update, patchTab, autoTitle, rename, select, open, close, reset,
  };
}
