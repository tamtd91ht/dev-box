'use client';

// Left rail: brokers grouped by project, with a ping button and a ⋯ menu.
// A read-only broker shows a 🔒 so you know before you click which cluster is
// armed for writes and which is not.

import { useEffect } from 'react';
import { mutateRabbitConnection, type PublicRabbitConnection } from '@/lib/rabbit';
import ConnTransferButton from '../ConnTransferButton';
import ConnectionForm from './ConnectionForm';

export interface BrokerRailProps {
  connections: PublicRabbitConnection[];
  activeId: string;
  pings: Record<string, number | 'err'>;
  manageOpen: boolean;
  editConn: PublicRabbitConnection | null;
  menuId: string | null;
  onActivate: (id: string) => void;
  onPing: (c: PublicRabbitConnection) => void;
  onMenu: (id: string | null) => void;
  onEdit: (c: PublicRabbitConnection) => void;
  onToggleManage: () => void;
  onCloseForm: () => void;
  onSaved: (r: { list: PublicRabbitConnection[]; activeId: string }) => void;
  onDeleted: (list: PublicRabbitConnection[], deletedId: string) => void;
  /** Sau khi import từ file: nạp lại danh sách từ server rồi báo cho người dùng. */
  onImported: (summary: string) => void;
  onError: (msg: string) => void;
}

export default function BrokerRail(props: BrokerRailProps) {
  const {
    connections, activeId, pings, manageOpen, editConn, menuId,
    onActivate, onPing, onMenu, onEdit, onToggleManage, onCloseForm, onSaved, onDeleted, onImported, onError,
  } = props;

  // Close the ⋯ menu on any outside click or Escape.
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
        <strong>RabbitMQ brokers</strong>
        <span style={{ display: 'flex', gap: 6 }}>
          <ConnTransferButton kind="rabbit" connections={connections} onImported={onImported} onError={onError} />
          <button className="chip-btn" onClick={onToggleManage}>{manageOpen ? '✕ Đóng' : '+ Thêm'}</button>
        </span>
      </div>

      {connections.length === 0 && !manageOpen && (
        <p className="empty" style={{ marginTop: 10 }}>
          Chưa có broker nào. Bấm “+ Thêm” để cấu hình host/port + tài khoản management.
        </p>
      )}

      {grouped.map(([project, list]) => (
        <div key={project} className="rabbit-conn-group">
          <div className="rabbit-group-label">{project}</div>
          {list.map((c) => (
            <div
              key={c.id}
              className={`rabbit-conn-row${c.id === activeId ? ' active' : ''}`}
              onClick={() => onActivate(c.id)}
            >
              <div className="rabbit-conn-main">
                <span className="rabbit-conn-name">
                  {c.readOnly && <span title="Read-only — thao tác ghi bị chặn">🔒 </span>}
                  {c.name}
                  {c.nodes.length > 1 && <span className="badge" style={{ marginLeft: 6 }}>cluster ×{c.nodes.length}</span>}
                </span>
                <span className="rabbit-conn-host">
                  {c.tls ? 'https' : 'http'} · {c.nodes.join(', ')}{c.vhost ? ` · ${c.vhost}` : ''}
                </span>
              </div>
              {pings[c.id] != null && (
                <span className="badge" style={{ color: pings[c.id] === 'err' ? 'var(--err)' : 'var(--ok)' }}>
                  {pings[c.id] === 'err' ? 'err' : `${pings[c.id]}ms`}
                </span>
              )}
              <button className="chip-btn" title="Test kết nối" onClick={(e) => { e.stopPropagation(); onPing(c); }}>⚡</button>
              <div className="rabbit-conn-menu" style={{ position: 'relative' }}>
                <button className="chip-btn" onClick={(e) => { e.stopPropagation(); onMenu(menuId === c.id ? null : c.id); }}>⋯</button>
                {menuId === c.id && (
                  <div className="rabbit-menu-pop" onClick={(e) => e.stopPropagation()}>
                    <button className="rabbit-menu-item" onClick={() => { onEdit(c); onMenu(null); }}>Sửa</button>
                    <button
                      className="rabbit-menu-item danger"
                      onClick={async () => {
                        onMenu(null);
                        try {
                          const next = await mutateRabbitConnection('DELETE', { id: c.id });
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

function groupByProject(list: PublicRabbitConnection[]): [string, PublicRabbitConnection[]][] {
  const map = new Map<string, PublicRabbitConnection[]>();
  for (const c of list) {
    const arr = map.get(c.project) ?? [];
    arr.push(c);
    map.set(c.project, arr);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([p, arr]) => [p, arr.sort((a, b) => a.name.localeCompare(b.name))] as [string, PublicRabbitConnection[]]);
}
