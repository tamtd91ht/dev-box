// Cấu hình xuất Excel đã lưu (tiêu đề + danh sách cột + luật đổi giá trị) theo từng collection,
// để lần sau chọn lại thay vì khai cột từ đầu. Lưu ở localStorage của trình duyệt (cá nhân từng người).

import type { JoinDraft } from './exportJoin';
import type { ReportColumn } from './mongoReport';

const KEY = 'devbox-export-configs';

export interface MongoExportConfig {
  id: string;
  name: string;
  /** "db.collection" — gợi ý cấu hình hợp collection đang xuất lên đầu danh sách. */
  target: string;
  title: string;
  columns: ReportColumn[];
  /** Field list được tách thành nhiều dòng (chỉ màn hình bật tính năng này mới dùng). */
  explode?: string;
  /** Các phép nối cột sang bảng/index khác (cột dùng field code "~alias.field"). */
  joins?: JoinDraft[];
}

function isConfig(v: unknown): v is MongoExportConfig {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return typeof c.id === 'string' && typeof c.name === 'string' && typeof c.target === 'string' && Array.isArray(c.columns);
}

export function loadExportConfigs(): MongoExportConfig[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isConfig) : [];
  } catch {
    return [];
  }
}

function save(list: MongoExportConfig[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota / chế độ riêng tư */ }
}

/** Lưu theo tên (cùng tên + cùng target thì ghi đè). Trả danh sách mới. */
export function saveExportConfig(input: Omit<MongoExportConfig, 'id'>): MongoExportConfig[] {
  const list = loadExportConfigs();
  const at = list.findIndex((c) => c.name === input.name && c.target === input.target);
  if (at >= 0) list[at] = { ...list[at], ...input };
  else list.push({ id: `xc_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`, ...input });
  save(list);
  return list;
}

export function removeExportConfig(id: string): MongoExportConfig[] {
  const list = loadExportConfigs().filter((c) => c.id !== id);
  save(list);
  return list;
}
