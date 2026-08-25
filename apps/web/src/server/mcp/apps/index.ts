/**
 * MCP Apps (SEP-1865) — serving the `ui://` resources cubby's tools render
 * through.
 *
 * Tool registration derives `_meta.ui.resourceUri` from the metadata-only
 * manifest. The host fetches the resource, renders the HTML in a sandboxed
 * iframe, and brokers `postMessage` JSON-RPC between it and this server. Hosts
 * without the extension ignore the pointer and show the structured output, so
 * every UI is strictly additive — no tool's data is reachable only through its
 * app.
 *
 * The apps themselves (and the manifest below) live in `@cubby/mcp-apps`; this
 * file is only the MCP wiring, which needs cubby's origin and the SDK.
 */
import { MCP_APP_MANIFEST } from "@cubby/mcp-apps/metadata";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { APP_ORIGIN } from "~/lib/auth";

type McpApp = (typeof MCP_APP_MANIFEST)[number];

function register(server: McpServer, app: McpApp) {
  registerAppResource(
    server,
    app.name,
    app.uri,
    { description: app.description },
    async () => {
      const { MCP_APP_BUNDLES, withCubbyOrigin } = await import(
        "@cubby/mcp-apps"
      );
      const bundle = MCP_APP_BUNDLES.find(({ id }) => id === app.id);
      if (!bundle) throw new Error(`Missing MCP App bundle for ${app.id}`);
      return {
        contents: [
          {
            uri: app.uri,
            mimeType: RESOURCE_MIME_TYPE,
            // The apps deep-link back into cubby, but a sandboxed iframe can't
            // know what origin its server is served from. Substituting at read
            // time keeps the origin out of tool payloads and out of the bundles.
            text: withCubbyOrigin(bundle.html, APP_ORIGIN),
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
      };
    },
  );
}

export function registerMcpApps(server: McpServer) {
  for (const app of MCP_APP_MANIFEST) register(server, app);
}
