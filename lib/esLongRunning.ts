// Server-only: truy vấn Elasticsearch đang chạy lâu hơn N giây (tab Phân tích ES).
//
// NHẸ, KHÔNG CHẶN CỤM — ba lệnh GET đọc trạng thái trong bộ nhớ, chạy song song:
//   • _tasks?actions=indices:data/*&detailed=true (timeout=5s, filter_path) — task đang
//     chạy (search, msearch, scroll, bulk, *_by_query, reindex…). Chỉ giữ task gốc
//     (không có parent_task_id) để một search không thành hàng chục dòng shard con.
//   • _cluster/pending_tasks — thay đổi cluster state đang chờ master (tạo index,
//     mapping, allocation…) kèm thời gian chờ.
//   • _cat/nodes?h=id,name — đổi node id ra tên.
// Không huỷ task nào; lệnh huỷ chỉ hiện ra để người dùng tự chạy nếu muốn.

import type { EsConnection } from '@/lib/esConnections';
import { esFetch } from '@/lib/esClient';
import { clampLongRunningSec, type LongRunningResult } from '@/lib/diagnose';

const TIMEOUT_MS = 10_000;
const ROWS_MAX = 100;
const WARN_SEC = 30;
const CRIT_SEC = 60;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const soft = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
const fmtS = (s: number) => (s >= 100 ? String(Math.round(s)) : String(Math.round(s * 10) / 10));
const tone = (s: number) => (s >= CRIT_SEC ? 'down' as const : s >= WARN_SEC ? 'warn' as const : undefined);

export async function esLongRunning(conn: EsConnection, minSecIn: unknown): Promise<LongRunningResult> {
  const minSec = clampLongRunningSec(minSecIn);
  const [tasks, pending, nodes] = await Promise.all([
    soft(esFetch<Json>(conn, '/_tasks?actions=indices:data/*&detailed=true&group_by=none&timeout=5s&filter_path=node_failures.*.reason,tasks.node,tasks.id,tasks.action,tasks.running_time_in_nanos,tasks.description,tasks.parent_task_id,tasks.cancelled,tasks.headers', undefined, 'GET', TIMEOUT_MS)),
    soft(esFetch<Json>(conn, '/_cluster/pending_tasks', undefined, 'GET', TIMEOUT_MS)),
    soft(esFetch<Json[]>(conn, '/_cat/nodes?format=json&full_id=true&h=id,name', undefined, 'GET', TIMEOUT_MS)),
  ]);
  const notes: string[] = [];
  const nodeName = new Map((nodes ?? []).map((n) => [String(n.id), String(n.name)]));

  const running = tasks === null ? [] : ((tasks.tasks ?? []) as Json[])
    .filter((t) => !t.parent_task_id)
    .map((t): Json => ({ ...t, sec: Number(t.running_time_in_nanos ?? 0) / 1e9 }))
    .filter((t) => t.sec >= minSec)
    .sort((a, b) => b.sec - a.sec);
  if (tasks === null) notes.push('Không đọc được _tasks (thiếu quyền monitor?)');
  const failures = (tasks?.node_failures ?? []) as Json[];
  if (failures.length) notes.push(`${failures.length} node không trả lời _tasks trong 5s — task trên node đó không có trong danh sách`);

  const waiting = pending === null ? [] : ((pending.tasks ?? []) as Json[])
    .map((t): Json => ({ ...t, sec: Number(t.time_in_queue_millis ?? 0) / 1000 }))
    .filter((t) => t.sec >= minSec)
    .sort((a, b) => b.sec - a.sec);
  if (pending === null) notes.push('Không đọc được _cluster/pending_tasks');

  return {
    at: Date.now(),
    minSec,
    notes,
    tables: [
      {
        title: `Task đang chạy ≥ ${minSec}s (${running.length})`,
        note: 'Search / msearch / scroll / bulk / *_by_query / reindex — task gốc, không tính shard con. Huỷ (nếu chắc chắn): POST _tasks/<Task>/_cancel',
        columns: ['Giây', 'Loại', 'Node', 'Task', 'Nguồn (X-Opaque-Id)', 'Mô tả'],
        right: [0],
        code: [3, 5],
        total: running.length,
        rows: running.slice(0, ROWS_MAX).map((t) => ({
          cells: [
            fmtS(t.sec),
            `${String(t.action ?? '').replace(/^indices:data\//, '')}${t.cancelled ? ' · đã huỷ' : ''}`,
            nodeName.get(String(t.node)) ?? String(t.node ?? '?'),
            `${t.node}:${t.id}`,
            String(t.headers?.['X-Opaque-Id'] ?? ''),
            String(t.description ?? ''),
          ],
          tone: tone(t.sec),
        })),
      },
      {
        title: `Pending task chờ master ≥ ${minSec}s (${waiting.length})`,
        note: 'Thay đổi cluster state đang xếp hàng ở master (tạo / xoá index, mapping, allocation…). Hàng chờ lâu là master đang quá tải.',
        columns: ['Giây', 'Ưu tiên', 'Đang chạy', 'Nguồn'],
        right: [0],
        code: [3],
        total: waiting.length,
        rows: waiting.slice(0, ROWS_MAX).map((t) => ({
          cells: [fmtS(t.sec), String(t.priority ?? ''), t.executing ? 'có' : '', String(t.source ?? '')],
          tone: tone(t.sec),
        })),
      },
    ],
  };
}
