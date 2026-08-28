/**
 * MCP Apps (SEP-1865) — serving the `ui://` resources cubby's tools render
 * through.
 *
 * The host fetches the resource, renders the HTML in a sandboxed iframe, and
 * brokers `postMessage` JSON-RPC between it and this server. Hosts without the
 * extension ignore the pointer and show the structured output, so the picker is
 * strictly additive.
 */
import { USDA_PICKER } from "@cubby/mcp-apps/metadata";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { APP_ORIGIN } from "~/lib/auth";

export function registerMcpApps(server: McpServer) {
  registerAppResource(
    server,
    USDA_PICKER.name,
    USDA_PICKER.uri,
    { description: USDA_PICKER.description },
    async () => {
      const { USDA_PICKER_HTML, withCubbyOrigin } =
        await import("@cubby/mcp-apps");
      return {
        contents: [
          {
            uri: USDA_PICKER.uri,
            mimeType: RESOURCE_MIME_TYPE,
            // The apps deep-link back into cubby, but a sandboxed iframe can't
            // know what origin its server is served from. Substituting at read
            // time keeps the origin out of tool payloads and out of the bundles.
            text: withCubbyOrigin(USDA_PICKER_HTML, APP_ORIGIN),
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
