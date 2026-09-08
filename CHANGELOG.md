# Changelog

All notable changes to VHS DevBox are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **Desktop shell mặc định chạy server production (`next build` + `next start`) thay vì `next dev`
  — RAM giảm ~2.5-3GB.** Đo thực tế: riêng tiến trình `next dev` chiếm ~3GB (cache biên dịch
  webpack/HMR của mọi route, phình dần theo thời gian dùng), trong khi server production chỉ vài
  trăm MB — giao diện không đổi một pixel, trang còn mở nhanh hơn vì không phải biên dịch lần đầu.
  Cách hoạt động: lúc khởi động, shell so commit HEAD của repo với HEAD ghi lại ở lần build thành
  công trước (`data/browser/build-info.json`); lệch (vừa bấm ⬇ Cập nhật, hoặc tự `git pull`) thì
  tự `next build` lại — có splash "đang khởi động" trong lúc chờ, log build đổ vào Console trong
  app. Build hỏng thì **fallback về `next dev`** để app vẫn dùng được (và log rõ lý do).
  Ai đang sửa code và cần hot reload: `npm run desktop:dev` (đặt `DESKTOP_DEV=1`), hoặc cứ
  `npm run dev` trước rồi mở app như trước giờ — thấy :3000 có người trả lời là shell dùng lại,
  không build gì cả. Kéo theo: ở chế độ production, nút ⬇ Cập nhật đổi followUp `reload` thành
  `restart` (F5 không đủ — server đang phục vụ bản build cũ, phải khởi động lại để shell build lại).
  Kèm một fix build chặn đường: `next build` trên Windows chết `EPERM scandir 'C:\Users\<user>\
  Application Data'` vì @vercel/nft tính tĩnh được `os.homedir()` trong lib/configSync.ts rồi glob
  đệ quy cả thư mục home để gom "asset" (trên Linux/Docker home đọc được nên chưa bao giờ lộ).
  next.config.js giờ loại home khỏi trace ở cả hai pha: `outputFileTracingExcludes` (pha
  collect-build-traces) + đẩy pattern vào `TraceEntryPointsPlugin.traceIgnores` qua webpack hook
  (pha compile — Next không có config chính thức cho pha này). Đã xác minh trên bản copy sạch:
  build pass, `next start` phục vụ đúng trang + API.

- **Tab Kafka — "⚡ Tìm nhanh" đổi mặc định thành 30 phút và chuyển lên thanh trên.**
  Khung thời gian mặc định khi chạy một chức năng đã lưu là **30 phút gần nhất** (trước là 15).
  Preset cũ đã tự khai `windowMinutes` thì **giữ nguyên** giá trị của nó — hằng số mới chỉ áp cho
  preset chưa khai và cho ô mặc định lúc tạo mới.
  Nút **chuyển lên thanh trên**, ngang hàng *Topics · Consumer groups* (cạnh "↻ Tải lại"), và panel
  bung xuống ngay dưới nút. **FAB nổi ở góc dưới trái đã bỏ** — nó nằm ngoài luồng mắt và chỉ hiện
  sau khi đã có cluster, nên rất dễ tưởng là tính năng không tồn tại. Là dropdown nên có thêm đóng
  khi bấm ra ngoài và phím `Esc` (dock nổi trước đây không cần).
  Trần chiều cao panel hạ xuống `min(52vh, 420px)` vì tổ tiên `.kafka-layout > .panel` có
  `overflow: auto` — dropdown không phủ ra ngoài được, để 60vh thì danh sách preset dài bị cắt cụt.

- **Nút "Sync" (đồng bộ config) giờ TẮT mặc định — chỉ chủ repo config mới thấy.** dev-box là repo
  public, ai clone về cũng chạy được, nhưng vault config (`dev-box-config`) là repo **private** của
  riêng chủ sở hữu. Người khác vốn đã không sync được — không có quyền clone repo đó, cũng không có
  passphrase — nhưng nút vẫn hiện với badge `!` mời gọi, bấm "Thiết lập tự động" thì app đi cài
  `age` rồi cố clone một repo họ không có quyền và kết thúc bằng một lỗi git khó hiểu.
  Giờ Sync theo đúng quy ước của mọi tool khác trong repo: **OFF mặc định**, bật bằng
  `CONFIG_SYNC_ENABLED=true` trong `.env.local` (đã gitignored nên không đi theo git sang máy
  người khác). Tắt thì nút **không được vẽ ra**, và `/api/config-sync` trả **403** cho
  `setup`/`push`/`pull` — ẩn nút ở client không phải một ranh giới, chỗ chặn thật nằm ở route.
  Riêng `status` vẫn trả lời để UI biết có nên vẽ nút hay không.
  Đây **không phải** một lớp bảo mật — bảo mật thật vẫn là repo config private + vault mã hoá bằng
  age. Cờ này chỉ để tính năng không xuất hiện với người không dùng được nó.

### Added

- **Tab Browser: nhân đôi tab, và chuột phải trên liên kết trong trang để mở ở tab mới — hai thao
  tác quen tay của trình duyệt thật mà app còn thiếu.**
  *Nhân đôi tab*: chuột phải lên một tab trên dải tab → **⧉ Nhân đôi tab** (cũng có trong menu ⋯
  cho tab đang xem). Bản sao dùng CÙNG profile nên vẫn nguyên phiên đăng nhập, mở ra ngay **cạnh
  tab gốc** (nhân đôi là để so hai bên — đặt ở cuối dải thì lại phải đi tìm), và nhân ra đúng
  **trang đang xem** chứ không phải trang lúc mở tab: `LinkViewer` giờ báo mọi lần điều hướng lên
  chủ khung (`onUrlChange`) để `tab.url` luôn mới — trước đó nó đứng ở địa chỉ khởi đầu, nên dò
  "trang này đang mở sẵn chưa" cũng so với một địa chỉ đã cũ. Nhân đôi KHÔNG hỏi lại "trang đang
  mở sẵn, chuyển tới hay mở thêm?" (trùng URL ở đây chính là mục đích), và KHÔNG chép `creds` của
  dấu trang gốc sang bản sao — mật khẩu tự điền đã đi theo origin trong 🔑 Mật khẩu đã lưu, còn
  chép `creds` thì một tab đã điều hướng sang site khác sẽ mang user/pass của dấu trang cũ đi theo.
  Menu chuột phải trên tab có sẵn luôn **↻ Tải lại · ⧉ Copy địa chỉ · ☆ Lưu vào dấu trang ·
  ✕ Đóng tab · ✕ Đóng các tab khác**.
  *Chuột phải trên liên kết*: menu ngữ cảnh trong `<webview>` (menu native ở `electron/main.cjs`,
  chỗ đang có Cắt/Sao chép/Dán/Inspect) thêm **⊞ Mở liên kết trong tab mới** và **↗ Mở liên kết
  bằng trình duyệt ngoài**. Mục "tab mới" chỉ hiện ở tab **Browser** — đó là nơi duy nhất có dải
  tab để mở thêm vào, hứa nó ở tab Links hay viewer Google là trỏ vào một chỗ không tồn tại. Đi
  đúng kênh `workspace:openInBrowserTab` mà `target=_blank`/`window.open` đang dùng, nên mở thành
  **tab nền**: trang đang đọc giữ nguyên. Trước đây muốn mở link ra tab khác phải Ctrl+click hoặc
  chuột giữa — biết thì tiện, không biết thì không có đường nào khác.

- **Nút ⬇ Cập nhật ở footer — app tự kéo bản mới của chính nó từ Git về.** Trước đây muốn có bản
  mới phải mở terminal, `cd` vào thư mục app, `git pull`, rồi tự đoán xem có phải chạy
  `npm install` hay khởi động lại app không.
  Nút nằm cạnh **Sync**, thấy ở mọi tab, và **có ích ngay cả khi không bấm**: badge trên nút là số
  commit đang chờ, ngầm kiểm tra bằng `git fetch` 30 phút một lần (fetch không đụng working tree
  nên chạy nền vô hại). Bấm vào thì panel **liệt kê đúng những commit sắp nhận** — biết mình sắp
  lấy về cái gì thay vì cập nhật mù.
  Phần đáng giá nhất là **sau khi pull**: app tự đọc danh sách file đã đổi rồi biết cần làm gì
  tiếp và làm hộ — chỉ đổi giao diện thì **Tải lại** (`next dev` đã tự biên dịch), đụng
  `electron/**` thì **Khởi động lại app**, đụng `package.json` thì **Cài thư viện & khởi động
  lại**.
  **An toàn:** chỉ `merge --ff-only`, không bao giờ `reset --hard`. Repo đang có thay đổi chưa
  commit thì **dừng lại và liệt kê đúng file nào đang vướng**, kèm nút *Cất tạm rồi cập nhật*
  (`git stash -u`) để người dùng tự quyết — không có đường nào trong tính năng này làm mất việc
  chưa commit. Nhánh local đã đi lệch khỏi remote thì báo rõ và bảo xử lý tay ở tab Git, thay vì
  đẻ ra một commit merge lộn xộn trong thư mục app.
  Cập nhật theo **nhánh đang đứng** và upstream của nó. Không tự động cập nhật bao giờ — luôn cần
  một cú bấm có chủ ý.

- **Tab 🤖 Automation — thêm hai loại hành động: 🌐 gọi API và ✈️ gửi Telegram.** Trước đây muốn
  đẩy một cảnh báo ra ngoài chỉ có `webhook` trần (URL + POST/PUT/GET + body), header phải sửa tay
  trong `.automation.json` vì editor không có ô nhập.
  **🌐 Gọi API** là chính `webhook` đó lớn lên (giữ nguyên discriminator nên **quy tắc cũ chạy y
  nguyên**, không phải sửa gì): thêm `PATCH`/`DELETE`, **query params** (tên *và* giá trị đều
  `{{template}}`, tự encode), **bảng header**, **xác thực** (Bearer · Basic · API key trong header
  tự đặt tên) tách riêng khỏi `headers` để editor che được và chỗ ghép `Authorization` chỉ có một,
  **kiểu body** `json`/`text`/`form` quyết định `content-type` khi bạn không tự đặt, **timeout**
  1–60s (mặc định 10, kẹp cả khi sửa tay file), và tuỳ chọn **giữ 500 ký tự đầu của response**
  trong tab Hoạt động — thứ duy nhất trả lời được "API nhận rồi nhưng nó nói gì".
  **✈️ Gửi Telegram** mặc định **dùng lại bot sẵn có của máy**: `TELEGRAM_BOT_TOKEN` /
  `TELEGRAM_ALLOWED_CHAT_ID` trong `.env.local` mà `bot/` (MR-review) đang dùng — token đọc lúc
  gửi, **không** chép vào `.automation.json`, **không** đi xuống renderer, và các chat id khai báo
  sẵn hiện thành chip bấm một cái là xong; muốn bot khác thì chọn "nhập token". Kèm `parse_mode`,
  gửi im lặng, tắt xem trước link (mặc định bật), `message_thread_id` cho nhóm có chủ đề, cắt nội
  dung ở 4000 ký tự thay vì để Telegram trả 400, và nút **Kiểm tra bot** (`getMe` + `getChat`, đọc
  thôi, không gửi tin) để phát hiện sai token / bot chưa vào nhóm ngay lúc soạn quy tắc.
  Cả hai chạy **phía server** (`/api/automation/dispatch`): không dính CORS, token không lọt vào
  network log của browser. Lỗi trả về đã **xoá token** khỏi chuỗi (một lỗi mạng có thể kéo nguyên
  URL kèm token vào tab Hoạt động), và tab Thử che `botToken`/`token` trong bản dump plan.
  (`lib/automation/{types,normalize,engine,catalog,runtime,telegram}.ts` ·
  `app/api/automation/{dispatch,telegram}/route.ts` · `components/automation/ActionCard.tsx` tách
  ra từ `RuleEditor.tsx` · `app/globals.css`.)

- **Tab ▦ Office › Bảng tính — thanh định dạng như Excel + chèn dòng/cột đủ 4 hướng.** Trước đây
  chỉ sửa được nội dung ô: không đổi được font, màu, căn lề, không trộn ô, và chèn thì chỉ chèn
  được *xuống dưới* / *bên phải*. Nay có **ribbon** phía trên lưới (chỉ `.xlsx` — CSV là text
  thuần nên hiện thanh chèn/xóa dòng-cột kèm ghi chú): **font** (10 kiểu chữ · cỡ 8→48 ·
  **B** *I* <u>U</u> S̶ · màu chữ · màu nền, mỗi màu kèm nút ⌫ bỏ màu) · **kẻ viền** (tất cả ô ·
  viền ngoài vùng · từng cạnh · bỏ viền) · **căn lề** (trái/giữa/phải/đều + trên/giữa/dưới + wrap
  text) · **định dạng số** (Chung · `#,##0` · `#,##0.00` · tiền ₫ · tiền $ · % · ngày · ngày giờ ·
  giờ · văn bản, thêm hai nút **thêm/bớt số thập phân** tự sửa pattern đang có mà giữ ký hiệu tiền)
  · **trộn ô & căn giữa** + **bỏ trộn** · **xóa định dạng**. Định dạng áp cho **ô đang chọn hoặc cả
  vùng đã quét**; `Ctrl+B/I/U` chạy ngay trên lưới; **bấm đầu dòng/cột là chọn cả dòng/cột** để
  định dạng hàng loạt, **chuột phải** (trong lưới hoặc trên đầu dòng/cột) ra menu chèn dòng
  lên trên/xuống dưới · chèn cột bên trái/bên phải · xóa · trộn ô · xóa định dạng — chọn 3 dòng thì
  chèn 3 dòng như Excel (trần 200/lần để không lỡ tay thêm mấy nghìn dòng khi đang chọn cả cột).
  Đổi định dạng số là **thấy ngay trong lưới** (1234567 → `1,234,567 ₫`, số ngày → `05/08/2026`)
  chứ không phải lưu rồi mở lại, vì client format lại từ giá trị thô.
  **Cơ chế lưu vẫn là op log**: thêm ba op `style` / `merge` / `unmerge` (patch mang ngữ nghĩa
  *giữ / xóa / đặt* từng thuộc tính, nên "bôi đậm" không làm mất màu và cỡ chữ sẵn có của ô), server
  đọc lại file rồi replay theo thứ tự — ô không đụng tới giữ nguyên style và công thức, vẫn backup
  `.bak` trước khi ghi đè. Server **clone** style trước khi sửa (ExcelJS dùng chung một object style
  cho mọi ô cùng xf khi đọc file — sửa tại chỗ là đổi lây sang ô khác), chặn màu không phải
  `#rrggbb`, chặn vùng > 200.000 ô, và ghi thêm số liệu `style=`/`merge=` vào dòng `SHEET_AUDIT`.
  (`lib/sheet.ts` · `lib/sheetClient.ts` · `lib/numFmt.ts` · `components/SheetFormatBar.tsx` ·
  `components/SheetWorkspace.tsx` · `app/globals.css`.)

- **Tab ⎇ Git — clone repo mới + bỏ toàn bộ thay đổi của một repo.** Hai việc trước đây phải mở
  terminal. **⧉ Clone repo…** (nút cạnh đường dẫn project, dùng được cả khi project chưa có repo
  nào) `git clone` về **thư mục gốc của project đang chọn**, nên repo mới tự xuất hiện trong danh
  sách repo và được chọn luôn sau khi xong; tên thư mục tự suy ra từ URL (bỏ đuôi `.git`) nhưng sửa
  được, có ô branch tùy chọn (`--branch`, trống = mặc định của remote), cảnh báo ngay khi tên đã
  tồn tại trong project, và không đóng được modal khi đang clone (repo lớn mất vài phút).
  **⟲ Bỏ tất cả** (header khối "Thay đổi", chỉ hiện khi có thay đổi) = `git reset --hard` +
  `git clean -fd`: hủy rebase dở dang trước (nếu không `reset --hard` để repo kẹt giữa rebase),
  đưa index + working tree về HEAD (cả phần đã stage), xóa file/thư mục chưa theo dõi, nhưng
  **giữ nguyên file trong .gitignore** (`node_modules`, `.env`, build) vì `clean` chạy không có
  `-x`; repo chưa có commit nào (không có HEAD) thì làm rỗng index rồi clean. Confirm liệt kê rõ
  từng nhóm sẽ mất và báo lại số liệu thật ("2 file về HEAD, xóa 2 file mới"). **An toàn**: URL chỉ
  nhận `https://` · `ssh://` · `git://` · `git@host:group/repo.git` (chặn `ext::` — transport chạy
  lệnh tùy ý — và URL mở đầu bằng `-`), tên thư mục bắt buộc là **một** đoạn đường dẫn nên clone
  không thể ra ngoài root project, đường dẫn đích dựng ở server chứ không lấy từ client,
  `GIT_TERMINAL_PROMPT=0` để repo private thiếu credential **lỗi ngay** thay vì treo chờ nhập mật
  khẩu ẩn, timeout riêng 10 phút cho clone. (`lib/gitCore.ts` · `lib/git.ts` ·
  `app/api/git/route.ts` · `components/GitWorkspace.tsx`.)

- **Tab 🤖 Automation — một engine cấu hình được cho cả tin nhắn lẫn hạ tầng (không hardcode).**
  Mọi nguồn được chuẩn hoá về **một** kiểu sự kiện rồi chạy qua đúng một pipeline
  `nguồn → trigger → phạm vi → khung giờ → điều kiện → giới hạn → hành động`, nên quy tắc viết cho
  Zalo và quy tắc "Redis RAM > 80%" dùng chung code. Chia **nhóm tính năng**: 💬 **social**
  (`message.received` từ tab Workspace — Zalo/Telegram/WhatsApp) · 📡 **infrastructure**
  (`infra.metric`/`infra.recovered` từ watch trên chính registry kết nối Redis/Mongo/ES/Kafka/
  Rabbit/PG) · ⚙ **system** (dành sẵn). **Hành động**: `notify` (toast trong app + OS
  notification, mức urgent không tự tắt) · `webhook` (chạy **server-side** → không dính CORS,
  header auth không lọt vào network log của browser, timeout 10s) · `log` (JSON-lines) ·
  `kafka` (produce qua connection đã lưu) · `reply` (**không bao giờ tự gửi** — chỉ
  `pending-approval` cho người duyệt). Điều kiện có 15 toán tử (contains/regex/anyOf/gt/lt/
  empty…), body/key/value hỗ trợ `{{template}}` đọc mọi field của sự kiện. Chống bão bằng
  `dedupeSec` + `cooldownSec` + `maxPerHour`, thứ tự quy tắc sắp xếp được vì `stopOnMatch`.
  **Theo dõi hạ tầng**: watch = `stack + kết nối + metric op ngưỡng`, poll tối thiểu 15s, phải giữ
  vi phạm đủ `forSec` mới bắn (debounce), nhắc lại theo cooldown, tự bắn "đã hồi phục"; runner
  dùng **một** tick 2s với `nextDue` riêng từng watch (không đẻ N timer), đổi ngưỡng là xoá lịch
  sử vi phạm; probe **không bao giờ throw** (hỏng → `up=0`, nên mất kết nối vẫn cảnh báo được) và
  **thiếu metric ≠ vi phạm** (im lặng còn hơn báo động giả); 6 adapter gộp cụm theo hướng "xấu
  nhất thắng" (gauge lấy max, hit rate lấy min, khối lượng lấy sum, alarm Rabbit một node = chặn
  cả cluster). **An toàn mặc định**: đọc tin nhắn OFF · theo dõi hạ tầng OFF · cho phép gửi OFF ·
  quy tắc mới luôn `dryRun` (dry-run vẫn hiện toast — đó chính là mục đích), và mọi công tắc an
  toàn áp dụng ngay bằng một cú click chứ không kẹt trong bản nháp. UI dựng **từ catalog dữ liệu**
  (thêm metric/trigger/nhóm = thêm entry, không sửa editor), 4 tab con Quy tắc / Theo dõi hạ tầng /
  Hoạt động / Thử — Hoạt động hiện cả sự kiện **không** khớp kèm lý do bỏ qua của từng quy tắc,
  Thử dựng sự kiện tay và chạy trên state vứt đi nên không ăn mất cooldown thật. Cấu hình + log
  lưu per-máy (`.automation.json`, `.automation-log.jsonl`) và **đã gitignore** vì có thể chứa
  webhook URL kèm token và nội dung tin nhắn. (`lib/automation/*` · `lib/workspace/capture.ts` ·
  `components/automation/*` · `components/AutomationHost.tsx` ·
  `app/api/automation/{route,dispatch/route}.ts` · `app/page.tsx` · `app/globals.css` ·
  `.gitignore` · `lib/automation/README.md`.)

- **Workspace: thêm Telegram + nhận diện thương hiệu ngay trên rail.** Telegram Web A
  (`web.telegram.org/a/`) thành plugin thứ hai, cũng `multiAccount` — nhiều tài khoản Telegram và
  Zalo đăng nhập song song, mỗi tài khoản một phiên độc lập (`persist:ws-{plugin}-{account}`),
  không chia sẻ cookie/storage. Không tách phân vùng riêng cho từng app: chỉ cần **nhìn là biết**,
  nên mỗi plugin khai báo `brand: { color, logo }` và UI vẽ **logo vector thật**
  (`components/BrandMark.tsx` — zalo · telegram · whatsapp, fallback emoji) ở hàng plugin, ở từng
  chip tài khoản và trên toolbar, kèm màu nhận diện tô viền hàng đang mở / vòng avatar / bong bóng
  chưa đọc. Bộ thu gom về **một script generic** hook cả `new Notification()` lẫn
  `ServiceWorkerRegistration.showNotification()` (PWA như Telegram/WhatsApp dùng dạng service
  worker) + quét badge DOM + đọc `(N)` trên title; plugin chỉ khai báo `capture: { genericTitles,
  bodySenderSeparator, extraScript, disableBadgeScan }` chứ không fork script. Nội dung tin chỉ
  được ghi khi cờ `window.__wsCap` bật (renderer đặt theo công tắc "đọc tin nhắn" — mặc định tắt).
  WhatsApp Web để sẵn dạng comment, bật là chạy. (`lib/workspace/{plugins,types,capture,accounts}.ts`
  · `components/{BrandMark,BrowserWorkspace,WorkspaceView}.tsx` · `app/globals.css` ·
  `lib/workspace/README.md`.)

- **Tab 🗂 Office — nút ＋ Tạo file mới (Excel/CSV/Word) + Esc thoát hộp thoại chọn file.**
  Cả hai editor nay tạo được file trống ngay trong DevBox: modal dùng chung nhập tên file
  (tự thêm đuôi, chọn `.xlsx`/`.csv` cho Bảng tính, `.docx` cho Văn bản), chọn thư mục lưu bằng
  FolderPicker (folder mode, pre-fill theo file đang mở / mở gần đây) rồi "Tạo & mở" — file
  được tạo xong mở luôn vào editor. Server: action `create` trên `/api/sheet` + `/api/word`,
  CREATE-ONLY (`wx`, không bao giờ ghi đè file trùng tên), tên file bị lọc ký tự cấm Windows
  (`\ / : * ? " < > |`…), cùng gate `OFFICE_ALLOW_WRITE` với Lưu và audit-log
  `SHEET_AUDIT`/`WORD_AUDIT operation=CREATE`; `.xlsx` mới có sẵn "Sheet1", `.docx` mới là
  skeleton OOXML tối thiểu hợp lệ (1 đoạn trống + trang A4, Word/LibreOffice mở được).
  Kèm sửa UX: phím **Esc** giờ đóng được FolderPicker (mọi chỗ dùng chung: Office, Git,
  ＋ Projects) và modal tạo file (đang mở picker con thì Esc đóng picker trước).
  (`lib/{officeFiles,sheet,sheetClient,word,wordClient}.ts` · `app/api/{sheet,word}/route.ts` ·
  `components/{OfficeNewFileModal,SheetWorkspace,WordWorkspace,FolderPicker}.tsx`.)

- **Tab Ⓖ Google — quản lý tài liệu Drive theo dự án (READ-ONLY, MULTI-ACCOUNT).** Dành cho
  dev/techlead nhiều dự án, nhiều tài khoản: đăng nhập **nhiều tài khoản Google song song**
  (chip chuyển tài khoản trên toolbar, ✕ đăng xuất từng cái, "＋ Tài khoản" chạy lại consent
  với `select_account`; tài khoản đang chọn nhớ theo máy). Ba phân vùng theo tài khoản đang
  chọn: **📁 Dự án** (dán link thư mục Drive gốc của từng dự án → `.googleroots.json` per-máy,
  gắn per-tài-khoản; duyệt cây thư mục con với breadcrumb, folder trước file sau, mở file là
  nhảy sang Drive), **📝 Docs** và **📊 Sheets** (danh sách toàn Drive — My Drive + Shared
  Drives — mới sửa trước, tìm theo tên, lọc ⭐ đã gắn sao của chính Drive, phân trang "Tải
  thêm"; mỗi dòng hiện owner + thời gian sửa tương đối). Đăng nhập OAuth loopback: tạo OAuth
  client Web trên Google Cloud một lần (dùng chung mọi tài khoản), bỏ `GOOGLE_CLIENT_ID/SECRET`
  vào `.env.local` (UI có hướng dẫn từng bước khi chưa cấu hình), bấm Đăng nhập → consent →
  token lưu per-máy `.googleauth.json` (gitignored, `{ accounts: [...] }`), tự refresh
  per-tài-khoản; Đăng xuất = revoke + gỡ khỏi danh sách. An toàn: scope `drive.readonly`,
  server chỉ gọi `files.list`/`files.get` — không tồn tại code path ghi lên Drive; browser
  không bao giờ thấy token; mọi API call phải chỉ định `accountId` tường minh. Không thêm
  dependency (gọi thẳng REST v3 bằng fetch). Gate: `GOOGLE_TOOL_ENABLED`.
  (`lib/{google,googleAuth,googleDrive,googleRoots}.ts` ·
  `app/api/google/{route,callback/route}.ts` · `components/GoogleWorkspace.tsx` · `app/page.tsx` ·
  `app/globals.css` · `.env.example` · `.gitignore`.)

- **Tab 🗂 Office — đọc & sửa Excel (.xlsx) / CSV / Word (.docx) ngay trong DevBox.** Một tab, hai
  phân vùng (mount-and-keep, file đang mở sống sót khi chuyển qua lại): **▦ Bảng tính** — lưới
  cột A/B/C… + số dòng sticky, nhiều sheet, ô công thức gắn badge ƒ (sửa sẽ ghi đè công thức bằng
  giá trị — có cảnh báo), sửa ô (click → gõ → Enter/Tab), thêm/xóa dòng; **🗎 Văn bản** — tài liệu
  hiện theo đoạn văn đúng cấp heading/bullet, click ¶ chọn đoạn, click chữ để sửa (textarea,
  Ctrl+Enter/blur), thêm/xóa đoạn; bảng chỉ-xem, đoạn chứa ảnh/link/field bị KHÓA sửa (server
  cũng từ chối) để không phá nội dung đó. Cả hai dùng chung mô hình OP LOG: server đọc lại file
  và replay từng thao tác — Excel qua ExcelJS (ô không đụng giữ style/độ rộng cột/merge/công
  thức), Word sửa thẳng `word/document.xml` qua JSZip + xmldom (đoạn không sửa giữ nguyên
  100%, đoạn sửa giữ định dạng run đầu), CSV qua papaparse (tự nhận delimiter, giữ BOM UTF-8
  kiểu Excel Việt, giữ CRLF/LF). Lưu = ghi đè sau modal xác nhận, LUÔN sao lưu `<file>.bak`
  (ghi tạm + rename atomic), từ chối khi file đổi từ lúc mở (so mtime); `.xlsm`/`.doc`/`.docm`
  bị từ chối. Nút 📂 Browse mở file picker server-side (FolderPicker dùng chung nay liệt kê FILE
  theo đuôi + dải quick-access Desktop/Documents/Downloads/Home/Ổ đĩa như hộp thoại Windows —
  Git tab và ＋ Projects hưởng chung), "Mở gần đây" nhớ theo máy. Trần 20 MB; hiển thị tối đa
  5.000 dòng × 256 cột/sheet · 5.000 đoạn. Gates: `OFFICE_TOOL_ENABLED` + `OFFICE_ALLOW_WRITE`
  (tên cũ SHEET_* vẫn nhận) — audit-log `SHEET_AUDIT`/`WORD_AUDIT`.
  (`lib/{officeFlags,officeFiles,sheet,sheetClient,word,wordClient,fsBrowse}.ts` ·
  `app/api/{sheet,word,fs-browse}/route.ts` ·
  `components/{OfficeWorkspace,SheetWorkspace,WordWorkspace,FolderPicker}.tsx` · `app/page.tsx` ·
  `app/globals.css` · `.env.example` · `package.json` (papaparse, jszip, @xmldom/xmldom).)

- **Nhiều tài khoản Zalo cùng lúc + báo tin nhắn mới trên menu.** (1) Plugin có thể bật
  `multiAccount` (Zalo đã bật): mỗi tài khoản là một phiên trình duyệt độc lập với partition riêng
  (`persist:ws-zalo-<account>`) nên 2 Zalo đăng nhập song song không đụng nhau. Thêm/đổi tên/xoá tài
  khoản ngay trên rail; danh sách nhớ theo máy (`localStorage`), xoá tài khoản là xoá luôn phiên trên
  đĩa. (2) Mỗi workspace báo số tin chưa đọc (đọc từ tiêu đề trang, Zalo đặt `(N) Zalo`) → bong bóng
  đỏ trên tài khoản **và** trên tab 🧭 Workspace (thấy được từ tab khác), cập nhật tiêu đề cửa sổ
  (`(N) VHS DevBox`), và **kêu chuông** khi tổng tăng. Nút 🔔/🔕 ở đầu rail để tắt/bật chuông (nhớ).
  Guest ẩn không bị throttle (`backgroundThrottling=false`) nên báo kịp khi đang ở tab khác; thông báo
  OS gốc của Zalo vẫn chạy nhờ quyền `notifications`.
  (`lib/workspace/{types,plugins,accounts}.ts` · `lib/workspace/config.ts` ·
  `components/{BrowserWorkspace,WorkspaceView}.tsx` · `app/page.tsx` · `app/globals.css` ·
  `electron/main.cjs`.)

- **Browser Workspace Framework — nhúng web app thật (Zalo cá nhân, Grafana, Kibana…) làm
  workspace hạng nhất trong tab 🧭 Workspace.** Framework plugin-based, generic: mỗi workspace là
  một cửa sổ trình duyệt thật (Electron `<webview>`, KHÔNG phải iframe, không reverse-engineer) với
  **phiên đăng nhập riêng lưu trên máy** (cookies/localStorage/IndexedDB/cache tại `data/browser/`),
  nên đăng nhập một lần (quét QR) là dùng được qua nhiều lần khởi động. Thêm/bớt workspace chỉ cần
  khai báo trong `lib/workspace/plugins.ts` (`{id, name, icon, url, permissions, keepAlive}`) — không
  đụng code engine. Zalo chỉ là plugin đầu tiên, không phải trung tâm. Engine/Manager/UI tách rời:
  Browser Engine + hardening (permission allow-list, chặn/nới download theo config, popup mở ra
  trình duyệt ngoài, log lifecycle created/navigate/fail/crash) ở `electron/main.cjs`; Workspace
  Manager (chọn active, mount-and-keep, LRU theo `maxActiveWorkspace`, `keepAlive`, `lazyLoad`) +
  UI (rail plugin, toolbar back/forward/reload/home/devtools/logout/mở-ngoài, trạng thái
  loading/failed/crashed + tự reload 1 lần khi treo) ở `components/BrowserWorkspace.tsx` +
  `components/WorkspaceView.tsx`. Chạy: `npm run dev` rồi `npm run desktop`; ngoài app desktop tab
  hiện hướng dẫn thay vì lỗi. Không ảnh hưởng module cũ.
  (`electron/main.cjs` · `electron/preload.cjs` · `lib/workspace/{types,plugins,config}.ts` ·
  `components/{BrowserWorkspace,WorkspaceView}.tsx` · `app/page.tsx` · `app/globals.css` ·
  `package.json` · `.gitignore` · `.env.local`.)

- **Telegram MR-review bot trở lại — workspace lấy từ project đã đăng ký, không hardcode.**
  Cụm `bot/` port từ `omicx-local-all-in-one` (long-poll Telegram → chạy engine read-only
  `/review-mr-dev` qua `claude` CLI → reply verdict + SCORE vào group; dedup theo sha commit,
  offset + trạng thái trong `bot/.state.json` / `bot/.status.json`, `npm run bot:status` để xem
  snapshot, tùy chọn DM owner lúc START/DONE). Không mở cổng lắng nghe nào.
  Điểm khác bản gốc: **cấu hình theo đúng mô hình integration pack** — bot không còn đòi
  `OMICX_BASE_PATH`, mà đọc chính registry per-máy do UI ghi ra, theo thứ tự
  `BOT_BASE_PATH` → `BOT_PROJECT=<id|tên>` → **đúng 1** pack trong `.apiintegrations.json` →
  **đúng 1** project trong `.gitprojects.json` → thư mục cha của repo. Nhiều lựa chọn mà không
  có `BOT_PROJECT` → **fail-fast kèm danh sách project đang có**, không đoán bừa; nguồn đã dùng
  được in ở dòng log boot (`workspace lấy từ: project "OMICX" (.apiintegrations.json)`).
  Prefix nhận diện service reviewable cũng thành env `REVIEW_SERVICE_PREFIX` (mặc định
  `cloud-saas-omicx-`, export từ `lib/reviewMr.ts` để bot và Git tab dùng chung một định nghĩa).
  Scripts mới: `npm run bot` · `bot:status` · `bot:test` (deps `tsx`, `dotenv`).
  (`bot/*` (12 file), `lib/reviewMr.ts`, `package.json`, `.gitignore`, `.env.example`,
  `README.md`, `bot/README.md`.)

- **Nút 📂 Browse khi đăng ký integration pack — không còn gõ đường dẫn tay.** Ô "Folder chứa
  `devbox.api.json`" ở tab **＋ Projects** giờ có nút Browse mở folder picker chạy trên server
  (browser không bao giờ đọc được absolute path, nên server list thư mục cho user click). Picker
  được **tách thành component dùng chung** `components/FolderPicker.tsx` (Git workspace và ＋
  Projects dùng chung một bản), thêm khả năng **đánh dấu marker**: thư mục nào có
  `devbox.api.json` hiện badge `▤ pack`, thư mục đang mở hiện `✓ devbox.api.json` /
  `⚠ chưa có devbox.api.json` → thấy đúng repo cần chọn thay vì thử-sai. Ô text vẫn giữ (dán
  đường dẫn / Enter để đăng ký), tên pack tự điền từ tên thư mục nếu còn trống.
  Route mới `/api/fs-browse` (project-neutral, nhận `marker` — chỉ là tên file, không cho path
  fragment; trả listing thư mục, không bao giờ trả nội dung file; bật sẵn, tắt bằng
  `FS_BROWSE_ENABLED=0`); implementation chuyển sang `lib/fsBrowse.ts`. `/api/git-fs` +
  `lib/gitFs.ts` giữ lại làm alias deprecated cho script cũ.
  (`components/FolderPicker.tsx`, `components/PackManager.tsx`, `components/GitWorkspace.tsx`,
  `lib/fsBrowse.ts`, `lib/gitFs.ts`, `lib/git.ts`, `app/api/fs-browse/`, `app/api/git-fs/`,
  `app/globals.css`, `.env.example`, `README.md`.)

- **API Explorer trở lại — dưới dạng engine generic + integration packs.** Tab **API Explorer**
  mới hoàn toàn project-neutral: project tự "cắm" vào bằng manifest **`devbox.api.json`** đặt
  trong repo của chính nó — khai báo `services[]` (id, label, authMode
  `apikey|tool|jwt-user|jwt-agent|jwt-admin`, `spec` path tương đối repo, defaultBaseUrl,
  apiPrefix) và `flows[]` (chuỗi request với `{{var}}` capture — model Flow cũ, giờ là JSON data).
  Operator đăng ký pack trong UI (tên + folder; registry per-máy `.apiintegrations.json`,
  gitignored, validate manifest tồn tại; spec path được **containment-check** không cho trỏ ra
  ngoài pack root). Engine port từ bản gốc: `lib/openapi.ts` (parse spec từ file path),
  `lib/types.ts`, `EndpointForm`/`FlowRunner`/`ResponseView`, route `/api/curl` +
  `/api/agent-token` (mint agent token qua tool-service cấu hình ở tab Webhooks);
  `lib/request.ts` khôi phục đầy đủ (callEndpoint/fetchCurl/interpolate/readPath) với auth-mode
  metadata inline (không còn services.ts hardcode). Config kết nối per-(pack, service) lưu key
  `"<pack>:<service>"` qua store chung; global vars API_KEY/JWT_TOKEN_* như cũ. Route mới:
  `/api/api-integrations` (CRUD registry + đọc manifest), `/api/api-catalog` (parse spec).
  **OMICX là pack đầu tiên** — manifest nằm trong repo `omicx/omicx-local-all-in-one`
  (4 services: public/tool/ai/admin + 2 flows public-service).
  (`lib/apiIntegrations.ts`, `lib/openapi.ts`, `lib/types.ts`, `lib/request.ts`,
  `app/api/api-integrations/`, `app/api/api-catalog/`, `app/api/curl/`, `app/api/agent-token/`,
  `components/ApiExplorerWorkspace.tsx`, `components/{EndpointForm,FlowRunner,ResponseView}.tsx`,
  `app/page.tsx`, `app/globals.css`, `.gitignore`.)

### Fixed

- **Bấm link trong tin nhắn Zalo vẫn báo "Có lỗi xảy ra khi mở popup mới" — vì cửa sổ ẩn bị huỷ
  quá sớm.** Lần sửa trước chỉ kiểm `w !== null` nên tưởng đã xong, nhưng phép dò popup chuẩn của
  web là `if (!w || w.closed || typeof w.closed === 'undefined')` và **Zalo kiểm lại sau một nhịp**
  — lúc đó cửa sổ ẩn đã `destroy()` nên `w.closed === true`, và toast vẫn hiện dù link mở đúng.
  Giờ cửa sổ ẩn được `stop()` (không tải gì) rồi mới huỷ sau `POPUP_STUB_TTL_MS` = 10s. Đo bằng
  harness Electron dựng đúng phép kiểm trên: huỷ ngay → sync OK / **async BLOCKED (closed=true)**;
  giữ rồi huỷ → sync OK / **async OK (closed=false)**; và URL của cửa sổ ẩn rỗng suốt, tức link
  thật không bị request lần hai. (`electron/main.cjs`.)

- **Bỏ hẳn việc đẩy link của tab Workspace đi nơi khác — Zalo/Telegram ở lại trong cửa sổ của nó.**
  Gỡ cả hộp thoại "Mở liên kết ở đâu?" (3 lựa chọn Links / Browser / trình duyệt ngoài) lẫn lớp
  chặn điều hướng `will-navigate`/`will-redirect` đã đẩy link ra browser ngoài. Cả hai đều **hiểu
  sai vấn đề**: chúng bắt luôn cả điều hướng của chính app, nên **quét QR xong Zalo bị chặn lại và
  hỏi mở ở đâu** thay vì hiện giao diện chat. Workspace là một app đóng trong app — quét QR, đăng
  nhập, đổi subdomain, bấm link trong tin nhắn đều phải diễn ra **ngay trong cửa sổ đó**; DevBox
  không chặn, không hỏi, không đẩy URL đi đâu. `window.open` của workspace giờ điều hướng thẳng
  trong chính webview đó (về chat bằng nút ← trên thanh công cụ). Các webview khác (tab Links, tab Browser, viewer Google) **không đổi**
  hành vi: popup vẫn ra trình duyệt thật. Kèm một lỗi lặng: cờ "guest này có phải workspace không"
  từng chốt theo biến tạm của `will-attach-webview` — event đó rời khỏi `did-attach-webview` nên
  nhiều `<webview>` mount cùng một nhịp render là thứ tự xen vào nhau và luật áp sai guest; giờ đọc
  bằng **danh tính session** (`session.fromPartition(p) === guest.session`) nên không thể lẫn.
  Xoá `components/OpenLinkDialog.tsx`, `lib/openTarget.ts` và IPC `workspace:openRequest` (giữ
  `workspace:openExternal` — nút ↗ tab Google và panel lỗi mail đang dùng).
  (`electron/{main,preload}.cjs`, `app/page.tsx`, `app/globals.css`,
  `components/{LinksWorkspace,BrowserTabWorkspace}.tsx`, `lib/workspace/types.ts`.)

- **Cửa sổ xin quyền Google: không cuộn được xuống nút Continue.** Trang consent cao hơn khung mà
  cuộn bằng chuột trong `<webview>` lồng trong modal không đáng tin (hit-testing của Electron lệch
  khi có compositing ancestor), lại thêm `html/body` của trang consent bị Google khóa
  `overflow:hidden` — cuộn thật nằm ở một div bên trong nên cả `window.scrollBy` cũng vô dụng.
  Sửa theo hướng **không phụ thuộc cuộn**: (1) sau mỗi lần tải, đo phần thiếu rồi **tự thu nhỏ
  guest** (`setZoomFactor`, sàn 60%) đến khi trọn trang vừa khung → nút Continue hiện ra mà không
  cần cuộn; (2) header có nút **↓ / ⤓ / − / ＋** cuộn và zoom guest qua `executeJavaScript` — chạy
  trong chính guest, tự tìm div cuộn thật nên không dính hit-testing; (3) wheel rơi vào host được
  chuyển tiếp xuống guest (guest ăn được wheel thì handler này không chạy → không cuộn đôi).
  Kèm hai bẫy cũ: bỏ `min-height:560px` của modal (cửa sổ app thấp là modal tràn 2 đầu, backdrop
  căn giữa nên phần cắt ở đáy — đúng chỗ nút Continue — không lấy lại được), và overlay "đang tải"
  giờ `pointer-events:none` + tự tắt sau 12s để nó không ngồi che chặn chuột nếu `did-stop-loading`
  không bao giờ nổ. (`components/GoogleAuthWindow.tsx`, `lib/workspace/types.ts`, `app/globals.css`.)

### Changed

- **Fork thành `vhs-dev-box` — infra toolbox trung lập dự án.** Tách từ
  `omicx/omicx-local-all-in-one` (bản gốc giữ nguyên trong repo omicx): **bỏ OMICX API Explorer**
  (endpoint catalog/openapi, Explore/Flows, Sidebar, SettingsDrawer, EnvManager, HealthDot,
  `/api/spec` `/api/config` `/api/curl` `/api/agent-token`, `lib/{openapi,flows,services,types}`)
  và **bỏ Telegram review bot** (`bot/`, scripts `bot`/`bot:status`, deps `dotenv`/`tsx`).
  Giữ nguyên: Webhooks (vẫn dùng `/api/proxy` + tool auth), Git (gồm Review MR runner), Redis,
  Kafka, RabbitMQ, MongoDB, Elasticsearch, PostgreSQL — đầy đủ quick-find/export/monitor.
  `page.tsx` viết lại gọn (tabs data-driven, lazy mount-and-keep), `lib/request.ts` slim còn
  auth helpers, rebrand **VHS DevBox**. Lịch sử bên dưới kế thừa từ bản gốc.

### Changed

- **Đổi tên hiển thị `OMICX DevBox` → `OMI DevBox`.** Tool giờ dùng chung cho toàn OMI (không riêng
  OMICX) nên wordmark ở header, `<title>` trang, và dòng footer đổi sang **OMI DevBox**.
  (`app/page.tsx`, `app/layout.tsx`.)

### Added (monitor Redis · Mongo · Kafka — theo mô hình node monitor của Elastic)

- **MongoDB: mục Monitor trong Tổng quan (auto 30s).** `serverStatus` + `dbStats` +
  `replSetGetStatus` mỗi 30s (chỉ khi đang mở Tổng quan + browser tab visible, toggle tắt được):
  **RAM resident/virtual** của mongod, **Disk data volume** (`fsUsedSize/fsTotalSize`, MongoDB ≥4.4),
  **Connections** current/available (gauge %), **WiredTiger cache** used/max (gauge %), **ops/s**
  theo từng opcounter (client tự diff 2 lần poll), và bảng **replica-set members** với state
  (PRIMARY/SECONDARY) + **replication lag** (đỏ khi >10s). Gauge đổi màu ≥75%/≥90%.
- **Redis: dải 📈 Monitor trong workspace (auto 30s khi mở).** INFO per node (single, hoặc **mỗi
  master của cluster**): **memory used vs maxmemory** (fallback so với system RAM; gauge, card viền
  đỏ khi ≥90%), clients, **ops/s** (instantaneous), **keyspace hit-rate**, **fragmentation ratio**
  (vàng khi >1.5), uptime, role + số replica. Mặc định **thu gọn** — chỉ poll khi mở.
- **Kafka: dải 📈 Cluster health (auto 60s khi mở).** Wire protocol Kafka không expose CPU/RAM/disk
  (cần JMX/exporter) nên monitor tập trung đúng thứ làm operator mất ngủ: **brokers** (★ controller,
  số partition leader mỗi broker — nhìn lệch tải), **under-replicated partitions** (ISR hụt) và
  **offline partitions** (mất leader — producer đang fail), kèm danh sách **topic bị ảnh hưởng**;
  panel viền đỏ khi có sự cố. Mặc định thu gọn — chỉ poll khi mở. **RAM/disk/CPU/load per broker
  host** có được qua ô **Metrics URLs** (tuỳ chọn) trên connection: khai báo endpoint
  **node_exporter** (`http://host:9100/metrics`, qua VPN không auth) → server fetch + parse
  Prometheus text (5s timeout, lỗi per-URL hiện inline), render card per host với gauge **RAM**,
  **Disk per mount** (bỏ tmpfs/overlay, top 3 theo size), **CPU %** (diff counter `node_cpu_seconds_total`
  giữa 2 lần poll) và **load 1m·5m·15m**; card viền đỏ khi RAM/disk ≥90%. Không khai báo URL thì
  strip hiện hint. (`lib/kafkaConnections.ts` (+`metricsUrls`), `lib/kafkaClient.ts`, `lib/kafka.ts`,
  `app/api/kafka/route.ts`, `components/kafka/HealthStrip.tsx`, `components/KafkaWorkspace.tsx`.)
- RabbitMQ đã có sẵn node monitor (RAM watermark / disk / fd / alarms, tự tải 10s opt-in) từ trước
  — không đổi.
  (`lib/mongoClient.ts`, `lib/mongo.ts`, `app/api/mongo/route.ts`, `components/mongo/OverviewView.tsx`,
  `components/MongoWorkspace.tsx`, `lib/redisClient.ts`, `lib/redis.ts`, `app/api/redis/route.ts`,
  `components/redis/MonitorStrip.tsx`, `components/RedisWorkspace.tsx`, `lib/kafkaClient.ts`,
  `lib/kafka.ts`, `app/api/kafka/route.ts`, `components/kafka/HealthStrip.tsx`,
  `components/KafkaWorkspace.tsx`, `app/globals.css`.)

### Added (PostgreSQL manager)

- **PostgreSQL manager (chạy local).** Tab **PostgreSQL** 🐘 hoàn thiện bộ datastore: cấu hình
  nhiều server theo **project** (host:port + database mặc định + username/password + ssl, nút
  **Test** báo version + latency; pool nhỏ max 3, key theo (connection, database) nên cây mở được
  các database anh em). **Tổng quan** (version, ping, danh sách DB + size). **Dữ liệu**: cây
  database → table (ước lượng rows + size), chọn bảng tự chạy `SELECT * … LIMIT 50`, editor SQL
  tự do — **mọi query đọc chạy trong transaction `READ ONLY` + `statement_timeout` 15s** (database
  tự từ chối write lén trong "read"), kết quả trần 500 dòng, render **bảng thật** cuộn ngang, click
  dòng mở JSON; tab **Columns** + **Indexes** per table. **🔎 Tìm nhanh** preset như Mongo/ES nhưng
  WHERE build **server-side dạng parameterized** (`= $n` / `= ANY($n)` cho list) — giá trị không
  bao giờ nối chuỗi vào SQL; gợi ý cột lấy đúng từ `information_schema`; đủ UX thu gọn tóm tắt +
  tab cột trả về + **📄 xuất .xlsx** (chung engine — timestamp ISO của PG thành date-cell thật).
  **Ghi duy nhất: UPDATE-with-WHERE** qua 3 lớp khoá (env `PG_ALLOW_WRITE` mặc định OFF +
  readOnly per-connection mặc định ON + typed-confirm modal với dry-run count); server luôn từ
  chối WHERE rỗng, `;` trong WHERE (1 câu lệnh duy nhất), và **không tồn tại code path
  insert/delete/DDL**; SET đi bằng bind parameter trên identifier đã validate; audit `PG_AUDIT …`.
  Gate `PG_TOOL_ENABLED` (mặc định OFF → 403). Hồ sơ lưu per-máy `.pgconnections.json` (gitignored,
  API chỉ trả `hasPassword`). Driver `pg` + `@types/pg`. Styles `.pg-*` tự sở hữu (clone `.mongo-*`).
  Engine báo cáo mở rộng nhận **ISO date string** (PG serialize timestamp) → date-cell.
  (`lib/pgConnections.ts`, `lib/pgClient.ts`, `lib/pg.ts`, `lib/pgQuickFinds.ts`,
  `app/api/pg-connections/route.ts`, `app/api/pg/route.ts`, `components/PgWorkspace.tsx`,
  `components/pg/*`, `lib/mongoReport.ts`, `app/page.tsx`, `app/globals.css`, `.gitignore`,
  `.env.example`, `package.json`.)

### Added (ES node monitor)

- **Elastic: monitor node realtime (heap / disk / CPU / load).** Mục **Nodes** trong Tổng quan:
  mỗi node 1 card với gauge **Heap %**, **Disk %** (kèm dung lượng còn trống), **CPU %** và
  **Load 1m·5m·15m**; ★ đánh dấu elected master; gauge đổi màu theo ngưỡng (≥75% vàng, ≥90% đỏ)
  và card viền đỏ khi heap/disk chạm 90%. **Tự fetch mỗi 10s** (`_cat/nodes` + `_cluster/health`)
  — chỉ chạy khi đang mở Tổng quan **và** browser tab visible, có toggle `auto 10s` tắt được +
  hiển thị thời điểm cập nhật gần nhất; refresh im lặng nên gauge trượt mượt không nháy.
  Cột `_cat/nodes` dùng giống nhau trên ES 6.8 → 8.x.
  (`lib/esClient.ts`, `app/api/es/route.ts`, `lib/es.ts`, `components/es/OverviewView.tsx`,
  `components/EsWorkspace.tsx`, `app/globals.css`.)

### Changed (export báo cáo — Mongo + ES)

- **Bỏ nội dung query khỏi dòng phụ đề (hàng 2)** của file .xlsx — giờ chỉ còn
  `namespace · số dòng · thời điểm xuất (· ghi chú cắt trần nếu có)`; filter nội bộ không lộ ra
  file gửi đi nữa.
- **Cột STT mặc định** (`__no` — số thứ tự 1..n, không phải giá trị document) luôn đứng đầu danh
  sách cột, xoá được như cột thường.
- **Trần 5 cột gợi ý mặc định** (chưa kể STT) để khung mapper vừa màn hình không phải cuộn;
  field còn lại vẫn nằm trong datalist gợi ý khi thêm cột.
- **Bề ngang tối thiểu cỡ A4**: báo cáo ít cột (2–5 cột) được **giãn cột theo tỷ lệ** cho tổng
  bề ngang đạt ~1 trang A4 thay vì co cụm thành dải hẹp; kèm print setup **A4 + fit-to-width**
  (dọc ≤6 cột, ngang >6 cột) nên in ra vừa đúng khổ giấy.
  (`lib/mongoReport.ts`, `components/mongo/ExportModal.tsx`, `components/es/ExportModal.tsx`.)

### Fixed

- **Modal cao quá viewport bị cụt mất phần đầu (title).** `.modal` là flex item của backdrop nên
  `min-height:auto` (= chiều cao nội dung) **thắng** `max-height:82vh` — modal xuất báo cáo với
  collection nhiều field phình cao hơn màn hình, căn giữa làm header/ô tiêu đề văng khỏi viewport.
  Sửa gốc: `.modal { min-height: 0; overflow: auto }` để `max-height` thực sự cap; đồng thời danh
  sách cột trong modal xuất báo cáo (Mongo + ES) cuộn nội bộ (`.export-colscroll`, trần 44vh) nên
  title + nút Xuất luôn nhìn thấy. (`app/globals.css`, `components/mongo/ExportModal.tsx`,
  `components/es/ExportModal.tsx`.)

### Added

- **Elasticsearch manager (read-only, chạy local).** Tab **Elastic** mới, nhân bản trải nghiệm tab
  MongoDB cho ES: cấu hình nhiều cluster theo **project** — mỗi cluster là **node list `host:port`**
  (phẩy, mặc định :9200 — như brokers bên Kafka; server **failover node-to-node** khi lỗi kết nối,
  HTTP response kể cả 5xx là authoritative không retry; record host+port cũ tự migrate). Hỗ trợ
  **ES 6.8 → 8.x**: major version được dò 1 lần per cluster — `track_total_hits` chỉ gửi cho ≥7
  (6.8 reject key lạ), `hits.total` chuẩn hoá cả dạng số (6.x) lẫn object (7+/8.x). Cluster qua VPN
  không auth; nút **Test** báo cluster name · version · health · số node · latency), **Tổng quan**
  (health xanh/vàng/đỏ, nodes, shards, **unassigned shards** nổi bật đỏ, danh sách indices với
  docs/size/pri×rep — ẩn index hệ thống `.*`, click index nhảy vào browser), **Dữ liệu** (danh sách
  index + query **DSL** phần `query`, sort/_source/size, phân trang from/size, **Count**, tab
  **Mapping** pretty JSON + **Info**), **🔎 Tìm nhanh** preset giống Mongo (field checkbox → `bool.filter`,
  kiểu **Exact(term) / Text(match) / Số / Boolean**, chế độ **single/list → terms**, thu gọn panel
  thành tóm tắt `{tenantId:t_123}`, tab **Trường trả về** = `_source` chip từ sample docs), và
  **📄 Xuất báo cáo .xlsx** styled (tái dùng engine `lib/mongoReport`). **Read-only tuyệt đối** —
  không tồn tại code path ghi (chỉ `_search/_count/_mapping/_cat/_cluster/health`); mọi search bị
  chặn `script`/`script_score`, size ≤200/trang, timeout 15s, giữ trong result window 10k. Gọi ES
  bằng **fetch thuần** (không thêm dependency). Gate `ES_TOOL_ENABLED` (mặc định OFF → 403); hồ sơ
  kết nối lưu per-máy `.esconnections.json` (gitignored). Styles `.es-*` tự sở hữu (clone từ
  `.mongo-*`, đúng convention kafka/rabbit).
  (`lib/esConnections.ts`, `lib/esClient.ts`, `lib/es.ts`, `lib/esQuickFinds.ts`,
  `app/api/es-connections/route.ts`, `app/api/es/route.ts`, `components/EsWorkspace.tsx`,
  `components/es/*`, `app/page.tsx`, `app/globals.css`, `.gitignore`, `.env.example`.)

- **MongoDB: Xuất báo cáo .xlsx từ kết quả Tìm nhanh.** Nút **📄 Xuất báo cáo** hiện sau khi query
  xong: đặt **tiêu đề báo cáo** (in đầu sheet + thành tên file slug), khai báo **cột** (tên cột ·
  field code — có datalist gợi ý từ field đã dò · định dạng). Định dạng **Auto** tự nhận diện
  từng giá trị: chữ → text, số → number (căn phải), **epoch timestamp** (giây hoặc mili — nhận theo
  độ lớn) → **date-cell Excel thật** (sort/filter chuẩn, đã bù timezone máy); 2 định dạng thời gian
  chọn tay per-cột: **Ngày** `dd/MM/yyyy` và **Ngày giờ** `HH:mm:ss dd/MM/yyyy`. File style chỉn
  chu: dòng tiêu đề 16pt merge toàn bảng, dòng phụ (namespace · query · số dòng · thời điểm xuất),
  header nền teal đậm chữ trắng, **zebra banding**, kẻ ô mảnh, freeze 3 dòng đầu, auto-filter,
  độ rộng cột tự tính theo dữ liệu. Xuất **toàn bộ kết quả khớp filter** (re-query server theo trang
  200, trần 5.000 dòng, projection chỉ các field trong cột nên nhẹ), không chỉ trang đang xem.
  ExcelJS nạp bằng **dynamic import** — không phình bundle chính.
  (`lib/mongoReport.ts`, `components/mongo/ExportModal.tsx`, `components/mongo/QuickFindView.tsx`,
  `package.json` (+`exceljs`).)

- **MongoDB: Tìm nhanh (quick-find preset, giống preset bên Kafka).** Sub-view **🔎 Tìm nhanh**
  trong tab MongoDB: tạo **nút tìm kiếm đặt tên sẵn** (ví dụ “Tìm tenant”) trỏ tới 1 connection +
  database + collection (có datalist gợi ý db/collection khi cấu hình) và khai báo sẵn **list field
  được query** (tên hiển thị · field path · kiểu mặc định). Khi chạy: **tích chọn** field cần dùng,
  điền giá trị — nhiều field = **AND** (equality per-field); mỗi field có **selector kiểu
  Text / ObjectId / Number / Boolean** (mặc định theo cấu hình, đổi được lúc chạy) — chọn
  **ObjectId** thì nhập hex 24 ký tự và tool tự convert sang ObjectId khi query (validate sớm ở
  client, báo đúng field sai). Mỗi field còn có chế độ **= single / ∈ list ($in)**: chọn list thì
  nhập nhiều giá trị cách nhau dấu phẩy (`quidn,tamtd`) → query `{domain: {$in: [...]}}`, từng phần
  tử vẫn được convert theo kiểu (list ObjectId ra ObjectId thật); tóm tắt hiển thị
  `domain:$in[quidn,tamtd]`. Row điều kiện layout **grid cột tường minh** (label · kiểu · chế độ ·
  giá trị) — tên field dài tự ellipsis trong cột riêng, không đè lên select. Kết quả: **mỗi document 1 dòng plaintext** trong dải cuộn ngang,
  **click mở modal JSON** pretty + copy (giống luồng tìm message bên Kafka). Bấm **Chạy** thì khung
  chọn field **tự thu gọn** thành 1 dòng tóm tắt dạng `{domain:quidn, is_deleted:false}` (bấm ✎ mở
  lại) để **kết quả chiếm tối đa màn hình** (72vh). Panel chạy có 2 tab: **Điều kiện** và **Trường
  trả về** — tab projection chọn **lúc chạy** (không nằm trong cấu hình preset): field gợi ý dạng
  chip được **tự dò từ documents thật** của collection (lấy mẫu 5 docs), tích để chọn, `_id` có
  toggle giữ/loại riêng, thêm được nested path thủ công (vd. `profile.phone`); để trống = trả
  nguyên document. Preset lưu
  **localStorage** (convention `kafkaPresets`); query chạy qua đúng action `find` của `/api/mongo`
  nên mọi giới hạn server (maxTimeMS, limit ≤200, chặn `$where`) áp dụng nguyên vẹn.
  (`lib/mongoQuickFinds.ts`, `components/mongo/QuickFindView.tsx`, `components/MongoWorkspace.tsx`,
  `app/globals.css`.)

- **MongoDB manager (kiểu Robo3T-lite, chạy local).** Tab **MongoDB** mới: cấu hình nhiều cluster
  theo từng **project** (standalone / replica set / `mongodb+srv`, TLS, authSource, có nút **Test**
  báo version + topology + latency trước khi lưu — giống Redis/Rabbit), cây **database →
  collection** kiểu Robo3T, truy vấn **find** (filter/projection/sort dạng JSON/EJSON — hỗ trợ
  `$oid`/`$date`, limit trần 200/trang + phân trang Prev/Next), **Count**, **Aggregate read-only**
  (chặn `$out`/`$merge`/`$where`/`$function`, tự gắn `$limit 500`, `allowDiskUse=false`), xem
  **Indexes** (unique/sparse/TTL/partial) + **Stats** ($collStats) + **Tổng quan** server
  (version, replica set, members, danh sách DB + size). **Đọc không giới hạn** phạm vi nhưng mọi
  query đều bounded `maxTimeMS` server-side. **Ghi chỉ có đúng 1 thao tác: update-có-query** —
  updateOne/updateMany bắt buộc **filter khác rỗng** (server từ chối `{}`), update doc chỉ nhận
  **toán tử `$`** (chặn thay thế cả document), không upsert/insert/delete/drop; qua **3 lớp khoá
  độc lập**: env `MONGO_ALLOW_WRITE` (mặc định OFF) + cờ **read-only per-connection** (mặc định
  ON) + modal **typed-confirm** (gõ lại `db.collection`, có **dry-run count** xem khớp bao nhiêu
  docs trước khi chạy); mọi update **audit** ra log server (`MONGO_AUDIT …`). Browser không nối
  thẳng MongoDB — mọi thao tác qua route server (driver `mongodb`, cache client theo hồ sơ, evict
  sau 10 phút idle). Toàn bộ tính năng **gate** bằng `MONGO_TOOL_ENABLED` (mặc định OFF →
  `/api/mongo*` trả 403). Hồ sơ kết nối lưu **per-máy** trong `.mongoconnections.json` (đã
  gitignore; API chỉ trả `hasPassword`, không trả password).
  (`lib/mongoConnections.ts`, `lib/mongoClient.ts`, `lib/mongo.ts`,
  `app/api/mongo-connections/route.ts`, `app/api/mongo/route.ts`,
  `components/MongoWorkspace.tsx`, `components/mongo/*`, `app/page.tsx`, `app/globals.css`,
  `package.json` (+`mongodb@^5` — driver v5 để nói chuyện được với server cũ MongoDB 3.6→7.0;
  driver v6 đòi server ≥4.2, còn cụm 4.0 wire-version 7 sẽ bị từ chối; server <4.4 không có lệnh
  `hello` nên có fallback `isMaster`), `.gitignore`, `.env.example`.)

- **Redis manager (kiểu RedisInsight, chạy local).** Tab **Redis** mới: cấu hình nhiều Redis
  **single-node** theo từng **project** (nhóm hiển thị theo project, badge màu theo môi trường
  dev/staging/**prod**), **Ping** đo độ trễ, tìm key bằng **SCAN** cursor-based (KHÔNG dùng `KEYS`
  để không block instance) + lọc theo kiểu + nút "Tải thêm" theo cursor, xem **value/type/TTL**
  (list/set/zset/hash tải bounded ≤500 phần tử + cờ `truncated`), **đặt/đổi TTL 1 key** (chặn
  `>30 ngày` cả ở UI lẫn server, không expose `PERSIST`), và **xoá 1 key** với **typed-confirm**
  (gõ lại tên key) + banner cảnh báo đỏ khi key là `*:lock:*` hoặc kết nối `env=prod`; mọi lần xoá
  đều **audit** ra log server. KHÔNG có bulk-delete/`FLUSHDB`/`FLUSHALL`. Browser không nối thẳng
  Redis — mọi thao tác đi qua route server (`ioredis`, tái dùng socket theo hồ sơ). Toàn bộ tính
  năng **gate** bằng `REDIS_TOOL_ENABLED` (mặc định OFF → `/api/redis*` trả 403, an toàn khi
  deploy). Hồ sơ kết nối lưu **per-máy** trong `.redisconnections.json` (đã gitignore, password
  plaintext như convention `.apitester-config.json`; API chỉ trả `hasPassword`, không trả password).
  (`lib/redisConnections.ts`, `lib/redisClient.ts`, `lib/redis.ts`, `app/api/redis-connections/route.ts`,
  `app/api/redis/route.ts`, `components/RedisWorkspace.tsx`, `app/page.tsx`, `app/globals.css`,
  `package.json` (+`ioredis`), `.gitignore`, `.env.example`.)

- **Git workspace: nhiều project (root folder cấu hình được) thay vì 1 root hard-code.** Trước đây
  root chỉ đến từ env (`GIT_TOOL_ROOT`) → chỉ 1 nơi quét repo. Giờ mỗi **project = `{ name, root }`**
  hiện thành 1 **tab** ở đầu Git workspace; đổi tab là đổi thư mục gốc → danh sách repo + toàn bộ
  chức năng (status/overview/pull-all/history/commit) chạy theo root đó. Có khối **Quản lý** để
  thêm/sửa/xóa project ngay trên UI. Config lưu **per-máy** trong `.gitprojects.json` (đã gitignore
  — mỗi máy cấu trúc folder khác nhau, cấu hình 1 lần); chưa có file thì tự fallback về root
  auto-detect như cũ (tab `auto`) nên không vỡ hành vi cũ. Root **không giới hạn base** (tool chạy
  local, ai chạm được đã có filesystem của dev) — chỉ cần thư mục tồn tại; `GIT_TOOL_BASE`/
  `GIT_TOOL_ROOT` chỉ là **điểm xuất phát** cho folder picker, có thể cấu hình. Lựa chọn repo được
  nhớ **theo từng project**. Backend: `detectRepos/statusAll/pullAll` nhận `root` động,
  `authorizeRepo` nhận danh sách root cho phép; thêm route `/api/git-projects` (GET/POST/PUT/DELETE)
  + `lib/gitProjects.ts`. (`lib/gitProjects.ts`, `lib/gitCore.ts`, `app/api/git-projects/route.ts`,
  `app/api/git/route.ts`, `lib/git.ts`, `components/GitWorkspace.tsx`, `app/globals.css`,
  `.gitignore`.)
- **Git workspace: nút Browse chọn thư mục gốc (server-backed folder picker).** Ô "Đường dẫn thư
  mục gốc" có nút **📂 Browse** mở modal duyệt thư mục của máy host — vì trình duyệt không đọc được
  absolute path, server liệt kê thư mục qua `/api/git-fs` (list ổ đĩa trên Windows + thư mục con,
  gắn nhãn `⎇ repo` cho thư mục là git repo). Chỉ trả **danh sách thư mục**, không đọc nội dung
  file; mọi path đều `path.resolve` (không nối chuỗi từ client). Chọn thư mục xong tự điền tên
  project nếu đang trống. (`lib/gitFs.ts`, `app/api/git-fs/route.ts`, `lib/git.ts`,
  `components/GitWorkspace.tsx`, `app/globals.css`.)
- **Git workspace: dropdown báo repo cần pull + Pull từng repo tại chỗ.** Khi mở dropdown chọn
  repo (mousedown/focus), tự chạy `status-all` (throttle 4s) và gắn glyph trạng thái ngay trước
  tên mỗi option: `↓ repo (n)` = cần pull (behind/diverged, kèm số commit), `↑` = cần push,
  `✎` = có thay đổi chưa commit, `•` = sạch, `?` = chưa rõ/không upstream/lỗi — do `<option>`
  native không nhúng được markup nên dùng 1 ký tự dẫn. Overview này **dùng chung** với panel
  `Tất cả repo` (một nguồn dữ liệu). Trong panel, mỗi dòng repo `cần pull`/`phân kỳ` có thêm nút
  **↓ Pull** để pull lẻ ngay (gọi action `pull` đơn-repo, tự refresh overview sau đó); nút
  **Pull tất cả** hiện kèm số repo pull được và disable khi không có repo nào cần pull.
  (`components/GitWorkspace.tsx`, `app/globals.css`.)
- **Git workspace: panel `Tất cả repo` — Status Check + Pull All.** Thêm khối tổng quan mọi repo
  ở đầu Git workspace với 2 nút: **↻ Kiểm tra tất cả** (chạy `git status` song song mọi repo,
  suy ra state từng repo: `sạch` / `cần commit` / `cần push` / `cần pull` / `phân kỳ` /
  `chưa có upstream` / `lỗi`, kèm số file thay đổi + ahead/behind, màu-mã hóa) và **↓ Pull tất cả**
  (`git pull --ff-only` song song; **bỏ qua** repo có thay đổi chưa commit / detached / chưa có
  upstream để không làm hỏng, và **báo rõ repo xung đột** khi không fast-forward được). Bảng cho
  click để mở nhanh repo tương ứng; có dòng summary + cảnh báo danh sách repo conflict. Backend
  thêm 2 action `status-all` / `pull-all` (không throw — repo lỗi được report riêng).
  (`lib/gitCore.ts`, `app/api/git/route.ts`, `lib/git.ts`, `components/GitWorkspace.tsx`,
  `app/globals.css`.)
- **Git workspace: tab `History` xem commit gần đây.** Bên cạnh tab **Thay đổi**, thêm sub-tab
  **History** hiển thị tối đa 50 commit mới nhất của branch hiện tại — mỗi dòng gồm short-hash,
  subject, ref (branch/tag) nếu có, tác giả + thời gian tương đối. Backend thêm action `log`
  (`git log --pretty` với delimiter `%x1f`/`%x1e` để parse an toàn, giới hạn ≤200, chạy qua
  `execFile` như các action khác). History chỉ tải khi mở tab, tự refresh khi đổi repo/branch,
  có nút ↻. (`lib/gitCore.ts`, `app/api/git/route.ts`, `lib/git.ts`, `components/GitWorkspace.tsx`,
  `app/globals.css`.)

### Fixed

- **Dropdown `<select>` chữ trắng trên nền trắng khi bung (không đọc được).** Popup option của
  native select được OS vẽ trên nền riêng, bỏ qua `--glass-2` (translucent) nên option ra nền
  trắng + chữ sáng. Thêm rule `select option, select optgroup` với nền **đục** theo theme
  (`--bg-1`) + `color: var(--text)` — fix cho cả dark/light. (`app/globals.css`.)

### Changed

- **UI: đổi title hiển thị `OMICX All-in-One` → `OMICX DevBox`.** Cập nhật `<title>` tab, `<h1>`
  appbar (wordmark `OMICX` đậm + `DevBox` nhẹ) và footer. (`app/page.tsx`, `app/layout.tsx`.)
- **UI: trau chuốt lại wordmark brand `OMICX All-in-One`.** Tách thành 2 tông — `OMICX` đậm
  (weight 800 + gradient nhấn), `All-in-One` nhẹ + muted (weight 500) — thay vì đổ gradient đều
  cả chuỗi nhìn nhạt. (`app/page.tsx`, `app/globals.css`.)
- **UI: đổi tên hiển thị `OMICX API Tester` → `OMICX All-in-One`.** Cập nhật `<title>` tab
  (`app/layout.tsx`), `<h1>` trên appbar + dòng footer (`app/page.tsx`); subtitle appbar đổi
  `flow-based backend testing` → `internal dev toolkit` cho đúng phạm vi all-in-one
  (API Explorer + Webhooks + Git Workspace). Giữ nguyên localStorage key `apitester.theme` và
  config literal `.apitester-config.json` (đổi sẽ reset theme / mất config của user).
- **Đổi tên repo `cloud-saas-omicx-api-tester` → `omicx-local-all-in-one`.** Rename thư mục
  local + git remote (`.../omicx/service/omicx-local-all-in-one.git`), `package.json` name
  (`omicx-api-tester` → `omicx-local-all-in-one`), và các định danh k8s/Docker: Deployment/
  Service/Ingress name + labels, image tag `ci/api-tester` → `ci/omicx-local-all-in-one`
  (`Dockerfile`, `k8s/*.yaml`, `k8s/README.md`, `README.md`). Config literal
  `.apitester-config.json` / `APITESTER_CONFIG_PATH` và command `/sync-api-tester` giữ nguyên.
  ⚠️ Cần đổi path project trên GitLab để push/fetch hoạt động.

- **Webhooks: gom cấu hình vào drawer ⚙ ở góc phải (giống PUBLIC API)** — hai khối
  **“Kết nối tool-service”** (Base URL / API prefix / X-KEY / X-VALUE) và **“Realtime socket”**
  (WS URL + Thử kết nối + Lưu & giữ kết nối) được chuyển khỏi thân trang vào một **drawer trượt
  từ phải**, mở bằng nút bánh răng ⚙ trên appbar (chỉ hiện ở mode Webhooks) — dùng lại đúng
  pattern `.drawer`/`.drawer-backdrop` của SettingsDrawer, đóng bằng Escape / backdrop. Thân
  trang giờ chỉ còn khối **“URL webhook của bạn”** + danh sách link + luồng request live, gọn hơn.
  Nút ⚙ có kdot báo trạng thái credential + host tool-service. Khi **lưu Base URL / API prefix**,
  **URL webhook tự sinh cập nhật theo** (vì `publicBaseUrl` mặc định suy từ Base URL + API prefix —
  trừ khi đã đặt Public base URL riêng). (`components/WebhookReceiver.tsx`, `app/page.tsx`.)

### Fixed

- **Webhooks: "Create failed: 200 OK" dù link đã tạo thành công.** `createLink` yêu cầu
  `r.ok && r.bodyJson` — khi upstream trả 200 nhưng proxy không parse được body thành JSON
  (thiếu/khác `application/json` content-type, hoặc body rỗng), `bodyJson` = undefined nên UI báo
  lỗi nhầm dù link đã được tạo. Giờ chỉ báo lỗi khi `!r.ok`; nếu 200 mà không có object link trả về
  thì coi là thành công và **reload danh sách từ server**. (`components/WebhookReceiver.tsx`.)
- **Webhooks: link URL hiển thị/copy dùng `link.url` backend trả (kẹt `localhost:8080/tool-svc/api`).**
  Danh sách link + nút copy + dòng "gửi request tới …" đang lấy thẳng `l.url` do tool-service sinh
  (base của chính backend), nên không bám Base URL + API prefix đã config trên UI. Đổi cả 3 chỗ sang
  `buildHookUrl(publicBaseUrl, l.id)` — giống hệt khối "URL webhook của bạn" (quick) — nên mọi link
  đều dựng URL = `{Base URL + API prefix}/tools/hook/{id}`. (`components/WebhookReceiver.tsx`.)
- **Webhooks: public URL không bám theo Base URL + API prefix đã cấu hình (kẹt ở localhost).**
  Trước đây `toolPublicBase = toolCfg.publicBaseUrl || defaultPublicBase(...)` — một khi
  `publicBaseUrl` đã từng được lưu (kể cả giá trị localhost cũ) thì nó **luôn thắng** và **âm thầm
  che** Base URL + API prefix người dùng chỉnh sau đó, nên URL webhook không bao giờ khớp config.
  Thêm `resolvePublicBase(baseUrl, apiPrefix, override)`: **Base URL + API prefix là source of truth**
  (sửa là public URL đổi theo ngay); override `publicBaseUrl` **chỉ thắng khi trỏ tới host thật sự
  KHÁC** (ingress riêng biệt) — cùng host với Base URL thì bị coi là stale và bỏ qua. (`app/page.tsx`.)

### Added

- **Git workspace (kiểu SourceTree) — chỉ chạy local.** Thêm mode thứ ba trên appbar
  (**API Explorer · Webhooks · Git**) để thao tác Git trên các repo omicx ngay trong api-tester:
  auto-detect mọi repo git anh em dưới thư mục omicx (dropdown chọn repo), xem **status** (branch,
  ahead/behind, upstream), **stage/unstage từng file** (Staged / Chưa stage / Chưa theo dõi, có
  "Stage all"/"Unstage all"), **discard** file working-tree, xem **diff từng file** (tô màu +/−),
  **commit** phần đã stage (kèm message), **pull `--ff-only`**, **push** (tự `-u origin` khi branch
  chưa có upstream), **checkout** + **tạo branch mới**. Cảnh báo (không chặn) khi commit vào branch
  ≠ `dev` trên repo `cloud-saas-*` (theo quy ước branch_guard). **An ninh:** toàn bộ chạy server-side
  qua `execFile('git', [...])` (không shell → không command-injection); mọi repo path phải nằm trong
  Git root đã cấu hình (chống path traversal); tính năng **tắt mặc định**, chỉ bật khi đặt
  `GIT_TOOL_ENABLED=true` — bản deploy/k8s không set nên feature không tồn tại ở đó (chống RCE). Root
  auto-detect chỉnh qua `GIT_TOOL_ROOT`. (`app/api/git/route.ts`, `lib/gitCore.ts`, `lib/git.ts`,
  `components/GitWorkspace.tsx`, `app/page.tsx`, `.env.example`.)
- **Webhooks: URL webhook “quick” tự sinh theo trình duyệt (kiểu webhook.site)** — thêm khối
  **“URL webhook của bạn”** ở đầu workspace Webhooks: trình duyệt tự gen 1 UUID (`crypto.randomUUID`),
  cache ở `localStorage` (`omicx.tool.webhook.quickId`), và hiển thị full URL copy được ngay —
  **không cần đăng nhập tool-service, không cần bấm “Create”**. Link tự sinh ở request đầu tiên (nhờ
  backend auto-create trên `ANY /tools/hook/:token` khi token là UUID hợp lệ). Nút **Copy URL**,
  **Xem live** (subscribe WS theo id để xem request đổ về ngay, kể cả khi link chưa tồn tại server-side),
  **↻ Id mới** (đổi id + theo dõi id mới). Thêm field cấu hình **Public base URL** (persist theo
  service, mặc định suy từ Base URL + API prefix) để URL khớp đúng ingress công khai (vd
  `https://socket.xyz.com`) khi domain nhận webhook khác domain quản lý; URL =
  `{publicBaseUrl}/tools/hook/{id}`. **Fix:** lịch sử capture đổi từ `GET .../requests` (đã bị backend
  bỏ) sang `POST .../requests/search` theo search-envelope ADR-0007 (`{pagination:{page,size}}`,
  1-based). **Fix:** default WS port `8091` → `9090` cho khớp `WEBHOOK_WS_PORT` mới của tool-service.
  (`components/WebhookReceiver.tsx`, `app/page.tsx`, `lib/persist.ts`.)
- **Deployment artifacts (Docker + k8s)** — the "deploy later" path is now real. Added a
  multi-stage `Dockerfile` building the Next.js standalone output (`node:20-alpine`, runs as
  the built-in non-root `node` user, serves on `:8080` via `PORT`/`HOSTNAME=0.0.0.0`, copies
  `openapi/` for runtime spec reads), a `.dockerignore`, and reference k8s manifests under
  `k8s/` (`deployment.yaml` Deployment+Service, `ingress.yaml` VPN-only template, `README.md`).
  New `app/api/health` route returns `200 ok` as the readiness/liveness probe target (distinct
  from the UI's backend-health concept). Image target `<your-registry>/ci/api-tester`.
  **Internal, VPN-only** — never exposed publicly (the tool mints JWTs + holds API keys).
- **Copy button on config inputs** — every field in the Settings drawer (the four
  global variables, base URL, API prefix, and the per-service token/tool key/secret
  overrides) shows an inline **Copy** button whenever it holds a value, copying the
  underlying value to the clipboard — including password fields, where the value is
  otherwise masked. Reusable `CopyButton` / `InputWithCopy` helpers in `SettingsDrawer`.
- **admin-service** wired as a drivable service — spec synced to `openapi/admin-service.yaml`
  (75 paths), registered in `AVAILABLE_SERVICES` / `SERVICE_CATALOG` (`authMode: jwt-admin`,
  global var `JWT_TOKEN_ADMIN`) and `SERVICE_ENV` (`ADMIN_SERVICE_BASE_URL`, fallback
  `http://localhost:8080/admin-svc`). Spec paths already carry `/api` (API prefix stays empty).
- **Per-service API prefix** — each service gains an optional **API prefix** in Settings
  (e.g. `/api`), **reconciled against each openapi path**: prepended to every request path
  (proxy, curl export, and the `/tools/agent-token` call) **only when the path does not
  already start with it** (segment-aware — `/api` won't match `/apix`), so a spec that
  already carries the prefix is never doubled. This handles both conventions — ai-service's
  spec bakes `/api` in (`/api/ai/jobs`, left as-is), tool-service's omits it
  (`/tools/encrypt` → `/api/tools/encrypt`). Central join logic lives in `joinPath()`
  (`lib/proxyCore.ts`). The **gateway routing prefix** (e.g. `/ai-svc`) is NOT this field —
  it belongs in the Base URL. The health dot applies the API prefix to an openapi-declared
  health path but falls back to the root `/health` (no prefix) when the spec declares none,
  so ai-service (Base URL `…/ai-svc`) lights up via `…/ai-svc/health`. Persisted per service
  in `.apitester-config.json`.
- **ai-service** wired as a drivable service — spec synced to `openapi/ai-service.yaml`,
  registered in `AVAILABLE_SERVICES` / `SERVICE_CATALOG` (`authMode: jwt-agent`, global var
  `JWT_TOKEN_AGENT`) and `SERVICE_ENV` (`AI_SERVICE_BASE_URL`). Base URL fallback left blank —
  set it in Settings (spec dev server hint: `https://api-dev.omicx.one/ai-svc`).
- **Generate agent/admin JWT from a tenant** — `JWT_TOKEN_AGENT` and `JWT_TOKEN_ADMIN`
  in the Settings drawer gain a **Tạo / Cập nhật** button that opens an inline input for a
  `tenantId` or domain and mints the token via tool-service's `POST /tools/agent-token`
  (new server route `app/api/agent-token`, which reads the tool-service base URL + `X-KEY`/
  `X-VALUE` from the store server-side). No email/phone → the tenant's business-owner agent.
  On success the returned `accessToken` overwrites the variable and is persisted; on failure
  the upstream message is shown inline. (`JWT_TOKEN_USER` generation is deferred.)
- **Copy as curl** — Explore endpoints gain a "Copy as curl" button that builds the
  equivalent `curl` command (targeting the real backend) and copies it to the
  clipboard. Headers are generated server-side by the proxy's own logic, extracted
  to `lib/proxyCore.ts` and served via `/api/curl`, so the command matches the real
  request — including the `tool`-mode `X-KEY` / `X-VALUE` static secrets. The proxy route
  now imports `proxyCore` instead of duplicating the header/URL logic.
- **Global variables + JWT auth modes** — the Settings drawer now holds four shared
  global variables (`API_KEY`, `JWT_TOKEN_USER`, `JWT_TOKEN_AGENT`, `JWT_TOKEN_ADMIN`)
  applied to every service unless it sets a per-service token override. Auth model
  expanded to `apikey | tool | jwt-user | jwt-agent | jwt-admin`; the proxy sends
  `X-Api-Key` (apikey) or `Authorization: Bearer <token>` (jwt-*), auto-prepending
  `Bearer ` only when missing. Tokens are stored **without** the `Bearer ` prefix.
  - Store gains a reserved `__global__` entry (`lib/persist.ts` `GlobalVars`,
    `saveGlobalVars`); `/api/local-config` now returns `{ services, global }`.
  - `resolveAuth` / `authReady` (`lib/request.ts`) resolve override → global var.
- **`/sync-api-tester` command** — copies one/many/`all` services' `openapi.yaml` into
  `openapi/<slug>.yaml` and registers each (`AVAILABLE_SERVICES`, `SERVICE_CATALOG`,
  `<SLUG>_BASE_URL`). See `.claude/commands/sync-api-tester.md`.
- **On-disk config persistence** — connection settings (per-service base URL +
  credentials) are now saved to a local file `.apitester-config.json` (gitignored)
  and auto-loaded on restart, so a browser/server restart re-maps them without
  re-typing. Reconfiguring overwrites the stored values; clearing a field removes it.
  - New server store `lib/localStore.ts` + route `app/api/local-config` (GET/PUT);
    client helper `lib/persist.ts`. Path overridable via `APITESTER_CONFIG_PATH`.

### Changed

- Credentials and base-URL overrides moved from browser storage
  (sessionStorage / localStorage) to the on-disk store above — survives browser
  changes and incognito. `lib/creds.ts` now only carries the `ServiceCreds` type
  (`token?` override + tool key/secret); the completeness check moved to
  `authReady` in `lib/request.ts`.

- **tool-service** support — now a real, drivable service alongside public-service,
  configured the same way (base URL + credentials in Settings).
  - Endpoint catalog from `openapi/tool-service.yaml` (`/tools/health` public;
    encrypt / decrypt / agent-token / tenant-purge / platform-user-purge require auth).
  - `TOOL_SERVICE_BASE_URL` config (default `http://localhost:8088/api`).
  - Per-service auth-mode abstraction (`apikey` | `tool`) and per-service credentials.
  - Proxy sends `X-KEY` + `X-VALUE` verbatim for tool mode — both are static shared
    secrets that tool-service compares constant-time (no time token, no prefix).
