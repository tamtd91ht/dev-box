# Browser Workspace Framework

Embed **real web applications** — Zalo cá nhân, Grafana, Kibana, Jenkins, GitLab, an internal
admin — as first-class **workspaces** inside VHS DevBox. Each workspace is a genuine browser
context (an Electron `<webview>`, **not** an iframe, **not** reverse-engineered) with its **own
persistent login session** stored on your machine. Log in once (scan the QR for Zalo) and it
survives restarts.

Zalo and Telegram are simply the **first two plugins** — the framework itself knows nothing about
any specific site.

## Why it needs the desktop app

A cross-origin iframe cannot host apps like `chat.zalo.me`: the browser partitions 3rd-party
`SharedWorker` / `localStorage` / `IndexedDB`, so the app stalls at the splash screen. A real,
persistent, per-workspace browser profile is only possible in a desktop shell. DevBox therefore
runs as an Electron app for this tab; every other tab (Redis/Kafka/Mongo/…) is unchanged, and in a
plain browser the Workspace tab shows a short "run the desktop app" note instead of an error.

## Run it

One command — the Electron shell starts the Next.js dev server itself:

```bash
npm run desktop   # boots next dev if :3000 is free, then opens the window
```

The server is shut down when you close the app. If you prefer to run the dev
server yourself (e.g. to watch its logs in a dedicated terminal), start it first
and `npm run desktop` will detect and reuse it instead of starting a second one:

```bash
npm run dev       # terminal 1 — optional; the app reuses it if already running
npm run desktop   # terminal 2
```

Point at a remote/staging build instead by setting `DESKTOP_URL` — then no dev
server is started.

Login sessions live under `data/browser/` (gitignored). "Đăng xuất" (⎋) wipes a single
workspace's session; deleting `data/browser/` wipes them all.

## Add a workspace (no engine code)

A plugin is a pure declaration. Append to `lib/workspace/plugins.ts`:

```ts
{ id: 'grafana', name: 'Grafana', icon: '📊', url: 'https://grafana.internal/', badge: 'vpn' }
```

| Field         | Meaning                                                        |
| ------------- | ------------------------------------------------------------- |
| `id`           | Stable key + session-partition suffix (`persist:ws-<id>-<account>`). |
| `url`          | Home URL — the only place a workspace URL is hardcoded.       |
| `brand`        | `{ color, logo }` — accent + built-in vector mark (see below). |
| `permissions`  | Extra web APIs the site may request (default: none extra).   |
| `keepAlive`    | Keep the guest in memory when you switch away (e.g. Zalo).    |
| `multiAccount` | Allow several independent accounts of this app at once.      |
| `capture`      | Declarative knobs for the shared collector (unread + messages). |
| `directory`    | Gợi ý đọc danh sách hội thoại (bật nút 🔎 quét trên thanh công cụ). |
| `userAgent`    | Optional User-Agent override.                                |

Allowed `permissions`: `notifications`, `media` (mic/cam for calls), `clipboard-read`,
`clipboard-sanitized-write`, `fullscreen`, `pointerLock`, `geolocation`. Anything not requested is
denied by the engine (screen capture, HID/serial/USB, MIDI are never granted).

## Brand identity — one rail, several apps

Zalo and Telegram share the rail but are **never** partitioned together: each account of each
plugin already has its own session (`persist:ws-{pluginId}-{instanceId}`), so no cookie, storage
or login is shared. What the UI has to solve is telling them apart *at a glance* — reading a label
is too slow when you have four accounts stacked.

So a plugin declares `brand: { color, logo }` and every surface uses it:

- `components/BrandMark.tsx` draws the real vector mark (`zalo` · `telegram` · `whatsapp`,
  emoji `icon` as fallback) — on the plugin row, on each account chip, in the toolbar.
- The accent colour tints the active row, the account avatar ring and the unread bubble, so an
  incoming Telegram message reads blue-cyan and Zalo reads blue-royal without any text.

A new app needs one entry with its colour + (optionally) one more `logo` case — no engine change.

## Multiple accounts

A plugin marked `multiAccount: true` (Zalo and Telegram both are) can hold several accounts at
once, each a fully independent browser session with its own persistent partition
(`persist:ws-{plugin}-<account>`) — so two Zalo accounts, or a Zalo and a Telegram, stay logged in
side by side. Add / rename / remove accounts from the rail; the list is
remembered per machine (`localStorage` under `data/browser/`). Removing an account also wipes its
on-disk session. Single-account plugins just have one implicit account.

## New-message alerts

Each workspace reports its unread count from the shared collector — the page title (`(N) Zalo`,
`(N) Telegram`), the Web Notification API and a DOM badge scan, in that order of trust. That
drives a red bubble on the account and — key point — a red **🔔 bell + count on the top-level 🧭
Workspace tab itself**, so a message arriving while you sit on the Git / Redis / Kafka / … tab is
impossible to miss. While the Workspace tab is *not* the active one, the bell **swings** and the whole
tab gives a periodic **shake + glow**; open the tab and it settles. It also updates the window /
taskbar title (`(N) VHS DevBox`) and rings a short chime when the total goes up. The 🔔/🔕 button in
the rail header mutes the chime (remembered); the visual bell/shake always shows.
Because visited workspaces stay mounted and background throttling is disabled, alerts keep working
while you are on another tab. Zalo's own OS notifications also fire (the `notifications` permission is
granted), giving a system toast + sound even when the window is in the background.

## Message capture → Automation

The same collector that counts unread can hand each message to the
[Automation engine](../automation/README.md) as a `social` event. It is **one generic script**
(`capture.ts`) that hooks the two universal signals every chat web app has — `new Notification()`
*and* `ServiceWorkerRegistration.showNotification()` (PWAs like Telegram/WhatsApp use the latter)
— plus a DOM badge scan. A plugin tunes it declaratively (`capture: { genericTitles,
bodySenderSeparator, extraScript, disableBadgeScan }`); it never forks the script.

Privacy is enforced **inside the guest**: message text is recorded only while the page-level flag
`window.__wsCap` is true, and the renderer sets that flag from the automation config's
`captureEnabled` switch — which is **OFF by default**. With capture off the guest counts unread
and stores nothing at all. `storeMessageText: false` additionally reduces what is kept to `••••`.

### Thu tin khi ở tab khác — đọc DOM thay vì chờ thông báo (Zalo)

Đo được: khi tab Workspace KHÔNG phải tab đang mở, webview Zalo ở nền và Zalo **ngừng bắn**
`new Notification`, nên collector (chỉ nghe thông báo) không bắt được tin cho tới khi quay lại tab
Workspace. Vì automation phải chạy nền (người dùng ở tab Kafka/Redis…), điều này làm hỏng mục đích.

Chữa: Zalo có thêm `extraScript` **đọc thẳng danh sách hội thoại** (`.conv-item`) mỗi nhịp poll,
không phụ thuộc thông báo. Ba điểm cốt để không bắn sai:
- danh sách là react-virtualized, ở nền render 0 dòng → CHỈ khi 0 dòng thì cuộn về đầu + phát
  `scroll` cho nhịp sau render (không phá cuộn của người đang xem);
- chữ ký so sánh **bỏ thời gian + số chưa đọc** (không thì mỗi phút lại tưởng có tin mới);
- nhịp đầu chỉ ghi mốc; bỏ tin của mình (`Bạn:`); bỏ hội thoại vừa có thông báo (`__wsNotiByConv`,
  tránh tính hai lần). Trùng còn lại do engine dedup theo id sự kiện.

Thông báo vẫn là kênh chính khi tab Workspace mở; DOM là kênh bù khi ở tab khác.

### Gửi tin làm chết việc thu tin — và cách chữa (`alwaysUnfocused`)

Đo được, không phải suy đoán: **không** chạy action gửi thì mọi tin đều khớp rule; **có** gửi một
lần thì các tin sau không vào rule nữa — kể cả hội thoại khác.

Nguyên nhân: để gửi, script phải **bấm chuột vào trang Zalo**. App chat chỉ bắn thông báo khi tin
rằng **không ai đang ngồi đó**; vừa có tương tác là nó coi người dùng đang dùng app và **ngừng bắn
thông báo** — mà thông báo là kênh **duy nhất** nội dung tin đi vào engine.

Chữa bằng đòn bẩy hẹp nhất: ghi đè `document.hasFocus()` để trang **luôn** tin là không ai xem.
Không giả `visibilityState` vì cái đó còn bóp timer và ảnh hưởng đánh dấu đã đọc. Giá trị thật giữ
ở `window.__wsRealHasFocus` để tab 🔬 Thu tin vẫn nói được sự thật — che mà giấu luôn thì lần sau
lại mất thêm một buổi đi tìm.

Bật theo plugin (`capture.alwaysUnfocused`), hiện chỉ Zalo. Telegram/WhatsApp không bị đụng tới.

### Chẩn đoán: tab 🔬 Thu tin (`components/automation/CapturePanel.tsx`)

Một tin đi qua 4 chặng — ① app bắn thông báo → ② hook bắt → ③ poll hút → ④ engine đánh giá — và
hỏng ở chặng nào cũng **im lặng y hệt nhau**. Panel đọc thẳng counter của collector:
`hook bắt được` (số lần hook chạy), `đang chờ hút`, `quyền thông báo`, `app thấy focus`, và 10 lần
bắt gần nhất (thời điểm + người gửi + hội thoại, **không** có nội dung).

`hook bắt được` đứng yên khi bạn nhắn ⇒ chặng ① chết, sửa engine bao nhiêu cũng vô ích.

## Guest bridge + conversation directory (đang dựng)

Một `<webview>` chỉ điều khiển được từ component giữ ref của nó, trong khi thứ *muốn* điều khiển
(automation) lại nằm ngoài cây đó. `guests.ts` là chỗ duy nhất ánh xạ `accountKey` (`zalo::a3f1c`)
→ guest đang sống, kèm `exec(script)`. `WorkspaceView` đăng ký lúc mount, huỷ lúc unmount.

⚠ Pane Workspace chỉ mount **sau khi tab được mở lần đầu** trong phiên (`visited.workspace` ở
`app/page.tsx`). Chưa mở tab lần nào thì không có guest nào — `requireGuest()` trả về đúng câu đó
thay vì im lặng không làm gì.

`directory.ts` đọc **danh sách hội thoại** của app để dựng danh bạ đích gửi **bên ngoài** app chat
(quản lý trong DevBox, không phải ghim trong khung Zalo). Script không biết gì về Zalo: thử
selector plugin khai trước, không khớp thì tự tìm theo cách người ta nhìn — cột hẹp bên trái gồm
nhiều dòng giống nhau có chữ — rồi **cuộn từng nấc** vì danh sách nào cũng ảo hoá. Mỗi dòng trả về
mọi thuộc tính dạng id (của chính nó và 2 cấp cha), vài đoạn text đầu, số ảnh, kèm HTML thô của
một dòng mẫu — đủ để biết app có lộ **id ổn định** hay chỉ có tên hiển thị.

Nút 🔎 trên thanh công cụ workspace (hiện khi plugin khai `directory`) mở
`components/WorkspaceScan.tsx`: quét, hiện bảng, và cho chép JSON thô. Chỉ đọc — chưa lưu gì.
Đoán sai khối thì bảng chẩn đoán có nút **dùng khối này** để tự chỉ lại, không cần sửa code.

### Đã đo được ở chat.zalo.me (2026-08)

| Thứ | Giá trị |
|---|---|
| Danh sách | `.ReactVirtualized__Grid__innerScrollContainer` — react-virtualized, **~13 dòng** tồn tại trong DOM một lúc, tổng cao ~9000px |
| Khối cuộn | `.ReactVirtualized__Grid` bọc ngoài. `nav.flx.h100` bao ngoài cùng là `overflow:hidden` → đặt `scrollTop` lên nó **không nhúc nhích** |
| Dòng | `.conv-item` — **đúng token class**. `[class*="conv-item"]` khớp luôn `conv-item__avatar`, `conv-item-title__name`… → 1 hội thoại nở thành 4-5 dòng rác |
| Tên | `.conv-item-title__name`. Text node đầu tiên của dòng là **giờ** ("30/07", "26 phút") hoặc tiền tố xem trước ("Bạn:") |
| id hội thoại | Không có trong thuộc tính dòng (mọi dòng chung `data-id="div_TabMsg_ThrdChItem"` — mã component). **Nhưng** `.conv-item__avatar img[id]` mang **id Zalo thật**; chỉ tin khi dòng có ĐÚNG một avatar, vì ảnh ghép của nhóm mang id từng thành viên |
| Nhóm vs cá nhân | `.zavatar-multi` (ảnh ghép). Nhóm đặt avatar riêng vẫn bị đoán nhầm thành cá nhân — chỉ là gợi ý |
| Vị trí cuộn | Danh sách giữ nguyên chỗ người dùng để lại → **phải về đầu trước khi quét**, nếu không mất sạch phần phía trên mà vẫn báo `complete: true` |
| Phân loại | Có nút **"Phân loại"** ở ~(283,102). Tìm theo **chữ**, không theo đường dẫn: class của Zalo là chuỗi tiện ích (`flx`, `flx-al-c`…) nên path đổi theo mọi thay đổi bố cục |
| Nhóm vs cá nhân (bổ sung) | Tiền tố người gửi trong dòng xem trước (`"QuiDN:"`) ⇒ nhóm; `"Bạn:"` không kết luận được gì |

`labels.ts` là bộ dò **tự mô tả** cho menu Phân loại: bấm nút, so sánh cây DOM trước/sau, báo về đúng
những phần tử vừa hiện ra kèm HTML của popup — rồi Esc để đóng. Viết selector mò cho một menu chưa
nhìn thấy chính là thứ đã tốn ba vòng ở danh sách hội thoại; bộ dò này để không lặp lại.

### Menu Phân loại (đo được)

```
div.popover-v3 > div.zmenu-body.expand > div.zl-scroll-menu > div.expand
  ├ span[data-translate-inner="STR_FILTER_BY_TAG"]        "Theo thẻ phân loại"
  └ div-14.zmenu-item[data-id="div_DetailLabelList_Label"]   ← MỘT NHÃN
      ├ div[data-id="div_MiniLabelList_LabelCheckbox"]        ô tick
      ├ i.fa-Tag_24_Filled                                    màu nhãn
      └ div[data-id="div_MiniLabelList_Label"]                tên nhãn
```

Bên trong popup bám `data-id` (mã component, ổn định) chứ không bám class. Mỗi nhãn là **ô tick**
nên `buildLabelScanScript` bật lọc → đọc danh sách ngắn → **bấm lại để tắt**; `restored: false`
nghĩa là Zalo còn đang bị lọc và UI phải nói ra.

⚠ React StrictMode gọi effect **hai lần** ở dev — hai lần quét chạy song song cùng cuộn một danh
sách ảo hoá thì kết quả lộn xộn (đầu danh sách bị ghép vào cuối). `WorkspaceScan` giữ một token
chạy để bỏ kết quả cũ.

## Layout

```
lib/workspace/
  types.ts      shared types (plugin, brand, config, bridge, webview) + JSX/Window augmentation
  plugins.ts    the plugin registry (declarations only) — Zalo, Telegram, WhatsApp (commented)
  guests.ts     accountKey → guest đang sống (exec script từ ngoài cây workspace)
  directory.ts  đọc danh sách hội thoại (spec khai báo + heuristic + cuộn) → danh bạ đích
  config.ts     defaults, isDesktop(), resolveConfig()
  accounts.ts   multi-account instances (per-account partition) + persistence
  capture.ts    the generic guest collector (unread + messages) + CaptureSpec
components/
  BrowserWorkspace.tsx   Workspace Manager — rail, accounts, LRU mount-and-keep, unread + chime
  WorkspaceView.tsx      one account — <webview> + toolbar + loading/failed/crashed + collector poll
  BrandMark.tsx          built-in vector marks (zalo · telegram · whatsapp), emoji fallback
electron/
  main.cjs      Browser Engine — window, webview hardening, permissions, downloads, logging, clearSession
  preload.cjs   contextBridge → window.workspace { isDesktop, version, config, clearSession }
```

The three layers — Browser Engine (`electron/`), Workspace Manager + UI (`components/`), and the
plugin declarations (`lib/workspace/plugins.ts`) — are independent. Nothing is hardcoded per site.

## Config

Runtime knobs default in `lib/workspace/config.ts` and may be overridden by
`data/browser/workspace.config.json` (read by the main process, handed to the renderer via
`window.workspace.config`):

| Key                  | Default | Meaning                                             |
| -------------------- | ------- | --------------------------------------------------- |
| `persistSession`     | `true`  | Persist cookies/storage to disk (login survives).   |
| `lazyLoad`           | `true`  | Only create a guest when its workspace is opened.   |
| `maxActiveWorkspace` | `3`     | Max alive guests; least-recently-used are evicted.  |
| `keepAlive`          | `true`  | Keep visited guests mounted (hidden) on switch.     |
| `allowDownload`      | `true`  | Allow file downloads from workspaces.               |
| `enableDevTools`     | `false` | Show a DevTools button on the workspace toolbar.    |

Per-plugin `keepAlive: true` pins a workspace in memory even past the LRU cap (Zalo keeps
receiving messages in the background).

## Non-goals

No per-site AI, no changing site behaviour, no replacement UIs, no automated sending. The framework
embeds sites as-is and manages their sessions; the only thing it reads out is the notification
stream the app already shows you, and only when you switch capture on. Acting on that stream is the
Automation engine's job — and even there, `reply` is a proposal for a human, never a silent send.
