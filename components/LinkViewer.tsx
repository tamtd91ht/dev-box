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
   *  chỉ-đọc. Tab Browser + tab Links bật; tab Google giữ tiêu đề gọn như cũ. */
  addressBar?: boolean;
  /** Link trong trang bấm "mở tab mới" (target=_blank / chuột giữa) → mở thành
   *  TAB MỚI trong app thay vì đẩy ra trình duyệt ngoài. */
  onOpenNewTab?: (url: string) => void;
  /** Guest ĐÃ ĐIỀU HƯỚNG sang trang khác (bấm link trong trang, redirect SSO,
   *  đổi route SPA) → báo URL mới về chủ khung.
   *
   *  Chủ khung cần biết vì prop `url` chỉ là trang KHỞI ĐẦU: không có kênh này
   *  thì "nhân đôi tab" nhân ra trang lúc mở tab chứ không phải trang đang
   *  xem, và dò tab trùng cũng so với một địa chỉ đã cũ.
   *
   *  Chủ khung ghi thẳng giá trị này trở lại prop `url` được: effect đồng bộ
   *  prop→guest ở dưới có chốt `sameUrl(el.getURL(), url)` nên vòng "báo lên
   *  rồi bị tải lại" không xảy ra. */
  onUrlChange?: (url: string) => void;
}

/** Thanh "Lưu mật khẩu?" — user/pass vừa bắt được ở form submit. */
interface SaveOffer { url: string; username: string; password: string; update: boolean }

const hostOf = (u: string): string => { try { return new URL(u).host; } catch { return u; } };

/** Tiền tố console mà guest dùng để báo "mở URL này ở tab mới" về host. */
const NEWTAB_PREFIX = '[dbx-newtab] ';

export default function LinkViewer({
  name, url, partition, onClose, onSaveLink, hidden, creds, passwordManager, profile,
  addressBar, onOpenNewTab, onUrlChange,
}: Props) {
  const ref = useRef<WebviewElement | null>(null);
  /** Callback báo URL mới — đọc qua ref vì effect gắn listener chạy MỘT lần
   *  (deps []) nên closure sẽ giữ mãi bản đầu tiên. */
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;
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
        if (cur) {
          setLiveUrl(cur);
          onUrlChangeRef.current?.(cur);
        }
      } catch {
        /* not attached yet */
      }
    };
    // Chốt chặn cuối: dù không sự kiện nào bắn, overlay cũng phải tự tắt — thà
    // để người dùng nhìn trang đang tải dở còn hơn kẹt spinner che hết nội dung.
    let stuckTimer: ReturnType<typeof setTimeout> | undefined;
    const clearStuck = () => { if (stuckTimer) { clearTimeout(stuckTimer); stuckTimer = undefined; } };
    const done = () => {
      clearStuck();
      setStatus((s) => (s === 'failed' ? s : 'ready'));
      syncNav();
    };

    const onStart = () => {
      setStatus('loading');
      syncNav();
      clearStuck();
      stuckTimer = setTimeout(done, 12_000);
    };
    const onStop = done;
    // Trang tin nhiều quảng cáo (vnexpress…) giữ kết nối tracker/iframe ads mở
    // rất lâu — có khi không bao giờ đóng — nên `did-stop-loading` không bắn và
    // overlay spinner kẹt mãi dù nội dung đã đọc được. Bám `dom-ready` như
    // WorkspaceView: document chính đã parse xong là bỏ overlay.
    const onDomReady = done;
    const onFail = (e: Event) => {
      const ev = e as unknown as { errorCode: number; errorDescription: string; isMainFrame: boolean };
      if (!ev.isMainFrame || ev.errorCode === -3 /* ABORTED */) return;
      setFailInfo(`${ev.errorDescription || 'Network error'} (${ev.errorCode})`);
      setStatus('failed');
    };

    // Lần tải ĐẦU: webview có thể đã bắn did-start-loading/dom-ready trước khi
    // effect này gắn listener → không có gì tắt overlay. Hẹn giờ ngay từ mount.
    stuckTimer = setTimeout(done, 12_000);

    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('dom-ready', onDomReady);
    el.addEventListener('did-navigate', syncNav);
    el.addEventListener('did-navigate-in-page', syncNav);
    el.addEventListener('did-fail-load', onFail as EventListener);
    return () => {
      clearStuck();
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('dom-ready', onDomReady);
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

  /**
   * Prop `url` đổi → bảo guest đi tới địa chỉ mới.
   *
   * `<webview src>` CHỈ được đọc lúc attach lần đầu; đổi thuộc tính sau đó
   * không làm gì cả. Nên khi người gọi (tab Browser) đưa sang URL khác trên
   * CÙNG một viewer, khung dưới vẫn nằm im ở trang cũ — nhìn như "sửa địa chỉ
   * xong Enter không ăn". Effect này là chỗ duy nhất khớp lại hai bên.
   *
   * Chỉ gọi khi guest đang thực sự ở địa chỉ khác: loadURL vô điều kiện sẽ tải
   * lại trang mỗi lần component re-render vì lý do không liên quan, và tệ hơn
   * là đá người dùng khỏi trang họ vừa tự bấm sang bên trong tab.
   */
  const urlRef = useRef(url);
  useEffect(() => {
    const prev = urlRef.current;
    urlRef.current = url;
    // Lần chạy đầu (prev === url) là lúc mount: `src` đã lo tải rồi, gọi thêm
    // loadURL chỉ tải hai lần. Chỉ hành động khi prop THỰC SỰ đổi giá trị.
    if (!url || sameUrl(prev, url)) return;
    const el = ref.current;
    if (!el) return;
    // Guest đã ở đúng đó rồi (người dùng vừa tự bấm sang) thì đừng tải lại.
    try { if (sameUrl(el.getURL() || '', url)) return; } catch { /* chưa attach */ }
    setDraft(null);
    setStatus('loading');
    setFailInfo('');
    try { void el.loadURL(url); } catch { /* guest chưa sẵn sàng */ }
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

  /**
   * Chạy `code` trong MỌI frame của guest và trả kết quả từng frame.
   *
   * webview.executeJavaScript() chỉ với tới MAIN FRAME. Rất nhiều trang đặt
   * form login trong <iframe> (Keycloak/SSO nhúng khung con) — với những trang
   * đó thì bẫy bắt mật khẩu và autofill không bao giờ thấy ô password, nên
   * thanh "Lưu mật khẩu?" im lặng đúng ở chỗ cần nó nhất. Cầu execInFrames
   * (main process, webFrameMain) chạy được cả trong frame khác origin.
   *
   * Thứ tự trả về: main frame trước, rồi các frame con — caller lấy kết quả
   * "có nghĩa" đầu tiên, nên main frame vẫn được ưu tiên như trước.
   *
   * Preload cũ chưa có cầu này → tự lùi về executeJavaScript (main frame),
   * tức đúng hành vi trước đây, không tệ hơn.
   */
  const execFrames = useCallback(async (code: string): Promise<unknown[]> => {
    const bridge = typeof window !== 'undefined' ? window.workspace?.execInFrames : undefined;
    // getWebContentsId ném lỗi khi guest chưa attach — đọc thẳng ở đây thay vì
    // qua guestId() (khai báo ở dưới, dùng cho DevTools) để khỏi phải xáo thứ
    // tự khai báo của cả component.
    let id = -1;
    try { id = ref.current?.getWebContentsId() ?? -1; } catch { /* chưa attach */ }
    if (bridge && id > 0) {
      try {
        const res = await bridge(id, code);
        if (res?.ok && res.frames) return res.frames.map((f) => f.value);
      } catch { /* cầu lỗi → lùi về main frame bên dưới */ }
    }
    try {
      const v = await ref.current?.executeJavaScript(code, true);
      return [v];
    } catch { return []; }
  }, []);

  /** Đoạn JS tìm ô user/pass — dùng lại cho cả điền và bắt submit.
   *
   *  QUÉT CẢ SHADOW DOM, không chỉ document.querySelectorAll: khá nhiều trang
   *  quản trị (web component, Lightning, Ionic…) đặt form login trong shadow
   *  root, và ở đó querySelectorAll của document trả về RỖNG. Đó là một trong
   *  những lý do thanh "Lưu mật khẩu?" có trang hiện có trang không.
   *
   *  GIỚI HẠN còn lại — form login nằm trong <iframe> (SSO nhúng kiểu Keycloak
   *  trong khung con): executeJavaScript của <webview> chỉ chạy ở main frame
   *  nên không với tới được, và iframe khác origin thì script cũng bị chặn.
   *  Những trang đó vẫn phải lưu tay qua 🔑. */
  const FIELD_JS = `
    const vis = (el) => el && el.offsetParent !== null && !el.disabled && !el.readOnly;
    // Mọi <input> trong document VÀ trong mọi shadow root lồng nhau, giữ đúng
    // thứ tự xuất hiện (userEl dựa vào thứ tự để đoán ô user trước ô password).
    const allInputs = () => {
      const out = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.tagName === 'INPUT') out.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(document);
      return out;
    };
    const pwEl = () => allInputs().find((i) => (i.type||'').toLowerCase() === 'password' && vis(i));
    const userEl = (pw) => {
      const all = allInputs();
      const texts = all.filter((i) =>
        ['text','email','tel','','username'].includes((i.type||'').toLowerCase()) && vis(i));
      const named = texts.find((i) => /user|email|login|account|phone|tel|name/i.test(
        (i.name||'')+(i.id||'')+(i.placeholder||'')+(i.autocomplete||'')));
      if (named) return named;
      // Không có tên gợi ý → ô text NGAY TRƯỚC ô password trong DOM.
      if (pw) { const i = all.indexOf(pw);
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
    // Điền vào frame NÀO CÓ form. Frame không có ô password trả 'no-form' —
    // vô hại, ta chỉ quan tâm frame nào làm được việc. Ưu tiên 'ok' (đã điền),
    // rồi 'kept' (người dùng đang gõ dở → dừng, không đạp lên), cuối cùng mới
    // là 'no-form' nghĩa là cả trang không có form nào.
    const rs = (await execFrames(code)) as string[];
    if (rs.includes('ok')) return 'ok';
    if (rs.includes('kept')) return 'kept';
    return 'no-form';
  }, [FIELD_JS, execFrames]);

  /** Gắn bẫy submit trong guest: lưu user/pass vừa gõ vào window.__dbxPwd để
   *  host đọc ra. Idempotent — gọi lại sau mỗi lần điều hướng là vô hại. */
  const armCapture = useCallback(async () => {
    const code = `(() => {
      // Bẫy gắn vào document. Điều hướng in-page giữ nguyên window NHƯNG một
      // số SPA thay hẳn document (hoặc trang gỡ listener của mình), lúc đó cờ
      // cũ vẫn true và ta sẽ không bao giờ cắm lại — thanh "Lưu mật khẩu?" im
      // luôn cho tới khi F5. Neo cờ vào chính document đang sống, không phải
      // window: document mới là document chưa có cờ, tự động cắm lại.
      if (document.__dbxPwdArmed) return 'already';
      document.__dbxPwdArmed = true;
      window.__dbxPwdArmed = true; // giữ cho tương thích, không còn dùng để gác
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
      // KHÔNG lọc theo e.target instanceof HTMLInputElement: event từ trong
      // shadow root bị "retarget", e.target thành phần tử host (một web
      // component, không phải INPUT) nên điều kiện đó loại sạch — và ta mất
      // đúng những trang đặt form trong shadow DOM. remember() tự đi tìm ô
      // password nên gọi thừa cũng chỉ tốn một lượt querySelector.
      document.addEventListener('input', remember, true);

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
        // Đi theo composedPath() chứ không phải e.target.closest(): với event
        // phát từ trong shadow root, e.target đã bị retarget thành host nên
        // closest() không bao giờ thấy cái <button> thật vừa bị bấm.
        const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
        const hit = path.some((n) => {
          if (!(n instanceof Element)) return false;
          if (n.tagName === 'BUTTON' || n.tagName === 'A') return true;
          return n.tagName === 'INPUT' && (n.type || '').toLowerCase() === 'submit';
        });
        if (hit) grab();
      }, true);
      document.addEventListener('keydown', (e) => { if (e.key === 'Enter') grab(); }, true);
      return 'armed';
    })()`;
    // Cắm vào MỌI frame: form login có thể ở main frame hay trong iframe SSO,
    // và cờ armed neo theo từng document nên frame nào cắm rồi thì tự bỏ qua.
    await execFrames(code);
  }, [FIELD_JS, execFrames]);

  /** Đọc user/pass guest vừa bắt được; xóa khỏi guest sau khi lấy. */
  const readCaptured = useCallback(async (): Promise<{ username: string; password: string; url: string } | null> => {
    const code = `(() => { const v = window.__dbxPwd; window.__dbxPwd = null; return v ? JSON.stringify(v) : null; })()`;
    // Mỗi frame có window riêng, nên thứ bắt được nằm ở frame CHỨA FORM — với
    // SSO nhúng thì đó là iframe, không phải main frame. Lấy frame đầu tiên có
    // mật khẩu (main frame vẫn được xét trước, đúng như cũ).
    const raws = (await execFrames(code)) as (string | null)[];
    for (const raw of raws) {
      if (!raw) continue;
      try {
        const got = JSON.parse(raw) as { username: string; password: string; url: string };
        if (got?.password) return got;
      } catch { /* frame trả rác → thử frame sau */ }
    }
    return null;
  }, [execFrames]);

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
    // Tra theo CẢ url main frame LẪN url của frame đang chứa ô password.
    //
    // Với SSO nhúng (form login trong iframe Keycloak), mật khẩu được lưu theo
    // origin của FRAME — đó là origin thật của trang đăng nhập, và lần sau
    // chính frame đó lại hiện ra. Nếu chỉ tra bằng url main frame thì bản ghi
    // vừa lưu ở lượt trước không bao giờ khớp lại: lưu được mà không điền được.
    const urls = [currentUrl()];
    if (passwordManager) {
      const found = (await execFrames(
        `(() => { const vis = (el) => el && el.offsetParent !== null && !el.disabled && !el.readOnly;
          const pw = [...document.querySelectorAll('input[type=password]')].find(vis);
          return pw ? location.href : null; })()`,
      )) as (string | null)[];
      for (const u of found) if (u && !urls.includes(u)) urls.push(u);
    }
    const hits = passwordManager
      ? (await Promise.all(urls.map((u) => pwMatch(u, profile).catch(() => []))))
          .flat()
          // Cùng một bản ghi có thể khớp cả hai url → giữ một bản.
          .filter((c, i, all) => all.findIndex((o) => o.id === c.id && o.username === c.username) === i)
      : [];
    const linkCred = creds?.password || creds?.username
      ? [{ id: '', username: creds.username ?? '', password: creds.password ?? '', profile }]
      : [];
    // Vault đã có tài khoản CÙNG username → bỏ bản của link (vault mới hơn).
    const dup = new Set(hits.map((h) => h.username));
    return [...hits, ...linkCred.filter((c) => !dup.has(c.username))];
  }, [passwordManager, profile, currentUrl, creds, execFrames]);

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

    // BẪY PHẢI CẮM TRƯỚC MỌI THỨ KHÁC, và cắm sớm nhất có thể.
    //
    // Vì sao tách khỏi cycle(): cycle là một chuỗi await dài (readCaptured →
    // considerSave → resolveCreds → vòng injectFill thưa dần tới 1.5s). Người
    // dùng gõ nhanh rồi Enter trong khoảng đó là bẫy chưa kịp có mặt — mất
    // trắng cặp user/pass, và thanh "Lưu mật khẩu?" không hiện. Đó chính là
    // triệu chứng "có lúc hiện có lúc không": nó phụ thuộc vào việc người dùng
    // gõ nhanh hay chậm hơn cái chuỗi await kia.
    //
    // `dom-ready` là mốc sớm nhất mà executeJavaScript chạy được — sớm hơn
    // did-stop-loading (cái đó còn chờ ảnh/script/iframe tải xong, trên trang
    // login nặng có thể là vài giây sau khi ô nhập đã bấm được).
    const arm = () => { void armCapture(); };

    el.addEventListener('dom-ready', arm);
    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', cycle);
    // Redirect SSO toàn trang bắn did-navigate; document mới nên phải cắm lại
    // ngay, không đợi did-stop-loading.
    el.addEventListener('did-navigate', arm);
    // Login SPA đổi URL mà không tải lại trang → cũng phải xét lưu + tra lại.
    el.addEventListener('did-navigate-in-page', cycle);

    // Lần tải ĐẦU của tab: webview có thể đã bắn dom-ready TRƯỚC khi effect này
    // kịp gắn listener (nhất là tab mở nền rồi mới chuyển sang). Cắm luôn một
    // lần ở đây — armCapture idempotent nên trùng cũng vô hại, còn thiếu thì
    // mất cả lần đăng nhập đầu tiên, đúng lúc người dùng cần nó nhất.
    arm();

    return () => {
      alive = false;
      el.removeEventListener('dom-ready', arm);
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', cycle);
      el.removeEventListener('did-navigate', arm);
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

  // ── DevTools dock trong khung, như Chrome ────────────────────────────────
  // `<webview>.openDevTools()` LUÔN bung cửa sổ rời (Electron ép 'detach' cho
  // guest webview) — xem rất bất tiện. Frontend DevTools cũng chỉ là một trang
  // web nên dock được — nhưng chỗ ở của nó KHÔNG thể là một <webview> khác
  // (Chromium cấm guest view làm devtools, electron#14095): main process nuôi
  // frontend trong một WebContentsView đặt ĐÈ lên cửa sổ, còn component này chỉ
  // vẽ pane (nền + thanh kéo + nút ✕) rồi báo rect của nó cho main
  // ('devtools:open' / 'devtools:bounds'). F12 / chuột phải → Inspect bấm TRONG
  // guest đi đường main → 'devtools:request' → đúng viewer này claim rồi mở
  // pane (xem requestEmbeddedDevTools trong electron/main.cjs).
  const devtoolsBodyRef = useRef<HTMLDivElement | null>(null);
  const [devtools, setDevtools] = useState(false);
  const [devtoolsH, setDevtoolsH] = useState(340); // chiều cao khi neo ĐÁY
  const [devtoolsW, setDevtoolsW] = useState(460); // bề rộng khi neo TRÁI/PHẢI
  /** Vị trí neo DevTools như Chrome: đáy | trái | phải. Nhớ qua localStorage —
   *  đây là sở thích cá nhân lặp lại mỗi lần mở, không phải trạng thái tạm. */
  const [devtoolsDock, setDevtoolsDock] = useState<'bottom' | 'left' | 'right'>('bottom');
  const [devtoolsDrag, setDevtoolsDrag] = useState(false);
  const DEFAULT_H = 340;
  const DEFAULT_W = 460;

  useEffect(() => {
    try {
      const v = localStorage.getItem('devbox.devtools.dock');
      if (v === 'bottom' || v === 'left' || v === 'right') setDevtoolsDock(v);
    } catch { /* localStorage bị chặn — giữ mặc định 'bottom' */ }
  }, []);

  const setDock = useCallback((d: 'bottom' | 'left' | 'right') => {
    setDevtoolsDock(d);
    try { localStorage.setItem('devbox.devtools.dock', d); } catch { /* bỏ qua */ }
  }, []);
  /** Bản sao dạng ref cho devtoolsDrag — devtoolsRect đọc nó để khỏi đổi danh
   *  tính callback (interval trong effect giữ closure cũ). */
  const devtoolsDragRef = useRef(false);
  /** Toạ độ "Inspect element" chờ pane mount + frontend nối xong mới dùng được. */
  const inspectAt = useRef<{ x: number; y: number } | null>(null);
  // Preload cũ chưa có cầu devtools → giữ nguyên hành vi cửa sổ rời như trước.
  // typeof-guard vì Next vẫn prerender component 'use client' trên server.
  const canDock = typeof window !== 'undefined' && Boolean(window.workspace?.devtoolsOpen);

  /** Id webContents của guest; -1 khi chưa attach (getWebContentsId ném lỗi). */
  const guestId = useCallback(() => {
    try { return ref.current?.getWebContentsId() ?? -1; } catch { return -1; }
  }, []);

  /** Rect chỗ ở DevTools trong toạ độ cửa sổ; null = view phải ẨN: tab nền bị
   *  đẩy offscreen (left âm), popup/modal đang cần nổi trên vùng webview (view
   *  là native layer, DOM không che nổi — cùng lý do với data-popup-over-webview
   *  của .ws-webview), hoặc đang kéo chiều cao (view nuốt mất pointermove). */
  const devtoolsRect = useCallback(() => {
    const el = devtoolsBodyRef.current;
    if (!el || devtoolsDragRef.current) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40 || r.left < 0 || r.top < 0) return null;
    const html = document.documentElement;
    if (html.hasAttribute('data-popup-over-webview') || html.hasAttribute('data-modal-over-webview')) return null;
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  }, []);

  const openDevtools = useCallback((point?: { x: number; y: number }) => {
    if (!canDock) {
      try { ref.current?.openDevTools(); } catch { /* guest chưa sẵn sàng */ }
      return;
    }
    inspectAt.current = point ?? null;
    setDevtools(true);
  }, [canDock]);

  /** Đóng = chỉ hạ cờ; effect dưới lo gọi devtoolsClose khi cờ tắt/unmount. */
  const closeDevtools = useCallback(() => setDevtools(false), []);

  // Pane vừa mount → nhờ main dựng WebContentsView tại rect của pane, rồi BÁM
  // THEO layout: kéo chiều cao, resize cửa sổ, ẩn tab (đẩy offscreen), popup
  // cần nổi lên… không có một sự kiện nào gộp đủ các trường hợp đó, nên poll
  // rect — một lần đọc getBoundingClientRect mỗi nhịp, chỉ gửi IPC khi đổi.
  useEffect(() => {
    if (!devtools) return;
    const id = guestId();
    if (id < 0) { setDevtools(false); return; }
    const point = inspectAt.current;
    inspectAt.current = null;
    void window.workspace?.devtoolsOpen?.(id, devtoolsRect(), point);
    let last = '';
    const timer = setInterval(() => {
      const rect = devtoolsRect();
      const key = JSON.stringify(rect);
      if (key === last) return;
      last = key;
      window.workspace?.devtoolsBounds?.(id, rect);
    }, 250);
    return () => {
      clearInterval(timer);
      // Chạy cả khi cờ tắt lẫn khi unmount cả viewer (đóng tab) — main đã dọn
      // rồi thì gọi lần nữa vô hại.
      void window.workspace?.devtoolsClose?.(id);
    };
  }, [devtools, guestId, devtoolsRect]);

  // Đổi vị trí neo → gửi rect mới NGAY, không chờ vòng poll 250ms (đổi dock mà
  // view nhảy trễ nửa giây nhìn rất khựng). Không đụng lúc kéo — kéo tự quản.
  useEffect(() => {
    if (!devtools || devtoolsDragRef.current) return;
    const id = guestId();
    if (id >= 0) window.workspace?.devtoolsBounds?.(id, devtoolsRect());
  }, [devtoolsDock, devtools, guestId, devtoolsRect]);

  // Yêu cầu mở từ main (F12/Inspect trong guest) + tin DevTools đã đóng (nút ✕
  // của chính frontend, hoặc guest chết) — chỉ nhận đúng guest của viewer này.
  useEffect(() => {
    const ws = window.workspace;
    if (!ws?.onDevToolsRequest) return;
    const offReq = ws.onDevToolsRequest((req) => {
      if (req.id < 0 || req.id !== guestId()) return;
      ws.devtoolsClaim?.(req.id);
      openDevtools(
        typeof req.x === 'number' && typeof req.y === 'number'
          ? { x: req.x, y: req.y }
          : undefined,
      );
    });
    const offClosed = ws.onDevToolsClosed?.((id) => {
      if (id >= 0 && id === guestId()) setDevtools(false);
    });
    return () => { offReq(); offClosed?.(); };
  }, [guestId, openDevtools]);

  /** Kéo mép trong của pane để đổi kích thước — có tấm phủ trong suốt lúc kéo,
   *  không thì con trỏ rơi vào <webview> là chuột "mất tích" (xem Splitter).
   *  View DevTools cũng phải ẨN suốt lúc kéo: nó là native layer, tấm phủ DOM
   *  không chặn được chuột đi vào nó (devtoolsRect trả null khi dragRef bật;
   *  gửi ngay một nhịp null để không phải đợi vòng poll).
   *
   *  Neo ĐÁY: kéo mép TRÊN đổi chiều cao. Neo TRÁI: kéo mép PHẢI đổi bề rộng.
   *  Neo PHẢI: kéo mép TRÁI đổi bề rộng (chiều tăng ngược lại). */
  const startDevtoolsDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const dock = devtoolsDock;
    const startX = e.clientX;
    const startY = e.clientY;
    const startH = devtoolsH;
    const startW = devtoolsW;
    setDevtoolsDrag(true);
    devtoolsDragRef.current = true;
    const id = guestId();
    if (id >= 0) window.workspace?.devtoolsBounds?.(id, null);
    const move = (ev: PointerEvent) => {
      if (dock === 'bottom') {
        const max = Math.max(160, window.innerHeight - 220);
        setDevtoolsH(Math.min(max, Math.max(120, startH + (startY - ev.clientY))));
      } else {
        const max = Math.max(280, window.innerWidth - 260);
        const delta = dock === 'left' ? ev.clientX - startX : startX - ev.clientX;
        setDevtoolsW(Math.min(max, Math.max(240, startW + delta)));
      }
    };
    const up = () => {
      setDevtoolsDrag(false);
      devtoolsDragRef.current = false; // vòng poll kế tiếp tự hiện view ở rect mới
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [devtoolsDock, devtoolsH, devtoolsW, guestId]);

  // Guest nhường chỗ cho pane theo hướng neo: đáy → thụt `bottom`, trái → thụt
  // `left`, phải → thụt `right`. (.ws-webview vốn inset:0, chỉ cần đè một cạnh.)
  const dtInset = !devtools
    ? undefined
    : devtoolsDock === 'bottom'
      ? { bottom: devtoolsH }
      : devtoolsDock === 'left'
        ? { left: devtoolsW }
        : { right: devtoolsW };
  const dtPaneStyle = devtoolsDock === 'bottom' ? { height: devtoolsH } : { width: devtoolsW };
  const dtCursor = devtoolsDock === 'bottom' ? 'row-resize' : 'col-resize';

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
              {/* TAY CẦM ĐỂ KÉO — phải là phần tử RIÊNG, không phải chính
                  <input>: kéo bên trong ô nhập là thao tác bôi chọn chữ, đặt
                  draggable lên đó sẽ cướp mất.
                  Bản trước dùng chính chấm trạng thái 8×8px làm tay cầm — quá
                  nhỏ để trúng và không có dấu hiệu gì cho biết kéo được, nên
                  thực tế không ai kéo nổi. Nay là một nút riêng có biểu tượng
                  và vùng bấm đủ rộng. */}
              {liveUrl && (
                <span
                  className="ws-omni-drag"
                  draggable
                  role="img"
                  aria-label="Kéo để lưu dấu trang"
                  title="Kéo xuống thanh dấu trang để lưu"
                  onDragStart={(e) => {
                    // Đủ cả hai kiểu: `text/uri-list` là chuẩn cho URL, còn
                    // `text/plain` để thả được sang ô nhập/ứng dụng khác.
                    e.dataTransfer.setData('text/uri-list', liveUrl);
                    e.dataTransfer.setData('text/plain', liveUrl);
                    // 'copyLink' KHÔNG chứa 'move'. Thanh dấu trang đặt
                    // dropEffect theo nguồn kéo, nhưng để chắc chắn mọi đích
                    // thả (kể cả ô nhập của trang khác) đều nhận được, khai
                    // 'all' — nguồn hẹp hơn đích là cách nhanh nhất để một cú
                    // thả bị huỷ im lặng, không có lỗi nào để lần ra.
                    e.dataTransfer.effectAllowed = 'all';
                  }}
                >
                  🔖
                </span>
              )}
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
              onClick={() => { if (devtools) closeDevtools(); else openDevtools(); }}
              title="DevTools của trang đang xem, dock trong khung — hoặc F12 / chuột phải → Inspect ngay trong trang"
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
          {/* DevTools mở → guest nhường một cạnh khung cho pane (dtInset đè lên
              inset:0 của .ws-webview theo hướng neo). Overlay tải trang cũng
              dừng ở mép pane — điều hướng khi đang soi không che mất DevTools. */}
          <webview
            ref={ref as unknown as React.Ref<HTMLElement>}
            className="ws-webview"
            src={url}
            partition={partition}
            style={dtInset}
            {...webviewAttrs}
          />
          {status === 'loading' && (
            <div className="ws-overlay" style={dtInset}>
              <div className="ws-spinner" />
              <p>Đang tải {name}…</p>
            </div>
          )}
          {status === 'failed' && (
            <div className="ws-overlay" style={dtInset}>
              <div className="ws-overlay-ico">🔌</div>
              <h3>Không tải được</h3>
              <p className="ws-muted">{failInfo}</p>
              <button className="ws-retry" onClick={retry}>Thử lại</button>
            </div>
          )}
          {devtools && (
            <div className="ws-devtools" data-dock={devtoolsDock} style={dtPaneStyle}>
              <div
                className="ws-devtools-grip"
                onPointerDown={startDevtoolsDrag}
                onDoubleClick={() => (devtoolsDock === 'bottom' ? setDevtoolsH(DEFAULT_H) : setDevtoolsW(DEFAULT_W))}
                title="Kéo để đổi kích thước · đúp chuột về mặc định"
              />
              <div className="ws-devtools-bar">
                <span className="ws-devtools-title" title={liveUrl}>
                  DevTools · {hostOf(liveUrl)}
                </span>
                {/* Chọn vị trí neo, như menu ⋮ của Chrome (Dock side). */}
                <span className="ws-devtools-dock" role="group" aria-label="Vị trí neo DevTools">
                  <button className={devtoolsDock === 'left' ? 'on' : ''} onClick={() => setDock('left')} title="Neo bên trái">◧</button>
                  <button className={devtoolsDock === 'bottom' ? 'on' : ''} onClick={() => setDock('bottom')} title="Neo bên dưới">⬓</button>
                  <button className={devtoolsDock === 'right' ? 'on' : ''} onClick={() => setDock('right')} title="Neo bên phải">◨</button>
                </span>
                <button className="ws-devtools-x" onClick={closeDevtools} title="Đóng DevTools (F12)">✕</button>
              </div>
              {/* Chỗ ở của frontend: main process đặt một WebContentsView đè
                  đúng rect của div này (đo + gửi ở effect devtools phía trên).
                  Div chỉ là nền lót — thấy nó tức là view đang ẩn/chưa nối. */}
              <div ref={devtoolsBodyRef} className="ws-devtools-body" />
            </div>
          )}
          {devtoolsDrag && <div className="ws-devtools-veil" aria-hidden style={{ cursor: dtCursor }} />}
        </div>
      </div>
    </div>
  );
}

/**
 * Hai địa chỉ có trỏ tới cùng một chỗ không?
 *
 * So chuỗi thô là không đủ: sau khi tải xong, guest trả về URL đã chuẩn hoá
 * ("example.com" → "https://example.com/"), nên so thẳng sẽ luôn thấy "khác" và
 * tải lại trang vô hạn. Bỏ dấu / cuối và phần #fragment (đổi fragment không
 * phải điều hướng) rồi mới so.
 */
function sameUrl(a: string, b: string): boolean {
  const norm = (s: string) => {
    try {
      const u = new URL(s);
      u.hash = '';
      return u.toString().replace(/\/$/, '');
    } catch {
      return s.replace(/\/$/, '');
    }
  };
  return norm(a) === norm(b);
}
