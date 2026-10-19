'use client';

// Left rail: MongoDB deployments grouped by project, with a ping button and a
// ⋯ menu. A read-only connection shows a 🔒 so you know before you click which
// cluster is armed for writes and which is not. Mirrors rabbit/BrokerRail.

import { useEffect } from 'react';
import { mutateMongoConnection, type PublicMongoConnection } from '@/lib/mongo';
import ConnTransferButton from '../ConnTransferButton';
import { RailHideButton } from '../ConnRailCollapse';
import ConnectionForm from './ConnectionForm';

export interface ConnRailProps {
  connections: PublicMongoConnection[];
  activeId: string;
  pings: Record<string, number | 'err'>;
  manageOpen: boolean;
  editConn: PublicMongoConnection | null;
  menuId: string | null;
  onActivate: (id: string) => void;
  onPing: (c: PublicMongoConnection) => void;
  onMenu: (id: string | null) => void;
  onEdit: (c: PublicMongoConnection) => void;
  onToggleManage: () => void;
  onCloseForm: () => void;
  onSaved: (r: { list: PublicMongoConnection[]; activeId: string }) => void;
  onDeleted: (list: PublicMongoConnection[], deletedId: string) => void;
  /** Sau khi import từ file: nạp lại danh sách từ server rồi báo cho người dùng. */
  onImported: (summary: string) => void;
  onError: (msg: string) => void;
  /** Ẩn cả cột kết nối (ConnRailCollapse) — không truyền khi chưa có kết nối nào. */
  onHide?: () => void;
}

export default function ConnRail(props: ConnRailProps) {
  const {
    connections, activeId, pings, manageOpen, editConn, menuId,
    onActivate, onPing, onMenu, onEdit, onToggleManage, onCloseForm, onSaved, onDeleted, onImported, onError,
    onHide,
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
        <strong>MongoDB clusters</strong>
        <span style={{ display: 'flex', gap: 6 }}>
          <ConnTransferButton kind="mongo" connections={connections} onImported={onImported} onError={onError} />
          <button className="chip-btn" onClick={onToggleManage}>{manageOpen ? '✕ Đóng' : '+ Thêm'}</button>
          {onHide && <RailHideButton onHide={onHide} />}
        </span>
      </div>

      {connections.length === 0 && !manageOpen && (
        <p className="empty" style={{ marginTop: 10 }}>
          Chưa có cluster nào. Bấm “+ Thêm” để cấu hình host:port (hoặc SRV domain) + tài khoản.
        </p>
      )}

      {grouped.map(([project, list]) => (
        <div key={project} className="mongo-conn-group">
          <div className="mongo-group-label">{project}</div>
          {list.map((c) => (
            <div
              key={c.id}
              className={`mongo-conn-row${c.id === activeId ? ' active' : ''}`}
              onClick={() => onActivate(c.id)}
            >
              <div className="mongo-conn-main">
                <span className="mongo-conn-name">
                  {c.readOnly && <span title="Read-only — thao tác ghi bị chặn">🔒 </span>}
                  {c.name}
                  {c.hosts.length > 1 && <span className="badge" style={{ marginLeft: 6 }}>rs ×{c.hosts.length}</span>}
                  {c.scheme === 'mongodb+srv' && <span className="badge" style={{ marginLeft: 6 }}>srv</span>}
                </span>
                <span className="mongo-conn-host">
                  {c.hosts.join(', ')}{c.replicaSet ? ` · ${c.replicaSet}` : ''}{c.tls ? ' · tls' : ''}
                </span>
              </div>
              {pings[c.id] != null && (
                <span className="badge" style={{ color: pings[c.id] === 'err' ? 'var(--err)' : 'var(--ok)' }}>
                  {pings[c.id] === 'err' ? 'err' : `${pings[c.id]}ms`}
                </span>
              )}
              <button className="chip-btn" title="Test kết nối" onClick={(e) => { e.stopPropagation(); onPing(c); }}>⚡</button>
              <div className="mongo-conn-menu" style={{ position: 'relative' }}>
                <button className="chip-btn" onClick={(e) => { e.stopPropagation(); onMenu(menuId === c.id ? null : c.id); }}>⋯</button>
                {menuId === c.id && (
                  <div className="mongo-menu-pop" onClick={(e) => e.stopPropagation()}>
                    <button className="mongo-menu-item" onClick={() => { onEdit(c); onMenu(null); }}>Sửa</button>
                    <button
                      className="mongo-menu-item danger"
                      onClick={async () => {
                        onMenu(null);
                        try {
                          const next = await mutateMongoConnection('DELETE', { id: c.id });
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

function groupByProject(list: PublicMongoConnection[]): [string, PublicMongoConnection[]][] {
  const map = new Map<string, PublicMongoConnection[]>();
  for (const c of list) {
    const arr = map.get(c.project) ?? [];
    arr.push(c);
    map.set(c.project, arr);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([p, arr]) => [p, arr.sort((a, b) => a.name.localeCompare(b.name))] as [string, PublicMongoConnection[]]);
}
