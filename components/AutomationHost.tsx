'use client';

// The automation engine's presence in the app shell.
//
// Mounted ONCE, outside every workspace pane, so it keeps working while you are
// on any tab:
//   · starts the infrastructure watch runner (respects config.watchEnabled)
//   · renders `notify` actions as toasts, including dry-run previews
//
// Toasts are deliberately not a library: an urgent alert must stay on screen
// until acknowledged, and a dry-run one must LOOK different from a real one.

import { useCallback, useEffect, useState } from 'react';
import { automation, type AutomationToast } from '@/lib/automation/runtime';
import { watcher } from '@/lib/automation/watcher';

/** Auto-dismiss delay per level. Urgent stays until clicked. */
const LIFETIME: Record<AutomationToast['level'], number> = {
  info: 6000,
  warn: 12000,
  urgent: 0,
};

const ICON: Record<AutomationToast['level'], string> = {
  info: '💬',
  warn: '⚠',
  urgent: '🚨',
};

const MAX_VISIBLE = 4;

export default function AutomationHost() {
  const [toasts, setToasts] = useState<AutomationToast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    watcher.start();
    return automation.onToast((t) => {
      setToasts((list) => [t, ...list].slice(0, MAX_VISIBLE));
      const ttl = LIFETIME[t.level];
      if (ttl > 0) setTimeout(() => dismiss(t.id), ttl);
    });
  }, [dismiss]);

  if (!toasts.length) return null;

  return (
    <div className="auto-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`auto-toast lv-${t.level}${t.dryRun ? ' dry' : ''}`}
          onClick={() => dismiss(t.id)}
          title="Bấm để đóng"
        >
          <span className="at-ico" aria-hidden>{ICON[t.level]}</span>
          <span className="at-body">
            <span className="at-title">{t.title}</span>
            {t.body ? <span className="at-text">{t.body}</span> : null}
            <span className="at-meta">
              {t.dryRun ? <em className="at-dry">chạy thử</em> : null}
              {t.ruleName}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
