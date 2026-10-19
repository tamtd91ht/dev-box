'use client';

// Khung xem diff kiểu SourceTree cho tab Git.
//
// Bản cũ đổ nguyên chuỗi patch vào <pre> rồi tô màu theo ký tự đầu dòng. Nhìn
// khó hình dung vì thiếu đúng những thứ giúp người đọc định vị:
//
//   · KHÔNG có số dòng   → không biết đang xem chỗ nào trong file
//   · dấu +/- lẫn nội dung → mắt phải tự lọc cột đầu mới đọc được code
//   · các hunk chạy liền  → không thấy ranh giới giữa những đoạn sửa rời nhau
//   · nền phẳng một màu   → dòng thêm/xoá chỉ khác nhau màu chữ, đọc lâu mỏi mắt
//
// Ở đây: hai cột số dòng (cũ | mới), dải màu nền cho add/del, mỗi hunk là một
// khối có tiêu đề, và tô ĐẬM phần chữ thực sự khác nhau trong cặp dòng sửa —
// đó là thứ khiến diff của SourceTree dễ đọc hơn `git diff` trong terminal.

import { useMemo, useState } from 'react';
import { parseDiff, type DiffHunk, type DiffLine } from '@/lib/parseDiff';

export type DiffMode = 'unified' | 'split';

interface Props {
  /** Nguyên văn patch từ /api/git. */
  patch: string;
  /** Đường dẫn file — hiện ở thanh tiêu đề. */
  path?: string;
  /** Nhãn trạng thái (staged / working…). */
  badge?: string;
}

/**
 * Tách phần chung ở đầu/cuối hai chuỗi để biết đoạn giữa là chỗ thật sự đổi.
 *
 * Diff của git tính theo DÒNG, nên một dòng sửa một chữ vẫn hiện thành xoá cả
 * dòng + thêm cả dòng. So ở mức ký tự rồi tô đậm đoạn giữa giúp thấy ngay đã
 * đổi cái gì — không phải đọc lại cả hai dòng để tự tìm.
 */
function inlineParts(a: string, b: string): { pre: number; end: number } {
  const max = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < max && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < max - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  // `end` là vị trí kết thúc đoạn khác biệt TRONG `a` (dòng đang vẽ).
  return { pre, end: a.length - suf };
}

/** Vẽ một dòng, tô đậm đoạn giữa nếu có dòng đối chiếu. */
function LineText({ line, counterpart }: { line: DiffLine; counterpart?: string }) {
  if (counterpart === undefined || line.kind === 'ctx' || line.kind === 'meta') {
    return <span className="dv-text">{line.text || ' '}</span>;
  }
  const { pre, end } = inlineParts(line.text, counterpart);
  // Đổi gần hết dòng → khỏi tô: tô cả dòng thành "đoạn khác" không thêm thông
  // tin gì mà còn rối hơn.
  if (pre === 0 && end >= line.text.length) {
    return <span className="dv-text">{line.text || ' '}</span>;
  }
  return (
    <span className="dv-text">
      {line.text.slice(0, pre)}
      <mark className={`dv-mark dv-mark--${line.kind}`}>{line.text.slice(pre, end)}</mark>
      {line.text.slice(end)}
    </span>
  );
}

/**
 * Ghép cặp del↔add trong một hunk để tô inline.
 *
 * Git xuất một khối sửa thành các dòng `-` liền nhau rồi các dòng `+` liền nhau.
 * Ghép theo thứ tự trong khối: `-`thứ n với `+`thứ n. Số lượng lệch nhau thì
 * phần dư không có đối chiếu — đúng, vì đó là dòng thêm/xoá thật.
 */
function pairInline(lines: DiffLine[]): Map<number, string> {
  const pair = new Map<number, string>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== 'del') { i += 1; continue; }
    const dels: number[] = [];
    while (i < lines.length && lines[i].kind === 'del') { dels.push(i); i += 1; }
    const adds: number[] = [];
    while (i < lines.length && lines[i].kind === 'add') { adds.push(i); i += 1; }
    const n = Math.min(dels.length, adds.length);
    for (let k = 0; k < n; k += 1) {
      pair.set(dels[k], lines[adds[k]].text);
      pair.set(adds[k], lines[dels[k]].text);
    }
  }
  return pair;
}

function HunkBlock({ hunk, mode }: { hunk: DiffHunk; mode: DiffMode }) {
  const [open, setOpen] = useState(true);
  const pair = useMemo(() => pairInline(hunk.lines), [hunk]);

  return (
    <div className="dv-hunk">
      {/* Tiêu đề hunk: bấm để gập. File sửa nhiều chỗ thì gập bớt đoạn không
          quan tâm là cách nhanh nhất để thấy phần còn lại. */}
      <button className="dv-hunk-head" onClick={() => setOpen((v) => !v)} title={hunk.header}>
        <span className="dv-hunk-caret" aria-hidden>{open ? '▾' : '▸'}</span>
        <span className="dv-hunk-range">
          @@ −{hunk.oldStart} +{hunk.newStart}
        </span>
        {hunk.section && <span className="dv-hunk-section">{hunk.section}</span>}
        <span className="dv-hunk-count">{hunk.lines.length} dòng</span>
      </button>

      {open && mode === 'unified' && (
        <div className="dv-rows">
          {hunk.lines.map((l, i) => (
            <div key={i} className={`dv-row dv-row--${l.kind}`}>
              <span className="dv-no dv-no--old">{l.oldNo ?? ''}</span>
              <span className="dv-no dv-no--new">{l.newNo ?? ''}</span>
              <span className="dv-sign" aria-hidden>
                {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
              </span>
              <LineText line={l} counterpart={pair.get(i)} />
            </div>
          ))}
        </div>
      )}

      {open && mode === 'split' && <SplitRows lines={hunk.lines} pair={pair} />}
    </div>
  );
}

/**
 * Chế độ hai cột: trái = bản cũ, phải = bản mới.
 *
 * Xếp cặp del↔add cùng một hàng để so ngang; dòng ngữ cảnh chiếm cả hai bên.
 * Đây là cách SourceTree hiện "side by side" và là chế độ dễ đọc nhất khi một
 * dòng bị sửa chứ không phải thêm/xoá hẳn.
 */
function SplitRows({ lines, pair }: { lines: DiffLine[]; pair: Map<number, string> }) {
  type Row = { left?: { l: DiffLine; i: number }; right?: { l: DiffLine; i: number } };
  const rows: Row[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === 'ctx' || l.kind === 'meta') {
      rows.push({ left: { l, i }, right: { l, i } });
      i += 1;
      continue;
    }
    const dels: { l: DiffLine; i: number }[] = [];
    while (i < lines.length && lines[i].kind === 'del') { dels.push({ l: lines[i], i }); i += 1; }
    const adds: { l: DiffLine; i: number }[] = [];
    while (i < lines.length && lines[i].kind === 'add') { adds.push({ l: lines[i], i }); i += 1; }
    if (!dels.length && !adds.length) { i += 1; continue; }
    for (let k = 0; k < Math.max(dels.length, adds.length); k += 1) {
      rows.push({ left: dels[k], right: adds[k] });
    }
  }

  return (
    <div className="dv-rows dv-rows--split">
      {rows.map((r, k) => (
        <div key={k} className="dv-srow">
          <div className={`dv-side dv-side--${r.left?.l.kind ?? 'blank'}`}>
            <span className="dv-no">{r.left?.l.oldNo ?? ''}</span>
            {r.left ? <LineText line={r.left.l} counterpart={pair.get(r.left.i)} /> : <span className="dv-text" />}
          </div>
          <div className={`dv-side dv-side--${r.right?.l.kind ?? 'blank'}`}>
            <span className="dv-no">{r.right?.l.newNo ?? ''}</span>
            {r.right ? <LineText line={r.right.l} counterpart={pair.get(r.right.i)} /> : <span className="dv-text" />}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function DiffView({ patch, path, badge }: Props) {
  const parsed = useMemo(() => parseDiff(patch), [patch]);
  const [mode, setMode] = useState<DiffMode>('unified');
  const [wrap, setWrap] = useState(false);

  return (
    <div className="dv">
      <div className="dv-bar">
        {badge && <span className={`badge ${badge === 'staged' ? 'info' : ''}`}>{badge}</span>}
        {path && <code className="dv-path" title={path}>{path}</code>}
        <span className="dv-churn">
          {parsed.added > 0 && <span className="dv-churn-add">+{parsed.added}</span>}
          {parsed.removed > 0 && <span className="dv-churn-del">−{parsed.removed}</span>}
        </span>
        <span className="dv-bar-gap" />
        <button className={`ghost sm${mode === 'unified' ? ' on' : ''}`}
          onClick={() => setMode('unified')} title="Một cột (unified)">☰</button>
        <button className={`ghost sm${mode === 'split' ? ' on' : ''}`}
          onClick={() => setMode('split')} title="Hai cột (side by side)">⫿⫿</button>
        <button className={`ghost sm${wrap ? ' on' : ''}`}
          onClick={() => setWrap((v) => !v)} title="Xuống dòng khi quá dài">↵</button>
      </div>

      {parsed.hunks.length === 0 ? (
        <div className="empty" style={{ padding: '24px 8px' }}>
          <div className="empty-ico">≡</div>
          <p className="small">
            {parsed.binary
              ? 'File nhị phân hoặc chỉ đổi chế độ — không có nội dung dòng để so.'
              : 'Không có diff hiển thị (file mới chưa stage). Stage để xem.'}
          </p>
        </div>
      ) : (
        <div className={`dv-body${wrap ? ' dv-body--wrap' : ''}`}>
          {parsed.hunks.map((h, i) => <HunkBlock key={i} hunk={h} mode={mode} />)}
        </div>
      )}
    </div>
  );
}
