'use client';

// Ô nhập có GỢI Ý BIẾN {{tên}} — dùng thay <input> ở mọi chỗ của tab API nhận
// biến (URL, Params, Headers, form body, Auth).
//
// Ba cách mở danh sách biến, cùng MỘT popup:
//   · Gõ `{{`            → gợi ý, gõ tiếp để lọc; Enter/Tab chọn, Esc đóng.
//                          `{{#auth` = chỉ biến có tag auth; chip tag ở đầu
//                          popup cũng lọc được.
//   · Bôi đen một biến   → (kéo chuột hoặc double-click vào tên) popup "Đổi
//                          {{x}} thành…" — chọn là thay cả token, khỏi gõ lại.
//   · Chuột phải / Ctrl+Space → đứng trong một biến thì đổi biến đó, đứng ngoài
//                          thì chèn biến tại con trỏ. Menu chuột phải kèm luôn
//                          Cắt / Sao chép / Dán vì nó thay menu mặc định.
//
// Danh sách biến lấy từ VarSuggestProvider (ApiWorkspace bọc ngoài cùng) nên
// KvTable / AuthPanel không phải truyền props xuyên qua.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DYNAMIC_VARS, type VarInfo } from '@/lib/apiVars';
import { TagChip } from './TagEditor';

export interface VarSuggest {
  /** Biến hiệu lực của request đang xem (giá trị đang dùng của từng biến). */
  vars: Record<string, string>;
  /** Chi tiết từng biến (nhãn đang dùng, số giá trị, tag) — để hiện + lọc theo tag. */
  info?: Record<string, VarInfo>;
  /** Mở hộp quản lý biến (mục cuối popup). */
  onManage?: () => void;
}

const Ctx = createContext<VarSuggest | null>(null);
export const VarSuggestProvider = Ctx.Provider;

/** Token {{…}} trong chuỗi — tên cho phép dở dang (đang gõ) nên lỏng hơn VAR_RE. */
const TOKEN_RE = /\{\{\s*([^{}\s]*)\s*\}\}/g;

/** `nameEnd` = vị trí ngay sau tên (trước khoảng trắng / `}}`). */
interface Token { start: number; end: number; name: string; nameEnd: number }

/**
 * Token chứa vùng chọn [s, e]. Con trỏ đơn (s = e) phải nằm HẲN bên trong
 * `{{…}}` — đứng ngay sau `}}` là đang ở ngoài, Ctrl+Space khi đó là chèn.
 * Vùng chọn phải nằm GỌN trong token: bôi đen cả URL (Ctrl+A) hay một đoạn
 * dài có lẫn biến không phải ý "đổi biến này".
 */
export function tokenAt(text: string, s: number, e: number): Token | null {
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const hit = s === e ? start < s && s < end : start <= s && e <= end;
    if (hit) return { start, end, name: m[1], nameEnd: start + m[0].indexOf(m[1], 2) + m[1].length };
  }
  return null;
}

/** `{{abc` đang gõ dở ngay trước con trỏ → vị trí `{{` + phần đã gõ. */
function typingAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /\{\{\s*(#?[\w.$-]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[0].length, query: m[1] } : null;
}

interface Item {
  name: string;
  value: string;
  dynamic: boolean;
  /** Nhãn giá trị đang dùng — chỉ hiện khi biến có nhiều giá trị. */
  label?: string;
  tags: string[];
}

type Mode =
  /** Thay [start, end) bằng `{{tên}}`. */
  | { kind: 'insert'; start: number; end: number; query: string }
  | { kind: 'replace'; start: number; end: number; current: string };

interface PopState { mode: Mode; x: number; y: number; menu: boolean }

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>;

export default function VarInput({ value, onChange, onKeyDown, onBlur, selectOnClick, ...rest }: InputProps & {
  value: string;
  onChange: (v: string) => void;
  /**
   * Click (chuột trái) vào ô CHƯA focus → bôi đen hết, dán / gõ là thay luôn
   * giá trị cũ. Đã focus rồi thì click đặt con trỏ như thường; kéo chuột chọn
   * một đoạn ngay cú click đầu cũng được tôn trọng.
   */
  selectOnClick?: boolean;
}) {
  const ctx = useContext(Ctx);
  /** Cú mousedown vừa rồi là click trái vào ô chưa focus — chờ mouseup để bôi đen hết. */
  const pendingSelect = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  const [pop, setPop] = useState<PopState | null>(null);
  const [hi, setHi] = useState(0);
  /** Chip tag đang chọn ở đầu popup (null = không lọc). */
  const [tagPick, setTagPick] = useState<string | null>(null);

  /** Mọi biến có thể chọn (chưa lọc) — biến khai trước, biến động sau. */
  const pool = useMemo((): Item[] => {
    if (!pop) return [];
    const vars: Item[] = Object.entries(ctx?.vars ?? {}).map(([name, v]) => {
      const i = ctx?.info?.[name];
      return { name, value: v, dynamic: false, label: i && i.options.length > 1 ? i.pick || 'mặc định' : undefined, tags: i?.tags ?? [] };
    });
    const dyn = Object.entries(DYNAMIC_VARS).map(([name, d]) => ({ name, value: d.desc, dynamic: true, tags: [] }));
    return [...vars.sort((a, b) => a.name.localeCompare(b.name)), ...dyn];
  }, [pop, ctx?.vars, ctx?.info]);
  const poolTags = useMemo(() => [...new Set(pool.flatMap((it) => it.tags))].sort((a, b) => a.localeCompare(b)), [pool]);

  const items = useMemo((): Item[] => {
    let all = tagPick ? pool.filter((it) => it.tags.includes(tagPick)) : pool;
    const raw = pop?.mode.kind === 'insert' ? pop.mode.query.toLowerCase() : '';
    if (!raw) return all;
    // `#tag` = lọc theo tag (khớp đầu tag), biến động không có tag nên rơi hết.
    if (raw.startsWith('#')) {
      const t = raw.slice(1);
      return all.filter((it) => it.tags.some((x) => x.toLowerCase().startsWith(t)));
    }
    // Khớp đầu tên lên trước, khớp giữa tên xuống sau.
    all = all.filter((it) => it.name.toLowerCase().includes(raw));
    return [...all.filter((it) => it.name.toLowerCase().startsWith(raw)), ...all.filter((it) => !it.name.toLowerCase().startsWith(raw))];
  }, [pool, pop, tagPick]);

  // Đóng popup thì bỏ lọc tag — lần mở sau bắt đầu sạch.
  useEffect(() => { if (!pop) setTagPick(null); }, [pop]);

  // Mở popup mới (hoặc đổi chế độ) thì đánh dấu sẵn biến hiện tại — đổi biến
  // thường là sang một biến "hàng xóm", mũi tên lên/xuống từ đó là gần nhất.
  const modeKey = pop ? `${pop.mode.kind}:${pop.mode.kind === 'replace' ? pop.mode.current : pop.mode.query}` : '';
  useEffect(() => {
    if (!pop) return;
    const cur = pop.mode.kind === 'replace' ? pop.mode.current : '';
    const i = cur ? items.findIndex((it) => it.name === cur) : -1;
    setHi(Math.max(0, i));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeKey, tagPick]);

  /** Popup neo ngay dưới ô (gõ / bôi đen / Ctrl+Space). */
  const below = (): { x: number; y: number } => {
    const r = ref.current?.getBoundingClientRect();
    return r ? { x: r.left, y: r.bottom + 2 } : { x: 0, y: 0 };
  };

  const open = useCallback((mode: Mode, at?: { x: number; y: number }) => {
    const p = at ?? below();
    setPop({ mode, x: p.x, y: p.y, menu: !!at });
  }, []);
  const close = useCallback(() => setPop(null), []);

  /** Đọc vị trí con trỏ rồi chọn chế độ: trong token → đổi, ngoài → chèn. */
  const modeAtCaret = (): Mode => {
    const el = ref.current;
    const s = el?.selectionStart ?? value.length;
    const e = el?.selectionEnd ?? s;
    const tok = tokenAt(value, s, e);
    if (tok) return { kind: 'replace', start: tok.start, end: tok.end, current: tok.name };
    const t = typingAt(value, s);
    if (t && s === e) return { kind: 'insert', start: t.start, end: s, query: t.query };
    return { kind: 'insert', start: s, end: e, query: '' };
  };

  const pick = (it: Item) => {
    if (!pop) return;
    const { start } = pop.mode;
    let end = pop.mode.end;
    // Gõ `{{ab` mà ngay sau con trỏ còn sót `c}}` / `}}` (ô có sẵn, hoặc sửa
    // giữa chừng) → nuốt luôn phần đuôi đó, không thì ra `{{abc}}c}}`.
    if (pop.mode.kind === 'insert' && pop.mode.start !== pop.mode.end) {
      const tail = /^[\w.$-]*\s*\}\}/.exec(value.slice(end));
      if (tail) end += tail[0].length;
    }
    const tok = `{{${it.name}}}`;
    onChange(value.slice(0, start) + tok + value.slice(end));
    setPop(null);
    const caret = start + tok.length;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  /** Sau mỗi lần gõ: đang gõ `{{…` thì mở/lọc gợi ý, không thì đóng. */
  const onInput = (v: string, caret: number) => {
    onChange(v);
    const t = typingAt(v, caret);
    if (t) setPop((p) => ({ mode: { kind: 'insert', start: t.start, end: caret, query: t.query }, ...(p && !p.menu ? { x: p.x, y: p.y } : below()), menu: false }));
    else if (pop) setPop(null);
  };

  /** Bôi đen chạm vào một biến → mời đổi biến. Con trỏ đơn thì thôi (đỡ phiền). */
  const onSelect = () => {
    const el = ref.current;
    if (!el || pop?.menu) return;
    const s = el.selectionStart ?? 0;
    const e = el.selectionEnd ?? 0;
    if (s === e) {
      if (pop?.mode.kind === 'replace') setPop(null);
      return;
    }
    const tok = tokenAt(value, s, e);
    if (tok) {
      if (pop?.mode.kind === 'replace' && pop.mode.start === tok.start && pop.mode.current === tok.name) return;
      open({ kind: 'replace', start: tok.start, end: tok.end, current: tok.name });
    } else if (pop?.mode.kind === 'replace') {
      setPop(null);
    }
  };

  const keyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      open(modeAtCaret());
      return;
    }
    if (pop && items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => (h + 1) % items.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => (h - 1 + items.length) % items.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(items[Math.min(hi, items.length - 1)]); return; }
    }
    if (pop && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    onKeyDown?.(e);
  };

  const onContextMenu = (e: React.MouseEvent<HTMLInputElement>) => {
    // Chromium đã dời con trỏ tới chỗ bấm (trừ khi bấm vào trong vùng đang
    // chọn) trước khi phát contextmenu — đọc selection lúc này là đúng chỗ.
    e.preventDefault();
    open(modeAtCaret(), { x: e.clientX, y: e.clientY });
  };

  // ── Cắt / Sao chép / Dán cho menu chuột phải (thay menu mặc định) ──
  const sel = () => {
    const el = ref.current;
    return el ? { s: el.selectionStart ?? 0, e: el.selectionEnd ?? 0 } : { s: 0, e: 0 };
  };
  const copySel = async (cut: boolean) => {
    const { s, e } = sel();
    if (s === e) return;
    try { await navigator.clipboard.writeText(value.slice(s, e)); } catch { return; }
    if (cut) onChange(value.slice(0, s) + value.slice(e));
    close();
  };
  const paste = async () => {
    let t = '';
    try { t = await navigator.clipboard.readText(); } catch { close(); return; }
    const { s, e } = sel();
    onChange(value.slice(0, s) + t + value.slice(e));
    close();
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(s + t.length, s + t.length); });
  };

  // Kẹp popup trong màn hình.
  const W = 340;
  const H = 300;
  const style = pop && typeof window !== 'undefined' ? {
    left: Math.max(6, Math.min(pop.x, window.innerWidth - W - 6)),
    top: pop.y + H > window.innerHeight - 6 ? Math.max(6, (pop.menu ? pop.y : pop.y - (ref.current?.offsetHeight ?? 0) - 4) - H) : pop.y,
    width: W,
  } : undefined;
  const hasSel = (() => { const { s, e } = sel(); return s !== e; })();
  const firstDyn = items.findIndex((it) => it.dynamic);

  return (
    <>
      <input
        {...rest}
        ref={ref}
        value={value}
        onChange={(e) => onInput(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onKeyDown={keyDown}
        onSelect={onSelect}
        onContextMenu={onContextMenu}
        onMouseDown={(e) => {
          pendingSelect.current = !!selectOnClick && e.button === 0 && document.activeElement !== e.currentTarget;
        }}
        onMouseUp={(e) => {
          if (!pendingSelect.current) return;
          pendingSelect.current = false;
          const el = e.currentTarget;
          // Bôi đen hết SAU mouseup (trước đó trình duyệt còn đặt con trỏ đè lên).
          // Ô chỉ có đúng một biến → onSelect mở luôn popup đổi biến.
          if (el.selectionStart === el.selectionEnd) el.select();
        }}
        onBlur={(e) => { if (!pop?.menu) close(); onBlur?.(e); }}
      />
      {pop && typeof document !== 'undefined' && createPortal(
        <>
          {pop.menu && <div className="bt-menu-backdrop" style={{ zIndex: 300 }} onMouseDown={close}
            onContextMenu={(e) => { e.preventDefault(); close(); }} />}
          <div className="api-varpop" style={style} role="listbox"
            // Giữ focus ở ô nhập: bấm vào popup không được làm ô mất focus (blur sẽ đóng popup).
            onMouseDown={(e) => e.preventDefault()}>
            <div className="api-varpop-head">
              {pop.mode.kind === 'replace'
                ? <>Đổi <code>{`{{${pop.mode.current}}}`}</code> thành…</>
                : pop.mode.query.startsWith('#') ? <>Biến có tag “{pop.mode.query.slice(1)}”</>
                : pop.mode.query ? <>Biến khớp “{pop.mode.query}”</> : 'Chèn biến'}
              <span style={{ flex: 1 }} />
              <span className="api-varpop-key">↑↓ Enter · Esc · #tag</span>
            </div>
            {poolTags.length > 0 && (
              <div className="api-varpop-tags">
                {poolTags.map((t) => (
                  <TagChip key={t} tag={t} on={tagPick === t} onClick={() => setTagPick((p) => (p === t ? null : t))} />
                ))}
              </div>
            )}
            <div className="api-varpop-list">
              {items.length === 0 && <div className="api-varpop-empty">Không có biến nào khớp.</div>}
              {items.map((it, i) => (
                <div key={it.name}>
                  {i === firstDyn && <div className="api-varpop-group">Biến động</div>}
                  <button
                    role="option"
                    aria-selected={i === hi}
                    className={`api-varpop-item${i === hi ? ' on' : ''}${pop.mode.kind === 'replace' && pop.mode.current === it.name ? ' cur' : ''}`}
                    onMouseEnter={() => setHi(i)}
                    onClick={() => pick(it)}
                    title={it.dynamic ? it.value : `${it.name} = ${it.value}`}
                  >
                    <code>{`{{${it.name}}}`}</code>
                    {it.label && <b className="api-varpop-label">{it.label}</b>}
                    <span className="api-varpop-val">{it.value || <i>(rỗng)</i>}</span>
                    {it.tags.slice(0, 2).map((t) => <TagChip key={t} tag={t} />)}
                  </button>
                </div>
              ))}
            </div>
            {pop.menu && (
              <div className="api-varpop-foot">
                <button onClick={() => void copySel(true)} disabled={!hasSel}>Cắt</button>
                <button onClick={() => void copySel(false)} disabled={!hasSel}>Sao chép</button>
                <button onClick={() => void paste()}>Dán</button>
                <span style={{ flex: 1 }} />
                {ctx?.onManage && <button onClick={() => { close(); ctx.onManage?.(); }}>🔣 Quản lý biến…</button>}
              </div>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
