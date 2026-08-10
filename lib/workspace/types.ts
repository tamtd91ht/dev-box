// Browser Workspace Framework — shared types.
//
// The framework embeds real web applications (Zalo, Kibana, Grafana, Jenkins…)
// as first-class "workspaces" inside the DevBox. Each workspace is a genuine
// browser context (an Electron <webview> with its own persistent session
// partition) — NOT an iframe — so SharedWorker / localStorage / IndexedDB /
// WebSocket all work and the login session survives restarts.
//
// A PLUGIN is pure declaration: name, icon, url, partition, permissions. It
// contains no browser logic (that lives in the engine / main process). Zalo is
// simply the first consumer of the framework.

import type { AvatarSpec } from './avatar';
import type { CaptureSpec } from './capture';
import type { DirectorySpec } from './directory';
import type { LabelSpec } from './labels';
import type { SendSpec } from './send';

/**
 * Visual identity of a workspace. Every place an account surfaces (rail group,
 * account row, toolbar, automation pickers) renders this, so "which app is this
 * account?" is answered by shape + colour before you read a single character of
 * the label — which matters the moment Zalo and Telegram sit side by side.
 */
export interface WorkspaceBrand {
  /** Accent colour — chip fill, rail accent bar, active-row tint. */
  color: string;
  /** Built-in vector mark. Absent → the emoji `icon` is used instead. */
  logo?: 'zalo' | 'telegram' | 'whatsapp' | 'messenger' | 'facebook';
}

/** Web APIs a workspace guest may request. Anything not listed is denied. */
export type WorkspacePermission =
  | 'notifications'
  | 'media' // camera / microphone (voice & video calls)
  | 'clipboard-read'
  | 'clipboard-sanitized-write'
  | 'fullscreen'
  | 'pointerLock'
  | 'geolocation';

/** One embeddable web application. Declarative only — no logic. */
export interface WorkspacePlugin {
  /** Stable id — used as the React key and the session-partition suffix. */
  id: string;
  /** Label shown in the workspace rail. */
  name: string;
  /** Emoji icon — fallback when the plugin declares no `brand.logo`. */
  icon: string;
  /** Colour + vector mark used to tell this app apart at a glance. */
  brand?: WorkspaceBrand;
  /** Home URL loaded when the workspace opens. */
  url: string;
  /** Small badge next to the name (e.g. "personal", "vpn"). */
  badge?: string;
  /** One-line description shown in the workspace header. */
  description?: string;
  /** Permissions this app is allowed to request (default: none extra). */
  permissions?: WorkspacePermission[];
  /** Keep the guest alive (in memory) when navigating to another tab. */
  keepAlive?: boolean;
  /** Optional User-Agent override for this workspace. */
  userAgent?: string;
  /**
   * Allow several independent accounts of this app at once — each gets its own
   * persistent session partition, so e.g. two Zalo accounts stay logged in side
   * by side. Accounts are managed at runtime (add / rename / remove).
   */
  multiAccount?: boolean;
  /**
   * Messaging apps: how the generic guest collector (lib/workspace/capture.ts)
   * should read this app's unread count and incoming messages. Declarative
   * knobs only — the script itself is shared by every app. Omit for a
   * non-messaging workspace: the count then comes from a "(N)" page title.
   */
  capture?: CaptureSpec;
  /**
   * Chỗ tìm ảnh đại diện của tài khoản đang đăng nhập, để rail hiện mặt thật
   * thay vì huy hiệu app chung chung (xem lib/workspace/avatar.ts). Bỏ trống
   * thì rail vẫn chạy, chỉ là mọi tài khoản cùng app trông giống hệt nhau.
   */
  avatar?: AvatarSpec;
  /**
   * Escape hatch: a raw JS expression returning the unread count, for a
   * workspace the generic collector cannot handle. Takes precedence over
   * `capture` but forfeits message capture (it returns a number, not a batch).
   */
  unreadScript?: string;
  /**
   * Chat apps: hints for reading this app's conversation list, so send targets
   * can be managed in DevBox instead of inside the app (see
   * lib/workspace/directory.ts). Declaring it (even as `{}`) is what puts the
   * "quét hội thoại" button on this workspace's toolbar — the heuristic runs
   * with or without selectors.
   */
  directory?: DirectorySpec;
  /**
   * Chat apps with their own label/category feature (Zalo: "Phân loại").
   * Filtering by a label the user already maintains is how a send-target list
   * stays small, human-curated and safe to key by name.
   */
  labels?: LabelSpec;
  /**
   * How to send a message as this account. Declaring it is what makes the
   * workspace available to the automation "gửi tin nhắn" action — a plugin
   * without it can never be written to.
   */
  send?: SendSpec;
}

/** Runtime knobs (from userData/workspace.config.json, merged over defaults). */
export interface WorkspaceConfig {
  /** Persist cookies/storage to disk so login survives restart. */
  persistSession: boolean;
  /** Only create a guest when its tab is first opened. */
  lazyLoad: boolean;
  /** Max concurrently-alive guests; least-recently-used are destroyed. */
  maxActiveWorkspace: number;
  /** Keep visited guests mounted (hidden) instead of destroying on leave. */
  keepAlive: boolean;
  /** Allow file downloads from workspaces. */
  allowDownload: boolean;
  /** Allow opening DevTools on a workspace guest. */
  enableDevTools: boolean;
}

/** The `window.workspace` bridge injected by electron/preload.cjs. */
export interface WorkspaceBridge {
  readonly isDesktop: true;
  /** Electron version string (diagnostics). */
  readonly version: string;
  /** Effective config resolved by the main process. */
  readonly config: WorkspaceConfig;
  /** Wipe cookies + storage + cache for a partition (the "Logout" action). */
  clearSession(partition: string): Promise<{ ok: boolean; error?: string }>;
  /** Kéo focus về host page sau khi hủy <webview> giữ focus (fix input "chết").
   *  Optional: preload cũ (trước khi có handler này) chưa expose. */
  focusHost?(): Promise<{ ok: boolean; error?: string }>;
  /** Tải ảnh bằng phiên của partition → data URL. Dùng cho ảnh đại diện tài
   *  khoản: avatar ở CDN khác gốc không kèm CORS nên trong guest fetch() và
   *  canvas đều chết; main process tải ở tầng mạng, không vướng CORS.
   *  Optional: preload cũ chưa expose. */
  fetchImage?(partition: string, url: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
  /** Bơm một phím THẬT vào guest của một partition (automation gửi tin Zalo:
   *  gõ chữ rồi nhấn Enter thật, vì ô soạn React bỏ qua sự kiện giả). Chỉ nhận
   *  phím trong danh sách trắng ở main. Optional: preload cũ chưa expose. */
  sendKey?(partition: string, keyCode: string): Promise<{ ok: boolean; error?: string }>;
  /** Mở URL bằng trình duyệt ngoài của máy (nút ↗ ở tab Google, link hướng dẫn
   *  trong panel lỗi mail). Optional: preload cũ chưa expose. */
  openExternal?(url: string): Promise<{ ok: boolean; error?: string }>;
  /** Bấm link trong tin nhắn Zalo/Telegram → main process hỏi mở ở tab Links
   *  hay tab Browser (components/OpenLinkDialog.tsx). Trả về hàm hủy đăng ký.
   *  Optional: preload cũ chưa expose. */
  onOpenRequest?(cb: (url: string) => void): () => void;
  /** window.open() từ chính UI DevBox → mở TRONG app thay vì Edge/Chrome; đích
   *  do defaultTargetFor() quyết định. Optional: preload cũ chưa expose. */
  onOpenInApp?(cb: (url: string) => void): () => void;
  /** Phím tắt khung app bấm khi con trỏ đang ở TRONG một <webview> (đang chat
   *  Zalo chẳng hạn): phím không bubble ra host page, main process bắt hộ rồi
   *  chuyển về đây. Trả về hàm hủy đăng ký. Optional: preload cũ chưa expose. */
  onShortcut?(cb: (name: 'quickTabs' | 'prevTab' | 'ultraView') => void): () => void;
  /** Niêm phong mật khẩu bằng safeStorage (DPAPI) trước khi ghi xuống đĩa.
   *  error='unavailable' khi OS không hỗ trợ → caller lưu plaintext + cảnh báo.
   *  Optional: preload cũ chưa expose. */
  encryptSecret?(plain: string): Promise<{ ok: boolean; value?: string; error?: string }>;
  /** Mở niêm phong để điền vào form login. Thất bại nếu file bị copy từ máy khác. */
  decryptSecret?(b64: string): Promise<{ ok: boolean; value?: string; error?: string }>;
  /** In HTML ra PDF bằng Chromium của app (tab Tools → Chuyển đổi file).
   *  Next server là process riêng nên không gọi Electron được — renderer làm
   *  cầu nối. Optional: preload cũ chưa expose, bản web thuần không có. */
  htmlToPdf?(html: string): Promise<{ ok: boolean; base64?: string; error?: string }>;
  /** Tab Remote: bật phần mềm điều khiển từ xa có sẵn trên máy (UltraViewer,
   *  mstsc, AnyDesk…). Renderer chỉ gửi `kind` + địa chỉ; đường dẫn .exe do
   *  main process tra trong bảng khai sẵn — xem electron/main.cjs.
   *  `manual: true` = client không nhận ID qua dòng lệnh, ID đã nằm sẵn trong
   *  clipboard để người dùng dán. Optional: preload cũ chưa expose. */
  openRemote?(payload: { kind: string; address: string; username?: string }):
    Promise<{ ok: boolean; manual?: boolean; error?: string }>;
  /** Chép chuỗi vào clipboard (nút chép mật khẩu ở tab Remote). */
  copyText?(text: string): Promise<{ ok: boolean; error?: string }>;
  /** Zalo API (thử nghiệm): đọc cookie HttpOnly của một phiên `zaloapi-*` —
   *  zpsid/zpw_sek/… mà renderer không thấy qua document.cookie. Optional:
   *  preload cũ chưa expose. */
  readZaloCookies?(
    partition: string,
    names?: string[],
  ): Promise<{
    ok: boolean;
    cookies?: Record<string, string>;
    /** Toàn bộ cookie đã ghép "name=value; …" — bước đăng nhập server cần nguyên chuỗi này. */
    header?: string;
    seen?: string[];
    error?: string;
  }>;
}

/** Minimal surface of an Electron <webview> element we actually drive. */
export interface WebviewElement extends HTMLElement {
  src: string;
  reload(): void;
  reloadIgnoringCache(): void;
  stop(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  getTitle(): string;
  loadURL(url: string): Promise<void>;
  openDevTools(): void;
  closeDevTools(): void;
  /** Run code in the guest page and resolve with its result. */
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  /** Zoom của guest (1 = 100%). Là thuộc tính của guest → set lại sau mỗi lần
   *  điều hướng. Dùng để thu nhỏ trang consent Google cho vừa khung. */
  setZoomFactor(factor: number): void;
  getZoomFactor(): number;
}

declare global {
  interface Window {
    /** Present only when running inside the Electron desktop shell. */
    workspace?: WorkspaceBridge;
  }
}

// The <webview> JSX intrinsic + its src/partition/allowpopups/useragent props are
// already declared by React's own WebViewHTMLAttributes — no augmentation needed.
// We set those as initial attributes (partition MUST exist before attach) and
// drive the rest imperatively through a WebviewElement ref.

export {};
