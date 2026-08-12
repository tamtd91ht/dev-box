'use client';

// One action inside a rule — the "then do this" half of the editor.
//
// Split out of RuleEditor because two of the actions (API call, Telegram) carry
// a real form of their own: query/header rows, auth, a bot to verify. The card
// knows nothing about which actions a group allows — it renders the `allowed`
// list it is handed (see catalog.ts).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listConnections, connLabel, type ConnOption } from '@/lib/automation/connections';
import type { TargetGroup } from '@/lib/workspace/targets';
import { sendToTargetGroup, type WsSendOutcome } from '@/lib/automation/wsSend';
import { sendViaZaloApi, type ZaloApiSendOutcome } from '@/lib/automation/zaloApiSend';
import { loadZaloApiAccounts, zaloApiAccountKey } from '@/lib/zaloapi/accounts';
import { zaloApiContacts, zaloApiContactAdd, type ZaloContact } from '@/lib/zaloapi/api';
import { useAutomation } from '@/lib/automation/useAutomation';
import { requireGuest } from '@/lib/workspace/guests';
import type { ActionType, AutomationAction, HttpMethod } from '@/lib/automation/types';
import { Field, Num, Toggle } from './parts';
import { TplInput, TplTextarea } from './TplField';

export const ACTION_LABEL: Record<ActionType, string> = {
  notify: '🔔 Thông báo',
  webhook: '🌐 Gọi API',
  telegram: '✈️ Gửi Telegram',
  wsSend: '💬 Gửi Zalo / workspace',
  zaloApiSend: '🟦 Gửi Zalo API',
  log: '📄 Ghi file log',
  kafka: '≋ Bắn Kafka',
  reply: '↩ Trả lời (cần duyệt)',
};

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// ── key/value rows (query params, headers) ─────────────────────────────────

/**
 * Editor for a string→string map.
 *
 * Rows live in local state rather than being derived from the object on every
 * keystroke: a half-typed row (`""` → value) has no key yet, and rebuilding the
 * object from props would make it disappear under the cursor. What leaves here
 * is always the clean map — rows with a blank key are dropped on the way out and
 * kept on screen.
 */
function KVRows({
  value,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
}: {
  value: Record<string, string> | undefined;
  onChange: (v: Record<string, string>) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}) {
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(value ?? {}));
  const emitted = useRef(JSON.stringify(value ?? {}));

  // Re-adopt only when the map changed from the OUTSIDE (another rule selected,
  // config reloaded) — not as an echo of what we just emitted.
  useEffect(() => {
    const incoming = JSON.stringify(value ?? {});
    if (incoming !== emitted.current) {
      setRows(Object.entries(value ?? {}));
      emitted.current = incoming;
    }
  }, [value]);

  const push = (next: [string, string][]) => {
    setRows(next);
    const map = Object.fromEntries(next.filter(([k]) => k.trim()));
    emitted.current = JSON.stringify(map);
    onChange(map);
  };

  return (
    <div className="auto-kv">
      {rows.map(([k, v], i) => (
        <div className="auto-kv-row" key={i}>
          <input
            value={k}
            placeholder={keyPlaceholder}
            onChange={(e) => push(rows.map((r, j) => (i === j ? [e.target.value, r[1]] : r)))}
          />
          <TplInput
            value={v}
            placeholder={valuePlaceholder}
            onChange={(nv) => push(rows.map((r, j) => (i === j ? [r[0], nv] : r)))}
          />
          <button type="button" className="ghost sm" onClick={() => push(rows.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="ghost sm" onClick={() => push([...rows, ['', '']])}>
        ＋ {addLabel}
      </button>
    </div>
  );
}

// ── Telegram: what this machine already has ────────────────────────────────

interface TelegramEnv {
  configured: boolean;
  tokenHint: string;
  chats: { id: string; from: 'allowed' | 'owner' }[];
}

const EMPTY_ENV: TelegramEnv = { configured: false, tokenHint: '', chats: [] };

/** One fetch per session, shared by every action card. */
let envPromise: Promise<TelegramEnv> | null = null;
function loadTelegramEnv(): Promise<TelegramEnv> {
  envPromise ??= fetch('/api/automation/telegram')
    .then((r) => r.json())
    .then((d: Partial<TelegramEnv>) => ({ ...EMPTY_ENV, ...d }))
    .catch(() => EMPTY_ENV);
  return envPromise;
}

function TelegramFields({
  action,
  onChange,
}: {
  action: Extract<AutomationAction, { type: 'telegram' }>;
  onChange: (a: AutomationAction) => void;
}) {
  const [env, setEnv] = useState<TelegramEnv>(EMPTY_ENV);
  const [check, setCheck] = useState<{ busy: boolean; text?: string; ok?: boolean }>({ busy: false });
  const inline = action.tokenSource === 'inline';

  useEffect(() => {
    let alive = true;
    void loadTelegramEnv().then((e) => alive && setEnv(e));
    return () => {
      alive = false;
    };
  }, []);

  const verify = async () => {
    setCheck({ busy: true });
    try {
      const r = await fetch('/api/automation/telegram', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tokenSource: action.tokenSource ?? 'env',
          botToken: action.botToken,
          chatId: action.chatId,
        }),
      });
      const d = (await r.json()) as { ok?: boolean; bot?: string; chat?: string; error?: string };
      setCheck({
        busy: false,
        ok: !!d.ok && !d.error,
        text: d.ok
          ? `bot ${d.bot}\nchat ${d.chat || '— chưa kiểm tra: ' + (d.error ?? 'thiếu chat id')}`
          : `✗ ${d.error ?? 'không kiểm tra được'}`,
      });
    } catch (e) {
      setCheck({ busy: false, ok: false, text: `✗ ${(e as Error).message}` });
    }
  };

  return (
    <div className="auto-grid">
      <Field
        label="Bot"
        hint={
          inline
            ? 'token này lưu trong file cấu hình automation của máy'
            : env.configured
              ? `dùng TELEGRAM_BOT_TOKEN của máy (${env.tokenHint}) — không lưu lại token`
              : '⚠ máy này chưa đặt TELEGRAM_BOT_TOKEN trong .env.local'
        }
      >
        <select
          value={action.tokenSource ?? 'env'}
          onChange={(e) =>
            onChange({ ...action, tokenSource: e.target.value as 'env' | 'inline', botToken: '' })
          }
        >
          <option value="env">Bot sẵn có của máy (.env.local)</option>
          <option value="inline">Bot khác — nhập token</option>
        </select>
      </Field>

      {inline ? (
        <Field label="Bot token" hint="lấy từ @BotFather">
          <input
            type="password"
            autoComplete="off"
            value={action.botToken ?? ''}
            placeholder="123456:AA…"
            onChange={(e) => onChange({ ...action, botToken: e.target.value })}
          />
        </Field>
      ) : null}

      <Field
        label="Chat ID"
        hint={inline || !env.chats.length ? 'id nhóm (số âm) hoặc @tenkenh' : 'để trống = chat đầu tiên trong .env.local'}
      >
        <TplInput
          value={action.chatId}
          placeholder={!inline && env.chats[0] ? env.chats[0].id : '-1001234567890'}
          onChange={(v) => onChange({ ...action, chatId: v })}
        />
      </Field>

      {!inline && env.chats.length ? (
        <Field label="Chat đã khai báo sẵn" wide hint="lấy từ .env.local của máy này">
          <div className="auto-checks">
            {env.chats.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`auto-chip${action.chatId === c.id ? ' on' : ''}`}
                onClick={() => onChange({ ...action, chatId: c.id })}
              >
                {c.id}
                {c.from === 'owner' ? ' (chat riêng)' : ''}
              </button>
            ))}
          </div>
        </Field>
      ) : null}

      <Field label="Nội dung" wide hint="để trống = tiêu đề + nội dung sự kiện · dùng {{severityLabel}}, {{value}}, {{address}}, {{description}}… · {{metaJson}} = metadata đầy đủ">
        <TplTextarea
          value={action.text ?? ''}
          placeholder={'🚨 *{{title}}*\n{{text}}'}
          onChange={(v) => onChange({ ...action, text: v })}
        />
      </Field>

      <Field label="Định dạng" hint="sai cú pháp Markdown là Telegram từ chối cả tin">
        <select
          value={action.parseMode ?? 'none'}
          onChange={(e) => onChange({ ...action, parseMode: e.target.value as typeof action.parseMode })}
        >
          <option value="none">Chữ thường</option>
          <option value="Markdown">Markdown</option>
          <option value="MarkdownV2">MarkdownV2</option>
          <option value="HTML">HTML</option>
        </select>
      </Field>

      <Field label="Topic id" hint="chỉ dùng cho nhóm bật chủ đề — để trống nếu không">
        <TplInput
          value={action.threadId ?? ''}
          onChange={(v) => onChange({ ...action, threadId: v })}
        />
      </Field>

      <div className="auto-switches wide">
        <Toggle
          checked={!!action.silent}
          onChange={(v) => onChange({ ...action, silent: v })}
          label="Gửi im lặng"
          hint="tin vẫn đến, máy nhận không kêu"
        />
        <Toggle
          checked={action.noPreview !== false}
          onChange={(v) => onChange({ ...action, noPreview: v })}
          label="Tắt xem trước link"
        />
        <button type="button" className="ghost sm" disabled={check.busy} onClick={verify}>
          {check.busy ? 'đang kiểm tra…' : 'Kiểm tra bot'}
        </button>
      </div>

      {check.text ? <pre className="auto-probe wide">{check.text}</pre> : null}
    </div>
  );
}

// ── API call ───────────────────────────────────────────────────────────────

function ApiFields({
  action,
  onChange,
}: {
  action: Extract<AutomationAction, { type: 'webhook' }>;
  onChange: (a: AutomationAction) => void;
}) {
  const auth = action.auth ?? { kind: 'none' as const };
  const hasBody = action.method !== 'GET' && action.method !== 'DELETE';
  const setAuth = (patch: Partial<typeof auth>) => onChange({ ...action, auth: { ...auth, ...patch } });

  return (
    <div className="auto-grid">
      <Field label="Phương thức">
        <select
          value={action.method}
          onChange={(e) => onChange({ ...action, method: e.target.value as HttpMethod })}
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Chờ tối đa (giây)" hint="1–60, mặc định 10">
        <Num value={action.timeoutSec} onChange={(v) => onChange({ ...action, timeoutSec: v })} placeholder="10" />
      </Field>
      <Field label="URL" wide hint="chạy phía server — không dính CORS, token không lộ ra network log">
        <TplInput
          value={action.url}
          placeholder="https://…"
          onChange={(v) => onChange({ ...action, url: v })}
        />
      </Field>

      <Field label="Tham số query" wide hint="nối vào URL, đã tự mã hoá — tên và giá trị đều dùng được {{…}}">
        <KVRows
          value={action.query}
          onChange={(query) => onChange({ ...action, query })}
          keyPlaceholder="tên"
          valuePlaceholder="giá trị"
          addLabel="tham số"
        />
      </Field>

      <Field label="Header" wide hint="giá trị dùng được {{…}}">
        <KVRows
          value={action.headers}
          onChange={(headers) => onChange({ ...action, headers })}
          keyPlaceholder="X-Request-Id"
          valuePlaceholder="{{id}}"
          addLabel="header"
        />
      </Field>

      <Field label="Xác thực">
        <select
          value={auth.kind}
          onChange={(e) => setAuth({ kind: e.target.value as typeof auth.kind })}
        >
          <option value="none">Không</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic (user + mật khẩu)</option>
          <option value="header">API key trong header</option>
        </select>
      </Field>
      {auth.kind === 'basic' ? (
        <Field label="Tài khoản">
          <input value={auth.user ?? ''} autoComplete="off" onChange={(e) => setAuth({ user: e.target.value })} />
        </Field>
      ) : null}
      {auth.kind === 'header' ? (
        <Field label="Tên header" hint="để trống = X-API-Key">
          <input
            value={auth.header ?? ''}
            placeholder="X-API-Key"
            onChange={(e) => setAuth({ header: e.target.value })}
          />
        </Field>
      ) : null}
      {auth.kind !== 'none' ? (
        <Field label={auth.kind === 'basic' ? 'Mật khẩu' : 'Token'} hint="lưu trong file cấu hình của máy này">
          <input
            type="password"
            autoComplete="off"
            value={auth.token ?? ''}
            onChange={(e) => setAuth({ token: e.target.value })}
          />
        </Field>
      ) : null}

      {hasBody ? (
        <>
          <Field label="Kiểu body" hint="quyết định content-type khi bạn không tự đặt header">
            <select
              value={action.bodyType ?? 'json'}
              onChange={(e) => onChange({ ...action, bodyType: e.target.value as typeof action.bodyType })}
            >
              <option value="json">JSON</option>
              <option value="text">Text</option>
              <option value="form">Form (x-www-form-urlencoded)</option>
            </select>
          </Field>
          <Field label="Body" wide hint="để trống = toàn bộ sự kiện dạng JSON · {{metaJson}} = metadata chuẩn (AlertMeta) — chèn không cần ngoặc kép">
            <TplTextarea
              value={action.bodyTemplate ?? ''}
              placeholder={'{"alert":{{metaJson}}}\nhoặc: {"text":"{{title}} — {{text}}"}'}
              onChange={(v) => onChange({ ...action, bodyTemplate: v })}
            />
          </Field>
        </>
      ) : (
        <Field label="Body" hint={`${action.method} không gửi body`}>
          <span className="auto-hint">—</span>
        </Field>
      )}

      <Toggle
        checked={!!action.captureResponse}
        onChange={(v) => onChange({ ...action, captureResponse: v })}
        label="Ghi lại phản hồi"
        hint="giữ 500 ký tự đầu của response trong tab Hoạt động"
      />
    </div>
  );
}

// ── Send into a workspace account ──────────────────────────────────────────

/**
 * Pick WHO sends and WHICH saved target list receives.
 *
 * The recipients are not typed here on purpose: chat.zalo.me has no
 * per-conversation id, so a target can only be matched by display name — safe
 * only inside a small set the user curated. That set is a Zalo label, synced
 * into DevBox from the workspace tab's 🔎 panel.
 */
function WorkspaceSendFields({
  action,
  onChange,
}: {
  action: Extract<AutomationAction, { type: 'wsSend' }>;
  onChange: (a: AutomationAction) => void;
}) {
  const [groups, setGroups] = useState<TargetGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<WsSendOutcome | null>(null);

  /**
   * Walk the ENTIRE send path without sending: open the conversation, type the
   * message, then clear it. The step log is what turns "không gửi được" into
   * something fixable — and when the composer is not found it lists every
   * editable on the page, which is how its selector gets pinned.
   */
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await sendToTargetGroup(action, true));
    } catch (e) {
      setTest({ status: 'error', detail: (e as Error).message, sent: 0, results: [] });
    }
    setTesting(false);
  };

  useEffect(() => {
    let alive = true;
    void fetch('/api/ws-targets')
      .then((r) => r.json())
      .then((d: { groups?: TargetGroup[] }) => {
        if (!alive) return;
        setGroups(d.groups ?? []);
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  // Accounts that can actually send = those with a synced target list.
  const accounts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const g of groups) if (!seen.has(g.accountKey)) seen.set(g.accountKey, g.accountLabel || g.accountKey);
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [groups]);

  const mine = groups.filter((g) => g.accountKey === action.accountKey);
  const chosen = groups.find((g) => g.id === action.targetGroupId);

  // The two reasons a wsSend silently does nothing, surfaced HERE instead of
  // only as an outcome after the rule has already failed to send.
  const { config } = useAutomation();
  const guestProblem = action.accountKey ? requireGuest(action.accountKey).error : '';

  if (loaded && !groups.length) {
    return (
      <p className="auto-hint">
        Chưa có danh bạ đích nào. Vào tab <b>🧭 Workspace</b> → chọn tài khoản Zalo → bấm <b>🔎</b> →
        chọn một nhãn <b>Phân loại</b> → <b>Lưu vào danh bạ</b>. Nhãn đó gán ở chính Zalo, nên thêm
        bớt người nhận là việc bạn làm trong Zalo, không phải sửa quy tắc.
      </p>
    );
  }

  return (
    <div className="auto-grid">
      {!config.allowSend && (
        <p className="ws-scan-bad auto-wide">
          ⚠ Công tắc <b>“cho phép gửi”</b> ở đầu tab Automation đang TẮT — hành động này sẽ bị bỏ qua
          (các hành động khác trong cùng quy tắc vẫn chạy bình thường).
        </p>
      )}
      {guestProblem && (
        <p className="ws-scan-bad auto-wide">
          ⚠ {guestProblem} — mở tab 🧭 Workspace một lần để guest Zalo sống, rồi quay lại.
        </p>
      )}

      <Field label="Gửi từ tài khoản" hint="tài khoản Zalo đang đăng nhập trong tab Workspace">
        <select
          value={action.accountKey}
          onChange={(e) => onChange({ ...action, accountKey: e.target.value, targetGroupId: '' })}
        >
          <option value="">— chọn —</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Gửi tới nhãn" hint="danh sách đã đồng bộ từ Phân loại của Zalo">
        <select
          value={action.targetGroupId}
          disabled={!action.accountKey}
          onChange={(e) => {
            const g = groups.find((x) => x.id === e.target.value);
            onChange({ ...action, targetGroupId: e.target.value, targetLabel: g?.label ?? '' });
          }}
        >
          <option value="">— chọn —</option>
          {mine.map((g) => (
            <option key={g.id} value={g.id}>
              🏷 {g.label} ({g.targets.length})
            </option>
          ))}
        </select>
      </Field>

      {chosen && (
        <Field label="Sẽ gửi tới" wide hint="đúng những hội thoại này — đồng bộ lại ở tab Workspace khi bạn đổi nhãn trong Zalo">
          <div className="auto-checks">
            {chosen.targets.map((t) => (
              <span key={t.name} className="auto-chip on">
                {t.kind === 'group' ? '👥' : '👤'} {t.name}
              </span>
            ))}
            {!chosen.targets.length && <span className="auto-hint">nhãn này chưa có hội thoại nào</span>}
          </div>
        </Field>
      )}

      <Field label="Nội dung" wide hint="dùng {{title}}, {{text}}, {{value}}, {{metricLabel}}, {{description}}…">
        <TplTextarea
          value={action.text}
          placeholder={'🚨 {{title}}\n{{text}}'}
          onChange={(v) => onChange({ ...action, text: v })}
        />
      </Field>

      <div className="auto-switches wide">
        <button
          type="button"
          className="ghost sm"
          disabled={testing || !action.accountKey || !action.targetGroupId || !action.text.trim()}
          onClick={() => void runTest()}
        >
          {testing ? 'đang thử…' : '▶ Gửi thử (mở hội thoại, gõ rồi xoá — KHÔNG gửi)'}
        </button>
        {test && (
          <span className={test.status === 'error' ? 'ws-scan-bad' : 'ws-scan-ok'}>{test.detail}</span>
        )}
      </div>

      {test && test.results.length > 0 && (
        <div className="auto-probe wide">
          {test.results.map((r, i) => (
            <div key={i}>
              <b>{r.target}</b>
              {(r.result?.steps ?? []).map((s, j) => (
                <div key={j}>
                  {'  '}
                  {s.ok ? '✓' : '✗'} {s.step} — {s.detail}
                </div>
              ))}
              {r.error && <div>{'  '}✗ {r.error}</div>}
              {(r.result?.editables ?? []).length > 0 && (
                <div>
                  {'  '}ô nhập liệu thấy được:
                  {r.result!.editables.map((e, k) => (
                    <div key={k}>
                      {'    '}
                      {e.tag}
                      {e.contentEditable ? '[contenteditable]' : ''} {e.w}×{e.h} @ {e.x},{e.y} — {e.path}
                    </div>
                  ))}
                </div>
              )}
              {(r.result?.controls ?? []).length > 0 && (
                <div>
                  {'  '}nút cạnh ô soạn (nút gửi nằm trong đây):
                  {r.result!.controls.map((c, k) => (
                    <div key={k}>
                      {'    '}
                      {c.tag}
                      {c.hasSvg ? '(svg)' : ''} {c.dataId ? `data-id="${c.dataId}" ` : ''}
                      {c.title ? `"${c.title}" ` : ''}
                      {c.text ? `[${c.text}] ` : ''}
                      {c.w}×{c.h} — {c.path}
                    </div>
                  ))}
                </div>
              )}
              {r.result?.composerHtml && (
                <details>
                  <summary>{'  '}HTML vùng soạn tin</summary>
                  <div>{r.result.composerHtml}</div>
                </details>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="auto-hint auto-wide">
        Cần bật công tắc <b>cho phép gửi</b> ở đầu tab Automation. Quy tắc để <b>chạy thử</b> thì nó
        vẫn mở hội thoại và gõ nội dung vào ô soạn, rồi <b>xoá đi không gửi</b> — cách duy nhất để
        biết đường gửi còn chạy trước khi có sự cố thật. Trần cứng: 5s giữa 2 tin, 20 tin/giờ mỗi
        tài khoản.
      </p>
    </div>
  );
}

// ── Zalo API send (THỬ NGHIỆM) ──────────────────────────────────────────────
//
// Khác WorkspaceSendFields ở chỗ: không có danh bạ đồng bộ. Đích là threadId
// thật gõ thẳng (trống = gửi cho chính mình). Nút "gửi thử" dựng request rồi in
// ra mà không bắn đi — đúng tinh thần một bước thử.
function ZaloApiSendFields({
  action,
  onChange,
}: {
  action: Extract<AutomationAction, { type: 'zaloApiSend' }>;
  onChange: (a: AutomationAction) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ZaloApiSendOutcome | null>(null);
  const { config } = useAutomation();
  const guestProblem = action.accountKey ? requireGuest(action.accountKey).error : '';
  // Danh sách tài khoản Zalo API để chọn (multi-account).
  const zaAccounts = useMemo(() => loadZaloApiAccounts(), []);

  // Danh bạ đích của tài khoản đang chọn (tự học từ tin đến + thêm tay). Rule
  // chỉ CHỌN từ đây — thấy tên, không phải gõ threadId. Nạp lại khi đổi tài khoản.
  const [contacts, setContacts] = useState<ZaloContact[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [manualId, setManualId] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualGroup, setManualGroup] = useState(false);

  const reloadContacts = useCallback(() => {
    if (!action.accountKey) { setContacts([]); return; }
    void zaloApiContacts(action.accountKey).then(setContacts).catch(() => setContacts([]));
  }, [action.accountKey]);
  useEffect(reloadContacts, [reloadContacts]);

  // Giá trị dropdown: '' = gửi cho chính mình; '__tpl' = dùng threadId template
  // (nâng cao); còn lại là threadId của một contact.
  const isTemplate = !!action.threadId && action.threadId.includes('{{');
  const selectValue = isTemplate ? '__tpl' : (action.threadId ?? '');

  const pickContact = (val: string) => {
    if (val === '__tpl') { setShowAdvanced(true); return; }
    if (!val) { onChange({ ...action, threadId: '', group: false, threadLabel: '' }); return; }
    const c = contacts.find((x) => x.threadId === val);
    onChange({ ...action, threadId: val, group: !!c?.group, threadLabel: c?.name ?? val });
  };

  const addManual = async () => {
    const id = manualId.trim();
    if (!id || !action.accountKey) return;
    try {
      const list = await zaloApiContactAdd({ accountKey: action.accountKey, threadId: id, name: manualName.trim(), group: manualGroup });
      setContacts(list);
      onChange({ ...action, threadId: id, group: manualGroup, threadLabel: manualName.trim() || id });
      setManualId(''); setManualName(''); setManualGroup(false);
    } catch { /* giữ nguyên form để thử lại */ }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await sendViaZaloApi(action, true));
    } catch (e) {
      setTest({ status: 'error', detail: (e as Error).message, sent: 0, result: null });
    }
    setTesting(false);
  };

  return (
    <div className="auto-grid">
      <div className="auto-warn-inline auto-wide">
        🟦 Gửi qua API nội bộ của Zalo Web, theo <b>threadId thật</b>. Chọn hội thoại từ danh bạ — nó tự
        ghi lại khi có người nhắn tới. Vi phạm điều khoản Zalo, chỉ dùng tài khoản phù hợp. Trần: 5s/tin, 20 tin/giờ.
      </div>

      <Field label="Tài khoản Zalo API" hint="chọn tài khoản đã thêm trong tab Zalo API">
        <select
          value={action.accountKey}
          onChange={(e) => onChange({ ...action, accountKey: e.target.value })}
        >
          {!zaAccounts.some((a) => zaloApiAccountKey(a.instanceId) === action.accountKey) && (
            <option value={action.accountKey}>{action.accountKey || '(chọn tài khoản)'}</option>
          )}
          {zaAccounts.map((a) => (
            <option key={a.instanceId} value={zaloApiAccountKey(a.instanceId)}>{a.label}</option>
          ))}
        </select>
      </Field>

      <Field label="Gửi tới" hint="danh bạ tự ghi khi có người nhắn tới — hoặc thêm tay ở dưới">
        <select value={selectValue} onChange={(e) => pickContact(e.target.value)}>
          <option value="">— Gửi cho chính mình —</option>
          {contacts.map((c) => (
            <option key={c.threadId} value={c.threadId}>
              {c.group ? '👥 ' : '👤 '}{c.name}{c.manual ? '' : ''}
            </option>
          ))}
          <option value="__tpl">{isTemplate ? `⚙ threadId động: ${action.threadId}` : '⚙ Dùng threadId động / nâng cao…'}</option>
        </select>
      </Field>

      <div className="auto-wide" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" className="ghost sm" onClick={reloadContacts} title="Nạp lại danh bạ">↻ Làm mới</button>
        <button type="button" className="ghost sm" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? 'Ẩn thêm thủ công' : '＋ Thêm hội thoại thủ công'}
        </button>
        <span className="auto-hint" style={{ margin: 0 }}>{contacts.length} hội thoại trong danh bạ</span>
      </div>

      {showAdvanced && (
        <div className="auto-wide" style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <TplInput style={{ flex: '2 1 160px' }} placeholder="threadId thật (hoặc {{fields.threadId}})" value={manualId} onChange={setManualId} />
            <input style={{ flex: '1 1 120px' }} placeholder="tên để dễ nhìn" value={manualName} onChange={(e) => setManualName(e.target.value)} />
            <label className="auto-hint" style={{ display: 'flex', alignItems: 'center', gap: 4, margin: 0 }}>
              <input type="checkbox" checked={manualGroup} onChange={(e) => setManualGroup(e.target.checked)} /> nhóm
            </label>
            <button type="button" className="ghost sm" onClick={() => void addManual()} disabled={!manualId.trim() || !action.accountKey}>Lưu vào danh bạ</button>
          </div>
          <p className="auto-hint" style={{ margin: 0 }}>
            Dùng khi hội thoại chưa ai nhắn tới, hoặc muốn trả lời động: điền
            <code> {'{{fields.threadId}}'} </code> vào ô trên rồi Lưu — rule sẽ trả về đúng hội thoại vừa đến.
          </p>
        </div>
      )}

      <Field label="Nội dung" wide hint="hỗ trợ {{title}}, {{text}}, {{description}}… · nhóm có bot AI: thêm {{metaBlock}} để bot tự phân tích cảnh báo">
        <TplTextarea
          rows={3}
          value={action.text}
          onChange={(v) => onChange({ ...action, text: v })}
        />
      </Field>

      {guestProblem && <p className="auto-hint auto-wide ws-scan-bad">⚠ {guestProblem}</p>}
      {!config.allowSend && (
        <p className="auto-hint auto-wide">
          Công tắc <b>cho phép gửi</b> ở đầu tab Automation đang tắt — quy tắc chỉ chạy thử.
        </p>
      )}

      <div className="auto-wide">
        <button
          type="button"
          className="ghost"
          disabled={testing || !action.accountKey || !action.text.trim()}
          onClick={() => void runTest()}
        >
          {testing ? 'đang thử…' : '▶ Gửi thử (dựng request, KHÔNG bắn đi)'}
        </button>
        {test && (
          <span className={test.status === 'error' ? 'ws-scan-bad' : 'ws-scan-ok'}> {test.detail}</span>
        )}
      </div>
    </div>
  );
}

// ── The card ───────────────────────────────────────────────────────────────

export function defaultAction(type: ActionType): AutomationAction {
  switch (type) {
    case 'notify':
      return { type: 'notify', level: 'info' };
    case 'webhook':
      return { type: 'webhook', url: '', method: 'POST', bodyType: 'json', timeoutSec: 10 };
    case 'telegram':
      return { type: 'telegram', tokenSource: 'env', chatId: '', parseMode: 'none', noPreview: true };
    case 'wsSend':
      return { type: 'wsSend', accountKey: '', targetGroupId: '', text: '' };
    case 'zaloApiSend':
      return { type: 'zaloApiSend', accountKey: 'zaloapi::main', threadId: '', group: false, text: '' };
    case 'log':
      return { type: 'log', file: '' };
    case 'kafka':
      return { type: 'kafka', connectionId: '', topic: '' };
    case 'reply':
      return { type: 'reply', text: '', requireApproval: true };
  }
}

/**
 * One line describing what a collapsed card does — the type alone ("Gọi API")
 * is not enough to tell three of them apart.
 */
function summarize(a: AutomationAction): string {
  switch (a.type) {
    case 'notify':
      return a.title || a.body || 'tiêu đề + nội dung của sự kiện';
    case 'webhook':
      return `${a.method} ${a.url || '(chưa có URL)'}`;
    case 'telegram':
      return `→ ${a.chatId || (a.tokenSource === 'inline' ? 'bot riêng' : 'chat trong .env.local')}`;
    case 'wsSend':
      return `→ ${a.targetLabel || '(chưa chọn danh sách)'}${a.text ? ` · ${a.text.split('\n')[0]}` : ''}`;
    case 'zaloApiSend':
      return `→ ${a.threadLabel || a.threadId || 'chính mình'}${a.text ? ` · ${a.text.split('\n')[0]}` : ''}`;
    case 'log':
      return a.file || '.automation-log.jsonl';
    case 'kafka':
      return `${a.topic || '(chưa có topic)'}`;
    case 'reply':
      return a.text || '(chưa có nội dung)';
    default:
      return '';
  }
}

export default function ActionCard({
  action,
  allowed,
  open,
  onToggle,
  onChange,
  onRemove,
}: {
  action: AutomationAction;
  allowed: ActionType[];
  /** Folded cards keep the rule readable when it has several actions. */
  open: boolean;
  onToggle: () => void;
  onChange: (a: AutomationAction) => void;
  onRemove: () => void;
}) {
  const [kafkaConns, setKafkaConns] = useState<ConnOption[]>([]);
  useEffect(() => {
    if (action.type !== 'kafka') return;
    void listConnections('kafka').then(setKafkaConns);
  }, [action.type]);

  const switchType = (type: ActionType) => {
    if (type === action.type) return;
    onChange(defaultAction(type));
  };

  return (
    <div className={`auto-action${open ? '' : ' is-closed'}`}>
      <div className="auto-action-head">
        <button
          type="button"
          className="auto-fold"
          aria-expanded={open}
          title={open ? 'Thu gọn' : 'Mở ra'}
          onClick={onToggle}
        >
          {open ? '▾' : '▸'}
        </button>
        <select value={action.type} onChange={(e) => switchType(e.target.value as ActionType)}>
          {allowed.map((t) => (
            <option key={t} value={t}>
              {ACTION_LABEL[t]}
            </option>
          ))}
        </select>
        {!open && (
          <span className="auto-action-sum" title={summarize(action)} onClick={onToggle}>
            {summarize(action)}
          </span>
        )}
        <button type="button" className="ghost sm" onClick={onRemove} title="Xoá hành động">
          ✕
        </button>
      </div>

      {!open ? null : (
        <>

      {action.type === 'notify' ? (
        <div className="auto-grid">
          <Field label="Mức độ">
            <select
              value={action.level}
              onChange={(e) => onChange({ ...action, level: e.target.value as typeof action.level })}
            >
              <option value="info">Thông tin</option>
              <option value="warn">Cảnh báo</option>
              <option value="urgent">Khẩn (không tự tắt)</option>
            </select>
          </Field>
          <Field label="Tiêu đề" hint="để trống = tiêu đề sự kiện">
            <TplInput value={action.title ?? ''} onChange={(v) => onChange({ ...action, title: v })} />
          </Field>
          <Field label="Nội dung" wide hint="dùng {{sender}}, {{text}}, {{value}}, {{description}}…">
            <TplInput value={action.body ?? ''} onChange={(v) => onChange({ ...action, body: v })} />
          </Field>
          <Toggle
            checked={!!action.sound}
            onChange={(v) => onChange({ ...action, sound: v })}
            label="Có tiếng"
            hint="kêu cả khi workspace đang tắt tiếng"
          />
        </div>
      ) : null}

      {action.type === 'webhook' ? <ApiFields action={action} onChange={onChange} /> : null}

      {action.type === 'telegram' ? <TelegramFields action={action} onChange={onChange} /> : null}

      {action.type === 'wsSend' ? <WorkspaceSendFields action={action} onChange={onChange} /> : null}

      {action.type === 'zaloApiSend' ? <ZaloApiSendFields action={action} onChange={onChange} /> : null}

      {action.type === 'log' ? (
        <Field label="Tên file" hint="cùng thư mục DevBox, đuôi .jsonl — để trống = .automation-log.jsonl">
          <input value={action.file ?? ''} placeholder=".automation-log.jsonl" onChange={(e) => onChange({ ...action, file: e.target.value })} />
        </Field>
      ) : null}

      {action.type === 'kafka' ? (
        <div className="auto-grid">
          <Field label="Kết nối">
            <select value={action.connectionId} onChange={(e) => onChange({ ...action, connectionId: e.target.value })}>
              <option value="">— chọn —</option>
              {kafkaConns.map((c) => (
                <option key={c.id} value={c.id}>
                  {connLabel(c)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Topic">
            <input value={action.topic} onChange={(e) => onChange({ ...action, topic: e.target.value })} />
          </Field>
          <Field label="Key" hint="để trống = instanceId">
            <TplInput value={action.key ?? ''} onChange={(v) => onChange({ ...action, key: v })} />
          </Field>
          <Field label="Value" wide hint="để trống = toàn bộ sự kiện dạng JSON · {{metaJson}} = metadata chuẩn (AlertMeta)">
            <TplInput
              value={action.valueTemplate ?? ''}
              onChange={(v) => onChange({ ...action, valueTemplate: v })}
            />
          </Field>
        </div>
      ) : null}

      {action.type === 'reply' ? (
        <div className="auto-grid">
          <Field label="Nội dung trả lời" wide hint="LUÔN cần bật 'cho phép gửi' + duyệt tay — không bao giờ tự gửi">
            <TplInput value={action.text} onChange={(v) => onChange({ ...action, text: v })} />
          </Field>
        </div>
      ) : null}
        </>
      )}
    </div>
  );
}
