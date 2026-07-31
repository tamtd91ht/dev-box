'use client';

// Add / edit a MongoDB connection. The one thing here that is not plumbing: the
// READ-ONLY toggle, which is the per-connection write gate (see
// lib/mongoConnections.ts). It defaults ON for a new connection and any record
// saved before the flag existed, so pointing this tool at a production cluster
// never silently arms writes. Test probes the deployment before saving and
// reports version + topology + latency.

import { useState } from 'react';
import { mutateMongoConnection, testMongoConnection, type PublicMongoConnection, type MongoScheme } from '@/lib/mongo';

export interface ConnectionFormProps {
  initial: PublicMongoConnection | null;
  onCancel: () => void;
  onSaved: (r: { list: PublicMongoConnection[]; activeId: string }) => void;
  onError: (msg: string) => void;
}

export default function ConnectionForm({ initial, onCancel, onSaved, onError }: ConnectionFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [project, setProject] = useState(initial?.project ?? '');
  const [scheme, setScheme] = useState<MongoScheme>(initial?.scheme ?? 'mongodb');
  const [hosts, setHosts] = useState(initial?.hosts.join(', ') ?? '');
  const [replicaSet, setReplicaSet] = useState(initial?.replicaSet ?? '');
  const [username, setUsername] = useState(initial?.username ?? '');
  const [password, setPassword] = useState('');
  const [authSource, setAuthSource] = useState(initial?.authSource ?? '');
  const [tls, setTls] = useState(initial?.tls ?? false);
  const [directConnection, setDirectConnection] = useState(initial?.directConnection ?? false);
  // Locked by default on create. On edit, reflect what is stored.
  const [readOnly, setReadOnly] = useState(initial ? initial.readOnly : true);
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const bodyOf = () => ({
    name, project, scheme, hosts, replicaSet, username, password, authSource, tls, directConnection, readOnly,
  });

  const srv = scheme === 'mongodb+srv';

  return (
    <div className="mongo-form">
      <label className="mongo-field">
        <span>Tên <b style={{ color: 'var(--err)' }}>*</b>{!name.trim() && <em style={{ color: 'var(--err)', fontStyle: 'normal' }}> — bắt buộc để lưu</em>}</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="vn-mongo-data" />
      </label>
      <label className="mongo-field"><span>Project</span>
        <input className="input" value={project} onChange={(e) => setProject(e.target.value)} placeholder="vn" />
      </label>
      <div className="mongo-form-row">
        <label className="mongo-field" style={{ flex: '0 0 150px' }}><span>Scheme</span>
          <select className="input" value={scheme} onChange={(e) => setScheme(e.target.value as MongoScheme)}>
            <option value="mongodb">mongodb</option>
            <option value="mongodb+srv">mongodb+srv</option>
          </select>
        </label>
        <label className="mongo-field" style={{ flex: 1 }}>
          <span>{srv ? 'SRV domain (không port)' : 'Hosts (host:port, phẩy — nhiều host = replica set)'}</span>
          <textarea
            className="input"
            rows={2}
            value={hosts}
            onChange={(e) => setHosts(e.target.value)}
            placeholder={srv ? 'cluster0.abcde.mongodb.net' : 'mongo1:27017, mongo2:27017, mongo3:27017'}
          />
        </label>
      </div>
      <div className="mongo-form-row">
        <label className="mongo-field" style={{ flex: 1 }}><span>Username (để trống = không auth)</span>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="omicx_reader" />
        </label>
        <label className="mongo-field" style={{ flex: 1 }}><span>Password {initial ? '(để trống = giữ nguyên)' : ''}</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={initial?.hasPassword ? '••••••' : ''} />
        </label>
      </div>
      <div className="mongo-form-row">
        <label className="mongo-field" style={{ flex: 1 }}><span>Auth source (mặc định admin)</span>
          <input className="input" value={authSource} onChange={(e) => setAuthSource(e.target.value)} placeholder="admin" />
        </label>
        {!srv && (
          <label className="mongo-field" style={{ flex: 1 }}><span>Replica set (tuỳ chọn)</span>
            <input className="input" value={replicaSet} onChange={(e) => setReplicaSet(e.target.value)} placeholder="rs0" />
          </label>
        )}
      </div>
      <div className="mongo-form-row" style={{ gap: 16 }}>
        <label className="mongo-check">
          <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} /> tls
        </label>
        {!srv && (
          <label className="mongo-check" title="Kết nối thẳng vào host được khai (bỏ qua replica set discovery)">
            <input type="checkbox" checked={directConnection} onChange={(e) => setDirectConnection(e.target.checked)} /> directConnection
          </label>
        )}
      </div>

      <label className={`mongo-check mongo-readonly-toggle${readOnly ? '' : ' armed'}`}>
        <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
        <span>
          <b>Read-only</b> — chặn update trên cluster này (đọc vẫn thoải mái).
          {!readOnly && <em> Đã mở khoá ghi — chỉ nên bỏ chọn với cluster dev/local.</em>}
        </span>
      </label>

      {testMsg && <div className="badge">{testMsg}</div>}
      <div className="status-line" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button
          className="ghost sm"
          disabled={busy || !hosts.trim()}
          onClick={async () => {
            setBusy(true); setTestMsg(null);
            try {
              const r = await testMongoConnection({
                scheme, hosts, replicaSet, authSource, username, password: password || '', tls, directConnection,
              });
              setTestMsg(`OK · MongoDB ${r.version} · ${r.topology} · ${r.latencyMs}ms`);
            } catch (e) { setTestMsg(`Lỗi: ${(e as Error).message}`); }
            finally { setBusy(false); }
          }}
        >Test</button>
        <button className="ghost sm" onClick={onCancel}>Huỷ</button>
        <button
          className="sm"
          disabled={busy || !name.trim() || !hosts.trim()}
          title={!name.trim() ? 'Nhập Tên trước đã' : !hosts.trim() ? 'Nhập hosts trước đã' : (initial ? 'Lưu thay đổi' : 'Thêm cluster')}
          onClick={async () => {
            setBusy(true);
            try {
              const list = initial
                ? await mutateMongoConnection('PUT', { id: initial.id, ...bodyOf() })
                : await mutateMongoConnection('POST', bodyOf());
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
