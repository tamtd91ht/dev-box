'use client';

// NỔI TRÊN <webview> — hai cờ trên <html>, dùng bằng hook thay vì gọi tay.
//
// <webview> của Electron vẽ ở TẦNG NATIVE: nó đè lên mọi phần tử HTML bất kể
// z-index. Menu/hộp thoại của app nằm trong luồng tài liệu bình thường sẽ bị
// trang web trong guest che kín — và vì guest là process riêng, cú bấm lẫn phím
// gõ đi vào TRANG WEB chứ không vào ô nhập. Triệu chứng nhìn thấy luôn là
// "modal mở ra nhưng bấm/gõ không được", rất dễ đoán sai thành lỗi bàn phím.
//
// Cách chữa là bật cờ trên <html>, CSS (app/globals.css) tạm đẩy webview đi:
//
//   • `popup` → data-popup-over-webview: đẩy RIÊNG <webview> ra -200vw. Dùng cho
//     menu/hộp thoại NHỎ — thanh tab, thanh dấu trang, layout còn nguyên nên
//     người dùng vẫn thấy mình đang ở đâu.
//   • `modal` → data-modal-over-webview: đẩy CẢ PANE đi. Chỉ dùng cho hộp thoại
//     PHỦ KÍN màn hình; đem dùng cho menu bé thì mọi thứ phía sau bay theo, bấm
//     chuột phải xong màn hình trắng trơn.
//
// VÌ SAO PHẢI ĐẾM THAM CHIẾU, KHÔNG set/remove trực tiếp:
//
// Cờ nằm trên <html> nên nó DÙNG CHUNG TOÀN APP, không thuộc riêng component
// nào. Trước đây mỗi component tự `setAttribute` lúc mở và `removeAttribute`
// lúc dọn — hai modal mở cùng lúc (bảng ⚙ trên thanh tiêu đề mở đè lên tab
// Browser là trường hợp thật) thì cái nào đóng trước sẽ GỠ SẠCH cờ trong khi
// cái còn lại vẫn đang mở, và cái còn lại lập tức bị webview chôn.
//
// Ở đây mỗi lần bật là +1, mỗi lần dọn là -1; cờ chỉ được gỡ khi bộ đếm về 0.
// Component không cần biết có ai khác đang mở hay không.
//
// Bộ đếm là module-scope: mọi component nạp cùng một module nên chia sẻ một bộ.

import { useEffect } from 'react';

export type OverWebviewKind = 'popup' | 'modal';

const ATTR: Record<OverWebviewKind, string> = {
  popup: 'data-popup-over-webview',
  modal: 'data-modal-over-webview',
};

/** Số chủ thể đang cần mỗi cờ. 0 = không ai cần, gỡ cờ khỏi <html>. */
const refs: Record<OverWebviewKind, number> = { popup: 0, modal: 0 };

function acquire(kind: OverWebviewKind) {
  refs[kind] += 1;
  if (refs[kind] === 1) document.documentElement.setAttribute(ATTR[kind], '1');
}

function release(kind: OverWebviewKind) {
  // Kẹp ở 0: release nhiều hơn acquire (StrictMode gọi cleanup thêm một nhịp)
  // không được đẩy bộ đếm xuống âm, vì sau đó acquire sẽ không bật lại cờ.
  refs[kind] = Math.max(0, refs[kind] - 1);
  if (refs[kind] === 0) document.documentElement.removeAttribute(ATTR[kind]);
}

/**
 * Giữ cờ "nổi trên webview" trong lúc `active` còn true.
 *
 *   usePopupOverWebview(menuOpen || !!ctx)   // menu nhỏ
 *   useModalOverWebview(true)                // modal luôn mở khi đã mount
 *
 * Truyền `false` là nhả — không cần dựng effect riêng để dọn.
 */
export function useOverWebview(
  kind: OverWebviewKind,
  active: boolean,
  opts?: { focusHost?: boolean },
): void {
  const focusHost = !!opts?.focusHost;
  useEffect(() => {
    if (!active) return;
    acquire(kind);
    // Đẩy webview đi chỗ khác KHÔNG lấy lại focus: guest đã offscreen nhưng vẫn
    // cầm focus ở tầng native, nên ô nhập của modal gõ không ra chữ. Chỉ những
    // hộp thoại CÓ ô nhập mới cần gọi (xem workspace:focusHost trong main.cjs).
    if (focusHost) void window.workspace?.focusHost?.().catch(() => {});
    return () => release(kind);
  }, [kind, active, focusHost]);
}

/** Đẩy RIÊNG <webview> — cho menu và hộp thoại nhỏ (giữ được ngữ cảnh sau lưng). */
export function usePopupOverWebview(active: boolean, opts?: { focusHost?: boolean }): void {
  useOverWebview('popup', active, opts);
}

/** Đẩy CẢ PANE — chỉ cho hộp thoại phủ kín màn hình. */
export function useModalOverWebview(active: boolean, opts?: { focusHost?: boolean }): void {
  useOverWebview('modal', active, opts);
}

/**
 * Nhả cờ `kind` trong lúc chạy `fn`, rồi giữ lại như cũ.
 *
 * Dùng khi phải mở HỘP THOẠI NATIVE của Electron (chọn thư mục/lưu file): guest
 * vẫn giữ input ở tầng native, mở dialog trong lúc cờ còn bật thì hộp thoại
 * hiện lên nhưng không bấm được gì. Bọc lời gọi lại là xong — và vì đi qua bộ
 * đếm nên nó không đạp cờ của modal khác đang mở.
 */
export async function withoutOverWebview<T>(kind: OverWebviewKind, fn: () => Promise<T>): Promise<T> {
  const had = refs[kind] > 0;
  if (had) document.documentElement.removeAttribute(ATTR[kind]);
  try {
    return await fn();
  } finally {
    if (had && refs[kind] > 0) document.documentElement.setAttribute(ATTR[kind], '1');
  }
}
