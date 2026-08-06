// Server-only: .docx → wire model (see lib/word.ts for the shapes).
//
// Reads word/document.xml into an ordered list of blocks, resolving just
// enough of the style chain that the on-screen page looks like Word's: a run's
// effective formatting is (docDefaults ⊕ paragraph style ⊕ paragraph mark ⊕
// the run's own rPr). We only resolve what we can render — anything we cannot
// faithfully rebuild (images, fields, hyperlinks) marks its paragraph LOCKED
// so the writer refuses to touch it.

import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import type {
  HeaderFooter, PageSetup, ParaBlock, ParaFormat, RunFormat, RunSpan,
  TableBlock, TableCell, WordBlock,
} from './word';
import { mergeRuns } from './word';
import {
  R_NS, W, type XDoc, type XEl,
  attr, cssColor, elementChildren, findChild, findChildren, findDeep,
  halfPtToPt, local, numAttr, textOf, toggleOn, twipToPt, val, walk,
} from './wordXml';

// ── Parsed-file handle ───────────────────────────────────────────────────────

export interface ParsedDocx {
  zip: JSZip;
  doc: XDoc;
  body: XEl;
  /** Original <?xml …?> declaration, re-prepended on serialize. */
  decl: string;
  /** word/styles.xml, when present — needed to resolve Heading sizes etc. */
  styles?: XDoc;
  /** Style id → resolved formatting, built once per open. */
  styleMap: Map<string, ResolvedStyle>;
  /** Formatting from styles.xml <w:docDefaults>. */
  docDefaults: ResolvedStyle;
}

/** What a named style contributes to its paragraphs. */
export interface ResolvedStyle {
  run: RunFormat;
  para: ParaFormat;
  /** basedOn chain target, resolved during map construction. */
  basedOn?: string;
}

function parseXml(xml: string, what: string): XDoc {
  try {
    return new DOMParser().parseFromString(xml, 'text/xml');
  } catch (e) {
    throw new Error(`Không parse được ${what}: ${(e as Error).message}`);
  }
}

async function readPart(zip: JSZip, name: string): Promise<XDoc | undefined> {
  const entry = zip.file(name);
  if (!entry) return undefined;
  return parseXml(await entry.async('string'), name);
}

export async function readDocx(abs: string, buf: Buffer): Promise<ParsedDocx> {
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error(`File không phải .docx hợp lệ (thiếu word/document.xml): ${abs}`);
  const xml = await entry.async('string');
  const doc = parseXml(xml, 'document.xml');
  const root = doc.documentElement as unknown as XEl;
  const body = findChild(root, 'body');
  if (!body) throw new Error('document.xml không có <w:body>.');
  const decl = /^<\?xml[^>]*\?>\s*/.exec(xml)?.[0] ?? '';

  const styles = await readPart(zip, 'word/styles.xml');
  const { map, defaults } = buildStyleMap(styles);
  return { zip, doc, body, decl, styles, styleMap: map, docDefaults: defaults };
}

// ── styles.xml ───────────────────────────────────────────────────────────────

function buildStyleMap(styles: XDoc | undefined): { map: Map<string, ResolvedStyle>; defaults: ResolvedStyle } {
  const map = new Map<string, ResolvedStyle>();
  const defaults: ResolvedStyle = { run: {}, para: {} };
  if (!styles) return { map, defaults };

  const root = styles.documentElement as unknown as XEl | undefined;
  if (!root) return { map, defaults };

  const dd = findChild(root, 'docDefaults');
  if (dd) {
    const rPrDef = findChild(dd, 'rPrDefault');
    const rPr = rPrDef && findChild(rPrDef, 'rPr');
    if (rPr) defaults.run = readRunFormat(rPr);
    const pPrDef = findChild(dd, 'pPrDefault');
    const pPr = pPrDef && findChild(pPrDef, 'pPr');
    if (pPr) defaults.para = readParaFormat(pPr).fmt;
  }

  const raw = new Map<string, { el: XEl; basedOn?: string }>();
  for (const st of findChildren(root, 'style')) {
    if (attr(st, 'type') !== 'paragraph' && attr(st, 'type') !== 'character') continue;
    const id = attr(st, 'styleId');
    if (!id) continue;
    raw.set(id, { el: st, basedOn: val(findChild(st, 'basedOn')) ?? undefined });
  }

  // Resolve each style through its basedOn chain (cycle-safe, memoized).
  const resolving = new Set<string>();
  const resolve = (id: string): ResolvedStyle => {
    const cached = map.get(id);
    if (cached) return cached;
    const entry = raw.get(id);
    if (!entry || resolving.has(id)) return { run: {}, para: {} };
    resolving.add(id);
    const parent = entry.basedOn ? resolve(entry.basedOn) : { run: {}, para: {} };
    const rPr = findChild(entry.el, 'rPr');
    const pPr = findChild(entry.el, 'pPr');
    const out: ResolvedStyle = {
      run: { ...parent.run, ...(rPr ? readRunFormat(rPr) : {}) },
      para: { ...parent.para, ...(pPr ? readParaFormat(pPr).fmt : {}) },
      basedOn: entry.basedOn,
    };
    resolving.delete(id);
    map.set(id, out);
    return out;
  };
  for (const id of raw.keys()) resolve(id);
  return { map, defaults };
}

// ── Run formatting ───────────────────────────────────────────────────────────

/** Read a `w:rPr` bag into a RunFormat (only the properties we can rebuild). */
export function readRunFormat(rPr: XEl): RunFormat {
  const f: RunFormat = {};
  if (toggleOn(findChild(rPr, 'b'))) f.b = 1;
  if (toggleOn(findChild(rPr, 'i'))) f.i = 1;
  if (toggleOn(findChild(rPr, 'strike'))) f.st = 1;
  if (toggleOn(findChild(rPr, 'caps'))) f.caps = 1;
  if (toggleOn(findChild(rPr, 'smallCaps'))) f.smallCaps = 1;

  const u = findChild(rPr, 'u');
  if (u) {
    const v = val(u);
    if (v && v !== 'none') f.u = 1;
  }

  const color = cssColor(val(findChild(rPr, 'color')));
  if (color) f.fc = color;

  const hl = val(findChild(rPr, 'highlight'));
  if (hl && hl !== 'none') f.hl = hl;

  const shd = findChild(rPr, 'shd');
  const shdFill = cssColor(attr(shd, 'fill'));
  if (shdFill) f.bg = shdFill;

  const sz = numAttr(findChild(rPr, 'sz'), 'val');
  if (sz !== undefined) f.fs = halfPtToPt(sz);

  const rFonts = findChild(rPr, 'rFonts');
  const ff = attr(rFonts, 'ascii') ?? attr(rFonts, 'hAnsi') ?? attr(rFonts, 'cs');
  if (ff) f.ff = ff;

  const va = val(findChild(rPr, 'vertAlign'));
  if (va === 'superscript') f.va = 'sup';
  else if (va === 'subscript') f.va = 'sub';

  return f;
}

// ── Paragraph formatting ─────────────────────────────────────────────────────

/** Read a `w:pPr` bag. `numId` is returned separately — resolving it to
 *  bullet-vs-number needs numbering.xml, which the caller supplies. */
export function readParaFormat(pPr: XEl): { fmt: ParaFormat; numId?: number } {
  const fmt: ParaFormat = {};
  const style = val(findChild(pPr, 'pStyle'));
  if (style) fmt.style = style;

  const jc = val(findChild(pPr, 'jc'));
  if (jc === 'left' || jc === 'start') fmt.jc = 'l';
  else if (jc === 'center') fmt.jc = 'c';
  else if (jc === 'right' || jc === 'end') fmt.jc = 'r';
  else if (jc === 'both' || jc === 'distribute') fmt.jc = 'j';

  const spacing = findChild(pPr, 'spacing');
  if (spacing) {
    const line = numAttr(spacing, 'line');
    const rule = attr(spacing, 'lineRule');
    // 'auto' means line is a multiple in 240ths; exact/atLeast are twips.
    if (line !== undefined && (rule === 'auto' || rule === null)) {
      fmt.ls = Math.round((line / 240) * 100) / 100;
    }
    const before = numAttr(spacing, 'before');
    if (before !== undefined) fmt.sb = twipToPt(before);
    const after = numAttr(spacing, 'after');
    if (after !== undefined) fmt.sa = twipToPt(after);
  }

  const ind = findChild(pPr, 'ind');
  if (ind) {
    const left = numAttr(ind, 'left') ?? numAttr(ind, 'start');
    if (left !== undefined) fmt.il = twipToPt(left);
    const first = numAttr(ind, 'firstLine');
    if (first !== undefined) fmt.ifl = twipToPt(first);
    const hanging = numAttr(ind, 'hanging');
    if (hanging !== undefined) fmt.ifl = -twipToPt(hanging);
  }

  let numId: number | undefined;
  const numPr = findChild(pPr, 'numPr');
  if (numPr) {
    numId = numAttr(findChild(numPr, 'numId'), 'val');
    const lvl = numAttr(findChild(numPr, 'ilvl'), 'val');
    if (lvl !== undefined && lvl > 0) fmt.lvl = lvl;
  }
  return { fmt, numId };
}

// ── numbering.xml — bullet vs number ─────────────────────────────────────────

/** numId → 'bullet' | 'number', read from numbering.xml. */
export type NumKinds = Map<number, 'bullet' | 'number'>;

export async function readNumbering(zip: JSZip): Promise<NumKinds> {
  const kinds: NumKinds = new Map();
  const doc = await readPart(zip, 'word/numbering.xml');
  const root = doc?.documentElement as unknown as XEl | undefined;
  if (!root) return kinds;

  // abstractNumId → format of level 0.
  const abstract = new Map<number, string>();
  for (const an of findChildren(root, 'abstractNum')) {
    const id = numAttr(an, 'abstractNumId');
    if (id === undefined) continue;
    const lvl0 = findChildren(an, 'lvl').find((l) => (numAttr(l, 'ilvl') ?? 0) === 0)
      ?? findChild(an, 'lvl');
    const fmt = lvl0 ? val(findChild(lvl0, 'numFmt')) : null;
    if (fmt) abstract.set(id, fmt);
  }
  for (const num of findChildren(root, 'num')) {
    const id = numAttr(num, 'numId');
    if (id === undefined) continue;
    const absId = numAttr(findChild(num, 'abstractNumId'), 'val');
    const fmt = absId !== undefined ? abstract.get(absId) : undefined;
    kinds.set(id, fmt === 'bullet' ? 'bullet' : 'number');
  }
  return kinds;
}

// ── Locked content detection ─────────────────────────────────────────────────

const LOCK_REASONS: Record<string, string> = {
  drawing: 'ảnh/hình vẽ',
  pict: 'ảnh/hình vẽ',
  object: 'đối tượng nhúng',
  hyperlink: 'liên kết',
  fldSimple: 'field tự động',
  fldChar: 'field tự động',
  instrText: 'field tự động',
  sdt: 'content control',
  oMath: 'công thức toán',
  oMathPara: 'công thức toán',
  footnoteReference: 'footnote',
  endnoteReference: 'endnote',
};

export function lockReason(p: XEl): string | undefined {
  let reason: string | undefined;
  walk(p, (e) => {
    if (reason) return false;
    const r = LOCK_REASONS[local(e)];
    if (r) { reason = r; return false; }
    return undefined;
  });
  return reason;
}

// ── Paragraph → runs ─────────────────────────────────────────────────────────

/**
 * Flatten a paragraph's runs into wire spans. Text-carrying children are
 * `w:t` (text), `w:br`/`w:cr` (line break) and `w:tab`; everything else is
 * skipped here and caught by lockReason() at the paragraph level.
 */
export function readRuns(p: XEl): RunSpan[] {
  const spans: RunSpan[] = [];
  for (const child of elementChildren(p)) {
    const name = local(child);
    if (name === 'pPr') continue;
    if (name === 'r') { spans.push(...runSpans(child)); continue; }
    // Hyperlinks/sdt wrap runs — read their text so the paragraph still shows
    // (the paragraph is locked anyway, so this is display-only).
    if (name === 'hyperlink' || name === 'sdt' || name === 'smartTag') {
      walk(child, (e) => {
        if (local(e) === 'r') { spans.push(...runSpans(e)); return false; }
        return undefined;
      });
    }
  }
  return mergeRuns(spans);
}

function runSpans(r: XEl): RunSpan[] {
  const rPr = findChild(r, 'rPr');
  const f = rPr ? readRunFormat(rPr) : undefined;
  const has = f && Object.keys(f).length > 0;
  let text = '';
  for (const c of elementChildren(r)) {
    const n = local(c);
    if (n === 't') text += textOf(c);
    else if (n === 'br' || n === 'cr') text += '\n';
    else if (n === 'tab') text += '\t';
  }
  if (text === '') return [];
  return [{ t: text, ...(has ? { f } : {}) }];
}

// ── Blocks ───────────────────────────────────────────────────────────────────

/** True when the paragraph is nothing but an explicit page break. */
function isPageBreakOnly(p: XEl): boolean {
  let hasBreak = false;
  let hasText = false;
  walk(p, (e) => {
    const n = local(e);
    if (n === 'pPr') return false;
    if (n === 'br' && attr(e, 'type') === 'page') { hasBreak = true; return false; }
    if (n === 't' && textOf(e) !== '') hasText = true;
    return undefined;
  });
  return hasBreak && !hasText;
}

function readParaBlock(p: XEl, nums: NumKinds): ParaBlock {
  const pPr = findChild(p, 'pPr');
  let fmt: ParaFormat | undefined;
  if (pPr) {
    const { fmt: f, numId } = readParaFormat(pPr);
    if (numId !== undefined && numId !== 0) f.list = nums.get(numId) ?? 'bullet';
    if (Object.keys(f).length > 0) fmt = f;
  }
  const block: ParaBlock = { kind: 'p', runs: readRuns(p) };
  if (fmt) block.fmt = fmt;
  const reason = lockReason(p);
  if (reason) { block.locked = true; block.lockReason = reason; }
  return block;
}

function readCell(tc: XEl, nums: NumKinds): TableCell {
  const cell: TableCell = { paras: [] };
  const tcPr = findChild(tc, 'tcPr');
  if (tcPr) {
    const span = numAttr(findChild(tcPr, 'gridSpan'), 'val');
    if (span !== undefined && span > 1) cell.span = span;

    const vMerge = findChild(tcPr, 'vMerge');
    // <w:vMerge/> with no val (or val="continue") = merged into the cell above.
    if (vMerge && (val(vMerge) ?? 'continue') === 'continue') cell.vMerged = 1;

    const bg = cssColor(attr(findChild(tcPr, 'shd'), 'fill'));
    if (bg) cell.bg = bg;

    const va = val(findChild(tcPr, 'vAlign'));
    if (va === 'center') cell.va = 'm';
    else if (va === 'bottom') cell.va = 'b';
    else if (va === 'top') cell.va = 't';

    const tcW = findChild(tcPr, 'tcW');
    const w = numAttr(tcW, 'w');
    if (w !== undefined && attr(tcW, 'type') === 'dxa') cell.w = twipToPt(w);
  }

  for (const p of findChildren(tc, 'p')) {
    const b = readParaBlock(p, nums);
    if (b.locked) cell.locked = true;
    cell.paras.push({ runs: b.runs, ...(b.fmt ? { fmt: b.fmt } : {}) });
  }
  // A nested table inside the cell is content we can't round-trip cell-wise.
  if (findChild(tc, 'tbl')) cell.locked = true;
  if (cell.paras.length === 0) cell.paras.push({ runs: [] });
  return cell;
}

function readTableBlock(tbl: XEl, nums: NumKinds): TableBlock {
  const rows: TableCell[][] = [];
  for (const tr of findChildren(tbl, 'tr')) {
    rows.push(findChildren(tr, 'tc').map((tc) => readCell(tc, nums)));
  }
  const block: TableBlock = { kind: 'tbl', rows };

  const tblPr = findChild(tbl, 'tblPr');
  const borders = tblPr && findChild(tblPr, 'tblBorders');
  if (borders) {
    const top = findChild(borders, 'top');
    const style = top ? val(top) : null;
    if (style && style !== 'none' && style !== 'nil') block.bordered = true;
  }
  // A table style (e.g. TableGrid) usually draws borders too.
  if (!block.bordered && tblPr) {
    const styleId = val(findChild(tblPr, 'tblStyle')) ?? '';
    if (/grid|list|table/i.test(styleId) && styleId !== 'TableNormal') block.bordered = true;
  }

  const firstRow = findChildren(tbl, 'tr')[0];
  const trPr = firstRow && findChild(firstRow, 'trPr');
  if (trPr && findChild(trPr, 'tblHeader')) block.headerRow = true;

  return block;
}

/** Block-level body children in document order (w:p and w:tbl). */
export function collectBlockEls(body: XEl): XEl[] {
  return elementChildren(body).filter((e) => {
    const n = local(e);
    return n === 'p' || n === 'tbl';
  });
}

export function readBlocks(els: XEl[], nums: NumKinds): WordBlock[] {
  return els.map((el): WordBlock => {
    if (local(el) === 'tbl') return readTableBlock(el, nums);
    if (isPageBreakOnly(el)) return { kind: 'br' };
    return readParaBlock(el, nums);
  });
}

// ── Header / footer ──────────────────────────────────────────────────────────

/** Relationship id → part name, from word/_rels/document.xml.rels. */
async function readRels(zip: JSZip): Promise<Map<string, string>> {
  const rels = new Map<string, string>();
  const doc = await readPart(zip, 'word/_rels/document.xml.rels');
  const root = doc?.documentElement as unknown as XEl | undefined;
  if (!root) return rels;
  for (const rel of elementChildren(root)) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (id && target) rels.set(id, target.replace(/^\/?word\//, '').replace(/^\.\//, ''));
  }
  return rels;
}

const HF_TYPES: Record<string, HeaderFooter['type']> = {
  default: 'default', first: 'first', even: 'even',
};

/** Read the header/footer parts referenced by the last section. */
export async function readHeadersFooters(
  zip: JSZip, body: XEl, nums: NumKinds,
): Promise<{ headers: HeaderFooter[]; footers: HeaderFooter[] }> {
  const headers: HeaderFooter[] = [];
  const footers: HeaderFooter[] = [];
  const sectPr = findChild(body, 'sectPr');
  if (!sectPr) return { headers, footers };
  const rels = await readRels(zip);

  for (const ref of elementChildren(sectPr)) {
    const name = local(ref);
    if (name !== 'headerReference' && name !== 'footerReference') continue;
    const type = HF_TYPES[attr(ref, 'type') ?? 'default'] ?? 'default';
    const relId = (ref as unknown as { getAttributeNS(ns: string, n: string): string | null })
      .getAttributeNS(R_NS, 'id') ?? attr(ref, 'id');
    const part = relId ? rels.get(relId) : undefined;
    if (!part) continue;
    const doc = await readPart(zip, `word/${part}`);
    const root = doc?.documentElement as unknown as XEl | undefined;
    if (!root) continue;

    const paras = findChildren(root, 'p').map((p) => {
      const b = readParaBlock(p, nums);
      return { runs: b.runs, ...(b.fmt ? { fmt: b.fmt } : {}) };
    });
    const hasPageNum = !!findDeep(root, 'fldSimple') || !!findDeep(root, 'fldChar');
    const hf: HeaderFooter = { type, paras, ...(hasPageNum ? { hasPageNum: true as const } : {}) };
    (name === 'headerReference' ? headers : footers).push(hf);
  }
  return { headers, footers };
}

// ── Page setup ───────────────────────────────────────────────────────────────

/** A4 portrait with 1" margins — the fallback when sectPr is missing. */
const DEFAULT_PAGE: PageSetup = { w: 595, h: 842, mt: 72, mr: 72, mb: 72, ml: 72 };

export function readPageSetup(body: XEl): PageSetup {
  const sectPr = findChild(body, 'sectPr');
  if (!sectPr) return { ...DEFAULT_PAGE };
  const pgSz = findChild(sectPr, 'pgSz');
  const pgMar = findChild(sectPr, 'pgMar');
  const page: PageSetup = { ...DEFAULT_PAGE };
  const w = numAttr(pgSz, 'w');
  const h = numAttr(pgSz, 'h');
  if (w !== undefined) page.w = twipToPt(w);
  if (h !== undefined) page.h = twipToPt(h);
  if (attr(pgSz, 'orient') === 'landscape') page.landscape = true;
  const mt = numAttr(pgMar, 'top');
  const mr = numAttr(pgMar, 'right');
  const mb = numAttr(pgMar, 'bottom');
  const ml = numAttr(pgMar, 'left');
  if (mt !== undefined) page.mt = twipToPt(mt);
  if (mr !== undefined) page.mr = twipToPt(mr);
  if (mb !== undefined) page.mb = twipToPt(mb);
  if (ml !== undefined) page.ml = twipToPt(ml);
  return page;
}

// ── Style resolution for display ─────────────────────────────────────────────

/**
 * Effective run formatting of a paragraph's default text: docDefaults ⊕ the
 * paragraph's named style. The client layers each run's own RunFormat on top,
 * so headings render at their real size without us baking it into every run.
 */
export function effectiveParaStyle(parsed: ParsedDocx, fmt: ParaFormat | undefined): { run: RunFormat; para: ParaFormat } {
  const styleId = fmt?.style;
  const st = styleId ? parsed.styleMap.get(styleId) : undefined;
  return {
    run: { ...parsed.docDefaults.run, ...(st?.run ?? {}) },
    para: { ...parsed.docDefaults.para, ...(st?.para ?? {}) },
  };
}

export { W };
