import type { NextConfig } from "next";

const apiBaseUrl = resolveApiBaseUrl(process.env.API_BASE_URL);
const distDir = process.env.NEXT_DIST_DIR?.trim() || ".next";

const nextConfig: NextConfig = {
  agentRules: false,
  distDir,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiBaseUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;

function resolveApiBaseUrl(value: string | undefined): string {
  const candidate = value?.trim() || "http://localhost:3001";
  const url = new URL(candidate);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("API_BASE_URL 必须是无账号信息的 HTTP(S) 地址");
  }
  return url.toString().replace(/\/$/u, "");
}
