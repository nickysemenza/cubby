/**
 * MCP Apps (SEP-1865) — the `ui://` resources cubby's tools render through.
 *
 * A tool points at one of these with `_meta.ui.resourceUri` (see the
 * `uiResourceUri` option on `registerMcpTool`); the host fetches the resource,
 * renders the HTML in a sandboxed iframe, and brokers `postMessage` JSON-RPC
 * between it and this server. Hosts without the extension ignore the pointer
 * and show the structured output, so every UI here is strictly additive — no
 * tool's data is reachable *only* through its app.
 *
 * Scope is deliberately narrow: an app earns its place only where the chat is
 * the right home for the interaction AND text is a bad medium for it. Tables,
 * boards, and charts stay in the web app, one `openLink` away.
 */
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { APP_ORIGIN } from "~/lib/auth";
// Built by `pnpm build:mcp-apps` into a gitignored dist/ (see
// mcp-apps/vite.config.ts). Inlined as a string because the worker has no
// filesystem to read an HTML file out of at request time. `?raw` resolves
// through vite/client's ambient wildcard, so typecheck passes even before the
// first build — but a stale dist/ silently ships an old UI, which is what
// scripts/ensure-mcp-apps.mjs exists to prevent.
import shoppingListHtml from "../../../../mcp-apps/dist/shopping-list.html?raw";
import usdaPickerHtml from "../../../../mcp-apps/dist/usda-picker.html?raw";

export const SHOPPING_LIST_UI = "ui://cubby/shopping-list.html";
export const USDA_PICKER_UI = "ui://cubby/usda-picker.html";

const CUBBY_ORIGIN_PLACEHOLDER = "__CUBBY_ORIGIN__";

type CubbyApp = {
  uri: string;
  name: string;
  description: string;
  html: string;
};

const APPS: CubbyApp[] = [
  {
    uri: SHOPPING_LIST_UI,
    name: "Shopping List",
    description:
      "Checkable shopping list grouped by availability, with the per-meal breakdown behind each item.",
    html: shoppingListHtml,
  },
  {
    uri: USDA_PICKER_UI,
    name: "USDA Food Picker",
    description:
      "USDA search results as pickable cards, showing data-type richness and macros per 100g.",
    html: usdaPickerHtml,
  },
];

/**
 * The apps deep-link back into cubby, but a sandboxed iframe has no way to know
 * what origin its server is served from. Substituting at read time keeps the
 * origin out of tool payloads and out of the committed bundles.
 */
function withOrigin(html: string): string {
  return html.replaceAll(CUBBY_ORIGIN_PLACEHOLDER, APP_ORIGIN);
}

export function registerMcpApps(server: McpServer) {
  for (const app of APPS) {
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
            text: withOrigin(app.html),
            _meta: {
              ui: {
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
}
