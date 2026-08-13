import { deletedCountOut } from "@cubby/schemas/common";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { shortcodeSchema } from "@cubby/schemas/identifiers";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import {
  type IngredientOut,
  ingredientMcpOut,
} from "@cubby/schemas/ingredient";
import {
  type InventoryMcpOut,
  inventoryMcpOut,
} from "@cubby/schemas/inventory";
import { type LocationOut, locationMcpOut } from "@cubby/schemas/location";
import { mcpUsdaFoodListItemOut, mcpUsdaFoodOut } from "@cubby/schemas/mcp";
import { type MealOut, mealMcpOut } from "@cubby/schemas/meal";
import { mcpListInputShape } from "@cubby/schemas/pagination";
import {
  type ProductMcpDetailOut,
  type ProductMcpOut,
  type ProductTopLevelOut,
  productMcpDetailOut,
  productMcpOut,
} from "@cubby/schemas/product";
import {
  type ExpenseOut,
  expenseOut,
  type ProjectOut,
  projectOut,
  type TaskOut,
  taskOut,
} from "@cubby/schemas/project";
import { type PurchaseOut, purchaseOut } from "@cubby/schemas/purchase";
import { type RecipeTopLevel, recipeMcpOut } from "@cubby/schemas/recipe";
import type { mcpUnitMappingInput } from "@cubby/schemas/unitmapping";
import { type VendorOut, vendorOut } from "@cubby/schemas/vendor";
import type { foodSummary } from "@cubby/usda-schemas";
import type {
  McpServer,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TRPCError } from "@trpc/server";
import { omitBy } from "es-toolkit";
import { z } from "zod";
import type { DomainCaller } from "~/server/api/domain";
import { resolveProductPricing } from "~/server/repo/product/pricing";

/**
 * Shared MCP tool-handler scaffolding.
 *
 * Houses the cross-family primitives the per-entity `*.tools.ts` files build on:
 * the tRPC caller accessor, registerMcpTool, error wrapper, structured response
 * helpers, the slim output projections, and the CRUD handler factories.
 */

export type Caller = DomainCaller;

type ToolExtra = { authInfo?: { extra?: Record<string, unknown> } };

type ZodSchemaLike = z.ZodType | Record<string, z.ZodType>;
type InferSchemaLike<T extends ZodSchemaLike> = T extends z.ZodType
  ? z.infer<T>
  : T extends z.core.$ZodShape
    ? z.infer<z.ZodObject<T>>
    : Record<string, unknown>;

type McpToolHandler<TInput extends ZodSchemaLike, TOutput extends z.ZodType> = (
  params: InferSchemaLike<TInput>,
  extra: ToolExtra,
) => Promise<z.output<TOutput> | CallToolResult>;

type RegisterMcpToolConfig<
  TInput extends ZodSchemaLike,
  TOutput extends z.ZodType,
> = {
  name: string;
  description: string;
  title?: string;
  inputSchema?: TInput;
  outputSchema: TOutput;
  annotations: ToolAnnotations;
  handler: McpToolHandler<TInput, TOutput>;
  /**
   * `ui://` resource this tool renders through (MCP Apps / SEP-1865). Hosts that
   * don't support the extension ignore it and show the structured output, so
   * this is always additive.
   */
  uiResourceUri?: string;
};

/**
 * `_meta` for a tool that declares an MCP App.
 *
 * Both keys are emitted on purpose: `ui.resourceUri` is the current spec, and
 * the flat `ui/resourceUri` is the deprecated alias older hosts still read.
 */
function uiToolMeta(
  resourceUri: string | undefined,
): Record<string, unknown> | undefined {
  if (!resourceUri) return undefined;
  return { ui: { resourceUri }, "ui/resourceUri": resourceUri };
}

type SdkRegisteredTool = {
  title?: string;
  description?: string;
  inputSchema?: z.ZodType;
  outputSchema?: z.ZodType;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  enabled: boolean;
};

type McpServerInternals = {
  _registeredTools: Record<string, SdkRegisteredTool>;
};

/** Reads McpServer._registeredTools — private SDK field; covered by listMcpToolCatalog tests. */
function getRegisteredTools(
  server: McpServer,
): Record<string, SdkRegisteredTool> {
  return (server as unknown as McpServerInternals)._registeredTools;
}

const EMPTY_OBJECT_JSON_SCHEMA = { type: "object", properties: {} };

/**
 * Resolve a tool's declared input to the object schema the SDK registers.
 *
 * `normalizeObjectSchema` recognizes exactly two things — an object schema and
 * a raw shape — and returns `undefined` for everything else (a union, a pipe, a
 * lazy). That `undefined` used to fall back to `z.object({})`, which is not a
 * degradation but a **silent break**: the SDK parses incoming arguments against
 * the registered schema, so every argument was stripped before the handler ran,
 * and `tools/list` advertised `{type: "object", properties: {}}` — a tool that
 * looks argument-less and rejects every call. `preview_entity_operation`
 * shipped that way with a top-level `z.union` input.
 *
 * So: no input at all is fine (an empty object schema is the honest answer),
 * but an input we cannot represent is a registration-time error.
 */
function toolInputSchema(
  toolName: string,
  schema: ZodSchemaLike | undefined,
): z.ZodType {
  // No schema, or an empty raw shape (`{}` — the other way a caller spells "no
  // arguments"). Neither has a field to lose.
  if (
    !schema ||
    (!(schema instanceof z.ZodType) && Object.keys(schema).length === 0)
  ) {
    return z.object({});
  }
  const normalized = normalizeObjectSchema(schema);
  if (!normalized) {
    throw new Error(
      `registerMcpTool(${toolName}): inputSchema must be an object schema or a raw shape. ` +
        "A union, pipe, or other non-object schema normalizes to `undefined` in the MCP SDK, " +
        "which advertises the tool as taking no arguments AND strips every argument before the " +
        "handler runs. Flatten it into one object and put the cross-field rules in `.refine()`.",
    );
  }
  return normalized as z.ZodType;
}

export function stripMockFromJsonSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (Array.isArray(schema)) {
    return schema.map((item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? stripMockFromJsonSchema(item as Record<string, unknown>)
        : item,
    ) as unknown as Record<string, unknown>;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "mock") continue;
    if (value && typeof value === "object") {
      result[key] = Array.isArray(value)
        ? value.map((item) =>
            item && typeof item === "object" && !Array.isArray(item)
              ? stripMockFromJsonSchema(item as Record<string, unknown>)
              : item,
          )
        : stripMockFromJsonSchema(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** @internal Test helper for asserting SDK registration metadata. */
export function getRegisteredTool(
  server: McpServer,
  name: string,
): SdkRegisteredTool | undefined {
  return getRegisteredTools(server)[name];
}

/** Explicit annotation bundles — each tool must reference one at registration time. */
export const READ_ONLY_CLOSED: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const READ_ONLY_OPEN: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const WRITE_CLOSED: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const WRITE_DESTRUCTIVE_CLOSED: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

function structuredSuccess(
  data: unknown,
  outputSchema: z.ZodType,
): CallToolResult {
  const parsed = outputSchema.parse(data);
  return {
    structuredContent: parsed as Record<string, unknown>,
    content: [{ type: "text", text: JSON.stringify(parsed) }],
  };
}

/** Like structuredSuccess but marks the MCP envelope as isError (e.g. total batch failure). */
export function structuredSuccessWithError(
  data: unknown,
  outputSchema: z.ZodType,
): CallToolResult {
  return { ...structuredSuccess(data, outputSchema), isError: true };
}

export function structuredError(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true as const,
  };
}

/**
 * Convert a tool schema to the JSON Schema advertised over the wire.
 *
 * Uses `z.toJSONSchema` directly rather than the SDK's `toJsonSchemaCompat`,
 * which hardcodes its options and so can't express the two settings this
 * boundary needs (every cubby schema is Zod 4, so the SDK's v3 branch is dead
 * weight here — `strictUnions` is a v3-only option it already ignores):
 *
 * - `override` maps `z.date()` to `{type: "string", format: "date-time"}`.
 *   `timestampedFields` (createdAt/updatedAt) plus the per-entity date columns
 *   (`totalsComputedAt`, `lastBulkInventory`, external-id timestamps, …) reach
 *   most read shapes, and Zod refuses to represent a Date in JSON Schema. That
 *   used to throw and drop the whole tool to an opaque
 *   `{type: "object", additionalProperties: true}`. A date-time string is what
 *   clients actually receive: `structuredContent` carries real `Date`s and the
 *   JSON-RPC transport serializes them via `JSON.stringify` → ISO 8601.
 * - `unrepresentable: "any"` keeps any *other* unrepresentable leaf (bigint,
 *   symbol, …) local to its own property instead of failing the whole schema.
 *
 * The catch is a last-resort net only — server.unit.test.ts's "advertises real
 * JSON Schema properties for every tool" asserts no tool falls back to it.
 */
function safeToJsonSchema(obj: z.ZodType, io: "input" | "output") {
  try {
    return stripMockFromJsonSchema(
      z.toJSONSchema(obj as z.ZodType, {
        target: "draft-7",
        io,
        unrepresentable: "any",
        override: (ctx) => {
          if (ctx.zodSchema._zod.def.type === "date") {
            ctx.jsonSchema.type = "string";
            ctx.jsonSchema.format = "date-time";
          }
        },
      }) as Record<string, unknown>,
    );
  } catch {
    return { type: "object", additionalProperties: true };
  }
}

/**
 * The JSON Schema advertised for one side of one registered tool.
 *
 * A tool registered with no schema at all genuinely takes no arguments, and
 * `{type: "object", properties: {}}` says exactly that. A schema that *exists*
 * but doesn't normalize is the silent-substitution bug this file used to have
 * (see `toolInputSchema`), so it throws rather than advertising an empty object
 * that hides real fields.
 */
function advertisedJsonSchema(
  toolName: string,
  schema: z.ZodType | undefined,
  io: "input" | "output",
) {
  if (!schema) return EMPTY_OBJECT_JSON_SCHEMA;
  const normalized = normalizeObjectSchema(schema);
  if (!normalized) {
    throw new Error(
      `${toolName}: registered ${io} schema is not an object schema, so it cannot be advertised without dropping every field.`,
    );
  }
  return safeToJsonSchema(normalized as z.ZodType, io);
}

/** Install a ListTools handler that strips mock metadata from advertised schemas. */
export function installMockStrippedListToolsHandler(server: McpServer) {
  // server.server is the underlying SDK Server — private but stable for ListTools override.
  const registeredTools = getRegisteredTools(server);

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Object.entries(registeredTools)
      .filter(([, tool]) => tool.enabled)
      .map(([name, tool]) => {
        const definition: Record<string, unknown> = {
          name,
          title: tool.title,
          description: tool.description,
          inputSchema: advertisedJsonSchema(name, tool.inputSchema, "input"),
          annotations: tool.annotations,
        };
        // `_meta` carries the MCP Apps `ui.resourceUri` pointer. Rebuilding the
        // definition by hand silently drops it, and a host that never sees the
        // pointer just renders text — no error to trace it back from.
        if (tool._meta) {
          definition._meta = tool._meta;
        }
        if (tool.outputSchema) {
          definition.outputSchema = advertisedJsonSchema(
            name,
            tool.outputSchema,
            "output",
          );
        }
        return definition;
      }),
  }));
}

function isCallToolResult(value: unknown): value is CallToolResult {
  if (!value || typeof value !== "object" || !("content" in value)) {
    return false;
  }
  const content = (value as CallToolResult).content;
  if (!Array.isArray(content)) return false;
  return content.every(
    (item) =>
      !!item &&
      typeof item === "object" &&
      "type" in item &&
      typeof (item as { type: unknown }).type === "string",
  );
}

export function registerMcpTool<
  TInput extends ZodSchemaLike,
  TOutput extends z.ZodType,
>(server: McpServer, config: RegisterMcpToolConfig<TInput, TOutput>) {
  const inputSchema = toolInputSchema(config.name, config.inputSchema);
  const callback = async (
    params: Record<string, unknown>,
    extra: ToolExtra,
  ): Promise<CallToolResult> => {
    try {
      const result = await config.handler(
        (params ?? {}) as InferSchemaLike<TInput>,
        extra as ToolExtra,
      );
      if (isCallToolResult(result)) {
        return result;
      }
      return structuredSuccess(result, config.outputSchema);
    } catch (error) {
      return structuredError(formatToolError(error));
    }
  };
  server.registerTool(
    config.name,
    {
      title: config.title,
      description: config.description,
      inputSchema,
      outputSchema: sdkOutputSchema(config.outputSchema),
      annotations: config.annotations,
      _meta: uiToolMeta(config.uiResourceUri),
    },
    callback as unknown as ToolCallback<typeof inputSchema>,
  );
}

/**
 * The output schema handed to the SDK, which is not always the one we validate
 * against.
 *
 * The SDK runs `normalizeObjectSchema` on a tool's registered `outputSchema`
 * and only recognizes a raw shape or an object schema — anything else (a union,
 * say) normalizes to `undefined`. On `tools/list` that's silently dropped
 * behind an `if (obj)` guard, but `validateToolOutput` then calls
 * `safeParseAsync(undefined, structuredContent)` and dies with "Cannot read
 * properties of undefined (reading '_zod')". So a non-object output schema
 * doesn't degrade the tool, it breaks every call to it — which is what had
 * `list_problems` (the one tool with a `z.union` output) failing outright since
 * it gained a structured schema in #341.
 *
 * `structuredSuccess` already parses the real schema before we return, so the
 * SDK's re-validation is redundant; handing it a permissive object keeps the
 * precise check where it counts and lets the call through. Anything already
 * object-shaped is passed untouched so it still publishes a useful JSON Schema.
 */
function sdkOutputSchema(schema: z.ZodType): z.ZodType {
  return schema instanceof z.ZodObject ? schema : z.looseObject({});
}

export function getCaller(extra: ToolExtra): Caller {
  const caller = extra.authInfo?.extra?.caller;
  if (!caller) throw new Error("Authenticated tRPC caller is missing");
  return caller as Caller;
}

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

export function toUnitMappingInput(m: z.infer<typeof mcpUnitMappingInput>) {
  return { a: m.a, b: m.b, source: m.source ?? null };
}

// Slim output projections

export type Row = Record<string, unknown>;
type Slim<T = unknown> = (row: Row) => T;
const slimSchemas = new WeakMap<Slim, z.ZodType>();
const identity: Slim = (row) => row;

export function defineSlim<T>(schema: z.ZodType<T>, slim: (row: Row) => T) {
  slimSchemas.set(slim as Slim, schema);
  return slim;
}

type LocationRow = LocationOut & {
  parent?: Pick<LocationOut, "id" | "name"> | null;
  children?: Array<Pick<LocationOut, "id" | "name">>;
};
export const slimLocation = defineSlim(locationMcpOut, (locRow: Row) => {
  const loc = locRow as LocationRow;
  return {
    id: loc.id,
    name: loc.name,
    type: loc.type,
    parentName: loc.parent?.name ?? null,
    parentId: loc.parent?.id ?? null,
    children: (loc.children ?? []).map((c) => ({
      id: c.id,
      name: c.name,
    })),
  };
});

type InventoryRow = Pick<InventoryMcpOut, "amount" | "valuation"> & {
  id: InventoryMcpOut["id"];
  product?: {
    id: ProductMcpOut["id"];
    name: string;
    manufacturer: string;
    category: ProductMcpOut["category"];
    model: string | null;
  } | null;
  // Widened (was `{ id: string; name: string }`) so the location ref can carry
  // its own shortcode — every list/detail row already selects it (see
  // dbInventoryEntryToListAPI/dbInventoryEntryToAPI), this type just hadn't
  // caught up.
  location?: { id: LocationOut["id"]; name: string } | null;
};
export const slimInventory = defineSlim(inventoryMcpOut, (entryRow: Row) => {
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
          category: entry.product.category,
          model: entry.product.model,
        }
      : null,
    location: entry.location
      ? { id: entry.location.id, name: entry.location.name }
      : null,
  };
});

type ProductRow = ProductTopLevelOut & {
  food?: { fdc_id?: number | null } | null;
  // Every read path nests the linked ingredient's own row (with its
  // public id) under `ingredient` — there is no bare `ingredientId` field on
  // a real product row to fall back to.
  ingredient?: { id: ProductMcpOut["ingredientId"] } | null;
  unitMappings?: Array<{
    a: ProductMcpOut["unitMappings"][number]["a"];
    b: ProductMcpOut["unitMappings"][number]["b"];
    source: string | null;
  }>;
};
export const slimProduct = defineSlim(productMcpOut, (pRow: Row) => {
  const p = pRow as ProductRow;
  const displayImages = (p.images ?? []).filter(isDisplayableImageFile);
  const pricing = p.pricing ?? resolveProductPricing(p.price);
  return {
    id: p.id,
    name: p.name,
    manufacturer: p.manufacturer,
    model: p.model,
    notes: p.notes,
    upc: p.upc,
    category: p.category,
    tags: p.tags ?? [],
    price: pricing.effectivePrice,
    priceOverride: p.price,
    pricing,
    expectedQuantity: p.expectedQuantity,
    imageCount: displayImages.length,
    coverImageUrl: displayImages[0]?.url ?? null,
    fdc_id: p.fdc_id ?? null,
    usdaUnavailable: p.usdaUnavailable ?? null,
    stockTracked: p.stockTracked ?? null,
    externalIds: p.externalIds,
    usdaFdcId: p.food?.fdc_id ?? null,
    ingredientId: p.ingredient?.id ?? null,
    unitMappings: (p.unitMappings ?? []).map((m) => ({
      a: m.a,
      b: m.b,
      source: m.source ?? null,
    })),
    dataQuality: p.dataQuality,
  };
});

export const slimProductDetail = defineSlim(
  productMcpDetailOut,
  (pRow: Row): ProductMcpDetailOut => {
    const p = pRow as ProductRow;
    const base = slimProduct(pRow);
    let displayPosition = 0;
    const images = (p.images ?? []).map((file) => {
      const displayable = isDisplayableImageFile(file);
      if (displayable) displayPosition += 1;
      return {
        ...file,
        displayPosition: displayable ? displayPosition : null,
        isCover: displayable && displayPosition === 1,
      };
    });
    const cover = images.find((file) => file.isCover) ?? null;
    return {
      ...base,
      imageCount: displayPosition,
      coverImageId: cover?.id ?? null,
      coverImageUrl: cover?.url ?? null,
      images,
    };
  },
);

export const slimRecipe = defineSlim(recipeMcpOut, (rRow: Row) => {
  const r = rRow as RecipeTopLevel;
  return {
    id: r.id,
    name: r.name,
    yield: r.yield,
    servings: r.servings,
    tags: r.tags,
  };
});

type IngredientRow = IngredientOut & {
  product?: Array<{ id: ProductMcpOut["id"]; name: string }>;
  appearsInRecipes?: unknown[];
  food?: { fdc_id?: number | null } | null;
};
export const slimIngredient = defineSlim(ingredientMcpOut, (iRow: Row) => {
  const i = iRow as IngredientRow;
  return {
    id: i.id,
    name: i.name,
    aliases: i.aliases,
    products: (i.product ?? []).map((p) => ({
      id: p.id,
      name: p.name,
    })),
    recipeCount: (i.appearsInRecipes ?? []).length,
    usdaFdcId: i.food?.fdc_id ?? null,
  };
});

// These domain rows already match their MCP schemas; keep only the lean-schema
// validation layer, with no public/private id remapping.
export const slimProject = defineSlim(
  projectOut,
  (row: Row) => row as ProjectOut,
);

export const slimTask = defineSlim(taskOut, (row: Row) => {
  return row as TaskOut;
});

export const slimVendor = defineSlim(vendorOut, (row: Row) => row as VendorOut);

export const slimPurchase = defineSlim(
  purchaseOut,
  (row: Row) => row as PurchaseOut,
);

export const slimExpense = defineSlim(expenseOut, (row: Row) => {
  return row as ExpenseOut;
});

export const slimMeal = defineSlim(mealMcpOut, (mRow: Row) => {
  const m = mRow as MealOut;
  return {
    id: m.id,
    date: m.date,
    name: m.name,
    sortOrder: m.sortOrder,
    totals: m.totals,
    recipes: (m.recipes ?? []).map((mr) => ({
      // mealRecipe row id — declared exception, no shortcode; stays uuid.
      id: mr.id,
      recipeId: mr.recipe.id,
      name: mr.recipe?.name ?? null,
      scale: mr.scale,
      scaledTotals: mr.scaledTotals,
    })),
  };
});

type UsdaFoodRow = z.infer<typeof foodSummary> & {
  // The real row (usda.service.ts's `getLinkedProducts`) is full
  // `ProductTopLevelOut[]` — only the fields the slim projection reads.
  linkedProducts?: Array<Pick<ProductTopLevelOut, "id" | "name">>;
};
/**
 * The nutrients worth reading first, in display order, as USDA names them.
 *
 * `nutrientSummary` arrives in arbitrary order — the top butter result opened
 * with Fiber, Folic acid, Caffeine, Theobromine, then a long run of individual
 * fatty acids, with Protein at index 92 of 115. Anything that reads the head of
 * the list (an agent skimming, a UI slicing the first N) gets theobromine before
 * protein. Entries carry no nutrient code, only a display name, so this matches
 * on the exact USDA strings; an unrecognized name simply keeps its original
 * position after these. Energy is disambiguated by unit — USDA emits both KCAL
 * and kJ rows under the same name.
 */
const NUTRIENT_DISPLAY_ORDER: Array<[name: string, unit?: string]> = [
  ["Energy", "KCAL"],
  ["Protein"],
  ["Total lipid (fat)"],
  ["Carbohydrate, by difference"],
  ["Fiber, total dietary"],
  ["Total Sugars"],
  ["Sodium, Na"],
  ["Cholesterol"],
  ["Fatty acids, total saturated"],
];

function nutrientRank(entry: { name: string; unit: string }): number {
  const index = NUTRIENT_DISPLAY_ORDER.findIndex(
    ([name, unit]) =>
      name === entry.name && (unit === undefined || unit === entry.unit),
  );
  return index === -1 ? NUTRIENT_DISPLAY_ORDER.length : index;
}

/** Key nutrients first, everything else left in the order USDA sent it. */
function orderNutrientSummary<T extends { name: string; unit: string }>(
  summary: T[],
): T[] {
  return summary
    .map((entry, index) => ({ entry, index, rank: nutrientRank(entry) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.entry);
}

export const slimUsdaFood = defineSlim(mcpUsdaFoodOut, (fRow: Row) => {
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
    nutrientSummary: orderNutrientSummary(
      f.nutritionInfo?.nutrientSummary ?? [],
    ),
    portionInfoRaw: f.portionInfoRaw ?? [],
    linkedProducts: (f.linkedProducts ?? []).map((p) => ({
      id: p.id,
      name: p.name,
    })),
  };
});

/**
 * Search-result projection: `slimUsdaFood` minus the full nutrient table.
 *
 * `nutrientSummary` runs to 115 entries (~6.5KB) on an SR Legacy row — every
 * fatty acid, the whole amino-acid profile, all four tocotrienols — which was
 * ~80% of a ten-result response. `nutrientsPer100` already carries the same
 * numbers keyed by nutrient code in ~260B, which is what the picker renders and
 * what an agent needs to choose between foods. `get_usda_food` still returns the
 * full table for the one food you settled on.
 */
export const slimUsdaFoodListItem = defineSlim(
  mcpUsdaFoodListItemOut,
  (fRow: Row) => {
    const { nutrientSummary: _dropped, ...rest } = slimUsdaFood(fRow);
    return rest;
  },
);

function parseResponse(schema: z.ZodType | undefined, value: unknown) {
  return schema ? schema.parse(value) : value;
}

export function respond<T>(
  schema: z.ZodType<T>,
  result: unknown,
  slim?: (row: Row) => T,
): T;
export function respond<T>(result: unknown, slim: Slim<T>): T;
export function respond(result: unknown, slim?: Slim): unknown;
export function respond(
  first: unknown,
  second?: unknown,
  third?: Slim,
): unknown {
  const schema = isSchema(first) ? first : undefined;
  const result = schema ? second : first;
  const slim = schema ? (third ?? identity) : ((second as Slim) ?? identity);
  return parseResponse(schema ?? slimSchemas.get(slim), slim(result as Row));
}

export function respondList<T>(
  schema: z.ZodType<T>,
  result: unknown,
  slim?: (row: Row) => T,
): { items: T[] };
export function respondList<T>(result: unknown, slim: Slim<T>): { items: T[] };
export function respondList(result: unknown, slim?: Slim): { items: unknown[] };
export function respondList(
  first: unknown,
  second?: unknown,
  third?: Slim,
): { items: unknown[] } {
  const schema = isSchema(first) ? first : undefined;
  const result = schema ? second : first;
  const slim = schema ? (third ?? identity) : ((second as Slim) ?? identity);
  const entrySchema = schema ?? slimSchemas.get(slim) ?? z.unknown();
  return {
    items: z.array(entrySchema).parse((result as Row[]).map(slim)),
  };
}

function isSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}

/**
 * A tool parameter naming an entity by its PUBLIC id — the shortcode.
 *
 * This is the one chokepoint every `get_*`/`update_*`/`delete_*` self-id flows
 * through, so swapping it here makes ~30 tools prefix-correct at once. It is the
 * SAME schema the UI and tRPC use — there is no MCP-specific ref type — which is
 * what makes the advertised JSON Schema carry a real `pattern` (`^PRD-[…]{4}$`)
 * instead of a bare string. An agent handed a wrong-entity code fails at zod
 * parse, before the handler runs and therefore before any mutation.
 */
export const idParam = <TEntity extends ShortcodeEntity>(entity: TEntity) =>
  shortcodeSchema(entity);

const idsParam = <TEntity extends ShortcodeEntity>(entity: TEntity) =>
  z
    .array(shortcodeSchema(entity))
    .describe(`Array of ${entity} shortcodes to delete`);

interface DynamicEntityRouter {
  create(input: Record<string, unknown>): Promise<unknown>;
  getByID(input: { id: unknown }): Promise<unknown>;
  delete(input: { ids: string[] }): Promise<unknown>;
  update(input: {
    id: unknown;
    data: Record<string, unknown>;
  }): Promise<unknown>;
  list(input: Record<string, unknown>): Promise<{
    meta: unknown;
    items: unknown[];
  }>;
}

function getEntityRouter(
  caller: Caller,
  routerName: string,
): DynamicEntityRouter {
  const routers = caller as unknown as Record<string, unknown>;
  return routers[routerName] as DynamicEntityRouter;
}

/**
 * How a get tool fetches its row, when the dynamically-resolved
 * `router.getByID({ id })` is the wrong call — e.g. a toolset that wants the
 * statically-typed caller so the id it passes is checked at compile time.
 * Symmetric with the toolset's `create` hatch: the MCP layer adapts, rather
 * than the router changing shape to suit MCP.
 */
type GetByIdFetch = (caller: Caller, id: string) => Promise<unknown>;

function getByIdHandler(
  routerName: string,
  slim: Slim = identity,
  fetch?: GetByIdFetch,
) {
  return async (params: Record<string, unknown>, extra: ToolExtra) => {
    const caller = getCaller(extra);
    const id = params.id as string;
    const result = fetch
      ? await fetch(caller, id)
      : await getEntityRouter(caller, routerName).getByID({ id });
    return respond(result, slim);
  };
}

function deleteHandler(routerName: string) {
  return async (params: Record<string, unknown>, extra: ToolExtra) => {
    const caller = getCaller(extra);
    const ids = params.ids as string[];
    await getEntityRouter(caller, routerName).delete({ ids });
    return { deleted: ids.length };
  };
}

/**
 * Transform an update tool's `data` object after the self-id has been pulled
 * off and before it reaches the router — the hook a FK field inside `data`
 * (e.g. product's `ingredientId`) resolves through, since the generic
 * `updateHandler` below knows nothing about any field but `id`.
 */
type ResolveUpdateData = (
  caller: Caller,
  data: Record<string, unknown>,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

function updateHandler(
  routerName: string,
  slim: Slim = identity,
  resolveData?: ResolveUpdateData,
) {
  return async (params: Record<string, unknown>, extra: ToolExtra) => {
    const caller = getCaller(extra);
    const { id, ...rest } = params;
    let data = omitBy(rest, (v) => v === undefined);
    if (resolveData) data = await resolveData(caller, data);
    const result = await getEntityRouter(caller, routerName).update({
      id: id as string,
      data,
    });
    return respond(result, slim);
  };
}

function batchMutationOut(item: z.ZodType) {
  return z.object({
    summary: z.object({
      requested: z.number().int().nonnegative(),
      succeeded: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
    results: z.array(
      z.discriminatedUnion("status", [
        z.object({
          index: z.number().int().nonnegative(),
          status: z.literal("succeeded"),
          item,
        }),
        z.object({
          index: z.number().int().nonnegative(),
          status: z.literal("failed"),
          error: z.string(),
        }),
      ]),
    ),
  });
}

function schemaFromShape(input: ZodSchemaLike): z.ZodType {
  return input instanceof z.ZodType ? input : z.object(input);
}

/** The default cap on a batch tool's `items[]`. */
const DEFAULT_BATCH_MAX_ITEMS = 50;

type BatchResult =
  | { index: number; status: "succeeded"; item: unknown }
  | { index: number; status: "failed"; error: string };

/**
 * Register a best-effort `{items: [...]}` tool over a per-item operation.
 *
 * Every batch tool in this server has the same contract, and it is deliberately
 * NOT transactional: each item runs the singular operation with its own
 * validation, side effects, and transaction, so one bad item fails alone
 * instead of discarding the caller's other 49. `batchMutationOut` reports each
 * outcome by request index for exactly that reason.
 *
 * A wholly-failed batch is still `isError: false` — the per-item errors are the
 * payload, and flagging the envelope would hide them behind a bare string.
 */
export function registerBatchTool<TItem extends z.ZodType>(
  server: McpServer,
  config: {
    name: string;
    description: string;
    itemInput: TItem;
    itemOutput: z.ZodType;
    maxItems?: number;
    annotations: ToolAnnotations;
    /** Cross-item input rules — e.g. rejecting two items that target one entity. */
    refineItems?: (
      items: Array<z.output<TItem>>,
      ctx: z.core.$RefinementCtx,
    ) => void;
    run: (caller: Caller, item: z.output<TItem>) => Promise<unknown>;
  },
) {
  const items = z
    .array(config.itemInput)
    .min(1)
    .max(config.maxItems ?? DEFAULT_BATCH_MAX_ITEMS);
  const refineItems = config.refineItems;
  const inputSchema = refineItems
    ? z
        .strictObject({ items })
        .superRefine((input, ctx) => refineItems(input.items, ctx))
    : z.strictObject({ items });

  registerMcpTool(server, {
    name: config.name,
    description: config.description,
    inputSchema,
    outputSchema: batchMutationOut(config.itemOutput),
    annotations: config.annotations,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const results: BatchResult[] = [];
      for (const [index, item] of (
        params.items as Array<z.output<TItem>>
      ).entries()) {
        try {
          results.push({
            index,
            status: "succeeded",
            item: await config.run(caller, item),
          });
        } catch (error) {
          results.push({
            index,
            status: "failed",
            error: formatToolError(error),
          });
        }
      }
      const succeeded = results.filter(
        (result) => result.status === "succeeded",
      ).length;
      return {
        summary: {
          requested: results.length,
          succeeded,
          failed: results.length - succeeded,
        },
        results,
      };
    },
  });
}

/**
 * Reject two items in one batch that target the same entity.
 *
 * Two updates to one row in a single call are always a caller mistake: the loop
 * is sequential and non-transactional, so the second silently wins and the
 * first's changes are unrecoverable from the response.
 */
export function rejectDuplicateIds(
  items: ReadonlyArray<unknown>,
  ctx: z.core.$RefinementCtx,
) {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const id = (item as { id?: string }).id;
    if (!id) continue;
    if (seen.has(id)) {
      ctx.addIssue({
        code: "custom",
        path: ["items", index, "id"],
        message: `Duplicate update id ${id}; each item must target a different entity.`,
      });
    }
    seen.add(id);
  }
}

/**
 * A list tool's filter builder. Most entities have no FK filter fields and
 * stay synchronous (`pickSchemaFilters`); one with a filter like
 * `locationIdFilter`/`projectId` needs `caller` to resolve the shortcode to a
 * uuid before it reaches the router, hence the `Caller` param and the
 * `Promise` return — awaited unconditionally below, which is a no-op for a
 * plain synchronous builder.
 */
type BuildListFilters = (
  caller: Caller,
  params: Row,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

function listHandler(
  routerName: string,
  slim: Slim,
  config: {
    orderBy: string;
    direction?: "asc" | "desc";
    buildFilters?: BuildListFilters;
    filterFields?: Record<string, z.ZodType>;
    defaultPageSize?: number;
    sortField?: string;
  },
) {
  const resolveFilters: BuildListFilters =
    config.buildFilters ??
    (config.filterFields
      ? (_caller, params) => pickSchemaFilters(params, config.filterFields!)
      : () => ({}));

  return async (params: Record<string, unknown>, extra: ToolExtra) => {
    const caller = getCaller(extra);
    const result = await getEntityRouter(caller, routerName).list({
      filters: await resolveFilters(caller, params),
      sort: {
        orderBy:
          (params.sort as string | undefined) ??
          config.sortField ??
          config.orderBy,
        direction: config.direction ?? "asc",
      },
      pagination: {
        pageIndex: (params.pageIndex as number) ?? 0,
        pageSize: (params.pageSize as number) ?? config.defaultPageSize ?? 50,
      },
    });
    const schema = slimSchemas.get(slim);
    return {
      meta: result.meta,
      items: z
        .array(schema ?? z.unknown())
        .parse((result.items as Row[]).map(slim)),
    };
  };
}

/**
 * A tool input object that REJECTS an unknown filter key instead of ignoring it.
 *
 * Zod strips unknown keys by default, and `pickSchemaFilters` below then copies
 * only the known ones — so a misspelled or not-yet-deployed filter used to
 * vanish silently and the tool returned the ENTIRE unfiltered set *presented as
 * a filtered result*. That happened for real: during the 2026-07-30 rollout,
 * `list_expenses({costMin: 500})` against a build without `costMin` came back
 * with all 1112 rows. Wrong data that looks right is worse than an error, and
 * any client/server skew reproduces it — a stale tool catalog, a request landing
 * mid-deploy, or a plain typo.
 *
 * Two things make this the right shape rather than a runtime guard in the
 * handler:
 *
 * - The MCP SDK parses arguments against this schema and hands the HANDLER the
 *   parsed object, so by then the offending key is already gone. The rejection
 *   has to live in the schema itself.
 * - `z.strictObject` publishes `additionalProperties: false` in the tool's JSON
 *   Schema, so a well-behaved client is told the rule up front rather than only
 *   discovering it by failing.
 *
 * `shape` is the whole input (filters PLUS `pageIndex`/`pageSize`, which
 * `mcpListInputShape` spreads into the same flat object and which must not trip
 * this); `filterFields` is only what we advertise as filters in the message.
 *
 * The message names the offending key AND lists the valid ones on purpose — an
 * agent told only "unrecognized key" will guess again.
 */
export function strictFilterInput<TShape extends Record<string, z.ZodType>>(
  toolName: string,
  shape: TShape,
  filterFields: Record<string, z.ZodType>,
) {
  const valid = Object.keys(filterFields).sort().join(", ");
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? `Unknown filter ${issue.keys.map((key) => `"${key}"`).join(", ")} for ${toolName}. ` +
          `Valid filters: ${valid}. Filters are matched EXACTLY, and an unknown one is ` +
          "rejected rather than ignored — silently dropping it would return the whole " +
          "unfiltered set as if it were filtered. Check the spelling against the list above."
        : undefined,
  });
}

function pickSchemaFilters(
  params: Row,
  filterFields: Record<string, z.ZodType>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(filterFields)) {
    if (params[key] !== undefined) {
      out[key] = params[key];
    }
  }
  return out;
}

function withIdInput(
  entity: ShortcodeEntity,
  dataShape: Record<string, z.ZodType>,
) {
  return { id: idParam(entity), ...dataShape };
}

type EntityListToolConfig = {
  name: string;
  description: string;
  router: string;
  filterFields: Record<string, z.ZodType>;
  outputSchema: z.ZodType;
  slim: Slim;
  sort: { orderBy: string; direction?: "asc" | "desc" };
  sortInput?: z.ZodType;
  annotations: ToolAnnotations;
  defaultPageSize?: number;
  maxPageSize?: number;
  buildFilters?: BuildListFilters;
};

function registerEntityListTool(
  server: McpServer,
  config: EntityListToolConfig,
) {
  const defaultPageSize = config.defaultPageSize ?? 50;
  registerMcpTool(server, {
    name: config.name,
    description: config.description,
    inputSchema: strictFilterInput(
      config.name,
      {
        ...mcpListInputShape(config.filterFields, {
          defaultPageSize,
          maxPageSize: config.maxPageSize,
        }),
        ...(config.sortInput ? { sort: config.sortInput } : {}),
      },
      config.filterFields,
    ),
    outputSchema: config.outputSchema,
    annotations: config.annotations,
    handler: listHandler(config.router, config.slim, {
      orderBy: config.sort.orderBy,
      direction: config.sort.direction,
      filterFields: config.buildFilters ? undefined : config.filterFields,
      buildFilters: config.buildFilters,
      defaultPageSize,
      sortField: config.sort.orderBy,
    }),
  });
}

function registerEntityGetTool(
  server: McpServer,
  config: {
    name: string;
    description: string;
    router: string;
    entity: ShortcodeEntity;
    outputSchema: z.ZodType;
    slim?: Slim;
    annotations: ToolAnnotations;
    /** Override the fetch when `router.getByID({ id })` is the wrong call. */
    get?: GetByIdFetch;
  },
) {
  registerMcpTool(server, {
    name: config.name,
    description: config.description,
    inputSchema: { id: idParam(config.entity) },
    outputSchema: config.outputSchema,
    annotations: config.annotations,
    handler: getByIdHandler(config.router, config.slim ?? identity, config.get),
  });
}

function registerEntityDeleteTool(
  server: McpServer,
  config: {
    name: string;
    description: string;
    router: string;
    entity: ShortcodeEntity;
    annotations: ToolAnnotations;
  },
) {
  registerMcpTool(server, {
    name: config.name,
    description: config.description,
    inputSchema: { ids: idsParam(config.entity) },
    outputSchema: deletedCountOut,
    annotations: config.annotations,
    handler: deleteHandler(config.router),
  });
}

function registerEntityUpdateTool<TInput extends ZodSchemaLike>(
  server: McpServer,
  config: {
    name: string;
    description: string;
    router: string;
    entity: ShortcodeEntity;
    inputSchema: TInput;
    outputSchema: z.ZodType;
    slim: Slim;
    annotations: ToolAnnotations;
    /** Resolve any FK shortcode fields inside `data` before it reaches the router. */
    resolveUpdateData?: ResolveUpdateData;
  },
) {
  registerMcpTool(server, {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    annotations: config.annotations,
    handler: async (params, extra) =>
      updateHandler(
        config.router,
        config.slim,
        config.resolveUpdateData,
      )(params as Record<string, unknown>, extra),
  });
}

export function registerEntityCreateTool<TInput extends ZodSchemaLike>(
  server: McpServer,
  config: {
    name: string;
    description: string;
    inputSchema: TInput;
    outputSchema: z.ZodType;
    slim: Slim;
    annotations: ToolAnnotations;
    create: (
      caller: Caller,
      params: InferSchemaLike<TInput>,
    ) => Promise<unknown>;
  },
) {
  registerMcpTool(server, {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    annotations: config.annotations,
    handler: async (params, extra) => {
      const result = await config.create(getCaller(extra), params);
      return respond(result, config.slim);
    },
  });
}

type CrudOperation = "list" | "get" | "create" | "update" | "delete";
/**
 * The plural create/update tools. Named separately from {@link CrudOperation}
 * because their default name is built from `entityPlural`, which is right for
 * `create_locations` but not for an entity whose singular tools were already
 * renamed — `inventory` would otherwise advertise `create_inventorys`.
 */
type BatchOperation = "batchCreate" | "batchUpdate";

type EntityCrudToolsetConfig<TCreateInput extends ZodSchemaLike> = {
  /** Singular slug — router key, shortcode prefix, and get/create/update tool names (get_x, create_x, update_x). */
  entity: ShortcodeEntity;
  /** Plural slug — list/delete tool names (list_xs, delete_xs). */
  entityPlural?: string;
  createInput: TCreateInput;
  updateShape: Record<string, z.ZodType>;
  /** Use when the update schema already includes its id field. */
  updateInput?: ZodSchemaLike;
  filterFields: Record<string, z.ZodType>;
  mcpListOut: z.ZodType;
  out: z.ZodType;
  detailOut?: z.ZodType;
  mutationOut?: z.ZodType;
  slim: Slim;
  /** Set false when the detail output must not use the list/mutation projection. */
  detailSlim?: Slim | false;
  sort: { orderBy: string; direction?: "asc" | "desc" };
  descriptions: {
    list: string;
    get: string;
    create: string;
    update: string;
    /**
     * Required unless the entity opts out of delete (`operations.delete: false`)
     * — an entity with no delete tool must not carry the dead prose for one.
     * Registration throws if it's missing while delete is enabled.
     */
    delete?: string;
  };
  names?: Partial<Record<CrudOperation | BatchOperation, string>>;
  operations?: Partial<Record<CrudOperation, boolean>>;
  paging?: { defaultPageSize?: number; maxPageSize?: number };
  create?: (
    caller: Caller,
    params: InferSchemaLike<TCreateInput>,
  ) => Promise<unknown>;
  /** Override the get fetch — see `GetByIdFetch`. */
  get?: GetByIdFetch;
  /** Resolve any FK shortcode fields inside update's `data` before the router sees it. */
  resolveUpdateData?: ResolveUpdateData;
  /** Override list's default filter passthrough — needed when a filter field is itself an FK shortcode. */
  buildFilters?: BuildListFilters;
  listSortInput?: z.ZodType;
  /**
   * The conventional best-effort create/update batch tools, **on by default**.
   *
   * This used to be opt-in, and only five of fifteen toolsets ever opted in —
   * so `delete_locations` existed while `create_location` stayed singular, and
   * rearranging a location tree cost one call per node. Plural `delete_*` hid
   * the gap because it comes from a different mechanism entirely
   * ({@link registerEntityDeleteTool}, one router call over an `ids[]`).
   *
   * Set a flag to `false` only where a plural form is genuinely wrong for the
   * entity, and say why at the call site.
   */
  batch?: { create?: boolean; update?: boolean };
};

/**
 * Register the standard 5-tool CRUD surface (list/get/create/update/delete)
 * for one entity in a single call. Bakes in the annotation conventions shared
 * by every entity toolset (READ_ONLY_CLOSED for reads, WRITE_CLOSED for
 * create/update, WRITE_DESTRUCTIVE_CLOSED for delete) and the name
 * derivation (`list_${plural}`, `get_${entity}`, `create_${entity}`,
 * `update_${entity}`, `delete_${plural}`).
 */
export function registerEntityCrudToolset<TCreateInput extends ZodSchemaLike>(
  server: McpServer,
  config: EntityCrudToolsetConfig<TCreateInput>,
) {
  const enabled = (operation: CrudOperation) =>
    config.operations?.[operation] !== false;
  // A batch tool is a plural wrapper over its singular, so it inherits that
  // operation's enablement: an entity with no `create_x` must not grow a
  // `create_xs` that calls a router method it deliberately doesn't expose.
  const batchEnabled = (operation: "create" | "update") =>
    enabled(operation) && config.batch?.[operation] !== false;
  const name = (operation: CrudOperation | BatchOperation, fallback: string) =>
    config.names?.[operation] ?? fallback;
  const detailOut = config.detailOut ?? config.out;
  const mutationOut = config.mutationOut ?? config.out;
  const entityPlural = config.entityPlural ?? `${config.entity}s`;
  const create =
    config.create ??
    ((caller: Caller, params: InferSchemaLike<TCreateInput>) =>
      getEntityRouter(caller, config.entity).create(
        params as Record<string, unknown>,
      ));
  const updateInput =
    config.updateInput ?? withIdInput(config.entity, config.updateShape);

  if (enabled("list"))
    registerEntityListTool(server, {
      name: name("list", `list_${entityPlural}`),
      description: config.descriptions.list,
      router: config.entity,
      filterFields: config.filterFields,
      outputSchema: config.mcpListOut,
      slim: config.slim,
      sort: config.sort,
      sortInput: config.listSortInput,
      defaultPageSize: config.paging?.defaultPageSize,
      maxPageSize: config.paging?.maxPageSize,
      buildFilters: config.buildFilters,
      annotations: READ_ONLY_CLOSED,
    });

  if (enabled("get"))
    registerEntityGetTool(server, {
      name: name("get", `get_${config.entity}`),
      description: config.descriptions.get,
      router: config.entity,
      entity: config.entity,
      outputSchema: detailOut,
      slim:
        config.detailSlim === false
          ? undefined
          : (config.detailSlim ?? config.slim),
      annotations: READ_ONLY_CLOSED,
      get: config.get,
    });

  if (enabled("create"))
    registerEntityCreateTool(server, {
      name: name("create", `create_${config.entity}`),
      description: config.descriptions.create,
      inputSchema: config.createInput,
      outputSchema: mutationOut,
      slim: config.slim,
      annotations: WRITE_CLOSED,
      create,
    });

  if (enabled("update"))
    registerEntityUpdateTool(server, {
      name: name("update", `update_${config.entity}`),
      description: config.descriptions.update,
      inputSchema: updateInput,
      outputSchema: mutationOut,
      slim: config.slim,
      router: config.entity,
      entity: config.entity,
      annotations: WRITE_CLOSED,
      resolveUpdateData: config.resolveUpdateData,
    });

  if (batchEnabled("create")) {
    registerBatchTool(server, {
      name: name("batchCreate", `create_${entityPlural}`),
      description:
        `Create up to ${DEFAULT_BATCH_MAX_ITEMS} ${entityPlural} in request order. Each item uses the same ` +
        `validation and side effects as ${name("create", `create_${config.entity}`)}; a failed item does not ` +
        "roll back successful items.",
      itemInput: schemaFromShape(config.createInput),
      itemOutput: mutationOut,
      annotations: WRITE_CLOSED,
      run: async (caller, item) =>
        respond(
          await create(caller, item as InferSchemaLike<TCreateInput>),
          config.slim,
        ),
    });
  }

  if (batchEnabled("update")) {
    registerBatchTool(server, {
      name: name("batchUpdate", `update_${entityPlural}`),
      description:
        `Update up to ${DEFAULT_BATCH_MAX_ITEMS} ${entityPlural} in request order. Each item uses the same ` +
        `validation and side effects as ${name("update", `update_${config.entity}`)}; a failed item does not ` +
        "roll back successful items.",
      itemInput: schemaFromShape(updateInput),
      itemOutput: mutationOut,
      annotations: WRITE_CLOSED,
      refineItems: rejectDuplicateIds,
      run: async (caller, item) => {
        const { id, ...rest } = item as Record<string, unknown>;
        let data = omitBy(rest, (value) => value === undefined);
        if (config.resolveUpdateData) {
          data = await config.resolveUpdateData(caller, data);
        }
        return respond(
          await getEntityRouter(caller, config.entity).update({ id, data }),
          config.slim,
        );
      },
    });
  }

  if (enabled("delete")) {
    const description = config.descriptions.delete;
    if (!description) {
      throw new Error(
        `registerEntityCrudToolset(${config.entity}): descriptions.delete is required unless operations.delete is false`,
      );
    }
    registerEntityDeleteTool(server, {
      name: name("delete", `delete_${entityPlural}`),
      description,
      router: config.entity,
      entity: config.entity,
      annotations: WRITE_DESTRUCTIVE_CLOSED,
    });
  }
}

export function registerRouterTool<
  TInput extends ZodSchemaLike = Record<string, never>,
  TOutput extends z.ZodType = z.ZodType,
>(
  server: McpServer,
  config: {
    name: string;
    description: string;
    inputSchema?: TInput;
    outputSchema: TOutput;
    annotations: ToolAnnotations;
    uiResourceUri?: string;
    call: (
      caller: Caller,
      params: InferSchemaLike<TInput>,
    ) => Promise<z.output<TOutput>>;
  },
) {
  registerMcpTool(server, {
    name: config.name,
    description: config.description,
    // Undefined on purpose when the tool takes no arguments — `toolInputSchema`
    // turns that into an empty object schema, the one case where advertising no
    // properties is the truth rather than a dropped input.
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    annotations: config.annotations,
    uiResourceUri: config.uiResourceUri,
    handler: async (params, extra) => config.call(getCaller(extra), params),
  });
}
