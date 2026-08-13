'use client';

// Nội dung cửa sổ rời: thanh tiêu đề mỏng + một khung xterm chiếm hết phần còn lại.
//
// Đóng cửa sổ KHÔNG giết phiên — đó là cả điểm của chế độ này. Muốn kết thúc
// hẳn thì bấm "Kết thúc phiên" (nút ⏻), hoặc đóng từ danh sách ở tab Terminal.
//
// Cửa sổ tự đóng khi phiên bị "đưa về tab" ở cửa sổ chính: nó poll cờ `detached`
// vài giây một lần. Poll chứ không phải socket vì đây là sự kiện cực hiếm và
// một POST 'list' thì rẻ — thêm hẳn một kênh realtime cho việc này là thừa.

import { useCallback, useEffect, useState } from 'react';
import XTermView from '@/components/terminal/XTermView';
import { tList, tKill, tDetach, type TermSessionInfo } from '@/lib/terminal';

const POLL_MS = 3000;

export default function TerminalWindow({ id }: { id: string }) {
  const [info, setInfo] = useState<TermSessionInfo | null>(null);
  const [dead, setDead] = useState(false);
  const [gone, setGone] = useState(false);

  const closeWindow = useCallback(() => {
    // Cửa sổ do main process mở (BrowserWindow) hoặc window.open — cả hai đều
    // đóng được bằng window.close(). Không đóng nổi (tab thường) thì thôi.
    try {
      window.close();
    } catch { /* ignore */ }
  }, []);

  const load = useCallback(async () => {
    try {
      const { sessions } = await tList();
      const s = sessions.find((x) => x.id === id);
      if (!s) {
        setGone(true);
        return;
      }
      setInfo(s);
      if (s.exited) setDead(true);
      // Cửa sổ chính đã "đưa về tab" → cửa sổ này rút lui.
      if (!s.detached) closeWindow();
    } catch { /* server đang restart — thử lại nhịp sau */ }
  }, [id, closeWindow]);

  useEffect(() => {
    void load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Tiêu đề cửa sổ theo tên phiên — nhiều cửa sổ terminal thì còn phân biệt được.
  useEffect(() => {
    document.title = info ? `${info.label} — VHS Terminal` : 'VHS Terminal';
  }, [info]);

  const endSession = async () => {
    await tKill(id).catch(() => {});
    closeWindow();
  };

  /** Trả phiên về tab chính: bỏ cờ detached rồi đóng cửa sổ. Phiên vẫn chạy. */
  const backToTab = async () => {
    await tDetach(id, false).catch(() => {});
    closeWindow();
  };

  if (gone) {
    return (
      <div className="tw-win tw-win-msg">
        <p>Phiên này không còn tồn tại.</p>
        <button onClick={closeWindow}>Đóng cửa sổ</button>
      </div>
    );
  }

  return (
    <div className="tw-win">
      <div className="tw-win-bar">
        <span className="tw-win-name">{info?.label ?? 'Terminal'}</span>
        {info && <span className="tw-win-cwd" title={info.cwd}>{info.cwd}</span>}
        {info?.pty === false && (
          <span className="tw-win-tag" title="node-pty không nạp được — TUI sẽ không vẽ đúng">pipes</span>
        )}
        {dead && <span className="tw-win-tag dead">đã kết thúc</span>}
        <span className="tw-gap" />
        <button className="tw-win-btn" onClick={() => void backToTab()} title="Đưa phiên về tab Terminal trong app">
          ⇤ Về tab
        </button>
        <button className="tw-win-btn danger" onClick={() => void endSession()} title="Kết thúc hẳn phiên này">
          ⏻ Kết thúc
        </button>
      </div>
      <div className="tw-win-body">
        <XTermView id={id} base="/api/term" active visible onDead={() => setDead(true)} />
      </div>
      <div className="tw-win-foot">
        Đóng cửa sổ này <b>không</b> làm mất phiên — mở lại từ tab Terminal bất cứ lúc nào.
      </div>
    </div>
  );
}
