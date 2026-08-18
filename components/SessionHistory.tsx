'use client';

// "⏱ Phiên gần đây" — danh sách phiên làm việc cũ, dùng chung cho 5 tab hạ tầng
// (Redis · Mongo · ES · Kafka · Rabbit). Xem lib/sessionHistory để biết vì sao
// chỉ lưu Ý ĐỊNH chứ không lưu KẾT QUẢ.
//
// Bấm một dòng = ĐIỀN LẠI form (view + db/index/topic + query), KHÔNG tự chạy.
// Người dùng nhìn thấy mình sắp chạy gì rồi mới bấm Run — quan trọng khi đầu
// bên kia là cụm production.
//
// Chỉ hiện phiên của CONNECTION đang chọn: phiên của cụm khác lẫn vào đây thì
// bấm nhầm sẽ query sai cụm.

import { useCallback, useEffect, useState } from 'react';
import {
  loadSessions, removeSession, clearSessionsFor, fmtSessionTime,
  type SessionScope, type WorkSession,
} from '@/lib/sessionHistory';

export default function SessionHistory({ scope, connectionId, onRestore, reloadKey }: {
  scope: SessionScope;
  /** Connection đang chọn — lọc danh sách. Rỗng = chưa chọn, không hiện gì. */
  connectionId: string;
  /** Điền lại state của phiên vào form (KHÔNG chạy). */
  onRestore: (state: Record<string, unknown>) => void;
  /**
   * Đổi giá trị này để buộc đọc lại localStorage — tab tăng nó lên mỗi lần vừa
   * ghi một phiên mới, nhờ vậy danh sách cập nhật ngay mà không cần chia sẻ
   * state giữa hai component.
   */
  reloadKey?: number;
}) {
  const [list, setList] = useState<WorkSession[]>([]);
  /** Mặc định thu gọn — danh sách là thứ tra khi cần, không phải thứ chiếm chỗ. */
  const [open, setOpen] = useState(false);

  useEffect(() => { setList(loadSessions(scope)); }, [scope, reloadKey]);

  const mine = list.filter((s) => s.connectionId === connectionId);

  const drop = useCallback((e: React.MouseEvent, id: string) => {
    // Nút 🗑 nằm trong dòng bấm-để-khôi-phục — chặn nổi bọt kẻo xoá xong lại
    // khôi phục luôn chính phiên vừa xoá.
    e.stopPropagation();
    setList(removeSession(scope, id));
  }, [scope]);

  const clearAll = useCallback(() => {
    if (!window.confirm(`Xóa toàn bộ ${mine.length} phiên gần đây của kết nối này?`)) return;
    // Chỉ bỏ phiên của connection đang chọn — danh sách này đã lọc theo nó, xoá
    // lan sang cụm khác là phá dữ liệu người dùng không nhìn thấy.
    setList(clearSessionsFor(scope, connectionId));
  }, [scope, connectionId, mine.length]);

  if (!connectionId || mine.length === 0) return null;

  return (
    <div className="sess-hist">
      <button className="sess-hist-head" onClick={() => setOpen((v) => !v)}
        title={open ? 'Thu gọn' : 'Mở danh sách phiên đã làm gần đây'}>
        <span className="sess-hist-caret" aria-hidden>{open ? '▾' : '▸'}</span>
        ⏱ Phiên gần đây <span className="sess-hist-n">{mine.length}</span>
      </button>
      {open && (
        <>
          <div className="sess-hist-list">
            {mine.map((s) => (
              <div key={s.id} className="sess-item">
                <button className="sess-item-open" onClick={() => onRestore(s.state)}
                  title="Điền lại phiên này vào form (không tự chạy)">
                  <span className="sess-item-label">{s.label}</span>
                  <span className="sess-item-time">{fmtSessionTime(s.at)}</span>
                </button>
                <button className="ghost sm sess-item-x" onClick={(e) => drop(e, s.id)} title="Xóa phiên này">🗑</button>
              </div>
            ))}
          </div>
          <button className="ghost sm sess-hist-clear" onClick={clearAll}>✕ Xóa hết</button>
        </>
      )}
    </div>
  );
}
