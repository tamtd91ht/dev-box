'use client';

// Nút chọn chế độ server ở footer: Production / Dev (webpack) / Dev Turbopack.
//
// Chế độ được LƯU ở main process (data/browser/server-mode.json) chứ không phải
// localStorage: người quyết định dựng server là main, và nó quyết định TRƯỚC
// khi có renderer nào. Shortcut desktop chạy thẳng electron.exe — không qua
// npm script — nên đây là chỗ duy nhất để app "nhớ" chế độ cho lần mở sau.
//
// Chọn xong chỉ ghi file; áp dụng cần khởi động lại (giết server cũ, dựng cái
// mới), nên hỏi "khởi động lại ngay" thay vì tự làm — có thể đang có việc dở.
// Dùng lại bộ style .hrl-* của HardReloadButton đứng cạnh.

import { useCallback, useEffect, useState } from 'react';
import { getUnloadBlockers } from '@/lib/unloadGuard';
import type { ServerMode, ServerModeInfo } from './UpdateButton';

const MODES: { mode: ServerMode; icon: string; label: string; sub: string }[] = [
  {
    mode: 'prod',
    icon: '🚀',
    label: 'Production',
    sub: 'next build (khi code đổi, vài phút) + next start. Nhẹ RAM, mở nhanh. Sửa code phải build lại.',
  },
  {
    mode: 'dev',
    icon: '🐢',
    label: 'Dev (webpack)',
    sub: 'Hot reload. Biên dịch lần đầu chậm (~20s trang chính, mỗi API thêm vài giây), RAM ~3GB.',
  },
  {
    mode: 'turbo',
    icon: '⚡',
    label: 'Dev Turbopack',
    sub: 'Hot reload, biên dịch nhanh hơn webpack nhiều lần. Lỗi lạ thì quay về Dev (webpack).',
  },
];

const SHORT: Record<string, string> = { prod: '🚀 Prod', dev: '🐢 Dev', turbo: '⚡ Turbo', external: '🔗 Ngoài' };

export default function ServerModeButton() {
  const [info, setInfo] = useState<ServerModeInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.desktopUpdate?.getServerMode?.().then(setInfo).catch(() => {});
  }, []);

  const pick = useCallback(async (mode: ServerMode) => {
    const bridge = window.desktopUpdate;
    if (!bridge?.setServerMode) return;
    const r = await bridge.setServerMode(mode).catch((e: Error) => ({ ok: false, error: e.message } as const));
    if ('saved' in r) setInfo(r);
    setNote(r.ok ? null : r.error || 'Không lưu được chế độ.');
  }, []);

  const relaunch = useCallback(async () => {
    // Giống HardReloadButton: còn tài liệu chưa lưu thì beforeunload chặn
    // app.quit() IM LẶNG — dừng trước, nói rõ lý do.
    const blockers = getUnloadBlockers();
    if (blockers.length > 0) {
      setNote(`Đang có ${blockers.join('; ')} — lưu hoặc đóng lại rồi hãy khởi động lại.`);
      return;
    }
    setOpen(false);
    setBusy(true);
    const r = await window.desktopUpdate?.relaunch().catch((e: Error) => ({ ok: false, error: e.message }));
    if (r && !r.ok) {
      setNote(r.error || 'Không khởi động lại được.');
      setBusy(false);
      return;
    }
    // relaunch() thành công thì tiến trình đã chết, không tới được đây.
    window.setTimeout(() => {
      setNote('App không tự thoát được (có thứ chặn unload) — hãy đóng và mở lại app thủ công.');
      setBusy(false);
    }, 3000);
  }, []);

  // Trình duyệt thường / shell desktop cũ: không có gì để chọn.
  if (!info) return null;

  const pending = info.running !== 'external' && info.running !== info.wanted;
  const label = SHORT[info.running] ?? '❔ Server';
  // Build prod hỏng → main lặng lẽ chạy next dev (mỗi tab biên dịch nguội lúc
  // bấm lần đầu). Đã có lần lỗi CSS làm build hỏng cả tuần mà chỉ thấy "app chậm".
  const buildFailed = !!info.buildFailedAt && info.running !== 'prod';

  return (
    <span className="hrl-wrap">
      <button
        className={`ghost sm${busy ? ' busy' : ''}`}
        style={buildFailed ? { color: 'var(--err)' } : undefined}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        title={
          buildFailed
            ? 'next build production THẤT BẠI lúc mở app → đang tạm chạy next dev (chậm, mỗi tab biên dịch lúc bấm lần đầu). Mở ⌨ Console xem dòng BuildFailed để biết lỗi.'
            : pending
            ? `Server đang chạy ${info.running || 'chưa rõ chế độ'} — lần khởi động sau sẽ chạy ${info.wanted}`
            : 'Chế độ chạy server Next — nhớ cho các lần mở app sau'
        }
      >
        {busy ? '⏳ Đang khởi động lại…' : buildFailed ? `⚠ build lỗi · ${label}` : pending ? `${label} → ${SHORT[info.wanted]}` : label}
      </button>

      {open && !busy && (
        <>
          <div className="hrl-back" onClick={() => setOpen(false)} />
          <div className="hrl-pop srvm-pop">
            {MODES.map((m) => (
              <button
                key={m.mode}
                className={info.saved === m.mode ? 'on' : ''}
                onClick={() => void pick(m.mode)}
              >
                {info.saved === m.mode ? '✓ ' : ''}{m.icon} {m.label}
                {info.running === m.mode && <span className="srvm-tag">đang chạy</span>}
                <span className="hrl-sub">{m.sub}</span>
              </button>
            ))}
            {info.envForced && (
              <span className="srvm-hint">
                Đang bị biến môi trường ép chạy <b>{info.envForced}</b> (DESKTOP_DEV/DESKTOP_TURBO) — lựa chọn ở đây
                chỉ có tác dụng khi mở app bằng shortcut / <code>npm run desktop</code>.
              </span>
            )}
            {info.running === 'external' && (
              <span className="srvm-hint">
                App đang dùng server chạy sẵn ngoài DevBox (vd <code>npm run dev</code> tự mở) — tắt nó đi thì lựa chọn
                ở đây mới có tác dụng.
              </span>
            )}
            {pending && (
              <>
                <div className="hrl-sep" />
                <button onClick={() => void relaunch()}>
                  🔄 Khởi động lại ngay
                  <span className="hrl-sub">
                    Giết server hiện tại (kể cả phiên terminal) rồi mở lại app ở chế độ {info.wanted}
                    {info.wanted === 'prod' ? ' — lần đầu sẽ next build, mất vài phút.' : '.'}
                  </span>
                </button>
              </>
            )}
          </div>
        </>
      )}

      {note && <span className="hrl-note" title={note}>{note}</span>}
    </span>
  );
}
