'use client';

// Left rail: ES clusters grouped by project, with a ping button and a ⋯ menu.
// No lock icon here — the whole ES tab is read-only by construction.

import { useEffect } from 'react';
import { mutateEsConnection, type PublicEsConnection } from '@/lib/es';
import ConnectionForm from './ConnectionForm';

export interface ConnRailProps {
  connections: PublicEsConnection[];
  activeId: string;
  pings: Record<string, number | 'err'>;
  manageOpen: boolean;
  editConn: PublicEsConnection | null;
  menuId: string | null;
  onActivate: (id: string) => void;
  onPing: (c: PublicEsConnection) => void;
  onMenu: (id: string | null) => void;
  onEdit: (c: PublicEsConnection) => void;
  onToggleManage: () => void;
  onCloseForm: () => void;
  onSaved: (r: { list: PublicEsConnection[]; activeId: string }) => void;
  onDeleted: (list: PublicEsConnection[], deletedId: string) => void;
  onError: (msg: string) => void;
}

export default function ConnRail(props: ConnRailProps) {
  const {
    connections, activeId, pings, manageOpen, editConn, menuId,
    onActivate, onPing, onMenu, onEdit, onToggleManage, onCloseForm, onSaved, onDeleted, onError,
  } = props;

  useEffect(() => {
    if (!menuId) return;
    const close = () => onMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); };
  }, [menuId, onMenu]);

  const grouped = groupByProject(connections);

  return (
    <aside className="panel">
      <div className="status-line" style={{ justifyContent: 'space-between' }}>
        <strong>Elastic clusters</strong>
        <button className="chip-btn" onClick={onToggleManage}>{manageOpen ? '✕ Đóng' : '+ Thêm'}</button>
      </div>

      {connections.length === 0 && !manageOpen && (
        <p className="empty" style={{ marginTop: 10 }}>
          Chưa có cluster nào. Bấm “+ Thêm” để cấu hình node list host:port (mặc định 9200, qua VPN không cần auth).
        </p>
      )}

      {grouped.map(([project, list]) => (
        <div key={project} className="es-conn-group">
          <div className="es-group-label">{project}</div>
          {list.map((c) => (
            <div
              key={c.id}
              className={`es-conn-row${c.id === activeId ? ' active' : ''}`}
              onClick={() => onActivate(c.id)}
            >
              <div className="es-conn-main">
                <span className="es-conn-name">
                  {c.name}
                  {c.nodes.length > 1 && <span className="badge" style={{ marginLeft: 6 }}>cluster ×{c.nodes.length}</span>}
                </span>
                <span className="es-conn-host">{c.tls ? 'https' : 'http'} · {c.nodes.join(', ')}</span>
              </div>
              {pings[c.id] != null && (
                <span className="badge" style={{ color: pings[c.id] === 'err' ? 'var(--err)' : 'var(--ok)' }}>
                  {pings[c.id] === 'err' ? 'err' : `${pings[c.id]}ms`}
                </span>
              )}
              <button className="chip-btn" title="Test kết nối" onClick={(e) => { e.stopPropagation(); onPing(c); }}>⚡</button>
              <div className="es-conn-menu" style={{ position: 'relative' }}>
                <button className="chip-btn" onClick={(e) => { e.stopPropagation(); onMenu(menuId === c.id ? null : c.id); }}>⋯</button>
                {menuId === c.id && (
                  <div className="es-menu-pop" onClick={(e) => e.stopPropagation()}>
                    <button className="es-menu-item" onClick={() => { onEdit(c); onMenu(null); }}>Sửa</button>
                    <button
                      className="es-menu-item danger"
                      onClick={async () => {
                        onMenu(null);
                        try {
                          const next = await mutateEsConnection('DELETE', { id: c.id });
                          onDeleted(next, c.id);
                        } catch (e) { onError((e as Error).message); }
                      }}
                    >Xoá khỏi danh sách</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}

      {manageOpen && (
        <ConnectionForm initial={editConn} onCancel={onCloseForm} onSaved={onSaved} onError={onError} />
      )}
    </aside>
  );
}

function groupByProject(list: PublicEsConnection[]): [string, PublicEsConnection[]][] {
  const map = new Map<string, PublicEsConnection[]>();
  for (const c of list) {
    const arr = map.get(c.project) ?? [];
    arr.push(c);
    map.set(c.project, arr);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([p, arr]) => [p, arr.sort((a, b) => a.name.localeCompare(b.name))] as [string, PublicEsConnection[]]);
}
