/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output makes the "deploy later" path (Docker/k8s) trivial.
  output: 'standalone',
};

module.exports = nextConfig;
