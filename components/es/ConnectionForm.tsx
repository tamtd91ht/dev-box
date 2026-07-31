'use client';

// Add / edit an Elasticsearch connection — a CLUSTER node list (host:port,
// comma-separated — like Kafka's brokers; default port 9200), no auth (VPN).
// The server fails over node-to-node on connection errors. Test reports
// cluster name + version + health + latency before saving. Works with ES
// 6.8 → 8.x.

import { useState } from 'react';
import { mutateEsConnection, testEsConnection, type PublicEsConnection } from '@/lib/es';

export interface ConnectionFormProps {
  initial: PublicEsConnection | null;
  onCancel: () => void;
  onSaved: (r: { list: PublicEsConnection[]; activeId: string }) => void;
  onError: (msg: string) => void;
}

export default function ConnectionForm({ initial, onCancel, onSaved, onError }: ConnectionFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [project, setProject] = useState(initial?.project ?? '');
  const [nodes, setNodes] = useState(initial?.nodes.join(', ') ?? '');
  const [tls, setTls] = useState(initial?.tls ?? false);
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const bodyOf = () => ({ name, project, nodes, tls });

  return (
    <div className="es-form">
      <label className="es-field">
        <span>Tên <b style={{ color: 'var(--err)' }}>*</b>{!name.trim() && <em style={{ color: 'var(--err)', fontStyle: 'normal' }}> — bắt buộc để lưu</em>}</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="vn-es-search" />
      </label>
      <label className="es-field"><span>Project</span>
        <input className="input" value={project} onChange={(e) => setProject(e.target.value)} placeholder="vn" />
      </label>
      <div className="es-form-row">
        <label className="es-field" style={{ flex: 1 }}>
          <span>Nodes (host:port, cách nhau bởi dấu phẩy — nhiều node = failover; mặc định :9200)</span>
          <textarea className="input mono" rows={2} value={nodes} onChange={(e) => setNodes(e.target.value)}
            placeholder="192.168.2.90:9200, 192.168.2.91:9200, 192.168.2.92:9200" />
        </label>
        <label className="es-check" style={{ marginTop: 18 }}>
          <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} /> https
        </label>
      </div>

      {testMsg && <div className="badge">{testMsg}</div>}
      <div className="status-line" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button
          className="ghost sm"
          disabled={busy || !nodes.trim()}
          onClick={async () => {
            setBusy(true); setTestMsg(null);
            try {
              const r = await testEsConnection({ nodes, tls });
              setTestMsg(`OK · ${r.clusterName} · ES ${r.version} · ${r.status} · ${r.nodes} node(s) · ${r.latencyMs}ms`);
            } catch (e) { setTestMsg(`Lỗi: ${(e as Error).message}`); }
            finally { setBusy(false); }
          }}
        >Test</button>
        <button className="ghost sm" onClick={onCancel}>Huỷ</button>
        <button
          className="sm"
          disabled={busy || !name.trim() || !nodes.trim()}
          title={!name.trim() ? 'Nhập Tên trước đã' : !nodes.trim() ? 'Nhập nodes trước đã' : (initial ? 'Lưu thay đổi' : 'Thêm cluster')}
          onClick={async () => {
            setBusy(true);
            try {
              const list = initial
                ? await mutateEsConnection('PUT', { id: initial.id, ...bodyOf() })
                : await mutateEsConnection('POST', bodyOf());
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
