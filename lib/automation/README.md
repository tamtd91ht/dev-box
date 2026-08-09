# Automation Engine

Một engine, nhiều **nhóm tính năng**. Mọi nguồn (tin nhắn Zalo/Telegram, chỉ số Redis/Mongo/ES…)
đều được chuẩn hoá về **một** kiểu sự kiện, nên một quy tắc viết cho Zalo và một quy tắc viết cho
"Redis RAM > 80%" chạy qua đúng cùng một đoạn code.

```
nguồn → AutomationEvent → trigger → scope → khung giờ → điều kiện → giới hạn → hành động
```

Phạm vi của nhóm `social` có **ba tầng**: ứng dụng (Zalo/Telegram) → tài khoản → **hội thoại**.
Tầng thứ ba giới hạn theo **tên** hội thoại (nhóm hoặc chat 1-1), so khớp bỏ qua hoa/thường và
khoảng trắng thừa. Trình soạn quy tắc gợi ý sẵn tên từ danh bạ đã lưu (`configs/wstargets.json`),
và vẫn gõ tay được tên bất kỳ.

Sự kiện `message.received` mang sẵn:

| Trường | Nghĩa |
|---|---|
| `conversation` | Tên nhóm, hoặc tên người khi chat 1-1 |
| `sender` | Người vừa nhắn. Trong chat 1-1 nó **trùng** `conversation` |
| `chatType` | `group` hay `user` — suy ra từ việc `sender` có khác `conversation` không |
| `text` · `title` | Nội dung · tiêu đề (nhóm hiện tên nhóm, 1-1 hiện tên người) |

Tất cả dùng được ở **cả điều kiện lẫn `{{template}}`**: `{{conversation}}`, `{{sender}}`,
`{{chatType}}`. Muốn "chỉ tin trong nhóm" thì thêm điều kiện `chatType bằng group` — khỏi phải
đoán bằng cách so tên.

| Nhóm | Nguồn | Trigger |
|---|---|---|
| 💬 `social` | workspace nhắn tin (Zalo, Telegram, WhatsApp… — `lib/workspace`) | `message.received` |
| 📡 `infra` | watch trên registry kết nối DevBox (Mongo · Redis · ES · Kafka · Rabbit · PG) | `infra.metric` · `infra.recovered` |
| ⚙ `system` | chính app (dành sẵn: lịch, vòng đời app) | `system.test` |

Thêm một nhóm/nguồn mới = thêm entry trong `catalog.ts` + một adapter trong `sources/` —
**không** phải sửa UI.

## File

| File | Vai trò |
|---|---|
| `types.ts` | Mô hình: event · rule · action · watch · config (`AutomationConfig`) |
| `catalog.ts` | Dữ liệu UI tự dựng lên: nhóm, trigger, field so khớp, toán tử, metric mỗi stack |
| `match.ts` | Đánh giá điều kiện + render `{{template}}` (thuần, không side effect) |
| `engine.ts` | Pipeline ở trên → `ActionPlan[]` + `RuleDecision[]` (thuần + state nhỏ: dedupe/cooldown/rate) |
| `normalize.ts` | Parse phòng thủ config sửa tay / POST vào; `MIN_WATCH_INTERVAL_SEC = 15` |
| `sources/social.ts` | 1 tin bắt được → `AutomationEvent` (id = hash nội dung → gửi lại không nhân đôi) |
| `sources/infra.ts` | 6 probe adapter → `MetricMap` phẳng + dựng event breach/recovered |
| `watcher.ts` | Runner: **một** tick 2s, mỗi watch có `nextDue` riêng |
| `runtime.ts` | Singleton phía renderer: config, lịch sử bắn, activity feed, toast stream |
| `store.ts` | Lưu đĩa phía server (`.automation.json`) + append log (`.automation-log.jsonl`) |
| `telegram.ts` | **Server only**: đọc bot trong `.env.local` + client Bot API (không throw, xoá token khỏi lỗi) |
| `connections.ts` | Nạp danh sách kết nối theo stack cho editor (memo hoá, không bao giờ throw) |
| `useAutomation.ts` | `useAutomation()` / `useWatcher()` qua `useSyncExternalStore` |

UI: `components/automation/*` (tab 🤖 Automation) · `components/AutomationHost.tsx` (runner + toast,
gắn **ngoài** mọi pane nên chạy ở bất kỳ tab nào; `ActionCard.tsx` = form của từng hành động) ·
API: `app/api/automation/{route,dispatch/route,telegram/route}.ts`.

## Công tắc an toàn (mặc định)

| Công tắc | Mặc định | Ý nghĩa |
|---|---|---|
| `enabled` | **ON** | Kill switch tổng — tắt là không quy tắc nào chạy |
| `captureEnabled` | **OFF** | Social: có được đọc nội dung tin hay không |
| `storeMessageText` | ON | Tắt = activity/log chỉ giữ `••••` |
| `watchEnabled` | **OFF** | Infra: có chạy poller đo chỉ số hay không |
| `allowSend` | **OFF** | Mở khoá 💬 `wsSend` (gửi THẬT, tự động) và `reply` (chờ duyệt) |
| `loopGuard` | **ON** | Bỏ qua tin do chính automation vừa gửi (`loopGuardSec`, mặc định 300s) |
| `osNotify` | **rỗng** | Nhóm nào được bắn thông báo hệ điều hành — mặc định không nhóm nào |
| `rule.dryRun` | **ON** cho quy tắc mới | Đánh giá + ghi nhận, không thực thi |

`reply` **không bao giờ tự gửi**: kết quả chỉ là `pending-approval` (khi `allowSend`) hoặc
`skipped`. Gửi tự động trên tài khoản cá nhân chính là thứ làm account bị khoá.

Dry-run vẫn hiện toast cho `notify` — đó chính là mục đích của chạy thử: xem quy tắc *sẽ nói gì*
mà không có side effect ra ngoài.

## Chặn vòng lặp (`loopGuard`)

Quy tắc gửi Zalo vào một nhóm mà **một tài khoản Zalo khác trong workspace cũng ở trong đó** → tài
khoản kia bắt được như tin đến → quy tắc bắn tiếp → hai bên ping-pong. Cooldown từng quy tắc
**không** cứu được, vì mỗi vòng là một tin thật sự mới với một tài khoản khác. Chuyện này đã xảy ra:
nội dung phình dần thành `[Automation] [Automation] [Automation]…`.

Cách nhận diện: **automation nhớ chính xác tin nó vừa gửi** — hội thoại nào, nội dung gì, lúc nào —
và bỏ tin đến khớp với một bản ghi đó. Không phụ thuộc vào bất cứ thứ gì sống sót qua vòng đi-về
của app.

Vì sao KHÔNG dùng dấu vô hình (đã thử, thất bại): mọi tin gửi đi được đóng dấu zero-width, nhưng
**Zalo xoá ký tự vô hình** trước khi tin quay lại — dấu về tới nơi đã sạch, không nhận ra được. Giữ
lại `hasMark` như một lớp phụ (phòng app nào giữ dấu), nhưng bản ghi mới là lớp chính.

Ba tính chất giữ cho nó chặn ĐÚNG tiếng vọng mà không chặn nhầm tin thật:

1. **Khớp chính xác** (chuẩn hoá khoảng trắng + chữ thường, cắt tiền tố người gửi) — không "chứa"
   hay "tiền tố", nên `automation 155` không còn nuốt `automation 1556`.
2. **Cùng hội thoại** — tiếng vọng quay về đúng hội thoại đã gửi tới; cùng nội dung ở nhóm khác
   không bị chặn.
3. **Tiêu thụ một lần + cửa sổ 120s** — mỗi tin gửi chỉ chặn ĐÚNG một tiếng vọng của nó rồi xoá bản
   ghi. Người dùng gõ lại y hệt câu đó (sau khi tiếng vọng đã bị tiêu thụ, hoặc quá 120s) vẫn
   trigger bình thường. Đây là điểm sửa dứt các bug cũ: trước đây cửa sổ dài + không tiêu thụ nên
   chặn mãi.

Bản ghi chỉ tạo khi `loopGuard` bật và **không** tạo lúc chạy thử. Sự kiện bị chặn vẫn hiện trong
tab Hoạt động với lý do `echo` (⛔ chặn vòng lặp) — không im lặng. Tin nhắn gửi đi giờ **sạch**,
không còn nhét ký tự vô hình vào tin của người dùng.

Sự kiện bị chặn **vẫn hiện trong tab Hoạt động** với lý do `tin do chính automation gửi (chặn vòng
lặp)` — im lặng bỏ qua thì đúng là cách tệ nhất để người dùng biết có chốt chặn.

## Thông báo hệ điều hành (`osNotify`)

**Tắt hết theo mặc định.** Mỗi lần bắn là một cửa sổ Electron riêng, nằm ngoài app và sống lâu hơn
app; lúc dính vòng lặp thì nó phủ kín màn hình. Toast trong app mang đúng nội dung đó, nằm cạnh tab
Hoạt động giải thích vì sao nó hiện, và tắt cùng cửa sổ.

Bật lại **theo từng nhóm** bằng hàng chip ở đầu tab Automation (💬 Social · 🖥 Infrastructure ·
🧪 System). Thông báo do host hệ thống phát (vd tự pull Git) đi theo cài đặt của nhóm `system`.

## Hành động

| Loại | Chạy ở đâu | Ghi chú |
|---|---|---|
| `notify` | renderer | Toast trong app + OS Notification; `urgent` không tự tắt |
| `webhook` | **server** (`/api/automation/dispatch`) | **Gọi API** — xem dưới |
| `telegram` | **server** | **Gửi Telegram** — xem dưới |
| `wsSend` | **renderer** → guest Zalo | **Gửi Zalo** bằng chính tài khoản đang đăng nhập — xem dưới |
| `log` | **server** | Append JSON-lines, mặc định `.automation-log.jsonl` |
| `kafka` | renderer → `/api/kafka` | Dùng đúng connection đã lưu trong DevBox |
| `reply` | — | Chỉ đề xuất, xem ở trên |

Body/key/value hỗ trợ `{{template}}`: `{{title}}`, `{{text}}`, `{{source}}`, `{{instance}}` và mọi
key trong `event.fields` (`{{sender}}`, `{{metric}}`, `{{value}}`…).

### 🌐 Gọi API (`webhook`)

`GET · POST · PUT · PATCH · DELETE` + **query params** (tên và giá trị đều template được, tự
encode) + **header** + **xác thực** (`bearer` · `basic` · API key trong header tự chọn) +
**body** (`json` / `text` / `form` — quyết định `content-type` khi bạn không tự đặt header; trống =
cả sự kiện dạng JSON) + **timeout** 1–60s (mặc định 10) + tuỳ chọn **giữ 500 ký tự đầu của
response** trong tab Hoạt động để dò lỗi.

Chạy **phía server** nên không dính CORS và token không lọt vào network log của browser. `auth`
nằm **ngoài** `headers` để editor che được giá trị và để chỗ ghép `Authorization` chỉ có một.
`GET`/`DELETE` không gửi body. Discriminator vẫn là `'webhook'` — quy tắc lưu từ trước khi action
này lớn lên vẫn chạy y nguyên.

### ✈️ Gửi Telegram (`telegram`)

Máy này **thường đã có sẵn một bot**: `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALLOWED_CHAT_ID` trong
`.env.local` mà `bot/` (MR-review) dùng. Nên `tokenSource` mặc định là **`env`**: token được đọc
lúc gửi, **không** ghi vào `.automation.json` và **không** đi xuống renderer — một bot, một chỗ
xoay token. Chọn `inline` khi cần bot khác (token lúc đó nằm trong file cấu hình, như URL webhook
kèm token).

Chat id để trống + nguồn `env` = chat đầu tiên trong `.env.local` (editor hiện sẵn các chat id đó
thành chip để bấm). Kèm `parse_mode` (`none` an toàn nhất — sai cú pháp Markdown là Telegram từ
chối cả tin), gửi im lặng, tắt xem trước link (mặc định **bật tắt**), và `message_thread_id` cho
nhóm có chủ đề. Nội dung > 4096 ký tự bị **cắt** thay vì để Telegram trả 400.

Nút **Kiểm tra bot** gọi `GET`/`POST /api/automation/telegram` → `getMe` + `getChat`: sai token
hay bot chưa được thêm vào nhóm thì biết ngay lúc soạn quy tắc, không phải 3h sáng. Nó **không gửi
tin** — muốn gửi thật thì dùng “Bắn thật” ở tab Thử.

Mọi lỗi trả về đã **xoá token** khỏi chuỗi (`lib/automation/telegram.ts`), vì một lỗi mạng có thể
kéo nguyên URL kèm token vào tab Hoạt động. Tab Thử cũng che `botToken`/`token` trong bản dump.

### 💬 Gửi Zalo (`wsSend`)

Gửi bằng **chính tài khoản Zalo đang đăng nhập** ở tab Workspace — không phải OA, không phải bot.
Chạy ở renderer vì chỗ duy nhất chạm được vào guest là `<webview>` (xem `lib/workspace/guests.ts`).

**Người nhận là một danh sách đã lưu, không phải tên gõ tay.** Lý do đo được chứ không phải chọn
cho gọn: chat.zalo.me **không lộ id hội thoại nào** — mọi dòng chung một mã component, chỉ avatar
ghép của nhóm mới có `id` (của từng thành viên). Nên đích chỉ định danh được bằng **tên hiển thị**,
và tên chỉ an toàn trong một tập nhỏ do người dùng tự chọn.

Cách dựng danh sách (tab Workspace → 🔎): quét ra toàn bộ hội thoại, **tuỳ ý** bấm một nhãn Phân
loại để thu hẹp, rồi **tick chọn** đúng những hội thoại cần — cá nhân lẫn nhóm, trộn thoải mái —
đặt tên và **Đưa vào danh bạ** (`configs/wstargets.json`, một mục cho mỗi *tài khoản × tên danh
sách*, id suy ra từ cặp đó nên lưu đè cùng tên **không** làm hỏng quy tắc đang trỏ vào).

> Bộ lọc nhãn chỉ để **nhìn cho gọn**, không phải nguồn sự thật. Nhãn Zalo là **ô tick chọn
> nhiều**: một nhãn còn tick từ lần trước sẽ hợp vào kết quả lần sau — thực tế đã thấy lọc 1 hội
> thoại mà ra 6. Ai nhận thì phải do người tick chọn, không phải do bộ lọc trả về.

Quy tắc chỉ chọn *tài khoản gửi + nhãn + nội dung*, và editor **hiện sẵn danh sách người nhận** để
duyệt bằng mắt trước khi bật gửi. Action A trỏ nhãn này, action B trỏ nhãn khác — độc lập.

Chặn an toàn xếp chồng: `allowSend` (mặc định OFF) → `rule.dryRun` → **trần cứng của runtime**
(≥5s giữa 2 tin, ≤20 tin/giờ **mỗi tài khoản**, quy tắc không tắt được). Gửi tuần tự từng người,
nghỉ 2s giữa hai người nhận.

**Enter phải là phím THẬT.** Ô soạn của Zalo là React contenteditable, nó kiểm `event.isTrusted` —
`dispatchEvent(new KeyboardEvent('Enter'))` là sự kiện giả nên bị bỏ qua: gõ được chữ mà **không
gửi**. Phím thật phải đến từ ngoài trang, qua `<webview>.sendInputEvent` ở tầng Electron
(`guests.ts` → `pressKey`). Vì lệnh đó nằm ở renderer, việc gửi tách làm hai pha:

```
pha 'type'   → mở hội thoại · focus + dọn + gõ ô soạn · dò nút · DỪNG (giữ focus)
renderer     → guest.pressKey('\r')   ← Enter THẬT
pha 'finish' → kiểm chứng khung chat · rời sang hội thoại khác
```

**Chạy thử** dừng ở cuối pha 'type': gõ xong rồi **xoá, không nhấn Enter** — thấy được đường đi tới
sát điểm gửi mà không gửi gì. Mỗi bước (`tìm hội thoại → mở → tìm ô soạn → gõ → Enter thật →
kiểm chứng`) có ok/lỗi riêng; hỏng ở đâu biết ngay ở đó. Nút gửi khai trong `sendButtonSelectors`
được click thử trong-trang trước như một lối tắt, nhưng Enter-thật mới là đường chính đáng tin.

## Theo dõi hạ tầng (watch)

Một watch = `stack + connectionId + metric op threshold`, poll mỗi `everySec`
(tối thiểu **15s**), phải giữ vi phạm đủ `forSec` mới bắn (debounce), nhắc lại theo `cooldownSec`
(mặc định 600s), và bắn `infra.recovered` khi hết vi phạm (tắt được).

Ngữ nghĩa runner:

- **Một** interval 2s cho tất cả watch, mỗi watch tự có `nextDue` → không đẻ N timer trôi lệch nhau.
- `signature = stack|connection|metric|op|threshold`; đổi ngưỡng → **xoá** lịch sử vi phạm, không
  bắn tiếp bằng state cũ.
- **Thiếu metric ≠ vi phạm.** Probe không trả metric đó → ghi nhận lỗi, không cảnh báo (im lặng
  còn hơn báo động giả). Riêng `up` luôn có, nên **mất kết nối vẫn bắn** (`up < 1`).
- Probe không bao giờ throw: hỏng → `{ up: 0 }` + `error`.

Metric mỗi stack khai báo ở `catalog.ts` (kèm `suggest` op + ngưỡng mặc định):

| Stack | Metric |
|---|---|
| 🧠 Redis | `up` `memUsedPct` `memUsedMb` `clients` `opsPerSec` `hitRatePct` `fragmentation` `nodes` |
| 🍃 Mongo | `up` `connectionsUsedPct` `connections` `cacheUsedPct` `diskUsedPct` `memResidentMb` `replLagSec` `membersUnhealthy` |
| 🔎 ES | `up` `statusLevel` (0/1/2) `unassignedShards` `relocatingShards` `pendingTasks` `heapPct` `cpuPct` `diskUsedPct` `load1m` `nodes` |
| 🧵 Kafka | `up` `underReplicated` `offline` `brokers` `noController` `topics` `partitions` |
| 🐰 Rabbit | `up` `messagesReady` `messagesUnacked` `consumers` `memAlarm` `diskAlarm` `nodesDown` `memUsedPct` `fdUsedPct` `queues` `publishRate` |
| 🐘 PG | `up` `latencyMs` |

Cụm nhiều node gộp theo hướng "xấu nhất thắng": gauge lấy `max`, tỉ lệ hit lấy `min`, khối lượng
lấy `sum`, alarm của Rabbit là `some()` (một node báo = publisher bị chặn toàn cluster).

## Giới hạn chống bão

Mỗi quy tắc có `dedupeSec` (bỏ qua trùng title+text), `cooldownSec` (khoảng cách tối thiểu giữa
2 lần bắn), `maxPerHour` (trần cứng theo giờ trượt). Thứ tự quy tắc **có ý nghĩa** vì
`stopOnMatch` — nên danh sách sắp xếp được bằng ↑↓.

## Dữ liệu trên máy (đã gitignore)

| File | Nội dung |
|---|---|
| `.automation.json` | Quy tắc + watch (có thể chứa URL API, token `auth`, bot token `inline`) |
| `.automation-log.jsonl` | Sink của hành động `log` (nội dung tin nhắn rơi vào đây) |

## Mô hình soạn thảo

Tab Automation sửa trên **bản nháp**: engine vẫn chạy config đã lưu lần cuối, nên một quy tắc
đang viết dở không bao giờ bắn. Riêng các công tắc an toàn áp dụng **ngay** khi chưa có nháp —
kill switch phải là một cú click.

Tab **Hoạt động** là bề mặt trung thực: sự kiện không khớp quy tắc nào vẫn hiện, kèm lý do bỏ qua
của từng quy tắc (`ngoài khung giờ`, `đang nghỉ`, `vượt giới hạn/giờ`…) — đó là cách debug một
quy tắc "không chạy". Tab **Thử** dựng sự kiện bằng tay: "Thử" dùng state vứt đi nên không bao giờ
ăn mất cooldown thật.
