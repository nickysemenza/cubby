import type { ActorContext } from "@cubby/schemas/context";
import type {
  IngredientId,
  ProductId,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import type {
  ProductCreateInput,
  ProductSummariesInput,
  ProductSummariesOut,
  ProductUpdateInput,
  ProductWithFoodOut,
} from "@cubby/schemas/product";
import type { FoodSummary } from "@cubby/usda-schemas";
import { uniq } from "es-toolkit";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import type { USDAClient } from "../clients/usda";
import { getRecipeUsagesForIngredient } from "../repo/ingredient";
import {
  createProduct as createProductRepo,
  foodLookupParamFromProduct,
  getProductByID as getProductByIDRepo,
  getProductImagesByProductIds,
  getProductsForFoodLookup,
  getProductUnitMappingsByProductIds,
  updateProduct as updateProductRepo,
} from "../repo/product";
import {
  resolveLiveShortcode,
  resolveLiveShortcodes,
} from "../repo/shortcode-resolver";
import { batchEnrichWithFood } from "./usda-helpers";

export type ProductWriteResult = {
  output: ProductWithFoodOut;
  entityId: ProductId;
};

export type ProductWriteActions = {
  getProductByID(id: ProductId): Promise<ProductWithFoodOut>;
  createProduct(
    data: ProductCreateInput,
    actor: ActorContext,
  ): Promise<ProductWriteResult>;
  updateProduct(
    id: ProductId,
    data: ProductUpdateInput["data"],
    actor: ActorContext,
  ): Promise<ProductWriteResult>;
};

export const getProductWithFood = async (
  db: Database,
  usdaClient: USDAClient,
  id: ProductId,
): Promise<ProductWithFoodOut> => {
  const product = await getProductByIDRepo(db, id);

  // Resolve the linked food: explicit fdc_id wins, else UPC auto-match.
  const lookupParam = foodLookupParamFromProduct(product);
  const food = lookupParam ? await usdaClient.findFood(lookupParam) : null;

  // Recipes the product appears in, resolved through its linked ingredient.
  const ingredientEntityId = product.ingredient
    ? await resolveLiveShortcode(db, product.ingredient.id, "ingredient")
    : null;
  const { recipeUsages } = ingredientEntityId
    ? await getRecipeUsagesForIngredient(db, ingredientEntityId as IngredientId)
    : { recipeUsages: [] };

  return {
    ...product,
    food,
    recipeUsages,
  };
};

const getProductFoodSummaries = async (
  db: Database,
  usdaClient: USDAClient,
  ids: ProductId[],
): Promise<Record<string, FoodSummary | null>> => {
  const uniqueIds = uniq(ids);
  const result: Record<string, FoodSummary | null> = Object.fromEntries(
    uniqueIds.map((id) => [id, null]),
  );
  if (uniqueIds.length === 0) return result;

  const products = await getProductsForFoodLookup(db, uniqueIds);
  const productsWithFood = await batchEnrichWithFood(
    products,
    foodLookupParamFromProduct,
    usdaClient,
  );

  for (const product of productsWithFood) {
    result[product.id] = product.food;
  }

  return result;
};

export const getProductSummaries = async (
  db: Database,
  usdaClient: USDAClient,
  shortcodes: ProductShortcode[],
  include: ProductSummariesInput["include"],
): Promise<ProductSummariesOut> => {
  const resolved = await resolveLiveShortcodes(db, shortcodes, "product");
  const missing = shortcodes.find((shortcode) => !resolved.has(shortcode));
  if (missing) {
    throw createAppError("PRODUCT_NOT_FOUND", `Product ${missing} not found`);
  }
  const ids = shortcodes.map(
    (shortcode) => resolved.get(shortcode) as ProductId,
  );
  const shortcodeById = new Map(
    shortcodes.map((shortcode) => [
      resolved.get(shortcode) as ProductId,
      shortcode,
    ]),
  );
  const rekey = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(
      Object.entries(record).flatMap(([id, value]) => {
        const shortcode = shortcodeById.get(id as ProductId);
        return shortcode ? [[shortcode, value]] : [];
      }),
    );
  const requested = new Set(include);
  const summaries: ProductSummariesOut = {};

  await Promise.all([
    requested.has("food")
      ? getProductFoodSummaries(db, usdaClient, ids).then((food) => {
          summaries.food = rekey(food);
        })
      : undefined,
    requested.has("images")
      ? getProductImagesByProductIds(db, ids).then((images) => {
          summaries.images = rekey(images);
        })
      : undefined,
    requested.has("unitMappings")
      ? getProductUnitMappingsByProductIds(db, ids).then((unitMappings) => {
          summaries.unitMappings = Object.fromEntries(
            Object.entries(unitMappings).flatMap(([id, mappings]) => {
              const shortcode = shortcodeById.get(id as ProductId);
              return shortcode
                ? [
                    [
                      shortcode,
                      mappings.map((mapping) => ({
                        ...mapping,
                        sourceMetadata: {
                          type: "product" as const,
                          productId: shortcode,
                        },
                      })),
                    ],
                  ]
                : [];
            }),
          );
        })
      : undefined,
  ]);

  return summaries;
};

export const createProductWithFood = async (
  db: Database,
  usdaClient: USDAClient,
  data: ProductCreateInput,
  actor: ActorContext,
): Promise<ProductWriteResult> => {
  const ingredientEntityId = data.ingredientId
    ? await resolveLiveShortcode(db, data.ingredientId, "ingredient")
    : null;
  if (data.ingredientId && !ingredientEntityId) {
    throw createAppError(
      "INGREDIENT_NOT_FOUND",
      `Ingredient ${data.ingredientId} not found`,
    );
  }
  const product = await createProductRepo(
    db,
    {
      ...data,
      ingredientId: ingredientEntityId as IngredientId | null,
    },
    actor,
  );
  // Dependent recipes are recomputed eagerly at the router (the single `create`
  // proc per product, `createMany` once over the deduped union) — covers UI +
  // MCP. No mark-stale; there is no drain anymore.
  const entityId = await resolveLiveShortcode(db, product.id, "product");
  if (!entityId) {
    throw new Error(`Created product ${product.id} could not be resolved`);
  }
  return {
    output: await getProductWithFood(db, usdaClient, entityId as ProductId),
    entityId: entityId as ProductId,
  };
};

export const updateProductWithFood = async (
  db: Database,
  usdaClient: USDAClient,
  id: ProductId,
  data: ProductUpdateInput["data"],
  actor: ActorContext,
): Promise<ProductWriteResult> => {
  const ingredientEntityId = data.ingredientId
    ? await resolveLiveShortcode(db, data.ingredientId, "ingredient")
    : data.ingredientId;
  if (data.ingredientId && !ingredientEntityId) {
    throw createAppError(
      "INGREDIENT_NOT_FOUND",
      `Ingredient ${data.ingredientId} not found`,
    );
  }
  await updateProductRepo(
    db,
    id,
    {
      ...data,
      ingredientId: ingredientEntityId as IngredientId | null | undefined,
    },
    actor,
  );
  // Eager recompute of dependent recipes (and inventory valuations) happens at
  // the router layer (covers UI + MCP callers) — see the product router's
  // update proc.
  return {
    output: await getProductWithFood(db, usdaClient, id),
    entityId: id,
  };
};

export const createProductWriteActions = (
  db: Database,
  usdaClient: USDAClient,
): ProductWriteActions => ({
  getProductByID: (id) => getProductWithFood(db, usdaClient, id),
  createProduct: (data, actor) =>
    createProductWithFood(db, usdaClient, data, actor),
  updateProduct: (id, data, actor) =>
    updateProductWithFood(db, usdaClient, id, data, actor),
});
