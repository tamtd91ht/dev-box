// Liveness/readiness probe target for k8s. The UI's "/health" concept probes the
// *backend* services; this route is the tester process's own health.
export const dynamic = 'force-dynamic';

export function GET() {
  return new Response('ok', { status: 200 });
}
