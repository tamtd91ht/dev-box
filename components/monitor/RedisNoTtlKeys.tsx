'use client';

// "Liệt kê key không TTL" trong Phân tích RAM Redis (lib/redisMemDiagnose.listNoTtlKeys).
// Cảnh báo "x% key không có TTL" chỉ có tỉ lệ — đây lấy ra tên N key cụ thể (người dùng
// chọn N) kèm loại + kích thước, gom theo dạng key, sao chép / tải CSV để xử lý tiếp.

import { useMemo, useState } from 'react';
import { redisListNoTtl, type NoTtlKeyList } from '@/lib/redis';
import { fmtBytes, fmtN } from '@/lib/diagnose';

const MAX_N = 10_000;
const SHOW_ROWS = 500;

export default function RedisNoTtlKeys({ connectionId }: { connectionId: string }) {
  const [n, setN] = useState(500);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [data, setData] = useState<NoTtlKeyList>();
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState(false);
  // Danh sách có thể dài — thu gọn được để xem tiếp phần phía dưới.
  const [open, setOpen] = useState(true);

  const run = () => {
    setBusy(true);
    setError(undefined);
    redisListNoTtl(connectionId, n)
      .then((d) => { setData(d); setOpen(true); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data?.keys ?? []).filter((k) => !q || k.key.toLowerCase().includes(q));
  }, [data, filter]);

  // Gom theo dạng key: dạng nào nhiều key không TTL nhất / tốn RAM nhất.
  const groups = useMemo(() => {
    const m = new Map<string, { db: number; pattern: string; count: number; bytes: number; sample: string }>();
    for (const k of rows) {
      const id = `${k.db}|${k.pattern}`;
      const g = m.get(id) ?? { db: k.db, pattern: k.pattern, count: 0, bytes: 0, sample: k.key };
      g.count++;
      g.bytes += k.bytes ?? 0;
      m.set(id, g);
    }
    return [...m.values()].sort((a, b) => b.count - a.count || b.bytes - a.bytes);
  }, [rows]);

  const copyKeys = () => {
    void navigator.clipboard?.writeText(rows.map((k) => k.key).join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  const downloadCsv = () => {
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = ['db,key,type,bytes,pattern', ...rows.map((k) => [k.db, esc(k.key), k.type, k.bytes ?? '', esc(k.pattern)].join(','))].join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `redis-no-ttl-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="pgd-sub">Key không TTL</div>
      <div className="rmd-actions">
        <label className="rmd-dur" title={`Số key không TTL muốn lấy ra (1–${fmtN(MAX_N)})`}>
          Lấy
          <input
            type="number"
            min={1}
            max={MAX_N}
            step={100}
            value={n}
            onChange={(e) => setN(Math.min(MAX_N, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
            className="rmd-n"
          />
          key
        </label>
        <button
          type="button"
          className="mon-btn"
          disabled={busy}
          onClick={run}
          title="SCAN (lượt 200, có nghỉ) + TTL theo trang đến khi đủ N key không TTL; rồi TYPE + MEMORY USAGE cho các key đó. Bỏ qua nếu CPU ≥ 80%, dừng nếu Redis chậm, trần 30 giây quét. Không đọc giá trị key."
        >
          {busy ? '⏳ Đang quét…' : `📋 ${data ? 'Liệt kê lại' : 'Liệt kê key không TTL'}`}
        </button>
        {data?.keys.length ? (
          <>
            <button
              type="button"
              className="mon-btn"
              onClick={() => setOpen((v) => !v)}
              title={open ? 'Ẩn bảng — giữ kết quả, mở lại lúc nào cũng được' : 'Hiện lại bảng key không TTL'}
            >
              {open ? '▴ Thu gọn' : `▾ Xem ${fmtN(data.keys.length)} key`}
            </button>
            {open ? <input className="rmd-filter" placeholder="Lọc theo tên key…" value={filter} onChange={(e) => setFilter(e.target.value)} /> : null}
            <button type="button" className="mon-btn" onClick={copyKeys}>{copied ? '✓ Đã chép' : `Sao chép ${fmtN(rows.length)} key`}</button>
            <button type="button" className="mon-btn" onClick={downloadCsv}>Tải CSV</button>
          </>
        ) : null}
      </div>
      {error ? <p className="mon-d-faint">Lỗi: {error}</p> : null}
      {data ? (
        <p className="mon-d-faint">
          {data.refused
            ? <>Không chạy: {data.refused}.</>
            : <>
              Lấy được <b>{fmtN(data.keys.length)}</b> / {fmtN(data.requested)} key không TTL
              {' '}(INFO: {fmtN(data.noTtlTotal)} / {fmtN(data.dbsize)} key không TTL).
              {data.scanned ? <> Đã quét {fmtN(data.scanned)} key, {Math.round((data.scannedNoTtl / data.scanned) * 100)}% trong đó không TTL.</> : null}
              {data.stopped ? <> Dừng sớm: {data.stopped}.</> : null}
            </>}
          {data.skipped.length ? <> Bỏ qua: {data.skipped.map((s) => `${s.addr} (${s.error})`).join('; ')}.</> : null}
        </p>
      ) : null}
      {open && groups.length ? (
        <div className="rmd-table-wrap rmd-scroll-sm">
          <table className="mon-mini rmd-table">
            <thead>
              <tr><th>Dạng key</th><th className="r">Số key</th><th className="r">Tổng RAM</th><th>Ví dụ</th></tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={`${g.db}|${g.pattern}`}>
                  <td><code>{g.pattern}</code>{g.db ? <span className="mon-d-faint"> · db {g.db}</span> : null}</td>
                  <td className="r">{fmtN(g.count)}</td>
                  <td className="r">{fmtBytes(g.bytes)}</td>
                  <td><code>{g.sample}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {open && rows.length ? (
        <div className="rmd-table-wrap rmd-scroll">
          <table className="mon-mini rmd-table">
            <thead>
              <tr><th>Key</th><th>Loại</th><th className="r">RAM</th></tr>
            </thead>
            <tbody>
              {rows.slice(0, SHOW_ROWS).map((k) => (
                <tr key={`${k.db}|${k.key}`}>
                  <td><code>{k.key}</code>{k.db ? <span className="mon-d-faint"> · db {k.db}</span> : null}</td>
                  <td>{k.type}</td>
                  <td className="r">{k.bytes !== null ? fmtBytes(k.bytes) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > SHOW_ROWS ? (
            <p className="mon-d-faint">Hiện {fmtN(SHOW_ROWS)} / {fmtN(rows.length)} key lớn nhất — sao chép / tải CSV để có đủ danh sách.</p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
