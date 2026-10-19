// Trang của bảng dịch nổi — nạp vào WebContentsView riêng mà electron/main.cjs
// (attachTranslateFloat) đặt chồng lên cửa sổ. Không mở trang này trực tiếp.

import TranslateFloat from '@/components/TranslateFloat';

export default function TranslateFloatPage() {
  return <TranslateFloat />;
}
