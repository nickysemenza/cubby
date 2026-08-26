/**
 * Product Orchestration Service
 *
 * Handles multi-step product workflows that go beyond simple CRUD:
 * - UPC cascade lookup (DB → USDA → UPC worker → create with defaults)
 * - Batch UPC image backfill
 */

import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import type { ActorContext } from "@cubby/schemas/context";
import { displayGtin } from "@cubby/schemas/external-id";
import {
  type IngredientId,
  type IngredientShortcode,
  type ProductId,
  parseEntityId,
} from "@cubby/schemas/identifiers";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import { isbnFromGtin } from "@cubby/schemas/isbn";
import type {
  ProductCreateInput,
  ProductFindOrCreateByCodeInput,
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
  findProductByGtin,
  findProductsWithNoImages,
  quickCreateProduct,
} from "~/server/repo/product";
import {
  resolveCreatedOrInvariant,
  resolveLiveShortcode,
} from "~/server/repo/shortcode-resolver";
import { readCachedUpcLookups } from "~/server/repo/upc-lookup-cache";
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

const resolveIngredientEntityId = async (
  db: Database,
  shortcode: IngredientShortcode,
): Promise<IngredientId> => {
  const id = await resolveLiveShortcode(db, shortcode, "ingredient");
  if (!id) throw new Error(`Ingredient ${shortcode} could not be resolved`);
  return parseEntityId("ingredient", id);
};

export async function createProductWithSideEffects(
  services: ProductWriteServices & { upcLookupClient: UPCLookupClient },
  input: ProductCreateInput,
  actor: ActorContext,
): Promise<ProductWithFoodAndSideEffectsOut> {
  const { output: product, entityId } = await services.product.createProduct(
    input,
    actor,
  );
  const backgroundBatches = await runMutationSideEffects(services.db, {
    action: "created",
    entity: { entityType: "product", entityId },
    source: "product.create",
  });

  if (input.upc) {
    try {
      await importImageFromUPC(
        services.db,
        services.upcLookupClient,
        input.upc,
        entityId,
      );
    } catch (error) {
      console.error(`[product.create] Image import failed:`, error);
    }
  }

  const ingredientId = product.ingredient?.id;
  const recipeBatches = ingredientId
    ? await services.recipeCosting.recomputeForIngredient(
        await resolveIngredientEntityId(services.db, ingredientId),
        {
          source: "product.create",
          entity: { entityType: "product", entityId },
        },
      )
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
  const { output: result } = await services.product.updateProduct(
    id,
    data,
    actor,
  );
  const backgroundBatches = await runMutationSideEffects(services.db, {
    action: "updated",
    entity: { entityType: "product", entityId: id },
    source: "product.update",
  });
  const ingredientShortcodes = uniq(
    [previous?.ingredient?.id, result.ingredient?.id].filter(
      (ingredientId): ingredientId is NonNullable<typeof ingredientId> =>
        ingredientId != null,
    ),
  );
  const recipeBatches =
    ingredientShortcodes.length > 0
      ? await services.recipeCosting.recomputeForIngredients(
          await Promise.all(
            ingredientShortcodes.map((shortcode) =>
              resolveIngredientEntityId(services.db, shortcode),
            ),
          ),
          {
            source: "product.update",
            entity: { entityType: "product", entityId: id },
          },
        )
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
  const { lookups } = await readCachedUpcLookups(
    services.db,
    [input.upc],
    (upcs) => services.upcLookupClient.lookupBatch(upcs),
  );
  const lookup = lookups.get(input.upc) ?? null;

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
  const hasDisplayableImage = current.images.some(isDisplayableImageFile);
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
      ? await services.recipeCosting.recomputeForIngredient(
          await resolveIngredientEntityId(services.db, ingredientId),
          {
            source: "product.applyUpcData",
            entity: { entityType: "product", entityId: input.id },
          },
        )
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
 * The identity a USDA food would give a product created from this barcode.
 * Shared with {@link lookupUPC} so the read-only answer is exactly what a
 * create would have written, rather than a second opinion that can drift.
 */
const usdaIdentity = (food: NonNullable<UsdaFoodByUpc>) => ({
  name: food.foodInfo.description,
  manufacturer:
    food.brandedFoodInfo?.brand_owner ??
    food.brandedFoodInfo?.brand_name ??
    UNSPECIFIED_MANUFACTURER,
});

const externalIdentity = (hit: UPCLookupHit) => ({
  name: hit.name,
  manufacturer: hit.manufacturer ?? hit.brand ?? UNSPECIFIED_MANUFACTURER,
  price: hit.priceDollars ?? null,
});

type UsdaFoodByUpc = Awaited<ReturnType<USDAClient["findFood"]>>;
type UPCLookupHit = NonNullable<Awaited<ReturnType<UPCLookupClient["lookup"]>>>;

export interface LookupUPCResult {
  upc: string;
  localProduct: ProductTopLevelOut | null;
  usdaFood: (ReturnType<typeof usdaIdentity> & { fdc_id: number }) | null;
  externalLookup:
    | (ReturnType<typeof externalIdentity> & {
        source: UPCLookupHit["source"];
        category: string | null;
        description: string | null;
        imageUrl: string | null;
      })
    | null;
}

/**
 * Answer "what is this barcode?" without creating anything.
 *
 * Deliberately queries all three sources in PARALLEL rather than reusing
 * `findOrCreateByUPC`'s short-circuiting cascade. The cascade exists to avoid
 * paying for network lookups it will not use once it has enough to create a
 * product; this question is the opposite — a local product that claims a
 * barcode is precisely when you most want to see what the manufacturer and the
 * UPC database say about it, because that is how a kit masquerading as a bare
 * tool gets caught. Both clients swallow their own errors and return null, so a
 * dead source degrades one field rather than the call.
 */
export async function lookupUPC(
  db: Database,
  usdaClient: USDAClient,
  upcLookupClient: UPCLookupClient,
  upc: string,
): Promise<LookupUPCResult> {
  const [localProduct, food, external] = await Promise.all([
    findProductByGtin(db, upc),
    usdaClient.findFood({ kind: "upc", gtin_upc: upc }),
    upcLookupClient.lookup(upc),
  ]);

  return {
    upc,
    localProduct,
    usdaFood: food ? { ...usdaIdentity(food), fdc_id: food.fdc_id } : null,
    externalLookup: external
      ? {
          ...externalIdentity(external),
          source: external.source,
          category: external.category ?? null,
          description: external.description ?? null,
          imageUrl: external.imageUrl ?? null,
        }
      : null,
  };
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
  const existing = await findProductByGtin(db, upc);
  if (existing) {
    return { product: existing, created: false };
  }

  const emitCreated = async (
    product: ProductTopLevelOut,
  ): Promise<FindOrCreateByUPCResult> => {
    const entityId = await resolveCreatedOrInvariant(db, "product", product.id);
    await runMutationSideEffects(db, {
      action: "created",
      entity: { entityType: "product", entityId },
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
      const food = await usdaClient.findFood({
        kind: "upc",
        gtin_upc: upc,
      });

      if (food) {
        return await emitCreated(
          await quickCreateProduct(
            db,
            {
              ...usdaIdentity(food),
              upc,
              expectedQuantity: null,
              model: null,
            },
            actor,
          ),
        );
      }

      const upcLookup = await upcLookupClient.lookup(upc);

      if (upcLookup) {
        const newProduct = await quickCreateProduct(
          db,
          {
            ...externalIdentity(upcLookup),
            upc,
            expectedQuantity: null,
            model: null,
          },
          actor,
        );

        if (upcLookup.imageUrl) {
          try {
            await importImageFromUPC(
              db,
              upcLookupClient,
              upc,
              await resolveCreatedOrInvariant(db, "product", newProduct.id),
            );
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
      const winner = await findProductByGtin(db, upc);
      if (!winner) throw error;
      return { product: winner, created: false };
    },
  );
}

/**
 * Find or create the physical-book Product named by an ISBN.
 *
 * ISBNs are EAN barcodes, but they are not food identities: skip USDA and
 * create through `isbn` so the repository both stores the canonical GTIN and
 * applies the `books` category invariant. The general UPC provider can still
 * supply the edition's title, publisher/manufacturer, price, and cover.
 */
async function findOrCreateByISBN(
  db: Database,
  upcLookupClient: UPCLookupClient,
  canonicalGtin: string,
  actor: ActorContext,
): Promise<FindOrCreateByUPCResult> {
  const normalized = isbnFromGtin(canonicalGtin);
  if (!normalized) {
    throw new Error(`Invalid canonical ISBN: ${canonicalGtin}`);
  }

  const existing = await findProductByGtin(db, canonicalGtin);
  if (existing) return { product: existing, created: false };

  const emitCreated = async (
    product: ProductTopLevelOut,
  ): Promise<FindOrCreateByUPCResult> => {
    const entityId = await resolveCreatedOrInvariant(db, "product", product.id);
    await runMutationSideEffects(db, {
      action: "created",
      entity: { entityType: "product", entityId },
      source: "product.findOrCreateByCode",
    });
    return { product, created: true };
  };

  return runWithConflictRecovery(
    async () => {
      const external = await upcLookupClient.lookup(normalized.isbn13);
      const product = await quickCreateProduct(
        db,
        {
          ...(external
            ? externalIdentity(external)
            : {
                name: `Book ISBN ${normalized.isbn13}`,
                manufacturer: UNSPECIFIED_MANUFACTURER,
              }),
          isbn: canonicalGtin,
          expectedQuantity: null,
          model: null,
        },
        actor,
      );

      if (external?.imageUrl) {
        try {
          await importImageFromUPC(
            db,
            upcLookupClient,
            normalized.isbn13,
            await resolveCreatedOrInvariant(db, "product", product.id),
          );
        } catch (error) {
          console.error(`[findOrCreateByISBN] Image import failed:`, error);
        }
      }

      return await emitCreated(product);
    },
    async (error) => {
      const winner = await findProductByGtin(db, canonicalGtin);
      if (!winner) throw error;
      return { product: winner, created: false };
    },
  );
}

export function findOrCreateByCode(
  db: Database,
  usdaClient: USDAClient,
  upcLookupClient: UPCLookupClient,
  input: ProductFindOrCreateByCodeInput,
  actor: ActorContext,
): Promise<FindOrCreateByUPCResult> {
  return input.kind === "isbn"
    ? findOrCreateByISBN(db, upcLookupClient, input.value, actor)
    : findOrCreateByUPC(
        db,
        usdaClient,
        upcLookupClient,
        input.value,
        undefined,
        actor,
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
  // The provider is keyed by barcode, so a product without one has nothing to
  // look up. `displayGtin` because the provider indexes the printed encoding,
  // not the canonical GTIN-14 the identifier row stores.
  const productsWithUPC = allNoImages.flatMap((p) =>
    p.primaryGtin == null ? [] : [{ ...p, upc: displayGtin(p.primaryGtin) }],
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
