'use client';

// "Vì sao không có sự kiện nào?" — the diagnostic for message capture.
//
// A message travels four stages before a rule can act on it:
//
//   ① Zalo raises a Notification
//   ② the collector's hook catches it and queues it in the page
//   ③ the 3s poll drains the queue into the renderer
//   ④ the engine evaluates it and runs actions
//
// A rule that "stopped working" looks IDENTICAL at every stage, and four
// rounds of fixing stage ④ changed nothing because the messages were never
// getting past ①. This panel reads the collector's own counters so the dead
// stage is a fact rather than a theory: `pushes` counts hook firings, so if it
// does not move while you send messages, the app never notified — and nothing
// in the engine can help.

import { useCallback, useEffect, useState } from 'react';
import { captureDiagScript, type CaptureDiag } from '@/lib/workspace/capture';
import { listGuests, subscribeGuests, type GuestHandle } from '@/lib/workspace/guests';
import { messagingPlugins } from '@/lib/workspace/plugins';
import { automation } from '@/lib/automation/runtime';

interface Row {
  key: string;
  label: string;
  diag: CaptureDiag | null;
  error: string;
}

const ago = (t: number): string => {
  if (!t) return 'chưa lần nào';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s trước`;
  if (s < 3600) return `${Math.round(s / 60)}m trước`;
  return `${Math.round(s / 3600)}h trước`;
};

export default function CapturePanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [guests, setGuests] = useState<GuestHandle[]>(listGuests());
  const [auto, setAuto] = useState(true);

  useEffect(() => subscribeGuests(() => setGuests(listGuests())), []);

  const social = new Set(messagingPlugins().map((p) => p.id));
  const targets = guests.filter((g) => social.has(g.pluginId));

  const probe = useCallback(async () => {
    setBusy(true);
    const list = listGuests().filter((g) => social.has(g.pluginId));
    const next: Row[] = [];
    for (const g of list) {
      try {
        const d = (await g.exec(captureDiagScript())) as CaptureDiag | null;
        next.push({ key: g.accountKey, label: g.label, diag: d ?? null, error: d ? '' : 'không trả về' });
      } catch (e) {
        next.push({ key: g.accountKey, label: g.label, diag: null, error: (e as Error).message });
      }
    }
    setRows(next);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guests]);

  useEffect(() => {
    void probe();
  }, [probe]);

  // Re-read while the panel is open: the point is to watch `pushes` move (or
  // fail to) as you send a message from your phone.
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => void probe(), 3000);
    return () => clearInterval(t);
  }, [auto, probe]);

  return (
    <div className="panel auto-cap">
      <div className="auto-list-head">
        <b>🔬 Chẩn đoán thu tin</b>
        <span className="auto-hint">
          Nhắn thử một tin rồi nhìn cột <b>hook bắt được</b>. Số KHÔNG tăng ⇒ Zalo không hề bắn thông
          báo cho tin đó, và mọi thứ phía sau (điều kiện, chống lặp, hành động) đều vô can.
        </span>
        <label className="auto-toggle" style={{ marginLeft: 'auto' }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span className="auto-toggle-text">
            <b>Tự đo lại</b>
            <em>mỗi 3 giây</em>
          </span>
        </label>
        <button type="button" className="ghost sm" disabled={busy} onClick={() => void probe()}>
          {busy ? 'đang đo…' : 'Đo lại'}
        </button>
      </div>

      {!targets.length && (
        <p className="ws-scan-bad">
          ✗ Không có tài khoản nhắn tin nào đang sống. Mở tab 🧭 Workspace một lần (cần app desktop)
          để guest khởi động, rồi quay lại đây.
        </p>
      )}

      {automation.echoTrace.length > 0 && (
        <div className="auto-cap-row">
          <b>⛔ So khớp chống lặp (tin social gần nhất)</b>
          <span className="auto-hint">
            Mỗi dòng: tin đến so với các bản ghi automation vừa gửi. <b>khớp = có</b> ⇒ tin của
            automation, bị chặn. <b>khớp = không</b> mà đúng ra phải khớp ⇒ nhìn chỗ lệch giữa “đến”
            và “đã gửi” để biết vì sao.
          </span>
          <div className="ws-scan-list">
            <table>
              <thead>
                <tr>
                  <th>lúc</th>
                  <th>khớp</th>
                  <th>hội thoại đến</th>
                  <th>nội dung đến</th>
                  <th>bản ghi đã gửi (hội thoại ¦ nội dung ¦ giây)</th>
                </tr>
              </thead>
              <tbody>
                {automation.echoTrace.map((t, i) => (
                  <tr key={i} className={t.matched ? 'is-picked' : undefined}>
                    <td className="auto-hint">{new Date(t.at).toLocaleTimeString('vi-VN')}</td>
                    <td className={t.matched ? 'ws-scan-ok' : 'ws-scan-bad'}>{t.matched ? '✓' : '✗'}</td>
                    <td><code>{t.conv || '(rỗng)'}</code></td>
                    <td><code>{t.body || '(rỗng)'}</code></td>
                    <td className="auto-hint">
                      {t.records.length
                        ? t.records.map((e, k) => (
                            <div key={k}>
                              <code>{e.conv || '(rỗng)'}</code> ¦ <code>{e.text}</code> ¦ {e.age}s
                            </div>
                          ))
                        : '— chưa gửi gì —'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {rows.map((r) => (
        <div key={r.key} className="auto-cap-row">
          <div className="ws-scan-sum">
            <b>{r.label}</b>
            {r.error ? (
              <span className="ws-scan-bad">✗ {r.error}</span>
            ) : r.diag ? (
              <>
                <span className={r.diag.hooked ? 'ws-scan-ok' : 'ws-scan-bad'}>
                  {r.diag.hooked ? '✓ đã gắn hook' : '✗ CHƯA gắn hook'}
                </span>
                <span className={r.diag.notiHooked ? 'ws-scan-ok' : 'ws-scan-warn'}>
                  Notification {r.diag.notiHooked ? '✓' : '✗'}
                </span>
                <span className={r.diag.swHooked ? 'ws-scan-ok' : 'auto-hint'}>
                  serviceWorker {r.diag.swHooked ? '✓' : '—'}
                </span>
                <span className={r.diag.permission === 'granted' ? 'ws-scan-ok' : 'ws-scan-bad'}>
                  quyền: {r.diag.permission}
                </span>
                <span className={r.diag.cap ? 'ws-scan-ok' : 'ws-scan-warn'}>
                  đọc nội dung: {r.diag.cap ? 'bật' : 'TẮT'}
                </span>
              </>
            ) : null}
          </div>

          {r.diag && (
            <>
              <div className="ws-scan-sum">
                <span>
                  <b>hook bắt được: {r.diag.pushes}</b> lần
                </span>
                <span>gần nhất: {ago(r.diag.lastPush)}</span>
                <span>đang chờ hút: {r.diag.queued}</span>
                <span>chưa đọc: {r.diag.noti}</span>
                <span className={r.diag.focused ? 'ws-scan-warn' : undefined}>
                  app thấy: {r.diag.visibility}
                  {r.diag.focused ? ' · đang focus' : ' · không focus'}
                </span>
              </div>

              {r.diag.hooked && r.diag.pushes === 0 && (
                <p className="auto-hint">
                  Hook đã gắn nhưng chưa bắt được lần nào. Nhắn một tin từ máy khác rồi xem số này —
                  không nhúc nhích ⇒ app không bắn thông báo (chặng ①), tăng mà tab Hoạt động vẫn
                  trống ⇒ hỏng ở chặng ③/④.
                </p>
              )}

              {r.diag.log.length > 0 && (
                <div className="ws-scan-list">
                  <table>
                    <thead>
                      <tr>
                        <th>lúc</th>
                        <th>người gửi</th>
                        <th>hội thoại</th>
                        <th>nguồn</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...r.diag.log].reverse().map((l, i) => (
                        <tr key={i}>
                          <td className="auto-hint">
                            {new Date(l.t).toLocaleTimeString('vi-VN')}
                          </td>
                          <td>{l.s || '—'}</td>
                          <td>{l.c || '—'}</td>
                          <td className="auto-hint">{l.k}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
