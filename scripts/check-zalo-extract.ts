// scripts/check-zalo-extract.ts — kiểm extractMessages() bóc đúng mọi kho tin.
//
// VÌ SAO CÓ FILE NÀY: mọi lỗi ở đây biểu hiện thành ĐÚNG MỘT triệu chứng — "tin
// không hiện" — dù nguyên nhân là bóc sai lớp bọc, đọc thiếu kho, hay xếp nhầm
// nhóm/1-1. Nhìn từ UI thì ba thứ đó giống hệt nhau, và phải có tài khoản Zalo
// thật + người thật nhắn mới tái hiện được.
//
// Các ca dưới đây dựng theo ĐÚNG hình dạng payload quan sát được trên cụm thật
// (configs/zaloapi-trace.json, probeShape của từng cmd):
//   cmd 501 → data.msgs                    tin 1-1 từ web
//   cmd 502 → data.msgs + data.groupMsgs   đồng bộ từ thiết bị khác (mobile)
//   cmd 521 → data.groupMsgs               tin nhóm
//   cmd 612 → data.reacts + reactGroups    thả cảm xúc
//   cmd 621 → data.data.…                  lồng HAI lớp bọc
//
//   npx tsx scripts/check-zalo-extract.ts

import { extractMessages } from '../lib/zaloapi/server/listener';

let failures = 0;
const ok = (m: string): void => console.log(`✓ ${m}`);
const fail = (m: string): void => {
  failures += 1;
  console.error(`✗ ${m}`);
};
const check = (cond: boolean, m: string): void => (cond ? ok(m) : fail(m));

const AT = 1_700_000_000_000;
const SELF = '5756364889292767791';

/** Lớp bọc {error_code,error_message,data} mà MỌI khung Zalo đều có. */
const wrap = (data: unknown): unknown => ({ error_code: 0, error_message: '', data });

/** Một tin 1-1 như payload thật. */
const msg = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  msgId: '1001', cliMsgId: '2001', uidFrom: '999', idTo: SELF,
  dName: 'Khách A', content: 'xin chào', ts: AT, ...o,
});

// ── 1. cmd 501 — tin 1-1 (đường đã chạy được từ trước, không được làm hỏng) ──
{
  const out = extractMessages(false, wrap({ msgs: [msg()], groupMsgs: [], pageMsgs: [] }), AT, SELF);
  check(out.length === 1, `501: rút được 1 tin (thực tế ${out.length})`);
  check(out[0]?.text === 'xin chào', '501: đúng nội dung');
  check(out[0]?.group === false, '501: xếp là 1-1');
  check(out[0]?.threadId === '999', '501: threadId là người gửi');
}

// ── 2. cmd 521 — TIN NHÓM. Từng bỏ lọt hoàn toàn: msgs rỗng, tin ở groupMsgs ──
{
  const out = extractMessages(false, wrap({
    lastActionId: 1, more: false,
    msgs: [],
    groupMsgs: [msg({ groupId: '777', content: 'chào cả nhóm' })],
    pageMsgs: [], clearUnreads: [], delivereds: [], seens: [], groupSeens: [],
  }), AT, SELF);
  check(out.length === 1, `521: rút được tin nhóm (thực tế ${out.length})`);
  check(out[0]?.group === true, '521: xếp là NHÓM');
  check(out[0]?.threadId === '777', '521: threadId là groupId');
}

// ── 3. groupMsgs KHÔNG mang groupId → vẫn phải là nhóm ──────────────────────
//
// Khung nhóm không phải lúc nào cũng có groupId; dựa mỗi field đó thì tin rơi
// thành 1-1 và đẻ ra một hội thoại rác tách khỏi luồng nhóm thật.
{
  const out = extractMessages(false, wrap({
    msgs: [], groupMsgs: [msg({ idTo: '888', content: 'không có groupId' })],
  }), AT, SELF);
  check(out[0]?.group === true, 'groupMsgs không có groupId vẫn xếp là NHÓM');
}

// ── 4. cmd 502 — đồng bộ từ THIẾT BỊ KHÁC (tin gõ trên Zalo mobile) ─────────
{
  const out = extractMessages(false, wrap({
    more: false,
    msgs: [msg({ uidFrom: '0', idTo: '555', content: 'gõ từ mobile' })],
    groupMsgs: [msg({ uidFrom: '0', groupId: '777', content: 'nhóm từ mobile' })],
    pageMsgs: [], clearUnreads: [], delivereds: [], seens: [], groupSeens: [], eesession: '',
  }), AT, SELF);
  check(out.length === 2, `502: rút cả hai kho (thực tế ${out.length})`);
  const one = out.find((x) => !x.group);
  const grp = out.find((x) => x.group);
  check(!!one && one.isSelf, '502: tin 1-1 từ mobile nhận ra là CỦA MÌNH (uidFrom "0")');
  check(one?.threadId === '555', '502: tin của mình khoá theo NGƯỜI NHẬN, không phải "0"');
  check(!!grp && grp.threadId === '777', '502: tin nhóm từ mobile về đúng nhóm');
}

// ── 5. cmd 612 — CẢM XÚC, kho riêng, rIcon/rType ở CẤP GỐC ─────────────────
{
  const out = extractMessages(false, wrap({
    lastActionId: 2, more: false, controls: [],
    reacts: [{
      msgId: '1001', uidFrom: '999', dName: 'Khách A', ts: AT,
      content: { rMsg: [{ gMsgID: '1001', cMsgID: '2001' }], rIcon: '/-heart', rType: 5 },
    }],
    reactGroups: [], queueStatus: {},
  }), AT, SELF);
  check(out.length === 1, `612: rút được cảm xúc (thực tế ${out.length})`);
  check(out[0]?.reaction?.rType === 5, '612: đúng rType (5 = tim)');
  check(out[0]?.reaction?.targetMsgId === '1001', '612: biết thả lên tin nào');
  check(out[0]?.reaction?.isSelf === false, '612: nhận ra là người KHÁC thả');
}

// ── 6. cmd 612 — cảm xúc dạng PHẲNG (rIcon/rType ngay trên object) ─────────
{
  const out = extractMessages(false, wrap({
    reacts: [{ msgId: '1001', uidFrom: '999', dName: 'Khách A', ts: AT, rIcon: '/-strong', rType: 3 }],
    reactGroups: [],
  }), AT, SELF);
  check(out.length === 1, `612 phẳng: rút được (thực tế ${out.length})`);
  check(out[0]?.reaction?.rType === 3, '612 phẳng: đúng rType (3 = like)');
}

// ── 7. reactGroups → cảm xúc trong NHÓM ────────────────────────────────────
{
  const out = extractMessages(false, wrap({
    reacts: [],
    reactGroups: [{
      msgId: '1001', uidFrom: '999', groupId: '777', dName: 'Khách A', ts: AT,
      content: { rMsg: [{ gMsgID: '1001' }], rIcon: '/-heart', rType: 5 },
    }],
  }), AT, SELF);
  check(out[0]?.group === true, 'reactGroups: xếp là NHÓM');
  check(out[0]?.reaction?.rType === 5, 'reactGroups: giữ đúng cảm xúc');
}

// ── 8. cmd 621 — LỒNG HAI lớp bọc ──────────────────────────────────────────
{
  const out = extractMessages(false, wrap(wrap({ msgs: [msg({ content: 'lồng hai lớp' })] })), AT, SELF);
  check(out.length === 1, `621: bóc hết lớp bọc lồng nhau (thực tế ${out.length})`);
  check(out[0]?.text === 'lồng hai lớp', '621: lấy đúng nội dung sau khi bóc');
}

// ── 9. Khung KHÔNG phải tin vẫn không được rút bừa ─────────────────────────
//
// Chiều ngược lại của mọi ca trên: nới lỏng để bắt thêm tin mà bắt luôn cả
// seen/typing thì màn chat đầy bong bóng rác.
{
  const seen = extractMessages(false, wrap({ actions: [{ act: 'seen', uid: '999' }] }), AT, SELF);
  check(seen.length === 0, 'cmd 602 (actions/seen) KHÔNG bị rút thành tin');

  const empty = extractMessages(false, wrap({ msgs: [], groupMsgs: [], seens: [{ uid: '999' }] }), AT, SELF);
  check(empty.length === 0, 'mọi kho rỗng → không rút gì');
}

// ── 10. Tin có `data` riêng không bị bóc nhầm ──────────────────────────────
//
// Vòng bóc chỉ đi tiếp khi tầng đó ĐÚNG là lớp bọc (có error_code). Không có
// điều kiện đó thì một tin mang field `data` của riêng nó sẽ bị ăn mất.
{
  const out = extractMessages(false, wrap({ msgs: [msg({ data: { foo: 1 } })] }), AT, SELF);
  check(out.length === 1, 'tin có field `data` riêng không bị bóc nhầm');
}

// ── 11. TRẢ LỜI — khối trích dẫn phải theo tin về ──────────────────────────
//
// Thiếu phần này thì tin người khác trả lời ta hiện ra như một câu rời khỏi
// ngữ cảnh: đọc "ok em làm rồi" mà không biết đang nói về việc gì.
{
  const out = extractMessages(false, wrap({
    msgs: [msg({
      content: JSON.stringify({
        title: 'ok em làm rồi',
        quote: { globalMsgId: '1001', ownerName: 'Sếp', qmsg: 'em check giúp cái deploy' },
      }),
    })],
  }), AT, SELF);
  check(out.length === 1, `quote: rút được tin (thực tế ${out.length})`);
  check(out[0]?.text === 'ok em làm rồi', 'quote: nội dung mới đúng');
  check(out[0]?.quote?.msgId === '1001', 'quote: giữ id tin gốc');
  check(out[0]?.quote?.text === 'em check giúp cái deploy', 'quote: giữ nội dung tin gốc');
  check(out[0]?.quote?.fromName === 'Sếp', 'quote: giữ tên người gửi tin gốc');
}

// ── 12. Khung cảm xúc KHÔNG bị đọc nhầm thành quote ────────────────────────
//
// Cảm xúc cũng dùng `content` cho payload riêng của nó; đọc bừa là mỗi lần ai
// thả tim lại sinh một khối trích dẫn rỗng.
{
  const out = extractMessages(false, wrap({
    reacts: [{
      msgId: '1001', uidFrom: '999', dName: 'Khách A', ts: AT,
      content: { rMsg: [{ gMsgID: '1001' }], rIcon: '/-heart', rType: 5 },
    }],
  }), AT, SELF);
  check(!out[0]?.quote, 'cảm xúc KHÔNG bị dựng thành khối trích dẫn');
}

// ── 13. Tin thường không có quote → không dựng khối rỗng ───────────────────
{
  const out = extractMessages(false, wrap({ msgs: [msg()] }), AT, SELF);
  check(!out[0]?.quote, 'tin thường không có khối trích dẫn thừa');
}

// ── Kết ────────────────────────────────────────────────────────────────────

if (failures) {
  console.error(`\ncheck:zalo THẤT BẠI — ${failures} ca sai.`);
  process.exit(1);
}
console.log('\ncheck:zalo OK — bóc đúng mọi kho tin đã quan sát được.');
