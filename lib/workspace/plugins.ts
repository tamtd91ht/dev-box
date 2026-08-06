// Browser Workspace Framework — plugin registry.
//
// A plugin is a pure declaration. To add a workspace (Telegram, WhatsApp,
// Kibana, Grafana, Jenkins, an internal admin…), append an entry here — no other
// code changes. The framework gives EACH ACCOUNT of each plugin its own
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
      extraScript: ZALO_LINK_CLICK,
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
  },
  // WhatsApp Web works the same way — its toasts go through the service worker,
  // which the collector already hooks. Uncomment when you actually need it:
  // {
  //   id: 'whatsapp',
  //   name: 'WhatsApp',
  //   icon: '🟢',
  //   brand: { color: '#25d366', logo: 'whatsapp' },
  //   url: 'https://web.whatsapp.com/',
  //   badge: 'personal',
  //   permissions: CHAT_PERMISSIONS,
  //   keepAlive: true,
  //   multiAccount: true,
  //   capture: { genericTitles: ['WhatsApp'], bodySenderSeparator: ': ' },
  // },
];

export function getPlugin(id: string): WorkspacePlugin | undefined {
  return WORKSPACE_PLUGINS.find((p) => p.id === id);
}

/** Plugins that feed the social automation group (i.e. declare a collector). */
export const messagingPlugins = (): WorkspacePlugin[] => WORKSPACE_PLUGINS.filter((p) => !!p.capture);
