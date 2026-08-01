'use client';

// React binding for the automation runtime singleton.
//
// useSyncExternalStore keeps every consumer (the Workspace rail, the Automation
// tab, the toast host) reading ONE snapshot object, so a rule edited in the
// Automation tab takes effect on the next Zalo/Telegram poll without any
// prop-drilling or provider.

import { useEffect, useSyncExternalStore } from 'react';
import { automation, type AutomationSnapshot } from './runtime';
import { watcher, type WatcherSnapshot } from './watcher';

export function useAutomation(): AutomationSnapshot {
  const snap = useSyncExternalStore(automation.subscribe, automation.getSnapshot, automation.getSnapshot);
  useEffect(() => {
    void automation.load(); // no-op after the first call
  }, []);
  return snap;
}

/** Latest probe sample per infra watch. The runner itself is started by AutomationHost. */
export function useWatcher(): WatcherSnapshot {
  return useSyncExternalStore(watcher.subscribe, watcher.getSnapshot, watcher.getSnapshot);
}

export { automation, watcher };
