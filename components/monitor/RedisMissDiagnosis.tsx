'use client';

// "Phân tích" hit rate thấp của Redis (lib/redisDiagnose): dạng key nào đang
// miss và vì sao. Khác PostgreSQL ở chỗ phải BẬT TẠM notify-keyspace-events
// trên server trong vài giây — nên hỏi xác nhận trước (kèm chọn thời gian bắt),
// nói rõ sẽ đổi gì và trả lại thế nào. "Phân tích lại" quay về đúng khung đó để
// chọn lại thời gian. Nút "ⓘ Cơ chế" giải thích từng bước app tìm ra key miss.
// Kết quả hiển thị qua DiagnosisView + bảng dạng key.

import { useCallback, useState } from 'react';
import { redisDiagnoseMisses, type RedisMissDiagnosis } from '@/lib/redis';
import { fmtN } from '@/lib/diagnose';
import DiagnosisView from './DiagnosisView';

const DURATIONS = [10, 30, 60];

/** Giải thích cơ chế — khớp với lib/redisDiagnose.ts + lib/redisDiagnoseRules.ts. */
const MECHANISM = (
  <>
    <p>
      <b>Vì sao cần cơ chế riêng:</b> Redis chỉ đếm <em>tổng</em> số lần trượt (<code>keyspace_misses</code> trong{' '}
      <code>INFO stats</code>), không ghi lại <em>key nào</em> trượt. Muốn biết dạng key nào đang miss, app phải nghe
      Redis báo từng lần miss trong một khoảng ngắn.
    </p>
    <ol className="pgd-info-steps">
      <li>
        <b>Đo trước (1 giây):</b> đọc <code>INFO</code> hai lần để có tốc độ miss và CPU luồng chính, <code>PING</code> đo độ trễ mạng.
        Bước 2 làm Redis publish thêm một message cho mỗi lần miss trên luồng chính, nên app giữ trung bình ≤ 2.000 sự kiện/giây:
        dưới mức đó bật liên tục; <b>giờ cao điểm thì bắt theo lát</b> — bật cờ vài chục ms đủ ~1.000 mẫu, tắt ngay, nghỉ rồi
        lặp lại (tốc độ đo lại sau mỗi lát). Chỉ <b>không bật gì</b> khi CPU luồng chính ≥ 90%, hoặc mạng chậm tới mức một lát
        ngắn nhất đã quá 10.000 sự kiện.
      </li>
      <li>
        <b>Bật tạm sự kiện key-miss:</b> trên từng node master, đọc giá trị cũ của <code>notify-keyspace-events</code> rồi thêm cờ{' '}
        <code>E</code> (kênh keyevent) và <code>m</code> (key-miss, có từ Redis 6.0). Chỉ thêm loại sự kiện miss, không bật các loại khác.
      </li>
      <li>
        <b>Nghe:</b> một kết nối riêng <code>PSUBSCRIBE __keyevent@*__:keymiss</code>. Mỗi khi một lệnh <b>đọc</b> không tìm thấy
        key, Redis gửi đúng tên key đó (kênh cho biết db). App chỉ nhận tên key, không đọc giá trị.
      </li>
      <li>
        <b>Dừng và trả lại:</b> hết thời gian bắt bạn chọn, hoặc đủ 20.000 mẫu thì dừng sớm — huỷ nghe, đặt lại{' '}
        <code>notify-keyspace-events</code> về giá trị cũ (trong <code>finally</code>, kể cả khi lỗi). Không trả lại được thì kết quả
        có mục đỏ kèm lệnh để chạy tay.
      </li>
      <li>
        <b>Gom thành dạng key:</b> tách tên key theo <code>: / | #</code>, thay phần biến thiên bằng ký hiệu — số → <code>{'{n}'}</code>,
        UUID → <code>{'{uuid}'}</code>, email, hex/ObjectId, ngày, token dài. Ví dụ <code>user:12345:profile</code> →{' '}
        <code>user:{'{n}'}:profile</code>.
      </li>
      <li>
        <b>Kiểm lại 10 dạng nặng nhất:</b> <code>EXISTS</code> lại vài key vừa miss (giờ đã có = được nạp lại sau miss);{' '}
        <code>SCAN</code> tối đa 100.000 key (lượt 500, nghỉ giữa các lượt, không bao giờ <code>KEYS</code>) để đếm key cùng dạng đang có
        và lấy mẫu <code>TTL</code>; <code>INFO</code> trước/sau để có hit rate hiện tại và số key bị evict.
      </li>
      <li>
        <b>Phán đoán từng dạng:</b> không có key nào cùng dạng và không ai nạp lại → <em>không bao giờ được ghi</em>; cùng một key
        miss nhiều lần → <em>miss lặp lại, không ai nạp lại</em>; key có thật nhưng TTL trung vị &lt; 5 phút → <em>TTL quá ngắn</em>;
        mỗi key chỉ miss một lần rồi được nạp lại → <em>dữ liệu dài đuôi</em> (miss là tự nhiên); còn lại → <em>hết hạn, nạp lại chậm</em>.
      </li>
    </ol>
    <p className="mon-d-faint">
      <b>Lệnh nào sinh miss:</b> chỉ lệnh <em>đọc</em> tra key — <code>GET</code>, <code>MGET</code>, <code>HGET</code>, <code>HGETALL</code>,{' '}
      <code>LRANGE</code>, <code>SMEMBERS</code>, <code>ZRANGE</code>, <code>EXISTS</code>, <code>TYPE</code>, <code>TTL</code>… (kể cả trong Lua).
      Lệnh <em>ghi</em> — <code>SET</code>, <code>INCR</code>, <code>HSET</code>, <code>LPUSH</code>, <code>DEL</code>, <code>EXPIRE</code>… — không bao giờ
      tính là miss. Vì vậy kiểm tra lock / rate-limit / idempotency bằng <code>GET</code>/<code>EXISTS</code> cũng kéo hit rate xuống dù hệ thống đúng.
    </p>
  </>
);

export default function RedisMissDiagnosis({ connectionId }: { connectionId: string }) {
  const [state, setState] = useState<{ busy: boolean; data?: RedisMissDiagnosis; error?: string }>({ busy: false });
  const [seconds, setSeconds] = useState(10);
  // Khung xác nhận (chọn thời gian bắt) đang mở — lần đầu, hoặc sau khi bấm "Phân tích lại".
  const [asking, setAsking] = useState(true);

  const run = useCallback(() => {
    setAsking(false);
    setState((s) => ({ ...s, busy: true, error: undefined }));
    redisDiagnoseMisses(connectionId, seconds)
      .then((data) => setState({ busy: false, data }))
      .catch((e: Error) => setState({ busy: false, error: e.message }));
  }, [connectionId, seconds]);

  const d = state.data;
  return (
    <DiagnosisView
      title="Phân tích hit rate"
      busy={state.busy}
      busyText={`Đang bắt key bị miss trong ${seconds} giây, rồi quét keyspace có giới hạn…`}
      error={state.error}
      data={d}
      // Phân tích lại = mở lại khung xác nhận để chọn lại thời gian bắt (không chạy ngay).
      onRerun={() => setAsking(true)}
      showStart={asking}
      info={MECHANISM}
      infoSummary="Bật tạm sự kiện key-miss của Redis, nghe tên key bị miss vài giây, gom theo dạng rồi trả lại cấu hình"
      start={(
        <div className="rmd-confirm">
          <p>
            Để biết <b>dạng key nào</b> đang miss, app sẽ <b>bật tạm</b> cờ <code>Em</code> của{' '}
            <code>notify-keyspace-events</code> trên server trong thời gian bắt, nghe sự kiện{' '}
            <code>keymiss</code>, rồi <b>trả lại giá trị cũ</b> ngay khi xong (kể cả khi lỗi).{' '}
            <span className="mon-d-faint">Chi tiết từng bước: nút ⓘ Cơ chế.</span>
          </p>
          <p className="mon-d-faint">
            Chỉ đọc TÊN key bị miss, không đọc giá trị. Bảo vệ production: đo tốc độ miss + CPU trước — trên 2.000 miss/giây
            (giờ cao điểm) thì bắt theo lát ngắn để tải thêm trung bình không vượt mức đó; CPU luồng chính ≥ 90% thì KHÔNG bật;
            đủ 20.000 mẫu là dừng sớm và trả lại cấu hình ngay. Sau đó quét SCAN tối đa 100.000 key
            (lượt nhỏ, nghỉ giữa các lượt, không dùng KEYS) để đếm key cùng dạng và lấy mẫu TTL. Cần Redis ≥ 6.0.
          </p>
          <div className="rmd-actions">
            <label className="rmd-dur">
              Thời gian bắt
              <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
                {DURATIONS.map((s) => <option key={s} value={s}>{s} giây</option>)}
              </select>
            </label>
            <button type="button" className="mon-btn primary" onClick={run}>
              🔍 {d ? 'Phân tích lại' : 'Bắt đầu phân tích'}
            </button>
            {d ? <button type="button" className="mon-btn" onClick={() => setAsking(false)}>Huỷ</button> : null}
          </div>
        </div>
      )}
      nums={d ? (
        <>
          Hiện tại: <b>{d.currentPct === null ? 'chưa đo được' : `${d.currentPct}%`}</b>
          {d.windowSec ? ` (trong ${d.windowSec}s)` : ''} · Cộng dồn: <b>{d.cumulativePct ?? '?'}%</b>
          {' '}· Bắt được <b>{fmtN(d.captured)}</b> miss{d.captured >= 20_000 ? ' (đủ mẫu, dừng sớm)' : ''}
        </>
      ) : null}
      extra={d && d.patterns.length ? (
        <>
          <div className="pgd-sub">Dạng key bị miss</div>
          <div className="rmd-table-wrap">
            <table className="mon-mini rmd-table">
              <thead>
                <tr><th>Dạng key</th><th className="r">Miss</th><th className="r">Key</th><th className="r">Đang có</th><th>Phán đoán</th></tr>
              </thead>
              <tbody>
                {d.patterns.map((p) => (
                  <tr key={`${p.db}|${p.pattern}`} title={`Ví dụ: ${p.samples.join('\n')}`}>
                    <td><code>{p.pattern}</code>{p.db ? <span className="mon-d-faint"> · db {p.db}</span> : null}</td>
                    <td className="r">{fmtN(p.misses)} <span className="mon-d-faint">({p.sharePct}%)</span></td>
                    <td className="r">{fmtN(p.distinct)}</td>
                    <td className="r">{p.existing === null ? '?' : fmtN(p.existing)}</td>
                    <td>{p.verdict}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      foot={d ? (
        <>
          lúc {new Date(d.at).toLocaleTimeString('vi-VN')} ·{' '}
          {d.findings.some((f) => f.id === 'restore')
            ? <b className="pgd-error">CHƯA trả lại được notify-keyspace-events — xem mục đỏ</b>
            : 'đã trả lại notify-keyspace-events như cũ.'}
        </>
      ) : null}
    />
  );
}
