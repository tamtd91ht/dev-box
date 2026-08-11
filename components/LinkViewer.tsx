'use client';

// In-app viewer for the Links tab — mở một link bất kỳ (Jenkins, Rancher,
// Google Docs, …) trong Electron <webview> thay vì nhảy ra browser ngoài.
// Desktop-shell only; caller fallback window.open khi không có window.workspace.
//
// Session: partition truyền từ ngoài theo PROFILE của link (lib/links.ts →
// partitionFor). Login user/pass một lần trong khung là cookie lưu bền cho cả
// nhóm link cùng profile; "Logout" (⎋) chỉ xóa phiên của profile đó.
//
// Tổng quát hóa từ GoogleDocViewer (tab Google giữ viewer riêng cho Drive) —
// khác biệt: partition động + không có hint đăng nhập Google.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebviewElement } from '@/lib/workspace/types';
import { pwMatch, pwSave, pwTouch, canEncrypt, type CredentialOpen } from '@/lib/passwords';
import { normalizeUrl } from '@/lib/bookmarks';

// Nhiều trang (Google sign-in, một số SSO) chặn "embedded browser" bằng cách
// sniff UA có token Electron/app-name — trình mình đúng là Chrome bên dưới.
const CHROME_UA =
  typeof navigator === 'undefined'
    ? undefined
    : navigator.userAgent.replace(/ vhs-dev-box\/[\d.]+/i, '').replace(/ Electron\/[\d.]+/i, '');

type Status = 'loading' | 'ready' | 'failed';

interface Props {
  /** Display name for the toolbar. */
  name: string;
  url: string;
  /** Session partition — persist:links-<profile> (see partitionFor). */
  partition: string;
  onClose: () => void;
  /** Lưu URL đang xem vào registry. Ẩn nút khi absent. */
  onSaveLink?: (name: string, url: string) => Promise<void>;
  /** Tab nền trong chế độ nhiều tab: đẩy offscreen (webview vẽ ở native layer
   *  nên visibility:hidden không ăn), tắt Esc — chỉ tab nổi nhận Esc. */
  hidden?: boolean;
  /** Tài khoản site đã lưu theo link — nút 🔑 tự điền vào form login. */
  creds?: { username?: string; password?: string };
  /** Bật trình quản lý mật khẩu kiểu Chrome cho khung này: tự điền mật khẩu đã
   *  lưu theo ORIGIN khi trang load, và hỏi "Lưu mật khẩu?" khi submit form
   *  login. Tab Browser bật; tab Links giữ nguyên hành vi cũ (creds theo link). */
  passwordManager?: boolean;
  /** Profile session của tab — phân biệt 2 tài khoản trên cùng một origin. */
  profile?: string;
  /** Hiện Ô ĐỊA CHỈ thật (URL hiện tại, gõ được để đi) thay cho dòng tiêu đề
   *  chỉ-đọc. Tab Browser bật; tab Links/Google giữ tiêu đề gọn như cũ. */
  addressBar?: boolean;
  /** Link trong trang bấm "mở tab mới" (target=_blank / chuột giữa) → mở thành
   *  TAB MỚI trong app thay vì đẩy ra trình duyệt ngoài. */
  onOpenNewTab?: (url: string) => void;
}

/** Thanh "Lưu mật khẩu?" — user/pass vừa bắt được ở form submit. */
interface SaveOffer { url: string; username: string; password: string; update: boolean }

const hostOf = (u: string): string => { try { return new URL(u).host; } catch { return u; } };

/** Tiền tố console mà guest dùng để báo "mở URL này ở tab mới" về host. */
const NEWTAB_PREFIX = '[dbx-newtab] ';

export default function LinkViewer({
  name, url, partition, onClose, onSaveLink, hidden, creds, passwordManager, profile,
  addressBar, onOpenNewTab,
}: Props) {
  const ref = useRef<WebviewElement | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [failInfo, setFailInfo] = useState('');
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  /** URL guest ĐANG mở — bám theo mọi điều hướng/redirect (SSO nhảy vài chặng
   *  rồi mới về trang thật), giống thanh địa chỉ trình duyệt. */
  const [liveUrl, setLiveUrl] = useState(url);
  /** Chữ trong ô địa chỉ khi người dùng đang gõ; null = đang bám theo liveUrl. */
  const [draft, setDraft] = useState<string | null>(null);
  const [offer, setOffer] = useState<SaveOffer | null>(null); // thanh "Lưu mật khẩu?"
  const [savedNote, setSavedNote] = useState<string | null>(null);
  /** Số mật khẩu đã lưu khớp trang đang xem — badge trên nút 🔑. */
  const [matchCount, setMatchCount] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const syncNav = () => {
      try {
        setCanBack(el.canGoBack());
        setCanForward(el.canGoForward());
        // Ô địa chỉ bám URL THẬT của guest (sau redirect SSO / đổi trang trong
        // SPA). Đang gõ dở thì thôi — không giật chữ khỏi tay người dùng.
        const cur = el.getURL();
        if (cur) setLiveUrl(cur);
      } catch {
        /* not attached yet */
      }
    };
    const onStart = () => { setStatus('loading'); syncNav(); };
    const onStop = () => {
      setStatus((s) => (s === 'failed' ? s : 'ready'));
      syncNav();
    };
    const onFail = (e: Event) => {
      const ev = e as unknown as { errorCode: number; errorDescription: string; isMainFrame: boolean };
      if (!ev.isMainFrame || ev.errorCode === -3 /* ABORTED */) return;
      setFailInfo(`${ev.errorDescription || 'Network error'} (${ev.errorCode})`);
      setStatus('failed');
    };

    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('did-navigate', syncNav);
    el.addEventListener('did-navigate-in-page', syncNav);
    el.addEventListener('did-fail-load', onFail as EventListener);
    return () => {
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('did-navigate', syncNav);
      el.removeEventListener('did-navigate-in-page', syncNav);
      el.removeEventListener('did-fail-load', onFail as EventListener);
    };
  }, []);

  // Electron bug: hủy <webview> đang giữ focus xong host vẫn tưởng guest giữ
  // focus → mọi input "chết". Khi viewer unmount, kéo focus về host.
  useEffect(() => () => {
    void window.workspace?.focusHost?.().catch(() => {});
  }, []);

  // Esc đóng viewer (phím trong guest không bubble ra host). Tab nền bỏ qua.
  useEffect(() => {
    if (hidden) return;
    // Esc khi con trỏ đang ở ô địa chỉ = bỏ chữ đang gõ (input tự xử lý), KHÔNG
    // đóng luôn cả tab — gõ nhầm rồi Esc mà mất tab thì rất khó chịu.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, hidden]);

  const retry = useCallback(() => {
    setStatus('loading');
    setFailInfo('');
    try {
      void ref.current?.loadURL(url);
    } catch {
      ref.current?.reload();
    }
  }, [url]);

  const openExternal = useCallback(() => {
    let cur = url;
    try {
      cur = ref.current?.getURL() || url;
    } catch {
      /* ignore */
    }
    window.open(cur, '_blank');
  }, [url]);

  /** Enter trong ô địa chỉ — như trình duyệt: là URL thì đi tới, không phải thì
   *  tìm Google (dùng chung normalizeUrl với ô địa chỉ của tab Browser). */
  const navigate = useCallback((raw: string) => {
    const target = normalizeUrl(raw);
    if (!target) return;
    setDraft(null);
    setStatus('loading');
    setFailInfo('');
    try { void ref.current?.loadURL(target); } catch { /* guest chưa attach */ }
  }, []);

  /** Chép URL đang xem — thao tác quen tay khi đã có thanh địa chỉ. */
  const [copied, setCopied] = useState(false);
  const copyUrl = useCallback(() => {
    void navigator.clipboard?.writeText(liveUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [liveUrl]);

  const logout = useCallback(async () => {
    if (!window.workspace) return;
    const prof = partition.replace(/^persist:links-/, '');
    if (!window.confirm(`Đăng xuất phiên "${prof}" trên máy này? (xóa cookie/storage của các link dùng profile này)`)) return;
    const res = await window.workspace.clearSession(partition);
    if (res.ok) {
      setStatus('loading');
      try {
        ref.current?.reloadIgnoringCache();
      } catch {
        /* ignore */
      }
    }
  }, [partition]);

  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'done'>('idle');
  const saveLink = useCallback(async () => {
    if (!onSaveLink) return;
    let cur = url;
    let title = name;
    try {
      cur = ref.current?.getURL() || url;
      title = ref.current?.getTitle?.() || name;
    } catch {
      /* not attached yet — save the original url */
    }
    setSaveState('saving');
    try {
      await onSaveLink(title, cur);
      setSaveState('done');
      setTimeout(() => setSaveState('idle'), 2500);
    } catch (e) {
      setSaveState('idle');
      window.alert((e as Error).message);
    }
  }, [onSaveLink, url, name]);

  // ── Trình quản lý mật khẩu kiểu Chrome ──────────────────────────────────
  // Guest bị sandbox và preload bị xóa (wireWebviewHardening trong main.cjs)
  // nên không cắm được script thường trú; ta executeJavaScript từ host:
  //   · did-stop-loading → tìm form login, điền mật khẩu đã lưu theo origin
  //   · cùng lúc gắn listener submit/click/Enter, ghi user/pass vừa gõ vào
  //     window.__dbxPwd; host đọc ra rồi hỏi "Lưu mật khẩu?"
  // KHÔNG tự submit — chỉ điền, đúng mặc định của Chrome.
  //
  // ĐIỂM CHẾT NGƯỜI: window.__dbxPwd nằm trong window của GUEST, mà điều hướng
  // toàn trang (submit form cổ điển: gõ ở trang A → POST → sang trang B) XÓA
  // SẠCH window đó. Nếu chỉ đọc ở did-stop-loading của trang B thì không bao giờ
  // thấy gì — chỉ login kiểu SPA (không điều hướng) mới bắt được.
  // Vì vậy đọc ở CẢ HAI mốc:
  //   · did-start-loading — ngay khi bắt đầu điều hướng, window CŨ còn sống
  //   · did-stop-loading  — cho SPA/login không điều hướng
  // và giữ giá trị bắt được trong ref của host (pendingRef) để sống sót qua
  // điều hướng, chỉ đem ra hỏi sau khi trang mới tải xong.

  /** Đoạn JS tìm ô user/pass — dùng lại cho cả điền và bắt submit. */
  const FIELD_JS = `
    const vis = (el) => el && el.offsetParent !== null && !el.disabled && !el.readOnly;
    const pwEl = () => [...document.querySelectorAll('input[type=password]')].find(vis);
    const userEl = (pw) => {
      const texts = [...document.querySelectorAll('input')].filter((i) =>
        ['text','email','tel','','username'].includes((i.type||'').toLowerCase()) && vis(i));
      const named = texts.find((i) => /user|email|login|account|phone|tel|name/i.test(
        (i.name||'')+(i.id||'')+(i.placeholder||'')+(i.autocomplete||'')));
      if (named) return named;
      // Không có tên gợi ý → ô text NGAY TRƯỚC ô password trong DOM.
      if (pw) { const all = [...document.querySelectorAll('input')]; const i = all.indexOf(pw);
        for (let k = i - 1; k >= 0; k--) if (texts.includes(all[k])) return all[k]; }
      return texts[0];
    };`;

  /** Điền user/pass vào form login trong guest.
   *  force=true (bấm 🔑) ghi đè cả khi ô mật khẩu đang có chữ.
   *  Trả 'ok' | 'kept' (đang có chữ, không đụng) | 'no-form'. */
  const injectFill = useCallback(async (username: string, password: string, force = false) => {
    const code = `(() => {
      ${FIELD_JS}
      const setVal = (el, v) => {
        if (!el || v == null) return;
        const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        d.set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const pw = pwEl();
      if (!pw) return 'no-form';
      // Người dùng đã tự gõ mật khẩu → KHÔNG ghi đè (autofill tự động không
      // được đạp lên thứ đang gõ; bấm 🔑 thì force=true nên vẫn điền).
      if (pw.value && !${JSON.stringify(Boolean(force))}) return 'kept';
      setVal(userEl(pw), ${JSON.stringify(username)});
      setVal(pw, ${JSON.stringify(password)});
      return 'ok';
    })()`;
    try { return (await ref.current?.executeJavaScript(code, true)) as string; }
    catch { return 'no-form'; }
  }, [FIELD_JS]);

  /** Gắn bẫy submit trong guest: lưu user/pass vừa gõ vào window.__dbxPwd để
   *  host đọc ra. Idempotent — gọi lại sau mỗi lần điều hướng là vô hại. */
  const armCapture = useCallback(async () => {
    const code = `(() => {
      if (window.__dbxPwdArmed) return 'already';
      window.__dbxPwdArmed = true;
      ${FIELD_JS}
      // Giá trị gõ gần nhất, ghi lại NGAY khi người dùng gõ. Đây là bản sao
      // sống sót: lúc submit thì SPA (Rancher, Argo…) đã kịp xóa/unmount form,
      // đọc pw.value tại thời điểm đó rất hay ra chuỗi rỗng.
      const last = { username: '', password: '', url: '' };
      const remember = () => {
        const pw = pwEl();
        if (!pw || !pw.value) return;
        const u = userEl(pw);
        last.username = (u && u.value) || last.username;
        last.password = pw.value;
        last.url = location.href;
      };
      // 'input' bắn SAU khi React commit value → đây là nguồn đáng tin nhất.
      document.addEventListener('input', (e) => {
        if (e.target instanceof HTMLInputElement) remember();
      }, true);

      const publish = () => {
        if (!last.password) return;
        window.__dbxPwd = { ...last, url: last.url || location.href, at: Date.now() };
      };
      // Vét một nhịp NỮA sau khi handler của trang chạy xong: người dùng có thể
      // dán mật khẩu rồi bấm ngay, lúc pointerdown 'input' chưa kịp bắn.
      const grab = () => { remember(); publish(); setTimeout(() => { remember(); publish(); }, 0); };

      // capture:true để chạy TRƯỚC handler của trang (SPA thường preventDefault
      // rồi xóa form ngay), và pointerdown để bắt cả nút không nằm trong <form>.
      document.addEventListener('submit', grab, true);
      document.addEventListener('pointerdown', (e) => {
        const t = e.target instanceof Element ? e.target.closest('button,input[type=submit],a') : null;
        if (t) grab();
      }, true);
      document.addEventListener('keydown', (e) => { if (e.key === 'Enter') grab(); }, true);
      return 'armed';
    })()`;
    try { await ref.current?.executeJavaScript(code, true); } catch { /* guest chưa sẵn */ }
  }, [FIELD_JS]);

  /** Đọc user/pass guest vừa bắt được; xóa khỏi guest sau khi lấy. */
  const readCaptured = useCallback(async (): Promise<{ username: string; password: string; url: string } | null> => {
    const code = `(() => { const v = window.__dbxPwd; window.__dbxPwd = null; return v ? JSON.stringify(v) : null; })()`;
    try {
      const raw = (await ref.current?.executeJavaScript(code, true)) as string | null;
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }, []);

  /** URL thật của guest (sau redirect SSO) — origin để tra mật khẩu. */
  const currentUrl = useCallback(() => {
    try { return ref.current?.getURL() || url; } catch { return url; }
  }, [url]);

  /** MỘT nguồn credential duy nhất cho cả autofill lẫn nút 🔑.
   *
   *  Trước đây có HAI kho không biết nhau: vault passwords.json (tra qua
   *  pwMatch) và user/pass gắn thẳng vào link trong links.json (prop `creds`).
   *  fillSaved() ưu tiên vault, còn nút lại hiện theo matchCount của vault —
   *  nên link đã có sẵn creds (vd OMICX-ConfigMaps) vẫn không đường nào điền
   *  được. Giờ gộp: vault trước (đã mã hóa, khớp theo origin thật sau redirect
   *  SSO), creds của link là fallback cuối.
   *
   *  KHÔNG chép creds của link vào vault: links.json lưu plaintext còn vault
   *  niêm phong bằng safeStorage — âm thầm bơm plaintext sang sẽ làm nhãn
   *  `cipher` nói dối. Muốn nâng cấp thì bấm "Lưu" ở thanh hỏi mật khẩu. */
  const resolveCreds = useCallback(async (): Promise<CredentialOpen[]> => {
    const hits = passwordManager
      ? await pwMatch(currentUrl(), profile).catch(() => [])
      : [];
    const linkCred = creds?.password || creds?.username
      ? [{ id: '', username: creds.username ?? '', password: creds.password ?? '', profile }]
      : [];
    // Vault đã có tài khoản CÙNG username → bỏ bản của link (vault mới hơn).
    const dup = new Set(hits.map((h) => h.username));
    return [...hits, ...linkCred.filter((c) => !dup.has(c.username))];
  }, [passwordManager, profile, currentUrl, creds]);

  /** user/pass bắt được, chờ trang mới tải xong mới đem ra hỏi. Ref (không phải
   *  state) để sống sót qua điều hướng mà không kéo theo re-render. */
  const pendingRef = useRef<{ username: string; password: string; url: string } | null>(null);

  useEffect(() => {
    if (!passwordManager) return;
    const el = ref.current;
    if (!el) return;
    let alive = true;

    /** Hỏi lưu nếu cặp user/pass này chưa có trong store. */
    const considerSave = async (got: { username: string; password: string; url: string }) => {
      const known = await pwMatch(got.url, profile).catch(() => []);
      if (!alive) return;
      const same = known.find((k) => k.username === got.username);
      // Đã lưu ĐÚNG cặp user+pass này → không hỏi lại (như Chrome).
      if (same && same.password === got.password) return;
      setOffer({ url: got.url, username: got.username, password: got.password, update: Boolean(same) });
    };

    // Điều hướng BẮT ĐẦU: window cũ còn sống, vét nốt thứ vừa gõ trước khi mất.
    // Giữ vào pendingRef để nếu trang mới tải thật thì hỏi sau khi tải xong.
    const onStart = () => {
      void (async () => {
        const got = await readCaptured();
        if (got?.password) pendingRef.current = got;
      })();
    };

    /** Một vòng đầy đủ: cắm lại bẫy → xét lưu thứ vừa bắt → tra & tự điền.
     *  Dùng chung cho did-stop-loading VÀ did-navigate-in-page: trang SPA
     *  (Rancher) điều hướng in-page mà không bắn did-stop-loading, nên nếu chỉ
     *  chạy ở did-stop-loading thì matchCount kẹt ở 0 → nút 🔑 biến mất và
     *  autofill không bao giờ xảy ra trên đúng những trang cần nó nhất. */
    const cycle = () => {
      void (async () => {
        // Điều hướng in-page giữ nguyên window nên bẫy cũ vẫn sống; armCapture
        // idempotent (window.__dbxPwdArmed) nên gọi lại là vô hại.
        await armCapture();

        // 1) Thứ bắt được ở trang trước (hoặc ngay trang này nếu login SPA).
        const carried = pendingRef.current;
        pendingRef.current = null;
        const fresh = await readCaptured();
        if (!alive) return;
        const got = fresh?.password ? fresh : carried;
        if (got?.password) await considerSave(got);
        if (!alive) return;

        // 2) Trang hiện tại có mật khẩu đã lưu (vault HOẶC creds của link)
        //    → tự điền (KHÔNG submit).
        const hits = await resolveCreds();
        if (!alive) return;
        setMatchCount(hits.length);
        const best: CredentialOpen | undefined = hits[0];
        if (!best) return;

        // Form login của SPA thường mount SAU sự kiện điều hướng (Rancher render
        // xong mới có <input type=password>), nên lần điền đầu hay trả 'no-form'.
        // Thử lại vài nhịp thưa dần rồi thôi — 'kept' cũng dừng: người dùng đang
        // gõ dở, không đạp lên.
        for (const wait of [0, 300, 800, 1500]) {
          if (wait) await new Promise((r) => setTimeout(r, wait));
          if (!alive) return;
          const r = await injectFill(best.username, best.password);
          if (r === 'ok') { if (best.id) void pwTouch(best.id); return; }
          if (r === 'kept') return;
        }
      })();
    };

    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', cycle);
    // Login SPA đổi URL mà không tải lại trang → cũng phải xét lưu + tra lại.
    el.addEventListener('did-navigate-in-page', cycle);
    return () => {
      alive = false;
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', cycle);
      el.removeEventListener('did-navigate-in-page', cycle);
    };
  }, [passwordManager, profile, armCapture, readCaptured, injectFill, resolveCreds]);

  /** Bấm 🔑: điền mật khẩu đã lưu theo origin (ưu tiên), fallback creds của link. */
  const fillSaved = useCallback(async () => {
    const all = await resolveCreds();
    // Bấm tay = cơ hội cập nhật badge, kể cả khi chưa sự kiện nào chạy.
    setMatchCount(all.length);
    if (all.length === 0) {
      window.alert('Chưa có mật khẩu nào lưu cho trang này.\n\nĐăng nhập một lần rồi bấm "Lưu" ở thanh hỏi mật khẩu, hoặc gán user/pass cho link trong danh sách.');
      return;
    }
    const best = all[0];
    const r = await injectFill(best.username, best.password, true);
    if (r === 'no-form') window.alert('Không thấy ô password trên trang này — mở đúng trang login rồi bấm 🔑 lại.');
    else if (best.id) void pwTouch(best.id); // id rỗng = creds của link, không có gì để touch
  }, [resolveCreds, injectFill]);

  /** Chấp nhận thanh "Lưu mật khẩu?" */
  const acceptOffer = useCallback(async () => {
    if (!offer) return;
    try {
      await pwSave(offer.url, offer.username, offer.password, { profile });
      setOffer(null);
      setSavedNote(offer.update ? 'Đã cập nhật mật khẩu' : 'Đã lưu mật khẩu');
      setMatchCount((n) => (offer.update ? n : n + 1));
      setTimeout(() => setSavedNote(null), 3000);
    } catch (e) {
      window.alert('Không lưu được: ' + (e as Error).message);
    }
  }, [offer, profile]);

  // Ctrl+click / chuột giữa trên <a> trong trang = "mở trong tab mới" theo thói
  // quen trình duyệt. Chrome xử lý hai cử chỉ này ở tầng NGOÀI window.open nên
  // setWindowOpenHandler bên main không thấy gì — phải chặn ngay trong guest.
  // Nghe ở capture để chạy trước handler của trang, và preventDefault để guest
  // không tự điều hướng; URL đẩy về host qua console.log có tiền tố riêng
  // (guest bị sandbox, preload bị xóa nên không có kênh IPC nào khác).
  const armNewTab = useCallback(async () => {
    if (!onOpenNewTab) return;
    const code = `(() => {
      if (window.__dbxNewTabArmed) return;
      window.__dbxNewTabArmed = true;
      const href = (e) => {
        const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
        if (!a) return null;
        const u = a.href || '';
        return /^https?:/i.test(u) ? u : null;
      };
      document.addEventListener('click', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
        const u = href(e);
        if (!u) return;
        e.preventDefault(); e.stopPropagation();
        console.log(${JSON.stringify(NEWTAB_PREFIX)} + u);
      }, true);
      document.addEventListener('auxclick', (e) => {
        if (e.button !== 1) return;
        const u = href(e);
        if (!u) return;
        e.preventDefault(); e.stopPropagation();
        console.log(${JSON.stringify(NEWTAB_PREFIX)} + u);
      }, true);
    })()`;
    try { await ref.current?.executeJavaScript(code, true); } catch { /* guest chưa sẵn */ }
  }, [onOpenNewTab]);

  useEffect(() => {
    if (!onOpenNewTab) return;
    const el = ref.current;
    if (!el) return;
    // Electron 43 phát console-message dạng có cấu trúc (event.message); bản cũ
    // để chuỗi ở event.args/arg thứ hai — nhận cả hai cho chắc (xem chú thích
    // cùng vấn đề ở guest.on('console-message') trong electron/main.cjs).
    const onConsole = (e: Event) => {
      const ev = e as unknown as { message?: string; args?: unknown[] };
      const msg = [ev.message, ...(ev.args ?? [])].find(
        (v): v is string => typeof v === 'string' && v.startsWith(NEWTAB_PREFIX),
      );
      if (msg) onOpenNewTab(msg.slice(NEWTAB_PREFIX.length));
    };
    const arm = () => { void armNewTab(); };
    el.addEventListener('console-message', onConsole as EventListener);
    el.addEventListener('did-stop-loading', arm);
    el.addEventListener('did-navigate-in-page', arm);
    arm();
    return () => {
      el.removeEventListener('console-message', onConsole as EventListener);
      el.removeEventListener('did-stop-loading', arm);
      el.removeEventListener('did-navigate-in-page', arm);
    };
  }, [onOpenNewTab, armNewTab]);

  const webviewAttrs: Record<string, string> = { allowpopups: 'true' };
  if (CHROME_UA) webviewAttrs.useragent = CHROME_UA;

  return (
    <div
      className="g-viewer"
      style={hidden ? { left: '-200vw', right: 'auto', width: '100%', pointerEvents: 'none' } : undefined}
    >
      <div className="ws-view" style={{ display: 'flex' }}>
        <div className="ws-toolbar">
          <div className="ws-nav">
            <button onClick={() => ref.current?.goBack()} disabled={!canBack} title="Quay lại">←</button>
            <button onClick={() => ref.current?.goForward()} disabled={!canForward} title="Tiến tới">→</button>
            <button onClick={() => ref.current?.reload()} title="Tải lại">⟳</button>
          </div>
          {addressBar ? (
            /* Ô địa chỉ thật: hiện URL guest đang mở, gõ + Enter để đi tới,
               Esc trả về URL hiện tại. Click chọn hết chữ như trình duyệt. */
            <div className="ws-omni">
              <span className={`ws-dot ws-dot--${status === 'failed' ? 'loading' : status}`} />
              <input
                className="ws-omni-input"
                value={draft ?? liveUrl}
                spellCheck={false}
                placeholder="Gõ địa chỉ hoặc từ khóa tìm Google…"
                title={liveUrl}
                onChange={(e) => setDraft(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') navigate(e.currentTarget.value);
                  else if (e.key === 'Escape') { e.stopPropagation(); setDraft(null); e.currentTarget.blur(); }
                }}
              />
              <button className="ws-omni-copy" onClick={copyUrl} title="Chép địa chỉ">{copied ? '✓' : '⧉'}</button>
            </div>
          ) : (
            <div className="ws-title">
              <span className={`ws-dot ws-dot--${status === 'failed' ? 'loading' : status}`} />
              <span className="ws-title-text" title={`${name} · phiên ${partition.replace(/^persist:links-/, '')}`}>{name}</span>
            </div>
          )}
          <div className="ws-actions">
            <button
              onClick={() => { setStatus('loading'); void ref.current?.loadURL('https://accounts.google.com/'); }}
              title="Đăng nhập Google trong khung này (phiên của profile hiện tại)"
            >
              Ⓖ
            </button>
            {onSaveLink && (
              <button onClick={() => void saveLink()} disabled={saveState === 'saving'}
                title="Lưu link đang xem vào danh sách">
                {saveState === 'done' ? '✓' : '💾'}
              </button>
            )}
            {/* LUÔN hiện khi bật password manager: matchCount chỉ được cập nhật
                sau khi tra store xong, mà trang SPA có thể chưa kịp bắn sự kiện
                nào — ẩn nút theo matchCount làm nó biến mất đúng lúc cần bấm.
                Không có gì để điền thì fillSaved() tự báo, đỡ hơn nút vô hình. */}
            {(creds?.username || creds?.password || passwordManager) && (
              <button onClick={() => void fillSaved()}
                title={matchCount > 0
                  ? `Điền mật khẩu đã lưu cho trang này (${matchCount} tài khoản)`
                  : 'Điền username/password đã lưu vào form login'}>
                🔑{passwordManager && matchCount > 1 ? <sup>{matchCount}</sup> : null}
              </button>
            )}
            <button
              onClick={() => { try { ref.current?.openDevTools(); } catch { /* guest chưa sẵn sàng */ } }}
              title="DevTools của trang đang xem (Network/Console/Elements) — hoặc F12 / chuột phải → Inspect ngay trong trang"
            >
              🔧
            </button>
            <button onClick={openExternal} title="Mở bằng trình duyệt ngoài">↗</button>
            <button onClick={() => void logout()} title="Đăng xuất phiên của profile này">⎋</button>
            <button onClick={onClose} title="Đóng (Esc)">✕</button>
          </div>
        </div>

        {/* Thanh "Lưu mật khẩu?" — hiện khi bắt được form login vừa submit */}
        {offer && (
          <div className="pw-offer">
            <span className="pw-offer-ico" aria-hidden>🔑</span>
            <span className="pw-offer-text">
              {offer.update ? 'Cập nhật mật khẩu đã lưu cho' : 'Lưu mật khẩu cho'}{' '}
              <b>{hostOf(offer.url)}</b>
              {offer.username && <> · <code>{offer.username}</code></>}
              {!canEncrypt() && (
                <em className="pw-offer-warn" title="Chỉ mã hóa được khi chạy app desktop (Electron safeStorage)">
                  — lưu dạng plaintext
                </em>
              )}
            </span>
            <button className="sm" onClick={() => void acceptOffer()}>Lưu</button>
            <button className="ghost sm" onClick={() => setOffer(null)}>Không</button>
          </div>
        )}
        {savedNote && <div className="pw-offer pw-offer-ok">✓ {savedNote}</div>}

        <div className="ws-canvas">
          {/* partition MUST be an initial attribute — it cannot change after
              attach; caller remounts (key) khi đổi profile. */}
          <webview
            ref={ref as unknown as React.Ref<HTMLElement>}
            className="ws-webview"
            src={url}
            partition={partition}
            {...webviewAttrs}
          />
          {status === 'loading' && (
            <div className="ws-overlay">
              <div className="ws-spinner" />
              <p>Đang tải {name}…</p>
            </div>
          )}
          {status === 'failed' && (
            <div className="ws-overlay">
              <div className="ws-overlay-ico">🔌</div>
              <h3>Không tải được</h3>
              <p className="ws-muted">{failInfo}</p>
              <button className="ws-retry" onClick={retry}>Thử lại</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
