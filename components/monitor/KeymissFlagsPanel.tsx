'use client';

// Kiểm tra tay cờ key-miss (notify-keyspace-events "m") của một Redis — mở từ nút
// "🔎 Cờ key-miss" luôn hiện trong chi tiết Redis của Monitor. Đọc CONFIG GET + PUBSUB
// NUMSUB trên từng master (lib/redisKeymissGuard, chỉ đọc); nút "Tắt" chỉ chạy khi bấm:
// có dấu "đang bật" thì trả về đúng giá trị cũ, không thì chỉ bỏ cờ m.
// Cùng việc với KeymissFlagHost (quét 10 phút/lần) nhưng chạy ngay, cho một kết nối.

import { useCallback, useEffect, useState } from 'react';
import { redisKeymissCheck, redisKeymissRelease, type KeymissState, type ReleaseResult } from '@/lib/redis';

export default function KeymissFlagsPanel({ connectionId }: { connectionId: string }) {
  const [st, setSt] = useState<{ busy: boolean; data?: KeymissState; error?: string; done?: ReleaseResult[] }>({ busy: true });

  const check = useCallback((done?: ReleaseResult[]) => {
    setSt((s) => ({ ...s, busy: true, error: undefined }));
    redisKeymissCheck(connectionId)
      .then((data) => setSt({ busy: false, data, done }))
      .catch((e: Error) => setSt({ busy: false, error: e.message, done }));
  }, [connectionId]);
  useEffect(() => { check(); }, [check]);

  const release = (addr?: string) => {
    setSt((s) => ({ ...s, busy: true, error: undefined }));
    redisKeymissRelease(connectionId, addr)
      .then((done) => check(done))
      .catch((e: Error) => setSt((s) => ({ ...s, busy: false, error: e.message })));
  };

  const d = st.data;
  const on = d?.nodes.filter((n) => n.on) ?? [];
  return (
    <section className="pgd">
      <h4>
        Cờ key-miss
        <span className="pgd-head-acts">
          <button type="button" className="mon-btn" onClick={() => check()} disabled={st.busy}>
            {st.busy ? '⟳ Đang kiểm tra…' : '⟳ Kiểm tra lại'}
          </button>
        </span>
      </h4>
      <p className="mon-d-faint">
        Phân tích hit rate bật tạm cờ <code>m</code> của <code>notify-keyspace-events</code> rồi trả lại. Còn bật mà không ai cần thì
        mỗi lần miss Redis phát thêm một sự kiện trên luồng chính. App cũng tự kiểm tra 10 phút một lần và hỏi bạn — không bao giờ tự tắt.
      </p>
      {st.error ? <p className="pgd-error">{st.error}</p> : null}
      {st.done?.length ? (
        <ul className="mon-d-faint">
          {st.done.map((r) => <li key={r.addr}>{r.addr}: {r.ok ? <>đã đặt <code>&quot;{r.from}&quot;</code> → <code>&quot;{r.to}&quot;</code></> : <b className="pgd-error">{r.error}</b>}</li>)}
        </ul>
      ) : null}
      {d ? (
        <>
          <p>
            {on.length
              ? <b>Đang bật trên {on.length}/{d.nodes.length} node.</b>
              : <>Không node nào bật cờ key-miss ({d.nodes.length} node đã kiểm tra).</>}
            {d.runningHere ? ' Đang có phiên phân tích hit rate chạy trong app này — cờ bật là đúng, nó sẽ tự trả lại.' : null}
          </p>
          <table className="mon-mini rmd-table">
            <thead>
              <tr><th>Node</th><th>notify-keyspace-events</th><th className="r">Đang nghe</th><th>Ghi chú</th><th /></tr>
            </thead>
            <tbody>
              {d.nodes.map((n) => (
                <tr key={n.addr}>
                  <td><code>{n.addr}</code></td>
                  <td>{n.flags === null ? '?' : <code>&quot;{n.flags}&quot;</code>}{n.on ? <b> · bật</b> : null}</td>
                  <td className="r">{n.listeners ?? '?'}{n.patterns ? <span className="mon-d-faint"> (+{n.patterns} pattern)</span> : null}</td>
                  <td className="mon-d-faint">
                    {n.error ?? (n.pending
                      ? `Phân tích lúc ${new Date(n.pending.at).toLocaleString('vi-VN')} chưa trả lại — giá trị cũ "${n.pending.orig}"`
                      : n.on ? 'Không có dấu của app — có thể do người / công cụ khác bật' : '')}
                  </td>
                  <td>
                    {n.on ? (
                      <button type="button" className="mon-btn" disabled={st.busy || d.runningHere} onClick={() => release(n.addr)}
                        title={n.pending ? `Trả về "${n.pending.orig}"` : 'Bỏ cờ m, giữ các cờ khác'}>
                        Tắt
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {on.length > 1 ? (
            <button type="button" className="mon-btn" disabled={st.busy || d.runningHere} onClick={() => release()}>Tắt trên mọi node</button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
