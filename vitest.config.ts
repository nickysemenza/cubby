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
});
