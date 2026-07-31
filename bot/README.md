# Telegram MR-review bot

Một tiến trình Node chạy **cục bộ trên máy dev** — lắng nghe lệnh `/review` trong một
group Telegram, chạy engine review-only `/review-mr-dev` (qua Claude Code CLI) trên chính
máy đó, rồi trả kết quả lại group (reply/quote message gốc + tag người yêu cầu).

Bot **không mở cổng lắng nghe** nào — chỉ gọi HTTPS long-poll ra Telegram — nên không cần
expose gì ra mạng ở nhà/công ty.

```
Member ─chat trong group─▶ Telegram Bot API
  "/review ai-service dev_duynh"          │  getUpdates(offset)  ← máy local KÉO về
                                          ▼
   poller (bot/index.ts) → git fetch + rev-list (branch ahead dev?)
                         → dedup theo sha commit (file bot/.state.json)
                         → claude -p "/review-mr-dev <svc> --branch=<b>"   (lib/reviewMr.ts)
                         → đọc verdict + SCORE từ file report engine ghi
                         → sendMessage(reply_to = msg gốc, tag @member)
```

Engine review (diff, fan-out agent, chấm rule, ghi `review-mr/…md` + rollup tháng) **không
đổi** — bot chỉ là lớp điều phối mỏng quanh nó.

## Cú pháp lệnh (gõ trong group) — gõ tự nhiên, không cần key=value

```
/review <service> <branch> <mô tả ngắn>

/review ai-service dev_duynh fix lỗi bảo mật dữ liệu ở luồng TTS   → 1 branch + mô tả
/review ai-service dev_duynh                                       → 1 branch, không mô tả
/review ai-service                                                 → MỌI feature branch ahead origin/dev
/review help                                                       → hướng dẫn
```

- **Thứ tự đọc:** token 1 = service, token 2 = branch, **mọi thứ còn lại = mô tả tự do**
  (được phép xuống nhiều dòng, dấu cách thoải mái).
- Mô tả **chỉ để người trên group đọc hiểu đang xin review gì** — bot echo lại trong reply
  và ghi 1 dòng `> 🗒️ Yêu cầu review (@ai): …` vào đầu file report. **Không** đưa vào engine,
  nên không làm review thiên lệch.
- `<service>`: tên short (`ai-service`, `wallet`) hoặc full `cloud-saas-omicx-*`.
- (Tuỳ chọn nâng cao, không bắt buộc) vẫn nhận `branch=dev_duynh des= …` nếu ai thích rõ ràng.

## Cài đặt lần đầu

1. **@BotFather** → `/newbot` → copy **token**.
2. **@BotFather** → `/setprivacy` → **DISABLE** (để bot đọc được mọi message trong group,
   không chỉ lệnh có `@botname`).
3. Add bot vào group review. Gửi 1 message bất kỳ, rồi mở
   `https://api.telegram.org/bot<token>/getUpdates` → lấy `chat.id` của group (số âm).
4. Copy `.env.example` → `.env.local`, điền **2 dòng bắt buộc**:
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_ALLOWED_CHAT_ID=-1001234567890
   ```
   Workspace review lấy tự động từ project đã đăng ký trong UI — xem mục dưới.
5. `claude` CLI đã đăng nhập trên máy này (engine chạy dưới quyền user của bạn).

Không cần Redis / DB / cài gì thêm — offset Telegram + dedup lưu vào file `bot/.state.json`
(tự tạo, đã gitignore). Chạy `npm run bot` là dùng ngay.

## Bot review workspace nào? (cấu hình kiểu integration pack)

DevBox là tool **dùng chung nhiều project**, nên bot **không hardcode đường dẫn**. Nó đọc
**đúng những registry per-máy mà UI đã ghi** — giống cách API Explorer nhận project:

| Thứ tự | Nguồn | Ghi ở đâu |
|--------|-------|-----------|
| 1 | `BOT_BASE_PATH` (alias cũ: `OMICX_BASE_PATH`) | `.env.local` — đường dẫn tuyệt đối, thắng tất cả |
| 2 | `BOT_PROJECT=<id hoặc tên>` | khớp với `.apiintegrations.json` rồi `.gitprojects.json` |
| 3 | **Đúng 1** integration pack đã đăng ký | tab **＋ Projects** (`.apiintegrations.json`) |
| 4 | **Đúng 1** git project đã đăng ký | tab **Git** (`.gitprojects.json`) |
| 5 | Chưa đăng ký gì | thư mục **cha** của repo này |

→ **OMICX: không cần cấu hình gì thêm.** Folder `…/sources/omicx` đã đăng ký ở tab ＋ Projects
(pack `devbox.api.json`), nên `npm run bot` tự lấy đúng workspace đó.

Nhiều project đã đăng ký mà không đặt `BOT_PROJECT` → bot **báo lỗi + liệt kê project đang có**
rồi dừng, **không đoán bừa**. Dòng log lúc boot luôn in nguồn đã dùng:

```
[09:12:01] workspace lấy từ: project "OMICX" (.apiintegrations.json)
```

Prefix folder để nhận diện service reviewable mặc định là `cloud-saas-omicx-`; project khác
đặt `REVIEW_SERVICE_PREFIX=<prefix của bạn>`.

## Chạy

```bash
npm install     # lần đầu (đã thêm tsx + dotenv)
npm run bot
```

Bot in dòng khởi động `bot @<username> up · instance=… · base=…` khi sẵn sàng.

## Làm sao biết bot đang review hay không (3 kênh)

Ngồi ở máy local, bạn nắm trạng thái qua 3 kênh — bổ trợ nhau:

**A. Log terminal** (cửa sổ đang chạy `npm run bot`) — in rõ từng mốc:
```
[12:49:38] 📥 lệnh từ @duynh: /review ai-service dev_duynh fix lỗi TTS
[12:49:40] 🔍 reviewing ai-service/dev_duynh @ fe331fff (ahead 9, author duynh) — đang chạy…
[13:03:05] ✅ done ai-service/dev_duynh → FIX_REQUIRED (CRIT=0 HIGH=2 MED=4 LOW=4) · 805s
[13:03:05] 💤 idle — đang chờ lệnh (polling)
```

**B. Lệnh snapshot** — gõ ở **bất kỳ terminal nào** (không cần nhìn cửa sổ bot):
```bash
npm run bot:status
```
```
🟢 instance=company · trạng thái: ĐANG REVIEW
   🔍 đang review: ai-service/dev_duynh (xin bởi @duynh)
   ⏱  đã chạy: 4ph 7s · còn 1 branch trong hàng đợi
   ✔ lần review cuối: wallet-service/dev_dongnv → APPROVE (…) · 210s · lúc 12:30
```
Đọc từ `bot/.status.json` (bot ghi mỗi lần đổi trạng thái) — chạy tức thì, không cần Redis/Telegram,
dùng được cả khi máy vừa bật lại. Trạng thái: `RẢNH` / `ĐANG REVIEW` / `ĐÃ DỪNG`.
Nếu snapshot cũ > 90s mà state không phải `stopped` → cảnh báo "bot có thể đã tắt/treo".

**C. Bot nhắn riêng cho bạn** (tùy chọn) — đặt `BOT_OWNER_CHAT_ID` = chat id 1-1 của bạn với bot.
Khi đó bot DM bạn đúng **2 thời điểm mỗi branch**: lúc **START** (`⏳ Bắt đầu review …`) và lúc
**DONE** (`⚠️ Xong review … → FIX_REQUIRED`). Điện thoại/desktop đều thấy dù bạn không ngồi máy.
Không đặt → tự tắt, không lỗi. (Lấy chat id: nhắn bot 1-1 rồi đọc `getUpdates`, lấy `chat.id` dương.)

## Hai máy (công ty + nhà) — quan trọng: offset là local mỗi máy

Bỏ Redis nghĩa là **offset Telegram không còn dùng chung giữa 2 máy** — mỗi máy giữ file
`bot/.state.json` riêng. Telegram thì **giữ nguyên** hàng đợi update cho tới khi *một*
consumer xác nhận (advance offset) tới đâu.

Hệ quả cần biết (đúng tình huống 5h cty → 7h về nhà):

- **5h ở cty:** máy cty review xong request A, ghi `offset = update_id(A)+1` vào file `.state.json`
  **của máy cty**. Nó đã "xác nhận" A với Telegram (gọi `getUpdates` với offset đó).
  → Telegram **xoá A khỏi hàng đợi**.
- **7h về nhà:** máy nhà có file `.state.json` riêng, offset của nó cũ hơn (hoặc = 0).
  Nhưng khi nó gọi `getUpdates`, **Telegram không trả A nữa** — vì A đã bị máy cty xác nhận,
  Telegram không giữ lại. → **Máy nhà KHÔNG review lại A.** ✅

Nói cách khác: cái chống-review-lại-A giữa 2 máy **không phải Redis**, mà là **chính Telegram**
— một update đã được máy nào đó `getUpdates` qua (offset vượt nó) thì Telegram bỏ, máy sau
không thấy. File offset local chỉ cần để **cùng một máy** không xử lại sau khi restart.

**Trường hợp DUY NHẤT bị lặp:** request A về Telegram lúc máy cty **đang tắt/chưa kịp
xác nhận**, rồi bạn bật máy nhà — thì máy nhà nhận A (bình thường, đúng ý). Sẽ chỉ review 2 lần
nếu **cả 2 máy cùng chạy song song** và cùng nhận một update trước khi máy kia advance offset —
mà bạn đã chốt **chỉ 1 máy bật cùng lúc**, nên không xảy ra.

> Vẫn còn dedup theo **sha commit** (dưới) làm lớp chắn thứ 2: kể cả nếu lỡ 2 máy chạy và cùng
> nhận A, máy nào review trước ghi report; nhưng dedup-sha là **per-máy** (file riêng) nên lớp
> này KHÔNG chống được cross-máy — chỉ chống lặp trên cùng máy. Lá chắn cross-máy thật sự là
> offset-của-Telegram ở trên.

Đặt `BOT_INSTANCE_ID=company` / `=home` cho mỗi máy để phân biệt trong log + `bot:status`.

## Máy tắt lúc member nhắn?

Không mất request. Telegram giữ update tới ~24h; máy bật lại (máy nào cũng được) → `getUpdates`
kéo về mọi lệnh **chưa máy nào xác nhận** → review lần lượt, rồi advance offset.

## Chống review trùng

Key dedup = `sha256(repo | branch | HEAD_sha_của_branch)`. Nhắn lại cùng branch mà **chưa
có commit mới** → bot trả lại report cũ, **không tốn một lượt Claude**. Push fix mới →
sha đổi → review lại (đúng khái niệm "Lần review" tăng dần trong rollup tháng của engine).

## Kiểm thử

```bash
# Parser + SCORE parsing (offline, không cần Telegram):
npm run bot:test                                        # workspace = thư mục cha của repo
BOT_BASE_PATH=D:/works/vihat/sources/omicx npm run bot:test    # hoặc chỉ định rõ
```

Các phần chạm Telegram/git kiểm bằng tay theo mục "Chạy" ở trên (nhắn `/review` thật trong group).

## File

| File | Vai trò |
|------|---------|
| `index.ts` | Vòng long-poll, graceful shutdown (SIGTERM/SIGINT) |
| `config.ts` | Đọc env, fail-fast nếu thiếu secret; resolve workspace từ registry per-máy |
| `telegram.ts` | Client Bot API (`getUpdates`, `sendMessage`) qua `fetch`, không lib ngoài |
| `command.ts` | Parse cú pháp `/review`, map service → repo path (tái dùng `lib/gitCore` + `lib/reviewMr`) |
| `git.ts` | Đọc remote branch (ahead dev? sha? author?) — read-only |
| `store.ts` | File `.state.json`: offset Telegram + dedup theo sha (TTL 30 ngày) |
| `reviewer.ts` | Gọi `runReviewMr` (lib), tìm file report, parse dòng `SCORE:` |
| `handler.ts` | Điều phối 1 message: authorize → parse → dedup → review → reply + báo trạng thái (A/B/C) |
| `status.ts` | Ghi `.status.json` mỗi lần đổi trạng thái (cho `bot:status`) |
| `status-cli.ts` | `npm run bot:status` — in snapshot trạng thái từ `.status.json` |
| `smoke.test.ts` | Test offline parser + SCORE parsing |
