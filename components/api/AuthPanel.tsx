'use client';

// Tab Auth: chọn kiểu xác thực, lúc gửi tự sinh header Authorization (hoặc
// header/query cho API key). Giá trị dùng được {{biến}} như mọi nơi khác.

import type { ApiAuth, ApiAuthType } from '@/lib/api';

const TYPES: { key: ApiAuthType; label: string }[] = [
  { key: 'none', label: 'Không' },
  { key: 'bearer', label: 'Bearer token' },
  { key: 'basic', label: 'Basic' },
  { key: 'apikey', label: 'API key' },
];

export default function AuthPanel({ auth, onChange }: { auth: ApiAuth | undefined; onChange: (a: ApiAuth) => void }) {
  const a: ApiAuth = auth ?? { type: 'none' };
  const set = (patch: Partial<ApiAuth>) => onChange({ ...a, ...patch });
  return (
    <div className="api-auth">
      <div className="api-bodytype">
        {TYPES.map((t) => (
          <label key={t.key}>
            <input type="radio" checked={a.type === t.key} onChange={() => set({ type: t.key })} /> {t.label}
          </label>
        ))}
      </div>

      {a.type === 'none' && (
        <p className="small" style={{ color: 'var(--muted)', margin: '4px 2px' }}>
          Request này không dùng xác thực tự động. Muốn tự gõ thì thêm header ở tab Headers.
        </p>
      )}

      {a.type === 'bearer' && (
        <div className="api-auth-grid">
          <label>Token</label>
          <input className="input" placeholder="{{token}} hoặc dán token" value={a.token ?? ''}
            onChange={(e) => set({ token: e.target.value })} />
        </div>
      )}

      {a.type === 'basic' && (
        <div className="api-auth-grid">
          <label>Username</label>
          <input className="input" value={a.user ?? ''} onChange={(e) => set({ user: e.target.value })} />
          <label>Password</label>
          <input className="input" type="password" value={a.pass ?? ''} onChange={(e) => set({ pass: e.target.value })} />
        </div>
      )}

      {a.type === 'apikey' && (
        <div className="api-auth-grid">
          <label>Key</label>
          <input className="input" placeholder="vd: X-API-Key" value={a.keyName ?? ''}
            onChange={(e) => set({ keyName: e.target.value })} />
          <label>Value</label>
          <input className="input" placeholder="{{apiKey}}" value={a.keyValue ?? ''}
            onChange={(e) => set({ keyValue: e.target.value })} />
          <label>Đặt ở</label>
          <select className="input" value={a.keyIn ?? 'header'} onChange={(e) => set({ keyIn: e.target.value as 'header' | 'query' })}>
            <option value="header">Header</option>
            <option value="query">Query param</option>
          </select>
        </div>
      )}

      {a.type !== 'none' && (
        <p className="small" style={{ color: 'var(--muted)', margin: '8px 2px 0' }}>
          Được thêm lúc gửi. Nếu tab Headers đã có sẵn header cùng tên (đang bật) thì header đó được ưu tiên.
        </p>
      )}
    </div>
  );
}
