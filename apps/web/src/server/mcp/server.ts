import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerIngredientTools } from "./tools/ingredient.tools";
import { registerInventoryTools } from "./tools/inventory.tools";
import { registerLocationTools } from "./tools/location.tools";
import { registerMealTools } from "./tools/meal.tools";
import { registerNotionTools } from "./tools/notion.tools";
import { registerProblemsTools } from "./tools/problems.tools";
import { registerProductTools } from "./tools/product.tools";
import { registerRecipeTools } from "./tools/recipe.tools";
import { registerSearchTools } from "./tools/search.tools";
import { registerUsdaTools } from "./tools/usda.tools";

/**
 * MCP Server for Cubby inventory and product management.
 *
 * The McpServer + tools are created once (module scope). Only the transport
 * is per-request — the SDK requires a fresh transport in stateless mode,
 * but the server itself is stateless and safe to reuse.
 *
 * Tool definitions live in `./tools/<family>.tools.ts`, grouped by entity
 * family; shared scaffolding (caller accessor, error wrapper, JSON helpers,
 * slim projections, CRUD factories) lives in `./tools/_shared.ts`. This file
 * keeps only the server lifecycle and the registration fan-out.
 */

// Re-exported for the unit test, which exercises the slim projections directly.
export { slimMeal, slimProduct, slimUsdaFood } from "./tools/_shared";

function registerTools(server: McpServer) {
  registerInventoryTools(server);
  registerProductTools(server);
  registerLocationTools(server);
  registerSearchTools(server);
  registerIngredientTools(server);
  registerRecipeTools(server);
  registerProblemsTools(server);
  registerNotionTools(server);
  registerMealTools(server);
  registerUsdaTools(server);
}

export function createMcpServer() {
  const server = new McpServer({
    name: "cubby",
    version: "1.0.0",
  });
  registerTools(server);
  return server;
}

/**
 * Handle an authenticated MCP request.
 * Per-request server+transport: the SDK's McpServer.connect() can only be
 * called once per instance, and the transport can't be reused in stateless mode.
 */
export async function handleMcpRequest(
  request: Request,
  authInfo: AuthInfo,
): Promise<Response> {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request, { authInfo });
}
