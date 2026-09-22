/**
 * Product Orchestration Service
 *
 * Handles multi-step product workflows that go beyond simple CRUD:
 * - UPC cascade lookup (DB → USDA → UPC worker → create with defaults)
 * - Batch UPC image backfill
 */

import {
  EMPTY_MUTATION_SIDE_EFFECTS,
  type MutationSideEffects,
  mutationSideEffectsWithWarnings,
} from "@cubby/schemas/background-jobs";
import type { ActorContext } from "@cubby/schemas/context";
import { displayGtin } from "@cubby/schemas/external-id";
import {
  type IngredientId,
  type IngredientShortcode,
  type ProductId,
  type ProductShortcode,
  parseEntityId,
} from "@cubby/schemas/identifiers";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import type {
  ProductCreateInput,
  ProductTopLevelOut,
  ProductUpdateInput,
  ProductWithFoodAndSideEffectsOut,
} from "@cubby/schemas/product";
import type { ScanAtLocationCode } from "@cubby/schemas/scan";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { uniq } from "es-toolkit";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { getErrorMessage } from "~/lib/error-utils";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { type ResolvedProductCode, resolveProductScan } from "~/lib/scan-code";
import { wasm } from "~/lib/wasm";
import type { UpcLookupPort } from "~/server/clients/upc-lookup";
import type { UsdaFoodLookupPort } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { runWithConflictRecovery } from "~/server/errors/db-errors";
import {
  findProductByGtin,
  findProductsWithNoImages,
  getProductByShortcode,
  quickCreateProduct,
} from "~/server/repo/product";
import {
  resolveCreatedOrInvariant,
  resolveLiveShortcode,
} from "~/server/repo/shortcode-resolver";
import { readCachedUpcLookups } from "~/server/repo/upc-lookup-cache";

import { importImageFromUPC } from "./image-import";
import { runMutationSideEffects } from "./mutation-side-effects";
import type { ProductWriteActions } from "./product.service";
import type { RecipeCostingService } from "./recipe-costing.service";

interface ProductWriteServices {
  db: Database;
  product: ProductWriteActions;
  recipeCosting: RecipeCostingService;
}

type UpcProductUpdate = Pick<
  ProductUpdateInput["data"],
  "manufacturer" | "price"
>;

const resolveIngredientEntityId = async (
  db: Database,
  shortcode: IngredientShortcode,
): Promise<IngredientId> => {
  const id = await resolveLiveShortcode(db, shortcode, "ingredient");
  if (!id) throw new Error(`Ingredient ${shortcode} could not be resolved`);
  return parseEntityId("ingredient", id);
};

/**
 * A UPC/ISBN cover photo is best-effort: the product write has already
 * succeeded, so a failed import becomes a caller-visible warning (raw
 * diagnostics, credential-scrubbed) instead of failing the write. The
 * product-enrichment pass remains the repair path.
 */
async function importCoverPhoto(
  db: Database,
  upcLookupClient: UpcLookupPort,
  code: string,
  productId: ProductId,
  source: string,
): Promise<string[]> {
  try {
    await importImageFromUPC(db, upcLookupClient, code, productId);
    return [];
  } catch (error) {
    console.error(`[${source}] Image import failed:`, error);
    return [
      scrubErrorMessage(
        `Cover photo import for ${code} failed: ${getErrorMessage(error)}`,
      ),
    ];
  }
}

export async function createProductWithSideEffects(
  services: ProductWriteServices & { upcLookupClient: UpcLookupPort },
  input: ProductCreateInput,
  actor: ActorContext,
): Promise<ProductWithFoodAndSideEffectsOut> {
  const { output: product, entityId } = await services.product.createProduct(
    input,
    actor,
  );
  await runMutationSideEffects(services.db, {
    action: "created",
    entity: { entity: "product", id: entityId },
    source: "product.create",
  });

  const warnings = input.upc
    ? await importCoverPhoto(
        services.db,
        services.upcLookupClient,
        input.upc,
        entityId,
        "product.create",
      )
    : [];

  const ingredientId = product.ingredient?.id;
  if (ingredientId) {
    await services.recipeCosting.recomputeForIngredient(
      await resolveIngredientEntityId(services.db, ingredientId),
      {
        source: "product.create",
        entity: { entityType: "product", entityId },
      },
    );
  }

  return {
    ...product,
    sideEffects: mutationSideEffectsWithWarnings(warnings),
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
  await runMutationSideEffects(services.db, {
    action: "updated",
    entity: { entity: "product", id: id },
    source: "product.update",
  });
  const ingredientShortcodes = uniq(
    [previous?.ingredient?.id, result.ingredient?.id].filter(
      (ingredientId): ingredientId is NonNullable<typeof ingredientId> =>
        ingredientId != null,
    ),
  );
  if (ingredientShortcodes.length > 0) {
    await services.recipeCosting.recomputeForIngredients(
      await Promise.all(
        ingredientShortcodes.map((shortcode) =>
          resolveIngredientEntityId(services.db, shortcode),
        ),
      ),
      {
        source: "product.update",
        entity: { entityType: "product", entityId: id },
      },
    );
  }

  return {
    ...result,
    sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
  };
}

export async function applyUpcDataWithSideEffects(
  services: ProductWriteServices & { upcLookupClient: UpcLookupPort },
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

  const data: UpcProductUpdate = {};
  const lookupManufacturer = lookup?.manufacturer ?? lookup?.brand ?? null;
  if (
    lookupManufacturer != null &&
    isUnspecifiedManufacturer(current.manufacturer) &&
    !isUnspecifiedManufacturer(lookupManufacturer)
  ) {
    data.manufacturer = lookupManufacturer;
  }
  // Product.price is an intentional replacement-price override. A known
  // Expense-derived price is the household's actual purchase history, so a
  // provider's advisory current offer must not displace it.
  if (current.pricing.effectivePrice == null && lookup?.priceDollars != null) {
    data.price = lookup.priceDollars;
  }

  const priceChanged = data.price !== undefined;
  if (Object.keys(data).length > 0) {
    await services.product.updateProduct(input.id, data, actor);
    await runMutationSideEffects(services.db, {
      action: "updated",
      entity: { entity: "product", id: input.id },
      source: "product.applyUpcData",
    });
  }

  // PDF manuals share the images relation — a manual-only product still has
  // no displayable image and should get the UPC-lookup photo.
  const hasDisplayableImage = current.images.some(isDisplayableImageFile);
  const warnings =
    !hasDisplayableImage && lookup?.imageUrl
      ? await importCoverPhoto(
          services.db,
          services.upcLookupClient,
          input.upc,
          input.id,
          "product.applyUpcData",
        )
      : [];

  const result = await services.product.getProductByID(input.id);
  const ingredientId = result.ingredient?.id;
  if (priceChanged && ingredientId) {
    await services.recipeCosting.recomputeForIngredient(
      await resolveIngredientEntityId(services.db, ingredientId),
      {
        source: "product.applyUpcData",
        entity: { entityType: "product", entityId: input.id },
      },
    );
  }
  return {
    ...result,
    sideEffects: mutationSideEffectsWithWarnings(warnings),
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
  sideEffects: MutationSideEffects;
}

const matched = (product: ProductTopLevelOut): FindOrCreateByUPCResult => ({
  product,
  created: false,
  sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
});

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

type UsdaFoodByUpc = Awaited<ReturnType<UsdaFoodLookupPort["findFood"]>>;
type UPCLookupHit = NonNullable<Awaited<ReturnType<UpcLookupPort["lookup"]>>>;

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
  usdaClient: UsdaFoodLookupPort,
  upcLookupClient: UpcLookupPort,
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
  usdaClient: UsdaFoodLookupPort,
  upcLookupClient: UpcLookupPort,
  upc: string,
  defaultName: string | undefined,
  actor: ActorContext,
): Promise<FindOrCreateByUPCResult> {
  const existing = await findProductByGtin(db, upc);
  if (existing) return matched(existing);

  const emitCreated = async (
    product: ProductTopLevelOut,
    warnings: readonly string[] = [],
  ): Promise<FindOrCreateByUPCResult> => {
    const entityId = await resolveCreatedOrInvariant(db, "product", product.id);
    await runMutationSideEffects(db, {
      action: "created",
      entity: { entity: "product", id: entityId },
      source: "product.findOrCreateByUPC",
    });
    return {
      product,
      created: true,
      sideEffects: mutationSideEffectsWithWarnings(warnings),
    };
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

        const warnings = upcLookup.imageUrl
          ? await importCoverPhoto(
              db,
              upcLookupClient,
              upc,
              await resolveCreatedOrInvariant(db, "product", newProduct.id),
              "findOrCreateByUPC",
            )
          : [];

        return await emitCreated(newProduct, warnings);
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
      return matched(winner);
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
  upcLookupClient: UpcLookupPort,
  canonicalGtin: string,
  actor: ActorContext,
): Promise<FindOrCreateByUPCResult> {
  const normalized = wasm.isbn_from_gtin(canonicalGtin);
  if (!normalized) {
    throw new Error(`Invalid canonical ISBN: ${canonicalGtin}`);
  }

  const existing = await findProductByGtin(db, canonicalGtin);
  if (existing) return matched(existing);

  const emitCreated = async (
    product: ProductTopLevelOut,
    warnings: readonly string[],
  ): Promise<FindOrCreateByUPCResult> => {
    const entityId = await resolveCreatedOrInvariant(db, "product", product.id);
    await runMutationSideEffects(db, {
      action: "created",
      entity: { entity: "product", id: entityId },
      source: "product.findOrCreateByCode",
    });
    return {
      product,
      created: true,
      sideEffects: mutationSideEffectsWithWarnings(warnings),
    };
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

      const warnings = external?.imageUrl
        ? await importCoverPhoto(
            db,
            upcLookupClient,
            normalized.isbn13,
            await resolveCreatedOrInvariant(db, "product", product.id),
            "findOrCreateByISBN",
          )
        : [];

      return await emitCreated(product, warnings);
    },
    async (error) => {
      const winner = await findProductByGtin(db, canonicalGtin);
      if (!winner) throw error;
      return matched(winner);
    },
  );
}

/**
 * A raw scanner value, classified with the web scanner's own rules so the
 * refusal copy is the same sentence on every surface. A Cubby label for a
 * non-product entity is refused here too: it names nothing stockable.
 */
const classifyProductScan = (raw: string): ResolvedProductCode => {
  const parsed = resolveProductScan(raw);
  if (!parsed.ok) throw createAppError("SCAN_CODE_UNRECOGNIZED", parsed.error);
  return parsed.value;
};

/**
 * A Cubby product label names a product that already exists — Cubby printed
 * it — so it resolves by lookup and never creates.
 */
const findProductByLabel = async (
  db: Database,
  shortcode: ProductShortcode,
): Promise<FindOrCreateByUPCResult> => {
  const product = await getProductByShortcode(db, shortcode);
  if (!product)
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      `No product found for ${shortcode}.`,
    );
  return matched(product);
};

// `async` so an unrecognized scan rejects instead of throwing synchronously.
export async function findOrCreateByCode(
  db: Database,
  usdaClient: UsdaFoodLookupPort,
  upcLookupClient: UpcLookupPort,
  input: ScanAtLocationCode,
  actor: ActorContext,
): Promise<FindOrCreateByUPCResult> {
  const code = input.kind === "scan" ? classifyProductScan(input.value) : input;
  switch (code.kind) {
    case "product":
      return findProductByLabel(db, code.value);
    case "isbn": {
      // `code.value` is now a raw, unvalidated string — the schema-level
      // `isbn` field became a plain trimmed string (check-digit validation +
      // GTIN-14 normalization moved here) because `packages/schemas` cannot
      // depend on the WASM boundary that validation needs.
      const normalizedIsbn = wasm.normalize_isbn(code.value);
      if (!normalizedIsbn) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "expected a valid ISBN-10 or ISBN-13",
        );
      }
      return findOrCreateByISBN(
        db,
        upcLookupClient,
        normalizedIsbn.gtin14,
        actor,
      );
    }
    case "barcode":
      return findOrCreateByUPC(
        db,
        usdaClient,
        upcLookupClient,
        code.value,
        undefined,
        actor,
      );
  }
}

export interface UpcImageBackfillCandidate {
  readonly productId: ProductId;
  readonly productName: string;
  readonly upc: string;
}

export interface UpcImageBackfillResult extends UpcImageBackfillCandidate {
  status: "imported" | "failed" | "skipped";
  readonly error?: string;
}

export interface UpcImageBackfillSummary {
  readonly found: number;
  readonly imported: number;
  readonly failed: number;
  readonly skipped: number;
  readonly details: readonly UpcImageBackfillResult[];
}

/**
 * Select products that can be looked up by the UPC image provider. The
 * workflow processes this immutable selection with bounded concurrency.
 */
export const selectUpcImageBackfill = async (
  db: Database,
): Promise<UpcImageBackfillCandidate[]> => {
  const allNoImages = await findProductsWithNoImages(db);
  // The provider is keyed by barcode, so a product without one has nothing to
  // look up. `displayGtin` because the provider indexes the printed encoding,
  // not the canonical GTIN-14 the identifier row stores.
  return allNoImages.flatMap((product) =>
    product.primaryGtin == null
      ? []
      : [
          {
            productId: product.id,
            productName: product.name,
            upc: displayGtin(product.primaryGtin),
          },
        ],
  );
};

/** A candidate owns an independent import transaction. Lookup failures are
 * returned as data so one dead image URL never stops the backfill. */
export const importUpcImageBackfillCandidate = async (
  db: Database,
  upcLookupClient: UpcLookupPort,
  candidate: UpcImageBackfillCandidate,
): Promise<UpcImageBackfillResult> => {
  try {
    const imported = await importImageFromUPC(
      db,
      upcLookupClient,
      candidate.upc,
      candidate.productId,
    );
    return imported
      ? { ...candidate, status: "imported" }
      : {
          ...candidate,
          status: "skipped",
          error: "No image found in UPC lookup",
        };
  } catch (error) {
    return { ...candidate, status: "failed", error: getErrorMessage(error) };
  }
};

export const summarizeUpcImageBackfill = (
  results: readonly UpcImageBackfillResult[],
): UpcImageBackfillSummary => {
  let imported = 0;
  let failed = 0;
  let skipped = 0;
  for (const result of results) {
    if (result.status === "imported") imported++;
    else if (result.status === "skipped") skipped++;
    else failed++;
  }
  return {
    found: results.length,
    imported,
    failed,
    skipped,
    details: [...results],
  };
};
