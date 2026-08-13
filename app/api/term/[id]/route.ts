// GET /api/term/<id> — SSE stream output của một phiên terminal (tab Terminal).
//
// Giống hệt cơ chế đã chạy ổn ở /api/code/term/<id>: chunk base64 (output chứa
// \r\n + control byte, nhét thẳng vào khung `data:` của SSE là vỡ), kết nối mới
// replay ring buffer sau một event 'reset' để không vẽ chồng, heartbeat 15s giữ
// kết nối.
//
// ĐÂY LÀ CHỖ "GIỮ PHIÊN" THÀNH HÌNH: cửa sổ (tab chính hay cửa sổ rời) chỉ là
// một subscriber. Nó chết/đóng/F5 thì chỉ mất subscriber, shell vẫn chạy và vẫn
// ghi vào buffer; mở lại là replay ra đúng màn hình đang có.

import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/termSessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const on = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? '');
const ENABLED = () => on(process.env.TERMINAL_ENABLED) || on(process.env.CODE_TOOL_ENABLED);

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!ENABLED()) return new Response('Terminal is disabled', { status: 403 });

  const { id } = await ctx.params;
  const session = getSession(id);
  if (!session) return new Response('No such terminal session', { status: 404 });

  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(
            enc.encode(`data: ${Buffer.from(chunk, 'utf8').toString('base64')}\n\n`),
          );
        } catch {
          /* controller đã đóng */
        }
      };

      // Reset TRƯỚC khi replay — EventSource tự reconnect khi đứt mạng/HMR,
      // không reset thì buffer vẽ chồng lên nội dung cũ.
      try {
        controller.enqueue(enc.encode('event: reset\ndata: {}\n\n'));
      } catch { /* đã đóng */ }

      if (session.buffer.length) send(session.buffer.join(''));

      if (session.exited) {
        try {
          controller.enqueue(enc.encode('event: exit\ndata: {}\n\n'));
          controller.close();
        } catch { /* đã đóng */ }
        return;
      }

      const sub = (chunk: string) => send(chunk);
      session.subscribers.add(sub);

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(': ping\n\n'));
        } catch { /* đã đóng */ }
      }, 15000);

      const exitWatch = setInterval(() => {
        if (!session.exited) return;
        try {
          controller.enqueue(enc.encode('event: exit\ndata: {}\n\n'));
          controller.close();
        } catch { /* đã đóng */ }
        cleanup();
      }, 500);

      cleanup = () => {
        session.subscribers.delete(sub);
        clearInterval(heartbeat);
        clearInterval(exitWatch);
      };

      req.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch { /* đã đóng */ }
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
