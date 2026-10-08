'use client';

// Nút ⚙ ở thanh URL: cấu hình gửi riêng cho request này (timeout, theo redirect).
// Lưu cùng request nên đặt một lần là xong.

import { useState } from 'react';
import type { ApiSendOpts } from '@/lib/api';

export default function SendOptsPopover({ opts, onChange }: { opts: ApiSendOpts | undefined; onChange: (o: ApiSendOpts) => void }) {
  const [open, setOpen] = useState(false);
  const o = opts ?? {};
  const custom = !!o.timeoutSec || o.follow === false;
  return (
    <span className="api-pop-wrap">
      <button className={`ghost sm${open || custom ? ' on' : ''}`} onClick={() => setOpen((v) => !v)}
        title={custom ? 'Cấu hình gửi (đang khác mặc định)' : 'Cấu hình gửi: timeout, theo redirect'}
        aria-haspopup="dialog" aria-expanded={open}>⚙</button>
      {open && (
        <>
          <div className="api-pop-veil" onClick={() => setOpen(false)} aria-hidden />
          <div className="api-pop api-opts" role="dialog" aria-label="Cấu hình gửi">
            <label className="api-opts-row">
              <span>Timeout (giây)</span>
              <input className="input sm" type="number" min={0} max={3600} placeholder="không giới hạn"
                value={o.timeoutSec ?? ''}
                onChange={(e) => onChange({ ...o, timeoutSec: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })} />
            </label>
            <label className="api-opts-row">
              <span>Theo redirect (3xx)</span>
              <input type="checkbox" checked={o.follow !== false} onChange={(e) => onChange({ ...o, follow: e.target.checked ? undefined : false })} />
            </label>
            <p className="small" style={{ color: 'var(--muted)', margin: '6px 0 0' }}>
              Tắt redirect để xem thẳng response 3xx và header <code>Location</code>. Chứng chỉ TLS không bị kiểm tra (tool nội bộ).
            </p>
          </div>
        </>
      )}
    </span>
  );
}
