// Đọc một giá trị CHỈ có ở client (cầu Electron window.workspace, safeStorage…)
// mà không làm vỡ hydration.
//
// Gọi thẳng isDesktop() trong render là bẫy: server render ra `false` (không
// có window), client hydrate ra `true` → React báo "Hydration failed" rồi
// dựng lại cả cây con. useSyncExternalStore cho lượt hydrate dùng serverValue
// (khớp HTML server), xong mới render lại bằng giá trị thật của client.
// Giá trị phải bất biến trong suốt phiên — subscribe không bao giờ báo đổi.

import { useSyncExternalStore } from 'react';

const noSubscribe = () => () => {};

export function useClientValue<T>(read: () => T, serverValue: T): T {
  return useSyncExternalStore(noSubscribe, read, () => serverValue);
}
