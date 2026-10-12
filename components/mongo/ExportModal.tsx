'use client';

// Xuất kết quả Mongo ra .xlsx: dùng hộp thoại chung (components/export/ExportDialog — tiêu đề, khai cột, cột thời gian
// theo pattern, tách dòng theo list, nối cột từ bảng/index khác, lưu cấu hình), chỉ khai báo cách đếm + cách phân trang.
//
// PHÂN TRANG: không sort riêng thì đi bằng CURSOR _id (sort _id tăng dần, trang sau lọc `_id > _id cuối`) — skip sâu
// dần trên collection lớn chậm dần đều. Có sort riêng của người dùng thì buộc phải dùng skip, vì cursor chỉ đúng khi
// sắp theo đúng khoá làm cursor.

import { findMongo, countMongo, withIdCursor } from '@/lib/mongo';
import { runExport, parseRows } from '../export/exportRun';
import ExportDialog from '../export/ExportDialog';
import type { SuggestOption } from '../SuggestInput';

const PAGE = 200;

export interface ExportModalProps {
  connectionId: string;
  db: string;
  coll: string;
  /** EJSON filter của truy vấn đang xuất (lấy từ lần chạy gần nhất). */
  filter: string;
  /** Sort EJSON của LẦN CHẠY vừa rồi — file xuất phải cùng thứ tự bảng đang nhìn. Rỗng = không sort (đi bằng cursor _id). */
  sort?: string;
  /** Mô tả sort cho hộp thoại xác nhận, vd "created_at ↓ · name ↑". */
  sortSummary?: string;
  /** Tóm tắt ngắn hiện ở phụ đề sheet, vd `{domain:alice}`. */
  querySummary: string;
  /** Gợi ý tên field (đã phát hiện + path của preset) cho bảng khai cột. */
  fieldSuggestions: Array<string | SuggestOption>;
  defaultTitle: string;
  onClose: () => void;
  onDone: (rows: number, filename: string) => void;
}

export default function ExportModal(props: ExportModalProps) {
  const { connectionId, db, coll, filter, sort } = props;
  return (
    <ExportDialog
      target={`${db}.${coll}`}
      querySummary={props.querySummary}
      sortSummary={props.sortSummary}
      fieldSuggestions={props.fieldSuggestions}
      defaultTitle={props.defaultTitle}
      placeholder="field code (vd. deviceInfos.deviceId)"
      allowExplode
      allowJoin
      countRows={async () => (await countMongo(connectionId, db, coll, filter)).count}
      fetchRows={async ({ paths, max, onProgress }) => {
        // Projection: chỉ field cấp 1 được nhắc tới mới đi qua đường truyền.
        const proj: Record<string, 0 | 1> = {};
        for (const t of paths) if (t !== '_id') proj[t] = 1;
        const userSort = sort?.trim() ?? '';
        // _id phải có mặt khi đi bằng cursor — nó là khoá lật trang.
        if (!paths.includes('_id') && userSort) proj._id = 0;
        const projection = JSON.stringify(proj);
        const effSort = userSort || JSON.stringify({ _id: 1 });
        return runExport<{ skip: number; lastId: unknown }>({
          max,
          onProgress,
          fetchPage: async (cursor) => {
            const useCursor = !userSort;
            const pageFilter = useCursor && cursor?.lastId !== undefined ? withIdCursor(filter, cursor.lastId) : filter;
            const page = await findMongo(connectionId, db, coll, {
              filter: pageFilter, projection, sort: effSort, limit: PAGE, skip: useCursor ? 0 : (cursor?.skip ?? 0),
            });
            const parsed = parseRows(page.docs);
            const lastId = parsed.length ? parsed[parsed.length - 1]._id : undefined;
            // Chốt chặn: cursor _id không tiến → dừng, không lặp vô hạn.
            const stuck = useCursor && lastId !== undefined && JSON.stringify(lastId) === JSON.stringify(cursor?.lastId);
            return { rows: stuck ? [] : parsed, next: page.hasMore && !stuck ? { skip: (cursor?.skip ?? 0) + PAGE, lastId } : null };
          },
        });
      }}
      onClose={props.onClose}
      onDone={props.onDone}
    />
  );
}
