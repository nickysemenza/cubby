/**
 * MCP Apps (SEP-1865) — serving the `ui://` resources cubby's tools render
 * through.
 *
 * A tool points at one with `_meta.ui.resourceUri` (see the `uiResourceUri`
 * option on `registerMcpTool`); the host fetches the resource, renders the HTML
 * in a sandboxed iframe, and brokers `postMessage` JSON-RPC between it and this
 * server. Hosts without the extension ignore the pointer and show the
 * structured output, so every UI is strictly additive — no tool's data is
 * reachable *only* through its app.
 *
 * The apps themselves (and the manifest below) live in `@cubby/mcp-apps`; this
 * file is only the MCP wiring, which needs cubby's origin and the SDK.
 */
import {
  MCP_APP_BUNDLES,
  type McpAppBundle,
  withCubbyOrigin,
} from "@cubby/mcp-apps";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { APP_ORIGIN } from "~/lib/auth";

export { SHOPPING_LIST_UI, USDA_PICKER_UI } from "@cubby/mcp-apps";

function register(server: McpServer, app: McpAppBundle) {
  registerAppResource(
    server,
    app.name,
    app.uri,
    { description: app.description },
    () => ({
      contents: [
        {
          uri: app.uri,
          mimeType: RESOURCE_MIME_TYPE,
          // The apps deep-link back into cubby, but a sandboxed iframe can't
          // know what origin its server is served from. Substituting at read
          // time keeps the origin out of tool payloads and out of the bundles.
          text: withCubbyOrigin(app.html, APP_ORIGIN),
          _meta: {
            ui: {
              // CSP and domain are intentionally omitted. These personal,
              // dev-only bundles are self-contained; omitted CSP denies
              // network access, and a dedicated domain is submission-only.
              // The apps draw their own hairline rules and ink top-rule; a
              // host-supplied border/background frames a frame.
              prefersBorder: false,
            },
          },
        },
      ],
    }),
  );
}

export function registerMcpApps(server: McpServer) {
  for (const app of MCP_APP_BUNDLES) register(server, app);
}
