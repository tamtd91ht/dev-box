'use client';

// Tab "Tìm & thay" trong Tools — thay chuỗi hàng loạt, giống mấy trang
// "string replace online" nhưng nằm luôn trong app (không phải dán dữ liệu nội
// bộ lên web lạ, đó mới là lý do chính nó tồn tại ở đây).
//
//   TRÁI  ô nhập: chuỗi gốc + "tìm gì" + "thay bằng gì"
//   PHẢI  kết quả, cập nhật NGAY khi gõ (không phải bấm mới thấy)
//
// HAI CHẾ ĐỘ, mặc định THƯỜNG:
//   · Thường — tìm đúng từng ký tự. Gõ "." là tìm dấu chấm thật, gõ "$5" ở ô
//     thay ra đúng "$5". Người không biết regex dùng được ngay mà không dính bẫy.
//   · Regex  — biểu thức chính quy đầy đủ, có $1/$2 để dùng lại nhóm bắt được.
//     Bật lên mới hiện thêm cờ ^$ theo dòng / . khớp xuống dòng, để chế độ
//     thường không bị rối bởi thứ nó không dùng tới.
//
// Toàn bộ phép thay nằm ở lib/replace.ts (hàm thuần, đã test). Ở đây chỉ là vỏ.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_OPTIONS, runReplace, summarize,
  type ReplaceMode, type ReplaceOptions,
} from '@/lib/replace';
import { useSplit } from '@/lib/useSplit';
import Splitter from './Splitter';

/** Nhớ tuỳ chọn giữa các lần mở — chuỗi thì không nhớ (dữ liệu tạm). */
const OPT_KEY = 'tools.replaceOpts';
/** Trần khớp trong lib; chạm trần thì đếm hiện "999+". */
const MATCH_LIMIT = 5000;

/** Ví dụ bấm phát dùng luôn — dạy regex nhanh hơn mọi đoạn văn giải thích. */
const SAMPLES: { label: string; find: string; repl: string; hint: string }[] = [
  { label: 'Gộp khoảng trắng', find: '\\s+', repl: ' ', hint: 'nhiều dấu cách/tab liền nhau → một dấu cách' },
  { label: 'Xoá dòng trống', find: '\\n{2,}', repl: '\\n', hint: 'hai dòng xuống trở lên → một' },
  { label: 'Đảo "họ tên"', find: '(\\w+) (\\w+)', repl: '$2 $1', hint: 'dùng $1/$2 lấy lại nhóm bắt được' },
  { label: 'Bỏ số', find: '\\d+', repl: '', hint: 'xoá mọi cụm chữ số' },
];

export default function ReplacePanel() {
  // Kéo thanh giữa hai ô để đổi bề rộng — biến RIÊNG cho panel này (biến CSS
  // di truyền xuống con, trùng tên với split khác là ăn nhầm con số của nhau).
  // min rộng tay hơn các view khác: hai bên đều là ô văn bản, bóp còn 150px thì
  // xuống dòng loạn lên chứ không đọc được gì.
  const split = useSplit({ varName: '--rp-split', min: 240, max: 900, gap: 12 });
  const [source, setSource] = useState('');
  const [find, setFind] = useState('');
  const [repl, setRepl] = useState('');
  const [opts, setOpts] = useState<ReplaceOptions>(DEFAULT_OPTIONS);
  const [copied, setCopied] = useState(false);
  const srcRef = useRef<HTMLTextAreaElement | null>(null);

  // Nhớ tuỳ chọn (chế độ, các cờ) — mở lại là đúng thói quen lần trước.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(OPT_KEY);
      if (raw) setOpts({ ...DEFAULT_OPTIONS, ...JSON.parse(raw) });
    } catch { /* hỏng thì dùng mặc định */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(OPT_KEY, JSON.stringify(opts)); } catch { /* nicety */ }
  }, [opts]);

  const set = useCallback(<K extends keyof ReplaceOptions>(k: K, v: ReplaceOptions[K]) => {
    setOpts((o) => ({ ...o, [k]: v }));
  }, []);

  // Tính lại mỗi lần gõ. Không cần debounce: replace trên chuỗi trong RAM là
  // mức micro giây, và thấy kết quả đổi theo từng phím mới là cái người dùng cần.
  const result = useMemo(
    () => runReplace(source, find, repl, opts),
    [source, find, repl, opts],
  );

  const count = result.matches.length;
  const capped = count >= MATCH_LIMIT;
  const changed = result.output !== source;

  const copyOut = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(result.output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* ignore */ }
  }, [result.output]);

  /** Đưa kết quả về ô nguồn — chạy nhiều phép thay nối tiếp nhau. */
  const applyBack = useCallback(() => {
    setSource(result.output);
    setFind('');
    setRepl('');
    srcRef.current?.focus();
  }, [result.output]);

  const clearAll = () => { setSource(''); setFind(''); setRepl(''); };

  return (
    <div className="rp-wrap">
      {/* ── Thanh điều khiển: chế độ + các cờ ─────────────────────────────── */}
      <div className="rp-top">
        <div className="rp-modes" role="radiogroup" aria-label="Chế độ tìm">
          {([
            ['plain', 'Thường', 'Tìm đúng từng ký tự — "." là dấu chấm thật, không phải ký hiệu regex'],
            ['regex', 'Regex', 'Biểu thức chính quy — dùng được $1/$2 để lấy lại nhóm bắt'],
          ] as [ReplaceMode, string, string][]).map(([m, label, title]) => (
            <button
              key={m}
              role="radio"
              aria-checked={opts.mode === m}
              className={`chip-btn${opts.mode === m ? ' on' : ''}`}
              onClick={() => set('mode', m)}
              title={title}
            >
              {m === 'regex' ? '.*' : 'Aa'} {label}
            </button>
          ))}
        </div>

        <span className="rp-sep" aria-hidden />

        <label className="rp-flag" title="Không phân biệt chữ hoa với chữ thường">
          <input type="checkbox" checked={opts.ignoreCase}
            onChange={(e) => set('ignoreCase', e.target.checked)} />
          <span>Bỏ qua hoa/thường</span>
        </label>
        <label className="rp-flag" title="Tắt = chỉ thay chỗ khớp ĐẦU TIÊN">
          <input type="checkbox" checked={opts.all}
            onChange={(e) => set('all', e.target.checked)} />
          <span>Thay tất cả</span>
        </label>

        {/* Cờ chỉ có nghĩa với regex — ẩn hẳn ở chế độ thường cho đỡ rối. */}
        {opts.mode === 'regex' && (
          <>
            <label className="rp-flag" title="^ và $ khớp đầu/cuối TỪNG DÒNG (cờ m)">
              <input type="checkbox" checked={opts.multiline}
                onChange={(e) => set('multiline', e.target.checked)} />
              <span>^$ theo dòng</span>
            </label>
            <label className="rp-flag" title="Dấu chấm khớp cả ký tự xuống dòng (cờ s)">
              <input type="checkbox" checked={opts.dotAll}
                onChange={(e) => set('dotAll', e.target.checked)} />
              <span>. khớp xuống dòng</span>
            </label>
          </>
        )}

        <span style={{ flex: 1 }} />
        <button className="ghost sm" onClick={clearAll}
          disabled={!source && !find && !repl} title="Xoá hết các ô">
          ⌫ Xoá hết
        </button>
      </div>

      {/* ── Hai ô tìm / thay ──────────────────────────────────────────────── */}
      <div className="rp-fields">
        <div className="rp-field">
          <label className="rp-label" htmlFor="rp-find">Tìm</label>
          <input
            id="rp-find"
            className={`input mono${result.error ? ' rp-bad' : ''}`}
            placeholder={opts.mode === 'regex' ? 'vd \\d+ hoặc (\\w+)@(\\w+)' : 'chuỗi cần tìm'}
            value={find}
            onChange={(e) => setFind(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="rp-field">
          <label className="rp-label" htmlFor="rp-repl">Thay bằng</label>
          <input
            id="rp-repl"
            className="input mono"
            placeholder={opts.mode === 'regex' ? 'vd $2 $1 (để trống = xoá)' : 'để trống = xoá chuỗi tìm được'}
            value={repl}
            onChange={(e) => setRepl(e.target.value)}
            spellCheck={false}
          />
        </div>
      </div>

      {/* Dòng trạng thái: lỗi regex, số chỗ khớp, cảnh báo khớp rỗng */}
      <div className="rp-status">
        {result.error ? (
          <span className="rp-err" title="Biểu thức chính quy chưa hợp lệ">⚠ Regex chưa đúng: {result.error}</span>
        ) : !find ? (
          <span className="small rp-muted">Nhập chuỗi cần tìm để bắt đầu — kết quả hiện ngay bên phải.</span>
        ) : (
          <>
            <span className={`rp-count${count ? '' : ' rp-zero'}`}>{summarize(count, capped)}</span>
            {result.emptyMatch && (
              <span className="rp-warn" title="Mẫu khớp chuỗi rỗng — thường là gõ nhầm">
                ⚠ mẫu khớp cả chuỗi rỗng
              </span>
            )}
            {capped && <span className="rp-warn">chỉ đếm tới {MATCH_LIMIT}</span>}
          </>
        )}
        <span style={{ flex: 1 }} />
        {opts.mode === 'regex' && (
          <span className="rp-samples">
            {SAMPLES.map((s) => (
              <button key={s.label} className="ghost sm" title={`${s.find} → ${s.repl || '(rỗng)'} — ${s.hint}`}
                onClick={() => {
                  // Chuỗi trong SAMPLES viết kiểu nguồn JS ("\\n") nên đổi về ký
                  // tự thật trước khi đưa vào ô thay, còn ô tìm giữ nguyên vì
                  // regex cần đúng dạng "\n" hai ký tự.
                  setFind(s.find);
                  setRepl(s.repl.replace(/\\n/g, '\n'));
                }}>
                {s.label}
              </button>
            ))}
          </span>
        )}
      </div>

      {/* ── Nguồn | Kết quả ───────────────────────────────────────────────── */}
      <div className="rp-cols" ref={split.ref} style={split.style}>
        <section className="rp-card">
          <div className="tools-pane-head">
            📝 Chuỗi gốc
            <span className="tools-pane-hint">{source.length.toLocaleString('vi-VN')} ký tự · {lineCount(source)} dòng</span>
          </div>
          <textarea
            ref={srcRef}
            className="input mono rp-area"
            placeholder="Dán chuỗi cần xử lý vào đây…"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
            autoFocus
          />
        </section>

        <section className="rp-card">
          <div className="tools-pane-head">
            ✅ Kết quả
            <span className="tools-pane-hint">
              {result.output.length.toLocaleString('vi-VN')} ký tự · {lineCount(result.output)} dòng
              {changed ? '' : ' · chưa đổi gì'}
            </span>
            <span style={{ flex: 1 }} />
            <button className="ghost sm" onClick={copyOut} disabled={!result.output}
              title="Chép kết quả vào clipboard">
              {copied ? '✓ Đã chép' : '⧉ Chép'}
            </button>
            <button className="ghost sm" onClick={applyBack} disabled={!changed}
              title="Đưa kết quả sang ô gốc để chạy tiếp phép thay khác">
              ↩ Dùng làm nguồn
            </button>
          </div>
          <textarea
            className="input mono rp-area rp-out"
            value={result.output}
            readOnly
            spellCheck={false}
            placeholder="Kết quả sẽ hiện ở đây…"
          />
        </section>
        <Splitter {...split.grip} />
      </div>
    </div>
  );
}

/** Đếm dòng — chuỗi rỗng là 0 dòng, còn lại là số \n cộng một. */
function lineCount(s: string): number {
  if (!s) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}
