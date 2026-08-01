// Shared env gates for the Office tab (Sheet = Excel/CSV, Word = docx).
// OFFICE_* is the canonical name; SHEET_* still works as a fallback so
// existing .env.local files keep functioning.

const on = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? '');

export const OFFICE_ENABLED = on(process.env.OFFICE_TOOL_ENABLED ?? process.env.SHEET_TOOL_ENABLED);
/** Global write gate — every save action refuses without it. */
export const OFFICE_ALLOW_WRITE = on(process.env.OFFICE_ALLOW_WRITE ?? process.env.SHEET_ALLOW_WRITE);
