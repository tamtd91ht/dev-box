'use client';

// API workspace — Postman-like: dựng/chạy/quản lý HTTP request. Chạy qua proxy
// server (/api/http) nên né CORS. Dán nguyên một lệnh curl để import (lib/
// curlParse). Biến {{var}} lấy từ environment đang chọn (lib/curlParse ->
// resolveVars). Collection + environment lưu per-machine (/api/api-collections).
//
// Bố cục: rail trái = request đã lưu (gom theo folder) + environment picker;
// giữa = thanh tab request đang mở + builder (method/url + Params/Headers/Body)
// và response.
//
// NHIỀU REQUEST MỞ CÙNG LÚC (như Postman): mỗi tab là một Session độc lập —
// draft riêng, response riêng, đang-gửi riêng. Mở request từ rail không đè lên
// thứ đang dở nữa. Danh sách tab (chỉ phần draft, không kèm response) nhớ qua
// localStorage nên đóng app mở lại vẫn còn nguyên bàn làm việc.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  apiGet, apiSaveRequest, apiRemoveRequest, apiSaveEnv, apiRemoveEnv, apiSetActiveEnv, apiSend,
  type ApiData, type ApiRequest, type ApiHeader, type ApiEnvironment, type HttpResult,
} from '@/lib/api';
import { parseCurl, resolveVars, looksLikeCurl, buildCurl } from '@/lib/curlParse';
import { formatText, type FormatKind } from '@/lib/format';
import {
  backspace as jsonBackspace, closeBracket as jsonCloseBracket, enter as jsonEnter,
  looksLikeJson, openBrace, openBracket, quote as jsonQuote, remapCaret, type EditResult,
} from '@/lib/jsonEdit';
import { fmtRel } from '@/lib/google';
import { useSplit } from '@/lib/useSplit';
import Splitter from './Splitter';
import { useRailCollapse, CollapsedRail, RailHideButton } from './RailCollapse';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
/** Draft rỗng — hàm chứ không phải hằng dùng chung: mỗi tab phải có mảng
 *  headers của riêng nó, không thì hai tab sửa chung một chỗ. */
const blankDraft = (): Draft => ({
  name: '', method: 'GET', url: '', headers: [{ key: '', value: '' }], body: '', bodyType: 'none',
});

interface Draft {
  id?: string;
  name: string;
  folder?: string;
  method: string;
  url: string;
  headers: ApiHeader[];
  body: string;
  bodyType: 'none' | 'raw' | 'form';
}

/** Một tab request đang mở — mọi thứ thuộc về nó nằm gọn ở đây. */
interface Session {
  key: string;
  draft: Draft;
  tab: 'params' | 'headers' | 'body';
  res: HttpResult | null;
  err: string | null;
  sending: boolean;
  resTab: 'body' | 'headers';
  resPretty: boolean;
}

const TABS_KEY = 'devbox.api.tabs';
let seq = 0;
const newKey = (): string => `t${Date.now().toString(36)}${(seq += 1).toString(36)}`;

function blankSession(draft: Draft = blankDraft()): Session {
  return {
    key: newKey(), draft, tab: draft.bodyType === 'none' ? 'headers' : 'body',
    res: null, err: null, sending: false, resTab: 'body', resPretty: true,
  };
}

function methodClass(m: string): string {
  return `api-m api-m--${m.toLowerCase()}`;
}

/** Tab còn trắng tinh? (chưa gõ gì, chưa gửi gì) — để tái dùng thay vì đẻ thêm. */
function isPristine(s: Session): boolean {
  const d = s.draft;
  return !d.id && !d.url.trim() && !d.body.trim() && !d.name.trim() && !s.res
    && d.headers.every((h) => !h.key.trim() && !h.value.trim());
}

/** Nhãn hiển thị trên tab: tên đã lưu, hoặc method + path cho dễ nhận ra. */
function tabLabel(d: Draft): string {
  if (d.name.trim()) return d.name;
  try { return new URL(d.url).pathname || new URL(d.url).hostname; } catch { /* URL còn dở */ }
  return d.url.trim() ? d.url.replace(/^https?:\/\//, '').slice(0, 28) : 'Request mới';
}

export default function ApiWorkspace() {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const railSplit = useSplit({ varName: '--api-rail', min: 160, max: 480, gap: 12 });
  const [data, setData] = useState<ApiData>({ requests: [], environments: [] });
  const [sessions, setSessions] = useState<Session[]>(() => [blankSession()]);
  const [activeKey, setActiveKey] = useState<string>(() => '');
  const [importOpen, setImportOpen] = useState(false);
  const [curlText, setCurlText] = useState('');
  const [envEdit, setEnvEdit] = useState<ApiEnvironment | null>(null);
  const [autoFmt, setAutoFmt] = useState(true);
  // Thu gọn cột collection để nhường chỗ cho builder + response. Rail còn rỗng
  // trơn (chưa request, chưa environment) thì buộc hiện — mấy nút ＋ ở trong đó.
  const rail = useRailCollapse('api', '--api-rail',
    data.requests.length === 0 && data.environments.length === 0);

  // Tab đang xem. Fallback về tab đầu để không bao giờ có màn hình trống khi
  // key lạc (khôi phục từ localStorage, tab vừa bị đóng…).
  const cur = sessions.find((s) => s.key === activeKey) ?? sessions[0];

  /** Sửa MỘT tab theo key — dùng cho việc chạy nền (send) vì lúc trả kết quả
   *  người dùng có thể đã chuyển sang tab khác. */
  const patch = useCallback((key: string, up: Partial<Session> | ((s: Session) => Partial<Session>)) => {
    setSessions((ss) => ss.map((s) => (s.key === key ? { ...s, ...(typeof up === 'function' ? up(s) : up) } : s)));
  }, []);
  /**
   * Sửa tab ĐANG xem — chỗ mọi thao tác tay đi qua.
   *
   * Đọc key qua ref để hàm này (và cả họ setDraft/setErr/… dựng trên nó) có
   * danh tính CỐ ĐỊNH: nếu nó đổi mỗi lần sang tab khác thì `reload` cũng đổi
   * theo, và effect gắn với reload sẽ nã lại collection sau mỗi cú bấm tab.
   */
  const activeRef = useRef('');
  activeRef.current = cur?.key ?? '';
  const setCur = useCallback((up: Partial<Session> | ((s: Session) => Partial<Session>)) => {
    setSessions((ss) => {
      const key = ss.some((s) => s.key === activeRef.current) ? activeRef.current : ss[0]?.key;
      return ss.map((s) => (s.key === key ? { ...s, ...(typeof up === 'function' ? up(s) : up) } : s));
    });
  }, []);

  // Bí danh giữ nguyên tên cũ: phần còn lại của component viết như thời một
  // request, chỉ khác là mọi setter giờ rơi vào tab đang xem.
  const { draft, tab, res, err, sending, resTab, resPretty } = cur;
  const setDraft = useCallback((up: Draft | ((d: Draft) => Draft)) =>
    setCur((s) => ({ draft: typeof up === 'function' ? up(s.draft) : up })), [setCur]);
  const setTab = useCallback((v: Session['tab']) => setCur({ tab: v }), [setCur]);
  const setRes = useCallback((v: HttpResult | null) => setCur({ res: v }), [setCur]);
  const setErr = useCallback((v: string | null) => setCur({ err: v }), [setCur]);
  const setResTab = useCallback((v: Session['resTab']) => setCur({ resTab: v }), [setCur]);
  const setResPretty = useCallback((up: boolean | ((p: boolean) => boolean)) =>
    setCur((s) => ({ resPretty: typeof up === 'function' ? up(s.resPretty) : up })), [setCur]);

  // ── Mở / đóng tab ──────────────────────────────────────────────────────────
  const openSession = useCallback((draftNew: Draft) => {
    const s = blankSession(draftNew);
    setSessions((ss) => [...ss, s]);
    setActiveKey(s.key);
    return s.key;
  }, []);

  const closeSession = useCallback((key: string) => {
    const i = sessions.findIndex((s) => s.key === key);
    if (i < 0) return;
    const left = sessions.filter((s) => s.key !== key);
    // Đóng tab cuối cùng = dọn bàn, không phải để trống màn hình.
    const next = left.length ? left : [blankSession()];
    setSessions(next);
    // Đóng tab đang xem → nhảy sang tab kế bên (Postman/Chrome đều vậy).
    if (cur?.key === key) setActiveKey(next[Math.min(i, next.length - 1)].key);
  }, [sessions, cur]);

  const reload = useCallback(async () => {
    try { setData(await apiGet()); } catch (e) { setErr((e as Error).message); }
  }, [setErr]);
  useEffect(() => { void reload(); }, [reload]);

  // ── Nhớ bàn làm việc qua localStorage ──────────────────────────────────────
  //
  // Chỉ cất phần DRAFT: response có thể vài MB, mà mở lại app thì nó cũng cũ
  // rồi. Nạp trong effect (không phải initialState) để server-render và client
  // khớp nhau — Next sẽ chửi hydration mismatch nếu đọc localStorage lúc render.
  // Cờ hydrated là STATE chứ không phải ref, và effect ghi phải chờ nó: nếu
  // đánh dấu bằng ref thì ngay trong cùng lượt commit, effect ghi chạy sau
  // effect nạp nhưng vẫn còn nắm sessions CŨ (bàn trắng) — nó sẽ đè trắng lên
  // đúng thứ vừa khôi phục.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(TABS_KEY);
      const saved = raw ? (JSON.parse(raw) as { drafts?: Draft[]; active?: number }) : null;
      if (saved?.drafts?.length) {
        const ss = saved.drafts.map((d) => blankSession({ ...blankDraft(), ...d }));
        setSessions(ss);
        setActiveKey(ss[Math.min(saved.active ?? 0, ss.length - 1)].key);
      }
    } catch { /* localStorage hỏng/đầy — mở bàn trắng, không phải lỗi đáng kêu */ }
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    try {
      const drafts = sessions.map((s) => s.draft);
      const active = Math.max(0, sessions.findIndex((s) => s.key === cur?.key));
      localStorage.setItem(TABS_KEY, JSON.stringify({ drafts, active }));
    } catch { /* đầy thì thôi */ }
  }, [hydrated, sessions, cur]);

  const activeEnv = data.environments.find((e) => e.id === data.activeEnvId);
  const envMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const v of activeEnv?.vars ?? []) if (v.key.trim()) m[v.key.trim()] = v.value;
    return m;
  }, [activeEnv]);

  // ── Gửi request ────────────────────────────────────────────────────────────
  //
  // Kết quả trả về ĐÚNG tab đã bấm Send (patch theo key, không phải setCur):
  // gửi ở tab A rồi nhảy sang tab B đọc tạm cái khác là chuyện thường, response
  // không được phép rơi nhầm chỗ.
  const send = async () => {
    const key = cur.key;
    const d = cur.draft;
    const url = resolveVars(d.url, envMap).trim();
    if (!url) { patch(key, { err: 'Nhập URL trước.' }); return; }
    patch(key, { sending: true, err: null, res: null });
    try {
      const headers = d.headers
        .filter((h) => h.key.trim() && h.on !== false)
        .map((h) => ({ key: resolveVars(h.key, envMap), value: resolveVars(h.value, envMap) }));
      const r = await apiSend({
        method: d.method, url, headers,
        body: d.bodyType === 'none' ? undefined : resolveVars(d.body, envMap),
      });
      patch(key, { res: r, resTab: 'body', resPretty: true });
    } catch (e) {
      patch(key, { err: (e as Error).message });
    } finally {
      patch(key, { sending: false });
    }
  };

  // ── Import curl ──────────────────────────────────────────────────────────────

  /** curl → Draft. Trả null và báo lỗi lên tab hiện tại nếu không đọc được. */
  const curlToDraft = useCallback((raw: string): Draft | null => {
    try {
      const p = parseCurl(raw);
      if (!p.url) { setErr('Không tìm thấy URL trong lệnh curl.'); return null; }
      return {
        name: '', method: p.method, url: p.url,
        headers: p.headers.length ? p.headers.map((h) => ({ ...h, on: true })) : [{ key: '', value: '' }],
        body: p.body, bodyType: p.bodyType,
      };
    } catch (e) {
      setErr('Không phân tích được curl: ' + (e as Error).message);
      return null;
    }
  }, [setErr]);

  /** Đổ curl vào TAB ĐANG XEM (dán thẳng vào ô URL = ý muốn sửa tại chỗ). */
  const applyCurl = useCallback((raw: string): boolean => {
    const d = curlToDraft(raw);
    if (!d) return false;
    setCur({ draft: d, tab: d.bodyType === 'none' ? 'headers' : 'body', err: null, res: null });
    return true;
  }, [curlToDraft, setCur]);

  /** Modal "Dán curl" = mang một request MỚI vào bàn → tab mới, trừ khi tab
   *  đang xem còn trắng tinh thì dùng luôn cho đỡ thừa. */
  const doImport = () => {
    const d = curlToDraft(curlText);
    if (!d) return;
    if (isPristine(cur)) setCur({ draft: d, tab: d.bodyType === 'none' ? 'headers' : 'body', err: null, res: null });
    else openSession(d);
    setImportOpen(false); setCurlText('');
  };

  /**
   * Dán vào ô URL: là curl thì tách luôn thành request (kiểu Postman), còn lại
   * để trình duyệt dán bình thường.
   *
   * Đọc từ clipboard của SỰ KIỆN chứ không phải navigator.clipboard — không cần
   * quyền, và lấy đúng thứ vừa dán chứ không phải thứ đang có trong clipboard.
   */
  const onUrlPaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!looksLikeCurl(text)) return; // URL thường — dán như thường
    e.preventDefault();
    // Không cần báo "đã nhận diện": method/URL/headers/body điền đầy trước mắt
    // là bằng chứng rõ hơn mọi dòng thông báo.
    applyCurl(text);
  }, [applyCurl]);

  // ── Copy as curl ─────────────────────────────────────────────────────────────
  const [curlCopied, setCurlCopied] = useState(false);

  /**
   * Chép request đang điền thành lệnh curl.
   *
   * Biến {{var}} được THAY bằng giá trị environment đang chọn — lệnh này để đưa
   * cho người khác chạy, mà máy họ không có environment của mình. Đổi lại là
   * token thật nằm trong clipboard: có cảnh báo ở tooltip.
   */
  const copyCurl = useCallback(async () => {
    const cmd = buildCurl({
      method: draft.method,
      url: resolveVars(draft.url, envMap),
      headers: draft.headers.map((h) => ({
        key: resolveVars(h.key, envMap), value: resolveVars(h.value, envMap), on: h.on,
      })),
      body: resolveVars(draft.body, envMap),
      bodyType: draft.bodyType,
    });
    try {
      await navigator.clipboard.writeText(cmd);
      setCurlCopied(true);
      setTimeout(() => setCurlCopied(false), 1500);
    } catch {
      setErr('Không chép được vào clipboard.');
    }
  }, [draft, envMap]);

  // ── Collection ───────────────────────────────────────────────────────────────
  /**
   * Bấm một request ở rail: đang mở sẵn thì nhảy tới tab đó (không mở trùng,
   * không mất response đang xem); chưa mở thì thêm tab mới — tab trắng tinh
   * đang xem thì dùng lại chỗ đó.
   */
  const openRequest = (r: ApiRequest) => {
    const already = sessions.find((s) => s.draft.id === r.id);
    if (already) { setActiveKey(already.key); return; }
    const d: Draft = {
      id: r.id, name: r.name, folder: r.folder, method: r.method, url: r.url,
      headers: r.headers.length ? r.headers : [{ key: '', value: '' }],
      body: r.body, bodyType: r.bodyType,
    };
    if (isPristine(cur)) setCur({ draft: d, tab: d.bodyType === 'none' ? 'headers' : 'body', res: null, err: null });
    else openSession(d);
  };

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveFolder, setSaveFolder] = useState('');

  /** Lưu nhanh nếu request đã có id (đè); chưa có thì mở modal đặt tên/folder. */
  const saveRequest = async () => {
    if (draft.id) { await persistRequest(draft.name || defaultName(draft), draft.folder ?? ''); return; }
    setSaveName(defaultName(draft)); setSaveFolder(''); setSaveOpen(true);
  };

  const persistRequest = async (name: string, folder: string) => {
    const finalName = name.trim() || defaultName(draft);
    try {
      const before = new Set(data.requests.map((r) => r.id));
      const d = await apiSaveRequest({ ...draft, name: finalName, folder: folder.trim() || undefined });
      setData(d); setSaveOpen(false);
      if (!draft.id) {
        const fresh = d.requests.find((x) => !before.has(x.id));
        if (fresh) setDraft((d0) => ({ ...d0, id: fresh.id, name: fresh.name, folder: fresh.folder }));
      }
    } catch (e) { setErr((e as Error).message); }
  };

  /** Xóa khỏi collection: tab nào đang mở request đó thì GIỮ NGUYÊN nội dung,
   *  chỉ bỏ id — thứ đang gõ dở không việc gì phải biến mất theo, 💾 sẽ hỏi
   *  tên lại như một request mới. */
  const removeRequest = async (r: ApiRequest) => {
    if (!window.confirm(`Xóa request "${r.name}"?`)) return;
    try {
      const d = await apiRemoveRequest(r.id);
      setData(d);
      setSessions((ss) => ss.map((s) => (s.draft.id === r.id
        ? { ...s, draft: { ...s.draft, id: undefined } } : s)));
    } catch (e) { setErr((e as Error).message); }
  };

  // ── Environment ────────────────────────────────────────────────────────────
  const newEnv = () => setEnvEdit({ id: '', name: '', vars: [{ key: '', value: '' }] });
  const saveEnv = async () => {
    if (!envEdit) return;
    try {
      const d = await apiSaveEnv({
        id: envEdit.id || undefined, name: envEdit.name,
        vars: envEdit.vars.filter((v) => v.key.trim()),
      });
      setData(d); setEnvEdit(null);
    } catch (e) { setErr((e as Error).message); }
  };
  const removeEnv = async (e: ApiEnvironment) => {
    if (!window.confirm(`Xóa environment "${e.name}"?`)) return;
    try { setData(await apiRemoveEnv(e.id)); } catch (er) { setErr((er as Error).message); }
  };
  const pickEnv = async (id: string | null) => { try { setData(await apiSetActiveEnv(id)); } catch (e) { setErr((e as Error).message); } };

  // Gom request theo folder cho rail.
  const grouped = useMemo(() => {
    const g: Record<string, ApiRequest[]> = {};
    for (const r of data.requests) (g[r.folder || ''] ||= []).push(r);
    return Object.entries(g).sort((a, b) => (a[0] || '~').localeCompare(b[0] || '~'));
  }, [data.requests]);

  const setHeader = (i: number, patch: Partial<ApiHeader>) =>
    setDraft((d) => ({ ...d, headers: d.headers.map((h, j) => (j === i ? { ...h, ...patch } : h)) }));
  const addHeaderRow = () => setDraft((d) => ({ ...d, headers: [...d.headers, { key: '', value: '' }] }));
  const rmHeader = (i: number) => setDraft((d) => ({ ...d, headers: d.headers.filter((_, j) => j !== i) }));

  // ── Ô body raw: gõ JSON có trợ lý + tự format ──────────────────────────────
  //
  // textarea là controlled component nên sau mỗi lần tự chèn phải TỰ đặt lại
  // con trỏ: React vẽ lại xong là selection nhảy về cuối. caretRef giữ chỗ cần
  // đặt, useLayoutEffect đặt trước khi trình duyệt vẽ khung hình (dùng
  // useEffect thì thấy con trỏ giật một nhịp).
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const caretRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && caretRef.current !== null) {
      el.setSelectionRange(caretRef.current, caretRef.current);
      caretRef.current = null;
    }
  });

  const applyEdit = useCallback((r: EditResult) => {
    caretRef.current = r.caret;
    setDraft((d) => ({ ...d, body: r.text }));
  }, [setDraft]);

  /** Format body về JSON 2-space, giữ con trỏ ở đúng chỗ đang gõ. */
  const formatBody = useCallback(() => {
    setDraft((d) => {
      const f = formatText('json', d.body);
      if (!f.ok || f.text === d.body) return d;
      const el = bodyRef.current;
      caretRef.current = el ? remapCaret(d.body, el.selectionStart, f.text) : f.text.length;
      return { ...d, body: f.text };
    });
  }, [setDraft]);

  // Tự format khi ngơi tay ~700ms và body đang là JSON hợp lệ. Lúc còn dở dang
  // (gõ nửa chừng cái key) thì JSON.parse fail nên không ai đụng vào text cả.
  useEffect(() => {
    if (!autoFmt || draft.bodyType !== 'raw' || !looksLikeJson(draft.body)) return;
    const t = setTimeout(formatBody, 700);
    return () => clearTimeout(t);
  }, [autoFmt, draft.body, draft.bodyType, formatBody]);

  /** Phím trong ô body: đóng cặp ngoặc, khung object, field mới, Ctrl+Shift+F. */
  const onBodyKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (draft.bodyType !== 'raw') return;
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault(); formatBody(); return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.nativeEvent.isComposing) return; // đang gõ tiếng Việt — đừng chen ngang
    const el = e.currentTarget;
    const [v, from, to] = [el.value, el.selectionStart, el.selectionEnd];
    const r =
      e.key === '{' ? openBrace(v, from, to)
        : e.key === '[' ? openBracket(v, from, to)
          : e.key === '"' ? jsonQuote(v, from, to)
            : e.key === '}' || e.key === ']' ? jsonCloseBracket(v, from, to, e.key)
              : e.key === 'Enter' ? jsonEnter(v, from, to)
                : e.key === 'Backspace' ? jsonBackspace(v, from, to)
                  : null;
    if (!r) return;
    e.preventDefault();
    applyEdit(r);
  };

  // Báo JSON hỏng ngay dưới ô — biết sai trước khi bấm Send.
  const bodyErr = useMemo(() => {
    if (draft.bodyType !== 'raw' || !looksLikeJson(draft.body)) return null;
    const f = formatText('json', draft.body);
    return f.ok ? null : f.error ?? 'JSON không hợp lệ';
  }, [draft.body, draft.bodyType]);

  // ── Response: format để đọc, KHÔNG đụng vào text gốc ───────────────────────
  //
  // Đây là chỗ khác bản cũ: trước kia nút ✨ ghi đè res.body nên bấm rồi là mất
  // nguyên văn (mà nguyên văn mới là thứ để đối chiếu khi nghi server trả lạ).
  // Giờ nó chỉ là công tắc Pretty/Raw.
  const resKind = useMemo<FormatKind | null>(() => {
    if (!res) return null;
    const ct = res.headers['content-type'] ?? '';
    if (/json/i.test(ct)) return 'json';
    if (/html/i.test(ct)) return 'html';
    if (/xml/i.test(ct)) return 'xml';
    return looksLikeJson(res.body) ? 'json' : null; // server trả text/plain mà ruột là JSON
  }, [res]);

  const resShown = useMemo(() => {
    if (!res) return '';
    if (!resPretty || !resKind) return res.body;
    const f = formatText(resKind, res.body);
    return f.ok ? f.text : res.body;
  }, [res, resKind, resPretty]);

  return (
    <div className="panel sheet-panel">
      <div className="api-root" ref={railSplit.ref} style={{ ...railSplit.style, ...rail.style }}>
        {/* ── Rail: collection + environment (thu gọn được) ── */}
        {rail.collapsed ? (
          <CollapsedRail label="Collection" count={data.requests.length} onShow={rail.show} />
        ) : (
        <aside className="g-rail api-rail">
          <div className="group-title" style={{ margin: '0 4px 6px', display: 'flex', gap: 6 }}>
            <span style={{ flex: 1 }}>Collection</span>
            <button className="ghost sm" onClick={() => openSession(blankDraft())} title="Request mới (tab mới)">＋</button>
            <button className="ghost sm" onClick={() => void reload()} title="Tải lại">↻</button>
            <RailHideButton onHide={rail.hide} className="ghost sm"
              title="Thu gọn cột collection — nhường chỗ cho request đang dựng" />
          </div>
          {grouped.map(([folder, reqs]) => (
            <div key={folder || '_'}>
              {folder && <div className="api-folder">📁 {folder}</div>}
              {reqs.map((r) => (
                <div key={r.id} className={`g-root${draft.id === r.id ? ' on' : ''}`}>
                  <button className="g-root-btn" onClick={() => openRequest(r)}
                    title={sessions.some((s) => s.draft.id === r.id) ? `${r.url}\n(đang mở — bấm để nhảy tới tab)` : r.url}>
                    <span className={methodClass(r.method)}>{r.method}</span>
                    <span className="g-root-name">{r.name}</span>
                  </button>
                  <button className="ghost sm g-root-act" onClick={() => void removeRequest(r)} title="Xóa">✕</button>
                </div>
              ))}
            </div>
          ))}
          {data.requests.length === 0 && <p className="small" style={{ color: 'var(--muted)', margin: '4px 6px' }}>Chưa có request. Dựng rồi 💾, hoặc “Dán curl”.</p>}

          <div className="group-title" style={{ margin: '14px 4px 6px', display: 'flex', gap: 6 }}>
            <span style={{ flex: 1 }}>Environment</span>
            <button className="ghost sm" onClick={newEnv} title="Environment mới">＋</button>
          </div>
          <select className="input sm" value={data.activeEnvId ?? ''} onChange={(e) => void pickEnv(e.target.value || null)}>
            <option value="">— không dùng —</option>
            {data.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          {data.environments.map((e) => (
            <div key={e.id} className="g-root" style={{ marginTop: 2 }}>
              <button className="g-root-btn" onClick={() => setEnvEdit(structuredClone(e))} title="Sửa biến">
                <span aria-hidden>🌱</span><span className="g-root-name">{e.name}</span>
                <span className="small" style={{ color: 'var(--muted)' }}>{e.vars.length} biến</span>
              </button>
              <button className="ghost sm g-root-act" onClick={() => void removeEnv(e)} title="Xóa">✕</button>
            </div>
          ))}
        </aside>
        )}

        {/* ── Builder + response ── */}
        <div className="api-main">
          {/* Thanh tab request đang mở — chuột giữa để đóng, như trình duyệt. */}
          <div className="api-wintabs">
            {sessions.map((s) => (
              <div key={s.key} className={`api-wintab${s.key === cur.key ? ' on' : ''}`}
                onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeSession(s.key); } }}>
                <button className="api-wintab-btn" onClick={() => setActiveKey(s.key)}
                  title={s.draft.url || 'Request mới'}>
                  <span className={methodClass(s.draft.method)}>{s.draft.method}</span>
                  <span className="api-wintab-name">{tabLabel(s.draft)}</span>
                  {s.sending && <span className="small" aria-label="đang gửi">…</span>}
                  {!s.sending && s.res && (
                    <span className={`api-dot api-status--${Math.floor(s.res.status / 100)}`} aria-hidden>●</span>
                  )}
                </button>
                <button className="api-wintab-x" onClick={() => closeSession(s.key)} title="Đóng tab">✕</button>
              </div>
            ))}
            <button className="ghost sm" onClick={() => openSession(blankDraft())} title="Tab request mới">＋</button>
          </div>

          <div className="api-urlbar">
            <select className={`input ${methodClass(draft.method)}`} style={{ width: 100 }} value={draft.method}
              onChange={(e) => setDraft({ ...draft, method: e.target.value })}>
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <input className="input" style={{ flex: 1 }}
              placeholder="https://… (dùng {{var}}) — hoặc dán thẳng lệnh curl vào đây"
              value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              onPaste={onUrlPaste}
              onKeyDown={(e) => e.key === 'Enter' && void send()} />
            <button onClick={() => void send()} disabled={sending}>{sending ? '…' : '▶ Send'}</button>
            <button className="ghost sm" onClick={() => void saveRequest()} title="Lưu vào collection">💾</button>
            <button className="ghost sm" onClick={() => void copyCurl()} disabled={!draft.url.trim()}
              title="Chép request này thành lệnh curl (biến {{var}} được thay bằng giá trị thật — cẩn thận token)">
              {curlCopied ? '✓ Đã chép' : '⧉ Copy curl'}
            </button>
            <button className="ghost sm" onClick={() => setImportOpen(true)} title="Dán một lệnh curl để import">Dán curl</button>
          </div>

          <div className="api-tabs">
            {(['params', 'headers', 'body'] as const).map((t) => (
              <button key={t} className={`api-tab${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>
                {t === 'params' ? 'Params' : t === 'headers' ? `Headers (${draft.headers.filter((h) => h.key.trim()).length})` : 'Body'}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            {activeEnv && <span className="small" style={{ color: 'var(--muted)' }}>env: <b>{activeEnv.name}</b></span>}
          </div>

          <div className="api-editor">
            {tab === 'headers' && (
              <div className="api-kv">
                {draft.headers.map((h, i) => (
                  <div key={i} className="api-kv-row">
                    <input type="checkbox" checked={h.on !== false} onChange={(e) => setHeader(i, { on: e.target.checked })} />
                    <input className="input" placeholder="Header" value={h.key} onChange={(e) => setHeader(i, { key: e.target.value })} />
                    <input className="input" placeholder="Value" value={h.value} onChange={(e) => setHeader(i, { value: e.target.value })} />
                    <button className="ghost sm" onClick={() => rmHeader(i)}>✕</button>
                  </div>
                ))}
                <button className="ghost sm" onClick={addHeaderRow}>＋ Thêm header</button>
              </div>
            )}
            {tab === 'params' && (
              <p className="small" style={{ color: 'var(--muted)', padding: 8 }}>
                Query params gõ thẳng vào URL (…?a=1&amp;b=2). Hỗ trợ biến {'{{var}}'} như mọi nơi.
              </p>
            )}
            {tab === 'body' && (
              <div className="api-body">
                <div className="api-bodytype">
                  {(['none', 'raw', 'form'] as const).map((bt) => (
                    <label key={bt}><input type="radio" checked={draft.bodyType === bt}
                      onChange={() => setDraft({ ...draft, bodyType: bt })} /> {bt}</label>
                  ))}
                  {draft.bodyType === 'raw' && (
                    <>
                      <button className="ghost sm" onClick={formatBody} title="Format JSON (Ctrl+Shift+F)">
                        ✨ Format JSON
                      </button>
                      <label title="Tự format lại khi ngơi tay, miễn là JSON đang hợp lệ">
                        <input type="checkbox" checked={autoFmt} onChange={(e) => setAutoFmt(e.target.checked)} /> auto
                      </label>
                      <span style={{ flex: 1 }} />
                      {bodyErr
                        ? <span className="small" style={{ color: 'var(--err)' }}>⚠ {bodyErr}</span>
                        : looksLikeJson(draft.body) && <span className="small" style={{ color: 'var(--muted)' }}>✓ JSON hợp lệ</span>}
                    </>
                  )}
                </div>
                {draft.bodyType !== 'none' && (
                  <textarea className="input api-bodytext" value={draft.body} ref={bodyRef}
                    spellCheck={false}
                    placeholder={draft.bodyType === 'raw' ? '{ "key": "{{value}}" }  — gõ { để ra sẵn khung, Enter để thêm field' : 'key=value&key2=value2'}
                    onKeyDown={onBodyKeyDown}
                    onBlur={() => { if (autoFmt && draft.bodyType === 'raw' && looksLikeJson(draft.body)) formatBody(); }}
                    onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
                )}
              </div>
            )}
          </div>

          {err && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', margin: '4px 0' }}>{err}</pre>}

          {res && (
            <div className="api-res">
              <div className="api-res-head">
                <span className={`api-status api-status--${Math.floor(res.status / 100)}`}>{res.status} {res.statusText}</span>
                <span className="small" style={{ color: 'var(--muted)' }}>{res.timeMs} ms · {res.size} B</span>
                <span style={{ flex: 1 }} />
                <button className={`api-tab${resTab === 'body' ? ' on' : ''}`} onClick={() => setResTab('body')}>Body</button>
                <button className={`api-tab${resTab === 'headers' ? ' on' : ''}`} onClick={() => setResTab('headers')}>Headers</button>
                {resTab === 'body' && resKind && (
                  <button className="ghost sm" onClick={() => setResPretty((p) => !p)}
                    title={resPretty ? 'Xem nguyên văn server trả về' : `Format ${resKind.toUpperCase()} cho dễ đọc`}>
                    {resPretty ? '↩ Raw' : `✨ Format ${resKind.toUpperCase()}`}
                  </button>
                )}
              </div>
              {resTab === 'body' ? (
                <pre className="api-res-body">{resShown}</pre>
              ) : (
                <pre className="api-res-body">{Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>
              )}
            </div>
          )}
        </div>
        {!rail.collapsed && <Splitter {...railSplit.grip} />}
      </div>

      {/* Modal lưu request (đặt tên + folder) */}
      {saveOpen && (
        <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && setSaveOpen(false)}>
          <div className="mail-compose panel" style={{ width: 'min(480px, 92vw)' }}>
            <div className="mail-compose-head"><b>💾 Lưu request</b><span style={{ flex: 1 }} />
              <button className="ghost sm" onClick={() => setSaveOpen(false)}>✕</button></div>
            <input className="input" autoFocus placeholder="Tên request" value={saveName}
              onChange={(e) => setSaveName(e.target.value)} />
            <input className="input" placeholder="Folder/nhóm (optional) — vd: Auth, Backend" value={saveFolder}
              list="api-folders" onChange={(e) => setSaveFolder(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void persistRequest(saveName, saveFolder)} />
            <datalist id="api-folders">
              {[...new Set(data.requests.map((r) => r.folder).filter(Boolean))].map((f) => <option key={f} value={f} />)}
            </datalist>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => void persistRequest(saveName, saveFolder)}>💾 Lưu</button>
              <button className="ghost" onClick={() => setSaveOpen(false)}>Hủy</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal dán curl */}
      {importOpen && (
        <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && setImportOpen(false)}>
          <div className="mail-compose panel" style={{ width: 'min(680px, 94vw)' }}>
            <div className="mail-compose-head"><b>Dán lệnh curl</b><span style={{ flex: 1 }} />
              <button className="ghost sm" onClick={() => setImportOpen(false)}>✕</button></div>
            <textarea className="input" style={{ minHeight: 200, fontFamily: 'var(--mono, monospace)' }} autoFocus
              placeholder="curl 'https://api.example.com/x' -H 'Authorization: Bearer {{token}}' -d '{...}'"
              value={curlText} onChange={(e) => setCurlText(e.target.value)} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={doImport} disabled={!curlText.trim()}>Import</button>
              <button className="ghost" onClick={() => setImportOpen(false)}>Hủy</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal environment editor */}
      {envEdit && (
        <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && setEnvEdit(null)}>
          <div className="mail-compose panel" style={{ width: 'min(620px, 94vw)' }}>
            <div className="mail-compose-head"><b>🌱 Environment</b><span style={{ flex: 1 }} />
              <button className="ghost sm" onClick={() => setEnvEdit(null)}>✕</button></div>
            <input className="input" placeholder="Tên environment (vd: dev, prod)" value={envEdit.name}
              onChange={(e) => setEnvEdit({ ...envEdit, name: e.target.value })} />
            <div className="api-kv">
              {envEdit.vars.map((v, i) => (
                <div key={i} className="api-kv-row">
                  <input className="input" placeholder="Biến (dùng {{tên}})" value={v.key}
                    onChange={(e) => setEnvEdit({ ...envEdit, vars: envEdit.vars.map((x, j) => j === i ? { ...x, key: e.target.value } : x) })} />
                  <input className="input" placeholder="Giá trị" value={v.value}
                    onChange={(e) => setEnvEdit({ ...envEdit, vars: envEdit.vars.map((x, j) => j === i ? { ...x, value: e.target.value } : x) })} />
                  <button className="ghost sm" onClick={() => setEnvEdit({ ...envEdit, vars: envEdit.vars.filter((_, j) => j !== i) })}>✕</button>
                </div>
              ))}
              <button className="ghost sm" onClick={() => setEnvEdit({ ...envEdit, vars: [...envEdit.vars, { key: '', value: '' }] })}>＋ Thêm biến</button>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => void saveEnv()} disabled={!envEdit.name.trim()}>💾 Lưu</button>
              <button className="ghost" onClick={() => setEnvEdit(null)}>Hủy</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function defaultName(d: Draft): string {
  try { return `${d.method} ${new URL(d.url).pathname}`; } catch { return `${d.method} request`; }
}
