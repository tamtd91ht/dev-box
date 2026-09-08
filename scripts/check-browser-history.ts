// scripts/check-browser-history.ts — kiểm store LỊCH SỬ truy nhập của tab
// Browser: chuẩn hoá URL, đếm số lần vào, và THỨ TỰ GỢI Ý.
//
// VÌ SAO CÓ FILE NÀY: gợi ý sai chỉ biểu hiện thành "gõ mà không ra trang mình
// hay vào" — nhìn từ UI thì y như chưa có lịch sử, và muốn tái hiện bằng tay
// thì phải bấm qua hàng chục trang thật rồi ngồi đoán vì sao dòng cần lại nằm
// dưới. Ba nhóm lỗi hay gặp, cả ba đều ẩn:
//   • urlKey gộp/không gộp sai → một trang thành nhiều dòng trùng, hoặc cả site
//     gộp thành một dòng (SPA đặt route trong hash).
//   • recordVisit ghi đè tiêu đề tốt bằng chuỗi rỗng lúc mới điều hướng.
//   • score xếp trang KHỚP SÁT xuống dưới một trang chỉ khớp giữa query string.
//
//   npx tsx scripts/check-browser-history.ts

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

// Store đọc đường dẫn LÚC IMPORT (const ở module scope) → phải đặt env TRƯỚC
// khi import, không thì nó ghi vào configs/browser-history.json thật.
const TMP = path.join(os.tmpdir(), `dbx-hist-check-${process.pid}.json`);
process.env.BROWSER_HISTORY_PATH = TMP;

let failures = 0;
const ok = (m: string): void => console.log(`✓ ${m}`);
const fail = (m: string): void => {
  failures += 1;
  console.error(`✗ ${m}`);
};
const check = (cond: boolean, m: string): void => (cond ? ok(m) : fail(m));

async function main(): Promise<void> {
  const {
    urlKey, recordVisit, recordTitle, suggest, listHistory,
    removeHistory, removeHistoryHost, clearHistory,
  } = await import('../lib/historyStore');

  await clearHistory();

  // ── urlKey ────────────────────────────────────────────────────────────────
  check(urlKey('https://a.vn/x/') === urlKey('https://a.vn/x'),
    'urlKey: "/x/" và "/x" là cùng một trang');
  check(urlKey('https://a.vn/x#top') === urlKey('https://a.vn/x'),
    'urlKey: bỏ #anchor trong cùng trang');
  check(urlKey('https://kib.vn/app#/discover') !== urlKey('https://kib.vn/app#/dash'),
    'urlKey: GIỮ hash dạng route (#/...) — SPA cũ đặt đường dẫn ở đó');
  check(urlKey('https://a.vn/s?q=1') !== urlKey('https://a.vn/s?q=2'),
    'urlKey: query khác nhau là hai trang khác nhau');

  // ── recordVisit ───────────────────────────────────────────────────────────
  check((await recordVisit('about:blank')) === null, 'recordVisit: bỏ qua URL không phải http(s)');
  check((await recordVisit('https://www.google.com/search?q=abc')) === null,
    'recordVisit: bỏ qua trang tìm Google do chính ô địa chỉ sinh ra');

  await recordVisit('https://git.vihat.vn/dash', 'GitLab · Dashboard');
  const again = await recordVisit('https://git.vihat.vn/dash/');   // '/' cuối
  check(again?.visitCount === 2, 'recordVisit: vào lại cùng trang → visitCount tăng, KHÔNG thêm dòng mới');
  check(again?.title === 'GitLab · Dashboard',
    'recordVisit: title rỗng KHÔNG xoá tiêu đề đã lưu (điều hướng bắn trước khi có <title>)');
  check((await listHistory()).length === 1, 'listHistory: một URL = một dòng');

  await recordTitle('https://git.vihat.vn/dash', 'GitLab · Bảng điều khiển');
  check((await listHistory())[0].title === 'GitLab · Bảng điều khiển',
    'recordTitle: cập nhật riêng tiêu đề sau khi trang load xong');

  // ── Thứ tự gợi ý ──────────────────────────────────────────────────────────
  // "kibana.noc.vn" khớp TỪ ĐẦU HOST; "logs.vn/?ref=kibana" chỉ khớp giữa query.
  await recordVisit('https://logs.vn/?ref=kibana', 'Logs');
  for (let i = 0; i < 6; i += 1) await recordVisit('https://logs.vn/?ref=kibana', 'Logs');
  await recordVisit('https://kibana.noc.vn/app', 'Kibana');

  const kib = await suggest('kib');
  check(kib.length === 2, 'suggest("kib"): thấy cả hai trang có chữ "kib"');
  check(kib[0]?.host === 'kibana.noc.vn',
    'suggest: khớp TỪ ĐẦU HOST đứng trên trang chỉ khớp giữa query string (dù trang kia vào nhiều lần hơn)');

  // Cùng kiểu khớp thì trang hay vào hơn phải đứng trên.
  await recordVisit('https://es-01.noc.vn/a', 'ES một');
  await recordVisit('https://es-02.noc.vn/a', 'ES hai');
  for (let i = 0; i < 9; i += 1) await recordVisit('https://es-02.noc.vn/a', 'ES hai');
  const es = await suggest('es-0');
  check(es[0]?.host === 'es-02.noc.vn', 'suggest: cùng kiểu khớp → trang vào nhiều lần hơn lên trước');

  check((await suggest('khong-co-gi-khop-ca')).length === 0, 'suggest: không khớp thì trả danh sách rỗng');

  const recent = await suggest('');
  check(recent.length > 0 && recent[0].url === 'https://es-02.noc.vn/a',
    'suggest(""): câu rỗng → các trang vào GẦN ĐÂY nhất (mở ô địa chỉ đã có sẵn để chọn)');

  check((await suggest('noc', 2)).length === 2, 'suggest: tôn trọng `limit`');

  // ── Xoá ───────────────────────────────────────────────────────────────────
  await removeHistory('https://logs.vn/?ref=kibana');
  check((await suggest('kib')).length === 1, 'removeHistory: bỏ đúng một địa chỉ');

  await removeHistoryHost('es-02.noc.vn');
  check((await suggest('es-0')).every((e) => e.host !== 'es-02.noc.vn'),
    'removeHistoryHost: bỏ cả site');

  await clearHistory();
  check((await listHistory()).length === 0, 'clearHistory: sạch');

  await fs.rm(TMP, { force: true });

  if (failures) {
    console.error(`\n${failures} kiểm tra KHÔNG đạt.`);
    process.exit(1);
  }
  console.log('\nTất cả kiểm tra đạt.');
}

void main().catch((e) => { console.error(e); process.exit(1); });
