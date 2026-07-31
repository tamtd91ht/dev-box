'use client';

// API Explorer — project-NEUTRAL engine. Everything project-specific comes from
// registered integration packs (devbox.api.json in the project's own repo):
// service list, spec paths, auth modes, flows. The operator registers packs by
// folder in the rail; per-(pack, service) connection config persists through
// the same on-disk store the Webhooks tab uses (key "<pack>:<service>").
//
// Explore = pick endpoint → EndpointForm (proxy call, curl preview).
// Flows   = manifest-defined chained requests with {{var}} capture (FlowRunner).

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Endpoint, Flow, ServiceCatalog } from '@/lib/types';
import EndpointForm from '@/components/EndpointForm';
import FlowRunner from '@/components/FlowRunner';
import {
  resolveAuth,
  authReady as isAuthReady,
  authModeLabel,
  generateAgentToken,
  type AuthMode,
} from '@/lib/request';
import {
  fetchFullConfig,
  saveLocalConfig,
  saveGlobalVars,
  type LocalConfig,
  type GlobalVars,
} from '@/lib/persist';

const LAST_PACK_KEY = 'devbox.api.lastPack';

interface ManifestService {
  id: string;
  label: string;
  blurb?: string;
  authMode: AuthMode;
  spec: string;
  defaultBaseUrl?: string;
  apiPrefix?: string;
}

interface IntegrationView {
  id: string;
  name: string;
  root: string;
  manifest?: { name: string; services: ManifestService[]; flows: Flow[] };
  manifestError?: string;
}

async function mutateIntegration(method: 'POST' | 'PUT' | 'DELETE', body: Record<string, unknown>): Promise<IntegrationView[]> {
  const r = await fetch('/api/api-integrations', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return (data as { integrations: IntegrationView[] }).integrations;
}

export default function ApiExplorerWorkspace() {
  const [integrations, setIntegrations] = useState<IntegrationView[] | null>(null);
  const [activePackId, setActivePackId] = useState('');
  const [activeServiceId, setActiveServiceId] = useState('');
  const [section, setSection] = useState<'explore' | 'flows'>('explore');
  const [manageOpen, setManageOpen] = useState(false);
  const [formName, setFormName] = useState('');
  const [formRoot, setFormRoot] = useState('');
  const [formBusy, setFormBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Catalog per (pack, service)
  const [catalog, setCatalog] = useState<ServiceCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedOp, setSelectedOp] = useState<string | null>(null);
  const [selectedFlow, setSelectedFlow] = useState<string | null>(null);

  // Persisted config (shared store with the Webhooks tab)
  const [saved, setSaved] = useState<LocalConfig>({});
  const [global, setGlobal] = useState<GlobalVars>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mintTenant, setMintTenant] = useState('');
  const [mintMsg, setMintMsg] = useState<string | null>(null);
  const [mintBusy, setMintBusy] = useState(false);

  useEffect(() => {
    fetchFullConfig().then((cfg) => { setSaved(cfg.services); setGlobal(cfg.global); }).catch(() => {});
  }, []);

  const loadIntegrations = useCallback(async () => {
    try {
      const r = await fetch('/api/api-integrations');
      const data = await r.json();
      const list = (data.integrations ?? []) as IntegrationView[];
      setIntegrations(list);
      setActivePackId((cur) => {
        const remembered = typeof window !== 'undefined' ? window.localStorage.getItem(LAST_PACK_KEY) ?? '' : '';
        const pick = [cur, remembered].find((id) => id && list.some((i) => i.id === id));
        return pick || list[0]?.id || '';
      });
    } catch (e) { setError((e as Error).message); setIntegrations([]); }
  }, []);

  useEffect(() => { void loadIntegrations(); }, [loadIntegrations]);
  useEffect(() => {
    if (activePackId && typeof window !== 'undefined') window.localStorage.setItem(LAST_PACK_KEY, activePackId);
  }, [activePackId]);

  const pack = useMemo(() => integrations?.find((i) => i.id === activePackId) ?? null, [integrations, activePackId]);
  const services = pack?.manifest?.services ?? [];
  const service = services.find((s) => s.id === activeServiceId) ?? services[0] ?? null;

  // Keep activeServiceId valid when the pack changes.
  useEffect(() => {
    if (!pack) return;
    const svcs = pack.manifest?.services ?? [];
    if (!svcs.some((s) => s.id === activeServiceId)) setActiveServiceId(svcs[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePackId, integrations]);

  // ── Per-(pack, service) connection config ──────────────────────────────────
  const cfgKey = pack && service ? `${pack.id}:${service.id}` : '';
  const svcCfg = (cfgKey && saved[cfgKey]) || {};
  const baseUrl = svcCfg.baseUrl || service?.defaultBaseUrl || '';
  const apiPrefix = svcCfg.apiPrefix ?? service?.apiPrefix ?? '';
  const authMode: AuthMode = service?.authMode ?? 'apikey';
  const auth = useMemo(
    () => resolveAuth(authMode, { token: svcCfg.token, toolKey: svcCfg.toolKey, toolSecret: svcCfg.toolSecret }, global),
    [authMode, svcCfg.token, svcCfg.toolKey, svcCfg.toolSecret, global],
  );
  const credsReady = isAuthReady(auth);

  function patchSvcCfg(patch: Record<string, string>) {
    if (!cfgKey) return;
    setSaved((prev) => ({ ...prev, [cfgKey]: { ...(prev[cfgKey] ?? {}), ...patch } }));
    const disk: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(patch)) disk[k] = v.trim() ? v.trim() : null;
    saveLocalConfig(cfgKey, disk).catch(() => {});
  }

  function patchGlobal(key: keyof GlobalVars, value: string) {
    setGlobal((prev) => ({ ...prev, [key]: value }));
    saveGlobalVars({ [key]: value.trim() ? value.trim() : null }).catch(() => {});
  }

  // ── Catalog + flows ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!pack || !service) { setCatalog(null); return; }
    let cancelled = false;
    setCatalog(null); setLoadError(null); setSelectedOp(null);
    fetch(`/api/api-catalog?integration=${encodeURIComponent(pack.id)}&service=${encodeURIComponent(service.id)}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.detail || data.error || `HTTP ${r.status}`);
        return data as ServiceCatalog;
      })
      .then((data) => {
        if (cancelled) return;
        setCatalog(data);
        setSelectedOp(data.endpoints[0]?.operationId ?? null);
      })
      .catch((err) => { if (!cancelled) setLoadError(String(err)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pack?.id, service?.id]);

  const flows = useMemo(
    () => (pack?.manifest?.flows ?? []).filter((f) => f.service === service?.id),
    [pack, service],
  );
  useEffect(() => { setSelectedFlow(flows[0]?.id ?? null); }, [flows]);

  const grouped = useMemo(() => {
    const g = new Map<string, Endpoint[]>();
    for (const e of catalog?.endpoints ?? []) {
      if (!g.has(e.group)) g.set(e.group, []);
      g.get(e.group)!.push(e);
    }
    return Array.from(g.entries());
  }, [catalog]);

  const activeEndpoint = catalog?.endpoints.find((e) => e.operationId === selectedOp) ?? null;
  const activeFlow = flows.find((f) => f.id === selectedFlow) ?? null;
  const globalVarKey: keyof GlobalVars | null =
    authMode === 'apikey' ? 'API_KEY'
      : authMode === 'jwt-user' ? 'JWT_TOKEN_USER'
        : authMode === 'jwt-agent' ? 'JWT_TOKEN_AGENT'
          : authMode === 'jwt-admin' ? 'JWT_TOKEN_ADMIN' : null;

  if (integrations === null) {
    return <div className="panel" style={{ margin: 'auto' }}><span className="spinner" /> Đang tải…</div>;
  }

  return (
    <div className="apix-layout">
      {/* ── Rail: integration packs + services ─────────────────────────── */}
      <aside className="panel">
        <div className="status-line" style={{ justifyContent: 'space-between' }}>
          <strong>API packs</strong>
          <button className="chip-btn" onClick={() => { setManageOpen((v) => !v); setFormName(''); setFormRoot(''); }}>
            {manageOpen ? '✕ Đóng' : '+ Thêm'}
          </button>
        </div>

        {integrations.length === 0 && !manageOpen && (
          <p className="empty" style={{ marginTop: 10 }}>
            Chưa có integration pack nào. Bấm “+ Thêm” và trỏ tới folder repo có <code>devbox.api.json</code>
            (ví dụ omicx-local-all-in-one).
          </p>
        )}

        {integrations.map((i) => (
          <div key={i.id} style={{ marginTop: 8 }}>
            <div
              className={`apix-pack-row${i.id === activePackId ? ' active' : ''}`}
              onClick={() => setActivePackId(i.id)}
              title={i.root}
            >
              <span className="apix-pack-name">▤ {i.manifest?.name ?? i.name}</span>
              {i.manifestError
                ? <span className="badge" style={{ color: 'var(--err)' }} title={i.manifestError}>manifest lỗi</span>
                : <span className="badge">{i.manifest?.services.length ?? 0} svc</span>}
              <button
                className="chip-btn"
                title="Xoá pack khỏi registry"
                onClick={async (e) => {
                  e.stopPropagation();
                  try { setIntegrations(await mutateIntegration('DELETE', { id: i.id })); }
                  catch (err) { setError((err as Error).message); }
                }}
              >✕</button>
            </div>
            {i.id === activePackId && !i.manifestError && (
              <ul className="apix-svc-list">
                {(i.manifest?.services ?? []).map((s) => (
                  <li key={s.id}>
                    <button
                      className={`apix-svc-item${service?.id === s.id ? ' active' : ''}`}
                      title={s.blurb ?? s.id}
                      onClick={() => setActiveServiceId(s.id)}
                    >
                      {s.label}
                      <span className="apix-svc-auth">{s.authMode}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}

        {manageOpen && (
          <div className="apix-form">
            <label className="apix-field"><span>Tên</span>
              <input className="input" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="OMICX" />
            </label>
            <label className="apix-field"><span>Folder chứa devbox.api.json</span>
              <input className="input mono" value={formRoot} onChange={(e) => setFormRoot(e.target.value)}
                placeholder="D:/works/vihat/sources/omicx/omicx-local-all-in-one" />
            </label>
            <div className="status-line" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button className="ghost sm" onClick={() => setManageOpen(false)}>Huỷ</button>
              <button
                className="sm"
                disabled={formBusy || !formName.trim() || !formRoot.trim()}
                onClick={async () => {
                  setFormBusy(true); setError(null);
                  try {
                    const list = await mutateIntegration('POST', { name: formName, root: formRoot });
                    setIntegrations(list);
                    setActivePackId(list[list.length - 1]?.id ?? '');
                    setManageOpen(false);
                  } catch (e) { setError((e as Error).message); }
                  finally { setFormBusy(false); }
                }}
              >Thêm</button>
            </div>
          </div>
        )}
      </aside>

      {/* ── Main: settings + explore/flows ─────────────────────────────── */}
      <main className="panel apix-main">
        {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}

        {!pack || !service ? (
          <p className="empty" style={{ margin: 'auto' }}>Chọn (hoặc thêm) một pack + service để bắt đầu.</p>
        ) : (
          <>
            <div className="status-line" style={{ justifyContent: 'space-between' }}>
              <div className="apix-subnav">
                <button className={section === 'explore' ? 'on' : ''} onClick={() => setSection('explore')}>
                  ▤ Explore{catalog ? ` (${catalog.endpoints.length})` : ''}
                </button>
                <button className={section === 'flows' ? 'on' : ''} onClick={() => setSection('flows')}>
                  ⤳ Flows{flows.length ? ` (${flows.length})` : ''}
                </button>
              </div>
              <button className="chip-btn" onClick={() => setSettingsOpen((v) => !v)} title="Kết nối + credentials cho service này">
                <span className={`kdot ${credsReady ? 'on' : 'off'}`} />
                <span className="kdot-host">{baseUrl ? shortHost(baseUrl) : 'chưa có URL'}</span>
                <span className="cog" aria-hidden>⚙</span>
              </button>
            </div>

            {settingsOpen && (
              <div className="apix-settings">
                <div className="apix-form-row">
                  <label className="apix-field" style={{ flex: 2 }}><span>Base URL</span>
                    <input className="input mono" value={svcCfg.baseUrl ?? ''} placeholder={service.defaultBaseUrl ?? 'http://localhost:8090'}
                      onChange={(e) => patchSvcCfg({ baseUrl: e.target.value })} />
                  </label>
                  <label className="apix-field" style={{ flex: 1 }}><span>API prefix</span>
                    <input className="input mono" value={svcCfg.apiPrefix ?? ''} placeholder={service.apiPrefix ?? '/api'}
                      onChange={(e) => patchSvcCfg({ apiPrefix: e.target.value })} />
                  </label>
                </div>

                <div className="apix-form-row">
                  {authMode === 'tool' ? (
                    <>
                      <label className="apix-field" style={{ flex: 1 }}><span>X-KEY</span>
                        <input className="input mono" value={svcCfg.toolKey ?? ''} onChange={(e) => patchSvcCfg({ toolKey: e.target.value })} />
                      </label>
                      <label className="apix-field" style={{ flex: 1 }}><span>X-VALUE</span>
                        <input className="input mono" type="password" value={svcCfg.toolSecret ?? ''} onChange={(e) => patchSvcCfg({ toolSecret: e.target.value })} />
                      </label>
                    </>
                  ) : (
                    <>
                      <label className="apix-field" style={{ flex: 1 }}>
                        <span>{authModeLabel(authMode)} — global {globalVarKey}</span>
                        <input className="input mono" type="password" value={(globalVarKey && global[globalVarKey]) ?? ''}
                          placeholder="dùng chung mọi service cùng mode"
                          onChange={(e) => globalVarKey && patchGlobal(globalVarKey, e.target.value)} />
                      </label>
                      <label className="apix-field" style={{ flex: 1 }}><span>Override riêng service này (tuỳ chọn)</span>
                        <input className="input mono" type="password" value={svcCfg.token ?? ''}
                          onChange={(e) => patchSvcCfg({ token: e.target.value })} />
                      </label>
                    </>
                  )}
                </div>

                {(authMode === 'jwt-agent' || authMode === 'jwt-admin') && (
                  <div className="apix-form-row" style={{ alignItems: 'flex-end' }}>
                    <label className="apix-field" style={{ flex: 1 }}><span>Mint agent token (tenantId / domain — qua tool-service đã cấu hình ở tab Webhooks)</span>
                      <input className="input mono" value={mintTenant} onChange={(e) => setMintTenant(e.target.value)} placeholder="t_123 hoặc quidn" />
                    </label>
                    <button
                      className="ghost sm"
                      disabled={mintBusy || !mintTenant.trim()}
                      onClick={async () => {
                        setMintBusy(true); setMintMsg(null);
                        const r = await generateAgentToken(mintTenant.trim());
                        if (r.token && globalVarKey) {
                          patchGlobal(globalVarKey, r.token);
                          setMintMsg(`OK — token đã lưu vào ${globalVarKey} (tenant ${r.tenantId ?? '?'})`);
                        } else setMintMsg(`Lỗi: ${r.error ?? 'không nhận được token'}`);
                        setMintBusy(false);
                      }}
                    >{mintBusy ? <span className="spinner" aria-hidden /> : '🔑'} Mint</button>
                  </div>
                )}
                {mintMsg && <div className="badge">{mintMsg}</div>}
              </div>
            )}

            {loadError && <div className="warn-box">Failed to load catalog: {loadError}</div>}

            {section === 'explore' && (
              <div className="layout">
                <div className="panel">
                  <h3>Endpoints</h3>
                  <div className="endpoint-list">
                    {grouped.map(([group, eps]) => (
                      <div key={group}>
                        <div className="group-title">{group}</div>
                        {eps.map((e) => (
                          <div
                            key={e.operationId}
                            className={`ep-item ${e.operationId === selectedOp ? 'active' : ''}`}
                            onClick={() => setSelectedOp(e.operationId)}
                          >
                            <span className={`method ${e.method}`}>{e.method}</span>
                            <span className="ep-path">{e.path}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                    {!catalog && !loadError && <div className="small">Loading catalog…</div>}
                  </div>
                </div>

                <div className="panel">
                  {activeEndpoint ? (
                    <EndpointForm
                      endpoint={activeEndpoint}
                      baseUrl={baseUrl}
                      apiPrefix={apiPrefix}
                      authMode={authMode}
                      auth={auth}
                      authReady={credsReady}
                    />
                  ) : (
                    <div className="empty">
                      <div className="empty-ico">▤</div>
                      <p>Chọn một endpoint bên trái để build và gửi request.</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {section === 'flows' && (
              <div className="layout">
                <div className="panel">
                  <h3>Flows</h3>
                  <div className="endpoint-list">
                    {flows.map((f) => (
                      <div
                        key={f.id}
                        className={`ep-item ${f.id === selectedFlow ? 'active' : ''}`}
                        onClick={() => setSelectedFlow(f.id)}
                      >
                        <span className="flow-step-title">{f.name}</span>
                      </div>
                    ))}
                    {flows.length === 0 && <div className="small">Pack này chưa khai báo flow cho service {service.label}.</div>}
                  </div>
                </div>

                <div className="panel">
                  {activeFlow && catalog ? (
                    <FlowRunner
                      flow={activeFlow}
                      endpoints={catalog.endpoints}
                      baseUrl={baseUrl}
                      apiPrefix={apiPrefix}
                      authMode={authMode}
                      auth={auth}
                      authReady={credsReady}
                    />
                  ) : (
                    <div className="empty">
                      <div className="empty-ico">⤳</div>
                      <p>Chọn một flow bên trái để chạy chuỗi request nối tiếp.</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/** Trim a base URL to host[:port] for the compact settings chip. */
function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}
