'use client';

// Browser Workspace Framework — the guest bridge.
//
// A `<webview>` can only be driven by the React component that owns its ref, but
// the things that WANT to drive it (the automation runtime, a directory sync,
// any future "do X in that app" feature) live nowhere near that component. This
// module is the one place where "account `zalo::a3f1c`" resolves to "the live
// guest you can run script in".
//
//   WorkspaceView (owns the <webview>) ──register──▶ [ guests registry ]
//                                                          │
//   automation / directory sync ──getGuest(accountKey)──────┘──▶ exec(script)
//
// Why a module singleton rather than context: the Workspace pane is mounted once
// and merely moved offscreen when another DevBox tab is active (see
// WorkspaceView's style comment), while the callers sit outside that tree
// entirely. A context would have forced them under one provider.
//
// Zalo declares `keepAlive`, so its guests are mounted eagerly at startup and
// stay alive on every tab — that is what makes "send from the Kafka tab" work at
// all. A guest that is NOT mounted simply isn't in the map, and callers must say
// so out loud instead of silently doing nothing.

export interface GuestHandle {
  /** `${pluginId}::${instanceId}` — same key the rail and rule scopes use. */
  accountKey: string;
  pluginId: string;
  instanceId: string;
  /** Account label, for error messages a human can act on. */
  label: string;
  /** True once the guest reported dom-ready and has not crashed. */
  ready: boolean;
  /**
   * Run a self-contained JS expression inside the guest and resolve with its
   * value (a Promise-returning expression is awaited by Electron). Rejects when
   * the guest is detached — never swallow that: a send must not report success.
   *
   * `userGesture` marks the script as user-initiated. Editing commands
   * (`document.execCommand('insertText')`) and other gesture-gated APIs refuse
   * to run without it in a background page — which is exactly the situation
   * here, since the workspace pane sits offscreen while rules fire from other
   * tabs. Read-only probes leave it off.
   */
  exec(script: string, userGesture?: boolean): Promise<unknown>;
  /**
   * Send a TRUSTED key press into the guest (Electron `<webview>.sendInputEvent`).
   *
   * The whole reason a send "types but doesn't go out": a React composer checks
   * `event.isTrusted`, and anything from `dispatchEvent` is untrusted, so a
   * synthetic Enter is ignored. sendInputEvent originates in the browser
   * process — it is trusted exactly like a physical keystroke. The webview is
   * focused first so the key lands in whatever it has focused (the composer).
   */
  pressKey(keyCode: string): Promise<{ ok: boolean; focused?: boolean; error?: string; via?: string }>;
}

type Listener = () => void;

const guests = new Map<string, GuestHandle>();
const listeners = new Set<Listener>();
/** Snapshot for useSyncExternalStore — a new array only when membership changes. */
let snapshot: GuestHandle[] = [];

function emit(): void {
  snapshot = [...guests.values()];
  for (const l of listeners) l();
}

/** Register a live guest. Returns the unregister function for useEffect cleanup. */
export function registerGuest(handle: GuestHandle): () => void {
  guests.set(handle.accountKey, handle);
  emit();
  return () => {
    // Only drop it if it is still OURS: a remount can register the replacement
    // before the old effect cleans up, and removing then would blank a live guest.
    if (guests.get(handle.accountKey) === handle) {
      guests.delete(handle.accountKey);
      emit();
    }
  };
}

export const getGuest = (accountKey: string): GuestHandle | undefined => guests.get(accountKey);

export const listGuests = (): GuestHandle[] => snapshot;

export const subscribeGuests = (l: Listener): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * Resolve a guest or explain why not, in the words the UI should show. Every
 * caller needs the same three checks, and "nothing happened" is the worst
 * possible outcome for an automated send.
 */
export function requireGuest(accountKey: string): { guest?: GuestHandle; error?: string } {
  const guest = guests.get(accountKey);
  if (!guest) {
    return {
      error: 'tài khoản chưa mở trong tab Workspace (cần app desktop, và tài khoản phải còn trong danh sách)',
    };
  }
  if (!guest.ready) return { guest, error: `“${guest.label}” đang tải lại — thử lại sau vài giây` };
  return { guest };
}
