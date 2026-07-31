'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Endpoint } from '@/lib/types';
import { callEndpoint, fetchCurl, type AuthPayload, type ProxyResult } from '@/lib/request';
import { joinPath } from '@/lib/proxyCore';
import type { AuthMode } from '@/lib/request';
import ResponseView from './ResponseView';

interface Props {
  endpoint: Endpoint;
  baseUrl: string;
  /** API prefix (e.g. /api) reconciled against the endpoint's openapi path. */
  apiPrefix?: string;
  authMode: AuthMode;
  /** Resolved auth (per-service override or global) for this service. */
  auth: AuthPayload;
  /** Whether `auth` has everything its mode needs. */
  authReady: boolean;
}

export default function EndpointForm({ endpoint, baseUrl, apiPrefix, authMode, auth, authReady }: Props) {
  const [body, setBody] = useState(endpoint.bodyExample ?? '');
  const [query, setQuery] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [languageCode, setLanguageCode] = useState('vi-VN');
  const [result, setResult] = useState<ProxyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [curl, setCurl] = useState<{ text: string; note?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset form state whenever the selected endpoint changes.
  useEffect(() => {
    setBody(endpoint.bodyExample ?? '');
    const q: Record<string, string> = {};
    for (const p of endpoint.queryParams) {
      q[p.name] = p.default !== undefined ? String(p.default) : '';
    }
    setQuery(q);
    setFile(null);
    setResult(null);
    setCurl(null);
    setCopied(false);
  }, [endpoint]);

  /** Build the query object exactly as `send` does (non-empty values only). */
  function currentQuery(): Record<string, string> {
    return Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ''));
  }

  async function exportCurl() {
    setCopied(false);
    try {
      const { curl: text, note } = await fetchCurl({
        baseUrl,
        apiPrefix,
        auth,
        endpoint,
        query: currentQuery(),
        jsonBody: endpoint.bodyKind === 'json' ? body : undefined,
        file,
        languageCode,
      });
      setCurl({ text, note });
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
      } catch {
        /* clipboard blocked (e.g. non-HTTPS) — the textarea below still lets the user copy */
      }
    } catch {
      setCurl({ text: '# Failed to build curl command.' });
    }
  }

  const canSend = useMemo(() => {
    if (endpoint.security && !authReady) return false;
    if (!baseUrl) return false;
    return true;
  }, [endpoint, authReady, baseUrl]);

  // Resolved URL preview (base + path + non-empty query) so the panel shows
  // exactly what will be called — useful even for parameterless endpoints.
  const resolvedUrl = useMemo(() => {
    const base = (baseUrl || '').replace(/\/+$/, '');
    const params = Object.entries(query).filter(([, v]) => v !== '');
    const qs = params.length
      ? '?' + params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
      : '';
    return `${base}${joinPath(apiPrefix, endpoint.path)}${qs}`;
  }, [baseUrl, apiPrefix, endpoint.path, query]);

  async function send() {
    setLoading(true);
    setResult(null);
    try {
      const res = await callEndpoint({
        baseUrl,
        apiPrefix,
        auth,
        endpoint,
        query: currentQuery(),
        jsonBody: endpoint.bodyKind === 'json' ? body : undefined,
        file,
        languageCode,
      });
      setResult(res);
    } catch (err) {
      setResult({ ok: false, status: 0, statusText: 'CLIENT_ERROR', detail: String(err) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="ep-head">
        <div className="status-line" style={{ marginBottom: 0 }}>
          <span className={`method ${endpoint.method}`}>{endpoint.method}</span>
          <span className="ep-path">{endpoint.path}</span>
          {!endpoint.security && <span className="badge noauth">no auth</span>}
          {endpoint.requiredScope && <span className="badge scope">{endpoint.requiredScope}</span>}
          {endpoint.billable && <span className="badge warn">billable</span>}
        </div>
        {endpoint.summary && <p className="hint" style={{ margin: '8px 0 0' }}>{endpoint.summary}</p>}
        <div className="url-bar" title={resolvedUrl}>
          <span className={`url-verb ${endpoint.method}`}>{endpoint.method}</span>
          <code className="url-text">{resolvedUrl}</code>
        </div>
      </div>

      {endpoint.billable && (
        <div className="warn-box">
          ⚠ This endpoint is billable in prod/staging (consumes wallet balance / quota).
          The dev profile sets <code>app.quota.enabled=false</code> so testing is not charged.
        </div>
      )}

      {endpoint.queryParams.length > 0 && (
        <div className="field-row">
          <label>Query parameters</label>
          {endpoint.queryParams.map((p) => (
            <div className="query-grid" key={p.name} style={{ marginBottom: 6 }}>
              <span className="small">
                {p.name}
                {p.required ? ' *' : ''}
              </span>
              <input
                value={query[p.name] ?? ''}
                placeholder={p.example !== undefined ? String(p.example) : p.type}
                onChange={(e) => setQuery({ ...query, [p.name]: e.target.value })}
              />
            </div>
          ))}
        </div>
      )}

      {endpoint.bodyKind === 'json' && (
        <div className="field-row">
          <label>Request body (JSON)</label>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12} />
        </div>
      )}

      {endpoint.bodyKind === 'multipart' && (
        <div className="field-row">
          <label>Audio file (multipart)</label>
          <input type="file" accept="audio/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <div style={{ marginTop: 8 }}>
            <label>languageCode (optional)</label>
            <input value={languageCode} onChange={(e) => setLanguageCode(e.target.value)} />
          </div>
        </div>
      )}

      <div className="ep-actions">
        <button onClick={send} disabled={!canSend || loading}>
          {loading ? 'Sending…' : `Send ${endpoint.method}`}
        </button>
        <button className="ghost" onClick={exportCurl} disabled={!baseUrl} title="Build a curl command for this request">
          {copied ? '✓ curl copied' : 'Copy as curl'}
        </button>
        {!authReady && endpoint.security && (
          <span className="small" style={{ color: 'var(--warn)' }}>
            {authMode === 'tool'
              ? 'Enter the Tool key + secret (⚙ top-right) to call this endpoint.'
              : 'Set the token — global variable or per-service override (⚙ top-right) — to call this endpoint.'}
          </span>
        )}
      </div>

      {curl && (
        <div className="field-row" style={{ marginTop: 12 }}>
          <label>curl {copied && <span className="small">· copied to clipboard</span>}</label>
          <textarea readOnly rows={Math.min(10, curl.text.split('\n').length + 1)} value={curl.text} onFocus={(e) => e.currentTarget.select()} />
          {curl.note && (
            <span className="small" style={{ marginTop: 6, display: 'block', color: 'var(--warn)' }}>
              ⚠ {curl.note}
            </span>
          )}
        </div>
      )}

      <ResponseView result={result} />
    </div>
  );
}
