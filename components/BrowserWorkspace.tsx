'use client';

// Browser Workspace Framework — Workspace Manager (renderer entry point).
//
// Owns the open workspaces: which account is active, which guests stay mounted,
// LRU eviction past `maxActiveWorkspace`, per-account unread badges, and the
// new-message chime. A `multiAccount` plugin (e.g. Zalo) can hold several
// accounts, each an independent persistent session. Fully generic — it iterates
// WORKSPACE_PLUGINS and their accounts and knows nothing about any specific site.
//
// Outside the Electron shell there is no real browser engine, so it shows a
// short "run the desktop app" explainer instead (the web build still compiles).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BrandMark from './BrandMark';
import WorkspaceView from './WorkspaceView';
import { WORKSPACE_PLUGINS, getPlugin } from '@/lib/workspace/plugins';
import { isDesktop, resolveConfig } from '@/lib/workspace/config';
import type { CollectResult } from '@/lib/workspace/capture';
import type { WorkspacePlugin } from '@/lib/workspace/types';
import {
  type WorkspaceAccount,
  accountKey,
  loadAccounts,
  newAccount,
  partitionForAccount,
  saveAccounts,
} from '@/lib/workspace/accounts';
import { automation, useAutomation } from '@/lib/automation/useAutomation';
import { socialEvent } from '@/lib/automation/sources/social';

interface Props {
  /** Report the total unread across all workspaces (for the header tab badge). */
  onUnread?: (total: number) => void;
  /** Whether the Workspace TAB itself is the visible one. An account counts as
   *  "being read" only when the tab is visible AND it is the selected account —
   *  selection alone must not clear its unread while the user is on another tab. */
  visible?: boolean;
}

/** A short two-note chime for a new message. Lazily creates the AudioContext. */
function useChime(): () => void {
  const ctxRef = useRef<AudioContext | null>(null);
  useEffect(() => {
    // Prime the audio context on the first user gesture (autoplay policy).
    const prime = () => {
      try {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctxRef.current = ctxRef.current ?? new Ctx();
        void ctxRef.current.resume();
      } catch {
        /* no audio */
      }
    };
    window.addEventListener('pointerdown', prime, { once: true });
    return () => window.removeEventListener('pointerdown', prime);
  }, []);

  return useCallback(() => {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ac = (ctxRef.current = ctxRef.current ?? new Ctx());
      void ac.resume();
      const now = ac.currentTime;
      [
        [880, 0],
        [1174, 0.12],
      ].forEach(([freq, at]) => {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, now + at);
        g.gain.exponentialRampToValueAtTime(0.16, now + at + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.28);
        o.connect(g).connect(ac.destination);
        o.start(now + at);
        o.stop(now + at + 0.3);
      });
    } catch {
      /* no audio */
    }
  }, []);
}

export default function BrowserWorkspace({ onUnread, visible = true }: Props) {
  const desktop = isDesktop();
  const cfg = useMemo(() => resolveConfig(), []);
  const plugins = WORKSPACE_PLUGINS;

  // Accounts per plugin (multiAccount plugins may have several).
  const [accounts, setAccounts] = useState<Record<string, WorkspaceAccount[]>>(() => {
    const map: Record<string, WorkspaceAccount[]> = {};
    for (const p of plugins) map[p.id] = loadAccounts(p);
    return map;
  });
  const allAccounts = useMemo(() => plugins.flatMap((p) => accounts[p.id] ?? []), [plugins, accounts]);

  // keepAlive plugins (e.g. Zalo) open eagerly even under lazyLoad — they exist
  // to run in the background and raise new-message alerts, which requires their
  // guest to be alive BEFORE the user ever opens this tab. Other plugins stay lazy.
  const eagerKeys = (cfg.lazyLoad ? allAccounts.filter((a) => !!getPlugin(a.pluginId)?.keepAlive) : allAccounts)
    .map((a) => accountKey(a.pluginId, a.instanceId))
    .slice(0, Math.max(1, cfg.maxActiveWorkspace));
  const [activeKey, setActiveKey] = useState<string>(eagerKeys[0] ?? '');
  const [openKeys, setOpenKeys] = useState<string[]>(eagerKeys);

  // Unread per open account → aggregate for badges + chime.
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    setMuted(typeof window !== 'undefined' && localStorage.getItem('ws:muted') === '1');
  }, []);
  const chime = useChime();

  const total = useMemo(() => Object.values(unread).reduce((a, b) => a + b, 0), [unread]);
  const prevTotal = useRef(0);
  useEffect(() => {
    if (total > prevTotal.current && !muted) chime();
    prevTotal.current = total;
    onUnread?.(total);
  }, [total, muted, chime, onUnread]);

  // Automation: message capture is opt-in and off by default, so the guests
  // count unread and store nothing until the Automation tab enables it.
  const { config: autoCfg } = useAutomation();
  const captureOn = autoCfg.enabled && autoCfg.captureEnabled;

  const feedAutomation = useCallback(
    (plugin: WorkspacePlugin, acc: WorkspaceAccount, batch: CollectResult['m']) => {
      for (const m of batch) void automation.submit(socialEvent(plugin, acc, m));
    },
    [],
  );

  const keepAlive = useCallback((pluginId: string) => !!getPlugin(pluginId)?.keepAlive, []);

  const select = useCallback(
    (key: string) => {
      setOpenKeys((prev) => {
        const next = prev.filter((x) => x !== key).concat(key); // most-recent last
        const cap = cfg.keepAlive ? Math.max(1, cfg.maxActiveWorkspace) : 1;
        let result = next;
        while (result.length > cap) {
          const victim = result.findIndex((x) => x !== key && !keepAlive(x.split('::')[0]));
          if (victim === -1) break; // everything left is pinned
          result = result.filter((_, i) => i !== victim);
        }
        return result;
      });
      setActiveKey(key);
    },
    [cfg.keepAlive, cfg.maxActiveWorkspace, keepAlive],
  );

  const setInstanceUnread = useCallback((key: string, n: number) => {
    setUnread((prev) => (prev[key] === n ? prev : { ...prev, [key]: n }));
  }, []);

  const addAccount = useCallback(
    (pluginId: string) => {
      const plugin = getPlugin(pluginId);
      if (!plugin) return;
      setAccounts((prev) => {
        const list = prev[pluginId] ?? [];
        const acc = newAccount(plugin, list.length + 1);
        const next = [...list, acc];
        saveAccounts(pluginId, next);
        // Open the new account right away.
        setTimeout(() => select(accountKey(pluginId, acc.instanceId)), 0);
        return { ...prev, [pluginId]: next };
      });
    },
    [select],
  );

  const renameAccount = useCallback((pluginId: string, instanceId: string, label: string) => {
    setAccounts((prev) => {
      const next = (prev[pluginId] ?? []).map((a) =>
        a.instanceId === instanceId ? { ...a, label } : a,
      );
      saveAccounts(pluginId, next);
      return { ...prev, [pluginId]: next };
    });
  }, []);

  const removeAccount = useCallback(
    async (pluginId: string, instanceId: string) => {
      const plugin = getPlugin(pluginId);
      if (!plugin) return;
      const label = (accounts[pluginId] ?? []).find((a) => a.instanceId === instanceId)?.label ?? '';
      if (!window.confirm(`Xoá "${label}" và đăng xuất phiên này trên máy?`)) return;
      // Wipe the on-disk session for this account.
      await window.workspace?.clearSession(partitionForAccount(plugin, instanceId, cfg));
      const key = accountKey(pluginId, instanceId);
      setAccounts((prev) => {
        const next = (prev[pluginId] ?? []).filter((a) => a.instanceId !== instanceId);
        saveAccounts(pluginId, next);
        return { ...prev, [pluginId]: next };
      });
      setOpenKeys((prev) => prev.filter((k) => k !== key));
      setUnread((prev) => {
        if (!(key in prev)) return prev;
        const { [key]: _drop, ...rest } = prev;
        return rest;
      });
      setActiveKey((cur) => (cur === key ? '' : cur));
    },
    [accounts, cfg],
  );

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      try {
        localStorage.setItem('ws:muted', next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  if (!desktop) {
    return (
      <div className="panel">
        <div className="empty-ico">🧭</div>
        <h3>Workspace cần chạy trong app desktop</h3>
        <p>
          Tab này nhúng web app thật (Zalo, Grafana, Kibana…) bằng cửa sổ trình duyệt riêng, có phiên đăng nhập lưu
          ngay trên máy bạn. Nó chỉ hoạt động khi mở DevBox dưới dạng ứng dụng desktop (Electron).
        </p>
        <p className="ws-muted">
          Mở terminal và chạy: <code>npm run dev</code> (một cửa sổ) rồi <code>npm run desktop</code> (cửa sổ khác).
        </p>
      </div>
    );
  }

  return (
    <div className="ws-shell">
      <aside className="ws-rail">
        <div className="ws-rail-head">
          <span className="ws-rail-head-t">Workspaces</span>
          <button
            className="ws-icon-btn"
            onClick={toggleMute}
            title={muted ? 'Bật chuông báo tin nhắn' : 'Tắt chuông báo tin nhắn'}
          >
            {muted ? '🔕' : '🔔'}
          </button>
        </div>

        {plugins.map((plugin) => {
          const list = accounts[plugin.id] ?? [];
          const multi = !!plugin.multiAccount;
          const groupUnread = list.reduce(
            (sum, a) => sum + (unread[accountKey(plugin.id, a.instanceId)] ?? 0),
            0,
          );

          return (
            <div
              key={plugin.id}
              className={`ws-group${multi ? ' is-multi' : ''}`}
              // The plugin's hue flows to the group head, the account rail and
              // the active-row tint, so each app is a visually distinct block.
              style={{ ['--brand' as string]: plugin.brand?.color ?? 'var(--accent)' }}
            >
              <div className="ws-group-head">
                <BrandMark plugin={plugin} size={20} />
                <span className="ws-rail-name">{plugin.name}</span>
                {multi && list.length > 1 && <span className="ws-group-count">{list.length}</span>}
                {!multi && plugin.badge && <span className="ws-rail-badge">{plugin.badge}</span>}
                {groupUnread > 0 && <span className="ws-unread">{groupUnread > 99 ? '99+' : groupUnread}</span>}
              </div>

              <div className="ws-acct-list">
                {list.map((acc) => {
                  const key = accountKey(plugin.id, acc.instanceId);
                  const alive = openKeys.includes(key);
                  const isActive = key === activeKey;
                  const n = unread[key] ?? 0;
                  if (editingKey === key) {
                    return (
                      <div key={key} className="ws-acct is-active">
                        <input
                          className="ws-acct-input"
                          autoFocus
                          defaultValue={acc.label}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const v = (e.target as HTMLInputElement).value.trim();
                              if (v) renameAccount(plugin.id, acc.instanceId, v);
                              setEditingKey(null);
                            } else if (e.key === 'Escape') {
                              setEditingKey(null);
                            }
                          }}
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v) renameAccount(plugin.id, acc.instanceId, v);
                            setEditingKey(null);
                          }}
                        />
                      </div>
                    );
                  }
                  return (
                    <div
                      key={key}
                      className={`ws-acct${isActive ? ' is-active' : ''}`}
                      onClick={() => select(key)}
                      title={`${plugin.name} — ${acc.label}`}
                    >
                      {/* The app mark repeats on every row: a renamed account
                          ("Sếp", "CSKH") must still say which app it lives in. */}
                      <BrandMark plugin={plugin} size={14} faded={!alive} />
                      <span className="ws-acct-name">{acc.label}</span>
                      {n > 0 && <span className="ws-unread sm">{n > 99 ? '99+' : n}</span>}
                      {alive && <span className={`ws-rail-live${isActive ? '' : ' is-bg'}`} />}
                      {multi && (
                        <>
                          <button
                            className="ws-acct-btn"
                            title="Đổi tên"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingKey(key);
                            }}
                          >
                            ✎
                          </button>
                          {list.length > 1 && (
                            <button
                              className="ws-acct-btn danger"
                              title="Xoá tài khoản"
                              onClick={(e) => {
                                e.stopPropagation();
                                void removeAccount(plugin.id, acc.instanceId);
                              }}
                            >
                              ×
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}

                {multi && (
                  <button className="ws-acct-add" onClick={() => addAccount(plugin.id)}>
                    ＋ Thêm tài khoản
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </aside>

      <div className="ws-stage">
        {openKeys.length === 0 && (
          <div className="panel">
            <div className="empty-ico">🧭</div>
            <h3>Chọn một workspace</h3>
            <p>Bấm vào một mục bên trái để mở. Mỗi tài khoản có phiên đăng nhập riêng, lưu trên máy bạn.</p>
          </div>
        )}
        {openKeys.map((key) => {
          const [pluginId, instanceId] = key.split('::');
          const plugin = getPlugin(pluginId);
          const acc = (accounts[pluginId] ?? []).find((a) => a.instanceId === instanceId);
          if (!plugin || !acc) return null;
          return (
            <WorkspaceView
              key={key}
              plugin={plugin}
              account={acc}
              config={cfg}
              active={key === activeKey}
              viewing={visible && key === activeKey}
              onUnread={(n) => setInstanceUnread(key, n)}
              capture={captureOn}
              onMessages={(batch) => feedAutomation(plugin, acc, batch)}
            />
          );
        })}
      </div>
    </div>
  );
}
