import { defineConfig } from "vitest/config";

// Keep Vitest from loading the Cloudflare Vite application config. These tests
// run in Node and do not need the worker runtime plugin.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
