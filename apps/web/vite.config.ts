import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import viteTsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  envDir: ".", // Explicitly load .env from this directory
  server: {
    host: "0.0.0.0",
    allowedHosts: ["nickys-macbook-air.tailnet-0eba.ts.net"],
  },
  ssr: {
    // Externalize OpenTelemetry packages to avoid ESM/CJS compatibility issues
    external: [
      "@opentelemetry/sdk-node",
      "@opentelemetry/resources",
      "@opentelemetry/semantic-conventions",
      "@opentelemetry/auto-instrumentations-node",
      "@opentelemetry/exporter-trace-otlp-http",
    ],
  },
  plugins: [
    wasm(),
    devtools(),
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    // tanstackStart must come BEFORE viteReact per TanStack Router plugin
    tanstackStart(),
    viteReact(),
    nitro({
      preset: "vercel",
      // Force bundle captcha packages from better-auth-ui (unused but cause ESM/CJS issues)
      externals: {
        inline: [
          "@hcaptcha/react-hcaptcha",
          "@hcaptcha/loader",
          "@captchafox/react",
          "@marsidev/react-turnstile",
          "@wojtekmaj/react-recaptcha-v3",
          "react-google-recaptcha",
          "@daveyplate/better-auth-ui",
        ],
      },
    }),
  ],
});
