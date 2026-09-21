import { entityKeys, entitySummary } from "@cubby/schemas/entity-summary";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import { inventoryMcpOut } from "@cubby/schemas/inventory";
import { mcpUsdaFoodListItemOut, mcpUsdaFoodOut } from "@cubby/schemas/mcp";
import { mealMcpOut } from "@cubby/schemas/meal";
import {
  type ProductMcpDetailOut,
  productMcpDetailOut,
  productMcpOut,
  productTopLevelOut,
} from "@cubby/schemas/product";
import { recipeMcpOut } from "@cubby/schemas/recipe";
import { foodSummary } from "@cubby/usda-schemas";
import { z } from "zod";

import { resolveProductPricing } from "~/server/repo/product/pricing";

function parseAs<TSchema extends z.ZodType, TInput>(
  schema: TSchema,
  input: TInput,
): z.output<TSchema> {
  return schema.parse(input);
}

export function slimInventory<TInput>(row: TInput) {
  return parseAs(inventoryMcpOut, row);
}

const productProjectionInput = productTopLevelOut.extend({
  food: z
    .object({ fdc_id: z.number().nullable().optional() })
    .nullable()
    .optional(),
  ingredient: z
    .object({ id: productMcpOut.shape.ingredientId.unwrap() })
    .nullable()
    .optional(),
  unitMappings: productMcpOut.shape.unitMappings.optional(),
});

function parseProductProjectionInput<TInput>(row: TInput) {
  return parseAs(productProjectionInput, row);
}

export function slimProduct<TInput>(row: TInput) {
  const product = parseProductProjectionInput(row);
  const itemImages = product.images ?? [];
  const labelImages = product.labelImages ?? [];
  const cover = itemImages.find(isDisplayableImageFile) ?? null;
  const pricing = product.pricing ?? resolveProductPricing(product.price);
  return productMcpOut.parse({
    id: product.id,
    name: product.name,
    manufacturer: product.manufacturer,
    model: product.model,
    notes: product.notes,
    primaryGtin: product.primaryGtin,
    category: product.category,
    tags: product.tags ?? [],
    price: product.price,
    effectivePrice: pricing.effectivePrice,
    pricing,
    expectedQuantity: product.expectedQuantity,
    imageCount: itemImages.length + labelImages.length,
    itemImageCount: itemImages.filter(isDisplayableImageFile).length,
    labelImageCount: labelImages.filter(isDisplayableImageFile).length,
    coverImageUrl: cover?.url ?? null,
    fdc_id: product.fdc_id ?? null,
    usdaUnavailable: product.usdaUnavailable ?? null,
    stockTracked: product.stockTracked ?? null,
    externalIds: product.externalIds,
    usdaFdcId: product.food?.fdc_id ?? null,
    ingredientId: product.ingredient?.id ?? null,
    unitMappings: (product.unitMappings ?? []).map((mapping) => ({
      a: mapping.a,
      b: mapping.b,
      source: mapping.source ?? null,
    })),
    labelNutrition: product.labelNutrition ?? null,
    dataQuality: product.dataQuality,
  });
}

export function slimProductDetail<TInput>(row: TInput): ProductMcpDetailOut {
  const product = parseProductProjectionInput(row);
  const base = slimProduct(row);
  let displayPosition = 0;
  const images = [
    ...(product.images ?? []),
    ...(product.labelImages ?? []),
  ].map((file) => {
    const displayable =
      file.purpose !== "label" && isDisplayableImageFile(file);
    if (displayable) displayPosition += 1;
    return {
      ...file,
      displayPosition: displayable ? displayPosition : null,
      isCover: displayable && displayPosition === 1,
    };
  });
  const cover = images.find((file) => file.isCover) ?? null;
  return productMcpDetailOut.parse({
    ...base,
    coverImageId: cover?.id ?? null,
    coverImageUrl: cover?.url ?? null,
    images,
  });
}

export function slimRecipe<TInput>(row: TInput) {
  return parseAs(recipeMcpOut, row);
}

export function slimMeal<TInput>(row: TInput) {
  return parseAs(mealMcpOut, row);
}

const usdaProjectionInput = foodSummary.extend({
  linkedProducts: z
    .array(productTopLevelOut.pick({ id: true, name: true }))
    .optional(),
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

const usdaIdentityProjection = (food: UsdaProjectionInput) => ({
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

export function slimUsdaFood<TInput>(row: TInput) {
  const food = parseAs(usdaProjectionInput, row);
  return mcpUsdaFoodOut.parse({
    fdc_id: food.fdc_id,
    ...usdaIdentityProjection(food),
    ...usdaNutritionProjection(food),
    linkedProducts: (food.linkedProducts ?? []).map((product) => ({
      id: product.id,
      name: product.name,
    })),
  });
}

export function slimUsdaFoodListItem<TInput>(row: TInput) {
  const { nutrientSummary: _nutrients, ...item } = slimUsdaFood(row);
  return mcpUsdaFoodListItemOut.parse(item);
}

export function respond<TInput, TOutput>(
  result: TInput,
  project: (row: TInput) => TOutput,
): TOutput {
  return project(result);
}

export interface ProjectedList<TItem> {
  items: TItem[];
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
    action: z.enum(["get", "list", "create", "update", "merge"]),
    entity: z.enum(entityKeys),
    item: entitySummaryItemSchema.nullable().optional(),
    items: z.array(entitySummaryItemSchema).optional(),
  })
  .passthrough();

const projectionItemSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    book: z.string().nullish(),
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
  const quality = item.dataQuality;
  if (!quality) return undefined;
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
  if (command.resultDetail === "full") return result;
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

export function respondList<TInput, TOutput>(
  result: TInput[],
  project: (row: TInput) => TOutput,
): ProjectedList<TOutput> {
  return { items: result.map(project) };
}
