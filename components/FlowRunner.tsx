'use client';

import { useMemo, useState } from 'react';
import type { Endpoint, Flow } from '@/lib/types';
import { callEndpoint, interpolate, readPath, type AuthPayload, type ProxyResult } from '@/lib/request';
import type { AuthMode } from '@/lib/request';
import ResponseView from './ResponseView';

interface Props {
  flow: Flow;
  endpoints: Endpoint[];
  baseUrl: string;
  /** API prefix (e.g. /api) reconciled against each step's openapi path. */
  apiPrefix?: string;
  authMode: AuthMode;
  /** Resolved auth (per-service override or global) for this service. */
  auth: AuthPayload;
  /** Whether `auth` has everything its mode needs. */
  authReady: boolean;
}

interface StepState {
  result?: ProxyResult;
  status: 'idle' | 'running' | 'done' | 'failed';
  bodyOverride?: string;
  queryOverride?: Record<string, string>;
}

export default function FlowRunner({ flow, endpoints, baseUrl, apiPrefix, authMode, auth, authReady }: Props) {
  const epById = useMemo(() => {
    const m = new Map<string, Endpoint>();
    for (const e of endpoints) m.set(e.operationId, e);
    return m;
  }, [endpoints]);

  const [vars, setVars] = useState<Record<string, string>>({});
  const [states, setStates] = useState<Record<string, StepState>>({});
  const [runningAll, setRunningAll] = useState(false);

  function setStep(id: string, patch: Partial<StepState>) {
    setStates((prev) => {
      const base: StepState = prev[id] ?? { status: 'idle' };
      return { ...prev, [id]: { ...base, ...patch } };
    });
  }

  async function runStep(stepId: string, currentVars: Record<string, string>): Promise<Record<string, string>> {
    const step = flow.steps.find((s) => s.id === stepId)!;
    const endpoint = epById.get(step.operationId);
    if (!endpoint) {
      setStep(stepId, { status: 'failed', result: { ok: false, status: 0, statusText: 'UNKNOWN_OP', detail: step.operationId } });
      return currentVars;
    }

    setStep(stepId, { status: 'running' });

    const st = states[stepId] ?? {};
    const rawBody = st.bodyOverride ?? step.body;
    const rawQuery = st.queryOverride ?? step.query;

    const body = interpolate(rawBody, currentVars);
    const query: Record<string, string> = {};
    if (rawQuery) {
      for (const [k, v] of Object.entries(rawQuery)) {
        const iv = interpolate(v, currentVars);
        if (iv) query[k] = iv;
      }
    }

    let res: ProxyResult;
    try {
      res = await callEndpoint({
        baseUrl,
        apiPrefix,
        auth,
        endpoint,
        query,
        jsonBody: endpoint.bodyKind === 'json' ? body : undefined,
      });
    } catch (err) {
      res = { ok: false, status: 0, statusText: 'CLIENT_ERROR', detail: String(err) };
    }

    // Capture response fields into vars.
    let nextVars = currentVars;
    if (res.ok && step.capture && res.bodyJson !== undefined) {
      const captured: Record<string, string> = {};
      for (const [varName, pathExpr] of Object.entries(step.capture)) {
        const val = readPath(res.bodyJson, pathExpr);
        if (val !== undefined) captured[varName] = val;
      }
      nextVars = { ...currentVars, ...captured };
      setVars(nextVars);
    }

    setStep(stepId, { status: res.ok ? 'done' : 'failed', result: res });
    return nextVars;
  }

  async function runAll() {
    setRunningAll(true);
    setVars({});
    setStates({});
    let acc: Record<string, string> = {};
    for (const step of flow.steps) {
      // eslint-disable-next-line no-await-in-loop
      acc = await runStep(step.id, acc);
    }
    setRunningAll(false);
  }

  const canRun = Boolean(baseUrl && authReady);

  return (
    <div>
      <div className="status-line">
        <div>
          <div className="flow-step-title">{flow.name}</div>
          <div className="hint" style={{ margin: 0 }}>{flow.description}</div>
        </div>
        <div className="spacer" />
        <button onClick={runAll} disabled={!canRun || runningAll}>
          {runningAll ? 'Running…' : '▶ Run all steps'}
        </button>
      </div>

      {!canRun && (
        <div className="warn-box">
          Enter base URL and {authMode === 'tool' ? 'Tool key + secret' : 'API key'} above to run this flow.
        </div>
      )}

      {Object.keys(vars).length > 0 && (
        <div className="vars">
          {Object.entries(vars).map(([k, v]) => (
            <span className="var-chip" key={k}>
              <b>{`{{${k}}}`}</b> = {v}
            </span>
          ))}
        </div>
      )}

      <div className="flow-steps">
        {flow.steps.map((step) => {
          const endpoint = epById.get(step.operationId);
          const st = states[step.id] ?? { status: 'idle' as const };
          return (
            <div
              key={step.id}
              className={`flow-step ${st.status === 'done' ? 'done' : ''} ${st.status === 'failed' ? 'failed' : ''}`}
            >
              <div className="flow-step-head">
                <div className="status-line" style={{ marginBottom: 0 }}>
                  {endpoint && <span className={`method ${endpoint.method}`}>{endpoint.method}</span>}
                  <span className="flow-step-title">{step.label}</span>
                  {endpoint && <span className="ep-path">{endpoint.path}</span>}
                  {endpoint?.billable && <span className="badge warn">billable</span>}
                </div>
                <button
                  className="ghost sm"
                  onClick={() => runStep(step.id, vars)}
                  disabled={!canRun || st.status === 'running'}
                >
                  {st.status === 'running' ? '…' : 'Run step'}
                </button>
              </div>

              {step.note && <div className="small" style={{ marginTop: 6 }}>{step.note}</div>}

              {endpoint?.bodyKind === 'json' && step.body !== undefined && (
                <div className="field-row" style={{ marginTop: 8 }}>
                  <label>Body (supports {'{{var}}'})</label>
                  <textarea
                    rows={6}
                    value={st.bodyOverride ?? step.body}
                    onChange={(e) => setStep(step.id, { bodyOverride: e.target.value })}
                  />
                </div>
              )}

              {step.query && (
                <div className="field-row" style={{ marginTop: 8 }}>
                  <label>Query (supports {'{{var}}'})</label>
                  {Object.entries(st.queryOverride ?? step.query).map(([k, v]) => (
                    <div className="query-grid" key={k} style={{ marginBottom: 6 }}>
                      <span className="small">{k}</span>
                      <input
                        value={v}
                        onChange={(e) =>
                          setStep(step.id, {
                            queryOverride: { ...(st.queryOverride ?? step.query), [k]: e.target.value },
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              )}

              {st.result && <ResponseView result={st.result} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
