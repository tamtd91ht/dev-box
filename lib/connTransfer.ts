// Server-only export/import cho DANH SÁCH CONNECTION của từng menu (Kafka,
// Redis, Mongo, Rabbit, ES, PG).
//
// VÌ SAO LÀ MODULE RIÊNG, KHÔNG NHÉT VÀO 6 FILE lib/*Connections.ts:
// cả 6 registry đã hội tụ về CÙNG một format file — `{ connections: [...] }`,
// mỗi record có `id` + `name` + `project`. Nên toàn bộ nghiệp vụ chuyển máy chỉ
// cần đọc/ghi đúng file đó, không quan tâm schema riêng của từng loại. Viết một
// lần ở đây thì thêm loại thứ 7 chỉ là thêm một dòng vào REGISTRIES.
//
// SECURITY MODEL — file export CHỨA SECRET DẠNG PLAINTEXT (Redis/Mongo/PG/Rabbit
// password). Đây là chủ ý: mục đích của tính năng là bê nguyên cấu hình sang máy
// khác dùng được ngay, và bản thân các file trong ./configs/ vốn đã là plaintext
// (xem lib/redisConnections.ts). Hệ quả người dùng PHẢI biết: file .json xuất ra
// tương đương một file mật khẩu — UI cảnh báo rõ ở hộp thoại xác nhận, và mọi
// endpoint vẫn nằm sau cùng cờ *_TOOL_ENABLED như phần còn lại của tab.
//
// Import KHÔNG chạy qua validate() của từng registry: bản ghi đến từ chính công
// cụ này nên đã hợp lệ, và mỗi loại lại có validate với chữ ký khác nhau. Thay
// vào đó ta lọc bằng bộ khung tối thiểu (id/name/project là string) rồi ghi
// thẳng — lần đọc kế tiếp của registry sẽ normalize() như với mọi file có sẵn.

import { promises as fs } from 'fs';
import path from 'path';
import { configPath } from './configDir';

/** Các menu có hỗ trợ export/import cấu hình. */
export type RegistryKind = 'kafka' | 'redis' | 'mongo' | 'rabbit' | 'es' | 'pg';

interface RegistrySpec {
  /** Nhãn tiếng Việt hiện trên UI + trong file export. */
  label: string;
  /** Tên file trong ./configs. */
  file: string;
  /** Tên file cũ ở repo-root (configDir tự migrate). */
  legacy: string[];
  /** Biến môi trường ghi đè đường dẫn — phải trùng với file registry tương ứng. */
  envVar: string;
  /**
   * Cờ bật tab. Đọc thẳng env chứ KHÔNG import *_ENABLED từ lib/<kind>Client —
   * mấy file đó kéo theo driver nặng (ioredis, kafkajs, mongodb, pg) mà route
   * này không cần. Regex phải giữ trùng với các client đó.
   */
  enabledEnv: string;
}

const REGISTRIES: Record<RegistryKind, RegistrySpec> = {
  kafka:  { label: 'Kafka clusters',      file: 'kafkaconnections.json',  legacy: ['.kafkaconnections.json'],  envVar: 'KAFKA_CONNECTIONS_PATH',  enabledEnv: 'KAFKA_TOOL_ENABLED' },
  redis:  { label: 'Redis instances',     file: 'redisconnections.json',  legacy: ['.redisconnections.json'],  envVar: 'REDIS_CONNECTIONS_PATH',  enabledEnv: 'REDIS_TOOL_ENABLED' },
  mongo:  { label: 'MongoDB clusters',    file: 'mongoconnections.json',  legacy: ['.mongoconnections.json'],  envVar: 'MONGO_CONNECTIONS_PATH',  enabledEnv: 'MONGO_TOOL_ENABLED' },
  rabbit: { label: 'RabbitMQ brokers',    file: 'rabbitconnections.json', legacy: ['.rabbitconnections.json'], envVar: 'RABBIT_CONNECTIONS_PATH', enabledEnv: 'RABBIT_TOOL_ENABLED' },
  es:     { label: 'Elastic clusters',    file: 'esconnections.json',     legacy: ['.esconnections.json'],     envVar: 'ES_CONNECTIONS_PATH',     enabledEnv: 'ES_TOOL_ENABLED' },
  pg:     { label: 'PostgreSQL servers',  file: 'pgconnections.json',     legacy: ['.pgconnections.json'],     envVar: 'PG_CONNECTIONS_PATH',     enabledEnv: 'PG_TOOL_ENABLED' },
};

export function isRegistryKind(v: unknown): v is RegistryKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(REGISTRIES, v);
}

/** Tab của loại này có đang bật không (cùng quy ước với lib/<kind>Client.ts). */
export function isKindEnabled(kind: RegistryKind): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[REGISTRIES[kind].enabledEnv] ?? '');
}

export function registryLabel(kind: RegistryKind): string {
  return REGISTRIES[kind].label;
}

/** Đường dẫn file registry — TRÙNG logic với lib/<kind>Connections.ts. */
function fileOf(kind: RegistryKind): string {
  const spec = REGISTRIES[kind];
  const override = process.env[spec.envVar];
  return override
    ? path.resolve(process.cwd(), override)
    : configPath(spec.file, spec.legacy);
}

/** Một bản ghi connection bất kỳ — chỉ 3 field là bắt buộc, phần còn lại tuỳ loại. */
export interface AnyConnection {
  id: string;
  name: string;
  project?: string;
  [k: string]: unknown;
}

/** Định dạng file export. `kind` khoá lại loại menu để không import nhầm chéo. */
export interface TransferFile {
  /** Chữ ký nhận diện file của công cụ này. */
  format: 'devbox-connections';
  /** Version format — tăng khi cấu trúc file đổi kiểu phá vỡ tương thích. */
  version: 1;
  kind: RegistryKind;
  /** Nhãn menu tại thời điểm export (chỉ để người đọc file hiểu, không dùng khi import). */
  label: string;
  /** ISO timestamp lúc export. */
  exportedAt: string;
  /** true nếu file có chứa mật khẩu — UI dùng để cảnh báo khi mở lại. */
  hasSecrets: boolean;
  connections: AnyConnection[];
}

const SECRET_FIELDS = ['password'] as const;

function hasSecret(c: AnyConnection): boolean {
  return SECRET_FIELDS.some((f) => typeof c[f] === 'string' && (c[f] as string).length > 0);
}

/** Đọc danh sách thô (CÒN mật khẩu) từ file registry. [] nếu thiếu/hỏng file. */
async function readRaw(kind: RegistryKind): Promise<AnyConnection[]> {
  try {
    const raw = await fs.readFile(fileOf(kind), 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed?.connections) ? parsed.connections : Array.isArray(parsed) ? parsed : [];
    return (arr as unknown[]).filter(isConnectionRecord);
  } catch {
    return [];
  }
}

async function writeRaw(kind: RegistryKind, connections: AnyConnection[]): Promise<void> {
  await fs.writeFile(fileOf(kind), JSON.stringify({ connections }, null, 2) + '\n', 'utf8');
}

/** Khung tối thiểu của một bản ghi hợp lệ — giống bộ lọc trong từng registry. */
function isConnectionRecord(c: unknown): c is AnyConnection {
  const o = c as AnyConnection;
  return !!o && typeof o === 'object' && typeof o.id === 'string' && !!o.id && typeof o.name === 'string';
}

// ── Export ───────────────────────────────────────────────────────────────────

/**
 * Dựng nội dung file export cho các connection được chọn.
 *
 * @param ids Danh sách id cần xuất. Rỗng/không truyền → xuất TẤT CẢ.
 * Thứ tự bản ghi giữ theo thứ tự trong file registry, không theo thứ tự `ids`.
 */
export async function buildExport(kind: RegistryKind, ids?: string[]): Promise<TransferFile> {
  const all = await readRaw(kind);
  const wanted = ids && ids.length ? new Set(ids) : null;
  const picked = wanted ? all.filter((c) => wanted.has(c.id)) : all;
  if (picked.length === 0) throw new Error('không có cấu hình nào để xuất');
  return {
    format: 'devbox-connections',
    version: 1,
    kind,
    label: REGISTRIES[kind].label,
    exportedAt: new Date().toISOString(),
    hasSecrets: picked.some(hasSecret),
    connections: picked,
  };
}

// ── Import ───────────────────────────────────────────────────────────────────

/** Cách xử lý một bản ghi trùng id với cấu hình đang có. */
export type ConflictMode = 'overwrite' | 'skip' | 'duplicate';

/** Kết quả soi file trước khi import — UI dựng hộp thoại xác nhận từ đây. */
export interface ImportPreview {
  kind: RegistryKind;
  label: string;
  exportedAt: string;
  hasSecrets: boolean;
  items: {
    id: string;
    name: string;
    project: string;
    /** Mô tả ngắn (host/broker/node…) để nhận ra bản ghi trên hộp thoại. */
    summary: string;
    /** true nếu id đã tồn tại trong cấu hình hiện tại. */
    conflict: boolean;
    /** Tên của bản ghi đang có cùng id — cho biết cái gì sẽ bị ghi đè. */
    existingName?: string;
    /** true nếu bản ghi mang theo mật khẩu. */
    hasSecret: boolean;
  }[];
}

/**
 * Một dòng tóm tắt endpoint, tự bắt các field mà 6 loại registry dùng. Danh sách
 * node có hai dạng: string "host:port" (kafka/rabbit/es/mongo) hoặc object
 * {host,port} (redis cluster) — nhận cả hai.
 */
function summarize(c: AnyConnection): string {
  const one = (x: unknown): string | null => {
    if (typeof x === 'string') return x.trim() || null;
    const o = x as { host?: unknown; port?: unknown };
    if (o && typeof o.host === 'string' && o.host) {
      return typeof o.port === 'number' ? `${o.host}:${o.port}` : o.host;
    }
    return null;
  };
  const list = (v: unknown): string | null => {
    if (!Array.isArray(v)) return null;
    const parts = v.map(one).filter((s): s is string => !!s);
    return parts.length ? parts.join(', ') : null;
  };
  const hostPort = typeof c.host === 'string' && c.host
    ? `${c.host}${typeof c.port === 'number' ? `:${c.port}` : ''}`
    : null;
  return (
    list(c.brokers) ??      // kafka
    list(c.nodes) ??        // rabbit / es / redis cluster
    list(c.hosts) ??        // mongo
    hostPort ??             // redis single / pg
    ''
  );
}

/** Phân tích + kiểm tra một file export do người dùng chọn. Throw nếu file sai. */
export function parseTransferFile(raw: unknown, expectKind: RegistryKind): TransferFile {
  const f = raw as Partial<TransferFile>;
  if (!f || typeof f !== 'object') throw new Error('file không phải JSON hợp lệ');
  if (f.format !== 'devbox-connections') {
    throw new Error('file không phải bản export cấu hình của Dev Box');
  }
  if (f.version !== 1) throw new Error(`phiên bản file không hỗ trợ (version=${String(f.version)})`);
  if (!isRegistryKind(f.kind)) throw new Error('file thiếu trường "kind" hợp lệ');
  if (f.kind !== expectKind) {
    throw new Error(`file này là cấu hình ${REGISTRIES[f.kind].label}, không import được vào ${REGISTRIES[expectKind].label}`);
  }
  const connections = Array.isArray(f.connections) ? f.connections.filter(isConnectionRecord) : [];
  if (connections.length === 0) throw new Error('file không chứa cấu hình nào hợp lệ');
  return {
    format: 'devbox-connections',
    version: 1,
    kind: f.kind,
    label: REGISTRIES[f.kind].label,
    exportedAt: typeof f.exportedAt === 'string' ? f.exportedAt : '',
    hasSecrets: connections.some(hasSecret),
    connections,
  };
}

/** Soi file: đối chiếu với cấu hình hiện tại để biết cái nào trùng. Không ghi gì. */
export async function previewImport(raw: unknown, expectKind: RegistryKind): Promise<ImportPreview> {
  const file = parseTransferFile(raw, expectKind);
  const existing = await readRaw(file.kind);
  const byId = new Map(existing.map((c) => [c.id, c]));
  return {
    kind: file.kind,
    label: file.label,
    exportedAt: file.exportedAt,
    hasSecrets: file.hasSecrets,
    items: file.connections.map((c) => ({
      id: c.id,
      name: c.name,
      project: typeof c.project === 'string' && c.project.trim() ? c.project.trim() : 'default',
      summary: summarize(c),
      conflict: byId.has(c.id),
      existingName: byId.get(c.id)?.name,
      hasSecret: hasSecret(c),
    })),
  };
}

export interface ImportResult {
  added: number;
  overwritten: number;
  skipped: number;
  /** Danh sách id sau khi import (theo thứ tự file registry) — UI reload lại list. */
  total: number;
}

/**
 * Ghi các bản ghi được chọn vào file registry.
 *
 * @param ids  Chỉ import các id này (bỏ trống → toàn bộ file).
 * @param mode Xử lý bản ghi trùng id: ghi đè · bỏ qua · thêm bản sao (id mới).
 */
export async function applyImport(
  raw: unknown,
  expectKind: RegistryKind,
  ids: string[] | undefined,
  mode: ConflictMode,
): Promise<ImportResult> {
  const file = parseTransferFile(raw, expectKind);
  const wanted = ids && ids.length ? new Set(ids) : null;
  const picked = wanted ? file.connections.filter((c) => wanted.has(c.id)) : file.connections;
  if (picked.length === 0) throw new Error('không có cấu hình nào được chọn để import');

  const list = await readRaw(file.kind);
  const taken = new Set(list.map((c) => c.id));
  let added = 0, overwritten = 0, skipped = 0;

  for (const inc of picked) {
    const idx = list.findIndex((c) => c.id === inc.id);
    if (idx === -1) {
      list.push(inc);
      taken.add(inc.id);
      added++;
      continue;
    }
    if (mode === 'skip') { skipped++; continue; }
    if (mode === 'overwrite') { list[idx] = inc; overwritten++; continue; }
    // duplicate: giữ nguyên bản cũ, thêm bản mới với id chưa dùng.
    const id = uniqueId(inc.id, taken);
    list.push({ ...inc, id, name: `${inc.name} (import)` });
    taken.add(id);
    added++;
  }

  await writeRaw(file.kind, list);
  return { added, overwritten, skipped, total: list.length };
}

/** `base`, `base-2`, `base-3`… — cùng quy ước với makeId() của các registry. */
function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}
