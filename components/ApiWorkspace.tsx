'use client';

// API workspace — Postman-like: dựng/chạy/quản lý HTTP request. Chạy qua proxy
// server (/api/http) nên né CORS. Dán nguyên một lệnh curl để import (lib/
// curlParse). Biến {{var}} lấy từ environment đang chọn (lib/curlParse ->
// resolveVars). Collection + environment lưu per-machine (/api/api-collections).
//
// Bố cục: rail trái = request đã lưu (gom theo folder) + environment picker;
// giữa = builder (method/url + tabs Params/Headers/Body) và response.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  apiGet, apiSaveRequest, apiRemoveRequest, apiSaveEnv, apiRemoveEnv, apiSetActiveEnv, apiSend,
  type ApiData, type ApiRequest, type ApiHeader, type ApiEnvironment, type HttpResult,
} from '@/lib/api';
import { parseCurl, resolveVars } from '@/lib/curlParse';
import { formatText } from '@/lib/format';
import { fmtRel } from '@/lib/google';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const BLANK: Draft = { name: '', method: 'GET', url: '', headers: [{ key: '', value: '' }], body: '', bodyType: 'none' };

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

function methodClass(m: string): string {
  return `api-m api-m--${m.toLowerCase()}`;
}

export default function ApiWorkspace() {
  const [data, setData] = useState<ApiData>({ requests: [], environments: [] });
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [tab, setTab] = useState<'params' | 'headers' | 'body'>('headers');
  const [res, setRes] = useState<HttpResult | null>(null);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [curlText, setCurlText] = useState('');
  const [envEdit, setEnvEdit] = useState<ApiEnvironment | null>(null);
  const [resTab, setResTab] = useState<'body' | 'headers'>('body');

  const reload = useCallback(async () => {
    try { setData(await apiGet()); } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const activeEnv = data.environments.find((e) => e.id === data.activeEnvId);
  const envMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const v of activeEnv?.vars ?? []) if (v.key.trim()) m[v.key.trim()] = v.value;
    return m;
  }, [activeEnv]);

  // ── Gửi request ────────────────────────────────────────────────────────────
  const send = async () => {
    const url = resolveVars(draft.url, envMap).trim();
    if (!url) { setErr('Nhập URL trước.'); return; }
    setSending(true); setErr(null); setRes(null);
    try {
      const headers = draft.headers
        .filter((h) => h.key.trim() && h.on !== false)
        .map((h) => ({ key: resolveVars(h.key, envMap), value: resolveVars(h.value, envMap) }));
      const r = await apiSend({
        method: draft.method, url, headers,
        body: draft.bodyType === 'none' ? undefined : resolveVars(draft.body, envMap),
      });
      setRes(r); setResTab('body');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  // ── Import curl ──────────────────────────────────────────────────────────────
  const doImport = () => {
    try {
      const p = parseCurl(curlText);
      if (!p.url) { setErr('Không tìm thấy URL trong lệnh curl.'); return; }
      setDraft({
        name: '', method: p.method, url: p.url,
        headers: p.headers.length ? p.headers.map((h) => ({ ...h, on: true })) : [{ key: '', value: '' }],
        body: p.body, bodyType: p.bodyType,
      });
      setTab(p.bodyType === 'none' ? 'headers' : 'body');
      setImportOpen(false); setCurlText(''); setErr(null); setRes(null);
    } catch (e) {
      setErr('Không phân tích được curl: ' + (e as Error).message);
    }
  };

  // ── Collection ───────────────────────────────────────────────────────────────
  const openRequest = (r: ApiRequest) => {
    setDraft({
      id: r.id, name: r.name, folder: r.folder, method: r.method, url: r.url,
      headers: r.headers.length ? r.headers : [{ key: '', value: '' }],
      body: r.body, bodyType: r.bodyType,
    });
    setTab(r.bodyType === 'none' ? 'headers' : 'body'); setRes(null); setErr(null);
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
        if (fresh) setDraft((cur) => ({ ...cur, id: fresh.id, name: fresh.name, folder: fresh.folder }));
      }
    } catch (e) { setErr((e as Error).message); }
  };

  const removeRequest = async (r: ApiRequest) => {
    if (!window.confirm(`Xóa request "${r.name}"?`)) return;
    try { const d = await apiRemoveRequest(r.id); setData(d); if (draft.id === r.id) setDraft(BLANK); }
    catch (e) { setErr((e as Error).message); }
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

  const prettyBody = () => {
    if (!res) return;
    const ct = res.headers['content-type'] ?? '';
    const kind = /json/i.test(ct) ? 'json' : /html/i.test(ct) ? 'html' : /xml/i.test(ct) ? 'xml' : null;
    if (!kind) return;
    const f = formatText(kind, res.body);
    if (f.ok) setRes({ ...res, body: f.text });
  };

  return (
    <div className="panel sheet-panel">
      <div className="api-root">
        {/* ── Rail: collection + environment ── */}
        <aside className="g-rail api-rail">
          <div className="group-title" style={{ margin: '0 4px 6px', display: 'flex', gap: 6 }}>
            <span style={{ flex: 1 }}>Collection</span>
            <button className="ghost sm" onClick={() => { setDraft(BLANK); setRes(null); }} title="Request mới">＋</button>
            <button className="ghost sm" onClick={() => void reload()} title="Tải lại">↻</button>
          </div>
          {grouped.map(([folder, reqs]) => (
            <div key={folder || '_'}>
              {folder && <div className="api-folder">📁 {folder}</div>}
              {reqs.map((r) => (
                <div key={r.id} className={`g-root${draft.id === r.id ? ' on' : ''}`}>
                  <button className="g-root-btn" onClick={() => openRequest(r)} title={r.url}>
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

        {/* ── Builder + response ── */}
        <div className="api-main">
          <div className="api-urlbar">
            <select className={`input ${methodClass(draft.method)}`} style={{ width: 100 }} value={draft.method}
              onChange={(e) => setDraft({ ...draft, method: e.target.value })}>
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <input className="input" style={{ flex: 1 }} placeholder="https://… (dùng {{var}} từ environment)"
              value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && void send()} />
            <button onClick={() => void send()} disabled={sending}>{sending ? '…' : '▶ Send'}</button>
            <button className="ghost sm" onClick={() => void saveRequest()} title="Lưu vào collection">💾</button>
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
                    <button className="ghost sm" onClick={() => { const f = formatText('json', draft.body); if (f.ok) setDraft({ ...draft, body: f.text }); }}>
                      ✨ Format JSON
                    </button>
                  )}
                </div>
                {draft.bodyType !== 'none' && (
                  <textarea className="input api-bodytext" value={draft.body}
                    placeholder={draft.bodyType === 'raw' ? '{ "key": "{{value}}" }' : 'key=value&key2=value2'}
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
                {resTab === 'body' && <button className="ghost sm" onClick={prettyBody} title="Format JSON/XML/HTML">✨</button>}
              </div>
              {resTab === 'body' ? (
                <pre className="api-res-body">{res.body}</pre>
              ) : (
                <pre className="api-res-body">{Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>
              )}
            </div>
          )}
        </div>
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
