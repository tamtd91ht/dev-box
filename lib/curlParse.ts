// Parser một lệnh `curl` → request có cấu trúc, cho tab API (dán curl kiểu
// Postman). Browser-safe, không phụ thuộc gì. Hỗ trợ các cờ hay gặp:
//   -X/--request, -H/--header, -d/--data/--data-raw/--data-binary/
//   --data-urlencode, -F/--form, -u/--user, --url, -G/--get, và URL trần.
// Bỏ qua các cờ không ảnh hưởng nội dung request (-s, -k, -L, --compressed…).

export interface ParsedRequest {
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  body: string;
  /** 'none' | 'raw' | 'form' — form = application/x-www-form-urlencoded/multipart. */
  bodyType: 'none' | 'raw' | 'form';
}

/**
 * Tách một dòng lệnh shell thành các token, hiểu '…' "…" và \ nối dòng.
 *
 * Vòng lặp trong CHỈ dừng ở khoảng trắng khi đang Ở NGOÀI dấu nháy — body JSON
 * gần như luôn có dấu cách và thường có cả xuống dòng, cắt giữa chừng là mất
 * sạch phần sau. Trạng thái `quote` giữ việc đó cho đúng.
 */
function tokenize(input: string): string[] {
  // Bỏ nối dòng bằng backslash + xuống dòng (curl copy nhiều dòng).
  const s = input.replace(/\\\r?\n/g, ' ').trim();
  const tokens: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    let tok = '';
    let quote: "'" | '"' | null = null;
    while (i < s.length) {
      const ch = s[i];
      if (quote === null && /\s/.test(ch)) break;

      if (quote === null && (ch === "'" || ch === '"')) {
        quote = ch as "'" | '"';
        i++;
      } else if (quote === "'" && ch === "'") {
        quote = null;
        i++;
      } else if (quote === '"' && ch === '"') {
        quote = null;
        i++;
      } else if (quote === '"' && ch === '\\' && i + 1 < s.length) {
        // Trong nháy kép, backslash thoát ký tự kế tiếp.
        tok += s[i + 1]; i += 2;
      } else if (quote === null && ch === '\\' && i + 1 < s.length) {
        tok += s[i + 1]; i += 2;
      } else {
        tok += ch; i++;
      }
    }
    tokens.push(tok);
  }
  return tokens;
}

const flagNeedsValue = new Set([
  '-X', '--request', '-H', '--header', '-d', '--data', '--data-raw',
  '--data-binary', '--data-urlencode', '-F', '--form', '-u', '--user',
  '--url', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie',
]);

export function parseCurl(raw: string): ParsedRequest {
  const tokens = tokenize(raw.trim());
  const out: ParsedRequest = { method: '', url: '', headers: [], body: '', bodyType: 'none' };
  const dataParts: string[] = [];
  let forceGet = false;

  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i];
    if (t === 'curl') continue;

    // Cờ dạng --header=value cũng chấp nhận.
    let inlineVal: string | undefined;
    const eq = t.indexOf('=');
    if (t.startsWith('--') && eq > 0 && flagNeedsValue.has(t.slice(0, eq))) {
      inlineVal = t.slice(eq + 1);
      t = t.slice(0, eq);
    }
    const val = () => inlineVal ?? tokens[++i] ?? '';

    switch (t) {
      case '-X': case '--request': out.method = val().toUpperCase(); break;
      case '-H': case '--header': {
        const h = val();
        const idx = h.indexOf(':');
        if (idx > 0) out.headers.push({ key: h.slice(0, idx).trim(), value: h.slice(idx + 1).trim() });
        break;
      }
      case '-d': case '--data': case '--data-raw': case '--data-binary':
        dataParts.push(val()); out.bodyType = 'raw'; break;
      case '--data-urlencode':
        dataParts.push(val()); out.bodyType = 'form'; break;
      case '-F': case '--form':
        dataParts.push(val()); out.bodyType = 'form'; break;
      case '-u': case '--user':
        out.headers.push({ key: 'Authorization', value: 'Basic ' + toB64(val()) }); break;
      case '-A': case '--user-agent': out.headers.push({ key: 'User-Agent', value: val() }); break;
      case '-e': case '--referer': out.headers.push({ key: 'Referer', value: val() }); break;
      case '-b': case '--cookie': out.headers.push({ key: 'Cookie', value: val() }); break;
      case '--url': out.url = val(); break;
      case '-G': case '--get': forceGet = true; break;
      // Cờ không mang nội dung — nuốt (kèm value nếu cần) rồi bỏ.
      case '-s': case '--silent': case '-k': case '--insecure': case '-L':
      case '--location': case '--compressed': case '-i': case '--include':
      case '-v': case '--verbose': case '-f': case '--fail': break;
      default:
        // URL trần (không phải cờ).
        if (!t.startsWith('-') && !out.url) out.url = t;
        // Cờ lạ có value: nếu token kế không phải cờ, nuốt luôn cho an toàn.
        else if (t.startsWith('-') && tokens[i + 1] && !tokens[i + 1].startsWith('-')) i++;
        break;
    }
  }

  if (dataParts.length) {
    out.body = dataParts.join('&');
    if (!out.method) out.method = forceGet ? 'GET' : 'POST';
  }
  if (!out.method) out.method = 'GET';

  // -G: data thành query string.
  if (forceGet && out.body) {
    out.url += (out.url.includes('?') ? '&' : '?') + out.body;
    out.body = ''; out.bodyType = 'none';
  }

  return out;
}

/**
 * Chuỗi này có phải một lệnh curl không?
 *
 * Dùng khi người dùng DÁN vào ô URL: dán curl thì tự tách thành request, dán
 * URL thường thì cứ để nguyên. Nhận diện phải CHẶT — đoán nhầm một URL thành
 * curl sẽ xoá sạch header/body người ta vừa gõ, khó chịu hơn nhiều so với việc
 * bắt bấm thêm một nút. Nên chỉ chấp nhận khi chuỗi MỞ ĐẦU bằng đúng chữ
 * `curl` + khoảng trắng (cho phép xuống dòng, và tiền tố `$ `/`# ` hay dính
 * theo khi copy từ terminal hoặc tài liệu).
 */
export function looksLikeCurl(raw: string): boolean {
  return /^\s*(?:[$#]\s+)?curl\s/i.test(raw);
}

/** Bọc nháy đơn kiểu shell: bên trong nháy đơn mọi thứ đều là nghĩa đen, riêng
 *  chính dấu nháy đơn phải thoát ra ngoài rồi nối lại ('\'' là mẹo chuẩn). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface CurlBuildInput {
  method: string;
  url: string;
  headers: { key: string; value: string; on?: boolean }[];
  body: string;
  bodyType: 'none' | 'raw' | 'form';
}

/**
 * Request đang điền → một lệnh `curl` dán vào terminal là chạy được.
 *
 * Xuống dòng bằng ` \` + newline` cho dễ đọc khi gửi cho người khác — đó là
 * mục đích chính của nút này (đưa cho đối tác), nên ưu tiên đọc được hơn ngắn.
 *
 * `-X` chỉ ghi khi KHÁC GET, vì curl mặc định GET; và khi có body thì method
 * vẫn phải ghi rõ (có `-d` là curl tự chuyển POST, nhưng PUT/PATCH thì không).
 * Header tắt (`on === false`) bị bỏ qua — đúng như lúc bấm Send.
 */
export function buildCurl(req: CurlBuildInput, opts: { multiline?: boolean } = {}): string {
  const nl = opts.multiline === false ? ' ' : ' \\\n  ';
  const parts: string[] = ['curl'];

  const method = (req.method || 'GET').toUpperCase();
  const hasBody = req.bodyType !== 'none' && !!req.body;
  if (method !== 'GET') parts.push(`-X ${method}`);

  parts.push(shellQuote(req.url));

  for (const h of req.headers) {
    if (!h.key.trim() || h.on === false) continue;
    parts.push(`-H ${shellQuote(`${h.key.trim()}: ${h.value}`)}`);
  }

  if (hasBody) {
    // --data-raw chứ không phải -d: -d nuốt ký tự xuống dòng và diễn giải @file,
    // nên JSON nhiều dòng hay body bắt đầu bằng @ sẽ sai âm thầm.
    parts.push(`--data-raw ${shellQuote(req.body)}`);
  }

  return parts.join(nl);
}

function toB64(s: string): string {
  try {
    if (typeof btoa === 'function') return btoa(s);
  } catch { /* fall through */ }
  // Node fallback (parser cũng chạy được server-side nếu cần).
  return Buffer.from(s, 'utf8').toString('base64');
}

/** Thay biến {{name}} bằng giá trị từ env. Giữ nguyên nếu không có biến. */
export function resolveVars(text: string, env: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, name) => (name in env ? env[name] : m));
}
