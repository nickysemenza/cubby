import {
  ingredientId,
  locationId,
  productId,
  recipeShortcode,
} from "@cubby/schemas/identifiers";
import { ingredientOut } from "@cubby/schemas/ingredient";
import { inventoryEntryOut } from "@cubby/schemas/inventory";
import { locationOut } from "@cubby/schemas/location";
import { mealOut, mealRecipeOut } from "@cubby/schemas/meal-responses";
import { productTopLevelOut } from "@cubby/schemas/product";
import { recipeTopLevel } from "@cubby/schemas/recipe-responses";
import {
  type mcpUnitMappingInput,
  unitMappingOut,
} from "@cubby/schemas/unitmapping";
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
import { TRPCError } from "@trpc/server";
import { omitBy } from "es-toolkit";
import { z } from "zod";

/**
 * Shared MCP tool-handler scaffolding.
 *
 * Houses the cross-family primitives the per-entity `*.tools.ts` files build on:
 * the tRPC caller accessor, the error wrapper, JSON response helpers, the slim
 * output projections, and the CRUD handler factories. `server.ts` keeps only the
 * server lifecycle + tool registration wiring.
 */

// biome-ignore lint/suspicious/noExplicitAny: server-side tRPC caller type
type Caller = any;

export function getCaller(extra: {
  authInfo?: { extra?: Record<string, unknown> };
}): Caller {
  return extra.authInfo?.extra?.caller;
}

/** Wrap a tool handler with error handling that returns tRPC/Zod error details */
export function withErrorHandling(
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
      return jsonError(formatToolError(error));
    }
  };
}

/**
 * Render an error thrown by a tool handler into a single message string.
 *
 * `createAppError` returns a `TRPCError` carrying `{ code, message, cause:
 * { reason } }`, so an AppError's `code` (and its `reason`, when present) is
 * surfaced to the MCP client — e.g. `NOT_FOUND: Recipe not found (recipeMissing)`.
 */
export function formatToolError(error: unknown): string {
  if (error instanceof TRPCError) {
    const reason = (error.cause as { reason?: string })?.reason;
    return reason
      ? `${error.code}: ${error.message} (${reason})`
      : `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** JSON response helper — pretty-printed for readability in MCP clients */
export function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** Error response helper — the `isError` counterpart to {@link json}. */
export function jsonError(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

/** Normalize an MCP unit mapping to the productCreateInput shape (source: string|null). */
export function toUnitMappingInput(m: z.infer<typeof mcpUnitMappingInput>) {
  return { a: m.a, b: m.b, source: m.source ?? null };
}

/** Case-insensitive substring match for nullable string fields */
export function matchesFilter(value: string | null, filter: unknown): boolean {
  if (typeof filter !== "string") return true;
  return value?.toLowerCase().includes(filter.toLowerCase()) ?? false;
}

/** Case-insensitive substring match against a string array */
export function matchesArrayFilter(values: string[], filter: unknown): boolean {
  if (typeof filter !== "string") return true;
  const lower = filter.toLowerCase();
  return values.some((v) => v.toLowerCase().includes(lower));
}

export function notionUnavailable() {
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
export function slimLocation(locRow: Row): z.infer<typeof slimLocationOut> {
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
export function slimInventory(entryRow: Row): z.infer<typeof slimInventoryOut> {
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
export function slimRecipe(rRow: Row): z.infer<typeof slimRecipeOut> {
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
export function slimIngredient(iRow: Row): z.infer<typeof slimIngredientOut> {
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

export type Row = Record<string, unknown>;
// Each slim projection takes a loose `Row` and casts once to its typed row shape
// internally (the router results are dynamically shaped via a string routerName),
// then pins its OUTPUT to the canonical schema via a `z.infer<typeof slim*Out>`
// return annotation.
type Slim = (row: Row) => unknown;
const identity: Slim = (row) => row;

/** The success tail every create/action tool shares: cast the tRPC result to a
 * Row and slim it into a JSON response. Mirrors the get/update/list factories. */
export function respond(result: unknown, slim: Slim = identity) {
  return json(slim(result as Row));
}

/** Like {@link respond} for tools that return an array of rows. */
export function respondList(result: unknown, slim: Slim = identity) {
  return json((result as Row[]).map(slim));
}

/** Schema for a single `{ id }` input field. */
export const idParam = (label: string) => z.string().describe(`${label} ID`);
/** Schema for a `{ ids }` input field on delete tools. */
export const idsParam = (label: string) =>
  z.array(z.string()).describe(`Array of ${label} IDs to delete`);

/** Handler for `get_*` tools: fetch one row by id, then slim it. */
export function getByIdHandler(routerName: string, slim: Slim = identity) {
  return withErrorHandling(async (params, extra) => {
    const result = await getCaller(extra)[routerName].getByID({
      id: params.id,
    });
    return json(slim(result as Row));
  });
}

/** Handler for `delete_*` tools: soft-delete by ids, report the count. */
export function deleteHandler(routerName: string) {
  return withErrorHandling(async (params, extra) => {
    const ids = params.ids as string[];
    await getCaller(extra)[routerName].delete({ ids });
    return json({ deleted: ids.length });
  });
}

/** Handler for `update_*` tools: drop undefined fields, update, then slim. */
export function updateHandler(routerName: string, slim: Slim = identity) {
  return withErrorHandling(async (params, extra) => {
    const { id, ...rest } = params;
    const data = omitBy(rest, (v) => v === undefined);
    const result = await getCaller(extra)[routerName].update({ id, data });
    return json(slim(result as Row));
  });
}

/** Handler for paginated `list_*`/`search_*` tools returning `{ meta, items }`. */
export function listHandler(
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
