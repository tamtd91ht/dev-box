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

import { useCallback, useEffect, useRef, useState } from 'react';
import { lList, lAdd, lUpdate, lRemove, partitionFor, type SavedLink, type SavedLinkMeta } from '@/lib/links';
import { onOpenUrl } from '@/lib/openTarget';
import { normalizeUrl } from '@/lib/bookmarks';
import { fmtRel } from '@/lib/google';
import LinkViewer from './LinkViewer';
import PasswordManager from './PasswordManager';
import PasswordInput from './PasswordInput';
import DupTabDialog, { tabUrlKey } from './DupTabDialog';

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
      <input className="input" placeholder="Tags, cách nhau dấu phẩy (optional) — vd: jenkins, logs, backend"
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
          <PasswordInput value={meta.password ?? ''} onChange={(v) => onChange({ ...meta, password: v })}
            placeholder="Password (cách cũ, optional)" />
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
  /** Id tab = số thứ tự (không dựng từ url nữa) để mở được nhiều tab cùng một
   *  link; "link này mở chưa" do map dưới trả lời — xem DupTabDialog. */
  const tabSeqRef = useRef(0);
  const tabKeysRef = useRef<Map<string, string>>(new Map());
  /** Chống event phát lặp (OpenLinkDialog bắn hai lần) — xem BrowserTabWorkspace. */
  const recentOpenRef = useRef<{ key: string; at: number; id: string } | null>(null);
  const [dupAsk, setDupAsk] = useState<{
    name: string; url: string; profile?: string; meta?: SavedLinkMeta;
    existingId: string; existingName: string;
  } | null>(null);

  // Map "link → tab đang mở" đi theo danh sách tab (mở/đóng đều được phủ).
  useEffect(() => {
    const m = new Map<string, string>();
    for (const t of tabs) {
      const k = tabUrlKey(t.partition, t.url);
      if (!m.has(k)) m.set(k, t.id);
    }
    tabKeysRef.current = m;
  }, [tabs]);

  /** Menu chuột phải trên thanh tab: Đóng tab này / Đóng hết.
   *  tabId = null khi chuột phải vào khoảng trống của thanh. */
  const [tabCtx, setTabCtx] = useState<{ x: number; y: number; tabId: string | null } | null>(null);

  // Click bất kỳ đâu (hoặc chuột phải chỗ khác) → đóng menu ngữ cảnh.
  useEffect(() => {
    if (!tabCtx) return;
    const close = () => setTabCtx(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close, true);
    };
  }, [tabCtx]);

  // Hộp thoại/menu phải nổi TRÊN <webview> (guest vẽ ở tầng native, đè mọi z-index).
  useEffect(() => {
    const root = document.documentElement;
    if (dupAsk || tabCtx) root.setAttribute('data-popup-over-webview', '1');
    else root.removeAttribute('data-popup-over-webview');
    return () => root.removeAttribute('data-popup-over-webview');
  }, [dupAsk, tabCtx]);

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

  /** Mở trong viewer nhúng; fallback browser ngoài khi chạy web thường.
   *
   *  Link ĐANG MỞ SẴN thì không âm thầm nhảy về tab cũ nữa mà HỎI (chuyển tới
   *  hay mở thêm tab mới) — mở hai tab cùng một trang là nhu cầu thật.
   *  `forceNew` = người dùng đã chọn "Mở thêm tab mới" trong hộp thoại. */
  const openInApp = useCallback((
    name: string, target: string, profile?: string, meta?: SavedLinkMeta,
    forceNew = false,
    /** Tab mới chạy NỀN (ctrl+click kiểu Chrome) — giữ nguyên trang đang đọc. */
    background = false,
  ) => {
    if (typeof window === 'undefined' || !window.workspace?.isDesktop) {
      window.open(target, '_blank'); // plain browser — <webview> không tồn tại
      return;
    }
    const partition = partitionFor(profile);
    const key = tabUrlKey(partition, target);

    if (!forceNew) {
      // Cùng event bị phát lặp trong ~2s (OpenLinkDialog bắn hai lần) → tiếng
      // vọng, kích hoạt tab vừa mở chứ đừng bật hộp thoại lên trước mặt.
      const recent = recentOpenRef.current;
      if (recent && recent.key === key && Date.now() - recent.at < 2000) {
        if (!background) setActiveTab(recent.id);
        return;
      }
      const existingId = tabKeysRef.current.get(key);
      if (existingId) {
        const existing = tabs.find((t) => t.id === existingId);
        setDupAsk({ name, url: target, profile, meta, existingId, existingName: existing?.name ?? name });
        return;
      }
    }

    const id = `tab-${++tabSeqRef.current}`;
    recentOpenRef.current = { key, at: Date.now(), id };
    setTabs((cur) => [...cur, { id, name, url: target, partition, meta }]);
    if (!background) setActiveTab(id);
  }, [tabs]);

  // Ctrl+click / chuột giữa TRONG một webview (tab Links, viewer Google) →
  // main process gửi về đây (workspace:openInLinksTab): mở tab mới CHẠY NỀN
  // như Chrome, giữ nguyên trang đang đọc; phiên lấy theo tab đang xem.
  // forceNew: ctrl+click là chủ ý muốn THÊM tab, kể cả link đang mở sẵn.
  useEffect(() => {
    if (!window.workspace?.onOpenInLinksTab) return;
    return window.workspace.onOpenInLinksTab((u) => {
      const from = tabs.find((t) => t.id === activeTab);
      const profile = from
        ? from.partition.replace(/^persist:links-/, '').replace(/^shared$/, '')
        : '';
      openInApp(nameFor(u), u, profile || undefined, undefined, true, true);
    });
  }, [openInApp, tabs, activeTab]);

  // Link bấm trong tin nhắn Zalo/Telegram đã chọn "Mở trong tab Links".
  // Không profile: link lạ chưa thuộc nhóm đăng nhập nào → phiên chung.
  // OpenLinkDialog phát event hai lần (lo tab vừa mount chưa kịp nghe); cú thứ
  // hai bị openInApp nhận diện là tiếng vọng (recentOpenRef) nên vô hại.
  useEffect(() => onOpenUrl('links', (u) => openInApp(nameFor(u), u)), [openInApp]);

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
    // Thêm scheme nếu gõ thiếu — nếu không webview hiểu là đường dẫn tương đối
    // → 404 (vd gõ "sso.example.com"). Dùng chung normalizeUrl với tab Browser
    // nên localhost/mạng riêng ra http, còn từ khóa thì tìm Google.
    const u = normalizeUrl(raw);
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

  /** Link ĐỤNG PHIÊN: cùng host, khác username, mà lại chung một partition.
   *
   *  partitionFor() gộp mọi link không profile vào `links-shared`, nên hai tài
   *  khoản trên cùng service sẽ ghi đè cookie của nhau — đăng nhập cái này là
   *  văng cái kia, lặp vô hạn. Đây là VẤN ĐỀ DỮ LIỆU (chưa gán profile) chứ
   *  không phải lỗi code, và chỉ người dùng mới biết hai tài khoản đó nên tách
   *  hay dùng chung — nên chỉ cảnh báo kèm cách sửa, không tự đoán.
   *
   *  Cùng host + cùng username thì KHÔNG cảnh báo: đó đúng là trường hợp muốn
   *  dùng chung một phiên (vd nhiều link Rancher của cùng một account). */
  const clashing = (() => {
    const byKey = new Map<string, Set<string>>();
    for (const l of links) {
      const user = (l.username ?? '').trim();
      if (!user) continue; // không biết tài khoản nào → không kết luận
      let host = '';
      try { host = new URL(l.url).host; } catch { continue; }
      const key = `${host}|${partitionFor(l.profile)}`;
      (byKey.get(key) ?? byKey.set(key, new Set()).get(key)!).add(user);
    }
    return new Set([...byKey].filter(([, users]) => users.size > 1).map(([key]) => key));
  })();

  const clashOf = (l: SavedLink): string | null => {
    const user = (l.username ?? '').trim();
    if (!user) return null;
    try { return clashing.has(`${new URL(l.url).host}|${partitionFor(l.profile)}`) ? new URL(l.url).host : null; }
    catch { return null; }
  };

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
                    {clashOf(l) && (
                      <span
                        className="glink-badge glink-clash"
                        title={`Đụng phiên: có link khác trên ${clashOf(l)} dùng tài khoản khác nhưng CHUNG một phiên đăng nhập.\n\nHai tài khoản sẽ ghi đè cookie của nhau — đăng nhập cái này là văng cái kia.\n\nSửa: bấm ✎ rồi đặt "profile" khác nhau cho mỗi tài khoản (vd "admin", "readonly").`}
                      >
                        ⚠ đụng phiên
                      </span>
                    )}
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
          <div
            className="lv-tabbar"
            role="tablist"
            aria-label="Link tabs"
            // Chuột phải khoảng trống của thanh → menu chỉ có "Đóng hết".
            onContextMenu={(e) => { e.preventDefault(); setTabCtx({ x: e.clientX, y: e.clientY, tabId: null }); }}
          >
            {tabs.map((t) => (
              <span key={t.id} className={`lv-tab${t.id === activeTab ? ' on' : ''}`}
                title={`${t.url} — chuột phải: Đóng tab / Đóng hết`}
                onContextMenu={(e) => {
                  e.preventDefault(); e.stopPropagation();
                  setTabCtx({ x: e.clientX, y: e.clientY, tabId: t.id });
                }}>
                <button className="lv-tab-btn" role="tab" aria-selected={t.id === activeTab}
                  onClick={() => setActiveTab(t.id)}>
                  {t.name}
                </button>
                <button className="lv-tab-x" title="Đóng tab"
                  onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>✕</button>
              </span>
            ))}
            {/* ＋ dính ngay cạnh tab cuối — như Chrome: bấm là về màn hình mở
                link mới, các tab đang mở giữ nguyên (webview vẫn sống). */}
            <button className="bt-newtab" onClick={() => setActiveTab(null)}
              title="Link mới — về danh sách/ô nhập để mở thêm (các tab giữ nguyên)">＋</button>
            <span style={{ flex: 1 }} />
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
                addressBar
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

      {/* Hộp thoại "link đang mở sẵn" — chuyển tới tab cũ hay mở thêm tab mới. */}
      {dupAsk && (
        <DupTabDialog
          url={dupAsk.url}
          existingName={dupAsk.existingName}
          onGoExisting={() => { setActiveTab(dupAsk.existingId); setDupAsk(null); }}
          onOpenNew={() => {
            const d = dupAsk;
            setDupAsk(null);
            openInApp(d.name, d.url, d.profile, d.meta, true);
          }}
          onCancel={() => setDupAsk(null)}
        />
      )}

      {/* Menu chuột phải trên thanh tab — thay cho nút "✕ Đóng hết" thường trực. */}
      {tabCtx && (
        <div
          className="bt-ctx"
          style={{
            position: 'fixed',
            left: Math.min(tabCtx.x, window.innerWidth - 210),
            top: Math.min(tabCtx.y, window.innerHeight - 110),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {tabCtx.tabId && (
            <button onClick={() => { closeTab(tabCtx.tabId!); setTabCtx(null); }}>
              ✕ Đóng tab này
            </button>
          )}
          <button className="danger" onClick={() => { setTabs([]); setActiveTab(null); setTabCtx(null); }}>
            ✕ Đóng hết ({tabs.length} tab)
          </button>
        </div>
      )}

      {pwOpen && <PasswordManager onClose={() => setPwOpen(false)} />}
    </div>
  );
}
