// scripts/check-git-checkout.ts — kiểm "đổi sang branch chỉ có trên remote".
//
// VÌ SAO CÓ FILE NÀY: `git clone` chỉ dựng ĐÚNG MỘT branch local (branch mặc
// định của repo), mọi branch khác nằm ở refs/remotes. Tab Git trước đây chỉ
// liệt kê `git branch` nên sau khi clone, danh sách branch đúng một dòng — không
// có đường nào sang branch khác. Đây là ca phải chốt bằng test vì nó chỉ lộ ra
// trên repo VỪA CLONE, còn repo dev đang mở sẵn thì branch nào cũng đã có local.
//
// Bốn cạm bẫy được canh ở đây:
//   • DETACHED HEAD: `git checkout origin/feat` chạy ngon, không báo lỗi gì, rồi
//     commit ở đó không thuộc branch nào và biến mất sau lần checkout sau. Phải
//     dựng branch local + --track, và test phải khẳng định detached === false.
//   • ĐẺ BRANCH TRÙNG: bấm "origin/feat" khi đã có local "feat" mà lại tạo mới
//     thì sẽ có hai branch lệch nhau. Ca này phải checkout đúng cái local đang có.
//   • MẤT UPSTREAM: tạo local mà quên --track thì Push sau đó không biết đẩy đi
//     đâu (và ↑/↓ trên UI luôn bằng 0). Test so `status().upstream`.
//   • WORKING TREE BẨN: git từ chối bằng một đoạn tiếng Anh lẫn giữa danh sách
//     file — dễ bị đọc thành "tool hỏng". Phải kèm câu chỉ việc phải làm.
//
//   npx tsx scripts/check-git-checkout.ts

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { branches, checkout, fetchBranches, status } from '../lib/gitCore';

let failures = 0;
const ok = (m: string): void => console.log(`✓ ${m}`);
const fail = (m: string): void => {
  failures += 1;
  console.error(`✗ ${m}`);
};
const check = (cond: boolean, m: string): void => (cond ? ok(m) : fail(m));

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd, windowsHide: true }, (e, out, err) =>
      e ? reject(new Error((err || (e as Error).message).toString())) : resolve(out.toString()),
    ),
  );
}

/** Ghi file rồi commit — mỗi branch một nội dung khác nhau để nhận ra đã sang đúng branch. */
async function commitFile(repo: string, name: string, body: string, msg: string): Promise<void> {
  await fs.writeFile(path.join(repo, name), body, 'utf8');
  await git(repo, ['add', '-A']);
  await git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg]);
}

/** Lỗi ném ra từ `fn`, hoặc null khi nó chạy lọt. */
async function errorOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitco-'));
  try {
    // ── Dựng một "server": src có 3 branch, đẩy thành bare origin.git ─────────
    const src = path.join(tmp, 'src');
    await fs.mkdir(src, { recursive: true });
    await git(src, ['-c', 'init.defaultBranch=main', 'init', '-q']);
    await commitFile(src, 'README.md', '# main\n', 'init');
    await git(src, ['checkout', '-q', '-b', 'feature/x']);
    await commitFile(src, 'x.txt', 'x\n', 'feat x');
    await git(src, ['checkout', '-q', '-b', 'feature/y', 'main']);
    await commitFile(src, 'y.txt', 'y\n', 'feat y');
    await git(src, ['checkout', '-q', 'main']);

    const origin = path.join(tmp, 'origin.git');
    await git(tmp, ['clone', '-q', '--bare', src, origin]);

    // Clone như người dùng vẫn clone: chỉ có branch mặc định dưới máy.
    const work = path.join(tmp, 'work');
    await git(tmp, ['clone', '-q', origin, work]);

    const first = await branches(work);
    check(first.branches.length === 1 && first.current === 'main', 'clone xong chỉ có 1 branch local (main)');
    check(
      first.remotes.includes('origin/feature/x') && first.remotes.includes('origin/feature/y'),
      'branches() thấy feature/x + feature/y ở refs/remotes',
    );
    // origin/HEAD rút gọn thành đúng chữ “origin” — lọt vào danh sách thì UI hiện
    // một dòng không phải branch, bấm vào là checkout nhầm.
    check(!first.remotes.includes('origin'), 'origin/HEAD KHÔNG lọt vào danh sách remote');

    // ── Ca 1: tên trần của branch CHƯA có local → tạo local + track ───────────
    const r1 = await checkout(work, 'feature/x', false);
    const st1 = await status(work);
    check(r1.branch === 'feature/x' && r1.created, 'checkout "feature/x" tạo branch local cùng tên');
    check(r1.trackedFrom === 'origin/feature/x', 'ghi rõ đã track origin/feature/x');
    check(!st1.detached && st1.branch === 'feature/x', 'KHÔNG rơi vào detached HEAD');
    check(st1.upstream === 'origin/feature/x', 'upstream được đặt → Push/ahead-behind hoạt động');
    check(
      await fs
        .access(path.join(work, 'x.txt'))
        .then(() => true)
        .catch(() => false),
      'code của branch đó đã nằm trên đĩa (x.txt)',
    );

    // ── Ca 2: bấm thẳng vào remote ref "origin/feature/y" ────────────────────
    const r2 = await checkout(work, 'origin/feature/y', false);
    const st2 = await status(work);
    check(r2.branch === 'feature/y' && r2.created, 'checkout "origin/feature/y" → branch local "feature/y"');
    check(!st2.detached && st2.upstream === 'origin/feature/y', 'cũng có upstream, cũng không detached');

    // ── Ca 3: remote ref mà local CÙNG TÊN đã có → dùng lại, không đẻ thêm ───
    const before = (await branches(work)).branches.length;
    const r3 = await checkout(work, 'origin/feature/x', false);
    const after = await branches(work);
    check(r3.branch === 'feature/x' && !r3.created, 'local đã có thì checkout nó, không tạo bản sao');
    check(after.branches.length === before, `số branch local không tăng (${before})`);

    // ── Ca 4: branch local sẵn có — đường thường gặp nhất ───────────────────
    const r4 = await checkout(work, 'main', false);
    check(r4.branch === 'main' && !r4.created, 'checkout branch local "main" chạy bình thường');

    // ── Ca 5: tạo branch mới từ một remote ref ──────────────────────────────
    const r5 = await checkout(work, 'hotfix/1', true, 'origin/feature/y');
    check(r5.branch === 'hotfix/1' && r5.created, 'tạo "hotfix/1" từ origin/feature/y');
    check((await status(work)).branch === 'hotfix/1', 'đang đứng trên branch vừa tạo');
    await checkout(work, 'main', false);

    // ── Ca 6: các lỗi phải nói tiếng người ──────────────────────────────────
    const eGone = await errorOf(() => checkout(work, 'khong-ton-tai', false));
    check(!!eGone && eGone.includes('không có branch'), 'branch không tồn tại → báo rõ, kèm gợi ý Fetch');
    const eDup = await errorOf(() => checkout(work, 'main', true));
    check(!!eDup && eDup.includes('đã có rồi'), 'tạo trùng tên branch đã có → chặn, bảo chọn trong danh sách');
    const eDash = await errorOf(() => checkout(work, '--force', false));
    check(!!eDash && eDash.includes('không hợp lệ'), 'tên bắt đầu bằng dấu "-" bị từ chối (không thành cờ của git)');

    // ── Ca 7: working tree bẩn — git chặn, ta phải chỉ việc phải làm ─────────
    // Sửa đúng file mà branch kia cũng đụng (README có nội dung khác nhau).
    await git(work, ['checkout', '-q', 'main']);
    await fs.writeFile(path.join(work, 'x.txt'), 'dang sua do\n', 'utf8');
    await git(work, ['add', 'x.txt']);
    await git(work, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'main cham vao x']);
    await fs.writeFile(path.join(work, 'x.txt'), 'chua commit\n', 'utf8');
    const eDirty = await errorOf(() => checkout(work, 'feature/x', false));
    check(!!eDirty && eDirty.includes('chưa lưu'), 'working tree bẩn → kèm câu "commit hoặc bỏ thay đổi rồi thử lại"');
    await git(work, ['checkout', '--', 'x.txt']);

    // ── Ca 8: fetch kéo về branch người khác VỪA push ────────────────────────
    await git(src, ['checkout', '-q', '-b', 'feature/late', 'main']);
    await commitFile(src, 'late.txt', 'late\n', 'feat late');
    await git(src, ['push', '-q', origin, 'refs/heads/feature/late:refs/heads/feature/late']);

    const stale = await branches(work);
    check(!stale.remotes.includes('origin/feature/late'), 'chưa fetch thì branch mới CHƯA hiện (đúng như git)');
    const fetched = await fetchBranches(work);
    check(fetched.fetched, 'fetchBranches() chạy được');
    check(fetched.branches.remotes.includes('origin/feature/late'), 'fetch xong branch mới hiện ra trong danh sách');
    const r8 = await checkout(work, 'origin/feature/late', false);
    check(r8.branch === 'feature/late' && r8.created, 'checkout được branch vừa fetch về');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  console.log(failures === 0 ? '\nTất cả OK.' : `\n${failures} kiểm tra thất bại.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
