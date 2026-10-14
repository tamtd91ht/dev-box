'use client';

// Hộp chỉnh ngưỡng vàng/đỏ của Monitor. Chỉ ghi ĐÈ lên mặc định (RULES) — ô để
// trống = dùng mặc định, nên khôi phục là xoá ô, không phải nhớ số gốc.
// Chỉ số kiểu cờ (controller, alarm, trạng thái ES) không chỉnh được: chúng
// không có "ngưỡng", chỉ có đúng/sai.

import { useEffect, useState } from 'react';
import { RULES, STACK_META, STACK_ORDER, overrideKey, type Overrides, type Rule } from '@/lib/monitor/status';
import type { InfraStack } from '@/lib/automation/types';

interface Props {
  overrides: Overrides;
  onSave: (o: Overrides) => void;
  onClose: () => void;
}

const dirText = (r: Rule): string => (r.dir === 'gt' ? 'lớn hơn' : 'nhỏ hơn');

export default function MonitorThresholds({ overrides, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<Overrides>(overrides);
  const [stack, setStack] = useState<InfraStack>('redis');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = (rule: Rule, field: 'warn' | 'crit', raw: string) => {
    const k = overrideKey(stack, rule.metric);
    setDraft((d) => {
      const cur = { ...(d[k] ?? {}) };
      const n = raw.trim() === '' ? undefined : Number(raw);
      if (n === undefined || !Number.isFinite(n)) delete cur[field];
      else cur[field] = n;
      const next = { ...d };
      if (Object.keys(cur).length) next[k] = cur; else delete next[k];
      return next;
    });
  };

  const rules = RULES[stack].filter((r) => !r.say);
  const changed = Object.keys(draft).length;

  return (
    <>
      <div className="mon-scrim" onClick={onClose} />
      <div className="mon-modal" role="dialog" aria-label="Chỉnh ngưỡng">
        <header className="mon-modal-head">
          <strong>⚙ Ngưỡng xanh / vàng / đỏ</strong>
          <span className="mon-faint">Để trống = dùng mặc định</span>
          <span className="mon-spacer" />
          <button className="mon-btn icon" onClick={onClose} aria-label="Đóng">✕</button>
        </header>
        <div className="mon-modal-tabs">
          {STACK_ORDER.map((s) => (
            <button key={s} className={s === stack ? 'on' : ''} onClick={() => setStack(s)}>
              {STACK_META[s].icon} {STACK_META[s].label}
            </button>
          ))}
        </div>
        <div className="mon-modal-body">
          <table className="mon-mini mon-thr">
            <thead>
              <tr><th>Chỉ số</th><th>Xấu khi</th><th>Vàng</th><th>Đỏ</th></tr>
            </thead>
            <tbody>
              {rules.map((r) => {
                const o = draft[overrideKey(stack, r.metric)] ?? {};
                return (
                  <tr key={r.metric}>
                    <td title={r.why}>{r.label}{r.unit ? <span className="mon-faint"> ({r.unit})</span> : null}</td>
                    <td className="mon-faint">{dirText(r)}</td>
                    <td>
                      <input
                        type="number"
                        value={o.warn ?? ''}
                        placeholder={r.warn === undefined ? '—' : String(r.warn)}
                        onChange={(e) => set(r, 'warn', e.target.value)}
                        className={o.warn !== undefined ? 'custom' : ''}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={o.crit ?? ''}
                        placeholder={r.crit === undefined ? '—' : String(r.crit)}
                        onChange={(e) => set(r, 'crit', e.target.value)}
                        className={o.crit !== undefined ? 'custom' : ''}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <footer className="mon-modal-foot">
          <button className="mon-btn" onClick={() => setDraft({})} disabled={changed === 0}>Khôi phục mặc định</button>
          <span className="mon-spacer" />
          <button className="mon-btn" onClick={onClose}>Huỷ</button>
          <button className="mon-btn primary" onClick={() => { onSave(draft); onClose(); }}>Lưu</button>
        </footer>
      </div>
    </>
  );
}
