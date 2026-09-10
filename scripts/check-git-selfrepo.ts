// scripts/check-git-selfrepo.ts — kiểm "project CHÍNH LÀ repo".
//
// VÌ SAO CÓ FILE NÀY: trỏ project thẳng vào một repo là ca mà detectRepos()
// trước đây trả về [] (nó chỉ quét con TRỰC TIẾP, mà một repo thì không chứa
// repo con) → tab Git trắng trơn, không có thông báo lỗi nào. Kiểu lỗi im lặng
// đó chỉ lộ ra khi thao tác tay trên UI, nên phải chốt bằng test.
//
// Ba cạm bẫy được canh ở đây:
//   • THƯ MỤC CON TRONG REPO bị nhận là repo: `rev-parse --is-inside-work-tree`
//     trả true cho cả `repo/lib`, nên nếu dùng nó thì trỏ project vào một
//     subfolder cũng "đỗ" — rồi mọi lệnh git chạy lên repo CHA với đường dẫn
//     hiện ra sai. Phải so `--show-toplevel`.
//   • CLONE VÀO GIỮA REPO: project loại này mà cho clone thì repo mới nằm bên
//     trong working tree đang mở, hiện ra thành file lạ của repo cha.
//   • MANIFEST BÁO KHỐNG: manifest ghi tên folder của máy đã đồng bộ, máy khác
//     clone ra tên khác vẫn là đúng repo đó — so theo tên sẽ báo cùng lúc
//     "thiếu 1" và "dư 1".
//
//   npx tsx scripts/check-git-selfrepo.ts

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { detectRepos, isSelfRepo } from '../lib/gitCore';

let failures = 0;
const ok = (m: string): void => console.log(`✓ ${m}`);
const fail = (m: string): void => {
  failures += 1;
  console.error(`✗ ${m}`);
};
const check = (cond: boolean, m: string): void => (cond ? ok(m) : fail(m));

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd, windowsHide: true }, (e) => (e ? reject(e) : resolve())),
  );
}

/** Repo thật trên đĩa — `git init` chứ không giả .git, vì chính lệnh git là thứ
 *  đang được kiểm (isSelfRepo gọi rev-parse). */
async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q']);
  // Cần một commit để repo có HEAD thật — status/branches đọc HEAD.
  await fs.writeFile(path.join(dir, 'README.md'), '# t\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
}

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'selfrepo-'));
  try {
    // ── Ca 1: root là thư mục CHỨA các repo (hành vi cũ, không được đổi) ──────
    const container = path.join(tmp, 'workspace');
    await initRepo(path.join(container, 'svc-a'));
    await initRepo(path.join(container, 'svc-b'));
    await fs.mkdir(path.join(container, 'not-a-repo'), { recursive: true });

    check(!(await isSelfRepo(container)), 'thư mục chứa repo: KHÔNG bị coi là self-repo');
    const many = await detectRepos(container);
    check(
      many.length === 2 && many.map((r) => r.name).join(',') === 'svc-a,svc-b',
      `thư mục chứa repo: quét ra đúng 2 repo con (được ${many.map((r) => r.name).join(',') || '∅'})`,
    );

    // ── Ca 2: root CHÍNH LÀ repo → đúng 1 entry, trỏ vào chính root ───────────
    const solo = path.join(tmp, 'dev-box');
    await initRepo(solo);

    check(await isSelfRepo(solo), 'root là repo: nhận ra self-repo');
    const one = await detectRepos(solo);
    check(one.length === 1, `root là repo: trả về đúng 1 repo (được ${one.length})`);
    check(
      one[0]?.path === path.resolve(solo),
      `root là repo: entry trỏ vào chính root (được ${one[0]?.path ?? '∅'})`,
    );
    check(one[0]?.name === 'dev-box', `root là repo: nhãn là tên folder (được ${one[0]?.name ?? '∅'})`);

    // ── Ca 3: THƯ MỤC CON trong repo không phải là repo root ──────────────────
    // Đây là cạm bẫy chính: --is-inside-work-tree trả true ở đây.
    const inner = path.join(solo, 'lib', 'deep');
    await fs.mkdir(inner, { recursive: true });
    check(!(await isSelfRepo(inner)), 'thư mục con trong repo: KHÔNG bị coi là self-repo');
    check(
      (await detectRepos(inner)).length === 0,
      'thư mục con trong repo: không quét ra repo nào (không "mượn" repo cha)',
    );

    // ── Ca 4: repo LỒNG trong repo → ưu tiên root, bỏ qua con ─────────────────
    const nested = path.join(tmp, 'outer');
    await initRepo(nested);
    await initRepo(path.join(nested, 'vendored'));
    const nestedRepos = await detectRepos(nested);
    check(
      nestedRepos.length === 1 && nestedRepos[0].path === path.resolve(nested),
      `repo lồng repo: chỉ hiện root, không hiện repo con (được ${nestedRepos.map((r) => r.name).join(',')})`,
    );

    // ── Ca 5: thư mục rỗng / không tồn tại vẫn im lặng trả rỗng ───────────────
    const empty = path.join(tmp, 'empty');
    await fs.mkdir(empty, { recursive: true });
    check(!(await isSelfRepo(empty)), 'thư mục rỗng: không phải self-repo');
    check((await detectRepos(empty)).length === 0, 'thư mục rỗng: quét ra 0 repo');
    check(
      (await detectRepos(path.join(tmp, 'khong-ton-tai'))).length === 0,
      'thư mục không tồn tại: quét ra 0 repo, không ném lỗi',
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  console.log(failures ? `\n${failures} kiểm tra THẤT BẠI` : '\nTất cả kiểm tra ĐẠT');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
