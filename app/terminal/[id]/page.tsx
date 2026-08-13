// Cửa sổ rời của một phiên terminal.
//
// Trang này CỐ Ý rất mỏng: chỉ một khung xterm full màn hình gắn vào phiên đã
// có sẵn trên server. Nó KHÔNG tạo phiên và KHÔNG giết phiên khi đóng — đóng
// cửa sổ chỉ là ngắt một subscriber SSE. Đó là lý do app crash/tắt vẫn giữ
// nguyên phiên: shell là con của tiến trình Next server, không phải của cửa sổ.

import TerminalWindow from '@/components/terminal/TerminalWindow';

export default async function TerminalWindowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TerminalWindow id={id} />;
}
