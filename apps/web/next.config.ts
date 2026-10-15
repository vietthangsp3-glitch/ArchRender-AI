import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  transpilePackages: [
    "@archrender/ui",
    "@archrender/config",
    "@archrender/schemas",
    "@archrender/database",
    "@archrender/auth",
    "@archrender/assets",
    "@archrender/jobs",
    "@archrender/projects",
  ],
  poweredByHeader: false,
};

export default nextConfig;
