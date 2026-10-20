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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  apiGet, apiSaveRequest, apiRemoveRequest, apiSend, apiSetActiveVarName, apiRenameFolder,
  stripFiles, FILE_LIMIT,
  type ApiData, type ApiRequest, type ApiHeader, type HttpResult,
  type ApiBodyType, type ApiFormField, type ApiAuth, type ApiSendOpts,
} from '@/lib/api';
import { parseCurl, looksLikeCurl, buildCurl } from '@/lib/curlParse';
import { resolveVars, findVarNames, buildVarMap, varNames, splitQuery, joinQuery, applyAuth } from '@/lib/apiVars';
import { pushHistory } from '@/lib/apiHistory';
import { formatText } from '@/lib/format';
import { looksLikeJson } from '@/lib/jsonEdit';
import { useSplit } from '@/lib/useSplit';
import Splitter from './Splitter';
import { useRailCollapse, CollapsedRail, RailHideButton } from './RailCollapse';
import JsonBox from './api/JsonBox';
import SplitPane, { type SplitCollapsed, type SplitDir } from './api/SplitPane';
import ResponsePane, { type ResTab } from './api/ResponsePane';
import AuthPanel from './api/AuthPanel';
import KvTable from './api/KvTable';
import VarsModal from './api/VarsModal';
import VarInput, { VarSuggestProvider } from './api/VarInput';
import HistoryPopover from './api/HistoryPopover';
import SendOptsPopover from './api/SendOptsPopover';
import CollectionRail, { allFolderPaths } from './api/CollectionRail';
import ApiTransferModal from './api/ApiTransferModal';
import { automation } from '@/lib/automation/runtime';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
/** Draft rỗng — hàm chứ không phải hằng dùng chung: mỗi tab phải có mảng
 *  headers của riêng nó, không thì hai tab sửa chung một chỗ. */
const blankDraft = (): Draft => ({
  name: '', method: 'GET', url: '', headers: [{ key: '', value: '' }], body: '', bodyType: 'none',
  form: [{ key: '', value: '', kind: 'text' }],
});

/** Nhãn + gợi ý cho từng kiểu body. Gói một chỗ để radio và phần diễn giải
 *  dưới nó không bao giờ lệch nhau. */
const BODY_TYPES: { key: ApiBodyType; label: string; hint: string }[] = [
  { key: 'none', label: 'none', hint: 'Không gửi body.' },
  { key: 'raw', label: 'raw', hint: 'Text thô (JSON/XML…). Tự đặt Content-Type ở tab Headers.' },
  { key: 'form', label: 'x-www-form-urlencoded', hint: 'Cặp key=value, mã hoá như form HTML cổ điển.' },
  { key: 'multipart', label: 'form-data', hint: 'Cặp key=value, kèm được FILE. Content-Type + boundary do runtime tự đặt.' },
];

/** Hai kiểu dùng bảng key/value thay vì ô text. */
const isFormType = (t: ApiBodyType) => t === 'form' || t === 'multipart';

interface Draft {
  id?: string;
  name: string;
  folder?: string;
  method: string;
  url: string;
  headers: ApiHeader[];
  body: string;
  bodyType: ApiBodyType;
  /** Dòng form cho 'form' (urlencoded) và 'multipart'. Dùng CHUNG một mảng cho
   *  cả hai: đổi qua lại giữa hai kiểu là chuyện thường khi dò API, giữ chung
   *  thì không phải gõ lại; chỉ dòng kind='file' là bị bỏ khi ở urlencoded. */
  form: ApiFormField[];
  /** Bảng Params (gồm dòng đang tắt). Vắng = suy ra từ query của `url`. */
  params?: ApiHeader[];
  auth?: ApiAuth;
  opts?: ApiSendOpts;
}

/** Một tab request đang mở — mọi thứ thuộc về nó nằm gọn ở đây. */
interface Session {
  key: string;
  draft: Draft;
  tab: 'params' | 'auth' | 'headers' | 'body';
  res: HttpResult | null;
  err: string | null;
  sending: boolean;
  resTab: ResTab;
  resPretty: boolean;
}

const TABS_KEY = 'devbox.api.tabs';
const LAYOUT_KEY = 'devbox.api.layout';
const PROJ_KEY = 'devbox.api.projects.closed';

/** Bố cục Request | Response — nhớ qua lần mở sau (khác useSplit: đây là tuỳ chọn
 *  làm việc hằng ngày chứ không phải "nới tạm ra xem"). */
interface Layout { dir: SplitDir; frac: number; collapsed: SplitCollapsed }
const DEFAULT_LAYOUT: Layout = { dir: 'h', frac: 0.5, collapsed: null };
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
    && (!d.auth || d.auth.type === 'none')
    && d.headers.every((h) => !h.key.trim() && !h.value.trim())
    && d.form.every((f) => !f.key.trim() && !f.value.trim() && !f.fileName);
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
  /** Hộp "View curl": xem lệnh curl của request đang dựng. */
  const [curlView, setCurlView] = useState(false);
  /** Thay {{var}} bằng giá trị thật trong curl — MẶC ĐỊNH BẬT: lệnh curl là để
   *  chạy được ngay (giá trị theo name đang chọn), giống ⧉ Copy curl. Bỏ tick
   *  khi cần xem/chép bản còn nguyên {{var}} (vd chia sẻ mà không lộ token). */
  const [curlResolve, setCurlResolve] = useState(true);
  /** Menu ⋯ / chuột phải của một request ở rail (toạ độ fixed). */
  const [railMenu, setRailMenu] = useState<{ x: number; y: number; req: ApiRequest } | null>(null);
  /** Menu ⋯ / chuột phải của một THƯ MỤC ở rail. */
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  /** Hộp đổi tên thư mục (kéo theo thư mục con + biến dự án). */
  const [folderEdit, setFolderEdit] = useState<{ from: string; to: string } | null>(null);
  /** Hộp export/import collection. */
  const [transfer, setTransfer] = useState<{ tab: 'export' | 'import'; scope: string } | null>(null);
  /** Hộp sửa tên/dự án của request đã lưu. */
  const [railEdit, setRailEdit] = useState<{ req: ApiRequest; name: string; folder: string } | null>(null);
  /** Hộp quản lý biến: null = đóng; scope '' = biến chung, hoặc tên dự án. */
  const [varsOpen, setVarsOpen] = useState<{ scope: string } | null>(null);
  /** Tăng sau mỗi lần ghi lịch sử để popover đọc lại. */
  const [histVersion, setHistVersion] = useState(0);
  /** Request đang chạy theo tab — để nút Hủy cắt đúng cái cần cắt. */
  const aborts = useRef<Record<string, AbortController>>({});
  const [autoFmt, setAutoFmt] = useState(true);
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const setFrac = useCallback((frac: number) => setLayout((l) => ({ ...l, frac })), []);
  const setCollapsed = useCallback((collapsed: SplitCollapsed) => setLayout((l) => ({ ...l, collapsed })), []);
  const flipDir = useCallback(() => setLayout((l) => ({ ...l, dir: l.dir === 'h' ? 'v' : 'h' })), []);
  /** Dự án đang thu gọn trong rail ('' = nhóm chưa phân dự án). */
  const [closedProj, setClosedProj] = useState<string[]>([]);
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
    try {
      const l = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as Partial<Layout> | null;
      if (l) {
        setLayout({
          dir: l.dir === 'v' ? 'v' : 'h',
          frac: typeof l.frac === 'number' && l.frac > 0 && l.frac < 1 ? l.frac : 0.5,
          collapsed: l.collapsed === 'first' || l.collapsed === 'second' ? l.collapsed : null,
        });
      }
      const pc = JSON.parse(localStorage.getItem(PROJ_KEY) ?? 'null') as unknown;
      if (Array.isArray(pc)) setClosedProj(pc.filter((x): x is string => typeof x === 'string'));
    } catch { /* bố cục hỏng — dùng mặc định */ }
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    try {
      // Lược RUỘT FILE trước khi ghi: localStorage chỉ ~5MB, một file base64
      // là đủ tràn quota và khi đó MẤT LUÔN cả bàn làm việc (catch nuốt lỗi,
      // không ghi được gì nữa). Tên file vẫn giữ để UI hiện "chọn lại file".
      const drafts = sessions.map((s) => ({ ...s.draft, form: stripFiles(s.draft.form) }));
      const active = Math.max(0, sessions.findIndex((s) => s.key === cur?.key));
      localStorage.setItem(TABS_KEY, JSON.stringify({ drafts, active }));
    } catch { /* đầy thì thôi */ }
  }, [hydrated, sessions, cur]);
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
      localStorage.setItem(PROJ_KEY, JSON.stringify(closedProj));
    } catch { /* đầy thì thôi */ }
  }, [hydrated, layout, closedProj]);

  // ── Biến ───────────────────────────────────────────────────────────────────
  //
  // Hợp của biến CHUNG và biến của DỰ ÁN mà request đang thuộc về (draft.folder),
  // biến dự án ghi đè khi trùng tên. Dòng bị tắt (on:false) không tính.
  // Thư mục lồng nhau ("admin/call-export") thừa kế biến của MỌI thư mục cha:
  // chung → admin → admin/call-export, lớp sâu hơn ghi đè lớp nông hơn.
  const project = (draft.folder ?? '').trim();
  const activeName = data.activeVarName ?? '';
  const layersFor = useCallback((proj: string) => {
    const parts = proj.split('/').map((x) => x.trim()).filter(Boolean);
    return [data.globalVars, ...parts.map((_, i) => data.projectVars?.[parts.slice(0, i + 1).join('/')])];
  }, [data.globalVars, data.projectVars]);
  /** Biến hiệu lực của MỘT dự án — cũng dùng cho request ở rail (copy curl). */
  const varsFor = useCallback((proj: string) => buildVarMap(layersFor(proj), activeName), [layersFor, activeName]);
  /** Các name có thể chọn: của biến chung + biến của dự án hiện tại (kể cả thư mục cha). */
  const nameOptions = useMemo(() => varNames(layersFor(project)), [layersFor, project]);
  const vars = useMemo(() => varsFor(project), [varsFor, project]);
  const envMap = vars; // tên cũ — phần còn lại của file vẫn gọi envMap

  /** Biến request này dùng nhưng chưa khai ở đâu cả — để cảnh báo trước khi gửi. */
  const missingVars = useMemo(() => {
    const a = draft.auth;
    const names = findVarNames(
      draft.url,
      ...draft.headers.filter((h) => h.on !== false).flatMap((h) => [h.key, h.value]),
      draft.bodyType === 'raw' ? draft.body : undefined,
      ...(isFormType(draft.bodyType) ? draft.form.filter((f) => f.on !== false).flatMap((f) => [f.key, f.value]) : []),
      a?.token, a?.user, a?.pass, a?.keyName, a?.keyValue,
    );
    return names.filter((n) => !(n in vars));
  }, [draft, vars]);

  /** Nguồn gợi ý cho mọi ô VarInput (gõ {{, bôi đen biến, chuột phải). */
  const varSuggest = useMemo(
    () => ({ vars, onManage: () => setVarsOpen({ scope: project }) }),
    [vars, project],
  );

  /** URL sau khi thay biến — hiện dưới ô URL để thấy biến map ra gì. */
  const resolvedUrl = useMemo(() => (draft.url.includes('{{') ? resolveVars(draft.url, vars) : ''), [draft.url, vars]);

  // ── Params ⇄ URL ───────────────────────────────────────────────────────────
  //
  // Bảng Params là một cái nhìn của query trong URL: sửa bảng thì URL đổi theo, gõ
  // URL thì bảng đọc lại. Dòng đang TẮT chỉ nằm trong bảng (draft.params), không
  // có trong URL. Chỉ cập nhật theo thao tác của người dùng (không effect) nên
  // không có vòng lặp URL ↔ bảng.
  const paramRows: ApiHeader[] = draft.params ?? splitQuery(draft.url).rows;
  const setParamRows = (rows: ApiHeader[]) => {
    const sp = splitQuery(draft.url);
    setDraft((d) => ({ ...d, params: rows, url: joinQuery(sp.base, rows, sp.hash) }));
  };
  const setUrl = (url: string) => setDraft((d) => ({
    ...d,
    url,
    // URL gõ tay: dòng đang bật đọc lại từ URL, dòng đang tắt giữ nguyên.
    params: [...splitQuery(url).rows, ...(d.params ?? []).filter((r) => r.on === false)],
  }));

  // ── Gửi request ────────────────────────────────────────────────────────────
  //
  // Kết quả trả về ĐÚNG tab đã bấm Send (patch theo key, không phải setCur):
  // gửi ở tab A rồi nhảy sang tab B đọc tạm cái khác là chuyện thường, response
  // không được phép rơi nhầm chỗ.
  const send = async () => {
    const key = cur.key;
    const d = cur.draft;
    const url0 = resolveVars(d.url, envMap).trim();
    if (!url0) { patch(key, { err: 'Nhập URL trước.' }); return; }
    const baseHeaders = d.headers
      .filter((h) => h.key.trim() && h.on !== false)
      .map((h) => ({ key: resolveVars(h.key, envMap), value: resolveVars(h.value, envMap) }));
    // Tab Auth sinh thêm header / query param (header gõ tay cùng tên thắng).
    const { url, headers } = applyAuth(url0, baseHeaders, d.auth, envMap);

    const ctl = new AbortController();
    aborts.current[key] = ctl;
    patch(key, { sending: true, err: null, res: null });
    let status: number | undefined;
    let timeMs: number | undefined;
    let error: string | undefined;
    try {
      const r = await apiSend({
        method: d.method, url, headers,
        bodyType: d.bodyType,
        body: d.bodyType === 'raw' ? resolveVars(d.body, envMap) : undefined,
        // Biến {{var}} áp cho cả tên field lẫn giá trị — cùng quy ước với URL
        // và headers, người dùng không phải nhớ chỗ nào được chỗ nào không.
        form: isFormType(d.bodyType)
          ? d.form
              .filter((f) => f.key.trim() && f.on !== false)
              // urlencoded không mang được file — bỏ hẳn dòng đó thay vì để
              // server nhận một field rỗng trùng tên (UI đã cảnh báo ở tab Body).
              .filter((f) => !(d.bodyType === 'form' && f.kind === 'file'))
              .map((f) => ({
                ...f,
                key: resolveVars(f.key, envMap),
                value: f.kind === 'file' ? '' : resolveVars(f.value, envMap),
              }))
          : undefined,
        timeoutSec: d.opts?.timeoutSec,
        follow: d.opts?.follow,
      }, ctl.signal);
      status = r.status; timeMs = r.timeMs;
      patch(key, { res: r, resTab: 'body', resPretty: true });
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      error = aborted ? 'Đã hủy request.' : (e as Error).message;
      patch(key, { err: error });
    } finally {
      delete aborts.current[key];
      patch(key, { sending: false });
      // Hủy tay thì không ghi lịch sử — đó không phải một lần gửi có kết quả.
      if (error !== 'Đã hủy request.') {
        pushHistory({
          method: d.method, url: d.url, status, timeMs, error,
          draft: { ...d, form: stripFiles(d.form) } as unknown as Record<string, unknown>,
        });
        setHistVersion((v) => v + 1);
      }
    }
  };

  const cancel = () => aborts.current[cur.key]?.abort();

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
        // curl mang body dạng text thô; không tách ngược thành dòng form (một
        // `--data a=1&b=2` có thể là urlencoded mà cũng có thể là chuỗi thường).
        form: [{ key: '', value: '', kind: 'text' }],
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

  // ── View / Copy curl ─────────────────────────────────────────────────────────
  const [curlCopied, setCurlCopied] = useState(false);

  /**
   * Dựng lệnh curl từ một draft.
   *
   * `resolve` = thay {{var}} bằng giá trị environment (để đưa cho người khác
   * chạy, máy họ không có environment của mình) — đổi lại là token thật nằm
   * trong lệnh. Tắt thì {{var}} giữ nguyên chữ.
   */
  const curlOf = useCallback((d: Draft, resolve: boolean): string => {
    const m = resolve ? varsFor((d.folder ?? '').trim()) : {};
    const rv = (t: string) => (resolve ? resolveVars(t, m) : t);
    const heads = d.headers.filter((h) => h.key.trim() && h.on !== false)
      .map((h) => ({ key: rv(h.key), value: rv(h.value) }));
    // Có cả header/query do tab Auth sinh ra — lệnh curl phải gửi được y như Send.
    const authed = resolve
      ? applyAuth(rv(d.url), heads, d.auth, m)
      : { url: d.url, headers: heads };
    return buildCurl({
      method: d.method,
      url: authed.url,
      headers: authed.headers,
      body: rv(d.body),
      bodyType: d.bodyType,
      form: d.form.map((f) => ({ ...f, key: rv(f.key), value: rv(f.value) })),
    });
  }, [varsFor]);

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCurlCopied(true);
      setTimeout(() => setCurlCopied(false), 1500);
    } catch {
      setErr('Không chép được vào clipboard.');
    }
  }, [setErr]);

  const copyCurl = useCallback(() => copyText(curlOf(draft, true)), [copyText, curlOf, draft]);

  // ── Collection ───────────────────────────────────────────────────────────────
  /**
   * Bấm một request ở rail: đang mở sẵn thì nhảy tới tab đó (không mở trùng,
   * không mất response đang xem); chưa mở thì thêm tab mới — tab trắng tinh
   * đang xem thì dùng lại chỗ đó.
   */
  const openRequest = (r: ApiRequest) => {
    const already = sessions.find((s) => s.draft.id === r.id);
    if (already) { setActiveKey(already.key); return; }
    const d = requestToDraft(r);
    if (isPristine(cur)) setCur({ draft: d, tab: d.bodyType === 'none' ? 'headers' : 'body', res: null, err: null });
    else openSession(d);
  };

  /** Mở lại một lần gửi trong lịch sử thành tab mới (tab trắng thì dùng luôn). */
  const openFromHistory = (raw: Record<string, unknown>) => {
    const d: Draft = { ...blankDraft(), ...(raw as Partial<Draft>), id: undefined };
    if (!d.headers?.length) d.headers = [{ key: '', value: '' }];
    if (!d.form?.length) d.form = [{ key: '', value: '', kind: 'text' }];
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
      const d = await apiSaveRequest({
        ...draft, name: finalName, folder: folder.trim() || undefined,
        // Ruột file không đi vào collections — xem ghi chú ở ApiFormField.
        form: stripFiles(draft.form),
      });
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

  /** Lưu đổi tên / chuyển dự án của request đã lưu. Tab đang mở nó cũng đổi theo
   *  (chỉ tên + dự án — nội dung đang gõ dở của tab giữ nguyên). */
  const saveRailEdit = async () => {
    if (!railEdit) return;
    const { req, name, folder } = railEdit;
    try {
      const d = await apiSaveRequest({
        ...req, name: name.trim() || req.name, folder: folder.trim() || undefined,
      });
      setData(d);
      const fresh = d.requests.find((x) => x.id === req.id);
      if (fresh) {
        setSessions((ss) => ss.map((s) => (s.draft.id === req.id
          ? { ...s, draft: { ...s.draft, name: fresh.name, folder: fresh.folder } } : s)));
      }
      setRailEdit(null);
    } catch (e) { setErr((e as Error).message); }
  };

  const saveFolderEdit = async () => {
    if (!folderEdit) return;
    try {
      const to = folderEdit.to.trim();
      setData(await apiRenameFolder(folderEdit.from, to));
      // Thư mục đang thu gọn đổi tên theo, khỏi bung ra bất ngờ.
      setClosedProj((c) => c.map((x) => (x === folderEdit.from || x.startsWith(`${folderEdit.from}/`) ? to + x.slice(folderEdit.from.length) : x)));
      setFolderEdit(null);
    } catch (e) { setErr((e as Error).message); }
  };

  const duplicateRequest = async (r: ApiRequest) => {
    try {
      setData(await apiSaveRequest({ ...r, id: undefined, name: `${r.name} (copy)` }));
    } catch (e) { setErr((e as Error).message); }
  };

  /** Mở menu của một request tại toạ độ (kẹp trong màn hình). */
  const openRailMenu = (x: number, y: number, req: ApiRequest) => {
    setRailMenu({
      x: Math.max(6, Math.min(x, window.innerWidth - 230)),
      y: Math.max(6, Math.min(y, window.innerHeight - 240)),
      req,
    });
  };


  const setHeader = (i: number, patch: Partial<ApiHeader>) =>
    setDraft((d) => ({ ...d, headers: d.headers.map((h, j) => (j === i ? { ...h, ...patch } : h)) }));
  const addHeaderRow = () => setDraft((d) => ({ ...d, headers: [...d.headers, { key: '', value: '' }] }));
  const rmHeader = (i: number) => setDraft((d) => ({ ...d, headers: d.headers.filter((_, j) => j !== i) }));

  // ── Dòng form (x-www-form-urlencoded / form-data) ───────────────────────────
  const setField = (i: number, patch: Partial<ApiFormField>) =>
    setDraft((d) => ({ ...d, form: d.form.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
  const addFieldRow = () =>
    setDraft((d) => ({ ...d, form: [...d.form, { key: '', value: '', kind: 'text' }] }));
  const rmField = (i: number) =>
    setDraft((d) => ({ ...d, form: d.form.filter((_, j) => j !== i) }));

  /**
   * Chọn file cho một dòng: đọc thành base64 ngay tại browser.
   *
   * Đọc luôn (thay vì giữ File rồi đọc lúc Send) vì request đi qua proxy server
   * dạng JSON — File không serialize được. Đổi lại phải chặn dung lượng: base64
   * nằm trọn trong RAM của cả browser lẫn server, và còn phình thêm ~33%.
   */
  const pickFile = async (i: number, file: File | undefined) => {
    if (!file) return;
    if (file.size > FILE_LIMIT) {
      setErr(`File ${file.name} nặng ${(file.size / 1024 / 1024).toFixed(1)}MB — trần là ${FILE_LIMIT / 1024 / 1024}MB.`);
      return;
    }
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        // result là data URL "data:<mime>;base64,<payload>" — chỉ lấy phần sau dấu phẩy.
        fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '');
        fr.onerror = () => reject(new Error('Không đọc được file.'));
        fr.readAsDataURL(file);
      });
      setField(i, {
        kind: 'file', fileName: file.name, fileB64: b64,
        fileType: file.type || 'application/octet-stream', value: '',
      });
      setErr(null);
    } catch (e) { setErr((e as Error).message); }
  };

  // ── Ô body raw: format JSON ────────────────────────────────────────────────
  //
  // Phần gõ (đóng cặp ngoặc, thụt dòng, đặt lại con trỏ) nay do Monaco lo — xem
  // components/api/JsonBox.tsx. Trước đây là <textarea> nên phải tự làm hết
  // bằng lib/jsonEdit + caretRef; bỏ được cả mảng đó khi đổi sang Monaco, chỉ
  // giữ lại nút ✨ Format và cờ auto vì chúng là hành vi riêng của tab này.

  /** Format body về JSON 2-space. */
  const formatBody = useCallback(() => {
    setDraft((d) => {
      const f = formatText('json', d.body);
      return !f.ok || f.text === d.body ? d : { ...d, body: f.text };
    });
  }, [setDraft]);

  // Tự format khi ngơi tay ~700ms và body đang là JSON hợp lệ. Lúc còn dở dang
  // (gõ nửa chừng cái key) thì JSON.parse fail nên không ai đụng vào text cả.
  useEffect(() => {
    if (!autoFmt || draft.bodyType !== 'raw' || !looksLikeJson(draft.body)) return;
    const t = setTimeout(formatBody, 700);
    return () => clearTimeout(t);
  }, [autoFmt, draft.body, draft.bodyType, formatBody]);


  // Báo JSON hỏng ngay dưới ô — biết sai trước khi bấm Send.
  const bodyErr = useMemo(() => {
    if (draft.bodyType !== 'raw' || !looksLikeJson(draft.body)) return null;
    const f = formatText('json', draft.body);
    return f.ok ? null : f.error ?? 'JSON không hợp lệ';
  }, [draft.body, draft.bodyType]);

  return (
    <VarSuggestProvider value={varSuggest}>
    <div className="panel sheet-panel">
      <div className="api-root" ref={railSplit.ref} style={{ ...railSplit.style, ...rail.style }}>
        {/* ── Rail: collection + environment (thu gọn được) ── */}
        {rail.collapsed ? (
          <CollapsedRail label="Collection" count={data.requests.length} onShow={rail.show} />
        ) : (
        <CollectionRail
          data={data}
          activeId={draft.id}
          openIds={new Set(sessions.map((x) => x.draft.id).filter((x): x is string => !!x))}
          closed={closedProj}
          onToggle={(path) => setClosedProj((c) => (c.includes(path) ? c.filter((x) => x !== path) : [...c, path]))}
          onCollapseAll={() => setClosedProj(allFolderPaths(data.requests))}
          onExpandAll={() => setClosedProj([])}
          onNew={(folder) => openSession({ ...blankDraft(), folder })}
          onOpen={openRequest}
          onRequestMenu={openRailMenu}
          onFolderMenu={(x, y, path) => setFolderMenu({
            x: Math.max(6, Math.min(x, window.innerWidth - 230)),
            y: Math.max(6, Math.min(y, window.innerHeight - 200)),
            path,
          })}
          onReload={() => void reload()}
          onHide={rail.hide}
          onImport={() => setTransfer({ tab: 'import', scope: '' })}
          onExport={(scope) => setTransfer({ tab: 'export', scope })}
          onVars={() => setVarsOpen({ scope: '' })}
        />
        )}

        {/* ── Builder + response ── */}
        <div className="api-main">
          {/* Thanh tab request đang mở — chuột giữa để đóng, như trình duyệt. */}
          <div className="api-wintabs g-shrink">
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
            <VarInput className="input" style={{ flex: 1, minWidth: 160 }}
              placeholder="https://… (gõ {{ để chèn biến) — hoặc dán thẳng lệnh curl vào đây"
              value={draft.url} onChange={setUrl}
              onPaste={onUrlPaste}
              onKeyDown={(e) => e.key === 'Enter' && void send()} />
            {sending
              ? <button onClick={cancel} title="Hủy request đang chạy">■ Hủy</button>
              : <button onClick={() => void send()}>▶ Send</button>}
            <SendOptsPopover opts={draft.opts} onChange={(o) => setDraft((d) => ({ ...d, opts: o }))} />
            <HistoryPopover version={histVersion} onOpen={openFromHistory} />
            <button className="ghost sm" onClick={() => void saveRequest()} title="Lưu vào dự án">💾</button>
            <button className="ghost sm" onClick={() => void copyCurl()} disabled={!draft.url.trim()}
              title="Chép request này thành lệnh curl (biến {{var}} được thay bằng giá trị thật — cẩn thận token)">
              {curlCopied ? '✓ Đã chép' : '⧉ Copy curl'}
            </button>
            <button className="ghost sm" onClick={() => setCurlView(true)} disabled={!draft.url.trim()}
              title="Xem lệnh curl của request này">👁 View curl</button>
          </div>

          {/* Biến map ra gì + biến nào còn thiếu — "map đúng" thấy ngay, không đợi
              server trả 4xx rồi mới đoán. */}
          {(missingVars.length > 0 || resolvedUrl) && (
            <div className="api-vline">
              {missingVars.length > 0 && (
                <button className="api-vwarn" onClick={() => setVarsOpen({ scope: project })}
                  title="Bấm để khai biến">
                  ⚠ Chưa có biến: {missingVars.map((n) => `{{${n}}}`).join(' ')}
                </button>
              )}
              {resolvedUrl && <span className="api-vresolved" title={resolvedUrl}>→ {resolvedUrl}</span>}
            </div>
          )}

          <SplitPane
            dir={layout.dir}
            frac={layout.frac}
            onFrac={setFrac}
            collapsed={layout.collapsed}
            onCollapsed={setCollapsed}
            firstLabel="Request"
            secondLabel="Response"
            first={
              <div className="api-req">
                <div className="api-tabs">
                  {(['params', 'auth', 'headers', 'body'] as const).map((t) => (
                    <button key={t} className={`api-tab${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>
                      {t === 'params' ? `Params${paramRows.filter((r) => r.key.trim() && r.on !== false).length ? ` (${paramRows.filter((r) => r.key.trim() && r.on !== false).length})` : ''}`
                        : t === 'auth' ? `Auth${draft.auth && draft.auth.type !== 'none' ? ' ●' : ''}`
                        : t === 'headers' ? `Headers (${draft.headers.filter((h) => h.key.trim()).length})` : 'Body'}
                    </button>
                  ))}
                  <span style={{ flex: 1 }} />
                  {nameOptions.length > 0 && (
                    <select className="input sm" value={activeName} style={{ width: 'auto' }}
                      title="Name đang dùng — biến khai nhiều giá trị theo name sẽ lấy giá trị ứng với name này khi Send"
                      onChange={(e) => {
                        const n = e.target.value;
                        setData((d) => ({ ...d, activeVarName: n || undefined }));
                        void apiSetActiveVarName(n).then(setData).catch(() => {});
                      }}>
                      <option value="">(không name)</option>
                      {nameOptions.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  )}
                  <button className="ghost sm" onClick={() => setVarsOpen({ scope: project })}
                    title={project ? `Biến của dự án “${project}” + biến chung` : 'Biến chung (request chưa thuộc dự án nào)'}>
                    🔣 {Object.keys(vars).length}{project ? ` · ${project}` : ''}
                  </button>
                  <span className="api-tools">
                    <button className="ghost sm" onClick={flipDir}
                      title={layout.dir === 'h' ? 'Đang xếp ngang (request trái · response phải) — bấm để xếp dọc' : 'Đang xếp dọc (request trên · response dưới) — bấm để xếp ngang'}>
                      {layout.dir === 'h' ? '⇄' : '⇅'}
                    </button>
                    <button className="ghost sm" onClick={() => setCollapsed('first')}
                      title="Thu gọn request để xem response rộng hơn">{layout.dir === 'h' ? '◂' : '▴'}</button>
                  </span>
                </div>

          <div className="api-editor">
            {tab === 'headers' && (
              <div className="api-kv">
                {draft.headers.map((h, i) => (
                  <div key={i} className="api-kv-row">
                    <input type="checkbox" checked={h.on !== false} onChange={(e) => setHeader(i, { on: e.target.checked })} />
                    <VarInput className="input" placeholder="Header" value={h.key} onChange={(v) => setHeader(i, { key: v })} />
                    <VarInput className="input" placeholder="Value" value={h.value} onChange={(v) => setHeader(i, { value: v })} />
                    <button className="ghost sm" onClick={() => rmHeader(i)}>✕</button>
                  </div>
                ))}
                <button className="ghost sm" onClick={addHeaderRow}>＋ Thêm header</button>
              </div>
            )}
            {tab === 'params' && (
              <div>
                <KvTable rows={paramRows} onChange={setParamRows} keyPlaceholder="Param" valuePlaceholder="Value" addLabel="＋ Thêm param" withVars />
                <p className="small" style={{ color: 'var(--muted)', margin: '2px 4px 6px' }}>
                  Đồng bộ hai chiều với URL. Bỏ tick một dòng để tắt tạm (không gửi nhưng vẫn giữ). Hỗ trợ <code>{'{{var}}'}</code> — gõ <code>{'{{'}</code> để gợi ý, bôi đen / chuột phải vào biến để đổi sang biến khác.
                </p>
              </div>
            )}
            {tab === 'auth' && <AuthPanel auth={draft.auth} onChange={(a) => setDraft((d) => ({ ...d, auth: a }))} />}
            {tab === 'body' && (
              <div className="api-body">
                <div className="api-bodytype">
                  {BODY_TYPES.map((bt) => (
                    <label key={bt.key} title={bt.hint}>
                      <input type="radio" checked={draft.bodyType === bt.key}
                        onChange={() => setDraft({ ...draft, bodyType: bt.key })} /> {bt.label}
                    </label>
                  ))}
                  {draft.bodyType === 'raw' && (
                    <>
                      <button className="ghost sm" onClick={formatBody} title="Format JSON 2 dấu cách">
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
                {/* Hai kiểu form dùng BẢNG key/value chứ không phải ô text:
                    gõ tay `a=1&b=2` thì phải tự mã hoá ký tự đặc biệt (dấu &,
                    dấu cách trong giá trị) — sai âm thầm, và multipart thì
                    không có cách nào gõ tay ra file. */}
                {isFormType(draft.bodyType) && (
                  <div className="api-kv">
                    {/* Nói rõ Content-Type SẼ gửi: cả hai kiểu đều do runtime tự
                        đặt (multipart còn kèm boundary), và header tự gõ ở tab
                        Headers bị bỏ qua — không nói thì người dùng tưởng header
                        của mình có tác dụng rồi ngồi dò tại sao server trả 400. */}
                    <p className="small" style={{ color: 'var(--muted)', margin: '0 2px 4px' }}>
                      Content-Type: <code>{draft.bodyType === 'form'
                        ? 'application/x-www-form-urlencoded'
                        : 'multipart/form-data; boundary=…'}</code> — tự đặt khi gửi.
                    </p>
                    {draft.form.map((f, i) => (
                      <div key={i} className="api-kv-row">
                        <input type="checkbox" checked={f.on !== false}
                          onChange={(e) => setField(i, { on: e.target.checked })} />
                        <VarInput className="input" placeholder="Key" value={f.key}
                          onChange={(v) => setField(i, { key: v })} />
                        {f.kind === 'file' ? (
                          <label className="api-file">
                            <input type="file" hidden
                              onChange={(e) => void pickFile(i, e.target.files?.[0])} />
                            {f.fileName
                              ? <span className={`api-file-name${f.fileB64 ? '' : ' is-stale'}`}
                                  title={f.fileB64 ? f.fileName : 'Request đã lưu không giữ ruột file — bấm để chọn lại'}>
                                  📎 {f.fileName}{f.fileB64 ? '' : ' (chọn lại)'}
                                </span>
                              : <span className="api-file-name">📎 Chọn file…</span>}
                          </label>
                        ) : (
                          <VarInput className="input" placeholder="Value" value={f.value}
                            onChange={(v) => setField(i, { value: v })} />
                        )}
                        {/* Chuyển text ↔ file. Chỉ multipart mới mang được file,
                            urlencoded thì nút này không có nghĩa. */}
                        {draft.bodyType === 'multipart' && (
                          <button className="ghost sm" title={f.kind === 'file' ? 'Đổi về giá trị text' : 'Đổi thành file đính kèm'}
                            onClick={() => setField(i, f.kind === 'file'
                              ? { kind: 'text', fileName: undefined, fileB64: undefined, fileType: undefined }
                              : { kind: 'file', value: '' })}>
                            {f.kind === 'file' ? '📎' : 'T'}
                          </button>
                        )}
                        <button className="ghost sm" onClick={() => rmField(i)}>✕</button>
                      </div>
                    ))}
                    <button className="ghost sm" onClick={addFieldRow}>＋ Thêm field</button>
                    {/* urlencoded KHÔNG mang được file — nói thẳng thay vì im
                        lặng bỏ qua dòng đó lúc gửi. */}
                    {draft.bodyType === 'form' && draft.form.some((f) => f.kind === 'file') && (
                      <p className="small" style={{ color: 'var(--warn, #d90)', margin: '4px 2px' }}>
                        ⚠ x-www-form-urlencoded không gửi được file — các dòng 📎 sẽ bị bỏ qua.
                        Chuyển sang <b>form-data</b> nếu cần đính kèm.
                      </p>
                    )}
                  </div>
                )}
                {draft.bodyType === 'raw' && (
                  <div className="api-bodybox">
                    <div className="api-fill">
                      <JsonBox
                        path={`api-body-${cur.key}`}
                        value={draft.body}
                        onChange={(v) => setDraft({ ...draft, body: v })}
                        language={looksLikeJson(draft.body) || !draft.body.trim() ? 'json' : 'plaintext'}
                        vars={vars}
                        height="100%"
                        placeholder={'{ "key": "{{value}}" }'}
                        onSubmit={() => void send()}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

              </div>
            }
            second={
              <ResponsePane
                res={res}
                err={err}
                sending={sending}
                tab={resTab}
                onTab={setResTab}
                pretty={resPretty}
                onPretty={setResPretty}
                modelKey={cur.key}
                tools={(
                  <>
                    <button className="ghost sm" onClick={flipDir}
                      title={layout.dir === 'h' ? 'Đang xếp ngang — bấm để xếp dọc' : 'Đang xếp dọc — bấm để xếp ngang'}>
                      {layout.dir === 'h' ? '⇄' : '⇅'}
                    </button>
                    <button className="ghost sm" onClick={() => setCollapsed('second')}
                      title="Thu gọn response để soạn request rộng hơn">{layout.dir === 'h' ? '▸' : '▾'}</button>
                  </>
                )}
              />
            }
          />
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
            <input className="input" placeholder="Dự án (optional) — vd: Auth, Backend" value={saveFolder}
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

      {/* View curl — chỉ đọc; muốn import thì dán thẳng curl vào ô URL. */}
      {curlView && (
        <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && setCurlView(false)}>
          <div className="mail-compose panel" style={{ width: 'min(720px, 94vw)' }}>
            <div className="mail-compose-head"><b>👁 Lệnh curl</b><span style={{ flex: 1 }} />
              <button className="ghost sm" onClick={() => setCurlView(false)}>✕</button></div>
            <textarea className="input" readOnly style={{ minHeight: 220, fontFamily: 'var(--mono, monospace)' }}
              value={curlOf(draft, curlResolve)} onFocus={(e) => e.currentTarget.select()} />
            <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--muted)' }}>
              <input type="checkbox" checked={curlResolve} onChange={(e) => setCurlResolve(e.target.checked)} />
              Thay {'{{var}}'} bằng giá trị thật (cẩn thận token)
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => void copyText(curlOf(draft, curlResolve))}>
                {curlCopied ? '✓ Đã chép' : '⧉ Copy'}
              </button>
              <button className="ghost" onClick={() => setCurlView(false)}>Đóng</button>
            </div>
          </div>
        </div>
      )}

      {/* Menu ⋯ / chuột phải của request ở rail */}
      {railMenu && typeof document !== 'undefined' && createPortal(
        <>
          <div className="bt-menu-backdrop" onMouseDown={() => setRailMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setRailMenu(null); }} />
          <div className="bt-menu bt-menu-fixed" role="menu" style={{ left: railMenu.x, top: railMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}>
            {(() => {
              const r = railMenu.req;
              const close = () => setRailMenu(null);
              return (
                <>
                  <button onClick={() => { close(); setRailEdit({ req: r, name: r.name, folder: r.folder ?? '' }); }}>
                    ✎ Sửa tên / dự án…
                  </button>
                  <button onClick={() => { close(); openRequest(r); }}>▶ Mở</button>
                  <button onClick={() => { close(); openSession(requestToDraft(r)); }}>⊞ Mở trong tab mới</button>
                  <button onClick={() => { close(); void duplicateRequest(r); }}>⧉ Nhân bản</button>
                  <div className="bt-menu-sep" />
                  <button onClick={() => { close(); void copyText(curlOf(requestToDraft(r), true)); }}>⧉ Copy curl</button>
                  <div className="bt-menu-sep" />
                  <button className="danger" onClick={() => { close(); void removeRequest(r); }}>🗑 Xóa</button>
                </>
              );
            })()}
          </div>
        </>,
        document.body,
      )}

      {/* Menu ⋯ / chuột phải của thư mục ở rail */}
      {folderMenu && typeof document !== 'undefined' && createPortal(
        <>
          <div className="bt-menu-backdrop" onMouseDown={() => setFolderMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setFolderMenu(null); }} />
          <div className="bt-menu bt-menu-fixed" role="menu" style={{ left: folderMenu.x, top: folderMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}>
            {(() => {
              const path = folderMenu.path;
              const close = () => setFolderMenu(null);
              return (
                <>
                  <button onClick={() => { close(); openSession({ ...blankDraft(), folder: path }); }}>＋ Request mới ở đây</button>
                  <button onClick={() => { close(); setFolderEdit({ from: path, to: path }); }}>✎ Đổi tên / chuyển thư mục…</button>
                  <button onClick={() => { close(); setVarsOpen({ scope: path }); }}>🔣 Biến của thư mục</button>
                  <div className="bt-menu-sep" />
                  <button onClick={() => { close(); setTransfer({ tab: 'export', scope: path }); }}>⤒ Export thư mục này…</button>
                  <button onClick={() => { close(); setTransfer({ tab: 'import', scope: path }); }}>⤓ Import…</button>
                </>
              );
            })()}
          </div>
        </>,
        document.body,
      )}

      {folderEdit && (
        <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && setFolderEdit(null)}>
          <div className="mail-compose panel" style={{ width: 'min(480px, 92vw)' }}>
            <div className="mail-compose-head"><b>✎ Đổi tên thư mục</b><span style={{ flex: 1 }} />
              <button className="ghost sm" onClick={() => setFolderEdit(null)}>✕</button></div>
            <p className="small" style={{ color: 'var(--muted)', margin: 0 }}>
              Dùng dấu / để lồng thư mục (vd <code>admin/call-export</code>). Thư mục con và biến của thư mục đi theo.
            </p>
            <input className="input" autoFocus value={folderEdit.to}
              onChange={(e) => setFolderEdit({ ...folderEdit, to: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && void saveFolderEdit()} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => void saveFolderEdit()}>💾 Lưu</button>
              <button className="ghost" onClick={() => setFolderEdit(null)}>Hủy</button>
            </div>
          </div>
        </div>
      )}

      {transfer && (
        <ApiTransferModal
          data={data}
          initialTab={transfer.tab}
          initialScope={transfer.tab === 'export' ? transfer.scope : ''}
          onImported={(d, r) => {
            setData(d);
            automation.systemNotify('info', '⤓ Đã import collection',
              `${r.added} thêm mới · ${r.overwritten} ghi đè · ${r.skipped} bỏ qua`, 'api');
          }}
          onClose={() => setTransfer(null)}
        />
      )}

      {/* Sửa tên / dự án của request đã lưu */}
      {railEdit && (
        <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && setRailEdit(null)}>
          <div className="mail-compose panel" style={{ width: 'min(480px, 92vw)' }}>
            <div className="mail-compose-head"><b>✎ Sửa request</b><span style={{ flex: 1 }} />
              <button className="ghost sm" onClick={() => setRailEdit(null)}>✕</button></div>
            <input className="input" autoFocus placeholder="Tên request" value={railEdit.name}
              onChange={(e) => setRailEdit({ ...railEdit, name: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && void saveRailEdit()} />
            <input className="input" placeholder="Dự án (optional)" value={railEdit.folder}
              list="api-folders"
              onChange={(e) => setRailEdit({ ...railEdit, folder: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && void saveRailEdit()} />
            <datalist id="api-folders">
              {[...new Set(data.requests.map((r) => r.folder).filter(Boolean))].map((f) => <option key={f} value={f} />)}
            </datalist>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => void saveRailEdit()}>💾 Lưu</button>
              <button className="ghost" onClick={() => setRailEdit(null)}>Hủy</button>
            </div>
          </div>
        </div>
      )}

      {varsOpen && (
        <VarsModal
          data={data}
          projects={allFolderPaths(data.requests)}
          initialScope={varsOpen.scope}
          onSaved={setData}
          onClose={() => setVarsOpen(null)}
        />
      )}
    </div>
    </VarSuggestProvider>
  );
}

function requestToDraft(r: ApiRequest): Draft {
  return {
    id: r.id, name: r.name, folder: r.folder, method: r.method, url: r.url,
    headers: r.headers.length ? r.headers : [{ key: '', value: '' }],
    body: r.body, bodyType: r.bodyType,
    form: r.form?.length ? r.form : [{ key: '', value: '', kind: 'text' }],
    params: r.params, auth: r.auth, opts: r.opts,
  };
}

function defaultName(d: Draft): string {
  try { return `${d.method} ${new URL(d.url).pathname}`; } catch { return `${d.method} request`; }
}
