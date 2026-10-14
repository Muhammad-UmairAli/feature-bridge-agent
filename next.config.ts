import type { NextConfig } from "next";

// Security headers for every response. A full script Content-Security-Policy
// needs nonces or hashes for Next.js's inline scripts and is added separately;
// frame-ancestors alone is safe to enforce now and blocks clickjacking of the
// request form (including tricking visitors into solving the bot check).
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Tracking pages are reachable by id; keep them out of search indexes.
      {
        source: "/requests/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
};

export default nextConfig;
