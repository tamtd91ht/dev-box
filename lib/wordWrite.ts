// Server-only: wire model → .docx mutations.
//
// Every write is an op replayed on the freshly re-read DOM (see wordSave in
// lib/wordClient.ts). The guiding rule: touch ONLY the elements an op names.
// A paragraph nobody edited is never re-serialized from our model, so its
// original XML — and therefore its exact formatting — survives untouched.

import type {
  ParaFormat, ParaFormatPatch, RunFormat, RunFormatPatch, RunSpan,
} from './word';
import { mergeRuns } from './word';
import {
  PPR_ORDER, RPR_ORDER, TCPR_ORDER, W, type XDoc, type XEl,
  appendChild, attr, cloneEl, elementChildren, ensureBag, findChild, findChildren,
  insertBefore, insertOrdered, local, maker, numAttr, ooxmlColor, ptToHalfPt,
  ptToTwip, removeChild, removeChildrenNamed, setAttr, setProp, val,
} from './wordXml';

// ── Runs ─────────────────────────────────────────────────────────────────────

/** Build a `w:rPr` bag from a RunFormat (omitted when the format is empty). */
export function buildRunProps(doc: XDoc, f: RunFormat | undefined): XEl | undefined {
  if (!f || Object.keys(f).length === 0) return undefined;
  const { el } = maker(doc);
  const rPr = el('rPr');
  // Appended in RPR_ORDER sequence — Word rejects out-of-order properties.
  if (f.ff) appendChild(rPr, el('rFonts', { ascii: f.ff, hAnsi: f.ff, cs: f.ff }));
  if (f.b) appendChild(rPr, el('b'));
  if (f.i) appendChild(rPr, el('i'));
  if (f.caps) appendChild(rPr, el('caps'));
  if (f.smallCaps) appendChild(rPr, el('smallCaps'));
  if (f.st) appendChild(rPr, el('strike'));
  if (f.fc) appendChild(rPr, el('color', { val: ooxmlColor(f.fc) }));
  if (f.fs !== undefined) {
    appendChild(rPr, el('sz', { val: ptToHalfPt(f.fs) }));
    appendChild(rPr, el('szCs', { val: ptToHalfPt(f.fs) }));
  }
  if (f.hl) appendChild(rPr, el('highlight', { val: f.hl }));
  if (f.u) appendChild(rPr, el('u', { val: 'single' }));
  if (f.bg) appendChild(rPr, el('shd', { val: 'clear', color: 'auto', fill: ooxmlColor(f.bg, 'FFFFFF') }));
  if (f.va) appendChild(rPr, el('vertAlign', { val: f.va === 'sup' ? 'superscript' : 'subscript' }));
  return rPr;
}

/** One RunSpan → one `w:r`, translating '\n' → `w:br` and '\t' → `w:tab`. */
export function buildRun(doc: XDoc, span: RunSpan): XEl {
  const { el, text } = maker(doc);
  const r = el('r');
  const rPr = buildRunProps(doc, span.f);
  if (rPr) appendChild(r, rPr);
  const lines = span.t.split('\n');
  lines.forEach((line, li) => {
    if (li > 0) appendChild(r, el('br'));
    line.split('\t').forEach((seg, si) => {
      if (si > 0) appendChild(r, el('tab'));
      if (seg !== '') appendChild(r, text(seg));
    });
  });
  return r;
}

/**
 * Replace a paragraph's content with `runs`, keeping its `w:pPr` intact.
 * When the paragraph had runs before, the FIRST run's rPr is used as the
 * baseline for spans that carry no formatting of their own — so retyping a
 * heading keeps the heading's direct character formatting.
 */
export function setParaRuns(doc: XDoc, p: XEl, runs: RunSpan[]): void {
  const baseline = findChild(p, 'r');
  const baseRPr = baseline && findChild(baseline, 'rPr');

  for (const c of elementChildren(p)) {
    if (local(c) !== 'pPr') removeChild(p, c);
  }
  for (const span of mergeRuns(runs)) {
    const r = buildRun(doc, span);
    if (!span.f && baseRPr && !findChild(r, 'rPr')) {
      insertBefore(r, cloneEl(baseRPr), elementChildren(r)[0]);
    }
    appendChild(p, r);
  }
}

// ── Paragraph properties ─────────────────────────────────────────────────────

const JC_OOXML: Record<'l' | 'c' | 'r' | 'j', string> = {
  l: 'left', c: 'center', r: 'right', j: 'both',
};

/** Apply a ParaFormatPatch to a paragraph's `w:pPr`. */
export function patchParaProps(doc: XDoc, p: XEl, patch: ParaFormatPatch, numIds: NumIdPool): void {
  if (patch.clear) {
    const pPr = findChild(p, 'pPr');
    // Keep only the paragraph-mark run props; drop all layout properties.
    if (pPr) removeChildrenNamed(pPr, ['pStyle', 'jc', 'spacing', 'ind', 'numPr', 'pageBreakBefore', 'contextualSpacing', 'shd', 'pBdr']);
    return;
  }
  const pPr = ensureBag(doc, p, 'pPr');

  if (patch.style !== undefined) {
    setProp(doc, pPr, 'pStyle', patch.style === null ? null : { val: patch.style }, PPR_ORDER);
  }
  if (patch.jc !== undefined) {
    setProp(doc, pPr, 'jc', patch.jc === null ? null : { val: JC_OOXML[patch.jc] }, PPR_ORDER);
  }

  // spacing carries three independent knobs — merge, never clobber.
  if (patch.ls !== undefined || patch.sb !== undefined || patch.sa !== undefined) {
    const cur = findChild(pPr, 'spacing');
    const next: Record<string, string | number | undefined> = {};
    const keep = (name: string) => {
      const v = attr(cur, name);
      if (v !== null) next[name] = v;
    };
    keep('line'); keep('lineRule'); keep('before'); keep('after');
    keep('beforeAutospacing'); keep('afterAutospacing');

    if (patch.ls !== undefined) {
      if (patch.ls === null) { delete next.line; delete next.lineRule; }
      else { next.line = Math.round(patch.ls * 240); next.lineRule = 'auto'; }
    }
    if (patch.sb !== undefined) {
      if (patch.sb === null) delete next.before;
      else { next.before = ptToTwip(patch.sb); next.beforeAutospacing = '0'; }
    }
    if (patch.sa !== undefined) {
      if (patch.sa === null) delete next.after;
      else { next.after = ptToTwip(patch.sa); next.afterAutospacing = '0'; }
    }
    setProp(doc, pPr, 'spacing', Object.keys(next).length > 0 ? next : null, PPR_ORDER);
  }

  if (patch.il !== undefined || patch.ifl !== undefined) {
    const cur = findChild(pPr, 'ind');
    const next: Record<string, string | number | undefined> = {};
    const keep = (name: string) => {
      const v = attr(cur, name);
      if (v !== null) next[name] = v;
    };
    keep('left'); keep('right'); keep('firstLine'); keep('hanging');

    if (patch.il !== undefined) {
      if (patch.il === null) delete next.left;
      else next.left = ptToTwip(patch.il);
    }
    if (patch.ifl !== undefined) {
      delete next.firstLine; delete next.hanging;
      if (patch.ifl !== null && patch.ifl !== 0) {
        if (patch.ifl > 0) next.firstLine = ptToTwip(patch.ifl);
        else next.hanging = ptToTwip(-patch.ifl);
      }
    }
    setProp(doc, pPr, 'ind', Object.keys(next).length > 0 ? next : null, PPR_ORDER);
  }

  if (patch.list !== undefined || patch.lvl !== undefined) {
    if (patch.list === null) {
      setProp(doc, pPr, 'numPr', null, PPR_ORDER);
      // Word's ListParagraph style leaves a stray indent behind — clear it too.
      if (val(findChild(pPr, 'pStyle')) === 'ListParagraph') {
        setProp(doc, pPr, 'pStyle', null, PPR_ORDER);
        setProp(doc, pPr, 'ind', null, PPR_ORDER);
      }
    } else {
      const kind = patch.list ?? 'bullet';
      const numId = numIds.idFor(kind);
      const lvl = patch.lvl ?? numAttr(findChild(findChild(pPr, 'numPr') ?? pPr, 'ilvl'), 'val') ?? 0;
      const { el } = maker(doc);
      const numPr = el('numPr');
      appendChild(numPr, el('ilvl', { val: lvl }));
      appendChild(numPr, el('numId', { val: numId }));
      const existing = findChild(pPr, 'numPr');
      if (existing) removeChild(pPr, existing);
      insertOrdered(pPr, numPr, PPR_ORDER);
      // Indent the list the way Word does, unless the user set their own.
      if (!findChild(pPr, 'ind')) {
        setProp(doc, pPr, 'ind', { left: 720 * (lvl + 1), hanging: 360 }, PPR_ORDER);
      }
    }
  }
}

/** Build a fresh `w:pPr` from a full ParaFormat (used for inserted content). */
export function buildParaProps(doc: XDoc, fmt: ParaFormat | undefined, numIds: NumIdPool): XEl | undefined {
  if (!fmt || Object.keys(fmt).length === 0) return undefined;
  const { el } = maker(doc);
  const p = el('p');
  patchParaProps(doc, p, { ...fmt } as ParaFormatPatch, numIds);
  return findChild(p, 'pPr');
}

// ── Character formatting over a range ────────────────────────────────────────

/** Apply a RunFormatPatch to one `w:rPr`-bearing run element in place. */
function patchRunProps(doc: XDoc, r: XEl, patch: RunFormatPatch): void {
  if (patch.clear) {
    const rPr = findChild(r, 'rPr');
    if (rPr) removeChild(r, rPr);
    return;
  }
  const rPr = ensureBag(doc, r, 'rPr');
  const { el } = maker(doc);

  /** Toggle property: set → empty element, clear → explicit val="0" removal. */
  const toggle = (name: string, v: 1 | null | undefined) => {
    if (v === undefined) return;
    setProp(doc, rPr, name, v === null ? null : {}, RPR_ORDER);
  };
  toggle('b', patch.b);
  toggle('i', patch.i);
  toggle('strike', patch.st);
  toggle('caps', patch.caps);
  toggle('smallCaps', patch.smallCaps);

  if (patch.u !== undefined) setProp(doc, rPr, 'u', patch.u === null ? null : { val: 'single' }, RPR_ORDER);
  if (patch.fc !== undefined) setProp(doc, rPr, 'color', patch.fc === null ? null : { val: ooxmlColor(patch.fc) }, RPR_ORDER);
  if (patch.hl !== undefined) setProp(doc, rPr, 'highlight', patch.hl === null ? null : { val: patch.hl }, RPR_ORDER);
  if (patch.bg !== undefined) {
    setProp(doc, rPr, 'shd', patch.bg === null ? null : { val: 'clear', color: 'auto', fill: ooxmlColor(patch.bg, 'FFFFFF') }, RPR_ORDER);
  }
  if (patch.ff !== undefined) {
    setProp(doc, rPr, 'rFonts', patch.ff === null ? null : { ascii: patch.ff, hAnsi: patch.ff, cs: patch.ff }, RPR_ORDER);
  }
  if (patch.fs !== undefined) {
    setProp(doc, rPr, 'sz', patch.fs === null ? null : { val: ptToHalfPt(patch.fs) }, RPR_ORDER);
    setProp(doc, rPr, 'szCs', patch.fs === null ? null : { val: ptToHalfPt(patch.fs) }, RPR_ORDER);
  }
  if (patch.va !== undefined) {
    setProp(doc, rPr, 'vertAlign', patch.va === null ? null : { val: patch.va === 'sup' ? 'superscript' : 'subscript' }, RPR_ORDER);
  }
  if (elementChildren(rPr).length === 0) removeChild(r, rPr);
  void el;
}

/** Character length a run contributes to the paragraph's plain text. */
function runLength(r: XEl): number {
  let n = 0;
  for (const c of elementChildren(r)) {
    const name = local(c);
    if (name === 't') n += ((c as unknown as { textContent: string | null }).textContent ?? '').length;
    else if (name === 'br' || name === 'cr' || name === 'tab') n += 1;
  }
  return n;
}

/** Split `r` at character offset `at`, returning the tail run (inserted after
 *  `r`), or undefined when the offset falls on a run boundary. */
function splitRunAt(doc: XDoc, p: XEl, r: XEl, at: number): XEl | undefined {
  if (at <= 0 || at >= runLength(r)) return undefined;
  const tail = cloneEl(r);
  // Walk both copies, trimming head after `at` and tail before it.
  let pos = 0;
  for (const c of elementChildren(r)) {
    const name = local(c);
    if (name === 'rPr') continue;
    const len = name === 't'
      ? ((c as unknown as { textContent: string | null }).textContent ?? '').length
      : (name === 'br' || name === 'cr' || name === 'tab') ? 1 : 0;
    if (pos >= at) removeChild(r, c);
    else if (name === 't' && pos + len > at) {
      const keep = ((c as unknown as { textContent: string | null }).textContent ?? '').slice(0, at - pos);
      const { text } = maker(doc);
      const next = text(keep);
      (r as unknown as { replaceChild(n: unknown, o: unknown): void }).replaceChild(next, c);
    }
    pos += len;
  }
  pos = 0;
  for (const c of elementChildren(tail)) {
    const name = local(c);
    if (name === 'rPr') continue;
    const len = name === 't'
      ? ((c as unknown as { textContent: string | null }).textContent ?? '').length
      : (name === 'br' || name === 'cr' || name === 'tab') ? 1 : 0;
    if (pos + len <= at) removeChild(tail, c);
    else if (name === 't' && pos < at) {
      const keep = ((c as unknown as { textContent: string | null }).textContent ?? '').slice(at - pos);
      const { text } = maker(doc);
      const next = text(keep);
      (tail as unknown as { replaceChild(n: unknown, o: unknown): void }).replaceChild(next, c);
    }
    pos += len;
  }
  const after = nextSibling(p, r);
  insertBefore(p, tail, after);
  return tail;
}

function nextSibling(parent: XEl, child: XEl): XEl | undefined {
  const kids = elementChildren(parent);
  const idx = kids.indexOf(child);
  return idx >= 0 ? kids[idx + 1] : undefined;
}

/**
 * Apply a character-format patch to the [from, to) slice of a paragraph's
 * text, splitting runs at the boundaries so only the selected words change.
 */
export function patchParaRunRange(doc: XDoc, p: XEl, from: number, to: number, patch: RunFormatPatch): void {
  if (to <= from) return;
  // Split at both boundaries first, so every run afterwards is fully in or out.
  let pos = 0;
  for (const r of elementChildren(p)) {
    if (local(r) !== 'r') continue;
    const len = runLength(r);
    if (len === 0) continue;
    const start = pos;
    const end = pos + len;
    if (from > start && from < end) { splitRunAt(doc, p, r, from - start); pos = start; continue; }
    if (to > start && to < end) { splitRunAt(doc, p, r, to - start); pos = start; continue; }
    pos = end;
  }
  pos = 0;
  for (const r of elementChildren(p)) {
    if (local(r) !== 'r') continue;
    const len = runLength(r);
    const start = pos;
    pos += len;
    if (len === 0) continue;
    if (start >= from && start + len <= to) patchRunProps(doc, r, patch);
  }
}

// ── numbering.xml — a bullet list and a numbered list on demand ──────────────

/**
 * Lazily provisions the two numbering definitions the editor can apply
 * (one bulleted, one numbered), creating word/numbering.xml — plus its
 * content-type override and relationship — the first time a list is used.
 */
export class NumIdPool {
  /** True once we added a definition (or synthesized the whole part), which
   *  tells the save path to write numbering.xml back into the zip. */
  private dirty: boolean;
  private nextAbstract: number;
  private nextNum: number;

  constructor(private ctx: NumberingContext) {
    this.dirty = ctx.created;
    this.nextAbstract = ctx.maxAbstractId + 1;
    this.nextNum = ctx.maxNumId + 1;
  }

  /** numId for the given list kind, provisioning it on first use. */
  idFor(kind: 'bullet' | 'number'): number {
    // Reuse a definition already in the file (or one we just made).
    const existing = this.ctx.existing.get(kind);
    if (existing !== undefined) return existing;
    return this.provision(kind);
  }

  private provision(kind: 'bullet' | 'number'): number {
    const { doc, root } = this.ctx;
    const { el } = maker(doc);
    const absId = this.nextAbstract++;
    const numId = this.nextNum++;

    const abs = el('abstractNum', { abstractNumId: absId });
    setAttr(abs, 'restartNumberingAfterBreak', '0');
    for (let lvl = 0; lvl < 6; lvl++) {
      const l = el('lvl', { ilvl: lvl });
      appendChild(l, el('start', { val: 1 }));
      if (kind === 'bullet') {
        // Symbol  = •, Courier 'o', Wingdings  = ▪ — Word's own
        // three-level bullet cycle, matching the fonts set on each level below.
        appendChild(l, el('numFmt', { val: 'bullet' }));
        appendChild(l, el('lvlText', { val: ['\uF0B7', 'o', '\uF0A7'][lvl % 3] }));
      } else {
        const fmts = ['decimal', 'lowerLetter', 'lowerRoman', 'decimal', 'lowerLetter', 'lowerRoman'];
        appendChild(l, el('numFmt', { val: fmts[lvl] }));
        appendChild(l, el('lvlText', { val: `%${lvl + 1}.` }));
      }
      appendChild(l, el('lvlJc', { val: 'left' }));
      const pPr = el('pPr');
      appendChild(pPr, el('ind', { left: 720 * (lvl + 1), hanging: 360 }));
      appendChild(l, pPr);
      if (kind === 'bullet') {
        const rPr = el('rPr');
        const font = ['Symbol', 'Courier New', 'Wingdings'][lvl % 3];
        appendChild(rPr, el('rFonts', { ascii: font, hAnsi: font, hint: 'default' }));
        appendChild(l, rPr);
      }
      appendChild(abs, l);
    }
    // abstractNum elements must precede num elements in numbering.xml.
    const firstNum = findChildren(root, 'num')[0];
    insertBefore(root, abs, firstNum);

    const num = el('num', { numId });
    appendChild(num, el('abstractNumId', { val: absId }));
    appendChild(root, num);

    this.ctx.existing.set(kind, numId);
    this.dirty = true;
    return numId;
  }

  /** The numbering document, when it needs writing back. */
  get pending(): XDoc | undefined {
    return this.dirty ? this.ctx.doc : undefined;
  }
}

/** Everything NumIdPool needs, prepared by the caller (async zip reads). */
export interface NumberingContext {
  doc: XDoc;
  root: XEl;
  /** Reusable list definitions already in the file, by kind. */
  existing: Map<'bullet' | 'number', number>;
  maxAbstractId: number;
  maxNumId: number;
  /** True when we synthesized the part rather than reading it. */
  created: boolean;
}

// ── Page break ───────────────────────────────────────────────────────────────

/** A paragraph holding nothing but a page break. */
export function buildPageBreak(doc: XDoc): XEl {
  const { el } = maker(doc);
  const p = el('p');
  const r = el('r');
  appendChild(r, el('br', { type: 'page' }));
  appendChild(p, r);
  return p;
}

// ── Tables ───────────────────────────────────────────────────────────────────

/** Total usable text width of an A4 page with 1" margins, in twips. */
const DEFAULT_TABLE_WIDTH = 9360;

function buildTblBorders(doc: XDoc): XEl {
  const { el } = maker(doc);
  const borders = el('tblBorders');
  for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) {
    appendChild(borders, el(side, { val: 'single', sz: 4, space: 0, color: '9CA3AF' }));
  }
  return borders;
}

/** Build a fresh r×c table with even column widths. */
export function buildTable(doc: XDoc, rows: number, cols: number, header: boolean): XEl {
  const { el } = maker(doc);
  const tbl = el('tbl');

  const tblPr = el('tblPr');
  appendChild(tblPr, el('tblStyle', { val: 'TableGrid' }));
  appendChild(tblPr, el('tblW', { w: 0, type: 'auto' }));
  appendChild(tblPr, buildTblBorders(doc));
  appendChild(tbl, tblPr);

  const colW = Math.floor(DEFAULT_TABLE_WIDTH / cols);
  const grid = el('tblGrid');
  for (let c = 0; c < cols; c++) appendChild(grid, el('gridCol', { w: colW }));
  appendChild(tbl, grid);

  for (let r = 0; r < rows; r++) {
    const tr = el('tr');
    if (header && r === 0) {
      const trPr = el('trPr');
      appendChild(trPr, el('tblHeader'));
      appendChild(tr, trPr);
    }
    for (let c = 0; c < cols; c++) {
      appendChild(tr, buildCell(doc, colW, header && r === 0));
    }
    appendChild(tbl, tr);
  }
  return tbl;
}

/** An empty table cell; header cells get bold text and a grey fill. */
export function buildCell(doc: XDoc, widthTwips: number, header = false): XEl {
  const { el } = maker(doc);
  const tc = el('tc');
  const tcPr = el('tcPr');
  appendChild(tcPr, el('tcW', { w: widthTwips, type: 'dxa' }));
  if (header) {
    appendChild(tcPr, el('shd', { val: 'clear', color: 'auto', fill: 'E8EDF3' }));
    appendChild(tcPr, el('vAlign', { val: 'center' }));
  }
  appendChild(tc, tcPr);

  const p = el('p');
  if (header) {
    const pPr = el('pPr');
    const rPr = el('rPr');
    appendChild(rPr, el('b'));
    appendChild(pPr, rPr);
    appendChild(p, pPr);
  }
  appendChild(tc, p);
  return tc;
}

/** Replace a table cell's content with a single paragraph of `runs`. */
export function setCellRuns(doc: XDoc, tc: XEl, runs: RunSpan[]): void {
  const paras = findChildren(tc, 'p');
  const keep = paras[0];
  for (const p of paras.slice(1)) removeChild(tc, p);
  if (keep) {
    setParaRuns(doc, keep, runs);
    return;
  }
  const { el } = maker(doc);
  const p = el('p');
  setParaRuns(doc, p, runs);
  appendChild(tc, p);
}

/** Apply cell-level formatting (background, vertical alignment). */
export function patchCellProps(doc: XDoc, tc: XEl, bg: string | null | undefined, va: 't' | 'm' | 'b' | null | undefined): void {
  if (bg === undefined && va === undefined) return;
  const tcPr = ensureBag(doc, tc, 'tcPr');
  if (bg !== undefined) {
    setProp(doc, tcPr, 'shd', bg === null ? null : { val: 'clear', color: 'auto', fill: ooxmlColor(bg, 'FFFFFF') }, TCPR_ORDER);
  }
  if (va !== undefined) {
    const map = { t: 'top', m: 'center', b: 'bottom' } as const;
    setProp(doc, tcPr, 'vAlign', va === null ? null : { val: map[va] }, TCPR_ORDER);
  }
}

/** Rows of a table, as `w:tr` elements. */
export const tableRows = (tbl: XEl): XEl[] => findChildren(tbl, 'tr');
/** Cells of a row, as `w:tc` elements. */
export const rowCells = (tr: XEl): XEl[] => findChildren(tr, 'tc');

/** Insert a copy of row `r` above/below it, blanked out. */
export function insertTableRow(doc: XDoc, tbl: XEl, r: number, where: 'above' | 'below'): void {
  const rows = tableRows(tbl);
  const model = rows[Math.min(r, rows.length - 1)];
  if (!model) throw new Error('Bảng không có dòng nào để nhân bản.');
  // Is the row we're cloning the repeating header? A bare <w:trPr> is not
  // enough to tell — Word writes one for row height too — so test the
  // <w:tblHeader> flag itself.
  const modelTrPr = findChild(model, 'trPr');
  const modelIsHeader = !!(modelTrPr && findChild(modelTrPr, 'tblHeader'));

  const fresh = cloneEl(model);
  // A cloned header row would repeat on every page — strip that flag.
  const trPr = findChild(fresh, 'trPr');
  if (trPr) {
    const hdr = findChild(trPr, 'tblHeader');
    if (hdr) removeChild(trPr, hdr);
  }
  for (const tc of rowCells(fresh)) {
    setCellRuns(doc, tc, []);
    // Header shading shouldn't carry into a body row — but a body row's own
    // shading should, so the new row matches the column it sits in.
    if (modelIsHeader) {
      const tcPr = findChild(tc, 'tcPr');
      const shd = tcPr && findChild(tcPr, 'shd');
      if (tcPr && shd) removeChild(tcPr, shd);
    }
  }
  const anchor = where === 'above' ? model : tableRows(tbl)[r + 1];
  insertBefore(tbl, fresh, anchor);
}

export function deleteTableRow(tbl: XEl, r: number): void {
  const rows = tableRows(tbl);
  if (rows.length <= 1) throw new Error('Bảng phải còn ít nhất một dòng — xóa cả bảng nếu không cần nữa.');
  const row = rows[r];
  if (!row) throw new Error(`Bảng không có dòng #${r + 1}.`);
  removeChild(tbl, row);
}

/** Insert a column beside column `c` in every row, splitting the width evenly. */
export function insertTableCol(doc: XDoc, tbl: XEl, c: number, where: 'left' | 'right'): void {
  const { el } = maker(doc);
  const grid = findChild(tbl, 'tblGrid');
  let width = Math.floor(DEFAULT_TABLE_WIDTH / (gridColCount(tbl) + 1));

  if (grid) {
    const cols = findChildren(grid, 'gridCol');
    const total = cols.reduce((s, g) => s + (numAttr(g, 'w') ?? 0), 0) || DEFAULT_TABLE_WIDTH;
    width = Math.floor(total / (cols.length + 1));
    // Re-space every column so the table keeps its overall width.
    for (const g of cols) setAttr(g, 'w', String(width));
    const fresh = el('gridCol', { w: width });
    insertBefore(grid, fresh, where === 'left' ? cols[c] : cols[c + 1]);
  }

  for (const tr of tableRows(tbl)) {
    const cells = rowCells(tr);
    const isHeader = !!findChild(tr, 'trPr')?.valueOf() && !!findChild(findChild(tr, 'trPr') as XEl, 'tblHeader');
    const model = cells[Math.min(c, cells.length - 1)];
    const fresh = buildCell(doc, width, isHeader);
    // Carry the neighbour's shading so a styled column stays consistent.
    if (model && !isHeader) {
      const src = findChild(model, 'tcPr');
      const shd = src && findChild(src, 'shd');
      if (shd) {
        const tcPr = ensureBag(doc, fresh, 'tcPr');
        const old = findChild(tcPr, 'shd');
        if (old) removeChild(tcPr, old);
        insertOrdered(tcPr, cloneEl(shd), TCPR_ORDER);
      }
    }
    insertBefore(tr, fresh, where === 'left' ? cells[c] : cells[c + 1]);
    for (const tc of rowCells(tr)) {
      const tcPr = findChild(tc, 'tcPr');
      const tcW = tcPr && findChild(tcPr, 'tcW');
      if (tcW && attr(tcW, 'type') === 'dxa') setAttr(tcW, 'w', String(width));
    }
  }
}

function gridColCount(tbl: XEl): number {
  const grid = findChild(tbl, 'tblGrid');
  if (grid) return findChildren(grid, 'gridCol').length;
  return Math.max(...tableRows(tbl).map((tr) => rowCells(tr).length), 1);
}

export function deleteTableCol(tbl: XEl, c: number): void {
  if (gridColCount(tbl) <= 1) throw new Error('Bảng phải còn ít nhất một cột — xóa cả bảng nếu không cần nữa.');
  const grid = findChild(tbl, 'tblGrid');
  if (grid) {
    const cols = findChildren(grid, 'gridCol');
    if (cols[c]) removeChild(grid, cols[c]);
  }
  for (const tr of tableRows(tbl)) {
    const cells = rowCells(tr);
    if (cells[c]) removeChild(tr, cells[c]);
  }
}

/** Turn the table's border grid on or off. */
export function setTableBorders(doc: XDoc, tbl: XEl, on: boolean): void {
  const tblPr = ensureBag(doc, tbl, 'tblPr');
  const existing = findChild(tblPr, 'tblBorders');
  if (existing) removeChild(tblPr, existing);
  const { el } = maker(doc);
  if (on) {
    insertBefore(tblPr, buildTblBorders(doc), undefined);
  } else {
    const borders = el('tblBorders');
    for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) {
      appendChild(borders, el(side, { val: 'none', sz: 0, space: 0, color: 'auto' }));
    }
    appendChild(tblPr, borders);
  }
}

/** Cell at (r, c) of a table, accounting for nothing fancier than gridSpan. */
export function cellAt(tbl: XEl, r: number, c: number): XEl | undefined {
  const row = tableRows(tbl)[r];
  if (!row) return undefined;
  return rowCells(row)[c];
}

export { W };
