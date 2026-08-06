'use client';

// Ô XEM bên phải của tab Tools cho JSON / XML: cây thu gọn được.
//
// Render bằng JSX (không dangerouslySetInnerHTML) nên nội dung file — kể cả
// chuỗi chứa thẻ HTML — luôn hiện ra dạng chữ, không có đường nào chạy script.
// Mặc định mở sẵn 2 tầng đầu cho dễ nhìn; sâu hơn thì bấm ▸ để mở.

import { useState } from 'react';
import type { TreeNode } from '@/lib/treeView';

/** Số tầng mở sẵn khi vừa render. */
const AUTO_OPEN_DEPTH = 2;

function Row({ node, depth }: { node: TreeNode; depth: number }) {
  const kids = node.children ?? [];
  const branch = kids.length > 0;
  const [open, setOpen] = useState(depth < AUTO_OPEN_DEPTH);

  const pad = { paddingLeft: 6 + depth * 14 };

  if (!branch) {
    return (
      <div className="tv-row" style={pad}>
        <span className="tv-caret" aria-hidden />
        {node.key !== '' && node.key !== '#text' && <span className="tv-key">{node.key}</span>}
        {node.key !== '' && node.key !== '#text' && <span className="tv-colon">:</span>}
        {node.attrs?.map((a) => (
          <span key={a.name} className="tv-attr">
            {a.name}=<span className="tv-attr-val">&quot;{a.value}&quot;</span>
          </span>
        ))}
        <span className={`tv-val tv-${node.type}`}>
          {node.type === 'string' ? `"${node.value}"` : node.value}
        </span>
      </div>
    );
  }

  const brace = node.type === 'array' ? `[${node.count ?? kids.length}]`
    : node.type === 'object' ? `{${node.count ?? kids.length}}`
      : `<${kids.length}>`;

  return (
    <>
      <div className="tv-row tv-branch" style={pad} onClick={() => setOpen((v) => !v)} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}>
        <span className={`tv-caret on${open ? ' open' : ''}`} aria-hidden>▸</span>
        {node.key !== '' && <span className="tv-key">{node.key}</span>}
        {node.attrs?.map((a) => (
          <span key={a.name} className="tv-attr">
            {a.name}=<span className="tv-attr-val">&quot;{a.value}&quot;</span>
          </span>
        ))}
        {!open && <span className="tv-count">{brace}</span>}
      </div>
      {open && kids.map((c, i) => <Row key={`${c.key}-${i}`} node={c} depth={depth + 1} />)}
    </>
  );
}

export default function TreeView({ root }: { root: TreeNode }) {
  const kids = root.children ?? [];
  // Nút gốc không có tên → render thẳng các con cho đỡ thừa một tầng.
  if (root.key === '' && kids.length > 0) {
    return <div className="tv">{kids.map((c, i) => <Row key={`${c.key}-${i}`} node={c} depth={0} />)}</div>;
  }
  if (root.key === '' && kids.length === 0 && root.value === undefined) {
    return <div className="tv"><p className="small" style={{ color: 'var(--faint)', padding: 8 }}>Chưa có nội dung.</p></div>;
  }
  return <div className="tv"><Row node={root} depth={0} /></div>;
}
