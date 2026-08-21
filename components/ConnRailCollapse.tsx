'use client';

// Gập/mở CỘT KẾT NỐI (danh sách + form cấu hình — "cột 2") của các tab dữ liệu
// Redis / Kafka / RabbitMQ / MongoDB / Elastic.
//
// Vì sao tồn tại: cấu hình kết nối là việc làm MỘT LẦN, còn vùng làm việc bên
// phải là nơi ngồi cả ngày — cột kết nối chiếm ~300px chỉ để nhắc lại thứ đã
// chọn. Cho ẩn đi để nhường chỗ, nhưng theo hai luật cứng:
//   1. Chưa có kết nối nào → BUỘC hiện (nút "+ Thêm" nằm ở đó, ẩn là bí đường).
//   2. Đã ẩn → luôn có dải dọc ở mép trái để mở lại, không bao giờ mất lối về.
//
// Lựa chọn nhớ theo TỪNG TOOL qua localStorage (devbox.connrail.<tool>).

import { useCallback, useEffect, useState } from 'react';
import { readLocal, writeLocal } from '@/lib/localKeys';

export function useConnRailCollapse(tool: string, connCount: number) {
  const storageKey = `connrail.${tool}`;
  const [wantHidden, setWantHidden] = useState(false);
  // Đọc lựa chọn cũ SAU khi mount — đọc thẳng lúc render là hydration mismatch.
  useEffect(() => {
    if (readLocal(storageKey) === '1') setWantHidden(true);
  }, [storageKey]);

  const hide = useCallback(() => { setWantHidden(true); writeLocal(storageKey, '1'); }, [storageKey]);
  const show = useCallback(() => { setWantHidden(false); writeLocal(storageKey, '0'); }, [storageKey]);

  // Hết sạch kết nối thì xoá luôn lựa chọn "ẩn" cũ chứ không chỉ ghi đè tạm:
  // nếu giữ lại, vừa thêm được kết nối ĐẦU TIÊN là cột tự biến mất ngay trước
  // mắt người dùng — trông như lỗi.
  useEffect(() => {
    if (connCount === 0 && wantHidden) { setWantHidden(false); writeLocal(storageKey, '0'); }
  }, [connCount, wantHidden, storageKey]);

  return { collapsed: wantHidden && connCount > 0, hide, show };
}

/** Nút « đặt cạnh "+ Thêm" ở header cột kết nối — chỉ render khi ≥1 kết nối
 *  (luật 1 ở trên). `className` cho khớp bộ nút sẵn có của từng workspace. */
export function RailHideButton({ onHide, className = 'chip-btn' }: {
  onHide: () => void;
  className?: string;
}) {
  return (
    <button className={className} onClick={onHide}
      title="Ẩn cột kết nối — nhường chỗ cho vùng làm việc. Mở lại bằng dải dọc ở mép trái.">
      «
    </button>
  );
}

/** Dải dọc thế chỗ cột khi đã ẩn — bấm bất kỳ đâu trên dải để mở lại. */
export function CollapsedConnRail({ label, count, onShow }: {
  label: string;
  count: number;
  onShow: () => void;
}) {
  return (
    <button className="connrail-strip" onClick={onShow}
      title={`Hiện cột kết nối (${count} kết nối)`}>
      <span aria-hidden>»</span>
      <span className="connrail-strip-label">{label} · {count}</span>
    </button>
  );
}
