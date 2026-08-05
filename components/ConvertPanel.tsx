'use client';

// Bảng CHUYỂN ĐỔI FILE (tab Tools) — chọn file nguồn → chọn định dạng đích →
// Chuyển. Job chạy NGẦM trên server; bảng này chỉ hiện tiến trình, còn thông
// báo lúc xong (kèm đường dẫn) do ConvertHost bắn ra toast + hòm thư.
//
// Ba tùy chọn, đều OPTIONAL:
//   · Nơi lưu — bỏ trống = cùng thư mục file nguồn.
//   · Template mẫu — chọn thì BẮT BUỘC dùng AI (chỉ AI mới đọc được bố cục mẫu
//     rồi trình bày lại), nên có bước xác nhận trước khi bật.
//   · Dùng AI — khi không có template: tắt = thư viện sẵn có, bật = gọi AI.

import { useCallback, useEffect, useState } from 'react';
import FolderPicker from './FolderPicker';
import {
  cMatrix, cStart, cList, cClear, canRenderPdf,
  CONVERT_SOURCE_EXTS, TARGET_LABEL, ALL_TARGETS,
  type TargetFormat, type ConvertJobView,
} from '@/lib/convert';

const STATUS_META: Record<ConvertJobView['status'], { icon: string; cls: string }> = {
  running: { icon: '⏳', cls: 'run' },
  'need-render': { icon: '🖨', cls: 'run' },
  done: { icon: '✅', cls: 'ok' },
  error: { icon: '⚠', cls: 'err' },
};

const extOf = (p: string) => {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i).toLowerCase();
};
const baseOf = (p: string) => p.split(/[\\/]/).pop() || p;

export default function ConvertPanel() {
  const [src, setSrc] = useState<string | null>(null);
  const [target, setTarget] = useState<TargetFormat>('pdf');
  const [outDir, setOutDir] = useState<string | null>(null);
  const [template, setTemplate] = useState<string | null>(null);
  const [useAi, setUseAi] = useState(false);
  const [matrix, setMatrix] = useState<Record<string, TargetFormat[]>>({});
  const [jobs, setJobs] = useState<ConvertJobView[]>([]);
  const [picking, setPicking] = useState<null | 'src' | 'dir' | 'tpl'>(null);
  /** Hỏi xác nhận trước khi bật AI cho template mẫu. */
  const [confirmTpl, setConfirmTpl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { cMatrix().then((r) => setMatrix(r.matrix)).catch(() => {}); }, []);

  const reload = useCallback(() => { cList().then(setJobs).catch(() => {}); }, []);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [reload]);

  const srcExt = src ? extOf(src) : '';
  const libTargets = matrix[srcExt] ?? [];
  const libOk = libTargets.includes(target);
  // Template luôn kéo theo AI; ngoài ra người dùng tự bật; và khi thư viện
  // không làm được cặp này thì AI là đường duy nhất.
  const aiForced = template !== null || (src !== null && !libOk);
  const willUseAi = aiForced || useAi;
  const pdfBlocked = target === 'pdf' && !willUseAi && !canRenderPdf();

  const start = async () => {
    if (!src) return;
    setBusy(true); setErr(null);
    try {
      await cStart({
        srcPath: src,
        target,
        ...(outDir ? { outDir } : {}),
        ...(willUseAi ? { useAi: true } : {}),
        ...(template ? { templatePath: template } : {}),
      });
      reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="cv-panel">
      <div className="group-title">🔄 Chuyển đổi file</div>

      {/* ── Nguồn + đích ── */}
      <div className="cv-row">
        <button className="ghost sm" onClick={() => setPicking('src')}>📄 Chọn file nguồn…</button>
        <span className="cv-path" title={src ?? undefined}>{src ? baseOf(src) : <i>chưa chọn</i>}</span>
      </div>

      <div className="cv-row">
        <span className="cv-lbl">Chuyển thành</span>
        <select className="input" value={target} onChange={(e) => setTarget(e.target.value as TargetFormat)} style={{ width: 170 }}>
          {ALL_TARGETS.map((t) => (
            <option key={t} value={t}>
              {TARGET_LABEL[t]}{src && !libTargets.includes(t) ? ' — cần AI' : ''}
            </option>
          ))}
        </select>
        <button className="sm" disabled={!src || busy || pdfBlocked} onClick={() => void start()}>
          {busy ? <span className="spinner" aria-hidden /> : '▶'} Chuyển
        </button>
      </div>

      {/* ── Nơi lưu (optional) ── */}
      <div className="cv-row">
        <button className="ghost sm" onClick={() => setPicking('dir')}>📁 Nơi lưu…</button>
        <span className="cv-path" title={outDir ?? undefined}>
          {outDir ?? <i>mặc định — cùng thư mục file nguồn</i>}
        </span>
        {outDir && <button className="ghost sm" onClick={() => setOutDir(null)} title="Bỏ chọn">✕</button>}
      </div>

      {/* ── Template mẫu (optional, kéo theo AI) ── */}
      <div className="cv-row">
        <button className="ghost sm" onClick={() => setPicking('tpl')}>🧩 Template mẫu…</button>
        <span className="cv-path" title={template ?? undefined}>
          {template ? baseOf(template) : <i>không dùng</i>}
        </span>
        {template && <button className="ghost sm" onClick={() => setTemplate(null)} title="Bỏ template">✕</button>}
      </div>

      {/* ── Công cụ chuyển đổi ── */}
      <div className="cv-row">
        <span className="cv-lbl">Công cụ</span>
        <label className="cv-ai">
          <input
            type="checkbox"
            checked={willUseAi}
            disabled={aiForced}
            onChange={(e) => setUseAi(e.target.checked)}
          />
          <span>Dùng AI (Claude)</span>
        </label>
        <span className="small" style={{ color: 'var(--muted)' }}>
          {template
            ? 'Có template mẫu → bắt buộc dùng AI.'
            : src && !libOk
              ? `Thư viện không chuyển được ${srcExt} → ${TARGET_LABEL[target]} → phải dùng AI.`
              : willUseAi
                ? 'AI đọc file nguồn rồi tự ghi file kết quả.'
                : 'Dùng thư viện sẵn có — nhanh, chạy offline.'}
        </span>
      </div>

      {pdfBlocked && (
        <p className="small" style={{ color: 'var(--warn, #d29922)' }}>
          ⚠ Tạo PDF bằng thư viện cần bản desktop (<code>npm run desktop</code>) vì phải mượn Chromium để in.
          Đang chạy trên trình duyệt thường — chọn định dạng khác, hoặc bật “Dùng AI”.
        </p>
      )}
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}

      {/* ── Tiến trình ── */}
      {jobs.length > 0 && (
        <>
          <div className="group-title" style={{ marginTop: 10, display: 'flex', alignItems: 'center' }}>
            <span style={{ flex: 1 }}>Tiến trình</span>
            <button className="ghost sm" onClick={() => void cClear().then((r) => setJobs(r.jobs))}>Dọn xong</button>
          </div>
          {jobs.map((j) => {
            const m = STATUS_META[j.status];
            return (
              <div key={j.id} className={`cv-job ${m.cls}`}>
                <span className="cv-job-ico" aria-hidden>{m.icon}</span>
                <div className="cv-job-main">
                  <div className="cv-job-line">
                    <b>{j.srcName}</b> → {TARGET_LABEL[j.target]}
                    {j.useAi && <span className="cv-badge-ai">AI</span>}
                  </div>
                  <div className="cv-job-sub" title={j.outAbs}>
                    {j.status === 'done' ? j.outAbs : j.status === 'error' ? (j.error ?? '') : j.step}
                  </div>
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* ── Pickers ── */}
      {picking === 'src' && (
        <FolderPicker
          title="Chọn file cần chuyển đổi"
          fileExts={CONVERT_SOURCE_EXTS}
          onPickFile={(p) => { setSrc(p); setPicking(null); }}
          onPick={() => {}}
          onClose={() => setPicking(null)}
        />
      )}
      {picking === 'dir' && (
        <FolderPicker
          initial={outDir ?? undefined}
          title="Chọn nơi lưu file kết quả"
          onPick={(p) => { setOutDir(p); setPicking(null); }}
          onClose={() => setPicking(null)}
        />
      )}
      {picking === 'tpl' && (
        <FolderPicker
          title="Chọn file template mẫu"
          fileExts={CONVERT_SOURCE_EXTS}
          onPickFile={(p) => { setConfirmTpl(p); setPicking(null); }}
          onPick={() => {}}
          onClose={() => setPicking(null)}
        />
      )}

      {/* Cảnh báo dùng AI khi chọn template — hỏi trước khi bật. */}
      {confirmTpl && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setConfirmTpl(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(520px, 94vw)' }}>
            <h3 style={{ marginTop: 0 }}>⚠ Template mẫu sẽ dùng AI</h3>
            <p className="small">
              Để trình bày lại nội dung theo bố cục của <b>{baseOf(confirmTpl)}</b>, DevBox sẽ gọi
              <b> Claude</b> (CLI <code>claude</code> cài trên máy này).
            </p>
            <ul className="small" style={{ lineHeight: 1.9 }}>
              <li>AI sẽ <b>đọc nội dung</b> file nguồn và file template.</li>
              <li>AI tự <b>ghi file kết quả</b> vào thư mục lưu bạn đã chọn.</li>
              <li>Chạy lâu hơn thư viện (job vẫn chạy ngầm, xong sẽ có thông báo).</li>
            </ul>
            <p className="small" style={{ color: 'var(--muted)' }}>
              Không muốn dùng AI thì bỏ template — chuyển đổi sẽ chạy bằng thư viện sẵn có.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="ghost sm" onClick={() => setConfirmTpl(null)}>Hủy</button>
              <button className="sm" onClick={() => { setTemplate(confirmTpl); setConfirmTpl(null); }}>
                ✓ Đồng ý — dùng AI
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
