import { recipeCreateInput, recipeUpdateInput } from "@cubby/schemas/recipe";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

/**
 * MCP Server for Cubby inventory and product management.
 *
 * The McpServer + tools are created once (module scope). Only the transport
 * is per-request — the SDK requires a fresh transport in stateless mode,
 * but the server itself is stateless and safe to reuse.
 */

// biome-ignore lint/suspicious/noExplicitAny: server-side tRPC caller type
type Caller = any;

function getCaller(extra: {
  authInfo?: { extra?: Record<string, unknown> };
}): Caller {
  return extra.authInfo?.extra?.caller;
}

/** Wrap a tool handler with error handling that returns tRPC/Zod error details */
function withErrorHandling(
  fn: (
    params: Record<string, unknown>,
    extra: { authInfo?: { extra?: Record<string, unknown> } },
  ) => Promise<{ content: { type: "text"; text: string }[] }>,
) {
  return async (
    params: Record<string, unknown>,
    extra: { authInfo?: { extra?: Record<string, unknown> } },
  ) => {
    try {
      return await fn(params, extra);
    } catch (error) {
      let message: string;
      if (error instanceof TRPCError) {
        const reason = (error.cause as { reason?: string })?.reason;
        message = reason
          ? `${error.code}: ${error.message} (${reason})`
          : `${error.code}: ${error.message}`;
      } else if (error instanceof Error) {
        message = error.message;
      } else {
        message = String(error);
      }
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  };
}

/** JSON response helper — pretty-printed for readability in MCP clients */
function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** Case-insensitive substring match for nullable string fields */
function matchesFilter(value: string | null, filter: unknown): boolean {
  if (typeof filter !== "string") return true;
  return value?.toLowerCase().includes(filter.toLowerCase()) ?? false;
}

/** Case-insensitive substring match against a string array */
function matchesArrayFilter(values: string[], filter: unknown): boolean {
  if (typeof filter !== "string") return true;
  const lower = filter.toLowerCase();
  return values.some((v) => v.toLowerCase().includes(lower));
}

function notionUnavailable() {
  return {
    content: [
      {
        type: "text" as const,
        text: "Notion integration is not configured. Set the NOTION_API_KEY environment variable.",
      },
    ],
    isError: true,
  };
}

/** Strip heavy fields from location objects */
function slimLocation(loc: Record<string, unknown>) {
  return {
    id: loc.id,
    name: loc.name,
    shortcode: loc.shortcode,
    type: loc.type,
    parentName: (loc.parent as Record<string, unknown> | null)?.name ?? null,
  };
}

/** Strip heavy fields from inventory entries */
function slimInventory(entry: Record<string, unknown>) {
  const product = entry.product as Record<string, unknown> | null;
  const location = entry.location as Record<string, unknown> | null;
  return {
    id: entry.id,
    amount: entry.amount,
    valuation: entry.valuation,
    product: product
      ? {
          id: product.id,
          name: product.name,
          manufacturer: product.manufacturer,
          shortcode: product.shortcode,
        }
      : null,
    location: location ? { id: location.id, name: location.name } : null,
  };
}

/** Strip heavy fields from product objects */
export function slimProduct(p: Record<string, unknown>) {
  // USDA linkage is resolved at query time (UPC-first, ndb_number fallback) and
  // surfaced as `p.food`; a non-null `usdaFdcId` is the canonical "is it linked"
  // signal and covers BOTH paths. `ndb_number` alone is insufficient — a product
  // linked only by UPC (e.g. Diamond Crystal salt) has a null ndb_number but is
  // still linked. `externalIds` is unrelated (Amazon ASIN / McMaster part #, etc.).
  const food = p.food as { fdc_id?: number } | null | undefined;
  return {
    id: p.id,
    name: p.name,
    shortcode: p.shortcode,
    manufacturer: p.manufacturer,
    upc: p.upc,
    category: p.category,
    price: p.price,
    expectedQuantity: p.expectedQuantity,
    ndb_number: p.ndb_number ?? null,
    usdaFdcId: food?.fdc_id ?? null,
    externalIds: p.externalIds,
  };
}

/** Strip heavy fields from recipe list rows (drops nested sections/images). */
function slimRecipe(r: Record<string, unknown>) {
  return {
    id: r.id,
    name: r.name,
    shortcode: r.shortcode,
    yield: r.yield,
    servings: r.servings,
    tags: r.tags,
  };
}

/** Strip heavy fields from ingredients (drops USDA food + nested recipe data). */
function slimIngredient(i: Record<string, unknown>) {
  const products = (i.product as Record<string, unknown>[] | undefined) ?? [];
  const appearsIn = (i.appearsInRecipes as unknown[] | undefined) ?? [];
  return {
    id: i.id,
    name: i.name,
    aliases: i.aliases,
    products: products.map((p) => ({ id: p.id, name: p.name })),
    recipeCount: appearsIn.length,
  };
}

// ---------------------------------------------------------------------------
// CRUD tool-handler factories
//
// Most entity tools share the same get-by-id / list / update / delete shapes,
// differing only in which router they call and how rows are slimmed. These
// factories capture that body so each server.tool() carries just its name,
// description, and input schema.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Slim = (row: Row) => unknown;
const identity: Slim = (row) => row;

/** Schema for a single `{ id }` input field. */
const idParam = (label: string) => z.string().describe(`${label} ID`);
/** Schema for a `{ ids }` input field on delete tools. */
const idsParam = (label: string) =>
  z.array(z.string()).describe(`Array of ${label} IDs to delete`);

/** Handler for `get_*` tools: fetch one row by id, then slim it. */
function getByIdHandler(routerName: string, slim: Slim = identity) {
  return withErrorHandling(async (params, extra) => {
    const result = await getCaller(extra)[routerName].getByID({
      id: params.id,
    });
    return json(slim(result as Row));
  });
}

/** Handler for `delete_*` tools: soft-delete by ids, report the count. */
function deleteHandler(routerName: string) {
  return withErrorHandling(async (params, extra) => {
    const ids = params.ids as string[];
    await getCaller(extra)[routerName].delete({ ids });
    return json({ deleted: ids.length });
  });
}

/** Handler for `update_*` tools: drop undefined fields, update, then slim. */
function updateHandler(routerName: string, slim: Slim = identity) {
  return withErrorHandling(async (params, extra) => {
    const { id, ...rest } = params;
    const data = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    const result = await getCaller(extra)[routerName].update({ id, data });
    return json(slim(result as Row));
  });
}

/** Handler for paginated `list_*`/`search_*` tools returning `{ meta, items }`. */
function listHandler(
  routerName: string,
  slim: Slim,
  config: {
    orderBy: string;
    direction?: "asc" | "desc";
    buildFilters: (params: Row) => Record<string, unknown>;
    defaultPageSize?: number;
  },
) {
  return withErrorHandling(async (params, extra) => {
    const result = await getCaller(extra)[routerName].list({
      filters: config.buildFilters(params),
      sort: { orderBy: config.orderBy, direction: config.direction ?? "asc" },
      pagination: {
        pageIndex: (params.pageIndex as number) ?? 0,
        pageSize: (params.pageSize as number) ?? config.defaultPageSize ?? 50,
      },
    });
    return json({
      meta: result.meta,
      items: (result.items as Row[]).map(slim),
    });
  });
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

const pageSize = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe("Items per page (default 50, max 100)");
const pageIndex = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Page index, 0-based (default 0)");

function registerTools(server: McpServer) {
  // ---------------------------------------------------------------------------
  // Inventory tools
  // ---------------------------------------------------------------------------

  server.tool(
    "list_inventory",
    "List inventory entries with optional filters.",
    {
      productName: z.string().optional().describe("Filter by product name"),
      locationName: z.string().optional().describe("Filter by location name"),
      locationId: z.string().optional().describe("Filter by exact location ID"),
      pageIndex,
      pageSize,
    },
    listHandler("inventory", slimInventory, {
      orderBy: "createdAt",
      direction: "desc",
      buildFilters: (p) => ({
        productNameFilter: p.productName,
        locationNameFilter: p.locationName,
        locationIdFilter: p.locationId,
      }),
    }),
  );

  server.tool(
    "get_inventory_entry",
    "Get a single inventory entry by ID.",
    { id: idParam("Inventory entry") },
    getByIdHandler("inventory", slimInventory),
  );

  server.tool(
    "create_inventory_entry",
    "Add a product to a location. Use search_products and list_locations first to get IDs.",
    {
      productId: z.string().describe("Product ID"),
      locationId: z.string().describe("Location ID"),
      value: z.number().describe("Quantity value"),
      unit: z.string().describe("Unit (e.g. 'each', 'lb', 'oz', 'cup')"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.inventory.create({
        productId: params.productId,
        locationId: params.locationId,
        amount: { value: params.value, unit: params.unit },
      });
      return json(slimInventory(result as Record<string, unknown>));
    }),
  );

  server.tool(
    "update_inventory_entry",
    "Update an inventory entry's amount, product, or location. When updating amount, both value and unit must be provided together.",
    {
      id: z.string().describe("Inventory entry ID"),
      value: z
        .number()
        .optional()
        .describe("New quantity value (requires unit)"),
      unit: z.string().optional().describe("New unit (requires value)"),
      productId: z.string().optional().describe("New product ID"),
      locationId: z.string().optional().describe("New location ID"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const data: Record<string, unknown> = {};
      // Require both value and unit together to avoid silent defaults
      if (params.value !== undefined && params.unit !== undefined) {
        data.amount = { value: params.value, unit: params.unit };
      } else if (params.value !== undefined || params.unit !== undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Both value and unit must be provided together when updating amount.",
            },
          ],
          isError: true,
        };
      }
      if (params.productId !== undefined) data.productId = params.productId;
      if (params.locationId !== undefined) data.locationId = params.locationId;
      const result = await caller.inventory.update({ id: params.id, data });
      return json(slimInventory(result as Record<string, unknown>));
    }),
  );

  server.tool(
    "delete_inventory_entries",
    "Soft-delete inventory entries by IDs.",
    { ids: idsParam("inventory entry") },
    deleteHandler("inventory"),
  );

  server.tool(
    "bulk_move_inventory",
    "Move inventory entries between locations. Supports partial moves.",
    {
      sourceLocationId: z.string().describe("Source location ID"),
      targetLocationId: z.string().describe("Target location ID"),
      items: z
        .array(
          z.object({
            inventoryEntryId: z.string().describe("Inventory entry ID to move"),
            value: z.number().describe("Quantity to move"),
            unit: z.string().describe("Unit"),
          }),
        )
        .describe("Items to move with quantities"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const items = params.items as {
        inventoryEntryId: string;
        value: number;
        unit: string;
      }[];
      const result = await caller.inventory.bulkMove({
        sourceLocationId: params.sourceLocationId,
        targetLocationId: params.targetLocationId,
        items: items.map((item) => ({
          inventoryEntryId: item.inventoryEntryId,
          quantity: { value: item.value, unit: item.unit },
        })),
      });
      return json(
        (result as Record<string, unknown>[]).map((i) => slimInventory(i)),
      );
    }),
  );

  // ---------------------------------------------------------------------------
  // Product tools
  // ---------------------------------------------------------------------------

  server.tool(
    "search_products",
    "Search products by name, manufacturer, UPC, or category.",
    {
      name: z.string().optional().describe("Filter by product name"),
      manufacturer: z.string().optional().describe("Filter by manufacturer"),
      upc: z.string().optional().describe("Filter by UPC code"),
      category: z.string().optional().describe("Filter by category"),
      pageIndex,
      pageSize,
    },
    listHandler("product", slimProduct, {
      orderBy: "name",
      buildFilters: (p) => ({
        nameFilter: p.name,
        manufacturerFilter: p.manufacturer,
        upcFilter: p.upc,
        categoryFilter: p.category,
      }),
    }),
  );

  server.tool(
    "get_product",
    "Get a product by ID.",
    { id: idParam("Product") },
    getByIdHandler("product", slimProduct),
  );

  server.tool(
    "create_product",
    "Create a new product. Use for items not found via search_products.",
    {
      name: z.string().describe("Product name"),
      manufacturer: z
        .string()
        .optional()
        .describe("Manufacturer (defaults to '(unspecified)')"),
      upc: z.string().optional().describe("UPC barcode"),
      price: z.number().optional().describe("Unit price in dollars"),
      expectedQuantity: z
        .number()
        .optional()
        .describe("Expected quantity (1 for unique items, null for unlimited)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.product.quickCreate({
        name: params.name,
        manufacturer: params.manufacturer,
        upc: params.upc,
        price: params.price,
        expectedQuantity: params.expectedQuantity,
      });
      return json(slimProduct(result as Record<string, unknown>));
    }),
  );

  server.tool(
    "update_product",
    "Update a product's fields.",
    {
      id: z.string().describe("Product ID"),
      name: z.string().optional().describe("New name"),
      manufacturer: z.string().optional().describe("New manufacturer"),
      upc: z.string().optional().describe("New UPC"),
      price: z.number().optional().describe("New price"),
      category: z.string().optional().describe("New category"),
      notes: z.string().optional().describe("Notes or URLs"),
      externalIds: z
        .array(
          z.object({
            id: z
              .string()
              .optional()
              .describe("Existing external ID record ID (for updates)"),
            source: z
              .string()
              .describe("Source name (e.g. 'amazon', 'mcmaster', 'mouser')"),
            externalId: z
              .string()
              .describe("The identifier (ASIN, part number, etc.)"),
            url: z
              .string()
              .optional()
              .describe("Direct link to the product page"),
          }),
        )
        .optional()
        .describe(
          "External identifiers. Replaces all existing IDs when provided.",
        ),
    },
    updateHandler("product", slimProduct),
  );

  server.tool(
    "delete_products",
    "Soft-delete products by IDs. Fails if products have inventory entries.",
    { ids: idsParam("product") },
    deleteHandler("product"),
  );

  server.tool(
    "find_product_by_upc",
    "Find or create a product by UPC barcode. Checks local DB, then USDA, then UPC lookup service.",
    {
      upc: z.string().describe("UPC barcode (12-14 digits)"),
      defaultName: z
        .string()
        .optional()
        .describe("Fallback name if not found in any database"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.product.findOrCreateByUPC({
        upc: params.upc,
        defaultName: params.defaultName,
      });
      return json(slimProduct(result as Record<string, unknown>));
    }),
  );

  // ---------------------------------------------------------------------------
  // Location tools
  // ---------------------------------------------------------------------------

  server.tool(
    "list_locations",
    "List all locations with optional name filter. Use to resolve location names to IDs.",
    {
      nameFilter: z.string().optional().describe("Filter by location name"),
      pageIndex,
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Items per page (default 200, max 200)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.location.list({
        filters: { nameFilter: params.nameFilter },
        sort: { orderBy: "name", direction: "asc" },
        pagination: {
          pageIndex: params.pageIndex ?? 0,
          pageSize: params.pageSize ?? 200,
        },
      });
      return json({
        totalCount: result.meta.totalCount,
        locations: result.items.map((l: Record<string, unknown>) =>
          slimLocation(l),
        ),
      });
    }),
  );

  server.tool(
    "get_location",
    "Get a location by ID, including parent info.",
    { id: idParam("Location") },
    getByIdHandler("location", slimLocation),
  );

  server.tool(
    "create_location",
    "Create a new location. Use list_locations to find a parent location ID.",
    {
      name: z.string().describe("Location name"),
      type: z
        .string()
        .optional()
        .describe("Location type (e.g. 'room', 'shelf', 'drawer', 'box')"),
      parentId: z
        .string()
        .optional()
        .describe("Parent location ID for nesting"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.location.create({
        name: params.name,
        type: params.type,
        parentId: params.parentId,
      });
      return json(slimLocation(result as Record<string, unknown>));
    }),
  );

  server.tool(
    "update_location",
    "Update a location's name, type, or parent.",
    {
      id: z.string().describe("Location ID"),
      name: z.string().optional().describe("New name"),
      type: z.string().optional().describe("New type"),
      parentId: z.string().optional().describe("New parent location ID"),
    },
    updateHandler("location", slimLocation),
  );

  server.tool(
    "delete_locations",
    "Soft-delete locations by IDs. Fails if locations have inventory entries.",
    { ids: idsParam("location") },
    deleteHandler("location"),
  );

  // ---------------------------------------------------------------------------
  // Search tools
  // ---------------------------------------------------------------------------

  server.tool(
    "global_search",
    "Search across all entities (products, locations, inventory, recipes).",
    {
      query: z.string().describe("Search query"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results (default 10, max 50)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.search.global({
        query: params.query,
        limit: params.limit ?? 10,
      });
      return json(result);
    }),
  );

  // ---------------------------------------------------------------------------
  // Ingredient tools
  // ---------------------------------------------------------------------------

  server.tool(
    "search_ingredients",
    "Search ingredients by name. Returns id, name, aliases, linked products, and recipe count.",
    {
      nameFilter: z
        .string()
        .optional()
        .describe("Filter by ingredient name (substring)"),
      missingProductsOnly: z
        .boolean()
        .optional()
        .describe("Only return ingredients with no linked products"),
      pageIndex,
      pageSize,
    },
    listHandler("ingredient", slimIngredient, {
      orderBy: "name",
      buildFilters: (p) => ({
        nameFilter: p.nameFilter,
        missingProductsOnly: p.missingProductsOnly,
      }),
    }),
  );

  server.tool(
    "get_ingredient",
    "Get a single ingredient by ID, including linked products and recipes it appears in.",
    { id: idParam("Ingredient") },
    getByIdHandler("ingredient", slimIngredient),
  );

  server.tool(
    "create_ingredient",
    "Create a new ingredient. Use search_ingredients first to avoid duplicates.",
    {
      name: z.string().describe("Ingredient name"),
      aliases: z
        .array(z.string())
        .optional()
        .describe("Alternate names for this ingredient"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.ingredient.create({
        name: params.name,
        aliases: params.aliases ?? [],
      });
      return json(slimIngredient(result as Record<string, unknown>));
    }),
  );

  server.tool(
    "update_ingredient",
    "Update an ingredient's name or aliases.",
    {
      id: z.string().describe("Ingredient ID"),
      name: z.string().optional().describe("New name"),
      aliases: z
        .array(z.string())
        .optional()
        .describe("New aliases (replaces)"),
    },
    updateHandler("ingredient", slimIngredient),
  );

  server.tool(
    "merge_ingredients",
    "Merge duplicate ingredients into one. Aliases are absorbed into the target, and their recipes/products are re-pointed to it.",
    {
      target: z.string().describe("ID of the ingredient to keep"),
      aliases: z
        .array(z.string())
        .min(1)
        .describe("IDs of duplicate ingredients to merge into the target"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.ingredient.merge({
        target: params.target,
        aliases: params.aliases,
      });
      return json(slimIngredient(result as Record<string, unknown>));
    }),
  );

  server.tool(
    "delete_ingredients",
    "Soft-delete ingredients by IDs. Fails if an ingredient is used in recipes or linked to products.",
    { ids: idsParam("ingredient") },
    deleteHandler("ingredient"),
  );

  // ---------------------------------------------------------------------------
  // Recipe tools (read-only)
  // ---------------------------------------------------------------------------

  server.tool(
    "list_recipes",
    "List recipes by name. Returns id, name, shortcode, yield, servings, tags.",
    {
      query: z
        .string()
        .optional()
        .describe("Filter by recipe name (substring)"),
      pageIndex,
      pageSize,
    },
    listHandler("recipe", slimRecipe, {
      orderBy: "name",
      buildFilters: (p) => ({ nameFilter: p.query }),
    }),
  );

  server.tool(
    "get_recipe",
    "Get a recipe by ID, including sections, ingredients, and instructions.",
    { id: idParam("Recipe") },
    getByIdHandler("recipe"),
  );

  server.tool(
    "find_cookable_recipes",
    "Rank recipes by how well current inventory covers their ingredients — answers 'what can I make right now?'. Each result includes a coverage ratio (0..1) and the list of missing ingredients.",
    {
      minCoverage: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Only return recipes with at least this coverage (0..1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max recipes to return (default 24, max 100)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.suggestions.getMakeable({
        minCoverage: params.minCoverage,
        limit: params.limit,
      });
      return json(result);
    }),
  );

  // ---------------------------------------------------------------------------
  // Recipe tools (write)
  // ---------------------------------------------------------------------------

  server.tool(
    "scrape_recipe",
    "Parse a recipe from a URL into structured form WITHOUT saving it. Returns the parsed recipe — use import_recipe to also save it.",
    { url: z.string().url().describe("Recipe page URL") },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.recipe.scrape(params.url);
      return json(result);
    }),
  );

  server.tool(
    "import_recipe",
    "Scrape a recipe from a URL and save it in one step. Returns the new recipe's id.",
    { url: z.string().url().describe("Recipe page URL") },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const imported = await caller.recipe.scrape(params.url);
      const result = await caller.recipe.insertImport(imported);
      return json({ id: result.id });
    }),
  );

  server.tool(
    "create_recipe",
    "Create a recipe from structured input (sections with ingredient IDs and instructions). Use search_ingredients to resolve ingredient IDs first.",
    recipeCreateInput.shape,
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.recipe.create(params);
      return json(slimRecipe(result as Record<string, unknown>));
    }),
  );

  server.tool(
    "update_recipe",
    "Update a recipe's fields. Only provided fields are changed.",
    {
      id: z.string().describe("Recipe ID"),
      ...recipeUpdateInput.shape.data.shape,
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const { id, ...rest } = params;
      const data = Object.fromEntries(
        Object.entries(rest).filter(([, v]) => v !== undefined),
      );
      const result = await caller.recipe.update({ id, data });
      return json(slimRecipe(result as Record<string, unknown>));
    }),
  );

  server.tool(
    "delete_recipe",
    "Soft-delete recipes by IDs.",
    { ids: idsParam("recipe") },
    deleteHandler("recipe"),
  );

  server.tool(
    "list_cookbooks",
    "List cookbooks (recipe sources) with the number of recipes from each.",
    {},
    withErrorHandling(async (_params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.recipe.listCookbooks();
      return json(result);
    }),
  );

  server.tool(
    "get_recipe_tags",
    "List all distinct recipe tags in use.",
    {},
    withErrorHandling(async (_params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.recipe.getAllTags();
      return json(result);
    }),
  );

  server.tool(
    "recompute_recipe_totals",
    "Recompute every recipe's persisted cost/calorie totals (one-shot backfill / recovery, e.g. after the USDA backend was unavailable). Use explain_recipe_costing first to diagnose WHY a total looks wrong.",
    {},
    withErrorHandling(async (_params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.recipe.recomputeAll();
      return json(result);
    }),
  );

  server.tool(
    "explain_recipe_costing",
    "Explain a recipe's cost/calorie totals: persisted state (totals, computed-at, stale?), a fresh compute with per-ingredient diagnostics (usage classification, fired consumption rule, exact per-measure errors, unit-graph conversion paths), named USDA misses, and persisted-vs-computed drift. Read-only. Pair with recompute_recipe_totals to heal.",
    { id: z.string().describe("Recipe ID") },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.recipe.explainCosting({ id: params.id });
      return json(result);
    }),
  );

  // ---------------------------------------------------------------------------
  // Data quality tools
  // ---------------------------------------------------------------------------

  server.tool(
    "list_problems",
    "List data-quality problems across products, inventory, locations, and recipes (e.g. duplicates, invalid UPCs, orphaned products, stale prices, stale ingredient parses where re-parsing the original line would now yield a different name). Use countsOnly for cheap triage, or type to fetch a single category.",
    {
      countsOnly: z
        .boolean()
        .optional()
        .describe(
          "Return only per-type counts and a total, not the full lists",
        ),
      type: z
        .string()
        .optional()
        .describe(
          "Return only this problem category (e.g. 'orphanedProducts', 'invalidUPCs', 'staleIngredientParses'). Ignored when countsOnly is true.",
        ),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      if (params.countsOnly) {
        return json(await caller.problems.getProblemsCount());
      }
      const all = await caller.problems.getAllProblems();
      if (typeof params.type === "string") {
        const slice = (all as Record<string, unknown>)[params.type];
        if (slice === undefined) {
          return json({
            error: `Unknown problem type '${params.type}'`,
            availableTypes: Object.keys(all as Record<string, unknown>),
          });
        }
        return json({ [params.type]: slice });
      }
      return json(all);
    }),
  );

  server.tool(
    "find_duplicate_inventory",
    "Find unique products (expectedQuantity = 1) that appear in more than one location — likely duplicates to consolidate.",
    {
      excludeLocationId: z
        .string()
        .optional()
        .describe("Ignore duplicates that involve this location"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.inventory.findDuplicates({
        excludeLocationId: params.excludeLocationId,
      });
      return json(result);
    }),
  );

  // ---------------------------------------------------------------------------
  // Notion tools (read-only)
  // ---------------------------------------------------------------------------

  const notionLimit = z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Max results to return (default 50, max 200)");

  server.tool(
    "list_projects",
    "List Notion projects with optional filters. Returns project name, status, kind, location, cost estimate, dates, and Notion URL.",
    {
      status: z.string().optional().describe("Filter by status (substring)"),
      kind: z.string().optional().describe("Filter by kind (substring)"),
      location: z
        .string()
        .optional()
        .describe("Filter by location (substring match on any location tag)"),
      name: z
        .string()
        .optional()
        .describe("Filter by project name (substring)"),
      limit: notionLimit,
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const dashboard = await caller.notion.dashboard();
      if (!dashboard) return notionUnavailable();

      const filtered = dashboard.projects
        .filter(
          (p: Record<string, unknown>) =>
            matchesFilter(p.status as string | null, params.status) &&
            matchesFilter(p.kind as string | null, params.kind) &&
            matchesArrayFilter(p.location as string[], params.location) &&
            matchesFilter(p.name as string | null, params.name),
        )
        .slice(0, params.limit ?? 50);

      return json({ count: filtered.length, projects: filtered });
    }),
  );

  server.tool(
    "list_tasks",
    "List Notion tasks with optional filters. Returns task name, status, due date, category, project name, and Notion URL.",
    {
      status: z.string().optional().describe("Filter by status (substring)"),
      projectName: z
        .string()
        .optional()
        .describe("Filter by project name (substring)"),
      category: z
        .string()
        .optional()
        .describe("Filter by category (substring)"),
      name: z.string().optional().describe("Filter by task name (substring)"),
      limit: notionLimit,
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const dashboard = await caller.notion.dashboard();
      if (!dashboard) return notionUnavailable();

      const filtered = dashboard.tasks
        .filter(
          (t: Record<string, unknown>) =>
            matchesFilter(t.status as string | null, params.status) &&
            matchesFilter(t.projectName as string | null, params.projectName) &&
            matchesFilter(t.category as string | null, params.category) &&
            matchesFilter(t.name as string | null, params.name),
        )
        .slice(0, params.limit ?? 50);

      return json({ count: filtered.length, tasks: filtered });
    }),
  );

  server.tool(
    "list_purchases",
    "List Notion purchases with optional filters. Returns purchase name, cost, date, category, purchaser, project name, and Notion URL.",
    {
      category: z
        .string()
        .optional()
        .describe("Filter by category (substring)"),
      projectName: z
        .string()
        .optional()
        .describe("Filter by project name (substring)"),
      purchaser: z
        .string()
        .optional()
        .describe("Filter by purchaser (substring)"),
      name: z
        .string()
        .optional()
        .describe("Filter by purchase name (substring)"),
      limit: notionLimit,
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const dashboard = await caller.notion.dashboard();
      if (!dashboard) return notionUnavailable();

      const filtered = dashboard.purchases
        .filter(
          (p: Record<string, unknown>) =>
            matchesFilter(p.category as string | null, params.category) &&
            matchesFilter(p.projectName as string | null, params.projectName) &&
            matchesFilter(p.purchaser as string | null, params.purchaser) &&
            matchesFilter(p.name as string | null, params.name),
        )
        .slice(0, params.limit ?? 50);

      return json({ count: filtered.length, purchases: filtered });
    }),
  );

  server.tool(
    "get_project_content",
    "Fetch the page content of a Notion project by its page ID. Returns structured blocks (paragraphs, headings, lists, images, etc.).",
    {
      pageId: z
        .string()
        .describe("Notion page ID (from list_projects results)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const content = await caller.notion.projectContent({
        pageId: params.pageId,
      });
      if (content === null) return notionUnavailable();
      return json(content);
    }),
  );
}
