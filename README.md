# VHS DevBox

**Infra toolbox dùng chung cho mọi dự án** — một web app Next.js chạy local, quản lý toàn bộ
hạ tầng dev/ops từ MỘT chỗ: **Redis · Kafka · RabbitMQ · MongoDB · Elasticsearch · PostgreSQL ·
Git · Webhooks**.

> Fork từ `omicx/omicx-local-all-in-one`, đã bỏ **OMICX API Explorer** và **Telegram review bot**
> để thành sản phẩm trung lập dự án. Bản gốc vẫn sống trong repo omicx với đầy đủ hai tính năng đó.

```bash
npm install
cp .env.example .env.local     # bật các tab cần dùng (mặc định TẤT CẢ đều OFF)
npm run dev                    # → http://localhost:3000
```

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

- **API Explorer** — engine **project-neutral**: project "cắm" API của mình vào bằng
  **integration pack** — file `devbox.api.json` đặt trong repo của project (services + spec paths
  + auth mode + flows). Đăng ký pack trong UI (trỏ folder repo, lưu per-máy
  `.apiintegrations.json`); DevBox parse openapi và dựng Explore (endpoint → gửi request qua
  proxy, curl preview) + Flows (chuỗi request với `{{var}}` capture). OMICX là pack đầu tiên
  (manifest sống trong repo omicx-local-all-in-one). Auth: apikey / tool key+secret / JWT
  (user/agent/admin, có mint agent token qua tool-service).
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

Chi tiết từng tool (giới hạn, lệnh dùng, model an toàn) xem `CHANGELOG.md` — mỗi tính năng có một
entry mô tả đầy đủ.

## Layout

```
app/api/{redis,kafka,rabbit,mongo,es,pg}[-connections]/  ← dispatch routes (gated by env)
app/api/{git,git-fs,git-projects,local-config,proxy,health}/
lib/{stack}Client.ts        ← server-only ops + safety bounds
lib/{stack}Connections.ts   ← connection registry (JSON per-máy, gitignored)
lib/{stack}QuickFinds.ts    ← quick-find presets (localStorage)
lib/mongoReport.ts          ← shared .xlsx report engine (ExcelJS dynamic import)
components/{Stack}Workspace.tsx + components/{stack}/*
```

## Deployment

Chạy local là chính (`npm run dev`). Nếu deploy nội bộ (VPN-only) thì build image từ `Dockerfile`
— nhớ rằng **không set env flag nào thì mọi tab đều tắt** (trả 403), nên một bản deploy "trắng"
là an toàn mặc định.
