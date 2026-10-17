'use client';

// Dịch nhanh — một chấm tròn nổi ở mọi view (mount cạnh StockTickerHost trong
// page.tsx, sống NGOÀI mọi pane nên đổi tab vẫn còn).
//
//   • Bấm chấm (hoặc Ctrl+Shift+Y, kể cả khi đang ở trong <webview>) → bảng dịch.
//     Đang bôi đen chữ trong app thì chữ đó được điền sẵn và dịch luôn.
//   • Chip cặp ngôn ngữ (mặc định en→vi): bấm để đổi, ⇄ đảo chiều, ⚙ thêm/bớt cặp.
//   • Gõ là dịch (trễ 400ms), Enter dịch ngay, Shift+Enter xuống dòng.
//   • Hai cột: trái ô nhập, phải bản dịch (nút 📋 Chép). Gợi ý khi gõ (lịch sử
//     tra + online) nằm ngay DƯỚI ô nhập, không che bản dịch. Chữ mờ sau con trỏ là gợi ý
//     đầu tiên — Tab/→ để điền; ↑↓ chọn trong danh sách.
//   • "Xem thêm": cách dịch khác, từ điển theo từ loại, định nghĩa, đồng nghĩa,
//     ví dụ — một lượt gọi nguồn đã trả hết, mở ra không phải chờ.
//   • Kéo chấm đi chỗ khác được; vị trí, cặp ngôn ngữ, lịch sử nhớ theo máy.
//
// <webview> vẽ ở tầng native nên đè chấm này ở tab Browser/Links/Workspace —
// lúc đó dùng Ctrl+Shift+Y (main process chuyển phím từ guest về). Bảng dịch mở
// ra thì bật cờ popup-over-webview để webview tạm dạt sang bên.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useOverWebview } from '@/lib/useOverWebview';
import {
  DEFAULT_PAIRS, LANGS, pairKey, shortLang, speechAudio, suggestText, translateText,
  type LangPair, type TransResult,
} from '@/lib/translate';

const PREFS_KEY = 'qtrans.prefs';
const HISTORY_MAX = 40;

interface Prefs {
  pairs: LangPair[];
  active: string;
  /** Khoảng cách chấm tới mép PHẢI / DƯỚI — đổi kích thước cửa sổ vẫn bám góc. */
  right: number;
  bottom: number;
  history: string[];
}

const DEFAULT_PREFS: Prefs = { pairs: DEFAULT_PAIRS, active: 'en-vi', right: 22, bottom: 64, history: [] };

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PREFS_KEY) || 'null') as Partial<Prefs> | null;
    if (!raw) return DEFAULT_PREFS;
    const pairs = Array.isArray(raw.pairs) && raw.pairs.length ? raw.pairs : DEFAULT_PAIRS;
    return {
      pairs,
      active: pairs.some((p) => pairKey(p) === raw.active) ? String(raw.active) : pairKey(pairs[0]),
      right: Number.isFinite(raw.right) ? Number(raw.right) : DEFAULT_PREFS.right,
      bottom: Number.isFinite(raw.bottom) ? Number(raw.bottom) : DEFAULT_PREFS.bottom,
      history: Array.isArray(raw.history) ? raw.history.map(String).slice(0, HISTORY_MAX) : [],
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

const langName = (code: string) => LANGS.find((l) => l.code === code)?.name ?? code;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Ví dụ của Google có <b> quanh từ đang tra — dựng thành phần tử, không dùng innerHTML. */
function boldParts(s: string): ReactNode[] {
  return s.split(/(<b>.*?<\/b>)/g).map((part, i) => {
    const m = /^<b>(.*)<\/b>$/.exec(part);
    const txt = (m ? m[1] : part).replace(/<[^>]+>/g, '');
    return m ? <b key={i}>{txt}</b> : <span key={i}>{txt}</span>;
  });
}

export default function QuickTranslate() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [editPairs, setEditPairs] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<TransResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sugs, setSugs] = useState<string[]>([]);
  const [sugIdx, setSugIdx] = useState(-1);
  /** Ẩn danh sách gợi ý sau khi vừa chọn / Enter / Esc; gõ tiếp thì hiện lại. */
  const [sugHidden, setSugHidden] = useState(false);
  const [copied, setCopied] = useState(false);
  const [newPair, setNewPair] = useState<LangPair>({ from: 'ja', to: 'vi' });

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const dotRef = useRef<HTMLButtonElement | null>(null);
  const translateAbort = useRef<AbortController | null>(null);
  const suggestAbort = useRef<AbortController | null>(null);

  // localStorage chỉ đọc sau mount — render đầu khớp với SSR.
  useEffect(() => { setPrefs(loadPrefs()); }, []);
  const savePrefs = useCallback((fn: (p: Prefs) => Prefs) => {
    setPrefs((prev) => {
      const next = fn(prev);
      try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* nicety */ }
      return next;
    });
  }, []);

  const pair = prefs.pairs.find((p) => pairKey(p) === prefs.active) ?? prefs.pairs[0] ?? DEFAULT_PAIRS[0];

  useOverWebview('popup', open, { focusHost: true });

  // ── Mở / đóng ───────────────────────────────────────────────────────────────
  const openPanel = useCallback(() => {
    // Chữ đang bôi đen trong app → điền sẵn (bôi đen trong ô dịch thì thôi).
    const sel = window.getSelection()?.toString().trim() ?? '';
    const inside = inputRef.current && document.activeElement === inputRef.current;
    if (sel && !inside && sel.length <= 2000) setQ(sel);
    setOpen(true);
  }, []);
  const toggle = useCallback(() => { if (open) setOpen(false); else openPanel(); }, [open, openPanel]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 30);
    return () => clearTimeout(t);
  }, [open]);

  // Ctrl+Shift+Y: trong khung app bắt ở đây; trong <webview> thì main chuyển về qua onShortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyY') { e.preventDefault(); toggle(); }
      else if (open && e.key === 'Escape') {
        if (allSugsRef.current.length && !sugHiddenRef.current) { setSugHidden(true); return; }
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    const off = window.workspace?.onShortcut?.((name) => { if (name === 'translate') toggle(); });
    return () => { window.removeEventListener('keydown', onKey); off?.(); };
  }, [toggle, open]);

  // ── Dịch ────────────────────────────────────────────────────────────────────
  const run = useCallback(async (text: string, p: LangPair) => {
    translateAbort.current?.abort();
    const t = text.trim();
    if (!t) { setRes(null); setErr(null); setBusy(false); return; }
    const ac = new AbortController();
    translateAbort.current = ac;
    setBusy(true);
    try {
      const r = await translateText(t, p.from, p.to, ac.signal);
      if (ac.signal.aborted) return;
      setRes(r); setErr(null);
      // Chỉ cụm ngắn mới đáng nhớ để gợi ý lại.
      if (t.length <= 80 && !t.includes('\n')) {
        savePrefs((pr) => ({ ...pr, history: [t, ...pr.history.filter((h) => h !== t)].slice(0, HISTORY_MAX) }));
      }
    } catch (e) {
      if (!ac.signal.aborted) { setErr((e as Error).message); setRes(null); }
    } finally {
      if (!ac.signal.aborted) setBusy(false);
    }
  }, [savePrefs]);

  // Gõ là dịch — trễ 400ms để không bắn mỗi phím.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void run(q, pair), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pair theo key là đủ
  }, [q, open, pairKey(pair), run]);

  // ── Gợi ý ───────────────────────────────────────────────────────────────────
  const fromHistory = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return prefs.history.filter((h) => h.toLowerCase().startsWith(t) && h.toLowerCase() !== t).slice(0, 4);
  }, [q, prefs.history]);

  useEffect(() => {
    suggestAbort.current?.abort();
    const t = q.trim();
    if (!open || !t || t.length > 60 || q.includes('\n')) { setSugs([]); return; }
    const ac = new AbortController();
    suggestAbort.current = ac;
    const timer = setTimeout(async () => {
      try {
        const online = await suggestText(q, pair.from, ac.signal);
        if (!ac.signal.aborted) setSugs(online);
      } catch { /* gợi ý hỏng thì thôi, không làm phiền */ }
    }, 220);
    return () => { clearTimeout(timer); ac.abort(); };
  }, [q, open, pair.from]);

  const allSugs = useMemo(
    () => [...new Set([...fromHistory, ...sugs])].filter((s) => s.toLowerCase() !== q.trim().toLowerCase()).slice(0, 6),
    [fromHistory, sugs, q],
  );
  useEffect(() => { setSugIdx(-1); }, [allSugs]);
  // Listener phím Esc đọc qua ref — khỏi gỡ/gắn lại mỗi lần danh sách đổi.
  const allSugsRef = useRef(allSugs);
  allSugsRef.current = allSugs;
  const sugHiddenRef = useRef(sugHidden);
  sugHiddenRef.current = sugHidden;

  /** Gợi ý điền tiếp ngay sau con trỏ (chữ mờ): gợi ý đầu tiên bắt đầu bằng đúng chữ đang gõ. */
  const ghost = useMemo(() => {
    if (!q || sugHidden || q.includes('\n')) return '';
    const hit = allSugs.find((s) => s.toLowerCase().startsWith(q.toLowerCase()) && s.length > q.length);
    return hit ? hit.slice(q.length) : '';
  }, [q, allSugs, sugHidden]);

  const pick = (s: string) => { setQ(s); setSugHidden(true); inputRef.current?.focus(); };

  const onInputKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const list = sugHidden ? [] : allSugs;
    if (e.key === 'ArrowDown' && list.length) { e.preventDefault(); setSugIdx((i) => (i + 1) % list.length); return; }
    if (e.key === 'ArrowUp' && list.length) { e.preventDefault(); setSugIdx((i) => (i <= 0 ? list.length - 1 : i - 1)); return; }
    const caretAtEnd = e.currentTarget.selectionStart === q.length && e.currentTarget.selectionEnd === q.length;
    if ((e.key === 'Tab' || (e.key === 'ArrowRight' && caretAtEnd)) && !e.shiftKey) {
      if (sugIdx >= 0 && list[sugIdx]) { e.preventDefault(); pick(list[sugIdx]); return; }
      if (ghost) { e.preventDefault(); setQ(q + ghost); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (sugIdx >= 0 && list[sugIdx]) { pick(list[sugIdx]); return; }
      setSugHidden(true);
      void run(q, pair);
    }
  };

  // ── Cặp ngôn ngữ ────────────────────────────────────────────────────────────
  const setActive = (p: LangPair) => savePrefs((pr) => ({ ...pr, active: pairKey(p) }));
  const swap = () => {
    // Đang auto → lấy ngôn ngữ đã nhận diện làm đích mới.
    const from = pair.to;
    const to = pair.from === 'auto' ? (res?.src && res.src !== pair.to ? res.src : 'en') : pair.from;
    const np = { from, to };
    savePrefs((pr) => ({
      ...pr,
      pairs: pr.pairs.some((x) => pairKey(x) === pairKey(np)) ? pr.pairs : [...pr.pairs, np],
      active: pairKey(np),
    }));
    if (res?.text) setQ(res.text);
  };
  const addPair = () => {
    if (newPair.from === newPair.to) return;
    savePrefs((pr) => ({
      ...pr,
      pairs: pr.pairs.some((x) => pairKey(x) === pairKey(newPair)) ? pr.pairs : [...pr.pairs, newPair],
      active: pairKey(newPair),
    }));
  };
  const removePair = (p: LangPair) => savePrefs((pr) => {
    const pairs = pr.pairs.filter((x) => pairKey(x) !== pairKey(p));
    if (!pairs.length) return pr; // luôn còn ít nhất một cặp
    return { ...pr, pairs, active: pr.active === pairKey(p) ? pairKey(pairs[0]) : pr.active };
  });

  // ── Tiện ích kết quả ────────────────────────────────────────────────────────
  const copy = async () => {
    if (!res?.text) return;
    try {
      if (window.workspace?.copyText) await window.workspace.copyText(res.text);
      else await navigator.clipboard.writeText(res.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard bị chặn */ }
  };
  // Đọc to: KHÔNG phát thẳng URL Google từ <audio> — renderer gửi Referer
  // localhost và Google trả 404 (bấm loa im lặng). Server tải MP3 về, ở đây
  // phát lần lượt từng đoạn bằng Blob. Bấm lại cùng nút = dừng.
  const [speaking, setSpeaking] = useState<null | 'out' | 'src'>(null);
  const [speakErr, setSpeakErr] = useState<string | null>(null);
  const speechRef = useRef<{ audio: HTMLAudioElement | null; urls: string[]; cancelled: boolean } | null>(null);
  const stopSpeech = useCallback(() => {
    const sp = speechRef.current;
    speechRef.current = null;
    if (sp) {
      sp.cancelled = true;
      sp.audio?.pause();
      sp.urls.forEach((u) => URL.revokeObjectURL(u));
    }
    setSpeaking(null);
  }, []);
  useEffect(() => { if (!open) stopSpeech(); }, [open, stopSpeech]);
  useEffect(() => stopSpeech, [stopSpeech]);

  const speak = async (which: 'out' | 'src', text: string, lang: string) => {
    const again = speaking === which;
    stopSpeech();
    if (again || !text.trim()) return;
    const sp = { audio: null as HTMLAudioElement | null, urls: [] as string[], cancelled: false };
    speechRef.current = sp;
    setSpeaking(which);
    setSpeakErr(null);
    try {
      const { mime, chunks } = await speechAudio(text, lang);
      if (sp.cancelled) return;
      sp.urls = chunks.map((b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return URL.createObjectURL(new Blob([bytes], { type: mime }));
      });
      for (const url of sp.urls) {
        if (sp.cancelled) return;
        const audio = new Audio(url);
        sp.audio = audio;
        await new Promise<void>((resolve, reject) => {
          audio.onended = () => resolve();
          audio.onpause = () => { if (sp.cancelled) resolve(); };
          audio.onerror = () => reject(new Error('Không phát được âm thanh.'));
          audio.play().catch(reject);
        });
      }
    } catch (e) {
      if (!sp.cancelled) setSpeakErr(`Không đọc được: ${(e as Error).message}`);
    } finally {
      if (speechRef.current === sp) stopSpeech();
    }
  };

  // ── Kéo chấm ────────────────────────────────────────────────────────────────
  const drag = useRef<{ x: number; y: number; right: number; bottom: number; moved: boolean } | null>(null);
  const onDotDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, right: prefs.right, bottom: prefs.bottom, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDotMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    const right = clamp(d.right - dx, 4, window.innerWidth - 40);
    const bottom = clamp(d.bottom - dy, 4, window.innerHeight - 40);
    setPrefs((p) => ({ ...p, right, bottom }));
  };
  const onDotUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) savePrefs((p) => p); // ghi vị trí mới
    else toggle();
  };

  /** Bảng mở về PHÍA TRONG màn hình tính từ chấm. */
  const panelStyle = useMemo((): CSSProperties => {
    const vw = typeof window === 'undefined' ? 1600 : window.innerWidth;
    const vh = typeof window === 'undefined' ? 900 : window.innerHeight;
    const s: CSSProperties = {};
    if (prefs.right < vw / 2) s.right = prefs.right; else s.left = vw - prefs.right - 34;
    if (prefs.bottom < vh / 2) s.bottom = prefs.bottom + 44; else s.top = vh - prefs.bottom + 6;
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tính lại khi mở / dời chấm
  }, [prefs.right, prefs.bottom, open]);

  const hasMore = !!res && (res.dict.length + res.definitions.length + res.synonyms.length
    + res.examples.length + res.alternatives.length) > 0;
  const showSugs = !sugHidden && allSugs.length > 0 && !q.includes('\n');

  return (
    <>
      <button
        ref={dotRef}
        className={`qtr-dot${open ? ' on' : ''}`}
        style={{ right: prefs.right, bottom: prefs.bottom }}
        title="Dịch nhanh (Ctrl+Shift+Y) — kéo để dời chỗ"
        aria-label="Dịch nhanh"
        aria-expanded={open}
        // Không cho chấm giành focus — focus phải vào ô nhập của bảng vừa mở.
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={onDotDown}
        onPointerMove={onDotMove}
        onPointerUp={onDotUp}
        onPointerCancel={() => { drag.current = null; }}
      >
        <span aria-hidden>文</span>
        <span className="qtr-dot-pair" aria-hidden>{shortLang(pair.from)}→{shortLang(pair.to)}</span>
      </button>

      {open && (
        <div className={`qtr-panel${more ? ' more' : ''}`} style={panelStyle} role="dialog" aria-label="Dịch nhanh">
          <div className="qtr-head">
            <div className="qtr-pairs">
              {prefs.pairs.map((p) => (
                <button
                  key={pairKey(p)}
                  className={`qtr-chip${pairKey(p) === pairKey(pair) ? ' on' : ''}`}
                  onClick={() => setActive(p)}
                  title={`${langName(p.from)} → ${langName(p.to)}`}
                >{shortLang(p.from)}→{shortLang(p.to)}</button>
              ))}
            </div>
            <button className="qtr-ico" onClick={swap} title="Đảo chiều dịch (dùng bản dịch làm câu nguồn)">⇄</button>
            <button className={`qtr-ico${editPairs ? ' on' : ''}`} onClick={() => setEditPairs((v) => !v)} title="Thêm / bớt cặp ngôn ngữ">⚙</button>
            <button className="qtr-ico" onClick={() => setOpen(false)} title="Đóng (Esc)">✕</button>
          </div>

          {editPairs && (
            <div className="qtr-pairedit">
              <div className="qtr-pairlist">
                {prefs.pairs.map((p) => (
                  <span key={pairKey(p)} className="qtr-pairitem">
                    {langName(p.from)} → {langName(p.to)}
                    <button onClick={() => removePair(p)} disabled={prefs.pairs.length <= 1} title="Bỏ cặp này">✕</button>
                  </span>
                ))}
              </div>
              <div className="qtr-pairadd">
                <select value={newPair.from} onChange={(e) => setNewPair((n) => ({ ...n, from: e.target.value }))}>
                  {LANGS.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                </select>
                <span>→</span>
                <select value={newPair.to} onChange={(e) => setNewPair((n) => ({ ...n, to: e.target.value }))}>
                  {LANGS.filter((l) => l.code !== 'auto').map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                </select>
                <button className="sm" onClick={addPair} disabled={newPair.from === newPair.to}>＋ Thêm</button>
              </div>
            </div>
          )}

          {/* Hai cột: trái là ô nhập + gợi ý (nằm TRONG luồng ngay dưới ô nhập,
              không nổi đè), phải là bản dịch — gợi ý dài cỡ nào cũng không che kết quả. */}
          <div className="qtr-body">
            <div className="qtr-col">
              <div className="qtr-inwrap">
                {/* Lớp chữ mờ nằm dưới ô nhập, cùng font/padding: phần đã gõ trong suốt,
                    phần gợi ý hiện mờ ngay sau con trỏ. */}
                <div className="qtr-ghost" aria-hidden>
                  <span className="qtr-ghost-typed">{q}</span>
                  <span className="qtr-ghost-rest">{ghost}</span>
                </div>
                <textarea
                  ref={inputRef}
                  className="qtr-input"
                  value={q}
                  placeholder={`Nhập ${pair.from === 'auto' ? 'chữ' : langName(pair.from)} cần dịch…`}
                  spellCheck={false}
                  onChange={(e) => { setQ(e.target.value); setSugHidden(false); }}
                  onKeyDown={onInputKey}
                />
                {q && <button className="qtr-clear" onClick={() => { setQ(''); setRes(null); inputRef.current?.focus(); }} title="Xoá">×</button>}
                {/* Đọc câu gốc. Nguồn "auto" thì lấy ngôn ngữ Google đã nhận diện;
                    chưa dịch xong thì đoán tạm là tiếng Anh. */}
                <button
                  className={`qtr-ico qtr-speak-in${speaking === 'src' ? ' on' : ''}`}
                  onClick={() => void speak('src', q, pair.from !== 'auto' ? pair.from : res?.src ?? 'en')}
                  disabled={!q.trim()}
                  title={speaking === 'src' ? 'Dừng đọc' : 'Đọc câu gốc'}
                >{speaking === 'src' ? '⏹' : '🔊'}</button>
              </div>
              {showSugs ? (
                <div className="qtr-sugs" role="listbox">
                  {allSugs.map((s, i) => (
                    <button
                      key={s}
                      role="option"
                      aria-selected={i === sugIdx}
                      className={`qtr-sug${i === sugIdx ? ' on' : ''}`}
                      onMouseDown={(e) => { e.preventDefault(); pick(s); }}
                    >
                      <span className="qtr-sug-ico" aria-hidden>{fromHistory.includes(s) ? '🕘' : '🔍'}</span>{s}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="qtr-keys">Enter dịch · Tab/→ điền gợi ý · ↑↓ chọn · Shift+Enter xuống dòng</div>
              )}
            </div>

            <div className="qtr-col">
              <div className="qtr-out">
                {err ? (
                  <div className="qtr-err">{err}</div>
                ) : res ? (
                  <>
                    {res.didYouMean && (
                      <div className="qtr-dym">
                        Có phải: <button onClick={() => pick(res.didYouMean!)}>{res.didYouMean}</button>
                      </div>
                    )}
                    <div className={`qtr-text${busy ? ' stale' : ''}`}>{res.text}</div>
                    {res.translit && <div className="qtr-translit">{res.translit}</div>}
                  </>
                ) : (
                  <div className="qtr-empty">{busy ? 'Đang dịch…' : 'Bản dịch hiện ở đây.'}</div>
                )}
              </div>
              <div className="qtr-actions">
                <button className={`qtr-copy${copied ? ' done' : ''}`} onClick={() => void copy()} disabled={!res?.text}
                  title="Chép bản dịch vào clipboard">{copied ? '✓ Đã chép' : '📋 Chép'}</button>
                <button className={`qtr-ico${speaking === 'out' ? ' on' : ''}`} onClick={() => res && void speak('out', res.text, pair.to)}
                  disabled={!res?.text} title={speaking === 'out' ? 'Dừng đọc' : 'Đọc bản dịch'}>{speaking === 'out' ? '⏹' : '🔊'}</button>
                <span className={`qtr-meta${speakErr ? ' bad' : ''}`} title={speakErr ?? undefined}>
                  {speakErr && <>{speakErr} · </>}
                  {res && pair.from === 'auto' && <>nhận diện: <b>{langName(res.src)}</b> · </>}
                  {res?.srcTranslit && <>/{res.srcTranslit}/ · </>}
                  {res?.engine}
                </span>
                {hasMore && (
                  <button className={`qtr-more${more ? ' on' : ''}`} onClick={() => setMore((v) => !v)}>
                    {more ? '⤡ Thu gọn' : '⤢ Xem thêm'}
                  </button>
                )}
              </div>
            </div>
          </div>

          {more && res && (
            <div className="qtr-ext">
              {res.alternatives.length > 0 && (
                <section>
                  <h4>Cách dịch khác</h4>
                  <div className="qtr-tags">
                    {res.alternatives.map((a) => <span key={a} className="qtr-tag">{a}</span>)}
                  </div>
                </section>
              )}
              {res.dict.length > 0 && (
                <section>
                  <h4>Từ điển</h4>
                  {res.dict.map((d) => (
                    <div key={d.pos} className="qtr-pos">
                      <i>{d.pos}</i>
                      <ul>
                        {d.entries.map((e) => (
                          <li key={e.word}><b>{e.word}</b>{e.reverse.length > 0 && <span className="qtr-rev"> — {e.reverse.join(', ')}</span>}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </section>
              )}
              {res.definitions.length > 0 && (
                <section>
                  <h4>Định nghĩa</h4>
                  {res.definitions.map((d) => (
                    <div key={d.pos} className="qtr-pos">
                      <i>{d.pos}</i>
                      <ol>
                        {d.items.map((it, i) => (
                          <li key={i}>{it.gloss}{it.example && <div className="qtr-ex">“{it.example}”</div>}</li>
                        ))}
                      </ol>
                    </div>
                  ))}
                </section>
              )}
              {res.synonyms.length > 0 && (
                <section>
                  <h4>Đồng nghĩa <span className="qtr-hint">(bấm để tra)</span></h4>
                  {res.synonyms.map((s) => (
                    <div key={s.pos} className="qtr-pos">
                      <i>{s.pos}</i>
                      <div className="qtr-tags">
                        {s.words.map((w) => <button key={w} className="qtr-tag" onClick={() => pick(w)}>{w}</button>)}
                      </div>
                    </div>
                  ))}
                </section>
              )}
              {res.examples.length > 0 && (
                <section>
                  <h4>Ví dụ</h4>
                  <ul className="qtr-exs">
                    {res.examples.map((x, i) => <li key={i}>{boldParts(x)}</li>)}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
