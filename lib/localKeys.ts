// localStorage keys + one-time migration off the old org-specific prefix.
//
// Keys used to be namespaced `omicx.*` — a leftover from the repo this tool was
// forked from. The tool is generic, so the prefix is now `devbox.*`. A plain
// rename would silently orphan every saved connection, preset, and quick-find
// already in users' browsers, so reads fall back to the legacy key and migrate
// the value across on first touch.
//
// Drop `legacyKey`/the fallback once enough time has passed that no browser
// still holds `omicx.*` data.

/** Current prefix for every localStorage key this app owns. */
const PREFIX = 'devbox';
/** The pre-rename prefix, still read as a fallback. */
const LEGACY_PREFIX = 'omicx';

/** Build the current key from a dotted suffix, e.g. key('pg.lastConn'). */
export function key(suffix: string): string {
  return `${PREFIX}.${suffix}`;
}

/** The legacy key for the same suffix. */
function legacyKey(suffix: string): string {
  return `${LEGACY_PREFIX}.${suffix}`;
}

/**
 * Read `suffix`, falling back to the legacy `omicx.*` key. When only the legacy
 * value exists it is copied to the new key and the old one removed, so the
 * fallback costs nothing after the first read.
 *
 * SSR-safe: returns null when there is no `window`.
 */
export function readLocal(suffix: string): string | null {
  if (typeof window === 'undefined') return null;
  const k = key(suffix);
  try {
    const current = window.localStorage.getItem(k);
    if (current !== null) return current;
    const old = window.localStorage.getItem(legacyKey(suffix));
    if (old === null) return null;
    // Migrate, then serve. Wrapped because storage can throw (quota, privacy mode).
    try {
      window.localStorage.setItem(k, old);
      window.localStorage.removeItem(legacyKey(suffix));
    } catch {
      /* keep the legacy value in place; we still return it below */
    }
    return old;
  } catch {
    return null;
  }
}

/** Write `suffix`. Never throws (private mode / quota). */
export function writeLocal(suffix: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key(suffix), value);
  } catch {
    /* best effort — losing a "last selected" hint is not worth an exception */
  }
}

/** Remove `suffix` under both the current and legacy prefixes. */
export function removeLocal(suffix: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key(suffix));
    window.localStorage.removeItem(legacyKey(suffix));
  } catch {
    /* ignore */
  }
}
