// Server-only: run read-only Claude Code slash commands (/review-mr-dev,
// /scan-security) against the omicx workspace.
//
// SECURITY MODEL — mirrors lib/gitCore.ts:
//   1. Reached ONLY through the GIT_TOOL_ENABLED-gated /api/git route, after the
//      repo path has already been authorized against the configured allowlist.
//   2. `service` is derived from the authorized repo path — never taken raw from
//      the client. `branch` is the only free-form input and is charset-validated.
//   3. The `claude` binary is invoked via execFile([argv]) — NEVER a shell string
//      — so the prompt / service / branch is a distinct argv element, immune to
//      injection.
//
// The commands are read-only against the code (git fetch/diff + agent fan-out)
// and write their report files under {cwd}/review-mr/ or {cwd}/security-reports/
// on their own.

import { execFile } from 'child_process';
import path from 'path';

// These commands fan out many agents; give them a generous ceiling.
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const COMMAND_MAX_BUFFER = 64 * 1024 * 1024; // 64 MB — full multi-service report

/**
 * Repo-folder prefix that marks a reviewable service in the workspace. Default
 * fits the omicx layout (`cloud-saas-omicx-ai-service`); another project sets
 * REVIEW_SERVICE_PREFIX to its own convention.
 */
export const SERVICE_PREFIX = process.env.REVIEW_SERVICE_PREFIX?.trim() || 'cloud-saas-omicx-';

export interface CommandResult {
  output: string;
  exitCode: number;
}

/** Back-compat alias — client already imports this name. */
export type ReviewMrResult = CommandResult;

/**
 * Short service name for the /review-mr-dev arg, derived from the repo folder:
 *   cloud-saas-omicx-account-service → account-service.
 * A non-matching name is returned unchanged (the command warns if it can't map).
 */
export function serviceNameFromRepoPath(repoPath: string): string {
  const base = path.basename(repoPath);
  return base.startsWith(SERVICE_PREFIX) ? base.slice(SERVICE_PREFIX.length) : base;
}

/**
 * Validate the free-form branch input. Empty is valid and means "review ALL
 * MRs of the repo". Otherwise enforce a safe charset and reject a leading `-`
 * (so it can never be read as a flag), matching gitCore.checkout() discipline.
 */
export function validateBranch(branch: unknown): string {
  const b = typeof branch === 'string' ? branch.trim() : '';
  if (!b) return '';
  if (b.startsWith('-') || !/^[A-Za-z0-9._/-]+$/.test(b)) {
    throw new Error('invalid branch name');
  }
  return b;
}

/**
 * Run one read-only Claude Code slash-command prompt via the local `claude` CLI
 * and buffer the full output. Resolves with the output + exit code even when the
 * command exits non-zero (e.g. a BLOCK finding) so the UI can still show it.
 * Rejects only when the `claude` binary itself is missing (ENOENT).
 *
 * `cwd` MUST be the project root (folder holding the cloud-saas-* repos) so the
 * command can enumerate sibling repos and write reports to the right place.
 */
function runClaudeCommand(cwd: string, prompt: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'claude',
      ['-p', prompt, '--permission-mode', 'acceptEdits'],
      {
        cwd,
        env: { ...process.env, OMICX_BASE_PATH: cwd },
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('claude CLI not found on PATH — install Claude Code / add it to PATH.'));
          return;
        }
        let output = stdout || '';
        if (stderr) output += `\n---stderr---\n${stderr}`;
        if (err && (err as { killed?: boolean }).killed) {
          output += '\n\n[killed: quá 20 phút]';
        }
        // execFile sets err.code to the numeric exit code on a non-zero exit.
        const code = err ? Number((err as { code?: number }).code) : 0;
        resolve({ output, exitCode: Number.isFinite(code) ? code : 1 });
      },
    );
  });
}

/** Run `/review-mr-dev <service> [--branch=<branch>]`. */
export function runReviewMr({
  cwd,
  service,
  branch,
}: {
  cwd: string;
  service: string;
  branch: string;
}): Promise<CommandResult> {
  const prompt = `/review-mr-dev ${service}${branch ? ` --branch=${branch}` : ''}`;
  return runClaudeCommand(cwd, prompt);
}

/**
 * Run `/scan-security <service>` — audits the service on its currently
 * checked-out branch (no branch/diff involved). In non-interactive mode the
 * command's HTML-vs-Markdown prompt defaults to Markdown only.
 */
export function runScanSecurity({
  cwd,
  service,
}: {
  cwd: string;
  service: string;
}): Promise<CommandResult> {
  const prompt = `/scan-security ${service}`;
  return runClaudeCommand(cwd, prompt);
}
