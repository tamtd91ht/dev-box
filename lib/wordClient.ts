// Server-only engine for the Word editor (Office tab).
//
// A .docx is a zip; the body lives in word/document.xml as a sequence of
// block elements (<w:p> paragraphs, <w:tbl> tables). Editing is
// READ-MODIFY-WRITE with an op log: on save the file is re-read fresh and the
// client's ops are replayed on the XML DOM, so every untouched paragraph keeps
// its exact original markup — and therefore its exact formatting.
//
// This module is the orchestrator. The heavy lifting lives in:
//   lib/wordXml.ts       — DOM/OOXML primitives
//   lib/wordRead.ts      — .docx → wire model
//   lib/wordWrite.ts     — wire ops → DOM mutations
//   lib/wordDocxParts.ts — new-document + template XML
//
// Scope guards:
//   - Paragraphs containing content we cannot rebuild (images, fields, links,
//     content controls, math) are LOCKED for text edits — replacing their runs
//     would silently destroy that content. Deleting them is always allowed,
//     and paragraph-level formatting on them is fine.
//   - .doc (binary 97-2003) and .docm (macro) are refused.
// Safety rails: OFFICE gates, size cap, stale-mtime check, `.bak` backup +
// atomic rename, WORD_AUDIT log line.

import { promises as fs } from 'fs';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type {
  ParaFormatPatch, RunFormatPatch, RunSpan, WordOp, WordOpenResult,
  WordSaveResult, WordTemplate,
} from './word';
import { runsText } from './word';
import { OFFICE_ALLOW_WRITE } from './officeFlags';
import {
  MAX_FILE_BYTES,
  resolveOfficeFile,
  resolveNewOfficeFile,
  writeNewFile,
  assertNotStale,
  atomicBackupWrite,
} from './officeFiles';
import {
  R_NS, W, type XDoc, type XEl,
  appendChild, attr, elementChildren, findChild, findChildren, insertBefore,
  local, maker, numAttr, removeChild, setAttr, textOf, val,
} from './wordXml';
import {
  collectBlockEls, lockReason, readBlocks, readDocx, readHeadersFooters,
  readNumbering, readPageSetup, type ParsedDocx,
} from './wordRead';
import {
  NumIdPool, buildPageBreak, buildParaProps, buildTable, cellAt,
  deleteTableCol, deleteTableRow, insertTableCol, insertTableRow,
  patchCellProps, patchParaProps, patchParaRunRange, rowCells, setCellRuns,
  setParaRuns, setTableBorders, tableRows, type NumberingContext,
} from './wordWrite';
import {
  EMPTY_NUMBERING_XML, FOOTER_CT, FOOTER_REL, HEADER_CT, HEADER_REL,
  emptyHeaderFooterXml, newDocxParts,
} from './wordDocxParts';

export { OFFICE_ENABLED as WORD_ENABLED, OFFICE_ALLOW_WRITE as WORD_ALLOW_WRITE } from './officeFlags';
export { MAX_FILE_BYTES };

export const MAX_BLOCKS = 5000;

const REFUSED = {
  '.doc': 'Định dạng Word 97–2003 (.doc) không hỗ trợ — mở bằng Word rồi Save As .docx trước.',
  '.docm': '.docm (file có macro) không được hỗ trợ — lưu lại sẽ mất VBA. Hãy Save As .docx trước.',
};

const writeGate = () => {
  if (!OFFICE_ALLOW_WRITE) {
    throw new Error('Ghi file đang tắt cho toàn tool. Set OFFICE_ALLOW_WRITE=true trong .env.local (local dev only).');
  }
};

// ── open ─────────────────────────────────────────────────────────────────────

export async function openDocx(rawPath: unknown): Promise<WordOpenResult> {
  const t = await resolveOfficeFile(rawPath, ['.docx'], REFUSED);
  const parsed = await readDocx(t.abs, await fs.readFile(t.abs));
  const nums = await readNumbering(parsed.zip);

  const els = collectBlockEls(parsed.body);
  const blocks = readBlocks(els.slice(0, MAX_BLOCKS), nums);
  const { headers, footers } = await readHeadersFooters(parsed.zip, parsed.body, nums);

  return {
    path: t.abs,
    sizeBytes: t.sizeBytes,
    mtimeMs: t.mtimeMs,
    blocks,
    truncated: els.length > MAX_BLOCKS,
    headers,
    footers,
    page: readPageSetup(parsed.body),
  };
}

// ── create ───────────────────────────────────────────────────────────────────

const TEMPLATES: WordTemplate[] = ['blank', 'report', 'minutes', 'proposal'];

export interface CreateDocxInput {
  dir: unknown;
  name: unknown;
  template?: unknown;
}

/** Create a NEW .docx — blank or from a report template — then open it.
 *  Never overwrites; gated by OFFICE_ALLOW_WRITE like every other write. */
export async function createDocx(input: CreateDocxInput): Promise<WordOpenResult> {
  writeGate();
  const { abs } = await resolveNewOfficeFile(input.dir, input.name, ['.docx']);
  const raw = String(input.template ?? 'blank') as WordTemplate;
  const template: WordTemplate = TEMPLATES.includes(raw) ? raw : 'blank';

  const zip = new JSZip();
  for (const [name, xml] of Object.entries(newDocxParts(template))) zip.file(name, xml);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  await writeNewFile(abs, Buffer.from(buf));

  // eslint-disable-next-line no-console
  console.log(`WORD_AUDIT operation=CREATE path=${abs} template=${template} ts=${new Date().toISOString()}`);
  return openDocx(abs);
}

// ── op sanitising ────────────────────────────────────────────────────────────

const MAX_TEXT = 200_000;

function idx(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 500_000) throw new Error(`${what} không hợp lệ: ${String(v)}`);
  return n;
}

function str(v: unknown, max = MAX_TEXT): string {
  const s = String(v ?? '');
  if (s.length > max) throw new Error(`Nội dung quá dài (${s.length} ký tự > ${max}).`);
  return s;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
/** Word's fixed highlight palette — anything else is refused. */
const HIGHLIGHTS = new Set([
  'yellow', 'green', 'cyan', 'magenta', 'blue', 'red', 'darkBlue', 'darkCyan',
  'darkGreen', 'darkMagenta', 'darkRed', 'darkYellow', 'darkGray', 'lightGray',
  'black', 'white', 'none',
]);

function sanitizeRunFormat(raw: unknown): RunSpan['f'] {
  const o = (raw ?? {}) as Record<string, unknown>;
  const f: NonNullable<RunSpan['f']> = {};
  for (const k of ['b', 'i', 'u', 'st', 'caps', 'smallCaps'] as const) {
    if (o[k]) f[k] = 1;
  }
  if (typeof o.fc === 'string' && HEX.test(o.fc)) f.fc = o.fc.toLowerCase();
  if (typeof o.bg === 'string' && HEX.test(o.bg)) f.bg = o.bg.toLowerCase();
  if (typeof o.hl === 'string' && HIGHLIGHTS.has(o.hl)) f.hl = o.hl;
  if (typeof o.ff === 'string' && o.ff.length <= 64) f.ff = o.ff;
  const fs = Number(o.fs);
  if (Number.isFinite(fs) && fs >= 1 && fs <= 409) f.fs = Math.round(fs * 2) / 2;
  if (o.va === 'sup' || o.va === 'sub') f.va = o.va;
  return Object.keys(f).length > 0 ? f : undefined;
}

/** Tri-state patch field: undefined = keep, null = clear, value = set. */
function tri<T>(raw: unknown, parse: (v: unknown) => T | undefined): T | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  return parse(raw);
}

function sanitizeRunPatch(raw: unknown): RunFormatPatch {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.clear) return { clear: 1 };
  const p: Record<string, unknown> = {};
  for (const k of ['b', 'i', 'u', 'st', 'caps', 'smallCaps']) {
    const v = tri(o[k], (x) => (x ? 1 : null));
    if (v !== undefined) p[k] = v;
  }
  for (const k of ['fc', 'bg']) {
    const v = tri(o[k], (x) => (typeof x === 'string' && HEX.test(x) ? x.toLowerCase() : undefined));
    if (v !== undefined) p[k] = v;
  }
  const hl = tri(o.hl, (x) => (typeof x === 'string' && HIGHLIGHTS.has(x) ? x : undefined));
  if (hl !== undefined) p.hl = hl === 'none' ? null : hl;
  const ff = tri(o.ff, (x) => (typeof x === 'string' && x.length <= 64 ? x : undefined));
  if (ff !== undefined) p.ff = ff;
  const fs = tri(o.fs, (x) => {
    const n = Number(x);
    return Number.isFinite(n) && n >= 1 && n <= 409 ? Math.round(n * 2) / 2 : undefined;
  });
  if (fs !== undefined) p.fs = fs;
  const va = tri(o.va, (x) => (x === 'sup' || x === 'sub' ? x : undefined));
  if (va !== undefined) p.va = va;
  return p as RunFormatPatch;
}

const STYLE_ID = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

function sanitizeParaPatch(raw: unknown): ParaFormatPatch {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.clear) return { clear: 1 };
  const p: ParaFormatPatch = {};
  const style = tri(o.style, (x) => (typeof x === 'string' && STYLE_ID.test(x) ? x : undefined));
  if (style !== undefined) p.style = style;
  const jc = tri(o.jc, (x) => (x === 'l' || x === 'c' || x === 'r' || x === 'j' ? x : undefined));
  if (jc !== undefined) p.jc = jc;
  const num = (v: unknown, lo: number, hi: number) => tri(v, (x) => {
    const n = Number(x);
    return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 100) / 100 : undefined;
  });
  const ls = num(o.ls, 0.25, 10); if (ls !== undefined) p.ls = ls;
  const sb = num(o.sb, 0, 720); if (sb !== undefined) p.sb = sb;
  const sa = num(o.sa, 0, 720); if (sa !== undefined) p.sa = sa;
  const il = num(o.il, 0, 720); if (il !== undefined) p.il = il;
  const ifl = num(o.ifl, -720, 720); if (ifl !== undefined) p.ifl = ifl;
  const list = tri(o.list, (x) => (x === 'bullet' || x === 'number' ? x : undefined));
  if (list !== undefined) p.list = list;
  const lvl = tri(o.lvl, (x) => {
    const n = Number(x);
    return Number.isInteger(n) && n >= 0 && n <= 5 ? n : undefined;
  });
  if (lvl !== undefined) p.lvl = lvl;
  return p;
}

function sanitizeRuns(raw: unknown): RunSpan[] {
  if (!Array.isArray(raw)) throw new Error('runs phải là mảng.');
  let total = 0;
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const t = String(o.t ?? '');
    total += t.length;
    if (total > MAX_TEXT) throw new Error(`Đoạn quá dài (> ${MAX_TEXT} ký tự).`);
    const f = sanitizeRunFormat(o.f);
    return { t, ...(f ? { f } : {}) };
  });
}

function sanitizeOps(raw: unknown): WordOp[] {
  if (!Array.isArray(raw)) throw new Error('ops phải là mảng.');
  if (raw.length > 20_000) throw new Error('Quá nhiều thay đổi trong một lần lưu.');
  return raw.map((o): WordOp => {
    const op = (o ?? {}) as Record<string, unknown>;
    switch (op.op) {
      case 'set':
        return { op: 'set', i: idx(op.i, 'chỉ số đoạn'), runs: sanitizeRuns(op.runs) };
      case 'runFmt': {
        const from = idx(op.from, 'vị trí đầu');
        const to = idx(op.to, 'vị trí cuối');
        if (to < from) throw new Error('Vùng bôi đen không hợp lệ.');
        return { op: 'runFmt', i: idx(op.i, 'chỉ số đoạn'), from, to, f: sanitizeRunPatch(op.f) };
      }
      case 'paraFmt':
        return { op: 'paraFmt', i: idx(op.i, 'chỉ số đoạn'), f: sanitizeParaPatch(op.f) };
      case 'insert': {
        const fmt = sanitizeParaPatch(op.fmt);
        return {
          op: 'insert', i: idx(op.i, 'chỉ số đoạn'), runs: sanitizeRuns(op.runs ?? []),
          ...(Object.keys(fmt).length > 0 ? { fmt: fmt as never } : {}),
        };
      }
      case 'delete':
        return { op: 'delete', i: idx(op.i, 'chỉ số đoạn') };
      case 'move':
        return { op: 'move', i: idx(op.i, 'chỉ số đoạn'), to: idx(op.to, 'vị trí đích') };
      case 'pageBreak':
        return { op: 'pageBreak', i: idx(op.i, 'chỉ số đoạn') };
      case 'tblInsert': {
        const rows = idx(op.rows, 'số dòng');
        const cols = idx(op.cols, 'số cột');
        if (rows < 1 || rows > 200 || cols < 1 || cols > 30) {
          throw new Error('Bảng phải từ 1–200 dòng và 1–30 cột.');
        }
        return { op: 'tblInsert', i: idx(op.i, 'chỉ số đoạn'), rows, cols, ...(op.header ? { header: 1 as const } : {}) };
      }
      case 'cellSet':
        return {
          op: 'cellSet', i: idx(op.i, 'chỉ số bảng'),
          r: idx(op.r, 'dòng'), c: idx(op.c, 'cột'), runs: sanitizeRuns(op.runs),
        };
      case 'cellFmt': {
        const bg = tri(op.bg, (x) => (typeof x === 'string' && HEX.test(x) ? x.toLowerCase() : undefined));
        const va = tri(op.va, (x) => (x === 't' || x === 'm' || x === 'b' ? x : undefined));
        return {
          op: 'cellFmt', i: idx(op.i, 'chỉ số bảng'), r: idx(op.r, 'dòng'), c: idx(op.c, 'cột'),
          f: sanitizeRunPatch(op.f),
          ...(bg !== undefined ? { bg } : {}), ...(va !== undefined ? { va } : {}),
        };
      }
      case 'tblRowInsert':
        return {
          op: 'tblRowInsert', i: idx(op.i, 'chỉ số bảng'), r: idx(op.r, 'dòng'),
          where: op.where === 'above' ? 'above' : 'below',
        };
      case 'tblRowDelete':
        return { op: 'tblRowDelete', i: idx(op.i, 'chỉ số bảng'), r: idx(op.r, 'dòng') };
      case 'tblColInsert':
        return {
          op: 'tblColInsert', i: idx(op.i, 'chỉ số bảng'), c: idx(op.c, 'cột'),
          where: op.where === 'left' ? 'left' : 'right',
        };
      case 'tblColDelete':
        return { op: 'tblColDelete', i: idx(op.i, 'chỉ số bảng'), c: idx(op.c, 'cột') };
      case 'tblBorder':
        return { op: 'tblBorder', i: idx(op.i, 'chỉ số bảng'), on: op.on ? 1 : 0 };
      case 'hfSet':
        return {
          op: 'hfSet', part: op.part === 'header' ? 'header' : 'footer',
          text: str(op.text, 2000),
          jc: op.jc === 'l' || op.jc === 'c' || op.jc === 'r' ? op.jc : 'c',
          pageNum: op.pageNum ? 1 : 0,
        };
      case 'replaceAll': {
        const find = str(op.find, 1000);
        if (find === '') throw new Error('Chuỗi cần tìm đang để trống.');
        return {
          op: 'replaceAll', find, replace: str(op.replace, 1000),
          matchCase: op.matchCase ? 1 : 0, whole: op.whole ? 1 : 0,
        };
      }
      default:
        throw new Error(`Thao tác không hợp lệ: ${String(op.op)}`);
    }
  });
}

// ── numbering context (lazily provisioned lists) ─────────────────────────────

async function numberingContext(parsed: ParsedDocx): Promise<NumberingContext> {
  const entry = parsed.zip.file('word/numbering.xml');
  const xml = entry ? await entry.async('string') : EMPTY_NUMBERING_XML;
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const root = doc.documentElement as unknown as XEl;

  const existing = new Map<'bullet' | 'number', number>();
  const abstractFmt = new Map<number, string>();
  let maxAbstractId = -1;
  let maxNumId = 0;

  for (const an of findChildren(root, 'abstractNum')) {
    const id = numAttr(an, 'abstractNumId');
    if (id === undefined) continue;
    maxAbstractId = Math.max(maxAbstractId, id);
    const lvl0 = findChildren(an, 'lvl').find((l) => (numAttr(l, 'ilvl') ?? 0) === 0);
    const fmt = lvl0 ? val(findChild(lvl0, 'numFmt')) : null;
    if (fmt) abstractFmt.set(id, fmt);
  }
  for (const num of findChildren(root, 'num')) {
    const id = numAttr(num, 'numId');
    if (id === undefined) continue;
    maxNumId = Math.max(maxNumId, id);
    const absId = numAttr(findChild(num, 'abstractNumId'), 'val');
    const fmt = absId !== undefined ? abstractFmt.get(absId) : undefined;
    if (!fmt) continue;
    const kind = fmt === 'bullet' ? 'bullet' : 'number';
    // First definition of each kind wins — reusing it keeps the file tidy.
    if (!existing.has(kind)) existing.set(kind, id);
  }

  return { doc, root, existing, maxAbstractId, maxNumId, created: !entry };
}

// ── header / footer writing ──────────────────────────────────────────────────

/** Next free rIdN in word/_rels/document.xml.rels. */
function nextRelId(relsRoot: XEl): string {
  let max = 0;
  for (const rel of elementChildren(relsRoot)) {
    const m = /^rId(\d+)$/.exec(attr(rel, 'Id') ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `rId${max + 1}`;
}

/** Build a header/footer part with the given text, optionally page-numbered. */
function buildHeaderFooterXml(part: 'header' | 'footer', text: string, jc: 'l' | 'c' | 'r', pageNum: boolean): string {
  const doc = new DOMParser().parseFromString(emptyHeaderFooterXml(part), 'text/xml');
  const root = doc.documentElement as unknown as XEl;
  const { el, text: mkText } = maker(doc);

  for (const c of elementChildren(root)) removeChild(root, c);

  const p = el('p');
  const pPr = el('pPr');
  appendChild(pPr, el('jc', { val: { l: 'left', c: 'center', r: 'right' }[jc] }));
  appendChild(p, pPr);

  if (text !== '') {
    const r = el('r');
    appendChild(r, mkText(pageNum ? `${text} ` : text));
    appendChild(p, r);
  }
  if (pageNum) {
    // A PAGE field: begin → instruction → separate → cached result → end.
    const begin = el('r');
    appendChild(begin, el('fldChar', { fldCharType: 'begin' }));
    appendChild(p, begin);

    const instr = el('r');
    const it = el('instrText');
    (it as unknown as { setAttribute(n: string, v: string): void }).setAttribute('xml:space', 'preserve');
    (it as unknown as { appendChild(n: unknown): void }).appendChild(doc.createTextNode(' PAGE '));
    appendChild(instr, it);
    appendChild(p, instr);

    const sep = el('r');
    appendChild(sep, el('fldChar', { fldCharType: 'separate' }));
    appendChild(p, sep);

    const cached = el('r');
    appendChild(cached, mkText('1'));
    appendChild(p, cached);

    const end = el('r');
    appendChild(end, el('fldChar', { fldCharType: 'end' }));
    appendChild(p, end);
  }
  appendChild(root, p);
  return serialize(doc, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n');
}

/**
 * Write the default header/footer: create the part, register its content type
 * and relationship, and point the section at it (replacing any existing
 * default reference of that kind).
 */
async function applyHeaderFooter(
  parsed: ParsedDocx, part: 'header' | 'footer', text: string, jc: 'l' | 'c' | 'r', pageNum: boolean,
): Promise<void> {
  const { zip, doc, body } = parsed;
  const sectPr = findChild(body, 'sectPr') ?? (() => {
    const { el } = maker(doc);
    const s = el('sectPr');
    appendChild(body, s);
    return s;
  })();

  const refName = part === 'header' ? 'headerReference' : 'footerReference';
  const partFile = part === 'header' ? 'header9.xml' : 'footer9.xml';

  // Reuse our own part on repeat edits so we don't pile up header9, header10…
  zip.file(`word/${partFile}`, buildHeaderFooterXml(part, text, jc, pageNum));

  // [Content_Types].xml override
  const ctEntry = zip.file('[Content_Types].xml');
  if (ctEntry) {
    const ctDoc = new DOMParser().parseFromString(await ctEntry.async('string'), 'text/xml');
    const ctRoot = ctDoc.documentElement as unknown as XEl;
    const pn = `/word/${partFile}`;
    const already = elementChildren(ctRoot).some((e) => attr(e, 'PartName') === pn);
    if (!already) {
      const ov = ctDoc.createElementNS('http://schemas.openxmlformats.org/package/2006/content-types', 'Override') as unknown as XEl;
      const set = (n: string, v: string) => (ov as unknown as { setAttribute(a: string, b: string): void }).setAttribute(n, v);
      set('PartName', pn);
      set('ContentType', part === 'header' ? HEADER_CT : FOOTER_CT);
      appendChild(ctRoot, ov);
      zip.file('[Content_Types].xml', serialize(ctDoc));
    }
  }

  // Relationship
  const relsPath = 'word/_rels/document.xml.rels';
  const relsEntry = zip.file(relsPath);
  const relsXml = relsEntry
    ? await relsEntry.async('string')
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';
  const relsDoc = new DOMParser().parseFromString(relsXml, 'text/xml');
  const relsRoot = relsDoc.documentElement as unknown as XEl;

  const existingRel = elementChildren(relsRoot).find((e) => attr(e, 'Target') === partFile);
  let relId = existingRel ? attr(existingRel, 'Id') ?? undefined : undefined;
  if (!relId) {
    relId = nextRelId(relsRoot);
    const rel = relsDoc.createElementNS('http://schemas.openxmlformats.org/package/2006/relationships', 'Relationship') as unknown as XEl;
    const set = (n: string, v: string) => (rel as unknown as { setAttribute(a: string, b: string): void }).setAttribute(n, v);
    set('Id', relId);
    set('Type', part === 'header' ? HEADER_REL : FOOTER_REL);
    set('Target', partFile);
    appendChild(relsRoot, rel);
  }
  zip.file(relsPath, serialize(relsDoc));

  // Section reference — replace the existing default one.
  for (const ref of elementChildren(sectPr)) {
    if (local(ref) === refName && (attr(ref, 'type') ?? 'default') === 'default') removeChild(sectPr, ref);
  }
  const { el } = maker(doc);
  const ref = el(refName, { type: 'default' });
  (ref as unknown as { setAttributeNS(ns: string, n: string, v: string): void })
    .setAttributeNS(R_NS, 'r:id', relId);
  // References must precede pgSz/pgMar in sectPr.
  insertBefore(sectPr, ref, elementChildren(sectPr)[0]);
}

// ── replaceAll ───────────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find & replace across every paragraph in the body (including table cells).
 *
 * The rewrite happens on the `w:t` text nodes themselves, so every run keeps
 * its own original `w:rPr` element — nothing is rebuilt from our wire model.
 * A hit spanning several runs is written into the FIRST run it touches and
 * erased from the rest, which is what Word does too.
 */
function replaceAllInBody(doc: XDoc, body: XEl, op: Extract<WordOp, { op: 'replaceAll' }>): number {
  const flags = op.matchCase ? 'g' : 'gi';
  const pattern = op.whole ? `(?<![\\p{L}\\p{N}_])${escapeRegExp(op.find)}(?![\\p{L}\\p{N}_])` : escapeRegExp(op.find);
  let re: RegExp;
  try {
    re = new RegExp(pattern, `${flags}u`);
  } catch {
    re = new RegExp(escapeRegExp(op.find), flags);
  }

  let count = 0;
  const paras: XEl[] = [];
  const collect = (el: XEl) => {
    for (const c of elementChildren(el)) {
      const n = local(c);
      if (n === 'p') paras.push(c);
      else if (n === 'tbl' || n === 'tr' || n === 'tc') collect(c);
    }
  };
  collect(body);

  for (const p of paras) {
    if (lockReason(p)) continue; // never rewrite fields/links/images
    const pieces = textPieces(p);
    const text = pieces.map((piece) => piece.text).join('');
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;

    // Collect hits first — rewriting as we scan would invalidate the offsets.
    const hits: { start: number; end: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; } // zero-width guard
      hits.push({ start: m.index, end: m.index + m[0].length });
    }
    if (hits.length === 0) continue;

    // Per text node, the slices it keeps plus any replacement it absorbs.
    const next = pieces.map((piece) => piece.text);
    for (const hit of [...hits].reverse()) {
      for (let k = pieces.length - 1; k >= 0; k--) {
        const piece = pieces[k];
        const from = Math.max(hit.start, piece.start);
        const to = Math.min(hit.end, piece.start + piece.text.length);
        if (to <= from) continue;
        const localFrom = from - piece.start;
        const localTo = to - piece.start;
        // The first node the hit touches receives the replacement text; the
        // rest just lose their slice of the match.
        const isFirst = hit.start >= piece.start;
        next[k] = next[k].slice(0, localFrom)
          + (isFirst ? op.replace : '')
          + next[k].slice(localTo);
      }
      count++;
    }
    pieces.forEach((piece, k) => {
      if (next[k] !== piece.text) setTextNode(doc, piece.node, next[k]);
    });
  }
  return count;
}

/** Length of a paragraph's plain text, counting br/tab as one character —
 *  the same offsets patchParaRunRange works in. */
function paraTextLength(p: XEl): number {
  let n = 0;
  for (const r of elementChildren(p)) {
    if (local(r) !== 'r') continue;
    for (const c of elementChildren(r)) {
      const name = local(c);
      if (name === 't') n += textOf(c).length;
      else if (name === 'br' || name === 'cr' || name === 'tab') n += 1;
    }
  }
  return n;
}

/** A `w:t` node of a paragraph plus its offset in the paragraph's plain text.
 *  `w:br`/`w:tab` contribute a character to the offsets but aren't editable. */
interface TextPiece { node: XEl; text: string; start: number }

function textPieces(p: XEl): TextPiece[] {
  const pieces: TextPiece[] = [];
  let pos = 0;
  for (const r of elementChildren(p)) {
    if (local(r) !== 'r') continue;
    for (const c of elementChildren(r)) {
      const n = local(c);
      if (n === 't') {
        const text = textOf(c);
        pieces.push({ node: c, text, start: pos });
        pos += text.length;
      } else if (n === 'br' || n === 'cr' || n === 'tab') {
        pos += 1;
      }
    }
  }
  return pieces;
}

/** Replace a `w:t`'s content, keeping xml:space so spacing survives. */
function setTextNode(doc: XDoc, node: XEl, text: string): void {
  for (const child of Array.from({ length: (node as unknown as { childNodes: { length: number } }).childNodes.length },
    (_, i) => (node as unknown as { childNodes: { item(j: number): unknown } }).childNodes.item(i))) {
    (node as unknown as { removeChild(n: unknown): void }).removeChild(child);
  }
  (node as unknown as { setAttribute(n: string, v: string): void }).setAttribute('xml:space', 'preserve');
  (node as unknown as { appendChild(n: unknown): void }).appendChild(doc.createTextNode(text));
}

// ── save ─────────────────────────────────────────────────────────────────────

function serialize(doc: XDoc, decl = ''): string {
  let xml = new XMLSerializer().serializeToString(doc as never);
  if (decl && !xml.startsWith('<?xml')) xml = decl + xml;
  return xml;
}

export interface SaveDocxInput {
  path: unknown;
  mtimeMs: unknown;
  ops: unknown;
}

export async function saveDocx(input: SaveDocxInput): Promise<WordSaveResult> {
  writeGate();
  const t = await resolveOfficeFile(input.path, ['.docx'], REFUSED);
  assertNotStale(t, input.mtimeMs);
  const ops = sanitizeOps(input.ops);
  if (ops.length === 0) throw new Error('Không có thay đổi nào để lưu.');

  const parsed = await readDocx(t.abs, await fs.readFile(t.abs));
  const { zip, doc, body, decl } = parsed;
  const numIds = new NumIdPool(await numberingContext(parsed));

  /** Live block list — kept in step with the DOM as ops insert and delete. */
  const blocks = collectBlockEls(body);
  /** Where a new block goes when appended at the end: before the sectPr. */
  const tailAnchor = () => findChild(body, 'sectPr');

  const paraAt = (i: number, what: string): XEl => {
    const node = blocks[i];
    if (!node || local(node) !== 'p') {
      throw new Error(`Không thể ${what} khối #${i + 1} (không phải đoạn văn — file đã đổi cấu trúc? Bấm "Tải lại").`);
    }
    return node;
  };
  const tableAt = (i: number): XEl => {
    const node = blocks[i];
    if (!node || local(node) !== 'tbl') {
      throw new Error(`Khối #${i + 1} không phải bảng (file đã đổi cấu trúc? Bấm "Tải lại").`);
    }
    return node;
  };
  const assertUnlocked = (p: XEl, i: number) => {
    const reason = lockReason(p);
    if (reason) {
      throw new Error(`Đoạn #${i + 1} chứa ${reason} — sửa nội dung sẽ phá hỏng phần đó nên bị từ chối.`);
    }
  };

  let replaced = 0;

  for (const op of ops) {
    switch (op.op) {
      case 'set': {
        const p = paraAt(op.i, 'sửa');
        assertUnlocked(p, op.i);
        setParaRuns(doc, p, op.runs);
        break;
      }
      case 'runFmt': {
        const p = paraAt(op.i, 'định dạng');
        assertUnlocked(p, op.i);
        patchParaRunRange(doc, p, op.from, op.to, op.f);
        break;
      }
      case 'paraFmt': {
        // Paragraph-level formatting is safe even on locked paragraphs.
        const p = paraAt(op.i, 'định dạng');
        patchParaProps(doc, p, op.f, numIds);
        break;
      }
      case 'insert': {
        const { el } = maker(doc);
        const p = el('p');
        const pPr = buildParaProps(doc, op.fmt, numIds);
        if (pPr) appendChild(p, pPr);
        if (op.runs.length > 0) setParaRuns(doc, p, op.runs);
        const ref = blocks[op.i];
        insertBefore(body, p, ref ?? tailAnchor());
        blocks.splice(op.i, 0, p);
        break;
      }
      case 'delete': {
        const node = blocks[op.i];
        if (!node) throw new Error(`Không có khối #${op.i + 1} để xóa.`);
        removeChild(body, node);
        blocks.splice(op.i, 1);
        break;
      }
      case 'move': {
        const node = blocks[op.i];
        if (!node) throw new Error(`Không có khối #${op.i + 1} để di chuyển.`);
        if (op.to === op.i) break;
        removeChild(body, node);
        blocks.splice(op.i, 1);
        // `to` is the destination index in the list AFTER the block has been
        // pulled out — the same convention the client's splice-out-then-in
        // uses, so "move down one" is `to = i + 1` on both sides.
        const target = Math.min(op.to, blocks.length);
        insertBefore(body, node, blocks[target] ?? tailAnchor());
        blocks.splice(target, 0, node);
        break;
      }
      case 'pageBreak': {
        const p = buildPageBreak(doc);
        const ref = blocks[op.i];
        insertBefore(body, p, ref ?? tailAnchor());
        blocks.splice(op.i, 0, p);
        break;
      }
      case 'tblInsert': {
        const tbl = buildTable(doc, op.rows, op.cols, op.header === 1);
        const ref = blocks[op.i];
        insertBefore(body, tbl, ref ?? tailAnchor());
        blocks.splice(op.i, 0, tbl);
        // ALWAYS follow a table with a paragraph — Word merges two adjacent
        // tables into one otherwise. This is unconditional so the block count
        // matches the client's op log exactly (it splices 2 blocks as well);
        // a conditional insert here would shift every later op by one.
        const { el } = maker(doc);
        const spacer = el('p');
        insertBefore(body, spacer, blocks[op.i + 1] ?? tailAnchor());
        blocks.splice(op.i + 1, 0, spacer);
        break;
      }
      case 'cellSet': {
        const tc = cellAt(tableAt(op.i), op.r, op.c);
        if (!tc) throw new Error(`Bảng #${op.i + 1} không có ô (${op.r + 1}, ${op.c + 1}).`);
        setCellRuns(doc, tc, op.runs);
        break;
      }
      case 'cellFmt': {
        const tc = cellAt(tableAt(op.i), op.r, op.c);
        if (!tc) throw new Error(`Bảng #${op.i + 1} không có ô (${op.r + 1}, ${op.c + 1}).`);
        patchCellProps(doc, tc, op.bg, op.va);
        for (const p of findChildren(tc, 'p')) {
          const len = paraTextLength(p);
          if (len > 0) patchParaRunRange(doc, p, 0, len, op.f);
        }
        break;
      }
      case 'tblRowInsert':
        insertTableRow(doc, tableAt(op.i), op.r, op.where);
        break;
      case 'tblRowDelete':
        deleteTableRow(tableAt(op.i), op.r);
        break;
      case 'tblColInsert':
        insertTableCol(doc, tableAt(op.i), op.c, op.where);
        break;
      case 'tblColDelete':
        deleteTableCol(tableAt(op.i), op.c);
        break;
      case 'tblBorder':
        setTableBorders(doc, tableAt(op.i), op.on === 1);
        break;
      case 'hfSet':
        await applyHeaderFooter(parsed, op.part, op.text, op.jc ?? 'c', op.pageNum === 1);
        break;
      case 'replaceAll':
        replaced += replaceAllInBody(doc, body, op);
        break;
    }
  }

  zip.file('word/document.xml', serialize(doc, decl));
  const numbering = numIds.pending;
  if (numbering) {
    zip.file('word/numbering.xml', serialize(numbering, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'));
    await registerNumberingPart(zip);
  }

  const outBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const backupPath = await atomicBackupWrite(t.abs, Buffer.from(outBuf));

  const tally = ops.reduce<Record<string, number>>((acc, o) => {
    acc[o.op] = (acc[o.op] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ');
  // eslint-disable-next-line no-console
  console.log(`WORD_AUDIT operation=SAVE path=${t.abs} ${summary} backup=${backupPath} ts=${new Date().toISOString()}`);

  const st = await fs.stat(t.abs);
  return {
    backupPath, sizeBytes: st.size, mtimeMs: st.mtimeMs,
    ...(replaced > 0 ? { replaced } : {}),
  };
}

/** Add numbering.xml's content type + relationship when we just created it. */
async function registerNumberingPart(zip: JSZip): Promise<void> {
  const NUM_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';
  const NUM_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';

  const ctEntry = zip.file('[Content_Types].xml');
  if (ctEntry) {
    const ctDoc = new DOMParser().parseFromString(await ctEntry.async('string'), 'text/xml');
    const root = ctDoc.documentElement as unknown as XEl;
    if (!elementChildren(root).some((e) => attr(e, 'PartName') === '/word/numbering.xml')) {
      const ov = ctDoc.createElementNS('http://schemas.openxmlformats.org/package/2006/content-types', 'Override') as unknown as XEl;
      const set = (n: string, v: string) => (ov as unknown as { setAttribute(a: string, b: string): void }).setAttribute(n, v);
      set('PartName', '/word/numbering.xml');
      set('ContentType', NUM_CT);
      appendChild(root, ov);
      zip.file('[Content_Types].xml', serialize(ctDoc));
    }
  }

  const relsPath = 'word/_rels/document.xml.rels';
  const relsEntry = zip.file(relsPath);
  const relsXml = relsEntry
    ? await relsEntry.async('string')
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';
  const relsDoc = new DOMParser().parseFromString(relsXml, 'text/xml');
  const root = relsDoc.documentElement as unknown as XEl;
  if (!elementChildren(root).some((e) => attr(e, 'Target') === 'numbering.xml')) {
    const rel = relsDoc.createElementNS('http://schemas.openxmlformats.org/package/2006/relationships', 'Relationship') as unknown as XEl;
    const set = (n: string, v: string) => (rel as unknown as { setAttribute(a: string, b: string): void }).setAttribute(n, v);
    set('Id', nextRelId(root));
    set('Type', NUM_REL);
    set('Target', 'numbering.xml');
    appendChild(root, rel);
    zip.file(relsPath, serialize(relsDoc));
  }
}

