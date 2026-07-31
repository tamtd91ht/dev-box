// Parse an omicx openapi.yaml into a normalized, flat endpoint catalog.
// Server-side only (reads from disk). The spec is a single self-contained file
// whose only $refs are local (#/components/...), so a lightweight js-yaml parse
// plus manual local-$ref resolution is enough — no heavy swagger toolchain.

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type {
  BodyKind,
  Endpoint,
  HttpMethod,
  QueryParam,
  ServiceCatalog,
} from './types';

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Resolve a single local $ref like "#/components/schemas/TtsRequest". */
function resolveRef(root: Any, ref: string): Any {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .reduce((acc: Any, key: string) => (acc == null ? acc : acc[key]), root);
}

/** Follow a $ref one level (objects with { $ref } are replaced by their target). */
function deref(root: Any, node: Any): Any {
  if (node && typeof node === 'object' && typeof node.$ref === 'string') {
    return resolveRef(root, node.$ref);
  }
  return node;
}

/** Merge allOf into a single object schema (shallow — enough for these specs). */
function flattenSchema(root: Any, schema: Any): Any {
  let s = deref(root, schema);
  if (!s || typeof s !== 'object') return s;
  if (Array.isArray(s.allOf)) {
    const merged: Any = { type: 'object', properties: {}, required: [] };
    for (const part of s.allOf) {
      const p = flattenSchema(root, part);
      if (p?.properties) Object.assign(merged.properties, p.properties);
      if (Array.isArray(p?.required)) merged.required.push(...p.required);
    }
    return merged;
  }
  return s;
}

/** Build a sample JSON value from a schema (prefers declared examples). */
function sampleFromSchema(root: Any, schema: Any, depth = 0): unknown {
  const s = flattenSchema(root, schema);
  if (!s || typeof s !== 'object' || depth > 6) return null;
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];

  switch (s.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const props = s.properties || {};
      for (const key of Object.keys(props)) {
        out[key] = sampleFromSchema(root, props[key], depth + 1);
      }
      return out;
    }
    case 'array':
      return [sampleFromSchema(root, s.items, depth + 1)];
    case 'integer':
    case 'number':
      return s.default ?? 0;
    case 'boolean':
      return s.default ?? false;
    case 'string':
      return s.default ?? '';
    default:
      // untyped object (e.g. free-form filter body)
      if (s.properties) {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(s.properties)) {
          out[key] = sampleFromSchema(root, s.properties[key], depth + 1);
        }
        return out;
      }
      return null;
  }
}

/** Pick the best request-body example: named example → schema-derived sample. */
function bodyExample(root: Any, content: Any): string | undefined {
  const json = content?.['application/json'];
  if (!json) return undefined;
  // Prefer an explicit examples[*].value, then a single example, then derive.
  if (json.examples && typeof json.examples === 'object') {
    const first = Object.values(json.examples)[0] as Any;
    if (first?.value !== undefined) return JSON.stringify(first.value, null, 2);
  }
  if (json.example !== undefined) return JSON.stringify(json.example, null, 2);
  const sample = sampleFromSchema(root, json.schema);
  return sample == null ? undefined : JSON.stringify(sample, null, 2);
}

function bodyKindOf(content: Any): BodyKind {
  if (!content) return 'none';
  if (content['multipart/form-data']) return 'multipart';
  if (content['application/json']) return 'json';
  return 'none';
}

/** Extract "Scope required: `xxx`" from a description blob. */
function parseScope(desc: string | undefined): string | undefined {
  if (!desc) return undefined;
  const m = desc.match(/Scope required:\*?\*?\s*`?([a-z]+:[a-z]+)`?/i);
  return m ? m[1] : undefined;
}

function toQueryParams(root: Any, params: Any[]): QueryParam[] {
  if (!Array.isArray(params)) return [];
  return params
    .map((p) => deref(root, p))
    .filter((p) => p && p.in === 'query')
    .map((p) => ({
      name: p.name,
      required: Boolean(p.required),
      type: p.schema?.type ?? 'string',
      description: p.description,
      example: p.example ?? p.schema?.example,
      default: p.schema?.default,
    }));
}

export function parseSpec(
  service: string,
  yamlText: string,
): ServiceCatalog {
  const root = yaml.load(yamlText) as Any;
  const endpoints: Endpoint[] = [];

  const paths = root?.paths ?? {};
  for (const rawPath of Object.keys(paths)) {
    const pathItem = paths[rawPath];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method.toLowerCase()];
      if (!op) continue;

      const description: string | undefined = op.description;
      // security: [] at the operation level means "no auth" (only /health).
      const secured = !(Array.isArray(op.security) && op.security.length === 0);
      const content = op.requestBody?.content;
      const billable = rawPath === '/tts' || rawPath === '/stt';

      endpoints.push({
        operationId: op.operationId ?? `${method}_${rawPath}`,
        method,
        path: rawPath,
        group: (Array.isArray(op.tags) && op.tags[0]) || 'default',
        summary: op.summary ?? '',
        description,
        requiredScope: parseScope(description),
        security: secured,
        bodyKind: bodyKindOf(content),
        bodyExample: content ? bodyExample(root, content) : undefined,
        queryParams: toQueryParams(root, op.parameters),
        billable,
      });
    }
  }

  return {
    service,
    title: root?.info?.title ?? service,
    version: root?.info?.version ?? '',
    serverHint: root?.servers?.[0]?.url,
    endpoints,
  };
}

/** Load + parse a spec FILE (absolute path) — integration packs supply the path. */
export function loadCatalogFromFile(serviceId: string, absSpecPath: string): ServiceCatalog {
  const text = fs.readFileSync(absSpecPath, 'utf8');
  return parseSpec(serviceId, text);
}
