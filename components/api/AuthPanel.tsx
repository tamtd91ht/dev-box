'use client';

// Tab Auth: chọn kiểu xác thực, lúc gửi tự sinh header Authorization (hoặc
// header/query cho API key). Giá trị dùng được {{biến}} như mọi nơi khác.

import type { ApiAuth, ApiAuthType } from '@/lib/api';
import VarInput from './VarInput';

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
          <VarInput className="input" placeholder="{{token}} hoặc dán token" value={a.token ?? ''}
            onChange={(v) => set({ token: v })} />
        </div>
      )}

      {a.type === 'basic' && (
        <div className="api-auth-grid">
          <label>Username</label>
          <VarInput className="input" value={a.user ?? ''} onChange={(v) => set({ user: v })} />
          <label>Password</label>
          <VarInput className="input" type="password" value={a.pass ?? ''} onChange={(v) => set({ pass: v })} />
        </div>
      )}

      {a.type === 'apikey' && (
        <div className="api-auth-grid">
          <label>Key</label>
          <VarInput className="input" placeholder="vd: X-API-Key" value={a.keyName ?? ''}
            onChange={(v) => set({ keyName: v })} />
          <label>Value</label>
          <VarInput className="input" placeholder="{{apiKey}}" value={a.keyValue ?? ''}
            onChange={(v) => set({ keyValue: v })} />
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
