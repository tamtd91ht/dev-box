'use client';

// Rail Collection của tab API — kiểu sidebar Postman: cây thư mục gọn, chữ nhỏ,
// không viền từng dòng; nút thao tác chỉ hiện khi rê chuột.
//
// Cây dựng từ `folder` của request: "admin/call-export" = dự án "admin" →
// thư mục con "call-export". Request chưa phân dự án nằm cuối, không tiêu đề.
// Trạng thái thu gọn (closed) do workspace giữ (đã nhớ qua localStorage) —
// khoá là đường dẫn đầy đủ của thư mục.

import { useMemo, useState } from 'react';
import type { ApiData, ApiRequest } from '@/lib/api';
import { RailHideButton } from '../RailCollapse';

interface Node {
  name: string;
  path: string;
  folders: Node[];
  requests: ApiRequest[];
  /** Tổng request trong cả cây con. */
  count: number;
}

function buildTree(requests: ApiRequest[]): { roots: Node[]; loose: ApiRequest[] } {
  const top: Node = { name: '', path: '', folders: [], requests: [], count: 0 };
  const loose: ApiRequest[] = [];
  for (const r of requests) {
    const parts = (r.folder ?? '').split('/').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) { loose.push(r); continue; }
    let n = top;
    let path = '';
    for (const p of parts) {
      path = path ? `${path}/${p}` : p;
      let c = n.folders.find((f) => f.name === p);
      if (!c) { c = { name: p, path, folders: [], requests: [], count: 0 }; n.folders.push(c); }
      n = c;
    }
    n.requests.push(r);
  }
  const fin = (n: Node): number => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    n.requests.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    n.count = n.requests.length + n.folders.reduce((s, f) => s + fin(f), 0);
    return n.count;
  };
  fin(top);
  return { roots: top.folders, loose };
}

/** Mọi đường dẫn thư mục (để thu gọn tất cả). */
export function allFolderPaths(requests: ApiRequest[]): string[] {
  const s = new Set<string>();
  for (const r of requests) {
    const parts = (r.folder ?? '').split('/').map((x) => x.trim()).filter(Boolean);
    parts.forEach((_, i) => s.add(parts.slice(0, i + 1).join('/')));
  }
  return [...s];
}

const METHOD_SHORT: Record<string, string> = { DELETE: 'DEL', OPTIONS: 'OPT', PATCH: 'PATCH' };

export interface CollectionRailProps {
  data: ApiData;
  activeId?: string;
  openIds: Set<string>;
  closed: string[];
  onToggle: (path: string) => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onNew: (folder?: string) => void;
  onOpen: (r: ApiRequest) => void;
  onRequestMenu: (x: number, y: number, r: ApiRequest) => void;
  onFolderMenu: (x: number, y: number, path: string) => void;
  onReload: () => void;
  onHide: () => void;
  onImport: () => void;
  onExport: (scope: string) => void;
  onVars: () => void;
}

export default function CollectionRail(p: CollectionRailProps) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const reqs = useMemo(() => (needle
    ? p.data.requests.filter((r) => `${r.method} ${r.name} ${r.url} ${r.folder ?? ''}`.toLowerCase().includes(needle))
    : p.data.requests), [p.data.requests, needle]);
  const { roots, loose } = useMemo(() => buildTree(reqs), [reqs]);
  const anyFolder = roots.length > 0;
  const allClosed = anyFolder && p.closed.length > 0;
  const globalN = (p.data.globalVars ?? []).filter((v) => v.key.trim()).length;
  const projN = Object.keys(p.data.projectVars ?? {}).length;

  const reqRow = (r: ApiRequest, depth: number) => (
    <div key={r.id} className={`cr-row cr-req${p.activeId === r.id ? ' on' : ''}`}
      style={{ paddingLeft: 6 + depth * 12 }}
      onContextMenu={(e) => { e.preventDefault(); p.onRequestMenu(e.clientX, e.clientY, r); }}>
      <button className="cr-main" onClick={() => p.onOpen(r)}
        title={p.openIds.has(r.id) ? `${r.url}\n(đang mở — bấm để nhảy tới tab)` : r.url}>
        <span className={`cr-m api-m--${r.method.toLowerCase()}`}>{METHOD_SHORT[r.method] ?? r.method}</span>
        <span className="cr-name">{r.name}</span>
      </button>
      <button className="cr-act" title="Sửa / nhân bản / copy curl / xóa (hoặc chuột phải)" aria-haspopup="menu"
        onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); p.onRequestMenu(b.right - 220, b.bottom + 2, r); }}>⋯</button>
    </div>
  );

  const folderRow = (n: Node, depth: number): React.ReactNode => {
    // Đang tìm thì mở bung mọi thư mục có kết quả.
    const closed = !needle && p.closed.includes(n.path);
    return (
      <div key={n.path}>
        <div className="cr-row cr-folder" style={{ paddingLeft: 2 + depth * 12 }}
          onContextMenu={(e) => { e.preventDefault(); p.onFolderMenu(e.clientX, e.clientY, n.path); }}>
          <button className="cr-main" aria-expanded={!closed} onClick={() => p.onToggle(n.path)} title={n.path}>
            <span className="cr-caret" aria-hidden>{closed ? '▸' : '▾'}</span>
            <span className="cr-ficon" aria-hidden>{closed ? '📁' : '📂'}</span>
            <span className="cr-name">{n.name}</span>
            <span className="cr-n">{n.count}</span>
          </button>
          <button className="cr-act" title={`Request mới trong "${n.path}"`} onClick={() => p.onNew(n.path)}>＋</button>
          <button className="cr-act" title="Export / đổi tên thư mục…" aria-haspopup="menu"
            onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); p.onFolderMenu(b.right - 220, b.bottom + 2, n.path); }}>⋯</button>
        </div>
        {!closed && (
          <>
            {n.folders.map((f) => folderRow(f, depth + 1))}
            {n.requests.map((r) => reqRow(r, depth + 1))}
          </>
        )}
      </div>
    );
  };

  return (
    <aside className="g-rail api-rail cr">
      <div className="cr-head">
        <span className="cr-title">Collections</span>
        <span style={{ flex: 1 }} />
        <button className="cr-ib" onClick={() => p.onNew()} title="Request mới (tab mới)">＋</button>
        <button className="cr-ib" onClick={p.onImport} title="Import — file export của DevBox hoặc Postman Collection">⤓</button>
        <button className="cr-ib" onClick={() => p.onExport('')} title="Export collection (toàn bộ / theo dự án / theo thư mục)">⤒</button>
        {anyFolder && (allClosed
          ? <button className="cr-ib" onClick={p.onExpandAll} title="Mở rộng tất cả">⊞</button>
          : <button className="cr-ib" onClick={p.onCollapseAll} title="Thu gọn tất cả">⊟</button>)}
        <button className="cr-ib" onClick={p.onReload} title="Tải lại">↻</button>
        <RailHideButton onHide={p.onHide} className="cr-ib" title="Thu gọn cột collection — nhường chỗ cho request đang dựng" />
      </div>

      {p.data.requests.length > 0 && (
        <input className="cr-search" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }}
          placeholder="Tìm request…" spellCheck={false} />
      )}

      <div className="cr-tree">
        {roots.map((n) => folderRow(n, 0))}
        {loose.length > 0 && anyFolder && <div className="cr-sep">Chưa phân dự án</div>}
        {loose.map((r) => reqRow(r, 0))}
        {p.data.requests.length === 0 && (
          <p className="cr-empty">Chưa có request. Dựng rồi 💾, dán lệnh curl vào ô URL, hoặc ⤓ import.</p>
        )}
        {p.data.requests.length > 0 && reqs.length === 0 && <p className="cr-empty">Không có request khớp “{q.trim()}”.</p>}
      </div>

      <button className="cr-foot" onClick={p.onVars} title="Quản lý biến chung và biến theo dự án">
        <span>🔣 Biến</span>
        <span className="cr-n">{globalN} chung · {projN} dự án</span>
      </button>
    </aside>
  );
}
