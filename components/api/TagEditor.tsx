'use client';

// Ô sửa TAG dạng chip — tag tự gán cho biến của tab API (vd auth, user, core).
// Gõ rồi Enter / dấu phẩy để chốt, ✕ để gỡ, Backspace ở ô trống gỡ tag cuối.
// Chọn một gợi ý trong datalist là chốt luôn, khỏi bấm Enter.

import { useState } from 'react';

/** Màu ổn định theo tên tag — cùng tag luôn cùng màu ở mọi chỗ (bảng, chip lọc, popup). */
export function tagHue(tag: string): number {
  let h = 0;
  for (const c of tag.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function TagChip({ tag, onRemove, onClick, on, count }: {
  tag: string;
  onRemove?: () => void;
  onClick?: () => void;
  /** Chip lọc đang chọn. */
  on?: boolean;
  count?: number;
}) {
  const style = { '--tag-h': tagHue(tag) } as React.CSSProperties;
  const body = <>{tag}{count !== undefined && <span className="api-tag-n">{count}</span>}</>;
  return onClick ? (
    <button type="button" className={`api-tag is-btn${on ? ' on' : ''}`} style={style} onClick={onClick} aria-pressed={on}>{body}</button>
  ) : (
    <span className="api-tag" style={style}>
      {body}
      {onRemove && <button type="button" className="api-tag-x" onClick={onRemove} title={`Gỡ tag ${tag}`}>✕</button>}
    </span>
  );
}

/** Thêm các tag mới (bỏ trùng không phân biệt hoa/thường), tối đa 10 — khớp cleanTags bên server. */
export function addTags(tags: string[], more: string[]): string[] {
  const out = [...tags];
  for (const raw of more) {
    const t = raw.trim().slice(0, 40);
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.slice(0, 10);
}

export default function TagEditor({ tags, onChange, listId, placeholder = '＋ tag' }: {
  tags: string[];
  onChange: (tags: string[]) => void;
  /** id của <datalist> gợi ý (tag đã dùng) — render một lần ở component cha. */
  listId?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const commit = (raw: string) => {
    const parts = raw.split(',').map((t) => t.trim()).filter(Boolean);
    setText('');
    if (parts.length) onChange(addTags(tags, parts));
  };
  return (
    <div className="api-tags">
      {tags.map((t) => <TagChip key={t} tag={t} onRemove={() => onChange(tags.filter((x) => x !== t))} />)}
      <input
        className="api-tag-input"
        list={listId}
        value={text}
        placeholder={tags.length ? '' : placeholder}
        onChange={(e) => {
          const v = e.target.value;
          // Chọn từ datalist = chốt luôn; gõ dấu phẩy = chốt phần trước dấu phẩy.
          if ((e.nativeEvent as InputEvent).inputType === 'insertReplacementText' || v.includes(',')) commit(v);
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(text); }
          else if (e.key === 'Backspace' && !text && tags.length) onChange(tags.slice(0, -1));
        }}
        onBlur={() => commit(text)}
      />
    </div>
  );
}
