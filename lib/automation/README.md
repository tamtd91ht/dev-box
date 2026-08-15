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
(tối thiểu **15s**), phải giữ vi phạm đủ `forSec` mới bắn (debounce), và bắn
`infra.recovered` khi hết vi phạm (tắt được).

**Watch đo, rule quyết định.** Watch KHÔNG tiết chế cảnh báo — còn vi phạm thì nó
phát event mỗi lần poll. Bao lâu mới thành một thông báo thật là việc của rule
(`RuleLimits`), nên một rule nói được "mỗi giờ 1 lần cho từng watch" mà không cần
mọi watch phải đồng ý. `forSec` nằm ở watch vì nó thuộc phần **đo** (vượt ngưỡng
20 giây thì chưa thực sự là vi phạm).

`severity` (`critical`/`warning`/`info`) và `tags` là **metadata nhận diện**: chúng
đi theo event thành `fields.severity` / `fields.severityLabel` để cảnh báo tự giới
thiệu mình, và dùng được trong điều kiện — nhưng **không định tuyến**. Rule chọn
watch bằng `scope.watchIds` (theo **id**), nên đổi tên watch không bao giờ làm đứt
liên kết.

**Lọc consumer group (chỉ Kafka, chỉ số theo group).** Với các chỉ số lag theo
group (`maxConsumerLag`, `stalledGroups`, `maxStalledSec`, `totalConsumerLag`,
`emptyGroups`, `rebalancingGroups`, `groups`, `lagGroupsUnknown`), watch có field
`groupFilter?: string[]` — chọn từ **dropdown gợi ý** trong editor (danh sách group
lấy thẳng từ cụm qua `listKafkaGroups`, không gõ tay). Phép đo được giới hạn vào
đúng các group đó TRƯỚC khi tính, nên cùng một chỉ số cho hai kiểu watch:

- `maxConsumerLag > X` với `groupFilter` **rỗng** = *bất kỳ consumer nào* lag > X.
- `maxConsumerLag > X` với `groupFilter` = *[nhóm đã chọn]* = *chỉ cần 1 trong các
  consumer này* lag > X là báo (max trên tập con). Group đã chọn mà không tồn tại
  trên cụm chỉ đơn giản không đóng góp gì (không làm hỏng phép đo).

Danh sách group đi vào mô tả tự sinh của cảnh báo ("Chỉ xét N consumer group: …"),
nên tin nhắn tự giải thích vì sao chỉ mấy consumer đó.

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
| 🧵 Kafka | `up` `underReplicated` `offline` `brokers` `noController` `topics` `partitions` — và nhóm **consumer lag**: `maxConsumerLag` `totalConsumerLag` `stalledGroups` `maxStalledSec` `emptyGroups` `rebalancingGroups` `lagGroupsUnknown` `groups` |
| 🐰 Rabbit | `up` `messagesReady` `messagesUnacked` `consumers` `memAlarm` `diskAlarm` `nodesDown` `memUsedPct` `fdUsedPct` `queues` `publishRate` |
| 🐘 PG | `up` `latencyMs` |

Cụm nhiều node gộp theo hướng "xấu nhất thắng": gauge lấy `max`, tỉ lệ hit lấy `min`, khối lượng
lấy `sum`, alarm của Rabbit là `some()` (một node báo = publisher bị chặn toàn cluster).

## Metadata chuẩn hoá (AlertMeta v1)

Mỗi event mang đủ dữ kiện trong `fields` phẳng (cho `{{var}}` và điều kiện); `meta.ts`
**dẫn xuất** từ đó một JSON có cấu trúc, phiên bản hoá — cho hệ thống NGOÀI parse
(webhook, bot AI đọc tin nhắn trong nhóm Zalo) mà không phải hiểu tiếng Việt trong title/text.

Event hạ tầng phát các field (đầy đủ khai ở `catalog.ts INFRA_FIELDS` — script
`npm run check:automation` giữ catalog và emission khớp nhau):

- `stack` `stackLabel` `metric` `metricLabel` `value` `threshold` `op` `opText` `unit`
- `watch` `watchId` `severity` `severityLabel` `tags` `everySec` `forSec`
- `address` — host:port của kết nối (lấy từ registry public, đã gột credential; rỗng
  ở vòng poll đầu sau khi mở app nếu cache chưa kịp warm)
- `alertType` — **mã ổn định** `stack.mã.hướng` (`redis.ram.high`, `kafka.lag.high`;
  riêng `up` → `stack.down`). Breach và recovery mang CÙNG mã — bot ghép cặp bằng
  `watchId` + `alertType`.
- `note` — ghi chú nghiệp vụ của watch ("Redis này cấp session cho tổng đài…")
- `description` — mô tả **cơ chế phát hiện, tự sinh từ catalog**: chỉ số nghĩa là gì
  (`meaning`), máy đo bằng gì và bao lâu (`probe` + `everySec` + cách gộp node), ngưỡng
  phát là gì (`opText threshold` + `forSec`), nối thêm `note`. Một cảnh báo phải TỰ
  GIẢI THÍCH — người trực (hoặc bot AI) đọc tin nhắn là đủ ngữ cảnh, không cần mở DevBox.

Hai biến template mới (mọi nhóm event đều có):

| Biến | Là gì | Dùng khi |
|---|---|---|
| `{{metaJson}}` | AlertMeta v1 nén một dòng | body webhook, nhúng vào tin nhắn cho bot |
| `{{metaJsonPretty}}` | Bản thụt dòng | log, nơi người đọc |

**Quy ước cho bot**: KHÔNG có marker bọc — bot quét tin nhắn, tìm đoạn JSON bắt
đầu bằng `{"schemaVersion":` rồi `JSON.parse`; `schemaVersion` cho biết shape
(đổi shape sẽ bump, xem `meta.ts`). Tin cho người đọc viết TRƯỚC khối JSON; ví dụ
một action `zaloApiSend.text`:

```
{{severityLabel}} {{stackLabel}} · {{instance}}
{{metricLabel}}: {{value}}{{absText}} (ngưỡng {{opText}} {{threshold}})
Máy: {{address}}

{{metaJson}}
```

**Độ dài**: `metaJson` ≈ 1–1.4 KB. Telegram trần 4096 ký tự, Zalo thấp hơn (~2000) —
nhóm không có bot thì dùng `{{description}}`/`{{address}}` rời, đừng nhúng JSON;
`description` tự sinh giữ ≤ ~350 ký tự, `note` bị cắt ở 280.

Nhóm social có meta gọn hơn (`conversation` `sender` `chatType` `app` `capture`
`threadId`); `system.test` giữ nguyên `fields` tự nhập. Event mẫu từng case lấy từ
`sample.ts sampleEvent()` — với infra nó gọi CHÍNH `infraBreachEvent()`, nên mẫu
trên UI không lệch được emission thật.

## Giới hạn chống bão

Mỗi quy tắc có `dedupeSec` (bỏ qua trùng title+text), `cooldownSec` (khoảng cách tối thiểu giữa
2 lần bắn), `maxPerHour` (trần cứng theo giờ trượt). Thứ tự quy tắc **có ý nghĩa** vì
`stopOnMatch` — nên danh sách sắp xếp được bằng ↑↓.

**Hai bảo đảm để các giới hạn này đúng THẬT** (không chỉ đúng trong một cửa sổ):

1. **Một runner duy nhất** — watcher chạy phía renderer và mỗi cửa sổ mount một
   watcher riêng; Electron + browser dev mở cùng lúc từng là HAI runner với hai
   bộ cooldown độc lập, tin cảnh báo xen kẽ nhau dưới mọi giới hạn (triệu chứng:
   đặt 5 phút mà ~1 phút đã thấy bắn lại). Giờ mỗi tick watcher renew lease qua
   `/api/automation/runner`; chỉ ai giữ lease mới poll + phát sự kiện, các cửa
   sổ khác đứng chờ (WatchesPanel hiện "◐ chờ") và tự tiếp quản trong ~8s khi
   leader đóng.
2. **Lịch sử bắn sống lâu hơn cửa sổ** — cooldown/dedupe/rate từng nằm trong RAM
   renderer: F5, mở lại app hay HMR khi dev là về 0 và cảnh báo bắn lại ngay poll
   kế tiếp. Giờ mỗi lần rule bắn thật, runtime đẩy snapshot (`lastFire`/`fires`/
   `content`/`seen`) lên `/api/automation/limits` (file `.automation-limits.json`,
   gitignore); lúc khởi động nó hydrate lại trước sự kiện đầu tiên. Merge theo
   luật "mốc mới nhất thắng" nên nhiều cửa sổ đẩy chéo không làm ngắn cooldown.
   Cả hai đường đều fail-soft: route lỗi thì hành xử như bản cũ.

`countBy` quyết định 2 giới hạn sau đếm trên **phạm vi nào** — đây là lựa chọn
chính sách, không phải kỹ thuật, nên nó được hỏi chứ không mặc định ngầm:

| `countBy` | Một bộ đếm cho | Dùng khi |
|---|---|---|
| `rule` (mặc định) | cả quy tắc | rule đại diện **một** mối lo; watch A hoặc B → 1 cảnh báo |
| `watch` | từng watch | rule bao nhiều thứ độc lập; 40 cụm sập cùng lúc phải báo đủ 40 |
| `instance` | từng kết nối | mọi watch trên cùng cụm chia nhau 1 bộ đếm |

Lưu ý `dedupeSec` khoá theo **nội dung** (`ruleId|title|text`). Với cảnh báo hạ tầng
thì giá trị đo đổi liên tục nên nó gần như không chặn được gì — hãy dùng
`cooldownSec` + `countBy`.

## Chống trùng theo bậc ngưỡng (`dedupeLadder`)

Đặt nhiều ngưỡng trên **cùng một thứ** để phân mức nặng nhẹ là chuyện thường:

```
watch A   disk mongo1 > 90%   (critical)
watch B   disk mongo1 > 80%   (warning)
```

Khi `disk = 95%` thì **cả hai** cùng vượt ngưỡng, mỗi watch phát một sự kiện →
hai cảnh báo cho đúng một sự việc.

`countBy` **không** giải được ca này: lúc rule nhìn thấy thì A và B đã là hai
event riêng biệt, và `countBy` chỉ đếm thưa đi chứ không biết cái nào đáng giữ.
Chọn `countBy: 'instance'` thì đúng là còn một tin, nhưng là *tin nào tới trước*
— có thể là cái nhẹ hơn.

Nên việc chọn "cái nào đại diện" nằm ở **watcher**, chỗ duy nhất nhìn thấy đồng
thời mọi watch cùng giá trị vừa đo:

1. Gom watch theo **(kết nối + chỉ số + chiều so sánh)**. Cùng máy, cùng chỉ số,
   cùng chiều = đang đo cùng một thứ ở các mức khác nhau. Khác metric (disk vs
   CPU) hay khác máy → nhóm khác, không đụng nhau.
2. Xếp hạng theo **độ chặt của NGƯỠNG**, không theo `severity` người dùng gõ:
   chiều tăng (`gt`/`gte`) thì ngưỡng cao hơn là chặt hơn; chiều giảm
   (`lt`/`lte`) thì ngưỡng thấp hơn là chặt hơn. Dựa vào con số nên không phụ
   thuộc việc khai severity có nhất quán hay không. (Ngưỡng bằng nhau mới xét
   tới severity, rồi tới `id` để kết quả ổn định giữa các vòng poll.)
3. Mỗi vòng, trong các watch **đang thực sự vượt ngưỡng** của cùng nhóm, chỉ cái
   chặt nhất được phát; các mức nhẹ hơn im (trace ghi `🔇 suppressed` kèm tên
   cái đang che, và WatchesPanel hiện "bị … che").

**Tự hạ cấp:** disk tụt 95% → 85% thì A hết khớp, B thành cái chặt nhất còn khớp
→ B được phát. Vẫn còn vấn đề, chỉ là nhẹ bớt.

Ba chi tiết dễ sai đã xử lý:

* Watch bị che **suốt** thời gian vượt ngưỡng thì lúc hết vượt sẽ **không** phát
  `infra.recovered` — báo "đã hồi phục" cho một cảnh báo chưa từng gửi là gây
  hoang mang. (Kiểm tra bằng `lastAlertAt > 0`.)
* Watch **không đọc được chỉ số** mất luôn quyền che: giữ nguyên trạng thái cũ
  là để một watch đã chết bịt miệng cả nhóm.
* Watch trong cùng nhóm có thể khác `everySec` nên không phải lúc nào cũng đo
  cùng lúc → dùng trạng thái gần nhất, nhưng cũ quá `STALE_MS` (15 phút) thì bỏ
  qua. Thà báo trùng một nhịp còn hơn im vì một watch đã ngừng đo.

`eq`/`neq` không xếp bậc được (không có "chặt hơn" giữa hai giá trị bằng nhau)
nên mỗi watch loại đó đứng riêng và không bao giờ bị che.

Mặc định **BẬT**. Tắt ở công tắc "Chống trùng cảnh báo" khi thật sự cần từng mức
có tiếng nói riêng (vd mỗi mức đẩy vào một hệ thống khác nhau).

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
