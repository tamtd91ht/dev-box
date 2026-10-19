'use client';

// Xuất kết quả PG quick-find ra .xlsx — dùng hộp thoại chung (components/export/ExportDialog: khai cột, cột thời gian
// theo pattern, nối cột từ bảng/index khác, lưu cấu hình).
//
// Chạy lại CHÍNH mệnh đề WHERE đã tham số hoá, lật từng trang (200 dòng/trang), chỉ SELECT các cột được nhắc tới.
// Cột jsonb chứa mảng object khai được dạng "deviceInfos.deviceId" (xem collectByPath ở lib/mongoReport).
//
// PHÂN TRANG: vẫn LIMIT/OFFSET — quick-find PG chưa có khoá sort ổn định để đi keyset.

import { pgQuickFind, pgQuickCount, type PgQuickEntry, type PgSortKey } from '@/lib/pg';
import { runExport, parseRows } from '../export/exportRun';
import ExportDialog from '../export/ExportDialog';

const PAGE = 200;

export interface ExportModalProps {
  connectionId: string;
  db: string;
  schema: string;
  table: string;
  /** Điều kiện của lần chạy đang xuất (tham số hoá ở server). */
  entries: PgQuickEntry[];
  /** Sort của LẦN CHẠY vừa rồi — file xuất cùng thứ tự bảng đang nhìn. */
  sort?: PgSortKey[];
  sortSummary?: string;
  querySummary: string;
  /** Gợi ý cột (từ information_schema). */
  fieldSuggestions: string[];
  defaultTitle: string;
  onClose: () => void;
  onDone: (rows: number, filename: string) => void;
}

export default function ExportModal(props: ExportModalProps) {
  const { connectionId, db, schema, table, entries, sort } = props;
  return (
    <ExportDialog
      target={`${db}.${schema}.${table}`}
      querySummary={props.querySummary}
      sortSummary={props.sortSummary}
      fieldSuggestions={props.fieldSuggestions}
      defaultTitle={props.defaultTitle}
      placeholder="column (vd. created_at)"
      allowJoin
      countRows={async () => (await pgQuickCount(connectionId, db, { schema, table, entries })).count}
      fetchRows={({ paths, max, onProgress }) =>
        runExport<number>({
          max,
          onProgress,
          fetchPage: async (offset) => {
            const at = offset ?? 0;
            // Cột jsonb khai dạng "doc.field" → SELECT vẫn phải lấy cột GỐC ("doc"); `paths` đã là field cấp 1.
            const page = await pgQuickFind(connectionId, db, {
              schema, table, entries, limit: PAGE, offset: at, columns: paths.length ? paths : undefined, sort: sort?.length ? sort : undefined,
            });
            return { rows: parseRows(page.rows), next: page.hasMore ? at + PAGE : null };
          },
        })}
      onClose={props.onClose}
      onDone={props.onDone}
    />
  );
}
