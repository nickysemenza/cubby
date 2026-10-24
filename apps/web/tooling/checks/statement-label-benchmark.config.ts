import { resolve } from "node:path";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { defineConfig } from "vitest/config";

// Explicit performance experiment: no ordinary test discovery, services, resets,
// Worker configuration, or provider credentials are loaded by this entrypoint.
export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  resolve: {
    alias: {
      "~/": resolve(import.meta.dirname, "../../src/") + "/",
      "tooling/": resolve(import.meta.dirname, "../") + "/",
    },
  },
  test: {
    include: ["tooling/checks/statement-label.benchmark.ts"],
    pool: "forks",
    maxWorkers: 1,
    execArgv: ["--expose-gc"],
    testTimeout: 180_000,
    env: {
      NODE_ENV: "test",
      SKIP_ENV_VALIDATION: "1",
      DATABASE_URL:
        "postgresql://postgres:password@127.0.0.1:55432/unused_benchmark",
      R2_PUBLIC_URL: "https://synthetic.example.test",
      R2_ACCESS_KEY_ID: "synthetic",
      R2_SECRET_ACCESS_KEY: "synthetic",
      R2_ENDPOINT: "https://synthetic.example.test",
      R2_BUCKET_NAME: "synthetic",
      BETTER_AUTH_SECRET: "synthetic-benchmark-signing-secret",
    },
  },
});
