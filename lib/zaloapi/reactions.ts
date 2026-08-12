// Zalo API (thử nghiệm) — BẢNG CẢM XÚC (reaction) dùng chung server + client.
//
// Port từ zca-js (src/models/Reaction.ts + src/apis/addReaction.ts). Mỗi cảm xúc
// cần ĐÚNG BA thứ khi gửi lên Zalo:
//   · rIcon  chuỗi emoticon kiểu Zalo, vd '/-heart', ':>' — CHÍNH nó hiện lên
//            trên tin ở app Zalo thật.
//   · rType  mã số của cảm xúc. KHÔNG theo thứ tự nào cả (HAHA=0, LIKE=3,
//            HEART=5, ROSE=120…) nên phải tra bảng, đừng tự suy.
//   · source luôn 6 cho mọi cảm xúc gửi từ web.
// Gửi sai rType thì Zalo nhận nhưng hiện SAI mặt — nên bảng này là bản chép
// nguyên, không phải bản tự đặt.
//
// Bỏ reaction: gửi lại chính tin đó với rType = -1 (xem UNREACT) — Zalo coi đó
// là "thu hồi cảm xúc", không có endpoint xoá riêng.
//
// Danh sách đầy đủ của zca-js có 54 mục; ở đây giữ TẤT CẢ để người dùng chọn
// được mọi mặt, nhưng QUICK_REACTIONS là 6 mặt hay dùng để hiện thành hàng nút
// bấm nhanh (giống Zalo/Messenger) — phần còn lại nằm trong bảng mở rộng.

export interface ReactionDef {
  /** Khoá ổn định dùng trong API nội bộ + lưu trữ. */
  key: string;
  /** Nhãn tiếng Việt hiện trên tooltip/menu. */
  label: string;
  /** Emoji xấp xỉ để VẼ trong UI của ta (Zalo dùng bộ sticker riêng). */
  emoji: string;
  /** rIcon — chuỗi emoticon Zalo gửi lên API. */
  icon: string;
  /** rType — mã số Zalo. */
  rType: number;
}

/** source cố định cho reaction gửi từ web (zca-js dùng 6 cho mọi mặt). */
export const REACTION_SOURCE = 6;

/** rType đặc biệt nghĩa là BỎ cảm xúc đã thả. */
export const UNREACT_RTYPE = -1;

/**
 * Toàn bộ cảm xúc, thứ tự như zca-js. `key` là tên enum viết thường-gạch-nối.
 */
export const REACTIONS: ReactionDef[] = [
  { key: 'heart', label: 'Tim', emoji: '❤️', icon: '/-heart', rType: 5 },
  { key: 'like', label: 'Thích', emoji: '👍', icon: '/-strong', rType: 3 },
  { key: 'haha', label: 'Haha', emoji: '😆', icon: ':>', rType: 0 },
  { key: 'wow', label: 'Wow', emoji: '😮', icon: ':o', rType: 32 },
  { key: 'cry', label: 'Buồn', emoji: '😢', icon: ':-((', rType: 2 },
  { key: 'angry', label: 'Tức giận', emoji: '😡', icon: ':-h', rType: 20 },
  { key: 'kiss', label: 'Nụ cười', emoji: '😘', icon: ':-*', rType: 8 },
  { key: 'tears-of-joy', label: 'Cười ra nước mắt', emoji: '🤣', icon: ":')", rType: 7 },
  { key: 'shit', label: 'Bãi phân', emoji: '💩', icon: '/-shit', rType: 66 },
  { key: 'rose', label: 'Hoa hồng', emoji: '🌹', icon: '/-rose', rType: 120 },
  { key: 'broken-heart', label: 'Tim tan vỡ', emoji: '💔', icon: '/-break', rType: 65 },
  { key: 'dislike', label: 'Không thích', emoji: '👎', icon: '/-weak', rType: 4 },
  { key: 'love', label: 'Yêu', emoji: '😍', icon: ';xx', rType: 29 },
  { key: 'confused', label: 'Bối rối', emoji: '😕', icon: ';-/', rType: 51 },
  { key: 'wink', label: 'Nháy mắt', emoji: '😉', icon: ';-)', rType: 45 },
  { key: 'fade', label: 'Phai nhạt', emoji: '🥀', icon: '/-fade', rType: 121 },
  { key: 'sun', label: 'Nắng', emoji: '☀️', icon: '/-li', rType: 67 },
  { key: 'birthday', label: 'Sinh nhật', emoji: '🎂', icon: '/-bd', rType: 126 },
  { key: 'bomb', label: 'Bom', emoji: '💣', icon: '/-bome', rType: 127 },
  { key: 'ok', label: 'OK', emoji: '👌', icon: '/-ok', rType: 68 },
  { key: 'peace', label: 'Hoà bình', emoji: '✌️', icon: '/-v', rType: 69 },
  { key: 'thanks', label: 'Cảm ơn', emoji: '🙏', icon: '/-thanks', rType: 70 },
  { key: 'punch', label: 'Đấm', emoji: '👊', icon: '/-punch', rType: 71 },
  { key: 'share', label: 'Chia sẻ', emoji: '🤝', icon: '/-share', rType: 72 },
  { key: 'pray', label: 'Cầu nguyện', emoji: '🛐', icon: '_()_', rType: 73 },
  { key: 'no', label: 'Không', emoji: '🚫', icon: '/-no', rType: 131 },
  { key: 'bad', label: 'Tệ', emoji: '🙁', icon: '/-bad', rType: 132 },
  { key: 'love-you', label: 'Yêu bạn', emoji: '🥰', icon: '/-loveu', rType: 133 },
  { key: 'sad', label: 'Rầu', emoji: '😔', icon: '--b', rType: 1 },
  { key: 'very-sad', label: 'Rất buồn', emoji: '☹️', icon: ':(', rType: 16 },
  { key: 'cool', label: 'Ngầu', emoji: '😎', icon: 'x-)', rType: 21 },
  { key: 'nerd', label: 'Nghiêm túc', emoji: '🤓', icon: '8-)', rType: 22 },
  { key: 'big-smile', label: 'Cười tươi', emoji: '😃', icon: ';-d', rType: 23 },
  { key: 'sunglasses', label: 'Kính râm', emoji: '🕶️', icon: 'b-)', rType: 26 },
  { key: 'neutral', label: 'Bình thường', emoji: '😐', icon: ':--|', rType: 30 },
  { key: 'sad-face', label: 'Mặt buồn', emoji: '😖', icon: 'p-(', rType: 35 },
  { key: 'bye', label: 'Chào', emoji: '👋', icon: ':-bye', rType: 36 },
  { key: 'sleepy', label: 'Buồn ngủ', emoji: '😪', icon: '|-)', rType: 38 },
  { key: 'wipe', label: 'Lau mồ hôi', emoji: '😅', icon: ':wipe', rType: 39 },
  { key: 'dig', label: 'Đào', emoji: '⛏️', icon: ':-dig', rType: 42 },
  { key: 'anguish', label: 'Đau khổ', emoji: '😩', icon: '&-(', rType: 44 },
  { key: 'handclap', label: 'Vỗ tay', emoji: '👏', icon: ':handclap', rType: 46 },
  { key: 'angry-face', label: 'Mặt giận', emoji: '😠', icon: '>-|', rType: 47 },
  { key: 'f-chair', label: 'Ghế trước', emoji: '🪑', icon: ':-f', rType: 48 },
  { key: 'l-chair', label: 'Ghế trái', emoji: '🪑', icon: ':-l', rType: 49 },
  { key: 'r-chair', label: 'Ghế phải', emoji: '🪑', icon: ':-r', rType: 50 },
  { key: 'silent', label: 'Im lặng', emoji: '🤐', icon: ';-x', rType: 52 },
  { key: 'surprise', label: 'Ngạc nhiên', emoji: '😯', icon: ':-o', rType: 53 },
  { key: 'embarrassed', label: 'Ngượng', emoji: '😳', icon: ';-s', rType: 54 },
  { key: 'afraid', label: 'Sợ', emoji: '😨', icon: ';-a', rType: 60 },
  { key: 'sad2', label: 'Ủ rũ', emoji: '🙁', icon: ':-<', rType: 61 },
  { key: 'big-laugh', label: 'Cười to', emoji: '😂', icon: ':))', rType: 62 },
  { key: 'rich', label: 'Giàu', emoji: '🤑', icon: '$-)', rType: 63 },
  { key: 'beer', label: 'Bia', emoji: '🍺', icon: '/-beer', rType: 99 },
];

/** 6 mặt hiện thành hàng nút bấm nhanh khi hover một tin. */
export const QUICK_REACTION_KEYS = ['heart', 'like', 'haha', 'wow', 'cry', 'angry'];

const BY_KEY = new Map(REACTIONS.map((r) => [r.key, r]));
/** Tra ngược từ rType (dùng khi ĐỌC reaction người khác thả từ listener). */
const BY_RTYPE = new Map(REACTIONS.map((r) => [r.rType, r]));
/** Tra ngược từ rIcon — payload Zalo có khi chỉ mang icon, không mang rType. */
const BY_ICON = new Map(REACTIONS.map((r) => [r.icon, r]));

export function reactionByKey(key: string): ReactionDef | undefined {
  return BY_KEY.get(key);
}

/**
 * Nhận diện một cảm xúc từ payload Zalo. Ưu tiên rType (chắc chắn hơn), rơi về
 * icon. Không nhận ra thì trả undefined để tầng trên hiện icon thô — thà hiện
 * lạ còn hơn nuốt mất một reaction có thật.
 */
export function reactionFrom(rType: unknown, icon: unknown): ReactionDef | undefined {
  const n = Number(rType);
  if (Number.isFinite(n) && BY_RTYPE.has(n)) return BY_RTYPE.get(n);
  if (typeof icon === 'string' && BY_ICON.has(icon)) return BY_ICON.get(icon);
  return undefined;
}

/** Emoji để VẼ một reaction đã biết rType/icon (rơi về chính icon nếu lạ). */
export function reactionEmoji(rType: unknown, icon: unknown): string {
  const def = reactionFrom(rType, icon);
  if (def) return def.emoji;
  return typeof icon === 'string' && icon ? icon : '•';
}
