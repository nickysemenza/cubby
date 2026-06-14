/**
 * Product Orchestration Service
 *
 * Handles multi-step product workflows that go beyond simple CRUD:
 * - UPC cascade lookup (DB → USDA → UPC worker → create with defaults)
 * - Batch UPC image backfill
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { ProductTopLevelOut } from "@cubby/schemas/product";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { getErrorMessage } from "~/lib/error-utils";
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
): Promise<ProductTopLevelOut> {
  // 1. Check if product with this UPC already exists
  const existing = await findProductByUPC(db, upc);
  if (existing) {
    return existing;
  }

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
        return await quickCreateProduct(
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

        return newProduct;
      }

      // 4. Nothing found anywhere - create with defaults
      return await quickCreateProduct(
        db,
        {
          name: defaultName ?? `Product ${upc}`,
          manufacturer: UNSPECIFIED_MANUFACTURER,
          upc,
          expectedQuantity: null,
          model: null,
        },
        actor,
      );
    },
    async (error) => {
      const winner = await findProductByUPC(db, upc);
      if (!winner) throw error;
      return winner;
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
 * Processes in parallel batches of 10.
 */
export async function backfillUPCImages(
  db: Database,
  upcLookupClient: UPCLookupClient,
): Promise<BackfillSummary> {
  const allNoImages = await findProductsWithNoImages(db);
  const productsWithUPC = allNoImages.filter(
    (p): p is typeof p & { upc: string } => p.upc != null,
  );

  const details: BackfillResult[] = [];
  let imported = 0;
  let failed = 0;
  let skipped = 0;

  const BATCH_SIZE = 10;
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
  }

  return {
    found: productsWithUPC.length,
    imported,
    failed,
    skipped,
    details,
  };
}

/**
 * Get count of products eligible for UPC image backfill
 * (products with a UPC but no images).
 */
export async function getUPCImageBackfillCount(
  db: Database,
): Promise<{ count: number }> {
  const products = await findProductsWithNoImages(db);
  return { count: products.filter((p) => p.upc != null).length };
}
