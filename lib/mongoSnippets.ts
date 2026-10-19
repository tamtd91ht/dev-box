// lib/mongoSnippets.ts — các khung JSON dựng sẵn của thanh snippet ô query Mongo.
//
// VÌ SAO KHÔNG ĐẾM TAY VỊ TRÍ CON TRỎ NỮA: khuôn trước đây mang kèm
// `caretOffset: 21` / `selectLen: 7` — những con số phải đếm bằng mắt qua cả
// `\n` lẫn dấu nháy. Đếm hụt một ô thì con trỏ rơi RA NGOÀI chuỗi, gõ tiếp là
// ra `{"_id": {"$oid": email"" }}` — nhìn thì vẫn giống đang chạy tốt. Đã có
// vài khuôn lệch đúng kiểu đó.
//
// Nên khuôn giờ tự đánh dấu ngay trong chuỗi:
//   `|`   — chỗ đặt con trỏ.
//   `«…»` — đoạn bôi đen sẵn (gõ là thay luôn). Luôn đặt bên TRONG dấu nháy,
//           để gõ đè xong vẫn còn nguyên nháy: `"«field»"` → gõ `email` ra
//           `"email"`, không phải `email`.
// `expandSnippet` bóc dấu và tính offset; scripts/check-mongo-query.ts soát
// rằng mọi khuôn đều parse được và con trỏ luôn rơi vào chỗ gõ tiếp được.

export interface Snippet {
  label: string;
  title: string;
  /** Khuôn CÓ ĐÁNH DẤU (`|`, `«…»`) — đừng chèn thẳng, phải qua expandSnippet. */
  src: string;
}

export interface SnippetInsert {
  /** Text thật sự chèn vào ô (đã bóc hết dấu đánh dấu). */
  text: string;
  /** Vị trí con trỏ TRONG `text`. */
  caret: number;
  /** Số ký tự bôi đen từ `caret` — gõ là thay luôn. 0 = không bôi đen. */
  selectLen: number;
}

/** Bóc dấu `|` / `«…»` khỏi khuôn, trả text sạch + vị trí con trỏ. */
export function expandSnippet(src: string): SnippetInsert {
  const sel = src.indexOf('«');
  if (sel >= 0) {
    const end = src.indexOf('»', sel);
    const word = src.slice(sel + 1, end);
    return { text: src.slice(0, sel) + word + src.slice(end + 1), caret: sel, selectLen: word.length };
  }
  const caret = src.indexOf('|');
  if (caret < 0) return { text: src, caret: src.length, selectLen: 0 };
  return { text: src.slice(0, caret) + src.slice(caret + 1), caret, selectLen: 0 };
}

/**
 * Khung cho ô Filter. Tên field cụ thể do autocomplete lo, nên ở đây dùng
 * `field` làm chỗ giữ chỗ và bôi đen sẵn để gõ đè.
 */
export const FILTER_SNIPPETS: Snippet[] = [
  { label: '{ }', title: 'Khung filter rỗng — gõ tên field để gợi ý hiện lên', src: '{\n  |\n}' },
  { label: 'field = value', title: 'So khớp bằng', src: '{\n  "«field»": ""\n}' },
  { label: '$and', title: 'Nhiều điều kiện cùng đúng', src: '{\n  "$and": [\n    { | },\n    {  }\n  ]\n}' },
  { label: '$or', title: 'Một trong các điều kiện', src: '{\n  "$or": [\n    { | },\n    {  }\n  ]\n}' },
  { label: '$in', title: 'Thuộc danh sách giá trị', src: '{\n  "«field»": { "$in": [] }\n}' },
  { label: '$regex', title: 'Khớp chuỗi (i = không phân biệt hoa thường)', src: '{\n  "«field»": { "$regex": "", "$options": "i" }\n}' },
  { label: 'khoảng số', title: 'Lớn hơn / nhỏ hơn', src: '{\n  "«field»": { "$gte": 0, "$lte": 0 }\n}' },
  { label: 'khoảng ngày', title: 'Lọc theo mốc thời gian (EJSON $date)', src: '{\n  "«createdAt»": { "$gte": { "$date": "2026-01-01T00:00:00Z" } }\n}' },
  { label: '_id', title: 'Tìm theo ObjectId', src: '{\n  "_id": { "$oid": "|" }\n}' },
  { label: '$exists', title: 'Field có / không tồn tại', src: '{\n  "«field»": { "$exists": true }\n}' },
];

/** Khung cho ô Pipeline (aggregate). */
export const PIPELINE_SNIPPETS: Snippet[] = [
  { label: '[ ]', title: 'Khung pipeline rỗng', src: '[\n  |\n]' },
  { label: '$match', title: 'Lọc trước khi gom', src: '[\n  { "$match": { | } }\n]' },
  { label: '$group', title: 'Gom nhóm + đếm', src: '[\n  { "$group": { "_id": "$«field»", "n": { "$sum": 1 } } }\n]' },
  { label: '$sort + $limit', title: 'Sắp xếp rồi cắt', src: '[\n  { "$sort": { "«field»": -1 } },\n  { "$limit": 20 }\n]' },
  { label: '$project', title: 'Chọn cột trả về', src: '[\n  { "$project": { "_id": 0, "«field»": 1 } }\n]' },
  { label: '$unwind', title: 'Bung mảng thành nhiều dòng', src: '[\n  { "$unwind": "$«field»" }\n]' },
  {
    label: '$lookup',
    title: 'Join sang collection khác',
    src: '[\n  {\n    "$lookup": {\n      "from": "|",\n      "localField": "",\n      "foreignField": "_id",\n      "as": "joined"\n    }\n  }\n]',
  },
  {
    label: 'đếm theo nhóm',
    title: 'Mẫu hay dùng: match → group → sort',
    src: '[\n  { "$match": { | } },\n  { "$group": { "_id": "$field", "n": { "$sum": 1 } } },\n  { "$sort": { "n": -1 } }\n]',
  },
];
