'use client';

// Zalo API (thử nghiệm) — executor cho action `zaloApiSend`.
//
// Song sinh với lib/automation/wsSend.ts nhưng đi đường API thay vì DOM. Điểm
// khác cốt lõi: đích là `threadId` THẬT (ổn định), không phải tên hiển thị —
// nên không cần danh bạ đồng bộ, không cuộn tìm dòng, không mở hội thoại.
//
//   action → POST /api/zaloapi { action:'send' } → outcome
//
// VÌ SAO QUA SERVER chứ không chạy script trong guest như wsSend: Zalo Web
// không phơi hàm gửi ra `window` (nó nằm trong bundle đã đóng gói), nên đường
// "mượn hàm của trang" là ngõ cụt. Đường đi được là tự dựng lại request đã ký +
// mã hoá — cần Node, nên nó nằm ở /api/zaloapi. Webview giờ chỉ còn việc quét
// QR rồi nhả cookie + imei để route đăng nhập.
//
// Cùng kỷ luật an toàn với wsSend: một lượt/tài khoản, có timeout, ghi trace.
// Gác allowSend + sendGate + loopGuard nằm ở runtime.ts (nơi đã gác wsSend), để
// không có hai bản luật gửi lệch nhau. Route còn một cổng nữa của riêng nó
// (ZALOAPI_ALLOW_SEND) — hai lớp độc lập, cố ý.

import { zaloApiSendMessage, type ZaloSendResult } from '@/lib/zaloapi/api';
import type { ResolvedMention } from './mention';
import type { ZaloApiSendAction } from './types';

export interface ZaloApiSendOutcome {
  status: 'ok' | 'error' | 'dry-run';
  detail: string;
  /** 1 nếu gửi được, 0 nếu không / dry-run. */
  sent: number;
  /** Kết quả thô từ route — trình soạn rule "gửi thử" hiện nó. */
  result: ZaloSendResult | null;
}

/** Một lượt/tài khoản: hai script cùng lái một guest sẽ giẫm lên nhau. */
const queues = new Map<string, Promise<unknown>>();
const JOB_TIMEOUT_MS = 60_000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`lượt gửi API: quá ${JOB_TIMEOUT_MS / 1000}s không phản hồi`)), JOB_TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e as Error);
      },
    );
  });
}

function enqueue<T>(accountKey: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(accountKey) ?? Promise.resolve();
  const run = () => withTimeout(job());
  const next = prev.then(run, run);
  queues.set(accountKey, next.catch(() => undefined));
  return next;
}

/** Người cần tag đã được bảng phân công giải ra (runtime tính, vì nó giữ event). */
export interface MentionPayload {
  people: ResolvedMention[];
  /** Lý do từng dòng khớp — cho dry-run/trace nói được vì sao tag ai. */
  why: string[];
}

export function sendViaZaloApi(
  action: ZaloApiSendAction,
  dryRun: boolean,
  mentions?: MentionPayload,
): Promise<ZaloApiSendOutcome> {
  return enqueue(action.accountKey, () => runSend(action, dryRun, mentions));
}

async function runSend(
  action: ZaloApiSendAction,
  dryRun: boolean,
  mentions?: MentionPayload,
): Promise<ZaloApiSendOutcome> {
  const threadId = (action.threadId ?? '').trim();
  const text = action.text ?? '';
  const where = threadId ? `${action.group ? 'nhóm' : 'hội thoại'} ${threadId}` : 'chính mình (self-chat)';
  const people = action.group ? (mentions?.people ?? []) : [];
  const tagNote = people.length
    ? ` · tag ${people.map((p) => `@${p.name}`).join(' ')}${mentions?.why.length ? ` (${mentions.why.join(' · ')})` : ''}`
    : '';

  if (!text.trim()) {
    return { status: 'error', detail: 'nội dung rỗng — không gửi', sent: 0, result: null };
  }

  // Dry-run KHÔNG chạm tới route: chỉ mô tả đúng thứ sắp gửi. Gọi route rồi
  // trông cậy nó tự không gửi là mời gọi tai nạn — một lỗi nhỏ phía server là
  // tin bắn đi thật trong lúc người dùng tưởng đang thử.
  if (dryRun) {
    return {
      status: 'dry-run',
      detail: `[gửi thử] tới ${where} · dài ${text.length} ký tự${tagNote} — CHƯA bắn đi`,
      sent: 0,
      result: null,
    };
  }

  try {
    const res = await zaloApiSendMessage({
      accountKey: action.accountKey,
      threadId,
      text,
      group: !!action.group,
      mentions: people.length ? people : undefined,
    });
    if (res.ok) {
      return { status: 'ok', detail: (res.detail || `đã gửi tới ${where}`) + tagNote, sent: 1, result: res };
    }
    return { status: 'error', detail: res.detail || 'gửi API không thành công', sent: 0, result: res };
  } catch (e) {
    // Lỗi cổng/chưa đăng nhập/hết hạn đều tới đây với thông điệp đã rõ nghĩa.
    return { status: 'error', detail: (e as Error).message, sent: 0, result: null };
  }
}
