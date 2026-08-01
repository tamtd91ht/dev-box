// Server-only engine for the Word editor (Office tab).
//
// A .docx is a zip; the body lives in word/document.xml as a sequence of
// block elements (<w:p> paragraphs, <w:tbl> tables). Like the Sheet editor,
// editing is READ-MODIFY-WRITE with an op log: the file is re-read fresh and
// the client's ops (set/insert/delete paragraph) are replayed on the XML DOM,
// so every untouched paragraph keeps its exact styling. Only the edited
// paragraph's runs are rebuilt (carrying over the FIRST run's formatting —
// mid-paragraph bold/italic within an edited paragraph is flattened).
//
// v1 scope guards:
//   - Tables are read-only blocks (shown with a preview).
//   - Paragraphs containing non-text payloads (images, fields, links, content
//     controls, math) are LOCKED for edit — replacing their runs would silently
//     destroy that content. Deleting a whole paragraph is always allowed.
//   - .doc (binary 97-2003) and .docm (macro) are refused.
// Same safety rails as Sheet: OFFICE gates, size cap, stale-mtime check,
// `.bak` backup + atomic rename, WORD_AUDIT log line.

import { promises as fs } from 'fs';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { WordBlock, WordOp, WordOpenResult, WordSaveResult } from './word';
import { OFFICE_ALLOW_WRITE } from './officeFlags';
import {
  MAX_FILE_BYTES,
  resolveOfficeFile,
  resolveNewOfficeFile,
  writeNewFile,
  assertNotStale,
  atomicBackupWrite,
} from './officeFiles';

export { OFFICE_ENABLED as WORD_ENABLED, OFFICE_ALLOW_WRITE as WORD_ALLOW_WRITE } from './officeFlags';
export { MAX_FILE_BYTES };

export const MAX_BLOCKS = 5000;

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

// xmldom's DOM types are structural — alias the bits we touch.
type XEl = ReturnType<DOMParser['parseFromString']>['documentElement'] & object;
type XDoc = ReturnType<DOMParser['parseFromString']>;

// ── DOM helpers ──────────────────────────────────────────────────────────────

function elementChildren(n: { childNodes: { length: number; item(i: number): unknown } }): XEl[] {
  const out: XEl[] = [];
  for (let i = 0; i < n.childNodes.length; i++) {
    const c = n.childNodes.item(i) as { nodeType?: number } | null;
    if (c && c.nodeType === 1) out.push(c as unknown as XEl);
  }
  return out;
}

/** Depth-first walk; visitor returning false skips that element's subtree. */
function walk(el: XEl, visit: (e: XEl) => boolean | void): void {
  for (const c of elementChildren(el as never)) {
    if (visit(c) !== false) walk(c, visit);
  }
}

const local = (e: XEl) => (e as unknown as { localName: string }).localName;

function findChild(el: XEl, name: string): XEl | undefined {
  return elementChildren(el as never).find((c) => local(c) === name);
}

// ── docx → wire ──────────────────────────────────────────────────────────────

/** Text of a paragraph: run text + <w:br>/<w:cr> → '\n', run <w:tab> → '\t'. */
function paraText(p: XEl): string {
  let text = '';
  walk(p, (e) => {
    const n = local(e);
    if (n === 'pPr') return false; // property bag — its w:tabs are NOT content
    if (n === 't') { text += (e as unknown as { textContent: string | null }).textContent ?? ''; return false; }
    if (n === 'br' || n === 'cr') { text += '\n'; return false; }
    if (n === 'tab') { text += '\t'; return false; }
    return undefined;
  });
  return text;
}

const LOCK_REASONS: Record<string, string> = {
  drawing: 'ảnh/hình vẽ',
  pict: 'ảnh/hình vẽ',
  object: 'đối tượng nhúng',
  hyperlink: 'liên kết',
  fldSimple: 'field tự động',
  fldChar: 'field tự động',
  sdt: 'content control',
  oMath: 'công thức toán',
  oMathPara: 'công thức toán',
  footnoteReference: 'footnote',
  endnoteReference: 'endnote',
};

function lockReason(p: XEl): string | undefined {
  let reason: string | undefined;
  walk(p, (e) => {
    if (reason) return false;
    const r = LOCK_REASONS[local(e)];
    if (r) { reason = r; return false; }
    return undefined;
  });
  return reason;
}

function blockOf(el: XEl): WordBlock {
  if (local(el) === 'tbl') {
    let preview = '';
    walk(el, (e) => {
      if (preview.length > 200) return false;
      if (local(e) === 't') { preview += ((e as unknown as { textContent: string | null }).textContent ?? '') + ' '; return false; }
      return undefined;
    });
    return { kind: 'tbl', text: preview.trim().slice(0, 200) };
  }
  const b: WordBlock = { kind: 'p', text: paraText(el) };
  const pPr = findChild(el, 'pPr');
  if (pPr) {
    const pStyle = findChild(pPr, 'pStyle');
    const style = pStyle && (pStyle as unknown as { getAttributeNS(ns: string, n: string): string | null }).getAttributeNS(W, 'val');
    if (style) b.style = style;
    if (findChild(pPr, 'numPr')) b.bullet = true;
  }
  const reason = lockReason(el);
  if (reason) { b.locked = true; b.lockReason = reason; }
  return b;
}

/** Block-level body children, in document order (w:p and w:tbl only). */
function collectBlocks(body: XEl): XEl[] {
  return elementChildren(body as never).filter((e) => {
    const n = local(e);
    return n === 'p' || n === 'tbl';
  });
}

interface ParsedDocx {
  zip: JSZip;
  doc: XDoc;
  body: XEl;
  /** Original <?xml …?> declaration, re-prepended on serialize. */
  decl: string;
}

async function readDocx(abs: string): Promise<ParsedDocx> {
  const zip = await JSZip.loadAsync(await fs.readFile(abs));
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('File không phải .docx hợp lệ (thiếu word/document.xml).');
  const xml = await entry.async('string');
  let doc: XDoc;
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml');
  } catch (e) {
    throw new Error(`Không parse được document.xml: ${(e as Error).message}`);
  }
  const root = doc.documentElement as unknown as XEl;
  const body = findChild(root, 'body');
  if (!body) throw new Error('document.xml không có <w:body>.');
  const decl = /^<\?xml[^>]*\?>\s*/.exec(xml)?.[0] ?? '';
  return { zip, doc, body, decl };
}

// ── open ─────────────────────────────────────────────────────────────────────

const REFUSED = {
  '.doc': 'Định dạng Word 97–2003 (.doc) không hỗ trợ — mở bằng Word rồi Save As .docx trước.',
  '.docm': '.docm (file có macro) không được hỗ trợ — lưu lại sẽ mất VBA. Hãy Save As .docx trước.',
};

export async function openDocx(rawPath: unknown): Promise<WordOpenResult> {
  const t = await resolveOfficeFile(rawPath, ['.docx'], REFUSED);
  const { body } = await readDocx(t.abs);
  const els = collectBlocks(body);
  const blocks = els.slice(0, MAX_BLOCKS).map(blockOf);
  return {
    path: t.abs,
    sizeBytes: t.sizeBytes,
    mtimeMs: t.mtimeMs,
    blocks,
    truncated: els.length > MAX_BLOCKS,
  };
}

// ── create ───────────────────────────────────────────────────────────────────

// Minimal-but-valid .docx skeleton: the 3 required parts, one empty paragraph,
// A4 page setup. Word/LibreOffice open it; our own open/save round-trips it.
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const NEW_DOCX_PARTS: Record<string, string> = {
  '[Content_Types].xml': `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  '_rels/.rels': `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/document.xml': `${XML_DECL}<w:document xmlns:w="${W}"><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
};

export interface CreateDocxInput {
  dir: unknown;
  name: unknown;
}

/** Create a NEW blank .docx (one empty paragraph), then open it. Never
 *  overwrites — an existing file refuses the create. Gated by
 *  OFFICE_ALLOW_WRITE like every other write in the tab. */
export async function createDocx(input: CreateDocxInput): Promise<WordOpenResult> {
  if (!OFFICE_ALLOW_WRITE) {
    throw new Error('Ghi file đang tắt cho toàn tool. Set OFFICE_ALLOW_WRITE=true trong .env.local (local dev only).');
  }
  const { abs } = await resolveNewOfficeFile(input.dir, input.name, ['.docx']);

  const zip = new JSZip();
  for (const [name, xml] of Object.entries(NEW_DOCX_PARTS)) zip.file(name, xml);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  await writeNewFile(abs, Buffer.from(buf));

  // eslint-disable-next-line no-console
  console.log(`WORD_AUDIT operation=CREATE path=${abs} ts=${new Date().toISOString()}`);
  return openDocx(abs);
}

// ── save ─────────────────────────────────────────────────────────────────────

function sanitizeOps(raw: unknown): WordOp[] {
  if (!Array.isArray(raw)) throw new Error('ops phải là mảng.');
  return raw.map((o): WordOp => {
    const op = (o ?? {}) as Record<string, unknown>;
    const i = Number(op.i);
    if (!Number.isInteger(i) || i < 0 || i > 500_000) throw new Error(`op có chỉ số không hợp lệ: ${op.i}`);
    if (op.op === 'set') return { op: 'set', i, text: String(op.text ?? '') };
    if (op.op === 'insert') return { op: 'insert', i, text: String(op.text ?? '') };
    if (op.op === 'delete') return { op: 'delete', i };
    throw new Error(`op không hợp lệ: ${String(op.op)}`);
  });
}

/** Rebuild a paragraph's content as ONE run (keeping the first run's rPr),
 *  translating '\n' → <w:br/> and '\t' → <w:tab/>. */
function setParaText(doc: XDoc, p: XEl, text: string): void {
  let firstRun: XEl | undefined;
  walk(p, (e) => {
    if (firstRun) return false;
    if (local(e) === 'pPr') return false;
    if (local(e) === 'r') { firstRun = e; return false; }
    return undefined;
  });
  const rPr = firstRun && findChild(firstRun, 'rPr');
  const rPrClone = rPr && (rPr as unknown as { cloneNode(deep: boolean): unknown }).cloneNode(true);

  for (const c of elementChildren(p as never)) {
    if (local(c) !== 'pPr') (p as unknown as { removeChild(n: unknown): void }).removeChild(c);
  }
  if (text === '') return; // empty paragraph

  const el = (name: string) => doc.createElementNS(W, `w:${name}`) as unknown as XEl;
  const run = el('r') as unknown as { appendChild(n: unknown): void };
  if (rPrClone) run.appendChild(rPrClone);
  const lines = text.split('\n');
  lines.forEach((line, li) => {
    if (li > 0) run.appendChild(el('br'));
    const segs = line.split('\t');
    segs.forEach((seg, si) => {
      if (si > 0) run.appendChild(el('tab'));
      if (seg !== '') {
        const tEl = el('t') as unknown as { setAttribute(n: string, v: string): void; appendChild(n: unknown): void };
        tEl.setAttribute('xml:space', 'preserve');
        tEl.appendChild(doc.createTextNode(seg));
        run.appendChild(tEl);
      }
    });
  });
  (p as unknown as { appendChild(n: unknown): void }).appendChild(run);
}

export interface SaveDocxInput {
  path: unknown;
  mtimeMs: unknown;
  ops: unknown;
}

export async function saveDocx(input: SaveDocxInput): Promise<WordSaveResult> {
  if (!OFFICE_ALLOW_WRITE) {
    throw new Error('Ghi file đang tắt cho toàn tool. Set OFFICE_ALLOW_WRITE=true trong .env.local (local dev only).');
  }
  const t = await resolveOfficeFile(input.path, ['.docx'], REFUSED);
  assertNotStale(t, input.mtimeMs);
  const ops = sanitizeOps(input.ops);
  if (ops.length === 0) throw new Error('Không có thay đổi nào để lưu.');

  const { zip, doc, body, decl } = await readDocx(t.abs);
  const blocks = collectBlocks(body);
  const bodyEl = body as unknown as { insertBefore(n: unknown, ref: unknown): void; appendChild(n: unknown): void; removeChild(n: unknown): void };

  for (const op of ops) {
    if (op.op === 'set') {
      const node = blocks[op.i];
      if (!node || local(node) !== 'p') throw new Error(`Không thể sửa block #${op.i + 1} (không phải đoạn văn — file đã đổi cấu trúc?).`);
      const reason = lockReason(node);
      if (reason) throw new Error(`Đoạn #${op.i + 1} chứa ${reason} — sửa nội dung sẽ phá hỏng phần đó nên bị từ chối.`);
      setParaText(doc, node, op.text);
    } else if (op.op === 'insert') {
      const p = doc.createElementNS(W, 'w:p') as unknown as XEl;
      if (op.text) setParaText(doc, p, op.text);
      const ref = blocks[op.i];
      if (ref) {
        bodyEl.insertBefore(p, ref);
      } else {
        // Append at the end — but ALWAYS before the trailing <w:sectPr> (page setup).
        const sectPr = findChild(body, 'sectPr');
        if (sectPr) bodyEl.insertBefore(p, sectPr); else bodyEl.appendChild(p);
      }
      blocks.splice(op.i, 0, p);
    } else {
      const node = blocks[op.i];
      if (!node || local(node) !== 'p') throw new Error(`Không thể xóa block #${op.i + 1} (chỉ xóa được đoạn văn, không xóa bảng).`);
      bodyEl.removeChild(node);
      blocks.splice(op.i, 1);
    }
  }

  let xml = new XMLSerializer().serializeToString(doc as never);
  if (decl && !xml.startsWith('<?xml')) xml = decl + xml;
  zip.file('word/document.xml', xml);
  const outBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });

  const backupPath = await atomicBackupWrite(t.abs, Buffer.from(outBuf));

  const set = ops.filter((o) => o.op === 'set').length;
  const ins = ops.filter((o) => o.op === 'insert').length;
  const del = ops.filter((o) => o.op === 'delete').length;
  // eslint-disable-next-line no-console
  console.log(`WORD_AUDIT operation=SAVE path=${t.abs} set=${set} ins=${ins} del=${del} backup=${backupPath} ts=${new Date().toISOString()}`);

  const st = await fs.stat(t.abs);
  return { backupPath, sizeBytes: st.size, mtimeMs: st.mtimeMs };
}
