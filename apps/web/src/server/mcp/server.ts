import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerMcpApps } from "./apps";
import { installMockStrippedListToolsHandler } from "./tools/_shared";
import { registerAuditTools } from "./tools/audit.tools";
import { registerEntityIntegrityTools } from "./tools/entity-integrity.tools";
import { registerImageTools } from "./tools/image.tools";
import { registerIngredientTools } from "./tools/ingredient.tools";
import { registerInventoryTools } from "./tools/inventory.tools";
import { registerLocationTools } from "./tools/location.tools";
import { registerMealTools } from "./tools/meal.tools";
import { registerProblemsTools } from "./tools/problems.tools";
import { registerProductTools } from "./tools/product.tools";
import { registerProjectTools } from "./tools/project.tools";
import { registerPurchaseTools } from "./tools/purchase.tools";
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

Ids are public shortcodes, not uuids. Every id you receive back from a tool and every id field you fill in is a short prefixed code (e.g. PRD-4K7M) — the uuid primary key behind it never crosses this API. The prefix names the entity, so a code is self-describing:
- PRD- product
- RCP- recipe
- ING- ingredient
- INV- inventory entry
- LOC- location
- MEL- meal
- PRJ- project
- TSK- task
- EXP- expense
- VEN- vendor
- PUR- purchase (one vendor charge — see the ledger note below, it is not a ledger line)
- CKB- cookbook
A code with the wrong prefix for the field it's passed to (a LOC- code where a tool wants a product) is rejected by input validation before the tool runs, so a mismatched or unresolvable code never reaches a write.

Declared exceptions — these stay raw uuids because no shortcode exists for them: the mealRecipe \`id\` inside a meal's recipes[] (update_meal_recipe / remove_meal_recipe take THIS, not the recipe's own shortcode), a recipe section-ingredient's line \`id\`, image ids (attach_file's response, update_purchase's removeImageIds/imageOrder), and USDA's \`fdc_id\` (an external USDA identifier, not a cubby entity).

Workflow tips:
- Turn a name into an id with list_*/search_*/get_* (or global_search across every indexed entity at once) before writing — you get a shortcode back, ready to pass straight into the next call.
- Ingredients: batch-resolve names with resolve_ingredients instead of one search+create per name.
- Meals: the \`id\` inside a meal's recipes[] is the mealRecipe id — use THAT (not recipeId) for update_meal_recipe / remove_meal_recipe.
- Products: usdaFdcId reflects either an explicit fdc_id or a UPC-resolved USDA link.
- Recipes: prefer create_recipe_from_text for pasted prep sheets; use create_recipe when you already have ingredient ids.
- Problems: list_problems countsOnly=true for cheap triage; reparse_stale_parses recovers mis-merged ingredient lines.
- Projects: list_projects/list_tasks/list_expenses are the household project tracker (DB-backed); a project's markdown notes come back on get_project.
- Ledger shape: \`Vendor ──< Purchase ──< Expense\`. ALL money lives on \`expense\` — list_expenses/create_expense are the spend ledger. A \`purchase\` is ONE vendor charge (it used to mean the ledger row; it no longer does), and its \`statedTotal\` is a reconciliation cue that is never summed into spend.
- Reconciling a vendor export against the ledger: match_expenses (read-only, ranks candidates for the whole batch) → update_expense to set vendor/orderId on what you confirm, or split_expense when one ledger row aggregates several export lines. Never write from a match without confirming it — and run match_expenses BEFORE create_expense, since the row you are about to add usually already exists under a different name.
- Reconciling a charge against its own paperwork: update_purchase records \`statedTotal\`; list_problems type="chargesNotReconciling" is the worklist of charges whose lines don't add up to it (a soft flag, often legitimately mismatched after a partial refund).
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
  registerPurchaseTools(server);
  registerMealTools(server);
  registerUsdaTools(server);
  registerImageTools(server);
  registerAuditTools(server);
  registerEntityIntegrityTools(server);
  // The `ui://` resources those tools' `_meta.ui.resourceUri` pointers resolve
  // to. Adds the `resources` capability, which is otherwise unused — cubby's
  // MCP surface is tools-only.
  registerMcpApps(server);
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

/** Run one introspection call against a throwaway in-process client/server pair. */
async function introspect<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "cubby-introspect", version: "1.0.0" });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    return await fn(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

/** Introspect the live tool catalog (same JSON external MCP clients see). */
export async function listMcpToolCatalog() {
  return introspect((client) => client.listTools());
}

/** Introspect the live resource catalog — the `ui://` MCP App bundles. */
export async function listMcpResourceCatalog() {
  return introspect((client) => client.listResources());
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
