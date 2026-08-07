'use client';

// Phần hiển thị tài liệu của Word workspace: trang giấy A4, các đoạn văn
// (render đúng định dạng từng cụm chữ) và bảng (sửa được từng ô).
//
// Sửa đoạn dùng <textarea> chứ không phải contenteditable: định dạng vẫn giữ
// theo cụm từ nhờ op `runFmt` áp lên vùng bôi đen, còn nội dung thì sửa như
// một ô văn bản bình thường — đơn giản và không bao giờ sinh ra HTML lạ.

import { forwardRef } from 'react';
import type {
  HeaderFooter, PageSetup, ParaBlock, ParaFormat, RunFormat, RunSpan,
  TableBlock, TableCell, WordBlock,
} from '@/lib/word';
import { runsText } from '@/lib/word';

/** Block cộng thêm cờ "đã sửa trong phiên này" để tô nền cảnh báo. */
export type Block = WordBlock & { d?: boolean };

/** Ô đang trỏ tới trong một bảng. */
export interface CellRef { block: number; r: number; c: number }

/** Vùng bôi đen trong đoạn đang sửa (offset ký tự). */
export interface TextRange { from: number; to: number }

/**
 * Trần bề rộng của trang giấy trong khung soạn thảo.
 *
 * `page` = đúng khổ giấy khai trong file (nhìn sát bản in, nhưng trên màn hình
 * rộng thì cột chữ chỉ chiếm giữa màn hình). `wide` / `full` ưu tiên chỗ gõ.
 */
export type DocWidth = 'page' | 'wide' | 'full';

/** Trần bề rộng theo từng chế độ (`full` = hết chỗ khung cho phép). */
const WIDTH_CAP: Record<DocWidth, string | undefined> = {
  page: undefined, // lấy theo page.w của file
  wide: '1180px',
  full: 'none',
};

/** Lề mô phỏng tối đa khi nới rộng — xem lý do ở chỗ dùng. */
const WIDE_MARGIN_CAP = 40;

// ── Định dạng → CSS ──────────────────────────────────────────────────────────

/** Bảng tô sáng của Word → màu CSS. */
const HL_CSS: Record<string, string> = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff',
  blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080',
  darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0',
  black: '#000000', white: '#ffffff',
};

/** RunFormat → style inline cho một <span>. */
export function runStyle(f: RunFormat | undefined): React.CSSProperties {
  if (!f) return {};
  const s: React.CSSProperties = {};
  if (f.b) s.fontWeight = 700;
  if (f.i) s.fontStyle = 'italic';
  if (f.u && f.st) s.textDecoration = 'underline line-through';
  else if (f.u) s.textDecoration = 'underline';
  else if (f.st) s.textDecoration = 'line-through';
  if (f.fc) s.color = f.fc;
  if (f.hl) s.background = HL_CSS[f.hl] ?? f.hl;
  else if (f.bg) s.background = f.bg;
  if (f.fs) s.fontSize = `${f.fs}pt`;
  if (f.ff) s.fontFamily = `"${f.ff}", serif`;
  if (f.caps) s.textTransform = 'uppercase';
  if (f.smallCaps) s.fontVariant = 'small-caps';
  if (f.va === 'sup') { s.verticalAlign = 'super'; s.fontSize = '0.75em'; }
  if (f.va === 'sub') { s.verticalAlign = 'sub'; s.fontSize = '0.75em'; }
  return s;
}

const JC_CSS = { l: 'left', c: 'center', r: 'right', j: 'justify' } as const;

/** ParaFormat → style inline cho khối đoạn. */
export function paraStyle(fmt: ParaFormat | undefined): React.CSSProperties {
  if (!fmt) return {};
  const s: React.CSSProperties = {};
  if (fmt.jc) s.textAlign = JC_CSS[fmt.jc];
  if (fmt.ls) s.lineHeight = fmt.ls;
  if (fmt.sb) s.marginTop = `${fmt.sb}pt`;
  if (fmt.sa) s.marginBottom = `${fmt.sa}pt`;
  if (fmt.il) s.marginLeft = `${fmt.il}pt`;
  if (fmt.ifl) s.textIndent = `${fmt.ifl}pt`;
  return s;
}

/** Kiểu đoạn (Title / Heading…) → class hiển thị. */
export function styleClass(fmt: ParaFormat | undefined): string {
  const s = (fmt?.style ?? '').toLowerCase();
  if (s === 'title') return ' word-p-title';
  if (s === 'subtitle') return ' word-p-subtitle';
  if (s === 'quote') return ' word-p-quote';
  if (s === 'caption') return ' word-p-caption';
  if (s.startsWith('heading')) {
    const n = Number.parseInt(s.slice(7), 10);
    if (n === 1) return ' word-p-h1';
    if (n === 2) return ' word-p-h2';
    if (n === 3) return ' word-p-h3';
    return ' word-p-h4';
  }
  return '';
}

/** Ký hiệu đầu dòng hiển thị cho đoạn thuộc danh sách. */
function listMarker(fmt: ParaFormat | undefined, ordinal: number): string | null {
  if (!fmt?.list) return null;
  if (fmt.list === 'bullet') return ['•', 'o', '▪'][(fmt.lvl ?? 0) % 3];
  return `${ordinal}.`;
}

// ── Runs ─────────────────────────────────────────────────────────────────────

/** Một đoạn runs → các <span> giữ đúng định dạng từng cụm. */
export function RunsView({ runs }: { runs: RunSpan[] }) {
  if (runs.length === 0) return null;
  return (
    <>
      {runs.map((r, i) => (
        <span key={i} style={runStyle(r.f)}>{r.t}</span>
      ))}
    </>
  );
}

// ── Bảng ─────────────────────────────────────────────────────────────────────

const VA_CSS = { t: 'top', m: 'middle', b: 'bottom' } as const;

interface TableViewProps {
  block: TableBlock;
  index: number;
  cell: CellRef | null;
  editingCell: CellRef | null;
  onPickCell: (r: number, c: number) => void;
  onEditCell: (r: number, c: number) => void;
  onCommitCell: (r: number, c: number, text: string) => void;
  onCancelCell: () => void;
}

function TableView({
  block, index, cell, editingCell, onPickCell, onEditCell, onCommitCell, onCancelCell,
}: TableViewProps) {
  return (
    <table className={`word-table${block.bordered === false ? ' plain' : ''}`}>
      <tbody>
        {block.rows.map((row, r) => (
          <tr key={r} className={block.headerRow && r === 0 ? 'head' : undefined}>
            {row.map((tc, c) => {
              if (tc.vMerged) return null; // ô bị gộp lên trên — không vẽ lại
              const isSel = cell?.block === index && cell.r === r && cell.c === c;
              const isEditing = editingCell?.block === index && editingCell.r === r && editingCell.c === c;
              const text = tc.paras.map((p) => runsText(p.runs)).join('\n');
              return (
                <td
                  key={c}
                  colSpan={tc.span}
                  className={`${isSel ? 'sel ' : ''}${tc.locked ? 'locked' : ''}`}
                  style={{
                    ...(tc.bg ? { background: tc.bg } : {}),
                    ...(tc.va ? { verticalAlign: VA_CSS[tc.va] } : {}),
                    ...(tc.w ? { width: `${tc.w}pt` } : {}),
                  }}
                  onClick={() => onPickCell(r, c)}
                  onDoubleClick={() => { if (!tc.locked) onEditCell(r, c); }}
                  title={tc.locked
                    ? 'Ô này chứa nội dung đặc biệt (ảnh / liên kết / bảng lồng) — chỉ xem'
                    : 'Bấm để chọn · bấm đúp để sửa'}
                >
                  {isEditing ? (
                    <textarea
                      className="word-cell-edit"
                      autoFocus
                      defaultValue={text}
                      rows={Math.min(8, Math.max(1, text.split('\n').length))}
                      onBlur={(e) => onCommitCell(r, c, e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          onCommitCell(r, c, e.currentTarget.value);
                        } else if (e.key === 'Escape') onCancelCell();
                      }}
                    />
                  ) : (
                    tc.paras.map((p, pi) => (
                      <div key={pi} className="word-cell-p" style={paraStyle(p.fmt)}>
                        {p.runs.length === 0 ? <span className="word-cell-empty" /> : <RunsView runs={p.runs} />}
                      </div>
                    ))
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Đầu / chân trang ─────────────────────────────────────────────────────────

function HeaderFooterView({ hf, kind }: { hf: HeaderFooter; kind: 'header' | 'footer' }) {
  const text = hf.paras.map((p) => runsText(p.runs)).join(' ').trim();
  const jc = hf.paras[0]?.fmt?.jc ?? 'c';
  return (
    <div className={`word-hf ${kind}`} style={{ textAlign: JC_CSS[jc] }}>
      <span className="word-hf-tag" aria-hidden>{kind === 'header' ? 'Đầu trang' : 'Chân trang'}</span>
      <span className="word-hf-text">
        {text || <em className="word-hf-empty">(trống)</em>}
        {hf.hasPageNum && <span className="word-hf-field"> ⟨số trang⟩</span>}
      </span>
    </div>
  );
}

// ── Toàn bộ tài liệu ─────────────────────────────────────────────────────────

export interface WordDocViewProps {
  blocks: Block[];
  page: PageSetup;
  headers: HeaderFooter[];
  footers: HeaderFooter[];
  sel: number | null;
  editing: number | null;
  cell: CellRef | null;
  editingCell: CellRef | null;
  /** Vị trí các kết quả tìm kiếm đang tô sáng, theo block index. */
  hits: Set<number>;
  /** Block đang được cuộn tới (từ mục lục / tìm kiếm). */
  focusBlock: number | null;
  /** Trần bề rộng trang giấy — chỉ ảnh hưởng cách hiển thị, không đụng vào file. */
  docWidth: DocWidth;
  /** Phóng to khung soạn thảo, % (100 = nguyên bản). Cũng chỉ là hiển thị. */
  zoom: number;
  onSelect: (i: number | null) => void;
  onEdit: (i: number) => void;
  onCommit: (i: number, text: string) => void;
  onCancel: () => void;
  /** Người dùng bôi đen trong ô đang sửa → cập nhật vùng áp định dạng. */
  onSelectionChange: (range: TextRange | null) => void;
  onPickCell: (ref: CellRef) => void;
  onEditCell: (ref: CellRef) => void;
  onCommitCell: (ref: CellRef, text: string) => void;
  onCancelCell: () => void;
}

const WordDocView = forwardRef<HTMLDivElement, WordDocViewProps>(function WordDocView({
  blocks, page, headers, footers, sel, editing, cell, editingCell, hits, focusBlock,
  docWidth, zoom,
  onSelect, onEdit, onCommit, onCancel, onSelectionChange,
  onPickCell, onEditCell, onCommitCell, onCancelCell,
}, ref) {
  const defaultHeader = headers.find((h) => h.type === 'default');
  const defaultFooter = footers.find((f) => f.type === 'default');

  // Nới rộng thì kẹp luôn lề mô phỏng lại: lề Word hay là 72pt mỗi bên, giữ
  // nguyên thì nới trần bề rộng xong cột chữ vẫn hụt mất gần 200px.
  const wide = docWidth !== 'page';
  const ml = wide ? Math.min(page.ml, WIDE_MARGIN_CAP) : page.ml;
  const mr = wide ? Math.min(page.mr, WIDE_MARGIN_CAP) : page.mr;

  // Số thứ tự cho danh sách đánh số: đếm lại mỗi khi chuỗi list bị ngắt.
  let ordinal = 0;

  return (
    <div className="word-scroll" ref={ref}>
      <div
        className="word-doc"
        style={{
          maxWidth: WIDTH_CAP[docWidth] ?? `${page.w}pt`,
          paddingLeft: `${ml}pt`,
          paddingRight: `${mr}pt`,
          paddingTop: `${Math.min(page.mt, 54)}pt`,
          paddingBottom: `${Math.min(page.mb, 54)}pt`,
          // `zoom` (không phải transform: scale) để bố cục được tính lại theo
          // tỉ lệ mới — chữ, bảng và cả textarea đang gõ đều to lên mà trang
          // vẫn tự vừa khung, không sinh thanh cuộn ngang như scale.
          ...(zoom === 100 ? {} : { zoom: zoom / 100 }),
        }}
      >
        {defaultHeader && <HeaderFooterView hf={defaultHeader} kind="header" />}

        {blocks.length === 0 && (
          <div className="empty" style={{ padding: 20 }}>
            <p className="small">Tài liệu trống — bấm “＋ Thêm đoạn” để bắt đầu.</p>
          </div>
        )}

        {blocks.map((b, i) => {
          const isSel = sel === i;
          const rowCls = `word-row${isSel ? ' sel' : ''}${b.d ? ' dirty' : ''}`
            + `${hits.has(i) ? ' hit' : ''}${focusBlock === i ? ' focus' : ''}`;

          if (b.kind === 'tbl') {
            ordinal = 0;
            return (
              <div key={i} className={rowCls} data-block={i}>
                <button className="word-gutter" onClick={() => onSelect(isSel ? null : i)}
                  title="Bấm để chọn / bỏ chọn bảng">▦</button>
                <div className="word-tbl-wrap">
                  <TableView
                    block={b}
                    index={i}
                    cell={cell}
                    editingCell={editingCell}
                    onPickCell={(r, c) => { onSelect(i); onPickCell({ block: i, r, c }); }}
                    onEditCell={(r, c) => onEditCell({ block: i, r, c })}
                    onCommitCell={(r, c, text) => onCommitCell({ block: i, r, c }, text)}
                    onCancelCell={onCancelCell}
                  />
                </div>
              </div>
            );
          }

          if (b.kind === 'br') {
            ordinal = 0;
            return (
              <div key={i} className={rowCls} data-block={i}>
                <button className="word-gutter" onClick={() => onSelect(isSel ? null : i)}
                  title="Ngắt trang — bấm để chọn rồi xóa nếu không cần">⤓</button>
                <div className="word-pagebreak"><span>Ngắt trang</span></div>
              </div>
            );
          }

          const para = b as ParaBlock & { d?: boolean };
          const marker = para.fmt?.list
            ? listMarker(para.fmt, para.fmt.list === 'number' ? ++ordinal : 0)
            : (ordinal = 0, null);
          const text = runsText(para.runs);

          return (
            <div key={i} className={rowCls} data-block={i}>
              <button className="word-gutter" onClick={() => onSelect(isSel ? null : i)}
                title="Bấm để chọn / bỏ chọn đoạn">{i + 1}</button>

              {editing === i ? (
                <textarea
                  className={`word-edit${styleClass(para.fmt)}`}
                  autoFocus
                  defaultValue={text}
                  style={paraStyle(para.fmt)}
                  rows={Math.min(16, Math.max(2, text.split('\n').length + 1))}
                  onBlur={(e) => onCommit(i, e.currentTarget.value)}
                  onSelect={(e) => {
                    const el = e.currentTarget;
                    onSelectionChange(
                      el.selectionStart === el.selectionEnd
                        ? null
                        : { from: el.selectionStart, to: el.selectionEnd },
                    );
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onCommit(i, e.currentTarget.value);
                    else if (e.key === 'Escape') onCancel();
                  }}
                />
              ) : (
                <div
                  className={`word-p${styleClass(para.fmt)}${para.locked ? ' locked' : ''}`}
                  style={paraStyle(para.fmt)}
                  onClick={() => { onSelect(i); if (!para.locked) onEdit(i); }}
                  title={para.locked
                    ? `Đoạn chứa ${para.lockReason} — khóa sửa chữ để không phá hỏng nội dung đó (vẫn đổi được căn lề, kiểu đoạn, và vẫn xóa được cả đoạn)`
                    : 'Bấm để sửa'}
                >
                  {marker && <span className="word-bullet" aria-hidden>{marker}</span>}
                  {para.locked && <span className="word-lock-badge">🔒 {para.lockReason}</span>}
                  {para.runs.length === 0
                    ? <span className="word-p-empty">¶</span>
                    : <RunsView runs={para.runs} />}
                </div>
              )}
            </div>
          );
        })}

        {defaultFooter && <HeaderFooterView hf={defaultFooter} kind="footer" />}
      </div>
    </div>
  );
});

export default WordDocView;

/** Ô của một bảng, hoặc undefined khi chỉ số không còn hợp lệ. */
export function cellOf(blocks: Block[], ref: CellRef | null): TableCell | undefined {
  if (!ref) return undefined;
  const b = blocks[ref.block];
  if (!b || b.kind !== 'tbl') return undefined;
  return b.rows[ref.r]?.[ref.c];
}
