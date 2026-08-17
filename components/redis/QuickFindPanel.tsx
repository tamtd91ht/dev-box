'use client';

// TÌM NHANH cho tab Redis — popover danh sách preset + form tạo/sửa + form chạy.
//
// Preset ghim (tên · mô tả · kết nối · DB · MẪU KEY). Mẫu key chứa biến
// `{{tên}}`; lúc chạy chỉ hỏi đúng mấy biến đó rồi ghép thành key thật. Mẫu
// không có biến thì tra luôn, không hỏi gì. Xem lib/redisQuickFinds.ts.
//
// Component này KHÔNG tự gọi Redis: nó trả key đã ghép (+ connectionId + db) cho
// RedisWorkspace qua onRun, để việc tra key đi đúng một đường sẵn có (cùng chỗ
// mà ô tìm kiếm thường vẫn dùng) — không nhân đôi logic scan/hiển thị giá trị.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PublicRedisConnection } from '@/lib/redis';
import {
  loadRedisQuickFinds,
  addRedisQuickFind,
  updateRedisQuickFind,
  removeRedisQuickFind,
  extractVars,
  fillPattern,
  hasUnfilledVars,
  type RedisQuickFind,
} from '@/lib/redisQuickFinds';

/** Hướng dẫn cú pháp mẫu key — dùng ở cả tooltip lẫn khối trợ giúp trong form. */
export const KEY_PATTERN_HELP = [
  'Mẫu key nhận biến động dạng {{tên}} — lúc bấm tìm nhanh sẽ hỏi đúng những biến này.',
  '',
  'Ví dụ:',
  '  callbot_listen:{{domain}}:{{ip}}   → hỏi domain + ip',
  '  session:{{userId}}                 → hỏi userId',
  '  config:global                      → không có biến, tra thẳng key này',
  '',
  'Tên biến dùng chữ, số, dấu _ - . — vd {{tenant_id}}, {{node.ip}}.',
  'Biến lặp lại chỉ hỏi một lần rồi điền vào mọi chỗ.',
  'Điền xong ra một key đầy đủ → tra THẲNG bằng TYPE/TTL, tức thì và không bỏ sót.',
  'Để * trong mẫu (callbot_listen:{{domain}}:*) thì thành một DẢI key → phải quét SCAN.',
].join('\n');

export interface QuickFindPanelProps {
  connections: PublicRedisConnection[];
  /** Kết nối + DB đang xem — làm giá trị mặc định khi tạo preset mới. */
  currentConnectionId: string;
  currentDb: number;
  /** Chạy preset: workspace nhận key đã ghép và đi tra như ô tìm thường. */
  onRun: (r: { connectionId: string; db: number; key: string; presetName: string }) => void;
  onNotice: (msg: string) => void;
}

export default function QuickFindPanel(props: QuickFindPanelProps) {
  const { connections, currentConnectionId, currentDb, onRun, onNotice } = props;

  const [open, setOpen] = useState(false);
  const [list, setList] = useState<RedisQuickFind[]>([]);
  const [edit, setEdit] = useState<RedisQuickFind | 'new' | null>(null);
  const [running, setRunning] = useState<RedisQuickFind | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => { setList(loadRedisQuickFinds()); }, []);

  // Bấm ra ngoài / Esc → đóng popover. Khi đang mở form con thì không đóng, để
  // một cú bấm lỡ tay không làm mất cả form đang gõ dở.
  useEffect(() => {
    if (!open || edit || running) return;
    const onDown = (e: MouseEvent) => {
      if (!anchorRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, edit, running]);

  return (
    <span className="rqf-anchor" ref={anchorRef}>
      <button
        className={'chip-btn' + (open ? ' on' : '')}
        title="Tìm nhanh theo chức năng đã lưu (kết nối + DB + mẫu key có biến động)"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ⚡ Tìm nhanh{list.length > 0 ? ` (${list.length})` : ''}
      </button>

      {open && (
        <div className="rqf-panel">
          <div className="rqf-head">
            <strong>Tìm nhanh</strong>
            <span style={{ flex: 1 }} />
            <button className="chip-btn" title="Thêm chức năng" onClick={() => setEdit('new')}>+ Thêm</button>
            <button className="chip-btn" title="Đóng" onClick={() => setOpen(false)}>✕</button>
          </div>

          {list.length === 0 ? (
            <p className="empty" style={{ margin: '8px 0' }}>
              Chưa có chức năng nào. Bấm “+ Thêm” để tạo — đặt tên, chọn cụm Redis,
              DB, rồi khai mẫu key (có thể dùng biến <code>{'{{domain}}'}</code>).
            </p>
          ) : (
            <div className="rqf-list">
              {list.map((p) => {
                const conn = connections.find((c) => c.id === p.connectionId);
                const vars = extractVars(p.keyPattern);
                return (
                  <div key={p.id} className="rqf-row">
                    <button
                      className="rqf-run"
                      title={[
                        p.description || 'Chạy tìm nhanh',
                        `Key: ${p.keyPattern}`,
                        vars.length ? `Sẽ hỏi: ${vars.join(', ')}` : 'Không có biến — tra thẳng key này',
                      ].join('\n')}
                      onClick={() => setRunning(p)}
                    >
                      <span className="rqf-name">{p.name}</span>
                      <span className="rqf-sub">
                        {conn ? conn.name : <em style={{ color: 'var(--err)' }}>kết nối đã xoá</em>}
                        {' · DB '}{p.db}{' · '}{p.keyPattern}
                      </span>
                      {p.description && <span className="rqf-desc">{p.description}</span>}
                      {vars.length > 0 && (
                        <span className="rqf-vars">
                          {vars.map((v) => <span key={v} className="rqf-varchip">{v}</span>)}
                        </span>
                      )}
                    </button>
                    <button className="chip-btn" title="Sửa" onClick={() => setEdit(p)}>✎</button>
                    <button
                      className="chip-btn"
                      title="Xoá"
                      onClick={() => { setList(removeRedisQuickFind(p.id)); onNotice('Đã xoá chức năng'); }}
                    >🗑</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {edit && (
        <EditModal
          initial={edit === 'new' ? null : edit}
          connections={connections}
          defaultConnectionId={currentConnectionId}
          defaultDb={currentDb}
          onCancel={() => setEdit(null)}
          onSaved={(saved) => { setList(saved); setEdit(null); onNotice('Đã lưu chức năng'); }}
        />
      )}

      {running && (
        <RunModal
          preset={running}
          connections={connections}
          onCancel={() => setRunning(null)}
          onRun={(key) => {
            setRunning(null);
            setOpen(false);
            onRun({ connectionId: running.connectionId, db: running.db, key, presetName: running.name });
          }}
        />
      )}
    </span>
  );
}

// ── Form tạo / sửa ───────────────────────────────────────────────────────────

function EditModal(props: {
  initial: RedisQuickFind | null;
  connections: PublicRedisConnection[];
  defaultConnectionId: string;
  defaultDb: number;
  onCancel: () => void;
  onSaved: (list: RedisQuickFind[]) => void;
}) {
  const { initial, connections, defaultConnectionId, defaultDb, onCancel, onSaved } = props;

  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [connectionId, setConnectionId] = useState(initial?.connectionId ?? defaultConnectionId ?? '');
  const [db, setDb] = useState(initial?.db ?? defaultDb ?? 0);
  const [keyPattern, setKeyPattern] = useState(initial?.keyPattern ?? '');
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(!initial); // lần đầu tạo thì mở sẵn

  // Cluster chỉ có DB 0 — chọn cụm cluster thì ghim về 0 luôn cho khỏi lưu sai.
  const conn = connections.find((c) => c.id === connectionId);
  const isCluster = conn?.mode === 'cluster';
  useEffect(() => { if (isCluster && db !== 0) setDb(0); }, [isCluster, db]);

  const vars = useMemo(() => extractVars(keyPattern), [keyPattern]);

  const submit = () => {
    if (!name.trim()) { setError('Cần đặt tên chức năng.'); return; }
    if (!connectionId) { setError('Chọn một cụm Redis.'); return; }
    if (!keyPattern.trim()) { setError('Cần khai mẫu key.'); return; }
    const body = {
      name: name.trim(),
      description: description.trim() || undefined,
      connectionId,
      db: isCluster ? 0 : db,
      keyPattern: keyPattern.trim(),
    };
    onSaved(initial ? updateRedisQuickFind(initial.id, body) : addRedisQuickFind(body));
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal rqf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="status-line" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>{initial ? '✎ Sửa chức năng' : '+ Thêm chức năng tìm nhanh'}</h3>
          <button className="ghost sm" onClick={onCancel}>✕</button>
        </div>

        {error && <div className="rqf-err">{error}</div>}

        <label className="rqf-field">
          <span>Tên chức năng</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Callbot đang lắng nghe" />
        </label>

        <label className="rqf-field">
          <span>Mô tả (tuỳ chọn) — để người khác hiểu chức năng này tra cái gì</span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Kiểm tra callbot của domain còn giữ phiên lắng nghe trên node nào" />
        </label>

        <div className="rqf-row2">
          <label className="rqf-field" style={{ flex: 1 }}>
            <span>Cụm Redis</span>
            <select className="input" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
              <option value="">— chọn —</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.project ? ` (${c.project})` : ''}{c.mode === 'cluster' ? ' · cluster' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="rqf-field" style={{ flex: '0 0 110px' }}>
            <span>DB index</span>
            <select className="input" value={db} disabled={isCluster}
              title={isCluster ? 'Redis Cluster chỉ có DB 0' : 'Logical DB 0–15'}
              onChange={(e) => setDb(Number(e.target.value))}>
              {Array.from({ length: 16 }, (_, i) => i).map((i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="rqf-field">
          <span className="rqf-field-head">
            <span>
              Mẫu key
              {/* Tooltip native: hover là thấy ngay, không phải bấm gì. */}
              <span className="rqf-hint" title={KEY_PATTERN_HELP} aria-label="Hướng dẫn cú pháp mẫu key">?</span>
            </span>
            <button type="button" className="chip-btn" onClick={() => setHelpOpen((v) => !v)}>
              {helpOpen ? 'Ẩn hướng dẫn' : 'Cách viết mẫu key'}
            </button>
          </span>
          <input className="input mono" value={keyPattern} onChange={(e) => setKeyPattern(e.target.value)}
            placeholder="callbot_listen:{{domain}}:{{ip}}" />
        </label>

        {helpOpen && (
          <div className="rqf-help">
            <b>Biến động</b> viết trong hai cặp ngoặc nhọn: <code>{'{{tên}}'}</code>. Lúc bấm
            tìm nhanh, form sẽ hỏi đúng những biến đó rồi ghép thành key thật.
            <table className="rqf-help-tbl">
              <thead><tr><th>Mẫu key</th><th>Khi chạy</th></tr></thead>
              <tbody>
                <tr>
                  <td><code>callbot_listen:{'{{domain}}'}:{'{{ip}}'}</code></td>
                  <td>hỏi <b>domain</b> + <b>ip</b></td>
                </tr>
                <tr>
                  <td><code>session:{'{{userId}}'}</code></td>
                  <td>hỏi <b>userId</b></td>
                </tr>
                <tr>
                  <td><code>config:global</code></td>
                  <td>không có biến → tra thẳng key này</td>
                </tr>
                <tr>
                  <td><code>callbot_listen:{'{{domain}}'}:*</code></td>
                  <td>hỏi <b>domain</b>, <code>*</code> quét mọi ip (dải key → dùng SCAN)</td>
                </tr>
              </tbody>
            </table>
            Tên biến dùng chữ, số, <code>_</code> <code>-</code> <code>.</code> — vd{' '}
            <code>{'{{tenant_id}}'}</code>. Biến lặp lại chỉ hỏi một lần rồi điền vào mọi chỗ.
            Mẫu điền xong mà <b>không còn</b> <code>*</code> thì tra thẳng đúng key đó
            (nhanh tức thì, DB lớn cỡ nào cũng không bỏ sót). Còn <code>*</code> thì
            nó là một dải key nên phải quét SCAN.
          </div>
        )}

        {/* Xem trước: biến nào sẽ được hỏi — sai cú pháp là thấy ngay tại đây. */}
        <div className="rqf-preview">
          {keyPattern.trim() === '' ? (
            <span className="rqf-preview-muted">Nhập mẫu key để xem trước.</span>
          ) : vars.length === 0 ? (
            <>Không có biến — sẽ tra thẳng <code>{keyPattern.trim()}</code></>
          ) : (
            <>
              Khi chạy sẽ hỏi:{' '}
              {vars.map((v) => <span key={v} className="rqf-varchip">{v}</span>)}
            </>
          )}
        </div>

        <div className="rqf-acts">
          <button className="ghost" onClick={onCancel}>Huỷ</button>
          <button onClick={submit}>{initial ? 'Lưu' : 'Thêm'}</button>
        </div>
      </div>
    </div>
  );
}

// ── Form chạy: điền biến ─────────────────────────────────────────────────────

function RunModal(props: {
  preset: RedisQuickFind;
  connections: PublicRedisConnection[];
  onCancel: () => void;
  onRun: (key: string) => void;
}) {
  const { preset, connections, onCancel, onRun } = props;
  const vars = useMemo(() => extractVars(preset.keyPattern), [preset.keyPattern]);
  const [values, setValues] = useState<Record<string, string>>({});
  const firstRef = useRef<HTMLInputElement | null>(null);

  const filled = fillPattern(preset.keyPattern, values);
  const missing = hasUnfilledVars(filled);
  const conn = connections.find((c) => c.id === preset.connectionId);

  useEffect(() => { firstRef.current?.focus(); }, []);

  // Không có biến nào thì chẳng có gì để hỏi — chạy luôn, khỏi bắt bấm thêm.
  useEffect(() => {
    if (vars.length === 0) onRun(preset.keyPattern);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vars.length]);
  if (vars.length === 0) return null;

  const go = () => { if (!missing) onRun(filled); };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal rqf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="status-line" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>⚡ {preset.name}</h3>
          <button className="ghost sm" onClick={onCancel}>✕</button>
        </div>

        {preset.description && <p className="rqf-run-desc">{preset.description}</p>}
        <div className="rqf-run-target">
          {conn ? conn.name : <em style={{ color: 'var(--err)' }}>kết nối đã xoá</em>} · DB {preset.db}
        </div>

        {vars.map((v, i) => (
          <label key={v} className="rqf-field">
            <span>{v}</span>
            <input
              ref={i === 0 ? firstRef : undefined}
              className="input mono"
              value={values[v] ?? ''}
              onChange={(e) => setValues((s) => ({ ...s, [v]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }}
              placeholder={`giá trị cho {{${v}}}`}
            />
          </label>
        ))}

        {/* Key sẽ tra — thấy trước khi bấm, khỏi đoán mình điền đúng chưa. */}
        <div className="rqf-preview">
          Key sẽ tra: <code className={missing ? 'rqf-key-bad' : 'rqf-key-ok'}>{filled}</code>
          {missing && <div className="rqf-preview-muted">Còn biến chưa điền.</div>}
        </div>

        <div className="rqf-acts">
          <button className="ghost" onClick={onCancel}>Huỷ</button>
          <button disabled={missing} onClick={go}>Tìm</button>
        </div>
      </div>
    </div>
  );
}
