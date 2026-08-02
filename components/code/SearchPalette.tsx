'use client';

// Code Studio — Search Everywhere (Ctrl+Shift+N / Shift Shift của IntelliJ):
// gõ tên class / method / file → 3 nhóm kết quả từ symbol index server, hỗ trợ
// camel-hump ("OCS" ra OmiCallService). ↑↓ chọn, Enter mở đúng dòng, Esc đóng.

import { useEffect, useMemo, useRef, useState } from 'react';
import { cNav, symbolIcon, fileIcon, type NavResult } from '@/lib/code';

interface Props {
  projectId: string;
  onOpen: (rel: string, line?: number) => void;
  onClose: () => void;
}

interface Row {
  section: string;
  icon: string;
  label: string;
  detail: string;
  rel: string;
  line?: number;
}

export default function SearchPalette({ projectId, onOpen, onClose }: Props) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<NavResult | null>(null);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const seqRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Debounce 150ms + drop kết quả cũ về muộn.
  useEffect(() => {
    if (!q.trim()) {
      setRes(null);
      return;
    }
    const seq = ++seqRef.current;
    setBusy(true);
    const t = setTimeout(() => {
      cNav(projectId, q)
        .then((r) => {
          if (seqRef.current === seq) {
            setRes(r);
            setSel(0);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (seqRef.current === seq) setBusy(false);
        });
    }, 150);
    return () => clearTimeout(t);
  }, [q, projectId]);

  const rows = useMemo<Row[]>(() => {
    if (!res) return [];
    const out: Row[] = [];
    for (const c of res.classes) {
      out.push({ section: 'Classes', icon: symbolIcon(c.kind), label: c.name, detail: `${c.rel}:${c.line}`, rel: c.rel, line: c.line });
    }
    for (const s of res.symbols.slice(0, 40)) {
      out.push({ section: 'Symbols', icon: symbolIcon(s.kind), label: s.name, detail: `${s.rel}:${s.line}`, rel: s.rel, line: s.line });
    }
    for (const f of res.files) {
      out.push({ section: 'Files', icon: fileIcon(f.name, 'file'), label: f.name, detail: f.rel, rel: f.rel });
    }
    return out;
  }, [res]);

  // Giữ dòng chọn trong khung nhìn.
  useEffect(() => {
    listRef.current?.querySelector('.cs-pal-row.on')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const pick = (r: Row) => {
    onOpen(r.rel, r.line);
    onClose();
  };

  return (
    <div className="cs-ask-backdrop" onClick={onClose}>
      <div className="cs-pal" onClick={(e) => e.stopPropagation()}>
        <div className="cs-pal-head">
          <span aria-hidden>🔍</span>
          <input
            autoFocus
            className="cs-pal-input"
            placeholder="Tìm class, method, file…  (hỗ trợ CamelHump: OCS → OmiCallService)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, rows.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === 'Enter' && rows[sel]) pick(rows[sel]);
            }}
          />
          {busy && <span className="spinner" aria-hidden />}
        </div>
        <div className="cs-pal-list" ref={listRef}>
          {rows.map((r, i) => (
            <div key={`${r.section}-${r.rel}-${r.line ?? 0}-${i}`}>
              {(i === 0 || rows[i - 1].section !== r.section) && (
                <div className="cs-pal-section">{r.section}</div>
              )}
              <button
                className={`cs-pal-row${i === sel ? ' on' : ''}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => pick(r)}
                title={r.detail}
              >
                <span className="cs-pal-ico" aria-hidden>{r.icon}</span>
                <span className="cs-pal-name">{r.label}</span>
                <span className="cs-pal-detail">{r.detail}</span>
              </button>
            </div>
          ))}
          {q.trim() && !busy && rows.length === 0 && (
            <div className="cs-pal-empty">Không tìm thấy “{q}”.</div>
          )}
          {!q.trim() && (
            <div className="cs-pal-empty">
              Gõ để tìm khắp project — class (Ⓒ), method (ⓜ), hằng số (ⓕ), file.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
