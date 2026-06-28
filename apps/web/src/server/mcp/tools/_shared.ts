import { deletedCountOut } from "@cubby/schemas/common";
import {
  type IngredientMcpOut,
  type IngredientOut,
  ingredientMcpOut,
} from "@cubby/schemas/ingredient";
import {
  type InventoryMcpOut,
  inventoryMcpOut,
} from "@cubby/schemas/inventory";
import { type LocationOut, locationMcpOut } from "@cubby/schemas/location";
import { type McpUsdaFoodOut, mcpUsdaFoodOut } from "@cubby/schemas/mcp";
import { type MealOut, mealMcpOut } from "@cubby/schemas/meal";
import { mcpListInputShape } from "@cubby/schemas/pagination";
import {
  type ProductMcpOut,
  type ProductTopLevelOut,
  productMcpOut,
} from "@cubby/schemas/product";
import {
  type RecipeMcpOut,
  type RecipeTopLevel,
  recipeMcpOut,
} from "@cubby/schemas/recipe";
import type { mcpUnitMappingInput } from "@cubby/schemas/unitmapping";
import type { foodSummary } from "@cubby/usda-schemas";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TRPCError } from "@trpc/server";
import { omitBy } from "es-toolkit";
import { z } from "zod";

/**
 * Shared MCP tool-handler scaffolding.
 *
 * Houses the cross-family primitives the per-entity `*.tools.ts` files build on:
 * the tRPC caller accessor, registerMcpTool, error wrapper, structured response
 * helpers, the slim output projections, and the CRUD handler factories.
 */

// biome-ignore lint/suspicious/noExplicitAny: server-side tRPC caller type
type Caller = any;

type ToolExtra = { authInfo?: { extra?: Record<string, unknown> } };

type ZodSchemaLike = z.ZodType | Record<string, z.ZodType>;

export type McpToolHandler = (
  params: Record<string, unknown>,
  extra: ToolExtra,
) => Promise<unknown | CallToolResult>;

export type RegisterMcpToolConfig = {
  name: string;
  description: string;
  title?: string;
  inputSchema?: ZodSchemaLike;
  outputSchema: z.ZodType;
  annotations: ToolAnnotations;
  handler: McpToolHandler;
};

type SdkRegisteredTool = {
  title?: string;
  description?: string;
  inputSchema?: z.ZodType;
  outputSchema?: z.ZodType;
  annotations?: ToolAnnotations;
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

/** Recursively delete `mock` keys from JSON Schema objects exposed to MCP clients. */
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

export function structuredSuccess(
  data: unknown,
  outputSchema: z.ZodType,
): CallToolResult {
  const parsed = outputSchema.parse(data);
  return {
    structuredContent: parsed as Record<string, unknown>,
    content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
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

function safeToJsonSchema(
  obj: ReturnType<typeof normalizeObjectSchema>,
  pipeStrategy: "input" | "output",
) {
  if (!obj) return EMPTY_OBJECT_JSON_SCHEMA;
  try {
    return stripMockFromJsonSchema(
      toJsonSchemaCompat(obj, {
        strictUnions: true,
        pipeStrategy,
      }) as Record<string, unknown>,
    );
  } catch {
    return { type: "object", additionalProperties: true };
  }
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
          inputSchema: safeToJsonSchema(
            tool.inputSchema
              ? normalizeObjectSchema(tool.inputSchema)
              : undefined,
            "input",
          ),
          annotations: tool.annotations,
        };
        if (tool.outputSchema) {
          definition.outputSchema = safeToJsonSchema(
            normalizeObjectSchema(tool.outputSchema),
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

export function registerMcpTool(
  server: McpServer,
  config: RegisterMcpToolConfig,
) {
  server.registerTool(
    config.name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      annotations: config.annotations,
    },
    async (params: Record<string, unknown>, extra: ToolExtra) => {
      try {
        const result = await config.handler(
          (params ?? {}) as Record<string, unknown>,
          extra as ToolExtra,
        );
        if (isCallToolResult(result)) {
          return result;
        }
        return structuredSuccess(result, config.outputSchema);
      } catch (error) {
        return structuredError(formatToolError(error));
      }
    },
  );
}

export function getCaller(extra: ToolExtra): Caller {
  return extra.authInfo?.extra?.caller;
}

/** Render an error thrown by a tool handler into a single message string. */
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

/** @deprecated Use structuredSuccess via registerMcpTool */
export function json(data: unknown) {
  return {
    structuredContent: data,
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** @deprecated Use structuredError via registerMcpTool */
export function jsonError(text: string) {
  return structuredError(text);
}

/** Wrap a legacy handler — prefer registerMcpTool instead. */
export function withErrorHandling(fn: McpToolHandler) {
  return async (params: Record<string, unknown>, extra: ToolExtra) => {
    try {
      return await fn(params, extra);
    } catch (error) {
      return structuredError(formatToolError(error));
    }
  };
}

export function toUnitMappingInput(m: z.infer<typeof mcpUnitMappingInput>) {
  return { a: m.a, b: m.b, source: m.source ?? null };
}

export function matchesFilter(value: string | null, filter: unknown): boolean {
  if (typeof filter !== "string") return true;
  return value?.toLowerCase().includes(filter.toLowerCase()) ?? false;
}

export function matchesArrayFilter(values: string[], filter: unknown): boolean {
  if (typeof filter !== "string") return true;
  const lower = filter.toLowerCase();
  return values.some((v) => v.toLowerCase().includes(lower));
}

export function notionUnavailable() {
  return structuredError(
    "Notion integration is not configured. Set the NOTION_API_KEY environment variable.",
  );
}

// ---------------------------------------------------------------------------
// Slim output projections
// ---------------------------------------------------------------------------

export type Row = Record<string, unknown>;
type Slim = (row: Row) => unknown;
const slimSchemas = new WeakMap<Slim, z.ZodType>();
const identity: Slim = (row) => row;

function defineSlim<T>(schema: z.ZodType<T>, slim: (row: Row) => T) {
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
    shortcode: loc.shortcode,
    type: loc.type,
    parentName: loc.parent?.name ?? null,
    parentId: loc.parent?.id ?? null,
    children: (loc.children ?? []).map((c) => ({ id: c.id, name: c.name })),
  };
});

type InventoryRow = Pick<InventoryMcpOut, "id" | "amount" | "valuation"> & {
  product?: {
    id: string;
    name: string;
    manufacturer: string;
    shortcode: string | null;
  } | null;
  location?: { id: string; name: string } | null;
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
          shortcode: entry.product.shortcode,
        }
      : null,
    location: entry.location
      ? { id: entry.location.id, name: entry.location.name }
      : null,
  };
});

type ProductRow = ProductTopLevelOut & {
  food?: { fdc_id?: number | null } | null;
  ingredient?: { id?: ProductMcpOut["ingredientId"] } | null;
  ingredientId?: ProductMcpOut["ingredientId"];
  unitMappings?: Array<{
    a: ProductMcpOut["unitMappings"][number]["a"];
    b: ProductMcpOut["unitMappings"][number]["b"];
    source: string | null;
  }>;
};
export const slimProduct = defineSlim(productMcpOut, (pRow: Row) => {
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
});

type RecipeRow = RecipeTopLevel & {
  shortcode?: RecipeMcpOut["shortcode"];
};
export const slimRecipe = defineSlim(recipeMcpOut, (rRow: Row) => {
  const r = rRow as RecipeRow;
  return {
    id: r.id,
    name: r.name,
    shortcode: r.shortcode ?? null,
    yield: r.yield,
    servings: r.servings,
    tags: r.tags,
  };
});

type IngredientRow = IngredientOut & {
  product?: IngredientMcpOut["products"];
  appearsInRecipes?: unknown[];
  food?: { fdc_id?: number | null } | null;
};
export const slimIngredient = defineSlim(ingredientMcpOut, (iRow: Row) => {
  const i = iRow as IngredientRow;
  return {
    id: i.id,
    name: i.name,
    aliases: i.aliases,
    products: (i.product ?? []).map((p: { id: string; name: string }) => ({
      id: p.id,
      name: p.name,
    })),
    recipeCount: (i.appearsInRecipes ?? []).length,
    usdaFdcId: i.food?.fdc_id ?? null,
  };
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
      id: mr.id,
      recipeId: mr.recipeId,
      name: mr.recipe?.name ?? null,
      scale: mr.scale,
      scaledTotals: mr.scaledTotals,
    })),
  };
});

type UsdaFoodRow = z.infer<typeof foodSummary> & {
  linkedProducts?: McpUsdaFoodOut["linkedProducts"];
};
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
    nutrientSummary: f.nutritionInfo?.nutrientSummary ?? [],
    portionInfoRaw: f.portionInfoRaw ?? [],
    linkedProducts: (f.linkedProducts ?? []).map((p) => ({
      id: p.id,
      name: p.name,
    })),
  };
});

function parseResponse(schema: z.ZodType | undefined, value: unknown) {
  return schema ? schema.parse(value) : value;
}

export function respond<T>(
  schema: z.ZodType<T>,
  result: unknown,
  slim?: (row: Row) => T,
): T;
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

export const idParam = (label: string) => z.string().describe(`${label} ID`);
export const idsParam = (label: string) =>
  z.array(z.string()).describe(`Array of ${label} IDs to delete`);

export function getByIdHandler(routerName: string, slim: Slim = identity) {
  return async (params: Record<string, unknown>, extra: ToolExtra) => {
    const result = await getCaller(extra)[routerName].getByID({
      id: params.id,
    });
    return respond(result, slim);
  };
}

export function deleteHandler(routerName: string) {
  return async (params: Record<string, unknown>, extra: ToolExtra) => {
    const ids = params.ids as string[];
    await getCaller(extra)[routerName].delete({ ids });
    return { deleted: ids.length };
  };
}

export function updateHandler(routerName: string, slim: Slim = identity) {
  return async (params: Record<string, unknown>, extra: ToolExtra) => {
    const { id, ...rest } = params;
    const data = omitBy(rest, (v) => v === undefined);
    const result = await getCaller(extra)[routerName].update({ id, data });
    return respond(result, slim);
  };
}

export function listHandler(
  routerName: string,
  slim: Slim,
  config: {
    orderBy: string;
    direction?: "asc" | "desc";
    buildFilters?: (params: Row) => Record<string, unknown>;
    filtersSchema?: z.ZodObject<z.ZodRawShape>;
    defaultPageSize?: number;
  },
) {
  const resolveFilters =
    config.buildFilters ??
    (config.filtersSchema
      ? (params: Row) => pickSchemaFilters(params, config.filtersSchema!)
      : () => ({}));

  return async (params: Record<string, unknown>, extra: ToolExtra) => {
    const result = await getCaller(extra)[routerName].list({
      filters: resolveFilters(params),
      sort: { orderBy: config.orderBy, direction: config.direction ?? "asc" },
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

/** Pick filter fields present in params using a filters schema's shape keys. */
export function pickSchemaFilters(
  params: Row,
  filtersSchema: z.ZodObject<z.ZodRawShape>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(filtersSchema.shape)) {
    if (params[key] !== undefined) {
      out[key] = params[key];
    }
  }
  return out;
}

export function withIdInput(
  idLabel: string,
  dataShape: Record<string, z.ZodType>,
) {
  return { id: idParam(idLabel), ...dataShape };
}

type EntityListToolConfig = {
  name: string;
  description: string;
  router: string;
  filtersSchema: z.ZodObject<z.ZodRawShape>;
  outputSchema: z.ZodType;
  slim: Slim;
  sort: { orderBy: string; direction?: "asc" | "desc" };
  annotations: ToolAnnotations;
  defaultPageSize?: number;
  maxPageSize?: number;
  buildFilters?: (params: Row) => Record<string, unknown>;
};

export function registerEntityListTool(
  server: McpServer,
  config: EntityListToolConfig,
) {
  const defaultPageSize = config.defaultPageSize ?? 50;
  registerMcpTool(server, {
    name: config.name,
    description: config.description,
    inputSchema: mcpListInputShape(config.filtersSchema, {
      defaultPageSize,
      maxPageSize: config.maxPageSize,
    }),
    outputSchema: config.outputSchema,
    annotations: config.annotations,
    handler: listHandler(config.router, config.slim, {
      orderBy: config.sort.orderBy,
      direction: config.sort.direction,
      filtersSchema: config.buildFilters ? undefined : config.filtersSchema,
      buildFilters: config.buildFilters,
      defaultPageSize,
    }),
  });
}

export function registerEntityGetTool(
  server: McpServer,
  config: {
    name: string;
    description: string;
    router: string;
    idLabel: string;
    outputSchema: z.ZodType;
    slim?: Slim;
    annotations: ToolAnnotations;
  },
) {
  registerMcpTool(server, {
    name: config.name,
    description: config.description,
    inputSchema: { id: idParam(config.idLabel) },
    outputSchema: config.outputSchema,
    annotations: config.annotations,
    handler: getByIdHandler(config.router, config.slim ?? identity),
  });
}

export function registerEntityDeleteTool(
  server: McpServer,
  config: {
    name: string;
    description: string;
    router: string;
    entityLabel: string;
    annotations: ToolAnnotations;
  },
) {
  registerMcpTool(server, {
    name: config.name,
    description: config.description,
    inputSchema: { ids: idsParam(config.entityLabel) },
    outputSchema: deletedCountOut,
    annotations: config.annotations,
    handler: deleteHandler(config.router),
  });
}

export function registerEntityUpdateTool(
  server: McpServer,
  config: {
    name: string;
    description: string;
    router: string;
    inputSchema: ZodSchemaLike;
    outputSchema: z.ZodType;
    slim: Slim;
    annotations: ToolAnnotations;
  },
) {
  registerMcpTool(server, {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    annotations: config.annotations,
    handler: updateHandler(config.router, config.slim),
  });
}

export function registerEntityCreateTool(
  server: McpServer,
  config: {
    name: string;
    description: string;
    inputSchema: ZodSchemaLike;
    outputSchema: z.ZodType;
    slim: Slim;
    annotations: ToolAnnotations;
    create: (
      caller: Caller,
      params: Record<string, unknown>,
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

/** Register a tool that calls a tRPC procedure and returns the result as-is. */
export function registerRouterTool(
  server: McpServer,
  config: {
    name: string;
    description: string;
    inputSchema?: ZodSchemaLike;
    outputSchema: z.ZodType;
    annotations: ToolAnnotations;
    call: (caller: Caller, params: Record<string, unknown>) => Promise<unknown>;
  },
) {
  registerMcpTool(server, {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema ?? {},
    outputSchema: config.outputSchema,
    annotations: config.annotations,
    handler: async (params, extra) => config.call(getCaller(extra), params),
  });
}
