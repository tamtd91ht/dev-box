'use client';

// Add / edit a MinIO connection. MinIO có HAI mặt: S3 API (cổng 9000 — nơi DevBox
// duyệt/tải object) và Console (cổng 9001 — giao diện web quản trị). Form tách
// riêng từng phần, và phần giám sát (Prometheus + node_exporter) là tuỳ chọn.
// Mọi ô địa chỉ nhận cả IP:port lẫn domain/URL đầy đủ.
// READ-ONLY toggle is the per-connection write gate — defaults ON.

import { useState } from 'react';
import { mutateMinioConnection, testMinioConnection, type PublicMinioConnection } from '@/lib/minio';

export interface ConnectionFormProps {
  initial: PublicMinioConnection | null;
  onCancel: () => void;
  onSaved: (r: { list: PublicMinioConnection[]; activeId: string }) => void;
  onError: (msg: string) => void;
}

const sectionStyle: React.CSSProperties = { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--glass-brd, rgba(127,127,127,.25))' };
const hintStyle: React.CSSProperties = { fontStyle: 'normal', color: 'var(--muted)' };

export default function ConnectionForm({ initial, onCancel, onSaved, onError }: ConnectionFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [project, setProject] = useState(initial?.project ?? '');
  const [host, setHost] = useState(initial?.host ?? '');
  const [port, setPort] = useState(initial?.port ?? 9000);
  const [tls, setTls] = useState(initial?.tls ?? false);
  const [accessKey, setAccessKey] = useState(initial?.accessKey ?? '');
  const [secretKey, setSecretKey] = useState('');
  const [region, setRegion] = useState(initial?.region ?? '');
  const [consoleUrl, setConsoleUrl] = useState(initial?.consoleUrl ?? '');
  const [metricsUrl, setMetricsUrl] = useState(initial?.metricsUrl ?? '');
  const [metricsToken, setMetricsToken] = useState('');
  const [metricsUrls, setMetricsUrls] = useState(initial?.metricsUrls?.join(', ') ?? '');
  const [readOnly, setReadOnly] = useState(initial ? initial.readOnly : true);
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const bodyOf = () => ({
    name, project, host, port, tls, accessKey, secretKey, region,
    consoleUrl, metricsUrl, metricsToken, metricsUrls, readOnly,
  });
  const hasSecret = !!secretKey || !!initial?.hasSecret;
  const canTest = !!host.trim() && !!accessKey.trim() && hasSecret;

  return (
    <div className="pg-form">
      <label className="pg-field">
        <span>Tên <b style={{ color: 'var(--err)' }}>*</b>{!name.trim() && <em style={{ color: 'var(--err)', fontStyle: 'normal' }}> — bắt buộc để lưu</em>}</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="vn-minio" />
      </label>
      <label className="pg-field"><span>Project</span>
        <input className="input" value={project} onChange={(e) => setProject(e.target.value)} placeholder="vn" />
      </label>

      <div style={sectionStyle}><strong>S3 API</strong> <em style={hintStyle}>— nơi DevBox duyệt / tải object (thường cổng 9000)</em></div>
      <div className="pg-form-row">
        <label className="pg-field" style={{ flex: 1 }}>
          <span>Endpoint <em style={hintStyle}>(IP, IP:port, domain hoặc URL)</em></span>
          <input className="input mono" value={host} onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.2.90  ·  192.168.2.90:9000  ·  https://s3.minio.vn"
            title="Dán nguyên URL cũng được: https → bật ssl, :port được tách ra." />
        </label>
        <label className="pg-field" style={{ flex: '0 0 100px' }}><span>Port</span>
          <input className="input" type="number" min={1} max={65535} value={port}
            onChange={(e) => setPort(Number(e.target.value) || 9000)} />
        </label>
        <label className="pg-check" style={{ marginTop: 18 }}>
          <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} /> ssl
        </label>
      </div>
      <div className="pg-form-row">
        <label className="pg-field" style={{ flex: 1 }}><span>Access key</span>
          <input className="input mono" value={accessKey} onChange={(e) => setAccessKey(e.target.value)} placeholder="minioadmin" autoComplete="off" />
        </label>
        <label className="pg-field" style={{ flex: 1 }}><span>Secret key {initial ? '(để trống = giữ nguyên)' : ''}</span>
          <input className="input" type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)}
            placeholder={initial?.hasSecret ? '••••••' : ''} autoComplete="new-password" />
        </label>
        <label className="pg-field" style={{ flex: '0 0 110px' }}><span>Region</span>
          <input className="input mono" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="(tuỳ chọn)" />
        </label>
      </div>

      <div style={sectionStyle}><strong>Console</strong> <em style={hintStyle}>— giao diện web quản trị (thường cổng 9001), tuỳ chọn</em></div>
      <label className="pg-field">
        <span>Console URL <em style={hintStyle}>(IP:port hoặc domain — để mở nhanh từ tab)</em></span>
        <input className="input mono" value={consoleUrl} onChange={(e) => setConsoleUrl(e.target.value)}
          placeholder="192.168.2.90:9001  ·  https://console.minio.vn" />
      </label>

      <div style={sectionStyle}><strong>Giám sát</strong> <em style={hintStyle}>— cho Monitor và màn Tổng quan, tuỳ chọn</em></div>
      <label className="pg-field">
        <span>Metrics URL <em style={hintStyle}>(Prometheus — bỏ trống = tự dùng endpoint S3 API + /minio/v2/metrics/cluster)</em></span>
        <input className="input mono" value={metricsUrl} onChange={(e) => setMetricsUrl(e.target.value)}
          placeholder="192.168.2.90:9000/minio/v2/metrics/cluster" />
      </label>
      <label className="pg-field">
        <span>Metrics token {initial?.hasMetricsToken ? '(để trống = giữ nguyên)' : ''} <em style={hintStyle}>(Bearer — khi MinIO không cho đọc metrics công khai: <code>mc admin prometheus generate</code>)</em></span>
        <input className="input" type="password" value={metricsToken} onChange={(e) => setMetricsToken(e.target.value)}
          placeholder={initial?.hasMetricsToken ? '••••••' : ''} autoComplete="new-password" />
      </label>
      <label className="pg-field">
        <span>Metrics URLs máy chủ <em style={hintStyle}>(node_exporter của máy chạy MinIO — để đo đĩa / RAM / CPU, ngăn cách bằng dấu phẩy)</em></span>
        <input className="input mono" value={metricsUrls} onChange={(e) => setMetricsUrls(e.target.value)}
          placeholder="http://192.168.2.90:9100/metrics" />
      </label>

      <label className={`pg-check pg-readonly-toggle${readOnly ? '' : ' armed'}`} style={sectionStyle}>
        <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
        <span>
          <b>Read-only</b> — chặn upload / xoá / tạo-xoá bucket trên server này (xem, tải xuống vẫn thoải mái).
          {!readOnly && <em> Đã mở khoá ghi — chỉ nên bỏ chọn với server dev/local.</em>}
        </span>
      </label>

      {testMsg && (
        <div className="badge" style={testMsg.startsWith('Không lưu được') || testMsg.startsWith('Lỗi') ? { color: 'var(--err)', whiteSpace: 'pre-wrap' } : undefined}>
          {testMsg}
        </div>
      )}
      <div className="status-line" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button
          className="ghost sm"
          disabled={busy || !canTest}
          title="Thử kết nối S3 API với thông tin đang nhập"
          onClick={async () => {
            setBusy(true); setTestMsg(null);
            try {
              const r = await testMinioConnection({
                host, port, tls, accessKey, secretKey: secretKey || undefined, connectionId: initial?.id,
              });
              setTestMsg(`OK · ${r.buckets} bucket · ${r.latencyMs}ms${r.live ? '' : ' · health/live lỗi'}${r.clusterOk ? '' : ' · cluster thiếu quorum'}`);
            } catch (e) { setTestMsg(`Lỗi: ${(e as Error).message}`); }
            finally { setBusy(false); }
          }}
        >Test</button>
        <button className="ghost sm" onClick={onCancel}>Huỷ</button>
        <button
          className="sm"
          disabled={busy || !name.trim() || !host.trim() || !accessKey.trim() || !hasSecret}
          title={!name.trim() ? 'Nhập Tên trước đã' : !host.trim() ? 'Nhập endpoint trước đã' : !accessKey.trim() ? 'Nhập access key' : !hasSecret ? 'Nhập secret key' : (initial ? 'Lưu thay đổi' : 'Thêm server')}
          onClick={async () => {
            setBusy(true);
            try {
              const list = initial
                ? await mutateMinioConnection('PUT', { id: initial.id, ...bodyOf() })
                : await mutateMinioConnection('POST', bodyOf());
              const activeId = initial?.id ?? list.find((c) => c.name === name.trim())?.id ?? list[0]?.id ?? '';
              onSaved({ list, activeId });
            } catch (e) {
              setTestMsg(`Không lưu được: ${(e as Error).message}`);
              onError((e as Error).message);
            }
            finally { setBusy(false); }
          }}
        >{initial ? 'Lưu' : 'Thêm'}</button>
      </div>
    </div>
  );
}
