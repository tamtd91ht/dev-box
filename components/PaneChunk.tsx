'use client';

// Tải chunk của một workspace (next/dynamic trong app/page.tsx) mà KHÔNG làm
// sập cả app khi chunk tải hụt.
//
// CA CÓ THẬT: đang mở app dưới `next dev`, sửa next.config.js → Next tự khởi
// động lại server. Trang trong cửa sổ vẫn là bản biên dịch CŨ, còn server mới
// chưa biên dịch trang / lần nào nên chưa có chunk nào cả → bấm một tab chưa
// ghé là GET /_next/static/chunks/…GitWorkspace_tsx.js trả 404 → ChunkLoadError
// ném thẳng lên, đỏ cả màn hình. Hồi các workspace còn import tĩnh thì không
// có lượt tải nào sau lúc mở trang nên không ai gặp.
//
// Cách gỡ, từ nhẹ tới nặng:
//   1. GET lại chính trang hiện tại — dưới `next dev` đó là thứ bắt server
//      biên dịch entry của trang, chunk xuất hiện trở lại — rồi thử import lại
//      (webpack xoá trạng thái chunk hỏng nên lần sau xin lại thật).
//   2. Vẫn hụt (bản production đã build lại, tên chunk đổi hẳn) → hiện khung
//      báo lỗi NGAY TRONG PANE với nút nạp lại trang. Không tự reload: các tab
//      khác có thể đang có việc dở (tài liệu chưa lưu, phiên Zalo…).

import { useState, type ComponentType } from 'react';
import { getUnloadBlockers } from '@/lib/unloadGuard';

function isChunkError(e: unknown): boolean {
  const err = e as { name?: string; message?: string } | null;
  return err?.name === 'ChunkLoadError' || /Loading (CSS )?chunk .* failed/i.test(err?.message ?? '');
}

/** GET trang hiện tại để `next dev` biên dịch lại entry (có chặn thời gian). */
async function warmPage(): Promise<void> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 90_000); // biên dịch nguội dưới webpack có lúc vài chục giây
  try {
    await fetch(window.location.pathname, { cache: 'no-store', signal: ctl.signal });
  } catch {
    /* server đang dựng lại — lượt thử sau sẽ biết */
  } finally {
    clearTimeout(t);
  }
}

/** Dùng trong loader của next/dynamic: `dynamic(() => loadPane(() => import('…')), …)`.
 *  Giữ `import()` nằm ngay trong loader để transform của Next vẫn nhận ra. */
export async function loadPane<P>(
  load: () => Promise<{ default: ComponentType<P> }>,
): Promise<{ default: ComponentType<P> }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await load();
    } catch (e) {
      if (!isChunkError(e)) throw e; // lỗi code thật — để nó hiện như mọi lỗi khác
      lastErr = e;
      await warmPage();
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  const msg = (lastErr as Error | undefined)?.message ?? 'ChunkLoadError';
  return { default: (() => <PaneChunkFailed message={msg} />) as ComponentType<P> };
}

function PaneChunkFailed({ message }: { message: string }) {
  const [note, setNote] = useState<string | null>(null);
  const reload = () => {
    const blockers = getUnloadBlockers();
    if (blockers.length > 0) {
      setNote(`Đang có ${blockers.join('; ')} — lưu hoặc đóng lại rồi hãy nạp lại.`);
      return;
    }
    window.location.reload();
  };
  return (
    <div className="panel" style={{ margin: 24 }}>
      <div className="empty-ico">🧩</div>
      <h3>Không tải được mã của tab này</h3>
      <p>
        Server vừa khởi động lại hoặc vừa build bản mới nên trang đang mở đã cũ. Nạp lại trang là xong — các tab khác
        cũng sẽ được nạp lại.
      </p>
      <p className="ws-muted" style={{ fontSize: 12 }}>{message}</p>
      <button onClick={reload}>🔄 Nạp lại trang</button>
      {note && <p style={{ color: 'var(--warn)', fontSize: 12 }}>{note}</p>}
    </div>
  );
}
