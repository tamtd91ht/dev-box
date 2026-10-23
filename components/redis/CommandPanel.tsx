'use client';

// Tab "⚡ Chạy lệnh" của từng kết nối Redis — gõ lệnh kiểu redis-cli, mỗi dòng
// một lệnh. CHỈ lệnh dữ liệu trên từng key (danh sách cho phép ở
// lib/redisCommands — không FLUSH*/CONFIG/KEYS/EVAL…).
//
// Quy trình bắt buộc, cùng tinh thần màn Thực thi của PostgreSQL / Mongo:
//   1. ≈ Chạy thử — KHÔNG gửi lệnh nào: soát cú pháp + luật TTL, đọc trạng thái
//      hiện tại (type / TTL / kích thước) của các key sẽ bị đụng, nêu cảnh báo
//      (tạo key không TTL, SET xoá TTL cũ, key lock). Redis không rollback được
//      nên không "chạy thật rồi huỷ" như PG.
//   2. gõ lại tên connection để xác nhận,
//   3. ⚠ Commit — chỉ bật khi lần chạy thử thành công là ĐÚNG ô lệnh + DB đang
//      trên màn hình. Chạy lần lượt, dừng ở lỗi đầu tiên.
// Server độc lập chặn theo REDIS_ALLOW_WRITE + readOnly của connection.

import { useCallback, useEffect, useState } from 'react';
import { runRedisCommands, humanizeTtl, type CmdRunResult } from '@/lib/redis';
import { readLocal, writeLocal } from '@/lib/localKeys';

export interface CommandPanelProps {
  connectionId: string;
  connName: string;
  isCluster: boolean;
  /** DB đang chọn ở tab Dữ liệu — dùng làm mặc định. */
  defaultDb: number;
  readOnly: boolean;
  allowWrite: boolean;
}

interface Ran { sig: string; result: CmdRunResult }

const PLACEHOLDER = `# mỗi dòng một lệnh, dòng bắt đầu bằng # là ghi chú
SET user:123:name "Nguyễn Văn A" EX 3600
HSET user:123 status ACTIVE plan pro
EXPIRE user:123 86400
DEL tmp:job:42`;

export default function CommandPanel({ connectionId, connName, isCluster, defaultDb, readOnly, allowWrite }: CommandPanelProps) {
  const scriptKey = `redis.cmd.${connectionId}`;
  const [script, setScript] = useState('');
  const [db, setDb] = useState(defaultDb);
  // Nạp ô lệnh đang soạn dở sau mount (đọc trong initializer làm lệch hydrate).
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { setScript(readLocal(scriptKey) ?? ''); setLoaded(true); }, [scriptKey]);
  useEffect(() => { if (loaded) writeLocal(scriptKey, script); }, [loaded, scriptKey, script]);

  const [dry, setDry] = useState<Ran | null>(null);
  const [done, setDone] = useState<Ran | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effDb = isCluster ? 0 : db;
  const sig = `${effDb}\n${script}`;
  const armed = allowWrite && !readOnly;
  const dryFresh = !!dry && dry.sig === sig;
  const canCommit = armed && !busy && dryFresh && typed === connName;
  const shown = done && done.sig === sig ? done : dry;

  const run = useCallback(async (commit: boolean) => {
    if (!script.trim()) return;
    setBusy(true); setError(null);
    try {
      const result = await runRedisCommands(connectionId, effDb, script, commit);
      if (commit) { setDone({ sig, result }); setDry(null); setTyped(''); }
      else { setDry({ sig, result }); setDone(null); }
    } catch (e) {
      setError((e as Error).message);
      if (!commit) setDry(null);
    } finally { setBusy(false); }
  }, [connectionId, effDb, script, sig]);

  if (!armed) {
    return (
      <div className="panel" style={{ margin: '24px auto', maxWidth: 560, textAlign: 'center' }}>
        <div className="empty-ico" aria-hidden>🔒</div>
        <h3>Chưa mở khoá ghi</h3>
        <p className="empty">
          {!allowWrite
            ? <>Đặt <code>REDIS_ALLOW_WRITE=true</code> trong <code>.env.local</code> rồi khởi động lại dev server.</>
            : <>Connection này đang read-only — sửa connection và bỏ chọn “Read-only”.</>}
        </p>
      </div>
    );
  }

  const failed = shown?.result.committed ? shown.result.lines.find((l) => l.ok === false) : undefined;

  return (
    <div className="redis-cmd">
      <div className="redis-cmd-input">
        <div className="redis-danger">
          ⚠ Ghi thẳng lên Redis, KHÔNG rollback được. <b>≈ Chạy thử</b> không gửi lệnh nào — chỉ soát lệnh và
          đọc trạng thái các key sẽ bị đụng; <b>Commit</b> chỉ bật sau khi chạy thử đúng ô lệnh này. Chỉ lệnh dữ liệu
          trên từng key (không FLUSH / CONFIG / KEYS / EVAL / PERSIST); TTL tối đa 30 ngày.
        </div>
        <div className="status-line" style={{ gap: 8 }}>
          {isCluster ? (
            <span className="redis-badge-cluster" title="Redis Cluster chỉ có DB 0">cluster · DB 0</span>
          ) : (
            <label className="small" style={{ color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              DB
              <select value={db} onChange={(e) => setDb(Number(e.target.value))}>
                {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>{i}</option>)}
              </select>
            </label>
          )}
          <span className="small" style={{ color: 'var(--muted)' }}>Ctrl+Enter = chạy thử</span>
        </div>
        <textarea
          className="input mono"
          rows={10}
          value={script}
          spellCheck={false}
          onChange={(e) => setScript(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void run(false); } }}
          placeholder={PLACEHOLDER}
          style={{ width: '100%', fontSize: 12.5, resize: 'vertical' }}
        />
        <div className="status-line" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="sm" disabled={busy || !script.trim()} onClick={() => void run(false)}>
            {busy ? <span className="spinner" aria-hidden /> : '≈'} Chạy thử
          </button>
          <input
            className="input mono"
            style={{ flex: '1 1 160px', fontSize: 12 }}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && canCommit && void run(true)}
            placeholder={dryFresh ? `gõ lại "${connName}" để commit` : 'chạy thử trước'}
            disabled={!dryFresh}
          />
          <button
            className="sm"
            disabled={!canCommit}
            onClick={() => void run(true)}
            style={{ color: 'var(--err)', borderColor: 'var(--err)' }}
            title={canCommit ? 'Chạy các lệnh' : 'Cần chạy thử thành công đúng ô lệnh này + gõ đúng tên connection'}
          >⚠ Commit</button>
        </div>
      </div>

      <div className="redis-cmd-result">
        {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
        {!shown && !error && <p className="xhint">Kết quả chạy thử / commit sẽ hiện ở đây.</p>}
        {shown && (
          <>
            <div className="status-line" style={{ gap: 6, flexWrap: 'wrap' }}>
              {shown.result.committed
                ? failed
                  ? <span className="badge" style={{ color: 'var(--err)' }}>✕ Dừng ở dòng {failed.line} — các dòng sau KHÔNG chạy</span>
                  : <span className="badge" style={{ color: 'var(--ok)' }}>✓ Đã chạy {shown.result.lines.length} lệnh</span>
                : <span className="badge">≈ Chạy thử — chưa gửi lệnh nào</span>}
              <span className="badge">{shown.result.tookMs}ms</span>
            </div>

            {shown.result.warnings.length > 0 && (
              <div className="redis-danger" style={{ marginTop: 8 }}>
                {shown.result.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
              </div>
            )}

            <table className="pg-table" style={{ marginTop: 8 }}>
              <thead>
                <tr><th>#</th><th style={{ textAlign: 'left' }}>Lệnh</th><th style={{ textAlign: 'left' }}>{shown.result.committed ? 'Kết quả' : 'Loại'}</th></tr>
              </thead>
              <tbody>
                {shown.result.lines.map((l) => (
                  <tr key={l.line}>
                    <td className="pg-rownum">{l.line}</td>
                    <td style={{ textAlign: 'left' }}><code className="small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{l.command}</code></td>
                    <td style={{ textAlign: 'left' }}>
                      {!shown.result.committed
                        ? <span className="badge" style={l.write ? { color: 'var(--err)' } : undefined}>{l.write ? 'ghi' : 'đọc'}</span>
                        : l.ok
                          ? <code className="small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{l.reply}</code>
                          : <span style={{ color: 'var(--err)' }}>{l.error}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!shown.result.committed && shown.result.keys.length > 0 && (
              <>
                <div className="small" style={{ color: 'var(--muted)', margin: '10px 0 4px' }}>Trạng thái hiện tại của các key sẽ bị đụng:</div>
                <table className="pg-table">
                  <thead>
                    <tr><th style={{ textAlign: 'left' }}>Key</th><th>Type</th><th>TTL</th><th>Kích thước</th></tr>
                  </thead>
                  <tbody>
                    {shown.result.keys.map((k) => (
                      <tr key={k.key}>
                        <td style={{ textAlign: 'left' }}>
                          <code className="small" style={{ wordBreak: 'break-all' }}>{k.key}</code>
                          {k.lock && <span className="badge" style={{ color: 'var(--err)', marginLeft: 6 }}>lock</span>}
                        </td>
                        <td>{k.type === 'none' ? <span style={{ color: 'var(--muted)' }}>chưa có</span> : k.type}</td>
                        <td>{k.pttl === -2 ? '—' : humanizeTtl(k.pttl < 0 ? k.pttl : Math.ceil(k.pttl / 1000))}</td>
                        <td>{k.size ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
