# Automation Engine

Một engine, nhiều **nhóm tính năng**. Mọi nguồn (tin nhắn Zalo/Telegram, chỉ số Redis/Mongo/ES…)
đều được chuẩn hoá về **một** kiểu sự kiện, nên một quy tắc viết cho Zalo và một quy tắc viết cho
"Redis RAM > 80%" chạy qua đúng cùng một đoạn code.

```
nguồn → AutomationEvent → trigger → scope → khung giờ → điều kiện → giới hạn → hành động
```

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
| `connections.ts` | Nạp danh sách kết nối theo stack cho editor (memo hoá, không bao giờ throw) |
| `useAutomation.ts` | `useAutomation()` / `useWatcher()` qua `useSyncExternalStore` |

UI: `components/automation/*` (tab 🤖 Automation) · `components/AutomationHost.tsx` (runner + toast,
gắn **ngoài** mọi pane nên chạy ở bất kỳ tab nào) · API: `app/api/automation/{route,dispatch/route}.ts`.

## Công tắc an toàn (mặc định)

| Công tắc | Mặc định | Ý nghĩa |
|---|---|---|
| `enabled` | **ON** | Kill switch tổng — tắt là không quy tắc nào chạy |
| `captureEnabled` | **OFF** | Social: có được đọc nội dung tin hay không |
| `storeMessageText` | ON | Tắt = activity/log chỉ giữ `••••` |
| `watchEnabled` | **OFF** | Infra: có chạy poller đo chỉ số hay không |
| `allowSend` | **OFF** | Mở khoá hành động `reply` |
| `rule.dryRun` | **ON** cho quy tắc mới | Đánh giá + ghi nhận, không thực thi |

`reply` **không bao giờ tự gửi**: kết quả chỉ là `pending-approval` (khi `allowSend`) hoặc
`skipped`. Gửi tự động trên tài khoản cá nhân chính là thứ làm account bị khoá.

Dry-run vẫn hiện toast cho `notify` — đó chính là mục đích của chạy thử: xem quy tắc *sẽ nói gì*
mà không có side effect ra ngoài.

## Hành động

| Loại | Chạy ở đâu | Ghi chú |
|---|---|---|
| `notify` | renderer | Toast trong app + OS Notification; `urgent` không tự tắt |
| `webhook` | **server** (`/api/automation/dispatch`) | Không dính CORS, header auth không lộ ra network log của browser; timeout 10s |
| `log` | **server** | Append JSON-lines, mặc định `.automation-log.jsonl` |
| `kafka` | renderer → `/api/kafka` | Dùng đúng connection đã lưu trong DevBox |
| `reply` | — | Chỉ đề xuất, xem ở trên |

Body/key/value hỗ trợ `{{template}}`: `{{title}}`, `{{text}}`, `{{source}}`, `{{instance}}` và mọi
key trong `event.fields` (`{{sender}}`, `{{metric}}`, `{{value}}`…).

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
| `.automation.json` | Quy tắc + watch (có thể chứa URL webhook kèm token) |
| `.automation-log.jsonl` | Sink của hành động `log` (nội dung tin nhắn rơi vào đây) |

## Mô hình soạn thảo

Tab Automation sửa trên **bản nháp**: engine vẫn chạy config đã lưu lần cuối, nên một quy tắc
đang viết dở không bao giờ bắn. Riêng các công tắc an toàn áp dụng **ngay** khi chưa có nháp —
kill switch phải là một cú click.

Tab **Hoạt động** là bề mặt trung thực: sự kiện không khớp quy tắc nào vẫn hiện, kèm lý do bỏ qua
của từng quy tắc (`ngoài khung giờ`, `đang nghỉ`, `vượt giới hạn/giờ`…) — đó là cách debug một
quy tắc "không chạy". Tab **Thử** dựng sự kiện bằng tay: "Thử" dùng state vứt đi nên không bao giờ
ăn mất cooldown thật.
