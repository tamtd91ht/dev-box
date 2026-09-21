'use client';

// Thanh tab query — dùng chung cho MongoDB và PostgreSQL (xem lib/queryTabs).
//
// Cách dùng giống hệt tab trình duyệt: bấm để chuyển, ✕ để đóng, + để mở tab
// mới, BẤM ĐÚP để đặt tên tay. Nhãn tự đổi theo bảng/collection đang chọn cho
// tới khi người dùng đặt tên — lúc đó nó đứng yên (xem `pinnedTitle`).
//
// Chuột giữa cũng đóng tab, theo thói quen từ trình duyệt.

import { useEffect, useRef, useState } from 'react';
import type { QueryTab } from '@/lib/queryTabs';
import { MAX_TABS } from '@/lib/queryTabs';

export default function QueryTabBar<T>({ tabs, activeId, onSelect, onOpen, onClose, onRename }: {
  tabs: QueryTab<T>[];
  activeId: string;
  onSelect: (id: string) => void;
  onOpen: () => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  /** Tab đang được đổi tên tại chỗ (null = không có). */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    if (editing && draft.trim()) onRename(editing, draft);
    setEditing(null);
  };

  const full = tabs.length >= MAX_TABS;

  return (
    <div className="qtabs" role="tablist">
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === activeId}
          className={`qtab${t.id === activeId ? ' on' : ''}`}
          onMouseDown={(e) => {
            // Chuột giữa = đóng, như trình duyệt. Chặn auto-scroll của trình duyệt.
            if (e.button === 1) { e.preventDefault(); onClose(t.id); }
          }}
          onClick={() => { if (editing !== t.id) onSelect(t.id); }}
          onDoubleClick={() => { setEditing(t.id); setDraft(t.title); }}
          title={editing === t.id ? undefined : `${t.title}\n\nBấm đúp để đổi tên · chuột giữa để đóng`}
        >
          {editing === t.id ? (
            <input
              ref={inputRef}
              className="qtab-rename"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                // Esc = bỏ đổi tên, giữ nguyên nhãn cũ.
                else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
                // Thanh tab nằm trong ô query của cả màn hình; đừng để phím lọt
                // ra ngoài thành phím tắt (Ctrl+Enter chạy query chẳng hạn).
                e.stopPropagation();
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              <span className="qtab-label">{t.title}</span>
              <button
                className="qtab-x"
                title="Đóng tab"
                onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
              >✕</button>
            </>
          )}
        </div>
      ))}
      <button
        className="qtab-add"
        onClick={onOpen}
        disabled={full}
        title={full ? `Tối đa ${MAX_TABS} tab` : 'Mở tab query mới (giữ nguyên tab đang làm dở)'}
      >+</button>
    </div>
  );
}
