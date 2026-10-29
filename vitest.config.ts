import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    env: loadEnv("test", import.meta.dirname, ""), // reads .env.local (local Supabase + optional API keys)
    fileParallelism: false, // tests share one local database and app_settings row
    testTimeout: 30000,
  },
});
