import type { FlueImportRunPurpose } from "@cubby/schemas/import-run-agent";
import type { McpConnectionDefinition } from "@flue/runtime";
import { z } from "zod";

import type { PurchaseImportServiceResolver } from "./tools";

const mcpAccess = z.object({
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
  mcpUrl: z.url(),
});

// Flue needs a URL synchronously when it constructs the transport. No request
// reaches this host: the custom fetch below rewrites it to the URL authorized
// by Cubby's run-bound access grant, then sends it over the service binding.
const MCP_PLACEHOLDER_URL = "https://cubby-mcp.invalid/mcp";

// Flue includes every mounted MCP tool schema in each model request. The
// household-wide catalog makes a two-photo run pay for unrelated workflows.
const PHOTO_INVENTORY_TOOLS = [
  "get_photo_run_context",
  "get_image_processing",
  "suggest_photo_product_candidates",
  "resolve_products",
  "find_similar_entities",
  "propose_photo_groups",
  "list_photo_group_proposals",
  "patch_products_external_ids",
];

async function rewriteMcpRequest(
  request: Request,
  mcpUrl: string,
): Promise<Request> {
  const target = new URL(mcpUrl);
  const requested = new URL(request.url);
  target.search = requested.search;
  // A transport-owned AbortSignal cannot be structured-cloned across a
  // Worker RPC service binding. Rebuild the small MCP request from bytes so
  // cancellation remains local to the agent submission instead of making the
  // private web entrypoint uncallable in workerd.
  return new Request(target, {
    method: request.method,
    headers: request.headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer(),
    redirect: request.redirect,
  });
}

/**
 * Mount the private Cubby MCP server without putting its bearer in durable
 * agent state. Flue resolves `auth` for every transport request; `fetch`
 * consumes the corresponding authorized URL and crosses only the Worker
 * service binding.
 */
export function cubbyMcpConnection(
  runId: string,
  serviceForRun: PurchaseImportServiceResolver,
  purpose: FlueImportRunPurpose = "account_sync",
): McpConnectionDefinition {
  let authorizedUrl: string | undefined;
  const connection: McpConnectionDefinition = {
    name: "cubby",
    url: MCP_PLACEHOLDER_URL,
    auth: async () => {
      const access = mcpAccess.parse(
        await serviceForRun().acquireMcpAccess({ runId }),
      );
      authorizedUrl = access.mcpUrl;
      return access.token;
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const mcpUrl =
        authorizedUrl ??
        mcpAccess.parse(await serviceForRun().acquireMcpAccess({ runId }))
          .mcpUrl;
      return serviceForRun().mcpFetch(await rewriteMcpRequest(request, mcpUrl));
    },
  };
  if (purpose === "photo_inventory") connection.tools = PHOTO_INVENTORY_TOOLS;
  return connection;
}
