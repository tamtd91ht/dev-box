'use client';

// Hộp thoại XÁC NHẬN trước khi chạy xuất Excel (Mongo / ES / PG).
//
// Vì sao cần: xuất là thao tác dài, quét toàn bộ tập khớp query. Trước đây bấm
// "Xuất" là chạy luôn, người dùng không biết mình sắp kéo về 30 dòng hay 3 triệu
// dòng cho tới khi nó đã chạy. Hộp thoại này ĐẾM TRƯỚC rồi mới hỏi.
//
// Đếm có thể thất bại (query nặng, timeout) — khi đó VẪN CHO XUẤT, chỉ nói là
// không đếm được. Chặn người dùng vì cái đếm hỏng thì tệ hơn là để họ tự quyết.

import { useEffect, useState } from 'react';
import { MAX_EXPORT_ROWS } from '@/lib/mongoReport';

export interface ConfirmExportModalProps {
  /** Đích xuất, hiện nguyên văn: "db.coll" / "index" / "db.schema.table". */
  target: string;
  /** Tóm tắt query đang xuất. */
  querySummary: string;
  /** Số cột đã khai. */
  columnCount: number;
  /** Mô tả sort đang áp — '' nghĩa là không sort. */
  sortSummary?: string;
  /** Đếm số dòng sẽ xuất. Trả null = không đếm được (vẫn cho chạy). */
  count: () => Promise<number | null>;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Ước lượng thô thời gian tải, chỉ để người dùng liệu chừng — KHÔNG phải cam kết. */
function estimate(rows: number): string {
  // ~200 dòng/trang, mỗi trang tầm 150-400ms tuỳ mạng và độ nặng document.
  const sec = Math.round((rows / 200) * 0.3);
  if (sec < 5) return 'vài giây';
  if (sec < 60) return `khoảng ${sec} giây`;
  const min = Math.round(sec / 60);
  return `khoảng ${min} phút`;
}

export default function ConfirmExportModal(props: ConfirmExportModalProps) {
  const { target, querySummary, columnCount, sortSummary, count, onCancel, onConfirm } = props;

  const [rows, setRows] = useState<number | null | undefined>(undefined); // undefined = đang đếm
  const [countErr, setCountErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const n = await count();
        if (alive) setRows(n);
      } catch (e) {
        if (!alive) return;
        setRows(null);
        setCountErr((e as Error).message);
      }
    })();
    return () => { alive = false; };
    // Chỉ đếm MỘT lần lúc mở — count() là closure mới mỗi render của cha.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counting = rows === undefined;
  const capped = typeof rows === 'number' && rows > MAX_EXPORT_ROWS;
  const willExport = typeof rows === 'number' ? Math.min(rows, MAX_EXPORT_ROWS) : null;
  const empty = rows === 0;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(520px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>⬇ Xác nhận xuất Excel</h3>
          <button className="ghost sm" onClick={onCancel}>✕</button>
        </div>

        <div className="export-confirm-count">
          {counting ? (
            <><span className="spinner" aria-hidden /> Đang đếm số dòng…</>
          ) : rows === null ? (
            <span className="export-confirm-unknown">Không đếm được số lượng</span>
          ) : (
            <>
              <b>{rows.toLocaleString('en-US')}</b> dòng
              {capped && <span className="export-confirm-cap">
                → chỉ xuất {MAX_EXPORT_ROWS.toLocaleString('en-US')}
              </span>}
            </>
          )}
        </div>

        <table className="export-confirm-tbl">
          <tbody>
            <tr><td>Nguồn</td><td className="mono">{target}</td></tr>
            <tr><td>Query</td><td className="mono">{querySummary || 'toàn bộ'}</td></tr>
            <tr><td>Sắp xếp</td><td className="mono">{sortSummary || '— không sắp xếp —'}</td></tr>
            <tr><td>Số cột</td><td>{columnCount}</td></tr>
            {typeof willExport === 'number' && willExport > 0 && (
              <tr><td>Ước tính</td><td>{estimate(willExport)}</td></tr>
            )}
          </tbody>
        </table>

        {capped && (
          <p className="export-confirm-warn">
            Tập kết quả lớn hơn trần {MAX_EXPORT_ROWS.toLocaleString('en-US')} dòng — file sẽ bị
            cắt. Thu hẹp query hoặc thêm điều kiện lọc nếu cần đủ dữ liệu.
          </p>
        )}
        {empty && <p className="export-confirm-warn">Không có dòng nào khớp — file xuất ra sẽ rỗng.</p>}
        {countErr && (
          <p className="export-confirm-warn">
            Đếm lỗi: {countErr}. Vẫn xuất được, nhưng không biết trước số lượng.
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="ghost sm" onClick={onCancel}>Huỷ</button>
          <button className="sm" onClick={onConfirm} disabled={counting}
            title={counting ? 'Đang đếm…' : 'Bắt đầu tải dữ liệu và dựng file'}>
            ⬇ Xuất .xlsx
          </button>
        </div>
      </div>
    </div>
  );
}
