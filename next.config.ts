import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  devIndicators: {
    position: "top-right",
  },
  // The OAuth discovery documents live at spec-fixed `/.well-known/*` URLs, but
  // Next ignores dot-prefixed folders as route segments, so map them to real
  // route handlers under /api/oauth instead.
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/oauth/authorization-server-metadata",
      },
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/oauth/protected-resource-metadata",
      },
    ];
  },
};

export default nextConfig;
