'use client';

// Tab CÔNG VIỆC — quản lý task trên lịch tháng, lưu GLOBAL trên MongoDB.
//
// Luồng: chọn ngày bắt đầu trên lịch → "＋ Thêm công việc" → nhập dự án / tên /
// mô tả / ưu tiên / tags / deadline (ngày+giờ) / cấu hình cảnh báo → lưu.
// Server (lib/workWatch) quét mỗi phút: nhắc khi TỚI NGÀY bắt đầu (chỉ khi task
// được tạo cho ngày tương lai) và khi GẦN DEADLINE theo cấu hình; cảnh báo về
// qua toast + hòm thông báo (WorkAlertHost).
//
// Trạng thái: Đang chờ / Đang diễn ra / Đã hoàn thành / Đã hủy — đổi bằng dãy
// nút chuyển nhanh trên từng dòng, hoặc dropdown trong form sửa. CHỈ hai trạng
// thái đầu mới nhận cảnh báo (STATUS_META[...].alerts). Bộ lọc có chip trạng
// thái kèm số lượng, cộng với keyword và khoảng thời gian.
//
// Kho lưu: một cụm Mongo chọn từ danh sách quản lý Mongo hiện có, hoặc nhập
// connection mới (tự lưu vào menu Mongo luôn). First-run hiện panel cấu hình.

import { useCallback, useEffect, useMemo, useState } from 'react';
import ConnectionForm from './mongo/ConnectionForm';
import type { PublicMongoConnection } from '@/lib/mongo';

// ── Types (khớp lib/workTasks) ───────────────────────────────────────────────

type Priority = 'low' | 'normal' | 'high' | 'urgent';

type Status = 'pending' | 'active' | 'done' | 'cancelled';

type WorkAlert =
  | { kind: 'offset'; minutes: number }
  | { kind: 'daily'; daysBefore: number; time: string };

interface WorkTask {
  id: string;
  project: string;
  name: string;
  desc: string;
  priority: Priority;
  tags: string[];
  startDate: string;
  dlDate: string | null;
  dlTime: string | null;
  deadlineMs: number | null;
  alert: WorkAlert | null;
  status: Status;
  createdDate: string;
}

interface ConfigView {
  configured: boolean;
  config: { connectionId: string; database: string } | null;
  connectionName: string | null;
  connections: PublicMongoConnection[];
}

async function workAction<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/work', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  }
  return (data as { result: T }).result;
}

// ── Date helpers (local) ─────────────────────────────────────────────────────

const p2 = (n: number) => String(n).padStart(2, '0');
const dstr = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const TODAY = () => dstr(new Date());

const PRIORITY_META: Record<Priority, { label: string; cls: string }> = {
  low: { label: 'Thấp', cls: 'lo' },
  normal: { label: 'Thường', cls: 'no' },
  high: { label: 'Cao', cls: 'hi' },
  urgent: { label: 'Khẩn', cls: 'ur' },
};

/** 4 trạng thái — nhãn, icon nút chuyển nhanh, class màu, có cảnh báo hay không. */
const STATUS_META: Record<Status, { label: string; icon: string; cls: string; hint: string; alerts: boolean }> = {
  pending: { label: 'Đang chờ', icon: '🕓', cls: 'pd', hint: 'Chưa đến thời gian thực hiện', alerts: true },
  active: { label: 'Đang diễn ra', icon: '▶', cls: 'ac', hint: 'Đang thực hiện', alerts: true },
  done: { label: 'Đã hoàn thành', icon: '✓', cls: 'dn', hint: 'Đã xong — không còn cảnh báo', alerts: false },
  cancelled: { label: 'Đã hủy', icon: '✕', cls: 'cx', hint: 'Đã hủy — không còn cảnh báo', alerts: false },
};

const STATUS_ORDER: Status[] = ['pending', 'active', 'done', 'cancelled'];

function fmtDl(t: WorkTask): string {
  if (!t.dlDate) return '';
  const [y, m, d] = t.dlDate.split('-');
  return `${d}/${m}/${y}${t.dlTime ? ` ${t.dlTime}` : ''}`;
}

/** Đếm ngược tới deadline: >1 ngày làm tròn NGÀY, <1 ngày theo GIỜ + PHÚT. */
function remainText(deadlineMs: number, now = Date.now()): string {
  const diff = deadlineMs - now;
  const abs = Math.abs(diff);
  const DAY = 86_400_000;
  let span: string;
  if (abs >= DAY) {
    span = `${Math.round(abs / DAY)} ngày`;
  } else {
    const h = Math.floor(abs / 3_600_000);
    const m = Math.round((abs % 3_600_000) / 60_000);
    span = h > 0 ? `${h} giờ ${m} phút` : `${m} phút`;
  }
  return diff >= 0 ? `còn ${span}` : `QUÁ HẠN ${span}`;
}

/** Bỏ dấu tiếng Việt + lowercase — để search không phân biệt hoa/thường/dấu. */
function stripVN(s: string): string {
  return s
    .normalize('NFD')
    // Dải combining marks U+0300–U+036F (dấu tách ra sau NFD).
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
}

function alertLabel(a: WorkAlert | null): string {
  if (!a) return 'Không cảnh báo';
  if (a.kind === 'offset') {
    if (a.minutes % 1440 === 0) return `Trước ${a.minutes / 1440} ngày`;
    if (a.minutes % 60 === 0) return `Trước ${a.minutes / 60} giờ`;
    return `Trước ${a.minutes} phút`;
  }
  return `Trước ${a.daysBefore} ngày lúc ${a.time}`;
}

// ── Setup panel (chọn / thêm cụm Mongo) ──────────────────────────────────────

function SetupPanel({ view, onSaved, onCancel }: {
  view: ConfigView;
  onSaved: (v: ConfigView) => void;
  /** Có khi đang SỬA cấu hình (đã configured trước đó) — cho phép quay lại. */
  onCancel?: () => void;
}) {
  const [connId, setConnId] = useState(view.config?.connectionId ?? view.connections[0]?.id ?? '');
  const [database, setDatabase] = useState(view.config?.database ?? 'devbox');
  const [conns, setConns] = useState(view.connections);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selConn = conns.find((c) => c.id === connId) ?? null;
  const changed = view.config ? view.config.connectionId !== connId || view.config.database !== database.trim() : true;

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      onSaved(await workAction<ConfigView>('config-set', { connectionId: connId, database: database.trim() }));
    } catch (e) {
      setErr((e as Error).message);
      setConfirming(false);
    } finally { setBusy(false); }
  };

  return (
    <div className="panel office-hero-panel" style={{ margin: 'auto', width: 'min(720px, 94%)' }}>
      <div className="office-hero">
        <div className="office-hero-ico" aria-hidden>📋</div>
        <div className="office-hero-title">{view.configured ? 'Sửa kho lưu trữ Công việc' : 'Kho lưu trữ Công việc'}</div>
        <p className="office-hero-sub">
          Task lưu trên <b>MongoDB</b> (phạm vi global — mọi máy cùng thấy), trong collection
          <code> devbox_work_tasks</code>. Chọn một cụm từ danh sách quản lý Mongo, hoặc khai báo cụm mới
          (form giống hệt menu Mongo — tự lưu vào đó luôn).
        </p>
        {view.configured && view.config && (
          <p className="office-hero-sub small" style={{ color: 'var(--muted)' }}>
            Đang dùng: <b>{view.connectionName}</b> / db <code>{view.config.database}</code>.
            Đổi cụm là CHUYỂN CON TRỎ — tab sẽ đọc/ghi cụm mới, dữ liệu ở cụm cũ giữ nguyên tại chỗ (không migrate).
          </p>
        )}
      </div>
      <div className="wk-setup">
        <label className="wk-field">
          <span>Cụm Mongo</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <select className="input" value={connId} onChange={(e) => setConnId(e.target.value)} style={{ flex: 1 }}>
              {conns.length === 0 && <option value="">— chưa có connection nào —</option>}
              {conns.map((c) => <option key={c.id} value={c.id}>{c.name}{c.project ? ` (${c.project})` : ''}</option>)}
            </select>
            <button className="ghost sm" onClick={() => setAdding((v) => !v)}>{adding ? 'Đóng form' : '＋ Kết nối mới'}</button>
          </div>
        </label>

        {adding && (
          <div className="wk-newconn">
            {/* Form CHUẨN của menu Mongo (tên cụm, dự án, scheme, hosts, auth,
                TLS, read-only, nút Test) — lưu thẳng vào registry dùng chung. */}
            <ConnectionForm
              initial={null}
              onCancel={() => setAdding(false)}
              onError={(m) => setErr(m)}
              onSaved={({ list, activeId }) => {
                setConns(list);
                setConnId(activeId);
                setAdding(false);
                setErr(null);
              }}
            />
          </div>
        )}

        <label className="wk-field">
          <span>Database</span>
          <input className="input" value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="devbox" />
        </label>
        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setConfirming(true)} disabled={busy || !connId || !database.trim() || !changed}
            title={!changed ? 'Chưa thay đổi gì so với cấu hình hiện tại' : undefined}>
            💾 Lưu cấu hình…
          </button>
          {onCancel && <button className="ghost" onClick={onCancel} disabled={busy}>Quay lại</button>}
        </div>
      </div>

      {/* Bước XÁC NHẬN — ghi nhầm vào cụm Mongo của dự án khác là tai nạn thật,
          nên bắt đọc lại đích đến trước khi chốt. */}
      {confirming && selConn && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && !busy && setConfirming(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(520px, 94vw)' }}>
            <h3 style={{ marginTop: 0 }}>⚠ Xác nhận kho lưu trữ</h3>
            <p className="small">Tab Công việc sẽ <b>GHI dữ liệu</b> vào:</p>
            <ul className="small" style={{ lineHeight: 1.9 }}>
              <li>Cụm: <b>{selConn.name}</b>{selConn.project ? <> (project <b>{selConn.project}</b>)</> : null}</li>
              <li>Hosts: <code>{selConn.hosts.join(', ')}</code></li>
              <li>Database: <code>{database.trim()}</code> · Collection: <code>devbox_work_tasks</code></li>
            </ul>
            <p className="small" style={{ color: 'var(--warn, #d29922)' }}>
              Kiểm tra kỹ — chọn nhầm cụm MongoDB của dự án khác sẽ ghi collection lạ vào đó.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="ghost sm" onClick={() => setConfirming(false)} disabled={busy}>Hủy</button>
              <button className="sm" onClick={() => void save()} disabled={busy}>
                {busy ? <span className="spinner" aria-hidden /> : '✓'} Xác nhận — dùng cụm này
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Form thêm/sửa task ───────────────────────────────────────────────────────

type AlertChoice = 'none' | '30' | '60' | '180' | '1440' | 'daily';

function alertToChoice(a: WorkAlert | null): AlertChoice {
  if (!a) return 'none';
  if (a.kind === 'daily') return 'daily';
  return (['30', '60', '180', '1440'].includes(String(a.minutes)) ? String(a.minutes) : 'daily') as AlertChoice;
}

function TaskForm({ initial, startDate, projects, busy, err, onSave, onClose }: {
  initial: WorkTask | null;
  startDate: string;
  projects: string[];
  busy: boolean;
  err: string | null;
  onSave: (fields: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [project, setProject] = useState(initial?.project ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [desc, setDesc] = useState(initial?.desc ?? '');
  const [priority, setPriority] = useState<Priority>(initial?.priority ?? 'normal');
  const [tags, setTags] = useState(initial?.tags.join(', ') ?? '');
  const [start, setStart] = useState(initial?.startDate ?? startDate);
  // Task mới: để trống → server tự chọn Đang chờ / Đang diễn ra theo ngày bắt đầu.
  const [status, setStatus] = useState<Status | ''>(initial?.status ?? '');
  const [dlDate, setDlDate] = useState(initial?.dlDate ?? '');
  const [dlTime, setDlTime] = useState(initial?.dlTime ?? '18:00');
  const [choice, setChoice] = useState<AlertChoice>(initial ? alertToChoice(initial.alert) : 'daily');
  const [dDays, setDDays] = useState(initial?.alert?.kind === 'daily' ? initial.alert.daysBefore : 1);
  const [dTime, setDTime] = useState(initial?.alert?.kind === 'daily' ? initial.alert.time : '21:00');

  const submit = () => {
    const alert: WorkAlert | null = !dlDate || choice === 'none'
      ? null
      : choice === 'daily'
        ? { kind: 'daily', daysBefore: dDays, time: dTime }
        : { kind: 'offset', minutes: Number(choice) };
    onSave({
      project, name, desc, priority,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      startDate: start, dlDate: dlDate || '', dlTime, alert,
      ...(status ? { status } : {}),
    });
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal wk-form" onClick={(e) => e.stopPropagation()}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>{initial ? '✎ Sửa công việc' : '＋ Thêm công việc'}</h3>
          <button className="ghost sm" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <div className="wk-form-grid">
          <label className="wk-field"><span>Dự án</span>
            <input className="input" list="wk-projects" value={project} onChange={(e) => setProject(e.target.value)} placeholder="vd OMICX" />
            <datalist id="wk-projects">{projects.map((pj) => <option key={pj} value={pj} />)}</datalist>
          </label>
          <label className="wk-field"><span>Tên công việc *</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="vd Bàn giao chức năng A" autoFocus />
          </label>
          <label className="wk-field wk-span2"><span>Mô tả chung</span>
            <textarea className="input wk-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Ghi chú phạm vi, link tài liệu…" />
          </label>
          <label className="wk-field"><span>Ưu tiên</span>
            <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {(Object.keys(PRIORITY_META) as Priority[]).map((k) => <option key={k} value={k}>{PRIORITY_META[k].label}</option>)}
            </select>
          </label>
          <label className="wk-field"><span>Tags (phẩy)</span>
            <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="backend, release" />
          </label>
          <label className="wk-field"><span>Ngày bắt đầu</span>
            <input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="wk-field"><span>Trạng thái</span>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value as Status | '')}>
              {!initial && <option value="">Tự động (theo ngày bắt đầu)</option>}
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>{STATUS_META[s].icon} {STATUS_META[s].label}</option>
              ))}
            </select>
            <span className="small" style={{ color: 'var(--muted)' }}>
              {status
                ? STATUS_META[status].hint + (STATUS_META[status].alerts ? '' : ' (tắt cảnh báo)')
                : 'Ngày bắt đầu ở tương lai → Đang chờ, ngược lại → Đang diễn ra.'}
            </span>
          </label>
          <div className="wk-field"><span>Deadline cam kết</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="input" type="date" value={dlDate} onChange={(e) => setDlDate(e.target.value)} style={{ flex: 1 }} />
              <input className="input" type="time" value={dlTime} onChange={(e) => setDlTime(e.target.value)} disabled={!dlDate} style={{ width: 100 }} />
            </div>
          </div>
          <div className="wk-field wk-span2"><span>Cảnh báo deadline</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <select className="input" value={choice} onChange={(e) => setChoice(e.target.value as AlertChoice)} disabled={!dlDate} style={{ width: 190 }}>
                <option value="none">Không cảnh báo</option>
                <option value="30">Trước 30 phút</option>
                <option value="60">Trước 1 giờ</option>
                <option value="180">Trước 3 giờ</option>
                <option value="1440">Trước 1 ngày</option>
                <option value="daily">Trước N ngày lúc giờ…</option>
              </select>
              {choice === 'daily' && dlDate && (
                <>
                  <span className="small">trước</span>
                  <input className="input" type="number" min={0} max={30} value={dDays} onChange={(e) => setDDays(Math.max(0, Number(e.target.value) || 0))} style={{ width: 64 }} />
                  <span className="small">ngày, lúc</span>
                  <input className="input" type="time" value={dTime} onChange={(e) => setDTime(e.target.value)} style={{ width: 100 }} />
                </>
              )}
            </div>
            <span className="small" style={{ color: 'var(--muted)' }}>
              Nhắc <b>ngày bắt đầu</b> tự kích hoạt khi tạo task cho một ngày trong tương lai (so theo ngày, không quan tâm giờ).
            </span>
            {status && !STATUS_META[status].alerts && (
              <span className="small" style={{ color: 'var(--warn, #d29922)' }}>
                ⚠ Trạng thái <b>{STATUS_META[status].label}</b> KHÔNG nhận cảnh báo — cấu hình ở trên chỉ có tác dụng trở lại khi chuyển về Đang chờ / Đang diễn ra.
              </span>
            )}
          </div>
        </div>

        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="ghost sm" onClick={onClose} disabled={busy}>Hủy</button>
          <button className="sm" onClick={submit} disabled={busy || !name.trim() || !start}>
            {busy ? <span className="spinner" aria-hidden /> : '💾'} Lưu
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Workspace chính ──────────────────────────────────────────────────────────

export default function WorkWorkspace() {
  const [view, setView] = useState<ConfigView | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [showSetup, setShowSetup] = useState(false);

  const [tasks, setTasks] = useState<WorkTask[]>([]);
  const now = new Date();
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() });
  const [selDate, setSelDate] = useState<string>(TODAY());
  const [form, setForm] = useState<{ task: WorkTask | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);

  // ── Bộ lọc quản trị: keyword (dự án/tên/tag, không dấu) + khoảng thời gian ──
  const [kw, setKw] = useState('');
  /** Trạng thái được chọn; rỗng = tất cả. Nhiều lựa chọn (toggle chip). */
  const [statusSel, setStatusSel] = useState<Status[]>([]);
  const [rangeMode, setRangeMode] = useState<'' | 'week' | 'month' | 'custom'>('');
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');

  const loadTasks = useCallback(async () => {
    try {
      const r = await workAction<{ tasks: WorkTask[] }>('list');
      setTasks(r.tasks);
      setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }, []);

  useEffect(() => {
    workAction<ConfigView>('config')
      .then((v) => { setView(v); setEnabled(true); if (v.configured) void loadTasks(); })
      .catch((e) => {
        if ((e as Error & { status?: number }).message.includes('MONGO_TOOL_ENABLED')) setEnabled(false);
        else { setEnabled(true); setErr((e as Error).message); }
      });
  }, [loadTasks]);

  // ── Derivations ────────────────────────────────────────────────────────────
  const byStart = useMemo(() => {
    const m = new Map<string, WorkTask[]>();
    for (const t of tasks) {
      if (!m.has(t.startDate)) m.set(t.startDate, []);
      m.get(t.startDate)!.push(t);
    }
    return m;
  }, [tasks]);
  const byDeadline = useMemo(() => {
    const m = new Map<string, WorkTask[]>();
    for (const t of tasks) {
      if (!t.dlDate) continue;
      if (!m.has(t.dlDate)) m.set(t.dlDate, []);
      m.get(t.dlDate)!.push(t);
    }
    return m;
  }, [tasks]);
  const projects = useMemo(() => Array.from(new Set(tasks.map((t) => t.project).filter(Boolean))).sort(), [tasks]);

  /** 6 tuần hiển thị của tháng, Thứ 2 đầu tuần. */
  const weeks = useMemo(() => {
    const first = new Date(ym.y, ym.m, 1);
    const lead = (first.getDay() + 6) % 7; // Mon=0
    const start = new Date(ym.y, ym.m, 1 - lead);
    const out: { date: string; inMonth: boolean; day: number }[][] = [];
    for (let w = 0; w < 6; w++) {
      const row: { date: string; inMonth: boolean; day: number }[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + i);
        row.push({ date: dstr(d), inMonth: d.getMonth() === ym.m, day: d.getDate() });
      }
      out.push(row);
    }
    return out;
  }, [ym]);

  const dayTasks = useMemo(() => {
    const starts = byStart.get(selDate) ?? [];
    const dls = (byDeadline.get(selDate) ?? []).filter((t) => t.startDate !== selDate);
    return { starts, dls };
  }, [byStart, byDeadline, selDate]);

  const upcoming = useMemo(
    // Chỉ việc còn sống (đang chờ / đang diễn ra) — đã xong hay đã hủy thì
    // không còn "sắp đến hạn" nữa.
    () => tasks
      .filter((t) => STATUS_META[t.status].alerts && t.deadlineMs !== null)
      .sort((a, b) => (a.deadlineMs ?? 0) - (b.deadlineMs ?? 0))
      .slice(0, 8),
    [tasks],
  );

  // ── Bộ lọc ─────────────────────────────────────────────────────────────────
  /** Khoảng [from..to] (YYYY-MM-DD, inclusive) theo chế độ đã chọn. */
  const range = useMemo((): { from: string; to: string } | null => {
    const d = new Date();
    if (rangeMode === 'week') {
      const lead = (d.getDay() + 6) % 7; // Thứ 2 đầu tuần
      const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - lead);
      const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
      return { from: dstr(mon), to: dstr(sun) };
    }
    if (rangeMode === 'month') {
      return { from: dstr(new Date(d.getFullYear(), d.getMonth(), 1)), to: dstr(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
    }
    if (rangeMode === 'custom') {
      if (!rangeFrom && !rangeTo) return null;
      return { from: rangeFrom || '0000-01-01', to: rangeTo || '9999-12-31' };
    }
    return null;
  }, [rangeMode, rangeFrom, rangeTo]);

  const filterActive = kw.trim() !== '' || range !== null || statusSel.length > 0;

  const filtered = useMemo(() => {
    if (!filterActive) return [];
    const q = stripVN(kw.trim());
    return tasks
      .filter((t) => {
        if (statusSel.length > 0 && !statusSel.includes(t.status)) return false;
        if (q) {
          // Search trên DỰ ÁN + TÊN + TAGS — không phân biệt hoa/thường/dấu.
          const hay = stripVN(`${t.project} ${t.name} ${t.tags.join(' ')}`);
          if (!hay.includes(q)) return false;
        }
        if (range) {
          const inR = (day: string | null) => !!day && day >= range.from && day <= range.to;
          if (!inR(t.startDate) && !inR(t.dlDate)) return false;
        }
        return true;
      })
      .sort((a, b) => (a.deadlineMs ?? Infinity) - (b.deadlineMs ?? Infinity) || a.startDate.localeCompare(b.startDate));
  }, [filterActive, kw, range, statusSel, tasks]);

  // ── Mutations ──────────────────────────────────────────────────────────────
  const saveTask = async (fields: Record<string, unknown>) => {
    setBusy(true); setFormErr(null);
    try {
      if (form?.task) await workAction('update', { id: form.task.id, ...fields });
      else await workAction('add', fields);
      setForm(null);
      await loadTasks();
    } catch (e) { setFormErr((e as Error).message); } finally { setBusy(false); }
  };

  /** Chuyển nhanh trạng thái — optimistic để nút phản hồi tức thì, list tải lại sau. */
  const changeStatus = async (t: WorkTask, status: Status) => {
    if (t.status === status) return;
    setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, status } : x)));
    try {
      await workAction('status', { id: t.id, status });
      await loadTasks();
    } catch (e) {
      setErr((e as Error).message);
      await loadTasks(); // trả về trạng thái thật trên server
    }
  };

  const remove = async (t: WorkTask) => {
    if (!window.confirm(`Xóa công việc "${t.name}"?`)) return;
    try {
      await workAction('remove', { id: t.id });
      await loadTasks();
    } catch (e) { setErr((e as Error).message); }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  if (enabled === false) {
    return (
      <div className="panel" style={{ margin: 'auto', width: 'min(560px, 94%)' }}>
        <div className="office-hero">
          <div className="office-hero-ico" aria-hidden>📋</div>
          <div className="office-hero-title">Tab Công việc cần Mongo tool</div>
          <p className="office-hero-sub">Đặt <code>MONGO_TOOL_ENABLED=true</code> trong <code>.env.local</code> rồi khởi động lại.</p>
        </div>
      </div>
    );
  }
  if (view === null) {
    return <div className="panel" style={{ margin: 'auto' }}><span className="spinner" /> Đang tải…</div>;
  }
  if (!view.configured || showSetup) {
    return (
      <SetupPanel
        view={view}
        onSaved={(v) => { setView(v); setShowSetup(false); setTasks([]); if (v.configured) void loadTasks(); }}
        onCancel={view.configured ? () => setShowSetup(false) : undefined}
      />
    );
  }

  const monthLabel = `Tháng ${ym.m + 1}/${ym.y}`;
  const renderTaskRow = (t: WorkTask, badge?: string) => {
    const meta = STATUS_META[t.status];
    // Quá hạn chỉ có nghĩa với việc còn sống — đã xong/đã hủy thì thôi tô đỏ.
    const overdue = t.deadlineMs !== null && t.deadlineMs < Date.now() && meta.alerts;
    return (
      <div key={t.id} className={`wk-task st-${meta.cls}`}>
        <div className="wk-task-main">
          <div className="wk-task-line">
            <span className={`wk-st ${meta.cls}`} title={meta.hint}>{meta.icon} {meta.label}</span>
            <span className={`wk-pri ${PRIORITY_META[t.priority].cls}`}>{PRIORITY_META[t.priority].label}</span>
            {t.project && <span className="wk-proj">{t.project}</span>}
            <b className="wk-task-name">{t.name}</b>
            {badge && <span className="wk-badge-dl">{badge}</span>}
          </div>
          {t.desc && <div className="wk-task-desc">{t.desc}</div>}
          <div className="wk-task-meta">
            {t.dlDate && (
              // Hover = đếm ngược sống: "còn 2 ngày" / "còn 3 giờ 15 phút".
              <span
                className={overdue ? 'wk-overdue' : undefined}
                title={`${t.deadlineMs !== null ? remainText(t.deadlineMs) + ' · ' : ''}${meta.alerts ? alertLabel(t.alert) : `${meta.label} — không cảnh báo`}`}
              >
                ⏰ {fmtDl(t)}
              </span>
            )}
            {t.tags.map((tag) => <span key={tag} className="wk-tag">#{tag}</span>)}
          </div>
          {/* Nút chuyển nhanh — trạng thái hiện tại bị mờ + disable. */}
          <div className="wk-st-switch">
            {STATUS_ORDER.map((s) => (
              <button
                key={s}
                className={`wk-st-btn ${STATUS_META[s].cls}${t.status === s ? ' on' : ''}`}
                disabled={t.status === s}
                onClick={() => void changeStatus(t, s)}
                title={t.status === s ? `Đang ở: ${STATUS_META[s].label}` : `Chuyển sang: ${STATUS_META[s].label}${STATUS_META[s].alerts ? '' : ' (tắt cảnh báo)'}`}
              >
                {STATUS_META[s].icon} {STATUS_META[s].label}
              </button>
            ))}
          </div>
        </div>
        <div className="wk-task-acts">
          <button className="ghost sm" onClick={() => { setFormErr(null); setForm({ task: t }); }} title="Sửa">✎</button>
          <button className="ghost sm" onClick={() => void remove(t)} title="Xóa">🗑</button>
        </div>
      </div>
    );
  };

  return (
    <div className="panel sheet-panel">
      <div className="sheet-toolbar">
        <button className="ghost sm" onClick={() => setYm(({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }))}>‹</button>
        <b style={{ minWidth: 110, textAlign: 'center' }}>{monthLabel}</b>
        <button className="ghost sm" onClick={() => setYm(({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }))}>›</button>
        <button className="ghost sm" onClick={() => { const d = new Date(); setYm({ y: d.getFullYear(), m: d.getMonth() }); setSelDate(TODAY()); }}>Hôm nay</button>
        <span style={{ flex: 1 }} />
        <span className="badge" title="Kho lưu trữ">🍃 {view.connectionName} / {view.config?.database}</span>
        <button
          className="ghost sm"
          title="Sửa kho lưu trữ (đổi cụm Mongo / database)"
          onClick={() => {
            // Refetch trước khi mở: danh sách connection có thể vừa đổi ở tab Mongo.
            workAction<ConfigView>('config')
              .then((v) => { setView(v); setShowSetup(true); })
              .catch((e) => setErr((e as Error).message));
          }}
        >⚙</button>
        <button className="ghost sm" onClick={() => void loadTasks()} title="Tải lại">↻</button>
        <button className="sm" onClick={() => { setFormErr(null); setForm({ task: null }); }}>＋ Thêm công việc</button>
      </div>
      {/* ── Bộ lọc: keyword (dự án/tên/tag, không dấu) + thời gian ── */}
      <div className="wk-filter">
        <input
          className="input"
          placeholder="🔎 Lọc theo dự án, tên, tag (không phân biệt hoa thường, có dấu hay không)…"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          style={{ flex: 1, minWidth: 180 }}
        />
        <select className="input" value={rangeMode} onChange={(e) => setRangeMode(e.target.value as typeof rangeMode)} style={{ width: 150 }}>
          <option value="">Mọi thời gian</option>
          <option value="week">Tuần này</option>
          <option value="month">Tháng này</option>
          <option value="custom">Khoảng tự chọn…</option>
        </select>
        {rangeMode === 'custom' && (
          <>
            <input className="input" type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} title="Từ ngày" />
            <span className="small" style={{ color: 'var(--muted)' }}>→</span>
            <input className="input" type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} title="Đến ngày" />
          </>
        )}
        {/* Lọc theo TRẠNG THÁI — chip bật/tắt, không chọn cái nào = tất cả. */}
        <div className="wk-stfilter" role="group" aria-label="Lọc theo trạng thái">
          {STATUS_ORDER.map((s) => {
            const on = statusSel.includes(s);
            const n = tasks.filter((t) => t.status === s).length;
            return (
              <button
                key={s}
                className={`wk-st-btn ${STATUS_META[s].cls}${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => setStatusSel((prev) => (on ? prev.filter((x) => x !== s) : [...prev, s]))}
                title={`${STATUS_META[s].hint} · ${n} công việc`}
              >
                {STATUS_META[s].icon} {STATUS_META[s].label} <span className="wk-st-n">{n}</span>
              </button>
            );
          })}
        </div>
        {filterActive && (
          <button className="ghost sm" onClick={() => { setKw(''); setStatusSel([]); setRangeMode(''); setRangeFrom(''); setRangeTo(''); }}>
            ✕ Bỏ lọc
          </button>
        )}
      </div>
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '6px 0' }}>{err}</pre>}

      {filterActive ? (
        /* ── Chế độ LỌC: danh sách kết quả thay cho lịch ── */
        <div className="wk-results">
          <div className="group-title">
            Kết quả lọc: {filtered.length} công việc
            {statusSel.length > 0 && <span className="small" style={{ color: 'var(--muted)', fontWeight: 400 }}> · {statusSel.map((s) => STATUS_META[s].label).join(', ')}</span>}
            {range && <span className="small" style={{ color: 'var(--muted)', fontWeight: 400 }}> · {range.from.split('-').reverse().join('/')} → {range.to.split('-').reverse().join('/')}</span>}
          </div>
          {filtered.length === 0 && <p className="small" style={{ color: 'var(--muted)' }}>Không có công việc nào khớp bộ lọc.</p>}
          {filtered.map((t) => renderTaskRow(t))}
        </div>
      ) : (
      <div className="wk-body">
        {/* ── Lịch tháng ── */}
        <div className="wk-cal">
          <div className="wk-cal-head">
            {['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map((d) => <div key={d}>{d}</div>)}
          </div>
          {weeks.map((row, wi) => (
            <div key={wi} className="wk-cal-row">
              {row.map((cell) => {
                const starts = byStart.get(cell.date) ?? [];
                const dls = byDeadline.get(cell.date) ?? [];
                const isToday = cell.date === TODAY();
                return (
                  <button
                    key={cell.date}
                    className={[
                      'wk-day',
                      cell.inMonth ? '' : 'dim',
                      isToday ? 'today' : '',
                      selDate === cell.date ? 'sel' : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => setSelDate(cell.date)}
                    onDoubleClick={() => { setSelDate(cell.date); setFormErr(null); setForm({ task: null }); }}
                    title={`${cell.date}${dls.length ? ` · ${dls.length} deadline` : ''} — double-click để thêm công việc`}
                  >
                    <span className="wk-day-num">{cell.day}{dls.length > 0 && <span className="wk-day-dl" title={`${dls.length} deadline`}>⏰</span>}</span>
                    <span className="wk-day-chips">
                      {starts.slice(0, 3).map((t) => (
                        // Đã xong / đã hủy đều gạch ngang; hover cho biết trạng thái nào.
                        <span
                          key={t.id}
                          className={`wk-chip ${PRIORITY_META[t.priority].cls}${STATUS_META[t.status].alerts ? '' : ' done'}`}
                          title={`${STATUS_META[t.status].icon} ${STATUS_META[t.status].label} — ${t.name}`}
                        >{STATUS_META[t.status].icon} {t.name}</span>
                      ))}
                      {starts.length > 3 && <span className="wk-chip more">+{starts.length - 3}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* ── Panel ngày đang chọn + sắp đến hạn ── */}
        <aside className="wk-side">
          <div className="group-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ flex: 1 }}>Ngày {selDate.split('-').reverse().join('/')}</span>
            <button className="ghost sm" onClick={() => { setFormErr(null); setForm({ task: null }); }} title={`Thêm công việc bắt đầu ngày ${selDate}`}>＋</button>
          </div>
          {dayTasks.starts.length === 0 && dayTasks.dls.length === 0 && (
            <p className="small" style={{ color: 'var(--muted)' }}>Chưa có công việc nào — bấm ＋ để thêm.</p>
          )}
          {dayTasks.starts.map((t) => renderTaskRow(t))}
          {dayTasks.dls.length > 0 && <div className="group-title" style={{ marginTop: 8 }}>Deadline ngày này</div>}
          {dayTasks.dls.map((t) => renderTaskRow(t, 'deadline'))}

          {upcoming.length > 0 && (
            <>
              <div className="group-title" style={{ marginTop: 14 }}>⏰ Sắp đến hạn</div>
              {upcoming.map((t) => (
                <button key={t.id} className="wk-up" onClick={() => { setSelDate(t.startDate); }}
                  title={`${t.name}${t.deadlineMs !== null ? ` — ${remainText(t.deadlineMs)}` : ''}`}>
                  <span className={`wk-pri ${PRIORITY_META[t.priority].cls}`}>{PRIORITY_META[t.priority].label}</span>
                  <span className="wk-up-name">{t.name}</span>
                  <span className="wk-up-dl">{t.deadlineMs !== null ? remainText(t.deadlineMs) : fmtDl(t)}</span>
                </button>
              ))}
            </>
          )}
        </aside>
      </div>
      )}

      {form && (
        <TaskForm
          initial={form.task}
          startDate={selDate}
          projects={projects}
          busy={busy}
          err={formErr}
          onSave={(f) => void saveTask(f)}
          onClose={() => setForm(null)}
        />
      )}
    </div>
  );
}
