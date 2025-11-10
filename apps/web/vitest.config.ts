import { defineConfig } from "vitest/config";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { join } from "path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // https://github.com/Menci/vite-plugin-wasm#usage
  plugins: [wasm(), topLevelAwait()],
  resolve: {
    alias: {
      // https://github.com/juliusmarminge/t3-complete/blob/main/vitest.config.ts
      "~/": join(__dirname, "./src/"),
      "tooling/": join(__dirname, "./tooling/"),
    },
  },
  test: {
    projects: [
      {
        // will inherit options from this config like plugins and pool
        extends: true,
        test: {
          name: "unit",
          include: ["**/*.unit.test.ts", "**/*.{test,spec}-d.?(c|m)[jt]s?(x)"],
          typecheck: {
            enabled: true,
            ignoreSourceErrors: true, // wasm files throw errors
          },
        },
      },
      {
        // will inherit options from this config like plugins and pool
        extends: true,
        plugins: [react()],
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["**/*.unit.test.tsx"],
          typecheck: {
            enabled: true,
            ignoreSourceErrors: true, // wasm files throw errors
          },
        },
      },
      {
        // won't inherit any options from this config
        // this is the default behaviour
        extends: true,
        test: {
          globalSetup: ["./tooling/test-setup.ts"],
          name: "integration",
          include: ["**/*.integration.test.ts"],
          testTimeout: 10000, // Increase timeout for integration tests
        },
      },
    ],

    env: {
      NODE_ENV: "test",
      SKIP_ENV_VALIDATION: "1",
      DATABASE_URL: "postgresql://recipehub:example@localhost:5555/test",
      USDA_API_URL: "http://localhost:8080",
      R2_ACCESS_KEY_ID: "test",
      R2_SECRET_ACCESS_KEY: "test",
      R2_ENDPOINT: "http://localhost:9000",
      R2_BUCKET_NAME: "test",
      R2_PUBLIC_URL: "http://localhost:9000",
    },
  },
});
