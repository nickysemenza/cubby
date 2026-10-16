import type { ActorContext } from "@cubby/schemas/context";
import {
  type ProductId,
  type ProductShortcode,
  parseEntityId,
} from "@cubby/schemas/identifiers";
import type {
  ProductCreateInput,
  ProductSummariesInput,
  ProductSummariesOut,
  ProductUpdateInput,
  ProductWithFoodOut,
} from "@cubby/schemas/product";
import type { FoodSummary } from "@cubby/usda";
import { uniq } from "es-toolkit";

import { startOperationDefinition } from "~/lib/start-operation-observability";
import { deleteStoredObjects } from "~/server/clients/s3";
import type { UsdaFoodLookupPort } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { getRecipeUsagesForIngredient } from "~/server/domains/ingredient/repo/search";
import { loadProductOwners } from "~/server/domains/inventory/repo/ownership";
import { foodLookupParamFromProduct } from "~/server/domains/product/repo/helpers";
import { buildNutritionDisplay } from "~/server/domains/product/repo/nutrition-display";
import {
  batchEnrichWithFood,
  type UsdaFoodBatchPort,
} from "~/server/domains/usda-food/repo/usda-helpers";
import { createAppError } from "~/server/errors/app-error";
import {
  resolveAllOrThrow,
  resolveCreatedOrInvariant,
  resolveLiveShortcode,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { observeOperationPhase } from "~/server/observability/observed-request";

import {
  createProduct as createProductRepo,
  getProductByID as getProductByIDRepo,
  getProductImagesByProductIds,
  getProductsForFoodLookup,
  updateProduct as updateProductRepo,
} from "../crud";
import { loadProductOwnershipEvidence } from "../ownership-evidence";
import { getProductUnitMappingsByProductIds } from "../unit-mappings";

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
  usdaClient: UsdaFoodLookupPort,
  id: ProductId,
): Promise<ProductWithFoodOut> => {
  const product = await getProductByIDRepo(db, id);

  const lookupParam = foodLookupParamFromProduct(product);
  const operation = startOperationDefinition("entity.detail");
  const [food, { recipeUsages }, ownership, owners] = await Promise.all([
    observeOperationPhase(operation, "food", () =>
      lookupParam ? usdaClient.findFood(lookupParam) : Promise.resolve(null),
    ),
    observeOperationPhase(operation, "recipe_usages", async () => {
      const ingredientEntityId = product.ingredient
        ? await resolveLiveShortcode(db, product.ingredient.id, "ingredient")
        : null;
      return ingredientEntityId
        ? await getRecipeUsagesForIngredient(
            db,
            parseEntityId("ingredient", ingredientEntityId),
          )
        : { recipeUsages: [], appearsInRecipes: [] };
    }),
    loadProductOwnershipEvidence(db, id),
    loadProductOwners(db, [id]),
  ]);

  return {
    ...product,
    ownershipEvidence: ownership,
    owners: owners.get(id) ?? [],
    nutritionDisplay: buildNutritionDisplay({
      labelNutrition: product.labelNutrition,
      food,
    }),
    food,
    recipeUsages,
  };
};

const getProductFoodSummaries = async (
  db: Database,
  usdaClient: UsdaFoodBatchPort,
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
  usdaClient: UsdaFoodBatchPort,
  shortcodes: ProductShortcode[],
  include: ProductSummariesInput["include"],
): Promise<ProductSummariesOut> => {
  const ids = await resolveAllOrThrow(db, "product", shortcodes);
  const shortcodeById = new Map(
    shortcodes.map((shortcode, i) => {
      return [ids[i]!, shortcode] as const;
    }),
  );
  const rekey = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(
      Object.entries(record).flatMap(([id, value]) => {
        const shortcode = shortcodeById.get(parseEntityId("product", id));
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
              const shortcode = shortcodeById.get(parseEntityId("product", id));
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
  usdaClient: UsdaFoodLookupPort,
  data: ProductCreateInput,
  actor: ActorContext,
): Promise<ProductWriteResult> => {
  const ingredientEntityId = data.ingredientId
    ? await resolveOrThrow(db, "ingredient", data.ingredientId)
    : null;
  const growsPlantEntityId = data.growsPlantId
    ? await resolveOrThrow(db, "plant", data.growsPlantId)
    : null;
  const product = await createProductRepo(
    db,
    {
      ...data,
      categoryId:
        data.categoryId == null
          ? data.categoryId
          : await resolveOrThrow(db, "productCategory", data.categoryId),
      ingredientId: ingredientEntityId,
      growsPlantId: growsPlantEntityId,
    },
    actor,
  );
  const productId = await resolveCreatedOrInvariant(db, "product", product.id);
  try {
    return {
      output: await getProductWithFood(db, usdaClient, productId),
      entityId: productId,
    };
  } catch (error) {
    // The row is committed at this point. A bare rethrow reads as "the create
    // failed" and gets retried into a duplicate; say what actually happened.
    throw createAppError(
      "WRITE_COMMITTED_READBACK_FAILED",
      `Product ${product.id} was created, but reading it back failed. Do not create it again; fetch it by id.`,
      error,
    );
  }
};

export const updateProductWithFood = async (
  db: Database,
  usdaClient: UsdaFoodLookupPort,
  id: ProductId,
  data: ProductUpdateInput["data"],
  actor: ActorContext,
): Promise<ProductWriteResult> => {
  // Explicit `== null` (not a truthy check): the falsy branch must narrow to
  // `null | undefined` so it matches the branded `IngredientId | null |
  // undefined` the repo expects — a truthy check leaves the branch typed as
  // the unbranded `IngredientShortcode`, since TS can't prove a non-literal
  // string type is never empty.
  const ingredientEntityId =
    data.ingredientId == null
      ? data.ingredientId
      : await resolveOrThrow(db, "ingredient", data.ingredientId);
  const growsPlantEntityId =
    data.growsPlantId == null
      ? data.growsPlantId
      : await resolveOrThrow(db, "plant", data.growsPlantId);
  const { detachedImageKeys } = await updateProductRepo(
    db,
    id,
    {
      ...data,
      categoryId:
        data.categoryId == null
          ? data.categoryId
          : await resolveOrThrow(db, "productCategory", data.categoryId),
      ingredientId: ingredientEntityId,
      growsPlantId: growsPlantEntityId,
    },
    actor,
  );
  // After the commit, never inside it: an R2 delete has no rollback. Best-effort
  // by contract — stranded bytes are cheaper than failing a committed update.
  await deleteStoredObjects(detachedImageKeys);
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
  usdaClient: UsdaFoodLookupPort,
): ProductWriteActions => ({
  getProductByID: (id) => getProductWithFood(db, usdaClient, id),
  createProduct: (data, actor) =>
    createProductWithFood(db, usdaClient, data, actor),
  updateProduct: (id, data, actor) =>
    updateProductWithFood(db, usdaClient, id, data, actor),
});
