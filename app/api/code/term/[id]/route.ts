// GET /api/code/term/<id> — SSE stream of one terminal session's output.
//
// Chunks are base64-encoded (terminal output chứa \r\n + control bytes, không
// nhét thẳng vào khung `data:` của SSE được). Kết nối mới replay toàn bộ ring
// buffer trước → client vẽ lại đúng màn hình hiện tại rồi nhận live. Heartbeat
// comment mỗi 15s giữ kết nối qua proxy/idle timeout.

import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/termSessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const on = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? '');

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!on(process.env.CODE_TOOL_ENABLED)) {
    return new Response('Code tool is disabled', { status: 403 });
  }
  const { id } = await ctx.params;
  const session = getSession(id);
  if (!session) return new Response('No such terminal session', { status: 404 });

  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(`data: ${Buffer.from(chunk, 'utf8').toString('base64')}\n\n`));
        } catch {
          /* controller đã đóng */
        }
      };

      // Replay những gì phiên đã in ra từ trước.
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
        } catch {
          /* đã đóng */
        }
      }, 15000);

      // Khi shell thoát, báo client rồi đóng stream (poll nhẹ — exit là sự kiện hiếm).
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
        } catch {
          /* đã đóng */
        }
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
