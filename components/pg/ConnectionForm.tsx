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
  const [database, setDatabase] = useState(initial?.database ?? 'postgres');
  const [username, setUsername] = useState(initial?.username ?? '');
  const [password, setPassword] = useState('');
  const [tls, setTls] = useState(initial?.tls ?? false);
  const [metricsUrls, setMetricsUrls] = useState(initial?.metricsUrls?.join(', ') ?? '');
  const [readOnly, setReadOnly] = useState(initial ? initial.readOnly : true);
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const bodyOf = () => ({ name, project, host, database, username, password, tls, metricsUrls, readOnly });
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
        <label className="pg-field" style={{ flex: 2 }}><span>Địa chỉ <em style={{ fontStyle: 'normal', color: 'var(--muted)' }}>(host:port, cluster ngăn cách bằng dấu phẩy)</em></span>
          <input className="input mono" value={host} onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.2.85:5432  hoặc  pg1:5432,pg2:5433,pg3:5434"
            title="Một địa chỉ = máy đơn hoặc HA (VIP / proxy). Nhiều địa chỉ = các node của cluster, mỗi node một cổng riêng — tự chọn node PRIMARY. Không ghi cổng = 5432." />
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
      <label className="pg-field">
        <span>Metrics URLs <em style={{ fontStyle: 'normal', color: 'var(--muted)' }}>(tuỳ chọn — node_exporter của máy chạy Postgres, để Monitor đo đĩa/RAM/CPU)</em></span>
        <input className="input mono" value={metricsUrls} onChange={(e) => setMetricsUrls(e.target.value)}
          placeholder="http://192.168.2.85:9100/metrics" />
      </label>

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
              const r = await testPgConnection({ host, database, username, password: password || undefined, tls });
              setTestMsg(`OK · PostgreSQL ${r.version} · db ${r.database} · ${r.latencyMs}ms`
                + (r.endpoint ? ` · ${r.role === 'primary' ? 'primary' : 'standby (không có primary)'} ${r.endpoint} (${r.nodes} node)` : ''));
            } catch (e) { setTestMsg(`Lỗi: ${(e as Error).message}`); }
            finally { setBusy(false); }
          }}
        >Test</button>
        <button className="ghost sm" onClick={onCancel}>Huỷ</button>
        <button
          className="sm"
          disabled={busy || !name.trim() || !host.trim() || !username.trim()}
          title={!name.trim() ? 'Nhập Tên trước đã' : !host.trim() ? 'Nhập địa chỉ trước đã' : !username.trim() ? 'Nhập username trước đã' : (initial ? 'Lưu thay đổi' : 'Thêm server')}
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
