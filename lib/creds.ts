// Per-service credentials.
//
// Auth token resolution: for every mode except 'tool', a service either overrides
// with its own `token` or inherits the matching global variable (see
// resolveAuth in lib/request.ts). Tool mode is always per-service (key + secret).
//   - apikey / jwt-* services: { token? }  (override; else global)
//   - tool services (tool-service): { toolKey, toolSecret }
//
// Persistence lives in the on-disk local store (lib/persist.ts + lib/localStore.ts)
// keyed by service id, so switching services keeps each one's credentials and a
// restart re-maps them.

export interface ServiceCreds {
  /** Per-service token OVERRIDE (raw, no "Bearer"). Empty → inherit global. */
  token?: string;
  toolKey?: string;    // tool mode — X-KEY (static)
  toolSecret?: string; // tool mode — TOOL_AUTH_SECRET (sent verbatim as X-VALUE)
}
