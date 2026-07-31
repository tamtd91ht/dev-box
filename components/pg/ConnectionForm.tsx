'use client';

// Add / edit a PostgreSQL connection. `database` is the session's default DB
// (the browser tree can still open sibling databases). READ-ONLY toggle is the
// per-connection write gate — defaults ON, same convention as Mongo/Rabbit.

import { useState } from 'react';
import { mutatePgConnection, testPgConnection, type PublicPgConnection } from '@/lib/pg';

export interface ConnectionFormProps {
  initial: PublicPgConnection | null;
  onCancel: () => void;
  onSaved: (r: { list: PublicPgConnection[]; activeId: string }) => void;
  onError: (msg: string) => void;
}

export default function ConnectionForm({ initial, onCancel, onSaved, onError }: ConnectionFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [project, setProject] = useState(initial?.project ?? '');
  const [host, setHost] = useState(initial?.host ?? '');
  const [port, setPort] = useState(initial?.port ?? 5432);
  const [database, setDatabase] = useState(initial?.database ?? 'postgres');
  const [username, setUsername] = useState(initial?.username ?? '');
  const [password, setPassword] = useState('');
  const [tls, setTls] = useState(initial?.tls ?? false);
  const [readOnly, setReadOnly] = useState(initial ? initial.readOnly : true);
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const bodyOf = () => ({ name, project, host, port, database, username, password, tls, readOnly });
  const canTest = !!host.trim() && !!username.trim();

  return (
    <div className="pg-form">
      <label className="pg-field">
        <span>Tên <b style={{ color: 'var(--err)' }}>*</b>{!name.trim() && <em style={{ color: 'var(--err)', fontStyle: 'normal' }}> — bắt buộc để lưu</em>}</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="vn-pbx-pg" />
      </label>
      <label className="pg-field"><span>Project</span>
        <input className="input" value={project} onChange={(e) => setProject(e.target.value)} placeholder="vn" />
      </label>
      <div className="pg-form-row">
        <label className="pg-field" style={{ flex: 1 }}><span>Host</span>
          <input className="input mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.2.85" />
        </label>
        <label className="pg-field" style={{ flex: '0 0 100px' }}><span>Port</span>
          <input className="input" type="number" min={1} max={65535} value={port}
            onChange={(e) => setPort(Number(e.target.value) || 5432)} />
        </label>
        <label className="pg-field" style={{ flex: 1 }}><span>Database mặc định</span>
          <input className="input mono" value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="postgres" />
        </label>
      </div>
      <div className="pg-form-row">
        <label className="pg-field" style={{ flex: 1 }}><span>Username</span>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="postgres" />
        </label>
        <label className="pg-field" style={{ flex: 1 }}><span>Password {initial ? '(để trống = giữ nguyên)' : ''}</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={initial?.hasPassword ? '••••••' : ''} />
        </label>
        <label className="pg-check" style={{ marginTop: 18 }}>
          <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} /> ssl
        </label>
      </div>

      <label className={`pg-check pg-readonly-toggle${readOnly ? '' : ' armed'}`}>
        <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
        <span>
          <b>Read-only</b> — chặn UPDATE trên server này (SELECT vẫn thoải mái — mọi query đọc chạy trong transaction READ ONLY).
          {!readOnly && <em> Đã mở khoá ghi — chỉ nên bỏ chọn với server dev/local.</em>}
        </span>
      </label>

      {testMsg && <div className="badge">{testMsg}</div>}
      <div className="status-line" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button
          className="ghost sm"
          disabled={busy || !canTest}
          onClick={async () => {
            setBusy(true); setTestMsg(null);
            try {
              const r = await testPgConnection({ host, port, database, username, password: password || undefined, tls });
              setTestMsg(`OK · PostgreSQL ${r.version} · db ${r.database} · ${r.latencyMs}ms`);
            } catch (e) { setTestMsg(`Lỗi: ${(e as Error).message}`); }
            finally { setBusy(false); }
          }}
        >Test</button>
        <button className="ghost sm" onClick={onCancel}>Huỷ</button>
        <button
          className="sm"
          disabled={busy || !name.trim() || !host.trim() || !username.trim()}
          title={!name.trim() ? 'Nhập Tên trước đã' : !host.trim() ? 'Nhập host trước đã' : !username.trim() ? 'Nhập username trước đã' : (initial ? 'Lưu thay đổi' : 'Thêm server')}
          onClick={async () => {
            setBusy(true);
            try {
              const list = initial
                ? await mutatePgConnection('PUT', { id: initial.id, ...bodyOf() })
                : await mutatePgConnection('POST', bodyOf());
              const activeId = initial?.id ?? list.find((c) => c.name === name.trim())?.id ?? list[0]?.id ?? '';
              onSaved({ list, activeId });
            } catch (e) { onError((e as Error).message); }
            finally { setBusy(false); }
          }}
        >{initial ? 'Lưu' : 'Thêm'}</button>
      </div>
    </div>
  );
}
