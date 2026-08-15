const os = require('os');

// Thư mục home (dạng posix) — pattern loại khỏi output file tracing bên dưới.
const HOME_GLOB = os.homedir().replace(/\\/g, '/') + '/**';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output makes the "deploy later" path (Docker/k8s) trivial.
  output: 'standalone',

  // VÌ SAO PHẢI LOẠI HOME KHỎI TRACE: @vercel/nft (chạy trong `next build` để
  // gom file cho server) tính tĩnh được `os.homedir()` + `path.join`, nên các
  // đường dẫn trong lib/configSync.ts (.dev-box-config, devbox-push-*.tar…)
  // thành "asset thư mục" và nft glob ĐỆ QUY cả C:\Users\<user> để gom chúng.
  // Trên Windows, glob đó đụng junction 'Application Data' (mặc định cấm
  // scandir) → EPERM → build chết ngay ở bước webpack. Trên Linux/Docker thì
  // home đọc được nên chưa bao giờ lộ. Home là dữ liệu runtime theo máy, không
  // bao giờ là asset của app → loại khỏi trace là đúng bản chất, ở CẢ HAI pha:
  //   1. pha collect-build-traces — nhận pattern qua outputFileTracingExcludes
  outputFileTracingExcludes: { '*': [HOME_GLOB] },
  //   2. pha webpack (TraceEntryPointsPlugin) — không có config chính thức
  //      (traceIgnores bị hardcode []), nhưng instance plugin nằm ngay trong
  //      config.plugins và đọc this.traceIgnores lúc chạy → đẩy pattern vào đó.
  webpack(config, { isServer }) {
    if (isServer) {
      for (const plugin of config.plugins || []) {
        if (plugin && plugin.constructor && plugin.constructor.name === 'TraceEntryPointsPlugin') {
          plugin.traceIgnores.push(HOME_GLOB);
        }
      }
    }
    return config;
  },
};

module.exports = nextConfig;
