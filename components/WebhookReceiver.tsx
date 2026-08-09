'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuthPayload, ProxyResult } from '@/lib/request';

/** A webhook link as returned by tool-service. */
interface WebhookLink {
  id: string;
  name: string;
  url: string;
  responseStatusCode: number;
  /** Header rules the inbound request must match exactly, else 401 + marked invalid. */
  validationHeaders?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

/** One captured inbound request. */
interface CapturedRequest {
  id: string;
  webhookId: string;
  method: string;
  path: string;
  queryString?: string | null;
  headers: Record<string, string>;
  body?: string | null;
  bodyTruncated: boolean;
  sourceIp?: string;
  contentType?: string | null;
  /** false ⇒ the request failed header validation (stored, answered 401). */
  validationPassed?: boolean;
  receivedAt: number;
}

interface Props {
  /** tool-service base URL (e.g. http://localhost:8080/tool-svc). */
  baseUrl: string;
  onBaseUrl: (url: string) => void;
  /** tool-service API prefix (e.g. /api). */
  apiPrefix: string;
  onApiPrefix: (prefix: string) => void;
  /** Static management credentials (X-KEY / X-VALUE). */
  toolKey: string;
  toolSecret: string;
  onCreds: (next: { toolKey?: string; toolSecret?: string }) => void;
  /** Effective auth payload used for proxy calls (creds → global fallback). */
  auth: AuthPayload;
  authReady: boolean;
  /** Effective WS URL (persisted override, or the derived default). */
  wsUrl: string;
  onWsUrl: (url: string) => void;
  /** Public ingest base (persisted override, or derived from baseUrl+apiPrefix).
   *  The copyable webhook URL is `{publicBaseUrl}/tools/hook/{id}`. */
  publicBaseUrl: string;
  onPublicBaseUrl: (url: string) => void;
  /** Settings drawer (connection + socket) open state — kept in the parent so
   *  it survives this pane unmounting on tab switches. The TRIGGER lives here:
   *  connection config is webhooks-scoped, so its chip belongs inside this pane,
   *  never in the global appbar (a mode-dependent chip there makes the header
   *  jump and can push the tab strip out of view). */
  settingsOpen: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
}

/** Trim a base URL to host[:port] for the compact connection chip. */
function chipHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}

/** localStorage key holding this browser's quick webhook id (client-generated). */
import { readLocal, writeLocal } from '@/lib/localKeys';
import { useSplit } from '@/lib/useSplit';
import Splitter from './Splitter';

const QUICK_ID_KEY = 'tool.webhook.quickId';

/** True when `s` is a canonical 36-char UUID — matches the backend's auto-create guard. */
function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
}

/** Generate a UUID, preferring the native crypto API. */
function genUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  // Fallback (non-crypto) — only reached in ancient/insecure contexts.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Build the public ingest URL for an id: `{publicBaseUrl}/tools/hook/{id}`. */
function buildHookUrl(publicBaseUrl: string, id: string): string {
  const base = (publicBaseUrl || '').replace(/\/+$/, '');
  return `${base}/tools/hook/${id}`;
}

/** Simulate-able response status codes offered per link. */
const STATUS_CHOICES = [200, 201, 202, 204, 301, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503];
const MAX_VALIDATION_HEADERS = 20;

type WsState = 'connecting' | 'open' | 'closed';
type ValRow = { name: string; value: string };

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return String(ms);
  }
}

function statusClass(code: number): string {
  return code < 400 ? 'status-2xx' : code < 500 ? 'status-4xx' : 'status-5xx';
}

/** Pretty-print a captured body when it is JSON; otherwise return it verbatim. */
function prettyBody(body: string | null | undefined): string {
  if (!body) return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/**
 * Webhook.site-style receiver for tool-service — a self-contained workspace,
 * independent of the API-explorer service selection. Configure the tool-service
 * connection (base URL, API prefix, X-KEY/X-VALUE) + realtime socket here; create
 * links, copy their public ingest URL, flip the simulated response status, attach
 * header-validation rules, and watch inbound requests stream in live over a native
 * WebSocket. Management calls go through the same-origin /api/proxy (tool auth).
 */
export default function WebhookReceiver({
  baseUrl,
  onBaseUrl,
  apiPrefix,
  onApiPrefix,
  toolKey,
  toolSecret,
  onCreds,
  auth,
  authReady,
  wsUrl,
  onWsUrl,
  publicBaseUrl,
  onPublicBaseUrl,
  settingsOpen,
  onOpenSettings,
  onCloseSettings,
}: Props) {
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const listSplit = useSplit({ varName: '--split-rail', min: 180, max: 560, gap: 18 });
  const [links, setLinks] = useState<WebhookLink[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [captures, setCaptures] = useState<CapturedRequest[]>([]);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wsState, setWsState] = useState<WsState>('closed');
  const [wsDraft, setWsDraft] = useState(wsUrl);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Connection (HTTP) config drafts — saved together via "Lưu kết nối".
  const [httpDraft, setHttpDraft] = useState({ baseUrl, apiPrefix, toolKey, toolSecret });

  // Quick webhook: a per-browser client-generated id (webhook.site-style). The link
  // auto-materializes on first ingest — no create step, no auth needed.
  const [quickId, setQuickId] = useState<string>('');
  const [publicDraft, setPublicDraft] = useState(publicBaseUrl);
  const [quickCopied, setQuickCopied] = useState(false);

  // Per-link header-validation editor rows (seeded from the selected link).
  const [valRows, setValRows] = useState<ValRow[]>([]);
  const [valBusy, setValBusy] = useState(false);
  const [valMsg, setValMsg] = useState('');

  // Socket config: connection test + "save & hold" state.
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testMsg, setTestMsg] = useState('');
  // Bumping this forces the live effect to (re)connect even when the URL is unchanged.
  const [connectNonce, setConnectNonce] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const testWsRef = useRef<WebSocket | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const linksRef = useRef<WebhookLink[]>(links);
  linksRef.current = links;

  useEffect(() => setWsDraft(wsUrl), [wsUrl]);
  useEffect(() => setPublicDraft(publicBaseUrl), [publicBaseUrl]);
  useEffect(
    () => setHttpDraft({ baseUrl, apiPrefix, toolKey, toolSecret }),
    [baseUrl, apiPrefix, toolKey, toolSecret],
  );

  // Load this browser's quick id from localStorage, generating + persisting one on
  // first visit. Runs once on mount (localStorage is browser-only → client effect).
  useEffect(() => {
    let id = '';
    try {
      id = readLocal(QUICK_ID_KEY) ?? '';
    } catch {
      /* storage unavailable (private mode) — fall back to an in-memory id */
    }
    if (!isUuid(id)) {
      id = genUuid();
      writeLocal(QUICK_ID_KEY, id);
    }
    setQuickId(id);
  }, []);

  // Close any lingering test socket on unmount.
  useEffect(() => () => { try { testWsRef.current?.close(); } catch { /* ignore */ } }, []);

  // Close the settings drawer on Escape (matches SettingsDrawer behaviour).
  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseSettings(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen, onCloseSettings]);

  // ── Management calls via the proxy ────────────────────────────────────────
  const proxy = useCallback(
    async (
      method: string,
      path: string,
      opts?: { query?: Record<string, string>; body?: unknown },
    ): Promise<ProxyResult> => {
      const res = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl,
          apiPrefix,
          method,
          path,
          auth,
          query: opts?.query,
          jsonBody: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
        }),
      });
      return res.json();
    },
    [baseUrl, apiPrefix, auth],
  );

  const loadLinks = useCallback(async () => {
    if (!authReady) return;
    setError(null);
    const r = await proxy('GET', '/tools/webhooks', { query: { page: '0', size: '100' } });
    if (r.ok && Array.isArray(r.bodyJson)) {
      setLinks(r.bodyJson as WebhookLink[]);
    } else if (!r.ok) {
      setError(`Load links failed: ${r.status} ${r.statusText || r.error || ''}`);
    }
  }, [proxy, authReady]);

  const loadHistory = useCallback(
    async (id: string) => {
      // History moved to a search-envelope POST (ADR-0007): empty filter, page 1.
      const r = await proxy('POST', `/tools/webhooks/${id}/requests/search`, {
        body: { pagination: { page: 1, size: 100 } },
      });
      if (r.ok && Array.isArray(r.bodyJson)) {
        setCaptures(r.bodyJson as CapturedRequest[]);
      } else {
        setCaptures([]);
      }
    },
    [proxy],
  );

  // Initial + auth-driven link load.
  useEffect(() => {
    loadLinks();
  }, [loadLinks]);

  // Load history for the selected link.
  useEffect(() => {
    if (selectedId) loadHistory(selectedId);
    else setCaptures([]);
  }, [selectedId, loadHistory]);

  // Seed the validation editor when the selection changes (read via ref so saving
  // a link's rules doesn't reset the editor mid-edit).
  useEffect(() => {
    const link = linksRef.current.find((l) => l.id === selectedId);
    const vh = link?.validationHeaders ?? {};
    setValRows(Object.entries(vh).map(([name, value]) => ({ name, value })));
    setValMsg('');
  }, [selectedId]);

  // ── Live WebSocket ────────────────────────────────────────────────────────
  // One connection for the component; reconnects only when the WS URL changes.
  // Link selection is handled by sending subscribe/unsubscribe frames.
  useEffect(() => {
    if (!wsUrl) return;
    let closedByUs = false;
    setWsState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      setWsState('closed');
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      setWsState('open');
      const cur = selectedIdRef.current;
      if (cur) ws.send(JSON.stringify({ action: 'subscribe', webhookId: cur }));
    };
    ws.onmessage = (ev) => {
      let msg: { type?: string; webhookId?: string; data?: CapturedRequest };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'request.captured' && msg.data) {
        if (msg.webhookId === selectedIdRef.current) {
          setCaptures((prev) => [msg.data as CapturedRequest, ...prev]);
        }
      }
    };
    ws.onclose = () => {
      if (!closedByUs) setWsState('closed');
    };
    ws.onerror = () => setWsState('closed');

    return () => {
      closedByUs = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    };
  }, [wsUrl, connectNonce]);

  // On selection change, (un)subscribe over the open socket.
  const prevSubRef = useRef<string | null>(null);
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      prevSubRef.current = selectedId;
      return;
    }
    const prev = prevSubRef.current;
    if (prev && prev !== selectedId) {
      ws.send(JSON.stringify({ action: 'unsubscribe', webhookId: prev }));
    }
    if (selectedId) {
      ws.send(JSON.stringify({ action: 'subscribe', webhookId: selectedId }));
    }
    prevSubRef.current = selectedId;
  }, [selectedId, wsState]);

  // ── Connection (HTTP) config ────────────────────────────────────────────────
  const httpDirty =
    httpDraft.baseUrl !== baseUrl ||
    httpDraft.apiPrefix !== apiPrefix ||
    httpDraft.toolKey !== toolKey ||
    httpDraft.toolSecret !== toolSecret;

  function saveHttp() {
    onBaseUrl(httpDraft.baseUrl.trim());
    onApiPrefix(httpDraft.apiPrefix.trim());
    onCreds({ toolKey: httpDraft.toolKey.trim(), toolSecret: httpDraft.toolSecret.trim() });
  }

  // ── Socket config actions ───────────────────────────────────────────────────
  // Open a throwaway socket to the drafted URL, report success/failure, then close.
  // Does NOT touch the live connection.
  function testConnection() {
    const url = wsDraft.trim();
    if (!url) {
      setTestState('fail');
      setTestMsg('Nhập URL socket trước.');
      return;
    }
    try { testWsRef.current?.close(); } catch { /* ignore */ }
    setTestState('testing');
    setTestMsg('Đang kết nối…');

    let done = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      setTestState('fail');
      setTestMsg('URL socket không hợp lệ.');
      return;
    }
    testWsRef.current = ws;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      setTestState('fail');
      setTestMsg('Hết thời gian chờ (5s) — không kết nối được.');
      try { ws.close(); } catch { /* ignore */ }
    }, 5000);

    ws.onopen = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      setTestState('ok');
      setTestMsg('Kết nối thành công.');
      try { ws.close(); } catch { /* ignore */ }
    };
    ws.onerror = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      setTestState('fail');
      setTestMsg('Không kết nối được tới socket. Kiểm tra URL, tool-service đã chạy và cổng WS mở chưa.');
      try { ws.close(); } catch { /* ignore */ }
    };
  }

  // Persist the drafted URL and (re)connect the live socket, keeping it open.
  function saveWs() {
    const url = wsDraft.trim();
    if (!url) {
      setTestState('fail');
      setTestMsg('Nhập URL socket trước.');
      return;
    }
    setTestState('idle');
    setTestMsg('');
    if (url !== wsUrl) {
      onWsUrl(url); // persist → wsUrl prop changes → live effect reconnects & holds
    } else {
      setConnectNonce((n) => n + 1); // same URL → force reconnect & hold
    }
  }

  // ── Link actions ────────────────────────────────────────────────────────────
  async function createLink() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await proxy('POST', '/tools/webhooks', { body: { name: newName.trim() || undefined } });
    setBusy(false);
    if (!r.ok) {
      setError(`Create failed: ${r.status} ${r.statusText || r.error || ''}`);
      return;
    }
    // Success. Usually the created link comes back as JSON; when it does, insert it
    // and select it. If the proxy couldn't parse a body (e.g. upstream omitted the
    // application/json content-type), the create still succeeded — reload the list
    // from the server rather than falsely reporting a failure.
    const link = r.bodyJson && typeof r.bodyJson === 'object' ? (r.bodyJson as WebhookLink) : null;
    if (link?.id) {
      setLinks((prev) => [link, ...prev]);
      setSelectedId(link.id);
    } else {
      await loadLinks();
    }
    setNewName('');
  }

  async function changeStatus(id: string, code: number) {
    setError(null);
    const r = await proxy('PATCH', `/tools/webhooks/${id}`, { body: { responseStatusCode: code } });
    if (r.ok && r.bodyJson) {
      const updated = r.bodyJson as WebhookLink;
      setLinks((prev) => prev.map((l) => (l.id === id ? updated : l)));
    } else {
      setError(`Update failed: ${r.status} ${r.statusText || r.error || ''}`);
    }
  }

  async function deleteLink(id: string) {
    setError(null);
    const r = await proxy('DELETE', `/tools/webhooks/${id}`);
    if (r.ok || r.status === 204) {
      setLinks((prev) => prev.filter((l) => l.id !== id));
      if (selectedId === id) setSelectedId(null);
    } else {
      setError(`Delete failed: ${r.status} ${r.statusText || r.error || ''}`);
    }
  }

  function copyUrl(link: WebhookLink) {
    navigator.clipboard?.writeText(buildHookUrl(publicBaseUrl, link.id)).then(
      () => {
        setCopiedId(link.id);
        setTimeout(() => setCopiedId((c) => (c === link.id ? null : c)), 1500);
      },
      () => {},
    );
  }

  // ── Quick webhook (per-browser id) actions ────────────────────────────────
  const quickUrl = quickId ? buildHookUrl(publicBaseUrl, quickId) : '';

  function regenerateQuickId() {
    const id = genUuid();
    writeLocal(QUICK_ID_KEY, id);
    setQuickId(id);
    // If we were watching the old quick id, follow the new one so the stream stays on it.
    if (selectedId && !linksRef.current.some((l) => l.id === selectedId)) {
      setSelectedId(id);
    }
  }

  function copyQuickUrl() {
    if (!quickUrl) return;
    navigator.clipboard?.writeText(quickUrl).then(
      () => {
        setQuickCopied(true);
        setTimeout(() => setQuickCopied(false), 1500);
      },
      () => {},
    );
  }

  // Watch the quick id's live stream. The link may not exist server-side yet — it
  // auto-materializes on first ingest — but WS subscribe works by id regardless, and
  // loadHistory simply returns empty until the first request arrives.
  function watchQuickId() {
    if (quickId) setSelectedId(quickId);
  }

  // ── Validation-rule editor actions ──────────────────────────────────────────
  function addValRow() {
    setValRows((prev) => (prev.length >= MAX_VALIDATION_HEADERS ? prev : [...prev, { name: '', value: '' }]));
  }
  function updateValRow(i: number, field: keyof ValRow, v: string) {
    setValRows((prev) => prev.map((row, idx) => (idx === i ? { ...row, [field]: v } : row)));
  }
  function removeValRow(i: number) {
    setValRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function saveValidation() {
    if (!selectedId || valBusy) return;
    const headers: Record<string, string> = {};
    for (const row of valRows) {
      const n = row.name.trim();
      if (n) headers[n] = row.value;
    }
    setValBusy(true);
    setValMsg('');
    const r = await proxy('PATCH', `/tools/webhooks/${selectedId}`, { body: { validationHeaders: headers } });
    setValBusy(false);
    if (r.ok && r.bodyJson) {
      const updated = r.bodyJson as WebhookLink;
      setLinks((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      setValMsg(`Đã lưu ${Object.keys(headers).length} quy tắc validate.`);
    } else {
      setValMsg(`Lưu thất bại: ${r.status} ${r.statusText || r.error || ''}`);
    }
  }

  const selected = links.find((l) => l.id === selectedId) ?? null;
  const wsDotClass = wsState === 'open' ? 'on' : wsState === 'connecting' ? 'checking' : 'off';
  const wsDirty = wsDraft.trim() !== wsUrl;
  const publicDirty = publicDraft.trim() !== publicBaseUrl;
  // We're watching the quick id when it's selected but isn't one of the managed links.
  const watchingQuick = !!quickId && selectedId === quickId && !selected;
  const testColor =
    testState === 'ok' ? 'var(--ok)' : testState === 'fail' ? 'var(--err)' : 'var(--muted)';

  const ruleCount = useMemo(
    () => valRows.filter((r) => r.name.trim()).length,
    [valRows],
  );
  // Rules currently persisted on the selected link (for the "unsaved" hint).
  const savedRuleCount = selected ? Object.keys(selected.validationHeaders ?? {}).length : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      {/* ── Quick webhook: per-browser id, no auth, auto-created on first hit ─ */}
      <div className="panel" style={{ borderColor: 'var(--accent, #6c8cff)' }}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>URL webhook của bạn</h3>
          <span className="badge info" title="Id lưu theo trình duyệt này">theo trình duyệt</span>
          {/* Connection chip — webhooks-scoped config, so it lives in this pane
              (moved out of the global appbar where it destabilized the tab strip). */}
          <button
            className="chip-btn"
            onClick={onOpenSettings}
            title="Cài đặt kết nối tool-service + realtime socket"
          >
            <span className={`kdot ${authReady ? 'on' : 'off'}`} />
            <span className="kdot-host">{chipHost(baseUrl)}</span>
            <span className="cog" aria-hidden>⚙</span>
          </button>
        </div>

        <div className="small" style={{ color: 'var(--muted)', marginBottom: 10 }}>
          Id này được <b>tạo & lưu trong trình duyệt của bạn</b> (không cần đăng nhập). Copy URL rồi
          gửi webhook vào đó — link <b>tự sinh</b> ở request đầu tiên, không cần bấm “Create”. Bấm
          <b> “Xem live”</b> để theo dõi request đổ về ngay bên dưới.
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <code
            className="small"
            title={quickUrl}
            style={{
              flex: '1 1 320px', minWidth: 240, padding: '8px 10px',
              background: 'var(--panel-2, rgba(127,127,127,.08))', borderRadius: 6,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontFamily: 'var(--mono)',
            }}
          >
            {quickUrl || 'Đang tạo id…'}
          </code>
          <button className="sm" onClick={copyQuickUrl} disabled={!quickUrl} title="Copy URL webhook">
            {quickCopied ? '✓ Đã copy' : 'Copy URL'}
          </button>
          <button
            className={watchingQuick ? 'sm' : 'ghost sm'}
            onClick={watchQuickId}
            disabled={!quickId}
            title="Theo dõi request đổ về id này"
          >
            {watchingQuick ? '● Đang xem live' : 'Xem live'}
          </button>
          <button
            className="ghost sm"
            onClick={regenerateQuickId}
            title="Tạo id mới (URL cũ sẽ ngừng dùng ở trình duyệt này)"
          >
            ↻ Id mới
          </button>
        </div>

        {/* Public ingest base — the host external senders reach (may differ from mgmt base). */}
        <details style={{ marginTop: 10 }}>
          <summary className="small" style={{ cursor: 'pointer', userSelect: 'none', color: 'var(--muted)' }}>
            Public base URL {publicDirty && <span className="badge warn" style={{ marginLeft: 6 }}>chưa lưu</span>}
          </summary>
          <div className="small" style={{ color: 'var(--muted)', margin: '8px 0' }}>
            Host mà bên ngoài gọi tới để bắn webhook (thường là ingress riêng, vd
            <code> https://socket.xyz.com</code>). URL = <code>{'{base}'}/tools/hook/{'{id}'}</code>.
            Bỏ trống ⇒ suy từ Base URL + API prefix.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              value={publicDraft}
              onChange={(e) => setPublicDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onPublicBaseUrl(publicDraft.trim())}
              placeholder="https://socket.xyz.com hoặc http://localhost:8080/tool-svc/api"
              style={{ flex: 1, minWidth: 260, fontFamily: 'var(--mono)', fontSize: 12 }}
            />
            <button
              className="sm"
              onClick={() => onPublicBaseUrl(publicDraft.trim())}
              disabled={!publicDirty}
              title="Lưu public base URL"
            >
              Lưu
            </button>
          </div>
        </details>
      </div>

    <div className="layout" ref={listSplit.ref} style={listSplit.style}>
      {/* ── Left: link list + create ─────────────────────────────────────── */}
      <div className="panel">
        <h3>Webhook links</h3>

        {!authReady && (
          <div className="badge warn" style={{ marginBottom: 12 }}>
            Mở ⚙ Cài đặt (góc phải) và nhập Tool key + secret để quản lý link.
          </div>
        )}

        <div className="field-row" style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            placeholder="Link name (optional)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createLink()}
            disabled={!authReady || busy}
            style={{ flex: 1 }}
          />
          <button className="sm" onClick={createLink} disabled={!authReady || busy}>
            + Create
          </button>
        </div>

        {error && (
          <pre className="code" style={{ color: 'var(--err)', marginBottom: 12 }}>{error}</pre>
        )}

        <div className="endpoint-list">
          {links.map((l) => {
            const rules = Object.keys(l.validationHeaders ?? {}).length;
            return (
            <div
              key={l.id}
              className={`ep-item ${l.id === selectedId ? 'active' : ''}`}
              onClick={() => setSelectedId(l.id)}
              style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="ep-path" style={{ flex: 1, fontWeight: 600 }}>{l.name}</span>
                {rules > 0 && (
                  <span className="badge info" title={`${rules} header validate`}>🔒 {rules}</span>
                )}
                <span className={`status-code ${statusClass(l.responseStatusCode)}`}>
                  {l.responseStatusCode}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <code className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {buildHookUrl(publicBaseUrl, l.id)}
                </code>
                <button
                  className="ghost sm"
                  onClick={(e) => { e.stopPropagation(); copyUrl(l); }}
                  title="Copy public URL"
                >
                  {copiedId === l.id ? '✓' : 'copy'}
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <label className="small" style={{ color: 'var(--muted)' }}>Respond</label>
                <select
                  value={l.responseStatusCode}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => changeStatus(l.id, Number(e.target.value))}
                  disabled={!authReady}
                  style={{ padding: '4px 8px', fontSize: 12 }}
                >
                  {STATUS_CHOICES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <span style={{ flex: 1 }} />
                <button
                  className="ghost sm"
                  onClick={(e) => { e.stopPropagation(); deleteLink(l.id); }}
                  title="Delete link"
                  disabled={!authReady}
                >
                  delete
                </button>
              </div>
            </div>
            );
          })}
          {links.length === 0 && authReady && (
            <div className="small">No links yet — create one to get a public URL.</div>
          )}
        </div>
      </div>

      {/* ── Right: validation rules + captured requests stream ───────────── */}
      <div className="panel">
        {(selected || watchingQuick) ? (
          <>
            <div className="status-line">
              <h3 style={{ margin: 0, flex: 1 }}>
                {selected ? selected.name : 'URL webhook của bạn'}
                {watchingQuick && (
                  <span className="badge info" style={{ marginLeft: 8 }}>quick</span>
                )}
              </h3>
              <span className={`kdot ${wsDotClass}`} />
              <span className="small">{wsState === 'open' ? 'live' : wsState}</span>
              <button className="ghost sm" onClick={() => selectedId && loadHistory(selectedId)}>reload</button>
            </div>

            {watchingQuick && (
              <div className="small" style={{ color: 'var(--muted)', margin: '6px 0 4px' }}>
                Đang theo dõi id trình duyệt. Link tự sinh khi có request đầu tiên; chỉnh status/validate
                được sau đó ở danh sách bên trái (cần đăng nhập tool-service).
              </div>
            )}

            {/* Header-validation rules editor — only for a real managed link. */}
            {selected && (
            <details className="wh-rules" style={{ margin: '10px 0 14px' }}>
              <summary className="small" style={{ cursor: 'pointer', userSelect: 'none' }}>
                Header validate{' '}
                <span className="badge info">{savedRuleCount}</span>
                {ruleCount !== savedRuleCount && <span className="badge warn" style={{ marginLeft: 6 }}>chưa lưu</span>}
              </summary>

              <div className="small" style={{ color: 'var(--muted)', margin: '8px 0 10px' }}>
                Request phải chứa <b>đúng</b> các header dưới đây (tên không phân biệt hoa/thường, giá trị khớp chính xác).
                Không khớp ⇒ trả <b>401</b> và vẫn lưu, đánh dấu <span style={{ color: 'var(--err)' }}>invalid</span>.
                Bỏ trống ⇒ không validate.
              </div>

              {valRows.map((row, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                  <input
                    type="text"
                    value={row.name}
                    onChange={(e) => updateValRow(i, 'name', e.target.value)}
                    placeholder="Header name (vd: X-Signature)"
                    style={{ flex: '1 1 40%', fontFamily: 'var(--mono)', fontSize: 12 }}
                  />
                  <span className="small" style={{ color: 'var(--muted)' }}>=</span>
                  <input
                    type="text"
                    value={row.value}
                    onChange={(e) => updateValRow(i, 'value', e.target.value)}
                    placeholder="Expected value"
                    style={{ flex: '1 1 40%', fontFamily: 'var(--mono)', fontSize: 12 }}
                  />
                  <button className="ghost sm" onClick={() => removeValRow(i)} title="Xoá quy tắc">✕</button>
                </div>
              ))}

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                <button
                  className="ghost sm"
                  onClick={addValRow}
                  disabled={valRows.length >= MAX_VALIDATION_HEADERS}
                  title={valRows.length >= MAX_VALIDATION_HEADERS ? `Tối đa ${MAX_VALIDATION_HEADERS} quy tắc` : 'Thêm quy tắc'}
                >
                  + Thêm header
                </button>
                <button className="sm" onClick={saveValidation} disabled={valBusy || !authReady}>
                  {valBusy ? 'Đang lưu…' : 'Lưu validate'}
                </button>
                {valMsg && (
                  <span className="small" style={{ color: valMsg.startsWith('Lưu thất bại') ? 'var(--err)' : 'var(--ok)' }}>
                    {valMsg}
                  </span>
                )}
              </div>
            </details>
            )}

            {captures.length === 0 && (
              <div className="empty">
                <div className="empty-ico">⚡</div>
                <p>Đang chờ request. Gửi một request tới <code className="small">{selected ? buildHookUrl(publicBaseUrl, selected.id) : quickUrl}</code> và nó hiện ở đây ngay.</p>
              </div>
            )}

            {captures.map((c) => (
              <div className="resp" key={c.id}>
                <div className="status-line">
                  <span className={`method ${c.method}`}>{c.method}</span>
                  <span className="ep-path" style={{ flex: 1 }}>{c.path}{c.queryString ? `?${c.queryString}` : ''}</span>
                  {c.validationPassed === false && (
                    <span className="badge err" title="Header validate không khớp — trả 401">✕ 401 · validate fail</span>
                  )}
                  <span className="small">{fmtTime(c.receivedAt)}</span>
                </div>
                <div className="small" style={{ marginBottom: 8 }}>
                  from {c.sourceIp || 'unknown'}
                  {c.contentType ? ` · ${c.contentType}` : ''}
                  {c.bodyTruncated ? ' · body truncated' : ''}
                </div>
                {c.body && <pre className="code">{prettyBody(c.body)}</pre>}
                <details style={{ marginTop: 8 }}>
                  <summary className="small">Headers ({Object.keys(c.headers || {}).length})</summary>
                  <pre className="code">{JSON.stringify(c.headers, null, 2)}</pre>
                </details>
              </div>
            ))}
          </>
        ) : (
          <div className="empty">
            <div className="empty-ico">⚡</div>
            <p>Bấm <b>“Xem live”</b> ở khối trên để theo dõi URL webhook của bạn, hoặc chọn một link ở danh sách bên trái.</p>
          </div>
        )}
      </div>
      <Splitter {...listSplit.grip} />
    </div>

      {/* ── Settings drawer: connection + realtime socket ─────────────────── */}
      <div className={`drawer-backdrop ${settingsOpen ? 'show' : ''}`} onClick={onCloseSettings} />
      <div className={`drawer ${settingsOpen ? 'open' : ''}`} role="dialog" aria-label="Webhook settings">
        <div className="drawer-head">
          <h3>Cài đặt Webhook</h3>
          <button className="theme-toggle" onClick={onCloseSettings} aria-label="Đóng cài đặt">
            ✕
          </button>
        </div>

        <div className="drawer-body">
          {/* ── Connection: tool-service HTTP config ─────────────────────── */}
          <div className="status-line" style={{ marginBottom: 10 }}>
            <h3 style={{ margin: 0, flex: 1 }}>Kết nối tool-service</h3>
            <span className={`kdot ${authReady ? 'on' : 'off'}`} />
            <span className="small">{authReady ? 'có credential' : 'thiếu X-KEY/X-VALUE'}</span>
          </div>

          <div className="field-row">
            <label>Base URL</label>
            <input
              type="text"
              value={httpDraft.baseUrl}
              onChange={(e) => setHttpDraft((d) => ({ ...d, baseUrl: e.target.value }))}
              placeholder="http://localhost:8080/tool-svc"
              style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
            />
          </div>
          <div className="field-row">
            <label>API prefix</label>
            <input
              type="text"
              value={httpDraft.apiPrefix}
              onChange={(e) => setHttpDraft((d) => ({ ...d, apiPrefix: e.target.value }))}
              placeholder="/api"
              style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
            />
            <span className="small" style={{ marginTop: 6, display: 'block', color: 'var(--muted)' }}>
              Lưu Base URL / API prefix cũng sẽ cập nhật <b>URL webhook</b> ở trên (khi chưa đặt Public base URL riêng).
            </span>
          </div>
          <div className="field-row">
            <label>X-KEY</label>
            <input
              type="text"
              value={httpDraft.toolKey}
              onChange={(e) => setHttpDraft((d) => ({ ...d, toolKey: e.target.value }))}
              placeholder="tool key"
              style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
            />
          </div>
          <div className="field-row">
            <label>X-VALUE</label>
            <input
              type="password"
              value={httpDraft.toolSecret}
              onChange={(e) => setHttpDraft((d) => ({ ...d, toolSecret: e.target.value }))}
              placeholder="tool secret"
              style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
            <button className="sm" onClick={saveHttp} disabled={!httpDirty} title="Lưu cấu hình kết nối">
              Lưu kết nối
            </button>
            {httpDirty && <span className="badge warn">Chưa lưu</span>}
          </div>

          <div className="drawer-divider" />

          {/* ── Realtime socket: URL + test + save & hold ─────────────────── */}
          <div className="status-line" style={{ marginBottom: 10 }}>
            <h3 style={{ margin: 0, flex: 1 }}>Realtime socket</h3>
            <span className={`kdot ${wsDotClass}`} title={`WebSocket ${wsState}`} />
            <span className="small">
              {wsState === 'open' ? 'đang giữ kết nối' : wsState === 'connecting' ? 'đang kết nối…' : 'chưa kết nối'}
            </span>
          </div>

          <div className="field-row">
            <label>WebSocket URL</label>
            <input
              type="text"
              value={wsDraft}
              onChange={(e) => {
                setWsDraft(e.target.value);
                if (testState !== 'idle') { setTestState('idle'); setTestMsg(''); }
              }}
              onKeyDown={(e) => e.key === 'Enter' && saveWs()}
              placeholder="ws://localhost:9090/ws/webhooks"
              style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="ghost sm"
              onClick={testConnection}
              disabled={testState === 'testing' || !wsDraft.trim()}
              title="Mở thử kết nối tới socket rồi đóng lại"
            >
              {testState === 'testing' ? 'Đang thử…' : 'Thử kết nối'}
            </button>
            <button
              className="sm"
              onClick={saveWs}
              disabled={!wsDraft.trim()}
              title="Lưu URL và giữ kết nối realtime"
            >
              {wsDirty ? 'Lưu & giữ kết nối' : 'Kết nối lại'}
            </button>
          </div>
          <div className="small" style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {testMsg && <span style={{ color: testColor }}>{testMsg}</span>}
            {wsDirty && <span className="badge warn">Chưa lưu</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
