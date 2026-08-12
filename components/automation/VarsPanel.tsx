'use client';

// 📦 Biến khả dụng & JSON mẫu — cầu nối máy-đọc-được giữa catalog và ô template.
//
// Trước đây người dùng phải ĐOÁN biến khi viết body webhook / nội dung thông
// báo (vài hint prose rải trong ActionCard). Panel này render thẳng từ
// registry: FieldDef của trigger (catalog.ts) + biến lõi (meta.ts
// TEMPLATE_CORE_VARS) — bấm là copy `{{tên}}`; và JSON mẫu chính là
// buildAlertMeta(sampleEvent(...)) nên thứ hiện ở đây KHÔNG THỂ lệch với thứ
// engine phát lúc 2 giờ sáng (script check:automation giữ phần còn lại).

import { useMemo, useState } from 'react';
import { STACKS, triggerDef, type FieldDef } from '@/lib/automation/catalog';
import { buildAlertMeta, TEMPLATE_CORE_VARS } from '@/lib/automation/meta';
import { sampleEvent } from '@/lib/automation/sample';
import type { InfraStack, TriggerType } from '@/lib/automation/types';

/** Cố định để JSON mẫu không đổi theo từng render. */
const SAMPLE_AT = 1786600200000;

export default function VarsPanel({ trigger, stacks }: { trigger: TriggerType; stacks?: string[] }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const isInfra = trigger === 'infra.metric' || trigger === 'infra.recovered';

  // Stack cho mẫu infra: ưu tiên stack đã chọn ở Phạm vi, cho đổi tay.
  const scoped = useMemo(
    () => (stacks ?? []).filter((s): s is InfraStack => STACKS.some((st) => st.id === s)),
    [stacks],
  );
  const [picked, setPicked] = useState<InfraStack | ''>('');
  const stack: InfraStack = picked || scoped[0] || 'redis';

  const vars = useMemo<FieldDef[]>(
    () => [...(triggerDef(trigger)?.fields ?? []), ...TEMPLATE_CORE_VARS],
    [trigger],
  );

  const metaPretty = useMemo(
    () => JSON.stringify(buildAlertMeta(sampleEvent(trigger, stack, SAMPLE_AT)), null, 2),
    [trigger, stack],
  );

  const copy = (text: string, key: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(key);
        window.setTimeout(() => setCopied((k) => (k === key ? null : k)), 1200);
      },
      () => {},
    );
  };

  return (
    <div className="auto-vars">
      <div className="auto-vars-head">
        <button type="button" className="ghost sm" onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'} 📦 Biến khả dụng & JSON mẫu
        </button>
        {open && isInfra ? (
          <select value={stack} onChange={(e) => setPicked(e.target.value as InfraStack)}>
            {STACKS.map((st) => (
              <option key={st.id} value={st.id}>
                {st.icon} {st.label}
              </option>
            ))}
          </select>
        ) : null}
        {!open ? (
          <span className="auto-hint">bấm biến để copy — khỏi phải đoán tên khi viết template</span>
        ) : null}
      </div>

      {open ? (
        <div className="auto-vars-grid">
          <div className="auto-vars-list">
            {vars.map((f) => (
              <div
                key={f.name}
                className="auto-var-row"
                title={[f.label, f.hint, f.sample !== undefined ? `Ví dụ: ${f.sample}` : '']
                  .filter(Boolean)
                  .join('\n')}
              >
                <button
                  type="button"
                  className="auto-var-name"
                  onClick={() => copy(`{{${f.name}}}`, f.name)}
                >
                  {copied === f.name ? '✓ đã copy' : `{{${f.name}}}`}
                </button>
                <span className="auto-var-label">{f.label}</span>
                {f.sample !== undefined ? <span className="auto-var-sample">{String(f.sample)}</span> : null}
              </div>
            ))}
          </div>
          <div className="auto-vars-json">
            <div className="auto-vars-head">
              <span className="auto-hint">
                Metadata mẫu — đây chính là <code>{'{{metaJson}}'}</code> (bọc marker: <code>{'{{metaBlock}}'}</code>)
              </span>
              <button type="button" className="ghost sm" onClick={() => copy(metaPretty, '__json')}>
                {copied === '__json' ? '✓ đã copy' : 'copy JSON'}
              </button>
            </div>
            <pre className="auto-probe wide">{metaPretty}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
