'use client';

// ULTRA VIEW — nút bật/tắt + bảng chọn pane trên thanh tiêu đề.
//
// Ultra View cho xem NHIỀU workspace một lúc: kéo log Kafka ra cạnh Git để vừa
// sửa vừa dòm, hay để Mail bên phải trong lúc truy vấn PostgreSQL bên trái.
// Tối đa 4 pane (lib/ultraView · MAX_PANES).
//
// Bảng chọn liệt kê mọi tab; bấm để thêm/bỏ khỏi khung nhìn, kèm mấy bố cục
// dựng sẵn hay dùng. Trạng thái nằm hết trong lib/ultraView (localStorage) nên
// đóng app mở lại vẫn đúng bố cục cũ.
//
// Bật/tắt KHÔNG dựng lại workspace nào: pane vốn mount một lần rồi giữ mãi,
// đây chỉ đổi chỗ đặt chúng — kết nối, kết quả truy vấn, phiên webview còn nguyên.

import { useEffect, useRef, useState } from 'react';
import * as ultraView from '@/lib/ultraView';
import { MAX_PANES, type UltraState } from '@/lib/ultraView';
import type { TabInfo } from './QuickTabs';
import { useModalOverWebview } from '@/lib/useOverWebview';

export interface UltraBarProps {
  state: UltraState;
  /** Tab đang mở — làm pane đầu tiên khi bật từ chế độ một tab. */
  current: string;
  /** Mọi khoá tab có thể đưa vào khung nhìn, theo thứ tự trên thanh menu. */
  allKeys: string[];
  /** Tra nhãn cho một khoá tab; undefined nghĩa là tab không còn (pack bị gỡ). */
  info: (key: string) => TabInfo | undefined;
}

/** Vài bố cục hay dùng — bấm một phát là có, khỏi tick từng tab. */
const PRESETS: { label: string; hint: string; panes: string[] }[] = [
  { label: 'Git · Code', hint: 'sửa code cạnh khung commit', panes: ['git', 'code'] },
  { label: 'Git · Công việc', hint: 'bám đầu việc trong lúc làm', panes: ['work', 'git'] },
  { label: 'Kafka · Redis', hint: 'so message với cache', panes: ['kafka', 'redis'] },
  { label: 'PostgreSQL · Mail', hint: 'tra cứu cạnh hòm thư', panes: ['pg', 'mail'] },
];

export default function UltraBar({ state, current, allKeys, info }: UltraBarProps) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Bấm ra ngoài / Esc → đóng bảng, như mọi dropdown khác trong app.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // <webview> của Electron vẽ ở TẦNG NATIVE riêng, nằm trên mọi phần tử HTML bất
  // kể z-index (xem ghi chú ở paneStyle trong app/page.tsx). Nên khi Ultra View
  // bật, các pane Links/Browser/Workspace che mất bảng chọn này — không có giá
  // trị z-index nào cứu được.
  // Cách duy nhất là tạm ĐẨY chúng ra khỏi màn hình trong lúc bảng mở: đặt cờ
  // trên <html>, CSS lo phần còn lại. Webview vẫn sống, vẫn giữ phiên đăng nhập
  // và trạng thái cuộn — chỉ là không thấy trong mấy giây bảng đang mở.
  useModalOverWebview(open);

  const { on, panes } = state;
  const full = panes.length >= MAX_PANES;

  return (
    <div className="ultra" ref={boxRef}>
      <button
        className={`ultra-btn${on ? ' is-on' : ''}`}
        onClick={() => ultraView.toggle(current)}
        title={
          on
            ? `Ultra View đang bật (${panes.length} khung) — bấm để về xem một tab · Ctrl+Shift+U`
            : 'Ultra View — xem nhiều workspace cùng lúc · Ctrl+Shift+U'
        }
        aria-pressed={on}
      >
        <span className="ultra-ico" aria-hidden>▥</span>
        Ultra
        {on && <span className="ultra-count">{panes.length}</span>}
      </button>

      <button
        className={`ultra-more${open ? ' is-on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Chọn workspace hiện trong Ultra View"
        aria-label="Chọn khung nhìn"
      >
        ▾
      </button>

      {open && (
        <>
          {/* Nền mờ: vừa để bấm ra ngoài đóng bảng, vừa tách bảng khỏi mớ khung
              phía sau cho dễ đọc. Cùng lối với .ntc-scrim ở NotificationCenter. */}
          <div className="ultra-scrim" onClick={() => setOpen(false)} aria-hidden />
        <div className="ultra-pop" role="dialog" aria-label="Chọn khung nhìn Ultra View">
          <div className="ultra-pop-head">
            <div>
              <b>Ultra View</b>
              <span className="ultra-pop-sub">
                xem nhiều workspace cùng lúc — tối đa {MAX_PANES} khung
              </span>
            </div>
            <button className="ultra-pop-x" onClick={() => setOpen(false)} aria-label="Đóng">×</button>
          </div>

          {/* Đang chọn những gì, theo thứ tự trái → phải. Sắp lại bằng ◀ ▶. */}
          {panes.length > 0 && (
            <div className="ultra-sel">
              {panes.map((k, i) => {
                const t = info(k);
                return (
                  <div className="ultra-chip" key={k}>
                    <span className="ultra-chip-ico" aria-hidden>{t?.icon ?? '▤'}</span>
                    <span className="ultra-chip-label">{t?.label ?? k}</span>
                    <button
                      className="ultra-chip-mv"
                      disabled={i === 0}
                      onClick={() => ultraView.move(k, -1)}
                      title="Sang trái"
                    >
                      ◀
                    </button>
                    <button
                      className="ultra-chip-mv"
                      disabled={i === panes.length - 1}
                      onClick={() => ultraView.move(k, 1)}
                      title="Sang phải"
                    >
                      ▶
                    </button>
                    <button
                      className="ultra-chip-x"
                      onClick={() => ultraView.remove(k)}
                      title="Bỏ khung này"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="ultra-pop-label">Bố cục dựng sẵn</div>
          <div className="ultra-presets">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className="ultra-preset"
                onClick={() => ultraView.setPanes(p.panes)}
                title={p.hint}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="ultra-pop-label">Chọn workspace</div>
          <div className="ultra-list">
            {allKeys.map((k) => {
              const t = info(k);
              if (!t) return null;
              const picked = panes.includes(k);
              return (
                <button
                  key={k}
                  className={`ultra-item${picked ? ' is-on' : ''}`}
                  // Đủ 4 khung rồi thì tab chưa chọn vẫn bấm được: ultraView.add
                  // thay khung ngoài cùng phải — nhưng báo trước qua title.
                  title={
                    picked
                      ? 'Bỏ khỏi khung nhìn'
                      : full
                        ? `Đã đủ ${MAX_PANES} khung — sẽ thay khung ngoài cùng phải`
                        : 'Thêm vào khung nhìn'
                  }
                  onClick={() => ultraView.togglePane(k)}
                >
                  <span className="ultra-item-ico" aria-hidden>{t.icon}</span>
                  <span className="ultra-item-label">{t.label}</span>
                  {picked && <span className="ultra-item-tick" aria-hidden>✓</span>}
                </button>
              );
            })}
          </div>

          {on && (
            <button className="ultra-off" onClick={() => ultraView.disable()}>
              Tắt Ultra View — về xem một tab
            </button>
          )}
        </div>
        </>
      )}
    </div>
  );
}
