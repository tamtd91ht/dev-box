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
