'use client';

// Zalo API — MÀN CHAT thật (không phải webview Zalo).
//
// Dựng trên chính API nội bộ đã port: danh sách hội thoại + lịch sử tin lấy từ
// kho server (lib/zaloapi/server/threadStore), gửi qua action 'send'. Đây là thứ
// biến tab Zalo API từ "kết nối + console" thành một ứng dụng chat quản lý được
// từng hội thoại cá nhân/nhóm — song song với việc nuôi Automation.
//
//   cột trái  : danh sách hội thoại (mới nhất trước, badge chưa đọc)
//   cột phải  : bong bóng tin (mình bên phải / người bên trái) + ô soạn gửi
//   soạn mới  : chọn từ danh bạ đã học, hoặc gõ threadId thật
//
// Lịch sử chỉ có TỪ LÚC listener chạy (kho RAM, không backfill tin cũ trước khi
// kết nối) — đủ để quản lý hội thoại đang diễn ra và trả lời.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  zaloApiThreads,
  zaloApiScan,
  zaloApiSetTags,
  zaloApiHistory,
  zaloApiSendMessage,
  zaloApiSendImage,
  zaloApiSendFile,
  zaloApiLoadOlder,
  zaloApiContacts,
  zaloApiReact,
  type ZaloThreadSummary,
  type ZaloStoredMessage,
  type ZaloContact,
} from '@/lib/zaloapi/api';
import {
  REACTIONS,
  QUICK_REACTION_KEYS,
  reactionByKey,
  reactionEmoji,
} from '@/lib/zaloapi/reactions';
import { useSplit } from '@/lib/useSplit';
import Splitter from './Splitter';

const POLL_MS = 2000;

function timeLabel(at: number): string {
  try { return new Date(at).toLocaleTimeString('vi', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

/** Bỏ dấu tiếng Việt để tìm "tam" khớp "Tâm". */
function normText(s: string): string {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
}

/** Màu chữ Zalo hỗ trợ (hex 6 ký tự, không #). Bảng gần với palette Zalo. */
const ZALO_COLORS: { name: string; hex: string }[] = [
  { name: 'Mặc định', hex: '' },
  { name: 'Đỏ', hex: 'db342e' },
  { name: 'Cam', hex: 'f27806' },
  { name: 'Vàng', hex: 'f7b503' },
  { name: 'Xanh lá', hex: '15a85f' },
  { name: 'Xanh dương', hex: '0068ff' },
  { name: 'Tím', hex: '7b3ff2' },
];

function rgbToHex(c: string): string {
  const s = (c || '').trim();
  const hex = s.match(/^#?([0-9a-f]{6})$/i);
  if (hex) return hex[1].toLowerCase();
  const rgb = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (rgb) return [1, 2, 3].map((i) => Number(rgb[i]).toString(16).padStart(2, '0')).join('').toLowerCase();
  return '';
}

interface Flags { b: boolean; i: boolean; u: boolean; s: boolean; color: string }

/**
 * Chuyển nội dung soạn thảo (contentEditable) thành { text thuần, styles } theo
 * đúng định dạng Zalo: mỗi style là { start, len, st } với st = b/i/u/s/c_<hex>.
 * Offset tính theo độ dài chuỗi (UTF-16) trùng với `text` gửi đi.
 */
function serializeStyled(root: HTMLElement): { text: string; styles: { start: number; len: number; st: string }[] } {
  const runs: { start: number; len: number; f: Flags }[] = [];
  let text = '';
  const EMPTY: Flags = { b: false, i: false, u: false, s: false, color: '' };

  const walk = (node: Node, f: Flags) => {
    if (node.nodeType === 3) {
      const t = node.textContent || '';
      if (!t) return;
      runs.push({ start: text.length, len: t.length, f });
      text += t;
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') { runs.push({ start: text.length, len: 1, f: EMPTY }); text += '\n'; return; }
    const isBlock = tag === 'div' || tag === 'p';
    if (isBlock && text.length && !text.endsWith('\n')) { runs.push({ start: text.length, len: 1, f: EMPTY }); text += '\n'; }
    const st = el.style;
    const nf: Flags = { ...f };
    if (tag === 'b' || tag === 'strong' || st.fontWeight === 'bold' || Number(st.fontWeight) >= 600) nf.b = true;
    if (tag === 'i' || tag === 'em' || st.fontStyle === 'italic') nf.i = true;
    const deco = `${st.textDecoration || ''} ${st.textDecorationLine || ''}`;
    if (tag === 'u' || deco.includes('underline')) nf.u = true;
    if (tag === 's' || tag === 'strike' || tag === 'del' || deco.includes('line-through')) nf.s = true;
    const col = st.color || (tag === 'font' ? el.getAttribute('color') || '' : '');
    if (col) { const hex = rgbToHex(col); if (hex) nf.color = hex; }
    for (const c of Array.from(node.childNodes)) walk(c, nf);
  };
  walk(root, EMPTY);

  const styles: { start: number; len: number; st: string }[] = [];
  const build = (get: (f: Flags) => string) => {
    let cur: { start: number; end: number; st: string } | null = null;
    for (const r of runs) {
      const v = get(r.f);
      if (v) {
        if (cur && cur.st === v && cur.end === r.start) cur.end = r.start + r.len;
        else { if (cur) styles.push({ start: cur.start, len: cur.end - cur.start, st: cur.st }); cur = { start: r.start, end: r.start + r.len, st: v }; }
      } else if (cur) { styles.push({ start: cur.start, len: cur.end - cur.start, st: cur.st }); cur = null; }
    }
    if (cur) styles.push({ start: cur.start, len: cur.end - cur.start, st: cur.st });
  };
  build((f) => (f.b ? 'b' : ''));
  build((f) => (f.i ? 'i' : ''));
  build((f) => (f.u ? 'u' : ''));
  build((f) => (f.s ? 's' : ''));
  build((f) => (f.color ? 'c_' + f.color : ''));

  // Bỏ xuống dòng thừa ở cuối + cắt style vượt quá độ dài.
  const trimmed = text.replace(/\n+$/, '');
  const clipped = styles
    .filter((s) => s.start < trimmed.length && s.len > 0)
    .map((s) => ({ ...s, len: Math.min(s.len, trimmed.length - s.start) }));
  return { text: trimmed, styles: clipped };
}

/** Đọc File ảnh → base64 (bỏ tiền tố data:). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('đọc ảnh thất bại'));
    r.readAsDataURL(file);
  });
}

/** Chữ cái đại diện cho avatar — 1 ký tự đầu của tên (bỏ dấu cách đầu). */
function initial(name: string): string {
  const s = (name || '').trim();
  return s ? s[0].toUpperCase() : '#';
}

/** Màu avatar ổn định theo khoá (id/tên) — cùng người luôn cùng màu, kiểu Zalo. */
function avatarHue(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % 360;
}

function Avatar({ name, id, group, size = 40 }: { name: string; id: string; group: boolean; size?: number }) {
  const hue = avatarHue(id || name);
  return (
    <span
      className="zc-av"
      style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hue} 55% 45%)` }}
    >
      {group ? '👥' : initial(name)}
    </span>
  );
}

/** Nhãn ngày cho vạch phân cách (Hôm nay / Hôm qua / dd/mm). */
function dayLabel(at: number): string {
  try {
    const d = new Date(at); const now = new Date();
    const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (same(d, now)) return 'Hôm nay';
    if (same(d, y)) return 'Hôm qua';
    return d.toLocaleDateString('vi', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return ''; }
}

export default function ZaloChatPanel({
  accountKey,
  connected,
  canSend,
  active,
}: {
  accountKey: string;
  /** Đã đăng nhập (có phiên server) — chưa thì màn chat trơ. */
  connected: boolean;
  /** Cổng gửi mở chưa (flags.enabled && flags.allowSend). */
  canSend: boolean;
  /** Tài khoản này đang là tab hiển thị — chỉ poll khi cần cho nhẹ. */
  active: boolean;
}) {
  const [threads, setThreads] = useState<ZaloThreadSummary[]>([]);
  const [activeThread, setActiveThread] = useState<string>('');
  const [group, setGroup] = useState(false);
  const [messages, setMessages] = useState<ZaloStoredMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [editorEmpty, setEditorEmpty] = useState(true);
  const [colorOpen, setColorOpen] = useState(false);
  // Ảnh ĐÍNH KÈM chờ gửi (dán/chọn chỉ nạp vào đây; Enter/Gửi mới bắn đi).
  const [pending, setPending] = useState<{ id: string; file: File; url: string }[]>([]);
  const pendingSeq = useRef(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderNote, setOlderNote] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Soạn mới
  const [composeOpen, setComposeOpen] = useState(false);
  const [contacts, setContacts] = useState<ZaloContact[]>([]);
  const [newId, setNewId] = useState('');
  const [newGroup, setNewGroup] = useState(false);

  // Quét danh bạ (nhóm + khách)
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState('');

  // Tìm kiếm + lọc theo tag
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [tagEditOpen, setTagEditOpen] = useState(false);
  // Menu chuột phải để gán tag ngay ở danh sách hội thoại.
  const [menu, setMenu] = useState<{ threadId: string; name: string; group: boolean; x: number; y: number } | null>(null);
  const [menuTag, setMenuTag] = useState('');

  // CẢM XÚC: id tin đang mở bảng chọn, và có đang mở bảng ĐẦY ĐỦ (54 mặt) hay
  // chỉ hàng nhanh 6 mặt. Lưu theo id tin để bảng đóng khi cuộn sang tin khác.
  /**
   * Tin đang được TRẢ LỜI (khối trích dẫn trên ô soạn). null = gửi tin thường.
   *
   * Giữ cả object chứ không chỉ id: lúc gửi cần zMsgId/zCliMsgId/fromId/at của
   * tin gốc, mà `messages` có thể đã đổi (tải tin cũ, poll về tin mới) giữa lúc
   * chọn và lúc bấm Gửi.
   */
  const [replyTo, setReplyTo] = useState<ZaloStoredMessage | null>(null);
  /** Người được tag (@) trong tin nhóm sắp gửi. */
  const [mentions, setMentions] = useState<{ uid: string; name: string }[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [reactFor, setReactFor] = useState<string>('');
  const [reactAll, setReactAll] = useState(false);
  const [reactBusy, setReactBusy] = useState('');

  // Kéo đổi bề rộng cột danh sách hội thoại. gap 0 vì hai cột dính nhau (cột
  // trái có border-right làm đường phân chia) — useSplit tự nới vùng bấm lên
  // MIN_HIT để vẫn trúng chuột. Tạm thời trong phiên, không nhớ qua lần mở sau
  // (xem lib/useSplit.ts).
  const rail = useSplit({ varName: '--zc-rail', min: 180, max: 560, gap: 0 });

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const activeThreadRef = useRef(activeThread);
  activeThreadRef.current = activeThread;

  // ── Poll danh sách hội thoại ────────────────────────────────────────────
  useEffect(() => {
    if (!connected) { setThreads([]); return; }
    let stop = false;
    const pump = () => {
      if (stop) return;
      zaloApiThreads(accountKey)
        .then((list) => { if (!stop) setThreads(list); })
        .catch(() => { /* route/listener sẽ báo trạng thái ở nơi khác */ });
    };
    pump();
    const t = setInterval(pump, POLL_MS);
    return () => { stop = true; clearInterval(t); };
  }, [accountKey, connected]);

  // ── Poll lịch sử của hội thoại đang mở ─────────────────────────────────
  useEffect(() => {
    if (!connected || !activeThread) { setMessages([]); return; }
    let stop = false;
    const pump = () => {
      if (stop) return;
      zaloApiHistory(accountKey, activeThread)
        .then((list) => { if (!stop) setMessages(list); })
        .catch(() => { /* bỏ nhịp */ });
    };
    pump();
    const t = setInterval(pump, POLL_MS);
    return () => { stop = true; clearInterval(t); };
  }, [accountKey, connected, activeThread]);

  // Cuộn xuống đáy khi có tin mới / đổi hội thoại.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activeThread]);

  const openThread = useCallback((t: ZaloThreadSummary) => {
    setActiveThread(t.threadId);
    setGroup(t.group);
    setErr('');
    setOlderNote('');
    setComposeOpen(false);
    setTagEditOpen(false);
    setTagInput('');
    if (editorRef.current) editorRef.current.innerHTML = '';
    setEditorEmpty(true);
    setPending((p) => { p.forEach((x) => URL.revokeObjectURL(x.url)); return []; });
    // Trả lời + tag thuộc về ĐÚNG hội thoại đang mở: giữ lại khi đổi hội thoại
    // là gửi trích dẫn của cuộc trò chuyện khác sang đây.
    setReplyTo(null);
    setMentions([]);
    setMentionOpen(false);
  }, []);

  const openCompose = useCallback(() => {
    setComposeOpen(true);
    zaloApiContacts(accountKey).then(setContacts).catch(() => setContacts([]));
  }, [accountKey]);

  const scan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    setScanNote('');
    try {
      const r = await zaloApiScan(accountKey);
      setThreads(r.threads);
      setScanNote(`Đã quét: ${r.groups} nhóm · ${r.friends} khách${r.note ? ` · ${r.note}` : ''}`);
    } catch (e) {
      setScanNote('Quét lỗi: ' + (e as Error).message);
    } finally {
      setScanning(false);
    }
  }, [accountKey, scanning]);

  const startNew = useCallback(() => {
    const id = newId.trim();
    if (!id) return;
    setActiveThread(id);
    setGroup(newGroup);
    setComposeOpen(false);
    setErr('');
  }, [newId, newGroup]);

  const refreshAfterSend = useCallback((dest: string) => {
    if (!dest) return;
    zaloApiHistory(accountKey, dest).then(setMessages).catch(() => { /* poll bắt kịp */ });
    zaloApiThreads(accountKey).then(setThreads).catch(() => { /* idem */ });
  }, [accountKey]);

  // Gán tag cho MỘT hội thoại bất kỳ (dùng chung: header + chuột phải ở list).
  const setTagsFor = useCallback(async (threadId: string, name: string, grp: boolean, tags: string[]) => {
    if (!threadId) return;
    try {
      await zaloApiSetTags({ accountKey, threadId, tags, name, group: grp });
      const list = await zaloApiThreads(accountKey);
      setThreads(list);
    } catch (e) { setErr((e as Error).message); }
  }, [accountKey]);

  // ĐÍNH KÈM (dán ảnh / chọn file bất kỳ) — chỉ nạp vào hàng chờ + xem trước,
  // KHÔNG gửi ngay. Ảnh đi đường photo, file thường đi đường asyncfile.
  const addPending = useCallback((file: File, fallbackName?: string) => {
    if (file.size > 100 * 1024 * 1024) {
      setErr(`"${file.name}" quá 100MB — gửi qua kênh khác.`);
      return;
    }
    const named = file.name ? file : new File([file], fallbackName || `screenshot_${Date.now()}.png`, { type: file.type || 'image/png' });
    const url = URL.createObjectURL(named);
    pendingSeq.current += 1;
    setPending((p) => [...p, { id: `att-${pendingSeq.current}`, file: named, url }]);
  }, []);

  const removePending = useCallback((id: string) => {
    setPending((p) => {
      const t = p.find((x) => x.id === id);
      if (t) URL.revokeObjectURL(t.url);
      return p.filter((x) => x.id !== id);
    });
  }, []);

  const send = useCallback(async () => {
    if (sending) return;
    const el = editorRef.current;
    const { text, styles } = el ? serializeStyled(el) : { text: '', styles: [] as { start: number; len: number; st: string }[] };
    const hasText = !!text.trim();
    if (!hasText && !pending.length) return;
    if (!activeThread) { setErr('Chọn hội thoại trước khi gửi.'); return; }
    if (!canSend) { setErr('Gửi đang tắt — đặt ZALOAPI_ALLOW_SEND=true trong .env.local.'); return; }
    setSending(true);
    setErr('');
    try {
      let dest = activeThread;
      if (pending.length) {
        // Gửi từng đính kèm: ảnh đi đường photo (có chú thích — chữ đang gõ
        // gắn vào ảnh ĐẦU TIÊN); file thường đi đường asyncfile (Zalo không
        // có chỗ caption cho file — chữ đang gõ được gửi thành tin riêng sau).
        let captionUsed = false;
        for (const p of pending) {
          const dataBase64 = await fileToBase64(p.file);
          if (p.file.type.startsWith('image/')) {
            const res = await zaloApiSendImage({
              accountKey, threadId: activeThread, group, dataBase64, fileName: p.file.name,
              caption: !captionUsed ? text.trim() : '',
            });
            captionUsed = captionUsed || !!text.trim();
            if (!res.ok) setErr(res.detail || 'gửi ảnh không thành công');
            dest = res.threadId || dest;
          } else {
            const res = await zaloApiSendFile({ accountKey, threadId: activeThread, group, dataBase64, fileName: p.file.name });
            if (!res.ok) setErr(res.detail || 'gửi file không thành công');
            dest = res.threadId || dest;
          }
        }
        // Toàn file thường mà có chữ đang gõ → gửi chữ thành tin riêng, không nuốt.
        if (text.trim() && !captionUsed) {
          const res = await zaloApiSendMessage({ accountKey, threadId: activeThread, text, group });
          if (!res.ok) setErr(res.detail || 'gửi không thành công');
          dest = res.threadId || dest;
        }
      } else {
        // Trả lời cần id THẬT của tin gốc. Tin gửi lạc quan (chưa có phản hồi
        // Zalo) và tin cũ lưu trước khi có field này đều thiếu — báo thẳng thay
        // vì gửi thành tin rời, vì "bấm trả lời mà ra tin thường" rất khó lần.
        let quote;
        if (replyTo) {
          if (!replyTo.zMsgId) {
            setErr('Tin này chưa có ID thật từ Zalo nên không trả lời được (thử tin mới hơn).');
            setSending(false);
            return;
          }
          quote = {
            msgId: replyTo.zMsgId,
            cliMsgId: replyTo.zCliMsgId || '',
            ownerId: replyTo.self ? '0' : replyTo.fromId,
            ts: replyTo.at,
            text: replyTo.text || '',
          };
        }
        const res = await zaloApiSendMessage({
          accountKey, threadId: activeThread, text, group,
          styles: styles.length ? styles : undefined,
          ...(mentions.length && group ? { mentions } : {}),
          ...(quote ? { quote } : {}),
        });
        if (!res.ok) setErr(res.detail || 'gửi không thành công');
        dest = res.threadId || dest;
      }
      pending.forEach((p) => URL.revokeObjectURL(p.url));
      setPending([]);
      setReplyTo(null);
      setMentions([]);
      if (el) { el.innerHTML = ''; setEditorEmpty(true); }
      refreshAfterSend(dest);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  }, [accountKey, activeThread, group, sending, canSend, pending, refreshAfterSend, replyTo, mentions]);

  // Áp định dạng cho vùng đang chọn trong editor (giữ focus bằng preventDefault).
  const applyFmt = useCallback((cmd: string, value?: string) => {
    const el = editorRef.current;
    if (el) el.focus();
    try { document.execCommand(cmd, false, value); } catch { /* trình duyệt cũ */ }
    setEditorEmpty(!el?.textContent?.trim());
  }, []);

  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  // Dán ẢNH/screenshot: nếu clipboard có ảnh → gửi ngay; chữ thì dán dạng thuần.
  const onEditorPaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imgItem = items.find((it) => it.type.startsWith('image/'));
    if (imgItem) {
      e.preventDefault();
      const file = imgItem.getAsFile();
      if (file) addPending(file, `screenshot_${Date.now()}.png`); // chỉ đính kèm, chờ Gửi
      return;
    }
    // Dán chữ: ép về plain text để không tha HTML rác vào editor.
    const text = e.clipboardData?.getData('text/plain');
    if (text) { e.preventDefault(); document.execCommand('insertText', false, text); }
  }, [addPending]);

  // Đính ảnh từ nút 📎 (chọn file) — cũng chỉ đính kèm, chờ Gửi.
  const onPickImage = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // cho phép chọn lại cùng file
    for (const f of files) addPending(f);
  }, [addPending]);

  // Kéo lịch sử cũ (chỉ nhóm có API; 1-1 Zalo không lộ endpoint).
  const loadOlder = useCallback(async () => {
    if (!activeThread || loadingOlder) return;
    setLoadingOlder(true);
    setOlderNote('');
    try {
      const res = await zaloApiLoadOlder(accountKey, activeThread, group);
      setMessages(res.messages);
      if (!res.supported) setOlderNote('Chat 1-1 không kéo được lịch sử cũ qua API — chỉ nhóm mới có. Tin 1-1 dựng dần từ lúc kết nối.');
    } catch (e) {
      setOlderNote((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }, [accountKey, activeThread, group, loadingOlder]);

  /**
   * Thả / đổi / bỏ cảm xúc. Bấm lại ĐÚNG mặt đang thả = bỏ (giống Zalo thật).
   * Server trả về danh sách tin đã cập nhật nên không cần tự sửa state tại chỗ.
   */
  const react = useCallback(async (m: ZaloStoredMessage, key: string) => {
    if (!activeThread || reactBusy) return;
    const mine = m.reactions?.['(self)'];
    const def = reactionByKey(key);
    const remove = !!mine && !!def && mine.rType === def.rType;
    setReactBusy(m.id);
    setErr('');
    try {
      const res = await zaloApiReact(accountKey, {
        threadId: activeThread,
        msgId: m.id,
        group,
        ...(remove ? { remove: true } : { key }),
      });
      setMessages(res.messages);
      if (!res.ok) setErr(res.detail || 'Thả cảm xúc thất bại.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setReactBusy('');
      setReactFor('');
      setReactAll(false);
    }
  }, [accountKey, activeThread, group, reactBusy]);

  if (!connected) {
    return (
      <div className="zc-empty">
        <div className="zc-empty-ico">💬</div>
        <p>Bấm <b>Kết nối</b> để nạp hội thoại. Tin sẽ hiện ở đây ngay khi có người nhắn tới.</p>
      </div>
    );
  }

  const activeSummary = threads.find((t) => t.threadId === activeThread);
  const headerName = activeSummary?.name || activeThread;
  const activeTags = activeSummary?.tags ?? [];

  // Tất cả tag đang có (cho thanh lọc) + danh sách hội thoại sau lọc (search + tag).
  const allTags = [...new Set(threads.flatMap((t) => t.tags ?? []))].sort((a, b) => a.localeCompare(b, 'vi'));
  const q = normText(search.trim());
  const visibleThreads = threads.filter((t) => {
    if (tagFilter && !(t.tags ?? []).includes(tagFilter)) return false;
    if (!q) return true;
    return normText(t.name).includes(q) || normText(t.lastText || '').includes(q);
  });

  // Tag của hội thoại đang mở menu chuột phải + gợi ý tag có sẵn để thêm nhanh.
  const menuTags = menu ? (threads.find((t) => t.threadId === menu.threadId)?.tags ?? []) : [];
  const quickTags = allTags.filter((t) => !menuTags.includes(t));

  const saveTags = (tags: string[]) => setTagsFor(activeThread, activeSummary?.name ?? '', group, tags);
  const addTag = () => {
    const t = tagInput.trim();
    setTagInput('');
    if (t && !activeTags.includes(t)) void saveTags([...activeTags, t]);
  };
  const removeTag = (t: string) => void saveTags(activeTags.filter((x) => x !== t));

  return (
    <div className="zc-wrap" data-active={active ? '1' : '0'} ref={rail.ref} style={rail.style}>
      {/* Cột trái — danh sách hội thoại */}
      <aside className="zc-list">
        <div className="zc-list-head">
          <span>Hội thoại</span>
          <span className="zc-list-headbtns">
            <button className="zc-new" title="Quét nhóm + khách từ Zalo về" onClick={() => void scan()} disabled={scanning}>
              {scanning ? '…' : '⟲'}
            </button>
            <button className="zc-new" title="Soạn hội thoại mới" onClick={openCompose}>＋</button>
          </span>
        </div>
        {scanNote && <div className="zc-scan-note">{scanNote}</div>}

        <div className="zc-search">
          <input
            className="zc-search-input"
            value={search}
            placeholder="🔎 Tìm tên hội thoại / nội dung…"
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && <button className="zc-search-clear" onClick={() => setSearch('')} title="Xoá tìm">✕</button>}
        </div>

        {allTags.length > 0 && (
          <div className="zc-tagbar">
            <button className={`zc-tagchip${!tagFilter ? ' is-on' : ''}`} onClick={() => setTagFilter('')}>Tất cả</button>
            {allTags.map((tg) => (
              <button key={tg} className={`zc-tagchip${tagFilter === tg ? ' is-on' : ''}`} onClick={() => setTagFilter(tagFilter === tg ? '' : tg)}>
                🏷 {tg}
              </button>
            ))}
          </div>
        )}

        {composeOpen && (
          <div className="zc-compose">
            <select
              className="zc-compose-sel"
              value=""
              onChange={(e) => {
                const c = contacts.find((x) => x.threadId === e.target.value);
                if (c) { setActiveThread(c.threadId); setGroup(c.group); setComposeOpen(false); }
              }}
            >
              <option value="">— chọn từ danh bạ đã học —</option>
              {contacts.map((c) => (
                <option key={c.threadId} value={c.threadId}>{c.group ? '👥 ' : ''}{c.name}</option>
              ))}
            </select>
            <div className="zc-compose-row">
              <input
                className="zc-compose-id"
                placeholder="hoặc gõ threadId thật…"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') startNew(); }}
              />
              <label className="zc-compose-grp"><input type="checkbox" checked={newGroup} onChange={(e) => setNewGroup(e.target.checked)} /> nhóm</label>
              <button className="zc-compose-go" onClick={startNew} disabled={!newId.trim()}>Mở</button>
            </div>
          </div>
        )}

        <div className="zc-list-body">
          {threads.length === 0 ? (
            <p className="zc-list-empty">Chưa có hội thoại nào. Bấm ⟲ để quét nhóm/khách về, hoặc chờ có tin đến.</p>
          ) : visibleThreads.length === 0 ? (
            <p className="zc-list-empty">Không có hội thoại khớp {search ? `“${search}”` : ''}{tagFilter ? ` · tag “${tagFilter}”` : ''}.</p>
          ) : (
            visibleThreads.map((t) => (
              <button
                key={t.threadId}
                className={`zc-item${t.threadId === activeThread ? ' is-active' : ''}`}
                onClick={() => openThread(t)}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ threadId: t.threadId, name: t.name, group: t.group, x: e.clientX, y: e.clientY }); setMenuTag(''); }}
              >
                <Avatar name={t.name} id={t.threadId} group={t.group} size={46} />
                <span className="zc-item-main">
                  <span className="zc-item-name">{t.name}</span>
                  <span className="zc-item-last">{t.lastText || '—'}</span>
                  {!!t.tags?.length && (
                    <span className="zc-item-tags">
                      {t.tags.map((tg) => <span key={tg} className="zc-item-tag">{tg}</span>)}
                    </span>
                  )}
                </span>
                <span className="zc-item-meta">
                  <span className="zc-item-time">{t.lastAt ? timeLabel(t.lastAt) : ''}</span>
                  {t.unread > 0 && <span className="zc-item-unread">{t.unread > 99 ? '99+' : t.unread}</span>}
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Cột phải — khung tin + ô soạn */}
      <section className="zc-thread">
        {!activeThread ? (
          <div className="zc-empty"><div className="zc-empty-ico">👈</div><p>Chọn một hội thoại để xem và trả lời.</p></div>
        ) : (
          <>
            <div className="zc-thread-head">
              <Avatar name={headerName} id={activeThread} group={group} size={40} />
              <span className="zc-thread-headtext">
                <span className="zc-thread-name">{headerName}</span>
                <span className="zc-thread-id" title="threadId thật">{group ? 'Nhóm · ' : ''}{activeThread}</span>
              </span>
              <span className="zc-thread-headspacer" />
              <button
                className={`zc-tagbtn${tagEditOpen ? ' is-on' : ''}`}
                onClick={() => setTagEditOpen((v) => !v)}
                title="Gán nhãn phân loại cho hội thoại này"
              >🏷 Tag{activeTags.length ? ` (${activeTags.length})` : ''}</button>
            </div>

            {tagEditOpen && (
              <div className="zc-tagedit">
                {activeTags.map((tg) => (
                  <span key={tg} className="zc-tagchip is-on">
                    🏷 {tg}
                    <button className="zc-tagx" onClick={() => removeTag(tg)} title="Bỏ tag">✕</button>
                  </span>
                ))}
                <input
                  className="zc-tagedit-input"
                  value={tagInput}
                  placeholder="thêm tag rồi Enter (vd: khách VIP)"
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
                />
                <button className="zc-tagedit-add" onClick={addTag} disabled={!tagInput.trim()}>Thêm</button>
              </div>
            )}

            <div className="zc-thread-body" ref={bodyRef}>
              <div className="zc-older">
                <button className="zc-older-btn" onClick={() => void loadOlder()} disabled={loadingOlder}>
                  {loadingOlder ? 'Đang tải…' : '⤒ Tải tin cũ'}
                </button>
                {olderNote && <span className="zc-older-note">{olderNote}</span>}
              </div>
              {messages.length === 0 ? (
                <p className="zc-thread-empty">Chưa có tin trong phiên này. Tin mới (và tin bạn gửi) sẽ hiện ở đây.</p>
              ) : (
                messages.map((m, i) => {
                  const prev = messages[i - 1];
                  const next = messages[i + 1];
                  const sameAs = (a?: ZaloStoredMessage) => !!a && a.self === m.self && a.fromId === m.fromId && Math.abs(m.at - a.at) < 5 * 60_000;
                  const startGroup = !sameAs(prev);
                  const endGroup = !sameAs(next);
                  const newDay = !prev || new Date(prev.at).toDateString() !== new Date(m.at).toDateString();
                  return (
                    <div key={m.id}>
                      {newDay && <div className="zc-day"><span>{dayLabel(m.at)}</span></div>}
                      <div className={`zc-row${m.self ? ' zc-row--me' : ''}${endGroup ? ' is-tail' : ''}`}>
                        {!m.self && (
                          <span className="zc-row-av">
                            {endGroup ? <Avatar name={m.fromName || headerName} id={m.fromId || activeThread} group={group && !m.fromId} size={30} /> : null}
                          </span>
                        )}
                        <div className="zc-row-main">
                          {!m.self && group && startGroup && m.fromName && <span className="zc-msg-from">{m.fromName}</span>}
                          {m.imageUrl ? (
                            <a className="zc-msg-img" href={m.imageUrl} target="_blank" rel="noreferrer">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={m.imageUrl} alt={m.text || 'ảnh'} loading="lazy" />
                            </a>
                          ) : (
                            <span className="zc-msg-bubble">{m.text}</span>
                          )}

                          {/* Nút mở bảng cảm xúc — chỉ hiện khi hover cả dòng
                              (CSS), để không làm rối màn chat.
                              KHÔNG ẩn nút theo zMsgId: tin lưu trước khi có field
                              đó (và tin cũ khôi phục từ kho) đều thiếu, ẩn đi là
                              MẤT HẲN thao tác trên gần hết màn chat. Thay vào đó
                              cứ cho bấm, server tự chặn và báo lý do nếu tin
                              không có id thật. */}
                          {canSend && (
                            <button
                              className="zc-react-open"
                              title="Thả cảm xúc"
                              onClick={() => {
                                setReactFor((v) => (v === m.id ? '' : m.id));
                                setReactAll(false);
                              }}
                            >☺</button>
                          )}

                          {/* TRẢ LỜI tin này. Chỉ hiện khi tin có id THẬT của
                              Zalo — khác với nút cảm xúc (cứ cho bấm rồi server
                              báo lỗi): ở đây thiếu id thì Zalo im lặng gửi thành
                              tin RỜI, không báo gì, nên chặn từ đầu rõ hơn. */}
                          {canSend && !!m.zMsgId && (
                            <button
                              className="zc-reply-open"
                              title="Trả lời tin này"
                              onClick={() => { setReplyTo(m); editorRef.current?.focus(); }}
                            >↩</button>
                          )}

                          {reactFor === m.id && (
                            <div className="zc-react-pop" role="menu">
                              {(reactAll ? REACTIONS : REACTIONS.filter((r) => QUICK_REACTION_KEYS.includes(r.key)))
                                .map((r) => {
                                  const on = m.reactions?.['(self)']?.rType === r.rType;
                                  return (
                                    <button
                                      key={r.key}
                                      className={`zc-react-pick${on ? ' is-on' : ''}`}
                                      title={on ? `${r.label} — bấm để bỏ` : r.label}
                                      disabled={reactBusy === m.id}
                                      onClick={() => void react(m, r.key)}
                                    >{r.emoji}</button>
                                  );
                                })}
                              {!reactAll && (
                                <button
                                  className="zc-react-more"
                                  title="Xem tất cả cảm xúc"
                                  onClick={() => setReactAll(true)}
                                >⋯</button>
                              )}
                            </div>
                          )}

                          {/* Cảm xúc ĐÃ THẢ, gom theo mặt + số người. */}
                          {m.reactions && Object.keys(m.reactions).length > 0 && (
                            <div className="zc-react-chips">
                              {Object.entries(
                                Object.values(m.reactions).reduce<Record<string, { emoji: string; n: number }>>((acc, v) => {
                                  const k = String(v.rType);
                                  acc[k] = { emoji: reactionEmoji(v.rType, v.icon), n: (acc[k]?.n ?? 0) + 1 };
                                  return acc;
                                }, {}),
                              ).map(([rType, v]) => {
                                const mineHere = m.reactions?.['(self)']?.rType === Number(rType);
                                return (
                                  <button
                                    key={rType}
                                    className={`zc-react-chip${mineHere ? ' is-mine' : ''}`}
                                    title={mineHere ? 'Bạn đã thả — bấm để bỏ' : `${v.n} người đã thả`}
                                    disabled={!canSend || reactBusy === m.id}
                                    onClick={() => {
                                      // Bấm chip của chính mình = bỏ. Chip của
                                      // người khác = thả cùng mặt đó.
                                      const def = REACTIONS.find((x) => x.rType === Number(rType));
                                      if (def) void react(m, def.key);
                                    }}
                                  >
                                    <span>{v.emoji}</span>
                                    {v.n > 1 && <b>{v.n}</b>}
                                  </button>
                                );
                              })}
                            </div>
                          )}

                          {endGroup && (
                            <span className="zc-msg-meta">
                              {timeLabel(m.at)}
                              {m.self && m.status === 'sending' && ' · đang gửi…'}
                              {m.self && m.status === 'failed' && ' · ✗ lỗi'}
                              {m.self && m.status === 'sent' && ' · ✓'}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {err && <div className="zc-err">{err}</div>}

            <div className="zc-composerwrap">
              <div className="zc-toolbar">
                <button className="zc-tb" title="Đậm" onMouseDown={(e) => { e.preventDefault(); applyFmt('bold'); }}><b>B</b></button>
                <button className="zc-tb" title="Nghiêng" onMouseDown={(e) => { e.preventDefault(); applyFmt('italic'); }}><i>I</i></button>
                <button className="zc-tb" title="Gạch dưới" onMouseDown={(e) => { e.preventDefault(); applyFmt('underline'); }}><u>U</u></button>
                <button className="zc-tb" title="Gạch ngang" onMouseDown={(e) => { e.preventDefault(); applyFmt('strikeThrough'); }}><s>S</s></button>
                <span className="zc-colorwrap">
                  <button className="zc-tb" title="Màu chữ" onMouseDown={(e) => { e.preventDefault(); setColorOpen((v) => !v); }}>🎨</button>
                  {colorOpen && (
                    <span className="zc-colors">
                      {ZALO_COLORS.filter((c) => c.hex).map((c) => (
                        <button
                          key={c.hex}
                          className="zc-swatch"
                          title={c.name}
                          style={{ background: `#${c.hex}` }}
                          onMouseDown={(e) => { e.preventDefault(); applyFmt('foreColor', `#${c.hex}`); setColorOpen(false); }}
                        />
                      ))}
                    </span>
                  )}
                </span>
                <button className="zc-tb" title="Xoá định dạng vùng chọn" onMouseDown={(e) => { e.preventDefault(); applyFmt('removeFormat'); }}>⌫</button>
              </div>
              {pending.length > 0 && (
                <div className="zc-attach">
                  {pending.map((p) => (
                    <span key={p.id} className="zc-attach-item" title={p.file.name}>
                      {p.file.type.startsWith('image/') ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.url} alt="đính kèm" />
                      ) : (
                        // File thường: không có gì để xem trước — chip tên + cỡ.
                        <span className="small" style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '6px 8px', maxWidth: 180, overflow: 'hidden',
                          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          📄 {p.file.name} · {p.file.size > 1024 * 1024
                            ? `${(p.file.size / 1024 / 1024).toFixed(1)}MB`
                            : `${Math.max(1, Math.round(p.file.size / 1024))}KB`}
                        </span>
                      )}
                      <button className="zc-attach-x" title="Bỏ đính kèm" onClick={() => removePending(p.id)}>✕</button>
                    </span>
                  ))}
                  <span className="zc-attach-hint">Enter hoặc bấm Gửi để gửi {pending.length} đính kèm</span>
                </div>
              )}
              {/* Đang TRẢ LỜI tin nào — hiện ngay trên ô soạn để không gửi
                  nhầm trích dẫn sau khi đã cuộn đi chỗ khác. */}
              {replyTo && (
                <div className="zc-reply-bar">
                  <span className="zc-reply-ico" aria-hidden>↩</span>
                  <span className="zc-reply-body">
                    <b>{replyTo.self ? 'Bạn' : (replyTo.fromName || replyTo.fromId || 'ẩn danh')}</b>
                    <span className="zc-reply-text">{replyTo.text || (replyTo.imageUrl ? '[ảnh]' : '[tin]')}</span>
                  </span>
                  <button className="zc-reply-x" title="Bỏ trả lời" onClick={() => setReplyTo(null)}>✕</button>
                </div>
              )}

              {/* TAG người trong nhóm. Chỉ hiện với hội thoại NHÓM: tin 1-1 thì
                  người nhận đã là chính người đó, thêm @ chỉ gây rối (server
                  cũng bỏ qua mentions của tin 1-1). */}
              {group && canSend && (
                <div className="zc-mention-bar">
                  <button
                    className="zc-mention-open"
                    title="Tag (@) người trong nhóm — Zalo sẽ báo riêng cho họ"
                    onClick={() => {
                      setMentionOpen((v) => !v);
                      // Danh bạ nạp lười: chỉ tốn một request khi thật sự mở.
                      if (!contacts.length) zaloApiContacts(accountKey).then(setContacts).catch(() => {});
                    }}
                  >@ Tag</button>
                  {mentions.map((p) => (
                    <span key={p.uid} className="zc-mention-chip" title={p.uid}>
                      @{p.name || p.uid}
                      <button onClick={() => setMentions((v) => v.filter((x) => x.uid !== p.uid))} title="Bỏ tag">✕</button>
                    </span>
                  ))}
                  {mentionOpen && (
                    <div className="zc-mention-pop" role="menu">
                      {/* Gợi ý từ CHÍNH những người đã nhắn trong nhóm này —
                          danh bạ Zalo không cho biết thành viên nhóm, nên đây là
                          nguồn uid thật đáng tin nhất đang có. */}
                      {[...new Map(
                        messages
                          .filter((x) => !x.self && x.fromId)
                          .map((x) => [x.fromId, { uid: x.fromId, name: x.fromName || x.fromId }]),
                      ).values()]
                        .filter((p) => !mentions.some((x) => x.uid === p.uid))
                        .slice(0, 30)
                        .map((p) => (
                          <button
                            key={p.uid}
                            className="zc-mention-item"
                            onClick={() => {
                              // Trần 5 người: hơn nữa là ping cả nhóm, phiền hơn
                              // là hữu ích (server cũng cắt ở 5).
                              setMentions((v) => (v.length >= 5 ? v : [...v, p]));
                              setMentionOpen(false);
                              editorRef.current?.focus();
                            }}
                          >
                            @{p.name}
                          </button>
                        ))}
                      {!messages.some((x) => !x.self && x.fromId) && (
                        <span className="zc-mention-empty">
                          Chưa ai nhắn trong nhóm này ở phiên hiện tại — chưa có uid để tag.
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="zc-composer">
                <input ref={fileRef} type="file" multiple hidden onChange={(e) => void onPickImage(e)} />
                <button
                  className="zc-composer-attach"
                  title="Đính kèm ảnh hoặc file bất kỳ (≤100MB). Ảnh mang chú thích từ ô soạn; file thường gửi kèm chữ thành tin riêng"
                  onClick={() => fileRef.current?.click()}
                  disabled={!canSend || sending}
                >📎</button>
                <div className="zc-editor-box">
                  <div
                    ref={editorRef}
                    className="zc-editor"
                    contentEditable={canSend}
                    suppressContentEditableWarning
                    onInput={() => setEditorEmpty(!editorRef.current?.textContent?.trim())}
                    onKeyDown={onEditorKeyDown}
                    onPaste={onEditorPaste}
                  />
                  {editorEmpty && (
                    <span className="zc-editor-ph">
                      {canSend ? 'Nhập tin… (Enter gửi · Shift+Enter xuống dòng · dán ảnh để gửi)' : 'Gửi đang tắt — bật ZALOAPI_ALLOW_SEND'}
                    </span>
                  )}
                </div>
                <button className="zc-composer-send" onClick={() => void send()} disabled={!canSend || sending || (editorEmpty && pending.length === 0)}>
                  {sending ? '…' : 'Gửi'}
                </button>
              </div>
            </div>
          </>
        )}
      </section>

      {/* Menu chuột phải — gán tag cho hội thoại bất kỳ ngay ở danh sách. */}
      {menu && (
        <div className="zc-ctx-overlay" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}>
          <div className="zc-ctx" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
            <div className="zc-ctx-title">🏷 Gán tag · {menu.name}</div>
            <div className="zc-ctx-tags">
              {menuTags.length === 0 && <span className="zc-ctx-empty">chưa có tag</span>}
              {menuTags.map((tg) => (
                <span key={tg} className="zc-tagchip is-on">
                  🏷 {tg}
                  <button className="zc-tagx" onClick={() => void setTagsFor(menu.threadId, menu.name, menu.group, menuTags.filter((x) => x !== tg))}>✕</button>
                </span>
              ))}
            </div>
            <input
              className="zc-tagedit-input"
              value={menuTag}
              placeholder="thêm tag rồi Enter…"
              autoFocus
              onChange={(e) => setMenuTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const t = menuTag.trim();
                  setMenuTag('');
                  if (t && !menuTags.includes(t)) void setTagsFor(menu.threadId, menu.name, menu.group, [...menuTags, t]);
                } else if (e.key === 'Escape') { setMenu(null); }
              }}
            />
            {quickTags.length > 0 && (
              <div className="zc-ctx-quick">
                {quickTags.map((tg) => (
                  <button key={tg} className="zc-tagchip" onClick={() => void setTagsFor(menu.threadId, menu.name, menu.group, [...menuTags, tg])}>+ {tg}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Thanh kéo giữa danh sách hội thoại và khung chat. Con CUỐI của .zc-wrap
          (nó position:absolute nên không đẻ thêm ô cho grid). */}
      <Splitter {...rail.grip} />
    </div>
  );
}
