import { mcpAppResourceUriForTool } from "@cubby/mcp-apps/metadata";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { shortcodeSchema } from "@cubby/schemas/identifiers";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import { inventoryMcpOut } from "@cubby/schemas/inventory";
import { mcpUsdaFoodListItemOut, mcpUsdaFoodOut } from "@cubby/schemas/mcp";
import { mealMcpOut } from "@cubby/schemas/meal";
import {
  type ProductMcpDetailOut,
  type ProductMcpOut,
  type ProductTopLevelOut,
  productMcpDetailOut,
  productMcpOut,
} from "@cubby/schemas/product";
import { recipeMcpOut } from "@cubby/schemas/recipe";
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
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/rpc";
import { z } from "zod";
import type { McpWorkflowCaller } from "~/server/api/mcp-workflows";
import type { EntityKernelContext } from "~/server/entity-kernel";
import { toPublicErrorPayload } from "~/server/errors/app-error";
import { resolveProductPricing } from "~/server/repo/product/pricing";

/**
 * Shared MCP tool-handler scaffolding.
 *
 * Houses the cross-family primitives the per-entity `*.tools.ts` files build on:
 * the tRPC caller accessor, registerMcpTool, error wrapper, structured response
 * helpers, the slim output projections, and the CRUD handler factories.
 */

export type Caller = McpWorkflowCaller;

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
   * Which concrete entity a GENERIC tool acted on, read off the call's own
   * arguments.
   *
   * Entity commands name their target explicitly, preserving tool-call
   * telemetry after the standard CRUD surface was collapsed.
   *
   * Returns `undefined` when the arguments don't name one (a malformed call
   * that never reached the handler).
   */
  telemetryEntity?: (params: InferSchemaLike<TInput>) => string | undefined;
};

export type ToolEntityExtractor = (
  params: Record<string, unknown>,
) => string | undefined;

/**
 * Per-tool entity extractors, keyed by SERVER — the same reason
 * `deletableEntities` below is: `createMcpServer()` runs more than once per
 * process (every test that builds a catalog), and a module-level Map would
 * accumulate one server's registrations into another's. A WeakMap also lets the
 * entry die with the server.
 */
const toolEntityExtractors = new WeakMap<
  McpServer,
  Map<string, ToolEntityExtractor>
>();

function declareToolEntityExtractor(
  server: McpServer,
  name: string,
  extract: ToolEntityExtractor,
) {
  const existing = toolEntityExtractors.get(server);
  if (existing) {
    existing.set(name, extract);
    return;
  }
  toolEntityExtractors.set(server, new Map([[name, extract]]));
}

/**
 * How to name the entity one call to `name` acted on, or `undefined` for a tool
 * that declared none.
 */
export function getToolEntityExtractor(
  server: McpServer,
  name: string,
): ToolEntityExtractor | undefined {
  return toolEntityExtractors.get(server)?.get(name);
}

/**
 * `_meta` for a tool that declares an MCP App.
 *
 * Both keys are emitted on purpose: `ui.resourceUri` is the current spec, and
 * the flat `ui/resourceUri` is the deprecated alias older hosts still read.
 */
function uiToolMeta(toolName: string): Record<string, unknown> | undefined {
  const resourceUri = mcpAppResourceUriForTool(toolName);
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

/**
 * A genuine FAULT: the call could not run at all.
 *
 * `_meta` carries the same `{code, reason}` a tRPC client reads off
 * `error.data`, so an agent can branch on WHY without substring-matching the
 * sentence. It rides in `_meta` and NOT in `structuredContent` on purpose: the
 * reference SDK client validates `structuredContent` against the tool's
 * declared output schema with no exemption for `isError` (client/index.js — the
 * missing-content guard checks `isError`, the validation right below it does
 * not), so a refusal payload smuggled in there makes every errored call throw
 * `McpError` client-side. Nothing validates `_meta`.
 *
 * A REFUSAL does not come through here at all — it is a domain answer inside
 * the tool's own output schema (see `operationRefusalOut`).
 */
export function structuredError(
  text: string,
  meta?: Record<string, unknown>,
): CallToolResult {
  return {
    content: [{ type: "text" as const, text }],
    isError: true as const,
    ...(meta ? { _meta: meta } : {}),
  };
}

/**
 * `_meta` key for the machine-readable half of a failed call. Namespaced
 * because `_meta` is a shared bag and the spec reserves the unprefixed space.
 */
const ERROR_META_KEY = "cubby/error";

/** The `_meta` bag for a fault, or `undefined` when there is nothing to add. */
function toolErrorMeta(error: unknown): Record<string, unknown> | undefined {
  const payload = toPublicErrorPayload(error);
  if (!payload.code && !payload.reason && !payload.blockers) return undefined;
  return { [ERROR_META_KEY]: payload };
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
 * The catch is a last-resort net only — the catalog-schema contract's "advertises real
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

/**
 * Adapt a wrapper's `Record<string, unknown>` extractor to the generic
 * `InferSchemaLike<TInput>` one {@link registerMcpTool} declares.
 *
 * Forwarding it directly makes `InferSchemaLike<TInput>` an INPUT position TS
 * has to satisfy, which pins the generic and turns `params.items` into
 * `unknown` inside every batch tool's own handler. The wrapper already knows
 * its params are an object; the cast says so without constraining inference.
 */
function adaptEntityExtractor<TIn, TOut>(
  extract: ((params: TIn) => string | undefined) | undefined,
): ((params: TOut) => string | undefined) | undefined {
  return extract && ((params) => extract(params as unknown as TIn));
}

export function registerMcpTool<
  TInput extends ZodSchemaLike,
  TOutput extends z.ZodType,
>(server: McpServer, config: RegisterMcpToolConfig<TInput, TOutput>) {
  const inputSchema = toolInputSchema(config.name, config.inputSchema);
  const telemetryEntity = config.telemetryEntity;
  if (telemetryEntity) {
    declareToolEntityExtractor(server, config.name, (params) =>
      telemetryEntity(params as InferSchemaLike<TInput>),
    );
  }
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
      return structuredError(formatToolError(error), toolErrorMeta(error));
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
      _meta: uiToolMeta(config.name),
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

/** Cached caller reserved for explicitly bounded-stale MCP read tools. */
export function getReadCaller(extra: ToolExtra): Caller {
  const caller = extra.authInfo?.extra?.readCaller;
  return caller ? (caller as Caller) : getCaller(extra);
}

/**
 * A tool failure, decomposed.
 *
 * `formatToolError` renders this to prose for the single-tool error path, where
 * the MCP envelope carries one text block and nothing else. Batch results keep
 * the parts: `error` alone forced a caller wanting to branch on *why* item 3
 * failed to substring-match a sentence, since `code` and `reason` were both
 * present at the throw site and then flattened into it.
 */
export interface ToolErrorDetail {
  /** The tRPC code, when the failure came through one. */
  code?: TRPC_ERROR_CODE_KEY;
  /** The `AppErrorReason` `createAppError` stamped onto `cause`. */
  reason?: string;
  message: string;
}

/**
 * `code`/`reason`/`blockers` come from `toPublicErrorPayload` — the same
 * whitelist tRPC's `errorFormatter` uses — so the two transports cannot drift
 * about what a client is allowed to learn. Only `message` is added here, since
 * it is the one part that belongs to the MCP envelope's text block.
 */
function describeToolError(error: unknown): ToolErrorDetail {
  const { code, reason } = toPublicErrorPayload(error);
  const message = error instanceof Error ? error.message : String(error);
  return {
    ...(code ? { code: code as TRPC_ERROR_CODE_KEY } : {}),
    ...(reason ? { reason } : {}),
    message,
  };
}

function formatToolError(error: unknown): string {
  const { code, reason, message } = describeToolError(error);
  if (!code) return message;
  return reason ? `${code}: ${message} (${reason})` : `${code}: ${message}`;
}

// Slim output projections

export type Row = Record<string, unknown>;
type Slim<T = unknown> = (row: Row) => T;
const slimSchemas = new WeakMap<Slim, z.ZodType>();
const identity: Slim = (row) => row;

function defineSlim<T>(schema: z.ZodType<T>, slim: (row: Row) => T) {
  slimSchemas.set(slim as Slim, schema);
  return slim;
}

/**
 * A row that ALREADY matches its MCP schema: the projection is the parse
 * `respond`/`respondList` runs against the registered schema, which drops
 * every key the schema does not declare. Nothing to remap by hand.
 */
function slimAs<T>(schema: z.ZodType<T>) {
  return defineSlim(schema, (row: Row) => row as unknown as T);
}

// Both inventory row flavors (`inventoryListItemOut` and
// `inventoryWithLocationAndProductOut`) are supersets of the picked shape.
export const slimInventory = slimAs(inventoryMcpOut);

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
    primaryGtin: p.primaryGtin,
    category: p.category,
    tags: p.tags ?? [],
    // `price` is the raw manual override and `effectivePrice` the resolved
    // costing price — the same split (and the same key names) as
    // `productTopLevelOut.price` / `productPricingOut.effectivePrice`.
    price: p.price,
    effectivePrice: pricing.effectivePrice,
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

export const slimRecipe = slimAs(recipeMcpOut);

export const slimMeal = slimAs(mealMcpOut);

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
          /**
           * The whole entity. Present only under `resultDetail: "full"` —
           * the default is compact, so a 50-item write does not spend the
           * caller's context on 50 hydrated entities.
           */
          item: item.optional(),
          /**
           * Compact identity: the shortcode the item created or updated, or
           * for an attachment the id of the stored file.
           */
          id: z.string().optional(),
          /** The attachment target, when the item attached to something. */
          entityId: z.string().optional(),
        }),
        z.object({
          index: z.number().int().nonnegative(),
          status: z.literal("failed"),
          /**
           * The rendered sentence, unchanged — still the thing a human reads.
           * `code` and `reason` are the same failure decomposed, so a caller can
           * branch on WHY item 3 failed without substring-matching this.
           */
          error: z.string(),
          /** Transport-neutral application error code, when available. */
          code: z.string().optional(),
          /** The `AppErrorReason` behind the refusal, when there was one. */
          reason: z.string().optional(),
        }),
      ]),
    ),
  });
}

/**
 * How much of each succeeded item a batch tool echoes back.
 *
 * Built per tool because the default is per tool: a write batch defaults to
 * `summary`, but a batch whose entire product IS the returned entity — reading
 * back per-image verification state, say — defaults to `full`.
 */
const batchResultDetailParam = (fallback: BatchResultDetail) =>
  z
    .enum(["summary", "full"])
    .default(fallback)
    .describe(
      `How much of each result to return. 'summary' gives {index, status, id}; 'full' gives the whole entity, which costs roughly 2-3k characters per item. This tool defaults to '${fallback}'.`,
    );

/**
 * Project a succeeded item down to its identity.
 *
 * Entities expose `id` (a shortcode); `attach_file` exposes `imageId` plus the
 * `entityId` it attached to. Both collapse to the same shape so the compact
 * result is uniform across every batch tool.
 */
function summarizeBatchItem(item: unknown): {
  id?: string;
  entityId?: string;
} {
  if (typeof item !== "object" || item === null) return {};
  const row = item as Record<string, unknown>;
  const id = row.id ?? row.imageId;
  return {
    ...(typeof id === "string" ? { id } : {}),
    ...(typeof row.entityId === "string" ? { entityId: row.entityId } : {}),
  };
}

/** The default cap on a batch tool's `items[]`. */
const DEFAULT_BATCH_MAX_ITEMS = 50;

type BatchResultDetail = "summary" | "full";

type BatchResult =
  | {
      index: number;
      status: "succeeded";
      item?: unknown;
      id?: string;
      entityId?: string;
    }
  | {
      index: number;
      status: "failed";
      error: string;
      code?: TRPC_ERROR_CODE_KEY;
      reason?: string;
    };

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
 *
 * Results are COMPACT by default: `{index, status, id}`. The singular tools
 * return a fully hydrated entity — `dataQuality` alone lists every gap twice,
 * once nested in `facets[]` and once flat, each with a prose sentence — and at
 * 50 items that envelope is tens of thousands of characters the caller has to
 * hold to learn 50 shortcodes. A 21-item `create_purchases` measured 58,603.
 * Pass `resultDetail: "full"` when the response is genuinely being read.
 */
export function registerBatchTool<TItem extends z.ZodType>(
  server: McpServer,
  config: {
    name: string;
    description: string;
    itemInput: TItem;
    itemOutput: z.ZodType;
    maxItems?: number;
    /**
     * What `resultDetail` falls back to. `"summary"` everywhere except the few
     * batches whose returned entity IS the point of calling them.
     */
    defaultResultDetail?: BatchResultDetail;
    annotations: ToolAnnotations;
    /** Which entity this batch acts on — see `RegisterMcpToolConfig.telemetryEntity`. */
    telemetryEntity?: (params: {
      items: Array<z.output<TItem>>;
    }) => string | undefined;
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
  const defaultDetail = config.defaultResultDetail ?? "summary";
  const resultDetail = batchResultDetailParam(defaultDetail);
  // strictObject: an undeclared key is rejected, so `resultDetail` has to be
  // part of the shape rather than read opportunistically off params.
  const inputSchema = refineItems
    ? z
        .strictObject({ items, resultDetail })
        .superRefine((input, ctx) => refineItems(input.items, ctx))
    : z.strictObject({ items, resultDetail });

  registerMcpTool(server, {
    name: config.name,
    description: config.description,
    inputSchema,
    outputSchema: batchMutationOut(config.itemOutput),
    annotations: config.annotations,
    telemetryEntity: adaptEntityExtractor(config.telemetryEntity),
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const detail =
        (params.resultDetail as BatchResultDetail) ?? defaultDetail;
      const results: BatchResult[] = [];
      for (const [index, item] of (
        params.items as Array<z.output<TItem>>
      ).entries()) {
        try {
          const produced = await config.run(caller, item);
          results.push({
            index,
            status: "succeeded",
            ...(detail === "full"
              ? { item: produced }
              : summarizeBatchItem(produced)),
          });
        } catch (error) {
          // `error` keeps the rendered sentence a human reads; `code`/`reason`
          // carry the same failure in a form a caller can branch on. The
          // message is not repeated as a third field — it is already inside
          // `error`, and a near-duplicate string per failed item is the
          // envelope bloat the compact result exists to avoid.
          const { code, reason } = describeToolError(error);
          results.push({
            index,
            status: "failed",
            error: formatToolError(error),
            ...(code ? { code } : {}),
            ...(reason ? { reason } : {}),
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

export function strictFilterInput<TShape extends Record<string, z.ZodType>>(
  toolName: string,
  shape: TShape,
  filterFields: Record<string, z.ZodType>,
) {
  const valid = Object.keys(filterFields).sort().join(", ");
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? `Unknown filter ${issue.keys.map((key) => `"${key}"`).join(", ")} for ${toolName}. Valid filters: ${valid}.`
        : undefined,
  });
}

/**
 * A list tool's filter builder. Most entities have no FK filter fields and
 * stay synchronous (`pickSchemaFilters`); one with a filter like
 * `locationIdFilter`/`projectId` needs `caller` to resolve the shortcode to a
 * uuid before it reaches the router, hence the `Caller` param and the
 * `Promise` return — awaited unconditionally below, which is a no-op for a
 * plain synchronous builder.
 */
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
    /** Which entity this tool acts on — see `RegisterMcpToolConfig.telemetryEntity`. */
    telemetryEntity?: (params: InferSchemaLike<TInput>) => string | undefined;
    call: (
      caller: Caller,
      params: InferSchemaLike<TInput>,
      context: EntityKernelContext | undefined,
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
    telemetryEntity: adaptEntityExtractor(config.telemetryEntity),
    handler: async (params, extra) =>
      config.call(
        getCaller(extra),
        params,
        extra.authInfo?.extra?.entityKernel as EntityKernelContext | undefined,
      ),
  });
}
