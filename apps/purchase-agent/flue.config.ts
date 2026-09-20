import { defineConfig } from "@flue/runtime/config";

export default defineConfig({
  target: "cloudflare",
  app: "./src/app.ts",
  cloudflare: "./src/cloudflare.ts",
  agents: "./purchase-import-run.ts",
  providers: ["cloudflare"],
});
