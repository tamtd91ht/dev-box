// Next.js server-boot hook (chạy MỘT lần khi server khởi động) — khởi động
// các tiến trình nền: tự pull Git cho mọi project + đếm mail chưa đọc.
// Guard NEXT_RUNTIME: hook này cũng được gọi cho edge runtime, nơi không có
// child_process / socket thô.

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureAutoPull } = await import('./lib/gitAutoPull');
    ensureAutoPull();
    const { ensureMailWatch } = await import('./lib/mailWatch');
    ensureMailWatch();
  }
}
