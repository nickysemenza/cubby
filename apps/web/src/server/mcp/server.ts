import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { installMockStrippedListToolsHandler } from "./tools/_shared";
import { registerIngredientTools } from "./tools/ingredient.tools";
import { registerInventoryTools } from "./tools/inventory.tools";
import { registerLocationTools } from "./tools/location.tools";
import { registerMealTools } from "./tools/meal.tools";
import { registerProblemsTools } from "./tools/problems.tools";
import { registerProductTools } from "./tools/product.tools";
import { registerProjectTools } from "./tools/project.tools";
import { registerRecipeTools } from "./tools/recipe.tools";
import { registerSearchTools } from "./tools/search.tools";
import { registerUsdaTools } from "./tools/usda.tools";

/**
 * MCP Server for Cubby inventory and product management.
 *
 * The McpServer + tools are created once (module scope). Only the transport
 * is per-request — the SDK requires a fresh transport in stateless mode,
 * but the server itself is stateless and safe to reuse.
 */

export const MCP_SERVER_INSTRUCTIONS = `Cubby MCP — personal pantry, recipe, and meal-planning API.

Workflow tips:
- Resolve IDs before writes: use list_*/search_*/get_* read tools to map names → ids.
- Ingredients: batch-resolve names with resolve_ingredients instead of one search+create per name.
- Meals: the \`id\` inside a meal's recipes[] is the mealRecipe id — use THAT (not recipeId) for update_meal_recipe / remove_meal_recipe.
- Products: usdaFdcId reflects either an explicit fdc_id or a UPC-resolved USDA link.
- Recipes: prefer create_recipe_from_text for pasted prep sheets; use create_recipe when you already have ingredient ids.
- Problems: list_problems countsOnly=true for cheap triage; reparse_stale_parses recovers mis-merged ingredient lines.
- Projects: list_projects/list_tasks/list_purchases are the household project tracker (DB-backed); a project's markdown notes come back on get_project.
- All list tools return { meta, items } paginated objects; bulk array tools return { items: [...] }.
- structuredContent is canonical; text content mirrors the same JSON.`;

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
  registerProjectTools(server);
  registerMealTools(server);
  registerUsdaTools(server);
}

export function createMcpServer() {
  const server = new McpServer(
    {
      name: "cubby",
      version: "1.0.0",
    },
    {
      instructions: MCP_SERVER_INSTRUCTIONS,
    },
  );
  registerTools(server);
  installMockStrippedListToolsHandler(server);
  return server;
}

/** Introspect the live tool catalog (same JSON external MCP clients see). */
export async function listMcpToolCatalog() {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "cubby-introspect", version: "1.0.0" });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    return await client.listTools();
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
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
