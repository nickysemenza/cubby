import { SHORTCODE_PREFIX } from "@cubby/shared";
import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  type AuthInfo,
  McpServer,
  createMcpHandler,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { MCP_TOOLS } from "~/contracts/mcp-tools";
import { ENTITY_KERNEL_ENTITIES } from "~/server/entity-kernel/contracts";
import { MCP_TOOL_BINDINGS } from "~/server/generated/mcp-tools.gen";
import { purchaseAgentRunActions } from "~/server/purchase-import/capabilities";

import { purchaseAgentTools } from "./agent-tool-catalog";
import { registerMcpApps } from "./apps";
import { trustedPurchaseAgent } from "./purchase-agent-protocol";
import { installToolCallTelemetryHandler } from "./tools/tool-call-telemetry";
import { installMockStrippedListToolsHandler } from "./tools/tool-catalog";
import type { ToolCatalogView } from "./tools/tool-catalog";
import {
  operationContextFromExtra,
  registerMcpTools,
  type ToolExtra,
} from "./tools/tool-registration";
import { createMcpClientValidator } from "./validation";

/**
 * MCP Server for Cubby inventory and product management.
 *
 * The tools are compiled once per isolate (`registerMcpTools`); the McpServer
 * and transport are per request — the SDK's `connect()` runs once per
 * instance, and a stateless transport cannot be reused.
 */

const shortcodePrefixInstructions = Object.entries(SHORTCODE_PREFIX)
  .map(([entity, prefix]) => `- ${prefix} ${entity}`)
  .join("\n");

export const MCP_SERVER_INSTRUCTIONS = `Cubby MCP — personal pantry, recipe, and meal-planning API.

Every tool takes {action, ...fields}; its description lists what each action does, and this text names an action as tool.action (call entity_read with {action:"get", ...} for entity_read.get). Read-only tools hold only reads, so they are safe to auto-approve.

Entity ids are public shortcodes, not uuids. Every top-level entity id you receive back from a tool and every entity relationship id you fill in is a short prefixed code (e.g. PRD-4K7M) — the uuid primary key behind it never crosses this API. The prefix names the entity, so a code is self-describing:
${shortcodePrefixInstructions}
A code with the wrong prefix for the field it's passed to (a LOC- code where a tool wants a product) is rejected by input validation before the tool runs, so a mismatched or unresolvable code never reaches a write.

Public outputs omit storage-only child-row and diagnostic ids when no shortcode exists. Three narrow exceptions retain a raw sub-entity id because it is the follow-up write handle: meal_recipe writes return their mealRecipe \`id\`, recipe_insights.using_ingredient returns a section \`lineId\`, and a product's \`unitMappings[]\` rows (from entity_read on product) keep their row \`id\` so resending it updates that mapping in place instead of deleting and recreating it. Entity write inputs may accept those raw sub-entity ids when editing an existing section, line, mapping, or meal-recipe row. USDA \`fdc_id\` is an external USDA identifier rather than a Cubby id.

Workflow tips:
- Reads go through entity_read ({action:"list", entity:"product"} or {action:"get", entity:"product", id:"PRD-…"}), writes through entity ({action:"create", entity:"product", data:{…}}); consult entities://catalog only when a schema leaves a supported entity/action unclear. search.global searches every indexed entity at once. Project, task, and expense records use the same two tools; a project's markdown notes come back from entity_read.get(project).
- Ingredients and plants: batch-resolve names with entity.resolve ({entity:"ingredient", names} or {entity:"plant", plants}) instead of one search+create per name. A Planting names its Plant, never free-text variety.
- Meals: meal_recipe.add returns \`mealRecipeId\`; use that occurrence id (not recipeId) with meal_recipe.update or meal_recipe.remove. Entity meal reads omit the storage-only mealRecipe id.
- Products: usdaFdcId reflects either an explicit fdc_id or a barcode-resolved USDA link. A product carries a SET of barcodes as \`gtin\` external ids, canonical GTIN-14; \`primaryGtin\` is the one that stands for it, and the \`upc\` write field sets that slot in any encoding. Use entity_read.list with sort="dataQuality" (ascending = weakest identity first; every scored entity accepts it, plus dataStatus/dataGap filters) for enrichment worklists, product_enrichment.patch_external_ids for slot-safe typed identifier changes, and imports_read.external_id_collisions for exact (source, kind, externalId) checks before adding identity. entity_read.get(product) with resultDetail "full" is the detailed media read; product_enrichment.verify_images is the explicit R2 integrity check.
- Recipes: prefer recipe_import.from_text for pasted prep sheets; use entity.create(recipe) when you already have ingredient ids.
- Interactive: use usda_food.search when nutrition mapping requires a choice among plausible USDA records; its picker shows and refines the candidates, so wait for the user's "Use this" choice instead of reproducing every result in prose. Use nutrition.shopping_list when the user asks what to buy for planned meals in a date range; its checks are temporary and are not saved as manual shopping items.
- Problems: activity.problems with countsOnly=true for cheap triage; type="duplicateInventory" finds unique Products stored in more than one location.
- Ledger shape: \`Expense → Purchase ← FinancialTransaction → FinancialAccount\`, with \`Vendor ──< Purchase\`. ALL spend lives on \`Expense.cost\`; a \`Purchase\` is one vendor order, receipt, or deliberately separate purchase event (not a card charge), and its \`statedTotal\` is literal vendor paperwork that is never summed into spend. Financial Transactions are settlement evidence only: matching paperwork or Expense totals does not prove payment.
- Reconciling a vendor export against the ledger: finance_read.expense_match (read-only, ranks candidates for the whole batch) → entity.update(expense) to set vendor/orderId on what you confirm, or expenses.split when one ledger row aggregates several export lines. Never write from a match without confirming it — and run the match before entity.create(expense), since the row you are about to add usually already exists under a different name.
- Reconciling a purchase against its paperwork: entity.update(purchase) records \`statedTotal\`; linked posted refund transactions produce the neutral \`refund_adjusted\` reconciliation status when they exactly explain a lower Expense total. activity.problems type="purchasesNotReconciling" contains only the remaining unexplained differences.
- Purchase completeness: start with entity_read.list(purchase), filtering dataStatus="needs_data" and optionally dataGap. Purchase and Product outputs carry computed dataQuality; linked Product gaps and exceptions are returned separately on Purchases with targetType/targetId so mutations can address the owning entity without changing the Purchase's own status. Use data_exception.set only for source-backed negative knowledge, and give documentKind when image.attach_files targets a Purchase.
- Gallery attachments: image.attach_files and image.attach_existing accept every ordered-gallery entity listed in their schema, including Garden Entries, meals, and tasks. For local files, call image.create_uploads, PUT each successful item with its declared Content-Type, then pass the returned uploadIds to image.attach_files. Covers and vendor logos have their own replacement fields, not gallery attachment targets. Provide a deterministic idempotencyKey for retries and the freshly read expectedImageCount for Product gallery writes; a mismatch is a precondition failure and attaches nothing. MIME/signature conflicts are rejected; product_enrichment.verify_images backfills and checks stored Product files without making ordinary entity_read.get(product) reads contact R2.
- Financial settlement is separate evidence: FinancialTransaction amounts never enter spend. A Purchase is the vendor order/receipt; it may have several FTX- rows (installments, refunds, split tender). Use entity_read.list(financialTransaction) with purchaseId to inspect those rows.
- Household contribution accounting uses standard entities: Expense beneficiaries/funders describe who consumed and initially funded existing cost; LedgerTransfer records later movement between Ledger Parties and owns its complete normalized-claim and evidence-transaction sets. LPY-/LTR- records use entity_read/entity rather than search.global; they are not indexed for semantic search.
- Ledger imports are client-orchestrated through standard mutations. Independent creates/updates may use entity.commands; there is intentionally no custom cross-record transactional importer. Retry with the same normalized Source Claim and use a reviewed disambiguator for legitimate indistinguishable duplicates.
- Monarch CSVs stay client-side: parse them in the MCP client, then use finance_read.preview_import in batches before creating approved ready_to_create rows with entity.create(financialTransaction). The preview is read-only and its stable source references make unchanged rows from later full-history exports no-ops.
- entity_read.list returns { meta, items } paginated objects. Every other action documents its own batch behavior.
- structuredContent is canonical; text content mirrors the same JSON.`;

// Re-exported for the unit test, which exercises the slim projections directly.
export {
  slimMeal,
  slimProduct,
  slimProductDetail,
  slimUsdaFood,
} from "~/contracts/mcp-projections";

function registerEntityCatalog(server: McpServer) {
  server.registerResource(
    "entities_catalog",
    "entities://catalog",
    {
      description:
        "The entity-kernel contract: supported entities, the entity_read / entity actions, and each action's precise JSON Schema.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "entities://catalog",
          mimeType: "application/json",
          text: JSON.stringify({
            entities: ENTITY_KERNEL_ENTITIES,
            actions: Object.fromEntries(
              (["entity_read", "entity"] as const).flatMap((tool) =>
                Object.entries(MCP_TOOL_BINDINGS[tool].actions).flatMap(
                  ([action, binding]) =>
                    "kernel" in binding
                      ? [
                          [
                            `${tool}.${action}`,
                            {
                              writes: tool === "entity",
                              inputSchema: z.toJSONSchema(
                                binding.kernel.input,
                                { unrepresentable: "any", io: "input" },
                              ),
                            },
                          ],
                        ]
                      : [],
                ),
              ),
            ),
          }),
        },
      ],
    }),
  );
}

/** The calling purchase agent sees only the actions its run's purpose mounts. */
async function purchaseAgentCatalogView(
  extra: ToolExtra,
): Promise<ToolCatalogView | undefined> {
  const trusted = trustedPurchaseAgent(extra);
  if (!trusted) return undefined;
  const operationContext = operationContextFromExtra(extra);
  if (!operationContext) return () => null;
  const prepared = await operationContext.prepare("strong");
  const { allowed } = await purchaseAgentRunActions(
    prepared.entityKernel.db,
    trusted.runId,
  );
  const tools = new Map(
    purchaseAgentTools(new Set(allowed)).map((tool) => [tool.name, tool]),
  );
  return (name) => tools.get(name) ?? null;
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
  registerMcpTools(server, MCP_TOOL_BINDINGS, MCP_TOOLS);
  registerEntityCatalog(server);
  // The `ui://` resources those tools' `_meta.ui.resourceUri` pointers resolve
  // to. Adds the `resources` capability beside the entity catalog.
  registerMcpApps(server);
  installToolCallTelemetryHandler(server);
  installMockStrippedListToolsHandler(server, purchaseAgentCatalogView);
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

const httpHandler = createMcpHandler(createMcpServer, {
  // Modern (2026-07-28+) protocol only: a 2025-era `initialize` handshake
  // gets the unsupported-protocol-version error naming the served revisions.
  legacy: "reject",
  // The private Worker binding closes its database client when fetch
  // returns, so a response must not stream past dispatch.
  responseMode: "json",
});

/** Each request gets a fresh server with the authenticated caller context. */
export function handleMcpRequest(
  request: Request,
  authInfo: AuthInfo,
): Promise<Response> {
  return httpHandler.fetch(request, { authInfo });
}
