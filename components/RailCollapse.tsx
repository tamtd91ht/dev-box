'use client';

// Gập/mở CỘT 2 — cột danh sách của một view (workspace nào, repo nào, hòm thư
// nào…). Dùng chung cho mọi tab có bố cục "danh sách | vùng làm việc".
//
// Vì sao tồn tại: đếm cả menu chính thì các tab này có BA cột, mà cột giữa chỉ
// để chọn — chọn xong là nó ngồi đó ăn 200-320px của đúng chỗ cần rộng nhất.
// Gập lại còn một dải dọc 34px, vùng chính tự nở ra hết phần dư.
//
// Hai luật cứng (giữ nguyên từ ConnRailCollapse — bản chuyên cho cột kết nối):
//   1. Danh sách còn rỗng → BUỘC hiện. Nút "+ Thêm" nằm trong đó, gập là bí.
//   2. Đã gập → luôn còn dải dọc để mở lại, không bao giờ mất lối về.
//
// Lựa chọn nhớ theo TỪNG VIEW qua localStorage (devbox.railcollapse.<key>).

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { readLocal, writeLocal } from '@/lib/localKeys';

/** Bề rộng dải dọc thế chỗ cột đã gập — khớp .rail-strip trong globals.css. */
const STRIP = '34px';

export interface RailCollapse {
  collapsed: boolean;
  hide: () => void;
  show: () => void;
  /**
   * Merge vào style của thẻ layout, SAU style của useSplit:
   * `style={{ ...railSplit.style, ...rail.style }}`.
   *
   * Thu cột bằng chính BIẾN CSS của view (cái mà useSplit cũng ghi vào) thay
   * vì đặt lại grid-template-columns: có view dựng bằng grid, có view bằng
   * flex (.ws-shell) — biến thì cả hai đều nghe.
   */
  style: CSSProperties;
}

/**
 * @param key      tên riêng của view (dùng làm khoá localStorage).
 * @param varName  biến CSS quyết định bề rộng cột 2 của view, vd '--ws-rail'.
 * @param force    buộc hiện, bất kể lựa chọn cũ — truyền `danh sách đang rỗng`.
 */
export function useRailCollapse(key: string, varName: string, force = false): RailCollapse {
  const storageKey = `railcollapse.${key}`;
  const [wantHidden, setWantHidden] = useState(false);
  // Đọc lựa chọn cũ SAU khi mount — đọc thẳng lúc render là hydration mismatch.
  useEffect(() => {
    if (readLocal(storageKey) === '1') setWantHidden(true);
  }, [storageKey]);

  const hide = useCallback(() => { setWantHidden(true); writeLocal(storageKey, '1'); }, [storageKey]);
  const show = useCallback(() => { setWantHidden(false); writeLocal(storageKey, '0'); }, [storageKey]);

  // Rỗng thì XOÁ HẲN lựa chọn cũ chứ không chỉ tạm bỏ qua: giữ lại thì thêm
  // được mục ĐẦU TIÊN là cột tự biến mất ngay trước mắt — trông như lỗi.
  useEffect(() => {
    if (force && wantHidden) { setWantHidden(false); writeLocal(storageKey, '0'); }
  }, [force, wantHidden, storageKey]);

  const collapsed = wantHidden && !force;
  return {
    collapsed, hide, show,
    style: collapsed ? ({ [varName]: STRIP } as CSSProperties) : {},
  };
}

/** Nút « ở header cột 2. `className` cho khớp bộ nút sẵn có của từng view. */
export function RailHideButton({ onHide, className = 'chip-btn', title }: {
  onHide: () => void;
  className?: string;
  title?: string;
}) {
  return (
    <button className={className} onClick={onHide}
      title={title ?? 'Thu gọn cột này — nhường chỗ cho vùng chính. Mở lại bằng dải dọc ở mép trái.'}>
      «
    </button>
  );
}

/** Dải dọc 34px thế chỗ cột đã gập — bấm bất kỳ đâu trên dải để mở lại. */
export function CollapsedRail({ label, count, onShow }: {
  label: string;
  /** Số mục trong danh sách đang bị gập — bỏ trống nếu không đếm được. */
  count?: number;
  onShow: () => void;
}) {
  const text = count === undefined ? label : `${label} · ${count}`;
  return (
    <button className="rail-strip" onClick={onShow} title={`Mở lại cột ${label}`}>
      <span aria-hidden>»</span>
      <span className="rail-strip-label">{text}</span>
    </button>
  );
}
