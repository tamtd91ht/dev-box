'use client';

// Left rail: PG servers grouped by project, with a ping button and a ⋯ menu.
// A read-only connection shows a 🔒 — same convention as the Mongo tab.

import { useEffect } from 'react';
import { mutatePgConnection, type PublicPgConnection } from '@/lib/pg';
import ConnTransferButton from '../ConnTransferButton';
import { RailHideButton } from '../RailCollapse';
import ConnectionForm from './ConnectionForm';

export interface ConnRailProps {
  connections: PublicPgConnection[];
  activeId: string;
  pings: Record<string, number | 'err'>;
  manageOpen: boolean;
  editConn: PublicPgConnection | null;
  menuId: string | null;
  onActivate: (id: string) => void;
  onPing: (c: PublicPgConnection) => void;
  onMenu: (id: string | null) => void;
  onEdit: (c: PublicPgConnection) => void;
  onToggleManage: () => void;
  onCloseForm: () => void;
  onSaved: (r: { list: PublicPgConnection[]; activeId: string }) => void;
  onDeleted: (list: PublicPgConnection[], deletedId: string) => void;
  /** Sau khi import từ file: nạp lại danh sách từ server rồi báo cho người dùng. */
  onImported: (summary: string) => void;
  onError: (msg: string) => void;
  /** Thu gọn cột — cha truyền vào thì mới vẽ nút « (xem RailCollapse). */
  onHide?: () => void;
}

export default function ConnRail(props: ConnRailProps) {
  const {
    connections, activeId, pings, manageOpen, editConn, menuId,
    onActivate, onPing, onMenu, onEdit, onToggleManage, onCloseForm, onSaved, onDeleted, onImported, onError,
    onHide,
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
        <strong>PostgreSQL servers</strong>
        <span style={{ display: 'flex', gap: 6 }}>
          <ConnTransferButton kind="pg" connections={connections} onImported={onImported} onError={onError} />
          <button className="chip-btn" onClick={onToggleManage}>{manageOpen ? '✕ Đóng' : '+ Thêm'}</button>
          {onHide && <RailHideButton onHide={onHide} />}
        </span>
      </div>

      {connections.length === 0 && !manageOpen && (
        <p className="empty" style={{ marginTop: 10 }}>
          Chưa có server nào. Bấm “+ Thêm” để cấu hình host:port + database + tài khoản.
        </p>
      )}

      {grouped.map(([project, list]) => (
        <div key={project} className="pg-conn-group">
          <div className="pg-group-label">{project}</div>
          {list.map((c) => (
            <div
              key={c.id}
              className={`pg-conn-row${c.id === activeId ? ' active' : ''}`}
              onClick={() => onActivate(c.id)}
            >
              <div className="pg-conn-main">
                <span className="pg-conn-name">
                  {c.readOnly && <span title="Read-only — UPDATE bị chặn">🔒 </span>}
                  {c.name}
                </span>
                <span className="pg-conn-host">{c.host}:{c.port}/{c.database} · {c.username}{c.tls ? ' · tls' : ''}</span>
              </div>
              {pings[c.id] != null && (
                <span className="badge" style={{ color: pings[c.id] === 'err' ? 'var(--err)' : 'var(--ok)' }}>
                  {pings[c.id] === 'err' ? 'err' : `${pings[c.id]}ms`}
                </span>
              )}
              <button className="chip-btn" title="Test kết nối" onClick={(e) => { e.stopPropagation(); onPing(c); }}>⚡</button>
              <div className="pg-conn-menu" style={{ position: 'relative' }}>
                <button className="chip-btn" onClick={(e) => { e.stopPropagation(); onMenu(menuId === c.id ? null : c.id); }}>⋯</button>
                {menuId === c.id && (
                  <div className="pg-menu-pop" onClick={(e) => e.stopPropagation()}>
                    <button className="pg-menu-item" onClick={() => { onEdit(c); onMenu(null); }}>Sửa</button>
                    <button
                      className="pg-menu-item danger"
                      onClick={async () => {
                        onMenu(null);
                        try {
                          const next = await mutatePgConnection('DELETE', { id: c.id });
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

function groupByProject(list: PublicPgConnection[]): [string, PublicPgConnection[]][] {
  const map = new Map<string, PublicPgConnection[]>();
  for (const c of list) {
    const arr = map.get(c.project) ?? [];
    arr.push(c);
    map.set(c.project, arr);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([p, arr]) => [p, arr.sort((a, b) => a.name.localeCompare(b.name))] as [string, PublicPgConnection[]]);
}
