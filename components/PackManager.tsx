'use client';

// ＋ Projects — register / remove integration packs. Each pack becomes its OWN
// top-level tab in the header's "Projects" zone (rendered by page.tsx), so a
// project's personalized API Explorer never mixes with the shared infra tools.

import { useState } from 'react';
import type { IntegrationView } from './ApiExplorerWorkspace';
import FolderPicker from './FolderPicker';

export interface PackManagerProps {
  packs: IntegrationView[];
  onChanged: (list: IntegrationView[]) => void;
  onOpen: (packId: string) => void;
}

async function mutateIntegration(method: 'POST' | 'PUT' | 'DELETE', body: Record<string, unknown>): Promise<IntegrationView[]> {
  const r = await fetch('/api/api-integrations', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return (data as { integrations: IntegrationView[] }).integrations;
}

export default function PackManager({ packs, onChanged, onOpen }: PackManagerProps) {
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const register = async () => {
    setBusy(true); setError(null);
    try {
      const list = await mutateIntegration('POST', { name, root });
      onChanged(list);
      setName(''); setRoot('');
      const added = list[list.length - 1];
      if (added) onOpen(added.id);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="panel" style={{ margin: '0 auto', maxWidth: 760, width: '100%' }}>
      <div className="status-line"><h3 style={{ margin: 0 }}>Projects — integration packs</h3></div>
      <p className="small" style={{ color: 'var(--muted)', lineHeight: 1.55 }}>
        Mỗi project “cắm” API của mình vào toolbox bằng file <code>devbox.api.json</code> đặt trong
        repo của chính nó (services + spec paths + auth + flows). Đăng ký folder ở đây — pack sẽ
        xuất hiện thành <b>một tab riêng mang tên project</b> ở phân vùng Projects trên header.
        Registry lưu per-máy (<code>.apiintegrations.json</code>, gitignored).
      </p>

      {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}

      <div className="group-title" style={{ marginTop: 12 }}>Đã đăng ký ({packs.length})</div>
      {packs.length === 0 && <p className="empty">Chưa có pack nào.</p>}
      {packs.map((p) => (
        <div key={p.id} className="apix-pack-row" style={{ cursor: 'default' }}>
          <span className="apix-pack-name" title={p.root}>
            ▤ <b>{p.manifest?.name ?? p.name}</b>
            <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {p.root}</span>
          </span>
          {p.manifestError
            ? <span className="badge" style={{ color: 'var(--err)' }} title={p.manifestError}>manifest lỗi</span>
            : <span className="badge">{p.manifest?.services.length ?? 0} services · {p.manifest?.flows.length ?? 0} flows</span>}
          <button className="chip-btn" onClick={() => onOpen(p.id)} disabled={!!p.manifestError}>Mở →</button>
          <button
            className="chip-btn"
            title="Xoá pack khỏi registry (không đụng repo của project)"
            onClick={async () => {
              try { onChanged(await mutateIntegration('DELETE', { id: p.id })); }
              catch (e) { setError((e as Error).message); }
            }}
          >✕</button>
        </div>
      ))}

      <div className="group-title" style={{ marginTop: 16 }}>Thêm pack mới</div>
      <div className="apix-form" style={{ marginTop: 4 }}>
        <div className="apix-form-row">
          <label className="apix-field" style={{ flex: 1 }}><span>Tên</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="OMICX"
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && root.trim() && !busy) register(); }} />
          </label>
          <label className="apix-field" style={{ flex: 2 }}><span>Folder chứa devbox.api.json</span>
            <div className="apix-pick-row">
              <input className="input mono" value={root} onChange={(e) => setRoot(e.target.value)}
                placeholder="Bấm “📂 Browse” hoặc dán đường dẫn"
                onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && root.trim() && !busy) register(); }} />
              <button className="ghost sm" disabled={busy} onClick={() => setPickerOpen(true)}
                title="Chọn thư mục ngay trên máy — không cần gõ đường dẫn">📂 Browse</button>
            </div>
          </label>
        </div>
        <div className="status-line" style={{ justifyContent: 'flex-end' }}>
          <button className="sm" disabled={busy || !name.trim() || !root.trim()} onClick={register}>
            {busy ? <span className="spinner" aria-hidden /> : '+'} Đăng ký
          </button>
        </div>
      </div>

      {pickerOpen && (
        <FolderPicker
          initial={root.trim() || undefined}
          title="Chọn folder chứa devbox.api.json"
          marker="devbox.api.json"
          hint="Thư mục có manifest được đánh dấu ▤ pack — đi vào repo project rồi bấm “Chọn thư mục này”."
          onPick={(picked) => {
            setRoot(picked);
            // Prefill the name from the folder when empty, same as the Git picker.
            setName((n) => n || picked.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '');
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
