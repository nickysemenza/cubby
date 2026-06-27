import type { IngredientOut } from "@cubby/schemas/ingredient";
import type { LocationOut } from "@cubby/schemas/location";
import type {
  McpIngredientOut,
  McpInventoryLocationOut,
  McpInventoryOut,
  McpInventoryProductOut,
  McpLocationOut,
  McpMealOut,
  McpProductOut,
  McpProductUnitMappingOut,
  McpRecipeOut,
  McpUsdaFoodOut,
} from "@cubby/schemas/mcp-responses";
import type { MealOut } from "@cubby/schemas/meal-responses";
import type { ProductTopLevelOut } from "@cubby/schemas/product";
import type { RecipeTopLevel } from "@cubby/schemas/recipe-responses";
import type { mcpUnitMappingInput } from "@cubby/schemas/unitmapping";
import type { foodSummary } from "@cubby/usda-schemas";
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
// shapes are named schema exports from `@cubby/schemas/mcp-responses`, so the
// MCP tool surface no longer hand-rolls response contracts in the app. The
// functions below only map list- or detail-shaped router rows onto those
// contracts. Return types are annotated with the schema-inferred exports so
// a canonical field rename/removal surfaces here
// at typecheck. The same projection runs over both list rows and detail rows,
// which carry different extra fields — hence the permissive row input types.
// ---------------------------------------------------------------------------

type LocationRow = LocationOut & {
  parent?: Pick<LocationOut, "id" | "name"> | null;
  children?: Array<Pick<LocationOut, "id" | "name">>;
};
export function slimLocation(locRow: Row): McpLocationOut {
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

type InventoryRow = Pick<McpInventoryOut, "id" | "amount" | "valuation"> & {
  product?: McpInventoryProductOut | null;
  location?: McpInventoryLocationOut | null;
};
export function slimInventory(entryRow: Row): McpInventoryOut {
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

type ProductRow = ProductTopLevelOut & {
  food?: { fdc_id?: number | null } | null;
  ingredient?: { id?: McpProductOut["ingredientId"] } | null;
  ingredientId?: McpProductOut["ingredientId"];
  unitMappings?: McpProductUnitMappingOut[];
};
export function slimProduct(pRow: Row): McpProductOut {
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

type RecipeRow = RecipeTopLevel & {
  shortcode?: McpRecipeOut["shortcode"];
};
export function slimRecipe(rRow: Row): McpRecipeOut {
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

type IngredientRow = IngredientOut & {
  product?: McpIngredientOut["products"];
  appearsInRecipes?: unknown[];
  food?: { fdc_id?: number | null } | null;
};
export function slimIngredient(iRow: Row): McpIngredientOut {
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

/** Strip a meal to its essentials and summarize each planned recipe. The per-recipe
 * `id` is the mealRecipe id — pass it to update_meal_recipe / remove_meal_recipe. */
export function slimMeal(mRow: Row): McpMealOut {
  const m = mRow as MealOut;
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

type UsdaFoodRow = z.infer<typeof foodSummary> & {
  linkedProducts?: McpUsdaFoodOut["linkedProducts"];
};
/** Project a USDA food: description/link keys, full nutrition (per-100 + named
 * summary), the portion table, and branded serving info. */
export function slimUsdaFood(fRow: Row): McpUsdaFoodOut {
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
