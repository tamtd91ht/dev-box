'use client';

// "Truy vấn đang chạy lâu" — dùng chung cho ES (lib/esLongRunning) và Mongo
// (lib/mongoDiagnose.mongoLongRunning). Người dùng chọn N giây (mặc định 5, bắt buộc
// ≥ 1, nhớ theo từng loại hạ tầng); đọc MỘT lần khi mở và mỗi lần bấm "Liệt kê" —
// không tự đo lại theo chu kỳ. Bảng do server dựng sẵn (LongRunningResult).

import { useCallback, useEffect, useState } from 'react';
import {
  LONG_RUNNING_DEFAULT_SEC, LONG_RUNNING_MAX_SEC, LONG_RUNNING_MIN_SEC, fmtN,
  type LongRunningResult,
} from '@/lib/diagnose';
import { readLocal, writeLocal } from '@/lib/localKeys';

interface Props {
  /** Khoá nhớ N (vd 'es.longRunningSec'). */
  storeKey: string;
  title: string;
  /** Lệnh đọc nhẹ đang dùng — hiện ở dòng chú thích. */
  how: string;
  load: (minSec: number) => Promise<LongRunningResult>;
}

export default function LongRunningView({ storeKey, title, how, load }: Props) {
  // Chuỗi thô để người dùng gõ tự do; kiểm hợp lệ trước khi gửi.
  const [raw, setRaw] = useState(String(LONG_RUNNING_DEFAULT_SEC));
  const [state, setState] = useState<{ busy: boolean; data?: LongRunningResult; error?: string }>({ busy: false });
  const n = Number(raw);
  const invalid = raw.trim() === '' || !Number.isFinite(n)
    ? 'Nhập số giây'
    : n < LONG_RUNNING_MIN_SEC ? `N phải ≥ ${LONG_RUNNING_MIN_SEC} giây`
      : n > LONG_RUNNING_MAX_SEC ? `N tối đa ${fmtN(LONG_RUNNING_MAX_SEC)} giây` : null;

  const run = useCallback((sec: number) => {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    load(sec)
      .then((data) => setState({ busy: false, data }))
      .catch((e: Error) => setState({ busy: false, error: e.message }));
  }, [load]);

  // Lần đầu: lấy N đã nhớ (nếu hợp lệ) rồi đọc ngay.
  useEffect(() => {
    const saved = Number(readLocal(storeKey));
    const sec = Number.isFinite(saved) && saved >= LONG_RUNNING_MIN_SEC && saved <= LONG_RUNNING_MAX_SEC ? saved : LONG_RUNNING_DEFAULT_SEC;
    setRaw(String(sec));
    run(sec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => {
    if (invalid || state.busy) return;
    writeLocal(storeKey, String(n));
    run(n);
  };

  const d = state.data;
  return (
    <section className="pgd">
      <h4>{title}</h4>
      <div className="rmd-actions">
        <label className="rmd-dur" title={`Chỉ liệt kê thứ đã chạy / chờ từ N giây trở lên (${LONG_RUNNING_MIN_SEC}–${fmtN(LONG_RUNNING_MAX_SEC)})`}>
          Chạy lâu hơn
          <input
            type="number"
            className="rmd-n"
            min={LONG_RUNNING_MIN_SEC}
            max={LONG_RUNNING_MAX_SEC}
            step={1}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            aria-invalid={!!invalid}
          />
          giây
        </label>
        <button type="button" className="mon-btn" onClick={submit} disabled={!!invalid || state.busy}>
          {state.busy ? '⏳ Đang đọc…' : '📋 Liệt kê'}
        </button>
        {invalid ? <span className="pgd-error">{invalid}</span> : null}
      </div>
      <p className="mon-d-faint" style={{ marginTop: 6 }}>{how}</p>
      {state.error ? <p className="pgd-error">Không đọc được: {state.error}</p> : null}
      {d ? (
        <div className={state.busy ? 'pgd-stale' : ''}>
          {d.tables.map((t) => (
            <div key={t.title}>
              <div className="pgd-sub">{t.title}</div>
              {t.note ? <p className="mon-d-faint">{t.note}</p> : null}
              {t.rows.length ? (
                <div className="rmd-table-wrap rmd-scroll">
                  <table className="mon-mini rmd-table">
                    <thead><tr>{t.columns.map((c, i) => <th key={c} className={t.right?.includes(i) ? 'r' : ''}>{c}</th>)}</tr></thead>
                    <tbody>
                      {t.rows.map((r, j) => (
                        <tr key={j} className={r.tone === 'down' ? 'lv-down' : r.tone === 'warn' ? 'lv-warn' : ''}>
                          {r.cells.map((c, i) => (
                            <td key={i} className={t.right?.includes(i) ? 'r' : ''}>
                              {t.code?.includes(i) && c ? <code title={c}>{c.length > 160 ? `${c.slice(0, 160)}…` : c}</code> : c}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="mon-d-faint">Không có gì chạy từ {d.minSec} giây trở lên.</p>}
              {t.total > t.rows.length ? <p className="mon-d-faint">Hiện {fmtN(t.rows.length)} / {fmtN(t.total)} — lâu nhất trước.</p> : null}
            </div>
          ))}
          <p className="mon-d-faint pgd-foot">
            đọc lúc {new Date(d.at).toLocaleTimeString('vi-VN')} · ≥ {d.minSec}s · chỉ đọc, không huỷ / dừng gì
            {d.notes.length ? <> · {d.notes.join(' · ')}</> : null}
          </p>
        </div>
      ) : null}
    </section>
  );
}
