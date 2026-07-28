import { resolve } from "node:path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * Build for one MCP Apps (SEP-1865) UI resource. Driven by `build.mjs`, which
 * runs it once per app — `vite-plugin-singlefile` turns code splitting off, and
 * rollup rejects multiple inputs without it, so one pass per app is forced.
 *
 * Everything is inlined on purpose: each app ships to the host as a single
 * self-contained HTML string over `resources/read`, so there is no origin to
 * fetch a sibling file from and no filesystem in the CF Worker to read one out
 * of. `apps/web/src/server/mcp/apps/index.ts` picks the output up via `?raw`.
 *
 * Output lands in `mcp-apps/dist/`, deliberately NOT `apps/web/dist` (that one
 * gets `rm -rf`'d at the top of `build:cf`).
 */
export default defineConfig(() => {
  const entry = process.env.MCP_APP;
  if (!entry) throw new Error("MCP_APP must name the app to build");

  return {
    root: __dirname,
    plugins: [viteSingleFile()],
    build: {
      outDir: resolve(__dirname, "dist"),
      // build.mjs clears dist once up front; each pass appends to it.
      emptyOutDir: false,
      // Hosts render this in an iframe on desktop and mobile Claude — no legacy
      // browser in that set, so skip the downlevel transforms.
      target: "es2022",
      rollupOptions: { input: resolve(__dirname, `${entry}.html`) },
    },
  };
});
