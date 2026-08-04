'use client';

// Tools workspace — format + xem JSON / XML / HTML cho đẹp (Monaco highlight,
// folding), và riêng JSON/text có tạo mới + lưu trữ snippet (store .docs.json).
//
// Trái: editor Monaco (nhập/dán, hoặc mở snippet đã lưu). Phải khi kind=html:
// preview render trong iframe sandbox. Nút Format/Minify gọi lib/format.ts;
// nút Lưu/Mới/Xóa gọi store qua lib/docs.ts.

import { useCallback, useEffect, useRef, useState } from 'react';
import '@/lib/monacoSetup'; // Monaco local /monaco/vs — phải config trước lần init đầu
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditorNs } from 'monaco-editor';
import { formatText, minifyJson, monacoLangFor, type FormatKind } from '@/lib/format';
import { dList, dSave, dRemove, dSaveFile, type SavedDoc } from '@/lib/docs';
import { fmtRel } from '@/lib/google';
import FolderPicker from './FolderPicker';

const KINDS: { key: FormatKind; label: string }[] = [
  { key: 'json', label: 'JSON' },
  { key: 'xml', label: 'XML' },
  { key: 'html', label: 'HTML' },
];

export default function ToolsWorkspace() {
  const [kind, setKind] = useState<FormatKind>('json');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState(false); // HTML: xem render
  const [docs, setDocs] = useState<SavedDoc[]>([]);
  const [openId, setOpenId] = useState<string | null>(null); // snippet đang mở (để Lưu đè)
  const [dirty, setDirty] = useState(false);
  const edRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(null);
  // Modal: 'store' = đặt tên lưu vào kho; 'file' = chọn thư mục + tên ghi file thật.
  const [modal, setModal] = useState<null | 'store' | 'file'>(null);
  const [nameInput, setNameInput] = useState('');
  const [pickDir, setPickDir] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const reloadDocs = useCallback(() => { dList().then(setDocs).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => { reloadDocs(); }, [reloadDocs]);

  const onMount: OnMount = (ed) => { edRef.current = ed; };

  const format = () => {
    const r = formatText(kind, text);
    setErr(r.ok ? null : r.error ?? 'Lỗi định dạng');
    if (r.ok) { setText(r.text); setDirty(true); }
  };
  const minify = () => {
    const r = minifyJson(text);
    setErr(r.ok ? null : r.error ?? null);
    if (r.ok) { setText(r.text); setDirty(true); }
  };

  const copy = async () => { try { await navigator.clipboard.writeText(text); } catch { /* ignore */ } };

  // ── Store snippet (JSON/text) ─────────────────────────────────────────────
  const newDoc = () => { setText(''); setErr(null); setOpenId(null); setDirty(false); setPreview(false); };

  const defaultExt = kind === 'json' ? '.json' : kind === 'xml' ? '.xml' : kind === 'html' ? '.html' : '.txt';

  /** Mở modal đặt tên. Đang mở snippet cũ → Lưu đè thẳng khỏi hỏi tên. */
  const openStoreModal = async () => {
    if (openId) { await saveStore(docs.find((d) => d.id === openId)?.name ?? ''); return; }
    setNameInput(''); setModal('store');
  };

  const saveStore = async (name: string) => {
    const docKind = kind === 'json' ? 'json' : 'text'; // XML/HTML lưu dạng text thô
    try {
      const before = new Set(docs.map((d) => d.id));
      const list = await dSave({ id: openId ?? undefined, name, kind: docKind, content: text });
      setDocs(list);
      if (!openId) setOpenId(list.find((d) => !before.has(d.id))?.id ?? null);
      setDirty(false); setModal(null);
    } catch (e) { setErr((e as Error).message); }
  };

  const saveToFile = async () => {
    if (!pickDir || !nameInput.trim()) return;
    try {
      const { path } = await dSaveFile(pickDir, nameInput.trim(), text);
      setErr(null); setModal(null);
      window.alert(`Đã lưu: ${path}`);
    } catch (e) { setErr((e as Error).message); }
  };

  const openDoc = (d: SavedDoc) => {
    // Snippet JSON mở ở tab JSON (format được); text mở ở tab JSON để xem/sửa
    // nhưng người dùng cứ để nguyên — không bắt buộc format.
    setKind('json');
    setText(d.content); setOpenId(d.id); setDirty(false); setErr(null); setPreview(false);
  };

  const removeDoc = async (d: SavedDoc) => {
    if (!window.confirm(`Xóa "${d.name}"?`)) return;
    try { setDocs(await dRemove(d.id)); if (openId === d.id) setOpenId(null); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="panel sheet-panel">
      <div className="g-toolbar">
        <div className="office-subnav" role="tablist" aria-label="Format kind">
          {KINDS.map((k) => (
            <button key={k.key} role="tab" aria-selected={kind === k.key}
              className={`office-subnav-btn${kind === k.key ? ' on' : ''}`}
              onClick={() => { setKind(k.key); setErr(null); if (k.key !== 'html') setPreview(false); }}>
              <span className="office-subnav-text">{k.label}</span>
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <button className="sm" onClick={format} title="Định dạng đẹp (Format / Beautify)">✨ Format</button>
        {kind === 'json' && <button className="ghost sm" onClick={minify} title="Rút gọn một dòng">Minify</button>}
        {kind === 'html' && <button className={`chip-btn${preview ? ' on' : ''}`} onClick={() => setPreview((v) => !v)}>👁 Preview</button>}
        <button className="ghost sm" onClick={copy} title="Copy toàn bộ">⧉ Copy</button>
        <span className="glink-filter-sep" aria-hidden />
        <button className="ghost sm" onClick={newDoc} title="Tạo tài liệu mới (trống)">＋ Mới</button>
        <button className="ghost sm" onClick={() => void openStoreModal()} title="Lưu vào kho trong app (JSON/text)">
          💾 {openId ? 'Lưu' : 'Lưu kho'}
        </button>
        <button className="ghost sm" onClick={() => { setNameInput(`untitled${defaultExt}`); setPickDir(null); setModal('file'); }}
          title="Lưu ra file thật — chọn thư mục trên máy">
          📁 Lưu ra file…
        </button>
      </div>
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '4px 0' }}>{err}</pre>}

      <div className="tools-body">
        {/* Rail trái: snippet đã lưu */}
        <aside className="g-rail tools-rail">
          <div className="group-title" style={{ margin: '0 4px 6px', display: 'flex', gap: 6 }}>
            <span style={{ flex: 1 }}>Đã lưu</span>
            <button className="ghost sm" onClick={reloadDocs} title="Tải lại">↻</button>
          </div>
          {docs.map((d) => (
            <div key={d.id} className={`g-root${openId === d.id ? ' on' : ''}`}>
              <button className="g-root-btn" onClick={() => openDoc(d)} title={`${d.name} · ${fmtRel(d.updatedAt)}`}>
                <span aria-hidden>{d.kind === 'json' ? '🧾' : '📄'}</span>
                <span className="g-root-name">{d.name}</span>
              </button>
              <button className="ghost sm g-root-act" onClick={() => void removeDoc(d)} title="Xóa">✕</button>
            </div>
          ))}
          {docs.length === 0 && <p className="small" style={{ color: 'var(--muted)', margin: '4px 6px' }}>Chưa có tài liệu. Gõ nội dung rồi 💾 Lưu.</p>}
        </aside>

        {/* Editor + (HTML) preview */}
        <div className="tools-main">
          <div className="tools-editor">
            <Editor
              language={monacoLangFor(kind)}
              theme="vs-dark"
              value={text}
              onChange={(v) => { setText(v ?? ''); setDirty(true); }}
              onMount={onMount}
              options={{
                minimap: { enabled: false }, fontSize: 13, wordWrap: 'on',
                scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2,
              }}
            />
          </div>
          {kind === 'html' && preview && (
            <iframe className="tools-preview" sandbox="allow-same-origin" srcDoc={text} title="HTML preview" />
          )}
        </div>
      </div>
      {dirty && openId && <span className="small" style={{ color: 'var(--muted)', padding: '2px 6px' }}>• có thay đổi chưa lưu</span>}

      {/* Modal: đặt tên lưu vào kho */}
      {modal === 'store' && (
        <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && setModal(null)}>
          <div className="mail-compose panel" style={{ width: 'min(440px, 92vw)' }}>
            <div className="mail-compose-head"><b>💾 Lưu vào kho</b><span style={{ flex: 1 }} />
              <button className="ghost sm" onClick={() => setModal(null)}>✕</button></div>
            <input className="input" autoFocus placeholder="Tên tài liệu" value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void saveStore(nameInput)} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => void saveStore(nameInput)}>💾 Lưu</button>
              <button className="ghost" onClick={() => setModal(null)}>Hủy</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: lưu ra file thật — chọn thư mục + tên file */}
      {modal === 'file' && (
        <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && setModal(null)}>
          <div className="mail-compose panel" style={{ width: 'min(560px, 92vw)' }}>
            <div className="mail-compose-head"><b>📁 Lưu ra file</b><span style={{ flex: 1 }} />
              <button className="ghost sm" onClick={() => setModal(null)}>✕</button></div>
            <div className="glink-meta-pair">
              <input className="input" placeholder="Thư mục đích" value={pickDir ?? ''}
                onChange={(e) => setPickDir(e.target.value)} />
              <button className="ghost sm" style={{ flex: 'none' }} onClick={() => setPicking(true)}>📂 Chọn…</button>
            </div>
            <input className="input" placeholder="Tên file (kèm đuôi)" value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void saveToFile()} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button disabled={!pickDir || !nameInput.trim()} onClick={() => void saveToFile()}>💾 Lưu ra file</button>
              <button className="ghost" onClick={() => setModal(null)}>Hủy</button>
            </div>
          </div>
        </div>
      )}

      {picking && (
        <FolderPicker
          initial={pickDir ?? undefined}
          title="Chọn thư mục lưu file"
          onPick={(p) => { setPickDir(p); setPicking(false); }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
