// Browser Workspace Framework — account instances (renderer side).
//
// A single-account plugin has exactly one context. A `multiAccount` plugin (e.g.
// Zalo) can have several, each a fully independent browser session with its own
// persistent partition — so two Zalo accounts stay logged in at the same time.
// The account list is remembered per machine in localStorage (desktop userData).

import type { WorkspaceConfig, WorkspacePlugin } from './types';

export interface WorkspaceAccount {
  /** Owning plugin id. */
  pluginId: string;
  /** Stable per-account id — part of the session partition. */
  instanceId: string;
  /** Editable label shown in the rail. */
  label: string;
  /**
   * Ẩn thông báo của riêng tài khoản này.
   *
   * ẨN ≠ TẮT ĐẾM. Guest vẫn chạy, vẫn đếm, vẫn thu tin cho automation y như cũ —
   * chỉ là số đó KHÔNG dội ra ngoài nữa: không cộng vào huy hiệu nhóm, không
   * cộng vào huy hiệu tab Workspace, không đổi tiêu đề cửa sổ, không kêu chuông.
   * Số vẫn hiện ngay trên dòng của tài khoản đó trong rail, để mở workspace ra
   * là biết có gì mới — đúng như yêu cầu "chỉ hiển thị trên account đó thôi".
   *
   * Vắng mặt = false, nên tài khoản cũ đã lưu từ trước vẫn báo bình thường.
   */
  muted?: boolean;
  /**
   * Ảnh đại diện thật của tài khoản, dạng data URL, đọc được từ trong guest
   * (xem lib/workspace/avatar.ts). Lưu xuống localStorage để mở app lên là rail
   * có mặt ngay, không phải đợi guest đăng nhập xong mới hiện.
   *
   * Vắng mặt = chưa đọc được (chưa đăng nhập, app không khai `avatar`, hoặc ảnh
   * khác gốc không cho canvas đọc) → rail lui về BrandMark. Ảnh 44px PNG nên cỡ
   * vài KB, không đụng hạn mức localStorage.
   */
  avatar?: string;
}

const storeKey = (pluginId: string) => `ws:accounts:${pluginId}`;

/** Short opaque id for a new account partition. */
function uid(): string {
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  } catch {
    return `a${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

/** The implicit single account for a normal plugin. */
export function defaultAccount(plugin: WorkspacePlugin): WorkspaceAccount {
  return { pluginId: plugin.id, instanceId: 'main', label: plugin.name };
}

/**
 * Load the persisted account list (single-account plugins always return one).
 *
 * Danh sách RỖNG đã lưu là một lựa chọn có thật: người dùng vừa gỡ hết tài khoản
 * của app đó. Phải trả về rỗng chứ không gieo lại — nếu không, gỡ xong mở lại là
 * nó mọc về, coi như nút gỡ không có tác dụng. Chỉ khi CHƯA có gì trong
 * localStorage (lần đầu) mới gieo một tài khoản mặc định.
 */
export function loadAccounts(plugin: WorkspacePlugin): WorkspaceAccount[] {
  if (!plugin.multiAccount || typeof window === 'undefined') return [defaultAccount(plugin)];
  try {
    const raw = localStorage.getItem(storeKey(plugin.id));
    const arr = raw ? (JSON.parse(raw) as WorkspaceAccount[]) : null;
    if (Array.isArray(arr)) return arr;
  } catch {
    /* fall through to seed */
  }
  const seed = [{ pluginId: plugin.id, instanceId: 'main', label: `${plugin.name} 1` }];
  saveAccounts(plugin.id, seed);
  return seed;
}

export function saveAccounts(pluginId: string, list: WorkspaceAccount[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(storeKey(pluginId), JSON.stringify(list));
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * A fresh account for a multiAccount plugin, numbered for a default label.
 *
 * Số thứ tự lấy theo chỗ TRỐNG đầu tiên, không lấy theo độ dài danh sách: gỡ
 * "Zalo 1" rồi thêm lại mà đánh số theo length thì ra "Zalo 2" trùng ngay với
 * cái đang có.
 */
export function newAccount(plugin: WorkspacePlugin, existing: WorkspaceAccount[] = []): WorkspaceAccount {
  const taken = new Set(existing.map((a) => a.label));
  let n = 1;
  while (taken.has(`${plugin.name} ${n}`)) n += 1;
  return { pluginId: plugin.id, instanceId: uid(), label: `${plugin.name} ${n}` };
}

/**
 * Session partition for one account. `persist:` writes to disk (login survives
 * restart). Every account gets a distinct partition so their logins never mix.
 */
export function partitionForAccount(
  plugin: WorkspacePlugin,
  instanceId: string,
  cfg: WorkspaceConfig,
): string {
  const key = `ws-${plugin.id}-${instanceId}`;
  return cfg.persistSession ? `persist:${key}` : key;
}

/** Stable map key for one open account. */
export const accountKey = (pluginId: string, instanceId: string) => `${pluginId}::${instanceId}`;
