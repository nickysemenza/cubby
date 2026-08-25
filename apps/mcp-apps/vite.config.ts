import { resolve } from "node:path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * Build the USDA picker MCP App (SEP-1865) document. `build.mjs` runs it once;
 * the resource registrar serves that one stable `ui://` URI.
 *
 * Everything is inlined on purpose: each app ships to the host as a single
 * self-contained HTML string over `resources/read`, so there is no origin to
 * fetch a sibling file from and no filesystem in the CF Worker to read one out
 * of. `apps/web/src/server/mcp/apps/index.ts` imports the output as raw HTML.
 *
 * Output lands in `mcp-apps/dist/`, deliberately NOT `apps/web/dist` (that one
 * gets `rm -rf`'d at the top of `build:cf`).
 */
export default defineConfig(() => {
  return {
    root: __dirname,
    plugins: [viteSingleFile()],
    build: {
      outDir: resolve(__dirname, "dist"),
      emptyOutDir: true,
      // Hosts render this in an iframe on desktop and mobile Claude — no legacy
      // browser in that set, so skip the downlevel transforms.
      target: "es2022",
      rollupOptions: { input: resolve(__dirname, "app.html") },
    },
  };
});
