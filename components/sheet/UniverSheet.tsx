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
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import coreVi from '@univerjs/preset-sheets-core/locales/vi-VN';
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter';
import filterVi from '@univerjs/preset-sheets-filter/locales/vi-VN';
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort';
import sortVi from '@univerjs/preset-sheets-sort/locales/vi-VN';
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace';
import findVi from '@univerjs/preset-sheets-find-replace/locales/vi-VN';
import { UniverSheetsConditionalFormattingPreset } from '@univerjs/preset-sheets-conditional-formatting';
import cfVi from '@univerjs/preset-sheets-conditional-formatting/locales/vi-VN';
import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation';
import dvVi from '@univerjs/preset-sheets-data-validation/locales/vi-VN';
import { UniverSheetsHyperLinkPreset } from '@univerjs/preset-sheets-hyper-link';
import linkVi from '@univerjs/preset-sheets-hyper-link/locales/vi-VN';
import { UniverSheetsNotePreset } from '@univerjs/preset-sheets-note';
import noteVi from '@univerjs/preset-sheets-note/locales/vi-VN';
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

const isDark = () => document.documentElement.getAttribute('data-theme') !== 'light';

/** Những gì khung bao ngoài (UniverPane) cần từ Univer để hiện "N thay đổi" và lưu. */
export interface UniverHandle {
  /** So bản chụp hiện tại với MỐC lúc nạp (hoặc lần lưu gần nhất). */
  diff(): DiffResult;
  /** Lưới giá trị chuỗi của sheet đầu tiên (cho CSV). */
  grid(): string[][];
  /** Coi trạng thái hiện tại là mốc mới — gọi sau khi lưu thành công. */
  rebase(): void;
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

    const { univer, univerAPI } = createUniver({
      locale: LocaleType.VI_VN,
      locales: {
        [LocaleType.VI_VN]: mergeLocales(coreVi, filterVi, sortVi, findVi, cfVi, dvVi, linkVi, noteVi),
      },
      presets: [
        UniverSheetsCorePreset({ container: host }),
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
    univerAPI.toggleDarkMode(isDark());

    // MỐC so sánh = bản chụp của chính Univer ngay sau khi nạp (không phải dữ liệu server
    // gửi xuống) — cùng một cách biểu diễn nên không sinh thay đổi giả.
    const snap = () => JSON.parse(JSON.stringify(wb.save())) as Snapshot;
    let base = snap();
    readyRef.current({
      diff: () => diffSnapshots(base, snap()),
      grid: () => snapshotToGrid(snap()),
      rebase: () => { base = snap(); },
    });
    const sub = wb.onCommandExecuted((cmd) => {
      if (cmd.id.startsWith('sheet.mutation.')) editedRef.current();
    });

    // Đổi theme app (html[data-theme]) thì Univer đổi theo.
    const mo = new MutationObserver(() => univerAPI.toggleDarkMode(isDark()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      sub.dispose();
      mo.disconnect();
      univer.dispose();
    };
  }, [workbook]);

  return <div ref={hostRef} className="univer-host" />;
}
