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
import { useSplit } from '@/lib/useSplit';
import Splitter from './Splitter';

interface Props {
  /** Report the total unread across all workspaces (for the header tab badge). */
  onUnread?: (total: number) => void;
  /** Whether the Workspace TAB itself is the visible one. An account counts as
   *  "being read" only when the tab is visible AND it is the selected account —
   *  selection alone must not clear its unread while the user is on another tab. */
  visible?: boolean;
}

/** A short two-note chime for a new message. Lazily creates the AudioContext. */
export function useChime(): () => void {
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
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const railSplit = useSplit({ varName: '--ws-rail', min: 120, max: 420, gap: 14 });
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
  /** App đã bị gỡ sạch tài khoản — hiện ở cụm "Đã gỡ" cuối rail để thêm lại. */
  const removed = useMemo(
    () => plugins.filter((p) => !(accounts[p.id] ?? []).length),
    [plugins, accounts],
  );

  // keepAlive plugins (e.g. Zalo) open eagerly even under lazyLoad — they exist
  // to run in the background and raise new-message alerts, which requires their
  // guest to be alive BEFORE the user ever opens this tab. Other plugins stay lazy.
  const eagerKeys = useMemo(
    () =>
      (cfg.lazyLoad ? allAccounts.filter((a) => !!getPlugin(a.pluginId)?.keepAlive) : allAccounts)
        .map((a) => accountKey(a.pluginId, a.instanceId))
        .slice(0, Math.max(1, cfg.maxActiveWorkspace)),
    [allAccounts, cfg.lazyLoad, cfg.maxActiveWorkspace],
  );
  const [activeKey, setActiveKey] = useState<string>(eagerKeys[0] ?? '');
  const [openKeys, setOpenKeys] = useState<string[]>(eagerKeys);

  // Unread per open account → aggregate for badges + chime.
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  /** Tài khoản đã gỡ, đang chờ xoá phiên trên đĩa sau khi guest unmount. */
  const [pendingWipe, setPendingWipe] = useState<{ key: string; partition: string }[]>([]);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    setMuted(typeof window !== 'undefined' && localStorage.getItem('ws:muted') === '1');
  }, []);
  const chime = useChime();

  /**
   * Tài khoản đang ẩn thông báo → số của nó dừng lại ở dòng của chính nó.
   *
   * `unread` giữ số THẬT của mọi tài khoản (dòng trong rail đọc thẳng từ đó).
   * Mọi thứ dội RA NGOÀI — huy hiệu nhóm, huy hiệu tab Workspace, tiêu đề cửa
   * sổ, chuông báo — đều đi qua `audible` này. Một chỗ lọc duy nhất, nên không
   * có đường nào lọt: thêm một chỗ hiện huy hiệu sau này cũng chỉ việc đọc nó.
   */
  const isMuted = useCallback(
    (key: string) => {
      const [pluginId, instanceId] = key.split('::');
      return !!(accounts[pluginId] ?? []).find((a) => a.instanceId === instanceId)?.muted;
    },
    [accounts],
  );

  const audible = useCallback(
    (key: string) => (isMuted(key) ? 0 : unread[key] ?? 0),
    [isMuted, unread],
  );

  const total = useMemo(
    () => Object.entries(unread).reduce((sum, [key, n]) => sum + (isMuted(key) ? 0 : n), 0),
    [unread, isMuted],
  );
  const prevTotal = useRef(0);
  // Bỏ ẩn một tài khoản đang có tin chưa đọc làm `total` nhảy vọt — nhưng đó là
  // tin CŨ vừa được tính lại, không phải tin mới đến. Chuông chỉ được kêu vì
  // tin mới, nên lần chạy ngay sau khi đổi cờ ẩn chỉ ghi lại mốc, không kêu.
  const mutedSig = useMemo(
    () => allAccounts.map((a) => (a.muted ? '1' : '0')).join(''),
    [allAccounts],
  );
  const prevMutedSig = useRef(mutedSig);
  useEffect(() => {
    const remuted = prevMutedSig.current !== mutedSig;
    prevMutedSig.current = mutedSig;
    if (total > prevTotal.current && !muted && !remuted) chime();
    prevTotal.current = total;
    onUnread?.(total);
  }, [total, muted, chime, onUnread, mutedSig]);

  // Đẩy trạng thái ẨN THÔNG BÁO xuống main process: main chặn quyền
  // `notifications` của guest theo partition — nhờ vậy 🔕 không chỉ im chuông
  // trong app mà notification WINDOWS từ chính trang (chat.zalo.me…) cũng im.
  // Không có cầu (chạy web thuần / preload cũ) thì thôi, không có gì để chặn.
  useEffect(() => {
    const bridge = window.workspace;
    if (!bridge?.setNotifMuted) return;
    const parts = allAccounts
      .filter((a) => a.muted)
      .map((a) => `ws-${a.pluginId}-${a.instanceId}`);
    void bridge.setNotifMuted(parts, muted).catch(() => {});
  }, [allAccounts, muted, mutedSig]);

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

  /**
   * A capture-capable account must stay mounted while capture is on: only a
   * mounted guest polls, so an evicted account silently stops feeding
   * automation even though its rules are enabled and in scope.
   */
  const pinned = useCallback(
    (key: string) => {
      const plugin = getPlugin(key.split('::')[0]);
      if (!plugin) return false;
      return !!plugin.keepAlive || (captureOn && !!plugin.capture);
    },
    [captureOn],
  );

  // Turning capture on must reach EVERY messaging account, not just the ones
  // that happened to be open — a rule scoped to "Tất cả" is otherwise silently
  // limited to whichever account the LRU last kept. Mounted-but-not-active
  // guests sit offscreen and keep polling, so this costs nothing visually.
  useEffect(() => {
    if (!captureOn) return;
    const wanted = allAccounts
      .filter((a) => !!getPlugin(a.pluginId)?.capture)
      .map((a) => accountKey(a.pluginId, a.instanceId));
    setOpenKeys((prev) => {
      const missing = wanted.filter((k) => !prev.includes(k));
      return missing.length ? [...prev, ...missing] : prev;
    });
  }, [captureOn, allAccounts]);

  const select = useCallback(
    (key: string) => {
      setOpenKeys((prev) => {
        const next = prev.filter((x) => x !== key).concat(key); // most-recent last
        const cap = cfg.keepAlive ? Math.max(1, cfg.maxActiveWorkspace) : 1;
        let result = next;
        while (result.length > cap) {
          const victim = result.findIndex((x) => x !== key && !pinned(x));
          if (victim === -1) break; // everything left is pinned
          result = result.filter((_, i) => i !== victim);
        }
        return result;
      });
      setActiveKey(key);
    },
    [cfg.keepAlive, cfg.maxActiveWorkspace, pinned],
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
        const acc = newAccount(plugin, list);
        const next = [...list, acc];
        saveAccounts(pluginId, next);
        // Open the new account right away.
        setTimeout(() => select(accountKey(pluginId, acc.instanceId)), 0);
        return { ...prev, [pluginId]: next };
      });
    },
    [select],
  );

  /** Bật/tắt "ẩn thông báo" cho một tài khoản (ghi xuống localStorage luôn). */
  const toggleAccountMuted = useCallback((pluginId: string, instanceId: string) => {
    setAccounts((prev) => {
      const next = (prev[pluginId] ?? []).map((a) =>
        a.instanceId === instanceId ? { ...a, muted: !a.muted } : a,
      );
      saveAccounts(pluginId, next);
      return { ...prev, [pluginId]: next };
    });
  }, []);

  /** Ảnh đại diện đọc được từ guest → ghim vào tài khoản (và xuống đĩa). */
  const setAccountAvatar = useCallback((pluginId: string, instanceId: string, avatar: string) => {
    setAccounts((prev) => {
      const list = prev[pluginId] ?? [];
      // Ảnh không đổi thì thôi: mỗi lần ghi là một lượt render cả rail + một
      // lượt JSON.stringify xuống localStorage.
      if (list.some((a) => a.instanceId === instanceId && a.avatar === avatar)) return prev;
      const next = list.map((a) => (a.instanceId === instanceId ? { ...a, avatar } : a));
      saveAccounts(pluginId, next);
      return { ...prev, [pluginId]: next };
    });
  }, []);

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
    (pluginId: string, instanceId: string) => {
      const plugin = getPlugin(pluginId);
      if (!plugin) return;
      const list = accounts[pluginId] ?? [];
      const label = list.find((a) => a.instanceId === instanceId)?.label ?? '';
      // Gỡ cái CUỐI CÙNG là cả app biến khỏi rail — nói thẳng ra, kèm đường về,
      // để không ai bấm xong rồi tưởng mất luôn không thêm lại được.
      const last = list.length <= 1;
      if (
        !window.confirm(
          last
            ? `Gỡ "${label}" và đăng xuất phiên này trên máy?\n\n` +
              `Đây là tài khoản cuối của ${plugin.name} — gỡ xong ${plugin.name} sẽ biến khỏi danh sách ` +
              `Workspaces. Bấm "＋ ${plugin.name}" ở cuối rail là thêm lại được (phải đăng nhập lại).`
            : `Xoá "${label}" và đăng xuất phiên này trên máy?`,
        )
      )
        return;
      const key = accountKey(pluginId, instanceId);
      // THỨ TỰ QUAN TRỌNG: bỏ tài khoản khỏi state TRƯỚC, xoá phiên SAU.
      //
      // Xoá phiên trong lúc <webview> của nó còn sống thì guest vẫn đang chạy:
      // lúc gỡ xuống nó ghi nốt cookie/localStorage ra đĩa, đè lên phần vừa
      // xoá — gỡ xong mở lại vẫn thấy đăng nhập. Nên chỉ đánh dấu ở đây, để
      // effect bên dưới xoá sau khi React đã unmount guest thật sự.
      setPendingWipe((prev) =>
        prev.some((w) => w.key === key)
          ? prev
          : [...prev, { key, partition: partitionForAccount(plugin, instanceId, cfg) }],
      );
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

  /**
   * Xoá phiên trên đĩa SAU KHI guest đã unmount.
   *
   * Effect chạy sau commit, mà lúc commit đó `openKeys` đã bỏ key ra rồi nên
   * <webview> tương ứng đã bị gỡ khỏi DOM — tới đây mới không còn ai ghi ngược
   * vào partition nữa. Chờ thêm một nhịp macrotask để Electron kịp huỷ hẳn
   * webContents trước khi clearStorageData chạy.
   */
  useEffect(() => {
    if (!pendingWipe.length) return;
    // Guest chưa gỡ hết thì chưa xoá — đợi commit sau.
    const ready = pendingWipe.filter((w) => !openKeys.includes(w.key));
    if (!ready.length) return;
    let alive = true;
    const t = setTimeout(async () => {
      for (const w of ready) {
        try {
          await window.workspace?.clearSession(w.partition);
        } catch {
          /* phiên xoá hụt thì lần gỡ sau vẫn xoá lại được — không chặn UI */
        }
      }
      if (!alive) return;
      const done = new Set(ready.map((w) => w.key));
      setPendingWipe((prev) => prev.filter((w) => !done.has(w.key)));
    }, 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [pendingWipe, openKeys]);

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
    <div className="ws-shell" ref={railSplit.ref} style={railSplit.style}>
      <aside className="ws-rail">
        <div className="ws-rail-head">
          <span className="ws-rail-head-t">Workspaces</span>
          <button
            className="ws-icon-btn"
            onClick={toggleMute}
            // Chuông ở đầu rail = ÂM THANH cho tất cả. Chuông trên mỗi dòng =
            // ẩn thông báo của riêng tài khoản đó. Nói rõ trong tooltip để hai
            // cái không bị hiểu lẫn nhau.
            title={muted ? 'Bật chuông báo (toàn bộ workspace)' : 'Tắt chuông báo (toàn bộ workspace)'}
          >
            {muted ? '🔕' : '🔔'}
          </button>
        </div>

        {plugins.map((plugin) => {
          const list = accounts[plugin.id] ?? [];
          const multi = !!plugin.multiAccount;
          // Huy hiệu nhóm chỉ cộng tài khoản KHÔNG ẩn — ẩn một tài khoản mà đầu
          // nhóm vẫn sáng số của nó thì coi như chưa ẩn.
          const groupUnread = list.reduce(
            (sum, a) => sum + audible(accountKey(plugin.id, a.instanceId)),
            0,
          );

          // Gỡ hết tài khoản = app không còn trong rail. Nó quay lại qua hàng
          // "＋" ở cuối rail, nên ở đây chỉ việc không vẽ.
          if (!list.length) return null;

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
                      className={`ws-acct${isActive ? ' is-active' : ''}${acc.muted ? ' is-muted' : ''}`}
                      onClick={() => select(key)}
                      title={
                        `${plugin.name} — ${acc.label}` +
                        (acc.muted ? ' · đang ẩn thông báo' : '')
                      }
                    >
                      {/* Có ảnh đại diện thật thì hiện mặt người — hai tài khoản
                          Zalo cạnh nhau chỉ phân biệt được bằng cái này. Huy hiệu
                          app lùi xuống góc, KHÔNG bỏ hẳn: dòng "Sếp" vẫn phải nói
                          được nó nằm ở app nào. Chưa có ảnh thì như cũ. */}
                      {acc.avatar ? (
                        <span className={`ws-acct-ava${alive ? '' : ' is-faded'}`}>
                          <img src={acc.avatar} alt="" width={22} height={22} />
                          <BrandMark plugin={plugin} size={11} className="ws-acct-ava-mark" />
                        </span>
                      ) : (
                        <BrandMark plugin={plugin} size={14} faded={!alive} />
                      )}
                      <span className="ws-acct-name">{acc.label}</span>
                      {/* Số THẬT, kể cả khi đang ẩn: ẩn là không dội ra ngoài,
                          chứ ngay tại dòng này vẫn phải thấy có gì mới. Ẩn thì
                          để huy hiệu ở dạng lặng (xám) cho khỏi bắt mắt. */}
                      {n > 0 && (
                        <span className={`ws-unread sm${acc.muted ? ' is-quiet' : ''}`}>
                          {n > 99 ? '99+' : n}
                        </span>
                      )}
                      {alive && <span className={`ws-rail-live${isActive ? '' : ' is-bg'}`} />}
                      <button
                        className={`ws-acct-btn${acc.muted ? ' is-on' : ''}`}
                        title={
                          acc.muted
                            ? 'Đang ẩn thông báo — bấm để báo lại như bình thường'
                            : 'Ẩn thông báo: chỉ hiện số ngay dòng này, không báo ra ngoài'
                        }
                        aria-pressed={!!acc.muted}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleAccountMuted(plugin.id, acc.instanceId);
                        }}
                      >
                        {acc.muted ? '🔕' : '🔔'}
                      </button>
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
                          {/* Gỡ được cả tài khoản cuối: một app không dùng thì
                              phải bỏ hẳn khỏi rail được, không thì "sửa được mà
                              không xoá được". Thêm lại ở hàng "＋" cuối rail. */}
                          <button
                            className="ws-acct-btn danger"
                            title={list.length > 1 ? 'Gỡ tài khoản' : `Gỡ tài khoản — ${plugin.name} sẽ biến khỏi danh sách`}
                            onClick={(e) => {
                              e.stopPropagation();
                              removeAccount(plugin.id, acc.instanceId);
                            }}
                          >
                            ×
                          </button>
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

        {/* Đường về cho những app đã gỡ hết tài khoản — không có hàng này thì
            "gỡ" thành một chiều, muốn dùng lại phải xoá localStorage. */}
        {removed.length > 0 && (
          <div className="ws-group ws-group-restore">
            <div className="ws-group-head">
              <span className="ws-rail-name ws-muted">Đã gỡ</span>
            </div>
            <div className="ws-acct-list">
              {removed.map((plugin) => (
                <button
                  key={plugin.id}
                  className="ws-acct-add"
                  title={`Thêm lại ${plugin.name} (phải đăng nhập lại)`}
                  onClick={() => addAccount(plugin.id)}
                >
                  ＋ {plugin.name}
                </button>
              ))}
            </div>
          </div>
        )}
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
              onAvatar={(url) => setAccountAvatar(pluginId, instanceId, url)}
            />
          );
        })}
      </div>
      <Splitter {...railSplit.grip} />
    </div>
  );
}
