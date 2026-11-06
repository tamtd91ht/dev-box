'use client';

// Kafka — cân bằng consumer ↔ partition (lib/kafkaBalance). Các mảnh dùng ở tab Kafka:
//   • KafkaBalanceSection — màn "Consumer ↔ Partition" của cả cụm (dữ liệu từ lượt quét lag): thanh tỉ lệ +
//     nút đếm (cũng là bộ lọc) + tìm group/topic → bảng cặp group · topic, lệch trước. Cặp thiếu consumer MÀ
//     đang lag là thứ cần làm (tô cam, có gợi ý ngay trong hàng); thiếu nhưng theo kịp / thừa chỉ để biết.
//   • GroupBalanceCell — cột "Consumer ↔ Partition" của danh sách group: cặp tệ nhất + số topic lệch khác.
//   • GroupAssignment — chi tiết group: cân bằng theo topic + thẻ từng consumer giữ partition nào.
// Chỉ hiển thị — dữ liệu do lib/kafkaClient tính (chỉ đọc describeGroups + metadata).

import { useMemo, useState } from 'react';
import {
  PC_TEXT,
  pcAdvice,
  pcRatioText,
  sortBalance,
  summarizeBalance,
  type KafkaPcRow,
  type PcStatus,
} from '@/lib/kafkaBalance';
import { fmtInt, type GroupConsumer } from '@/lib/kafka';
import './balance.css';

/** Tông màu của một cặp: chỉ "thiếu MÀ đang lag" mới là cảnh báo; còn lại là thông tin. */
export function pcTone(r: Pick<KafkaPcRow, 'status' | 'lag'>): 'ok' | 'warn' | 'soft' | 'info' | 'mute' {
  if (r.status === 'balanced') return 'ok';
  if (r.status === 'under') return (r.lag ?? 0) > 0 ? 'warn' : 'soft';
  if (r.status === 'over') return 'info';
  return 'mute';
}

export const isLopsided = (r: KafkaPcRow): boolean => r.status === 'under' || r.status === 'over';

export function PcPill({ row }: { row: Pick<KafkaPcRow, 'status' | 'lag'> }) {
  return (
    <span className={`pc-pill ${pcTone(row)}`}>
      <i aria-hidden />
      {PC_TEXT[row.status]}
    </span>
  );
}

/**
 * Thước P ↔ C: hai vạch cùng thang (lớn hơn trong hai số = đầy). Phần consumer vượt số partition (ngồi không)
 * tô sọc; phần partition chưa có consumer riêng (thiếu) để rỗng viền.
 */
export function PcMeter({ partitions, consumers }: { partitions: number; consumers: number }) {
  const max = Math.max(1, partitions, consumers);
  const pct = (n: number) => `${(n / max) * 100}%`;
  const used = Math.min(partitions, consumers);
  return (
    <div className="pc-meter" role="img" aria-label={`${partitions} partition, ${consumers} consumer`}>
      <div className="pc-meter-row">
        <span className="pc-meter-k">P</span>
        <div className="pc-meter-track">
          <i className="p" style={{ width: pct(partitions) }} />
        </div>
        <b>{fmtInt(partitions)}</b>
      </div>
      <div className="pc-meter-row">
        <span className="pc-meter-k">C</span>
        <div className="pc-meter-track">
          <i className="c" style={{ width: pct(used) }} />
          {consumers > partitions && <i className="idle" style={{ width: pct(consumers - partitions) }} />}
          {consumers < partitions && <i className="gap" style={{ width: pct(partitions - consumers) }} />}
        </div>
        <b>{fmtInt(consumers)}</b>
      </div>
    </div>
  );
}

type Filter = 'issue' | PcStatus | 'all';
const BAR: PcStatus[] = ['under', 'over', 'none', 'balanced'];
const STEP = 50;

/**
 * Màn "Consumer ↔ Partition" của cả cụm. `rows` = mọi cặp group · topic của lượt quét lag (kể cả cân bằng);
 * `groupsChecked` = số group đánh giá được. Bấm một hàng → mở chi tiết group đó.
 */
export function KafkaBalanceSection({
  rows,
  groupsChecked,
  initialFilter,
  onOpenGroup,
}: {
  rows: KafkaPcRow[];
  groupsChecked: number;
  initialFilter?: Filter;
  onOpenGroup?: (groupId: string) => void;
}) {
  const s = useMemo(() => summarizeBalance(rows), [rows]);
  const sorted = useMemo(() => sortBalance(rows), [rows]);
  const issues = s.under + s.over + s.none;
  const [filter, setFilter] = useState<Filter>(initialFilter ?? (issues ? 'issue' : 'all'));
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(STEP);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sorted.filter(
      (r) =>
        (filter === 'all' || (filter === 'issue' ? r.status !== 'balanced' : r.status === filter)) &&
        (!needle || r.groupId.toLowerCase().includes(needle) || r.topic.toLowerCase().includes(needle)),
    );
  }, [sorted, filter, q]);

  if (!s.pairs) {
    return (
      <p className="empty" style={{ marginTop: 10 }}>
        Chưa có group nào đánh giá được (cần group consumer thường, mô tả được, có member hoặc offset).
      </p>
    );
  }

  const pick = (f: Filter) => {
    setFilter(filter === f ? 'all' : f);
    setShown(STEP);
  };
  const chips: { status: PcStatus; n: number; sub?: string }[] = [
    { status: 'under', n: s.under, sub: s.underLagging ? `${s.underLagging} đang lag` : undefined },
    { status: 'over', n: s.over, sub: s.idleConsumers ? `+${s.idleConsumers} consumer rảnh` : undefined },
    { status: 'none', n: s.none },
    { status: 'balanced', n: s.balanced },
  ];

  return (
    <div className="pc">
      <p className="pc-lead">
        Tối ưu khi <b>mỗi partition có đúng một consumer</b> (số consumer = số partition).{' '}
        <span className="pc-k warn">Thiếu</span> — một consumer gánh nhiều partition, đáng xử lý khi đang lag.{' '}
        <span className="pc-k info">Thừa</span> — consumer dư không được giao partition, ngồi không.
      </p>

      <div className="pc-bar" role="img" aria-label={BAR.map((st) => `${s[st]} ${PC_TEXT[st]}`).join(', ')}>
        {BAR.map((st) => s[st] > 0 && <span key={st} className={`pc-seg ${st}`} style={{ flexGrow: s[st] }} title={`${s[st]} ${PC_TEXT[st]}`} />)}
      </div>

      <div className="pc-tools">
        <div className="pc-chips" role="group" aria-label="Lọc theo trạng thái">
          {chips.map(
            (c) =>
              c.n > 0 && (
                <button
                  key={c.status}
                  type="button"
                  className={`pc-chip ${c.status}${filter === c.status ? ' on' : ''}`}
                  aria-pressed={filter === c.status}
                  onClick={() => pick(c.status)}
                  title={filter === c.status ? 'Bỏ lọc' : `Chỉ xem: ${PC_TEXT[c.status]}`}
                >
                  <i aria-hidden />
                  <b>{fmtInt(c.n)}</b> {PC_TEXT[c.status]}
                  {c.sub && <small>· {c.sub}</small>}
                </button>
              ),
          )}
          <span className="pc-chips-sep" aria-hidden />
          {issues > 0 && (
            <button type="button" className={`pc-chip plain${filter === 'issue' ? ' on' : ''}`} aria-pressed={filter === 'issue'} onClick={() => pick('issue')}>
              Chỉ cặp lệch
            </button>
          )}
          <button
            type="button"
            className={`pc-chip plain${filter === 'all' ? ' on' : ''}`}
            aria-pressed={filter === 'all'}
            onClick={() => {
              setFilter('all');
              setShown(STEP);
            }}
          >
            Tất cả {fmtInt(s.pairs)}
          </button>
        </div>
        <input
          className="input pc-search"
          type="search"
          name="kafka-balance-filter"
          placeholder="Lọc group / topic…"
          aria-label="Lọc group hoặc topic"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setShown(STEP);
          }}
          autoComplete="off"
          data-lpignore="true"
          data-form-type="other"
        />
      </div>

      {list.length === 0 ? (
        <p className="empty">{filter === 'issue' && !q.trim() ? 'Mọi cặp group · topic đều cân bằng.' : 'Không có cặp nào khớp.'}</p>
      ) : (
        <div className="pc-table-wrap">
          <table className="pc-table">
            <thead>
              <tr>
                <th>Group · topic</th>
                <th>Partition ↔ consumer</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, shown).map((r) => {
                const urgent = r.status === 'under' && (r.lag ?? 0) > 0;
                return (
                  <tr
                    key={`${r.groupId}\u0000${r.topic}`}
                    className={onOpenGroup ? 'pc-click' : undefined}
                    tabIndex={onOpenGroup ? 0 : undefined}
                    title={pcAdvice(r) + (onOpenGroup ? ' — bấm để xem consumer và partition của group' : '')}
                    onClick={onOpenGroup ? () => onOpenGroup(r.groupId) : undefined}
                    onKeyDown={onOpenGroup ? (e) => e.key === 'Enter' && onOpenGroup(r.groupId) : undefined}
                  >
                    <td className="pc-name">
                      <b title={r.groupId}>{r.groupId}</b>
                      <span title={r.topic}>{r.topic}</span>
                    </td>
                    <td>
                      <PcMeter partitions={r.partitions} consumers={r.consumers} />
                    </td>
                    <td className="pc-st">
                      <PcPill row={r} />
                      <span className="pc-ratio">
                        {pcRatioText(r)}
                        {' · lag '}
                        {r.lag === null ? <span className="pc-unk">?</span> : <b className={r.lag > 0 ? 'pc-lag' : ''}>{fmtInt(r.lag)}</b>}
                      </span>
                      {/* Gợi ý ngắn ngay trong hàng cho cặp cần làm; câu đầy đủ ở tooltip của hàng. */}
                      {urgent && <span className="pc-advice">→ tăng consumer lên {r.partitions}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {list.length > shown && (
        <div className="pc-pager">
          <button type="button" className="chip-btn" onClick={() => setShown(shown + STEP)}>
            Xem thêm {Math.min(STEP, list.length - shown)} / còn {list.length - shown}
          </button>
        </div>
      )}
      <div className="kafka-hint">
        Đánh giá {fmtInt(groupsChecked)} group consumer · consumer = member đăng ký topic (kể cả member không được giao partition).
      </div>
    </div>
  );
}

/** Ô cân bằng của một group trong danh sách: cặp tệ nhất + số topic lệch khác. */
export function GroupBalanceCell({ rows }: { rows?: KafkaPcRow[] }) {
  if (!rows?.length) return <span className="pc-unk" title="Chưa đánh giá được (group không có member / không phải group consumer thường)">—</span>;
  const sorted = sortBalance(rows);
  const worst = sorted[0];
  const more = sorted.filter(isLopsided).length - (isLopsided(worst) ? 1 : 0);
  const tip = sorted
    .map((r) => `${r.topic}: ${r.partitions} partition · ${r.consumers} consumer — ${PC_TEXT[r.status]} (${pcRatioText(r)})`)
    .join('\n');
  return (
    <span className="pc-cell" title={tip}>
      <PcPill row={worst} />
      <small>
        {worst.consumers}/{worst.partitions}
        {rows.length > 1 ? ` · ${worst.topic}` : ''}
        {more > 0 ? ` +${more}` : ''}
      </small>
    </span>
  );
}

/** Phân công trong chi tiết group: cân bằng theo topic + từng consumer giữ partition nào. */
export function GroupAssignment({ balance, consumers }: { balance?: KafkaPcRow[]; consumers?: GroupConsumer[] }) {
  if (!balance?.length && !consumers?.length) return null;
  const load = (c: GroupConsumer) => c.assigned.reduce((n, a) => n + a.partitions.length, 0);
  return (
    <div className="pc-assign">
      {balance && balance.length > 0 && (
        <div className="pc-assign-topics">
          {balance.map((r) => (
            <span key={r.topic} title={pcAdvice(r)}>
              <PcPill row={r} />
              <code>{r.topic}</code>
              <span>
                {r.partitions} partition · {r.consumers} consumer — {pcRatioText(r)}
              </span>
            </span>
          ))}
        </div>
      )}
      {consumers && consumers.length > 0 && (
        <div className="pc-consumers">
          {consumers.map((c) => {
            const n = load(c);
            return (
              <div key={c.memberId} className={`pc-consumer${n === 0 ? ' idle' : ''}`} title={c.memberId}>
                <div className="pc-consumer-head">
                  <b>{c.clientId || c.memberId}</b>
                  <small>{n === 0 ? 'rảnh' : `${n} partition`}</small>
                </div>
                {c.host && <div className="pc-consumer-host">{c.host}</div>}
                <div className="pc-consumer-parts">
                  {n === 0
                    ? 'Không được giao partition nào'
                    : c.assigned.map((a) => (
                        <span key={a.topic}>
                          <code>{a.topic}</code> [{a.partitions.join(', ')}]{' '}
                        </span>
                      ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
