'use client';

// Tab REMOTE — sổ máy cần điều khiển từ xa, bấm một cái là bật đúng client.
//
// PHẠM VI: DevBox không tự vẽ màn hình máy kia. Muốn làm được vậy phải có host
// capture màn hình + relay xuyên NAT, tức là viết lại UltraViewer. Thay vào đó
// tab này lo phần mà UltraViewer làm dở: nhớ máy nào là máy nào (tên, dự án,
// ghi chú, ai dùng), tìm nhanh, rồi gọi UltraViewer/mstsc/AnyDesk mở thẳng.
//
// Mật khẩu lưu dạng niêm phong safeStorage (DPAPI) — không hiện ra màn hình,
// chỉ chép được vào clipboard đúng lúc bấm. Xem lib/remote.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listHosts, addHost, updateHost, removeHost, openHost, copyPassword, copyAddress,
  isDesktop, canEncrypt, type RemoteHost, type RemoteKind, type HostForm,
} from '@/lib/remote';
// Import từ remoteHostTypes (không có fs) chứ KHÔNG từ remoteHosts — file đó
// đọc/ghi đĩa, bundle vào browser sẽ lỗi "Can't resolve 'fs'".
import { KIND_META, REMOTE_KINDS } from '@/lib/remoteHostTypes';
import PasswordInput from './PasswordInput';

const EMPTY: HostForm = { name: '', kind: 'ultraviewer', address: '' };

const splitTags = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean);

/** "2 giờ trước" cho cột lần dùng gần nhất. */
function ago(iso?: string): string {
  if (!iso) return 'chưa dùng';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'vừa xong';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.round(h / 24);
  return d === 1 ? 'hôm qua' : `${d} ngày trước`;
}

export default function RemoteWorkspace() {
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [form, setForm] = useState<HostForm>(EMPTY);
  const [tagsText, setTagsText] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [q, setQ] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const desktop = isDesktop();
  const encrypts = canEncrypt();

  const reload = useCallback(async () => {
    try {
      setHosts(await listHosts());
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  // Thông báo tự tắt để không đọng lại trên màn hình.
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(''), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  const projects = useMemo(
    () => Array.from(new Set(hosts.map((h) => h.project).filter(Boolean) as string[])).sort(),
    [hosts],
  );

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return hosts.filter((h) => {
      if (filterProject && h.project !== filterProject) return false;
      if (!needle) return true;
      return [h.name, h.address, h.project, h.note, ...(h.tags ?? [])]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(needle));
    });
  }, [hosts, q, filterProject]);

  const resetForm = () => {
    setForm(EMPTY);
    setTagsText('');
    setEditing(null);
    setShowForm(false);
  };

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      const payload: HostForm = { ...form, tags: splitTags(tagsText) };
      const next = editing ? await updateHost(editing, payload) : await addHost(payload);
      setHosts(next);
      resetForm();
      setMsg(editing ? 'Đã lưu thay đổi.' : 'Đã thêm máy.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (h: RemoteHost) => {
    setEditing(h.id);
    setShowForm(true);
    setForm({
      name: h.name,
      kind: h.kind,
      address: h.address,
      username: h.username ?? '',
      password: '', // trống = giữ nguyên mật khẩu đang lưu
      project: h.project ?? '',
      note: h.note ?? '',
      network: h.network,
    });
    setTagsText((h.tags ?? []).join(', '));
  };

  const connect = async (h: RemoteHost) => {
    setErr('');
    try {
      const { manual } = await openHost(h);
      setMsg(
        manual
          ? `Đã bật ${KIND_META[h.kind].label} — ID "${h.address}" đã chép sẵn, dán vào ô máy đối tác.`
          : `Đang mở ${h.name}…`,
      );
      void reload(); // cập nhật "lần dùng gần nhất"
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const doCopy = async (fn: () => Promise<void>, what: string) => {
    setErr('');
    try {
      await fn();
      setMsg(`Đã chép ${what}.`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const del = async (h: RemoteHost) => {
    if (!window.confirm(`Xoá "${h.name}" khỏi danh sách?`)) return;
    setErr('');
    try {
      setHosts(await removeHost(h.id));
      setMsg('Đã xoá.');
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="rmt">
      <div className="rmt-head">
        <div>
          <h2 className="rmt-title">Máy từ xa</h2>
          <p className="rmt-sub">
            Sổ máy cần điều khiển — bấm <b>Kết nối</b> là DevBox bật sẵn phần mềm tương ứng
            (UltraViewer, Remote Desktop, AnyDesk…) và điền/chép sẵn ID cho bạn.
          </p>
        </div>
        <button className="rmt-add" onClick={() => (showForm ? resetForm() : setShowForm(true))}>
          {showForm ? 'Đóng' : '＋ Thêm máy'}
        </button>
      </div>

      {!desktop && (
        <div className="rmt-warn">
          Đang chạy ở bản web. Vẫn xem/sửa được danh sách, nhưng <b>bật phần mềm điều khiển
          thì phải mở app desktop</b> — trình duyệt không cho phép chạy chương trình trên máy.
        </div>
      )}

      {showForm && (
        <div className="rmt-form">
          <div className="rmt-form-row">
            <input
              className="input"
              placeholder="Tên máy — vd Máy build CI, PC anh Tuấn"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <select
              className="input"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as RemoteKind })}
            >
              {REMOTE_KINDS.map((k) => (
                <option key={k} value={k}>{KIND_META[k].label}</option>
              ))}
            </select>
            <select
              className="input"
              value={form.network ?? ''}
              onChange={(e) =>
                setForm({ ...form, network: (e.target.value || undefined) as 'lan' | 'wan' | undefined })
              }
              title="Chỉ để ghi chú và lọc"
            >
              <option value="">Mạng: không rõ</option>
              <option value="lan">Nội bộ / VPN</option>
              <option value="wan">Ngoài internet</option>
            </select>
          </div>

          <input
            className="input"
            placeholder={KIND_META[form.kind].hint}
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />

          <div className="rmt-form-row">
            <input
              className="input"
              placeholder="Tài khoản (optional — RDP hay cần)"
              autoComplete="off"
              value={form.username ?? ''}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
            <PasswordInput
              value={form.password ?? ''}
              onChange={(v) => setForm({ ...form, password: v })}
              placeholder={editing ? 'Mật khẩu (để trống = giữ nguyên)' : 'Mật khẩu (optional)'}
            />
          </div>

          <div className="rmt-form-row">
            <input
              className="input"
              placeholder="Dự án (optional)"
              value={form.project ?? ''}
              onChange={(e) => setForm({ ...form, project: e.target.value })}
            />
            <input
              className="input"
              placeholder="Tags, cách nhau dấu phẩy"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
            />
          </div>

          <input
            className="input"
            placeholder="Ghi chú — máy này dùng làm gì, lưu ý khi vào…"
            value={form.note ?? ''}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />

          {!encrypts && (
            <p className="rmt-hint">
              Máy này không dùng được safeStorage nên <b>không lưu mật khẩu</b> — các ô khác vẫn lưu bình thường.
            </p>
          )}

          <div className="rmt-form-actions">
            <button className="rmt-save" onClick={submit} disabled={busy}>
              {busy ? 'Đang lưu…' : editing ? 'Lưu thay đổi' : 'Thêm máy'}
            </button>
            <button className="rmt-cancel" onClick={resetForm}>Huỷ</button>
          </div>
        </div>
      )}

      {(err || msg) && (
        <div className={err ? 'rmt-err' : 'rmt-msg'}>{err || msg}</div>
      )}

      <div className="rmt-tools">
        <input
          className="input rmt-search"
          placeholder="Tìm theo tên, ID, ghi chú, tag…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {projects.length > 0 && (
          <select className="input rmt-filter" value={filterProject} onChange={(e) => setFilterProject(e.target.value)}>
            <option value="">Mọi dự án</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
        <span className="rmt-count">{shown.length}/{hosts.length} máy</span>
      </div>

      {shown.length === 0 ? (
        <div className="empty">
          <div className="empty-ico">🖥</div>
          <p>
            {hosts.length === 0
              ? 'Chưa có máy nào. Bấm “＋ Thêm máy” để lưu ID UltraViewer hoặc địa chỉ RDP đầu tiên.'
              : 'Không có máy nào khớp bộ lọc.'}
          </p>
        </div>
      ) : (
        <div className="rmt-list">
          {shown.map((h) => (
            <div className="rmt-card" key={h.id}>
              <div className="rmt-card-main">
                <div className="rmt-card-top">
                  <span className="rmt-kind" title={KIND_META[h.kind].label}>{KIND_META[h.kind].icon}</span>
                  <b className="rmt-name">{h.name}</b>
                  {h.network && (
                    <span className="rmt-net">{h.network === 'lan' ? 'nội bộ' : 'internet'}</span>
                  )}
                  {h.project && <span className="rmt-proj">{h.project}</span>}
                </div>
                <div className="rmt-addr">
                  <span className="rmt-kind-label">{KIND_META[h.kind].label}</span>
                  <code>{h.address}</code>
                  {h.username && <span className="rmt-user">· {h.username}</span>}
                </div>
                {h.note && <p className="rmt-note">{h.note}</p>}
                <div className="rmt-meta">
                  <span>{ago(h.lastUsedAt)}</span>
                  {!!h.useCount && <span>· đã mở {h.useCount} lần</span>}
                  {(h.tags ?? []).map((t) => <span className="rmt-tag" key={t}>{t}</span>)}
                </div>
              </div>

              <div className="rmt-card-actions">
                <button className="rmt-connect" onClick={() => connect(h)} disabled={!desktop}
                  title={desktop ? `Bật ${KIND_META[h.kind].label}` : 'Cần app desktop'}>
                  Kết nối
                </button>
                <button className="rmt-mini" onClick={() => doCopy(() => copyAddress(h), 'địa chỉ')}
                  title="Chép ID/địa chỉ">⧉</button>
                {h.passwordEnc && (
                  <button className="rmt-mini" onClick={() => doCopy(() => copyPassword(h), 'mật khẩu')}
                    title="Chép mật khẩu vào clipboard">🔑</button>
                )}
                <button className="rmt-mini" onClick={() => startEdit(h)} title="Sửa">✎</button>
                <button className="rmt-mini rmt-del" onClick={() => del(h)} title="Xoá">✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
