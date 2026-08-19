// Extension mẫu cho tab Browser của DevBox.
//
// MỤC ĐÍCH: chứng minh content script thật sự chạy, và làm khung sườn để bạn
// chép ra viết cái của mình. Nó chỉ gắn một huy hiệu nhỏ ở góc phải dưới rồi
// tự mờ đi — không đụng vào nội dung trang.
//
// VÌ SAO CHỈ CÓ CONTENT SCRIPT: Electron chạy content script trong <webview>
// rất tốt, nhưng KHÔNG có chrome.tabs / chrome.webRequest / nút trên thanh
// công cụ. Viết extension cho DevBox thì bám vào content script + chrome.storage
// là chạy chắc; động vào mấy API kia là hỏng.

(function () {
  // Trang có thể là iframe quảng cáo, khung ẩn, about:blank… — chỉ gắn vào
  // document chính, nếu không mỗi trang sẽ mọc ra chục cái huy hiệu.
  if (window.top !== window.self) return;
  if (!document.body) return;

  const ID = 'hello-devbox-badge';
  if (document.getElementById(ID)) return;          // đã chạy rồi (SPA điều hướng lại)

  const el = document.createElement('div');
  el.id = ID;
  el.textContent = '🧩 DevBox extension đang chạy';
  document.body.appendChild(el);

  // Tự biến mất sau 4 giây: đây là dấu hiệu "có chạy", không phải thanh công cụ.
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 600);
  }, 4000);
})();
