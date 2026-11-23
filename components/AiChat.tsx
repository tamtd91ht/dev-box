'use client';

// Trợ lý AI — bảng chat NEO bên phải cửa sổ, mở từ nút ✨ trên thanh menu.
//
// Làm theo Radar của vhs-infrastructure-monitor: mỗi câu hỏi gửi kèm màn hình
// đang mở, trả lời hiện dần, Dừng = huỷ phía server, đính kèm ảnh/file bằng
// dán / kéo thả / nút 📎. Khác Radar ở hai chỗ, đều do đặc thù app này:
//   · NEO chứ không phủ: khung app co lại nhường chỗ (xem lib/aiChat.ts) vì
//     <webview> Zalo/Browser vẽ ở tầng native, HTML không đè lên được.
//   · POLL chứ không SSE: đi qua lib/apiFetch để khỏi dính giới hạn 6 socket.
//
// Hai màn trong bảng: "Trò chuyện" và "Kho tri thức" — tri thức riêng người
// dùng đưa vào (gõ tay, nhập file, hoặc lưu lại một câu trả lời); tài liệu đang
// bật được gửi kèm mỗi câu hỏi (lib/aiKnowledge.ts).
//
// Trợ lý không có công cụ: nó chỉ gợi ý bằng chữ, không chạy được gì trên máy.
//
// UI theo cấu trúc của skill omicx-ui, dùng token màu sẵn có của Dev Box: mỗi
// màn một nút đặc (xanh lá = tạo/lưu), còn lại là nút viền; mọi khối dữ liệu
// có trạng thái đang tải / trống / lỗi kèm "Thử lại"; viền focus luôn thấy.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { renderMarkdown } from '@/lib/md';
import { fmtRel } from '@/lib/google';
import {
  AI_DEFAULT_MODEL, AI_LIMITS, AI_MAX_W, AI_MIN_W, AI_MODELS, KB_BUDGET, KB_LIMITS, aiDock,
  type AiAttachment, type AiPoll, type AiTurn, type KbDoc, type KbMeta,
} from '@/lib/aiChat';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  error?: string;
  stopped?: boolean;
  meta?: { model: string | null; durationMs: number; sources: string[] };
  /** Tên file gửi kèm câu hỏi (không giữ nội dung). */
  files?: string[];
}

type Pending = AiAttachment & { id: string; bytes: number; preview?: string };

const MSGS_KEY = 'ai.msgs';
const MODEL_KEY = 'ai.model';
const POLL_MS = 300;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const num = (n: number) => n.toLocaleString('vi-VN');
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(action: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
  const r = await apiFetch('/api/ai', { method: 'POST', body: JSON.stringify({ action, ...params }), timeoutMs });
  const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: T };
  if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
  return (data.result ?? data) as T;
}

function loadMsgs(): Msg[] {
  try {
    const v = JSON.parse(window.sessionStorage.getItem(MSGS_KEY) ?? '[]') as Msg[];
    // Tải lại trang giữa lúc đang trả lời → câu đó coi như bị dừng.
    return Array.isArray(v) ? v.map((m) => (m.streaming ? { ...m, streaming: false, stopped: true } : m)) : [];
  } catch { return []; }
}

const readAs = (f: File, how: 'dataURL' | 'text') => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result ?? ''));
  r.onerror = () => reject(new Error(`Không đọc được ${f.name}`));
  if (how === 'dataURL') r.readAsDataURL(f); else r.readAsText(f);
});

/** File chữ → nội dung; file nhị phân (có byte NUL) → ném lỗi dễ hiểu. */
async function readTextFile(f: File): Promise<string> {
  const text = await readAs(f, 'text');
  if (text.slice(0, 4000).includes('\u0000')) {
    throw new Error(`${f.name}: không phải file chữ (chỉ nhận văn bản, code, log, JSON, Markdown…)`);
  }
  return text;
}

async function prepare(f: File): Promise<Pending> {
  const name = f.name || 'dán-từ-clipboard.png';
  if (IMAGE_TYPES.has(f.type)) {
    const url = await readAs(f, 'dataURL');
    return { id: uid(), kind: 'image', name, mediaType: f.type, data: url.slice(url.indexOf(',') + 1), bytes: f.size, preview: url };
  }
  if (f.type === 'application/pdf' || /\.pdf$/i.test(name)) {
    const url = await readAs(f, 'dataURL');
    return { id: uid(), kind: 'pdf', name, data: url.slice(url.indexOf(',') + 1), bytes: f.size };
  }
  if (f.type.startsWith('image/')) throw new Error(`${name}: chỉ nhận ảnh PNG / JPEG / GIF / WebP`);
  const text = (await readTextFile(f)).slice(0, AI_LIMITS.maxTextChars);
  return { id: uid(), kind: 'text', name, data: text, bytes: text.length };
}

const SUGGESTIONS = [
  'Giải thích giúp lỗi này (dán log hoặc ảnh chụp vào)',
  'Viết truy vấn cho dữ liệu tôi đang cần',
  'Tóm tắt tài liệu trong kho tri thức',
];

export default function AiChat({ screen }: { screen: string }) {
  const dock = useSyncExternalStore(aiDock.subscribe, aiDock.getSnapshot, aiDock.getServerSnapshot);
  const [view, setView] = useState<'chat' | 'kb'>('chat');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [model, setModel] = useState(AI_DEFAULT_MODEL);
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  /** Kho tri thức — nạp một lần khi mở bảng, cập nhật sau mỗi thao tác. */
  const [kb, setKb] = useState<KbMeta[] | null>(null);
  const [kbErr, setKbErr] = useState<string | null>(null);
  /** Mở sẵn trình soạn tài liệu (vd "Lưu vào kho" từ một câu trả lời). */
  const [kbDraft, setKbDraft] = useState<{ id?: string; title: string; content: string } | null>(null);

  const jobRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);
  /** Người dùng đang đứng ở cuối danh sách → chữ mới về thì cuộn theo. */
  const stick = useRef(true);

  // sessionStorage chỉ có ở trình duyệt → nạp sau khi mount (tránh lệch SSR).
  useEffect(() => {
    setMsgs(loadMsgs());
    try {
      const m = window.localStorage.getItem(MODEL_KEY);
      if (m && AI_MODELS.some((x) => x.id === m)) setModel(m);
    } catch { /* nicety */ }
  }, []);
  useEffect(() => {
    try { window.sessionStorage.setItem(MSGS_KEY, JSON.stringify(msgs.slice(-60))); } catch { /* đầy → bỏ qua */ }
  }, [msgs]);

  const loadKb = useCallback(() => {
    setKbErr(null);
    call<KbMeta[]>('kb.list').then(setKb).catch((e) => setKbErr((e as Error).message));
  }, []);
  useEffect(() => { if (dock.open && kb === null) loadKb(); }, [dock.open, kb, loadKb]);

  useEffect(() => {
    if (dock.open && view === 'chat') inputRef.current?.focus();
  }, [dock.open, view]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs, view]);

  // ── Đổi bề rộng: kéo mép trái ─────────────────────────────────────────────
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: PointerEvent) => aiDock.setWidth(window.innerWidth - e.clientX);
    const stop = () => setResizing(false);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
    const prevSel = document.body.style.userSelect;
    const prevCur = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', stop);
      document.removeEventListener('pointercancel', stop);
      document.body.style.userSelect = prevSel;
      document.body.style.cursor = prevCur;
    };
  }, [resizing]);

  // ── Đính kèm ──────────────────────────────────────────────────────────────
  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setNote(null);
    const errors: string[] = [];
    const ready: Pending[] = [];
    for (const f of files) {
      try { ready.push(await prepare(f)); } catch (e) { errors.push((e as Error).message); }
    }
    setPending((cur) => {
      const next = [...cur];
      for (const p of ready) {
        const total = next.reduce((n, x) => n + x.bytes, 0);
        if (next.length >= AI_LIMITS.maxFiles) { errors.push(`Tối đa ${AI_LIMITS.maxFiles} file mỗi câu hỏi — bỏ ${p.name}`); continue; }
        if (total + p.bytes > AI_LIMITS.maxTotalBytes) {
          errors.push(`${p.name}: vượt ${Math.round(AI_LIMITS.maxTotalBytes / 1048576)} MB đính kèm`);
          continue;
        }
        next.push(p);
      }
      return next;
    });
    if (errors.length) setNote(errors.join(' · '));
  }, []);

  // ── Hỏi ───────────────────────────────────────────────────────────────────
  const send = useCallback(async (text?: string) => {
    const question = (text ?? draft).trim();
    if (!question || busy) return;
    if (question.length > AI_LIMITS.maxQuestion) {
      setNote(`Câu hỏi dài quá ${num(AI_LIMITS.maxQuestion)} ký tự — rút gọn hoặc đính kèm thành file.`);
      return;
    }
    const atts = pending;
    const history: AiTurn[] = msgs
      .filter((m) => m.content && !m.error)
      .map((m) => ({ role: m.role, content: m.content }));
    const aId = uid();
    stick.current = true;
    setMsgs((cur) => [
      ...cur,
      { id: uid(), role: 'user', content: question, files: atts.length ? atts.map((a) => a.name) : undefined },
      { id: aId, role: 'assistant', content: '', streaming: true },
    ]);
    setDraft(''); setPending([]); setNote(null); setBusy(true);
    const patch = (p: Partial<Msg> | ((m: Msg) => Partial<Msg>)) => setMsgs((cur) => cur.map((m) => (
      m.id === aId ? { ...m, ...(typeof p === 'function' ? p(m) : p) } : m
    )));

    try {
      const { id } = await call<{ id: string }>('ask', {
        question, history, screen, model,
        attachments: atts.map(({ id: _i, bytes: _b, preview: _p, ...a }) => a),
      }, 60000);
      jobRef.current = id;
      let from = 0;
      for (;;) {
        const r = await call<AiPoll>('poll', { id, from });
        from = r.next;
        if (r.text) patch((m) => ({ content: m.content + r.text }));
        if (r.done) {
          const stopped = r.error === 'Đã dừng.';
          patch({
            streaming: false,
            stopped,
            error: r.error && !stopped ? r.error : undefined,
            meta: r.error ? undefined : { model: r.model, durationMs: r.durationMs, sources: r.sources },
          });
          break;
        }
        await sleep(POLL_MS);
      }
    } catch (e) {
      patch({ streaming: false, error: (e as Error).message });
    } finally {
      jobRef.current = null;
      setBusy(false);
    }
  }, [draft, busy, pending, msgs, screen, model]);

  const stopAsk = () => { if (jobRef.current) void call('stop', { id: jobRef.current }).catch(() => {}); };

  const newChat = () => { stopAsk(); setMsgs([]); setNote(null); setPending([]); inputRef.current?.focus(); };

  const copyMsg = async (m: Msg) => {
    try { await navigator.clipboard.writeText(m.content); setCopied(m.id); setTimeout(() => setCopied(null), 1500); } catch { /* ignore */ }
  };

  /** Câu hỏi ngay trước một câu trả lời — làm tiêu đề gợi ý khi lưu vào kho. */
  const questionBefore = (id: string) => {
    const i = msgs.findIndex((m) => m.id === id);
    return i > 0 ? msgs[i - 1].content : '';
  };

  const kbOn = useMemo(() => (kb ?? []).filter((d) => d.enabled), [kb]);

  if (!dock.open) return null;

  const dropProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault(); dragDepth.current += 1; setDropping(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) { dragDepth.current = 0; setDropping(false); }
    },
  };

  return (
    <aside className={`aic${resizing ? ' resizing' : ''}`} style={{ width: dock.width }} aria-label="Trợ lý AI">
      <div
        className="aic-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Kéo để đổi bề rộng bảng trợ lý"
        aria-valuenow={dock.width}
        aria-valuemin={AI_MIN_W}
        aria-valuemax={AI_MAX_W}
        tabIndex={0}
        title="Kéo để đổi bề rộng · ←/→ chỉnh từng bước"
        onPointerDown={(e) => { e.preventDefault(); setResizing(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { e.preventDefault(); aiDock.setWidth(dock.width + 24); }
          else if (e.key === 'ArrowRight') { e.preventDefault(); aiDock.setWidth(dock.width - 24); }
        }}
      />

      <header className="aic-head">
        <span className="aic-title"><span aria-hidden>✨</span> Trợ lý AI</span>
        <div className="aic-tabs" role="tablist" aria-label="Màn của trợ lý">
          <button role="tab" aria-selected={view === 'chat'} className={`aic-tab${view === 'chat' ? ' on' : ''}`}
            onClick={() => setView('chat')}>
            Trò chuyện
          </button>
          <button role="tab" aria-selected={view === 'kb'} className={`aic-tab${view === 'kb' ? ' on' : ''}`}
            onClick={() => setView('kb')}>
            Kho tri thức{kb ? <span className="aic-count">{kb.length}</span> : null}
          </button>
        </div>
        <span className="aic-spacer" />
        {view === 'chat' && msgs.length > 0 && (
          <button className="aic-icon" onClick={newChat} title="Cuộc trò chuyện mới (xoá hội thoại đang có)" aria-label="Cuộc trò chuyện mới">
            ＋
          </button>
        )}
        <button className="aic-icon" onClick={() => aiDock.setOpen(false)} title="Đóng bảng trợ lý" aria-label="Đóng bảng trợ lý">
          ✕
        </button>
      </header>

      {view === 'kb' ? (
        <KnowledgeView
          docs={kb}
          error={kbErr}
          draft={kbDraft}
          onDraft={setKbDraft}
          onDocs={setKb}
          onReload={loadKb}
        />
      ) : (
        <div className="aic-chat" {...dropProps}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault(); e.stopPropagation();
            dragDepth.current = 0; setDropping(false);
            void addFiles([...e.dataTransfer.files]);
          }}>
          {dropping && <div className="aic-drop" aria-hidden>Thả ảnh / file để đính kèm câu hỏi</div>}

          <div className="aic-ctx">
            <span className="aic-chip" title="Câu hỏi được gắn với màn hình này">
              <span aria-hidden>🖥</span> {screen || 'Dev Box'}
            </span>
            <button className="aic-chip aic-chip-btn" onClick={() => setView('kb')}
              title={kbOn.length ? `Gửi kèm mỗi câu hỏi: ${kbOn.map((d) => d.title).join(', ')}` : 'Chưa có tài liệu nào đang bật — bấm để thêm'}>
              <span aria-hidden>📚</span> {kb === null ? 'Kho tri thức' : kbOn.length ? `${kbOn.length} tài liệu đang dùng` : 'Kho tri thức trống'}
            </button>
          </div>

          <div className="aic-list" ref={listRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            }}>
            {msgs.length === 0 ? (
              <div className="aic-empty">
                <div className="aic-empty-ico" aria-hidden>✨</div>
                <p className="aic-empty-title">Hỏi gì cũng được</p>
                <p className="aic-empty-sub">
                  Trợ lý biết bạn đang ở màn hình nào và dùng tài liệu trong kho tri thức của bạn.
                  Nó chỉ gợi ý — không tự chạy lệnh hay sửa gì trên máy.
                </p>
                <div className="aic-suggest">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="aic-suggest-btn" onClick={() => { setDraft(s); inputRef.current?.focus(); }}>{s}</button>
                  ))}
                </div>
              </div>
            ) : msgs.map((m) => (m.role === 'user' ? (
              <div key={m.id} className="aic-msg user">
                {m.files && (
                  <div className="aic-files">{m.files.map((f, i) => <span key={i} className="aic-file">📎 {f}</span>)}</div>
                )}
                <div className="aic-bubble">{m.content}</div>
              </div>
            ) : (
              <div key={m.id} className="aic-msg assistant" aria-busy={m.streaming}>
                {m.content
                  ? <div className="md-preview aic-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                  : m.streaming ? <span className="aic-typing" aria-label="Đang trả lời"><i /><i /><i /></span> : null}
                {m.stopped && <div className="aic-stopped">Đã dừng.</div>}
                {m.error && (
                  <div className="aic-error" role="alert">
                    <span>{m.error}</span>
                    <button className="ghost sm" onClick={() => void send(questionBefore(m.id))} disabled={busy}>Thử lại</button>
                  </div>
                )}
                {!m.streaming && m.content && (
                  <div className="aic-meta">
                    {m.meta && (
                      <span title={m.meta.sources.length ? `Tài liệu đã gửi kèm: ${m.meta.sources.join(', ')}` : 'Không gửi kèm tài liệu nào từ kho tri thức'}>
                        {m.meta.model ?? 'Claude'} · {(m.meta.durationMs / 1000).toFixed(1)} giây
                        {m.meta.sources.length ? ` · 📚 ${m.meta.sources.length} tài liệu` : ''}
                      </span>
                    )}
                    <span className="aic-spacer" />
                    <button className="aic-link" onClick={() => void copyMsg(m)}>{copied === m.id ? 'Đã sao chép' : 'Sao chép'}</button>
                    <button className="aic-link"
                      onClick={() => { setKbDraft({ title: questionBefore(m.id).replace(/\s+/g, ' ').slice(0, 80), content: m.content }); setView('kb'); }}
                      title="Lưu câu trả lời này thành tài liệu trong kho tri thức">
                      Lưu vào kho
                    </button>
                  </div>
                )}
              </div>
            )))}
          </div>

          <footer className="aic-compose">
            {note && <div className="aic-note" role="status">{note}</div>}
            {pending.length > 0 && (
              <ul className="aic-atts">
                {pending.map((p) => (
                  <li key={p.id} className="aic-att" title={p.name}>
                    {p.preview ? <img src={p.preview} alt="" /> : <span aria-hidden>📄</span>}
                    <span className="aic-att-name">{p.name}</span>
                    <button className="aic-att-x" onClick={() => setPending((cur) => cur.filter((x) => x.id !== p.id))}
                      aria-label={`Bỏ ${p.name}`}>✕</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="aic-box">
              <textarea
                ref={inputRef}
                className="aic-input"
                rows={2}
                value={draft}
                placeholder="Hỏi trợ lý… (Enter gửi · Shift+Enter xuống dòng · dán ảnh được)"
                aria-label="Câu hỏi cho trợ lý"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
                }}
                onPaste={(e) => {
                  const files = [...e.clipboardData.files];
                  if (files.length) { e.preventDefault(); void addFiles(files); }
                }}
              />
              <div className="aic-bar">
                <button className="aic-icon" onClick={() => fileRef.current?.click()} title="Đính kèm ảnh / file (hoặc dán, kéo thả)" aria-label="Đính kèm ảnh hoặc file">
                  📎
                </button>
                <input ref={fileRef} type="file" multiple hidden
                  onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
                <select className="aic-model" value={model} aria-label="Model trả lời"
                  title={AI_MODELS.find((m) => m.id === model)?.hint}
                  onChange={(e) => {
                    setModel(e.target.value);
                    try { window.localStorage.setItem(MODEL_KEY, e.target.value); } catch { /* nicety */ }
                  }}>
                  {AI_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                <span className="aic-spacer" />
                {busy ? (
                  <button className="aic-send stop" onClick={stopAsk} title="Dừng câu trả lời">■ Dừng</button>
                ) : (
                  <button className="aic-send" onClick={() => void send()} disabled={!draft.trim()} title="Gửi (Enter)">Gửi ↑</button>
                )}
              </div>
            </div>
          </footer>
        </div>
      )}
    </aside>
  );
}

// ── Kho tri thức ─────────────────────────────────────────────────────────────

function KnowledgeView(props: {
  docs: KbMeta[] | null;
  error: string | null;
  draft: { id?: string; title: string; content: string } | null;
  onDraft: (d: { id?: string; title: string; content: string } | null) => void;
  onDocs: (d: KbMeta[]) => void;
  onReload: () => void;
}) {
  const { docs, error, draft, onDraft, onDocs, onReload } = props;
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [askDel, setAskDel] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);

  const editing = draft !== null;
  useEffect(() => { if (editing) titleRef.current?.focus(); }, [editing]);

  const run = async (fn: () => Promise<KbMeta[]>, okText?: string) => {
    setMsg(null);
    try { onDocs(await fn()); if (okText) setMsg({ kind: 'ok', text: okText }); return true; }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); return false; }
  };

  const importFiles = async (files: File[]) => {
    if (!files.length) return;
    setMsg(null);
    let done = 0;
    const errors: string[] = [];
    let last: KbMeta[] | null = null;
    for (const f of files) {
      try {
        const content = await readTextFile(f);
        last = await call<KbMeta[]>('kb.save', { title: f.name.replace(/\.[^.]+$/, '') || f.name, content });
        done += 1;
      } catch (e) { errors.push((e as Error).message); }
    }
    if (last) onDocs(last);
    setMsg(errors.length
      ? { kind: 'err', text: `${done ? `Đã nhập ${done} file. ` : ''}Lỗi: ${errors.join(' · ')}` }
      : { kind: 'ok', text: `Đã nhập ${done} file vào kho.` });
  };

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    const ok = await run(() => call<KbMeta[]>('kb.save', { ...draft }), draft.id ? 'Đã lưu thay đổi.' : 'Đã thêm tài liệu vào kho.');
    setSaving(false);
    if (ok) onDraft(null);
  };

  const edit = async (id: string) => {
    setMsg(null);
    try {
      const d = await call<KbDoc>('kb.get', { id });
      onDraft({ id: d.id, title: d.title, content: d.content });
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  };

  // ── Soạn / sửa một tài liệu ────────────────────────────────────────────────
  if (draft) {
    const tooLong = draft.content.length > KB_LIMITS.maxDocChars;
    const valid = draft.title.trim() !== '' && draft.content.trim() !== '' && !tooLong;
    return (
      <div className="aic-kb">
        <div className="aic-kb-bar">
          <button className="aic-link" onClick={() => { onDraft(null); setMsg(null); }}>← Kho tri thức</button>
          <span className="aic-kb-h">{draft.id ? 'Chỉnh sửa tài liệu' : 'Thêm tài liệu'}</span>
        </div>
        <div className="aic-form">
          <label className="aic-label" htmlFor="aic-kb-title">Tiêu đề <span className="aic-req" aria-hidden>*</span></label>
          <input id="aic-kb-title" ref={titleRef} className="input" value={draft.title} maxLength={KB_LIMITS.maxTitle}
            placeholder="Vd: Quy ước đặt tên topic Kafka"
            onChange={(e) => onDraft({ ...draft, title: e.target.value })} />
          <label className="aic-label" htmlFor="aic-kb-content">
            Nội dung <span className="aic-req" aria-hidden>*</span>
            <span className="aic-hint">{num(draft.content.length)} ký tự</span>
          </label>
          <textarea id="aic-kb-content" className="aic-kb-text" value={draft.content}
            placeholder={'Dán tài liệu, quy trình, cấu hình, ghi chú… (Markdown hoặc văn bản thường).\nTrợ lý sẽ dựa vào đây khi trả lời.'}
            onChange={(e) => onDraft({ ...draft, content: e.target.value })}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void save(); } }} />
          {tooLong && (
            <div className="aic-note err" role="alert">
              Dài quá {num(KB_LIMITS.maxDocChars)} ký tự — tách thành nhiều tài liệu nhỏ hơn.
            </div>
          )}
          {msg?.kind === 'err' && <div className="aic-note err" role="alert">{msg.text}</div>}
        </div>
        <div className="aic-kb-foot">
          <button className="ghost sm" onClick={() => { onDraft(null); setMsg(null); }} disabled={saving}>Đóng</button>
          <button className="aic-cta" onClick={() => void save()} disabled={!valid || saving} title="Lưu (Ctrl+Enter)">
            {saving ? <span className="spinner" aria-hidden /> : null} {draft.id ? 'Lưu thay đổi' : 'Thêm vào kho'}
          </button>
        </div>
      </div>
    );
  }

  // ── Danh sách ──────────────────────────────────────────────────────────────
  const list = docs ?? [];
  const needle = q.trim().toLowerCase();
  const shown = needle ? list.filter((d) => d.title.toLowerCase().includes(needle)) : list;
  const onChars = list.filter((d) => d.enabled).reduce((n, d) => n + d.chars, 0);
  const over = onChars > KB_BUDGET;

  return (
    <div className="aic-kb"
      onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dragDepth.current += 1; setDropping(true); } }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; } }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) { dragDepth.current = 0; setDropping(false); }
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault(); e.stopPropagation();
        dragDepth.current = 0; setDropping(false);
        void importFiles([...e.dataTransfer.files]);
      }}>
      {dropping && <div className="aic-drop" aria-hidden>Thả file chữ để nhập vào kho tri thức</div>}

      <p className="aic-kb-intro">
        Tri thức riêng của bạn: tài liệu nội bộ, quy trình, quy ước… Tài liệu đang <b>bật</b> được gửi kèm mỗi câu hỏi để trợ lý trả lời dựa trên đó.
      </p>

      <div className="aic-kb-bar">
        <input className="input aic-search" type="search" value={q} placeholder="Tìm theo tiêu đề" aria-label="Tìm tài liệu theo tiêu đề"
          onChange={(e) => setQ(e.target.value)} />
        <button className="ghost sm" onClick={() => fileRef.current?.click()} title="Nhập file chữ (.md, .txt, .json, code, log…) — mỗi file thành một tài liệu">
          Nhập file
        </button>
        <input ref={fileRef} type="file" multiple hidden
          onChange={(e) => { void importFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
        <button className="aic-cta" onClick={() => { setMsg(null); onDraft({ title: '', content: '' }); }}>＋ Thêm mới</button>
      </div>

      {list.length > 0 && (
        <div className={`aic-meter${over ? ' over' : ''}`}>
          <div className="aic-meter-row">
            <span>Đang bật: {num(onChars)} / {num(KB_BUDGET)} ký tự mỗi câu hỏi</span>
            <span>{list.filter((d) => d.enabled).length} / {list.length} tài liệu</span>
          </div>
          <div className="aic-meter-bar" aria-hidden><i style={{ width: `${Math.min(100, (onChars / KB_BUDGET) * 100)}%` }} /></div>
          <div className="aic-meter-hint">
            {over
              ? 'Vượt hạn mức: mỗi câu hỏi chỉ gửi các đoạn liên quan nhất tới câu hỏi đó. Tắt bớt tài liệu ít dùng nếu muốn gửi nguyên văn.'
              : 'Trong hạn mức: toàn bộ tài liệu đang bật được gửi nguyên văn.'}
          </div>
        </div>
      )}

      {msg && <div className={`aic-note ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'}>{msg.text}</div>}

      <div className="aic-kb-list">
        {error ? (
          <div className="aic-error" role="alert">
            <span>Không tải được kho tri thức: {error}</span>
            <button className="ghost sm" onClick={onReload}>Thử lại</button>
          </div>
        ) : docs === null ? (
          <div className="aic-skel" aria-label="Đang tải kho tri thức"><i /><i /><i /></div>
        ) : list.length === 0 ? (
          <div className="aic-empty">
            <div className="aic-empty-ico" aria-hidden>📚</div>
            <p className="aic-empty-title">Chưa có tài liệu</p>
            <p className="aic-empty-sub">Bấm “Thêm mới” để gõ hoặc dán nội dung, “Nhập file” hoặc kéo thả file chữ vào đây.</p>
          </div>
        ) : shown.length === 0 ? (
          <p className="aic-empty-sub" style={{ padding: 16 }}>Không có tài liệu nào khớp “{q}”.</p>
        ) : shown.map((d) => (
          <div key={d.id} className={`aic-doc${d.enabled ? '' : ' off'}`}>
            <button
              className={`aic-switch${d.enabled ? ' on' : ''}`}
              role="switch"
              aria-checked={d.enabled}
              aria-label={`${d.enabled ? 'Tắt' : 'Bật'} tài liệu ${d.title}`}
              title={d.enabled ? 'Đang gửi kèm câu hỏi — bấm để tắt' : 'Đang tắt — bấm để bật'}
              onClick={() => void run(() => call<KbMeta[]>('kb.toggle', { id: d.id, enabled: !d.enabled }))}
            ><i /></button>
            <button className="aic-doc-main" onClick={() => void edit(d.id)} title="Mở để xem / chỉnh sửa">
              <span className="aic-doc-title">{d.title}</span>
              <span className="aic-doc-sub">{num(d.chars)} ký tự · {fmtRel(d.updatedAt)}</span>
            </button>
            {askDel === d.id ? (
              <button className="aic-del ask" autoFocus onBlur={() => setAskDel(null)}
                onClick={() => { setAskDel(null); void run(() => call<KbMeta[]>('kb.remove', { id: d.id }), 'Đã xoá tài liệu.'); }}>
                Xoá hẳn?
              </button>
            ) : (
              <button className="aic-del" onClick={() => setAskDel(d.id)} aria-label={`Xoá tài liệu ${d.title}`} title="Xoá">✕</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
