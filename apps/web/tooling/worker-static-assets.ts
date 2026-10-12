import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Generated files emitted into the client output. Cloudflare serves a static
 * asset before invoking the Worker (no `run_worker_first`), so a fixed-path
 * file never runs Worker code, and an unchanged file costs no upload bytes.
 */
const STATIC_ASSETS = [
  {
    // Served as-is; `checkHttpRoutes` reserves the path from operations.
    path: resolve(
      import.meta.dirname,
      "../src/lib/generated/http-openapi.gen.json",
    ),
    fileName: "api/v1/openapi.json",
    contentType: "application/json",
  },
];

/**
 * Emit each `STATIC_ASSETS` file into the client output only, which is what
 * the Worker's static assets serve. Dev serves the same paths.
 */
export function workerStaticAssets(): Plugin {
  let building = false;

  return {
    name: "cubby-worker-static-assets",
    enforce: "pre",
    configResolved(config) {
      building = config.command === "build";
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        const asset = STATIC_ASSETS.find(
          (candidate) => pathname === `/${candidate.fileName}`,
        );
        if (!asset) return next();
        res.setHeader("Content-Type", asset.contentType);
        res.setHeader("Cache-Control", "no-cache");
        res.end(req.method === "HEAD" ? undefined : readFileSync(asset.path));
      });
    },
    buildStart() {
      if (!building || this.environment.name !== "client") return;
      for (const asset of STATIC_ASSETS) {
        this.emitFile({
          type: "asset",
          fileName: asset.fileName,
          source: readFileSync(asset.path),
        });
      }
    },
  };
}
