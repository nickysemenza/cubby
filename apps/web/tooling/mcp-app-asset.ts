import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const APP_HTML = resolve(import.meta.dirname, "../../mcp-apps/dist/app.html");

/**
 * Turn the MCP App's built HTML into one hashed client asset. The server graph
 * imports the URL module too, but only the client environment emits the file;
 * this keeps the Worker holding a URL and lets its ASSETS binding serve bytes.
 */
export function mcpAppAsset(): Plugin {
  const source = () => readFileSync(APP_HTML);
  const fileName = () => {
    const hash = createHash("sha256")
      .update(source())
      .digest("hex")
      .slice(0, 12);
    return `mcp-usda-picker-${hash}.html`;
  };

  return {
    name: "cubby-mcp-app-asset",
    enforce: "pre",
    resolveId(id, importer) {
      if (!importer || !id.endsWith("?url")) return undefined;
      const candidate = resolve(importer, "..", id.slice(0, -4));
      if (candidate !== APP_HTML) return undefined;
      return `${APP_HTML}?url`;
    },
    load(id) {
      if (id !== `${APP_HTML}?url`) return undefined;
      return `export default ${JSON.stringify(`/assets/${fileName()}`)};`;
    },
    buildStart() {
      // Vite builds client and SSR as separate environments. Only the static
      // client output is attached to the Worker's ASSETS binding.
      if (this.environment.name !== "client") return;
      this.emitFile({
        type: "asset",
        fileName: `assets/${fileName()}`,
        source: source(),
      });
    },
  };
}
