// Server-only OOXML primitives shared by the Word reader and writer.
//
// A .docx is a zip of XML parts; the body lives in word/document.xml. We work
// on the parsed DOM (via @xmldom/xmldom) rather than regexes so that untouched
// elements keep their exact original markup on re-serialize.
//
// xmldom's types are structural, so the whole file leans on a small set of
// narrow casts collected here — everything above this layer stays typed.

import { DOMParser } from '@xmldom/xmldom';

/** WordprocessingML main namespace. */
export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
/** Relationships namespace (header/footer references). */
export const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export type XEl = ReturnType<DOMParser['parseFromString']>['documentElement'] & object;
export type XDoc = ReturnType<DOMParser['parseFromString']>;

// ── Narrow structural views onto xmldom nodes ────────────────────────────────

interface NodeLike {
  nodeType?: number;
  localName?: string;
  textContent?: string | null;
  childNodes: { length: number; item(i: number): unknown };
  parentNode?: unknown;
}
interface ElLike extends NodeLike {
  getAttributeNS(ns: string | null, n: string): string | null;
  setAttributeNS(ns: string | null, n: string, v: string): void;
  removeAttributeNS(ns: string | null, n: string): void;
  hasAttributeNS(ns: string | null, n: string): boolean;
  setAttribute(n: string, v: string): void;
  appendChild(n: unknown): unknown;
  insertBefore(n: unknown, ref: unknown): unknown;
  removeChild(n: unknown): unknown;
  replaceChild(n: unknown, old: unknown): unknown;
  cloneNode(deep: boolean): unknown;
}

const asEl = (e: XEl) => e as unknown as ElLike;

export const local = (e: XEl): string => (e as unknown as NodeLike).localName ?? '';

export function elementChildren(n: XEl): XEl[] {
  const out: XEl[] = [];
  const kids = (n as unknown as NodeLike).childNodes;
  for (let i = 0; i < kids.length; i++) {
    const c = kids.item(i) as NodeLike | null;
    if (c && c.nodeType === 1) out.push(c as unknown as XEl);
  }
  return out;
}

/** Depth-first walk; a visitor returning false skips that element's subtree. */
export function walk(el: XEl, visit: (e: XEl) => boolean | void): void {
  for (const c of elementChildren(el)) {
    if (visit(c) !== false) walk(c, visit);
  }
}

export function findChild(el: XEl, name: string): XEl | undefined {
  return elementChildren(el).find((c) => local(c) === name);
}

export function findChildren(el: XEl, name: string): XEl[] {
  return elementChildren(el).filter((c) => local(c) === name);
}

/** First descendant with this local name (depth-first). */
export function findDeep(el: XEl, name: string): XEl | undefined {
  let hit: XEl | undefined;
  walk(el, (e) => {
    if (hit) return false;
    if (local(e) === name) { hit = e; return false; }
    return undefined;
  });
  return hit;
}

export const textOf = (e: XEl): string => (e as unknown as NodeLike).textContent ?? '';

// ── Attributes (w:val and friends) ───────────────────────────────────────────

export function attr(el: XEl | undefined, name: string): string | null {
  if (!el) return null;
  const e = asEl(el);
  // Namespaced lookup first, then the raw name — xmldom keeps both reachable
  // and some producers write attributes without the w: prefix.
  return e.getAttributeNS(W, name) ?? e.getAttributeNS(null, name) ?? null;
}

export const val = (el: XEl | undefined): string | null => attr(el, 'val');

export function numAttr(el: XEl | undefined, name: string): number | undefined {
  const v = attr(el, name);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A toggle property (`<w:b/>`, `<w:i/>`, …) is ON when present unless it
 * carries an explicit falsy w:val — Word writes `w:val="0"` to turn a
 * style-inherited toggle back off.
 */
export function toggleOn(el: XEl | undefined): boolean {
  if (!el) return false;
  const v = val(el);
  return v === null || !(v === '0' || v === 'false' || v === 'off');
}

// ── Mutation ─────────────────────────────────────────────────────────────────

export function setAttr(el: XEl, name: string, value: string): void {
  asEl(el).setAttributeNS(W, `w:${name}`, value);
}

export function appendChild(parent: XEl, child: XEl): void {
  asEl(parent).appendChild(child);
}

export function insertBefore(parent: XEl, child: XEl, ref: XEl | undefined): void {
  if (ref) asEl(parent).insertBefore(child, ref);
  else asEl(parent).appendChild(child);
}

export function removeChild(parent: XEl, child: XEl): void {
  asEl(parent).removeChild(child);
}

export function replaceChild(parent: XEl, next: XEl, old: XEl): void {
  asEl(parent).replaceChild(next, old);
}

export function cloneEl(el: XEl): XEl {
  return asEl(el).cloneNode(true) as XEl;
}

export function parentOf(el: XEl): XEl | undefined {
  const p = (el as unknown as NodeLike).parentNode as NodeLike | undefined;
  return p && p.nodeType === 1 ? (p as unknown as XEl) : undefined;
}

/** Remove `el` from its parent, if it has one. */
export function detach(el: XEl): void {
  const p = parentOf(el);
  if (p) removeChild(p, el);
}

/** Drop every child element whose local name is in `names`. */
export function removeChildrenNamed(el: XEl, names: string[]): void {
  for (const c of elementChildren(el)) {
    if (names.includes(local(c))) removeChild(el, c);
  }
}

// ── Element construction ─────────────────────────────────────────────────────

/** Factory bound to one document: `el('p')` → `<w:p/>`. */
export function maker(doc: XDoc) {
  const el = (name: string, attrs?: Record<string, string | number | undefined>): XEl => {
    const e = doc.createElementNS(W, `w:${name}`) as unknown as XEl;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v !== undefined) setAttr(e, k, String(v));
      }
    }
    return e;
  };
  /** `<w:t xml:space="preserve">text</w:t>` — preserve keeps leading spaces. */
  const text = (s: string): XEl => {
    const t = el('t');
    asEl(t).setAttribute('xml:space', 'preserve');
    asEl(t).appendChild(doc.createTextNode(s));
    return t;
  };
  return { el, text };
}

/**
 * Insert a property element into a property bag (`w:pPr` / `w:rPr`) at the
 * position OOXML's schema demands — these are sequences, and Word rejects a
 * document whose properties are out of order.
 */
export function insertOrdered(bag: XEl, child: XEl, order: string[]): void {
  const name = local(child);
  const rank = order.indexOf(name);
  // Unknown property → append; schema order is only defined for what we write.
  if (rank < 0) { appendChild(bag, child); return; }
  const after = elementChildren(bag).find((c) => {
    const r = order.indexOf(local(c));
    return r >= 0 && r > rank;
  });
  insertBefore(bag, child, after);
}

/** Child sequence of `w:pPr`, in schema order (the part we touch). */
export const PPR_ORDER = [
  'pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl',
  'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens',
  'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE',
  'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind',
  'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection',
  'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr',
  'sectPr', 'pPrChange',
];

/** Child sequence of `w:rPr`, in schema order (the part we touch). */
export const RPR_ORDER = [
  'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike',
  'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid',
  'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz',
  'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign',
  'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath',
];

/** Child sequence of `w:tcPr` (table cell properties). */
export const TCPR_ORDER = [
  'cnfStyle', 'tcW', 'gridSpan', 'hMerge', 'vMerge', 'tcBorders', 'shd',
  'noWrap', 'tcMar', 'textDirection', 'tcFitText', 'vAlign', 'hideMark',
];

/** Get (or create) a property bag child of `el`. A bag is always the FIRST
 *  child of its parent (w:pPr in w:p, w:rPr in w:r, w:tcPr in w:tc …). */
export function ensureBag(doc: XDoc, el: XEl, name: 'pPr' | 'rPr' | 'tcPr' | 'tblPr' | 'trPr'): XEl {
  const existing = findChild(el, name);
  if (existing) return existing;
  const { el: mk } = maker(doc);
  const bag = mk(name);
  insertBefore(el, bag, elementChildren(el)[0]);
  return bag;
}

/** Replace (or create) a single-valued property inside a bag. */
export function setProp(doc: XDoc, bag: XEl, name: string, attrs: Record<string, string | number | undefined> | null, order: string[]): void {
  const existing = findChild(bag, name);
  if (attrs === null) {
    if (existing) removeChild(bag, existing);
    return;
  }
  const { el } = maker(doc);
  const next = el(name, attrs);
  if (existing) replaceChild(bag, next, existing);
  else insertOrdered(bag, next, order);
}

// ── Colors ───────────────────────────────────────────────────────────────────

/** OOXML color ('4472C4', 'auto') → CSS '#rrggbb', or undefined. */
export function cssColor(raw: string | null | undefined): string | undefined {
  if (!raw || raw === 'auto') return undefined;
  const hex = raw.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  return `#${hex.toLowerCase()}`;
}

/** CSS '#rrggbb' → OOXML 'RRGGBB'. Invalid input falls back to `fallback`. */
export function ooxmlColor(css: string | null | undefined, fallback = '000000'): string {
  const hex = String(css ?? '').replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(hex) ? hex.toUpperCase() : fallback;
}

// ── Units ────────────────────────────────────────────────────────────────────
// OOXML measures in twentieths of a point ("twips") and half-points; the wire
// format uses plain points so the UI never has to think about either.

export const twipToPt = (tw: number): number => Math.round((tw / 20) * 10) / 10;
export const ptToTwip = (pt: number): number => Math.round(pt * 20);
export const halfPtToPt = (hp: number): number => Math.round((hp / 2) * 10) / 10;
export const ptToHalfPt = (pt: number): number => Math.round(pt * 2);
