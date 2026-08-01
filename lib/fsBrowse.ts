// Server-only filesystem browsing for the shared folder picker.
//
// Lets the UI walk the host's folders to pick a path (project root for the Git
// workspace, pack root for ＋ Projects, a spreadsheet for the Sheet tab), since
// a browser can't read absolute paths. Every path is path.resolve()'d — never
// string-concatenated from client input — and only listings are ever returned:
// directory names (+ isRepo/hasMarker hints) and, when the caller passes `exts`,
// file names + size/mtime for those extensions. NEVER file contents. There is
// no base restriction: folder layout is per-machine and the caller already has
// the developer's own filesystem access.

import { promises as fs } from 'fs';
import os from 'os';
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

export interface FileEntry {
  name: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
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
  /** Files matching the caller's `exts`, sorted. Only present when exts asked. */
  files?: FileEntry[];
  /** Quick-access places (Desktop, Documents, … như hộp thoại Windows). */
  shortcuts?: QuickPlace[];
}

export interface QuickPlace {
  name: string;
  /** Absolute path, or "" for the Windows drive list. */
  path: string;
  icon: string;
}

/** Quick-access places that actually exist on this machine — Desktop/Documents
 *  (bao gồm bản OneDrive-redirected), Downloads, Home, danh sách ổ đĩa. Cached:
 *  the layout doesn't change while the server runs. */
let quickCache: QuickPlace[] | null = null;
async function quickPlaces(): Promise<QuickPlace[]> {
  if (quickCache) return quickCache;
  const home = os.homedir();
  const candidates: { name: string; icon: string; paths: string[] }[] = [
    { name: 'Desktop', icon: '🖥️', paths: [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop')] },
    { name: 'Documents', icon: '📑', paths: [path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents')] },
    { name: 'Downloads', icon: '⬇️', paths: [path.join(home, 'Downloads')] },
    { name: 'Home', icon: '🏠', paths: [home] },
  ];
  const out: QuickPlace[] = [];
  for (const c of candidates) {
    for (const p of c.paths) {
      try {
        if ((await fs.stat(p)).isDirectory()) { out.push({ name: c.name, icon: c.icon, path: p }); break; }
      } catch { /* not on this machine */ }
    }
  }
  if (process.platform === 'win32') out.push({ name: 'Ổ đĩa', icon: '🖴', path: '' });
  quickCache = out;
  return out;
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

/** Extensions must be bare alphanumerics ("xlsx", "csv") — no dots, no globs. */
function safeExts(exts?: string[]): string[] | undefined {
  if (!Array.isArray(exts)) return undefined;
  const ok = exts
    .map((e) => String(e ?? '').trim().toLowerCase())
    .filter((e) => /^[a-z0-9]{1,10}$/.test(e));
  return ok.length > 0 ? ok : undefined;
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
 *
 * `exts` (optional, e.g. ['xlsx','csv']) additionally lists the folder's FILES
 * with those extensions (name + size + mtime, never contents) in `files`, so a
 * picker can select a file instead of a folder. Omitted → directories only,
 * identical to the historical behaviour.
 */
export async function browse(target?: string, marker?: string, exts?: string[]): Promise<BrowseResult> {
  const mark = safeMarker(marker);
  const fileExts = safeExts(exts);
  // Empty target → the drive list on Windows, or "/" elsewhere.
  const isWin = process.platform === 'win32';
  if (target === '' && isWin) {
    return {
      path: '', parent: null, entries: await listDrives(), isDriveList: true,
      shortcuts: await quickPlaces(),
    };
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
    return { path: start, parent, entries: [], isDriveList: false, shortcuts: await quickPlaces() };
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

  const result: BrowseResult = {
    path: start, parent, entries, isDriveList: false,
    shortcuts: await quickPlaces(),
  };
  if (mark) result.markerHere = await contains(start, mark);

  if (fileExts) {
    const wanted = dirents.filter(
      (d) => d.isFile() && fileExts.includes(path.extname(d.name).slice(1).toLowerCase()),
    );
    const files = await Promise.all(
      wanted
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async (d): Promise<FileEntry | null> => {
          const full = path.join(start, d.name);
          try {
            const st = await fs.stat(full);
            return { name: d.name, path: full, sizeBytes: st.size, mtimeMs: st.mtimeMs };
          } catch {
            return null; // vanished between readdir and stat — just skip it
          }
        }),
    );
    result.files = files.filter((f): f is FileEntry => f !== null);
  }

  return result;
}
