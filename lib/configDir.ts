// Nơi DUY NHẤT quyết định chỗ lưu mọi file registry/state local (git-projects,
// links, mail accounts, connections, tokens…). Trước đây mỗi file nằm rải rác
// ở repo-root dưới dạng .xxx.json và phải liệt kê TỪNG file trong .gitignore —
// quên một dòng là commit nhầm secret. Giờ gom hết vào ./configs/ và chỉ cần
// gitignore `configs/`.
//
// AUTO-MIGRATE: lần đầu một module hỏi tới file, nếu configs/<name> chưa có mà
// file .xxx.json cũ còn ở root thì DI CHUYỂN sang — dữ liệu hiện tại của người
// dùng không mất. Đồng bộ (một lần, rẻ) để mọi caller thấy đường dẫn ổn định.

import fs from 'fs';
import path from 'path';

const CONFIG_DIR = process.env.DEVBOX_CONFIG_DIR
  ? path.resolve(process.cwd(), process.env.DEVBOX_CONFIG_DIR)
  : path.join(process.cwd(), 'configs');

let ensured = false;
function ensureDir(): void {
  if (ensured) return;
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch { /* đã tồn tại */ }
  ensured = true;
}

/**
 * Đường dẫn tuyệt đối tới một file config trong ./configs.
 *
 * @param name Tên file trong configs, KHÔNG có dấu chấm đầu (vd "links.json").
 * @param legacyBasenames Các tên file cũ ở repo-root để migrate (vd
 *        [".links.json", ".googlelinks.json"]). File đầu tiên tồn tại sẽ được
 *        chuyển vào configs/<name> nếu configs/<name> chưa có.
 */
export function configPath(name: string, legacyBasenames: string[] = []): string {
  ensureDir();
  const target = path.join(CONFIG_DIR, name);
  if (!fs.existsSync(target)) {
    for (const legacy of legacyBasenames) {
      const old = path.join(process.cwd(), legacy);
      if (fs.existsSync(old)) {
        try {
          fs.renameSync(old, target);
        } catch {
          // Rename fail (khác ổ đĩa…) → copy rồi xóa.
          try { fs.copyFileSync(old, target); fs.rmSync(old); } catch { /* bỏ qua, coi như chưa có */ }
        }
        break;
      }
    }
  }
  return target;
}
