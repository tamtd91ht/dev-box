'use client';

// Data browser — NHIỀU TAB, mỗi tab một index và một phiên truy vấn riêng.
//
// Trước đây cả tab Dữ liệu chỉ có MỘT phiên: đổi index là mất sạch body query,
// kết quả và trang đang xem của index cũ. Giờ mỗi index mở ra một tab riêng
// (`+` để thêm), state của từng tab sống độc lập và giữ nguyên khi chuyển qua
// lại — so sánh hai index cạnh nhau không phải gõ lại query.
//
// Bố cục mỗi tab: chưa chọn index thì cây indices chiếm cột trái; chọn xong cây
// TỰ ẨN cho rộng chỗ đọc kết quả — đổi index bằng combobox trên đầu (gõ để lọc,
// Enter chọn), hoặc ☰ để mở lại cây.
//
// Everything here is read-only: _search / _count / _mapping, all bounded
// server-side (size ≤200, from+size ≤10k, 15s timeout, scripting rejected).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  listEsIndices,
  esMapping,
  searchEs,
  countEs,
  prettyDoc,
  fmtBytes,
  fmtCount,
  deriveEsFieldNames,
  type EsIndexInfo,
  type EsSearchResult,
  type WireDoc,
} from '@/lib/es';
import { flattenEsMapping, type EsField } from '@/lib/esDsl';
import ExportModal from './ExportModal';
import QueryEditor from './QueryEditor';
import AggsResult from './AggsResult';
import JsonViewer from './JsonViewer';
import { useSplit } from '@/lib/useSplit';
import Splitter from '../Splitter';

import SessionHistory from '../SessionHistory';
import { recordSession, short, type EsSession } from '@/lib/sessionHistory';

export interface BrowserViewProps {
  connectionId: string;
  /** Index pre-selected from the Overview jump (optional). */
  initialIndex?: string;
}

type IdxTab = 'docs' | 'mapping' | 'info';

const healthColor = (h: string) =>
  h === 'green' ? 'var(--ok)' : h === 'red' ? 'var(--err)' : 'var(--warn, #d5a021)';

/** Một tab dữ liệu — chỉ giữ danh tính, còn state truy vấn nằm trong <BrowserSession>. */
interface Tab {
  id: string;
  /** Index của tab; '' là tab mới chưa chọn index. */
  index: string;
}

let tabSeq = 0;
const newTab = (index = ''): Tab => ({ id: `t${++tabSeq}`, index });

export default function BrowserView({ connectionId, initialIndex }: BrowserViewProps) {
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab(initialIndex ?? '')]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);

  // Danh sách indices nạp MỘT LẦN cho cả cluster rồi chia cho mọi tab dùng —
  // mỗi tab tự gọi _cat/indices thì mở 5 tab là 5 lần gọi y hệt nhau.
  const [indices, setIndices] = useState<EsIndexInfo[]>([]);
  const [idxLoading, setIdxLoading] = useState(false);
  const [idxError, setIdxError] = useState<string | null>(null);

  const loadIndices = useCallback(async () => {
    setIdxLoading(true); setIdxError(null);
    try { setIndices(await listEsIndices(connectionId)); }
    catch (e) { setIdxError((e as Error).message); }
    finally { setIdxLoading(false); }
  }, [connectionId]);

  useEffect(() => { void loadIndices(); }, [loadIndices]);

  const setTabIndex = useCallback((id: string, index: string) => {
    setTabs((list) => list.map((t) => (t.id === id ? { ...t, index } : t)));
  }, []);

  /** Tăng lên mỗi lần ghi một phiên — buộc SessionHistory đọc lại danh sách. */
  const [sessBump, setSessBump] = useState(0);
  /**
   * Body cần điền vào tab khi khôi phục một phiên. Mang `seq` để BrowserSession
   * phân biệt được hai lần khôi phục CÙNG một body (bấm lại cùng dòng) — so
   * sánh nội dung thì lần thứ hai không kích hoạt gì.
   */
  const [restore, setRestore] = useState<{ tabId: string; body: string; seq: number } | null>(null);
  const restoreSeq = useRef(0);

  const addTab = useCallback((index = '') => {
    const t = newTab(index);
    setTabs((list) => [...list, t]);
    setActiveId(t.id);
  }, []);

  const closeTab = useCallback((id: string) => {
    // Đóng tab cuối cùng = làm mới nó (luôn còn một tab để làm việc). Đóng tab
    // đang xem thì nhảy sang tab kế bên phải, hết thì lấy tab cuối.
    const gone = tabs.findIndex((t) => t.id === id);
    if (gone < 0) return;
    if (tabs.length === 1) {
      const fresh = newTab();
      setTabs([fresh]);
      setActiveId(fresh.id);
      return;
    }
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    if (activeId === id) setActiveId((next[gone] ?? next[next.length - 1]).id);
  }, [tabs, activeId]);

  /**
   * Khôi phục một phiên: mở index của nó ở tab đang đứng (nếu tab trống hoặc
   * đã đúng index) hoặc một tab mới, rồi ĐIỀN body — KHÔNG tự chạy _search.
   */
  const restoreSession = useCallback((raw: Record<string, unknown>) => {
    const st = raw as Partial<EsSession>;
    const index = typeof st.index === 'string' ? st.index : '';
    const body = typeof st.query === 'string' ? st.query : '';
    if (!index) return;
    const cur = tabs.find((t) => t.id === activeId);
    let target = cur?.id ?? '';
    if (cur && (!cur.index || cur.index === index)) setTabIndex(cur.id, index);
    else {
      const t = newTab(index);
      setTabs((list) => [...list, t]);
      setActiveId(t.id);
      target = t.id;
    }
    restoreSeq.current += 1;
    setRestore({ tabId: target, body, seq: restoreSeq.current });
  }, [tabs, activeId, setTabIndex]);

  // Jump from Overview: mở index đó ở tab đang đứng nếu tab còn trống, còn không
  // thì thêm tab mới — không đè lên phiên đang có kết quả.
  const jumpedRef = useRef('');
  useEffect(() => {
    if (!initialIndex || jumpedRef.current === initialIndex) return;
    jumpedRef.current = initialIndex;
    const cur = tabs.find((t) => t.id === activeId);
    if (cur && !cur.index) setTabIndex(cur.id, initialIndex);
    else addTab(initialIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialIndex]);

  return (
    <div className="es-dtabs-wrap">
      <div className="es-dtabs" role="tablist">
        {tabs.map((t) => (
          <span key={t.id} className={`es-dtab${t.id === activeId ? ' on' : ''}`}>
            <button
              className="es-dtab-main"
              role="tab"
              aria-selected={t.id === activeId}
              title={t.index || 'Tab mới — chọn một index'}
              onClick={() => setActiveId(t.id)}
            >
              {t.index || 'tab mới'}
            </button>
            <button
              className="es-dtab-x"
              title={tabs.length === 1 ? 'Xoá nội dung tab' : 'Đóng tab'}
              onClick={() => closeTab(t.id)}
            >✕</button>
          </span>
        ))}
        <button className="chip-btn es-dtab-add" title="Mở thêm một tab index khác"
          onClick={() => addTab()}>+</button>
      </div>

      <SessionHistory
        scope="es"
        connectionId={connectionId}
        reloadKey={sessBump}
        onRestore={restoreSession}
      />

      {idxError && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{idxError}</pre>}

      {/* Mọi tab đều được mount, chỉ tab không active thì ẩn — nhờ vậy body
          query / kết quả / trang đang xem của tab cũ còn nguyên khi quay lại. */}
      {tabs.map((t) => (
        <div key={t.id} className="es-dtab-pane" hidden={t.id !== activeId}>
          <BrowserSession
            connectionId={connectionId}
            tabId={t.id}
            index={t.index}
            onPickIndex={(ix) => setTabIndex(t.id, ix)}
            indices={indices}
            idxLoading={idxLoading}
            onReloadIndices={loadIndices}
            onOpenInNewTab={addTab}
            restoreBody={restore && restore.tabId === t.id ? restore : null}
            onRecordSession={() => setSessBump((n) => n + 1)}
          />
        </div>
      ))}
    </div>
  );
}

interface BrowserSessionProps {
  connectionId: string;
  /** Id tab — vào khoá model Monaco để hai tab không dùng chung nội dung. */
  tabId: string;
  /** Index của tab này ('' = chưa chọn). Đổi giá trị này là reset phiên. */
  index: string;
  onPickIndex: (name: string) => void;
  indices: EsIndexInfo[];
  idxLoading: boolean;
  onReloadIndices: () => void;
  onOpenInNewTab: (index: string) => void;
  /** Body cần điền khi khôi phục phiên (null = không có gì để điền). */
  restoreBody: { body: string; seq: number } | null;
  /** Báo lên cha là vừa ghi một phiên, để danh sách đọc lại. */
  onRecordSession: () => void;
}

/** Một phiên truy vấn: index + body + kết quả + mapping của riêng một tab. */
function BrowserSession({
  connectionId, tabId, index: selected, onPickIndex,
  indices, idxLoading, onReloadIndices, onOpenInNewTab,
  restoreBody, onRecordSession,
}: BrowserSessionProps) {
  /** Tiền tố khoá model Monaco cho mọi khung JSON của phiên này. Gồm cả index
   *  vì đổi index là nội dung khác hẳn, đừng dùng lại model cũ.
   *
   *  Lọc ký tự lạ: chuỗi này đi vào uri của model, mà tên index Elasticsearch
   *  cho phép nhiều ký tự (kể cả `:` `?` `#`) sẽ làm hỏng uri. Chỉ cần DUY NHẤT
   *  chứ không cần đọc được, nên thay hết bằng '_'. */
  const paneKey = `${connectionId}/${tabId}/${(selected || '_').replace(/[^\w.-]/g, '_')}`;
  // Kéo thanh giữa hai cột để nới ô đang cần đọc — chỉ trong phiên này.
  const tree = useSplit({ varName: '--es-tree', min: 160, max: 520, gap: 12 });
  const [treeFilter, setTreeFilter] = useState('');
  /** Cây indices tự ẩn khi đã chọn index — mở lại bằng nút ☰. */
  const [showTree, setShowTree] = useState(true);

  const [idxTab, setIdxTab] = useState<IdxTab>('docs');
  /** NGUYÊN body _search (JSON) — trống = match_all, size mặc định 50. */
  const [body, setBody] = useState('');

  const [result, setResult] = useState<EsSearchResult | null>(null);
  const [countInfo, setCountInfo] = useState<string | null>(null);
  const [mapping, setMapping] = useState<WireDoc | null>(null);
  /** Field trải từ mapping — nuôi autocomplete tên field trong ô body. */
  const [fields, setFields] = useState<EsField[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Điền body từ một phiên vừa khôi phục. Theo `seq` chứ không theo nội dung:
   * bấm lại đúng dòng cũ vẫn phải điền lại (người dùng có thể đã sửa ô body).
   * Chỉ ĐIỀN, không chạy — xem lib/sessionHistory.
   */
  const restoredSeq = useRef(0);
  useEffect(() => {
    if (!restoreBody || restoreBody.seq === restoredSeq.current) return;
    restoredSeq.current = restoreBody.seq;
    setBody(restoreBody.body);
    setResult(null); setCountInfo(null); setError(null);
  }, [restoreBody]);

  /** `over.from` chỉ dùng cho phân trang Prev/Next — nó đè lên from trong body. */
  const runSearch = useCallback(async (over?: { from?: number }) => {
    if (!selected) return;
    setBusy(true); setError(null); setCountInfo(null);
    try {
      const r = await searchEs(connectionId, selected, { body, from: over?.from });
      setResult(r);
      // Ghi phiên: index + body, KHÔNG ghi hits trả về.
      const state: EsSession = { subView: 'browser', index: selected, query: body };
      recordSession('es', {
        label: `${selected}${body.trim() ? ` · ${short(body)}` : ' · match_all'}`,
        connectionId,
        state: state as unknown as Record<string, unknown>,
      });
      onRecordSession();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [connectionId, selected, body, onRecordSession]);

  const runCount = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const r = await countEs(connectionId, selected, '', body);
      setCountInfo(`${fmtCount(r.count)} document${r.count === 1 ? '' : 's'} · ${r.tookMs}ms`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [connectionId, selected, body]);

  const loadMapping = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const m = await esMapping(connectionId, selected);
      setMapping(m);
      setFields(flattenEsMapping(m.json));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [connectionId, selected]);

  const selectIndex = useCallback((name: string) => {
    onPickIndex(name);
    setShowTree(false); // nhường chỗ cho kết quả — mở lại bằng ☰
    setIdxTab('docs');
    setBody('');
    setResult(null); setCountInfo(null); setMapping(null); setFields([]); setError(null);
  }, [onPickIndex]);

  // Mapping nạp ngầm ngay khi chọn index (không chặn UI, lỗi thì im lặng) — cần
  // sớm vì nó là nguồn gợi ý tên field cho ô body, không chỉ cho tab Mapping.
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    esMapping(connectionId, selected)
      .then((m) => { if (alive) { setMapping(m); setFields(flattenEsMapping(m.json)); } })
      .catch(() => { /* tab Mapping vẫn có nút tải lại */ });
    return () => { alive = false; };
  }, [connectionId, selected]);

  // Auto-run match_all on selection.
  const lastAuto = useRef('');
  useEffect(() => {
    if (!selected) return;
    const key = `${connectionId}/${selected}`;
    if (lastAuto.current === key) return;
    lastAuto.current = key;
    void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, connectionId]);

  const selectedInfo = indices.find((i) => i.name === selected) ?? null;
  const filteredIndices = useMemo(
    () => indices.filter((i) => !treeFilter || i.name.includes(treeFilter)),
    [indices, treeFilter],
  );
  const treeVisible = showTree || !selected;

  return (
    <div className={`es-browser${treeVisible ? '' : ' es-browser-solo'}`} ref={tree.ref} style={tree.style}>
      {/* ── Indices list (ẩn khi đã chọn index) ──────────────────────── */}
      {treeVisible && (
        <div className="es-tree">
          <div className="status-line" style={{ justifyContent: 'space-between' }}>
            <strong>Indices</strong>
            <button className="chip-btn" onClick={onReloadIndices} disabled={idxLoading}>↻</button>
          </div>
          <input
            className="input"
            value={treeFilter}
            onChange={(e) => setTreeFilter(e.target.value)}
            placeholder="lọc index…"
            style={{ margin: '6px 0' }}
          />
          {idxLoading && indices.length === 0 && <p className="empty"><span className="spinner" /> Đang tải…</p>}
          <ul className="es-idx-list">
            {filteredIndices.map((ix) => (
              <li key={ix.name}>
                <button
                  className={`es-idx-item${selected === ix.name ? ' active' : ''}`}
                  // Ctrl/⌘+click hoặc chuột giữa: mở index ở TAB MỚI, như trình duyệt.
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey) onOpenInNewTab(ix.name);
                    else selectIndex(ix.name);
                  }}
                  onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onOpenInNewTab(ix.name); } }}
                  title={`${fmtCount(ix.docsCount)} docs · ${fmtBytes(ix.sizeBytes)}\n\nCtrl+click (hoặc chuột giữa) để mở ở tab mới`}
                >
                  <span style={{ color: healthColor(ix.health) }}>●</span>{' '}
                  {ix.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Query + results ──────────────────────────────────────────── */}
      <div className="es-main">
        {!selected ? (
          <p className="empty" style={{ margin: 'auto' }}>Chọn một index ở danh sách bên trái để truy vấn.</p>
        ) : (
          <>
            <div className="status-line" style={{ justifyContent: 'space-between', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                <button
                  className="chip-btn"
                  title={treeVisible ? 'Ẩn danh sách indices' : 'Hiện danh sách indices'}
                  onClick={() => setShowTree((v) => !v)}
                >☰</button>
                <IndexPicker indices={indices} value={selected} onPick={selectIndex} />
                <button className="chip-btn" title="Mở index này ở một tab mới để so sánh"
                  onClick={() => onOpenInNewTab(selected)}>⧉ tab mới</button>
              </div>
              <div className="es-subnav">
                <button className={idxTab === 'docs' ? 'on' : ''} onClick={() => setIdxTab('docs')}>Documents</button>
                <button className={idxTab === 'mapping' ? 'on' : ''} onClick={() => { setIdxTab('mapping'); if (!mapping) void loadMapping(); }}>Mapping</button>
                <button className={idxTab === 'info' ? 'on' : ''} onClick={() => setIdxTab('info')}>Info</button>
              </div>
            </div>

            {error && <pre className="code" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{error}</pre>}
            {notice && <div className="badge" style={{ color: 'var(--ok)' }}>{notice}</div>}

            {idxTab === 'docs' && (
              <>
                <div className="es-querybar">
                  <QueryEditor
                    mode="body"
                    value={body}
                    onChange={setBody}
                    onRun={() => void runSearch()}
                    fields={fields}
                    label={`Body _search — như Kibana Dev Tools (trống = match_all)${fields.length ? ` · ${fields.length} field từ mapping` : ''}`}
                    placeholder='{ "query": { "term": { "field": "value" } }, "aggs": { … }, "sort": [{ "createdAt": "desc" }], "size": 50 }'
                  />
                  <div className="status-line" style={{ gap: 8 }}>
                    <button className="sm" disabled={busy} onClick={() => void runSearch()}>
                      {busy ? <span className="spinner" aria-hidden /> : '▶'} Search
                    </button>
                    <button className="ghost sm" disabled={busy} onClick={() => void runCount()}>Count</button>
                    {countInfo && <span className="badge">{countInfo}</span>}
                    <span className="es-hint" style={{ marginLeft: 'auto' }}>size ≤ 200 · size 0 = chỉ lấy aggs · script bị chặn</span>
                  </div>
                </div>

                {result && (
                  <>
                    <div className="status-line" style={{ justifyContent: 'space-between' }}>
                      <span className="badge">
                        {fmtCount(result.total)}{result.totalRelation === 'gte' ? '+' : ''} khớp · hiển thị {result.docs.length} · from {result.from} · {result.tookMs}ms
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {/* Xuất .xlsx — chỉ có nghĩa khi truy vấn đang trả về
                            document; size=0 (chỉ lấy aggs) thì không có gì để xuất. */}
                        <button
                          className="chip-btn"
                          disabled={busy || result.docs.length === 0}
                          title={result.docs.length === 0
                            ? 'Không có document nào để xuất'
                            : 'Xuất TOÀN BỘ kết quả khớp query ra .xlsx (chọn cột trong hộp thoại)'}
                          onClick={() => setExportOpen(true)}
                        >⬇ Export</button>
                        <button className="chip-btn" disabled={busy || result.size === 0 || result.from === 0}
                          onClick={() => void runSearch({ from: Math.max(0, result.from - result.size) })}>← Prev</button>
                        <button className="chip-btn" disabled={busy || result.size === 0 || result.from + result.docs.length >= Math.min(result.total, 10000 - result.size)}
                          onClick={() => void runSearch({ from: result.from + result.size })}>Next →</button>
                      </div>
                    </div>
                    <div className="es-results">
                      {result.aggs && (
                        <>
                          <div className="status-line" style={{ gap: 8 }}>
                            <strong style={{ fontSize: 12.5 }}>Σ Aggregations</strong>
                          </div>
                          <AggsResult json={result.aggs.json} truncated={result.aggs.truncated} />
                        </>
                      )}
                      {result.docs.length === 0 && (
                        <p className="empty">{result.size === 0 ? 'size = 0 — chỉ lấy aggregations, không lấy document.' : 'Không có document nào khớp.'}</p>
                      )}
                      {result.docs.map((d, i) => (
                        <DocCard
                          key={`${result.from}-${i}`}
                          json={d.json}
                          truncated={d.truncated}
                          index={result.from + i}
                          // Khoá model Monaco: phải riêng theo TAB nữa (paneKey),
                          // không thì hai tab mở cùng một index sẽ dùng chung model.
                          docKey={`${paneKey}/${result.from + i}`}
                        />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {idxTab === 'mapping' && (
              mapping
                ? (
                  <>
                    <div className="status-line" style={{ gap: 8 }}>
                      {mapping.truncated && <span className="badge" style={{ color: 'var(--err)' }}>truncated</span>}
                      <span className="es-hint">Ctrl+F để tìm field trong mapping</span>
                      <button className="chip-btn" style={{ marginLeft: 'auto' }} title="Copy mapping"
                        onClick={() => void navigator.clipboard?.writeText(mapping.json)}>⧉</button>
                    </div>
                    <JsonViewer value={mapping.json} path={`es-mapping:/${paneKey}.json`} maxHeight={620} />
                  </>
                )
                : <p className="empty">{busy ? 'Đang tải mapping…' : 'Chưa tải được mapping.'}</p>
            )}

            {idxTab === 'info' && (
              selectedInfo ? (
                <table className="es-table">
                  <tbody>
                    <tr><td>Health</td><td style={{ textAlign: 'left' }}>{selectedInfo.health}</td></tr>
                    <tr><td>Status</td><td style={{ textAlign: 'left' }}>{selectedInfo.status}</td></tr>
                    <tr><td>Documents</td><td style={{ textAlign: 'left' }}>{fmtCount(selectedInfo.docsCount)}</td></tr>
                    <tr><td>Store size</td><td style={{ textAlign: 'left' }}>{fmtBytes(selectedInfo.sizeBytes)}</td></tr>
                    <tr><td>Shards</td><td style={{ textAlign: 'left' }}>{selectedInfo.primaries} primary × {selectedInfo.replicas} replica</td></tr>
                  </tbody>
                </table>
              ) : <p className="empty">Không có thông tin index (tải lại danh sách).</p>
            )}
          </>
        )}
      </div>
      {treeVisible && <Splitter {...tree.grip} />}

      {exportOpen && selected && result && (
        <ExportModal
          connectionId={connectionId}
          index={selected}
          // Truyền BODY nguyên bản chứ không phải query rời: tab này cho gõ cả
          // sort/_source/size kiểu Dev Tools, tách lấy mỗi `query` sẽ xuất ra
          // một tập kết quả KHÁC với cái người dùng đang nhìn.
          body={body}
          querySummary={body.trim() ? 'body _search đang gõ' : 'match_all'}
          // Gợi ý field: mapping (đầy đủ) + tên field có thật trong kết quả.
          fieldSuggestions={[...new Set([
            '_id',
            ...deriveEsFieldNames(result.docs),
            ...fields.map((f) => f.path),
          ])]}
          // Cột mặc định lấy từ kết quả THẬT — mapping có thể hàng trăm field
          // mà truy vấn chỉ trả về vài cái.
          initialPaths={['_id', ...deriveEsFieldNames(result.docs)].slice(0, 8)}
          defaultTitle={selected}
          onClose={() => setExportOpen(false)}
          onDone={(rows, filename) => {
            setExportOpen(false);
            setNotice(`Đã xuất ${rows.toLocaleString('en-US')} dòng → ${filename}`);
            setTimeout(() => setNotice(null), 5000);
          }}
        />
      )}
    </div>
  );
}

/**
 * Combobox đổi index khi cây indices đang ẩn: hiện tên index đang chọn, focus
 * vào là gõ để lọc, ↑/↓ chạy trong danh sách, Enter chọn dòng đang sáng, Esc
 * trả về tên cũ.
 *
 * Trước đây Enter luôn lấy list[0] và KHÔNG có dòng nào sáng lên, nên muốn lấy
 * mục thứ hai trở đi là bắt buộc phải với chuột. Giờ có con trỏ `cur` hiển thị
 * rõ mình đang đứng ở đâu — bàn phím làm được trọn vẹn.
 */
function IndexPicker({ indices, value, onPick }: {
  indices: EsIndexInfo[];
  value: string;
  onPick: (name: string) => void;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState(0);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { setText(value); }, [value]);

  // Chưa gõ gì (text còn là tên đang chọn) thì hiện cả danh sách.
  const needle = text.trim() === value ? '' : text.trim();
  const list = useMemo(
    () => indices.filter((i) => !needle || i.name.includes(needle)).slice(0, 50),
    [indices, needle],
  );

  // Lọc lại là danh sách đổi → con trỏ cũ có thể trỏ ra ngoài. Về đầu danh sách.
  useEffect(() => { setCur(0); }, [needle]);

  // Giữ dòng đang sáng nằm trong tầm nhìn khi chạy ↑/↓ qua danh sách dài.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('.on')?.scrollIntoView({ block: 'nearest' });
  }, [cur, open]);

  const choose = (name: string, el: HTMLInputElement) => {
    onPick(name);
    setOpen(false);
    el.blur();
  };

  return (
    <div className="es-ixpick">
      <input
        className="input mono"
        value={text}
        onFocus={(e) => { setOpen(true); setCur(0); e.target.select(); }}
        onBlur={() => { setOpen(false); setText(value); }}
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          const el = e.target as HTMLInputElement;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setCur((c) => (list.length ? (c + 1) % list.length : 0));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
            setCur((c) => (list.length ? (c - 1 + list.length) % list.length : 0));
          } else if (e.key === 'Enter') {
            const pick = list[cur] ?? list[0];
            if (pick) { e.preventDefault(); choose(pick.name, el); }
          } else if (e.key === 'Escape') {
            el.blur();
          }
        }}
        placeholder="gõ để tìm index…"
        title="Đổi index — gõ để lọc, ↑/↓ chọn, Enter mở"
      />
      {open && list.length > 0 && (
        <div className="es-ixpick-menu" ref={menuRef}>
          {list.map((ix, i) => (
            <button
              key={ix.name}
              className={i === cur ? 'on' : undefined}
              // preventDefault để input không blur trước khi click kịp chạy
              onMouseDown={(e) => { e.preventDefault(); }}
              onMouseEnter={() => setCur(i)}
              onClick={() => { onPick(ix.name); setOpen(false); }}
            >
              <span style={{ color: healthColor(ix.health) }}>●</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{ix.name}</span>
              <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 11 }}>{fmtCount(ix.docsCount)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** One document rendered as collapsible pretty JSON with a copy button.
 *
 *  Phần mở ra dùng <JsonViewer> (Monaco read-only) chứ không phải <pre>: có tô
 *  màu JSON và Ctrl+F tìm trong CẢ document, kể cả phần đang cuộn khuất. Editor
 *  chỉ được dựng khi thẻ đã mở, nên một trang 200 document không tạo 200 editor. */
function DocCard({ json, truncated, index, docKey }: {
  json: string; truncated: boolean; index: number;
  /** Khoá duy nhất cho model Monaco của thẻ này. */
  docKey: string;
}) {
  const [open, setOpen] = useState(false);
  const pretty = prettyDoc(json);
  const oneLine = json.replace(/\s+/g, ' ');
  return (
    <div className="es-doc">
      <div className="es-doc-head" onClick={() => setOpen((v) => !v)}>
        <span className="es-tree-caret">{open ? '▾' : '▸'}</span>
        <span className="es-doc-idx">#{index + 1}</span>
        {!open && <code className="es-doc-preview">{oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine}</code>}
        {truncated && <span className="badge" style={{ color: 'var(--err)' }}>truncated</span>}
        <button
          className="chip-btn"
          title="Copy JSON"
          onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(pretty); }}
        >⧉</button>
      </div>
      {open && (
        <JsonViewer
          value={pretty}
          path={`es-doc:/${docKey}.json`}
          maxHeight={460}
        />
      )}
    </div>
  );
}
