'use client';

// In-app console for the desktop shell. The Electron main process mirrors its
// own lifecycle log + the spawned `next dev` output into a ring buffer and
// streams it over the `desktopConsole` preload bridge (electron/preload.cjs).
// This renders a toggle button (lives in the app footer) and a bottom drawer,
// hidden by default. Renders nothing at all when running as a plain web app.

import { useEffect, useRef, useState } from 'react';

type LogEntry = { id: number; ts: number; source: string; line: string };

type ConsoleBridge = {
  getAll: () => Promise<LogEntry[]>;
  onLine: (cb: (entry: LogEntry) => void) => () => void;
};

declare global {
  interface Window {
    desktopConsole?: ConsoleBridge;
  }
}

const CLIENT_LIMIT = 2000;

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function DesktopConsole() {
  // Bridge only exists inside Electron; detected after mount so SSR and the
  // plain-browser build render nothing.
  const [bridge, setBridge] = useState<ConsoleBridge | null>(null);
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const b = window.desktopConsole;
    if (!b) return;
    setBridge(b);
    let off: (() => void) | undefined;
    let dead = false;
    // History first, then live lines; dedupe by id in case a line lands both
    // in the snapshot and on the stream during the handover.
    b.getAll().then((initial) => {
      if (dead) return;
      setLogs(initial);
      off = b.onLine((entry) =>
        setLogs((prev) => {
          if (prev.length && prev[prev.length - 1].id >= entry.id) return prev;
          const next = [...prev, entry];
          return next.length > CLIENT_LIMIT ? next.slice(next.length - CLIENT_LIMIT) : next;
        }),
      );
    });
    return () => {
      dead = true;
      off?.();
    };
  }, []);

  // Keep the view pinned to the newest line while open.
  useEffect(() => {
    if (!open) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, logs]);

  if (!bridge) return null;

  return (
    <>
      <button
        type="button"
        className={`console-toggle${open ? ' on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Log của desktop shell + next dev"
      >
        <span aria-hidden>⌨</span> Console
      </button>

      {open && (
        <div className="console-drawer" role="log" aria-label="Desktop console">
          <div className="console-head">
            <strong>Console</strong>
            <span className="console-hint">shell + next dev · {logs.length} dòng</span>
            <span className="console-spacer" />
            <button type="button" onClick={() => setLogs([])}>Xoá</button>
            <button type="button" onClick={() => setOpen(false)}>Đóng</button>
          </div>
          <div className="console-body" ref={bodyRef}>
            {logs.length === 0 ? (
              <div className="console-empty">Chưa có log nào.</div>
            ) : (
              logs.map((e) => (
                <div key={e.id} className="console-line">
                  <span className="console-ts">{fmtTime(e.ts)}</span>
                  <span className={`console-src src-${e.source}`}>{e.source}</span>
                  <span className="console-msg">{e.line}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}
