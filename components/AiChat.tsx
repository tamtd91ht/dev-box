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
// Bật "Thao tác màn hình" thì nó được làm thêm ĐÚNG ba việc trong lib/aiScreen.ts
// (mở tab, đọc chữ trên màn hình, bấm phần tử — nút không phải tab phải được
// người dùng bấm Cho phép): mỗi câu trả lời có khối <hanh_dong> là một bước,
// thực hiện xong thì hỏi tiếp kèm nhật ký, tối đa MAX_STEPS bước.
//
// GIỌNG NÓI (lib/speech.ts): nút micro cạnh ô nhập ghi âm rồi chuyển thành chữ
// bằng Whisper chạy trên máy (STT); nút "Đọc" dưới mỗi câu trả lời đọc to bằng
// giọng Google (TTS — chữ của câu trả lời được gửi tới Google).
//
// UI theo cấu trúc của skill omicx-ui, dùng token màu sẵn có của Dev Box: mỗi
// màn một nút đặc (xanh lá = tạo/lưu), còn lại là nút viền; mọi khối dữ liệu
// có trạng thái đang tải / trống / lỗi kèm "Thử lại"; viền focus luôn thấy.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { renderMarkdown } from '@/lib/md';
import { fmtRel } from '@/lib/google';
import { fmtDuration, mdToSpeech, speaker } from '@/lib/speech';
import { useStt, useSttPrefs } from '@/lib/useStt';
import { useSpeechProviders } from '@/lib/useSpeechProviders';
import {
  DENIED, captureScreen, closeViews, describeAction, openedViewsToClose, parseAction, pinTarget, releaseTarget,
  runAction, stripAction, targetName, type AiTab, type ScreenShot,
} from '@/lib/aiScreen';
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
  /** Các bước trợ lý đã thao tác trên màn hình để trả lời câu này. */
  steps?: { label: string; note?: string; state: 'doing' | 'done' | 'denied' }[];
  /** File gửi kèm câu hỏi: tên + loại (+ ảnh thu nhỏ, chỉ giữ trong phiên đang mở). */
  files?: { name: string; kind: AiAttachment['kind']; preview?: string }[];
  /** View trợ lý đã tự mở ở nền cho câu này — đề nghị tắt cho nhẹ máy (lib/aiScreen.ts). */
  cleanup?: { views: { key: string; label: string }[]; state: 'ask' | 'closed' | 'kept' };
}

type Pending = AiAttachment & { id: string; bytes: number; preview?: string };

const MSGS_KEY = 'ai.msgs';
const MODEL_KEY = 'ai.model';
const AGENT_KEY = 'ai.agent';
/** Số hành động tối đa cho một câu hỏi — chặn vòng lặp vô tận. */
/** Đọc hết một bảng dài cần cuộn nhiều lần — 8 bước cũ không đủ. */
const MAX_STEPS = 20;
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
    if (!Array.isArray(v)) return [];
    return v.map((m) => ({
      ...m,
      ...(m.streaming ? { streaming: false, stopped: true } : {}),
      // Bước đang làm dở lúc tải lại trang → coi như đã xong để khỏi quay mãi.
      steps: m.steps?.map((s) => (s.state === 'doing' ? { ...s, state: 'done' as const } : s)),
      // Bản đầu lưu `files` là mảng tên.
      files: m.files?.map((f) => (typeof f === 'string' ? { name: f as string, kind: 'text' as const } : f)),
    }));
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

/** Nhãn loại file trên thẻ đính kèm: PDF, MD, JSON, LOG… */
function typeLabel(a: { kind: AiAttachment['kind']; name: string }): string {
  if (a.kind === 'pdf') return 'PDF';
  if (a.kind === 'image') return 'ẢNH';
  const ext = /\.([A-Za-z0-9]{1,6})$/.exec(a.name)?.[1];
  return (ext ?? 'txt').toUpperCase();
}

const SUGGESTIONS = [
  'Giải thích giúp lỗi này (dán log hoặc ảnh chụp vào)',
  'Vào Công việc xem hôm nay tôi có deadline nào không',
  'Tóm tắt tài liệu trong kho tri thức',
];

export default function AiChat({ screen, tabs }: { screen: string; tabs: AiTab[] }) {
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
  /** "Thao tác màn hình": cho trợ lý mở tab / đọc / bấm trên giao diện app. */
  const [agent, setAgent] = useState(true);
  /** Đang chờ người dùng cho phép một cú bấm. */
  const [confirm, setConfirm] = useState<{ label: string; resolve: (ok: boolean) => void } | null>(null);
  const stopRef = useRef(false);
  /** Tên màn hình mới nhất — vòng lặp thao tác đọc lại sau mỗi lần đổi tab. */
  const screenRef = useRef(screen);
  screenRef.current = screen;
  /** Nút micro: ghi âm → chữ (Whisper trên máy) → nối vào ô nhập. */
  const stt = useStt();
  const sttPrefs = useSttPrefs();
  /** Nhà cung cấp STT / TTS đang chọn ở Tools › Giọng nói (null = mặc định). */
  const speechVia = useSpeechProviders();
  /** Câu trả lời nào đang được đọc to. */
  const speak = useSyncExternalStore(speaker.subscribe, speaker.getSnapshot, speaker.getServerSnapshot);
  /** Menu ＋ (tải file lên / dán từ clipboard / kho tri thức). */
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
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
      if (window.localStorage.getItem(AGENT_KEY) === '0') setAgent(false);
    } catch { /* nicety */ }
  }, []);
  useEffect(() => {
    // Ảnh thu nhỏ không lưu (nặng) — tải lại trang thì chỉ còn tên file.
    const slim = msgs.slice(-60).map((m) => (m.files ? { ...m, files: m.files.map(({ preview: _p, ...f }) => f) } : m));
    try { window.sessionStorage.setItem(MSGS_KEY, JSON.stringify(slim)); } catch { /* đầy → bỏ qua */ }
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

  // Đóng bảng thì tắt micro và ngừng đọc — không để micro thu âm khi không còn
  // thấy nút, hay giọng đọc vang lên mà không có chỗ bấm dừng.
  const sttCancel = stt.cancel;
  useEffect(() => {
    if (dock.open) return;
    sttCancel();
    speaker.stop();
  }, [dock.open, sttCancel]);

  // Menu ＋: bấm ra ngoài hoặc Esc thì đóng.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  // Ô nhập tự cao theo nội dung (tới giới hạn max-height trong CSS).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, dock.open, view, dock.width]);

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
  const send = useCallback(async (text?: string, base?: Msg[]) => {
    // Chỉ có đính kèm, không gõ gì → vẫn gửi được với câu hỏi mặc định.
    const question = (text ?? draft).trim() || (text === undefined && pending.length ? 'Xem giúp nội dung đính kèm này.' : '');
    if (!question || busy) return;
    if (question.length > AI_LIMITS.maxQuestion) {
      setNote(`Câu hỏi dài quá ${num(AI_LIMITS.maxQuestion)} ký tự — rút gọn hoặc đính kèm thành file.`);
      return;
    }
    const atts = text === undefined ? pending : [];
    const prior = base ?? msgs;
    const history: AiTurn[] = prior
      .filter((m) => m.content && !m.error)
      .map((m) => ({ role: m.role, content: m.content }));
    const aId = uid();
    stick.current = true;
    setMsgs([
      ...prior,
      {
        id: uid(), role: 'user', content: question,
        files: atts.length ? atts.map((a) => ({ name: a.name, kind: a.kind, preview: a.preview })) : undefined,
      },
      { id: aId, role: 'assistant', content: '', streaming: true },
    ]);
    if (text === undefined) { setDraft(''); setPending([]); }
    setNote(null); setBusy(true);
    const patch = (p: Partial<Msg> | ((m: Msg) => Partial<Msg>)) => setMsgs((cur) => cur.map((m) => (
      m.id === aId ? { ...m, ...(typeof p === 'function' ? p(m) : p) } : m
    )));

    stopRef.current = false;
    // CHẠY NỀN: câu hỏi bám vào màn hình lúc gửi (lib/aiScreen.ts — pinTarget).
    // Người dùng chuyển sang menu khác thì trợ lý vẫn đọc / cuộn đúng màn hình
    // đó, không giật màn hình của họ về và không đọc nhầm màn mới.
    if (agent) pinTarget(screenRef.current);
    /** Nhật ký thao tác của câu hỏi này — gửi lại ở mỗi lượt để model biết đã làm gì. */
    const steps: { action: string; result: string; note?: string }[] = [];
    /** Ảnh chụp màn hình sau bước gần nhất — gửi kèm lượt kế (chỉ ảnh MỚI NHẤT). */
    let shots: ScreenShot[] = [];
    let totalMs = 0;
    try {
      // Mỗi vòng = một lượt hỏi. Câu trả lời có khối <hanh_dong> → làm bước đó
      // rồi hỏi tiếp; không có → đó là câu trả lời cuối.
      for (let round = 0; ; round++) {
        const { id } = await call<{ id: string }>('ask', {
          question, history, screen: targetName(screenRef.current), model,
          // File chỉ gửi ở lượt đầu; các lượt sau gửi ảnh chụp màn hình sau bước
          // vừa làm (để model NHÌN phần vẽ canvas: Google Sheets, biểu đồ…).
          attachments: round === 0
            ? atts.map(({ id: _i, bytes: _b, preview: _p, ...a }) => a)
            : shots.map((s) => ({ kind: 'image' as const, name: s.name, mediaType: s.mediaType, data: s.data })),
          ...(agent ? { agent: true, tabs, steps } : {}),
        }, 60000);
        jobRef.current = id;
        let from = 0;
        let raw = '';
        let last: AiPoll;
        for (;;) {
          const r = await call<AiPoll>('poll', { id, from });
          from = r.next;
          if (r.text) { raw += r.text; patch({ content: stripAction(raw) }); }
          if (r.done) { last = r; break; }
          await sleep(POLL_MS);
        }
        totalMs += last.durationMs;
        const stopped = last.error === 'Đã dừng.' || stopRef.current;
        const action = agent && !last.error && !stopped ? parseAction(raw) : null;
        if (!action || round >= MAX_STEPS) {
          patch({
            streaming: false,
            stopped,
            // CLI báo lỗi (hết hạn mức, chưa đăng nhập…) bằng chính phần chữ trả lời →
            // chỉ hiện một lần ở ô lỗi, không lặp lại thành câu trả lời.
            content: last.error && stripAction(raw).trim() === last.error.trim()
              ? ''
              : stripAction(raw) || (action ? `Đã dừng sau ${MAX_STEPS} bước thao tác mà chưa xong — hỏi lại cụ thể hơn giúp.` : ''),
            error: last.error && !stopped ? last.error : undefined,
            meta: last.error ? undefined : { model: last.model, durationMs: totalMs, sources: last.sources },
          });
          break;
        }
        // Một bước thao tác: hiện nhãn, thực hiện trên giao diện, ghi kết quả.
        const label = describeAction(action, tabs);
        patch((m) => ({ content: '', steps: [...(m.steps ?? []), { label, note: stripAction(raw) || undefined, state: 'doing' }] }));
        const result = await runAction(action, {
          tabs,
          screenName: () => screenRef.current,
          confirmClick: (what) => new Promise<boolean>((resolve) => {
            if (stopRef.current) { resolve(false); return; }
            // Chạy nền mà bảng đang đóng thì thẻ "Cho phép" không ai thấy → mở bảng.
            aiDock.setOpen(true);
            setConfirm({ label: what, resolve: (ok) => { setConfirm(null); resolve(ok); } });
          }),
        });
        // Ghi chú của model trước hành động (dữ liệu đã gom được qua các lần
        // cuộn) đi kèm nhật ký — ảnh chụp cũ không gửi lại, chỉ còn ghi chú này.
        steps.push({ action: JSON.stringify(action), result, note: stripAction(raw).slice(0, 4000) || undefined });
        // Bị từ chối bấm thì màn hình không đổi — vẫn chụp lại cho đơn giản.
        shots = await captureScreen();
        patch((m) => ({
          steps: m.steps?.map((s, i, all) => (
            i === all.length - 1 ? { ...s, state: result.startsWith(DENIED) ? 'denied' as const : 'done' as const } : s
          )),
        }));
        if (stopRef.current) { patch({ streaming: false, stopped: true }); break; }
      }
    } catch (e) {
      patch({ streaming: false, error: (e as Error).message });
    } finally {
      jobRef.current = null;
      // View trợ lý tự mở ở nền mà người dùng không đang xem → hỏi có tắt không.
      const toClose = agent ? openedViewsToClose() : [];
      if (toClose.length) patch({ cleanup: { views: toClose, state: 'ask' } });
      releaseTarget();
      setConfirm(null);
      setBusy(false);
    }
  }, [draft, busy, pending, msgs, model, agent, tabs]);

  const stopAsk = () => {
    stopRef.current = true;
    confirm?.resolve(false);
    if (jobRef.current) void call('stop', { id: jobRef.current }).catch(() => {});
  };

  /** Hỏi lại câu hỏi của một câu trả lời: bỏ cặp hỏi–đáp đó rồi gửi lại câu hỏi.
   *  File đính kèm của lượt cũ không được gửi lại (nội dung không còn giữ). */
  const retry = (id: string) => {
    const i = msgs.findIndex((m) => m.id === id);
    if (i < 1 || busy) return;
    void send(msgs[i - 1].content, msgs.slice(0, i - 1));
  };

  /** Chữ dán vào: ngắn thì vào ô nhập, dài thì thành một file đính kèm. */
  const pasteText = (text: string) => {
    if (text.length < AI_LIMITS.pasteAsFileChars) { setDraft((d) => d + text); return; }
    void addFiles([new File([text], 'văn-bản-đã-dán.txt', { type: 'text/plain' })]);
  };

  /** "Dán từ clipboard" trong menu ＋ — cho người không quen Ctrl+V. */
  const pasteFromClipboard = async () => {
    setMenu(false);
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      let text = '';
      for (const it of items) {
        const img = it.types.find((t) => t.startsWith('image/'));
        if (img) { files.push(new File([await it.getType(img)], 'dán-từ-clipboard.png', { type: img })); continue; }
        if (it.types.includes('text/plain')) text += await (await it.getType('text/plain')).text();
      }
      if (files.length) await addFiles(files);
      else if (text) pasteText(text);
      else setNote('Clipboard đang trống hoặc không phải ảnh / chữ.');
    } catch {
      setNote('Không đọc được clipboard — bấm vào ô nhập rồi nhấn Ctrl+V.');
    }
    inputRef.current?.focus();
  };

  /** Bấm micro: đang rảnh → ghi âm; đang ghi → dừng và chuyển thành chữ. */
  const toggleMic = async () => {
    if (stt.state.phase === 'working') return;
    if (stt.state.phase === 'recording') {
      const blob = await stt.stopRec();
      if (!blob || !blob.size) return;
      const done = await stt.transcribeBlob(blob, { model: sttPrefs.model, language: sttPrefs.language, provider: speechVia.stt?.id });
      if (done?.text) {
        setDraft((d) => (d.trim() ? `${d.trimEnd()} ${done.text}` : done.text));
        inputRef.current?.focus();
      } else if (done) {
        setNote('Không nghe ra chữ nào — nói to, rõ hơn hoặc kiểm tra micro.');
      }
      return;
    }
    setNote(null);
    void stt.startRec();
  };

  const newChat = () => { stopAsk(); speaker.stop(); setMsgs([]); setNote(null); setPending([]); inputRef.current?.focus(); };

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
                <p className="aic-empty-title">Hôm nay bạn cần gì?</p>
                <p className="aic-empty-sub">
                  Trợ lý dùng tài liệu trong kho tri thức của bạn. Bật “Thao tác màn hình” thì nó tự mở tab,
                  đọc màn hình và bấm giúp bạn — nút nào không phải tab sẽ hỏi bạn trước.
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
                  <div className="aic-files">
                    {m.files.map((f, i) => (f.preview
                      ? <img key={i} className="aic-file-img" src={f.preview} alt={f.name} title={f.name} />
                      : (
                        <span key={i} className="aic-file" title={f.name}>
                          <span className="aic-att-name">{f.name}</span>
                          <span className="aic-att-type">{typeLabel(f)}</span>
                        </span>
                      )))}
                  </div>
                )}
                <div className="aic-bubble">{m.content}</div>
              </div>
            ) : (
              <div key={m.id} className="aic-msg assistant" aria-busy={m.streaming}>
                {m.steps && (
                  <ol className="aic-steps">
                    {m.steps.map((s, i) => (
                      <li key={i} className={`aic-step ${s.state ?? 'done'}`} title={s.note}>
                        <span aria-hidden>{s.state === 'doing' ? '…' : s.state === 'denied' ? '✕' : '✓'}</span>
                        {s.label}{s.state === 'denied' ? ' — bạn đã từ chối' : ''}
                      </li>
                    ))}
                  </ol>
                )}
                {m.content
                  ? <div className="md-preview aic-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                  : m.streaming ? <span className="aic-typing" aria-label="Đang trả lời"><i /><i /><i /></span> : null}
                {m.stopped && <div className="aic-stopped">Đã dừng.</div>}
                {m.cleanup && !m.streaming && (
                  <div className="aic-cleanup" role="group" aria-label="Tắt các view trợ lý đã mở">
                    {m.cleanup.state === 'ask' ? (
                      <>
                        <span>
                          Trợ lý đã mở ở nền: <b>{m.cleanup.views.map((v) => v.label).join(', ')}</b>.
                          Tắt để nhẹ máy? (trạng thái chưa lưu trong các view này sẽ mất)
                        </span>
                        <span className="aic-cleanup-actions">
                          <button
                            className="sm"
                            onClick={() => {
                              closeViews(m.cleanup!.views.map((v) => v.key));
                              setMsgs((cur) => cur.map((x) => (x.id === m.id && x.cleanup ? { ...x, cleanup: { ...x.cleanup, state: 'closed' } } : x)));
                            }}
                          >Tắt các view này</button>
                          <button
                            className="ghost sm"
                            onClick={() => setMsgs((cur) => cur.map((x) => (x.id === m.id && x.cleanup ? { ...x, cleanup: { ...x.cleanup, state: 'kept' } } : x)))}
                          >Giữ lại</button>
                        </span>
                      </>
                    ) : (
                      <span className="aic-cleanup-done">
                        {m.cleanup.state === 'closed' ? '✓ Đã tắt' : 'Đã giữ lại'}: {m.cleanup.views.map((v) => v.label).join(', ')}
                      </span>
                    )}
                  </div>
                )}
                {m.error && (
                  <div className="aic-error" role="alert">
                    <span>{m.error}</span>
                    <button className="ghost sm" onClick={() => retry(m.id)} disabled={busy}>Thử lại</button>
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
                    <button className="aic-act" onClick={() => void copyMsg(m)}>{copied === m.id ? '✓ Đã sao chép' : '⧉ Sao chép'}</button>
                    <button className="aic-act"
                      onClick={() => void speaker.speak(m.id, mdToSpeech(m.content), 'auto',
                        speechVia.tts ? { provider: speechVia.tts.id, partChars: speechVia.tts.maxChars } : {})}
                      title={speak.key === m.id ? 'Dừng đọc' : `Đọc to câu trả lời này (${speechVia.tts ? speechVia.tts.name : 'giọng Google'} — chữ được gửi tới ${speechVia.tts ? speechVia.tts.name : 'Google'})`}>
                      {speak.key === m.id ? (speak.loading ? '… Đang tải' : '■ Dừng đọc') : '🔊 Đọc'}
                    </button>
                    <button className="aic-act" onClick={() => retry(m.id)} disabled={busy} title="Hỏi lại câu này để nhận câu trả lời khác">↻ Thử lại</button>
                    <button className="aic-act"
                      onClick={() => { setKbDraft({ title: questionBefore(m.id).replace(/\s+/g, ' ').slice(0, 80), content: m.content }); setView('kb'); }}
                      title="Lưu câu trả lời này thành tài liệu trong kho tri thức">
                      ＋ Lưu vào kho
                    </button>
                  </div>
                )}
              </div>
            )))}
          </div>

          <footer className="aic-compose">
            {note && <div className="aic-note" role="status">{note}</div>}
            {(stt.state.error || speak.error) && (
              <div className="aic-note err" role="alert">{stt.state.error ?? speak.error}</div>
            )}
            {stt.state.phase === 'working' && (
              <div className="aic-stt" role="status">
                <span className="spinner" aria-hidden /> <span className="aic-stt-text">{stt.state.status}</span>
                <button className="aic-act" onClick={stt.cancel}>Dừng</button>
              </div>
            )}
            {confirm && (
              <div className="aic-confirm" role="alertdialog" aria-label="Trợ lý xin phép bấm một nút">
                <p>Trợ lý muốn bấm <b>“{confirm.label}”</b> trên màn hình <b>{screen}</b>.</p>
                <div className="aic-confirm-btns">
                  <button className="ghost sm" onClick={() => confirm.resolve(false)}>Từ chối</button>
                  <button className="aic-allow" autoFocus onClick={() => confirm.resolve(true)}>Cho phép</button>
                </div>
              </div>
            )}
            <div className="aic-box">
              {pending.length > 0 && (
                <ul className="aic-atts">
                  {pending.map((p) => (
                    <li key={p.id} className={`aic-att ${p.kind}`} title={p.name}>
                      {p.preview ? <img src={p.preview} alt={p.name} /> : (
                        <>
                          <span className="aic-att-name">{p.name}</span>
                          <span className="aic-att-type">{typeLabel(p)}</span>
                        </>
                      )}
                      <button className="aic-att-x" onClick={() => setPending((cur) => cur.filter((x) => x.id !== p.id))}
                        aria-label={`Bỏ ${p.name}`}>✕</button>
                    </li>
                  ))}
                </ul>
              )}
              <textarea
                ref={inputRef}
                className="aic-input"
                rows={1}
                value={draft}
                placeholder="Hỏi trợ lý… dán ảnh / file bằng Ctrl+V"
                aria-label="Câu hỏi cho trợ lý"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
                }}
                onPaste={(e) => {
                  const files = [...e.clipboardData.files];
                  if (files.length) { e.preventDefault(); void addFiles(files); return; }
                  // Đoạn chữ dài (log, file cấu hình…) → thành thẻ đính kèm cho gọn ô nhập.
                  const text = e.clipboardData.getData('text/plain');
                  if (text.length >= AI_LIMITS.pasteAsFileChars) { e.preventDefault(); pasteText(text); }
                }}
              />
              <div className="aic-bar">
                <div className="aic-plus" ref={menuRef}>
                  <button className={`aic-round${menu ? ' on' : ''}`} onClick={() => setMenu((v) => !v)}
                    aria-haspopup="menu" aria-expanded={menu}
                    title="Thêm ảnh, file" aria-label="Thêm ảnh hoặc file">
                    ＋
                  </button>
                  {menu && (
                    <div className="aic-menu" role="menu">
                      <button role="menuitem" className="aic-menu-item" onClick={() => { setMenu(false); fileRef.current?.click(); }}>
                        <span aria-hidden>📎</span> Tải ảnh hoặc file lên
                      </button>
                      <button role="menuitem" className="aic-menu-item" onClick={() => void pasteFromClipboard()}>
                        <span aria-hidden>📋</span> Dán từ clipboard
                      </button>
                      <button role="menuitem" className="aic-menu-item" onClick={() => { setMenu(false); setView('kb'); }}>
                        <span aria-hidden>📚</span> Mở kho tri thức
                      </button>
                    </div>
                  )}
                </div>
                <input ref={fileRef} type="file" multiple hidden
                  onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
                <button
                  className={`aic-round aic-mic${stt.state.phase === 'recording' ? ' rec' : ''}`}
                  onClick={() => void toggleMic()}
                  disabled={stt.state.phase === 'working'}
                  aria-pressed={stt.state.phase === 'recording'}
                  aria-label={stt.state.phase === 'recording' ? 'Dừng ghi âm và chuyển thành chữ' : 'Nói thay vì gõ'}
                  title={stt.state.phase === 'recording'
                    ? 'Đang ghi âm — bấm để dừng và chuyển thành chữ'
                    : speechVia.stt
                      ? `Nói thay vì gõ: ghi âm rồi gửi ${speechVia.stt.name} chuyển thành chữ (đổi nhà cung cấp ở Giọng nói)`
                      : 'Nói thay vì gõ: ghi âm rồi chuyển thành chữ ngay trên máy (đổi ngôn ngữ / model / nhà cung cấp ở Giọng nói)'}
                >
                  {stt.state.phase === 'recording'
                    ? <><span className="aic-recdot" aria-hidden /> {fmtDuration(stt.state.recSeconds)}</>
                    : '🎙'}
                </button>
                {stt.state.phase === 'recording' && (
                  <button className="aic-act" onClick={stt.cancel} title="Bỏ bản ghi này">Huỷ</button>
                )}
                {/* Đang ghi âm thì nhường chỗ cho đồng hồ + nút Huỷ (thanh chỉ rộng ~390px). */}
                {stt.state.phase !== 'recording' && (
                <button
                  className={`aic-agent${agent ? ' on' : ''}`}
                  role="switch"
                  aria-checked={agent}
                  disabled={busy}
                  onClick={() => {
                    const next = !agent;
                    setAgent(next);
                    try { window.localStorage.setItem(AGENT_KEY, next ? '1' : '0'); } catch { /* nicety */ }
                  }}
                  title={agent
                    ? 'Đang bật: trợ lý được mở tab, đọc màn hình và bấm trên giao diện app (nút không phải tab sẽ hỏi bạn trước). Bấm để tắt.'
                    : 'Đang tắt: trợ lý chỉ trả lời bằng chữ. Bấm để cho phép nó mở tab, đọc màn hình và bấm trên giao diện app.'}
                >
                  <span aria-hidden>🖱</span> Thao tác màn hình
                </button>
                )}
                <span className="aic-spacer" />
                <select className="aic-model" value={model} aria-label="Model trả lời"
                  title={AI_MODELS.find((m) => m.id === model)?.hint}
                  onChange={(e) => {
                    setModel(e.target.value);
                    try { window.localStorage.setItem(MODEL_KEY, e.target.value); } catch { /* nicety */ }
                  }}>
                  {AI_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                {busy ? (
                  <button className="aic-send stop" onClick={stopAsk} title="Dừng câu trả lời" aria-label="Dừng câu trả lời">■</button>
                ) : (
                  <button className="aic-send" onClick={() => void send()} disabled={!draft.trim() && pending.length === 0}
                    title="Gửi (Enter)" aria-label="Gửi câu hỏi">↑</button>
                )}
              </div>
            </div>
            <p className="aic-disclaimer">Trợ lý có thể sai — kiểm tra lại thông tin quan trọng. Enter gửi · Shift+Enter xuống dòng.</p>
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
