import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { MCP_APP_MANIFEST } from "../src/metadata";
import { withCubbyAppConfig } from "../src/origin";

/**
 * Dev server for the local MCP App harness
 * (`pnpm --filter @cubby/mcp-apps dev`).
 *
 * Serves harness/host.html, which loads the *built* bundles and drives them
 * over the real AppBridge protocol.
 *
 * `/app/<name>.html` mirrors what the host does with a `ui://` resource: reads
 * the bundle, substitutes the cubby origin, and serves it as a document. The
 * iframe points its `src` at that rather than using `srcdoc`, because a
 * sandboxed srcdoc document has an opaque origin and Chromium won't run module
 * scripts in it — the real host sidesteps this by serving apps from a dedicated
 * origin (`_meta.ui.domain`), which this route stands in for.
 */
/** Allowlist, not a pattern — the request path never reaches `resolve`. */
const APPS = MCP_APP_MANIFEST;

function serveApps(): Plugin {
  return {
    name: "mcp-apps-harness",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const app = APPS.find(
          (candidate) => req.url === `/app/${candidate.id}.html`,
        );
        if (!app) return next();
        try {
          const html = await readFile(
            resolve(__dirname, "..", "dist", "app.html"),
            "utf-8",
          );
          res.setHeader("Content-Type", "text/html");
          // Same substitution the MCP server does, from the same helper — a
          // harness that rewrites differently would hide origin bugs.
          res.end(
            withCubbyAppConfig(html, {
              origin: "https://example.invalid",
              appId: app.id,
            }),
          );
        } catch {
          res.statusCode = 404;
          res.end("run `pnpm --filter @cubby/mcp-apps build` first");
        }
      });
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, ".."),
  plugins: [serveApps()],
  server: { port: 5199, open: "/harness/host.html" },
});
