// Server-only filesystem browsing for the shared folder picker.
//
// Lets the UI walk the host's folders to pick a path (project root for the Git
// workspace, pack root for ＋ Projects), since a browser can't read absolute
// paths. Every path is path.resolve()'d — never string-concatenated from client
// input — and only directory listings (name + isRepo/hasMarker hints) are ever
// returned, never file contents. There is no base restriction: folder layout is
// per-machine and the caller already has the developer's own filesystem access.

import { promises as fs } from 'fs';
import path from 'path';
import { browseStart } from './gitProjects';

export interface DirEntry {
  name: string;
  path: string;
  /** True when the directory itself is a git working tree (has a .git entry). */
  isRepo: boolean;
  /** True when the directory holds the caller's `marker` file. Set only when asked. */
  hasMarker?: boolean;
}

export interface BrowseResult {
  /** Absolute path being listed. Empty string = the drive/root list (Windows). */
  path: string;
  /** Parent path to go "up" to, or null at the top (drive list / fs root). */
  parent: string | null;
  /** Immediate sub-directories, sorted. On the top level these are drives. */
  entries: DirEntry[];
  /** True when `path` is "" — i.e. entries are drive roots, not real folders. */
  isDriveList: boolean;
  /** Whether the listed folder ITSELF holds `marker`. Set only when asked. */
  markerHere?: boolean;
}

/** Enumerate Windows drive letters that exist (C:\, D:\, …). */
async function listDrives(): Promise<DirEntry[]> {
  const drives: DirEntry[] = [];
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const root = String.fromCharCode(c) + ':\\';
    try {
      await fs.access(root);
      drives.push({ name: String.fromCharCode(c) + ':', path: root, isRepo: false });
    } catch {
      /* drive not present */
    }
  }
  return drives;
}

/** Does `dir` contain `name` (dir or file)? Cheap hint for the picker. */
async function contains(dir: string, name: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, name));
    return true;
  } catch {
    return false;
  }
}

/** A marker must be a plain file name — never a path fragment that escapes `dir`. */
function safeMarker(marker?: string): string | undefined {
  const m = (marker ?? '').trim();
  if (!m) return undefined;
  if (m !== path.basename(m)) return undefined;
  return m;
}

/**
 * List the sub-directories of `target`. When `target` is empty/undefined, start at
 * browseStart(). On Windows, going "up" from a drive root (e.g. C:\) yields the
 * drive list (path ""). Hidden/system dirs are included except node_modules and
 * .git (noise for a root picker). Never throws for a normal unreadable dir — it
 * surfaces as an empty listing.
 *
 * `marker` (optional plain file name, e.g. `devbox.api.json`) adds a `hasMarker`
 * flag per entry plus `markerHere` for the listed folder, so the UI can point at
 * the folder the user actually wants.
 */
export async function browse(target?: string, marker?: string): Promise<BrowseResult> {
  const mark = safeMarker(marker);
  // Empty target → the drive list on Windows, or "/" elsewhere.
  const isWin = process.platform === 'win32';
  if (target === '' && isWin) {
    return { path: '', parent: null, entries: await listDrives(), isDriveList: true };
  }

  const start = target && target.trim() ? path.resolve(target.trim()) : browseStart();

  // Determine the parent. At a drive root (C:\) the parent is the drive list ("")
  // on Windows; at the fs root ("/") there is no parent.
  const parentRaw = path.dirname(start);
  let parent: string | null;
  if (parentRaw === start) {
    parent = isWin ? '' : null; // C:\ → drive list; / → nothing
  } else {
    parent = parentRaw;
  }

  let dirents;
  try {
    dirents = await fs.readdir(start, { withFileTypes: true });
  } catch {
    // Unreadable (permissions, gone) → empty listing but keep navigation working.
    return { path: start, parent, entries: [], isDriveList: false };
  }

  const dirs = dirents.filter((d) => {
    if (!d.isDirectory()) return false;
    if (d.name === 'node_modules' || d.name === '.git') return false;
    return true;
  });

  const entries: DirEntry[] = await Promise.all(
    dirs
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (d): Promise<DirEntry> => {
        const full = path.join(start, d.name);
        const e: DirEntry = { name: d.name, path: full, isRepo: await contains(full, '.git') };
        if (mark) e.hasMarker = await contains(full, mark);
        return e;
      }),
  );

  const result: BrowseResult = { path: start, parent, entries, isDriveList: false };
  if (mark) result.markerHere = await contains(start, mark);
  return result;
}
