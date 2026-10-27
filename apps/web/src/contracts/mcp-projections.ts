import { entityKeys, entitySummary } from "@cubby/schemas/entity-summary";
import { fieldEnvelopeFor, fieldValueOf } from "@cubby/schemas/field-envelope";
import { mcpUsdaFoodListItemOut, mcpUsdaFoodOut } from "@cubby/schemas/mcp";
import { productRefOut } from "@cubby/schemas/product-fields";
import { foodSummary, foodSummaryCompact } from "@cubby/usda";
import { z } from "zod";

/**
 * MCP token-budget projections, applied as an action's `project` in
 * `mcp-tools.ts`. Pure — contract modules may import only schema code — so the
 * generator loads them with the tool declarations.
 */

function parseAs<TSchema extends z.ZodType, TInput>(
  schema: TSchema,
  input: TInput,
): z.output<TSchema> {
  return schema.parse(input);
}

const linkedProductsInput = z.array(productRefOut).optional();
const usdaProjectionInput = foodSummary.extend({
  linkedProducts: linkedProductsInput,
});
// Search rows omit the nutrient table (`UsdaFoodListRow`).
const usdaListProjectionInput = foodSummaryCompact.extend({
  linkedProducts: linkedProductsInput,
});

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

function orderNutrientSummary<T extends { name: string; unit: string }>(
  summary: T[],
): T[] {
  return summary
    .map((entry, index) => ({ entry, index, rank: nutrientRank(entry) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.entry);
}

type UsdaProjectionInput = z.output<typeof usdaProjectionInput>;
type UsdaListProjectionInput = z.output<typeof usdaListProjectionInput>;

const usdaIdentityProjection = (food: UsdaListProjectionInput) => ({
  description: food.foodInfo?.description ?? null,
  data_type: food.foodInfo?.data_type ?? null,
  brand_owner: food.brandedFoodInfo?.brand_owner ?? null,
  brand_name: food.brandedFoodInfo?.brand_name ?? null,
  gtin_upc: food.brandedFoodInfo?.gtin_upc ?? null,
  ndb_number: food.legacyFoodInfo?.ndb_number ?? null,
  ingredients: food.brandedFoodInfo?.ingredients ?? null,
  serving: food.brandedFoodInfo?.serving ?? null,
});

const usdaNutritionProjection = (food: UsdaProjectionInput) => ({
  nutrientsPer100: food.nutritionInfo?.nutrientsPer100 ?? null,
  nutrientSummary: orderNutrientSummary(
    food.nutritionInfo?.nutrientSummary ?? [],
  ),
  portionInfoRaw: food.portionInfoRaw ?? [],
});

const linkedProductsProjection = (food: UsdaListProjectionInput) =>
  (food.linkedProducts ?? []).map((product) => ({
    id: product.id,
    name: product.name,
  }));

export function slimUsdaFood<TInput>(row: TInput) {
  const food = parseAs(usdaProjectionInput, row);
  return mcpUsdaFoodOut.parse({
    fdc_id: food.fdc_id,
    ...usdaIdentityProjection(food),
    ...usdaNutritionProjection(food),
    linkedProducts: linkedProductsProjection(food),
  });
}

export function slimUsdaFoodListItem<TInput>(row: TInput) {
  const food = parseAs(usdaListProjectionInput, row);
  return mcpUsdaFoodListItemOut.parse({
    fdc_id: food.fdc_id,
    ...usdaIdentityProjection(food),
    nutrientsPer100: food.nutritionInfo?.nutrientsPer100 ?? null,
    portionInfoRaw: food.portionInfoRaw ?? [],
    linkedProducts: linkedProductsProjection(food),
  });
}

const externalIdSummarySchema = z.object({
  source: z.string(),
  kind: z.string(),
  externalId: z.string(),
  isPrimary: z.boolean().optional(),
});
const recipeCoverageSchema = z.object({
  cost: z.unknown(),
  kcal: z.unknown(),
});
// Shape for any scored entity (product, purchase, and future entries in
// `scoredEntities`) whose item carries a `dataQuality` block — not a
// product-specific shape.
const dataQualityCoverageSchema = z.object({
  status: z.string().nullable(),
  missingChecks: z.array(z.string()),
  defectChecks: z.array(z.string()),
});
const coverageSchema = z.union([
  recipeCoverageSchema,
  dataQualityCoverageSchema,
]);

const entitySummaryItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    externalIds: z.array(externalIdSummarySchema).optional(),
    coverage: coverageSchema.optional(),
  })
  .strict();

export const entitySummaryResultSchema = z
  .object({
    action: z.enum(["get", "list", "merge"]),
    entity: z.enum(entityKeys),
    item: entitySummaryItemSchema.nullable().optional(),
    items: z.array(entitySummaryItemSchema).optional(),
  })
  .passthrough();

const projectionItemSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    displayName: z.string().nullish(),
    fromPartyName: z.string().nullish(),
    description: z.string().nullish(),
    filename: z.string().nullish(),
    externalIds: z.array(externalIdSummarySchema).optional(),
    totals: z
      .object({
        cost: z.unknown(),
        nutrition: z.object({ kcal: z.unknown() }).passthrough(),
      })
      .nullish(),
    dataQuality: z
      .object({
        status: z.string().optional(),
        gaps: z
          .array(z.object({ check: z.string(), kind: z.string() }))
          .optional(),
      })
      .nullish(),
  })
  .passthrough();
type ProjectionItem = z.infer<typeof projectionItemSchema>;

const projectionQualitySchema = projectionItemSchema.shape.dataQuality
  .unwrap()
  .unwrap();

// Structural, not name-based: any entity whose item carries `dataQuality`
// (product, purchase, or a future scored entity from `scoredEntities`) gets
// the same coverage projection, so this never needs a per-entity branch as
// more entities gain a data-quality block.
function coverageFor(entity: keyof typeof entitySummary, item: ProjectionItem) {
  if (entity === "recipe") {
    return {
      cost: item.totals?.cost ?? null,
      kcal: item.totals?.nutrition.kcal ?? null,
    };
  }
  const envelope = fieldEnvelopeFor(item, "dataQuality");
  const parsed = projectionQualitySchema.safeParse(
    envelope ? fieldValueOf(envelope) : item.dataQuality,
  );
  if (!parsed.success) return undefined;
  const quality = parsed.data;
  return {
    status: quality.status ?? null,
    missingChecks: [
      ...new Set(
        (quality.gaps ?? [])
          .filter((gap) => gap.kind === "missing")
          .map((gap) => String(gap.check)),
      ),
    ],
    defectChecks: [
      ...new Set(
        (quality.gaps ?? [])
          .filter((gap) => gap.kind === "defect")
          .map((gap) => String(gap.check)),
      ),
    ],
  };
}

/** The list fields a read summary publishes beside `id`: the title, and a product's external ids. */
export const entitySummaryFields = (
  entity: keyof typeof entitySummary,
): string[] => [
  entitySummary[entity].titleField,
  ...(entity === "product" ? ["externalIds"] : []),
];

function summarizeEntityItem(
  entity: keyof typeof entitySummary,
  item: unknown,
  write: boolean,
): z.output<typeof entitySummaryItemSchema> | null {
  const record = projectionItemSchema.nullable().parse(item);
  if (record === null) return null;
  const name = z
    .string()
    .catch(record.id)
    .parse(record[entitySummary[entity].titleField]);
  const summary: z.output<typeof entitySummaryItemSchema> = {
    id: record.id,
    name,
  };
  if (entity === "product" && record.externalIds)
    summary.externalIds = record.externalIds;
  if (write) {
    const coverage = coverageFor(entity, record);
    if (coverage) summary.coverage = coverage;
  }
  return summary;
}

interface ProjectableEntityResult {
  action: string;
  entity: keyof typeof entitySummary;
}

export function projectEntityResult<TResult extends ProjectableEntityResult>(
  command: { action?: string; resultDetail?: "summary" | "full" },
  result: TResult,
) {
  if (
    command.resultDetail === "full" ||
    result.action === "create" ||
    result.action === "update"
  )
    return result;
  const payload = z
    .object({
      action: z.string(),
      entity: z.enum(entityKeys),
      item: z.unknown().optional(),
      items: z.array(z.unknown()).optional(),
    })
    .passthrough()
    .parse(result);
  if (!["get", "list", "create", "update", "merge"].includes(payload.action))
    return result;
  if (payload.action === "list") {
    return {
      ...payload,
      items: (payload.items ?? []).map((item) =>
        summarizeEntityItem(payload.entity, item, false),
      ),
    };
  }
  return {
    ...payload,
    item: summarizeEntityItem(
      payload.entity,
      payload.item,
      ["create", "update", "merge"].includes(payload.action),
    ),
  };
}

/**
 * `{ items }` — the root every MCP list output wraps its array in. A bare array
 * root has no JSON Schema `properties`, and the MCP SDK re-validates
 * `structuredContent` against the declared output schema, so a tool whose root
 * is an array fails every call. Takes the member's own schema instance.
 */
export function mcpItemsEnvelope<Items extends z.ZodTypeAny>(items: Items) {
  return z.object({ items });
}

/** `{ results }` — the same envelope for a per-input-name result list. */
export function mcpResultsEnvelope<Results extends z.ZodTypeAny>(
  results: Results,
) {
  return z.object({ results });
}
