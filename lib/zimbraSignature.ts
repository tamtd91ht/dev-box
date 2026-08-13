// Kéo CHỮ KÝ đã cấu hình sẵn trên webmail Zimbra về DevBox.
//
// VÌ SAO PHẢI CÓ FILE NÀY: chữ ký KHÔNG nằm trong mail và KHÔNG đi qua
// IMAP/SMTP — nó là thiết lập của tài khoản, chỉ đọc được bằng API riêng của
// Zimbra (SOAP tại /service/soap). Vậy nên dù DevBox đã nói IMAP/SMTP với hòm
// thư, nó vẫn không thể biết bạn đã ký tên gì trên webmail.
//
// LUỒNG: AuthRequest (lấy authToken bằng chính user/pass đã lưu ở tab Mail) →
// GetSignaturesRequest → danh sách chữ ký. Hai request, không lưu token lại:
// đồng bộ là việc thỉnh thoảng mới làm, giữ token chỉ thêm chỗ rò rỉ.
//
// GIỚI HẠN ĐÃ BIẾT:
//   · Chỉ chạy với hòm thư đăng nhập bằng MẬT KHẨU. Hòm thư OAuth (Gmail/
//     Workspace) không dùng Zimbra nên không có gì để kéo — Gmail cũng không
//     cho đọc chữ ký qua IMAP.
//   · Server phải là Zimbra và cho phép SOAP từ ngoài. Không phải Zimbra thì
//     request đầu tiên trả về HTML/404, ta báo lỗi rõ chứ không đoán mò.

import type { MailAccount } from './mailAccounts';

/** Một chữ ký lấy về từ Zimbra. */
export interface ZimbraSignature {
  name: string;
  /** Nội dung HTML (Zimbra lưu cả bản text; ta ưu tiên HTML). */
  html: string;
  /** Chữ ký này có phải bản text thuần không (server chỉ có text/plain). */
  plainOnly: boolean;
}

/** Gốc webmail suy ra từ IMAP host — Zimbra thường dùng chung host. */
function soapRoot(account: MailAccount): string {
  const custom = account.calDavUrl?.trim();
  if (custom) return custom.replace(/\/+$/, '');
  const host = account.imap.host.replace(/^imap\./i, '');
  return `https://${host}`;
}

async function soap(url: string, body: string): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/soap+xml; charset=utf-8', 'user-agent': 'VHS-DevBox signature' },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  // Không phải Zimbra (hoặc SOAP bị chặn) thì thường là trang HTML đăng nhập.
  if (!/^\s*<(\?xml|soap:)/i.test(text)) {
    throw new Error(
      `${new URL(url).host} không trả lời SOAP của Zimbra (HTTP ${res.status}). `
      + 'Hòm thư này có thể không chạy Zimbra, hoặc webmail nằm ở địa chỉ khác — '
      + 'khai địa chỉ webmail ở nút ⚙ mục Lịch rồi thử lại.',
    );
  }
  if (res.status >= 400) {
    // Zimbra nhét lý do vào <soap:Text>; lấy ra cho người dùng đọc được.
    const reason = /<soap:Text>([\s\S]*?)<\/soap:Text>/i.exec(text)?.[1]?.trim();
    throw new Error(reason || `Zimbra trả lỗi HTTP ${res.status}.`);
  }
  return text;
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Đăng nhập SOAP, trả về authToken. */
async function authToken(account: MailAccount, url: string): Promise<string> {
  const body =
    `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <AuthRequest xmlns="urn:zimbraAccount">
      <account by="name">${xmlEscape(account.user || account.email)}</account>
      <password>${xmlEscape(account.pass)}</password>
    </AuthRequest>
  </soap:Body>
</soap:Envelope>`;
  const text = await soap(url, body);
  const token = /<authToken>([\s\S]*?)<\/authToken>/i.exec(text)?.[1]?.trim();
  if (!token) {
    throw new Error('Zimbra không cấp authToken — kiểm tra lại tài khoản/mật khẩu hòm thư.');
  }
  return token;
}

/** Gỡ CDATA + giải mã entity cho phần nội dung chữ ký. */
function decodeContent(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  if (cdata) return cdata[1];
  return raw
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&'); // & giải mã CUỐI, không thì &amp;lt; ra sai
}

/**
 * Lấy danh sách chữ ký đã cấu hình trên webmail.
 *
 * Zimbra trả mỗi chữ ký dưới dạng
 *   <signature name="..." id="..."><content type="text/html">…</content></signature>
 * và có thể kèm CẢ text/plain lẫn text/html cho cùng một chữ ký. Ta ưu tiên
 * bản HTML vì DevBox gửi mail HTML; chỉ có text thì bọc lại thành HTML.
 */
export async function fetchZimbraSignatures(account: MailAccount): Promise<ZimbraSignature[]> {
  if (account.auth === 'oauth') {
    throw new Error(
      'Hòm thư này đăng nhập bằng Google (OAuth), không phải Zimbra — '
      + 'Gmail không cho đọc chữ ký qua IMAP nên phải chép tay.',
    );
  }
  if (!account.pass) throw new Error('Hòm thư chưa có mật khẩu để đăng nhập Zimbra.');

  const url = `${soapRoot(account)}/service/soap`;
  const token = await authToken(account, url);

  const body =
    `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Header>
    <context xmlns="urn:zimbra"><authToken>${xmlEscape(token)}</authToken></context>
  </soap:Header>
  <soap:Body><GetSignaturesRequest xmlns="urn:zimbraAccount"/></soap:Body>
</soap:Envelope>`;
  const text = await soap(url, body);

  const out: ZimbraSignature[] = [];
  const sigRe = /<signature\b([^>]*)>([\s\S]*?)<\/signature>/gi;
  for (let m = sigRe.exec(text); m; m = sigRe.exec(text)) {
    const name = /name="([^"]*)"/i.exec(m[1])?.[1] ?? '(không tên)';
    const inner = m[2];

    // Trong một <signature> có thể có nhiều <content type="...">.
    let html = '';
    let plain = '';
    const cRe = /<content\b([^>]*)>([\s\S]*?)<\/content>/gi;
    for (let c = cRe.exec(inner); c; c = cRe.exec(inner)) {
      const type = (/type="([^"]*)"/i.exec(c[1])?.[1] ?? '').toLowerCase();
      const value = decodeContent(c[2]);
      if (type.includes('html')) html = value;
      else plain = value;
    }

    if (!html && !plain) continue;
    out.push({
      name,
      // Chỉ có text thuần → bọc thành HTML giữ xuống dòng, vì DevBox soạn HTML.
      html: html || `<div style="white-space:pre-wrap">${
        plain.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      }</div>`,
      plainOnly: !html,
    });
  }

  if (out.length === 0) {
    throw new Error('Không thấy chữ ký nào trên webmail của hòm thư này.');
  }
  return out;
}
