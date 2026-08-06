'use client';

// Office workspace — one tab, two editors: ▦ Bảng tính (Excel/CSV) and
// 🗎 Văn bản (Word .docx). This shell only owns the section switcher; each
// editor is self-contained (own file state, recents, save flow) and stays
// MOUNTED once visited so an open document survives switching sections —
// same mount-and-keep pattern as the app's top-level tabs.
//
// Markdown (.md) KHÔNG ở đây — nó là định dạng text nên nằm ở tab Tools cùng
// JSON / XML / HTML (xem components/ToolsWorkspace.tsx).

import { useEffect, useState, type CSSProperties } from 'react';
import SheetWorkspace from './SheetWorkspace';
import WordWorkspace from './WordWorkspace';

type Section = 'sheet' | 'word';

const LAST_SECTION_KEY = 'office.lastSection';

const SECTIONS: { key: Section; icon: string; label: string; hint: string }[] = [
  { key: 'sheet', icon: '▦', label: 'Bảng tính', hint: 'Excel (.xlsx) · CSV' },
  { key: 'word', icon: '🗎', label: 'Văn bản', hint: 'Word (.docx)' },
];

/** Overlay panes in the same grid cell; hide inactive with visibility (keeps
 *  layout + scroll state — no <webview> here so this is always safe). */
function paneStyle(on: boolean): CSSProperties {
  if (on) return { gridColumn: '1 / -1', gridRow: '1', minHeight: 0, display: 'flex', flexDirection: 'column' };
  return {
    gridColumn: '1 / -1', gridRow: '1', minHeight: 0, display: 'flex', flexDirection: 'column',
    visibility: 'hidden', pointerEvents: 'none',
  };
}

export default function OfficeWorkspace() {
  const [section, setSection] = useState<Section>('sheet');
  const [visited, setVisited] = useState<Record<Section, boolean>>({ sheet: false, word: false });

  useEffect(() => {
    const last = window.localStorage.getItem(LAST_SECTION_KEY);
    if (last === 'word' || last === 'sheet') setSection(last);
  }, []);
  useEffect(() => {
    setVisited((v) => (v[section] ? v : { ...v, [section]: true }));
    try { window.localStorage.setItem(LAST_SECTION_KEY, section); } catch { /* nicety */ }
  }, [section]);

  return (
    <div className="office-layout">
      <div className="office-subnav" role="tablist" aria-label="Office editors">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            role="tab"
            aria-selected={section === s.key}
            className={`office-subnav-btn${section === s.key ? ' on' : ''}`}
            onClick={() => setSection(s.key)}
          >
            <span className="office-subnav-ico" aria-hidden>{s.icon}</span>
            <span className="office-subnav-text">
              {s.label}
              <span className="office-subnav-hint">{s.hint}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="office-body">
        {visited.sheet && (
          <div style={paneStyle(section === 'sheet')} aria-hidden={section !== 'sheet'}>
            <SheetWorkspace />
          </div>
        )}
        {visited.word && (
          <div style={paneStyle(section === 'word')} aria-hidden={section !== 'word'}>
            <WordWorkspace />
          </div>
        )}
      </div>
    </div>
  );
}
