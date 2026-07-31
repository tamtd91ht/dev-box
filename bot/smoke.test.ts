// Lightweight smoke test — run with:  npx tsx bot/smoke.test.ts
//
// No test framework: pure assertions against the offline-parseable units
// (command parsing + SCORE-line parsing). Anything touching Telegram/Redis/git
// is covered by the manual end-to-end steps in bot/README.md instead.

import assert from 'assert';
import { parseCommand } from './command';
import { parseScoreLine } from './reviewer';

let passed = 0;
function ok(name: string, cond: boolean): void {
  assert.ok(cond, name);
  passed++;
  // eslint-disable-next-line no-console
  console.log(`  ✓ ${name}`);
}

async function run(): Promise<void> {
  const base =
    process.env.BOT_BASE_PATH ||
    process.env.OMICX_BASE_PATH ||
    require('path').resolve(process.cwd(), '..');

  // ── command parsing ──────────────────────────────────────────────────────
  ok('non-command ignored', (await parseCommand('hello team', base)).kind === 'ignore');
  ok('/review with no args → help', (await parseCommand('/review', base)).kind === 'help');
  ok('/review help → help', (await parseCommand('/review help', base)).kind === 'help');

  const bad = await parseCommand('/review ai-service bad;rm', base);
  ok('branch with shell-meta char rejected', bad.kind === 'error');

  const dashBad = await parseCommand('/review ai-service -force', base);
  ok('branch starting with dash rejected', dashBad.kind === 'error');

  const missing = await parseCommand('/review no-such-service-xyz dev_x', base);
  ok('unknown service → error', missing.kind === 'error');

  // Real workspace lookup (ai-service exists in this repo tree).
  const real = await parseCommand('/review ai-service dev_duynh', base);
  if (real.kind === 'review') {
    ok('ai-service resolves', real.service === 'ai-service' && real.branch === 'dev_duynh');
    ok('repoPath points at the repo', real.repoPath.endsWith('cloud-saas-omicx-ai-service'));
    ok('no description → empty', real.description === '');

    // Natural free-text description (no key=value).
    const nat = await parseCommand('/review ai-service dev_duynh fix lỗi bảo mật ở luồng TTS', base);
    ok(
      'natural: branch + free-text description',
      nat.kind === 'review' && nat.branch === 'dev_duynh' && nat.description === 'fix lỗi bảo mật ở luồng TTS',
    );

    // Multi-line description.
    const multi = await parseCommand('/review ai-service dev_duynh\nfix lỗi TTS\nthêm rate-limit', base);
    ok(
      'natural: multi-line description',
      multi.kind === 'review' && multi.branch === 'dev_duynh' && multi.description.includes('rate-limit'),
    );

    // Explicit keys still supported.
    const kv = await parseCommand('/review ai-service branch=dev_duynh des= fix TTS', base);
    ok(
      'keyed: branch= + des= still works',
      kv.kind === 'review' && kv.branch === 'dev_duynh' && kv.description === 'fix TTS',
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(`  ⚠ ai-service not resolvable here (kind=${real.kind}) — skipping repo assertions`);
  }

  const cmdAt = await parseCommand('/review@omicx_review_bot ai-service', base);
  ok('/review@botname recognized', cmdAt.kind === 'review' || cmdAt.kind === 'error');

  // ── SCORE line parsing ─────────────────────────────────────────────────────
  const s1 = parseScoreLine('SCORE: CRIT=0 HIGH=2 MED=6 LOW=1 VERDICT=FIX_REQUIRED');
  ok('SCORE parse verdict', s1?.verdict === 'FIX_REQUIRED');
  ok('SCORE parse counts', s1?.score.high === 2 && s1?.score.med === 6);

  const s2 = parseScoreLine('...\nSCORE: CRIT=1 HIGH=0 MED=0 LOW=2 VERDICT=BLOCK\n');
  ok('SCORE embedded/multiline', s2?.verdict === 'BLOCK' && s2?.score.crit === 1);

  const s3 = parseScoreLine('SCORE: CRIT=0 HIGH=0 MED=0 LOW=2 verdict=APPROVE');
  ok('SCORE lowercase verdict token', s3?.verdict === 'APPROVE');

  ok('no SCORE line → null', parseScoreLine('nothing here') === null);

  // eslint-disable-next-line no-console
  console.log(`\n${passed} checks passed.`);
}

run().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('SMOKE TEST FAILED:', e);
  process.exit(1);
});
