'use client';

// Tools workspace — format + xem JSON / XML / HTML / Markdown cho đẹp (Monaco
// highlight, folding), và riêng JSON/text có tạo mới + lưu trữ snippet
// (store .docs.json).
//
// CHIA ĐÔI MÀN HÌNH cho JSON / XML / HTML / Markdown — giống các editor quen
// thuộc: TRÁI là nguồn trong Monaco (sửa trực tiếp), PHẢI là ô xem tương ứng,
// tự cập nhật ngay khi gõ:
//   · JSON / XML → cây thu gọn được (lib/treeView.ts + components/TreeView.tsx)
//   · HTML       → render trong iframe sandbox
//   · Markdown   → render bằng renderMarkdown (lib/md.ts — tự escape nên HTML
//                  thô trong file hiện ra dạng chữ, không chạy được script)
// Nút ◫ tắt/bật ô xem (nhớ qua localStorage); tab Text không có ô xem.
// Giữa hai ô có THANH KÉO: rê để đổi bề rộng (gõ thì nới ô nguồn, đọc thì nới
// ô xem), đúp chuột về 50/50, ←/→ chỉnh từng bước. Tỉ lệ cũng được nhớ lại.
//
// LƯU đi theo thứ đang mở (Ctrl+S luôn làm đúng việc đó):
//   · đang mở FILE thật  → 💾 Lưu ghi đè thẳng vào chính file đó, không hỏi
//   · đang mở SNIPPET kho → 💾 Lưu cập nhật snippet đó
//   · chưa mở gì          → "Lưu vào kho" / "Lưu thành file…" để chọn đích;
//                           lưu xong thì file đó thành file đang mở
// "Lưu thành file…" ghi đè được lên file CÙNG LOẠI có sẵn: hộp chọn thư mục
// liệt kê luôn các file .md/.json/… trong đó, bấm vào là điền sẵn tên; file đã
// tồn tại thì luôn hỏi xác nhận (statFile) trước khi ghi.
// KÉO THẢ file vào vùng editor để mở luôn: chạy trong Electron thì có đường dẫn
// thật → mở như 📂 Mở file… (lưu đè lại được); trên trình duyệt thường chỉ đọc
// được nội dung nên mở ra để xem/sửa, muốn lưu thì phải chọn đích.
// Nút Format/Minify gọi lib/format.ts; store qua lib/docs.ts.
//
// Cuối rail trái còn có bảng CHUYỂN ĐỔI FILE (ConvertPanel): file trên máy →
// định dạng khác, chạy ngầm bằng thư viện sẵn có hoặc AI.
//
// Ngoài các tab format còn hai CÔNG CỤ RIÊNG chiếm trọn thân panel (state
// `tool`): 🕘 Thời gian (EpochPanel) và 🔁 Tìm & thay (ReplacePanel).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '@/lib/monacoSetup'; // Monaco local /monaco/vs — phải config trước lần init đầu
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditorNs } from 'monaco-editor';
import { formatText, minifyJson, monacoLangFor, detectKind, type FormatKind } from '@/lib/format';
import { renderMarkdown } from '@/lib/md';
import { treeFor } from '@/lib/treeView';
import TreeView from './TreeView';
import { dList, dSave, dRemove, dSaveFile, dReadFile, dFileExists, type SavedDoc } from '@/lib/docs';
import { fmtRel } from '@/lib/google';
import FolderPicker from './FolderPicker';
import ConvertPanel from './ConvertPanel';
import EpochPanel from './EpochPanel';
import ReplacePanel from './ReplacePanel';
import { useSplit } from '@/lib/useSplit';
import Splitter from './Splitter';

const KINDS: { key: FormatKind; label: string }[] = [
  { key: 'json', label: 'JSON' },
  { key: 'xml', label: 'XML' },
  { key: 'html', label: 'HTML' },
  { key: 'md', label: 'Markdown' },
  { key: 'text', label: 'Text' },
];

/** Tab chia đôi được: trái = nguồn (sửa được), phải = ô xem tương ứng. */
const SPLITTABLE = new Set<FormatKind>(['json', 'xml', 'html', 'md']);

/** Tên ô xem bên phải theo kind — dùng cho tiêu đề + tooltip. */
const VIEW_LABEL: Record<FormatKind, string> = {
  json: 'cây JSON',
  xml: 'cây XML',
  html: 'render HTML',
  md: 'render Markdown',
  text: '',
};

const SPLIT_KEY = 'tools.split';
/** Tỉ lệ bề rộng ô nguồn (%) — kéo thanh chia giữa hai ô để đổi. */
const RATIO_KEY = 'tools.splitRatio';
/** Không cho kéo tới mức một ô biến mất. */
const MIN_RATIO = 15;
const MAX_RATIO = 85;

/** Đuôi file CÙNG LOẠI theo tab — hộp thoại "Lưu thành file…" liệt kê sẵn các
 *  file này trong thư mục đích để bấm chọn ghi đè. */
const KIND_EXTS: Record<FormatKind, string[]> = {
  json: ['json'],
  xml: ['xml', 'svg'],
  html: ['html', 'htm'],
  md: ['md', 'markdown', 'mdown', 'mkd', 'mdx'],
  text: ['txt', 'log', 'yml', 'yaml', 'csv', 'env', 'conf', 'ini', 'properties'],
};

/** Đuôi file media → phát trong player thay vì mở editor. */
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus']);
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi']);

interface MediaOpen { path: string; name: string; video: boolean; url: string }

/** Kích thước gọn cho hộp thoại xác nhận ghi đè: 731 B · 24 KB · 3.2 MB. */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ToolsApi {
  /** Mở một file trên đĩa vào editor (chuột phải file → "Open with"). */
  openFile: (absPath: string) => void;
}

interface ToolsWorkspaceProps {
  /** Cha giữ ref tới API này để nhờ mở file .md/.json/.xml/.html từ Explorer. */
  onReady?: (api: ToolsApi) => void;
}

export default function ToolsWorkspace({ onReady }: ToolsWorkspaceProps = {}) {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const railSplit = useSplit({ varName: '--tools-rail', min: 150, max: 460, gap: 12 });
  const [kind, setKind] = useState<FormatKind>('json');
  /**
   * Công cụ RIÊNG đang mở, hay '' = đang ở editor.
   *
   * Mỗi công cụ (Thời gian, Tìm & thay) chiếm trọn thân panel và ẩn hết nút
   * liên quan tới file/format. Dùng MỘT giá trị thay vì mỗi công cụ một cờ
   * boolean: hai cờ độc lập thì có trạng thái "cùng bật" vô nghĩa, và mỗi lần
   * thêm công cụ lại phải nhớ tắt tất cả cờ còn lại ở mọi chỗ.
   */
  const [tool, setTool] = useState<'' | 'epoch' | 'replace'>('');
  /** Đang ở một công cụ riêng → giấu toàn bộ toolbar/editor của tab format. */
  const inTool = tool !== '';
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  /** Bật ô xem bên phải (mặc định bật — nhớ lựa chọn qua localStorage). */
  const [split, setSplit] = useState(true);
  const [docs, setDocs] = useState<SavedDoc[]>([]);
  const [openId, setOpenId] = useState<string | null>(null); // snippet đang mở (để Lưu đè)
  const [dirty, setDirty] = useState(false);
  const edRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(null);
  // Modal: 'store' = đặt tên lưu vào kho; 'file' = chọn thư mục + tên ghi file thật.
  const [modal, setModal] = useState<null | 'store' | 'file'>(null);
  const [nameInput, setNameInput] = useState('');
  const [pickDir, setPickDir] = useState<string | null>(null);
  /** 'dir' = chọn thư mục lưu · 'open' = chọn FILE trên máy để mở vào editor. */
  const [picking, setPicking] = useState<null | 'dir' | 'open'>(null);
  /** File local đang mở (hiện tên trên toolbar; Lưu ra file sẽ prefill lại nó). */
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  /** File media đang phát (thay editor bằng player tới khi đóng). */
  const [media, setMedia] = useState<MediaOpen | null>(null);
  /** Đang ghi file (khoá nút Lưu để không bấm hai lần). */
  const [saving, setSaving] = useState(false);
  /** File đích đã tồn tại → hỏi xác nhận trước khi ghi đè. */
  const [confirmOverwrite, setConfirmOverwrite] = useState<
    { dir: string; name: string; size: number } | null
  >(null);

  /** Thông báo ngắn dưới toolbar (đã lưu…) — tự tắt sau 4s. */
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((m: string) => {
    setNotice(m);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  /** Ô xem đang thực sự hiện (tab hỗ trợ + người dùng bật). */
  const showView = split && SPLITTABLE.has(kind) && !media && !inTool;

  /** Bề rộng ô NGUỒN tính theo % — kéo thanh giữa để đổi, nhớ qua localStorage. */
  const [ratio, setRatio] = useState(50);
  const [dragging, setDragging] = useState(false);
  const mainRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const v = Number(window.localStorage.getItem(RATIO_KEY));
    if (Number.isFinite(v) && v >= MIN_RATIO && v <= MAX_RATIO) setRatio(v);
  }, []);

  /** Kéo thanh chia: theo dõi con trỏ trên cả document để rê ra ngoài vẫn ăn. */
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const box = mainRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return;
      const pct = ((e.clientX - box.left) / box.width) * 100;
      setRatio(Math.min(MAX_RATIO, Math.max(MIN_RATIO, pct)));
    };
    const stop = () => setDragging(false);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
    // Khoá chọn chữ + giữ con trỏ dạng kéo trong lúc rê.
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', stop);
      document.removeEventListener('pointercancel', stop);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [dragging]);

  // Ghi nhớ tỉ lệ sau khi thả (không ghi liên tục lúc đang rê).
  useEffect(() => {
    if (dragging) return;
    try { window.localStorage.setItem(RATIO_KEY, String(Math.round(ratio))); } catch { /* nicety */ }
  }, [ratio, dragging]);

  // ── Kéo thả file vào để mở ─────────────────────────────────────────────────
  /** Đang rê file lên vùng editor (để tô viền báo "thả được"). */
  const [dropping, setDropping] = useState(false);
  /** Đếm dragenter/dragleave: rê qua phần tử con cũng bắn dragleave, đếm mới
   *  biết con trỏ đã thật sự rời khỏi vùng thả hay chưa. */
  const dragDepth = useRef(0);

  /** Chỉ nhận khi rê FILE (không phải bôi đen chữ trong editor). */
  const isFileDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files');


  /** Bàn phím: ←/→ dịch 2%, Home/End về biên, Enter/đúp về 50/50. */
  const onSplitterKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setRatio((r) => Math.max(MIN_RATIO, r - step)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setRatio((r) => Math.min(MAX_RATIO, r + step)); }
    else if (e.key === 'Home') { e.preventDefault(); setRatio(MIN_RATIO); }
    else if (e.key === 'End') { e.preventDefault(); setRatio(MAX_RATIO); }
    else if (e.key === 'Enter') { e.preventDefault(); setRatio(50); }
  };

  /** Markdown đã render — chỉ tính khi ô xem đang hiện. */
  const mdHtml = useMemo(
    () => (showView && kind === 'md' ? renderMarkdown(text) : ''),
    [showView, kind, text],
  );

  /** Cây JSON/XML — chỉ dựng khi ô xem đang hiện. Lỗi cú pháp trả về để hiện
   *  ngay trong ô xem (không chặn việc gõ ở bên trái). */
  const tree = useMemo(
    () => (showView && (kind === 'json' || kind === 'xml') ? treeFor(kind, text) : null),
    [showView, kind, text],
  );

  useEffect(() => {
    const v = window.localStorage.getItem(SPLIT_KEY);
    if (v === '0') setSplit(false);
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(SPLIT_KEY, split ? '1' : '0'); } catch { /* nicety */ }
  }, [split]);

  const reloadDocs = useCallback(() => { dList().then(setDocs).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => { reloadDocs(); }, [reloadDocs]);

  /** Ctrl/Cmd+S — lưu về đúng đích đang mở. Giữ trong ref để Monaco (bind một
   *  lần lúc mount) luôn gọi được bản mới nhất, khỏi phải re-bind mỗi lần gõ.
   *  Gán thật ở dưới, sau khi các hàm lưu đã khai báo. */
  const saveShortcut = useRef<() => void>(() => {});

  const onMount: OnMount = (ed, monaco) => {
    edRef.current = ed;
    // Monaco nuốt Ctrl+S của trình duyệt → bind ngay trong editor.
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveShortcut.current());
  };

  // Ctrl+S khi con trỏ Ở NGOÀI editor (ô xem, toolbar…).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveShortcut.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
  const newDoc = () => { setText(''); setErr(null); setOpenId(null); setOpenFilePath(null); setDirty(false); };

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

  /** Ghi thật ra đĩa. Tách riêng khỏi saveToFile để bước xác nhận ghi đè gọi lại. */
  const writeFile = async (dir: string, filename: string) => {
    setSaving(true);
    try {
      const { path } = await dSaveFile(dir, filename, text);
      setErr(null); setModal(null); setConfirmOverwrite(null);
      // Từ giờ file này là "file đang mở" → lần sau 💾 Lưu ghi thẳng vào nó.
      setOpenFilePath(path); setDirty(false);
      flash(`Đã lưu: ${path}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** Bấm "Lưu ra file": file đã tồn tại thì HỎI XÁC NHẬN trước khi ghi đè. */
  const saveToFile = async () => {
    const name = nameInput.trim();
    if (!pickDir || !name) return;
    setSaving(true);
    try {
      const exists = await dFileExists(pickDir, name);
      setSaving(false);
      if (exists) { setConfirmOverwrite({ dir: pickDir, name, size: exists.size }); return; }
    } catch {
      setSaving(false); // không kiểm tra được thì cứ ghi — server vẫn báo lỗi nếu hỏng
    }
    await writeFile(pickDir, name);
  };

  /** 💾 Lưu — ghi thẳng đè lên file đang mở (không hỏi gì). Chỉ hiện khi đã
   *  có file tham chiếu; chưa có thì dùng "Lưu thành file…". */
  const saveOpenFile = async () => {
    if (!openFilePath) return;
    const base = openFilePath.split(/[\\/]/).pop() ?? '';
    const dir = openFilePath.slice(0, openFilePath.length - base.length).replace(/[\\/]$/, '');
    setSaving(true);
    try {
      await dSaveFile(dir, base, text);
      setErr(null); setDirty(false);
      flash(`Đã lưu ${base}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Đích của Ctrl+S: file thật đang mở → ghi đè; snippet đang mở → cập nhật;
  // chưa có gì → mở hộp thoại "Lưu thành file…".
  saveShortcut.current = () => {
    if (!dirty || saving) return;
    if (openFilePath) void saveOpenFile();
    else if (openId) void openStoreModal();
    else { setNameInput(`untitled${defaultExt}`); setPickDir(null); setModal('file'); }
  };

  /** Mở file từ máy: media → phát luôn; json/xml/html (đuôi hoặc nội dung)
   *  → render đúng tab; còn lại → mở full text. */
  const openLocalFile = async (p: string) => {
    setPicking(null);
    const name = p.split(/[\\/]/).pop() ?? p;
    const ext = (name.split('.').pop() ?? '').toLowerCase();
    if (AUDIO_EXTS.has(ext) || VIDEO_EXTS.has(ext)) {
      setMedia({
        path: p,
        name,
        video: VIDEO_EXTS.has(ext),
        url: `/api/docs?media&path=${encodeURIComponent(p)}`,
      });
      setErr(null);
      return;
    }
    try {
      const { path: full, content } = await dReadFile(p);
      setKind(detectKind(full, content));
      setText(content);
      setOpenId(null);
      setOpenFilePath(full);
      setMedia(null);
      setDirty(false); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  };

  // "Open with" từ Explorer đi vào đúng openLocalFile ở trên — cùng đường với
  // 📂 Mở file… nên được cả phần đoán tab theo nội dung lẫn nhớ đường dẫn để
  // 💾 Lưu ghi đè lại chính nó.
  //
  // openLocalFile là closure mới mỗi lần render (nó đọc state), nên đưa thẳng
  // lên cha thì cha ôm một bản cũ. Cất qua ref rồi expose một hàm ổn định.
  const openLocalRef = useRef(openLocalFile);
  openLocalRef.current = openLocalFile;
  useEffect(() => {
    onReady?.({ openFile: (p: string) => void openLocalRef.current(p) });
  }, [onReady]);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDropping(false);
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;

    // Electron/Chromium cho biết đường dẫn thật → mở qua server như 📂 Mở file…
    // (đọc được cả file lớn, biết đường dẫn để 💾 Lưu ghi đè lại chính nó).
    const realPath = (f as File & { path?: string }).path;
    if (realPath) { await openLocalFile(realPath); return; }

    // Trình duyệt thường: không có đường dẫn → đọc thẳng nội dung. Mở được để
    // xem/sửa nhưng KHÔNG có file tham chiếu, nên lưu phải chọn đích.
    const ext = (f.name.split('.').pop() ?? '').toLowerCase();
    if (AUDIO_EXTS.has(ext) || VIDEO_EXTS.has(ext)) {
      setErr(`Kéo thả file media chưa xem được ở đây — dùng 📂 Mở file… cho ${f.name}.`);
      return;
    }
    const MAX = 10 * 1024 * 1024;
    if (f.size > MAX) {
      setErr(`${f.name} nặng ${(f.size / 1048576).toFixed(1)}MB — quá 10MB, editor không mở nổi.`);
      return;
    }
    try {
      const content = await f.text();
      setKind(detectKind(f.name, content));
      setText(content);
      setOpenId(null); setOpenFilePath(null); setMedia(null);
      setDirty(false); setErr(null);
      flash(`Đã mở ${f.name} — bấm “Lưu thành file…” để chọn nơi lưu.`);
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }, [openLocalFile, flash]);

  const openDoc = (d: SavedDoc) => {
    // Snippet JSON mở ở tab JSON (format được); text mở ở tab JSON để xem/sửa
    // nhưng người dùng cứ để nguyên — không bắt buộc format.
    setKind('json');
    setText(d.content); setOpenId(d.id); setOpenFilePath(null); setDirty(false); setErr(null);
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
            <button key={k.key} role="tab" aria-selected={!inTool && kind === k.key}
              className={`office-subnav-btn${!inTool && kind === k.key ? ' on' : ''}`}
              onClick={() => { setKind(k.key); setTool(''); setErr(null); }}>
              <span className="office-subnav-text">{k.label}</span>
            </button>
          ))}
          <button role="tab" aria-selected={tool === 'epoch'}
            className={`office-subnav-btn${tool === 'epoch' ? ' on' : ''}`}
            onClick={() => { setTool('epoch'); setErr(null); }}
            title="Đổi epoch ⇄ ngày giờ, hai chiều, chọn được múi giờ">
            <span className="office-subnav-text">🕘 Thời gian</span>
          </button>
          <button role="tab" aria-selected={tool === 'replace'}
            className={`office-subnav-btn${tool === 'replace' ? ' on' : ''}`}
            onClick={() => { setTool('replace'); setErr(null); }}
            title="Tìm & thay chuỗi hàng loạt — chế độ thường hoặc regex">
            <span className="office-subnav-text">🔁 Tìm &amp; thay</span>
          </button>
        </div>
        <span style={{ flex: 1 }} />
        {!inTool && (
        <>
        {kind !== 'text' && (
          <button className="sm" onClick={format}
            title={kind === 'md' ? 'Chuẩn hoá Markdown (bullet, dòng trống, khoảng trắng thừa)' : 'Định dạng đẹp (Format / Beautify)'}>
            ✨ Format
          </button>
        )}
        {kind === 'json' && <button className="ghost sm" onClick={minify} title="Rút gọn một dòng">Minify</button>}
        {SPLITTABLE.has(kind) && (
          <button className={`chip-btn${split ? ' on' : ''}`} onClick={() => setSplit((v) => !v)}
            title={split ? 'Tắt ô xem — chỉ hiện editor' : `Chia đôi: bên trái sửa, bên phải ${VIEW_LABEL[kind]}`}>
            ◫ {split ? 'Đang chia đôi' : 'Chia đôi'}
          </button>
        )}
        <button className="ghost sm" onClick={copy} title="Copy toàn bộ">⧉ Copy</button>
        <span className="glink-filter-sep" aria-hidden />
        <button className="ghost sm" onClick={newDoc} title="Tạo tài liệu mới (trống)">＋ Mới</button>
        <button className="ghost sm" onClick={() => setPicking('open')}
          title="Mở file trên máy (json/xml/html/txt/log/yaml…) vào editor">
          📂 Mở file…
        </button>
        {/* ĐANG MỞ FILE THẬT → 💾 Lưu ghi đè thẳng vào chính file đó (Ctrl+S).
            ĐANG MỞ SNIPPET trong kho → 💾 Lưu cập nhật snippet đó.
            CHƯA CÓ GÌ → chỉ còn "Lưu thành file…" / "Lưu vào kho" để chọn đích. */}
        {openFilePath ? (
          <button className="sm" onClick={() => void saveOpenFile()} disabled={saving || !dirty}
            title={dirty ? `Ghi đè ${openFilePath} (Ctrl+S)` : 'Chưa có thay đổi nào'}>
            {saving ? <span className="spinner" aria-hidden /> : '💾'} Lưu
          </button>
        ) : openId ? (
          <button className="sm" onClick={() => void openStoreModal()} disabled={!dirty}
            title={dirty ? 'Cập nhật tài liệu trong kho (Ctrl+S)' : 'Chưa có thay đổi nào'}>
            💾 Lưu
          </button>
        ) : (
          <>
            <button className="ghost sm" onClick={() => void openStoreModal()} title="Lưu vào kho trong app (JSON/text)">
              💾 Lưu vào kho
            </button>
            <button
              className="ghost sm"
              onClick={() => { setNameInput(`untitled${defaultExt}`); setPickDir(null); setModal('file'); }}
              title="Lưu thành file thật trên máy — chọn thư mục + tên file"
            >
              📁 Lưu thành file…
            </button>
          </>
        )}
        {openFilePath && (
          <span className="badge" title={openFilePath}>
            📄 {openFilePath.split(/[\\/]/).pop()}{dirty ? ' •' : ''}
          </span>
        )}
        </>
        )}
      </div>
      {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '4px 0' }}>{err}</pre>}
      {notice && <div className="badge" style={{ color: 'var(--ok)', margin: '4px 0' }}>{notice}</div>}

      {tool === 'epoch' ? <EpochPanel /> : tool === 'replace' ? <ReplacePanel /> : (
      <div className="tools-body" ref={railSplit.ref} style={railSplit.style}>
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

          {/* Chuyển đổi file: độc lập với editor (làm việc trên file thật trên
              máy), job chạy ngầm — xem components/ConvertPanel.tsx. */}
          <ConvertPanel />
        </aside>

        {/* Editor + ô xem — hoặc player khi mở file media */}
        <div
          className={`tools-main${dragging ? ' dragging' : ''}${dropping ? ' dropping' : ''}`}
          ref={mainRef}
          onDragEnter={(e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            dragDepth.current += 1;
            setDropping(true);
          }}
          onDragOver={(e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();                       // bắt buộc, nếu không trình duyệt tự mở file
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDragLeave={(e) => {
            if (!isFileDrag(e)) return;
            dragDepth.current -= 1;
            if (dragDepth.current <= 0) { dragDepth.current = 0; setDropping(false); }
          }}
          onDrop={(e) => void onDrop(e)}
        >
          {dropping && (
            <div className="tools-dropzone" aria-hidden>
              <div className="tools-dropzone-box">
                <span className="tools-dropzone-ico">📥</span>
                Thả file vào đây để mở
              </div>
            </div>
          )}
          {media ? (
            <div className="tools-media">
              <div className="tools-media-head">
                <b>{media.video ? '🎬' : '🎵'} {media.name}</b>
                <span className="small" style={{ color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={media.path}>{media.path}</span>
                <button className="ghost sm" onClick={() => setMedia(null)} title="Đóng player, về editor">✕</button>
              </div>
              {media.video ? (
                <video key={media.url} className="tools-media-el" src={media.url} controls autoPlay />
              ) : (
                <div className="tools-media-audio">
                  <span className="tools-media-ico" aria-hidden>🎵</span>
                  <audio key={media.url} src={media.url} controls autoPlay style={{ width: '100%' }} />
                </div>
              )}
            </div>
          ) : (
          <>
            {/* TRÁI — nguồn, luôn sửa được. Bề rộng theo `ratio` khi có ô xem. */}
            <div
              className="tools-pane tools-editor"
              style={showView ? { flex: `0 0 ${ratio}%` } : undefined}
            >
              {showView && <div className="tools-pane-head">📄 Nguồn <span className="tools-pane-hint">sửa trực tiếp</span></div>}
              <div className="tools-editor-box">
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
            </div>

            {/* THANH CHIA — kéo để đổi bề rộng hai ô; đúp về lại 50/50 */}
            {showView && (
              <div
                className={`tools-splitter${dragging ? ' on' : ''}`}
                role="separator"
                aria-orientation="vertical"
                aria-label="Kéo để đổi bề rộng hai ô"
                aria-valuenow={Math.round(ratio)}
                aria-valuemin={MIN_RATIO}
                aria-valuemax={MAX_RATIO}
                tabIndex={0}
                onPointerDown={(e) => { e.preventDefault(); setDragging(true); }}
                onDoubleClick={() => setRatio(50)}
                onKeyDown={onSplitterKey}
                title="Kéo để đổi bề rộng · đúp chuột về 50/50 · ←/→ chỉnh từng bước"
              >
                <span className="tools-splitter-grip" aria-hidden />
              </div>
            )}

            {/* PHẢI — ô xem tương ứng, cập nhật ngay khi gõ */}
            {showView && (
              <div className="tools-pane tools-view">
                <div className="tools-pane-head">
                  👁 {VIEW_LABEL[kind]}
                  <span className="tools-pane-hint">tự cập nhật</span>
                </div>
                {kind === 'html' ? (
                  <iframe className="tools-view-box" sandbox="allow-same-origin" srcDoc={text} title="HTML preview" />
                ) : kind === 'md' ? (
                  // An toàn: renderMarkdown escape toàn bộ nguồn rồi mới sinh thẻ
                  // của chính nó, nên HTML thô trong file hiện ra dạng chữ.
                  <div className="tools-view-box md-preview" dangerouslySetInnerHTML={{ __html: mdHtml }} />
                ) : tree?.ok && tree.root ? (
                  <div className="tools-view-box"><TreeView root={tree.root} /></div>
                ) : (
                  <div className="tools-view-box">
                    <p className="small tools-view-err">⚠ {tree?.error ?? 'Không đọc được nội dung.'}</p>
                  </div>
                )}
              </div>
            )}
          </>
          )}
        </div>
        <Splitter {...railSplit.grip} />
      </div>
      )}
      {!inTool && dirty && openId && <span className="small" style={{ color: 'var(--muted)', padding: '2px 6px' }}>• có thay đổi chưa lưu</span>}

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
              <button className="ghost sm" style={{ flex: 'none' }} onClick={() => setPicking('dir')}>📂 Chọn…</button>
            </div>
            <input className="input" placeholder="Tên file (kèm đuôi)" value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void saveToFile()} />
            <p className="small" style={{ color: 'var(--faint)', margin: '2px 2px 0' }}>
              Gõ tên mới, hoặc bấm 📂 Chọn… rồi bấm vào một file {KIND_EXTS[kind].map((e) => `.${e}`).join(' / ')} có sẵn để ghi đè lên nó.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button disabled={!pickDir || !nameInput.trim() || saving} onClick={() => void saveToFile()}>
                {saving ? <span className="spinner" aria-hidden /> : '💾'} Lưu ra file
              </button>
              <button className="ghost" onClick={() => setModal(null)}>Hủy</button>
            </div>
          </div>
        </div>
      )}

      {/* Xác nhận ghi đè — file đích đã tồn tại */}
      {confirmOverwrite && (
        <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && setConfirmOverwrite(null)}>
          <div className="mail-compose panel" style={{ width: 'min(520px, 92vw)' }}>
            <div className="mail-compose-head"><b>⚠ File đã tồn tại</b><span style={{ flex: 1 }} />
              <button className="ghost sm" onClick={() => setConfirmOverwrite(null)} disabled={saving}>✕</button></div>
            <p className="small" style={{ margin: '2px 2px 0', lineHeight: 1.6 }}>
              <code>{confirmOverwrite.name}</code> đã có sẵn trong thư mục này
              ({fmtSize(confirmOverwrite.size)}). Ghi đè sẽ thay toàn bộ nội dung cũ
              bằng nội dung đang mở và <b>không khôi phục lại được</b>.
            </p>
            <code className="small picker-cwd" style={{ display: 'block' }} title={`${confirmOverwrite.dir}`}>
              {confirmOverwrite.dir}
            </code>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => void writeFile(confirmOverwrite.dir, confirmOverwrite.name)} disabled={saving}>
                {saving ? <span className="spinner" aria-hidden /> : '💾'} Ghi đè
              </button>
              <button className="ghost" onClick={() => setConfirmOverwrite(null)} disabled={saving}>Hủy</button>
            </div>
          </div>
        </div>
      )}

      {picking === 'dir' && (
        // Vừa chọn được THƯ MỤC (lưu tên mới), vừa liệt kê file CÙNG LOẠI để
        // bấm chọn ghi đè — bấm file thì điền sẵn tên, xác nhận ở bước sau.
        <FolderPicker
          initial={pickDir ?? undefined}
          title="Chọn thư mục lưu file (hoặc bấm file có sẵn để ghi đè)"
          hint={`Bấm thư mục để đi vào · “Chọn thư mục này” để lưu tên mới · bấm file ${KIND_EXTS[kind].map((e) => `.${e}`).join(' / ')} để ghi đè lên nó.`}
          fileExts={KIND_EXTS[kind]}
          allowPickFolder
          onPickFile={(p) => {
            const base = p.split(/[\\/]/).pop() ?? '';
            setPickDir(p.slice(0, p.length - base.length).replace(/[\\/]$/, ''));
            setNameInput(base);
            setPicking(null);
          }}
          onPick={(p) => { setPickDir(p); setPicking(null); }}
          onClose={() => setPicking(null)}
        />
      )}

      {picking === 'open' && (
        <FolderPicker
          title="Mở file từ máy (text mở editor, media phát luôn)"
          fileExts={[
            'json', 'xml', 'svg', 'html', 'htm', 'txt', 'log', 'md', 'yml', 'yaml', 'csv',
            'env', 'conf', 'ini', 'properties', 'sql', 'js', 'ts', 'sh', 'ps1', 'bat',
            'mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus',
            'mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi',
          ]}
          onPickFile={(p) => void openLocalFile(p)}
          onPick={() => {}}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
