'use client';

// Khung mục lục bên trái Word workspace: liệt kê các đoạn mang kiểu
// Tiêu đề / Đề mục 1-4 theo đúng thứ tự trong tài liệu, bấm vào là nhảy tới.
// Đây là mục lục ĐỘNG để điều hướng khi soạn — không phải bảng mục lục chèn
// vào file (muốn có mục lục in ra thì tạo trong Word).

import type { OutlineEntry } from '@/lib/wordDocUtils';

export interface WordOutlineProps {
  entries: OutlineEntry[];
  /** Block đang chọn — để bôi sáng mục tương ứng. */
  current: number | null;
  onJump: (i: number) => void;
}

export default function WordOutline({ entries, current, onJump }: WordOutlineProps) {
  return (
    <aside className="word-outline">
      <div className="group-title" style={{ margin: '0 0 6px' }}>Mục lục</div>
      {entries.length === 0 ? (
        <p className="small" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
          Chưa có đề mục nào. Chọn một đoạn rồi đặt kiểu <b>Đề mục 1/2/3</b> ở thanh
          định dạng — đoạn đó sẽ hiện ở đây.
        </p>
      ) : (
        <nav className="word-outline-list">
          {entries.map((e) => (
            <button
              key={e.i}
              className={`word-outline-item lvl${e.level}${current === e.i ? ' on' : ''}`}
              onClick={() => onJump(e.i)}
              title={`Nhảy tới: ${e.text}`}
            >
              {e.text}
            </button>
          ))}
        </nav>
      )}
    </aside>
  );
}
