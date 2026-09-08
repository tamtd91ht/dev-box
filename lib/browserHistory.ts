// Client helpers cho lịch sử truy cập của tab Browser. Browser-safe.
//
// GHI thì "bắn rồi quên" (fire-and-forget): điều hướng không được phải chờ một
// round-trip API mới hiện trang. Lỗi ghi lịch sử chỉ làm mất một dòng gợi ý,
// KHÔNG được nổi thành lỗi trên giao diện.

export interface HistoryEntry {
  url: string;
  title: string;
  host: string;
  visitCount: number;
  lastVisit: string;
  firstVisit: string;
}

async function hAction<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/browser-history', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  }
  return (data as { result: T }).result;
}

/** Đánh dấu "đã xem trang này". Không throw — xem ghi chú đầu file. */
export function historyVisit(url: string, title = ''): void {
  void hAction('visit', { url, title }).catch(() => {});
}

/** Trang load xong mới có <title> → cập nhật riêng tiêu đề. Không throw. */
export function historyTitle(url: string, title: string): void {
  if (!title.trim()) return;
  void hAction('title', { url, title }).catch(() => {});
}

export const historyList = (q = '', limit = 200) => hAction<HistoryEntry[]>('list', { q, limit });
export const historyRemove = (url: string) => hAction<unknown>('remove', { url });
export const historyRemoveHost = (host: string) => hAction<unknown>('remove', { host });
export const historyClear = () => hAction<unknown>('clear');

/**
 * Gợi ý cho ô địa chỉ, CHỐNG GÕ DỒN.
 *
 * Mỗi ký tự gõ ra một lần gọi API là vừa vô ích vừa dễ trả về LỆCH THỨ TỰ:
 * request của "kib" có thể về sau request của "kiba" và ghi đè danh sách bằng
 * kết quả cũ. Nên ở đây:
 *  - hoãn `DELAY` ms, cú gõ tiếp theo huỷ cú trước;
 *  - đánh số thứ tự mỗi lần gọi, kết quả về mà đã có lần gọi mới hơn thì bỏ.
 *
 * Trả về hàm `cancel` để component gọi khi unmount / khi đóng danh sách gợi ý.
 */
const DELAY = 120;

export function makeSuggester(onResult: (list: HistoryEntry[], forQuery: string) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  let live = true;

  const cancel = () => { if (timer) { clearTimeout(timer); timer = undefined; } };

  const query = (q: string, limit = 8) => {
    cancel();
    if (!live) return;
    const mine = ++seq;
    timer = setTimeout(() => {
      void hAction<HistoryEntry[]>('suggest', { q, limit })
        .then((list) => { if (live && mine === seq) onResult(list, q); })
        .catch(() => { if (live && mine === seq) onResult([], q); });
    }, DELAY);
  };

  /** Bỏ hẳn — mọi kết quả đang bay về sau đó đều bị lờ đi. */
  const dispose = () => { live = false; cancel(); };

  return { query, cancel, dispose };
}
