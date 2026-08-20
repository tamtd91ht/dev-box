// Tách một unified diff của git thành cấu trúc để vẽ được như SourceTree:
// từng hunk, từng dòng có SỐ DÒNG hai bên (trước / sau).
//
// VÌ SAO PHẢI PARSE Ở CLIENT: `/api/git` trả về nguyên văn patch (string). Bản
// giao diện cũ đổ thẳng chuỗi đó ra <pre> rồi tô màu theo ký tự đầu dòng — nên
// mất hết thông tin quan trọng: không biết dòng nào là dòng số bao nhiêu, không
// gom được theo hunk, không tách được cột cũ/mới. Muốn có cảm giác SourceTree
// thì phải có số dòng, mà số dòng chỉ suy ra được từ header `@@ -a,b +c,d @@`.
//
// Parse ở client thay vì đổi API: patch vẫn là nguồn thật của git, và giữ API
// nguyên vẹn thì mọi chỗ đang gọi 'diff'/'commit-diff' không phải sửa gì.

/** Loại của một dòng trong diff. */
export type DiffLineKind = 'ctx' | 'add' | 'del' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  /** Nội dung đã bỏ ký tự dấu ở đầu (+/-/space). */
  text: string;
  /** Số dòng ở bản CŨ — null với dòng thêm mới. */
  oldNo: number | null;
  /** Số dòng ở bản MỚI — null với dòng bị xoá. */
  newNo: number | null;
}

export interface DiffHunk {
  /** Nguyên văn header `@@ -1,7 +1,9 @@ hàm nào đó` — hiện làm tiêu đề hunk. */
  header: string;
  /** Phần chú thích sau `@@` (git ghi tên hàm/section chứa hunk này). */
  section: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  /** Các dòng đầu patch (`diff --git`, `index`, `+++`, `---`). Ít khi cần hiện. */
  meta: string[];
  added: number;
  removed: number;
  /** Patch có nội dung nhưng không có hunk nào — binary, đổi mode, rename thuần. */
  binary: boolean;
}

const HUNK_RE = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+(.*)$/;

/**
 * Parse unified diff. Không bao giờ throw — patch lạ thì trả về phần đọc được,
 * vì thà hiện thiếu còn hơn làm sập cả panel diff.
 */
export function parseDiff(patch: string): ParsedDiff {
  const out: ParsedDiff = { hunks: [], meta: [], added: 0, removed: 0, binary: false };
  if (!patch || !patch.trim()) return out;

  // Bỏ dòng rỗng CUỐI mà split sinh ra khi patch kết thúc bằng newline. Giữ lại
  // thì hunk cuối có thêm một dòng ngữ cảnh rỗng không tồn tại trong file thật.
  const lines = patch.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let cur: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of lines) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      cur = {
        header: raw,
        section: (m[5] ?? '').trim(),
        oldStart: oldNo,
        newStart: newNo,
        lines: [],
      };
      out.hunks.push(cur);
      continue;
    }

    // Trước hunk đầu tiên: header của patch.
    if (!cur) {
      if (raw) out.meta.push(raw);
      if (/^(Binary files|GIT binary patch)/.test(raw)) out.binary = true;
      continue;
    }

    // `\ No newline at end of file` — ghi chú của git, không phải nội dung.
    if (raw.startsWith('\\')) {
      cur.lines.push({ kind: 'meta', text: raw.slice(1).trim(), oldNo: null, newNo: null });
      continue;
    }

    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === '+') {
      cur.lines.push({ kind: 'add', text, oldNo: null, newNo });
      newNo += 1;
      out.added += 1;
    } else if (sign === '-') {
      cur.lines.push({ kind: 'del', text, oldNo, newNo: null });
      oldNo += 1;
      out.removed += 1;
    } else {
      // Dòng ngữ cảnh. Dòng RỖNG trong patch cũng là ngữ cảnh (git ghi một dấu
      // cách, nhưng nhiều công cụ cắt mất khoảng trắng cuối) — nên `raw === ''`
      // vẫn phải tính là một dòng ngữ cảnh, bỏ qua là lệch hết số dòng phía sau.
      cur.lines.push({ kind: 'ctx', text, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    }
  }

  if (out.hunks.length === 0 && out.meta.length > 0) out.binary = true;
  return out;
}
