import { type Entity, entitySchema } from "@cubby/schemas/entity-core";
import {
  mcpTelemetryIdentitySchema,
  type TelemetryMessageV1,
} from "@cubby/schemas/telemetry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { TraceNames, withTrace } from "~/server/tracing";
import { registerMcpApps } from "./apps";
import {
  getRegisteredTool,
  getToolEntityExtractor,
  installMockStrippedListToolsHandler,
} from "./tools/_shared";
import { registerAuditTools } from "./tools/audit.tools";
import { registerDataQualityTools } from "./tools/data-quality.tools";
import { registerEntityTools } from "./tools/entity.tools";
import { registerEntityIntegrityTools } from "./tools/entity-integrity.tools";
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

Declared exceptions — these stay raw uuids because no public entity shortcode exists for them, and all of them are SUB-entity ids rather than manifest entities: the mealRecipe \`id\` inside a meal's recipes[]; recipe section and section-line ids; unit-mapping ids; background job/batch ids; and orphan/liveness diagnostics whose row may no longer resolve. USDA \`fdc_id\` is also retained as an external USDA identifier rather than a Cubby id.

Workflow tips:
- Read entities://catalog, then call entity with a command object such as {action:"list", entity:"product"} or {action:"get", entity:"product", id:"PRD-…"}. Workflow tools remain for multi-entity work; global_search searches every indexed entity at once.
- Ingredients: batch-resolve names with resolve_ingredients instead of one search+create per name.
- Meals: the \`id\` inside a meal's recipes[] is the mealRecipe id — use THAT (not recipeId) for update_meal_recipe / remove_meal_recipe.
- Products: usdaFdcId reflects either an explicit fdc_id or a barcode-resolved USDA link. A product carries a SET of barcodes as \`gtin\` external ids, canonical GTIN-14; \`primaryGtin\` is the one that stands for it, and the \`upc\` write field sets that slot in any encoding. Use entity action="list", entity="product" with sort="identity_strength" for enrichment worklists, patch_product_external_ids for slot-safe typed identifier changes, and exact (source, kind, externalId) collision checks before adding identity. Entity action="get", entity="product" is the detailed media read; verify_product_images is the explicit R2 integrity check.
- Recipes: prefer create_recipe_from_text for pasted prep sheets; use entity action="create", entity="recipe" when you already have ingredient ids.
- Interactive tools: use search_usda_foods when nutrition mapping requires a choice among plausible USDA records. Let its picker show and refine the candidates, then wait for the user's "Use this" choice instead of reproducing every result in prose. Use get_shopping_list when the user asks what to buy for planned meals in a date range; its checks are temporary and are not saved as manual shopping items.
- Problems: list_problems countsOnly=true for cheap triage; type="duplicateInventory" finds unique Products stored in more than one location.
- Projects, tasks, and expenses use entity; a project's markdown notes come back from entity action=get, entity=project.
- Ledger shape: \`Expense → Purchase ← FinancialTransaction → FinancialAccount\`, with \`Vendor ──< Purchase\`. ALL spend lives on \`Expense.cost\`; a \`Purchase\` is one vendor order, receipt, or deliberately separate purchase event (not a card charge), and its \`statedTotal\` is literal vendor paperwork that is never summed into spend. Financial Transactions are settlement evidence only: matching paperwork or Expense totals does not prove payment.
- Reconciling a vendor export against the ledger: match_expenses (read-only, ranks candidates for the whole batch) → entity action=update, entity=expense to set vendor/orderId on what you confirm, or split_expense when one ledger row aggregates several export lines. Never write from a match without confirming it — and run match_expenses before entity action=create, entity=expense, since the row you are about to add usually already exists under a different name.
- Reconciling a purchase against its paperwork: entity update(purchase) records \`statedTotal\`; linked posted refund transactions produce the neutral \`refund_adjusted\` reconciliation status when they exactly explain a lower Expense total. list_problems type="purchasesNotReconciling" contains only the remaining unexplained differences.
- Purchase completeness: start with entity action=list, entity=purchase, filtering dataStatus="needs_data" and optionally dataGap. Purchase and Product outputs carry computed dataQuality; linked Product gaps and exceptions are returned separately on Purchases with targetType/targetId so mutations can address the owning entity without changing the Purchase's own status. Use set_data_exception only for source-backed negative knowledge, and require documentKind when attach_file targets a Purchase.
- Safe attachment: provide a deterministic idempotencyKey for retries and the freshly read expectedImageCount for Product gallery writes. A mismatch is a precondition failure and associates nothing. MIME/signature conflicts are rejected; verify_product_images backfills and checks stored Product files without making ordinary get_product reads contact R2.
- Financial settlement is separate evidence: FinancialTransaction amounts never enter spend. A Purchase is the vendor order/receipt; it may have several FTX- rows (installments, refunds, split tender). Use entity list(financialTransaction) with purchaseId to inspect those rows.
- Household contribution accounting uses standard entities: Expense beneficiaries/funders describe who consumed and initially funded existing cost; LedgerTransfer records later movement between Ledger Parties and owns its complete normalized-claim and evidence-transaction sets. LPY-/LTR- records use entity, not global search or browser pages.
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

type RawRequestHandler = (
  request: unknown,
  extra: { authInfo?: AuthInfo },
) => Promise<unknown>;

type ProtocolInternals = {
  _requestHandlers: Map<string, RawRequestHandler>;
};

type TelemetryExtra = {
  identity?: unknown;
  emit?: (event: TelemetryMessageV1) => Promise<void>;
};

function requestToolName(request: unknown): string | null {
  if (!request || typeof request !== "object") return null;
  const params = (request as { params?: unknown }).params;
  if (!params || typeof params !== "object") return null;
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function requestToolArguments(
  request: unknown,
): Record<string, unknown> | undefined {
  if (!request || typeof request !== "object") return undefined;
  const params = (request as { params?: unknown }).params;
  if (!params || typeof params !== "object") return undefined;
  const args = (params as { arguments?: unknown }).arguments;
  return args && typeof args === "object"
    ? (args as Record<string, unknown>)
    : undefined;
}

/**
 * Which entity a call acted on, for `McpToolCall.entity`.
 *
 * Read from an extractor the tool declared at registration, never by
 * inspecting arguments here: the entity command carries `entity` explicitly,
 * while attachment tools derive it from a shortcode prefix. Other workflow
 * tools declare a static entity when one applies.
 *
 * The result is validated against `entitySchema`, so this stays payload-free:
 * one enum value, never free-form arguments.
 */
function toolCallEntity(
  server: McpServer,
  toolName: string,
  request: unknown,
): Entity | undefined {
  const extractor = getToolEntityExtractor(server, toolName);
  if (!extractor) return undefined;
  try {
    const parsed = entitySchema.safeParse(
      extractor(requestToolArguments(request) ?? {}),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Best-effort: a malformed or unexpected argument shape must never break
    // the call it is only being observed for.
    return undefined;
  }
}

/**
 * Wrap the SDK-installed tools/call handler instead of duplicating its input
 * and output validation. This private-map adapter is intentionally narrow and
 * guarded by MCP server integration tests, like the registered-tool adapter.
 */
function installToolCallTelemetryHandler(server: McpServer): void {
  const protocol = server.server as unknown as ProtocolInternals;
  const original = protocol._requestHandlers.get("tools/call");
  if (!original) throw new Error("MCP tools/call handler is not installed");

  protocol._requestHandlers.set("tools/call", async (request, extra) => {
    const toolName = requestToolName(request);
    const spanName = TraceNames.mcp(toolName ?? "unknown");
    return withTrace(spanName, async (span) => {
      const telemetry = extra.authInfo?.extra?.telemetry as
        | TelemetryExtra
        | undefined;
      const identity = mcpTelemetryIdentitySchema.safeParse(
        telemetry?.identity,
      );
      const registeredAtCall = toolName
        ? getRegisteredTool(server, toolName) !== undefined
        : false;
      span.setAttributes({
        "rpc.system": "mcp",
        "rpc.method": "tools/call",
        "mcp.tool.name": toolName ?? "unknown",
        "mcp.tool.registered": registeredAtCall,
      });

      let result: unknown;
      let outcome: "success" | "error" = "error";
      try {
        result = await original(request, extra);
        outcome =
          result &&
          typeof result === "object" &&
          (result as { isError?: unknown }).isError === true
            ? "error"
            : "success";
        if (outcome === "error") span.setError("MCP tool returned an error");
      } catch (error) {
        span.setError("MCP tool dispatch failed");
        throw error;
      } finally {
        if (toolName && identity.success && telemetry?.emit) {
          try {
            await telemetry.emit({
              version: 1,
              eventId: crypto.randomUUID(),
              occurredAt: new Date().toISOString(),
              release: __GIT_COMMIT__,
              type: "mcp_tool_call",
              toolName,
              outcome,
              registeredAtCall,
              entity: toolCallEntity(server, toolName, request),
              ...identity.data,
            });
          } catch (error) {
            console.error("[MCP telemetry] failed to record tool call", {
              toolName,
              error,
            });
          }
        }
      }
      return result;
    });
  });
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
