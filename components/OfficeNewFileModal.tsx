'use client';

// "Tạo file mới" modal shared by the Office editors (Sheet + Word): type a
// file name, pick the destination folder with the shared FolderPicker (folder
// mode), and confirm. The parent owns the actual API call (busy/err come in
// as props); this component only collects (dir, name-with-extension).

import { useEffect, useState } from 'react';
import FolderPicker from './FolderPicker';

/** A starting-point document offered alongside the blank one. */
export interface OfficeTemplateChoice {
  v: string;
  label: string;
  hint: string;
  icon: string;
}

export interface OfficeNewFileModalProps {
  /** Modal heading, e.g. 'Tạo bảng tính mới'. */
  title: string;
  /** Allowed extensions WITHOUT the dot (['xlsx','csv']); first = default. */
  exts: string[];
  /** Pre-filled destination folder (e.g. folder of the currently open file). */
  initialDir?: string;
  /** When given, the user picks a template; its id comes back via onCreate. */
  templates?: OfficeTemplateChoice[];
  busy: boolean;
  err: string | null;
  /** `name` always carries its extension. `template` is set only when
   *  `templates` was provided. */
  onCreate: (dir: string, name: string, template?: string) => void;
  onClose: () => void;
}

/** Windows-illegal file name characters (also fine to refuse on other OSes). */
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\\/:*?"<>|\x00-\x1f]/;

export default function OfficeNewFileModal({
  title,
  exts,
  initialDir,
  templates,
  busy,
  err,
  onCreate,
  onClose,
}: OfficeNewFileModalProps) {
  const [dir, setDir] = useState(initialDir ?? '');
  const [name, setName] = useState('');
  const [ext, setExt] = useState(exts[0]);
  const [template, setTemplate] = useState(templates?.[0]?.v ?? '');
  const [dirPickerOpen, setDirPickerOpen] = useState(false);

  // Esc = thoát: close the nested folder picker first, then the modal itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (dirPickerOpen) setDirPickerOpen(false);
      else if (!busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirPickerOpen, busy, onClose]);

  const trimmed = name.trim();
  const nameBad = trimmed !== '' && (BAD_CHARS.test(trimmed) || /^\.+$/.test(trimmed) || trimmed.endsWith('.'));
  const hasExt = exts.some((x) => trimmed.toLowerCase().endsWith(`.${x}`));
  const fullName = hasExt ? trimmed : `${trimmed}.${ext}`;
  const canCreate = !busy && dir !== '' && trimmed !== '' && !nameBad;

  const submit = () => {
    if (canCreate) onCreate(dir, fullName, templates ? template : undefined);
  };

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 94vw)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>{title}</h3>
          <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
        </div>

        {templates && templates.length > 0 && (
          <>
            <label className="small" style={{ color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
              Bắt đầu từ
            </label>
            <div className="office-tpl-grid">
              {templates.map((t) => (
                <button
                  key={t.v}
                  type="button"
                  className={`office-tpl${template === t.v ? ' on' : ''}`}
                  onClick={() => setTemplate(t.v)}
                  disabled={busy}
                  title={t.hint}
                >
                  <span className="office-tpl-ico" aria-hidden>{t.icon}</span>
                  <span className="office-tpl-name">{t.label}</span>
                  <span className="office-tpl-hint">{t.hint}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <label className="small" style={{ color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
          Tên file
        </label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <input
            autoFocus
            placeholder={`vi-du.${ext}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
          {exts.length > 1 && !hasExt && (
            <select value={ext} onChange={(e) => setExt(e.target.value)} style={{ flex: '0 0 100px' }}>
              {exts.map((x) => <option key={x} value={x}>.{x}</option>)}
            </select>
          )}
        </div>
        {nameBad && (
          <div className="small" style={{ color: 'var(--err)', marginBottom: 8 }}>
            Tên file không được chứa \ / : * ? &quot; &lt; &gt; | hay kết thúc bằng dấu chấm.
          </div>
        )}

        <label className="small" style={{ color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
          Lưu vào thư mục
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <code className="small picker-cwd" style={{ flex: 1 }} title={dir || undefined}>
            {dir || '(chưa chọn thư mục)'}
          </code>
          <button className="ghost sm" onClick={() => setDirPickerOpen(true)} disabled={busy}>
            📂 Chọn…
          </button>
        </div>

        {trimmed !== '' && dir !== '' && !nameBad && (
          <div className="small" style={{ color: 'var(--muted)', marginBottom: 4 }}>
            Sẽ tạo: <code>{fullName}</code> — không ghi đè file trùng tên.
          </div>
        )}
        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="ghost sm" onClick={onClose} disabled={busy}>Hủy</button>
          <button className="sm" onClick={submit} disabled={!canCreate}
            title={dir === '' ? 'Chọn thư mục lưu file trước' : trimmed === '' ? 'Nhập tên file' : 'Tạo file và mở ngay'}>
            {busy ? <span className="spinner" aria-hidden /> : '＋'} Tạo &amp; mở
          </button>
        </div>

        {dirPickerOpen && (
          <FolderPicker
            title="Chọn thư mục lưu file mới"
            initial={dir || undefined}
            onPick={(p) => { setDir(p); setDirPickerOpen(false); }}
            onClose={() => setDirPickerOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
