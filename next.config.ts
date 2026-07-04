import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  devIndicators: {
    position: "top-right",
  },
};

export default nextConfig;
