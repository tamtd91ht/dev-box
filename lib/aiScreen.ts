// Trợ lý AI — "tay và mắt" trên giao diện Dev Box (chạy ở renderer).
//
// Trợ lý vẫn là một lượt `claude -p` KHÔNG công cụ (lib/aiChatServer.ts). Muốn
// nó thao tác được màn hình như Claude in Chrome, ta tự làm vòng lặp: model trả
// về MỘT khối <hanh_dong>{…}</hanh_dong>, components/AiChat.tsx gọi các hàm ở
// đây để thực hiện ngay trong trang, rồi gửi kết quả (ảnh chụp chữ của màn
// hình) cho lượt hỏi kế tiếp.
//
// GIỚI HẠN CỐ Ý — đây là toàn bộ những gì trợ lý làm được, không hơn:
//   · open_tab    — chuyển tab của app (như bấm menu).
//   · read_screen — đọc CHỮ đang hiện ở pane đang xem + danh sách phần tử bấm được.
//   · click       — bấm một phần tử trong danh sách đó. Tab / tab con thì bấm
//                   luôn; MỌI nút khác phải được người dùng bấm "Cho phép" trong
//                   bảng chat trước (AiChat lo phần hỏi) — vì nút có thể là Xoá,
//                   Gửi, Chạy…
// Không gõ phím, không điền form, không chạy lệnh, không đọc/ghi file, không
// chạm vào chính bảng trợ lý. Trang web nhúng (<webview> Zalo, Browser…) vẽ ở
// tầng native nên không đọc và không bấm được.
// Chữ đọc từ màn hình là DỮ LIỆU không tin được (mail, tin nhắn, log… có thể
// chứa câu "hãy bấm nút X") — system prompt dặn model không làm theo, và chốt
// chặn thật là bước xin phép ở trên.

export type AiAction =
  | { type: 'open_tab'; tab: string }
  | { type: 'read_screen' }
  | { type: 'click'; n: number };

export interface AiTab { key: string; label: string }

const MAX_TEXT = 12_000;
const MAX_ITEMS = 120;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Phần tử bấm được của lần đọc màn hình gần nhất — `click n` trỏ vào đây. */
let lastItems: { el: HTMLElement; label: string; tab: boolean }[] = [];

/** Khối hành động ở cuối câu trả lời của model (nếu có). */
export function parseAction(raw: string): AiAction | null {
  const m = /<hanh_dong>\s*(\{[\s\S]*?\})\s*<\/hanh_dong>/.exec(raw);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]) as Record<string, unknown>;
    if (o.type === 'open_tab' && typeof o.tab === 'string') return { type: 'open_tab', tab: o.tab };
    if (o.type === 'read_screen') return { type: 'read_screen' };
    if (o.type === 'click' && Number.isInteger(o.n)) return { type: 'click', n: Number(o.n) };
  } catch { /* JSON hỏng → coi như không có hành động */ }
  return null;
}

/** Bỏ khối hành động (kể cả đang stream dở) khỏi phần chữ hiện cho người dùng. */
export const stripAction = (raw: string) => raw.replace(/<hanh_dong[\s\S]*$/, '').trimEnd();

/** Pane đang hiện (không tính bảng trợ lý). Ultra View nhiều pane → pane đầu. */
function visiblePane(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.body > main.workspace:not([aria-hidden="true"])');
}

const isShown = (el: HTMLElement) => el.offsetParent !== null && el.getClientRects().length > 0;

function labelOf(el: HTMLElement): string {
  const clean = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, ' ').trim();
  const text = clean(el.getAttribute('aria-label')) || clean(el.innerText) || clean((el as HTMLInputElement).value);
  const title = clean(el.getAttribute('title'));
  // Nút chỉ có biểu tượng (↻, ✕, ⚙…): kèm tooltip để cả model lẫn người dùng
  // (lúc được hỏi "Cho phép bấm?") hiểu nút đó làm gì.
  const t = text.length <= 2 && title && title !== text ? `${text} (${title})`.trim() : text || title;
  return t.slice(0, 80);
}

const isTab = (el: HTMLElement) =>
  el.getAttribute('role') === 'tab' || !!el.closest('[role="tablist"]');

/** Chờ màn hình "yên": hết chữ Đang tải… và độ dài chữ đứng im hai nhịp liền. */
async function settle(maxMs = 8000): Promise<void> {
  const t0 = Date.now();
  let prev = -1;
  let same = 0;
  while (Date.now() - t0 < maxMs) {
    await sleep(350);
    const text = visiblePane()?.innerText ?? '';
    const loading = /^\s*Đang tải…?\s*$/.test(text) || text.trim() === '';
    if (!loading && text.length === prev) { same += 1; if (same >= 2) return; } else same = 0;
    prev = text.length;
  }
}

/** Ảnh chụp CHỮ của pane đang xem + danh sách phần tử bấm được (đánh số). */
export function snapshot(screenName: string): string {
  const pane = visiblePane();
  if (!pane) { lastItems = []; return `Màn hình: ${screenName}\n(Không tìm thấy vùng nội dung.)`; }

  let text = pane.innerText.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const cut = text.length > MAX_TEXT;
  if (cut) text = text.slice(0, MAX_TEXT);

  const items: typeof lastItems = [];
  for (const el of pane.querySelectorAll<HTMLElement>('button, a[href], [role="tab"], [role="button"], summary')) {
    if (items.length >= MAX_ITEMS) break;
    if (!isShown(el) || (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;
    const label = labelOf(el);
    if (!label) continue;
    items.push({ el, label, tab: isTab(el) });
  }
  lastItems = items;

  const notes: string[] = [];
  if (pane.querySelector('webview')) notes.push('Màn hình này có trang web nhúng (Zalo, trình duyệt…) — nội dung bên trong KHÔNG đọc và không bấm được.');
  if (pane.querySelector('canvas, .xterm, .monaco-editor')) notes.push('Có vùng vẽ riêng (terminal / editor / bảng tính) — chữ trong đó có thể không đọc được đầy đủ.');
  if (cut) notes.push(`Chữ trên màn hình dài hơn ${MAX_TEXT} ký tự — đã cắt bớt phần sau.`);

  return [
    `Màn hình: ${screenName}`,
    notes.length ? notes.map((n) => `(${n})`).join('\n') : '',
    '--- Chữ đang hiện ---',
    text || '(trống)',
    '--- Phần tử bấm được (dùng số trong ngoặc cho hành động click) ---',
    items.length
      ? items.map((it, i) => `[${i + 1}] ${it.label}${it.tab ? ' (tab)' : ''}`).join('\n')
      : '(không có)',
  ].filter(Boolean).join('\n');
}

export interface ActionHost {
  tabs: AiTab[];
  /** Tên màn hình đang mở (đọc lại sau mỗi hành động). */
  screenName: () => string;
  /** Hỏi người dùng trước khi bấm một nút không phải tab. */
  confirmClick: (label: string) => Promise<boolean>;
}

/** Nhãn ngắn hiện trên bảng chat cho từng bước. */
export function describeAction(a: AiAction, tabs: AiTab[]): string {
  if (a.type === 'open_tab') return `Mở tab ${tabs.find((t) => t.key === a.tab)?.label ?? a.tab}`;
  if (a.type === 'read_screen') return 'Đọc màn hình';
  return `Bấm “${lastItems[a.n - 1]?.label ?? `#${a.n}`}”`;
}

/** Câu mở đầu kết quả khi người dùng từ chối một cú bấm — AiChat dựa vào để đánh dấu bước. */
export const DENIED = 'Người dùng KHÔNG cho phép';

/** Thực hiện một hành động; trả về chữ kết quả gửi lại cho model. Không ném lỗi. */
export async function runAction(a: AiAction, host: ActionHost): Promise<string> {
  try {
    if (a.type === 'open_tab') {
      const tab = host.tabs.find((t) => t.key === a.tab);
      if (!tab) return `Không có tab "${a.tab}". Các tab hợp lệ: ${host.tabs.map((t) => t.key).join(', ')}.`;
      window.dispatchEvent(new CustomEvent<string>('devbox:open-tab', { detail: tab.key }));
      await settle();
      return `Đã mở tab ${tab.label}.\n${snapshot(host.screenName())}`;
    }
    if (a.type === 'read_screen') {
      await settle(2500);
      return snapshot(host.screenName());
    }
    const it = lastItems[a.n - 1];
    if (!it || !it.el.isConnected || !isShown(it.el)) {
      return `Không còn phần tử số ${a.n} trên màn hình (màn hình đã đổi). Đọc lại màn hình rồi chọn lại.\n${snapshot(host.screenName())}`;
    }
    if (!it.tab && !(await host.confirmClick(it.label))) {
      return `${DENIED} bấm “${it.label}”. Đừng thử bấm lại nút này; trả lời với những gì đã có hoặc hỏi người dùng.`;
    }
    it.el.click();
    await settle();
    return `Đã bấm “${it.label}”.\n${snapshot(host.screenName())}`;
  } catch (e) {
    return `Hành động lỗi: ${(e as Error).message}`;
  }
}
