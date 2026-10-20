'use client';

// Thanh BIẾN CỦA REQUEST (ngay dưới ô URL) — thay cho ô chọn "name" chung cũ.
//
// Mỗi biến request đang dùng là một chip `tên: nhãn ▾`; bấm để đổi giá trị
// đang dùng của RIÊNG biến đó (lưu chung cho mọi request, xem varPicks). Biến
// chỉ có một giá trị thì chip chỉ để xem (rê chuột thấy giá trị) — bấm mở hộp
// Biến. Biến chưa khai hiện chip đỏ, bấm để khai luôn.
//
// QuickSwitch (⇄) là phím tắt "đổi cả bộ": mọi biến có giá trị mang nhãn X
// chuyển sang X một lần.

import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { VarInfo } from '@/lib/apiVars';

const labelText = (l: string) => l || 'mặc định';
/** Giá trị dài (token…) chỉ hiện đầu đuôi. */
const short = (v: string) => (v.length > 42 ? `${v.slice(0, 28)}…${v.slice(-8)}` : v);

/** Menu nhỏ neo theo nút bấm — dùng chung khuôn .bt-menu của app. */
function useAnchorMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const openAt = (el: HTMLElement, w = 300, h = 280) => {
    const r = el.getBoundingClientRect();
    setAt({
      x: Math.max(6, Math.min(r.left, window.innerWidth - w - 6)),
      y: r.bottom + h > window.innerHeight - 6 ? Math.max(6, r.top - h - 4) : r.bottom + 4,
    });
  };
  const menu = (body: React.ReactNode) => at && typeof document !== 'undefined' && createPortal(
    <>
      <div className="bt-menu-backdrop" onMouseDown={() => setAt(null)} onContextMenu={(e) => { e.preventDefault(); setAt(null); }} />
      <div className="bt-menu bt-menu-fixed vc-menu" role="menu" style={{ left: at.x, top: at.y }} onMouseDown={(e) => e.stopPropagation()}>
        {body}
      </div>
    </>,
    document.body,
  );
  return { openAt, close: () => setAt(null), menu };
}

function VarChip({ info, onPick, onEdit }: {
  info: VarInfo;
  onPick: (label: string) => void;
  onEdit: () => void;
}) {
  const m = useAnchorMenu();
  const multi = info.options.length > 1;
  const title = `{{${info.key}}} = ${info.value}${info.scope ? `\nKhai ở: ${info.scope}` : '\nKhai ở: biến chung'}`;
  return (
    <>
      <button className={`vc-chip${multi ? ' multi' : ''}`} title={title}
        onClick={(e) => (multi ? m.openAt(e.currentTarget) : onEdit())}>
        <span className="vc-key">{info.key}</span>
        {multi
          ? <><span className="vc-label">{labelText(info.pick)}</span><span className="vc-caret">▾</span></>
          : <span className="vc-val">{short(info.value) || <i>(rỗng)</i>}</span>}
      </button>
      {m.menu(
        <>
          <div className="vc-menu-head">Giá trị của <code>{`{{${info.key}}}`}</code> — áp cho mọi request</div>
          {info.options.map((o, i) => (
            <button key={`${o.label}-${i}`} role="menuitemradio" aria-checked={o.label === info.pick}
              onClick={() => { m.close(); onPick(o.label); }}>
              <span className="bt-menu-check">{o.label === info.pick ? '●' : ''}</span>
              <b className="vc-opt-label">{labelText(o.label)}</b>
              <span className="vc-opt-val">{short(o.value) || '(rỗng)'}</span>
            </button>
          ))}
          <div className="bt-menu-sep" />
          <button onClick={() => { m.close(); onEdit(); }}><span className="bt-menu-check" />✎ Sửa trong hộp Biến…</button>
        </>,
      )}
    </>
  );
}

/** Số chip hiện sẵn — request dùng nhiều biến thì gọn lại thành "+N". */
const CAP = 8;

export default function VarChips({ names, info, onPick, onEdit, onMissing }: {
  /** Tên biến request đang dùng (không tính biến động), theo thứ tự xuất hiện. */
  names: string[];
  info: Record<string, VarInfo>;
  onPick: (info: VarInfo, label: string) => void;
  onEdit: (info: VarInfo) => void;
  /** Bấm chip biến chưa khai. */
  onMissing: (key: string) => void;
}) {
  const [all, setAll] = useState(false);
  if (!names.length) return null;
  // Biến chưa khai lên đầu — đó là thứ làm request hỏng.
  const sorted = [...names.filter((n) => !info[n]), ...names.filter((n) => info[n])];
  const shown = all ? sorted : sorted.slice(0, CAP);
  return (
    <div className="vc-bar" aria-label="Biến của request">
      <span className="vc-ico" title="Biến request này dùng — bấm chip để đổi giá trị">🔣</span>
      {shown.map((n) => (info[n]
        ? <VarChip key={n} info={info[n]} onPick={(l) => onPick(info[n], l)} onEdit={() => onEdit(info[n])} />
        : (
          <button key={n} className="vc-chip missing" onClick={() => onMissing(n)} title="Biến chưa khai ở đâu cả — bấm để khai">
            ⚠ <span className="vc-key">{n}</span> <span className="vc-val">chưa khai</span>
          </button>
        )))}
      {sorted.length > CAP && (
        <button className="vc-chip more" onClick={() => setAll((v) => !v)}>{all ? 'Thu gọn' : `+${sorted.length - CAP}`}</button>
      )}
    </div>
  );
}

/** ⇄ Chuyển nhanh: chọn một nhãn → mọi biến có giá trị mang nhãn đó chuyển sang nó. */
export function QuickSwitch({ labels, counts, current, onSwitch, onManage }: {
  labels: string[];
  /** Số biến có giá trị mang từng nhãn. */
  counts: Record<string, number>;
  /** Nhãn của lần chuyển nhanh gần nhất (để đánh dấu). */
  current: string;
  onSwitch: (label: string) => void;
  /** Mục cuối menu: mở hộp Biến (thanh tab request không còn nút 🔣 riêng). */
  onManage?: () => void;
}) {
  const m = useAnchorMenu();
  if (!labels.length) return null;
  return (
    <>
      <button className="ghost sm" onClick={(e) => m.openAt(e.currentTarget, 260)}
        title="Chuyển nhanh: mọi biến có giá trị mang nhãn đã chọn chuyển sang giá trị đó (biến không có nhãn này giữ nguyên)">
        ⇄ {current || 'Chuyển nhanh'}
      </button>
      {m.menu(
        <>
          <div className="vc-menu-head">Chuyển mọi biến có nhãn… sang nhãn đó</div>
          {labels.map((l) => (
            <button key={l} onClick={() => { m.close(); onSwitch(l); }}>
              <span className="bt-menu-check">{l === current ? '✓' : ''}</span>
              {l}
              <span className="bt-menu-key">{counts[l] ?? 0} biến</span>
            </button>
          ))}
          {onManage && (
            <>
              <div className="bt-menu-sep" />
              <button onClick={() => { m.close(); onManage(); }}><span className="bt-menu-check" />🔣 Quản lý biến…</button>
            </>
          )}
        </>,
      )}
    </>
  );
}
