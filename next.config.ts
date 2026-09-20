import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep verification builds separate from an already-running developer server.
  distDir: process.env.SKIM_NEXT_DIST_DIR || ".next",
};

export default nextConfig;
