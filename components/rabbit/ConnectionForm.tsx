'use client';

// Add / edit a broker. The one thing here that is not plumbing: the READ-ONLY
// toggle, which is the second write gate (see lib/rabbitConnections.ts). It
// defaults ON for a new broker and any record saved before the flag existed, so
// pointing this tool at a production cluster never silently arms destructive ops.

import { useState } from 'react';
import { mutateRabbitConnection, testRabbitConnection, type PublicRabbitConnection } from '@/lib/rabbit';

export interface ConnectionFormProps {
  initial: PublicRabbitConnection | null;
  onCancel: () => void;
  onSaved: (r: { list: PublicRabbitConnection[]; activeId: string }) => void;
  onError: (msg: string) => void;
}

export default function ConnectionForm({ initial, onCancel, onSaved, onError }: ConnectionFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [project, setProject] = useState(initial?.project ?? '');
  const [nodes, setNodes] = useState(initial?.nodes.join(', ') ?? '');
  const [username, setUsername] = useState(initial?.username ?? 'guest');
  const [password, setPassword] = useState('');
  const [tls, setTls] = useState(initial?.tls ?? false);
  const [vhost, setVhost] = useState(initial?.vhost ?? '');
  // Locked by default on create. On edit, reflect what is stored.
  const [readOnly, setReadOnly] = useState(initial ? initial.readOnly : true);
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const bodyOf = () => ({ name, project, nodes, username, password, tls, vhost, readOnly });

  return (
    <div className="rabbit-form">
      <label className="rabbit-field"><span>Tên</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="vn-rabbit" />
      </label>
      <label className="rabbit-field"><span>Project</span>
        <input className="input" value={project} onChange={(e) => setProject(e.target.value)} placeholder="vn" />
      </label>
      <label className="rabbit-field">
        <span>Nodes (host:port, cách nhau bởi dấu phẩy — nhiều node = cluster)</span>
        <textarea className="input" rows={2} value={nodes} onChange={(e) => setNodes(e.target.value)} placeholder="node1:15672, node2:15672, node3:15672" />
      </label>
      <div className="rabbit-form-row">
        <label className="rabbit-field" style={{ flex: 1 }}><span>Username</span>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="guest" />
        </label>
        <label className="rabbit-field" style={{ flex: 1 }}><span>Password {initial ? '(để trống = giữ nguyên)' : ''}</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={initial?.hasPassword ? '••••••' : ''} />
        </label>
      </div>
      <div className="rabbit-form-row">
        <label className="rabbit-field" style={{ flex: 1 }}><span>Vhost (để trống = tất cả)</span>
          <input className="input" value={vhost} onChange={(e) => setVhost(e.target.value)} placeholder="/" />
        </label>
        <label className="rabbit-check" style={{ marginTop: 16 }}>
          <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} /> https
        </label>
      </div>

      <label className={`rabbit-check rabbit-readonly-toggle${readOnly ? '' : ' armed'}`}>
        <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
        <span>
          <b>Read-only</b> — chặn mọi thao tác ghi (tạo / bind / purge / xoá) trên broker này.
          {!readOnly && <em> Đã mở khoá ghi — chỉ nên bỏ chọn với broker dev/local.</em>}
        </span>
      </label>

      {testMsg && <div className="badge">{testMsg}</div>}
      <div className="status-line" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button
          className="ghost sm"
          disabled={busy || !nodes.trim()}
          onClick={async () => {
            setBusy(true); setTestMsg(null);
            try {
              const r = await testRabbitConnection({ nodes, username, password: password || '', tls });
              setTestMsg(`OK · ${r.clusterName} · v${r.version} · ${r.latencyMs}ms`);
            } catch (e) { setTestMsg(`Lỗi: ${(e as Error).message}`); }
            finally { setBusy(false); }
          }}
        >Test</button>
        <button className="ghost sm" onClick={onCancel}>Huỷ</button>
        <button
          className="sm"
          disabled={busy || !name.trim() || !nodes.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              const list = initial
                ? await mutateRabbitConnection('PUT', { id: initial.id, ...bodyOf() })
                : await mutateRabbitConnection('POST', bodyOf());
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
