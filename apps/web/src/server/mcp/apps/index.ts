/**
 * MCP Apps (SEP-1865) — serving the `ui://` resources cubby's tools render
 * through.
 *
 * The host fetches the resource, renders the HTML in a sandboxed iframe, and
 * brokers `postMessage` JSON-RPC between it and this server. Hosts without the
 * extension ignore the pointer and show the structured output, so the picker is
 * strictly additive.
 */
import {
  USDA_PICKER,
  USDA_PICKER_HTML_URL,
  withCubbyOrigin,
} from "@cubby/mcp-apps";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";

import { APP_ORIGIN } from "~/lib/auth-constants";
import { getAssetsFetcher } from "~/server/cf-env";

let usdaPickerHtmlPromise: Promise<string> | undefined;

/** Shared-graph tests call this after each case so an asset read cannot cross files. */
export function resetMcpAppAssetCacheForTests() {
  usdaPickerHtmlPromise = undefined;
}

async function loadUsdaPickerHtml(): Promise<string> {
  if (usdaPickerHtmlPromise) return usdaPickerHtmlPromise;
  const loadPromise = (async () => {
    const assetsFetch = getAssetsFetcher();
    if (assetsFetch) {
      const response = await assetsFetch(
        new Request(new URL(USDA_PICKER_HTML_URL, APP_ORIGIN)),
      );
      if (!response.ok) {
        throw new Error(
          `Failed to load USDA picker asset (${response.status} ${response.statusText})`,
        );
      }
      return response.text();
    }

    // Vitest can read the raw bundle without a Worker binding. Local and
    // deployed Workers load the emitted/served URL through ASSETS above.
    if (import.meta.env.DEV) {
      const { USDA_PICKER_HTML } = await import("@cubby/mcp-apps/dev");
      return USDA_PICKER_HTML;
    }
    throw new Error("The ASSETS binding is required to serve MCP Apps");
  })();
  usdaPickerHtmlPromise = loadPromise.catch(() => {
    // A transient asset read must not poison the isolate's cache forever.
    usdaPickerHtmlPromise = undefined;
    return loadPromise;
  });
  return usdaPickerHtmlPromise;
}

export function registerMcpApps(server: McpServer) {
  server.registerResource(
    USDA_PICKER.name,
    USDA_PICKER.uri,
    {
      description: USDA_PICKER.description,
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => {
      const html = await loadUsdaPickerHtml();
      return {
        contents: [
          {
            uri: USDA_PICKER.uri,
            mimeType: RESOURCE_MIME_TYPE,
            // The apps deep-link back into cubby, but a sandboxed iframe can't
            // know what origin its server is served from. Substituting at read
            // time keeps the origin out of tool payloads and out of the bundles.
            text: withCubbyOrigin(html, APP_ORIGIN),
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
