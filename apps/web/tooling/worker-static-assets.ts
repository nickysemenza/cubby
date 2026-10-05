import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const hashed = (name: string, extension: string) => (source: Buffer) =>
  `assets/${name}-${createHash("sha256").update(source).digest("hex").slice(0, 12)}.${extension}`;

/**
 * Generated files emitted into the client output. Cloudflare serves a static
 * asset before invoking the Worker (no `run_worker_first`), so a fixed-path
 * file never runs Worker code, and an unchanged file costs no upload bytes.
 */
const STATIC_ASSETS = [
  {
    // Hashed: the Worker imports its URL (`?url`) and reads it via ASSETS.
    path: resolve(import.meta.dirname, "../../mcp-apps/dist/app.html"),
    fileName: hashed("mcp-usda-picker", "html"),
    contentType: "text/html; charset=utf-8",
  },
  {
    // Served as-is; `checkHttpRoutes` reserves the path from operations.
    path: resolve(
      import.meta.dirname,
      "../src/lib/generated/http-openapi.gen.json",
    ),
    fileName: () => "api/v1/openapi.json",
    contentType: "application/json",
  },
];

/**
 * Emit each `STATIC_ASSETS` file into the client output only: the server graph
 * may import a hashed file's `?url` module, but only the client output is
 * attached to the Worker's ASSETS binding. Dev serves the same paths.
 */
export function workerStaticAssets(): Plugin {
  let building = false;
  const fileName = (asset: (typeof STATIC_ASSETS)[number]) =>
    asset.fileName(readFileSync(asset.path));
  const byPath = new Map(STATIC_ASSETS.map((asset) => [asset.path, asset]));

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
          (candidate) => pathname === `/${fileName(candidate)}`,
        );
        if (!asset) return next();
        res.setHeader("Content-Type", asset.contentType);
        res.setHeader("Cache-Control", "no-cache");
        res.end(req.method === "HEAD" ? undefined : readFileSync(asset.path));
      });
    },
    async resolveId(id, importer) {
      if (!importer || !id.endsWith("?url")) return undefined;
      // Resolve through aliases (`~/lib/...`) before matching a listed file.
      const resolved = await this.resolve(id.slice(0, -4), importer, {
        skipSelf: true,
      });
      if (!resolved || !byPath.has(resolved.id)) return undefined;
      return `${resolved.id}?url`;
    },
    load(id) {
      const asset = id.endsWith("?url") && byPath.get(id.slice(0, -4));
      if (!asset) return undefined;
      return `export default ${JSON.stringify(`/${fileName(asset)}`)};`;
    },
    buildStart() {
      if (!building || this.environment.name !== "client") return;
      for (const asset of STATIC_ASSETS) {
        this.emitFile({
          type: "asset",
          fileName: fileName(asset),
          source: readFileSync(asset.path),
        });
      }
    },
  };
}
