// Zalo API (thử nghiệm) — đọc width/height/size của ảnh từ BUFFER, tự làm.
//
// zca-js không tự đọc kích thước ảnh: nó bắt caller cấp `imageMetadataGetter`.
// Ta chạy server-side (Node) và không muốn kéo thêm thư viện ảnh, nên tự đọc
// header các định dạng phổ biến (PNG/JPEG/GIF/WebP/BMP). Zalo cần width/height
// trong payload gửi ảnh; đọc sai thì ảnh có thể hiển thị méo, nên cố đọc đúng,
// và trả 0 khi không nhận dạng được (Zalo vẫn nhận, chỉ mất kích thước gợi ý).

export interface ImageMeta {
  width: number;
  height: number;
  /** Kích thước file (byte) = độ dài buffer. */
  totalSize: number;
}

/** Đọc kích thước ảnh từ buffer. Không nhận dạng được → width/height = 0. */
export function readImageMeta(buf: Buffer): ImageMeta {
  const totalSize = buf.length;
  const wh = dimensions(buf);
  return { width: wh?.w ?? 0, height: wh?.h ?? 0, totalSize };
}

function dimensions(b: Buffer): { w: number; h: number } | null {
  if (b.length < 24) return null;

  // PNG: 8-byte sig, rồi IHDR với width/height big-endian tại offset 16/20.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }

  // GIF: "GIF87a"/"GIF89a", width/height little-endian tại offset 6/8.
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  }

  // BMP: "BM", width/height little-endian tại offset 18/22.
  if (b[0] === 0x42 && b[1] === 0x4d) {
    return { w: b.readUInt32LE(18), h: b.readUInt32LE(22) };
  }

  // WebP: "RIFF"...."WEBP". Ba biến thể: VP8 / VP8L / VP8X.
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const fmt = b.toString('ascii', 12, 16);
    if (fmt === 'VP8 ' && b.length >= 30) return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (fmt === 'VP8L' && b.length >= 25) {
      const bits = b.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fmt === 'VP8X' && b.length >= 30) {
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { w, h };
    }
  }

  // JPEG: quét các marker SOF (0xFFC0..0xFFCF trừ C4/C8/CC) để lấy height/width.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const marker = b[o + 1];
      // SOF markers mang kích thước; loại trừ các marker không phải SOF.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: b.readUInt16BE(o + 5), w: b.readUInt16BE(o + 7) };
      }
      // Nhảy qua segment theo độ dài của nó.
      const len = b.readUInt16BE(o + 2);
      if (len < 2) break;
      o += 2 + len;
    }
  }

  return null;
}
