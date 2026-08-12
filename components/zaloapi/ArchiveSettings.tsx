'use client';

// Zalo API — cấu hình KHO LƯU TRỮ TIN (3 chế độ: off / local / mongo).
//
// VÌ SAO CẦN: listener socket chỉ thấy tin TỪ LÚC KẾT NỐI, và Zalo không cho lấy
// lại lịch sử 1-1 — không lưu thì restart app là trắng màn chat. Panel này chọn
// lưu ở đâu (xem lib/zaloapi/server/messageArchive).
//
// XÁC NHẬN HAI BƯỚC cho mọi lượt đổi chế độ: tin nhắn là dữ liệu cá nhân, và
// chọn nhầm cụm Mongo của dự án khác sẽ ghi collection lạ vào đó — nên bắt đọc
// lại đích đến trước khi chốt (cùng kỷ luật với tab Công việc).
//
// Thêm connection Mongo mới dùng thẳng form CHUẨN của menu Mongo
// (components/mongo/ConnectionForm) — cùng một registry, không có đường riêng.

import { useCallback, useEffect, useState } from 'react';
import ConnectionForm from '../mongo/ConnectionForm';
import type { PublicMongoConnection } from '@/lib/mongo';

export type ArchiveMode = 'off' | 'local' | 'mongo';

export interface ArchiveConfigView {
  mode: ArchiveMode;
  configured: boolean;
  config: { mode: ArchiveMode; connectionId?: string; database?: string };
  connectionName: string | null;
  connections: PublicMongoConnection[];
  storedCount?: number;
  localKb?: number;
  probeError?: string;
}

async function api<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('/api/zaloapi', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(json?.error || `Lỗi ${res.status}`);
  return json.result as T;
}

const MODE_META: Record<ArchiveMode, { ico: string; title: string; desc: string }> = {
  off: {
    ico: '🚫',
    title: 'Không lưu',
    desc: 'Chỉ giữ trong RAM như hiện tại. Tắt app hoặc ngắt kết nối là mất lịch sử. '
      + 'Riêng tư nhất — không có tin nào xuống đĩa.',
  },
  local: {
    ico: '💾',
    title: 'Lưu trên máy này',
    desc: 'Một file cho mỗi tài khoản trong configs/zaloapi-messages/. Không cần Mongo, chạy offline. '
      + 'Tự giới hạn dung lượng: trần 16 MB mỗi tài khoản, giữ 400 tin mới nhất mỗi hội thoại, '
      + 'bỏ tin cũ hơn 90 ngày. Sync sang máy khác bằng chính FILE tin (qua vault có passphrase).',
  },
  mongo: {
    ico: '🍃',
    title: 'Lưu trên MongoDB',
    desc: 'Ghi vào collection zaloapi_messages của một cụm chọn từ menu Mongo. Nhiều máy cùng thấy một kho. '
      + 'Sync sang máy khác chỉ là CON TRỎ (connectionId + database) — mật khẩu cụm vẫn nằm ở registry Mongo.',
  },
};

export default function ArchiveSettings({ accountKey, onClose }: {
  accountKey: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<ArchiveConfigView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Lựa chọn đang soạn (chưa lưu).
  const [mode, setMode] = useState<ArchiveMode>('off');
  const [connId, setConnId] = useState('');
  const [database, setDatabase] = useState('devbox');
  const [adding, setAdding] = useState(false);
  const [conns, setConns] = useState<PublicMongoConnection[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [purging, setPurging] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const v = await api<ArchiveConfigView>('archiveConfig', { accountKey });
      setView(v);
      setMode(v.mode);
      setConns(v.connections);
      setConnId(v.config.connectionId ?? v.connections[0]?.id ?? '');
      setDatabase(v.config.database ?? 'devbox');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [accountKey]);

  useEffect(() => { void load(); }, [load]);

  const selConn = conns.find((c) => c.id === connId) ?? null;
  const changed = !view
    || view.mode !== mode
    || (mode === 'mongo' && (view.config.connectionId !== connId || (view.config.database ?? '') !== database.trim()));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const v = await api<ArchiveConfigView>('archiveConfigSet', {
        accountKey,
        mode,
        ...(mode === 'mongo' ? { connectionId: connId, database: database.trim() } : {}),
      });
      setView(v);
      setConfirming(false);
      setNote(
        v.mode === 'off'
          ? 'Đã tắt lưu trữ. Tin đã lưu trước đó vẫn còn — dùng “Dọn kho” nếu muốn xoá.'
          : `Đã bật lưu trữ (${MODE_META[v.mode].title}).`
        + (v.storedCount ? ` Kho đang có ${v.storedCount} tin của tài khoản này.` : ''),
      );
    } catch (e) {
      setErr((e as Error).message);
      setConfirming(false);
    } finally { setBusy(false); }
  };

  const hydrate = async () => {
    setBusy(true); setErr(null); setNote('');
    try {
      const r = await api<{ threads: number; messages: number }>('archiveHydrate', { accountKey });
      setNote(r.messages
        ? `Đã nạp lại ${r.messages} tin của ${r.threads} hội thoại vào màn chat.`
        : 'Kho không có tin nào mới để nạp (màn chat đã có đủ).');
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  const purge = async () => {
    setBusy(true); setErr(null); setNote('');
    try {
      const r = await api<{ messages: number; threads: number }>('archivePurge', { accountKey });
      setNote(`Đã xoá ${r.messages} tin (${r.threads} hội thoại) khỏi kho.`);
      setPurging(false);
      await load();
    } catch (e) {
      setErr((e as Error).message);
      setPurging(false);
    } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal za-arch" onClick={(e) => e.stopPropagation()} style={{ width: 'min(680px, 95vw)' }}>
        <h3 style={{ marginTop: 0 }}>🗄 Kho lưu trữ tin nhắn</h3>
        <p className="small" style={{ color: 'var(--muted)' }}>
          Zalo chỉ đẩy tin qua socket <b>từ lúc kết nối</b> và không cho lấy lại lịch sử chat 1-1, nên
          không lưu thì tắt app là mất. Chọn chỗ lưu để lần mở sau dựng lại được màn chat.
        </p>

        {view && view.configured && (
          <p className="small" style={{ color: 'var(--muted)' }}>
            Đang dùng: <b>{MODE_META[view.mode].title}</b>
            {view.mode === 'mongo' && view.connectionName ? <> — <b>{view.connectionName}</b> / db <code>{view.config.database}</code></> : null}
            {typeof view.storedCount === 'number' ? <> · đã lưu <b>{view.storedCount}</b> tin (tài khoản này)</> : null}
            {typeof view.localKb === 'number' ? <> · <b>{view.localKb} KB</b> trên đĩa</> : null}
          </p>
        )}
        {view?.probeError && (
          <p className="small" style={{ color: 'var(--warn, #d29922)' }}>
            Không đọc được kho: {view.probeError}
          </p>
        )}

        {/* Chọn chế độ */}
        <div className="za-arch-modes">
          {(['off', 'local', 'mongo'] as ArchiveMode[]).map((m) => (
            <label key={m} className={`za-arch-mode${mode === m ? ' is-on' : ''}`}>
              <input type="radio" name="zaarchmode" checked={mode === m} onChange={() => setMode(m)} />
              <span className="za-arch-ico" aria-hidden>{MODE_META[m].ico}</span>
              <span className="za-arch-body">
                <b>{MODE_META[m].title}</b>
                <span className="small">{MODE_META[m].desc}</span>
              </span>
            </label>
          ))}
        </div>

        {/* Cấu hình riêng của chế độ mongo */}
        {mode === 'mongo' && (
          <div className="za-arch-mongo">
            <label className="wk-field">
              <span>Cụm Mongo</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <select className="input" value={connId} onChange={(e) => setConnId(e.target.value)} style={{ flex: 1 }}>
                  {conns.length === 0 && <option value="">— chưa có connection nào —</option>}
                  {conns.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.project ? ` (${c.project})` : ''}</option>
                  ))}
                </select>
                <button className="ghost sm" onClick={() => setAdding((v) => !v)}>
                  {adding ? 'Đóng form' : '＋ Kết nối mới'}
                </button>
              </div>
            </label>

            {adding && (
              <div className="wk-newconn">
                {/* Form CHUẨN của menu Mongo — lưu thẳng vào registry dùng chung. */}
                <ConnectionForm
                  initial={null}
                  onCancel={() => setAdding(false)}
                  onError={(m) => setErr(m)}
                  onSaved={({ list, activeId }) => {
                    setConns(list);
                    setConnId(activeId);
                    setAdding(false);
                    setErr(null);
                  }}
                />
              </div>
            )}

            <label className="wk-field">
              <span>Database</span>
              <input className="input" value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="devbox" />
            </label>
            <p className="small" style={{ color: 'var(--muted)' }}>
              Collection cố định: <code>zaloapi_messages</code> + <code>zaloapi_threads</code>.
            </p>
          </div>
        )}

        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
        {note && <p className="small" style={{ color: 'var(--ok, #3fb950)' }}>{note}</p>}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button
            onClick={() => setConfirming(true)}
            disabled={busy || !changed || (mode === 'mongo' && (!connId || !database.trim()))}
            title={!changed ? 'Chưa thay đổi gì so với cấu hình hiện tại' : undefined}
          >💾 Lưu cấu hình…</button>
          {view?.configured && (
            <button className="ghost" onClick={() => void hydrate()} disabled={busy}
              title="Đọc kho và nạp lịch sử vào màn chat ngay">↻ Nạp lại lịch sử</button>
          )}
          {view?.configured && (
            <button className="ghost" onClick={() => setPurging(true)} disabled={busy}
              title="Xoá tin đã lưu của tài khoản này">🗑 Dọn kho…</button>
          )}
          <span style={{ flex: 1 }} />
          <button className="ghost" onClick={onClose} disabled={busy}>Đóng</button>
        </div>

        {/* XÁC NHẬN đổi chế độ — tin nhắn là dữ liệu cá nhân, và ghi nhầm vào cụm
            Mongo của dự án khác là tai nạn thật. */}
        {confirming && (
          <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && !busy && setConfirming(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(520px, 94vw)' }}>
              <h3 style={{ marginTop: 0 }}>⚠ Xác nhận kho lưu trữ</h3>
              {mode === 'off' ? (
                <p className="small">
                  Từ giờ <b>KHÔNG lưu</b> tin nào nữa — lịch sử chỉ còn trong RAM và mất khi tắt app.
                  Tin đã lưu trước đó vẫn giữ nguyên tại chỗ.
                </p>
              ) : mode === 'local' ? (
                <>
                  <p className="small">Tin nhắn sẽ được <b>GHI XUỐNG ĐĨA MÁY NÀY</b>:</p>
                  <ul className="small" style={{ lineHeight: 1.9 }}>
                    <li>Thư mục: <code>configs/zaloapi-messages/</code></li>
                    <li>Trần: 16 MB mỗi tài khoản · 400 tin mới nhất mỗi hội thoại · bỏ tin quá 90 ngày</li>
                    <li>Sync: file tin vào vault mã hoá (cần passphrase để kéo về máy khác)</li>
                  </ul>
                  <p className="small" style={{ color: 'var(--warn, #d29922)' }}>
                    Tin nhắn là dữ liệu cá nhân — chỉ bật nếu bạn chấp nhận nó nằm trên đĩa (và trong vault sync).
                  </p>
                </>
              ) : selConn ? (
                <>
                  <p className="small">Tin nhắn sẽ được <b>GHI VÀO CỤM MONGODB</b>:</p>
                  <ul className="small" style={{ lineHeight: 1.9 }}>
                    <li>Cụm: <b>{selConn.name}</b>{selConn.project ? <> (project <b>{selConn.project}</b>)</> : null}</li>
                    <li>Hosts: <code>{selConn.hosts.join(', ')}</code></li>
                    <li>Database: <code>{database.trim()}</code> · Collection: <code>zaloapi_messages</code></li>
                  </ul>
                  <p className="small" style={{ color: 'var(--warn, #d29922)' }}>
                    Kiểm tra kỹ — chọn nhầm cụm của dự án khác sẽ ghi tin nhắn cá nhân vào đó.
                  </p>
                </>
              ) : (
                <p className="small" style={{ color: 'var(--err)' }}>Chưa chọn được connection.</p>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                <button className="ghost sm" onClick={() => setConfirming(false)} disabled={busy}>Hủy</button>
                <button className="sm" onClick={() => void save()} disabled={busy || (mode === 'mongo' && !selConn)}>
                  {busy ? <span className="spinner" aria-hidden /> : '✓'} Xác nhận
                </button>
              </div>
            </div>
          </div>
        )}

        {/* XÁC NHẬN dọn kho — xoá tin là không lấy lại được. */}
        {purging && (
          <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && !busy && setPurging(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(480px, 94vw)' }}>
              <h3 style={{ marginTop: 0 }}>🗑 Dọn kho lưu trữ</h3>
              <p className="small">
                Xoá <b>toàn bộ tin đã lưu</b> của tài khoản này
                {view?.mode === 'mongo' ? <> khỏi cụm <b>{view.connectionName}</b></> : <> khỏi đĩa máy này</>}
                {typeof view?.storedCount === 'number' ? <> ({view.storedCount} tin)</> : null}. Không lấy lại được.
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                <button className="ghost sm" onClick={() => setPurging(false)} disabled={busy}>Hủy</button>
                <button className="sm" onClick={() => void purge()} disabled={busy}>
                  {busy ? <span className="spinner" aria-hidden /> : '✓'} Xoá
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
