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

/** Tách một dòng lệnh shell thành các token, hiểu '…' "…" và \ nối dòng. */
function tokenize(input: string): string[] {
  // Bỏ nối dòng bằng backslash + xuống dòng (curl copy nhiều dòng).
  const s = input.replace(/\\\r?\n/g, ' ').trim();
  const tokens: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    let tok = '';
    while (i < s.length && !/\s/.test(s[i])) {
      const ch = s[i];
      if (ch === "'") {
        i++;
        while (i < s.length && s[i] !== "'") tok += s[i++];
        i++; // bỏ ' đóng
      } else if (ch === '"') {
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < s.length) { tok += s[i + 1]; i += 2; }
          else tok += s[i++];
        }
        i++; // bỏ " đóng
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
