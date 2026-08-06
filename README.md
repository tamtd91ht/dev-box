# VHS DevBox

**Infra toolbox dùng chung cho mọi dự án** — một web app Next.js chạy local, quản lý toàn bộ
hạ tầng dev/ops từ MỘT chỗ: **Redis · Kafka · RabbitMQ · MongoDB · Elasticsearch · PostgreSQL ·
Git · Webhooks**.

> Fork từ một toolbox all-in-one nội bộ. Hai tính năng vốn gắn chặt với tổ chức gốc đã được **viết lại
> theo hướng project-neutral** và quay lại đây: **API Explorer** (giờ là *integration pack* — tab
> ＋ Projects) và **Telegram MR-review bot** (`npm run bot` — workspace lấy từ project đã đăng ký).
> Cả hai không hardcode đường dẫn hay tên service của dự án nào.

```bash
npm install
cp .env.example .env.local     # bật các tab cần dùng (mặc định TẤT CẢ đều OFF)
npm run dev                    # → http://localhost:3000
```

## App desktop (Electron)

```bash
npm run desktop            # mở app desktop (tự chạy next dev nếu :3000 chưa có gì)
npm run desktop:install    # Windows: tạo shortcut Desktop + Start Menu — máy mới chạy 1 lần là xong
```

Shortcut chạy thẳng `electron.exe` của repo (không mở cửa sổ console); log của shell + `next dev`
xem ngay trong app bằng nút **⌨ Console** ở footer (ẩn mặc định). Sau khi cài, mở app bằng
double-click icon ngoài Desktop hoặc nhấn nút Windows gõ "VHS DevBox".

## Nguyên tắc chung của mọi tab

| Nguyên tắc | Cụ thể |
|---|---|
| **Gate bằng env** | Mỗi tool một flag (`REDIS_TOOL_ENABLED`, `MONGO_TOOL_ENABLED`, …) — mặc định OFF, deploy k8s không set gì là không expose gì. |
| **Browser không chạm hạ tầng** | Mọi socket (ioredis, kafkajs, mongodb, pg, HTTP ES/Rabbit) do Next server giữ; UI chỉ gọi same-origin `/api/*`. |
| **Connection per-project** | Mỗi tab một registry kết nối nhóm theo project, có **Test connection**; lưu per-máy trong file JSON gitignored (`.redisconnections.json`, …); password không bao giờ trả về browser (chỉ `hasPassword`). |
| **Đọc thoải mái, ghi có khoá** | Read được bound (SCAN/maxTimeMS/READ ONLY tx/size cap). Write (nếu có) qua 3 lớp khoá độc lập: env flag + readOnly per-connection (mặc định ON) + typed-confirm modal; luôn audit-log (`*_AUDIT`). |
| **Quick-find + Export** | Mongo/ES/PG có preset tìm nhanh (field checkbox, AND, single/list) và xuất báo cáo .xlsx styled (STT, epoch/ISO → date-cell `dd/MM/yyyy` · `HH:mm:ss dd/MM/yyyy`, khổ A4). |
| **Monitor** | ES (heap/disk/CPU/load 10s) · Mongo (RAM/disk/connections/cache/ops + repl lag 30s) · Redis (INFO per node 30s) · Kafka (brokers/URP/offline 60s + RAM/disk/CPU/load qua node_exporter Metrics URLs) · Rabbit (node health 10s opt-in). Chỉ poll khi panel mở + browser tab visible. |

## Các tab

- **＋ Projects (integration packs)** — engine API Explorer **project-neutral**: project "cắm" API
  của mình vào bằng **integration pack** — file `devbox.api.json` đặt trong repo của project
  (services + spec paths + auth mode + flows). Đăng ký pack trong UI bằng nút **📂 Browse** (folder
  picker chạy server-side, thư mục có manifest hiện badge `▤ pack`; registry per-máy
  `.apiintegrations.json`); mỗi pack thành **một tab riêng** ở phân vùng Projects trên header.
  DevBox parse openapi và dựng Explore (endpoint → gửi request qua proxy, curl preview) + Flows
  (chuỗi request với `{{var}}` capture). Ví dụ một pack — manifest ở root workspace
  `<project>/devbox.api.json`, spec đọc thẳng từ `<service>/src/main/resources/openapi.yaml`
  nên không cần bước sync. Auth: apikey / tool key+secret / JWT (user/agent/admin, có mint agent
  token qua tool-service).
- **Git** — multi-project (root cấu hình được), status/pull-all/history/commit + Review MR runner.
- **Redis** — single/cluster, SCAN browser, value/TTL, delete typed-confirm, monitor INFO.
- **Kafka** — topics/partitions/offsets, consumer groups + lag, peek, search theo time-window,
  produce, quick-search preset, cluster health + host metrics.
- **RabbitMQ** — cluster/node health, queues/exchanges/bindings + routing tester, peek requeue-safe,
  publish, write ops 3 lớp khoá.
- **MongoDB** — Robo3T-lite: tree db→collection, find/count/aggregate (EJSON), indexes/stats,
  update-with-query (3 khoá), quick-find, export, monitor. Driver v5: server 3.6→7.0.
- **Elasticsearch** — read-only tuyệt đối, ES 6.8→8.x, cluster node list failover, query DSL,
  mapping, node monitor, quick-find, export.
- **PostgreSQL** — tree database→table, SQL editor trong transaction READ ONLY + timeout,
  columns/indexes, UPDATE-with-WHERE (3 khoá), quick-find parameterized, export.
- **Webhooks** — nhận webhook realtime qua tool-service (cấu hình base URL + X-KEY/X-VALUE trong UI).
- **🧭 Workspace** *(cần app desktop)* — nhúng web app thật làm workspace: Zalo + Telegram (nhiều
  tài khoản song song, mỗi tài khoản một phiên riêng trên máy), mỗi app có màu + logo riêng trên
  rail nên nhìn là biết ngay. Báo tin chưa đọc lên tận tab. `lib/workspace/README.md`.
- **🤖 Automation** — một engine cho mọi nhóm: 💬 *social* (tin nhắn từ tab Workspace) và
  📡 *infrastructure* (watch chỉ số Redis/Mongo/ES/Kafka/Rabbit/PG từ chính registry kết nối).
  Sự kiện → điều kiện → hành động (notify · webhook · log · kafka · reply-chờ-duyệt). Mặc định an
  toàn: đọc tin nhắn OFF, theo dõi hạ tầng OFF, cho phép gửi OFF, quy tắc mới luôn chạy thử.
  `lib/automation/README.md`.

Chi tiết từng tool (giới hạn, lệnh dùng, model an toàn) xem `CHANGELOG.md` — mỗi tính năng có một
entry mô tả đầy đủ.

## Telegram MR-review bot (`npm run bot`)

Tiến trình **riêng**, không thuộc web app và **không mở cổng nào**: long-poll một group Telegram,
gặp `/review <service> <branch> <mô tả>` thì chạy engine read-only `/review-mr-dev` qua `claude`
CLI trên máy này rồi reply kết quả (verdict + SCORE) vào group.

```bash
# .env.local: TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_CHAT_ID
npm run bot           # chạy bot        npm run bot:status   # snapshot trạng thái
npm run bot:test      # test parser offline
```

Workspace review **không hardcode**: bot đọc chính registry per-máy mà UI đã ghi
(`.apiintegrations.json` của ＋ Projects, `.gitprojects.json` của tab Git) — đăng ký project một
lần trong UI là bot dùng được ngay; nhiều project thì chọn bằng `BOT_PROJECT=<tên|id>`, hoặc ghi
đè thẳng bằng `BOT_BASE_PATH`. Chi tiết + cách lấy chat id: `bot/README.md`.

## Layout

```
app/api/{redis,kafka,rabbit,mongo,es,pg}[-connections]/  ← dispatch routes (gated by env)
app/api/{git,git-projects,fs-browse,local-config,proxy,health}/
app/api/{api-integrations,api-catalog,curl,agent-token}/   ← integration packs (API Explorer)
lib/{stack}Client.ts        ← server-only ops + safety bounds
lib/{stack}Connections.ts   ← connection registry (JSON per-máy, gitignored)
lib/{stack}QuickFinds.ts    ← quick-find presets (localStorage)
lib/mongoReport.ts          ← shared .xlsx report engine (ExcelJS dynamic import)
lib/fsBrowse.ts             ← folder listing cho picker (dùng bởi Git + ＋ Projects)
lib/workspace/*             ← Browser Workspace Framework (plugin Zalo/Telegram + collector)
lib/automation/*            ← Automation engine (types · catalog · engine · watcher · sources)
components/{Stack}Workspace.tsx + components/{stack}/*
components/FolderPicker.tsx  ← folder picker dùng chung (📂 Browse)
components/AutomationHost.tsx ← runner + toast, sống ngoài mọi tab
bot/                        ← Telegram MR-review bot (tiến trình riêng, `npm run bot`)
```

## Deployment

Chạy local là chính (`npm run dev`). Nếu deploy nội bộ (VPN-only) thì build image từ `Dockerfile`
— nhớ rằng **không set env flag nào thì mọi tab đều tắt** (trả 403), nên một bản deploy "trắng"
là an toàn mặc định.
