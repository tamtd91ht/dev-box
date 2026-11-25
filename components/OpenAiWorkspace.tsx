'use client';

// Menu 🤖 OpenAI — gửi prompt tới ChatGPT qua API của OpenAI.
//
//   · Gửi request: chọn CẤU HÌNH (khoá nào, dịch vụ nào) + model, "Định hướng"
//     (system prompt — vai trò, giọng văn, định dạng kết quả mong muốn) + Prompt,
//     temperature / max tokens / dạng kết quả (chữ hoặc JSON). Kết quả hiện dần,
//     sao chép được; lịch sử vài chục lần gửi gần nhất giữ trong trình duyệt.
//     Prompt mẫu (cấu hình + định hướng + tham số, có thể kèm prompt) lưu ở server.
//   · Cấu hình: lưu NHIỀU cấu hình (vd "Công ty", "Cá nhân", "OpenRouter"), mỗi cái
//     có khoá API, model mặc định; mục Nâng cao (base URL, organization, project).
//     Một cấu hình là mặc định — chọn sẵn khi gửi request.
//
// Model luôn chọn bằng dropdown (gõ tay dễ sai tên): model của tài khoản lấy qua
// API theo từng cấu hình, mục cuối "Nhập tay…" cho model mới app chưa kịp biết.
//
// Khoá API chỉ nằm ở server (lib/openaiServer.ts, configs/openai.json): trang chỉ
// thấy "sk-p…3fQa". Mọi lời gọi đi qua /api/openai; request chạy thành job ở
// server, trang hỏi tiến độ (poll) — giống trợ lý AI.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/lib/apiFetch';
import { renderMarkdown } from '@/lib/md';
import {
  OPENAI_DEFAULT_BASE, OPENAI_FILE_EXTS, OPENAI_LIMITS,
  type OpenAiFormat, type OpenAiPoll, type OpenAiTokenEstimate, type OpenAiPreset, type OpenAiProfile, type OpenAiProfiles, type OpenAiUsage,
} from '@/lib/openai';

const TAB_KEY = 'openai.tab';
const DRAFT_KEY = 'openai.draft';
const HISTORY_KEY = 'openai.history';
/** Các tab request đang mở + tab đang xem (chỉ bản nháp — file và kết quả không lưu, như menu API). */
const TABS_KEY = 'openai.tabs';
/** Model người dùng tự nhập (app chưa kịp biết) — nhớ để lần sau có sẵn trong dropdown. */
const CUSTOM_KEY = 'openai.customModels';
const ADV_KEY = 'openai.advancedOpen';
const POLL_MS = 400;
const MAX_CUSTOM = 20;
const CUSTOM_OPTION = '__custom__';
const NEW_PROFILE = '__new__';

/** Gợi ý khi CHƯA lấy được danh sách model của cấu hình (chưa có khoá, base URL không hỗ trợ /models…).
 *  Có thể cũ so với OpenAI — model mới thì dùng "Nhập tay". Có danh sách thật thì không hiện mục này. */
const SUGGESTED_MODELS = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (n: number) => n.toLocaleString('vi-VN');

async function call<T>(action: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
  const r = await apiFetch('/api/openai', { method: 'POST', body: JSON.stringify({ action, ...params }), timeoutMs });
  const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: T };
  if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
  return data.result as T;
}

function load<T>(key: string, fallback: T): T {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch { return fallback; }
}
function save(key: string, value: unknown): void {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* bộ nhớ đầy / bị chặn */ }
}

interface Draft {
  /** Tên request (tuỳ chọn) — hiện trên tab; trống thì tab lấy dòng đầu của prompt. */
  name: string;
  profileId: string;
  system: string;
  prompt: string;
  model: string;
  temperature: string;
  maxTokens: string;
  format: OpenAiFormat;
}
const EMPTY_DRAFT: Draft = { name: '', profileId: '', system: '', prompt: '', model: '', temperature: '', maxTokens: '', format: 'text' };

interface Run {
  id: string | null;
  text: string;
  running: boolean;
  error: string | null;
  model: string | null;
  usage: OpenAiUsage | null;
  finishReason: string | null;
  durationMs: number;
  format: OpenAiFormat;
  /** Mốc đo ở TRANG (performance.now): bấm Gửi → chữ đầu tiên về → có kết quả đầy đủ (hoặc lỗi / dừng).
   *  Gồm cả mạng và thời gian chờ server — đúng cảm nhận của người dùng. */
  submittedAt: number | null;
  firstAt: number | null;
  endedAt: number | null;
}
const IDLE: Run = {
  id: null, text: '', running: false, error: null, model: null, usage: null, finishReason: null, durationMs: 0, format: 'text',
  submittedAt: null, firstAt: null, endedAt: null,
};

/** Dưới 5 giây: mili giây ("840 ms", "3.215 ms"); dưới 1 phút: làm tròn giây ("12 giây");
 *  từ 1 phút: phút + giây ("2 phút 05 giây"). */
function fmtSeconds(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  if (v < 5_000) return `${v.toLocaleString('vi-VN')} ms`;
  const s = Math.round(v / 1000);
  if (s < 60) return `${s} giây`;
  const m = Math.floor(s / 60);
  return `${m} phút ${String(s - m * 60).padStart(2, '0')} giây`;
}

interface HistoryItem {
  at: string;
  profile: string;
  model: string;
  system: string;
  prompt: string;
  /** Tên các file đã đính (chữ của file không lưu vào lịch sử — quá nặng). */
  files?: string[];
  /** Đủ để mở lại request ở tab mới (bản cũ chưa có các trường này thì dùng mặc định). */
  name?: string;
  profileId?: string;
  temperature?: string;
  maxTokens?: string;
  text: string;
  format: OpenAiFormat;
  usage: OpenAiUsage | null;
  /** Tổng thời gian từ lúc bấm Gửi tới lúc có kết quả (ms). */
  elapsedMs?: number;
}

/** File đã import: chữ server đọc ra (lib/fileText.ts) — giữ trong bộ nhớ, không lưu bản nháp. */
interface ImportedFile {
  name: string;
  kind: string;
  text: string;
  chars: number;
  truncated: boolean;
  note: string;
}

/** Prompt dùng khi chỉ đính file mà không viết gì. */
const FILE_ONLY_PROMPT = 'Phân tích nội dung file đính kèm.';

/**
 * Kéo focus bàn phím về trang chính rồi mới focus ô vừa bấm. Electron bug: vừa ở một tab có
 * <webview> (Browser, Workspace, Links…) sang đây thì guest — đã đi offscreen — vẫn cầm focus,
 * gõ vào ô không ra chữ cho tới khi focus tự về (người dùng thấy "phải chờ một lúc"). Cùng cách
 * với ConfigSyncButton / PasswordManager (workspace:focusHost trong electron/main.cjs).
 */
function reclaimFocus(target?: HTMLElement | null): void {
  const bridge = typeof window !== 'undefined' ? window.workspace?.focusHost : undefined;
  if (!bridge) return;
  void Promise.resolve(bridge()).catch(() => {}).finally(() => target?.focus());
}

/** Hỏi xác nhận bằng hộp thoại của trình duyệt, rồi trả focus về trang (hộp thoại gốc của Electron
 *  cũng có lúc để ô nhập "chết" sau khi đóng). */
function ask(message: string): boolean {
  const ok = window.confirm(message);
  reclaimFocus();
  return ok;
}

function toBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
    r.onerror = () => reject(new Error(`${f.name}: không đọc được file.`));
    r.readAsDataURL(f);
  });
}

// ── Chọn model ───────────────────────────────────────────────────────────────

/** Các model chọn được: của tài khoản (API) / đã nhập tay / gợi ý. */
interface ModelChoices {
  live: string[];
  custom: string[];
  addCustom: (m: string) => void;
}

/**
 * Chọn model bằng DROPDOWN (gõ tay dễ sai tên). Nhóm: model của tài khoản (lấy qua API),
 * model đã nhập tay, gợi ý sẵn (chỉ khi chưa lấy được danh sách thật). Mục cuối "Nhập tay…"
 * mở ô nhập cho model mới mà app chưa kịp biết; model đó được nhớ cho lần sau.
 */
function ModelPicker({ value, onChange, choices, allowEmpty, emptyLabel = '— Chọn model —' }: {
  value: string;
  onChange: (m: string) => void;
  choices: ModelChoices;
  /** Có mục trống (vd "dùng model mặc định"). */
  allowEmpty?: boolean;
  emptyLabel?: string;
}) {
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const { live, custom } = choices;
  const customOnly = custom.filter((m) => !live.includes(m));
  const suggested = live.length ? [] : SUGGESTED_MODELS.filter((m) => !custom.includes(m));
  // Giá trị hiện tại không nằm trong nhóm nào (vd lưu từ trước) → vẫn hiện để không mất.
  const known = new Set([...live, ...customOnly, ...suggested]);
  const orphan = value && !known.has(value) ? value : '';

  const confirm = () => {
    const m = typed.trim();
    if (!m) return;
    choices.addCustom(m);
    onChange(m);
    setTyping(false);
    setTyped('');
  };

  if (typing) {
    return (
      <span className="oai-model-typing">
        <input
          autoFocus
          spellCheck={false}
          value={typed}
          placeholder="Tên model chính xác, vd gpt-5-mini"
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); confirm(); }
            if (e.key === 'Escape') { e.preventDefault(); setTyping(false); }
          }}
        />
        <button className="ghost sm" onClick={confirm} disabled={!typed.trim()}>Dùng</button>
        <button className="ghost sm" onClick={() => setTyping(false)}>Huỷ</button>
      </span>
    );
  }

  return (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value === CUSTOM_OPTION) { setTyped(''); setTyping(true); return; }
        onChange(e.target.value);
      }}
    >
      {(allowEmpty || !value) && <option value="">{emptyLabel}</option>}
      {orphan && <option value={orphan}>{orphan}</option>}
      {live.length > 0 && (
        <optgroup label="Model của tài khoản">
          {live.map((m) => <option key={m} value={m}>{m}</option>)}
        </optgroup>
      )}
      {customOnly.length > 0 && (
        <optgroup label="Đã nhập tay">
          {customOnly.map((m) => <option key={m} value={m}>{m}</option>)}
        </optgroup>
      )}
      {suggested.length > 0 && (
        <optgroup label="Gợi ý (chưa lấy được danh sách từ tài khoản)">
          {suggested.map((m) => <option key={m} value={m}>{m}</option>)}
        </optgroup>
      )}
      <option value={CUSTOM_OPTION}>✎ Nhập tay model khác…</option>
    </select>
  );
}

// ── Khung chính ──────────────────────────────────────────────────────────────

export default function OpenAiWorkspace() {
  const [tab, setTabState] = useState<'request' | 'config'>('request');
  const [store, setStore] = useState<OpenAiProfiles | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  /** Model của tài khoản theo từng cấu hình (lấy qua API khi cần). */
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<string[]>([]);
  const [presets, setPresets] = useState<OpenAiPreset[]>([]);

  // ── Nhiều tab request (như menu API) ──
  const [reqTabs, setReqTabs] = useState<ReqTab[]>([]);
  const [activeKey, setActiveKey] = useState('');
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  useEffect(() => {
    // Khôi phục các tab; bản trước chỉ có MỘT bản nháp (DRAFT_KEY) → thành tab đầu tiên.
    const saved = load<{ drafts?: Partial<Draft>[]; active?: number } | null>(TABS_KEY, null);
    const drafts = saved?.drafts?.length ? saved.drafts : [load<Partial<Draft>>(DRAFT_KEY, {})];
    const tabs = drafts.slice(0, OPENAI_LIMITS.maxTabs).map((d) => newReqTab({ ...EMPTY_DRAFT, ...d }));
    setReqTabs(tabs);
    setActiveKey(tabs[Math.min(Math.max(0, saved?.active ?? 0), tabs.length - 1)].key);
    setHistory(load<HistoryItem[]>(HISTORY_KEY, []).slice(0, OPENAI_LIMITS.maxHistory));
  }, []);
  useEffect(() => {
    if (!reqTabs.length) return;
    save(TABS_KEY, { drafts: reqTabs.map((t) => t.draft), active: Math.max(0, reqTabs.findIndex((t) => t.key === activeKey)) });
  }, [reqTabs, activeKey]);

  // Tên request do thanh tab quản (đổi tên ngay trên tab) — bản nháp từ RequestPane không ghi đè tên.
  const onDraft = useCallback((key: string, d: Draft) => {
    setReqTabs((ts) => ts.map((t) => (t.key === key ? { ...t, draft: { ...d, name: t.draft.name } } : t)));
  }, []);
  const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null);
  const startRename = useCallback((key: string) => {
    const t = reqTabs.find((x) => x.key === key);
    if (!t) return;
    setActiveKey(key);
    setTab('request');
    setRenaming({ key, value: t.draft.name });
    reclaimFocus();
  }, [reqTabs]);
  const commitRename = useCallback(() => {
    if (!renaming) return; // Enter đã lưu → ô nhập biến mất → blur gọi lại: bỏ qua
    const { key, value } = renaming;
    const name = value.trim().slice(0, 80);
    setReqTabs((ts) => ts.map((t) => (t.key === key ? { ...t, draft: { ...t.draft, name } } : t)));
    setRenaming(null);
  }, [renaming]);
  const onStatus = useCallback((key: string, st: TabStatus) => {
    setReqTabs((ts) => ts.map((t) => (t.key === key && t.status !== st ? { ...t, status: st } : t)));
  }, []);
  const onHistory = useCallback((item: HistoryItem) => setHistory((h) => {
    const next = [item, ...h].slice(0, OPENAI_LIMITS.maxHistory);
    save(HISTORY_KEY, next);
    return next;
  }), []);
  const clearHistory = useCallback(() => { setHistory([]); save(HISTORY_KEY, []); }, []);
  const openConfig = useCallback(() => { setTabState('config'); save(TAB_KEY, 'config'); }, []);

  /** Mở tab mới ngay sau tab đang xem (bản nháp trống, nhân bản, hoặc mở lại từ lịch sử). */
  const openTab = useCallback((d: Draft = EMPTY_DRAFT, run?: Run) => {
    setTab('request');
    if (reqTabs.length >= OPENAI_LIMITS.maxTabs) {
      window.alert(`Đã mở ${OPENAI_LIMITS.maxTabs} tab — đóng bớt trước.`);
      reclaimFocus();
      return;
    }
    const t = newReqTab(d, run);
    setReqTabs((ts) => {
      const i = ts.findIndex((x) => x.key === activeKey);
      return [...ts.slice(0, i + 1), t, ...ts.slice(i + 1)];
    });
    setActiveKey(t.key);
  }, [activeKey, reqTabs.length]);

  /** Đóng một nhóm tab; đóng hết = dọn bàn (còn một tab trống), không để màn hình trống. */
  const closeTabs = useCallback((keys: Set<string>, keep?: string) => {
    const focus = keep ?? activeKey;
    const i = reqTabs.findIndex((t) => t.key === focus);
    const left = reqTabs.filter((t) => !keys.has(t.key));
    const next = left.length ? left : [newReqTab(EMPTY_DRAFT)];
    let nextActive = focus;
    if (!next.some((t) => t.key === focus)) {
      // Tab đang xem bị đóng → sang tab kế bên (như trình duyệt / menu API).
      const after = reqTabs.slice(i + 1).find((t) => !keys.has(t.key))
        ?? [...reqTabs.slice(0, Math.max(0, i))].reverse().find((t) => !keys.has(t.key));
      nextActive = (after ?? next[0]).key;
    }
    setReqTabs(next);
    setActiveKey(nextActive);
  }, [activeKey, reqTabs]);

  const setTab = (t: 'request' | 'config') => { setTabState(t); save(TAB_KEY, t); };

  const loadModels = useCallback(async (profileId: string, force = false) => {
    if (!profileId) return;
    if (!force && models[profileId]) return;
    let list: string[] = [];
    try { list = await call<string[]>('models', { profileId }); } catch { /* không lấy được → dropdown dùng gợi ý */ }
    setModels((m) => ({ ...m, [profileId]: list }));
  }, [models]);

  useEffect(() => {
    reclaimFocus(); // mở menu ngay sau một tab có <webview>: nhả focus khỏi guest
    setTabState(load(TAB_KEY, 'request'));
    setCustom(load<string[]>(CUSTOM_KEY, []));
    void (async () => {
      try {
        const s = await call<OpenAiProfiles>('profiles.list');
        setStore(s);
        if (!s.profiles.some((p) => p.hasKey)) setTabState('config');
      } catch (e) { setLoadErr((e as Error).message); }
      try { setPresets(await call<OpenAiPreset[]>('presets.list')); } catch { /* chưa có thì thôi */ }
    })();
  }, []);

  const addCustom = useCallback((m: string) => setCustom((list) => {
    const next = [m, ...list.filter((x) => x !== m)].slice(0, MAX_CUSTOM);
    save(CUSTOM_KEY, next);
    return next;
  }), []);
  const choicesFor = useCallback(
    (profileId: string): ModelChoices => ({ live: models[profileId] ?? [], custom, addCustom }),
    [models, custom, addCustom],
  );

  const ready = store?.profiles.some((p) => p.hasKey);

  return (
    <div
      className="oai-wrap"
      // Bấm vào ô nhập: đòi focus về trang chính trước (xem reclaimFocus) — menu này được mở lại
      // nhiều lần, không chỉ lúc mount, nên làm ở mỗi lần bấm chứ không chỉ một lần.
      onPointerDownCapture={(e) => {
        const t = (e.target as HTMLElement).closest<HTMLElement>('input, textarea, select');
        if (t) reclaimFocus(t);
      }}
    >
      {/* Thanh trên: các tab request bên trái, ⚙ Cấu hình ở góc phải — dồn chiều cao cho request. */}
      <div className="oai-topbar">
        <div className="api-wintabs g-shrink oai-wintabs">
          {reqTabs.map((t) => (
            <div
              key={t.key}
              className={`api-wintab${t.key === activeKey && tab === 'request' ? ' on' : ''}`}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTabs(new Set([t.key])); } }}
              onContextMenu={(e) => {
                e.preventDefault();
                setTabMenu({
                  x: Math.max(6, Math.min(e.clientX, window.innerWidth - 240)),
                  y: Math.max(6, Math.min(e.clientY, window.innerHeight - 260)),
                  key: t.key,
                });
              }}
            >
              {renaming?.key === t.key ? (
                // Đổi tên ngay trên tab: Enter / bấm ra ngoài = lưu, Esc = huỷ.
                <input
                  className="oai-tab-rename"
                  autoFocus
                  value={renaming.value}
                  maxLength={80}
                  placeholder="Tên request"
                  onChange={(e) => setRenaming({ key: t.key, value: e.target.value })}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                    if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
                  }}
                />
              ) : (
                <button
                  className="api-wintab-btn"
                  onClick={() => { setActiveKey(t.key); setTab('request'); }}
                  onDoubleClick={() => startRename(t.key)}
                  title={`${t.draft.name.trim() || t.draft.prompt.slice(0, 300) || 'Request mới'}\n(bấm đúp để đổi tên)`}
                >
                  <span className="api-wintab-name">{reqTabLabel(t.draft)}</span>
                  {t.status === 'running' && <span className="small" aria-label="đang chạy">…</span>}
                  {t.status === 'done' && <span className="oai-tabdot ok" aria-label="xong">●</span>}
                  {t.status === 'error' && <span className="oai-tabdot err" aria-label="lỗi">●</span>}
                </button>
              )}
              <button className="api-wintab-x" onClick={() => closeTabs(new Set([t.key]))} title="Đóng tab (chuột giữa cũng đóng)">✕</button>
            </div>
          ))}
          <button className="ghost sm" onClick={() => openTab()} title="Tab request mới">＋</button>
        </div>
        <button
          className={`oai-gear${tab === 'config' ? ' on' : ''}`}
          onClick={() => setTab(tab === 'config' ? 'request' : 'config')}
          aria-pressed={tab === 'config'}
          aria-label="Cấu hình OpenAI"
          title={tab === 'config'
            ? 'Đóng Cấu hình — quay về request'
            : `Cấu hình OpenAI${store ? ` · ${store.profiles.length} cấu hình${ready ? '' : ' · chưa có khoá API'}` : ''}`}
        >
          ⚙{store && !ready && <span className="oai-dot" />}
        </button>
      </div>
      {loadErr && <div className="oai-error" role="alert">Không đọc được cấu hình: {loadErr}</div>}
      {/* Các tab request LUÔN mount (chỉ ẩn) — kể cả khi đang ở Cấu hình — để request đang chạy
          ở tab khác không bị dừng và bản nháp không mất. */}
      <div className="oai-reqarea" hidden={tab !== 'request'}>
        {reqTabs.map((t) => (
          <div key={t.key} className="oai-tabpane" hidden={t.key !== activeKey}>
            <RequestPane
              tabKey={t.key}
              name={t.draft.name}
              initialDraft={t.draft}
              initialRun={t.run}
              onDraft={onDraft}
              onStatus={onStatus}
              history={history}
              onHistory={onHistory}
              onClearHistory={clearHistory}
              onOpenTab={openTab}
              store={store}
              choicesFor={choicesFor}
              loadModels={loadModels}
              presets={presets}
              setPresets={setPresets}
              onConfigure={openConfig}
            />
          </div>
        ))}
      </div>
      {/* Menu chuột phải của một tab request — như menu API. */}
      {tabMenu && typeof document !== 'undefined' && createPortal(
        <>
          <div className="bt-menu-backdrop" onMouseDown={() => setTabMenu(null)} onContextMenu={(e) => { e.preventDefault(); setTabMenu(null); }} />
          <div className="bt-menu bt-menu-fixed" role="menu" style={{ left: tabMenu.x, top: tabMenu.y, minWidth: 220 }} onMouseDown={(e) => e.stopPropagation()}>
            {(() => {
              const key = tabMenu.key;
              const keys = reqTabs.map((t) => t.key);
              const i = keys.indexOf(key);
              const left = keys.slice(0, Math.max(0, i));
              const right = i < 0 ? [] : keys.slice(i + 1);
              const others = keys.filter((k) => k !== key);
              const src = reqTabs.find((t) => t.key === key);
              const act = (fn: () => void) => () => { setTabMenu(null); fn(); };
              return (
                <>
                  <button onClick={act(() => startRename(key))}>✎ Đổi tên</button>
                  <button onClick={act(() => { if (src) openTab({ ...src.draft, name: src.draft.name ? `${src.draft.name} (copy)` : '' }); })}>⧉ Nhân bản thành tab mới</button>
                  <div className="bt-menu-sep" />
                  <button onClick={act(() => closeTabs(new Set([key])))}>✕ Đóng tab này</button>
                  <button onClick={act(() => closeTabs(new Set(others), key))} disabled={!others.length}>
                    Đóng các tab khác<span className="bt-menu-key">{others.length || ''}</span>
                  </button>
                  <button onClick={act(() => closeTabs(new Set(left), key))} disabled={!left.length}>
                    ⇤ Đóng các tab bên trái<span className="bt-menu-key">{left.length || ''}</span>
                  </button>
                  <button onClick={act(() => closeTabs(new Set(right), key))} disabled={!right.length}>
                    ⇥ Đóng các tab bên phải<span className="bt-menu-key">{right.length || ''}</span>
                  </button>
                  <div className="bt-menu-sep" />
                  <button className="danger" onClick={act(() => closeTabs(new Set(keys)))}>
                    Đóng tất cả<span className="bt-menu-key">{keys.length}</span>
                  </button>
                </>
              );
            })()}
          </div>
        </>,
        document.body,
      )}
      {tab === 'config' && (
        <ConfigPane
          store={store}
          choicesFor={choicesFor}
          onSaved={(s, touched) => {
            setStore(s);
            // Cấu hình vừa sửa có thể đổi khoá / base URL → lấy lại model của nó lần sau.
            if (touched) setModels((m) => { const n = { ...m }; delete n[touched]; return n; });
          }}
          onModels={(id, list) => setModels((m) => ({ ...m, [id]: list }))}
        />
      )}
    </div>
  );
}

// ── Gửi request ──────────────────────────────────────────────────────────────

/** Một tab request ở thanh tab. `draft` là bản sao (để nhãn tab, nhân bản, lưu lại) — nguồn thật
 *  nằm trong RequestPane của tab đó. */
interface ReqTab {
  key: string;
  draft: Draft;
  /** Mở từ lịch sử: kết quả cũ hiện sẵn (không lưu qua lần mở sau). */
  run?: Run;
  status: TabStatus;
}

let tabSeq = 0;
function newReqTab(draft: Draft, run?: Run): ReqTab {
  tabSeq += 1;
  return { key: `t${Date.now().toString(36)}${tabSeq.toString(36)}`, draft: { ...draft }, run, status: run?.text ? 'done' : 'idle' };
}

/** Nhãn tab: dòng đầu của prompt; không có thì dòng đầu của định hướng; không có nữa thì "Request mới". */
function reqTabLabel(d: Draft): string {
  const first = (s: string) => s.trim().split('\n')[0].trim();
  // Tên người dùng đặt (tuỳ chọn) trước; không có thì dòng đầu của prompt / định hướng.
  const t = (d.name ?? '').trim() || first(d.prompt) || (d.system.trim() ? `⚙ ${first(d.system)}` : '');
  if (!t) return 'Request mới';
  return t.length > 28 ? `${t.slice(0, 27)}…` : t;
}

/** Trạng thái một tab cho thanh tab: đang chạy / xong / lỗi. */
type TabStatus = 'idle' | 'running' | 'done' | 'error';

/** Một tab request (menu có nhiều tab như menu API): state riêng, chạy nền được khi đang xem tab khác.
 *  memo: gõ ở một tab chỉ vẽ lại tab đó, không vẽ lại cả loạt tab (kết quả dài, Markdown). */
const RequestPane = memo(function RequestPane({
  tabKey, name, initialDraft, initialRun, onDraft, onStatus, history, onHistory, onClearHistory, onOpenTab,
  store, choicesFor, loadModels, presets, setPresets, onConfigure,
}: {
  tabKey: string;
  /** Tên request (đổi trên tab) — lưu vào lịch sử. */
  name: string;
  initialDraft: Draft;
  /** Mở từ lịch sử: kết quả cũ hiện sẵn. */
  initialRun?: Run;
  onDraft: (key: string, d: Draft) => void;
  onStatus: (key: string, s: TabStatus) => void;
  history: HistoryItem[];
  onHistory: (h: HistoryItem) => void;
  onClearHistory: () => void;
  onOpenTab: (d: Draft, run?: Run) => void;
  store: OpenAiProfiles | null;
  choicesFor: (profileId: string) => ModelChoices;
  loadModels: (profileId: string, force?: boolean) => Promise<void>;
  presets: OpenAiPreset[];
  setPresets: (p: OpenAiPreset[]) => void;
  onConfigure: () => void;
}) {
  const [draft, setDraftState] = useState<Draft>(initialDraft);
  const [run, setRun] = useState<Run>(initialRun ?? IDLE);
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const [presetId, setPresetId] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [files, setFilesState] = useState<ImportedFile[]>([]);
  // Bản đồng bộ để kiểm giới hạn khi nhiều file được thêm liên tiếp (state chưa kịp cập nhật).
  const filesRef = useRef<ImportedFile[]>([]);
  const setFiles = (next: ImportedFile[]) => { filesRef.current = next; setFilesState(next); };
  const [reading, setReading] = useState(0);
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);

  /** Import file: server đọc chữ ra (doc, docx, txt, csv, pdf, xlsx); lỗi báo từng file. */
  const addFiles = async (list: File[]) => {
    const errs: string[] = [];
    for (const f of list) {
      const ext = (/\.[^.]+$/.exec(f.name.toLowerCase())?.[0] ?? '');
      if (!OPENAI_FILE_EXTS.includes(ext)) { errs.push(`${f.name}: chỉ nhận ${OPENAI_FILE_EXTS.join(', ')}.`); continue; }
      if (f.size > OPENAI_LIMITS.fileBytes) { errs.push(`${f.name}: lớn hơn ${OPENAI_LIMITS.fileBytes / 1024 / 1024} MB.`); continue; }
      setReading((n) => n + 1);
      try {
        const r = await call<ImportedFile>('file.read', { name: f.name, data: await toBase64(f) }, 120_000);
        const cur = filesRef.current.filter((x) => x.name !== r.name); // cùng tên = thay file cũ
        const total = cur.reduce((n, x) => n + x.chars, 0) + r.chars;
        if (cur.length >= OPENAI_LIMITS.maxFiles) errs.push(`${f.name}: tối đa ${OPENAI_LIMITS.maxFiles} file mỗi request.`);
        else if (total > OPENAI_LIMITS.filesTotalChars) errs.push(`${f.name}: các file cộng lại dài quá ${num(OPENAI_LIMITS.filesTotalChars)} ký tự.`);
        else setFiles([...cur, r]);
      } catch (e) {
        errs.push((e as Error).message);
      } finally {
        setReading((n) => n - 1);
      }
    }
    setMsg(errs.length ? { kind: 'err', text: errs.join(' · ') } : null);
  };

  const dropProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault(); dragDepth.current += 1; setDropping(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDropping(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault(); dragDepth.current = 0; setDropping(false);
      void addFiles([...e.dataTransfer.files]);
    },
  };

  const setDraft = (patch: Partial<Draft>) => setDraftState((d) => ({ ...d, ...patch }));
  // Bản nháp lên khung cha (nhãn tab + lưu lại các tab đang mở).
  useEffect(() => { onDraft(tabKey, draft); }, [draft, tabKey, onDraft]);
  // Trạng thái cho thanh tab: … đang chạy, chấm xanh xong, chấm đỏ lỗi.
  const status: TabStatus = run.running ? 'running' : run.error && run.error !== 'Đã dừng.' ? 'error' : run.text ? 'done' : 'idle';
  useEffect(() => { onStatus(tabKey, status); }, [status, tabKey, onStatus]);
  // Đóng tab khi request còn chạy → dừng nó ở server (khỏi tốn token cho kết quả không ai xem).
  const runIdRef = useRef<string | null>(null);
  useEffect(() => { runIdRef.current = run.running ? run.id : null; }, [run.running, run.id]);
  useEffect(() => () => { if (runIdRef.current) void call('stop', { id: runIdRef.current }).catch(() => {}); }, []);

  // Cấu hình đang chọn: theo bản nháp nếu còn tồn tại, không thì cấu hình mặc định.
  const profiles = store?.profiles ?? [];
  const profile: OpenAiProfile | undefined = profiles.find((p) => p.id === draft.profileId)
    ?? profiles.find((p) => p.id === store?.defaultId) ?? profiles[0];
  const profileId = profile?.id ?? '';
  useEffect(() => { if (profileId) void loadModels(profileId); }, [profileId, loadModels]);

  const model = draft.model || profile?.defaultModel || '';
  // Request "đủ": có cấu hình có khoá, model, prompt hoặc file, không đang đọc file.
  const filled = !!profile?.hasKey && (!!draft.prompt.trim() || files.length > 0) && !!model && reading === 0;
  const canSend = filled && !run.running;
  const prompt = draft.prompt.trim() ? draft.prompt : FILE_ONLY_PROMPT;

  /** Request đang soạn — dùng chung cho Gửi và Copy cURL (hai thứ phải khớp nhau). */
  const buildRequest = () => ({
    profileId,
    model,
    system: draft.system,
    prompt,
    temperature: draft.temperature === '' ? null : Number(draft.temperature),
    maxTokens: draft.maxTokens === '' ? null : Number(draft.maxTokens),
    format: draft.format,
    files: files.map((f) => ({ name: f.name, text: f.text })),
  });

  // Ước tính token INPUT trước khi gửi: server đếm bằng tokenizer của OpenAI trên đúng các message
  // sẽ gửi (định hướng + prompt + chữ của file). Đếm lại sau khi ngừng gõ một nhịp.
  const [est, setEst] = useState<{ tokens: number; exact: boolean; encoding: string } | null>(null);
  const [estBusy, setEstBusy] = useState(false);
  const estKey = filled ? JSON.stringify([profileId, model, draft.system, prompt, files.map((f) => [f.name, f.chars])]) : '';
  const estReq = useRef(buildRequest);
  estReq.current = buildRequest;
  useEffect(() => {
    if (!estKey) { setEst(null); return; }
    let live = true;
    setEstBusy(true);
    const t = window.setTimeout(() => {
      void call<OpenAiTokenEstimate>('tokens', { request: estReq.current() }, 60_000)
        .then((r) => { if (live) setEst(r); })
        .catch(() => { if (live) setEst(null); })
        .finally(() => { if (live) setEstBusy(false); });
    }, 600);
    return () => { live = false; window.clearTimeout(t); };
  }, [estKey]);

  const [curlKey, setCurlKey] = useState(false);
  const [curlCopied, setCurlCopied] = useState(false);
  /** Lệnh cURL tương đương (server dựng từ đúng body sẽ gửi) để chạy lại ở Postman / terminal. */
  const copyCurl = async () => {
    if (!filled) return;
    if (curlKey && !ask('Lệnh cURL sẽ chứa KHOÁ API THẬT — chỉ dán vào nơi an toàn (đừng gửi qua chat, đừng commit). Tiếp tục?')) return;
    setMsg(null);
    try {
      const r = await call<{ curl: string; hasKey: boolean }>('curl', { request: buildRequest(), withKey: curlKey });
      await navigator.clipboard.writeText(r.curl);
      setCurlCopied(true);
      setTimeout(() => setCurlCopied(false), 1500);
      setMsg({
        kind: 'ok',
        text: r.hasKey
          ? 'Đã chép cURL (kèm khoá thật, "stream": false).'
          : 'Đã chép cURL — đặt biến OPENAI_API_KEY (hoặc thay $OPENAI_API_KEY bằng khoá) trước khi chạy; "stream": false.',
      });
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  };

  const send = async () => {
    if (!canSend || !profile) return;
    setMsg(null);
    setRaw(false);
    const format = draft.format;
    const submittedAt = performance.now();
    let firstAt: number | null = null;
    setRun({ ...IDLE, running: true, format, submittedAt });
    try {
      const { id } = await call<{ id: string }>('start', { request: buildRequest() });
      setRun((r) => ({ ...r, id }));
      let from = 0;
      let text = '';
      for (;;) {
        const p = await call<OpenAiPoll>('poll', { id, from });
        from = p.next;
        text += p.text;
        if (firstAt === null && text) firstAt = performance.now();
        const endedAt = p.done ? performance.now() : null;
        setRun((r) => ({
          ...r, text, model: p.model, usage: p.usage, finishReason: p.finishReason, durationMs: p.durationMs, error: p.error,
          firstAt, endedAt,
        }));
        if (p.done) {
          if (!p.error && text) {
            const item: HistoryItem = {
              at: new Date().toISOString(), profile: profile.name, model: p.model ?? model,
              system: draft.system, prompt: draft.prompt, text, format, usage: p.usage,
              elapsedMs: Math.round((endedAt ?? performance.now()) - submittedAt),
              ...(files.length ? { files: files.map((f) => f.name) } : {}),
              profileId, temperature: draft.temperature, maxTokens: draft.maxTokens,
              ...(name.trim() ? { name: name.trim() } : {}),
            };
            onHistory(item);
          }
          break;
        }
        await sleep(POLL_MS);
      }
    } catch (e) {
      setRun((r) => ({ ...r, error: (e as Error).message }));
    } finally {
      // Lỗi giữa chừng (mạng, server) cũng chốt mốc kết thúc để đồng hồ dừng đúng chỗ.
      setRun((r) => ({ ...r, running: false, endedAt: r.endedAt ?? performance.now() }));
    }
  };

  const stopRun = () => {
    if (run.id) void call('stop', { id: run.id }).catch(() => {});
  };

  const applyPreset = (id: string) => {
    setPresetId(id);
    if (id) setAdvOpenSaved(true); // thấy ngay định hướng / tham số vừa được nạp
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setDraft({
      // Cấu hình của prompt mẫu đã bị xoá → giữ cấu hình đang chọn.
      ...(p.profileId && profiles.some((x) => x.id === p.profileId) ? { profileId: p.profileId } : {}),
      system: p.system,
      ...(p.prompt ? { prompt: p.prompt } : {}),
      model: p.model,
      temperature: p.temperature === null ? '' : String(p.temperature),
      maxTokens: p.maxTokens === null ? '' : String(p.maxTokens),
      format: p.format,
    });
  };

  // Lưu prompt mẫu: hàng nhập tên NGAY TRONG form — Electron chặn window.prompt (trả về null,
  // nút sẽ không làm gì), cùng lý do với hộp thoại "Thư mục mới" của BrowserTabWorkspace.
  const [naming, setNaming] = useState<{ asNew: boolean; name: string; keepPrompt: boolean } | null>(null);
  // "Nâng cao" (prompt mẫu, định hướng, tham số) — tuỳ chọn nên thu gọn; nhớ đóng / mở theo trình duyệt.
  const [advOpen, setAdvOpen] = useState(false);
  useEffect(() => { setAdvOpen(load<boolean>(ADV_KEY, false)); }, []);
  const setAdvOpenSaved = (v: boolean) => { setAdvOpen(v); save(ADV_KEY, v); };
  /** Những gì đang bật bên trong "Nâng cao" — hiện ở dòng tiêu đề để thu gọn vẫn biết. */
  const advSummary = [
    presets.find((x) => x.id === presetId) ? `prompt mẫu "${presets.find((x) => x.id === presetId)!.name}"` : '',
    draft.system.trim() ? 'định hướng' : '',
    draft.temperature !== '' ? `temperature ${draft.temperature}` : '',
    draft.maxTokens !== '' ? `max ${draft.maxTokens} token` : '',
    draft.format === 'json' ? 'JSON' : '',
  ].filter(Boolean).join(', ');

  const openNaming = (asNew: boolean) => {
    const current = presets.find((x) => x.id === presetId);
    setNaming({ asNew: asNew || !current, name: asNew || !current ? '' : current.name, keepPrompt: !!draft.prompt.trim() });
    reclaimFocus(); // ô tên autoFocus — phải nhả focus khỏi guest <webview> thì mới gõ được ngay
  };

  const savePreset = async () => {
    if (!naming) return;
    const current = presets.find((x) => x.id === presetId);
    const name = naming.name.trim();
    if (!name) return;
    const { asNew, keepPrompt } = naming;
    try {
      const list = await call<OpenAiPreset[]>('presets.save', {
        preset: {
          ...(asNew || !current ? {} : { id: current.id }),
          name,
          profileId,
          model: draft.model,
          system: draft.system,
          prompt: keepPrompt ? draft.prompt : '',
          temperature: draft.temperature === '' ? null : Number(draft.temperature),
          maxTokens: draft.maxTokens === '' ? null : Number(draft.maxTokens),
          format: draft.format,
        },
      });
      setPresets(list);
      setPresetId(list.find((p) => p.name === name)?.id ?? '');
      setNaming(null);
      setMsg({ kind: 'ok', text: `Đã lưu prompt mẫu "${name}".` });
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  };

  const removePreset = async () => {
    const p = presets.find((x) => x.id === presetId);
    if (!p || !ask(`Xoá prompt mẫu "${p.name}"?`)) return;
    try {
      setPresets(await call<OpenAiPreset[]>('presets.remove', { id: p.id }));
      setPresetId('');
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  };

  const copy = () => void navigator.clipboard?.writeText(run.text).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, () => {});

  // Markdown dựng lại chỉ khi kết quả đổi (không phải mỗi lần gõ / mỗi nhịp đồng hồ).
  const html = useMemo(() => (run.running || !run.text ? '' : renderMarkdown(run.text)), [run.text, run.running]);
  const pretty = useMemo(() => {
    if (run.format !== 'json' || run.running) return null;
    try { return JSON.stringify(JSON.parse(run.text), null, 2); } catch { return null; }
  }, [run.text, run.format, run.running]);

  if (store && !profiles.some((p) => p.hasKey)) {
    return (
      <div className="oai-empty">
        <h3>Chưa có cấu hình OpenAI nào</h3>
        <p>Thêm một cấu hình có khoá API ở tab Cấu hình (tạo khoá ở platform.openai.com → API keys). Khoá chỉ lưu trên máy này, không hiện lại trong trang.</p>
        <button className="sp-cta" onClick={onConfigure}>Mở Cấu hình</button>
      </div>
    );
  }

  return (
    <div className="epoch-cols oai-cols">
      <section className={`epoch-card oai-card oai-reqcard${dropping ? ' oai-dropping' : ''}`} {...dropProps}>
        <div className="tools-pane-head">
          ✉ Request <span className="tools-pane-hint">nội dung được gửi tới {profile?.baseUrl ?? OPENAI_DEFAULT_BASE}</span>
        </div>
        {dropping && <div className="oai-drop" aria-hidden>Thả file vào đây — doc, docx, txt, csv, pdf, xlsx</div>}
        <div className="epoch-card-body oai-form">
          <div className="oai-row">
            <label className="oai-field oai-grow">
              <span>Cấu hình</span>
              <select
                value={profileId}
                // Đổi cấu hình → về model mặc định của cấu hình đó (model cũ có thể không có ở tài khoản kia).
                onChange={(e) => setDraft({ profileId: e.target.value, model: '' })}
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.hasKey}>
                    {p.name}{p.id === store?.defaultId ? ' (mặc định)' : ''}{p.hasKey ? '' : ' — chưa có khoá'}
                  </option>
                ))}
              </select>
            </label>
            <label className="oai-field oai-grow">
              <span>Model {profile?.defaultModel && <em>(mặc định của cấu hình: {profile.defaultModel})</em>}</span>
              <ModelPicker value={model} onChange={(m) => setDraft({ model: m })} choices={choicesFor(profileId)} />
            </label>
            <button
              className="ghost sm"
              title="Lấy lại danh sách model của cấu hình này"
              onClick={() => void loadModels(profileId, true)}
              disabled={!profile?.hasKey}
            >
              ↻
            </button>
          </div>

          <label className="oai-field oai-grow-v oai-prompt-field">
            <span>Prompt</span>
            <textarea
              className="oai-autogrow oai-autogrow-prompt"
              rows={8}
              value={draft.prompt}
              maxLength={OPENAI_LIMITS.promptChars}
              placeholder={files.length ? `Yêu cầu với file đính kèm… (để trống = "${FILE_ONLY_PROMPT}")` : 'Nội dung cần xử lý… (Ctrl+Enter để gửi)'}
              onChange={(e) => setDraft({ prompt: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
            />
          </label>
          <div className="oai-files">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept={OPENAI_FILE_EXTS.join(',')}
              onChange={(e) => { void addFiles([...(e.currentTarget.files ?? [])]); e.currentTarget.value = ''; }}
            />
            <button
              className="ghost sm"
              onClick={() => fileInput.current?.click()}
              disabled={files.length >= OPENAI_LIMITS.maxFiles}
              title={`Đính file vào prompt (hoặc kéo thả) — ${OPENAI_FILE_EXTS.join(', ')}; tối đa ${OPENAI_LIMITS.maxFiles} file. Chữ trong file được đọc ra và gửi kèm prompt.`}
            >
              📎 Import file
            </button>
            {files.map((f) => (
              <span key={f.name} className="oai-chip" title={`${num(f.chars)} ký tự${f.note ? ` · ${f.note}` : ''}${f.truncated ? ' · đã cắt bớt phần cuối' : ''}`}>
                <b>{f.kind}</b> {f.name} <em>{num(f.chars)} ký tự{f.truncated ? ' (đã cắt)' : ''}</em>
                <button aria-label={`Bỏ ${f.name}`} onClick={() => setFiles(filesRef.current.filter((x) => x.name !== f.name))}>✕</button>
              </span>
            ))}
            {reading > 0 && <span className="oai-chip oai-chip-busy">Đang đọc {reading} file…</span>}
            {!files.length && !reading && <span className="oai-count">doc · docx · txt · csv · pdf · xlsx — chữ trong file được gửi kèm prompt</span>}
          </div>

          <details
            className="oai-advanced"
            open={advOpen}
            onToggle={(e) => setAdvOpenSaved((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>
              ⚙ Nâng cao{advSummary ? <em> — đang dùng: {advSummary}</em> : <em> — prompt mẫu, định hướng (system prompt), temperature, max tokens, dạng kết quả</em>}
            </summary>
            <div className="oai-form">
              <div className="oai-row">
                <label className="oai-field oai-grow">
                  <span>Prompt mẫu</span>
                  <select value={presetId} onChange={(e) => applyPreset(e.target.value)}>
                    <option value="">— Không dùng —</option>
                    {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <button className="ghost sm" onClick={() => openNaming(false)} title="Lưu cấu hình + định hướng + tham số hiện tại vào prompt mẫu đang chọn (hoặc tạo mới)">
                  💾 Lưu
                </button>
                <button className="ghost sm" onClick={() => openNaming(true)} title="Lưu thành prompt mẫu mới">＋ Mới</button>
                {presetId && <button className="ghost sm" onClick={() => void removePreset()} title="Xoá prompt mẫu đang chọn">Xoá</button>}
              </div>
              {naming && (
                <div className="oai-row oai-naming">
                  <label className="oai-field oai-grow">
                    <span>{naming.asNew ? 'Tên prompt mẫu mới' : 'Lưu đè prompt mẫu'}</span>
                    <input
                      autoFocus
                      value={naming.name}
                      maxLength={120}
                      placeholder="vd Review code Java"
                      onChange={(e) => setNaming({ ...naming, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); void savePreset(); }
                        if (e.key === 'Escape') { e.preventDefault(); setNaming(null); }
                      }}
                    />
                  </label>
                  <label className="oai-check" title="Bỏ chọn: chỉ lưu cấu hình, model, định hướng và tham số">
                    <input type="checkbox" checked={naming.keepPrompt} onChange={(e) => setNaming({ ...naming, keepPrompt: e.target.checked })} />
                    kèm nội dung Prompt
                  </label>
                  <button className="sp-cta" onClick={() => void savePreset()} disabled={!naming.name.trim()}>Lưu</button>
                  <button className="ghost sm" onClick={() => setNaming(null)}>Huỷ</button>
                </div>
              )}

              <label className="oai-field">
                <span>Định hướng <em>(system prompt — vai trò, giọng văn, định dạng kết quả mong muốn)</em></span>
                <textarea
                  className="oai-autogrow"
                  rows={3}
                  value={draft.system}
                  maxLength={OPENAI_LIMITS.systemChars}
                  placeholder="Vd: Bạn là chuyên gia review code Java. Trả lời bằng tiếng Việt, gạch đầu dòng, nêu mức độ nghiêm trọng cho mỗi vấn đề."
                  onChange={(e) => setDraft({ system: e.target.value })}
                />
              </label>
              <div className="oai-row">
                <label className="oai-field oai-num" title="0 = ổn định, 2 = sáng tạo. Để trống = mặc định của model (một số model chỉ nhận mặc định).">
                  <span>Temperature</span>
                  <input type="number" min={0} max={2} step={0.1} value={draft.temperature} placeholder="mặc định" onChange={(e) => setDraft({ temperature: e.target.value })} />
                </label>
                <label className="oai-field oai-num" title="Giới hạn độ dài kết quả (token). Để trống = không giới hạn ở phía mình.">
                  <span>Max tokens</span>
                  <input type="number" min={1} max={OPENAI_LIMITS.maxTokens} step={1} value={draft.maxTokens} placeholder="không" onChange={(e) => setDraft({ maxTokens: e.target.value })} />
                </label>
                <label className="oai-field oai-num" title="JSON: bắt model trả về một đối tượng JSON hợp lệ — định hướng hoặc prompt phải nhắc tới chữ JSON.">
                  <span>Kết quả</span>
                  <select value={draft.format} onChange={(e) => setDraft({ format: e.target.value as OpenAiFormat })}>
                    <option value="text">Chữ</option>
                    <option value="json">JSON</option>
                  </select>
                </label>
              </div>
            </div>
          </details>
          {draft.format === 'json' && !/json/i.test(draft.system + draft.prompt) && (
            <p className="oai-warn">Chế độ JSON: OpenAI yêu cầu định hướng hoặc prompt có nhắc tới chữ “JSON”, nếu không request sẽ bị từ chối.</p>
          )}

          {/* Hàng nút luôn thấy: ngay dưới nội dung khi prompt ngắn; prompt dài thì ghim ở đáy khung
              (ô prompt co lại và tự cuộn) — xem .oai-actions / .oai-reqcard trong globals.css. */}
          <div className="oai-row oai-actions">
            {run.running ? (
              <button className="sp-cta" onClick={stopRun}>■ Dừng</button>
            ) : (
              <button className="sp-cta" onClick={() => void send()} disabled={!canSend} title={!model ? 'Chọn model trước' : 'Gửi (Ctrl+Enter)'}>
                ➤ Gửi
              </button>
            )}
            <button
              className="ghost sm"
              onClick={() => void copyCurl()}
              disabled={!filled}
              title={filled
                ? 'Chép lệnh cURL tương đương request này (cùng cấu hình, model, định hướng, prompt, tham số, file) để chạy lại ở Postman / terminal mà so sánh. Gửi với "stream": false.'
                : 'Điền đủ request (cấu hình có khoá, model, prompt hoặc file) để chép cURL'}
            >
              {curlCopied ? '✓ Đã chép cURL' : '⧉ Copy cURL'}
            </button>
            <label className="oai-check" title="Bỏ chọn: khoá là biến $OPENAI_API_KEY (an toàn khi dán / chia sẻ). Chọn: chép kèm khoá thật của cấu hình.">
              <input type="checkbox" checked={curlKey} onChange={(e) => setCurlKey(e.target.checked)} /> kèm khoá thật
            </label>
            <span className="oai-count">
              {num(draft.prompt.length)} ký tự{files.length ? ` + ${files.length} file (${num(files.reduce((n, f) => n + f.chars, 0))} ký tự)` : ''}
            </span>
            {filled && (
              <span
                className="oai-tokens"
                title={est
                  ? `Ước tính token INPUT (định hướng + prompt + file + phần phụ của định dạng chat), đếm bằng tokenizer ${est.encoding} của OpenAI — chưa gửi gì.${est.exact ? '' : ' Model này không phải của OpenAI / chưa biết bảng mã → chỉ gần đúng.'} Số thật hiện ở phần Kết quả sau khi gửi.`
                  : 'Đang ước tính token input…'}
              >
                {est ? `≈ ${num(est.tokens)} token input${est.exact ? '' : ' (gần đúng)'}` : '≈ … token input'}
                {estBusy && est ? ' …' : ''}
              </span>
            )}
            {msg && <span className={`oai-msg ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'}>{msg.text}</span>}
          </div>
        </div>
      </section>

      <section className="epoch-card oai-card">
        <div className="tools-pane-head">
          ✦ Kết quả
          <span className="tools-pane-hint">
            {run.running ? 'đang trả lời…' : run.model ?? ''}
            {run.usage ? ` · input ${num(run.usage.promptTokens)}${run.usage.cachedTokens ? ` (cache ${num(run.usage.cachedTokens)})` : ''} · output ${num(run.usage.completionTokens)}${run.usage.reasoningTokens ? ` (suy luận ${num(run.usage.reasoningTokens)})` : ''} token` : ''}
          </span>
          <Elapsed run={run} />
          {run.text && !run.running && (
            <span className="oai-head-actions">
              <button className="ghost sm" onClick={() => setRaw((v) => !v)}>{raw ? 'Xem đẹp' : 'Xem thô'}</button>
              <button className="ghost sm" onClick={copy}>{copied ? '✓ Đã chép' : 'Sao chép'}</button>
            </span>
          )}
        </div>
        <div className="epoch-card-body oai-result">
          {run.error && <div className="oai-error" role="alert">{run.error}</div>}
          {run.finishReason === 'length' && !run.running && (
            <p className="oai-warn">Kết quả bị cắt vì chạm giới hạn Max tokens — tăng Max tokens rồi gửi lại.</p>
          )}
          {!run.text && !run.running && !run.error && <p className="oai-muted">Kết quả sẽ hiện ở đây.</p>}
          {!run.text && run.running && <p className="oai-muted">Đang chờ trả lời…</p>}
          {run.text && (raw || run.running ? (
            <pre className="oai-pre">{run.text}</pre>
          ) : pretty !== null ? (
            <pre className="oai-pre">{pretty}</pre>
          ) : (
            <div className="md-preview oai-md" dangerouslySetInnerHTML={{ __html: html }} />
          ))}
        </div>
        {history.length > 0 && (
          <details className="oai-history">
            <summary>Lịch sử — {history.length} request gần nhất (tối đa {OPENAI_LIMITS.maxHistory}, lưu trong trình duyệt này)</summary>
            <ul>
              {history.map((h, i) => (
                <li key={`${h.at}-${i}`}>
                  <button
                    className="oai-history-item"
                    title="Mở lại request và kết quả này ở tab mới"
                    onClick={() => onOpenTab(
                      {
                        ...EMPTY_DRAFT,
                        name: h.name ?? '', profileId: h.profileId ?? '', model: h.model, system: h.system, prompt: h.prompt, format: h.format,
                        temperature: h.temperature ?? '', maxTokens: h.maxTokens ?? '',
                      },
                      { ...IDLE, text: h.text, model: h.model, usage: h.usage, format: h.format },
                    )}
                  >
                    <span className="oai-history-when">
                      {new Date(h.at).toLocaleString('vi-VN')} · {h.profile ? `${h.profile} · ` : ''}{h.model}
                      {h.elapsedMs !== undefined ? ` · ⏱ ${fmtSeconds(h.elapsedMs)}` : ''}
                    </span>
                    <span className="oai-history-prompt">
                      {h.name ? <b>{h.name} · </b> : null}
                      {h.files?.length ? `📎 ${h.files.join(', ')} · ` : ''}{h.prompt.slice(0, 140)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <button className="ghost sm" onClick={onClearHistory}>Xoá lịch sử</button>
          </details>
        )}
      </section>
    </div>
  );
});

/**
 * Thời gian xử lý — từ lúc bấm Gửi tới lúc có kết quả đầy đủ, đo ở trang. Đang chạy: đồng hồ chạy
 * (cập nhật 10 lần / giây); xong: tổng + lúc chữ đầu tiên về (phân biệt model chậm BẮT ĐẦU với model
 * trả lời DÀI). Tách component riêng để nhịp đồng hồ chỉ vẽ lại đúng chỗ này.
 */
function Elapsed({ run }: { run: Run }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!run.running) return;
    const t = window.setInterval(() => tick((n) => n + 1), 100);
    return () => window.clearInterval(t);
  }, [run.running]);
  if (run.submittedAt === null) return null;
  const end = run.endedAt ?? performance.now();
  const total = end - run.submittedAt;
  const first = run.firstAt !== null ? run.firstAt - run.submittedAt : null;
  const what = run.running ? '' : run.error ? (run.error === 'Đã dừng.' ? ' · đã dừng' : ' · lỗi') : '';
  return (
    <span
      className={`oai-elapsed${run.running ? ' running' : ''}`}
      title={'Tính từ lúc bấm Gửi tới lúc có kết quả đầy đủ (gồm mạng + chờ server).'
        + (first !== null ? `
Chữ đầu tiên về sau ${fmtSeconds(first)}.` : '')
        + (run.durationMs ? `
Server gọi OpenAI mất ${fmtSeconds(run.durationMs)}.` : '')}
    >
      ⏱ {fmtSeconds(total)}{run.running ? '…' : ''}
      {first !== null && !run.running && <em> · chữ đầu sau {fmtSeconds(first)}</em>}
      {what}
    </span>
  );
}

// ── Cấu hình ─────────────────────────────────────────────────────────────────

function ConfigPane({ store, choicesFor, onSaved, onModels }: {
  store: OpenAiProfiles | null;
  choicesFor: (profileId: string) => ModelChoices;
  /** `touched`: id cấu hình vừa đổi (để lấy lại model của nó). */
  onSaved: (s: OpenAiProfiles, touched?: string) => void;
  onModels: (profileId: string, list: string[]) => void;
}) {
  const profiles = store?.profiles ?? [];
  const [selected, setSelected] = useState<string>('');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(OPENAI_DEFAULT_BASE);
  const [organization, setOrganization] = useState('');
  const [project, setProject] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [testModels, setTestModels] = useState<string[] | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | 'other' | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const isNew = selected === NEW_PROFILE;
  const current = profiles.find((p) => p.id === selected);

  // Chưa chọn gì: cấu hình mặc định; chưa có cấu hình nào: mở sẵn form thêm mới.
  useEffect(() => {
    if (!store) return;
    if (selected === NEW_PROFILE || store.profiles.some((p) => p.id === selected)) return;
    setSelected(store.defaultId || store.profiles[0]?.id || NEW_PROFILE);
  }, [store, selected]);

  // Nạp form theo cấu hình đang chọn. Mục Nâng cao mở sẵn khi cấu hình có giá trị khác mặc định.
  useEffect(() => {
    const p = profiles.find((x) => x.id === selected);
    setApiKey('');
    setTestModels(null);
    setMsg(null);
    setName(p?.name ?? (profiles.length ? '' : 'Mặc định'));
    setBaseUrl(p?.baseUrl ?? OPENAI_DEFAULT_BASE);
    setOrganization(p?.organization ?? '');
    setProject(p?.project ?? '');
    setDefaultModel(p?.defaultModel ?? '');
    setAdvancedOpen(!!p && (!!p.organization || !!p.project || p.baseUrl !== OPENAI_DEFAULT_BASE));
    // Chỉ khi đổi cấu hình đang chọn (không nạp lại mỗi lần store đổi — sẽ xoá chữ đang gõ).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const draft = () => ({ ...(isNew ? {} : { id: selected }), name, apiKey, baseUrl, organization, project, defaultModel });
  const base = choicesFor(isNew ? '' : selected);
  const picker = useMemo<ModelChoices>(() => ({ ...base, live: testModels ?? base.live }), [base, testModels]);

  const run = async (kind: 'save' | 'test' | 'other', fn: () => Promise<void>) => {
    setBusy(kind); setMsg(null);
    try { await fn(); } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); } finally { setBusy(null); }
  };

  const test = () => run('test', async () => {
    const list = await call<string[]>('models', { profile: draft() });
    setTestModels(list);
    if (!isNew && !apiKey) onModels(selected, list);
    setMsg({ kind: 'ok', text: `Kết nối được — ${list.length} model dùng được cho chat.` });
  });

  const saveProfile = () => run('save', async () => {
    const s = await call<OpenAiProfiles>('profiles.save', { profile: draft() });
    const id = isNew ? s.profiles.find((p) => p.name.toLowerCase() === name.trim().toLowerCase())?.id ?? '' : selected;
    onSaved(s, id);
    setApiKey('');
    if (isNew && id) setSelected(id);
    setMsg({ kind: 'ok', text: isNew ? `Đã thêm cấu hình "${name.trim()}".` : 'Đã lưu cấu hình.' });
  });

  const clearKey = () => {
    if (!current || !ask(`Xoá khoá API của cấu hình "${current.name}"?`)) return;
    void run('other', async () => {
      onSaved(await call<OpenAiProfiles>('profiles.save', { profile: { id: current.id, clearKey: true } }), current.id);
      setMsg({ kind: 'ok', text: 'Đã xoá khoá API.' });
    });
  };

  const remove = () => {
    if (!current || !ask(`Xoá cấu hình "${current.name}"? Khoá API của nó cũng bị xoá khỏi máy.`)) return;
    void run('other', async () => {
      const s = await call<OpenAiProfiles>('profiles.remove', { id: current.id });
      onSaved(s, current.id);
      setSelected(s.defaultId || s.profiles[0]?.id || NEW_PROFILE);
    });
  };

  const makeDefault = () => {
    if (!current) return;
    void run('other', async () => {
      onSaved(await call<OpenAiProfiles>('profiles.setDefault', { id: current.id }));
      setMsg({ kind: 'ok', text: `"${current.name}" là cấu hình mặc định khi gửi request.` });
    });
  };

  return (
    <div className="oai-config-wrap">
      <nav className="oai-profiles" aria-label="Các cấu hình đã lưu">
        {profiles.map((p) => (
          <button key={p.id} className={p.id === selected ? 'on' : ''} onClick={() => setSelected(p.id)}>
            <span className="oai-profile-name">
              {p.name}{p.id === store?.defaultId && <span className="oai-badge">mặc định</span>}
            </span>
            <span className="oai-profile-sub">{p.hasKey ? p.keyHint : 'chưa có khoá'}{p.defaultModel ? ` · ${p.defaultModel}` : ''}</span>
          </button>
        ))}
        <button className={`oai-profile-add${isNew ? ' on' : ''}`} onClick={() => setSelected(NEW_PROFILE)}>＋ Thêm cấu hình</button>
      </nav>

      <section className="epoch-card oai-card oai-config">
        <div className="tools-pane-head">
          {isNew ? '＋ Cấu hình mới' : `⚙ ${current?.name ?? ''}`}
          <span className="tools-pane-hint">lưu ở configs/openai.json trên máy này — không lên git</span>
        </div>
        <div className="epoch-card-body oai-form">
          <label className="oai-field">
            <span>Tên cấu hình <em>(vd Công ty, Cá nhân, OpenRouter)</em></span>
            <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="oai-field">
            <span>Khoá API {current?.hasKey && <em>(đang dùng {current.keyHint} — để trống để giữ nguyên)</em>}</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              placeholder={current?.hasKey ? '•••••••• (giữ khoá hiện tại)' : 'sk-…'}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>
          <label className="oai-field">
            <span>
              Model mặc định{' '}
              {picker.live.length === 0 && <em>(bấm Thử kết nối để lấy danh sách model của tài khoản)</em>}
            </span>
            <ModelPicker value={defaultModel} onChange={setDefaultModel} choices={picker} allowEmpty emptyLabel="— Không đặt (chọn khi gửi) —" />
          </label>
          <details
            className="oai-advanced"
            open={advancedOpen}
            onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>
              Nâng cao <em>— Base URL, Organization, Project (tuỳ chọn; để trống nếu dùng OpenAI với một tổ chức)</em>
            </summary>
            <div className="oai-form">
              <label className="oai-field">
                <span>Base URL <em>(đổi khi dùng dịch vụ tương thích OpenAI: proxy Azure, OpenRouter, LM Studio, Ollama…)</em></span>
                <input value={baseUrl} spellCheck={false} placeholder={OPENAI_DEFAULT_BASE} onChange={(e) => setBaseUrl(e.target.value)} />
              </label>
              <div className="oai-row">
                <label className="oai-field oai-grow">
                  <span>Organization <em>(khi khoá thuộc nhiều tổ chức)</em></span>
                  <input value={organization} spellCheck={false} placeholder="org-…" onChange={(e) => setOrganization(e.target.value)} />
                </label>
                <label className="oai-field oai-grow">
                  <span>Project <em>(tính chi phí vào project riêng)</em></span>
                  <input value={project} spellCheck={false} placeholder="proj_…" onChange={(e) => setProject(e.target.value)} />
                </label>
              </div>
            </div>
          </details>
          <div className="oai-row">
            <button className="sp-cta" onClick={() => void saveProfile()} disabled={busy !== null || !name.trim()}>
              {busy === 'save' ? 'Đang lưu…' : isNew ? 'Thêm cấu hình' : 'Lưu'}
            </button>
            <button className="ghost sm" onClick={() => void test()} disabled={busy !== null || (!apiKey && !current?.hasKey)}>
              {busy === 'test' ? 'Đang thử…' : 'Thử kết nối'}
            </button>
            {current && current.id !== store?.defaultId && (
              <button className="ghost sm" onClick={makeDefault} disabled={busy !== null}>Đặt làm mặc định</button>
            )}
            {current?.hasKey && <button className="ghost sm" onClick={clearKey} disabled={busy !== null}>Xoá khoá</button>}
            {current && <button className="ghost sm" onClick={remove} disabled={busy !== null}>Xoá cấu hình</button>}
            {msg && <span className={`oai-msg ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'}>{msg.text}</span>}
          </div>
          <p className="oai-muted">
            Khoá chỉ nằm ở server của Dev Box trên máy này; trang không bao giờ nhận lại khoá. Mọi prompt gửi đi đều tới
            base URL của cấu hình được chọn — đừng đưa mật khẩu, token hay dữ liệu khách hàng vào prompt nếu chưa được phép.
          </p>
        </div>
      </section>
    </div>
  );
}
