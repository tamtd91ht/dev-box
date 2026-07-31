// DEPRECATED — superseded by lib/fsBrowse.ts.
//
// Folder browsing is no longer git-specific: one picker now serves the Git
// workspace AND ＋ Projects (pack root), so the implementation moved to
// lib/fsBrowse.ts (same code + optional `marker` flagging). This module stays as
// a thin re-export so the legacy /api/git-fs endpoint keeps working; new code
// should import '@/lib/fsBrowse'. Safe to delete together with /api/git-fs.

export { browse, type BrowseResult, type DirEntry } from './fsBrowse';
