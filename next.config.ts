import type { NextConfig } from "next";

const config: NextConfig = {
  // CV uploads go through a server action; default limit is 1MB.
  experimental: { serverActions: { bodySizeLimit: "4.5mb" } },
};

export default config;
