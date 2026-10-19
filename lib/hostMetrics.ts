// Server-only: đọc node_exporter (RAM / đĩa / CPU / load) của máy chạy một dịch vụ.
//
// Dùng chung cho Kafka (brokers) và PostgreSQL — cả hai đều không nói gì về máy
// mà chúng chạy trên, trong khi đĩa đầy là cách chúng chết thường gặp nhất.
// Connection nào khai `metricsUrls` thì được đọc; không khai thì không có gì.

// ── Host metrics via node_exporter (RAM / disk / CPU / load) ─────────────────
// The Kafka protocol has no host metrics, but ops boxes usually run
// node_exporter (or jmx_exporter). When a connection declares metricsUrls,
// this fetches + parses the Prometheus text format for the handful of gauges
// an operator actually watches. CPU% needs a rate — cumulative counters are
// returned raw and the CLIENT diffs consecutive polls.

export interface HostDiskMount {
  mount: string;
  sizeBytes: number;
  availBytes: number;
}

export interface HostMetrics {
  url: string;
  /** Hostname taken from the URL (display label). */
  host: string;
  error?: string;
  load1?: number;
  load5?: number;
  load15?: number;
  memTotalBytes?: number;
  memAvailableBytes?: number;
  /** Largest real filesystems (tmpfs/overlay excluded), max 3. */
  disks?: HostDiskMount[];
  /** Cumulative CPU seconds — client diffs polls into busy %. */
  cpuIdleSec?: number;
  cpuTotalSec?: number;
  /** Số core (đếm nhãn `cpu` của node_cpu_seconds_total) — để quy load1 về mỗi core. */
  cpuCores?: number;
  at: number;
}

/** Parse Prometheus text: returns [{name, labels, value}] for the metrics we need. */
function parseProm(text: string, wanted: Set<string>): { name: string; labels: Record<string, string>; value: number }[] {
  const out: { name: string; labels: Record<string, string>; value: number }[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const brace = line.indexOf('{');
    const name = brace === -1 ? line.slice(0, line.indexOf(' ')) : line.slice(0, brace);
    if (!wanted.has(name)) continue;
    const labels: Record<string, string> = {};
    let rest: string;
    if (brace === -1) {
      rest = line.slice(name.length).trim();
    } else {
      const close = line.indexOf('}');
      if (close === -1) continue;
      for (const pair of line.slice(brace + 1, close).split(',')) {
        const eq = pair.indexOf('=');
        if (eq > 0) labels[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim().replace(/^"|"$/g, '');
      }
      rest = line.slice(close + 1).trim();
    }
    const value = Number(rest.split(' ')[0]);
    if (Number.isFinite(value)) out.push({ name, labels, value });
  }
  return out;
}

const PROM_WANTED = new Set([
  'node_load1', 'node_load5', 'node_load15',
  'node_memory_MemTotal_bytes', 'node_memory_MemAvailable_bytes',
  'node_filesystem_size_bytes', 'node_filesystem_avail_bytes',
  'node_cpu_seconds_total',
]);

const SKIP_FSTYPES = new Set(['tmpfs', 'overlay', 'squashfs', 'ramfs', 'devtmpfs', 'iso9660']);

export async function fetchOneHostMetrics(url: string): Promise<HostMetrics> {
  const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return { url, host, error: `HTTP ${res.status}`, at: Date.now() };
    const rows = parseProm(await res.text(), PROM_WANTED);
    const one = (n: string) => rows.find((r) => r.name === n)?.value;

    // Filesystems: pair size+avail by (device,mountpoint), skip pseudo fs, top 3 by size.
    const fsMap = new Map<string, { mount: string; size?: number; avail?: number }>();
    for (const r of rows) {
      if (r.name !== 'node_filesystem_size_bytes' && r.name !== 'node_filesystem_avail_bytes') continue;
      if (SKIP_FSTYPES.has(r.labels.fstype ?? '')) continue;
      const key = `${r.labels.device}|${r.labels.mountpoint}`;
      const e = fsMap.get(key) ?? { mount: r.labels.mountpoint ?? '?' };
      if (r.name === 'node_filesystem_size_bytes') e.size = r.value; else e.avail = r.value;
      fsMap.set(key, e);
    }
    const disks: HostDiskMount[] = [...fsMap.values()]
      .filter((e) => (e.size ?? 0) > 0 && e.avail !== undefined)
      .map((e) => ({ mount: e.mount, sizeBytes: e.size ?? 0, availBytes: e.avail ?? 0 }))
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
      .slice(0, 3);

    // CPU: cumulative seconds summed across all cpus; idle separately.
    // Số core đếm từ nhãn `cpu` (mỗi core một chuỗi per mode) — cần để quy
    // load1 về "mỗi core", vì load 8 trên máy 16 core là nhàn còn trên máy
    // 2 core là ngộp; không có nó thì một ngưỡng load không dùng chung được
    // cho các broker khác cấu hình.
    let cpuIdleSec = 0;
    let cpuTotalSec = 0;
    const cores = new Set<string>();
    for (const r of rows) {
      if (r.name !== 'node_cpu_seconds_total') continue;
      cpuTotalSec += r.value;
      if (r.labels.cpu) cores.add(r.labels.cpu);
      if (r.labels.mode === 'idle') cpuIdleSec += r.value;
    }

    return {
      url,
      host,
      load1: one('node_load1'),
      load5: one('node_load5'),
      load15: one('node_load15'),
      memTotalBytes: one('node_memory_MemTotal_bytes'),
      memAvailableBytes: one('node_memory_MemAvailable_bytes'),
      disks,
      cpuIdleSec: cpuTotalSec > 0 ? cpuIdleSec : undefined,
      cpuTotalSec: cpuTotalSec > 0 ? cpuTotalSec : undefined,
      cpuCores: cores.size > 0 ? cores.size : undefined,
      at: Date.now(),
    };
  } catch (e) {
    return {
      url, host, at: Date.now(),
      error: (e as Error).name === 'AbortError' ? 'timeout 5s' : (e as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Mọi endpoint được đọc song song (lỗi từng URL nằm ngay trong kết quả của URL đó). */
export function fetchHostMetrics(urls: string[]): Promise<HostMetrics[]> {
  return Promise.all(urls.map(fetchOneHostMetrics));
}
