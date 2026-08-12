// Browser Workspace Framework — plugin registry.
//
// A plugin is a pure declaration. To add a workspace (Kibana, Grafana, Jenkins,
// an internal admin…), append an entry here — no other code changes. Hiện có:
// Zalo · Telegram · WhatsApp · Facebook (gồm cả Messenger, chung một phiên).
// The framework gives EACH ACCOUNT of each plugin its own
// persistent session partition (`persist:ws-{pluginId}-{instanceId}`), so Zalo
// and Telegram never share cookies, storage or a login — they are already fully
// partitioned. What they do share is the rail, and there each app carries its
// own colour + vector mark (see `brand`) so you never have to read a label to
// know which app an account belongs to.
//
//   id           stable key + partition suffix (a-z0-9-)
//   url          home URL (the ONLY place a workspace URL is hardcoded)
//   brand        accent colour + built-in logo (components/BrandMark.tsx)
//   permissions  extra web APIs the app may request (default: none)
//   keepAlive    keep the guest in memory across tab switches
//   capture      knobs for the shared guest collector (unread + messages)
//
// Example (uncomment + point at your VPN hosts):
//   { id: 'grafana', name: 'Grafana', icon: '📊', url: 'https://grafana.internal/', badge: 'vpn' },
//   { id: 'kibana',  name: 'Kibana',  icon: '🔎', url: 'https://kibana.internal/',  badge: 'vpn' },
//   { id: 'jenkins', name: 'Jenkins', icon: '🧱', url: 'https://jenkins.internal/', badge: 'vpn' },

import type { WorkspacePlugin } from './types';

/** Permissions every chat app needs: calls, toasts, copy/paste, fullscreen. */
const CHAT_PERMISSIONS: WorkspacePlugin['permissions'] = [
  'notifications',
  'media', // voice & video calls
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
];

/**
 * Zalo: bấm link trong tin nhắn → mở được.
 *
 * VÌ SAO PHẢI CAN THIỆP TRONG KHUNG CHAT, không chặn ở tầng Electron được:
 * chặn `window.open` (setWindowOpenHandler) và chặn điều hướng (will-navigate)
 * đều KHÔNG bắt được cú bấm này — đã thử cả hai, hộp thoại không hề hiện. Nghĩa
 * là Zalo nuốt luôn sự kiện click ở tầng DOM: link trong tin nhắn không phải
 * <a href> thường mà là phần tử có handler riêng, và handler đó không dẫn tới
 * một hành vi mà Electron nhìn thấy được. Không có tín hiệu nào ra tới main
 * process thì không có gì để chặn — nên phải bắt ngay tại chỗ, trong guest.
 *
 * Chạy ở CAPTURE PHASE trên document, tức trước khi handler của Zalo nhận được
 * sự kiện. Tìm URL theo thứ tự:
 *   1. thuộc tính href thật của <a> gần nhất (kể cả href rỗng/javascript:)
 *   2. các data-* Zalo hay gắn URL vào
 *   3. chính text của phần tử, nếu nó trông như một URL
 * Có URL http(s) → chặn sự kiện (stopPropagation + preventDefault) rồi gọi
 * window.open. Lúc này setWindowOpenHandler bên main.cjs MỚI chạy, và hộp thoại
 * "Mở ở đâu?" hiện ra như thiết kế.
 *
 * Chỉ đụng vào cú bấm có URL ra ngoài. Bấm vào tin nhắn thường, nút, emoji,
 * sticker, khung chat… không khớp thì thả cho Zalo xử lý y như cũ — không ảnh
 * hưởng gì tới phần còn lại của app, kể cả luồng quét QR.
 *
 * `[ws-link]` in ra terminal để nếu vẫn trượt thì còn biết nó thấy gì.
 */
const ZALO_LINK_CLICK = `
if(!window.__wsLinkHook){
  window.__wsLinkHook = true;
  (function(){
    var RE = /^https?:\\/\\/[^\\s<>"']+$/i;

    // URL "thật" của một phần tử — href, data-*, hoặc text trông như URL.
    function urlOf(el){
      try {
        var a = el.closest && el.closest('a');
        if(a){
          // getAttribute chứ không phải a.href: href rỗng/javascript: bị trình
          // duyệt nở thành URL trang hiện tại, tưởng nhầm là link thật.
          var raw = (a.getAttribute('href')||'').trim();
          if(RE.test(raw)) return raw;
          var ds = a.dataset || {};
          for(var k in ds){ var v=(ds[k]||'').trim(); if(RE.test(v)) return v; }
        }
        var cur = el;
        for(var i=0;i<4&&cur;i++){
          var d = cur.dataset || {};
          for(var k2 in d){ var v2=(d[k2]||'').trim(); if(RE.test(v2)) return v2; }
          cur = cur.parentElement;
        }
        // Zalo render link thành text thuần trong một node lá.
        var t = (el.textContent||'').trim();
        if(t.length < 2048 && RE.test(t)) return t;
      } catch(_){}
      return '';
    }

    document.addEventListener('click', function(e){
      try {
        var el = e.target;
        if(!el || el.nodeType !== 1) return;
        var u = urlOf(el);
        if(!u) return;
        // Cùng domain Zalo → để Zalo tự đi (điều hướng nội bộ, không phải link
        // người ta gửi).
        try { if(/(^|\\.)zalo\\.me$/i.test(new URL(u).hostname)) return; } catch(_){ return; }
        e.preventDefault();
        e.stopPropagation();
        if(e.stopImmediatePropagation) e.stopImmediatePropagation();
        try{ console.log('[ws-link] open '+u); }catch(_){}
        // window.open → setWindowOpenHandler (main.cjs) → hộp thoại "Mở ở đâu?".
        window.open(u, '_blank');
      } catch(err){ try{ console.log('[ws-link] error '+err); }catch(_){} }
    }, true);
  })();
}
`;

/**
 * Zalo: đọc tin mới THẲNG TỪ DANH SÁCH HỘI THOẠI, không chờ thông báo.
 *
 * VÌ SAO: đo được — khi tab Workspace KHÔNG phải tab đang mở, webview Zalo ở nền
 * và Zalo NGỪNG bắn `new Notification`, nên collector (vốn chỉ nghe thông báo)
 * không bắt được tin nào cho tới khi quay lại tab Workspace. Đọc DOM không phụ
 * thuộc vào việc Zalo có bắn thông báo hay không.
 *
 * Chạy trong mỗi nhịp poll (3s), là extraScript của collector nên có sẵn `push`.
 *
 * Ba cái bẫy đã né:
 *   1. Danh sách là react-virtualized: ở nền có thể render 0 dòng. CHỈ khi 0
 *      dòng thì cuộn về đầu + phát 'scroll' để nó render các hội thoại MỚI NHẤT
 *      cho nhịp sau — chỉ làm lúc trống nên không phá cuộn của người đang xem.
 *   2. Chuỗi so sánh BỎ thời gian ("2 giờ"→"3 giờ") và số chưa đọc, nếu không
 *      mỗi phút trôi lại tưởng có tin mới.
 *   3. Nhịp đầu chỉ ghi mốc, không phát (không thì vừa mở là bắn cả trăm dòng);
 *      bỏ tin của mình ("Bạn:"); bỏ hội thoại vừa có thông báo (khỏi tính 2 lần).
 */
const ZALO_DOM_CAPTURE = `
(function(){
  try {
    if(!window.__wsCap) return;
    var rows = document.querySelectorAll('.conv-item');
    if(!rows.length){
      // List chưa render (ở nền). Cuộn về đầu để nhịp sau có dòng mới nhất.
      try {
        var sc = document.querySelector('.virtualized-scroll') || document.querySelector('.ReactVirtualized__Grid');
        var g=0; while(sc && g++<6){ if(sc.scrollHeight > sc.clientHeight+20) break; sc = sc.parentElement; }
        if(sc){ sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll',{bubbles:true})); }
      } catch(_){}
      return;
    }
    var prev = window.__wsDomPrev = window.__wsDomPrev || {};
    var first = !window.__wsDomInit;
    var notiAt = window.__wsNotiByConv = window.__wsNotiByConv || {};
    var now = Date.now();
    function meat(s){
      var str = String(s||'').replace(/\\s+/g,' ').trim();
      // Nhãn thời gian tương đối ("Vài giây", "3 phút") của conv-item thường
      // DÍNH LIỀN snippet trong textContent: "Vài giâyautomation nè". Tách đơn
      // vị thời gian khỏi chữ theo sau để bước lọc token bên dưới cắt được nó.
      str = str.replace(/(giây|giay|phút|phut|giờ|gio|ngày|ngay|tuần|tuan)(?=[^\\s\\d])/gi, '$1 ');
      var parts = str.split(' '), keep=[];
      for(var i=0;i<parts.length;i++){ var w=parts[i]; if(!w) continue;
        if(/^\\d+\\+?$/.test(w)) continue;
        if(/^\\d{1,2}[\\/:]\\d{1,2}(\\/\\d{2,4})?$/.test(w)) continue;
        if(/^(giờ|gio|phút|phut|ngày|ngay|giây|giay|tuần|tuan|thg)$/i.test(w)) continue;
        if(/^(hôm|hom|qua|nay|vừa|vua|xong|vài|vai|trước|truoc)$/i.test(w)) continue;
        keep.push(w);
      }
      return keep.join(' ');
    }
    for(var i=0;i<rows.length;i++){
      var r = rows[i];
      var nameEl = r.querySelector('.conv-item-title__name');
      var name = nameEl ? String(nameEl.textContent||'').replace(/\\s+/g,' ').trim() : '';
      if(!name) continue;
      var whole = String(r.textContent||'').replace(/\\s+/g,' ').trim();
      var at = whole.indexOf(name);
      var rest = at>=0 ? (whole.slice(0,at)+' '+whole.slice(at+name.length)) : whole;
      var sig = meat(rest);
      if(!sig) continue;
      var had = Object.prototype.hasOwnProperty.call(prev, name);
      if(had && prev[name] === sig) continue;
      prev[name] = sig;
      if(first || !had) continue;                                  // nhịp đầu: chỉ ghi mốc
      if(/^(bạn|ban|you)\\s*:/i.test(sig)) continue;                // tin của mình
      if(notiAt[name] && now - notiAt[name] < 20000) continue;     // thông báo đã bắt
      var sender=name, text=sig, colon=sig.indexOf(':');
      if(colon>0 && colon<=40){ sender=sig.slice(0,colon).trim(); text=sig.slice(colon+1).trim(); }
      if(!text) continue;
      push(sender, name, text, 'dom');
    }
    window.__wsDomInit = true;
  } catch(_){}
})();
`;

export const WORKSPACE_PLUGINS: WorkspacePlugin[] = [
  {
    id: 'zalo',
    name: 'Zalo',
    icon: '💬',
    brand: { color: '#0068ff', logo: 'zalo' },
    url: 'https://chat.zalo.me/',
    badge: 'personal',
    description: 'Zalo cá nhân — quét QR một lần, phiên đăng nhập lưu ngay trên máy bạn.',
    permissions: CHAT_PERMISSIONS,
    keepAlive: true,
    multiAccount: true, // nhiều tài khoản Zalo cùng lúc — mỗi cái một phiên riêng
    capture: {
      // Zalo raises a desktop toast per message: title = người gửi (hoặc tên
      // nhóm), body = "Tên: nội dung" khi ở trong nhóm.
      genericTitles: ['Zalo', 'Zalo Web'],
      bodySenderSeparator: ': ',
      // Thông báo là kênh chính khi tab Workspace mở; đọc DOM là kênh bắt tin
      // khi ở tab khác (webview nền không bắn thông báo). Cả hai chạy cùng, có
      // chống trùng theo hội thoại (notiByConv) + engine dedup theo id.
      extraScript: ZALO_LINK_CLICK + ZALO_DOM_CAPTURE,
    },
    // Ảnh đại diện của CHÍNH tài khoản: nút mở menu cá nhân ở đầu thanh dọc
    // bên trái. `.nav__avatar`/`#nav-profile-item` là khung nút; script tự lấy
    // <img> bên trong. KHÔNG được trỏ vào `.conv-item__avatar` — đó là mặt
    // người khác trong danh sách hội thoại.
    avatar: {
      selectors: [
        '#nav-profile-item img',
        '.nav__avatar img',
        '.nav-profile img',
        '[data-id="div_MainTab_Avatar"] img',
      ],
      // Zalo dựng avatar của mình bằng CÙNG component `zavatar` với avatar hội
      // thoại, nên bám class rất dễ trượt. Cứu bằng vị trí: thanh dọc trái rộng
      // ~64px, avatar của mình nằm trên đỉnh nó. Loại thẳng mọi ảnh nằm trong
      // danh sách hội thoại — đó là mặt người khác.
      probeCorner: {
        width: 80,
        height: 160,
        excludeSelectors: ['.conv-item', '.ReactVirtualized__Grid'],
      },
    },
    // Đọc danh sách hội thoại để dựng danh bạ đích NGOÀI Zalo. Các selector này
    // ĐO ĐƯỢC từ chat.zalo.me thật (xem lib/workspace/directory.ts), không phải
    // phỏng đoán:
    //
    // - Danh sách chạy bằng react-virtualized: chỉ ~13 dòng tồn tại trong DOM
    //   một lúc, khối cuộn thật là `.ReactVirtualized__Grid` bọc ngoài (bắt
    //   được bằng cách đi lên từ innerScrollContainer), còn `nav.flx.h100` bao
    //   ngoài thì `overflow:hidden` — đặt scrollTop lên nó không nhúc nhích.
    // - `.conv-item` phải khớp ĐÚNG TOKEN class. `[class*="conv-item"]` khớp
    //   luôn `conv-item__avatar`, `conv-item-title__name`, `conv-item-title__more`
    //   → một hội thoại nở thành 4-5 "dòng" rác, mỗi mảnh nhặt một chữ khác nhau
    //   (giờ "30/07", "26 phút", tiền tố "Bạn:").
    // - Tên nằm trong `.conv-item-title__name`; hàng còn lại là giờ và xem
    //   trước tin nhắn, KHÔNG được nhặt nhầm làm tên.
    // - Không có id hội thoại nào trong DOM (mọi dòng chỉ chung một
    //   `data-id="div_TabMsg_ThrdChItem"` của component) → danh bạ phải bám tên.
    directory: {
      listSelectors: ['.ReactVirtualized__Grid__innerScrollContainer', '.virtualized-scroll'],
      itemSelectors: ['.conv-item'],
      nameSelectors: ['.conv-item-title__name'],
      idAttrs: [],
      // Avatar <img id> LÀ id Zalo thật của đối phương — thứ định danh ổn định
      // duy nhất trang này lộ ra. Chỉ dùng khi hội thoại có ĐÚNG một avatar:
      // ảnh ghép của nhóm mang id của từng thành viên, không cái nào là id nhóm.
      avatarIdSelectors: ['.conv-item__avatar img[id]'],
      groupSelectors: ['.zavatar-multi'],
      passes: 30, // ~9100px danh sách / ~700px khung nhìn
    },
    // Nút "Phân loại" nằm ngay trên danh sách (đo được ở ~283,102). Tìm theo
    // CHỮ chứ không theo đường dẫn: class của Zalo là chuỗi tiện ích ngắn
    // (flx, flx-al-c…) nên đường dẫn đổi theo mọi thay đổi bố cục, còn nhãn
    // hiển thị thì không.
    // Menu Phân loại — ĐO ĐƯỢC từ chat.zalo.me thật. Nút tìm theo CHỮ (class của
    // Zalo là chuỗi tiện ích `flx`, `flx-al-c`… nên đường dẫn đổi theo bố cục),
    // còn bên trong popup thì bám `data-id` — đây là mã component ổn định, khác
    // hẳn class. Mỗi nhãn là một ô TICK, nên bấm lần nữa là tắt lọc.
    labels: {
      filterText: 'Phân loại',
      popupSelectors: ['.popover-v3'],
      itemSelectors: ['[data-id="div_DetailLabelList_Label"]'],
      nameSelectors: ['[data-id="div_MiniLabelList_Label"]'],
    },
    // Gửi tin. CHƯA đo được DOM khung soạn — các selector dưới là phỏng đoán
    // theo lối đặt tên của Zalo, và script gửi (lib/workspace/send.ts) được
    // viết để **báo cáo** thay vì đoán: không khớp thì nó tự tìm ô soạn ở nửa
    // dưới màn hình và liệt kê mọi phần tử nhập liệu nhìn thấy (`editables`),
    // đủ để ghim selector đúng sau MỘT lần chạy thử.
    send: {
      composerSelectors: [
        '#richInput',
        '[data-id="div_Chat_InputMessage"]',
        '.chat-input [contenteditable="true"]',
        '#chatInput [contenteditable="true"]',
      ],
      sendButtonSelectors: ['[data-id="btn_Chat_SendMessage"]', '.btn-send', '[title="Gửi tin nhắn"]'],
      messageSelectors: ['.chat-body .msg-item', '[data-id="div_Chat_MessageItem"]', '.message-item'],
      // Zalo gửi bằng Enter → pha 'type' dừng lại, renderer bơm Enter TRUSTED
      // (sendInputEvent từ main process). Đặt false nếu app chỉ gửi bằng nút:
      // khi đó script bấm nút thay vì chờ Enter. KHÔNG bấm nút ở chế độ true —
      // click tổng hợp không qua được event.isTrusted, xem lib/workspace/send.ts.
      enterToSend: true,
      // BẬT — log chứng minh cần thiết: gửi xong mà để hội thoại ĐANG MỞ thì
      // Zalo coi như người dùng đang đọc và NGỪNG bắn thông báo cho tin mới của
      // hội thoại đó → thu tin chết tới khi mở workspace xem lại ("chỉ chạy
      // được một lần"). Đỗ sang chat với chính mình ("My Documents") để không
      // hội thoại thật nào bị bỏ mở → thông báo của chúng tiếp tục về.
      parkAfterSend: true,
      parkNames: ['My Documents', 'Cloud của tôi', 'Cloud của bạn'],
    },
  },
  {
    id: 'telegram',
    name: 'Telegram',
    icon: '✈️',
    brand: { color: '#2aabee', logo: 'telegram' },
    // Web A is the actively-developed client and keeps "(N)" in the page title,
    // which gives the collector an exact count even before any toast fires.
    url: 'https://web.telegram.org/a/',
    badge: 'personal',
    description: 'Telegram Web — đăng nhập bằng số điện thoại hoặc QR, phiên lưu ngay trên máy bạn.',
    permissions: CHAT_PERMISSIONS,
    keepAlive: true,
    multiAccount: true, // Telegram nhiều tài khoản — mỗi cái một phiên riêng
    capture: {
      genericTitles: ['Telegram', 'Telegram Web'],
      bodySenderSeparator: ': ',
    },
    // Web A: ảnh của mình nằm trong ngăn kéo bên trái (mở bằng ☰). Ngăn kéo
    // đóng thì phần tử vẫn ở trong DOM nên vẫn đọc được. Telegram hay vẽ avatar
    // bằng chữ cái trên nền màu thay vì <img>; lúc đó không có ảnh để lấy và
    // rail giữ nguyên huy hiệu app — đúng như thiết kế.
    avatar: {
      selectors: [
        '#LeftMainHeader .ChatInfo .Avatar img',
        '.left-header .Avatar img',
        '#Settings .ProfileInfo .Avatar img',
        '.settings-container .Avatar img',
      ],
      // Ngăn kéo trái. Loại danh sách chat (.chat-list / .ListItem) để không
      // vớ phải avatar người đang nhắn.
      probeCorner: {
        width: 300,
        height: 120,
        excludeSelectors: ['.chat-list', '.ListItem', '#LeftColumn .chat-item-clickable'],
      },
    },
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    icon: '🟢',
    brand: { color: '#25d366', logo: 'whatsapp' },
    url: 'https://web.whatsapp.com/',
    badge: 'personal',
    description: 'WhatsApp Web — quét QR bằng app trên điện thoại, phiên lưu ngay trên máy bạn.',
    permissions: CHAT_PERMISSIONS,
    keepAlive: true,
    multiAccount: true,
    capture: {
      // Toast của WhatsApp Web đi qua service worker — collector đã hook sẵn cả
      // hai dạng. Tiêu đề là tên hội thoại, thân là "Người gửi: nội dung".
      genericTitles: ['WhatsApp', 'WhatsApp Web'],
      bodySenderSeparator: ': ',
    },
    // WhatsApp Web: avatar của mình ở thanh công cụ trên cùng bên trái. Ảnh
    // được tải qua blob: URL cùng gốc nên canvas đọc được bình thường.
    avatar: {
      selectors: [
        'header [data-testid="default-user"] img',
        '#side header img[draggable="false"]',
        'header .x1n2onr6 img[src^="blob:"]',
      ],
      probeCorner: {
        width: 420,
        height: 90,
        excludeSelectors: ['#pane-side', '[role="listitem"]', '[data-testid="cell-frame-container"]'],
      },
    },
  },
  {
    id: 'facebook',
    name: 'Facebook',
    icon: '📘',
    brand: { color: '#0866ff', logo: 'facebook' },
    // MỘT workspace cho cả Facebook và Messenger, không tách hai.
    //
    // facebook.com và messenger.com dùng CHUNG hệ đăng nhập của Meta. Tách
    // thành hai plugin thì mỗi cái một partition (`ws-{pluginId}-{instanceId}`)
    // → hai cookie jar riêng → phải đăng nhập hai lần cho cùng một tài khoản,
    // trong khi trên Chrome thật đăng nhập Facebook là vào Messenger được luôn.
    // Gộp lại: một partition, đăng nhập một lần, menu ☰ chọn vào Facebook hay
    // Messenger — giống hệt cách mở hai địa chỉ trong cùng một trình duyệt.
    url: 'https://www.facebook.com/',
    badge: 'personal',
    description:
      'Facebook & Messenger — đăng nhập một lần, menu ☰ chọn Bảng tin hay Nhắn tin. Phiên lưu ngay trên máy bạn.',
    permissions: CHAT_PERMISSIONS,
    // keepAlive vì workspace này CÓ Messenger: tin nhắn phải tới được khi đang
    // ở tab khác, nếu không badge chỉ nhảy lúc mình mở lên xem.
    keepAlive: true,
    multiAccount: true,
    capture: {
      // Gộp tiêu đề chung của cả hai miền — Messenger đặt tiêu đề theo tên hội
      // thoại, còn Facebook để "Facebook". Cả hai đều là tiêu đề "vô nghĩa",
      // lọc ra để không đẩy thành thông báo rác.
      genericTitles: ['Messenger', 'Facebook', 'Facebook Messenger'],
      bodySenderSeparator: ': ',
    },
    // Một workspace chạy trên HAI miền, nên khai selector cho cả hai: facebook
    // .com để avatar ở nút tài khoản góc phải trên, messenger.com để ở thanh
    // bên trái. Ảnh của Meta phục vụ từ scontent.* (khác gốc) — nếu thiếu CORS
    // thì canvas ném và script trả null, rail lui về huy hiệu app.
    avatar: {
      selectors: [
        '[aria-label="Tài khoản của bạn"] img',
        '[aria-label="Your profile"] img',
        'div[role="banner"] [role="button"] image',
        'div[role="navigation"] svg image',
      ],
      // Facebook để avatar ở góc trên-PHẢI (nút tài khoản trên thanh xanh),
      // ngược với đám app chat. Messenger thì ở trái, nhưng selector phía trên
      // đã phủ; probe chỉ là lưới an toàn cuối.
      probeCorner: {
        fromRight: true,
        width: 260,
        height: 70,
        excludeSelectors: ['[role="feed"]', '[role="article"]', '[role="grid"]'],
      },
    },
  },
];

/**
 * Facebook: các trang hay vào, đổ thành menu ngay trên thanh công cụ workspace.
 *
 * Cùng một guest, chỉ điều hướng — nên bấm qua lại KHÔNG mất phiên đăng nhập và
 * không dựng lại trang từ đầu. `/me/` để Facebook tự phân giải sang trang cá
 * nhân của tài khoản đang đăng nhập: không phải nhét username hay id vào source.
 *
 * Mục Nhắn tin trỏ sang messenger.com bằng URL TUYỆT ĐỐI: khác miền với
 * facebook.com nhưng cùng phiên đăng nhập Meta, nên vẫn trong một guest và vào
 * thẳng, không hỏi đăng nhập lại. Đây là lý do `path` chấp nhận cả URL đầy đủ.
 */
export interface WorkspaceMenuItem {
  label: string;
  /**
   * Đường dẫn trong cùng app (nối vào origin của plugin), HOẶC một URL tuyệt đối
   * khi mục đó nằm ở miền anh em dùng chung phiên (messenger.com ↔ facebook.com).
   */
  path: string;
  icon?: string;
  /** Vạch phân nhóm phía trên mục này trong menu. */
  divider?: boolean;
}

export const WORKSPACE_MENUS: Record<string, WorkspaceMenuItem[]> = {
  facebook: [
    { label: 'Bảng tin', path: 'https://www.facebook.com/', icon: '🏠' },
    { label: 'Nhắn tin (Messenger)', path: 'https://www.messenger.com/', icon: '💬' },
    { label: 'Trang cá nhân', path: '/me/', icon: '👤', divider: true },
    { label: 'Story', path: '/stories/', icon: '📸' },
    { label: 'Reels', path: '/reel/', icon: '🎬' },
    { label: 'Bạn bè', path: '/friends/', icon: '👥' },
    { label: 'Nhóm', path: '/groups/feed/', icon: '👪' },
    { label: 'Kỷ niệm', path: '/memories/', icon: '🕰️' },
    { label: 'Đã lưu', path: '/saved/', icon: '🔖' },
    { label: 'Marketplace', path: '/marketplace/', icon: '🛒' },
    { label: 'Thông báo', path: '/notifications/', icon: '🔔', divider: true },
    { label: 'Cài đặt', path: '/settings/', icon: '⚙️' },
  ],
};

/** Menu điều hướng nhanh của một plugin (rỗng nếu plugin không khai). */
export const menuFor = (pluginId: string): WorkspaceMenuItem[] => WORKSPACE_MENUS[pluginId] ?? [];

export function getPlugin(id: string): WorkspacePlugin | undefined {
  return WORKSPACE_PLUGINS.find((p) => p.id === id);
}

/** Plugins that feed the social automation group (i.e. declare a collector). */
export const messagingPlugins = (): WorkspacePlugin[] => WORKSPACE_PLUGINS.filter((p) => !!p.capture);
