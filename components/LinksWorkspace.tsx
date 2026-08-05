'use client';

// Links workspace — bookmark manager cho MỌI link công việc (Jenkins build,
// Rancher logs, Google Docs bên thứ 3, wiki, dashboard…) + mở ngay trong app
// bằng <webview>. Chuyển từ mục 🔗 của tab Google ra tab riêng để rạch ròi:
// tab Google = Drive/Docs/Sheets qua OAuth; tab Links = bookmark + phiên
// đăng nhập user/pass.
//
// PROFILE session: mỗi link gán một profile (optional). Link cùng profile mở
// chung một partition → login một lần dùng cho cả nhóm; hai tài khoản trên
// cùng service = hai profile. Không gán profile = phiên chung mặc định.
// Metadata (dự án/mô tả/tags) + lọc theo dự án/tag như trước.

import { useCallback, useEffect, useState } from 'react';
import { lList, lAdd, lUpdate, lRemove, partitionFor, type SavedLink, type SavedLinkMeta } from '@/lib/links';
import { fmtRel } from '@/lib/google';
import LinkViewer from './LinkViewer';
import PasswordManager from './PasswordManager';

/** Một TAB viewer đang mở. Kèm metadata đang gõ dở ở "＋ chi tiết" (nếu có)
 *  — để bấm 💾 TRONG viewer vẫn lưu đủ dự án/tags, không chỉ tên + profile.
 *  Mở được nhiều tab song song; webview tab nền vẫn sống (offscreen). */
interface ViewerTab { id: string; name: string; url: string; partition: string; meta?: SavedLinkMeta }

type MetaDraft = SavedLinkMeta & { tagsText?: string };

const splitTags = (s?: string) => (s ?? '').split(',').map((t) => t.trim()).filter(Boolean);

/** Form metadata — dùng cho "＋ chi tiết" khi lưu mới và khi sửa (✎). */
function MetaFields({ meta, onChange }: { meta: MetaDraft; onChange: (m: MetaDraft) => void }) {
  return (
    <>
      <div className="glink-meta-pair">
        <input className="input" placeholder="Tên hiển thị (optional)" value={meta.name ?? ''}
          onChange={(e) => onChange({ ...meta, name: e.target.value })} />
        <input className="input" placeholder="Dự án (optional)" value={meta.project ?? ''}
          onChange={(e) => onChange({ ...meta, project: e.target.value })} />
        <input className="input" placeholder="Profile phiên đăng nhập (optional) — vd jenkins-prod"
          value={meta.profile ?? ''}
          onChange={(e) => onChange({ ...meta, profile: e.target.value })}
          title="Link cùng profile dùng chung phiên đăng nhập trong viewer. Hai tài khoản cùng một service → đặt hai profile khác nhau. Bỏ trống = phiên chung." />
      </div>
      <input className="input" placeholder="Mô tả ngắn (optional)" value={meta.description ?? ''}
        onChange={(e) => onChange({ ...meta, description: e.target.value })} />
      <input className="input" placeholder="Tags, cách nhau dấu phẩy (optional) — vd: jenkins, logs, omicx"
        value={meta.tagsText ?? ''}
        onChange={(e) => onChange({ ...meta, tagsText: e.target.value })} />
      {/* User/pass ở ĐÂY là cách CŨ: lưu plaintext trong links.json và chỉ dùng
          khi bấm 🔑. Cách mới (khuyến nghị) là cứ đăng nhập bình thường rồi bấm
          "Lưu" ở thanh hỏi mật khẩu — nó lưu theo origin, mã hóa DPAPI, và TỰ
          ĐIỀN lần sau. Giữ lại hai ô này để dữ liệu cũ không mất, nhưng nói rõ
          để khỏi tưởng đây là chỗ lưu mật khẩu chính. */}
      <details className="glink-legacy-creds">
        <summary className="small" style={{ color: 'var(--muted)', cursor: 'pointer' }}>
          Tài khoản site (cách cũ) — thường KHÔNG cần nữa
        </summary>
        <p className="small" style={{ color: 'var(--muted)', margin: '4px 0' }}>
          Không cần điền: mở link rồi đăng nhập như bình thường, thanh <b>&ldquo;Lưu mật khẩu?&rdquo;</b> sẽ
          hiện — bấm Lưu là lần sau tự điền (mã hóa bằng Windows DPAPI). Hai ô dưới đây lưu{' '}
          <b>plaintext</b> trong <code>configs/links.json</code> và chỉ dùng khi bấm 🔑.
        </p>
        <div className="glink-meta-pair">
          <input className="input" placeholder="Username (cách cũ, optional)" value={meta.username ?? ''}
            autoComplete="off" onChange={(e) => onChange({ ...meta, username: e.target.value })} />
          <input className="input" type="password" placeholder="Password (cách cũ, optional)"
            value={meta.password ?? ''} autoComplete="new-password"
            onChange={(e) => onChange({ ...meta, password: e.target.value })} />
        </div>
      </details>
    </>
  );
}

export default function LinksWorkspace() {
  const [links, setLinks] = useState<SavedLink[]>([]);
  const [url, setUrl] = useState('');
  const [addMeta, setAddMeta] = useState<MetaDraft>({});
  const [showMeta, setShowMeta] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tabs, setTabs] = useState<ViewerTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);

  // Bộ lọc: 1 dự án + 1 tag (click lần nữa để bỏ).
  const [fProject, setFProject] = useState<string | null>(null);
  const [fTag, setFTag] = useState<string | null>(null);

  // Sửa inline: id của link đang mở form ✎.
  const [editId, setEditId] = useState<string | null>(null);
  const [editMeta, setEditMeta] = useState<MetaDraft>({});
  const [pwOpen, setPwOpen] = useState(false); // modal 🔑 Mật khẩu đã lưu

  const reload = useCallback(async () => {
    setLoading(true); setErr(null);
    try { setLinks(await lList()); } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const nameFor = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };

  /** Mở trong viewer nhúng — link đã mở rồi thì kích hoạt tab cũ, chưa thì
   *  thêm tab mới; fallback browser ngoài khi chạy web thường. */
  const openInApp = useCallback((name: string, target: string, profile?: string, meta?: SavedLinkMeta) => {
    if (typeof window === 'undefined' || !window.workspace?.isDesktop) {
      window.open(target, '_blank'); // plain browser — <webview> không tồn tại
      return;
    }
    const partition = partitionFor(profile);
    const id = `${partition}|${target}`;
    setTabs((cur) => (cur.some((t) => t.id === id) ? cur : [...cur, { id, name, url: target, partition, meta }]));
    setActiveTab(id);
  }, []);

  /** Đóng một tab; đang đóng tab nổi thì chuyển sang tab kề. */
  const closeTab = useCallback((id: string) => {
    setTabs((cur) => {
      const idx = cur.findIndex((t) => t.id === id);
      const next = cur.filter((t) => t.id !== id);
      setActiveTab((act) => (act === id ? next[Math.max(0, idx - 1)]?.id ?? null : act));
      return next;
    });
  }, []);

  /** Mở link đang gõ — KHÔNG lưu, nhưng MANG THEO metadata đang gõ dở để nút
   *  💾 trong viewer lưu đầy đủ (flow: dán link → gõ chi tiết → Mở → 💾). */
  const open = () => {
    const raw = url.trim();
    if (!raw) return;
    // Thêm https:// nếu gõ thiếu scheme — nếu không webview hiểu là đường dẫn
    // tương đối → 404 (vd gõ "sso.example.com").
    const u = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
    openInApp(addMeta.name?.trim() || nameFor(u), u, addMeta.profile, {
      ...addMeta,
      tags: splitTags(addMeta.tagsText),
    });
  };

  /** Lưu link đang gõ (kèm metadata nếu đã mở "＋ chi tiết"). */
  const save = async () => {
    const u = url.trim();
    if (!u) return;
    setSaving(true); setErr(null);
    try {
      setLinks(await lAdd(u, { ...addMeta, tags: splitTags(addMeta.tagsText) }));
      setUrl(''); setAddMeta({}); setShowMeta(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (l: SavedLink) => {
    if (!window.confirm(`Xóa link "${l.name}" khỏi danh sách đã lưu?`)) return;
    try { setLinks(await lRemove(l.id)); } catch (e) { setErr((e as Error).message); }
  };

  const startEdit = (l: SavedLink) => {
    setEditId(l.id);
    setEditMeta({
      name: l.name, project: l.project ?? '', description: l.description ?? '',
      profile: l.profile ?? '', tagsText: (l.tags ?? []).join(', '),
      username: l.username ?? '', password: l.password ?? '',
    });
  };

  const saveEdit = async () => {
    if (!editId) return;
    setSaving(true); setErr(null);
    try {
      setLinks(await lUpdate(editId, {
        name: editMeta.name ?? '',
        project: editMeta.project ?? '',
        description: editMeta.description ?? '',
        profile: editMeta.profile ?? '',
        username: editMeta.username ?? '',
        password: editMeta.password ?? '',
        tags: splitTags(editMeta.tagsText),
      }));
      setEditId(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Giá trị lọc lấy từ dữ liệu thật — dự án/tag nào có link mới hiện chip.
  const projects = [...new Set(links.map((l) => l.project).filter(Boolean) as string[])].sort();
  const tags = [...new Set(links.flatMap((l) => l.tags ?? []))].sort();
  const shown = links.filter((l) =>
    (!fProject || l.project === fProject) && (!fTag || (l.tags ?? []).includes(fTag)));

  return (
    <div className="panel sheet-panel">
      <div className="g-list-wrap" style={{ padding: '2px 0' }}>
        <div className="g-toolbar">
          <input
            className="input g-search"
            placeholder="Dán link bất kỳ (Jenkins, Rancher, Docs…) rồi Enter để mở trong app…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && open()}
          />
          <button className="ghost sm" onClick={open} disabled={!url.trim()} title="Mở link trong app (không lưu)">
            ▶ Mở
          </button>
          <button className="ghost sm" onClick={() => void save()} disabled={saving || !url.trim()} title="Lưu vào danh sách bên dưới">
            {saving ? <span className="spinner" aria-hidden /> : '💾'} Lưu
          </button>
          <button className={`chip-btn${showMeta ? ' on' : ''}`} onClick={() => setShowMeta((v) => !v)}
            title="Tên / dự án / profile / mô tả / tags cho link sắp lưu — tất cả optional">
            ＋ chi tiết
          </button>
          <button className="ghost sm" onClick={() => setPwOpen(true)}
            title="Mật khẩu đã lưu — tự điền khi mở lại trang login">🔑</button>
          <button className="ghost sm" onClick={() => void reload()} disabled={loading} title="Tải lại danh sách đã lưu">
            {loading ? <span className="spinner" aria-hidden /> : '↻'}
          </button>
        </div>
        {showMeta && (
          <div className="glink-meta-form">
            <MetaFields meta={addMeta} onChange={setAddMeta} />
          </div>
        )}

        {(projects.length > 0 || tags.length > 0) && (
          <div className="glink-filters">
            {projects.map((p) => (
              <button key={`p-${p}`} className={`chip-btn${fProject === p ? ' on' : ''}`}
                onClick={() => setFProject(fProject === p ? null : p)} title={`Lọc theo dự án ${p}`}>
                📁 {p}
              </button>
            ))}
            {projects.length > 0 && tags.length > 0 && <span className="glink-filter-sep" aria-hidden />}
            {tags.map((t) => (
              <button key={`t-${t}`} className={`chip-btn${fTag === t ? ' on' : ''}`}
                onClick={() => setFTag(fTag === t ? null : t)} title={`Lọc theo tag ${t}`}>
                #{t}
              </button>
            ))}
            {(fProject || fTag) && (
              <button className="ghost sm" onClick={() => { setFProject(null); setFTag(null); }} title="Bỏ lọc">
                ✕ Bỏ lọc ({shown.length}/{links.length})
              </button>
            )}
          </div>
        )}

        {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{err}</pre>}
        <div className="g-list">
          {shown.map((l) => (
            <div key={l.id}>
              <a
                className="g-row"
                href={l.url}
                onClick={(e) => {
                  e.preventDefault();
                  // Mang THEO đủ metadata của link (dự án/tags/mô tả/profile),
                  // không chỉ user/pass — nút 💾 trong viewer lưu lại mới đúng.
                  openInApp(l.name, l.url, l.profile, {
                    name: l.name, project: l.project, description: l.description,
                    profile: l.profile, tags: l.tags,
                    username: l.username, password: l.password,
                  });
                }}
                title={`${l.url} — mở trong app`}
              >
                <span className="g-ico" aria-hidden>🔗</span>
                <span className="g-name">
                  <span className="g-base">
                    {l.name}
                    {l.project && <span className="glink-badge" title={`Dự án ${l.project}`}>📁 {l.project}</span>}
                    {l.profile && <span className="glink-badge glink-profile" title={`Phiên đăng nhập "${l.profile}"`}>🔑 {l.profile}</span>}
                    {(l.tags ?? []).map((t) => <span key={t} className="glink-tag">#{t}</span>)}
                  </span>
                  <span className="g-meta">
                    {l.description ? `${l.description} · ` : ''}{l.url}{l.addedAt ? ` · lưu ${fmtRel(l.addedAt)}` : ''}
                  </span>
                </span>
                <span
                  className="g-open"
                  title="Sửa tên / dự án / profile / mô tả / tags"
                  onClick={(e) => {
                    e.preventDefault(); e.stopPropagation();
                    if (editId === l.id) setEditId(null); else startEdit(l);
                  }}
                >
                  ✎
                </span>
                <span
                  className="g-open"
                  title="Mở bằng trình duyệt ngoài"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(l.url, '_blank'); }}
                >
                  ↗
                </span>
                <span
                  className="g-open"
                  title="Xóa khỏi danh sách"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); void remove(l); }}
                >
                  ✕
                </span>
              </a>
              {editId === l.id && (
                <div className="glink-meta-form glink-edit">
                  <MetaFields meta={editMeta} onChange={setEditMeta} />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="sm" onClick={() => void saveEdit()} disabled={saving}>
                      {saving ? <span className="spinner" aria-hidden /> : '💾'} Lưu thay đổi
                    </button>
                    <button className="ghost sm" onClick={() => setEditId(null)}>Hủy</button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {!loading && links.length === 0 && !err && (
            <div className="empty" style={{ padding: '24px 8px' }}>
              <p className="small">
                Chưa có link nào. Dán link Jenkins/Rancher/Docs… vào ô trên rồi 💾 để giữ lại —
                mở trong app, đăng nhập một lần là phiên được lưu (theo profile).
              </p>
            </div>
          )}
          {!loading && links.length > 0 && shown.length === 0 && (
            <div className="empty" style={{ padding: '24px 8px' }}>
              <p className="small">Không có link nào khớp bộ lọc.</p>
            </div>
          )}
        </div>
      </div>

      {tabs.length > 0 && (
        /* activeTab=null → chế độ THU NHỎ: chỉ còn thanh tab dưới đáy, danh
           sách link lộ ra để mở thêm; webview các tab vẫn sống offscreen. */
        <div className={`lv-wrap${activeTab ? '' : ' lv-min'}`}>
          <div className="lv-tabbar" role="tablist" aria-label="Link tabs">
            {tabs.map((t) => (
              <span key={t.id} className={`lv-tab${t.id === activeTab ? ' on' : ''}`} title={t.url}>
                <button className="lv-tab-btn" role="tab" aria-selected={t.id === activeTab}
                  onClick={() => setActiveTab(t.id)}>
                  {t.name}
                </button>
                <button className="lv-tab-x" title="Đóng tab"
                  onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>✕</button>
              </span>
            ))}
            <span style={{ flex: 1 }} />
            {activeTab ? (
              <button className="ghost sm" title="Về danh sách để mở thêm link — các tab vẫn giữ nguyên"
                onClick={() => setActiveTab(null)}>＋ Link mới</button>
            ) : (
              <span className="small" style={{ color: 'var(--muted)', padding: '0 6px' }}>
                chọn link ở danh sách trên để mở tab mới
              </span>
            )}
            <button className="ghost sm" title="Đóng tất cả tab, về danh sách"
              onClick={() => { setTabs([]); setActiveTab(null); }}>✕ Đóng hết</button>
          </div>
          <div className="lv-body">
            {tabs.map((t) => (
              <LinkViewer
                key={t.id}
                name={t.name}
                url={t.url}
                partition={t.partition}
                hidden={t.id !== activeTab}
                creds={{ username: t.meta?.username, password: t.meta?.password }}
                profile={t.meta?.profile}
                passwordManager
                onClose={() => closeTab(t.id)}
                onSaveLink={async (name, target) => {
                  // Lưu kèm profile của phiên tab này + metadata gõ dở ở "＋ chi tiết".
                  const profile = t.partition.replace(/^persist:links-/, '').replace(/^shared$/, '');
                  await lAdd(target, {
                    ...t.meta,
                    name: t.meta?.name?.trim() || name,
                    profile: t.meta?.profile?.trim() || profile,
                  });
                  setUrl(''); setAddMeta({}); setShowMeta(false);
                  await reload();
                }}
              />
            ))}
          </div>
        </div>
      )}

      {pwOpen && <PasswordManager onClose={() => setPwOpen(false)} />}
    </div>
  );
}
