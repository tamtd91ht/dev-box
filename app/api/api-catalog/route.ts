// GET /api/api-catalog?integration=<id>&service=<serviceId>
//   → normalized endpoint catalog (ServiceCatalog) parsed from the pack's spec.
//
// The integration pack declares WHERE the spec lives (devbox.api.json →
// services[].spec, relative to the pack root, traversal-checked); this route
// reads + parses it on the server.

import { NextResponse } from 'next/server';
import { getIntegration, loadManifest, resolveSpecPath } from '@/lib/apiIntegrations';
import { loadCatalogFromFile } from '@/lib/openapi';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const integrationId = searchParams.get('integration') ?? '';
  const serviceId = searchParams.get('service') ?? '';

  const integration = await getIntegration(integrationId);
  if (!integration) {
    return NextResponse.json({ error: `Unknown integration: ${integrationId}` }, { status: 404 });
  }

  try {
    const manifest = await loadManifest(integration);
    const svc = manifest.services.find((s) => s.id === serviceId);
    if (!svc) {
      return NextResponse.json(
        { error: `Integration "${manifest.name}" không có service "${serviceId}"` },
        { status: 404 },
      );
    }
    const catalog = loadCatalogFromFile(svc.id, resolveSpecPath(integration, svc.spec));
    return NextResponse.json(catalog);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to load spec for ${serviceId}`, detail: String(err) },
      { status: 500 },
    );
  }
}
