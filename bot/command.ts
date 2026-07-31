// Parse & validate the /review command text from a Telegram message, and map a
// short service name onto an authorized repo path in the workspace.
//
// Syntax (both forms accepted, and they may be mixed):
//   Positional : /review <service> [branch]        e.g. /review ai-service dev_duynh
//   Keyed      : /review <service> branch=<b> des=<mô tả có thể nhiều dòng>
//   /review <service>   → review ALL feature branches ahead of dev
//   /review help        → usage
//
// The keyed form exists so a request reads at a glance in the group chat
// ("ai đang xin review cái gì"): `des=` is a human description echoed back and
// recorded on the report — it never enters the engine's judgment.
//
// The command word may carry a @botname suffix in a group ("/review@omicx_bot").

import { detectRepos, type RepoInfo } from '../lib/gitCore';
import { serviceNameFromRepoPath, validateBranch, SERVICE_PREFIX } from '../lib/reviewMr';

const DESC_MAX = 500;

export type ParsedCommand =
  | { kind: 'review'; repoPath: string; service: string; branch: string; description: string }
  | { kind: 'help' }
  | { kind: 'ignore' } // not a command addressed to this bot
  | { kind: 'error'; message: string };

export const USAGE = [
  '<b>Xin review MR — gõ tự nhiên:</b>',
  '<code>/review &lt;service&gt; &lt;branch&gt; &lt;mô tả ngắn&gt;</code>',
  '',
  '<b>Ví dụ:</b>',
  '<code>/review ai-service dev_duynh fix lỗi bảo mật dữ liệu ở luồng TTS</code>',
  '',
  'Mô tả có thể xuống nhiều dòng:',
  '<code>/review ai-service dev_duynh',
  'fix lỗi bảo mật ở luồng TTS',
  'thêm rate-limit cho endpoint tạo assistant</code>',
  '',
  '<b>Ngắn gọn cũng được:</b>',
  '• <code>/review ai-service dev_duynh</code> — không cần mô tả',
  '• <code>/review ai-service</code> — review mọi branch ahead <code>dev</code>',
  '• <code>/review help</code> — xem hướng dẫn này',
  '',
  '<i>Mô tả chỉ để mọi người trên group đọc hiểu bạn đang xin review gì — không ảnh hưởng kết quả review.</i>',
].join('\n');

/** True when text is a /review command (optionally /review@botname). */
function isReviewCommand(word: string): boolean {
  const w = word.toLowerCase();
  return w === '/review' || w.startsWith('/review@');
}

/**
 * Resolve a user-typed service token to an authorized repo under `basePath`.
 * Accepts the short form (`ai-service`, `wallet`) or the full folder name.
 * Returns null when nothing matches.
 */
export async function resolveService(
  basePath: string,
  token: string,
): Promise<RepoInfo | null> {
  const repos = await detectRepos(basePath);
  const services = repos.filter((r) => r.name.startsWith(SERVICE_PREFIX));
  const t = token.trim().toLowerCase();

  // 1. exact full folder name
  let hit = services.find((r) => r.name.toLowerCase() === t);
  if (hit) return hit;

  // 2. short name (folder minus the cloud-saas-omicx- prefix)
  hit = services.find((r) => serviceNameFromRepoPath(r.path).toLowerCase() === t);
  if (hit) return hit;

  // 3. bare stem — allow "wallet" to match "wallet-service" (unambiguous only)
  const stemMatches = services.filter((r) => {
    const short = serviceNameFromRepoPath(r.path).toLowerCase();
    return short === t || short === `${t}-service`;
  });
  if (stemMatches.length === 1) return stemMatches[0];

  return null;
}

/** Parse the raw message text into a command. Pure parsing + one repo lookup. */
export async function parseCommand(text: string, basePath: string): Promise<ParsedCommand> {
  const raw = text || '';
  // The command word is the first whitespace-run token; everything after it is
  // the argument body (which may span multiple lines for the keyed `des=` form).
  const headMatch = raw.match(/^\s*(\S+)([\s\S]*)$/);
  if (!headMatch || !isReviewCommand(headMatch[1])) {
    return { kind: 'ignore' };
  }
  const body = headMatch[2].trim();

  // Service token = first whitespace-run token of the body.
  const svcMatch = body.match(/^(\S+)([\s\S]*)$/);
  if (!svcMatch || svcMatch[1].toLowerCase() === 'help') {
    return { kind: 'help' };
  }
  const serviceToken = svcMatch[1];
  const rest = svcMatch[2]; // "<branch> <mô tả tự do…>", optionally with branch=/des=

  // Optional explicit keys (branch=, des=) are supported but NOT required.
  const keyed = extractKeyed(rest);
  let branchToken = keyed.branch;
  let description = keyed.description;

  // Natural form — no keys: first bare token = branch, the rest = free-text
  // description. So "/review ai-service dev_duynh fix lỗi TTS" just works, and
  // the description can run onto more lines.
  if (!branchToken || !description) {
    const leftover = keyed.leftover.replace(/^\s+/, '');
    const m = leftover.match(/^(\S+)([\s\S]*)$/);
    if (m) {
      if (!branchToken) branchToken = m[1];
      if (!description) description = m[2];
    }
  }
  description = description.slice(0, DESC_MAX).trim();

  let branch = '';
  if (branchToken) {
    try {
      branch = validateBranch(branchToken);
    } catch {
      return { kind: 'error', message: `Tên branch không hợp lệ: <code>${escape(branchToken)}</code>` };
    }
  }

  const repo = await resolveService(basePath, serviceToken);
  if (!repo) {
    return {
      kind: 'error',
      message: `Không tìm thấy service <code>${escape(serviceToken)}</code> trong workspace.`,
    };
  }

  return {
    kind: 'review',
    repoPath: repo.path,
    service: serviceNameFromRepoPath(repo.path),
    branch,
    description,
  };
}

/**
 * Optionally pull explicit `branch=` and `des=`/`desc=` keys out of the body.
 * These are a power-user convenience, NOT required — the natural form
 * ("<branch> <free text>") is parsed from `leftover` by the caller. `des=`
 * greedily consumes to end-of-message, so it must be the LAST key. `leftover`
 * is the body minus any recognized keys.
 */
function extractKeyed(rest: string): { branch: string; description: string; leftover: string } {
  let description = '';
  let remaining = rest;

  // des= / desc= / mô-tả= : everything from the key to end-of-message.
  const desMatch = remaining.match(/(?:^|\s)(?:des|desc|mota|mô-tả)\s*=\s*([\s\S]*)$/i);
  if (desMatch) {
    description = desMatch[1];
    remaining = remaining.slice(0, desMatch.index ?? remaining.length).trim();
  }

  // branch= : a single token (no spaces).
  let branch = '';
  const brMatch = remaining.match(/(?:^|\s)branch\s*=\s*(\S+)/i);
  if (brMatch) {
    branch = brMatch[1];
    const at = brMatch.index ?? 0;
    remaining = (remaining.slice(0, at) + ' ' + remaining.slice(at + brMatch[0].length)).trim();
  }

  return { branch, description, leftover: remaining };
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
