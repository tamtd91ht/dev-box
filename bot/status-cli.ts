// `npm run bot:status` — print the bot's current status in one glance.
//
// Reads bot/.status.json (written by the running bot). Works from any terminal,
// needs no Redis/Telegram. Tells you: running or not, reviewing what and for how
// long, how many branches are queued, and how the last review ended.

import { promises as fs } from 'fs';
import { statusPath, type StatusSnapshot } from './status';

const STALE_MS = 90_000; // a running bot refreshes at least this often (poll cycle)

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(statusPath(), 'utf8');
  } catch {
    console.log('⚪ Bot chưa chạy lần nào (không có .status.json).');
    console.log('   Khởi động:  npm run bot');
    return;
  }

  let s: StatusSnapshot;
  try {
    s = JSON.parse(raw) as StatusSnapshot;
  } catch {
    console.log('⚠️  .status.json hỏng định dạng — bot có thể đang ghi dở, thử lại.');
    return;
  }

  const ageMs = Date.now() - new Date(s.updatedAt).getTime();
  const stale = s.state !== 'stopped' && ageMs > STALE_MS;

  const icon =
    s.state === 'reviewing' ? '🟢' :
    s.state === 'idle' ? '⚪' :
    s.state === 'stopped' ? '🔴' : '⚪';

  console.log(`${icon} instance=${s.instanceId} · trạng thái: ${label(s.state)}${stale ? '  ⚠️ (snapshot cũ — bot có thể đã tắt/treo)' : ''}`);

  if (s.state === 'reviewing' && s.current) {
    const elapsed = Math.round((Date.now() - s.current.startedAt) / 1000);
    console.log(`   🔍 đang review: ${s.current.service}/${s.current.branch} (xin bởi ${s.current.requester})`);
    console.log(`   ⏱  đã chạy: ${fmtDuration(elapsed)}${s.queued > 0 ? ` · còn ${s.queued} branch trong hàng đợi` : ''}`);
  } else if (s.state === 'idle') {
    console.log('   💤 rảnh — đang chờ lệnh /review trên Telegram.');
  }

  if (s.last) {
    console.log(
      `   ✔ lần review cuối: ${s.last.service}/${s.last.branch} → ${s.last.verdict}` +
        `${s.last.score ? ` (${s.last.score})` : ''} · ${fmtDuration(s.last.durationSec)} · lúc ${localTime(s.last.finishedAt)}`,
    );
  }
  console.log(`   (cập nhật: ${localTime(s.updatedAt)}${stale ? `, ${fmtDuration(Math.round(ageMs / 1000))} trước` : ''})`);
}

function label(state: StatusSnapshot['state']): string {
  return { starting: 'đang khởi động', idle: 'RẢNH', reviewing: 'ĐANG REVIEW', stopped: 'ĐÃ DỪNG' }[state];
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}ph${s ? ` ${s}s` : ''}`;
}

function localTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

main().catch((e) => {
  console.error('status error:', (e as Error).message);
  process.exit(1);
});
