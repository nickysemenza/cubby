/**
 * Product Orchestration Service
 *
 * Handles multi-step product workflows that go beyond simple CRUD:
 * - UPC cascade lookup (DB → USDA → UPC worker → create with defaults)
 * - Batch UPC image backfill
 */

import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import type { ActorContext } from "@cubby/schemas/context";
import type { ProductId } from "@cubby/schemas/identifiers";
import { isDocumentFile } from "@cubby/schemas/image";
import type {
  ProductCreateInput,
  ProductTopLevelOut,
  ProductUpdateInput,
  ProductWithFoodAndSideEffectsOut,
} from "@cubby/schemas/product";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { uniq } from "es-toolkit";
import { getErrorMessage } from "~/lib/error-utils";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { runWithConflictRecovery } from "~/server/errors/db-errors";
import {
  findProductByUPC,
  findProductsWithNoImages,
  quickCreateProduct,
} from "~/server/repo/product";
import { importImageFromUPC } from "./image-import";
import type { LocationValuationService } from "./location-valuation.service";
import { runMutationSideEffects } from "./mutation-side-effects";
import type { ProductWriteActions } from "./product.service";
import type { RecipeCostingService } from "./recipe-costing.service";

interface ProductWriteServices {
  db: Database;
  product: ProductWriteActions;
  recipeCosting: RecipeCostingService;
  locationValuation: LocationValuationService;
}

export async function createProductWithSideEffects(
  services: ProductWriteServices & { upcLookupClient: UPCLookupClient },
  input: ProductCreateInput,
  actor: ActorContext,
): Promise<ProductWithFoodAndSideEffectsOut> {
  const product = await services.product.createProduct(input, actor);
  const backgroundBatches = await runMutationSideEffects(services.db, {
    action: "created",
    entity: { entityType: "product", entityId: product.id },
    source: "product.create",
  });

  if (input.upc) {
    try {
      await importImageFromUPC(
        services.db,
        services.upcLookupClient,
        input.upc,
        product.id,
      );
    } catch (error) {
      console.error(`[product.create] Image import failed:`, error);
    }
  }

  const ingredientId = product.ingredient?.id;
  const recipeBatches = ingredientId
    ? await services.recipeCosting.recomputeForIngredient(ingredientId, {
        source: "product.create",
        entity: { entityType: "product", entityId: product.id },
      })
    : [];

  return {
    ...product,
    sideEffects: {
      backgroundBatches: [...backgroundBatches, ...recipeBatches],
    },
  };
}

export async function updateProductWithSideEffects(
  services: ProductWriteServices,
  id: ProductId,
  data: ProductUpdateInput["data"],
  actor: ActorContext,
): Promise<ProductWithFoodAndSideEffectsOut> {
  const previous =
    data.ingredientId !== undefined
      ? await services.product.getProductByID(id)
      : null;
  const result = await services.product.updateProduct(id, data, actor);
  const backgroundBatches = await runMutationSideEffects(services.db, {
    action: "updated",
    entity: { entityType: "product", entityId: id },
    source: "product.update",
  });
  const ingredientIds = uniq(
    [previous?.ingredient?.id, result.ingredient?.id].filter(
      (ingredientId): ingredientId is NonNullable<typeof ingredientId> =>
        ingredientId != null,
    ),
  );
  const recipeBatches =
    ingredientIds.length > 0
      ? await services.recipeCosting.recomputeForIngredients(ingredientIds, {
          source: "product.update",
          entity: { entityType: "product", entityId: id },
        })
      : [];

  return {
    ...result,
    sideEffects: {
      backgroundBatches: [...backgroundBatches, ...recipeBatches],
    },
  };
}

export async function applyUpcDataWithSideEffects(
  services: ProductWriteServices & { upcLookupClient: UPCLookupClient },
  input: { id: ProductId; upc: string },
  actor: ActorContext,
): Promise<ProductWithFoodAndSideEffectsOut> {
  const current = await services.product.getProductByID(input.id);
  const lookup = await services.upcLookupClient.lookup(input.upc);

  const data: { manufacturer?: string; price?: number } = {};
  const lookupManufacturer = lookup?.manufacturer ?? lookup?.brand ?? null;
  if (
    lookupManufacturer != null &&
    isUnspecifiedManufacturer(current.manufacturer) &&
    !isUnspecifiedManufacturer(lookupManufacturer)
  ) {
    data.manufacturer = lookupManufacturer;
  }
  if (current.price == null && lookup?.priceDollars != null) {
    data.price = lookup.priceDollars;
  }

  const priceChanged = data.price !== undefined;
  let backgroundBatches: BackgroundBatchRef[] = [];
  if (Object.keys(data).length > 0) {
    await services.product.updateProduct(input.id, data, actor);
    backgroundBatches = await runMutationSideEffects(services.db, {
      action: "updated",
      entity: { entityType: "product", entityId: input.id },
      source: "product.applyUpcData",
    });
  }

  // PDF manuals share the images relation — a manual-only product still has
  // no displayable image and should get the UPC-lookup photo.
  const hasDisplayableImage = current.images.some(
    (img) => !isDocumentFile(img),
  );
  if (!hasDisplayableImage && lookup?.imageUrl) {
    try {
      await importImageFromUPC(
        services.db,
        services.upcLookupClient,
        input.upc,
        input.id,
      );
    } catch (error) {
      console.error(`[product.applyUpcData] Image import failed:`, error);
    }
  }

  const result = await services.product.getProductByID(input.id);
  const ingredientId = result.ingredient?.id;
  const recipeBatches =
    priceChanged && ingredientId
      ? await services.recipeCosting.recomputeForIngredient(ingredientId, {
          source: "product.applyUpcData",
          entity: { entityType: "product", entityId: input.id },
        })
      : [];
  return {
    ...result,
    sideEffects: {
      backgroundBatches: [...backgroundBatches, ...recipeBatches],
    },
  };
}

/**
 * The result of a UPC find-or-create. `created` distinguishes a brand-new
 * product from a match against an existing one — the scan UI uses it to prompt
 * "link an ingredient?" only for genuinely-new products (a new UPC product
 * lands with no ingredient link / mappings, invisible to recipe costing).
 */
export interface FindOrCreateByUPCResult {
  product: ProductTopLevelOut;
  created: boolean;
}

/**
 * Find or create a product by UPC code.
 * Cascade: local DB → USDA → UPC worker → create with defaults.
 */
export async function findOrCreateByUPC(
  db: Database,
  usdaClient: USDAClient,
  upcLookupClient: UPCLookupClient,
  upc: string,
  defaultName: string | undefined,
  actor: ActorContext,
): Promise<FindOrCreateByUPCResult> {
  // 1. Check if product with this UPC already exists
  const existing = await findProductByUPC(db, upc);
  if (existing) {
    return { product: existing, created: false };
  }

  const emitCreated = async (
    product: ProductTopLevelOut,
  ): Promise<FindOrCreateByUPCResult> => {
    await runMutationSideEffects(db, {
      action: "created",
      entity: { entityType: "product", entityId: product.id },
      source: "product.findOrCreateByUPC",
    });
    return { product, created: true };
  };

  // Cascade create with cross-request race recovery. Each quickCreateProduct is
  // a single product INSERT, so a concurrent creator of the same UPC makes the
  // loser's INSERT throw a (raw) unique violation with nothing committed.
  // runWithConflictRecovery re-SELECTs the committed winner by UPC instead of
  // 500ing; a non-UPC duplicate (e.g. name+manufacturer) finds no UPC row and
  // is re-thrown unchanged.
  return runWithConflictRecovery(
    async () => {
      // 2. Lookup in USDA database (food items)
      const food = await usdaClient.findFood({
        kind: "upc",
        gtin_upc: upc,
      });

      if (food) {
        return await emitCreated(
          await quickCreateProduct(
            db,
            {
              name: food.foodInfo.description,
              manufacturer:
                food.brandedFoodInfo?.brand_owner ??
                food.brandedFoodInfo?.brand_name ??
                UNSPECIFIED_MANUFACTURER,
              upc,
              expectedQuantity: null,
              model: null,
            },
            actor,
          ),
        );
      }

      // 3. Lookup in UPC worker (general products - tools, electronics, etc.)
      const upcLookup = await upcLookupClient.lookup(upc);

      if (upcLookup) {
        const newProduct = await quickCreateProduct(
          db,
          {
            name: upcLookup.name,
            manufacturer:
              upcLookup.manufacturer ??
              upcLookup.brand ??
              UNSPECIFIED_MANUFACTURER,
            upc,
            expectedQuantity: null,
            model: null,
            price: upcLookup.priceDollars ?? null,
          },
          actor,
        );

        // Import image from UPC lookup if available (non-blocking)
        if (upcLookup.imageUrl) {
          try {
            await importImageFromUPC(db, upcLookupClient, upc, newProduct.id);
          } catch (error) {
            console.error(`[findOrCreateByUPC] Image import failed:`, error);
          }
        }

        return await emitCreated(newProduct);
      }

      // 4. Nothing found anywhere - create with defaults
      return await emitCreated(
        await quickCreateProduct(
          db,
          {
            name: defaultName ?? `Product ${upc}`,
            manufacturer: UNSPECIFIED_MANUFACTURER,
            upc,
            expectedQuantity: null,
            model: null,
          },
          actor,
        ),
      );
    },
    async (error) => {
      const winner = await findProductByUPC(db, upc);
      if (!winner) throw error;
      return { product: winner, created: false };
    },
  );
}

interface BackfillResult {
  productId: string;
  productName: string;
  upc: string;
  status: "imported" | "failed" | "skipped";
  error?: string;
}

interface BackfillSummary {
  found: number;
  imported: number;
  failed: number;
  skipped: number;
  details: BackfillResult[];
}

/**
 * Batch import UPC images for products that have a UPC but no images.
 * Processes in parallel batches of 10. Streamed: `yield`s `{done,total}` after
 * each batch (each batch's per-product writes commit independently — safe to
 * yield between them) and `return`s the summary.
 */
export async function* backfillUPCImages(
  db: Database,
  upcLookupClient: UPCLookupClient,
): AsyncGenerator<{ done: number; total: number }, BackfillSummary> {
  const allNoImages = await findProductsWithNoImages(db);
  const productsWithUPC = allNoImages.filter(
    (p): p is typeof p & { upc: string } => p.upc != null,
  );

  const details: BackfillResult[] = [];
  let imported = 0;
  let failed = 0;
  let skipped = 0;

  const total = productsWithUPC.length;
  let done = 0;
  const BATCH_SIZE = 10;
  yield { done, total };
  for (let i = 0; i < productsWithUPC.length; i += BATCH_SIZE) {
    const batch = productsWithUPC.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async (p) => {
        try {
          const result = await importImageFromUPC(
            db,
            upcLookupClient,
            p.upc,
            p.id,
          );

          if (result) {
            return {
              productId: p.id,
              productName: p.name,
              upc: p.upc,
              status: "imported" as const,
            };
          } else {
            return {
              productId: p.id,
              productName: p.name,
              upc: p.upc,
              status: "skipped" as const,
              error: "No image found in UPC lookup",
            };
          }
        } catch (error) {
          return {
            productId: p.id,
            productName: p.name,
            upc: p.upc,
            status: "failed" as const,
            error: getErrorMessage(error),
          };
        }
      }),
    );

    for (const result of batchResults) {
      details.push(result);
      if (result.status === "imported") imported++;
      else if (result.status === "skipped") skipped++;
      else failed++;
    }
    done += batch.length;
    yield { done, total };
  }

  return {
    found: productsWithUPC.length,
    imported,
    failed,
    skipped,
    details,
  };
}
