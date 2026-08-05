// Server-only: LÕI CHUYỂN ĐỔI FILE cho tab Tools.
//
// Hai đường chuyển đổi, người dùng chọn:
//   · THƯ VIỆN — mammoth (docx→html), ExcelJS (xlsx→…), papaparse (csv),
//     js-yaml, JSON/XML. Nhanh, offline, xác định.
//   · AI — gọi `claude` CLI có sẵn trên máy (cùng cơ chế lib/reviewMr.ts, không
//     cần API key). Bắt buộc khi có TEMPLATE MẪU, và dùng được cho mọi cặp định
//     dạng mà thư viện không làm nổi.
//
// PDF là ca đặc biệt: repo không có thư viện ghi PDF. Đường thư viện dựng HTML
// rồi để RENDERER (Electron, webContents.printToPDF) in ra PDF — Next server là
// process riêng nên không tự gọi Electron được, y hệt ràng buộc của safeStorage
// (xem electron/main.cjs). Vì vậy job PDF dừng ở trạng thái 'need-render' và
// ConvertHost phía client hoàn tất nốt. Bản web thuần không có Electron →
// báo lỗi rõ ràng thay vì treo.

import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import yaml from 'js-yaml';

export const MAX_INPUT_BYTES = 20 * 1024 * 1024; // 20 MB — cùng cap officeFiles

// ── Định dạng ───────────────────────────────────────────────────────────────

/** Đuôi file NGUỒN đọc được. */
export const SOURCE_EXTS = [
  '.docx', '.xlsx', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.md', '.txt',
] as const;

/** Định dạng ĐÍCH chọn được. */
export type TargetFormat = 'pdf' | 'html' | 'md' | 'txt' | 'csv' | 'json' | 'yaml' | 'xlsx' | 'xml' | 'docx';

export const TARGET_EXT: Record<TargetFormat, string> = {
  pdf: '.pdf', html: '.html', md: '.md', txt: '.txt', csv: '.csv',
  json: '.json', yaml: '.yaml', xlsx: '.xlsx', xml: '.xml', docx: '.docx',
};

/**
 * Cặp (nguồn → đích) mà THƯ VIỆN làm được, không cần AI.
 * Ngoài bảng này thì bắt buộc dùng AI — UI đọc bảng này để bật/tắt lựa chọn.
 */
export const LIB_MATRIX: Record<string, TargetFormat[]> = {
  '.docx': ['html', 'md', 'txt', 'pdf'],
  '.xlsx': ['csv', 'json', 'html', 'pdf'],
  '.csv': ['json', 'yaml', 'xlsx', 'html', 'pdf'],
  '.json': ['yaml', 'csv', 'xlsx', 'txt', 'html', 'pdf'],
  '.yaml': ['json', 'txt', 'html', 'pdf'],
  '.yml': ['json', 'txt', 'html', 'pdf'],
  '.xml': ['txt', 'html', 'pdf'],
  '.html': ['txt', 'md', 'pdf'],
  '.htm': ['txt', 'md', 'pdf'],
  '.md': ['html', 'txt', 'pdf'],
  '.txt': ['html', 'md', 'pdf'],
};

export function libCanConvert(srcExt: string, target: TargetFormat): boolean {
  return (LIB_MATRIX[srcExt.toLowerCase()] ?? []).includes(target);
}

// ── Đọc nguồn về dạng trung gian ────────────────────────────────────────────

/** Nội dung nguồn đã chuẩn hóa: HTML để in PDF, text để ghi file text. */
interface SourceContent {
  /** HTML đầy đủ (đã bọc <head><style>) — dùng cho pdf/html. */
  html: string;
  /** CHỈ phần thân, không <head>/<style> — nguồn cho html→md.
   *  Tách riêng vì nếu md hóa cả trang thì CSS trong <style> lọt vào file .md. */
  bodyHtml: string;
  /** Text thuần — dùng cho txt/md/csv/json/yaml/xml. */
  text: string;
}

const PAGE_STYLE = `
  body { font-family: "Segoe UI", Roboto, Arial, sans-serif; font-size: 13px;
         line-height: 1.6; color: #111; margin: 24px; }
  table { border-collapse: collapse; margin: 8px 0; }
  td, th { border: 1px solid #bbb; padding: 4px 8px; vertical-align: top; }
  th { background: #f0f0f0; }
  pre { white-space: pre-wrap; word-wrap: break-word; font-family: Consolas, monospace; }
  img { max-width: 100%; }
`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function htmlDoc(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`;
}

/** Bảng 2 chiều → <table>. Dùng chung cho csv/xlsx/json-mảng. */
function rowsToHtml(rows: unknown[][]): string {
  const cell = (v: unknown) => esc(v === null || v === undefined ? '' : String(v));
  const [head, ...rest] = rows;
  if (!head) return '<p><i>(rỗng)</i></p>';
  return `<table><thead><tr>${head.map((h) => `<th>${cell(h)}</th>`).join('')}</tr></thead><tbody>${
    rest.map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join('')}</tr>`).join('')
  }</tbody></table>`;
}

/** Bỏ tag HTML → text thuần (đủ dùng cho html→txt, không dựng DOM). */
function stripTags(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, '') // cả <title> lẫn <style> trong đó
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** HTML → Markdown rất gọn (heading, bold/italic, link, list) — đủ cho docx→md. */
function htmlToMd(html: string): string {
  return html
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lv: string, t: string) => `\n${'#'.repeat(Number(lv))} ${stripTags(t)}\n`)
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, t: string) => `**${stripTags(t)}**`)
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, t: string) => `*${stripTags(t)}*`)
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, t: string) => `[${stripTags(t)}](${href})`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t: string) => `- ${stripTags(t)}\n`)
    .replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, t: string) => `\n${stripTags(t)}\n`)
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readSource(abs: string, ext: string): Promise<SourceContent> {
  const name = path.basename(abs);

  if (ext === '.docx') {
    const { value: html } = await mammoth.convertToHtml({ path: abs });
    return { html: htmlDoc(name, html), bodyHtml: html, text: stripTags(html) };
  }

  if (ext === '.xlsx') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(abs);
    const parts: string[] = [];
    const flat: unknown[][] = [];
    wb.eachSheet((ws) => {
      const rows: unknown[][] = [];
      ws.eachRow((row) => {
        const vals = (row.values as unknown[]).slice(1); // ExcelJS đánh số từ 1
        rows.push(vals.map((v) => (v && typeof v === 'object' && 'text' in v ? (v as { text: unknown }).text : v)));
      });
      parts.push(`<h2>${esc(ws.name)}</h2>${rowsToHtml(rows)}`);
      if (flat.length === 0) flat.push(...rows); // csv/json lấy sheet đầu
    });
    const body = parts.join('\n');
    return {
      html: htmlDoc(name, body),
      bodyHtml: body,
      text: Papa.unparse(flat.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c))))),
    };
  }

  const raw = await fs.readFile(abs, 'utf8');

  if (ext === '.csv') {
    const body = rowsToHtml(Papa.parse<string[]>(raw.trim(), { skipEmptyLines: true }).data);
    return { html: htmlDoc(name, body), bodyHtml: body, text: raw };
  }
  if (ext === '.html' || ext === '.htm') {
    return { html: raw, bodyHtml: raw, text: stripTags(raw) };
  }
  // .json/.yaml/.yml/.md/.xml/.txt — bọc <pre> giữ nguyên xuống dòng; trung
  // thực hơn việc tự chế một renderer markdown nửa vời.
  const pre = `<pre>${esc(raw)}</pre>`;
  return { html: htmlDoc(name, pre), bodyHtml: pre, text: raw };
}

// ── Chuyển sang định dạng đích (đường THƯ VIỆN) ─────────────────────────────

/** Mảng object đồng nhất → bảng 2 chiều (header = union các key). */
function objectsToRows(arr: Record<string, unknown>[]): unknown[][] {
  const keys: string[] = [];
  for (const o of arr) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
  return [keys, ...arr.map((o) => keys.map((k) => {
    const v = o[k];
    return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : v;
  }))];
}

/** Kết quả đường thư viện: file nhị phân/text đã sẵn, hoặc chờ renderer in PDF. */
export type LibResult =
  | { kind: 'buffer'; data: Buffer }
  | { kind: 'need-render'; html: string };

export async function convertWithLib(
  abs: string,
  ext: string,
  target: TargetFormat,
): Promise<LibResult> {
  if (!libCanConvert(ext, target)) {
    throw new Error(`Thư viện không chuyển được ${ext} → ${target}. Bật "Dùng AI" để thử.`);
  }
  const src = await readSource(abs, ext);

  // PDF: server không in được (Electron ở process khác) → trả HTML cho renderer.
  if (target === 'pdf') return { kind: 'need-render', html: src.html };

  if (target === 'html') return { kind: 'buffer', data: Buffer.from(src.html, 'utf8') };
  if (target === 'txt') return { kind: 'buffer', data: Buffer.from(src.text, 'utf8') };
  if (target === 'md') {
    // bodyHtml, KHÔNG phải src.html — md hóa cả trang thì <style> lọt vào .md.
    const md = ext === '.docx' || ext === '.html' || ext === '.htm' ? htmlToMd(src.bodyHtml) : src.text;
    return { kind: 'buffer', data: Buffer.from(md, 'utf8') };
  }

  // Các đích dữ liệu-có-cấu trúc: đi qua "bảng" hoặc "object".
  const raw = src.text;

  if (target === 'json') {
    if (ext === '.yaml' || ext === '.yml') {
      return { kind: 'buffer', data: Buffer.from(JSON.stringify(yaml.load(raw) ?? null, null, 2), 'utf8') };
    }
    // csv / xlsx → mảng object theo header
    const parsed = Papa.parse<Record<string, unknown>>(raw.trim(), { header: true, skipEmptyLines: true });
    return { kind: 'buffer', data: Buffer.from(JSON.stringify(parsed.data, null, 2), 'utf8') };
  }

  if (target === 'yaml') {
    const obj = ext === '.json'
      ? JSON.parse(raw)
      : Papa.parse<Record<string, unknown>>(raw.trim(), { header: true, skipEmptyLines: true }).data;
    return { kind: 'buffer', data: Buffer.from(yaml.dump(obj, { noRefs: true, lineWidth: 120 }), 'utf8') };
  }

  if (target === 'csv') {
    if (ext === '.json') {
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed) && parsed.every((x) => x && typeof x === 'object' && !Array.isArray(x))
        ? objectsToRows(parsed as Record<string, unknown>[])
        : Array.isArray(parsed) ? (parsed as unknown[][]) : [[JSON.stringify(parsed)]];
      return { kind: 'buffer', data: Buffer.from(Papa.unparse(rows), 'utf8') };
    }
    return { kind: 'buffer', data: Buffer.from(raw, 'utf8') }; // xlsx đã unparse ở readSource
  }

  if (target === 'xlsx') {
    const rows: unknown[][] = ext === '.json'
      ? (() => {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) && parsed.every((x) => x && typeof x === 'object' && !Array.isArray(x))
            ? objectsToRows(parsed as Record<string, unknown>[])
            : Array.isArray(parsed) ? (parsed as unknown[][]) : [[JSON.stringify(parsed)]];
        })()
      : (Papa.parse<string[]>(raw.trim(), { skipEmptyLines: true }).data as unknown[][]);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    rows.forEach((r) => ws.addRow(r as ExcelJS.CellValue[]));
    if (rows[0]) ws.getRow(1).font = { bold: true };
    return { kind: 'buffer', data: Buffer.from(await wb.xlsx.writeBuffer()) };
  }

  throw new Error(`Chưa hỗ trợ đích ${target} bằng thư viện.`);
}

// ── Đường AI (`claude` CLI) ─────────────────────────────────────────────────

const AI_TIMEOUT_MS = 15 * 60 * 1000;
const AI_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Nhờ `claude` CLI chuyển đổi. Chạy với cwd = THƯ MỤC ĐÍCH và
 * --permission-mode acceptEdits, nên nó chỉ ghi kết quả quanh chỗ mình lưu.
 *
 * Mọi đường dẫn đi vào qua argv (execFile, không shell) nên không có chuyện
 * chèn lệnh; nhưng nội dung prompt vẫn là dữ liệu người dùng nên câu lệnh mô tả
 * rõ ràng nhiệm vụ để AI không bị nội dung file lái đi.
 */
export function runAiConvert(opts: {
  srcAbs: string;
  outAbs: string;
  target: TargetFormat;
  templateAbs: string | null;
}): Promise<{ output: string; exitCode: number }> {
  const { srcAbs, outAbs, target, templateAbs } = opts;
  const cwd = path.dirname(outAbs);

  const lines = [
    `Chuyển đổi file sang định dạng ${target.toUpperCase()}.`,
    `File nguồn: ${srcAbs}`,
    `File kết quả PHẢI ghi ra đúng đường dẫn: ${outAbs}`,
  ];
  if (templateAbs) {
    lines.push(
      `File template mẫu: ${templateAbs}`,
      'Hãy đọc template để nắm bố cục, tiêu đề, thứ tự mục và cách trình bày,',
      'rồi trình bày lại nội dung của file nguồn THEO ĐÚNG bố cục của template đó.',
    );
  }
  lines.push(
    'Giữ nguyên toàn bộ dữ liệu và ý nghĩa của file nguồn — không bịa thêm, không lược bớt.',
    'Chỉ tạo đúng một file kết quả tại đường dẫn nêu trên, không sửa file nguồn.',
  );

  const prompt = lines.join('\n');

  // Dùng spawn (không phải execFile) để ĐÓNG HẲN stdin: ở chế độ -p, claude vẫn
  // ngóng stdin 3 giây rồi mới chạy ("no stdin data received in 3s"). execFile
  // không nhận tùy chọn stdio nên không tắt được chuyện đó.
  // Vẫn là argv array, không qua shell → không có đường chèn lệnh.
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', prompt, '--permission-mode', 'acceptEdits'], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let errOut = '';
    let capped = false;
    const take = (chunk: string, toErr: boolean) => {
      if (capped) return;
      if (out.length + errOut.length + chunk.length > AI_MAX_BUFFER) {
        capped = true;
        out += '\n[đã cắt bớt: output quá lớn]';
        return;
      }
      if (toErr) errOut += chunk; else out += chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => take(c, false));
    child.stderr.on('data', (c: string) => take(c, true));

    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, AI_TIMEOUT_MS);

    child.on('error', (e) => {
      clearTimeout(timer);
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('Không tìm thấy `claude` CLI trên PATH — cài Claude Code hoặc thêm vào PATH.'));
        return;
      }
      reject(e);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      let output = out;
      if (errOut) output += `\n---stderr---\n${errOut}`;
      if (killed) output += '\n\n[đã hủy: quá 15 phút]';
      resolve({ output, exitCode: killed ? 1 : (code ?? 1) });
    });
  });
}
