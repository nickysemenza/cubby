import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Files the Worker serves through its ASSETS binding instead of embedding: an
 * unchanged file costs no Worker upload bytes on deploy.
 */
const STATIC_ASSETS = [
  {
    path: resolve(import.meta.dirname, "../../mcp-apps/dist/app.html"),
    name: "mcp-usda-picker",
    extension: "html",
    contentType: "text/html; charset=utf-8",
  },
  {
    path: resolve(
      import.meta.dirname,
      "../src/lib/generated/http-openapi.gen.json",
    ),
    name: "http-openapi",
    extension: "json",
    contentType: "application/json",
  },
];

/**
 * Turn each `STATIC_ASSETS` file into one hashed client asset. The server graph
 * imports the `?url` module too, but only the client environment emits the
 * file; this keeps the Worker holding a URL and lets ASSETS serve the bytes.
 */
export function workerStaticAssets(): Plugin {
  let building = false;
  const fileName = (asset: (typeof STATIC_ASSETS)[number]) => {
    const hash = createHash("sha256")
      .update(readFileSync(asset.path))
      .digest("hex")
      .slice(0, 12);
    return `${asset.name}-${hash}.${asset.extension}`;
  };
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
        const asset = STATIC_ASSETS.find((candidate) =>
          pathname.startsWith(`/assets/${candidate.name}-`),
        );
        if (!asset) return next();
        if (pathname !== `/assets/${fileName(asset)}`) {
          res.statusCode = 404;
          return res.end();
        }
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
      return `export default ${JSON.stringify(`/assets/${fileName(asset)}`)};`;
    },
    buildStart() {
      // Vite builds client and SSR as separate environments. Only the static
      // client output is attached to the Worker's ASSETS binding.
      if (!building || this.environment.name !== "client") return;
      for (const asset of STATIC_ASSETS) {
        this.emitFile({
          type: "asset",
          fileName: `assets/${fileName(asset)}`,
          source: readFileSync(asset.path),
        });
      }
    },
  };
}
