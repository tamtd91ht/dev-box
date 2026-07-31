// Shared types for the API tester — normalized OpenAPI catalog + flow model.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export type BodyKind = 'none' | 'json' | 'multipart';

export interface QueryParam {
  name: string;
  required: boolean;
  type: string;
  description?: string;
  example?: unknown;
  default?: unknown;
}

/** One callable operation, flattened from the OpenAPI paths. */
export interface Endpoint {
  operationId: string;
  method: HttpMethod;
  path: string;               // e.g. "/webhooks"
  group: string;              // tag, e.g. "Webhooks"
  summary: string;
  description?: string;
  requiredScope?: string;     // parsed from description ("Scope required: xxx")
  security: boolean;          // false only for /health
  bodyKind: BodyKind;
  /** Prefilled JSON body example (for json bodyKind), pretty-printed. */
  bodyExample?: string;
  queryParams: QueryParam[];
  /** true when the route is a billable AI call (surface a warning). */
  billable: boolean;
}

export interface ServiceCatalog {
  service: string;            // "public-service"
  title: string;
  version: string;
  /** The spec's illustrative servers[0].url — shown as a hint, not trusted. */
  serverHint?: string;
  endpoints: Endpoint[];
}

// ── Flow model ─────────────────────────────────────────────────────────────

export interface FlowStep {
  id: string;
  label: string;
  operationId: string;        // which Endpoint this step calls
  /** Pre-filled JSON body (may contain {{var}} placeholders). */
  body?: string;
  /** Pre-filled query params (values may contain {{var}} placeholders). */
  query?: Record<string, string>;
  /** Capture response fields into named vars: { webhookId: "id" } → JSONPath-lite. */
  capture?: Record<string, string>;
  note?: string;
}

export interface Flow {
  id: string;
  service: string;
  name: string;
  description: string;
  steps: FlowStep[];
}
