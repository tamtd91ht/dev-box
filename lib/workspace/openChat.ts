// Browser Workspace Framework — mở MỘT hội thoại theo tên trong guest đang chạy
// nền, để đọc (trợ lý AI: "phân tích nhóm A" khi người dùng đang ở menu khác,
// hoặc đang xem hội thoại khác trong cùng Zalo).
//
// Chỉ ĐỌC/CHUYỂN hội thoại — không gõ, không gửi. Dùng lại đúng đường tìm dòng
// của lib/workspace/send.ts (danh sách react-virtualized phải "hâm" bằng cuộn
// mới hiện dòng khi webview nằm ngoài màn hình), thêm:
//   · so tên KHÔNG dấu / không phân biệt hoa thường, rồi "chứa" — người dùng gõ
//     "nhóm dev" thì vẫn ra "Nhóm DEV - VHS"; khớp nhiều cái thì trả danh sách
//     để hỏi lại, không đoán.
//   · nhớ hội thoại đang mở (và tab Ưu tiên / Khác) TRƯỚC khi chuyển, để xong
//     việc mở lại đúng chỗ người dùng đang đứng (restore).
//   · không thấy ở tab lọc đang chọn (vd "Chưa đọc") thì thử "Tất cả" / tab khác.
//
// Mở hội thoại thì Zalo đánh dấu ĐÃ XEM — không tránh được, như người mở tay.

import { prelude } from './send';

export interface OpenChatResult {
  ok: boolean;
  error: string;
  /** Tên dòng đã bấm (đúng như trong danh sách). */
  opened: string;
  /** Tiêu đề khung chat sau khi mở — để đối chiếu. */
  title: string;
  /** Hội thoại đang mở TRƯỚC khi chuyển ('' = không rõ / không có). */
  prev: string;
  /** Tab danh sách lúc đầu nếu đã phải đổi tab để tìm ('' = không đổi). */
  prevTab: string;
  /** Khớp nhiều / gần giống — để hỏi lại người dùng. */
  candidates: string[];
  /** Số hội thoại đã quét qua. */
  scanned: number;
  /** 'tìm kiếm' nếu phải mở qua ô tìm kiếm của Zalo. */
  via: string;
}

const json = (v: unknown) => JSON.stringify(v ?? null);

/** Tab lọc phía trên danh sách hội thoại của Zalo ("Tất cả / Chưa đọc", bản khác "Ưu tiên / Khác"). */
const LIST_TABS = ['Tất cả', 'Ưu tiên', 'Khác', 'Chưa đọc'];

export function buildOpenChatScript(
  dir: { listSelectors?: string[]; itemSelectors?: string[]; nameSelectors?: string[] },
  opts: {
    name: string;
    /** Chỉ khớp đúng tên (khôi phục) — không so "chứa", không đổi tab để tìm. */
    exact?: boolean;
    /** Bấm tab danh sách này trước (khôi phục tab Ưu tiên / Khác). */
    tab?: string;
    /** exact + name rỗng → đỗ vào một trong các hội thoại này. */
    parkNames?: string[];
    /** Chỉ làm khi hội thoại đang mở đúng là cái này (khôi phục). */
    onlyIfOpen?: string;
    /** 'search' = bỏ bước quét danh sách, tìm thẳng bằng ô tìm kiếm (để thử). */
    via?: 'search';
  },
): string {
  return `(async function(){
  var R = { ok:false, error:'', opened:'', title:'', prev:'', prevTab:'', candidates:[], scanned:0, via:'' };
  try {
    var WANT=${json(opts.name)}, EXACT=${opts.exact ? 'true' : 'false'}, TAB=${json(opts.tab ?? '')};
    var MORE_WAITS=6, TABS=${json(LIST_TABS)}, PARK=${json(opts.parkNames ?? [])}, ONLY_IF=${json(opts.onlyIfOpen ?? '')}, VIA=${json(opts.via ?? '')};
${prelude(json(dir.listSelectors ?? []), json(dir.itemSelectors ?? []), json(dir.nameSelectors ?? []))}
    var norm = function(s){
      return String(s||'').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/[đĐ]/g,'d')
        .toLowerCase().replace(/\\s+/g,' ').trim();
    };
    function anyScroller(){
      var c = null;
      for(var i=0;i<LIST_SEL.length && !c;i++){ try { c = document.querySelector(LIST_SEL[i]); } catch(_){} }
      if(!c){ try { c = document.querySelector('.virtualized-scroll') || document.querySelector('.ReactVirtualized__Grid'); } catch(_){} }
      if(!c) return null;
      var sc = c, g = 0;
      while(sc && g++ < 6){ if(sc.scrollHeight > sc.clientHeight + 20) return sc; sc = sc.parentElement; }
      return c;
    }
    async function warm(){
      for(var w=0; w<20; w++){
        if(listBox()) return listBox();
        var sc = anyScroller();
        if(sc){ try { sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll', { bubbles:true })); } catch(_){} }
        await sleep(300);
      }
      return listBox();
    }
    function scrollerOf(box){
      var s = box, g = 0;
      while(s && g++ < 8){ if(s.scrollHeight > s.clientHeight + 20) return s; s = s.parentElement; }
      return box;
    }
    function listLeftRight(){
      var b = listBox() || anyScroller();
      if(!b) return null;
      return b.getBoundingClientRect();
    }
    // Có hội thoại đang mở không: khung soạn tin nằm bên phải danh sách. Màn chào
    // (chưa mở gì) chỉ có banner "Tải ngay"… — đọc tiêu đề ở đó là đọc nhầm.
    function chatOpen(){
      var lr = listLeftRight();
      var minX = lr ? lr.right - 2 : innerWidth * 0.3;
      var eds = document.querySelectorAll('#richInput,[contenteditable="true"],textarea');
      for(var i=0;i<eds.length;i++){
        var r = eds[i].getBoundingClientRect();
        if(r.width > 0 && r.height > 0 && r.left >= minX) return true;
      }
      return false;
    }
    // Tiêu đề khung chat: chữ to / đậm nhất ở dải trên cùng, bên phải danh sách.
    // ĐO ĐƯỢC trên chat.zalo.me (11/2026): tên nằm ở .threadChat__title
    // .main-title-container; khung "Thông tin hội thoại" bên phải (.chat-info) có chữ
    // TO hơn nên heuristic dưới phải loại nó ra.
    var TITLE_SEL = ['.threadChat__title .main-title-container', '.threadChat__title', '.main-title-container'];
    function chatTitle(){
      if(!chatOpen()) return '';
      for(var q=0;q<TITLE_SEL.length;q++){
        var hit = firstOf([TITLE_SEL[q]]);
        if(hit){ var ht = clip(hit.textContent, 120); if(ht) return ht; }
      }
      var lr = listLeftRight();
      var minX = lr ? lr.right - 2 : innerWidth * 0.3;
      var best = '', score = 0;
      var els = document.querySelectorAll('div,span,h1,h2,h3,h4,p');
      for(var i=0;i<els.length;i++){
        var el = els[i];
        if(el.children.length > 1) continue;
        if(el.closest('.chat-info, .z-banner__info, [class*="banner"]')) continue;
        var t = clip(el.textContent, 120);
        if(!t || t.length > 100) continue;
        var r = el.getBoundingClientRect();
        if(r.width <= 0 || r.height <= 0 || r.left < minX || r.top < 0 || r.top > 110) continue;
        var cs = getComputedStyle(el);
        if(cs.visibility === 'hidden' || cs.display === 'none') continue;
        var sc = parseFloat(cs.fontSize || '0') * (parseInt(cs.fontWeight || '400', 10) >= 500 ? 1.5 : 1);
        if(sc > score){ score = sc; best = t; }
      }
      return best;
    }
    function selectedName(){
      var box = listBox();
      if(!box) return '';
      var rows = rowsIn(box);
      for(var i=0;i<rows.length;i++){
        if(/(^|\\s|-)(selected|active|is-active|focused|current)(\\s|$)/i.test(String(rows[i].className||''))) return nameIn(rows[i]);
      }
      return '';
    }
    function rowNames(){
      var box = listBox();
      return box ? rowsIn(box).map(nameIn).filter(Boolean) : [];
    }
    function listTop(){
      try { var b = listBox() || anyScroller(); if(b){ var s = scrollerOf(b); s.scrollTop = 0; s.dispatchEvent(new Event('scroll', { bubbles:true })); } } catch(_){}
    }
    // Quét cả danh sách từ đầu; pred(name) đúng thì trả dòng đó (đang hiện, bấm được).
    // Zalo chỉ nạp thêm hội thoại cũ khi cuộn CHẠM ĐÁY → tới đáy thì chờ xem danh
    // sách có dài thêm không (vài lần) rồi mới thôi.
    async function scan(pred, seen){
      var box = await warm();
      if(!box) return null;
      var sc = scrollerOf(box);
      try { sc.scrollTop = 0; } catch(_){}
      await sleep(320);
      var waits = 0;
      for(var p=0;p<150;p++){
        var rows = rowsIn(listBox() || box);
        for(var i=0;i<rows.length;i++){
          var nm = nameIn(rows[i]);
          if(!nm) continue;
          if(seen) seen[nm] = 1;
          if(pred(nm)) return rows[i];
        }
        if(sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4){
          if(waits >= MORE_WAITS) break;
          var h = sc.scrollHeight;
          waits++;
          await sleep(900);
          if(sc.scrollHeight <= h) break;
          continue;
        }
        sc.scrollTop = sc.scrollTop + Math.max(120, Math.floor(sc.clientHeight * 0.8));
        await sleep(260);
      }
      listTop();
      return null;
    }
    // Tab lọc phía trên danh sách đang chọn (Tất cả / Chưa đọc, hoặc Ưu tiên / Khác).
    function activeTab(){
      for(var i=0;i<TABS.length;i++){
        var el = tabEl(TABS[i]);
        for(var k=0; el && k<3; k++, el = el.parentElement){
          if(/(^|\\s)(selected|active|is-active)(\\s|$)/.test(String(el.className||''))) return TABS[i];
        }
      }
      return '';
    }
    function tabEl(text){
      var lr = listLeftRight();
      var els = document.querySelectorAll('div,span,a,button,li');
      for(var i=0;i<els.length;i++){
        var el = els[i];
        if(el.children.length > 1) continue;
        if(clip(el.textContent, 40) !== text || !visible(el)) continue;
        var r = el.getBoundingClientRect();
        if(lr && (r.top > lr.top + 4 || r.left > lr.right || r.right < lr.left)) continue;
        return el;
      }
      return null;
    }
    async function clickTab(text){
      var el = tabEl(text);
      if(!el) return false;
      realClick(el);
      await sleep(700);
      return true;
    }
    // ── Dự phòng: ô tìm kiếm của Zalo ─────────────────────────────────────────
    // Zalo web chỉ nạp vài chục hội thoại gần nhất vào danh sách; nhóm lâu không ai
    // nhắn chỉ ra khi tìm. ĐO ĐƯỢC: #contact-search-input nhận value đặt bằng setter
    // gốc + sự kiện input (React); kết quả là các dòng con của một danh sách ảo
    // (.ReactVirtualized__Grid__innerScrollContainer) ngay dưới ô; nút "Đóng" cạnh ô
    // thoát chế độ tìm.
    function searchInput(){
      var el = document.querySelector('#contact-search-input');
      if(el) return el;
      var ins = document.querySelectorAll('input');
      for(var i=0;i<ins.length;i++) if(/tìm|search/i.test(ins[i].placeholder||'') && visible(ins[i])) return ins[i];
      return null;
    }
    function setInput(el, v){
      try { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); } catch(_){ el.value = v; }
      el.dispatchEvent(new Event('input', { bubbles:true }));
    }
    function closeSearch(){
      var inp = searchInput();
      if(inp){ try { setInput(inp, ''); inp.blur(); } catch(_){} }
      var ib = inp ? inp.getBoundingClientRect() : null;
      var els = document.querySelectorAll('div,span,button');
      for(var i=0;i<els.length;i++){
        if(els[i].children.length > 0 || clip(els[i].textContent, 10) !== 'Đóng' || !visible(els[i])) continue;
        var r = els[i].getBoundingClientRect();
        if(ib && Math.abs(r.top - ib.top) > 40) continue;
        realClick(els[i]);
        return;
      }
    }
    // Chữ khớp trong một dòng kết quả. Zalo TÔ SÁNG phần khớp (tách chữ thành nhiều
    // thẻ) nên không lấy được tên ở một thẻ lá — so trên textContent của từng khối:
    // khớp đúng tên thì lấy, không thì lấy khối NGẮN nhất có chứa chuỗi tìm.
    function matchIn(item){
      var all = item.querySelectorAll('div,span');
      var loose = '';
      for(var i=0;i<all.length;i++){
        var t = clip(all[i].textContent, 120);
        if(!t || t.length > 100) continue;
        var n = norm(t);
        if(n === want) return { exact:true, nm:t };
        if(n.indexOf(want) >= 0 && (!loose || t.length < loose.length)) loose = t;
      }
      return { exact:false, nm:loose };
    }
    async function searchFor(exactOnly, seen){
      var inp = searchInput();
      if(!inp) return null;
      var ib = inp.getBoundingClientRect();
      inp.focus();
      setInput(inp, WANT);
      var items = [];
      for(var w=0; w<8; w++){
        await sleep(400);
        items = [];
        var conts = document.querySelectorAll('.ReactVirtualized__Grid__innerScrollContainer');
        for(var c=0;c<conts.length;c++){
          var cr = conts[c].getBoundingClientRect();
          if(cr.top < ib.bottom - 2 || cr.left > ib.right + 40) continue;
          for(var k=0;k<conts[c].children.length;k++){
            var it = conts[c].children[k];
            var m = matchIn(it);
            if(m.nm && visible(it)) items.push({ el: it, nm: m.nm, exact: m.exact });
          }
        }
        if(items.length && w >= 2) break;
      }
      var pick = null, loose = [];
      for(var i=0;i<items.length;i++){
        if(seen) seen[items[i].nm] = 1;
        if(items[i].exact){ pick = items[i]; break; }
        if(!exactOnly && norm(items[i].nm).indexOf(want) >= 0 && loose.indexOf(items[i].nm) < 0) loose.push(items[i].nm);
      }
      if(!pick && loose.length === 1){
        for(var j=0;j<items.length;j++) if(items[j].nm === loose[0]){ pick = items[j]; break; }
      }
      if(!pick){
        if(loose.length > 1){ R.candidates = loose.slice(0, 20); R.error = 'có ' + loose.length + ' hội thoại khớp “' + WANT + '”'; }
        closeSearch();
        await sleep(300);
        return null;
      }
      R.via = 'tìm kiếm';
      return pick.el;
    }

    async function openRow(row, nmOverride){
      var nm = nmOverride || nameIn(row);
      realClick(row);
      await sleep(1100);
      if(R.via) { closeSearch(); await sleep(300); }
      R.opened = nm;
      R.title = chatTitle();
      R.ok = true;
      try { var sc = scrollerOf(listBox() || row.parentElement); sc.scrollTop = 0; } catch(_){}
    }

    R.prev = selectedName() || chatTitle();
    // Khôi phục: chỉ khi khung chat vẫn đang ở hội thoại trợ lý đã mở — người dùng
    // tự chuyển sang hội thoại khác trong lúc đó thì để yên.
    if(ONLY_IF && norm(selectedName()) !== norm(ONLY_IF) && norm(chatTitle()) !== norm(ONLY_IF)){ R.error = 'skip'; return R; }
    if(TAB) await clickTab(TAB);

    var want = norm(WANT);
    var same = function(nm){ return nm === WANT || norm(nm) === want; };
    var seen = {};
    var row = VIA === 'search' ? null : await scan(same, seen);
    if(!row && !EXACT){
      // Không thấy ở tab lọc đang chọn (vd đang ở "Chưa đọc") → thử các tab khác,
      // "Tất cả" trước. Nhớ tab gốc để trả lại.
      var cur = activeTab();
      for(var t=0;t<TABS.length && !row;t++){
        if(TABS[t] === cur || !tabEl(TABS[t])) continue;
        if(!cur){
          // Không biết tab nào đang chọn → chỉ đổi khi bấm làm danh sách đổi.
          var before = rowNames().slice(0, 6).join('|');
          await clickTab(TABS[t]);
          if(rowNames().slice(0, 6).join('|') === before) continue;
        } else {
          await clickTab(TABS[t]);
        }
        R.prevTab = cur || R.prevTab || '?';
        row = await scan(same, seen);
      }
      if(R.prevTab === '?') R.prevTab = '';
    }
    if(!row && !EXACT){
      var names = Object.keys(seen);
      var toks = want.split(' ').filter(function(x){ return x.length > 1; });
      var hits = names.filter(function(nm){
        var n = norm(nm);
        if(n.indexOf(want) >= 0) return true;
        return toks.length > 0 && toks.every(function(tk){ return n.indexOf(tk) >= 0; });
      });
      if(hits.length === 1){
        var only = hits[0];
        var isOnly = function(nm){ return nm === only; };
        row = await scan(isOnly, null);
        // Dòng đó nằm ở tab danh sách cũ (đã đổi tab để tìm) → quay lại tab cũ rồi tìm.
        if(!row && R.prevTab && (await clickTab(R.prevTab))){ R.prevTab = ''; row = await scan(isOnly, null); }
      } else if(hits.length > 1){
        R.candidates = hits.slice(0, 20);
        R.error = 'có ' + hits.length + ' hội thoại khớp “' + WANT + '”';
      } else {
        R.candidates = names.filter(function(nm){
          var n = norm(nm);
          return toks.some(function(tk){ return tk.length > 2 && n.indexOf(tk) >= 0; });
        }).slice(0, 20);
      }
    }
    if(!row && WANT && !R.candidates.length){
      var tabNow = R.prevTab;
      if(tabNow){ await clickTab(tabNow); R.prevTab = ''; } // ô tìm tìm trên mọi hội thoại — trả tab lọc về như cũ trước
      var found = await searchFor(EXACT, seen);
      if(found){
        R.scanned = Object.keys(seen).length;
        await openRow(found, matchIn(found).nm);
        // Tên trong kết quả tìm có thể khác dòng danh sách — lấy tên chuẩn từ tiêu đề khung chat.
        if(R.title) R.opened = R.title;
        return R;
      }
    }
    R.scanned = Object.keys(seen).length;
    if(row){ await openRow(row); return R; }

    if(EXACT && PARK.length){
      // Khôi phục mà không biết hội thoại cũ → đỗ vào chat với chính mình, như lúc gửi xong
      // (để một hội thoại thật bị bỏ mở không chặn thông báo của nó).
      // (Cũng dùng khi hội thoại cũ không còn tìm thấy.)
      var spot = await scan(function(nm){ return PARK.indexOf(nm) >= 0 && norm(nm) !== norm(ONLY_IF); }, null);
      if(spot){ await openRow(spot); return R; }
    }
    if(!R.error) R.error = 'không tìm thấy hội thoại “' + WANT + '” (đã quét ' + R.scanned + ' hội thoại)';
    // Tìm hụt ở tab khác → trả danh sách về tab cũ.
    if(R.prevTab){ await clickTab(R.prevTab); R.prevTab = ''; }
    return R;
  } catch(e){
    R.ok = false;
    R.error = 'lỗi trong trang: ' + (e && e.message ? e.message : String(e));
    return R;
  }
})()`;
}
