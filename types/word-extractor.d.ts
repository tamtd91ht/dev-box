// word-extractor 1.x không kèm kiểu — chỉ phần lib/fileText.ts dùng (đọc .doc Word 97-2003).
declare module 'word-extractor' {
  interface WordDocument {
    getBody(): string;
  }
  export default class WordExtractor {
    extract(source: string | Buffer): Promise<WordDocument>;
  }
}
