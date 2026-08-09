'use client';

// "Quét danh sách hội thoại" — the first half of managing send targets OUTSIDE
// the chat app.
//
// It asks the live guest for its conversation list (lib/workspace/directory.ts)
// and shows what came back: the name of every row, and — the part that decides
// how the directory will work — whether the app exposes a STABLE id per
// conversation or only a display name.
//
// The raw JSON is one click away on purpose. Until we have seen a real Zalo DOM,
// that dump is what tells us which attribute to pin the directory to.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildDirectoryScript,
  idSources,
  idlessCount,
  type DirectorySpec,
  type ScanDiag,
  type ScanResult,
} from '@/lib/workspace/directory';
import {
  buildLabelProbeScript,
  buildLabelScanScript,
  type LabelProbe,
  type LabelScan,
  type LabelSpec,
} from '@/lib/workspace/labels';
import { requireGuest } from '@/lib/workspace/guests';

/**
 * What the guest saw when it could NOT find the list — the whole point of the
 * first run. `candidates` is every repeated row-stack in the page with the
 * numbers it was scored on, so the real conversation list is normally sitting
 * right there in the table even when the picker chose wrong.
 */
function Diag({
  diag,
  forced,
  onPick,
}: {
  diag: ScanDiag;
  forced: number | null;
  onPick: (i: number) => void;
}) {
  if (!diag) return null;
  const blocked = diag.frames.filter((f) => !f.accessible);
  return (
    <div className="ws-scan-diag">
      <div className="ws-scan-sum">
        <span>
          <b>{diag.elements}</b> phần tử trong trang
        </span>
        <span>
          {diag.frames.length} iframe{blocked.length ? ` (${blocked.length} khác miền, không đọc được)` : ''}
        </span>
        <span>{diag.shadowRoots} shadow root</span>
        <span title={diag.url}>
          <code>{diag.title || diag.url}</code>
        </span>
      </div>

      {diag.candidates.length ? (
        <>
          <p className="auto-hint">
            Các khối “nhiều dòng giống nhau” trong trang. Nhận ra danh sách hội thoại ở dòng nào thì
            bấm <b>dùng khối này</b> — quét lại ngay theo khối bạn chọn.
          </p>
          <div className="ws-scan-list">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>dòng</th>
                  <th>có ảnh</th>
                  <th>vị trí / cỡ</th>
                  <th>đường dẫn</th>
                  <th>dòng đầu</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {diag.candidates.map((c, i) => (
                  <tr key={i} className={forced === i ? 'is-picked' : undefined}>
                    <td className="ws-scan-i">{i + 1}</td>
                    <td className="ws-scan-i">{c.rows}</td>
                    <td className="ws-scan-i">{c.withImg}</td>
                    <td className="auto-hint">
                      {c.w}×{c.h} @ {c.x},{c.y}
                      {c.root !== 'main' ? ` · ${c.root}` : ''}
                    </td>
                    <td>
                      <code>{c.path}</code>
                    </td>
                    <td>{c.sample}</td>
                    <td>
                      <button className="ghost sm" onClick={() => onPick(i)}>
                        {forced === i ? 'đang dùng' : 'dùng khối này'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="auto-hint">
          Không có khối nào gồm ≥4 dòng giống nhau. Nếu Zalo đang hiện danh sách thật thì nội dung
          nằm ngoài tầm với của script (iframe khác miền, hoặc canvas) — gửi tôi JSON để xem tiếp.
        </p>
      )}
    </div>
  );
}

type State =
  | { phase: 'idle' }
  | { phase: 'scanning' }
  | { phase: 'done'; result: ScanResult; labels: LabelProbe | null }
  | { phase: 'error'; error: string };

/**
 * What the app's own label menu ("Phân loại") looks like from the inside.
 *
 * Runs as part of the scan rather than behind its own button: two copy buttons
 * side by side meant the wrong JSON came back three times in a row, and the
 * probe only opens a menu and closes it again.
 */
function LabelSection({
  probe,
  sweeping,
  swept,
  report,
  filter,
  counts,
  onSweep,
  onFilter,
}: {
  probe: LabelProbe | null;
  /** Label currently being applied in Zalo ('' = idle). */
  sweeping: string;
  /** True once the sweep has run at least once. */
  swept: boolean;
  report: LabelScan[];
  filter: string;
  counts: Record<string, number>;
  onSweep: () => void;
  onFilter: (f: string) => void;
}) {
  if (!probe) return null;
  return (
    <div className="ws-scan-diag">
      <h4 className="ws-scan-h">🏷 Phân loại</h4>
      {!probe.ok ? (
        <p className="ws-scan-bad">✗ {probe.error}</p>
      ) : (
        <>
          {probe.names.length > 0 && !swept && (
            <div className="status-line">
              <button className="ghost sm" disabled={!!sweeping} onClick={onSweep}>
                {sweeping ? `⏳ đang đọc nhãn “${sweeping}”…` : `🏷 Đọc nhãn của từng hội thoại (${probe.names.length} nhãn)`}
              </button>
              <span className="auto-hint">
                Zalo không ghi nhãn vào từng dòng, nên cách duy nhất chắc chắn là bật lần lượt từng bộ
                lọc rồi đọc kết quả — mất ~{probe.names.length * 4}s. Xong thì bảng có cột nhãn và
                lọc được ngay tại chỗ, không phải đụng vào Zalo nữa.
              </span>
            </div>
          )}

          {swept && (
            <>
              <div className="auto-checks">
                <button
                  type="button"
                  className={`auto-chip${filter === '' ? ' on' : ''}`}
                  onClick={() => onFilter('')}
                >
                  Tất cả
                </button>
                {probe.names.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`auto-chip${filter === n ? ' on' : ''}`}
                    onClick={() => onFilter(n)}
                  >
                    🏷 {n} ({counts[n] ?? 0})
                  </button>
                ))}
                <button
                  type="button"
                  className={`auto-chip${filter === '__none' ? ' on' : ''}`}
                  onClick={() => onFilter('__none')}
                >
                  chưa gán nhãn ({counts.__none ?? 0})
                </button>
                <button type="button" className="auto-chip" disabled={!!sweeping} onClick={onSweep}>
                  {sweeping ? `⏳ ${sweeping}` : '⟳ đọc lại nhãn'}
                </button>
              </div>
              <p className="auto-hint">
                Lọc ở đây là lọc <b>bảng phía trên</b>, không đụng vào Zalo. Tick chọn vẫn giữ nguyên
                khi bạn đổi bộ lọc.
              </p>
            </>
          )}

          {report.length > 0 && (
            <div className="ws-scan-list">
              <table>
                <thead>
                  <tr>
                    <th>nhãn</th>
                    <th>bấm được</th>
                    <th>danh sách đổi</th>
                    <th>trước → sau</th>
                    <th>tắt lọc</th>
                    <th>lỗi</th>
                  </tr>
                </thead>
                <tbody>
                  {report.map((r) => (
                    <tr key={r.label}>
                      <td>🏷 {r.label}</td>
                      <td className="ws-scan-i">{r.clicked ? '✓' : '✗'}</td>
                      <td className={r.changed ? 'ws-scan-ok' : 'ws-scan-warn'}>
                        {r.changed ? '✓' : '✗ không đổi'}
                      </td>
                      <td className="auto-hint">
                        {r.before} → {r.items.length}
                      </td>
                      <td className={r.restored ? 'ws-scan-ok' : 'ws-scan-warn'}>
                        {r.restored ? '✓' : '✗'}
                      </td>
                      <td className="ws-scan-bad">{r.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {report.some((r) => !r.changed) && (
            <p className="ws-scan-warn">
              ⚠ Nhãn có “danh sách đổi = ✗” nghĩa là bấm xong mà danh sách không nhúc nhích — kết quả
              lúc đó là <b>toàn bộ hội thoại</b> chứ không phải hội thoại của nhãn, nên tôi{' '}
              <b>không ghi nhận</b> thay vì gán nhầm nhãn cho cả 115 dòng.
            </p>
          )}

          {/* Bảng chẩn đoán DOM của menu — nó từng chiếm hết màn hình và bị
              nhầm là danh sách hội thoại. Giờ chỉ mở ra khi cần dò lỗi. */}
          <details className="ws-scan-raw">
            <summary>
              Chẩn đoán menu Phân loại ({probe.items.length} phần tử · tìm nút theo {probe.foundBy})
            </summary>
            <div className="ws-scan-list" style={{ marginTop: 8 }}>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>chữ</th>
                    <th>lá</th>
                    <th>vị trí</th>
                    <th>đường dẫn</th>
                  </tr>
                </thead>
                <tbody>
                  {probe.items.map((it, i) => (
                    <tr key={i}>
                      <td className="ws-scan-i">{i + 1}</td>
                      <td>{it.text}</td>
                      <td className="ws-scan-i">{it.leaf ? '✓' : ''}</td>
                      <td className="auto-hint">
                        {it.w}×{it.h} @ {it.x},{it.y}
                      </td>
                      <td>
                        <code>{it.path}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

export default function WorkspaceScan({
  accountKey,
  accountLabel,
  spec,
  labelSpec,
  onClose,
}: {
  accountKey: string;
  accountLabel: string;
  spec: DirectorySpec;
  labelSpec?: LabelSpec;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>({ phase: 'idle' });
  const [copied, setCopied] = useState(false);
  /** Index into diag.candidates the user picked, overriding the auto-guess. */
  const [forced, setForced] = useState<number | null>(null);
  /**
   * Two scans must never run at once. React StrictMode invokes effects TWICE in
   * dev, so the mount fired two scans that scrolled the same virtual list
   * against each other — the result came back with the top of the list stitched
   * on at the end. The token also drops a stale scan's result.
   */
  const runId = useRef(0);
  /** Which label is being applied in Zalo right now ('' = idle). */
  const [labelBusy, setLabelBusy] = useState('');
  /** conversation name → the labels it carries. */
  const [labelMap, setLabelMap] = useState<Record<string, string[]>>({});
  const [swept, setSwept] = useState(false);
  /** One row per label: what the filter actually did. */
  const [sweepReport, setSweepReport] = useState<LabelScan[]>([]);
  /** '' = every row · '__none' = unlabelled · otherwise a label name. */
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  /**
   * Conversations the user ticked, name → kind.
   *
   * Hand-picked rather than "whatever the label filter returned": Zalo's labels
   * are CHECKBOXES, so a label left ticked from an earlier filter silently
   * unions into the next result — a list of 1 came back as 6. What a rule
   * messages must be what a human chose, not what a filter happened to show.
   * The filter stays useful for narrowing the 116 rows down to a handful first.
   */
  const [picked, setPicked] = useState<Record<string, 'group' | 'user'>>({});
  const [listName, setListName] = useState('');
  const pickedNames = Object.keys(picked);

  const togglePick = useCallback((name: string, kind: 'group' | 'user') => {
    setPicked((prev) => {
      if (prev[name]) {
        const next = { ...prev };
        delete next[name];
        return next;
      }
      return { ...prev, [name]: kind };
    });
    setSaved('');
  }, []);

  /** Persist the ticked conversations as one named send-target list. */
  const saveTargets = useCallback(async () => {
    const name = listName.trim();
    if (!name || !pickedNames.length) return;
    setSaving(true);
    try {
      const r = await fetch('/api/ws-targets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountKey,
          accountLabel,
          label: name,
          targets: pickedNames.map((n) => ({ name: n, kind: picked[n] })),
        }),
      });
      if (r.ok) setSaved(name);
    } catch {
      /* the button simply stays un-ticked */
    }
    setSaving(false);
  }, [accountKey, accountLabel, listName, picked, pickedNames]);

  /**
   * Read WHICH LABELS each conversation carries, by turning each label filter
   * on in turn and recording what it shows.
   *
   * Zalo writes nothing about labels into a conversation row, so there is
   * nothing to read off the list itself — driving the app's own filter is the
   * only way to learn this without inventing a mapping. It costs one pass per
   * label (~4s each), which is why it is ONE explicit sweep: afterwards the
   * table filters instantly, in DevBox, with Zalo untouched.
   */
  const sweepLabels = useCallback(async () => {
    const names = state.phase === 'done' ? (state.labels?.names ?? []) : [];
    if (!labelSpec || !names.length) return;
    const { guest, error } = requireGuest(accountKey);
    if (!guest || error) {
      setSweepReport([
        {
          ok: false, error: error ?? 'không tìm thấy tài khoản', label: '(tài khoản)',
          clicked: false, changed: false, before: 0, restored: false, items: [],
        },
      ]);
      setSwept(true);
      return;
    }
    const map: Record<string, string[]> = {};
    const report: LabelScan[] = [];
    for (const label of names) {
      setLabelBusy(label);
      try {
        // Pass every label name as an alternative control text: Zalo renames
        // the filter button to whichever label is active.
        const r = (await guest.exec(
          buildLabelScanScript({ ...labelSpec, filterTexts: names }, spec, label),
        )) as LabelScan | null;
        if (!r || typeof r !== 'object') {
          report.push({
            ok: false, error: 'guest không trả về kết quả', label,
            clicked: false, changed: false, before: 0, restored: false, items: [],
          });
          continue;
        }
        report.push(r);
        // A label whose filter never changed the list did NOT return that
        // label's conversations — it returned every conversation. Recording it
        // would tag all 115 rows with that label, which is worse than nothing.
        if (r.ok && r.changed) for (const it of r.items) (map[it.name] ??= []).push(label);
      } catch (e) {
        report.push({
          ok: false, error: (e as Error).message, label,
          clicked: false, changed: false, before: 0, restored: false, items: [],
        });
      }
    }
    setLabelBusy('');
    setLabelMap(map);
    setSweepReport(report);
    setSwept(true);
  }, [accountKey, labelSpec, spec, state]);

  const scan = useCallback(async () => {
    const token = ++runId.current;
    const mine = () => runId.current === token;
    setState({ phase: 'scanning' });
    const { guest, error } = requireGuest(accountKey);
    if (!guest || error) {
      setState({ phase: 'error', error: error ?? 'không tìm thấy guest' });
      return;
    }
    try {
      const script = buildDirectoryScript(forced === null ? spec : { ...spec, forceCandidate: forced });
      const raw = (await guest.exec(script)) as ScanResult | null;
      if (!mine()) return; // a newer scan started — this one's result is stale
      if (!raw || typeof raw !== 'object') {
        setState({ phase: 'error', error: 'guest không trả về kết quả (trang có thể vừa tải lại)' });
        return;
      }
      // The label menu is read in the SAME run and merged into the same result:
      // two separate buttons, each with its own copy, sent the wrong JSON back
      // three times. One action, one JSON.
      let labels: LabelProbe | null = null;
      if (labelSpec) {
        try {
          const p = (await guest.exec(buildLabelProbeScript(labelSpec))) as LabelProbe | null;
          labels = p && typeof p === 'object' ? p : null;
        } catch (e) {
          labels = {
            ok: false,
            error: (e as Error).message,
            names: [],
            foundBy: '',
            controlPath: '',
            items: [],
            popupPath: '',
            popupHtml: '',
          };
        }
      }
      if (!mine()) return;
      setState({ phase: 'done', result: { ...raw, items: raw.items ?? [] }, labels });
    } catch (e) {
      if (mine()) setState({ phase: 'error', error: (e as Error).message });
    }
  }, [accountKey, spec, forced, labelSpec]);

  // Scanning is the whole point of opening this panel — don't make it a second click.
  useEffect(() => {
    void scan();
  }, [scan]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const result = state.phase === 'done' ? state.result : null;
  const labels = state.phase === 'done' ? state.labels : null;
  const sources = result ? idSources(result) : [];
  const idless = result ? idlessCount(result) : 0;

  /** How many conversations carry each label (and how many carry none). */
  const labelCounts = useMemo(() => {
    const out: Record<string, number> = { __none: 0 };
    for (const it of result?.items ?? []) {
      const ls = labelMap[it.name] ?? [];
      if (!ls.length) out.__none += 1;
      for (const l of ls) out[l] = (out[l] ?? 0) + 1;
    }
    return out;
  }, [result, labelMap]);

  /** The rows actually shown — filtering happens HERE, not in Zalo. */
  const shown = useMemo(() => {
    const items = result?.items ?? [];
    if (!filter) return items;
    if (filter === '__none') return items.filter((it) => !(labelMap[it.name] ?? []).length);
    return items.filter((it) => (labelMap[it.name] ?? []).includes(filter));
  }, [result, filter, labelMap]);

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify({ ...result, labelMenu: labels, labelMap, sweepReport }, null, 2),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the <details> below still shows the text */
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal ws-scan" onClick={(e) => e.stopPropagation()}>
        <div className="status-line" style={{ marginBottom: 10 }}>
          <b>🔎 Danh sách hội thoại — {accountLabel}</b>
          <span className="ws-scan-spacer" />
          <button className="ghost sm" disabled={state.phase === 'scanning'} onClick={() => void scan()}>
            {state.phase === 'scanning' ? 'đang quét…' : 'Quét lại'}
          </button>
          <button className="ghost sm" onClick={onClose} title="Đóng (Esc)">
            ✕
          </button>
        </div>

        {state.phase === 'scanning' && (
          <p className="auto-hint">
            Đang cuộn danh sách trong {accountLabel} để nạp hết các dòng… (vài giây)
          </p>
        )}

        {state.phase === 'error' && <p className="ws-scan-bad">✗ {state.error}</p>}

        {result && !result.ok && (
          <>
            <p className="ws-scan-bad">✗ {result.error || 'không đọc được dòng nào'}</p>
            <Diag diag={result.diag} forced={forced} onPick={setForced} />
          </>
        )}

        {result && result.ok && (
          <>
            <div className="ws-scan-sum">
              <span>
                <b>{shown.length}</b>
                {shown.length !== result.items.length ? `/${result.items.length}` : ''} hội thoại
                {filter ? ` · lọc: ${filter === '__none' ? 'chưa gán nhãn' : filter}` : ''}
              </span>
              <span
                className={result.stuck ? 'ws-scan-warn' : result.complete ? 'ws-scan-ok' : undefined}
              >
                {result.complete
                  ? 'đã cuộn hết danh sách'
                  : result.stuck
                    ? `⚠ không cuộn được — mới đọc ${result.items.length} dòng đang hiện`
                    : `mới cuộn ${result.passes} lượt — có thể còn nữa`}
              </span>
              <span className="auto-hint">
                Tick những hội thoại cần gửi → đặt tên → <b>Đưa vào danh bạ</b>
              </span>
            </div>

            <div className="ws-scan-list">
              <table>
                <thead>
                  <tr>
                    <th />
                    <th>#</th>
                    <th>Tên hội thoại</th>
                    <th>loại</th>
                    {swept && <th>nhãn</th>}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((it, i) => (
                    <tr key={`${it.convId}-${i}`} className={picked[it.name] ? 'is-picked' : undefined}>
                      <td className="ws-scan-i">
                        <input
                          type="checkbox"
                          checked={!!picked[it.name]}
                          disabled={!it.name}
                          onChange={() => togglePick(it.name, it.kind)}
                        />
                      </td>
                      <td className="ws-scan-i">{i + 1}</td>
                      <td>{it.name || <em className="auto-hint">(không đọc được tên)</em>}</td>
                      <td className="auto-hint">{it.kind === 'group' ? '👥 nhóm' : '👤 cá nhân'}</td>
                      {swept && (
                        <td className="auto-hint">
                          {(labelMap[it.name] ?? []).map((l) => `🏷 ${l}`).join(' ') || '—'}
                        </td>
                      )}
                    </tr>
                  ))}
                  {!shown.length && (
                    <tr>
                      <td colSpan={5} className="auto-hint">
                        không có hội thoại nào khớp bộ lọc này
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

          </>
        )}

        <LabelSection
          probe={labels}
          sweeping={labelBusy}
          swept={swept}
          report={sweepReport}
          filter={filter}
          counts={labelCounts}
          onSweep={() => void sweepLabels()}
          onFilter={setFilter}
        />

        {pickedNames.length > 0 && (
          <div className="ws-scan-cart">
            <div className="ws-scan-sum">
              <span>
                Đã chọn <b>{pickedNames.length}</b> hội thoại
              </span>
              <button className="ghost sm" onClick={() => setPicked({})}>
                bỏ chọn hết
              </button>
            </div>
            <div className="auto-checks">
              {pickedNames.map((n) => (
                <button key={n} type="button" className="auto-chip on" onClick={() => togglePick(n, picked[n])}>
                  {picked[n] === 'group' ? '👥' : '👤'} {n} ✕
                </button>
              ))}
            </div>
            <div className="status-line">
              <input
                className="ws-scan-name"
                value={listName}
                placeholder={filter && filter !== '__none' ? `vd: ${filter}` : 'tên danh sách, vd: Cảnh báo hạ tầng'}
                onChange={(e) => {
                  setListName(e.target.value);
                  setSaved('');
                }}
              />
              <button
                className="ghost sm"
                disabled={saving || !listName.trim()}
                onClick={() => void saveTargets()}
              >
                {saving ? 'đang lưu…' : saved === listName.trim() ? '✓ đã lưu' : '💾 Đưa vào danh bạ'}
              </button>
              <span className="auto-hint">
                Lưu xong: vào tab 🤖 Automation → hành động <b>💬 Gửi Zalo</b> → chọn đúng tên này.
                Lưu lại cùng tên = ghi đè danh sách cũ.
              </span>
            </div>
          </div>
        )}

        {result && (
          <>
            <details className="ws-scan-raw">
              <summary>🛠 Chi tiết kỹ thuật</summary>
              <div className="ws-scan-sum" style={{ margin: '8px 0' }}>
                <span>
                  định vị: <code>{result.how}</code>
                  {result.root && result.root !== 'main' ? <code> · {result.root}</code> : null}
                </span>
                {result.usedStrategy && (
                  <span>
                    cuộn bằng: <code>{result.usedStrategy}</code>
                  </span>
                )}
                {result.diag.idsUnique && idless === 0 ? (
                  <span className="ws-scan-ok">mỗi dòng một id riêng</span>
                ) : (
                  <span className="ws-scan-warn">
                    id không riêng từng dòng ({result.diag.idDistinct}/{result.diag.rowsProbed}) — bám
                    theo tên
                  </span>
                )}
                {sources.length > 0 && (
                  <span>id lấy từ: {sources.map((s) => `${s.attr} (${s.count})`).join(' · ')}</span>
                )}
                {result.diag.dupSkipped > 0 && <span>bỏ {result.diag.dupSkipped} dòng trùng</span>}
                <button className="ghost sm" onClick={() => void copy()}>
                  {copied ? '✓ đã chép' : 'Sao chép JSON đầy đủ'}
                </button>
              </div>
              <pre className="auto-probe">
                {JSON.stringify(
                  {
                    how: result.how,
                    root: result.root,
                    containerPath: result.containerPath,
                    complete: result.complete,
                    sampleHtml: result.sampleHtml,
                    firstItems: result.items.slice(0, 3),
                    diag: result.diag,
                    labelMenu: labels,
                  },
                  null,
                  2,
                )}
              </pre>

              <div style={{ marginTop: 10 }}>
                <p className="auto-hint">
                  Quét nhầm khối? Chọn lại từ {result.diag.candidates.length} khối tìm được:
                </p>
                <Diag diag={result.diag} forced={forced} onPick={setForced} />
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
