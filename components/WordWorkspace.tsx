'use client';

// Word editor (Office tab) — trình soạn thảo .docx chạy trên máy local
// (server gate bằng OFFICE_TOOL_ENABLED). Đủ dùng để một nhân viên văn phòng
// soạn báo cáo gửi sếp: định dạng chữ và đoạn, danh sách, bảng, đầu/chân
// trang có số trang, mục lục, tìm & thay thế, đếm chữ, in / xuất PDF.
//
// Mô hình sửa giống hệt Sheet editor: bản làm việc trong bộ nhớ + một OP LOG.
// Bấm Lưu là gửi op log lên server; server đọc lại .docx từ đĩa rồi phát lại
// từng op lên word/document.xml, nên MỌI đoạn không đụng tới đều giữ nguyên
// 100% định dạng gốc. Lưu là thao tác GHI duy nhất, sau OFFICE_ALLOW_WRITE +
// hộp thoại xác nhận + backup `.bak`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FolderPicker from './FolderPicker';
import OfficeNewFileModal from './OfficeNewFileModal';
import WordFormatBar from './WordFormatBar';
import WordDocView, { type Block, type CellRef, type TextRange } from './WordDocView';
import WordFindPanel from './WordFindPanel';
import WordOutline from './WordOutline';
import WordHeaderFooterModal from './WordHeaderFooterModal';
import WordInsertTableModal from './WordInsertTableModal';
import { fmtBytes } from '@/lib/sheet';
import {
  applyParaPatch, commonRunFormat, mergeRuns, patchRunRange, runsText,
  fetchWordFlags, openWordFile, createWordFile, saveWordFile,
  type HeaderFooter, type PageSetup, type ParaFormatPatch, type RunFormatPatch,
  type RunSpan, type TableCell, type WordFlags, type WordOp, type WordOpenResult,
  type WordTemplate,
} from '@/lib/word';
import {
  buildOutline, buildPrintHtml, docStats, findAll, replaceInRuns,
  type SearchOptions,
} from '@/lib/wordDocUtils';

const RECENT_KEY = 'word.recent';

const TEMPLATES = [
  { v: 'blank', label: 'Trang trắng', hint: 'Bắt đầu từ tài liệu trống', icon: '📄' },
  { v: 'report', label: 'Báo cáo công việc', hint: 'Quốc hiệu, bảng kết quả, chỗ ký', icon: '📊' },
  { v: 'minutes', label: 'Biên bản họp', hint: 'Thành phần, nội dung, phân công', icon: '📝' },
  { v: 'proposal', label: 'Tờ trình', hint: 'Căn cứ, đề xuất, dự toán', icon: '📨' },
];

function loadRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecent(list: string[]) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)));
  } catch { /* recents are a nicety */ }
}

/** Folder part of an absolute path (for pre-filling the create-new dialog). */
function dirOf(p: string): string {
  return p.replace(/[\\/][^\\/]*$/, '');
}

/** Plain text → một run duy nhất, giữ định dạng của run đầu đoạn cũ. */
function textToRuns(text: string, prev: RunSpan[]): RunSpan[] {
  if (text === '') return [];
  const f = prev[0]?.f;
  return [{ t: text, ...(f ? { f } : {}) }];
}

/**
 * Ghép văn bản mới vào các run cũ, cố giữ định dạng những cụm không đổi.
 * Trường hợp thường gặp nhất là sửa một chỗ nhỏ trong đoạn nhiều định dạng:
 * ta so đầu và đuôi để biết phần nào giữ nguyên, phần giữa thì mang định dạng
 * của chỗ bị thay.
 */
function spliceRuns(prev: RunSpan[], next: string): RunSpan[] {
  const before = runsText(prev);
  if (before === next) return prev;
  if (prev.length <= 1) return textToRuns(next, prev);

  let head = 0;
  const maxHead = Math.min(before.length, next.length);
  while (head < maxHead && before[head] === next[head]) head++;

  let tail = 0;
  const maxTail = Math.min(before.length - head, next.length - head);
  while (tail < maxTail && before[before.length - 1 - tail] === next[next.length - 1 - tail]) tail++;

  const slice = (from: number, to: number): RunSpan[] => {
    const out: RunSpan[] = [];
    let pos = 0;
    for (const r of prev) {
      const end = pos + r.t.length;
      if (end > from && pos < to) {
        const part = r.t.slice(Math.max(0, from - pos), Math.min(r.t.length, to - pos));
        if (part) out.push({ t: part, ...(r.f ? { f: r.f } : {}) });
      }
      pos = end;
    }
    return out;
  };
  /** Định dạng tại vị trí `at` — dùng cho phần văn bản mới chèn vào. */
  const formatAt = (at: number): RunSpan['f'] => {
    let pos = 0;
    for (const r of prev) {
      const end = pos + r.t.length;
      if (at < end) return r.f;
      pos = end;
    }
    return prev[prev.length - 1]?.f;
  };

  const middle = next.slice(head, next.length - tail);
  const f = formatAt(Math.min(head, before.length - 1));
  return mergeRuns([
    ...slice(0, head),
    ...(middle ? [{ t: middle, ...(f ? { f } : {}) }] : []),
    ...slice(before.length - tail, before.length),
  ]);
}

/**
 * Editor này là MỘT tài liệu. Mở nhiều file = mount nhiều instance (xem
 * OfficeWorkspace) — mọi state file nằm trong đây nên các tab hoàn toàn độc lập.
 */
export interface WordWorkspaceProps {
  /** Mở sẵn file này lúc mount (tab được tạo từ "Mở văn bản"); bỏ trống → hiện màn hình chào. */
  initialPath?: string;
  /** Báo tên file + số thay đổi chưa lưu lên dãy tab của Office. */
  onDocState?: (s: { path: string | null; dirtyCount: number }) => void;
  /**
   * Tab này có đang được xem không. Nhiều instance cùng MOUNT một lúc (mỗi tab
   * một tài liệu) mà phím tắt lại bắt trên `window`, nên bản bị che PHẢI bỏ qua
   * — không thì Ctrl+S mở hộp thoại lưu của cả tài liệu đang không nhìn thấy.
   */
  active?: boolean;
}

export default function WordWorkspace({ initialPath, onDocState, active = true }: WordWorkspaceProps = {}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [flags, setFlags] = useState<WordFlags | null>(null);

  const [file, setFile] = useState<WordOpenResult | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [headers, setHeaders] = useState<HeaderFooter[]>([]);
  const [footers, setFooters] = useState<HeaderFooter[]>([]);
  const [page, setPage] = useState<PageSetup>({ w: 595, h: 842, mt: 72, mr: 72, mb: 72, ml: 72 });
  const [ops, setOps] = useState<WordOp[]>([]);

  const [sel, setSel] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [range, setRange] = useState<TextRange | null>(null);
  const [cell, setCell] = useState<CellRef | null>(null);
  const [editingCell, setEditingCell] = useState<CellRef | null>(null);

  const [recent, setRecent] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [hfOpen, setHfOpen] = useState<'header' | 'footer' | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [focusBlock, setFocusBlock] = useState<number | null>(null);
  const [hits, setHits] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((m: string) => {
    setNotice(m);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  useEffect(() => {
    setRecent(loadRecent());
    fetchWordFlags()
      .then((f) => { setFlags(f); setEnabled(true); })
      .catch((e) => {
        if ((e as Error & { status?: number }).status === 403) setEnabled(false);
        else { setEnabled(true); setErr((e as Error).message); }
      });
  }, []);

  const dirtyCount = ops.length;

  const applyOpen = useCallback((res: WordOpenResult) => {
    setFile(res);
    setBlocks(res.blocks.slice());
    setHeaders(res.headers);
    setFooters(res.footers);
    setPage(res.page);
    setOps([]);
    setSel(null); setEditing(null); setRange(null);
    setCell(null); setEditingCell(null);
    setHits(new Set()); setFocusBlock(null);
    setPickerOpen(false);
    const list = [res.path, ...loadRecent().filter((x) => x !== res.path)];
    saveRecent(list); setRecent(list.slice(0, 10));
  }, []);

  const openPath = useCallback(async (p: string) => {
    setBusy(true); setErr(null);
    try {
      applyOpen(await openWordFile(p));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [applyOpen]);

  // Tab được tạo kèm đường dẫn → mở luôn, khỏi bắt bấm lại lần nữa. Đợi
  // `enabled` để không gọi API khi tool đang tắt; ref chặn mở lại nếu người dùng
  // đã đóng file đó trong cùng tab.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!initialPath || seededRef.current || enabled !== true) return;
    seededRef.current = true;
    void openPath(initialPath);
  }, [initialPath, enabled, openPath]);

  // Dãy tab của Office cần tên file + số thay đổi để hiện dấu ●.
  useEffect(() => {
    onDocState?.({ path: file?.path ?? null, dirtyCount });
  }, [file?.path, dirtyCount, onDocState]);

  const doCreate = useCallback(async (dir: string, name: string, template?: string) => {
    setBusy(true); setErr(null);
    try {
      const res = await createWordFile(dir, name, (template ?? 'blank') as WordTemplate);
      applyOpen(res);
      setCreateOpen(false);
      flash(`Đã tạo file mới: ${res.path}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [applyOpen, flash]);

  const confirmDiscard = useCallback((what: string) => (
    dirtyCount === 0 || window.confirm(`Đang có ${dirtyCount} thay đổi chưa lưu — ${what} sẽ mất hết. Tiếp tục?`)
  ), [dirtyCount]);

  const openCreate = useCallback(() => {
    if (!confirmDiscard('tạo file mới')) return;
    setErr(null); setCreateOpen(true);
  }, [confirmDiscard]);

  const reload = useCallback(() => {
    if (!file || !confirmDiscard('tải lại')) return;
    void openPath(file.path);
  }, [file, confirmDiscard, openPath]);

  // ── Op log ──────────────────────────────────────────────────────────────────

  const pushOp = useCallback((op: WordOp) => setOps((os) => [...os, op]), []);

  /** Đánh dấu một block là đã sửa (để tô nền cảnh báo). */
  const markDirty = useCallback((i: number) => {
    setBlocks((bs) => {
      const b = bs[i];
      if (!b || b.d) return bs;
      const nb = bs.slice();
      nb[i] = { ...b, d: true };
      return nb;
    });
  }, []);

  // ── Sửa nội dung đoạn ───────────────────────────────────────────────────────

  // Lưu ý: mọi handler dưới đây tính op TRƯỚC rồi mới gọi setBlocks/setOps.
  // Không gọi setOps bên trong updater của setBlocks — React 18 (StrictMode)
  // chạy updater hai lần nên op sẽ bị đẩy vào log hai lần.
  const commitEdit = useCallback((i: number, text: string) => {
    setEditing(null);
    setRange(null);
    const cur = blocks[i];
    if (!cur || cur.kind !== 'p' || runsText(cur.runs) === text) return;
    const runs = spliceRuns(cur.runs, text);
    setBlocks((bs) => {
      const b = bs[i];
      if (!b || b.kind !== 'p') return bs;
      const nb = bs.slice();
      nb[i] = { ...b, runs, d: true };
      return nb;
    });
    pushOp({ op: 'set', i, runs });
  }, [blocks, pushOp]);

  const insertPara = useCallback((at: number) => {
    setBlocks((bs) => {
      const nb = bs.slice();
      nb.splice(Math.min(at, nb.length), 0, { kind: 'p', runs: [], d: true });
      return nb;
    });
    pushOp({ op: 'insert', i: at, runs: [] });
    setSel(at); setEditing(at);
  }, [pushOp]);

  const deleteBlock = useCallback(() => {
    if (sel === null) return;
    const at = sel;
    if (!blocks[at]) return;
    setBlocks((bs) => {
      const nb = bs.slice();
      nb.splice(at, 1);
      return nb;
    });
    pushOp({ op: 'delete', i: at });
    setSel(null); setEditing(null); setCell(null); setEditingCell(null);
  }, [sel, blocks, pushOp]);

  const moveBlock = useCallback((dir: -1 | 1) => {
    if (sel === null) return;
    const to = sel + dir;
    if (to < 0 || to >= blocks.length) return;
    setBlocks((bs) => {
      const nb = bs.slice();
      const [b] = nb.splice(sel, 1);
      nb.splice(to, 0, { ...b, d: true });
      return nb;
    });
    pushOp({ op: 'move', i: sel, to });
    setSel(to); setEditing(null);
  }, [sel, blocks.length, pushOp]);

  // ── Định dạng ───────────────────────────────────────────────────────────────

  const applyRunFormat = useCallback((p: RunFormatPatch) => {
    // Đang sửa một ô bảng → áp cho cả ô.
    if (cell && !editing) {
      const { block: bi, r, c } = cell;
      setBlocks((bs) => {
        const b = bs[bi];
        if (!b || b.kind !== 'tbl') return bs;
        const rows = b.rows.map((row, ri) => (ri !== r ? row : row.map((tc, ci) => {
          if (ci !== c) return tc;
          return {
            ...tc,
            paras: tc.paras.map((para) => ({
              ...para,
              runs: patchRunRange(para.runs, 0, runsText(para.runs).length, p),
            })),
          } satisfies TableCell;
        })));
        const nb = bs.slice();
        nb[bi] = { ...b, rows, d: true };
        return nb;
      });
      pushOp({ op: 'cellFmt', i: bi, r, c, f: p });
      return;
    }

    if (sel === null) return;
    const target = sel;
    const cur = blocks[target];
    if (!cur || cur.kind !== 'p') return;
    // Bôi đen cụm từ → chỉ áp cho cụm đó; không thì áp cả đoạn.
    const from = range && editing === target ? range.from : 0;
    const to = range && editing === target ? range.to : runsText(cur.runs).length;
    const runs = patchRunRange(cur.runs, from, to, p);
    setBlocks((bs) => {
      const b = bs[target];
      if (!b || b.kind !== 'p') return bs;
      const nb = bs.slice();
      nb[target] = { ...b, runs, d: true };
      return nb;
    });
    pushOp({ op: 'runFmt', i: target, from, to, f: p });
  }, [sel, range, editing, cell, blocks, pushOp]);

  const applyParaFormat = useCallback((p: ParaFormatPatch) => {
    if (sel === null) return;
    const target = sel;
    setBlocks((bs) => {
      const b = bs[target];
      if (!b || b.kind !== 'p') return bs;
      const nb = bs.slice();
      nb[target] = { ...b, fmt: applyParaPatch(b.fmt, p), d: true };
      return nb;
    });
    pushOp({ op: 'paraFmt', i: target, f: p });
  }, [sel, pushOp]);

  // ── Bảng ────────────────────────────────────────────────────────────────────

  const insertTable = useCallback((rows: number, cols: number, header: boolean) => {
    const at = sel !== null ? sel + 1 : blocks.length;
    const blank = { paras: [{ runs: [] as RunSpan[] }] };
    const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ ...blank })));
    setBlocks((bs) => {
      const nb = bs.slice();
      nb.splice(at, 0,
        { kind: 'tbl', rows: grid, bordered: true, ...(header ? { headerRow: true } : {}), d: true },
        { kind: 'p', runs: [], d: true });
      return nb;
    });
    pushOp({ op: 'tblInsert', i: at, rows, cols, ...(header ? { header: 1 as const } : {}) });
    setTableOpen(false);
    setSel(at);
    flash(`Đã chèn bảng ${rows}×${cols} — bấm đúp vào ô để nhập nội dung.`);
  }, [sel, blocks.length, pushOp, flash]);

  const commitCell = useCallback((ref: CellRef, text: string) => {
    setEditingCell(null);
    const cur = blocks[ref.block];
    if (!cur || cur.kind !== 'tbl') return;
    const tc = cur.rows[ref.r]?.[ref.c];
    if (!tc) return;
    if (tc.paras.map((p) => runsText(p.runs)).join('\n') === text) return;
    const runs = spliceRuns(tc.paras[0]?.runs ?? [], text);
    setBlocks((bs) => {
      const b = bs[ref.block];
      if (!b || b.kind !== 'tbl') return bs;
      const rows = b.rows.map((row, ri) => (ri !== ref.r ? row : row.map((old, ci) => (
        ci !== ref.c ? old : { ...old, paras: [{ runs, ...(old.paras[0]?.fmt ? { fmt: old.paras[0].fmt } : {}) }] }
      ))));
      const nb = bs.slice();
      nb[ref.block] = { ...b, rows, d: true };
      return nb;
    });
    pushOp({ op: 'cellSet', i: ref.block, r: ref.r, c: ref.c, runs });
  }, [blocks, pushOp]);

  const tableRowOp = useCallback((where: 'above' | 'below') => {
    if (!cell) return;
    setBlocks((bs) => {
      const b = bs[cell.block];
      if (!b || b.kind !== 'tbl') return bs;
      const cols = b.rows[cell.r]?.length ?? 1;
      const fresh = Array.from({ length: cols }, () => ({ paras: [{ runs: [] as RunSpan[] }] }));
      const rows = b.rows.slice();
      rows.splice(where === 'above' ? cell.r : cell.r + 1, 0, fresh);
      const nb = bs.slice();
      nb[cell.block] = { ...b, rows, d: true };
      return nb;
    });
    pushOp({ op: 'tblRowInsert', i: cell.block, r: cell.r, where });
  }, [cell, pushOp]);

  const tableRowDelete = useCallback(() => {
    if (!cell) return;
    const b = blocks[cell.block];
    if (!b || b.kind !== 'tbl') return;
    if (b.rows.length <= 1) { setErr('Bảng phải còn ít nhất một dòng.'); return; }
    setBlocks((bs) => {
      const cur = bs[cell.block];
      if (!cur || cur.kind !== 'tbl') return bs;
      const rows = cur.rows.filter((_, ri) => ri !== cell.r);
      const nb = bs.slice();
      nb[cell.block] = { ...cur, rows, d: true };
      return nb;
    });
    pushOp({ op: 'tblRowDelete', i: cell.block, r: cell.r });
    setCell(null); setEditingCell(null);
  }, [cell, blocks, pushOp]);

  const tableColOp = useCallback((where: 'left' | 'right') => {
    if (!cell) return;
    setBlocks((bs) => {
      const b = bs[cell.block];
      if (!b || b.kind !== 'tbl') return bs;
      const at = where === 'left' ? cell.c : cell.c + 1;
      const rows = b.rows.map((row) => {
        const next = row.slice();
        next.splice(Math.min(at, next.length), 0, { paras: [{ runs: [] }] });
        return next;
      });
      const nb = bs.slice();
      nb[cell.block] = { ...b, rows, d: true };
      return nb;
    });
    pushOp({ op: 'tblColInsert', i: cell.block, c: cell.c, where });
  }, [cell, pushOp]);

  const tableColDelete = useCallback(() => {
    if (!cell) return;
    const b = blocks[cell.block];
    if (!b || b.kind !== 'tbl') return;
    if ((b.rows[0]?.length ?? 0) <= 1) { setErr('Bảng phải còn ít nhất một cột.'); return; }
    setBlocks((bs) => {
      const cur = bs[cell.block];
      if (!cur || cur.kind !== 'tbl') return bs;
      const rows = cur.rows.map((row) => row.filter((_, ci) => ci !== cell.c));
      const nb = bs.slice();
      nb[cell.block] = { ...cur, rows, d: true };
      return nb;
    });
    pushOp({ op: 'tblColDelete', i: cell.block, c: cell.c });
    setCell(null); setEditingCell(null);
  }, [cell, blocks, pushOp]);

  const tableBorderToggle = useCallback(() => {
    if (!cell) return;
    const b = blocks[cell.block];
    if (!b || b.kind !== 'tbl') return;
    const on = !(b.bordered !== false);
    setBlocks((bs) => {
      const cur = bs[cell.block];
      if (!cur || cur.kind !== 'tbl') return bs;
      const nb = bs.slice();
      nb[cell.block] = { ...cur, bordered: on, d: true };
      return nb;
    });
    pushOp({ op: 'tblBorder', i: cell.block, on: on ? 1 : 0 });
  }, [cell, blocks, pushOp]);

  // ── Ngắt trang ──────────────────────────────────────────────────────────────

  const insertPageBreak = useCallback(() => {
    const at = sel !== null ? sel + 1 : blocks.length;
    setBlocks((bs) => {
      const nb = bs.slice();
      nb.splice(at, 0, { kind: 'br', d: true });
      return nb;
    });
    pushOp({ op: 'pageBreak', i: at });
    setSel(at);
  }, [sel, blocks.length, pushOp]);

  // ── Đầu / chân trang ────────────────────────────────────────────────────────

  const applyHeaderFooter = useCallback((part: 'header' | 'footer', text: string, jc: 'l' | 'c' | 'r', pageNum: boolean) => {
    const hf: HeaderFooter = {
      type: 'default',
      paras: [{ runs: text ? [{ t: text }] : [], fmt: { jc } }],
      ...(pageNum ? { hasPageNum: true as const } : {}),
    };
    const swap = (list: HeaderFooter[]) => [hf, ...list.filter((x) => x.type !== 'default')];
    if (part === 'header') setHeaders(swap); else setFooters(swap);
    pushOp({ op: 'hfSet', part, text, jc, pageNum: pageNum ? 1 : 0 });
    setHfOpen(null);
    flash(`Đã đặt ${part === 'header' ? 'đầu trang' : 'chân trang'} — bấm Lưu để ghi vào file.`);
  }, [pushOp, flash]);

  // ── Tìm & thay thế ──────────────────────────────────────────────────────────

  const jumpTo = useCallback((i: number) => {
    setSel(i);
    setFocusBlock(i);
    const el = scrollRef.current?.querySelector(`[data-block="${i}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  const runFind = useCallback((find: string, opts: SearchOptions) => {
    const found = findAll(blocks, find, opts);
    setHits(new Set(found.map((h) => h.i)));
    return found;
  }, [blocks]);

  const runReplaceAll = useCallback((find: string, replace: string, opts: SearchOptions) => {
    const found = findAll(blocks, find, opts);
    if (found.length === 0) return 0;
    // Việc thay thế thật do server làm khi lưu (một op cho cả tài liệu); ở đây
    // chỉ cập nhật bản xem để người dùng thấy ngay kết quả.
    // Đoạn / ô bị khóa được BỎ QUA đúng như server, để bản xem trước và con số
    // báo cho người dùng khớp với những gì thực sự ghi xuống file.
    setBlocks((bs) => bs.map((b) => {
      if (b.kind === 'p') {
        if (b.locked) return b;
        const next = replaceInRuns(b.runs, find, replace, opts);
        return next ? { ...b, runs: next, d: true } : b;
      }
      if (b.kind === 'tbl') {
        let tableTouched = false;
        const rows = b.rows.map((row) => row.map((tc) => {
          if (tc.locked) return tc;
          let cellTouched = false;
          const paras = tc.paras.map((p) => {
            const next = replaceInRuns(p.runs, find, replace, opts);
            if (!next) return p;
            cellTouched = true;
            return { ...p, runs: next };
          });
          if (!cellTouched) return tc;
          tableTouched = true;
          return { ...tc, paras };
        }));
        return tableTouched ? { ...b, rows, d: true } : b;
      }
      return b;
    }));
    pushOp({
      op: 'replaceAll', find, replace,
      matchCase: opts.matchCase ? 1 : 0, whole: opts.whole ? 1 : 0,
    });
    setHits(new Set());
    flash(`Đã thay ${found.length} chỗ — bấm Lưu để ghi vào file.`);
    return found.length;
  }, [blocks, pushOp, flash]);

  // ── In / xuất PDF ───────────────────────────────────────────────────────────

  const doPrint = useCallback(() => {
    if (!file) return;
    const name = file.path.split(/[\\/]/).pop() ?? 'tai-lieu';
    const html = buildPrintHtml(blocks, page, headers, footers, name.replace(/\.docx$/i, ''));
    const w = window.open('', '_blank');
    if (!w) { setErr('Trình duyệt chặn cửa sổ in — hãy cho phép pop-up cho trang này.'); return; }
    w.document.write(html);
    w.document.close();
    // Đợi font/layout xong rồi mới gọi hộp thoại in.
    w.addEventListener('load', () => { w.focus(); w.print(); });
  }, [file, blocks, page, headers, footers]);

  // ── Lưu ─────────────────────────────────────────────────────────────────────

  const doSave = useCallback(async () => {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const res = await saveWordFile(file.path, file.mtimeMs, ops);
      setFile((f) => (f ? { ...f, mtimeMs: res.mtimeMs, sizeBytes: res.sizeBytes } : f));
      setOps([]);
      setBlocks((bs) => bs.map((b) => (b.d ? { ...b, d: undefined } : b)));
      setSaveOpen(false);
      flash(`Đã lưu ✓${res.replaced ? ` (thay ${res.replaced} chỗ)` : ''} · backup: ${res.backupPath}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [file, ops, flash]);

  // ── Phím tắt ────────────────────────────────────────────────────────────────

  const allowWrite = flags?.allowWrite === true;

  useEffect(() => {
    // Tab bị che không nhận phím tắt — xem `active` trong WordWorkspaceProps.
    if (!file || !active) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'f') { e.preventDefault(); setFindOpen(true); }
      else if (k === 'b') { e.preventDefault(); applyRunFormat({ b: 1 }); }
      else if (k === 'i') { e.preventDefault(); applyRunFormat({ i: 1 }); }
      else if (k === 'u') { e.preventDefault(); applyRunFormat({ u: 1 }); }
      else if (k === 'p') { e.preventDefault(); doPrint(); }
      else if (k === 's') {
        e.preventDefault();
        if (allowWrite && ops.length > 0) setSaveOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [file, active, applyRunFormat, doPrint, allowWrite, ops.length]);

  // ── Dẫn xuất cho thanh công cụ ──────────────────────────────────────────────

  const selBlock = sel !== null ? blocks[sel] : undefined;
  const selPara = selBlock?.kind === 'p' ? selBlock : undefined;
  const selCell = useMemo(() => {
    if (!cell) return undefined;
    const b = blocks[cell.block];
    return b?.kind === 'tbl' ? b.rows[cell.r]?.[cell.c] : undefined;
  }, [cell, blocks]);

  /** Định dạng chữ hiệu dụng ở chỗ đang chọn — quyết định nút nào sáng. */
  const activeRunFormat = useMemo(() => {
    if (selCell) return commonRunFormat(selCell.paras[0]?.runs ?? [], 0, Number.MAX_SAFE_INTEGER);
    if (!selPara) return undefined;
    const len = runsText(selPara.runs).length;
    const from = range && editing === sel ? range.from : 0;
    const to = range && editing === sel ? range.to : len;
    return commonRunFormat(selPara.runs, from, to);
  }, [selPara, selCell, range, editing, sel]);

  const outline = useMemo(() => buildOutline(blocks), [blocks]);
  const stats = useMemo(() => docStats(blocks, page), [blocks, page]);

  // ── Gate / loading ──────────────────────────────────────────────────────────

  if (enabled === false) {
    return (
      <div className="panel" style={{ margin: 'auto', width: 'min(560px, 94%)' }}>
        <div className="office-hero">
          <div className="office-hero-ico" aria-hidden>🗎</div>
          <div className="office-hero-title">Office tab đang tắt</div>
          <p className="office-hero-sub">
            Đặt <code>OFFICE_TOOL_ENABLED=true</code> trong <code>.env.local</code> rồi khởi động lại dev server để bật.
            Muốn LƯU (ghi đè file, luôn kèm backup <code>.bak</code>) thì đặt thêm <code>OFFICE_ALLOW_WRITE=true</code> — chỉ dùng local.
          </p>
        </div>
      </div>
    );
  }
  if (enabled === null) {
    return <div className="panel" style={{ margin: 'auto' }}><span className="spinner" /> Đang tải…</div>;
  }

  // ── Màn hình chào ───────────────────────────────────────────────────────────

  if (!file) {
    return (
      <div className="panel office-hero-panel" style={{ margin: 'auto', width: 'min(680px, 94%)' }}>
        <div className="office-hero">
          <div className="office-hero-ico" aria-hidden>🗎</div>
          <div className="office-hero-title">Word Editor</div>
          <p className="office-hero-sub">
            Mở file <code>.docx</code> trên máy — soạn thảo, định dạng, kẻ bảng
            rồi lưu ghi đè an toàn.
          </p>
          <div className="office-hero-points">
            <span className="office-point">✎ Định dạng chữ &amp; đoạn</span>
            <span className="office-point">▦ Bảng sửa được từng ô</span>
            <span className="office-point">🔢 Đầu/chân trang &amp; số trang</span>
            <span className="office-point">🔎 Tìm &amp; thay thế · mục lục</span>
            <span className="office-point">🖨 In / xuất PDF</span>
            <span className="office-point">🛟 Tự backup .bak khi lưu</span>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="office-cta" onClick={() => setPickerOpen(true)} disabled={busy}>
              {busy ? <span className="spinner" aria-hidden /> : '📂'} Chọn file…
            </button>
            <button
              className="office-cta ghost"
              onClick={openCreate}
              disabled={busy || !allowWrite}
              title={!allowWrite ? 'Tạo file cần quyền ghi — đặt OFFICE_ALLOW_WRITE=true trong .env.local' : 'Tạo file .docx mới từ mẫu có sẵn'}
            >
              ＋ Tạo file mới
            </button>
          </div>
          {err && !createOpen && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', maxWidth: '100%' }}>{err}</pre>}
        </div>
        {recent.length > 0 && (
          <div className="office-recent-wrap">
            <div className="group-title" style={{ margin: '0 4px 6px' }}>Mở gần đây</div>
            <div className="office-recent">
              {recent.map((p) => {
                const base = p.split(/[\\/]/).pop() ?? p;
                const dir = p.slice(0, p.length - base.length).replace(/[\\/]$/, '');
                return (
                  <button key={p} className="office-recent-row" onClick={() => void openPath(p)} title={p}>
                    <span className="picker-ico" aria-hidden>📝</span>
                    <span className="office-recent-name">
                      <span className="office-recent-base">{base}</span>
                      <span className="office-recent-dir">{dir}</span>
                    </span>
                    <span className="picker-into" aria-hidden>›</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {pickerOpen && (
          <FolderPicker
            title="Chọn file .docx"
            fileExts={['docx']}
            onPickFile={(p) => void openPath(p)}
            onPick={() => {}}
            onClose={() => setPickerOpen(false)}
          />
        )}
        {createOpen && (
          <OfficeNewFileModal
            title="＋ Tạo văn bản mới"
            exts={['docx']}
            templates={TEMPLATES}
            initialDir={recent[0] ? dirOf(recent[0]) : undefined}
            busy={busy}
            err={err}
            onCreate={(dir, name, tpl) => void doCreate(dir, name, tpl)}
            onClose={() => { setCreateOpen(false); setErr(null); }}
          />
        )}
      </div>
    );
  }

  // ── Trình soạn thảo ─────────────────────────────────────────────────────────

  const opCount = (kinds: WordOp['op'][]) => ops.filter((o) => kinds.includes(o.op)).length;
  const textEdits = opCount(['set', 'cellSet', 'replaceAll']);
  const fmtEdits = opCount(['runFmt', 'paraFmt', 'cellFmt', 'tblBorder']);
  const structEdits = opCount([
    'insert', 'delete', 'move', 'pageBreak', 'tblInsert',
    'tblRowInsert', 'tblRowDelete', 'tblColInsert', 'tblColDelete', 'hfSet',
  ]);

  const targetLabel = cell
    ? `ô (${cell.r + 1}, ${cell.c + 1})`
    : sel !== null
      ? (range && editing === sel ? 'cụm từ đang bôi đen' : `đoạn ${sel + 1}`)
      : 'chỗ đang chọn';

  return (
    <div className="panel sheet-panel">
      <div className="sheet-toolbar">
        <span className="picker-cwd small" title={file.path}>{file.path}</span>
        <span className="badge">DOCX</span>
        <span className="badge" title="Kích thước file">{fmtBytes(file.sizeBytes)}</span>
        <button className="ghost sm" onClick={reload} disabled={busy} title="Đọc lại file từ đĩa">↻ Tải lại</button>
        <button className="ghost sm" onClick={() => setPickerOpen(true)} disabled={busy} title="Mở file khác">📂 File khác</button>
        <button
          className="ghost sm"
          onClick={openCreate}
          disabled={busy || !allowWrite}
          title={!allowWrite ? 'Tạo file cần quyền ghi — đặt OFFICE_ALLOW_WRITE=true trong .env.local' : 'Tạo file .docx mới từ mẫu có sẵn'}
        >
          ＋ File mới
        </button>
        <span style={{ flex: 1 }} />
        {dirtyCount > 0 && <span className="badge sheet-dirty-badge">● {dirtyCount} thay đổi</span>}
        <button className="ghost sm" onClick={() => setFindOpen((o) => !o)} title="Tìm & thay thế (Ctrl+F)">🔎 Tìm</button>
        <button className="ghost sm" onClick={() => setHfOpen('header')} title="Đặt nội dung đầu trang">⌃ Đầu trang</button>
        <button className="ghost sm" onClick={() => setHfOpen('footer')} title="Đặt chân trang và số trang tự động">⌄ Chân trang</button>
        <button className="ghost sm" onClick={doPrint} title="Mở bản in — chọn 'Save as PDF' để xuất PDF (Ctrl+P)">🖨 In / PDF</button>
        <button
          className="sm"
          onClick={() => setSaveOpen(true)}
          disabled={busy || dirtyCount === 0 || !allowWrite}
          title={!allowWrite
            ? 'Ghi file đang tắt — đặt OFFICE_ALLOW_WRITE=true trong .env.local'
            : dirtyCount === 0 ? 'Chưa có thay đổi nào' : 'Ghi đè file (backup .bak trước) — Ctrl+S'}
        >
          💾 Lưu (ghi đè)
        </button>
      </div>

      <WordFormatBar
        run={activeRunFormat}
        para={selPara?.fmt}
        disabled={sel === null && !cell}
        targetLabel={targetLabel}
        hasSelection={range !== null && editing === sel}
        inTable={cell !== null}
        onRunFormat={applyRunFormat}
        onParaFormat={applyParaFormat}
        onInsertTable={() => setTableOpen(true)}
        onPageBreak={insertPageBreak}
        onTableRow={tableRowOp}
        onTableRowDelete={tableRowDelete}
        onTableCol={tableColOp}
        onTableColDelete={tableColDelete}
        onTableBorder={tableBorderToggle}
      />

      <div className="sheet-toolbar word-subbar">
        <button
          className="ghost sm"
          onClick={() => insertPara(sel !== null ? sel + 1 : blocks.length)}
          disabled={busy}
          title={sel !== null ? `Thêm đoạn mới dưới khối ${sel + 1}` : 'Thêm đoạn mới ở cuối tài liệu'}
        >
          ＋ Thêm đoạn
        </button>
        <button className="ghost sm" onClick={() => moveBlock(-1)} disabled={busy || sel === null || sel === 0}
          title="Đưa khối đang chọn lên trên">↑ Lên</button>
        <button className="ghost sm" onClick={() => moveBlock(1)} disabled={busy || sel === null || sel === blocks.length - 1}
          title="Đưa khối đang chọn xuống dưới">↓ Xuống</button>
        <button
          className="ghost sm"
          onClick={deleteBlock}
          disabled={busy || sel === null}
          title={sel === null ? 'Bấm vào số ¶ bên trái để chọn khối cần xóa' : `Xóa khối ${sel + 1}`}
        >
          ✕ Xóa khối
        </button>
        <button className="ghost sm" onClick={() => setOutlineOpen((o) => !o)}
          title="Bật / tắt khung mục lục bên trái">
          {outlineOpen ? '◧' : '▢'} Mục lục
        </button>
        <span style={{ flex: 1 }} />
        <span className="badge" title="Ước tính — bố cục thật do Word quyết định">
          {stats.words.toLocaleString('vi')} từ · {stats.chars.toLocaleString('vi')} ký tự
          {' · '}{stats.paras} đoạn{stats.tables > 0 && ` · ${stats.tables} bảng`}
          {' · ~'}{stats.pages} trang
        </span>
      </div>

      {file.truncated && (
        <div className="sheet-banner">
          ⚠ Tài liệu quá dài — chỉ hiển thị {blocks.length.toLocaleString('vi')} khối đầu.
          Sửa trong vùng hiển thị vẫn an toàn cho phần còn lại.
        </div>
      )}
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '6px 0' }}>{err}</pre>}
      {notice && <div className="badge" style={{ color: 'var(--ok)', margin: '6px 0' }}>{notice}</div>}

      {findOpen && (
        <WordFindPanel
          onFind={runFind}
          onJump={jumpTo}
          onReplaceAll={runReplaceAll}
          onClose={() => { setFindOpen(false); setHits(new Set()); }}
        />
      )}

      <div className={`word-body${outlineOpen ? ' with-outline' : ''}`}>
        {outlineOpen && (
          <WordOutline entries={outline} current={sel} onJump={jumpTo} />
        )}
        <WordDocView
          ref={scrollRef}
          blocks={blocks}
          page={page}
          headers={headers}
          footers={footers}
          sel={sel}
          editing={editing}
          cell={cell}
          editingCell={editingCell}
          hits={hits}
          focusBlock={focusBlock}
          onSelect={(i) => { setSel(i); setEditing(null); setRange(null); if (blocks[i ?? -1]?.kind !== 'tbl') setCell(null); }}
          onEdit={(i) => { setEditing(i); setCell(null); }}
          onCommit={commitEdit}
          onCancel={() => { setEditing(null); setRange(null); }}
          onSelectionChange={setRange}
          onPickCell={(ref) => { setCell(ref); setEditing(null); }}
          onEditCell={(ref) => { setCell(ref); setEditingCell(ref); }}
          onCommitCell={commitCell}
          onCancelCell={() => setEditingCell(null)}
        />
      </div>

      {pickerOpen && (
        <FolderPicker
          title="Chọn file .docx"
          fileExts={['docx']}
          onPickFile={(p) => { if (confirmDiscard('mở file khác')) void openPath(p); }}
          onPick={() => {}}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {createOpen && (
        <OfficeNewFileModal
          title="＋ Tạo văn bản mới"
          exts={['docx']}
          templates={TEMPLATES}
          initialDir={dirOf(file.path)}
          busy={busy}
          err={err}
          onCreate={(dir, name, tpl) => void doCreate(dir, name, tpl)}
          onClose={() => { setCreateOpen(false); setErr(null); }}
        />
      )}

      {tableOpen && (
        <WordInsertTableModal onInsert={insertTable} onClose={() => setTableOpen(false)} />
      )}

      {hfOpen && (
        <WordHeaderFooterModal
          part={hfOpen}
          current={(hfOpen === 'header' ? headers : footers).find((x) => x.type === 'default')}
          onApply={(text, jc, pageNum) => applyHeaderFooter(hfOpen, text, jc, pageNum)}
          onClose={() => setHfOpen(null)}
        />
      )}

      {saveOpen && (
        <div className="modal-backdrop" onClick={() => !busy && setSaveOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(620px, 94vw)' }}>
            <div className="status-line" style={{ marginBottom: 10 }}>
              <h3 style={{ margin: 0, flex: 1 }}>💾 Lưu — ghi đè file gốc</h3>
              <button className="ghost sm" onClick={() => setSaveOpen(false)} disabled={busy}>✕</button>
            </div>

            <code className="small picker-cwd" style={{ display: 'block', marginBottom: 10 }} title={file.path}>
              {file.path}
            </code>

            <ul className="sheet-save-summary">
              {textEdits > 0 && <li>{textEdits} thay đổi nội dung</li>}
              {fmtEdits > 0 && <li>{fmtEdits} thay đổi định dạng</li>}
              {structEdits > 0 && <li>{structEdits} thay đổi bố cục (thêm/xóa/di chuyển khối, bảng, đầu-chân trang)</li>}
            </ul>

            <div className="sheet-save-note">
              Bản gốc được sao lưu thành <code>{file.path.split(/[\\/]/).pop()}.bak</code> trước khi ghi đè
              (ghi file tạm rồi rename — không có trạng thái ghi dở). Đoạn không sửa giữ nguyên 100% định dạng.
            </div>

            {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="ghost sm" onClick={() => setSaveOpen(false)} disabled={busy}>Huỷ</button>
              <button className="sm" onClick={() => void doSave()} disabled={busy}>
                {busy ? <span className="spinner" aria-hidden /> : '💾'} Ghi đè ({dirtyCount} thay đổi)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
