/**
 * Chia "làn" (lane) cho đồ thị commit — thuật toán chuẩn của gitk/SmartGit.
 * Đầu vào: commit theo --topo-order (con luôn đứng trước cha). Mỗi dòng trả về
 * điểm (node) + các đoạn nối, toạ độ tính theo làn và nửa dòng:
 *   y = 0 mép trên · 0.5 tâm node · 1 mép dưới.
 */

export interface GraphInput {
  hash: string;
  parents: string[];
}

export interface GraphSeg {
  /** Làn/vị trí y bắt đầu → kết thúc. */
  x1: number; y1: number; x2: number; y2: number;
  /** Làn quyết định màu đoạn. */
  lane: number;
}

export interface GraphRow {
  col: number;
  merge: boolean;
  segs: GraphSeg[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Số làn lớn nhất xuất hiện — để định bề rộng cột đồ thị. */
  width: number;
}

export function layoutGraph(commits: GraphInput[]): GraphLayout {
  /** lanes[i] = hash commit mà làn i đang chờ gặp (null = làn trống). */
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let width = 1;

  const freeLane = (): number => {
    const i = lanes.indexOf(null);
    if (i >= 0) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const c of commits) {
    const segs: GraphSeg[] = [];
    const before = lanes.slice();

    // Làn đang chờ commit này: node nằm ở làn đầu tiên; các làn còn lại hội tụ vào node.
    let col = before.indexOf(c.hash);
    if (col < 0) col = freeLane();

    for (let i = 0; i < before.length; i++) {
      const h = before[i];
      if (h === null) continue;
      if (h === c.hash) segs.push({ x1: i, y1: 0, x2: col, y2: 0.5, lane: i });
      else segs.push({ x1: i, y1: 0, x2: i, y2: 1, lane: i }); // làn đi ngang qua
    }

    // Giải phóng mọi làn vừa hội tụ, rồi gán cha.
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.hash) lanes[i] = null;

    c.parents.forEach((p, idx) => {
      let target = lanes.indexOf(p);
      if (target < 0) {
        // Cha đầu tiên tiếp tục làn của node nếu còn trống; cha khác mở làn mới.
        target = idx === 0 && lanes[col] === null ? col : freeLane();
        lanes[target] = p;
      }
      segs.push({ x1: col, y1: 0.5, x2: target, y2: 1, lane: target });
    });

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, before.length, lanes.length, col + 1);
    rows.push({ col, merge: c.parents.length > 1, segs });
  }

  return { rows, width };
}

export const GRAPH_COLORS = [
  '#4c8dff', '#3fb950', '#d29922', '#db61a2', '#a371f7', '#39c5cf', '#f0883e', '#f85149',
];
