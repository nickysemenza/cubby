import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * Dev server for the local MCP App harness (`pnpm dev:mcp-apps`).
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
function serveApps(): Plugin {
  return {
    name: "mcp-apps-harness",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const match = /^\/app\/([\w-]+)\.html$/.exec(req.url ?? "");
        if (!match) return next();
        try {
          const html = await readFile(
            resolve(__dirname, "..", "dist", `${match[1]}.html`),
            "utf-8",
          );
          res.setHeader("Content-Type", "text/html");
          res.end(
            html.replaceAll("__CUBBY_ORIGIN__", "https://example.invalid"),
          );
        } catch {
          res.statusCode = 404;
          res.end("run `pnpm build:mcp-apps` first");
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
