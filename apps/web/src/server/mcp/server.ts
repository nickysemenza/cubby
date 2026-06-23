import {
  ingredientId,
  locationId,
  productId,
  recipeShortcode,
} from "@cubby/schemas/identifiers";
import {
  ingredientBase,
  ingredientFiltersSchema,
  ingredientOut,
} from "@cubby/schemas/ingredient";
import { inventoryEntryOut } from "@cubby/schemas/inventory";
import { locationCreateInput, locationOut } from "@cubby/schemas/location";
import {
  mealCreateInput,
  mealDate,
  mealOut,
  mealRecipeInput,
  mealRecipeOut,
  mealScale,
  mealUpdateData,
} from "@cubby/schemas/meal";
import { mcpPaginationParams } from "@cubby/schemas/pagination";
import {
  productCategory,
  productCreateInput,
  productTopLevelOut,
  productUpdateData,
} from "@cubby/schemas/product";
import {
  recipeCreateInput,
  recipeTopLevel,
  recipeUpdateInput,
} from "@cubby/schemas/recipe";
import {
  mcpUnitMappingInput,
  unitMappingOut,
} from "@cubby/schemas/unitmapping";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import {
  brandedFoodInfo,
  dataTypeEnum,
  fdcId,
  foodPortion,
  type foodSummary,
  ndb,
  nutrientSummary,
  nutrientsPer100,
  upc,
} from "@cubby/usda-schemas";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { TRPCError } from "@trpc/server";
import { omitBy } from "es-toolkit";
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
      return jsonError(message);
    }
  };
}

/** JSON response helper — pretty-printed for readability in MCP clients */
function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** Error response helper — the `isError` counterpart to {@link json}. */
function jsonError(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

/** Normalize an MCP unit mapping to the productCreateInput shape (source: string|null). */
function toUnitMappingInput(m: z.infer<typeof mcpUnitMappingInput>) {
  return { a: m.a, b: m.b, source: m.source ?? null };
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
  return jsonError(
    "Notion integration is not configured. Set the NOTION_API_KEY environment variable.",
  );
}

// ---------------------------------------------------------------------------
// Slim output projections
//
// Each read tool returns a compact projection of a router's rich output. The
// shapes are pinned to the canonical schemas via `slim*Out` (a `.pick()` of the
// entity's output schema) so the field lists can't drift; the functions map the
// (list- or detail-shaped) row onto that shape. Return types are annotated with
// `z.infer<typeof slim*Out>`, so a canonical field rename/removal surfaces here
// at typecheck. The same projection runs over both list rows and detail rows,
// which carry different extra fields — hence the permissive row input types.
// ---------------------------------------------------------------------------

const slimLocationOut = locationOut
  .pick({ id: true, name: true, shortcode: true, type: true })
  .extend({
    // Hierarchy as pointers, not nested objects. get_location / list_locations
    // both already carry parent + immediate children on the row, so these are
    // reachable in the same call — id+name is enough to navigate.
    parentName: z.string().nullable(),
    parentId: locationId.nullable(),
    children: z.array(z.object({ id: locationId, name: z.string() })),
  });
type LocationRow = z.infer<typeof locationOut> & {
  parent?: Pick<z.infer<typeof locationOut>, "id" | "name"> | null;
  children?: Array<Pick<z.infer<typeof locationOut>, "id" | "name">>;
};
function slimLocation(locRow: Row): z.infer<typeof slimLocationOut> {
  const loc = locRow as LocationRow;
  return {
    id: loc.id,
    name: loc.name,
    shortcode: loc.shortcode,
    type: loc.type,
    parentName: loc.parent?.name ?? null,
    parentId: loc.parent?.id ?? null,
    children: (loc.children ?? []).map((c) => ({ id: c.id, name: c.name })),
  };
}

const slimInventoryProduct = productTopLevelOut.pick({
  id: true,
  name: true,
  manufacturer: true,
  shortcode: true,
});
const slimInventoryOut = inventoryEntryOut
  .pick({ id: true, amount: true, valuation: true })
  .extend({
    product: slimInventoryProduct.nullable(),
    location: locationOut.pick({ id: true, name: true }).nullable(),
  });
type InventoryRow = z.infer<typeof inventoryEntryOut> & {
  product?: z.infer<typeof slimInventoryProduct> | null;
  location?: Pick<z.infer<typeof locationOut>, "id" | "name"> | null;
};
function slimInventory(entryRow: Row): z.infer<typeof slimInventoryOut> {
  const entry = entryRow as InventoryRow;
  return {
    id: entry.id,
    amount: entry.amount,
    valuation: entry.valuation,
    product: entry.product
      ? {
          id: entry.product.id,
          name: entry.product.name,
          manufacturer: entry.product.manufacturer,
          shortcode: entry.product.shortcode,
        }
      : null,
    location: entry.location
      ? { id: entry.location.id, name: entry.location.name }
      : null,
  };
}

const slimProductOut = productTopLevelOut
  .pick({
    id: true,
    name: true,
    shortcode: true,
    manufacturer: true,
    upc: true,
    category: true,
    price: true,
    expectedQuantity: true,
    fdc_id: true,
    usdaUnavailable: true,
    externalIds: true,
  })
  .extend({
    // USDA linkage is resolved at query time (explicit fdc_id, else UPC
    // auto-match) and surfaced as `p.food`; a non-null `usdaFdcId` is the
    // canonical "is it linked" signal — it covers the UPC-only path (stored
    // fdc_id null) too. An agent reaches the full food via get_usda_food.
    usdaFdcId: z.number().nullable(),
    ingredientId: ingredientId.nullable(),
    unitMappings: z.array(
      unitMappingOut.pick({ a: true, b: true, source: true }),
    ),
  });
type ProductRow = z.infer<typeof productTopLevelOut> & {
  food?: { fdc_id?: number | null } | null;
  ingredient?: { id?: z.infer<typeof ingredientId> } | null;
  ingredientId?: z.infer<typeof ingredientId> | null;
  unitMappings?: Array<z.infer<typeof unitMappingOut>>;
};
export function slimProduct(pRow: Row): z.infer<typeof slimProductOut> {
  const p = pRow as ProductRow;
  return {
    id: p.id,
    name: p.name,
    shortcode: p.shortcode,
    manufacturer: p.manufacturer,
    upc: p.upc,
    category: p.category,
    price: p.price,
    expectedQuantity: p.expectedQuantity,
    fdc_id: p.fdc_id ?? null,
    usdaUnavailable: p.usdaUnavailable ?? null,
    externalIds: p.externalIds,
    usdaFdcId: p.food?.fdc_id ?? null,
    ingredientId: p.ingredient?.id ?? p.ingredientId ?? null,
    unitMappings: (p.unitMappings ?? []).map((m) => ({
      a: m.a,
      b: m.b,
      source: m.source ?? null,
    })),
  };
}

const slimRecipeOut = recipeTopLevel
  .pick({ id: true, name: true, yield: true, servings: true, tags: true })
  // recipeTopLevel doesn't model shortcode (the row carries it); keep it nullish.
  .extend({ shortcode: recipeShortcode.nullish() });
type RecipeRow = z.infer<typeof recipeTopLevel> & {
  shortcode?: z.infer<typeof recipeShortcode> | null;
};
function slimRecipe(rRow: Row): z.infer<typeof slimRecipeOut> {
  const r = rRow as RecipeRow;
  return {
    id: r.id,
    name: r.name,
    shortcode: r.shortcode ?? null,
    yield: r.yield,
    servings: r.servings,
    tags: r.tags,
  };
}

const slimIngredientOut = ingredientOut
  .pick({ id: true, name: true, aliases: true })
  .extend({
    products: z.array(z.object({ id: productId, name: z.string() })),
    recipeCount: z.number().int().nonnegative(),
    // Pointer to the ingredient's own USDA food link (reach it via get_usda_food).
    usdaFdcId: z.number().nullable(),
  });
type IngredientRow = z.infer<typeof ingredientOut> & {
  product?: Array<{ id: z.infer<typeof productId>; name: string }>;
  appearsInRecipes?: unknown[];
  food?: { fdc_id?: number | null } | null;
};
function slimIngredient(iRow: Row): z.infer<typeof slimIngredientOut> {
  const i = iRow as IngredientRow;
  return {
    id: i.id,
    name: i.name,
    aliases: i.aliases,
    products: (i.product ?? []).map((p) => ({ id: p.id, name: p.name })),
    recipeCount: (i.appearsInRecipes ?? []).length,
    usdaFdcId: i.food?.fdc_id ?? null,
  };
}

const slimMealRecipeOut = mealRecipeOut
  .pick({ id: true, recipeId: true, scale: true, scaledTotals: true })
  .extend({ name: z.string().nullable() });
const slimMealOut = mealOut
  .pick({ id: true, date: true, name: true, sortOrder: true, totals: true })
  .extend({ recipes: z.array(slimMealRecipeOut) });
/** Strip a meal to its essentials and summarize each planned recipe. The per-recipe
 * `id` is the mealRecipe id — pass it to update_meal_recipe / remove_meal_recipe. */
export function slimMeal(mRow: Row): z.infer<typeof slimMealOut> {
  const m = mRow as z.infer<typeof mealOut>;
  return {
    id: m.id,
    date: m.date,
    name: m.name,
    sortOrder: m.sortOrder,
    totals: m.totals,
    recipes: (m.recipes ?? []).map((mr) => ({
      id: mr.id,
      recipeId: mr.recipeId,
      name: mr.recipe?.name ?? null,
      scale: mr.scale,
      scaledTotals: mr.scaledTotals,
    })),
  };
}

const slimUsdaFoodOut = z.object({
  fdc_id: fdcId,
  description: z.string().nullable(),
  data_type: dataTypeEnum.nullable(),
  brand_owner: z.string().nullable(),
  brand_name: z.string().nullable(),
  gtin_upc: upc.nullable(),
  ndb_number: ndb.nullable(),
  ingredients: z.string().nullable(),
  // Branded serving + the portion table + named-nutrient summary: an agent
  // can't reach these any other way (no portion/nutrient-decode tool exists).
  serving: brandedFoodInfo.shape.serving.nullable(),
  nutrientsPer100: nutrientsPer100.nullable(),
  nutrientSummary: z.array(nutrientSummary),
  portionInfoRaw: z.array(foodPortion),
  linkedProducts: z.array(z.object({ id: productId, name: z.string() })),
});
type UsdaFoodRow = z.infer<typeof foodSummary> & {
  linkedProducts?: Array<{ id: z.infer<typeof productId>; name: string }>;
};
/** Project a USDA food: description/link keys, full nutrition (per-100 + named
 * summary), the portion table, and branded serving info. */
export function slimUsdaFood(fRow: Row): z.infer<typeof slimUsdaFoodOut> {
  const f = fRow as UsdaFoodRow;
  return {
    fdc_id: f.fdc_id,
    description: f.foodInfo?.description ?? null,
    data_type: f.foodInfo?.data_type ?? null,
    brand_owner: f.brandedFoodInfo?.brand_owner ?? null,
    brand_name: f.brandedFoodInfo?.brand_name ?? null,
    gtin_upc: f.brandedFoodInfo?.gtin_upc ?? null,
    ndb_number: f.legacyFoodInfo?.ndb_number ?? null,
    ingredients: f.brandedFoodInfo?.ingredients ?? null,
    serving: f.brandedFoodInfo?.serving ?? null,
    nutrientsPer100: f.nutritionInfo?.nutrientsPer100 ?? null,
    nutrientSummary: f.nutritionInfo?.nutrientSummary ?? [],
    portionInfoRaw: f.portionInfoRaw ?? [],
    linkedProducts: (f.linkedProducts ?? []).map((p) => ({
      id: p.id,
      name: p.name,
    })),
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
// Each slim projection takes a loose `Row` and casts once to its typed row shape
// internally (the router results are dynamically shaped via a string routerName),
// then pins its OUTPUT to the canonical schema via a `z.infer<typeof slim*Out>`
// return annotation.
type Slim = (row: Row) => unknown;
const identity: Slim = (row) => row;

/** The success tail every create/action tool shares: cast the tRPC result to a
 * Row and slim it into a JSON response. Mirrors the get/update/list factories. */
function respond(result: unknown, slim: Slim = identity) {
  return json(slim(result as Row));
}

/** Like {@link respond} for tools that return an array of rows. */
function respondList(result: unknown, slim: Slim = identity) {
  return json((result as Row[]).map(slim));
}

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
    const data = omitBy(rest, (v) => v === undefined);
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
      ...mcpPaginationParams,
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
      productId: idParam("Product"),
      locationId: idParam("Location"),
      value: z.number().positive().describe("Quantity value (must be > 0)"),
      unit: z.string().describe("Unit (e.g. 'each', 'lb', 'oz', 'cup')"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.inventory.create({
        productId: params.productId,
        locationId: params.locationId,
        amount: { value: params.value, unit: params.unit },
      });
      return respond(result, slimInventory);
    }),
  );

  server.tool(
    "update_inventory_entry",
    "Update an inventory entry's amount, product, or location. When updating amount, both value and unit must be provided together.",
    {
      id: idParam("Inventory entry"),
      value: z
        .number()
        .positive()
        .optional()
        .describe("New quantity value, must be > 0 (requires unit)"),
      unit: z.string().optional().describe("New unit (requires value)"),
      productId: idParam("Product").optional().describe("New product ID"),
      locationId: idParam("Location").optional().describe("New location ID"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const data: Record<string, unknown> = {};
      // Require both value and unit together to avoid silent defaults
      if (params.value !== undefined && params.unit !== undefined) {
        data.amount = { value: params.value, unit: params.unit };
      } else if (params.value !== undefined || params.unit !== undefined) {
        return jsonError(
          "Both value and unit must be provided together when updating amount.",
        );
      }
      if (params.productId !== undefined) data.productId = params.productId;
      if (params.locationId !== undefined) data.locationId = params.locationId;
      const result = await caller.inventory.update({ id: params.id, data });
      return respond(result, slimInventory);
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
      sourceLocationId: idParam("Source location"),
      targetLocationId: idParam("Target location"),
      items: z
        .array(
          z.object({
            inventoryEntryId: idParam("Inventory entry"),
            value: z
              .number()
              .positive()
              .describe("Quantity to move (must be > 0)"),
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
      return respondList(result, slimInventory);
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
      category: productCategory.optional().describe("Filter by category"),
      ...mcpPaginationParams,
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
    'Create a new product. Use for items not found via search_products. Pass ingredientId to link it to an ingredient and/or unitMappings (e.g. "8 oz = $10") so recipes can cost it; useful for specialty items with no USDA match.',
    {
      // Field shapes + descriptions come from the canonical productCreateInput
      // (name required; the rest optional for quick entry). unitMappings uses the
      // MCP edge variant (source omittable).
      name: productCreateInput.shape.name,
      ...productCreateInput
        .pick({
          manufacturer: true,
          upc: true,
          price: true,
          expectedQuantity: true,
          ingredientId: true,
        })
        .partial().shape,
      unitMappings: z.array(mcpUnitMappingInput).optional(),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      // The quick path (name/price/upc only) preserves the original behavior.
      // Linking an ingredient or attaching mappings needs the full create input,
      // which quickCreate doesn't accept; route through product.create instead.
      const unitMappings = (
        (params.unitMappings as Array<z.infer<typeof mcpUnitMappingInput>>) ??
        []
      ).map(toUnitMappingInput);
      if (params.ingredientId == null && unitMappings.length === 0) {
        const result = await caller.product.quickCreate({
          name: params.name,
          manufacturer: params.manufacturer,
          upc: params.upc,
          price: params.price,
          expectedQuantity: params.expectedQuantity,
        });
        return respond(result, slimProduct);
      }
      const result = await caller.product.create({
        name: params.name,
        manufacturer: params.manufacturer ?? UNSPECIFIED_MANUFACTURER,
        upc: (params.upc as string | undefined) ?? null,
        fdc_id: null,
        expectedQuantity:
          (params.expectedQuantity as number | undefined) ?? null,
        ingredientId: (params.ingredientId as string | undefined) ?? null,
        price: (params.price as number | undefined) ?? null,
        unitMappings,
      });
      return respond(result, slimProduct);
    }),
  );

  server.tool(
    "update_product",
    "Update a product's fields. To set fdc_id, get the id from find_usda_food/search_usda_foods first. externalIds replaces the full set when provided.",
    {
      id: idParam("Product"),
      // Curated subset of productUpdateData — field shapes + descriptions are
      // canonical (so forms / tRPC / MCP stay in sync). unitMappings are managed
      // by update_product_unit_mappings, not here.
      ...productUpdateData.pick({
        name: true,
        manufacturer: true,
        upc: true,
        fdc_id: true,
        usdaUnavailable: true,
        price: true,
        category: true,
        notes: true,
        externalIds: true,
      }).shape,
    },
    updateHandler("product", slimProduct),
  );

  server.tool(
    "update_product_unit_mappings",
    'Replace the unit mappings on a product (conversion/price edges like "8 oz = $10"). Pass the COMPLETE desired set; existing mappings not in the list are removed. Money unit is "dollar"; nutrient edges (b unit "kcal", "g protein") also work.',
    {
      id: idParam("Product"),
      unitMappings: z
        .array(mcpUnitMappingInput)
        .describe(
          'The complete set of mappings to keep, e.g. [{ a: { value: 8, unit: "oz" }, b: { value: 10, unit: "dollar" } }]. An empty array clears all mappings.',
        ),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const unitMappings = (
        params.unitMappings as Array<z.infer<typeof mcpUnitMappingInput>>
      ).map(toUnitMappingInput);
      const result = await caller.product.update({
        id: params.id,
        data: { unitMappings },
      });
      return respond(result, slimProduct);
    }),
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
      upc,
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
      return respond(result, slimProduct);
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
      // Locations intentionally diverge: only nameFilter is exposed (not
      // itemTypeFilter) and the page size is capped higher (200) since the
      // location tree is small and usually wanted whole. Each row carries its
      // parent + children pointers, so the hierarchy is navigable from here.
      pageIndex: mcpPaginationParams.pageIndex,
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
        locations: result.items.map((l: Row) => slimLocation(l)),
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
      // Field shapes + descriptions from canonical locationCreateInput (name
      // required; type/parentId optional). Images are managed elsewhere.
      name: locationCreateInput.shape.name,
      ...locationCreateInput.pick({ type: true, parentId: true }).partial()
        .shape,
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.location.create({
        name: params.name,
        type: params.type,
        parentId: params.parentId,
      });
      return respond(result, slimLocation);
    }),
  );

  server.tool(
    "update_location",
    "Update a location's name, type, or parent.",
    {
      id: idParam("Location"),
      // Curated subset of canonical locationCreateInput (all optional for update).
      ...locationCreateInput
        .pick({ name: true, type: true, parentId: true })
        .partial().shape,
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
      // Field names match the router filter exactly — reuse its shape + docs.
      ...ingredientFiltersSchema.shape,
      ...mcpPaginationParams,
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
      name: ingredientBase.shape.name.describe("Ingredient name"),
      aliases: ingredientBase.shape.aliases
        .optional()
        .describe("Alternate names for this ingredient"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.ingredient.create({
        name: params.name,
        aliases: params.aliases ?? [],
      });
      return respond(result, slimIngredient);
    }),
  );

  server.tool(
    "resolve_ingredients",
    "Batch-resolve a list of ingredient names to IDs in one call: each name is matched to an existing ingredient (case-insensitive, including aliases) or created if missing. Returns one entry per name with `matched`/`created` flags and the resolved id. Use this instead of calling search_ingredients then create_ingredient one name at a time.",
    {
      names: z
        .array(z.string().min(1))
        .describe(
          "Ingredient names to resolve or create, e.g. ['jasmine rice', 'scallion', 'soy sauce']",
        ),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.ingredient.resolveOrCreate({
        names: params.names,
      });
      return json(result);
    }),
  );

  server.tool(
    "update_ingredient",
    "Update an ingredient's name or aliases.",
    {
      id: idParam("Ingredient"),
      name: ingredientBase.shape.name.optional().describe("New name"),
      aliases: ingredientBase.shape.aliases
        .optional()
        .describe("New aliases (replaces)"),
    },
    updateHandler("ingredient", slimIngredient),
  );

  server.tool(
    "merge_ingredients",
    "Merge duplicate ingredients into one. Aliases are absorbed into the target, and their recipes/products are re-pointed to it.",
    {
      target: idParam("Ingredient").describe("ID of the ingredient to keep"),
      aliases: z
        .array(idParam("Ingredient"))
        .min(1)
        .describe("IDs of duplicate ingredients to merge into the target"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.ingredient.merge({
        target: params.target,
        aliases: params.aliases,
      });
      return respond(result, slimIngredient);
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
      nameFilter: z
        .string()
        .optional()
        .describe("Filter by recipe name (substring)"),
      ...mcpPaginationParams,
    },
    listHandler("recipe", slimRecipe, {
      orderBy: "name",
      buildFilters: (p) => ({ nameFilter: p.nameFilter }),
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

  // Raw-text recipe input: ingredient/instruction lines as plain strings (no
  // pre-resolved IDs). The server WASM-parses each ingredient line and
  // find-or-creates ingredients — the same pipeline as URL/Notion import. Maps
  // onto the `ImportRecipe` carrier consumed by `recipe.insertImport`.
  const createRecipeFromTextInput = z.object({
    name: z.string().min(1).describe("Recipe name"),
    servings: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Number of servings"),
    yield: z
      .string()
      .optional()
      .describe(
        "Freeform yield, e.g. '2 loaves' or 'Makes 12 pancakes' (parsed server-side)",
      ),
    notes: z.string().optional().describe("Headnote / notes markdown"),
    sections: z
      .array(
        z.object({
          name: z
            .string()
            .optional()
            .describe(
              "Section name, e.g. 'Sauce' (omit for a single unnamed section)",
            ),
          ingredients: z
            .array(z.string())
            .describe(
              "Raw ingredient lines, e.g. '1 cup jasmine rice' — NOT ingredient IDs",
            ),
          instructions: z
            .array(z.string())
            .default([])
            .describe("Instruction step lines, one string per step"),
        }),
      )
      .min(1)
      .describe(
        "Recipe sections; each holds raw ingredient lines and instruction steps",
      ),
  });

  server.tool(
    "create_recipe_from_text",
    "Create a recipe from raw text lines WITHOUT pre-resolving ingredient IDs. Pass ingredient and instruction lines as plain strings; the server parses each ingredient line (quantity/unit/name) and find-or-creates ingredients automatically. Mirrors the app's 'from text' / Notion import. Prefer this over resolve_ingredients + create_recipe when building a recipe from a prep sheet or pasted text. Returns the new recipe's id.",
    createRecipeFromTextInput.shape,
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const input = createRecipeFromTextInput.parse(params);
      // Build the ImportRecipe carrier. `meta.recipe_yield` is re-parsed and
      // top-level `servings` wins over the yield-derived count (see
      // normalizeImportRecipe); `meta.description` flows into composed notes.
      const importRecipe = {
        meta: {
          title: input.name,
          ...(input.notes ? { description: input.notes } : {}),
          ...(input.yield ? { recipe_yield: input.yield } : {}),
        },
        sections: input.sections.map((s) => ({
          ...(s.name ? { name: s.name } : {}),
          ingredients: s.ingredients,
          instructions: s.instructions,
        })),
        references: [],
        ...(input.servings != null ? { servings: input.servings } : {}),
      };
      const result = await caller.recipe.insertImport(importRecipe);
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
      return respond(result, slimRecipe);
    }),
  );

  server.tool(
    "update_recipe",
    "Update a recipe's fields. Only provided fields are changed.",
    {
      id: idParam("Recipe"),
      ...recipeUpdateInput.shape.data.shape,
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const { id, ...rest } = params;
      const data = omitBy(rest, (v) => v === undefined);
      const result = await caller.recipe.update({ id, data });
      return respond(result, slimRecipe);
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
          "Return only this problem category (e.g. 'orphanedProducts', 'productsWithNoImages', 'staleIngredientParses'). Ignored when countsOnly is true.",
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

  // ---------------------------------------------------------------------------
  // Meal-planning tools
  //
  // A meal is a planned eating occasion on a calendar day grouping one or more
  // recipes (each at a `scale` multiplier). Cost/calorie rollups derive from
  // recipe.totals × scale. The per-recipe `id` in a meal's `recipes[]` is the
  // mealRecipe id — pass THAT (not the recipe id) to update/remove_meal_recipe.
  // ---------------------------------------------------------------------------

  server.tool(
    "list_meals",
    "List meals (planned eating occasions), most recent first, optionally bounded by a date range.",
    {
      from: mealDate.optional().describe("Only meals on or after this day"),
      to: mealDate.optional().describe("Only meals on or before this day"),
      ...mcpPaginationParams,
    },
    listHandler("meal", slimMeal, {
      orderBy: "date",
      direction: "desc",
      buildFilters: (p) => ({ from: p.from, to: p.to }),
    }),
  );

  server.tool(
    "get_meal",
    "Get a single meal by ID, including its planned recipes and cost/calorie totals.",
    { id: idParam("Meal") },
    getByIdHandler("meal", slimMeal),
  );

  server.tool(
    "create_meal",
    "Create a meal on a calendar day. Optionally include recipes (by recipe ID) to plan in one call; use list_recipes/get_recipe to resolve IDs.",
    mealCreateInput.shape,
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.meal.create(params);
      return respond(result, slimMeal);
    }),
  );

  server.tool(
    "update_meal",
    "Update a meal's date, name, or sort order. Recipes are managed via add/update/remove_meal_recipe.",
    {
      id: idParam("Meal"),
      ...mealUpdateData.shape,
    },
    updateHandler("meal", slimMeal),
  );

  server.tool(
    "delete_meals",
    "Soft-delete meals by IDs. Cascades to the meal's planned recipes.",
    { ids: idsParam("meal") },
    deleteHandler("meal"),
  );

  server.tool(
    "get_meals_by_date_range",
    "Get all meals between two days (inclusive) — the calendar view for a week/range.",
    {
      from: mealDate.describe("Start day (inclusive)"),
      to: mealDate.describe("End day (inclusive)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.meal.getByDateRange({
        from: params.from,
        to: params.to,
      });
      return respondList(result, slimMeal);
    }),
  );

  server.tool(
    "get_shopping_list",
    "Build a shopping list across all meals in a date range: aggregated need vs. on-hand inventory, the shortfall to buy, and a per-meal breakdown of who needs each item. Read-only — never mutates inventory.",
    {
      from: mealDate.describe("Start day (inclusive)"),
      to: mealDate.describe("End day (inclusive)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.meal.getShoppingList({
        from: params.from,
        to: params.to,
      });
      return json(result);
    }),
  );

  server.tool(
    "add_recipe_to_meal",
    "Plan a recipe into a meal at a given scale multiplier (1 = as-written).",
    {
      mealId: idParam("Meal"),
      ...mealRecipeInput.shape,
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.meal.addRecipe({
        mealId: params.mealId,
        recipeId: params.recipeId,
        scale: params.scale,
        sortOrder: params.sortOrder,
      });
      return respond(result, slimMeal);
    }),
  );

  server.tool(
    "update_meal_recipe",
    "Adjust a planned recipe's scale or sort order within its meal.",
    {
      id: z
        .string()
        .describe(
          "Meal-recipe ID (the `id` inside a meal's recipes[], NOT the recipe id)",
        ),
      scale: mealScale.optional().describe("New scale multiplier (e.g. 1.5)"),
      sortOrder: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("New sort order"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.meal.updateRecipe({
        id: params.id,
        scale: params.scale,
        sortOrder: params.sortOrder,
      });
      return respond(result, slimMeal);
    }),
  );

  server.tool(
    "remove_meal_recipe",
    "Remove a planned recipe from its meal.",
    {
      id: z
        .string()
        .describe(
          "Meal-recipe ID (the `id` inside a meal's recipes[], NOT the recipe id)",
        ),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.meal.removeRecipe({ id: params.id });
      return respond(result, slimMeal);
    }),
  );

  // ---------------------------------------------------------------------------
  // USDA food-data tools (read-only lookups against USDA FoodData Central)
  // ---------------------------------------------------------------------------

  server.tool(
    "search_usda_foods",
    "Search USDA FoodData Central by name (full-text). foundation_food & sr_legacy_food are generic whole foods; branded_food is specific products. Use to find a food's FDC id / UPC / NDB for nutrition or for linking a product.",
    {
      query: z.string().describe("Food name to search for"),
      dataType: dataTypeEnum
        .optional()
        .describe("Optional bias toward a USDA data type"),
      ...mcpPaginationParams,
      // Smaller default than the shared param: USDA rows carry nutrient data, so
      // fewer-per-page keeps payloads light. Override the description to match.
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Items per page (default 25, max 100)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.usda.list({
        filters: {
          nameFilter: params.query,
          dataTypeFilter: params.dataType,
        },
        sort: { orderBy: "description", direction: "asc" },
        pagination: {
          pageIndex: (params.pageIndex as number) ?? 0,
          pageSize: (params.pageSize as number) ?? 25,
        },
      });
      return json({
        meta: result.meta,
        items: (result.items as Record<string, unknown>[]).map(slimUsdaFood),
      });
    }),
  );

  server.tool(
    "get_usda_food",
    "Get a USDA food by its FDC id (from search_usda_foods), including compact nutrients-per-100g and any linked Cubby products.",
    { fdcId },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.usda.getByID({ id: params.fdcId });
      return json(
        result ? slimUsdaFood(result as Record<string, unknown>) : null,
      );
    }),
  );

  server.tool(
    "find_usda_food",
    "Look up a USDA food by barcode (UPC/GTIN, 12-14 digits) or NDB number. Provide exactly one.",
    {
      upc: upc.optional(),
      ndbNumber: ndb.optional(),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const upc = params.upc as string | undefined;
      const ndbNumber = params.ndbNumber as number | undefined;
      if ((upc == null) === (ndbNumber == null)) {
        return jsonError("Provide exactly one of `upc` or `ndbNumber`.");
      }
      const lookup =
        upc != null
          ? ({ kind: "upc", gtin_upc: upc } as const)
          : ({ kind: "ndb", ndb_number: ndbNumber as number } as const);
      const result = await caller.usda.getByAlternateID(lookup);
      return json(
        result ? slimUsdaFood(result as Record<string, unknown>) : null,
      );
    }),
  );
}
