import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import viteTsConfigPaths from "vite-tsconfig-paths";

const isDev = process.env.NODE_ENV !== "production";

export default defineConfig({
  envDir: ".", // Explicitly load .env from this directory
  // Externalize OpenTelemetry packages to avoid ESM/CJS compatibility issues
  ssr: {
    external: [
      "@opentelemetry/sdk-node",
      "@opentelemetry/resources",
      "@opentelemetry/semantic-conventions",
      "@opentelemetry/auto-instrumentations-node",
      "@opentelemetry/exporter-trace-otlp-http",
    ],
  },
  plugins: [
    // Only use Cloudflare plugin in production - allows Node.js pg driver in dev
    !isDev && cloudflare({ viteEnvironment: { name: "ssr" } }),
    wasm(),
    devtools(),
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ].filter(Boolean),
});
