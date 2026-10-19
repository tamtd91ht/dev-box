'use client';

// CÀI ĐẶT TẢI FILE — một khối trong bảng ⚙ trên thanh tiêu đề.
//
// Bấm link download trong webview (Zalo, Telegram, Links, Browser…) thì mặc
// định app HỎI nơi lưu như Chrome. Khối này để đổi giữa "hỏi mỗi lần" và "tự
// lưu", và chỉ định thư mục mặc định.
//
// CHỈ CÓ Ý NGHĨA TRÊN DESKTOP: luật tải file nằm ở Electron main process
// (wireDownloadPolicy trong electron/main.cjs). Chạy trên web thường thì cầu
// window.downloadPrefs không tồn tại → không render gì.

import { useCallback, useEffect, useState } from 'react';

type Mode = 'ask' | 'auto';

interface Prefs {
  ok: boolean;
  mode: Mode;
  /** Thư mục người dùng đã chỉ định; '' = để app tự quyết. */
  dir: string;
  /** Thư mục THỰC TẾ sẽ dùng khi `dir` rỗng (chỗ lưu lần trước / Downloads). */
  effectiveDir: string;
  defaultDir: string;
}

type SetRes = { ok: boolean; mode?: Mode; dir?: string; effectiveDir?: string; error?: string };

declare global {
  interface Window {
    downloadPrefs?: {
      get(): Promise<Prefs>;
      set(payload: { mode?: Mode; dir?: string }): Promise<SetRes>;
      pickDir(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      openDir(): Promise<{ ok: boolean; path?: string; error?: string }>;
    };
  }
}

export default function DownloadPrefs() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const api = window.downloadPrefs;
    if (!api) return;
    try {
      const r = await api.get();
      if (r?.ok) setPrefs(r);
    } catch {
      /* cầu chết — coi như không có mục này */
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /** Gửi một thay đổi rồi đồng bộ lại state từ giá trị main process trả về. */
  const save = useCallback(async (payload: { mode?: Mode; dir?: string }) => {
    const api = window.downloadPrefs;
    if (!api) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.set(payload);
      if (!r.ok) { setErr(r.error || 'không lưu được'); return; }
      setPrefs((p) => (p ? {
        ...p,
        mode: r.mode ?? p.mode,
        dir: r.dir ?? p.dir,
        effectiveDir: r.effectiveDir ?? p.effectiveDir,
      } : p));
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  }, []);

  const pick = useCallback(async () => {
    const api = window.downloadPrefs;
    if (!api) return;
    const r = await api.pickDir();
    if (r.ok && r.path) await save({ dir: r.path });
    else if (r.error) setErr(r.error);
  }, [save]);

  // Không phải desktop (hoặc bản desktop cũ chưa có cầu) → ẩn hẳn.
  if (!prefs) return null;

  const asking = prefs.mode === 'ask';

  return (
    <>
      <div className="tvis-group">Tải file về</div>

      <div className="dlp-modes">
        <label className={`dlp-mode${asking ? ' is-on' : ''}`}>
          <input
            type="radio"
            name="dlp-mode"
            checked={asking}
            disabled={busy}
            onChange={() => void save({ mode: 'ask' })}
          />
          <span className="dlp-mode-text">
            <b>Hỏi nơi lưu mỗi lần</b>
            <span>Mở hộp thoại chọn thư mục như Chrome — đổi được cả tên file.</span>
          </span>
        </label>

        <label className={`dlp-mode${!asking ? ' is-on' : ''}`}>
          <input
            type="radio"
            name="dlp-mode"
            checked={!asking}
            disabled={busy}
            onChange={() => void save({ mode: 'auto' })}
          />
          <span className="dlp-mode-text">
            <b>Tự lưu, không hỏi</b>
            <span>Lưu thẳng vào thư mục bên dưới; trùng tên thì đánh số.</span>
          </span>
        </label>
      </div>

      <div className="dlp-dir">
        <span className="dlp-dir-label">
          {asking ? 'Thư mục hộp thoại mở sẵn' : 'Thư mục lưu'}
        </span>
        <code className="dlp-dir-path" title={prefs.dir || prefs.effectiveDir}>
          {prefs.dir || prefs.effectiveDir}
        </code>
        <div className="dlp-dir-acts">
          <button className="ghost sm" disabled={busy} onClick={() => void pick()}>Chọn…</button>
          <button
            className="ghost sm"
            disabled={busy}
            onClick={() => void window.downloadPrefs?.openDir()}
            title="Mở thư mục này trong Explorer"
          >Mở</button>
          {prefs.dir && (
            <button
              className="ghost sm"
              disabled={busy}
              onClick={() => void save({ dir: '' })}
              title={`Quay về Downloads của máy (${prefs.defaultDir})`}
            >Bỏ ghim</button>
          )}
        </div>
      </div>

      {!prefs.dir && (
        <div className="dlp-hint">
          Chưa ghim thư mục nào — app dùng chỗ bạn lưu gần nhất, mặc định là
          Downloads của máy.
        </div>
      )}

      {err && <div className="dlp-err">{err}</div>}
    </>
  );
}
