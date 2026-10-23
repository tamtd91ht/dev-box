'use client';

// "Phân tích" RAM đã dùng của Redis (lib/redisMemDiagnose). Mức cơ bản chạy ngay khi
// mở (chỉ đọc INFO / MEMORY STATS / CONFIG GET); "Lấy mẫu key" (SCAN + MEMORY USAGE
// có giới hạn) chỉ chạy khi bấm — tốn hơn một chút nên để người dùng chủ động.
// Xu hướng tăng tính từ lịch sử Monitor truyền vào (`history`).

import { useCallback, useEffect, useRef, useState } from 'react';
import { redisDiagnoseMem, type RedisMemDiagnosis } from '@/lib/redis';
import { fmtBytes, fmtN } from '@/lib/diagnose';
import DiagnosisView from './DiagnosisView';
import RedisNoTtlKeys from './RedisNoTtlKeys';

/** Giải thích cơ chế — khớp với lib/redisMemDiagnose.ts + lib/redisMemRules.ts. */
const MECHANISM = (
  <>
    <p>
      <b>RAM đã dùng</b> = <code>used_memory</code> / <code>maxmemory</code> (không đặt maxmemory thì so với RAM máy). App trả lời bốn câu:
    </p>
    <ol className="pgd-info-steps">
      <li>
        <b>RAM nằm ở đâu:</b> <code>MEMORY STATS</code> + <code>INFO memory</code> tách thành dữ liệu, bộ đệm client (pub/sub chậm,
        MONITOR, reply lớn), bộ đệm replica, replication backlog, cache script Lua, bảng băm key. Bộ đệm client ≥ 64 MB và
        ≤ 1.000 client thì chạy <code>CLIENT LIST</code> để chỉ ra client nào.
      </li>
      <li>
        <b>Đầy thì sao:</b> <code>maxmemory-policy</code> + số key có TTL (<code>INFO keyspace</code>) — noeviction thì từ chối ghi,
        volatile-* mà ít key có TTL cũng vậy; số lệnh đã bị từ chối lấy từ <code>INFO errorstats</code>.
      </li>
      <li>
        <b>Đang diễn ra gì:</b> đọc <code>INFO stats</code> hai lần cách 3 giây → key bị evict / hết hạn mỗi giây; key hết hạn chưa dọn
        (<code>expired_stale_perc</code>); lưu đĩa bằng fork khi RAM đã gần nửa máy.
      </li>
      <li>
        <b>Tăng nhanh cỡ nào:</b> hồi quy tuyến tính trên lịch sử RAM của Monitor (tối đa 90 lần đo) → MB/giờ và còn bao lâu thì đầy.
      </li>
    </ol>
    <p>
      <b>Lấy mẫu key</b> (bấm mới chạy): <code>SCAN</code> tối đa 50.000 key (lượt 200, nghỉ giữa các lượt), đo <code>MEMORY USAGE … SAMPLES 5</code>{' '}
      + <code>TTL</code> trên tối đa 2.000 key rải đều, gom theo dạng key (<code>user:{'{n}'}:profile</code>) → dạng nào chiếm bao nhiêu % dữ
      liệu (ước lượng), bao nhiêu % không TTL, key lớn trong mẫu.
    </p>
    <p>
      <b>Liệt kê key không TTL</b> (bấm mới chạy, chọn N ≤ 10.000): <code>SCAN</code> lượt 200 + <code>TTL</code> pipeline theo trang đến khi
      đủ N key có TTL = -1 (trần 300.000 key quét / 30 giây), rồi <code>TYPE</code> + <code>MEMORY USAGE</code> cho đúng các key đó → bảng
      theo dạng key, sao chép / tải CSV.
    </p>
    <p className="mon-d-faint">
      <b>An toàn production:</b> mức cơ bản chỉ dùng lệnh O(1). Lấy mẫu: bỏ qua nếu CPU luồng chính ≥ 80%; đo theo lô 50 key, lô nào
      chậm bất thường thì dừng ngay; trần 20 giây; không đọc giá trị key, không đổi cấu hình. Mỗi node hạn 5 giây.{' '}
      <b>Không phân tích được:</b> dạng key chính xác trên TOÀN keyspace (chỉ ước lượng từ mẫu — muốn chính xác thì phân tích file RDB
      của replica ngoài giờ), key lớn ngoài mẫu (<code>redis-cli --memkeys</code> trên replica), lịch sử dài hơn cửa sổ của Monitor,
      ứng dụng nào ghi key (chỉ đoán qua prefix).
    </p>
  </>
);

interface Props {
  connectionId: string;
  history: { at: number; mb: number }[];
}

export default function RedisMemDiagnosis({ connectionId, history }: Props) {
  const [state, setState] = useState<{ busy: boolean; sampling?: boolean; data?: RedisMemDiagnosis; error?: string }>({ busy: true });
  // Đã lấy mẫu một lần thì "Phân tích lại" lấy mẫu tiếp — người dùng đã chọn mức đó.
  const [withSample, setWithSample] = useState(false);
  // history đổi mỗi vòng đo — không chạy lại vì thế, chỉ lấy bản mới nhất lúc bấm.
  const historyRef = useRef(history);
  historyRef.current = history;

  const run = useCallback((sample: boolean) => {
    setState((s) => ({ ...s, busy: true, sampling: sample, error: undefined }));
    redisDiagnoseMem(connectionId, { sample, history: historyRef.current })
      .then((data) => setState({ busy: false, data }))
      .catch((e: Error) => setState({ busy: false, error: e.message }));
  }, [connectionId]);
  useEffect(() => { run(false); }, [run]);

  const d = state.data;
  const sampleBtn = (
    <button
      type="button"
      className="mon-btn"
      disabled={state.busy}
      onClick={() => { setWithSample(true); run(true); }}
      title="SCAN tối đa 50.000 key + MEMORY USAGE trên tối đa 2.000 key, theo lô nhỏ có nghỉ; tự dừng nếu Redis chậm. Mất khoảng 10–25 giây."
    >
      🧪 {d?.sample ? 'Lấy mẫu lại' : 'Lấy mẫu key — dạng nào chiếm RAM'}
    </button>
  );

  return (
    <DiagnosisView
      title="Phân tích RAM"
      busy={state.busy}
      busyText={state.sampling
        ? 'Đang đọc INFO rồi lấy mẫu key (SCAN + MEMORY USAGE theo lô nhỏ, khoảng 10–25 giây)…'
        : 'Đang đọc INFO / MEMORY STATS / cấu hình (khoảng 3–5 giây, chỉ đọc)…'}
      error={state.error}
      data={d}
      onRerun={() => run(withSample)}
      info={MECHANISM}
      infoSummary="Tách RAM theo thành phần, chính sách khi đầy, evict / hết hạn, xu hướng tăng; lấy mẫu key khi bấm"
      nums={d ? (
        <>
          Đang dùng: <b>{fmtBytes(d.used)}</b>
          {d.limit ? <> / {fmtBytes(d.limit)} {d.limitKind === 'system' ? '(RAM máy)' : '(maxmemory)'} · <b>{d.usedPct}%</b></> : null}
          {d.growthMbPerHour !== null ? <> · Xu hướng: <b>{d.growthMbPerHour > 0 ? '+' : ''}{fmtN(d.growthMbPerHour)} MB/giờ</b></> : ' · Xu hướng: chưa đủ lịch sử'}
        </>
      ) : null}
      extra={d ? (
        <>
          <div className="pgd-sub">RAM nằm ở đâu</div>
          <table className="mon-mini rmd-table">
            <tbody>
              {d.breakdown.map((b) => (
                <tr key={b.label}>
                  <td>{b.label}</td>
                  <td className="r">{fmtBytes(b.bytes)}</td>
                  <td className="r mon-d-faint">{d.used ? Math.round((b.bytes / d.used) * 100) : 0}%</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="pgd-sub">Dạng key chiếm RAM</div>
          {d.patterns?.length ? (
            <div className="rmd-table-wrap">
              <table className="mon-mini rmd-table">
                <thead>
                  <tr><th>Dạng key</th><th className="r">% dữ liệu</th><th className="r">≈ RAM</th><th className="r">TB/key</th><th className="r">Không TTL</th></tr>
                </thead>
                <tbody>
                  {d.patterns.slice(0, 15).map((p) => (
                    <tr key={`${p.db}|${p.pattern}`} title={`Lớn nhất: ${p.maxKey} (${fmtBytes(p.maxBytes)})`}>
                      <td><code>{p.pattern}</code>{p.db ? <span className="mon-d-faint"> · db {p.db}</span> : null}</td>
                      <td className="r">{p.sharePct}%</td>
                      <td className="r">{fmtBytes(p.estBytes)}</td>
                      <td className="r">{fmtBytes(p.bytes / Math.max(1, p.count))}</td>
                      <td className="r">{p.noTtlPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className="mon-d-faint">
            {d.sample
              ? <>Ước lượng từ {fmtN(d.sample.measured)} key đo / {fmtN(d.sample.scanned)} key quét (keyspace {fmtN(d.sample.dbsize)}){d.sample.stopped ? ` · dừng sớm: ${d.sample.stopped}` : ''}. </>
              : d.sampleRefused ? <>Chưa lấy mẫu: {d.sampleRefused}. </> : <>INFO chỉ cho tổng số — muốn biết dạng key nào chiếm RAM thì lấy mẫu. </>}
            {sampleBtn}
          </p>

          <RedisNoTtlKeys connectionId={connectionId} />
        </>
      ) : null}
      foot={d ? (
        <>
          lúc {new Date(d.at).toLocaleTimeString('vi-VN')} · chỉ đọc{d.sample ? ' (kèm SCAN + MEMORY USAGE có giới hạn)' : ''}, không đổi gì trên server
          {d.skipped.length ? <> · bỏ qua: {d.skipped.map((s) => `${s.addr} (${s.error})`).join('; ')}</> : null}
        </>
      ) : null}
    />
  );
}
