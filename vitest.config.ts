import { defineConfig } from "vitest/config";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { join } from "path";

export default defineConfig({
  // https://github.com/Menci/vite-plugin-wasm#usage
  plugins: [wasm(), topLevelAwait()],
  resolve: {
    alias: {
      // https://github.com/juliusmarminge/t3-complete/blob/main/vitest.config.ts
      "~/": join(__dirname, "./src/"),
    },
  },
  test: {
    workspace: [
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
        // won't inherit any options from this config
        // this is the default behaviour
        extends: true,
        test: {
          globalSetup: ["./tooling/test-setup.ts"],
          name: "integration",
          include: ["**/*.integration.test.ts"],
        },
      },
    ],

    env: {
      NODE_ENV: "test",
    },
  },
});
