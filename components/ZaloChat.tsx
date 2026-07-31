'use client';

// Zalo "mini chat" embed — the official Zalo Official Account (OA) Chat Widget.
//
// Feasibility: Zalo ships a drop-in web widget (the same one used on public sites)
// that renders its own floating bubble bottom-right and opens an in-page chat with
// a Zalo OA. It is a single external script (`sp.zalo.me/plugins/sdk.js`) that
// scans the DOM for a `.zalo-chat-widget` element and hydrates it. That makes it
// embeddable here with no backend, no AMQP/API of our own — the only required
// input is the OA id.
//
// Gating: this renders NOTHING unless `NEXT_PUBLIC_ZALO_OA_ID` is set. That keeps
// the tool self-contained/offline by default (no third-party script is loaded) and
// means a deployed build without the var is inert — same posture as the other
// local-only tabs. Drop your OA id into `.env.local` to activate it:
//
//   NEXT_PUBLIC_ZALO_OA_ID=1234567890123456789
//   NEXT_PUBLIC_ZALO_WELCOME=Chào bạn, cần hỗ trợ gì không?   # optional
//
// (Find the OA id in Zalo OA Manager → Settings, or the `oaid` in the OA URL.)

import { useEffect, useRef, useState } from 'react';

const SDK_SRC = 'https://sp.zalo.me/plugins/sdk.js';
const OA_ID = process.env.NEXT_PUBLIC_ZALO_OA_ID ?? '';
const WELCOME = process.env.NEXT_PUBLIC_ZALO_WELCOME ?? 'Chào bạn, cần hỗ trợ gì không?';

export default function ZaloChat() {
  const injected = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!OA_ID || injected.current) return;
    injected.current = true;

    // Re-use the script if a previous mount already added it; otherwise inject it
    // once. The SDK auto-scans for `.zalo-chat-widget` when it loads.
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SDK_SRC}"]`);
    if (existing) return;

    const s = document.createElement('script');
    s.src = SDK_SRC;
    s.async = true;
    s.onerror = () => setFailed(true); // e.g. offline / blocked — degrade quietly
    document.body.appendChild(s);
  }, []);

  // Not configured → embed nothing at all (keeps the tool offline-clean).
  if (!OA_ID) return null;

  // If the external SDK can't load (offline dev, blocked host), fall back to a
  // plain link to the OA so the affordance still works.
  if (failed) {
    return (
      <a
        className="zalo-fallback"
        href={`https://zalo.me/${OA_ID}`}
        target="_blank"
        rel="noreferrer"
        title="Mở chat Zalo (SDK không tải được)"
      >
        Zalo
      </a>
    );
  }

  return (
    <div
      className="zalo-chat-widget"
      data-oaid={OA_ID}
      data-welcome-message={WELCOME}
      data-autopopup="0"
      data-width=""
      data-height=""
    />
  );
}
