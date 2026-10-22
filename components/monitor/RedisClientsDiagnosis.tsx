'use client';

// "Phân tích" số client kết nối Redis (lib/redisClientsDiagnose). Mức cơ bản chạy ngay
// khi mở (chỉ INFO + CONFIG GET); "Xem client theo nguồn" (CLIENT LIST — O(số client)
// trên luồng chính) phải bấm rồi XÁC NHẬN (thấy ước tính thời gian chiếm luồng chính),
// và server còn tự từ chối khi nhiều client / CPU cao. "Phân tích lại" chỉ chạy mức cơ bản.

import { useCallback, useEffect, useState } from 'react';
import { redisDiagnoseClients, type RedisClientsDiagnosis } from '@/lib/redis';
import { fmtN } from '@/lib/diagnose';
import DiagnosisView from './DiagnosisView';

/** Giải thích cơ chế — khớp với lib/redisClientsDiagnose.ts + lib/redisClientsRules.ts. */
const MECHANISM = (
  <>
    <p>
      Cảnh báo của Monitor dùng ngưỡng cố định (5.000 / 9.000 client); trần thật là <code>maxclients</code> — vượt trần thì Redis
      từ chối kết nối mới. App trả lời:
    </p>
    <ol className="pgd-info-steps">
      <li>
        <b>Còn bao xa trần:</b> <code>CONFIG GET maxclients</code> so với <code>connected_clients</code>; <code>rejected_connections</code>{' '}
        đọc hai lần cách 3 giây → đang từ chối hay chỉ là chuyện cũ.
      </li>
      <li>
        <b>Mở / đóng liên tục:</b> <code>total_connections_received</code> tăng bao nhiêu mỗi giây — cao là ứng dụng không dùng pool.
      </li>
      <li>
        <b>Cấu hình:</b> <code>timeout</code> (0 = kết nối rảnh không bao giờ bị ngắt), <code>tcp-keepalive</code> (0 = kết nối chết vẫn bị giữ).
      </li>
      <li>
        <b>Kết nối đến từ đâu</b> (bấm mới chạy): <code>CLIENT LIST</code>, gom theo máy nguồn (IP), tên client (<code>CLIENT SETNAME</code> /
        lib-name), thời gian rảnh, tuổi kết nối, pub/sub, đang chờ BLPOP. Bỏ qua kết nối replica.
      </li>
    </ol>
    <p className="mon-d-faint">
      <b>An toàn production:</b> mức cơ bản chỉ <code>INFO</code> + <code>CONFIG GET</code>. <code>CLIENT LIST</code> chạy trên luồng chính,
      tốn ~1–2 ms mỗi 1.000 client, nên chỉ chạy khi bạn bấm, node ≤ 5.000 client (ước tính &lt; 10 ms) và CPU luồng chính &lt; 80%, sau một bước xác nhận; cụm thì lần lượt từng
      node, nghỉ giữa các node. App chỉ gom số đếm, không đổi cấu hình, không ngắt kết nối nào.{' '}
      <b>Không phân tích được:</b> tiến trình / container nào phía sau một IP NAT, kết nối nào là rò hay pool đang giữ (chỉ suy từ thời gian
      rảnh), lịch sử số kết nối trước lúc bấm.
    </p>
  </>
);

export default function RedisClientsDiagnosis({ connectionId }: { connectionId: string }) {
  const [state, setState] = useState<{ busy: boolean; listing?: boolean; data?: RedisClientsDiagnosis; error?: string }>({ busy: true });
  // Khung xác nhận CLIENT LIST đang mở.
  const [confirming, setConfirming] = useState(false);

  const run = useCallback((list: boolean) => {
    setState((s) => ({ ...s, busy: true, listing: list, error: undefined }));
    redisDiagnoseClients(connectionId, { list })
      .then((data) => setState({ busy: false, data }))
      .catch((e: Error) => setState({ busy: false, error: e.message }));
  }, [connectionId]);
  useEffect(() => { run(false); }, [run]);

  const d = state.data;
  const L = d?.list;
  const estMs = d ? Math.max(1, Math.round((d.clients / 1000) * 2)) : null;

  return (
    <DiagnosisView
      title="Phân tích client"
      busy={state.busy}
      busyText={state.listing
        ? 'Đang đọc INFO rồi CLIENT LIST (lần lượt từng node, khoảng 4–6 giây)…'
        : 'Đang đọc INFO clients / stats và cấu hình (khoảng 3–5 giây, chỉ đọc)…'}
      error={state.error}
      data={d}
      onRerun={() => run(false)}
      info={MECHANISM}
      infoSummary="So với maxclients thật, kết nối mới mỗi giây, bị từ chối, cấu hình timeout / keepalive; CLIENT LIST khi bấm"
      nums={d ? (
        <>
          Client: <b>{fmtN(d.clients)}</b>
          {d.maxclients ? <> / {fmtN(d.maxclients)} · <b>{d.usedPct}%</b> maxclients</> : ' · maxclients: ?'}
          {d.newPerSec !== null ? <> · Kết nối mới: <b>{fmtN(d.newPerSec)}/s</b></> : null}
        </>
      ) : null}
      extra={d ? (
        <>
          {L ? (
            <>
              <div className="pgd-sub">Theo máy nguồn</div>
              <Groups rows={L.bySource} />
              <div className="pgd-sub">Theo tên client</div>
              <Groups rows={L.byName} />
              <p className="mon-d-faint">
                {fmtN(L.total)} client · rảnh &lt; 1 phút {fmtN(L.idle.lt60)} · 1–10 phút {fmtN(L.idle.lt600)} · 10 phút–1 giờ {fmtN(L.idle.lt3600)}
                {' '}· ≥ 1 giờ {fmtN(L.idle.ge3600)} · pub/sub {fmtN(L.pubsub)} · chờ BLPOP {fmtN(L.blocked)} · CLIENT LIST mất {fmtN(L.durationMs)} ms (tính cả mạng).
              </p>
            </>
          ) : null}
          {confirming ? (
            <div className="rmd-confirm">
              <p>
                <code>CLIENT LIST</code> duyệt mọi client trong MỘT lệnh trên luồng chính: với <b>{fmtN(d.clients)}</b> client, Redis đứng
                khoảng <b>~{estMs} ms</b> (ước tính) — mọi lệnh khác phải chờ chừng đó. Ứng dụng đặt timeout lệnh ngắn hơn có thể báo lỗi một lần.
              </p>
              <p className="mon-d-faint">Server tự từ chối nếu một node có &gt; 5.000 client hoặc CPU luồng chính ≥ 80%. Cụm: lần lượt từng node, nghỉ giữa các node.</p>
              <div className="rmd-actions">
                <button type="button" className="mon-btn primary" onClick={() => { setConfirming(false); run(true); }}>Chạy CLIENT LIST</button>
                <button type="button" className="mon-btn" onClick={() => setConfirming(false)}>Huỷ</button>
              </div>
            </div>
          ) : (
            <p className="mon-d-faint">
              {d.listRefused ? <>Chưa xem danh sách: {d.listRefused}. </> : null}
              <button type="button" className="mon-btn" disabled={state.busy} onClick={() => setConfirming(true)}>
                👥 {L ? 'Xem lại client theo nguồn' : 'Xem client theo nguồn'}
              </button>
            </p>
          )}
        </>
      ) : null}
      foot={d ? (
        <>
          lúc {new Date(d.at).toLocaleTimeString('vi-VN')} · chỉ đọc{L ? ' (kèm CLIENT LIST)' : ''}, không đổi gì trên server
          {d.skipped.length ? <> · bỏ qua: {d.skipped.map((s) => `${s.addr} (${s.error})`).join('; ')}</> : null}
        </>
      ) : null}
    />
  );
}

function Groups({ rows }: { rows: NonNullable<RedisClientsDiagnosis['list']>['bySource'] }) {
  return (
    <div className="rmd-table-wrap">
      <table className="mon-mini rmd-table">
        <thead>
          <tr><th>Nguồn</th><th className="r">Kết nối</th><th className="r">Rảnh ≥ 10 phút</th><th className="r">Mới &lt; 10s</th><th className="r">Pub/sub</th><th>Lệnh cuối hay gặp</th></tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.key}>
              <td><code>{g.key}</code></td>
              <td className="r">{fmtN(g.count)}</td>
              <td className="r">{fmtN(g.idle)}</td>
              <td className="r">{fmtN(g.young)}</td>
              <td className="r">{fmtN(g.pubsub)}</td>
              <td><code>{g.topCmd}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
