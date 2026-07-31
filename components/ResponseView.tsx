'use client';

import type { ProxyResult } from '@/lib/request';

function statusClass(status: number): string {
  if (status === 0) return 'status-0';
  if (status >= 200 && status < 300) return 'status-2xx';
  if (status >= 400 && status < 500) return 'status-4xx';
  return 'status-5xx';
}

/** Find any playable audio URL in the response body (TTS audioUrl / STT inputAudioUrl). */
function findAudioUrls(body: unknown): string[] {
  const urls: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === 'string' && /^https?:\/\/.+\.(wav|mp3|mpeg|mp4|ogg|flac|m4a)(\?|$)/i.test(v)) {
      urls.push(v);
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v && typeof v === 'object') {
      Object.values(v as Record<string, unknown>).forEach(visit);
    }
  };
  visit(body);
  return Array.from(new Set(urls));
}

export default function ResponseView({ result }: { result: ProxyResult | null }) {
  if (!result) return null;

  const body =
    result.bodyJson !== undefined
      ? JSON.stringify(result.bodyJson, null, 2)
      : result.bodyText ?? '';
  const audioUrls = result.bodyJson !== undefined ? findAudioUrls(result.bodyJson) : [];

  return (
    <div className="resp">
      <div className="status-line">
        <span className={`status-code ${statusClass(result.status)}`}>
          {result.status || 'ERR'} {result.statusText || ''}
        </span>
        {result.error && <span className="small" style={{ color: 'var(--err)' }}>{result.error}</span>}
      </div>

      {result.detail && !result.bodyJson && (
        <pre className="code" style={{ color: 'var(--err)' }}>{result.detail}</pre>
      )}

      {body && <pre className="code">{body}</pre>}

      {audioUrls.map((url) => (
        <audio key={url} controls src={url}>
          <a href={url}>audio</a>
        </audio>
      ))}

      {result.headers && (
        <details style={{ marginTop: 10 }}>
          <summary className="small">Response headers</summary>
          <pre className="code">{JSON.stringify(result.headers, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
