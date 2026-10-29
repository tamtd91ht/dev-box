'use client';

// Giao diện bảng tính kiểu Excel của tab Excel — dựng bằng Univer (mã nguồn mở,
// Apache-2.0): thanh công cụ + thanh công thức + tab sheet như Excel, lưới vẽ bằng
// canvas nên cuộn mượt cả trăm nghìn dòng, và có sẵn freeze panes, lọc, sắp xếp,
// tìm/thay (Ctrl+F / Ctrl+H), conditional formatting, data validation, hyperlink,
// ghi chú, undo/redo, công thức.
//
// Component này CHỈ lo phần hiển thị: nhận dữ liệu workbook đã chuyển sẵn ở server
// (lib/sheetUniver) và dựng/huỷ Univer. Tải dữ liệu + khung bao ngoài ở UniverPane.
//
// Chỉ chạy ở client (import động ssr:false từ UniverPane) — Univer đụng vào DOM/canvas
// ngay lúc import nên không thể render ở server.

import { useEffect, useRef } from 'react';
import { createUniver, greenTheme, LocaleType, mergeLocales } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import coreEn from '@univerjs/preset-sheets-core/locales/en-US';
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter';
import filterEn from '@univerjs/preset-sheets-filter/locales/en-US';
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort';
import sortEn from '@univerjs/preset-sheets-sort/locales/en-US';
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace';
import findEn from '@univerjs/preset-sheets-find-replace/locales/en-US';
import { UniverSheetsConditionalFormattingPreset } from '@univerjs/preset-sheets-conditional-formatting';
import cfEn from '@univerjs/preset-sheets-conditional-formatting/locales/en-US';
import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation';
import dvEn from '@univerjs/preset-sheets-data-validation/locales/en-US';
import { UniverSheetsHyperLinkPreset } from '@univerjs/preset-sheets-hyper-link';
import linkEn from '@univerjs/preset-sheets-hyper-link/locales/en-US';
import { UniverSheetsNotePreset } from '@univerjs/preset-sheets-note';
import noteEn from '@univerjs/preset-sheets-note/locales/en-US';
import type { UWorkbook } from '@/lib/sheetUniver';
import { diffSnapshots, snapshotToGrid, type DiffResult, type Snapshot } from '@/lib/sheetUniverDiff';

import '@univerjs/preset-sheets-core/lib/index.css';
import '@univerjs/preset-sheets-filter/lib/index.css';
import '@univerjs/preset-sheets-sort/lib/index.css';
import '@univerjs/preset-sheets-find-replace/lib/index.css';
import '@univerjs/preset-sheets-conditional-formatting/lib/index.css';
import '@univerjs/preset-sheets-data-validation/lib/index.css';
import '@univerjs/preset-sheets-hyper-link/lib/index.css';
import '@univerjs/preset-sheets-note/lib/index.css';


/** Những gì khung bao ngoài (UniverPane) cần từ Univer để hiện "N thay đổi" và lưu. */
export interface UniverHandle {
  /** So bản chụp hiện tại với MỐC lúc nạp (hoặc lần lưu gần nhất). */
  diff(): DiffResult;
  /** Lưới giá trị chuỗi của sheet đầu tiên (cho CSV). */
  grid(): string[][];
  /** Coi trạng thái hiện tại là mốc mới — gọi sau khi lưu thành công. */
  rebase(): void;
  /** Facade API của Univer — ribbon kiểu Excel gọi lệnh qua đây. */
  api: ReturnType<typeof createUniver>['univerAPI'];
}

export default function UniverSheet({ workbook, onReady, onEdited }: {
  workbook: UWorkbook;
  onReady: (h: UniverHandle) => void;
  /** Có lệnh sửa dữ liệu vừa chạy (chưa debounce) — để cha lên lịch tính lại số thay đổi. */
  onEdited: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Giữ callback mới nhất trong ref: effect dựng Univer chỉ chạy lại khi đổi workbook.
  const readyRef = useRef(onReady);
  const editedRef = useRef(onEdited);
  readyRef.current = onReady;
  editedRef.current = onEdited;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Mỗi lần dựng Univer có <div> gắn riêng: lúc huỷ thì gỡ div này khỏi DOM ngay,
    // còn univer.dispose() hoãn sang macrotask (xem cleanup) — nếu workbook đổi, bản
    // mới dựng vào div mới, không giẫm lên React root của bản cũ chưa kịp huỷ.
    const mount = document.createElement('div');
    mount.style.cssText = 'position:absolute;inset:0';
    host.appendChild(mount);

    const { univer, univerAPI } = createUniver({
      // Giao diện mô phỏng Microsoft Excel → chữ tiếng Anh như Excel, tông xanh lá
      // của Excel (viền ô chọn, nút chính). Ribbon gốc của Univer tắt (toolbar:false)
      // — thay bằng ExcelRibbon; thanh công thức + tab sheet vẫn của Univer.
      locale: LocaleType.EN_US,
      locales: {
        [LocaleType.EN_US]: mergeLocales(coreEn, filterEn, sortEn, findEn, cfEn, dvEn, linkEn, noteEn),
      },
      theme: greenTheme,
      presets: [
        UniverSheetsCorePreset({ container: mount, toolbar: false }),
        UniverSheetsFilterPreset(),
        UniverSheetsSortPreset(),
        UniverSheetsFindReplacePreset(),
        UniverSheetsConditionalFormattingPreset(),
        UniverSheetsDataValidationPreset(),
        UniverSheetsHyperLinkPreset(),
        UniverSheetsNotePreset(),
      ],
    });

    // Dữ liệu từ server là JSON thuần đúng hình IWorkbookData; typings của Univer
    // đòi enum nên ép kiểu ở đây thay vì kéo enum vào code server.
    const wb = univerAPI.createWorkbook(workbook as never);
    // Luôn nền sáng như Microsoft Excel (ô trắng, viền xám) — không theo theme tối của app.
    univerAPI.toggleDarkMode(false);

    // MỐC so sánh = bản chụp của chính Univer ngay sau khi nạp (không phải dữ liệu server
    // gửi xuống) — cùng một cách biểu diễn nên không sinh thay đổi giả.
    const snap = () => JSON.parse(JSON.stringify(wb.save())) as Snapshot;
    let base = snap();
    readyRef.current({
      diff: () => diffSnapshots(base, snap()),
      grid: () => snapshotToGrid(snap()),
      rebase: () => { base = snap(); },
      api: univerAPI,
    });
    const sub = wb.onCommandExecuted((cmd) => {
      if (cmd.id.startsWith('sheet.mutation.')) editedRef.current();
    });

    return () => {
      sub.dispose();
      mount.remove();
      // Univer tự render UI bằng React root riêng; dispose() unmount root đó đồng bộ.
      // Cleanup này chạy giữa lúc React của app đang render/commit (vd. đổi tab ở
      // OfficeWorkspace) → React báo "synchronously unmount a root while React was
      // already rendering". Hoãn sang macrotask để unmount sau khi render xong.
      setTimeout(() => univer.dispose(), 0);
    };
  }, [workbook]);

  return <div ref={hostRef} className="univer-host" />;
}
