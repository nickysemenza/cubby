import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { registerMcpApps } from "./apps";
import { installMockStrippedListToolsHandler } from "./tools/_shared";
import { registerAuditTools } from "./tools/audit.tools";
import { registerDataQualityTools } from "./tools/data-quality.tools";
import { registerEntityIntegrityTools } from "./tools/entity-integrity.tools";
import { registerEntityTools } from "./tools/entity.tools";
import { registerFinancialTools } from "./tools/financial.tools";
import { registerImageTools } from "./tools/image.tools";
import { registerIngredientTools } from "./tools/ingredient.tools";
import { registerInventoryTools } from "./tools/inventory.tools";
import { registerLedgerTools } from "./tools/ledger.tools";
import { registerMealTools } from "./tools/meal.tools";
import { registerProblemsTools } from "./tools/problems.tools";
import { registerProductTools } from "./tools/product.tools";
import { registerProjectTools } from "./tools/project.tools";
import { registerPurchaseTools } from "./tools/purchase.tools";
import { registerRecipeTools } from "./tools/recipe.tools";
import { registerSearchTools } from "./tools/search.tools";
import { installToolCallTelemetryHandler } from "./tools/tool-call-telemetry";
import { registerUsdaTools } from "./tools/usda.tools";
import { createMcpClientValidator } from "./validation";

/**
 * MCP Server for Cubby inventory and product management.
 *
 * The McpServer + tools are created once (module scope). Only the transport
 * is per-request — the SDK requires a fresh transport in stateless mode,
 * but the server itself is stateless and safe to reuse.
 */

export const MCP_SERVER_INSTRUCTIONS = `Cubby MCP — personal pantry, recipe, and meal-planning API.

Entity ids are public shortcodes, not uuids. Every top-level entity id you receive back from a tool and every entity relationship id you fill in is a short prefixed code (e.g. PRD-4K7M) — the uuid primary key behind it never crosses this API. The prefix names the entity, so a code is self-describing:
- PRD- product
- RCP- recipe
- ING- ingredient
- INV- inventory entry
- LOC- location
- MEL- meal
- PRJ- project
- TSK- task
- PLT- planting
- GDE- garden entry
- EXP- expense
- VEN- vendor
- PUR- purchase (one vendor order/receipt event — see the ledger note below; it is not an expense or a card charge)
- FAC- financial account
- FTX- financial transaction
- LPY- ledger party (member, guest, or the household)
- LTR- ledger transfer
- CKB- cookbook
- WSH- wishlist item
- IMG- image
A code with the wrong prefix for the field it's passed to (a LOC- code where a tool wants a product) is rejected by input validation before the tool runs, so a mismatched or unresolvable code never reaches a write.

Public outputs omit storage-only child-row and diagnostic ids when no shortcode exists. Three narrow exceptions retain a raw sub-entity id because it is the follow-up write handle: dedicated meal-recipe mutations return their mealRecipe \`id\`, find_recipes_using_ingredient returns a section \`lineId\`, and a product's \`unitMappings[]\` rows (from find/get/list on product) keep their row \`id\` so resending it updates that mapping in place instead of deleting and recreating it. Entity write inputs may accept those raw sub-entity ids when editing an existing section, line, mapping, or meal-recipe row. USDA \`fdc_id\` is an external USDA identifier rather than a Cubby id.

Workflow tips:
- Read entities://catalog, then call entity with a command object such as {action:"list", entity:"product"} or {action:"get", entity:"product", id:"PRD-…"}. Workflow tools remain for multi-entity work; global_search searches every indexed entity at once.
- Ingredients: batch-resolve names with resolve_ingredients instead of one search+create per name.
- Meals: add_meal_recipe, update_meal_recipe, and remove_meal_recipe return each mealRecipe \`id\`; use that workflow id (not recipeId) for the next update/remove call. Generic entity meal reads omit the storage-only mealRecipe id.
- Products: usdaFdcId reflects either an explicit fdc_id or a barcode-resolved USDA link. A product carries a SET of barcodes as \`gtin\` external ids, canonical GTIN-14; \`primaryGtin\` is the one that stands for it, and the \`upc\` write field sets that slot in any encoding. Use entity action="list", entity="product" with sort="identity_strength" for enrichment worklists, patch_product_external_ids for slot-safe typed identifier changes, and exact (source, kind, externalId) collision checks before adding identity. Entity action="get", entity="product" is the detailed media read; verify_product_images is the explicit R2 integrity check.
- Recipes: prefer create_recipe_from_text for pasted prep sheets; use entity action="create", entity="recipe" when you already have ingredient ids.
- Interactive tools: use search_usda_foods when nutrition mapping requires a choice among plausible USDA records. Let its picker show and refine the candidates, then wait for the user's "Use this" choice instead of reproducing every result in prose. Use get_shopping_list when the user asks what to buy for planned meals in a date range; its checks are temporary and are not saved as manual shopping items.
- Problems: list_problems countsOnly=true for cheap triage; type="duplicateInventory" finds unique Products stored in more than one location.
- Projects, tasks, and expenses use entity; a project's markdown notes come back from entity action=get, entity=project.
- Ledger shape: \`Expense → Purchase ← FinancialTransaction → FinancialAccount\`, with \`Vendor ──< Purchase\`. ALL spend lives on \`Expense.cost\`; a \`Purchase\` is one vendor order, receipt, or deliberately separate purchase event (not a card charge), and its \`statedTotal\` is literal vendor paperwork that is never summed into spend. Financial Transactions are settlement evidence only: matching paperwork or Expense totals does not prove payment.
- Reconciling a vendor export against the ledger: match_expenses (read-only, ranks candidates for the whole batch) → entity action=update, entity=expense to set vendor/orderId on what you confirm, or split_expense when one ledger row aggregates several export lines. Never write from a match without confirming it — and run match_expenses before entity action=create, entity=expense, since the row you are about to add usually already exists under a different name.
- Reconciling a purchase against its paperwork: entity update(purchase) records \`statedTotal\`; linked posted refund transactions produce the neutral \`refund_adjusted\` reconciliation status when they exactly explain a lower Expense total. list_problems type="purchasesNotReconciling" contains only the remaining unexplained differences.
- Purchase completeness: start with entity action=list, entity=purchase, filtering dataStatus="needs_data" and optionally dataGap. Purchase and Product outputs carry computed dataQuality; linked Product gaps and exceptions are returned separately on Purchases with targetType/targetId so mutations can address the owning entity without changing the Purchase's own status. Use set_data_exception only for source-backed negative knowledge, and require documentKind when attach_file targets a Purchase.
- Gallery attachments: attach_file, attach_files, and attach_existing_image accept every ordered-gallery entity listed in their input schema, including Garden Entries, plantings, meals, and tasks. Covers and vendor logos have their own replacement fields, not gallery attachment targets. Provide a deterministic idempotencyKey for retries and the freshly read expectedImageCount for Product gallery writes. A mismatch is a precondition failure and associates nothing. MIME/signature conflicts are rejected; verify_product_images backfills and checks stored Product files without making ordinary get_product reads contact R2.
- Financial settlement is separate evidence: FinancialTransaction amounts never enter spend. A Purchase is the vendor order/receipt; it may have several FTX- rows (installments, refunds, split tender). Use entity list(financialTransaction) with purchaseId to inspect those rows.
- Household contribution accounting uses standard entities: Expense beneficiaries/funders describe who consumed and initially funded existing cost; LedgerTransfer records later movement between Ledger Parties and owns its complete normalized-claim and evidence-transaction sets. LPY-/LTR- records use entity rather than global search; they are not indexed for semantic search, though they now have browser pages.
- Ledger imports are client-orchestrated per record through those standard mutations. Retry with the same normalized Source Claim; use a reviewed disambiguator for legitimate indistinguishable duplicates. There is intentionally no custom batch importer or cross-record transaction.
- Monarch CSVs stay client-side: parse them in the MCP client, then use preview_financial_statement_import in batches before creating approved ready_to_create rows with entity action=create, entity=financialTransaction. The preview is read-only and its stable source references make unchanged rows from later full-history exports no-ops.
- Entity action=list responses return { meta, items } paginated objects. The entity command accepts one deliberate action at a time; workflow tools document their own batch behavior.
- structuredContent is canonical; text content mirrors the same JSON.`;

// Re-exported for the unit test, which exercises the slim projections directly.
export {
  slimMeal,
  slimProduct,
  slimProductDetail,
  slimUsdaFood,
} from "./tools/_shared";

function registerTools(server: McpServer) {
  registerEntityTools(server);
  registerInventoryTools(server);
  registerProductTools(server);
  registerSearchTools(server);
  registerIngredientTools(server);
  registerLedgerTools(server);
  registerRecipeTools(server);
  registerProblemsTools(server);
  registerProjectTools(server);
  registerPurchaseTools(server);
  registerFinancialTools(server);
  registerMealTools(server);
  registerUsdaTools(server);
  registerImageTools(server);
  registerAuditTools(server);
  registerDataQualityTools(server);
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
      version: `dev-${__GIT_COMMIT__}`,
    },
    {
      instructions: MCP_SERVER_INSTRUCTIONS,
    },
  );
  registerTools(server);
  installToolCallTelemetryHandler(server);
  installMockStrippedListToolsHandler(server);
  return server;
}

/** Run one introspection call against a throwaway in-process client/server pair. */
async function introspect<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client(
    { name: "cubby-introspect", version: "1.0.0" },
    { jsonSchemaValidator: createMcpClientValidator() },
  );

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
