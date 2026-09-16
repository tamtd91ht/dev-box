// Client helpers + types cho tab API (Postman-like). Browser-safe.

export interface ApiHeader { key: string; value: string; on?: boolean }

/**
 * Kiểu body, đặt tên theo đúng content-type sẽ gửi đi:
 *   'none'      — không có body.
 *   'raw'       — text thô (JSON/XML/… ), người dùng tự đặt Content-Type.
 *   'form'      — application/x-www-form-urlencoded.
 *   'multipart' — multipart/form-data, có thể kèm FILE.
 *
 * 'form' giữ nguyên tên cũ (không đổi thành 'urlencoded') để các request ĐÃ LƯU
 * trong apicollections.json không phải migrate — đổi tên là mọi request cũ rơi
 * về 'none' và mất body.
 */
export type ApiBodyType = 'none' | 'raw' | 'form' | 'multipart';

/** Một dòng trong form (urlencoded hoặc multipart). */
export interface ApiFormField {
  key: string;
  /** Giá trị text. Bỏ trống khi `kind: 'file'`. */
  value: string;
  /** Tắt tạm một dòng mà không phải xoá — như hàng header. */
  on?: boolean;
  /** 'file' chỉ hợp lệ trong multipart; urlencoded không mang file được. */
  kind?: 'text' | 'file';
  /** kind='file': tên file để hiện lại trên UI sau khi tải lại app. */
  fileName?: string;
  /**
   * kind='file': nội dung file dạng base64.
   *
   * CỐ Ý KHÔNG LƯU xuống collections (xem stripFiles): file vài MB nhồi vào
   * JSON làm file cấu hình phình to và chậm mọi lần đọc/ghi. Chọn lại file khi
   * cần gửi — đúng cách Postman xử lý request đã lưu.
   */
  fileB64?: string;
  /** kind='file': content-type của file, để server dựng lại đúng phần MIME. */
  fileType?: string;
}

export interface ApiRequest {
  id: string;
  name: string;
  folder?: string;
  method: string;
  url: string;
  headers: ApiHeader[];
  body: string;
  bodyType: ApiBodyType;
  /** Các dòng form khi bodyType là 'form' hoặc 'multipart'. */
  form?: ApiFormField[];
  updatedAt: string;
}

export interface ApiEnvironment {
  id: string;
  name: string;
  vars: { key: string; value: string }[];
}

export interface ApiData {
  requests: ApiRequest[];
  environments: ApiEnvironment[];
  activeEnvId?: string;
}

export interface HttpResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  timeMs: number;
  size: number;
}

async function call<T>(endpoint: string, payload: Record<string, unknown>): Promise<T> {
  const r = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data as { ok?: boolean }).ok === false) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return (data as { result: T }).result;
}

const store = (action: string, params: Record<string, unknown> = {}) =>
  call<ApiData>('/api/api-collections', { action, ...params });

export const apiGet = () => store('get');
export const apiSaveRequest = (r: Partial<ApiRequest> & { name: string }) => store('saveRequest', { ...r });
export const apiRemoveRequest = (id: string) => store('removeRequest', { id });
export const apiSaveEnv = (e: Partial<ApiEnvironment> & { name: string }) => store('saveEnv', { ...e });
export const apiRemoveEnv = (id: string) => store('removeEnv', { id });
export const apiSetActiveEnv = (id: string | null) => store('setActiveEnv', { id });

/** Gửi một request qua proxy server (né CORS).
 *  `bodyType`/`form` để server tự dựng urlencoded hoặc multipart (kèm file);
 *  bỏ trống thì `body` được gửi nguyên văn như cũ. */
export const apiSend = (input: {
  method: string; url: string; headers?: ApiHeader[]; body?: string;
  bodyType?: ApiBodyType; form?: ApiFormField[];
}) => call<HttpResult>('/api/http', input);

/** Trần tổng dung lượng file đính kèm — base64 nằm trọn trong RAM của cả
 *  browser lẫn server, quá tay là treo app chứ không phải chỉ chậm. */
export const FILE_LIMIT = 20 * 1024 * 1024;

/** Bỏ RUỘT file trước khi lưu collections (giữ tên để UI còn hiện được). */
export function stripFiles(form: ApiFormField[] | undefined): ApiFormField[] | undefined {
  if (!form) return undefined;
  return form.map((f) => (f.kind === 'file' ? { ...f, fileB64: undefined } : f));
}
