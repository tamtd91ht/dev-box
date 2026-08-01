// Browser Workspace Framework — config + partition helpers (renderer side).
//
// Defaults live here; the main process may override them from
// userData/workspace.config.json and hands the merged result to the renderer
// through window.workspace.config. Nothing here is hardcoded per plugin.

import type { WorkspaceConfig } from './types';

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
  persistSession: true,
  lazyLoad: true,
  maxActiveWorkspace: 3,
  keepAlive: true,
  allowDownload: true,
  enableDevTools: true, // ⚙ on the toolbar — handy for inspecting a guest (e.g. unread detection)
};

/** True only inside the Electron desktop shell (the bridge is injected there). */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && !!window.workspace?.isDesktop;
}

/** Effective config = defaults merged with whatever the main process resolved. */
export function resolveConfig(): WorkspaceConfig {
  const injected = typeof window !== 'undefined' ? window.workspace?.config : undefined;
  return { ...DEFAULT_WORKSPACE_CONFIG, ...(injected ?? {}) };
}

// Session partitions are derived per account in lib/workspace/accounts.ts
// (partitionForAccount) — one persistent partition per account instance.
