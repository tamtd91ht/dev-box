'use client';

// Zalo API — tab riêng, TÁCH HẲN khỏi khung Workspace. Hỗ trợ NHIỀU tài khoản
// như Workspace: rail bên trái + mỗi tài khoản một phiên Zalo độc lập.
//
// Vì sao tách: client API không có "trang" để hiện như một workspace bình
// thường. Nhét vào WorkspaceView khiến mỗi nhánh mọc thêm `if(isApi)`. Ở đây nó
// độc lập; luồng Workspace cũ không đổi dòng nào.
//
// KIẾN TRÚC MULTI-ACCOUNT:
//   • lib/zaloapi/accounts.ts giữ danh sách tài khoản (localStorage). Mỗi tài
//     khoản: instanceId → partition `persist:zaloapi-<id>` + accountKey
//     `zaloapi::<id>` (dùng chung cho guest registry, phiên server, listener,
//     scope automation).
//   • Mỗi tài khoản là MỘT <ZaloApiAccountView>, mount-and-keep (ẩn offscreen
//     khi không chọn) để listener + guest chạy nền — như keepAlive của Workspace.
//   • Parent chỉ lo: danh sách, thêm/đổi tên/xoá, tài khoản đang chọn.
//
// LUỒNG THẬT (mỗi tài khoản, backend ở lib/zaloapi/server/* + /api/zaloapi):
//   Kết nối = trích cookie(HttpOnly qua main)+imei+UA từ guest → login server-side.
//   Nhận: listener WebSocket SERVER-SIDE; renderer poll → nuôi automation
//         (message.received sourceId 'zaloapi', mang threadId thật) + ghi Console.
//   Gửi: rule automation (action zaloApiSend) hoặc gõ thẳng trong trang Zalo.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebviewElement } from '@/lib/workspace/types';
import { buildExtractScript } from '@/lib/zaloapi/extract';
import {
  fetchZaloApiFlags,
  zaloApiLogin,
  zaloApiLogout,
  zaloApiStatus,
  zaloApiListen,
  zaloApiPoll,
  type ZaloApiFlags,
  type ZaloSessionInfo,
  type ZaloListenerState,
} from '@/lib/zaloapi/api';
import {
  loadZaloApiAccounts,
  saveZaloApiAccounts,
  newZaloApiAccount,
  zaloApiAccountKey,
  zaloApiPartition,
  type ZaloApiAccount,
} from '@/lib/zaloapi/accounts';
import { zaloIncomingEvent } from '@/lib/zaloapi/event';
import { buildNotiHookScript, drainNotiScript } from '@/lib/zaloapi/notiHook';
import type { ExtractResult } from '@/lib/zaloapi/types';
import { isDesktop } from '@/lib/workspace/config';
import { registerGuest } from '@/lib/workspace/guests';
import { automation, useAutomation } from '@/lib/automation/useAutomation';
import { useChime } from './BrowserWorkspace';

const ZALO_URL = 'https://chat.zalo.me/';
const POLL_MS = 2000;
const SESSION_COOKIES = ['zpsid', 'zpw_sek', 'zpw_enk'];

type Status = 'loading' | 'ready' | 'failed';
type LogKind = 'info' | 'recv' | 'send' | 'err';
interface LogLine { at: number; kind: LogKind; text: string }

/** Lý do một rule KHÔNG khớp, dịch sang câu người đọc hành động được. */
function skipReason(s?: string): string {
  switch (s) {
    case 'config-disabled': return 'Automation đang tắt (công tắc tổng)';
    case 'rule-disabled': return 'quy tắc đang tắt';
    case 'trigger': return 'khác nhóm/loại sự kiện (không phải social message.received)';
    case 'scope': return 'ngoài phạm vi — sai tài khoản/nguồn, hoặc scope "Hội thoại" không khớp TÊN';
    case 'window': return 'ngoài khung giờ hoạt động';
    case 'no-match': return 'điều kiện không thoả (xem lại "Nội dung chứa …")';
    case 'dedupe': return 'trùng nội dung gần đây (dedupe)';
    case 'cooldown': return 'đang trong thời gian nghỉ (cooldown)';
    case 'rate-limit': return 'vượt trần số lần/giờ';
    case 'echo': return 'bị coi là tin của chính automation (loopGuard)';
    default: return s || 'không rõ';
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  MỘT tài khoản — webview + kết nối + nhận + console. Mount-and-keep.
// ════════════════════════════════════════════════════════════════════════════
function ZaloApiAccountView({
  account,
  active,
  viewing,
  flags,
  captureOn,
  onUnread,
}: {
  account: ZaloApiAccount;
  active: boolean;
  /** Người dùng đang THỰC SỰ nhìn tài khoản này (tab hiện + được chọn). */
  viewing: boolean;
  flags: ZaloApiFlags | null;
  captureOn: boolean;
  /** Báo số tin chưa đọc của tài khoản này lên parent. */
  onUnread: (instanceId: string, n: number) => void;
}) {
  const accountKey = zaloApiAccountKey(account.instanceId);
  const partition = zaloApiPartition(account.instanceId);

  const ref = useRef<WebviewElement | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [session, setSession] = useState<ZaloSessionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [wsState, setWsState] = useState<ZaloListenerState['state']>('off');

  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consolePos, setConsolePos] = useState<'bottom' | 'right'>('bottom');
  useEffect(() => {
    const v = typeof window !== 'undefined' ? localStorage.getItem('zaloapi:consolePos') : null;
    if (v === 'right' || v === 'bottom') setConsolePos(v);
  }, []);
  const toggleConsolePos = useCallback(() => {
    setConsolePos((p) => {
      const next = p === 'bottom' ? 'right' : 'bottom';
      try { localStorage.setItem('zaloapi:consolePos', next); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const [logs, setLogs] = useState<LogLine[]>([]);
  const log = useCallback((kind: LogKind, text: string) => {
    setLogs((prev) => [{ at: Date.now(), kind, text }, ...prev].slice(0, 200));
  }, []);

  // Số tin chưa đọc của tài khoản này — tăng khi nhận tin, về 0 khi người dùng
  // đang nhìn tài khoản này. Báo lên parent để dồn thành badge trên tab.
  const [unread, setUnread] = useState(0);
  const onUnreadRef = useRef(onUnread);
  onUnreadRef.current = onUnread;
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  useEffect(() => { onUnreadRef.current(account.instanceId, unread); }, [unread, account.instanceId]);
  // Đang nhìn tài khoản này ⇒ coi như đã đọc.
  useEffect(() => { if (viewing) setUnread(0); }, [viewing]);
  // Gỡ tài khoản (unmount) → xoá số của nó khỏi tổng, khỏi để lại count treo.
  useEffect(() => () => onUnreadRef.current(account.instanceId, 0), [account.instanceId]);

  const credsRef = useRef<{ cookie: string; imei: string; userAgent: string } | null>(null);

  const exec = useCallback(async (script: string, gesture = false): Promise<unknown> => {
    const el = ref.current;
    if (!el) throw new Error('webview chưa gắn');
    return el.executeJavaScript(script, gesture);
  }, []);

  // ── webview lifecycle ─────────────────────────────────────────────────────
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onReady = () => setStatus('ready');
    const onFail = (e: Event) => {
      const ev = e as unknown as { isMainFrame: boolean; errorCode: number };
      if (ev.isMainFrame && ev.errorCode !== -3) setStatus('failed');
    };
    el.addEventListener('dom-ready', onReady);
    el.addEventListener('did-fail-load', onFail as EventListener);
    return () => {
      el.removeEventListener('dom-ready', onReady);
      el.removeEventListener('did-fail-load', onFail as EventListener);
    };
  }, []);

  // ── đăng ký guest vào registry DÙNG CHUNG (theo accountKey) ───────────────
  useEffect(
    () =>
      registerGuest({
        accountKey,
        pluginId: 'zaloapi',
        instanceId: account.instanceId,
        label: account.label,
        ready: status === 'ready',
        exec: (script: string, userGesture = false) => {
          const el = ref.current;
          if (!el) return Promise.reject(new Error('guest Zalo API chưa gắn'));
          try {
            return el.executeJavaScript(script, userGesture) as Promise<unknown>;
          } catch (e) {
            return Promise.reject(e as Error);
          }
        },
        pressKey: async () => ({ ok: false, error: 'nhánh API không dùng phím thật', via: 'none' as const }),
      }),
    [accountKey, account.instanceId, account.label, status],
  );

  // ── ĐẾM TIN ĐẾN cho badge/chuông — hook thông báo NGAY TRONG guest ────────
  // Độc lập với listener server-side. Trang Zalo tự bắn Notification khi có tin
  // (toast Electron); ta hook nó, đếm, poll từ host. Badge lên dù listener chưa
  // chạy. Chạy ngay khi webview ready — KHÔNG cần Kết nối trước.
  useEffect(() => {
    if (status !== 'ready') return;
    const el = ref.current;
    if (!el) return;
    let stop = false;
    const inject = () => { el.executeJavaScript(buildNotiHookScript(), false).catch(() => { /* chưa gắn */ }); };
    inject();
    el.addEventListener('dom-ready', inject); // điều hướng thay document → tiêm lại
    const t = setInterval(() => {
      if (stop) return;
      el.executeJavaScript(drainNotiScript(), false)
        .then((r) => {
          const n = Number((r as { n?: number } | null)?.n ?? 0);
          if (!n) return;
          log('recv', `nhận ${n} thông báo mới`);
          if (!viewingRef.current) setUnread((u) => u + n);
        })
        .catch(() => { /* điều hướng/detach — bỏ nhịp */ });
    }, POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
      el.removeEventListener('dom-ready', inject);
    };
  }, [status, log]);

  // Phiên còn sống từ lần chạy trước (server giữ qua reload).
  useEffect(() => {
    void zaloApiStatus(accountKey)
      .then((s) => {
        setSession(s);
        if (s) log('info', `Phiên còn sống · uid ${s.uid}`);
      })
      .catch(() => { /* chưa đăng nhập */ });
  }, [accountKey, log]);

  // ── KẾT NỐI: trích credential → login server-side ─────────────────────────
  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const bridge = window.workspace;
      if (!bridge?.readZaloCookies) {
        log('err', 'Bản app này chưa hỗ trợ đọc cookie phiên — cập nhật app rồi thử lại.');
        return;
      }
      const guest = (await exec(buildExtractScript())) as ExtractResult;
      if (!guest.loggedIn) {
        log('err', 'Chưa đăng nhập Zalo — quét QR ở khung bên dưới trước đã.');
        return;
      }
      const ck = await bridge.readZaloCookies(partition, SESSION_COOKIES);
      if (!ck.ok || !ck.header) {
        log('err', 'Không đọc được cookie phiên: ' + (ck.error ?? 'không rõ'));
        return;
      }
      const imei = guest.session?.imei ?? '';
      if (!imei) {
        log('err', 'Không tìm thấy imei trong phiên — tải lại trang Zalo rồi kết nối lại.');
        return;
      }
      const creds = { cookie: ck.header, imei, userAgent: String((await exec('navigator.userAgent')) ?? '') };
      credsRef.current = creds;
      const info = await zaloApiLogin({ accountKey, ...creds });
      setSession(info);
      log('info', `Đã kết nối · uid ${info.uid}`);
      // NHẢ webview Zalo: Zalo chỉ cho 1 kết nối/tài khoản. Nếu webview vẫn giữ
      // Zalo Web mở thì nó + listener server tranh nhau → Zalo đá qua lại (cmd
      // 3000 "trùng kết nối"), tin không về ổn định. Điều hướng webview sang
      // trang trống để listener server độc chiếm. Bấm "Tải lại" để về Zalo khi
      // cần quét QR / chat tay.
      try {
        ref.current?.loadURL('about:blank');
        setStatus('loading');
        log('info', 'Đã nhả webview Zalo (about:blank) — listener server độc chiếm kết nối. Bấm ⟳ để mở lại Zalo.');
      } catch { /* webview chưa gắn — bỏ qua */ }
    } catch (e) {
      setSession(null);
      log('err', 'Kết nối lỗi: ' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [accountKey, partition, exec, log]);

  const disconnect = useCallback(async () => {
    try {
      await zaloApiLogout(accountKey);
    } catch { /* dọn dẹp — lỗi ở đây không đáng chặn UI */ }
    credsRef.current = null;
    setSession(null);
    setWsState('off');
    log('info', 'Đã ngắt kết nối.');
  }, [accountKey, log]);

  // ── NHẬN TIN: listener server-side + poll nuôi automation + ghi Console ───
  const captureRef = useRef(captureOn);
  captureRef.current = captureOn;

  useEffect(() => {
    if (!session) return;
    void zaloApiListen(accountKey)
      .then((st) => setWsState(st.state))
      .catch(() => { /* poll bên dưới sẽ báo trạng thái */ });
  }, [session, accountKey]);

  useEffect(() => {
    if (!session) return;
    let stop = false;
    let prevState: string | null = null;
    let prevStats = '';
    const pump = async () => {
      if (stop) return;
      try {
        const r = await zaloApiPoll(accountKey);
        setWsState(r.state as ZaloListenerState['state']);
        if (r.state !== prevState) {
          prevState = r.state;
          log('info', `Listener: ${r.state}${r.detail ? ' — ' + r.detail : ''}`);
        }
        // Chẩn đoán: khi số đếm ĐỔI, ghi một dòng để biết tin tắc ở chặng nào.
        // frames đứng yên ⇒ socket không nhận; msgFrames>0 mà extracted=0 ⇒
        // parse sai schema; decodeErr>0 ⇒ giải mã hỏng (cipherKey/GCM).
        const s = r.stats;
        if (s) {
          const sig = `${s.frames}/${s.msgFrames}/${s.decoded}/${s.extracted}/${s.decodeErr}`;
          if (sig !== prevStats) {
            prevStats = sig;
            log('info', `Khung: nhận ${s.frames} · tin ${s.msgFrames} · giải mã ${s.decoded} · rút ${s.extracted} · lỗi giải mã ${s.decodeErr} · cipher ${s.hasCipher ? 'có' : 'chưa'}`);
          }
        }
        if (!r.messages?.length) return;
        for (const m of r.messages) {
          const who = m.fromName || m.fromId || 'ẩn danh';
          log('recv', `${who}${m.group ? ' (nhóm)' : ''}${m.threadId ? ` [${m.threadId}]` : ''}: ${m.text}`);
          if (!captureRef.current) {
            log('info', '↳ capture TẮT → không đưa vào Automation (bật Capture ở tab Automation)');
            continue;
          }
          const ev = zaloIncomingEvent(m, account.instanceId, account.label);
          if (!ev) { log('info', '↳ tin rỗng, bỏ qua'); continue; }
          // Nhật ký ENGINE: event vào rồi TỪNG rule quyết gì (match / skip vì
          // lý do gì). Đây là chỗ thấy thẳng "vì sao rule không match".
          void automation.submit(ev).then((res) => {
            if (!res) { log('info', '↳ engine bỏ (trùng id hoặc echo loopGuard)'); return; }
            log('info', `↳ vào Automation: conversation="${ev.fields.conversation}" sender="${ev.fields.sender}" threadId=${ev.fields.threadId || '—'}`);
            if (!res.decisions.length) { log('info', '↳ chưa có quy tắc social nào'); return; }
            for (const d of res.decisions) {
              if (d.matched) log('info', `↳ ✓ khớp: "${d.ruleName}"`);
              else log('info', `↳ ✗ "${d.ruleName}" — ${skipReason(d.skipped)}`);
            }
          }).catch(() => { /* submit không bao giờ ném, nhưng phòng xa */ });
        }
        // Đếm chưa đọc: cộng khi KHÔNG đang nhìn tài khoản này (đang xem coi như
        // đã đọc). Bỏ tin của chính mình (fromId == uid).
        if (!viewingRef.current) {
          const incoming = r.messages.filter((m) => !session || m.fromId !== session.uid);
          if (incoming.length) setUnread((n) => n + incoming.length);
        }
      } catch (e) {
        // KHÔNG nuốt im: một lỗi poll lặp lại là dấu hiệu route/listener hỏng.
        log('err', 'poll lỗi: ' + (e as Error).message);
      }
    };
    const t = setInterval(pump, POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [session, accountKey, account.instanceId, account.label, log]);

  const disabled = flags ? !flags.enabled : false;
  const dotTone = session ? (wsState === 'ready' ? 'ok' : wsState === 'error' ? 'bad' : 'warn') : 'off';
  const stateText = !session
    ? 'chưa kết nối'
    : wsState === 'ready'
      ? `đang nhận tin · uid ${session.uid}`
      : wsState === 'error'
        ? 'lỗi kết nối tin'
        : `kết nối tin: ${wsState}`;

  return (
    // Không chọn thì đẩy offscreen (giữ webview sống + listener chạy nền), thay
    // vì display:none (zero-size webview → hỏng). Cùng thủ thuật WorkspaceView.
    <div
      className="za-view"
      style={active ? undefined : { position: 'absolute', left: '-200vw', top: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    >
      <div className="za-bar">
        <span className={`za-dot za-dot--${dotTone}`} />
        <span className="za-bar-state">{stateText}</span>

        {captureOn ? (
          <span className="za-badge za-badge--ok">tin đến → Automation</span>
        ) : (
          <span className="za-badge" title="Bật capture ở tab Automation để tin Zalo API thành điều kiện cho rule">
            chỉ nhận, chưa vào Automation
          </span>
        )}
        {flags?.enabled && !flags.allowSend && (
          <span className="za-badge za-badge--warn" title="Thêm ZALOAPI_ALLOW_SEND=true để rule gửi được tin">
            gửi đang tắt
          </span>
        )}

        <span className="za-bar-spacer" />

        {disabled ? (
          <span className="za-bar-off">
            nhánh tắt — đặt <code>ZALOAPI_TOOL_ENABLED=true</code> trong <code>.env.local</code>
          </span>
        ) : session ? (
          <button className="za-btn" disabled={busy} onClick={() => void disconnect()}>Ngắt kết nối</button>
        ) : (
          <button className="za-btn za-btn--go" disabled={busy} onClick={() => void connect()}>
            {busy ? 'Đang kết nối…' : 'Kết nối'}
          </button>
        )}

        <button
          className={`za-btn${consoleOpen ? ' is-on' : ''}`}
          onClick={() => setConsoleOpen((v) => !v)}
          title="Nhật ký tin nhận / gửi / kết nối"
        >
          Console{logs.length ? ` (${logs.length})` : ''}
        </button>
        <button
          onClick={() => { try { ref.current?.loadURL(ZALO_URL); setStatus('loading'); } catch { /* chưa gắn */ } }}
          className="za-btn"
          title="Mở lại trang Zalo (để quét QR / chat tay). Lưu ý: mở Zalo sẽ tranh kết nối với listener."
        >⟳ Mở Zalo</button>
      </div>

      <div className="za-stage">
        <webview
          ref={ref as unknown as React.Ref<HTMLElement>}
          className="za-webview"
          src={ZALO_URL}
          partition={partition}
          {...({ allowpopups: 'true' } as Record<string, string>)}
        />
        {status === 'loading' && (
          <div className="za-overlay"><div className="ws-spinner" /><p>Đang tải Zalo…</p></div>
        )}
        {status === 'failed' && (
          <div className="za-overlay"><p>Không tải được.</p><button onClick={() => ref.current?.reload()}>Thử lại</button></div>
        )}

        {consoleOpen && (
          <div className={`za-console za-console--${consolePos}`}>
            <div className="za-console-head">
              <span>Nhật ký · {account.label}</span>
              <div className="za-console-btns">
                <button onClick={toggleConsolePos} title={consolePos === 'bottom' ? 'Chuyển sang bên phải' : 'Chuyển xuống dưới'}>
                  {consolePos === 'bottom' ? '⇥ Phải' : '⤓ Dưới'}
                </button>
                <button onClick={() => setLogs([])} title="Xoá nhật ký">Xoá</button>
                <button onClick={() => setConsoleOpen(false)} title="Đóng">✕</button>
              </div>
            </div>
            <div className="za-console-body">
              {logs.length === 0 ? (
                <p className="za-console-empty">Chưa có gì. Log tin nhận, gửi và trạng thái kết nối sẽ hiện ở đây.</p>
              ) : (
                logs.map((l, i) => (
                  <div key={`${l.at}-${i}`} className={`za-log za-log--${l.kind}`}>
                    <span className="za-log-time">{new Date(l.at).toLocaleTimeString('vi')}</span>
                    <span className="za-log-tag">{l.kind === 'recv' ? '↓' : l.kind === 'send' ? '↑' : l.kind === 'err' ? '✗' : '•'}</span>
                    <span className="za-log-text">{l.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  Parent — rail nhiều tài khoản + tài khoản đang chọn.
// ════════════════════════════════════════════════════════════════════════════
export default function ZaloApiWorkspace({
  onUnread,
  visible = true,
}: {
  /** Báo tổng số tin chưa đọc lên shell (badge + chuông trên tab). */
  onUnread?: (total: number) => void;
  /** Tab Zalo API có đang là tab hiện trên màn hình không. */
  visible?: boolean;
} = {}) {
  const desktop = isDesktop();
  const [flags, setFlags] = useState<ZaloApiFlags | null>(null);
  useEffect(() => {
    void fetchZaloApiFlags().then(setFlags).catch(() => setFlags(null));
  }, []);

  const { config: autoCfg } = useAutomation();
  const captureOn = autoCfg.enabled && autoCfg.captureEnabled;

  const [accounts, setAccounts] = useState<ZaloApiAccount[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [editingId, setEditingId] = useState<string | null>(null);

  // Chưa đọc theo từng tài khoản → badge trên rail + dồn tổng lên tab.
  const [unread, setUnread] = useState<Record<string, number>>({});
  const setAccountUnread = useCallback((instanceId: string, n: number) => {
    setUnread((prev) => (prev[instanceId] === n ? prev : { ...prev, [instanceId]: n }));
  }, []);
  const total = Object.values(unread).reduce((s, n) => s + n, 0);
  const onUnreadRef = useRef(onUnread);
  onUnreadRef.current = onUnread;
  useEffect(() => { onUnreadRef.current?.(total); }, [total]);

  // Chuông khi tổng chưa đọc TĂNG (tin mới), không kêu khi giảm/tính lại. Dùng
  // lại đúng tiếng chuông của Workspace cho nhất quán.
  const chime = useChime();
  const prevTotal = useRef(0);
  useEffect(() => {
    if (total > prevTotal.current) chime();
    prevTotal.current = total;
  }, [total, chime]);
  useEffect(() => {
    const list = loadZaloApiAccounts();
    setAccounts(list);
    setActiveId((cur) => cur || list[0]?.instanceId || '');
  }, []);

  const persist = useCallback((list: ZaloApiAccount[]) => {
    setAccounts(list);
    saveZaloApiAccounts(list);
  }, []);

  const addAccount = useCallback(() => {
    const acc = newZaloApiAccount(accounts);
    persist([...accounts, acc]);
    setActiveId(acc.instanceId);
  }, [accounts, persist]);

  const renameAccount = useCallback((id: string, label: string) => {
    persist(accounts.map((a) => (a.instanceId === id ? { ...a, label } : a)));
  }, [accounts, persist]);

  const removeAccount = useCallback(async (id: string) => {
    const acc = accounts.find((a) => a.instanceId === id);
    if (!acc) return;
    if (!window.confirm(`Xoá "${acc.label}" và đăng xuất phiên này?`)) return;
    // Xoá phiên server + xoá session webview trên máy.
    try { await zaloApiLogout(zaloApiAccountKey(id)); } catch { /* ignore */ }
    try { await window.workspace?.clearSession?.(zaloApiPartition(id)); } catch { /* ignore */ }
    const next = accounts.filter((a) => a.instanceId !== id);
    persist(next);
    setActiveId((cur) => (cur === id ? next[0]?.instanceId ?? '' : cur));
  }, [accounts, persist]);

  if (!desktop) {
    return (
      <div className="panel">
        <div className="empty-ico">🟦</div>
        <h3>Zalo API cần app desktop</h3>
        <p>Đăng nhập bằng QR trong một phiên trình duyệt thật — chỉ chạy được khi mở DevBox dưới dạng ứng dụng.</p>
      </div>
    );
  }

  return (
    <div className="za-multiwrap">
      {/* Băng-rôn KHÔNG THỂ BỎ QUA khi nhánh chưa bật — nguyên nhân "kết nối rồi
          chẳng có gì": route /api/zaloapi trả 403 trước mọi thao tác, listener
          không bao giờ chạy. Thông báo/badge vẫn có vì đó là hook trong guest. */}
      {flags && !flags.enabled && (
        <div className="za-offbanner">
          ⚠ Nhánh Zalo API đang <b>TẮT</b> — nên nhận tin / gửi / automation đều KHÔNG chạy (chỉ có thông báo hệ thống).
          Thêm <code>ZALOAPI_TOOL_ENABLED=true</code> (và <code>ZALOAPI_ALLOW_SEND=true</code> nếu muốn gửi) vào
          <code> .env.local</code> rồi <b>đóng hẳn app và mở lại</b>.
        </div>
      )}
    <div className="za-multishell">
      {/* Rail tài khoản */}
      <aside className="za-rail">
        <div className="za-rail-head">
          <span>Tài khoản Zalo API</span>
        </div>
        <div className="za-rail-list">
          {accounts.map((a) => (
            editingId === a.instanceId ? (
              <input
                key={a.instanceId}
                className="za-rail-input"
                autoFocus
                defaultValue={a.label}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const v = (e.target as HTMLInputElement).value.trim();
                    if (v) renameAccount(a.instanceId, v);
                    setEditingId(null);
                  } else if (e.key === 'Escape') setEditingId(null);
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v) renameAccount(a.instanceId, v);
                  setEditingId(null);
                }}
              />
            ) : (
              <div
                key={a.instanceId}
                className={`za-rail-item${a.instanceId === activeId ? ' is-active' : ''}`}
                onClick={() => setActiveId(a.instanceId)}
                title={a.label}
              >
                <span className="za-rail-name">{a.label}</span>
                {(unread[a.instanceId] ?? 0) > 0 && (
                  <span className="za-rail-unread">{unread[a.instanceId] > 99 ? '99+' : unread[a.instanceId]}</span>
                )}
                <button className="za-rail-btn" title="Đổi tên" onClick={(e) => { e.stopPropagation(); setEditingId(a.instanceId); }}>✎</button>
                {accounts.length > 1 && (
                  <button className="za-rail-btn danger" title="Xoá" onClick={(e) => { e.stopPropagation(); void removeAccount(a.instanceId); }}>×</button>
                )}
              </div>
            )
          ))}
          <button className="za-rail-add" onClick={addAccount}>＋ Thêm tài khoản</button>
        </div>
      </aside>

      {/* Khung tài khoản — tất cả mount, ẩn offscreen cái không chọn. */}
      <div className="za-multistage">
        {accounts.length === 0 ? (
          <div className="panel"><div className="empty-ico">🟦</div><h3>Chưa có tài khoản</h3><p>Bấm “Thêm tài khoản” để bắt đầu.</p></div>
        ) : (
          accounts.map((a) => (
            <ZaloApiAccountView
              key={a.instanceId}
              account={a}
              active={a.instanceId === activeId}
              viewing={visible && a.instanceId === activeId}
              flags={flags}
              captureOn={captureOn}
              onUnread={setAccountUnread}
            />
          ))
        )}
      </div>
    </div>
    </div>
  );
}
