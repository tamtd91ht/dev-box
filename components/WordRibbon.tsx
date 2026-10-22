'use client';

// Khung kiểu Microsoft Word cho Word workspace: thanh tiêu đề (Quick Access +
// tên file), dải tab File · Home · Insert · Layout · View (+ tab ngữ cảnh
// "Table" khi đang đứng trong bảng), ribbon chia nhóm như Word, và thanh trạng
// thái dưới cùng (số trang · số từ · zoom).
//
// Dùng lại bộ khung ribbon của ExcelRibbon (Ribbon / Group / Btn / Drop, class
// .xl-*), chỉ đổi màu nhấn sang xanh Word qua class .wd-shell. Component KHÔNG
// giữ nội dung tài liệu: đọc định dạng hiệu dụng ở chỗ đang chọn để nút nào
// đang bật thì sáng, rồi phát patch (undefined=giữ / null=xóa).

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ParaFormat, ParaFormatPatch, RunFormat, RunFormatPatch } from '@/lib/word';
import { fmtBytes } from '@/lib/sheet';
import { ColorPicker } from './SheetFormatBar';
import { Btn, Drop, Group, I, Ribbon, keep, toItems, type MenuItem } from './sheet/ExcelRibbon';
import type { DocWidth } from './WordDocView';

const FONTS = [
  'Times New Roman', 'Arial', 'Calibri', 'Cambria', 'Segoe UI', 'Tahoma',
  'Verdana', 'Courier New', 'Roboto', 'Arial Narrow',
];
const SIZES = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

/** Gallery Styles — id là styleId thật trong .docx, xem trước gần giống Word. */
const STYLES: { v: string; label: string; css: React.CSSProperties }[] = [
  { v: 'Normal', label: 'Normal', css: {} },
  { v: 'Title', label: 'Title', css: { fontSize: 17, fontFamily: '"Calibri Light", Calibri, sans-serif' } },
  { v: 'Subtitle', label: 'Subtitle', css: { color: '#595959', fontStyle: 'italic' } },
  { v: 'Heading1', label: 'Heading 1', css: { color: '#2f5496', fontSize: 14 } },
  { v: 'Heading2', label: 'Heading 2', css: { color: '#2f5496', fontSize: 13 } },
  { v: 'Heading3', label: 'Heading 3', css: { color: '#1f3763' } },
  { v: 'Quote', label: 'Quote', css: { fontStyle: 'italic', color: '#404040' } },
  { v: 'Caption', label: 'Caption', css: { fontStyle: 'italic', color: '#44546a', fontSize: 11 } },
];

const LINE_SPACINGS = [1, 1.15, 1.5, 2, 2.5, 3];

/** Bảng tô sáng của Word — chỉ dùng đúng tên Word chấp nhận. */
const HIGHLIGHTS: { v: string; label: string; css: string }[] = [
  { v: 'yellow', label: 'Yellow', css: '#ffff00' },
  { v: 'green', label: 'Bright Green', css: '#00ff00' },
  { v: 'cyan', label: 'Turquoise', css: '#00ffff' },
  { v: 'magenta', label: 'Pink', css: '#ff00ff' },
  { v: 'red', label: 'Red', css: '#ff0000' },
  { v: 'blue', label: 'Blue', css: '#0000ff' },
  { v: 'darkYellow', label: 'Dark Yellow', css: '#808000' },
  { v: 'lightGray', label: 'Gray-25%', css: '#c0c0c0' },
];

const ZOOM_MIN = 80;
const ZOOM_MAX = 200;

/* ── Icon riêng của Word (cùng kiểu vẽ với ExcelRibbon) ───────────────────── */
const W = {
  bullets: <svg viewBox="0 0 16 16"><circle cx="2.5" cy="3.5" r="1.2" fill="currentColor" /><circle cx="2.5" cy="8" r="1.2" fill="currentColor" /><circle cx="2.5" cy="12.5" r="1.2" fill="currentColor" /><path d="M6 3.5h9M6 8h9M6 12.5h9" stroke="currentColor" /></svg>,
  numbering: <svg viewBox="0 0 16 16"><text x="0" y="5.5" fontSize="5" fill="currentColor">1</text><text x="0" y="10" fontSize="5" fill="currentColor">2</text><text x="0" y="14.5" fontSize="5" fill="currentColor">3</text><path d="M6 3.5h9M6 8h9M6 12.5h9" stroke="currentColor" /></svg>,
  firstLine: <svg viewBox="0 0 16 16"><path d="M7 3h7M2 6.3h12M2 9.6h12M2 13h12" stroke="currentColor" /><path d="m2 1.5 3 1.5-3 1.5z" fill="#2b579a" /></svg>,
  sub: <svg viewBox="0 0 16 16"><text x="0" y="11" fontSize="10" fill="currentColor">x</text><text x="8" y="15" fontSize="6.5" fill="#2b579a">2</text></svg>,
  sup: <svg viewBox="0 0 16 16"><text x="0" y="13" fontSize="10" fill="currentColor">x</text><text x="8" y="6.5" fontSize="6.5" fill="#2b579a">2</text></svg>,
  caps: <svg viewBox="0 0 16 16"><text x="0" y="12" fontSize="9" fontWeight="600" fill="currentColor">Aa</text></svg>,
  hl: <svg viewBox="0 0 16 16"><path d="m4 10 6-7 3 3-6 7H4z" fill="#fff" stroke="currentColor" strokeWidth=".9" /><path d="M4 10h3v3" fill="none" stroke="currentColor" strokeWidth=".9" /></svg>,
  spacing: <svg viewBox="0 0 16 16"><path d="M7 3h8M7 6.3h8M7 9.6h8M7 13h8" stroke="currentColor" /><path d="M3 2v12M1.5 4 3 2l1.5 2M1.5 12 3 14l1.5-2" fill="none" stroke="#2b579a" /></svg>,
  replace: <svg viewBox="0 0 16 16"><text x="0" y="7" fontSize="6.5" fill="currentColor">ab</text><text x="7" y="15" fontSize="6.5" fill="#2b579a">ac</text><path d="M10 2h3v3M13 2l-3 3" fill="none" stroke="currentColor" strokeWidth=".9" /></svg>,
  newPara: <svg viewBox="0 0 32 32"><path d="M7 3h13l6 6v20H7z" fill="#fff" stroke="#8a8a8a" /><path d="M20 3v6h6" fill="none" stroke="#8a8a8a" /><text x="11" y="23" fontSize="12" fontWeight="700" fill="#2b579a">¶</text></svg>,
  pageBreak: <svg viewBox="0 0 32 32"><path d="M7 3h18v10H7zM7 19h18v10H7z" fill="#fff" stroke="#8a8a8a" /><path d="M3 16h26" stroke="#2b579a" strokeWidth="1.6" strokeDasharray="3 2" /></svg>,
  picture: <svg viewBox="0 0 32 32"><rect x="3" y="6" width="26" height="20" fill="#fff" stroke="#8a8a8a" /><circle cx="10" cy="12" r="2.5" fill="#f0b24a" /><path d="m5 24 8-8 5 5 4-3 6 6z" fill="#5b9bd5" /></svg>,
  header: <svg viewBox="0 0 32 32"><path d="M7 3h18v26H7z" fill="#fff" stroke="#8a8a8a" /><rect x="9" y="5" width="14" height="5" fill="#c9daf8" stroke="#2b579a" /><path d="M10 15h12M10 19h12M10 23h8" stroke="#bdbdbd" /></svg>,
  footer: <svg viewBox="0 0 32 32"><path d="M7 3h18v26H7z" fill="#fff" stroke="#8a8a8a" /><rect x="9" y="22" width="14" height="5" fill="#c9daf8" stroke="#2b579a" /><path d="M10 8h12M10 12h12M10 16h8" stroke="#bdbdbd" /></svg>,
  pageNum: <svg viewBox="0 0 32 32"><path d="M7 3h18v26H7z" fill="#fff" stroke="#8a8a8a" /><text x="13" y="26" fontSize="8" fontWeight="700" fill="#2b579a">#</text><path d="M10 8h12M10 12h12M10 16h8" stroke="#bdbdbd" /></svg>,
  margins: <svg viewBox="0 0 32 32"><path d="M7 3h18v26H7z" fill="#fff" stroke="#8a8a8a" /><rect x="10" y="7" width="12" height="18" fill="none" stroke="#2b579a" strokeDasharray="2 1.5" /></svg>,
  orient: <svg viewBox="0 0 32 32"><path d="M4 8h14v20H4z" fill="#fff" stroke="#8a8a8a" /><path d="M12 4h16v12H12z" fill="#fff" stroke="#2b579a" /></svg>,
  size: <svg viewBox="0 0 32 32"><path d="M8 3h16v26H8z" fill="#fff" stroke="#8a8a8a" /><text x="10.5" y="19" fontSize="7" fontWeight="700" fill="#2b579a">A4</text></svg>,
  up: <svg viewBox="0 0 16 16"><path d="M8 13V3M4 7l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>,
  down: <svg viewBox="0 0 16 16"><path d="M8 3v10M4 9l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>,
  trash: <svg viewBox="0 0 16 16"><path d="M3 4h10M6 4V2.5h4V4M4.5 4l.7 10h5.6l.7-10" fill="none" stroke="currentColor" /><path d="M7 6.5v5M9 6.5v5" stroke="#d13438" /></svg>,
  nav: <svg viewBox="0 0 32 32"><rect x="3" y="5" width="26" height="22" fill="#fff" stroke="#8a8a8a" /><rect x="3" y="5" width="9" height="22" fill="#c9daf8" stroke="#8a8a8a" /><path d="M5 10h5M5 14h4M5 18h5M15 10h11M15 14h11M15 18h8" stroke="#2b579a" /></svg>,
  printLayout: <svg viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" fill="#e6e6e6" /><path d="M8 4h16v24H8z" fill="#fff" stroke="#8a8a8a" /><path d="M11 9h10M11 13h10M11 17h10M11 21h6" stroke="#2b579a" /></svg>,
  webLayout: <svg viewBox="0 0 32 32"><rect x="2" y="4" width="28" height="24" fill="#fff" stroke="#8a8a8a" /><path d="M2 9h28" stroke="#8a8a8a" /><path d="M5 13h22M5 17h22M5 21h16" stroke="#2b579a" /></svg>,
  wide: <svg viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" fill="#e6e6e6" /><path d="M4 4h24v24H4z" fill="#fff" stroke="#8a8a8a" /><path d="M7 9h18M7 13h18M7 17h18M7 21h12" stroke="#2b579a" /></svg>,
  oneHundred: <svg viewBox="0 0 32 32"><text x="2" y="21" fontSize="11" fontWeight="700" fill="#2b579a">100</text></svg>,
  print: <svg viewBox="0 0 32 32"><rect x="9" y="4" width="14" height="8" fill="#fff" stroke="#8a8a8a" /><rect x="3" y="12" width="26" height="11" rx="2" fill="#bdbdbd" stroke="#7a7a7a" /><rect x="9" y="19" width="14" height="9" fill="#fff" stroke="#8a8a8a" /><path d="M12 23h8M12 26h6" stroke="#2b579a" /></svg>,
  borders: <svg viewBox="0 0 32 32"><rect x="5" y="5" width="22" height="22" fill="#fff" stroke="currentColor" strokeWidth="1.6" /><path d="M5 16h22M16 5v22" stroke="currentColor" strokeWidth="1.6" /></svg>,
  rowAbove: <svg viewBox="0 0 32 32"><rect x="5" y="14" width="22" height="14" fill="#fff" stroke="#8a8a8a" /><path d="M5 21h22M12.3 14v14M19.6 14v14" stroke="#bdbdbd" /><rect x="5" y="4" width="22" height="7" fill="#c9daf8" stroke="#2b579a" /></svg>,
  rowBelow: <svg viewBox="0 0 32 32"><rect x="5" y="4" width="22" height="14" fill="#fff" stroke="#8a8a8a" /><path d="M5 11h22M12.3 4v14M19.6 4v14" stroke="#bdbdbd" /><rect x="5" y="21" width="22" height="7" fill="#c9daf8" stroke="#2b579a" /></svg>,
  colLeft: <svg viewBox="0 0 32 32"><rect x="14" y="5" width="14" height="22" fill="#fff" stroke="#8a8a8a" /><path d="M21 5v22M14 12.3h14M14 19.6h14" stroke="#bdbdbd" /><rect x="4" y="5" width="7" height="22" fill="#c9daf8" stroke="#2b579a" /></svg>,
  colRight: <svg viewBox="0 0 32 32"><rect x="4" y="5" width="14" height="22" fill="#fff" stroke="#8a8a8a" /><path d="M11 5v22M4 12.3h14M4 19.6h14" stroke="#bdbdbd" /><rect x="21" y="5" width="7" height="22" fill="#c9daf8" stroke="#2b579a" /></svg>,
  doc: <svg viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="2" fill="#2b579a" /><text x="3.2" y="12" fontSize="10" fontWeight="700" fill="#fff">W</text></svg>,
};

type Tab = 'File' | 'Home' | 'Insert' | 'Layout' | 'View' | 'Table';
const COLLAPSE_KEY = 'word.ribbonCollapsed';

export interface WordDocStats { words: number; chars: number; paras: number; tables: number; pages: number }

export interface WordRibbonProps {
  filePath: string;
  sizeBytes: number;
  dirty: number;
  saving: boolean;
  canSave: boolean;
  saveTitle: string;
  onSave: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;

  /** Định dạng chữ hiệu dụng ở chỗ đang chọn (đoạn, cụm từ bôi đen, hoặc ô bảng). */
  run: RunFormat | undefined;
  /** Định dạng đoạn của đoạn đang chọn. */
  para: ParaFormat | undefined;
  /** Chưa chọn đoạn/ô nào → khoá các nút định dạng. */
  disabled: boolean;
  /** Mô tả chỗ đang áp — dùng trong tooltip. */
  targetLabel: string;
  inTable: boolean;
  onRunFormat: (p: RunFormatPatch) => void;
  onParaFormat: (p: ParaFormatPatch) => void;

  onInsertPara: () => void;
  onInsertTable: () => void;
  onPageBreak: () => void;
  onInsertImage: () => void;
  onHeader: () => void;
  onFooter: () => void;
  onPageSetup: () => void;
  onTableRow: (where: 'above' | 'below') => void;
  onTableRowDelete: () => void;
  onTableCol: (where: 'left' | 'right') => void;
  onTableColDelete: () => void;
  onTableBorder: () => void;

  canMoveUp: boolean;
  canMoveDown: boolean;
  canDelete: boolean;
  onMove: (dir: -1 | 1) => void;
  onDeleteBlock: () => void;

  onFind: () => void;
  onPrint: () => void;
  outlineOpen: boolean;
  onToggleOutline: () => void;
  width: DocWidth;
  onWidth: (w: DocWidth) => void;
  zoom: number;
  onZoom: (dir: -1 | 1) => void;
  onZoomReset: () => void;

  allowWrite: boolean;
  onNewFile: () => void;
  onOpenFile: () => void;
  onReload: () => void;
  onOpenExternal: () => void;
  stats: WordDocStats;
}

export default function WordRibbon(p: WordRibbonProps) {
  const {
    run, para, disabled: off, targetLabel, inTable, onRunFormat, onParaFormat,
  } = p;
  const fileName = p.filePath.split(/[\\/]/).pop() ?? p.filePath;

  const [tab, setTab] = useState<Tab>('Home');
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try { setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1'); } catch { /* nicety */ }
  }, []);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      try { window.localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1'); } catch { /* nicety */ }
      return !c;
    });
  }, []);
  // Rời bảng thì tab ngữ cảnh "Table" biến mất → quay về Home.
  useEffect(() => { if (!inTable && tab === 'Table') setTab('Home'); }, [inTable, tab]);

  // Kéo trong bộ chọn màu bắn ra hàng chục event — chỉ áp khi tay dừng lại.
  const colorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (colorTimer.current) clearTimeout(colorTimer.current); }, []);
  const pickColor = (c: string, live?: boolean) => {
    if (colorTimer.current) clearTimeout(colorTimer.current);
    if (!live) { onRunFormat({ fc: c }); return; }
    colorTimer.current = setTimeout(() => onRunFormat({ fc: c }), 150);
  };

  const toggle = (key: 'b' | 'i' | 'u' | 'st' | 'caps') => onRunFormat({ [key]: run?.[key] ? null : 1 } as RunFormatPatch);
  const setVa = (v: 'sup' | 'sub') => onRunFormat({ va: run?.va === v ? null : v });
  /** Bấm lại chính kiểu căn đang bật → bỏ căn, như Word. */
  const setJc = (v: 'l' | 'c' | 'r' | 'j') => onParaFormat({ jc: para?.jc === v ? null : v });
  const setList = (v: 'bullet' | 'number') => onParaFormat({ list: para?.list === v ? null : v });
  const fs = run?.fs ?? 12;
  const growShrink = (dir: 1 | -1) => {
    const next = dir > 0 ? SIZES.find((s) => s > fs) : [...SIZES].reverse().find((s) => s < fs);
    if (next) onRunFormat({ fs: next });
  };
  const indent = para?.il ?? 0;
  const style = para?.style ?? 'Normal';

  /** Clipboard trên ô đang gõ (textarea đang focus — nút ribbon không cướp focus). */
  const clip = (cmd: 'cut' | 'copy') => { document.execCommand(cmd); };
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) document.execCommand('insertText', false, text);
    } catch { /* quyền clipboard bị chặn — Ctrl+V vẫn dùng được */ }
  };

  const hlItems: MenuItem[] = [
    ...HIGHLIGHTS.map((h) => ({
      label: h.label, icon: <span className="word-hl-swatch" style={{ background: h.css }} />,
      run: () => onRunFormat({ hl: h.v }), disabled: off,
    })),
    { label: '', sep: true },
    { label: 'No Color', icon: <span className="word-hl-swatch none" />, run: () => onRunFormat({ hl: null }), disabled: off },
  ];

  const spacingItems: MenuItem[] = [
    ...LINE_SPACINGS.map((v) => ({
      label: `${v.toFixed(2).replace(/0$/, '')}${para?.ls === v ? '  ✓' : ''}`,
      run: () => onParaFormat({ ls: v }), disabled: off,
    })),
    { label: '', sep: true },
    { label: 'Add Space Before Paragraph', run: () => onParaFormat({ sb: Math.min(720, (para?.sb ?? 0) + 6) }), disabled: off },
    { label: 'Remove Space Before Paragraph', run: () => onParaFormat({ sb: null }), disabled: off || !para?.sb },
    { label: 'Add Space After Paragraph', run: () => onParaFormat({ sa: Math.min(720, (para?.sa ?? 0) + 6) }), disabled: off },
    { label: 'Remove Space After Paragraph', run: () => onParaFormat({ sa: null }), disabled: off || !para?.sa },
  ];

  const body: Record<Exclude<Tab, 'File'>, ReactNode> = {
    Home: (
      <>
        <Group label="Clipboard">
          <Btn big icon={I.paste} label="Paste" title="Paste (Ctrl+V)" run={() => void paste()} />
          <div className="xl-col">
            <Btn icon={I.cut} label="Cut" title="Cut (Ctrl+X)" run={() => clip('cut')} />
            <Btn icon={I.copy} label="Copy" title="Copy (Ctrl+C)" run={() => clip('copy')} />
          </div>
        </Group>

        <Group label="Font">
          <div className="xl-rows">
            <div className="xl-row">
              <select className="xl-select font" disabled={off} value={run?.ff ?? ''} title={`Font — ${targetLabel}`}
                onChange={(e) => onRunFormat({ ff: e.target.value || null })}>
                <option value="">(Theme font)</option>
                {FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
                {run?.ff && !FONTS.includes(run.ff) && <option value={run.ff}>{run.ff}</option>}
              </select>
              <select className="xl-select size" disabled={off} value={run?.fs ?? ''} title={`Font Size — ${targetLabel}`}
                onChange={(e) => onRunFormat({ fs: e.target.value ? Number(e.target.value) : null })}>
                <option value="">–</option>
                {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
                {run?.fs && !SIZES.includes(run.fs) && <option value={run.fs}>{run.fs}</option>}
              </select>
              <Btn icon={I.grow} title="Increase Font Size (Ctrl+])" disabled={off} run={() => growShrink(1)} />
              <Btn icon={I.shrink} title="Decrease Font Size (Ctrl+[)" disabled={off} run={() => growShrink(-1)} />
              <Btn icon={W.caps} title="Change Case — ALL CAPS" on={!!run?.caps} disabled={off} run={() => toggle('caps')} />
              <Btn icon={I.eraser} title={`Clear All Formatting — ${targetLabel}`} disabled={off}
                run={() => { onRunFormat({ clear: 1 }); onParaFormat({ clear: 1 }); }} />
            </div>
            <div className="xl-row">
              <Btn label="B" title="Bold (Ctrl+B)" on={!!run?.b} disabled={off} run={() => toggle('b')} />
              <Btn label="I" title="Italic (Ctrl+I)" on={!!run?.i} disabled={off} run={() => toggle('i')} />
              <Btn label="U" title="Underline (Ctrl+U)" on={!!run?.u} disabled={off} run={() => toggle('u')} />
              <Btn label="ab" title="Strikethrough" on={!!run?.st} disabled={off} run={() => toggle('st')} />
              <Btn icon={W.sub} title="Subscript" on={run?.va === 'sub'} disabled={off} run={() => setVa('sub')} />
              <Btn icon={W.sup} title="Superscript" on={run?.va === 'sup'} disabled={off} run={() => setVa('sup')} />
              <span className="xl-vsep" />
              <Drop icon={<span className="wd-hl-ico">{W.hl}<span style={{ background: HIGHLIGHTS.find((h) => h.v === run?.hl)?.css ?? '#ffff00' }} /></span>}
                title="Text Highlight Color" disabled={off} items={hlItems}
                split={() => onRunFormat({ hl: run?.hl ? null : 'yellow' })} />
              <ColorPicker kind="fc" current={run?.fc} disabled={off} rangeLabel={targetLabel}
                onPick={pickColor} onClear={() => onRunFormat({ fc: null })} />
            </div>
          </div>
        </Group>

        <Group label="Paragraph">
          <div className="xl-rows">
            <div className="xl-row">
              <Btn icon={W.bullets} title="Bullets" on={para?.list === 'bullet'} disabled={off} run={() => setList('bullet')} />
              <Btn icon={W.numbering} title="Numbering" on={para?.list === 'number'} disabled={off} run={() => setList('number')} />
              <span className="xl-vsep" />
              <Btn icon={I.indL} title="Decrease Indent" disabled={off || indent <= 0}
                run={() => onParaFormat({ il: Math.max(0, indent - 18) || null })} />
              <Btn icon={I.indR} title="Increase Indent" disabled={off}
                run={() => onParaFormat({ il: Math.min(720, indent + 18) })} />
              <Btn icon={W.firstLine} title="First Line Indent (1.27 cm)" on={!!para?.ifl} disabled={off}
                run={() => onParaFormat({ ifl: para?.ifl ? null : 36 })} />
            </div>
            <div className="xl-row">
              <Btn icon={I.aLeft} title="Align Left (Ctrl+L)" on={para?.jc === 'l'} disabled={off} run={() => setJc('l')} />
              <Btn icon={I.aCenter} title="Center (Ctrl+E)" on={para?.jc === 'c'} disabled={off} run={() => setJc('c')} />
              <Btn icon={I.aRight} title="Align Right (Ctrl+R)" on={para?.jc === 'r'} disabled={off} run={() => setJc('r')} />
              <Btn icon={<svg viewBox="0 0 16 16"><path d="M2 3h12M2 6.3h12M2 9.6h12M2 13h12" stroke="currentColor" /></svg>}
                title="Justify (Ctrl+J)" on={para?.jc === 'j'} disabled={off} run={() => setJc('j')} />
              <span className="xl-vsep" />
              <Drop icon={W.spacing} title="Line and Paragraph Spacing" disabled={off} items={spacingItems} />
            </div>
          </div>
        </Group>

        <Group label="Styles">
          <div className="wd-styles">
            {STYLES.map((s) => (
              <button key={s.v} type="button" className={`wd-style${style === s.v ? ' on' : ''}`} disabled={off}
                onMouseDown={keep} style={s.css} title={`${s.label} style — ${targetLabel}`}
                onClick={() => onParaFormat({ style: s.v === 'Normal' ? null : s.v })}>
                <span className="wd-style-aa">AaBbCc</span>
                <span className="wd-style-name">{s.label}</span>
              </button>
            ))}
          </div>
        </Group>

        <Group label="Editing">
          <div className="xl-col">
            <Btn icon={<svg viewBox="0 0 16 16"><circle cx="9.5" cy="6" r="3.8" fill="none" stroke="#2b579a" strokeWidth="1.4" /><path d="m7 9-5 5" stroke="#2b579a" strokeWidth="1.8" /></svg>}
              label="Find" title="Find (Ctrl+F)" run={p.onFind} />
            <Btn icon={W.replace} label="Replace" title="Replace (Ctrl+H)" run={p.onFind} />
          </div>
        </Group>
      </>
    ),

    Insert: (
      <>
        <Group label="Pages">
          <Btn big icon={W.newPara} label="New Paragraph" title="Insert an empty paragraph below the selection" run={p.onInsertPara} />
          <Btn big icon={W.pageBreak} label="Page Break" title="Start the next page after the selected block" run={p.onPageBreak} />
        </Group>
        <Group label="Tables">
          <Btn big icon={I.table} label="Table" title="Insert a table below the selection" run={p.onInsertTable} />
        </Group>
        <Group label="Illustrations">
          <Btn big icon={W.picture} label="Pictures" title="Insert a PNG / JPEG / GIF / BMP picture (max 8 MB)" run={p.onInsertImage} />
        </Group>
        <Group label="Header & Footer">
          <Btn big icon={W.header} label="Header" title="Edit the page header" run={p.onHeader} />
          <Btn big icon={W.footer} label="Footer" title="Edit the page footer" run={p.onFooter} />
          <Btn big icon={W.pageNum} label="Page Number" title="Add an automatic page number to the footer" run={p.onFooter} />
        </Group>
      </>
    ),

    Layout: (
      <>
        <Group label="Page Setup" launcher={p.onPageSetup}>
          <Btn big icon={W.margins} label="Margins" title="Page margins" run={p.onPageSetup} />
          <Btn big icon={W.orient} label="Orientation" title="Portrait / landscape" run={p.onPageSetup} />
          <Btn big icon={W.size} label="Size" title="Paper size (A4, Letter…)" run={p.onPageSetup} />
          <Btn big icon={W.pageBreak} label="Breaks" title="Insert a page break" run={p.onPageBreak} />
        </Group>
        <Group label="Paragraph">
          <div className="xl-rows wd-layout-rows">
            <div className="xl-row">
              <span className="wd-lbl">Indent</span>
              <Btn icon={I.indL} title="Decrease left indent" disabled={off || indent <= 0}
                run={() => onParaFormat({ il: Math.max(0, indent - 18) || null })} />
              <span className="wd-val">{(indent / 28.35).toFixed(2)} cm</span>
              <Btn icon={I.indR} title="Increase left indent" disabled={off}
                run={() => onParaFormat({ il: Math.min(720, indent + 18) })} />
            </div>
            <div className="xl-row">
              <span className="wd-lbl">Spacing</span>
              <Btn label="−" title="Less space after paragraph" disabled={off || !para?.sa}
                run={() => onParaFormat({ sa: Math.max(0, (para?.sa ?? 0) - 6) || null })} />
              <span className="wd-val">{para?.sa ?? 0} pt</span>
              <Btn label="+" title="More space after paragraph" disabled={off}
                run={() => onParaFormat({ sa: Math.min(720, (para?.sa ?? 0) + 6) })} />
            </div>
          </div>
        </Group>
        <Group label="Arrange">
          <div className="xl-col">
            <Btn icon={W.up} label="Move Up" title="Move the selected block up" disabled={!p.canMoveUp} run={() => p.onMove(-1)} />
            <Btn icon={W.down} label="Move Down" title="Move the selected block down" disabled={!p.canMoveDown} run={() => p.onMove(1)} />
            <Btn icon={W.trash} label="Delete Block" title="Delete the selected paragraph / table / page break" disabled={!p.canDelete} run={p.onDeleteBlock} />
          </div>
        </Group>
      </>
    ),

    View: (
      <>
        <Group label="Views">
          <Btn big icon={W.printLayout} label="Print Layout" title="Page exactly as sized in the file" on={p.width === 'page'} run={() => p.onWidth('page')} />
          <Btn big icon={W.wide} label="Wide" title="Wider page (~1180px), narrower on-screen margins" on={p.width === 'wide'} run={() => p.onWidth('wide')} />
          <Btn big icon={W.webLayout} label="Web Layout" title="Page fills the whole window" on={p.width === 'full'} run={() => p.onWidth('full')} />
        </Group>
        <Group label="Show">
          <Btn big icon={W.nav} label="Navigation Pane" title="Headings outline on the left" on={p.outlineOpen} run={p.onToggleOutline} />
        </Group>
        <Group label="Zoom">
          <Btn big icon={I.zoom} label="Zoom In" title="Zoom in (Ctrl +)" disabled={p.zoom >= ZOOM_MAX} run={() => p.onZoom(1)} />
          <Btn big icon={W.oneHundred} label="100%" title="Back to 100% (Ctrl 0)" on={p.zoom === 100} run={p.onZoomReset} />
          <Btn big icon={<svg viewBox="0 0 32 32"><circle cx="14" cy="14" r="8" fill="none" stroke="currentColor" strokeWidth="2" /><path d="m20 20 7 7M10 14h8" stroke="currentColor" strokeWidth="2.4" /></svg>}
            label="Zoom Out" title="Zoom out (Ctrl −)" disabled={p.zoom <= ZOOM_MIN} run={() => p.onZoom(-1)} />
        </Group>
        <Group label="Print">
          <Btn big icon={W.print} label="Print / PDF" title="Print, or choose “Save as PDF” (Ctrl+P)" run={p.onPrint} />
        </Group>
      </>
    ),

    Table: (
      <>
        <Group label="Rows & Columns">
          <Btn big icon={W.rowAbove} label="Insert Above" run={() => p.onTableRow('above')} />
          <Btn big icon={W.rowBelow} label="Insert Below" run={() => p.onTableRow('below')} />
          <Btn big icon={W.colLeft} label="Insert Left" run={() => p.onTableCol('left')} />
          <Btn big icon={W.colRight} label="Insert Right" run={() => p.onTableCol('right')} />
        </Group>
        <Group label="Delete">
          <div className="xl-col">
            <Btn icon={W.trash} label="Delete Row" run={p.onTableRowDelete} />
            <Btn icon={W.trash} label="Delete Column" run={p.onTableColDelete} />
            <Btn icon={W.trash} label="Delete Table" disabled={!p.canDelete} run={p.onDeleteBlock} />
          </div>
        </Group>
        <Group label="Borders">
          <Btn big icon={W.borders} label="Borders" title="Show / hide the table grid lines" run={p.onTableBorder} />
        </Group>
      </>
    ),
  };

  const tabs: Tab[] = ['File', 'Home', 'Insert', 'Layout', 'View', ...(inTable ? ['Table' as const] : [])];

  return (
    <div className="xl-shell wd-shell">
      {/* ── Thanh tiêu đề: Quick Access + tên file ── */}
      <div className="xl-title">
        <div className="xl-qat">
          <span className="wd-app-ico" aria-hidden>{W.doc}</span>
          <button type="button" className="xl-qbtn" onMouseDown={keep} onClick={p.onSave} disabled={!p.canSave}
            title={p.saveTitle}>{p.saving ? <span className="spinner" aria-hidden /> : I.save}</button>
          <button type="button" className="xl-qbtn" onMouseDown={keep} disabled={!p.canUndo} onClick={p.onUndo} title="Undo (Ctrl+Z)">{I.undo}</button>
          <button type="button" className="xl-qbtn" onMouseDown={keep} disabled={!p.canRedo} onClick={p.onRedo} title="Redo (Ctrl+Y)">{I.redo}</button>
        </div>
        <div className="xl-title-name" title={p.filePath}>{fileName}{p.dirty > 0 ? ' •' : ''} - Word</div>
        <div className="xl-title-right">
          {p.dirty > 0 && <span className="xl-dirty" title="Unsaved changes">{p.dirty} unsaved</span>}
          <button type="button" className="xl-title-btn" onClick={p.onOpenExternal}
            title="Open in the desktop app (Word / WPS / LibreOffice). Save there and come back — this view reloads by itself.">
            Open in desktop app
          </button>
        </div>
      </div>

      {/* ── Dải tab ── */}
      <div className="xl-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={t === tab}
            className={`xl-tab${t === tab ? ' on' : ''}${t === 'File' ? ' file' : ''}${t === 'Table' ? ' ctx' : ''}`}
            onClick={() => { setTab(t); if (collapsed && t !== 'File') toggleCollapsed(); }}>
            {t === 'Table' ? 'Table Layout' : t}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" className="xl-save" onClick={p.onSave} disabled={!p.canSave} title={p.saveTitle}>
          {p.saving ? <span className="spinner" aria-hidden /> : I.save} Save
        </button>
      </div>

      {/* ── Ribbon / trang File ── */}
      {tab === 'File' ? (
        <div className="xl-backstage">
          <div className="xl-bs-menu">
            <button type="button" onClick={() => setTab('Home')}>← Back</button>
            <button type="button" onClick={p.onSave} disabled={!p.canSave} title={p.saveTitle}>Save</button>
            <button type="button" onClick={p.onNewFile} disabled={!p.allowWrite}
              title={p.allowWrite ? 'New document from a template' : 'Set OFFICE_ALLOW_WRITE=true in .env.local'}>New</button>
            <button type="button" onClick={p.onOpenFile}>Open…</button>
            <button type="button" onClick={p.onReload}>Reload from disk</button>
            <button type="button" onClick={p.onPrint}>Print / Save as PDF</button>
            <button type="button" onClick={p.onOpenExternal}>Open in desktop Word</button>
          </div>
          <div className="xl-bs-info">
            <h3>Info</h3>
            <div className="xl-bs-file">{fileName} <span className="xl-bs-kind">DOCX</span></div>
            <div className="xl-empty" style={{ padding: 0 }}>
              <div>{p.filePath}</div>
              <div>{fmtBytes(p.sizeBytes)} · {p.stats.words.toLocaleString('vi')} words · {p.stats.chars.toLocaleString('vi')} characters
                {' · '}{p.stats.paras} paragraphs{p.stats.tables > 0 && ` · ${p.stats.tables} tables`} · ~{p.stats.pages} pages</div>
              <div style={{ marginTop: 8 }}>Saving overwrites the file directly (no .bak copy). Paragraphs you did not touch keep their exact original formatting.</div>
            </div>
          </div>
        </div>
      ) : !collapsed && (
        <Ribbon label={tab} items={toItems(body[tab])} onCollapse={toggleCollapsed} />
      )}
      {collapsed && tab !== 'File' && (
        <button type="button" className="xl-expand" onClick={toggleCollapsed} title="Show the Ribbon">⌄ Show ribbon</button>
      )}
    </div>
  );
}

/** Thanh trạng thái dưới cùng như Word: trang · số từ · thanh zoom. */
export function WordStatusBar({ stats, zoom, onZoom, onZoomReset, dirty, notice }: {
  stats: WordDocStats; zoom: number; onZoom: (dir: -1 | 1) => void; onZoomReset: () => void;
  dirty: number; notice: string | null;
}) {
  return (
    <div className="wd-status">
      <span title="Estimated — the real layout is decided by Word">Page ~{stats.pages}</span>
      <span>{stats.words.toLocaleString('vi')} words</span>
      <span>{stats.chars.toLocaleString('vi')} characters</span>
      {dirty > 0 && <span className="wd-status-dirty">● {dirty} unsaved</span>}
      {notice && <span className="wd-status-note">{notice}</span>}
      <span style={{ flex: 1 }} />
      <button type="button" onClick={() => onZoom(-1)} disabled={zoom <= ZOOM_MIN} title="Zoom out">−</button>
      <span className="wd-zoom-track" aria-hidden>
        <span className="wd-zoom-knob" style={{ left: `${((zoom - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)) * 100}%` }} />
      </span>
      <button type="button" onClick={() => onZoom(1)} disabled={zoom >= ZOOM_MAX} title="Zoom in">+</button>
      <button type="button" className="wd-zoom-val" onClick={onZoomReset} title="Back to 100%">{zoom}%</button>
    </div>
  );
}
