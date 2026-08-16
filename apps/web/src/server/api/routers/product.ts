/**
 * Product Router - Uses service layer
 *
 * Products integrate with the USDA external API for nutrition data enrichment,
 * so CRUD operations go through the product service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import {
  type IngredientId,
  type ProductId,
  type ProductShortcode,
  productShortcode,
  unsafeExpenseShortcode,
  unsafeIngredientId,
  unsafeInventoryShortcode,
  unsafeProductId,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import {
  mergeProductsInput,
  mergeProductsOut,
  patchProductExternalIdsInput,
  productApplyUpcInput,
  productCategoryDistributionOut,
  productCreateInput,
  productCreateManyInput,
  productDiscardInput,
  productDiscardOut,
  productExternalIdCollisionInput,
  productExternalIdCollisionsOut,
  productExternalIdSourceOptionsOut,
  productFiltersSchema,
  productFindOrCreateByUPCInput,
  productFindOrCreateByUPCOut,
  productListItemOut,
  productLookupUpcOut,
  productManufacturerOptionsOut,
  productMarkUsdaUnavailableManyInput,
  productMovementTimelineInput,
  productMovementTimelineOut,
  productPickerItemOut,
  productQuickCreatePayload,
  productShortcodeListOut,
  productShortcodesInput,
  productSortableFields,
  productSummariesInput,
  productSummariesOut,
  productTagOptionsOut,
  productTagSiblingsOut,
  productTopLevelOut,
  productUpdateInput,
  productWithFoodAndSideEffectsOut,
  productWithFoodOut,
} from "@cubby/schemas/product";
import {
  productProjectUsesInput,
  productProjectUsesOut,
  productProjectUsesSetInput,
  productProjectUsesSetOut,
} from "@cubby/schemas/project";
import {
  productPurchasesInput,
  productPurchasesOut,
} from "@cubby/schemas/purchase";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { streamItems, streamProgress } from "~/lib/bulk-progress";
import { getErrorMessage } from "~/lib/error-utils";
import { findProductExternalIdCollisions } from "~/server/repo/data-quality";
import {
  deleteProducts,
  discardProductUnits,
  getCategoryDistribution,
  getProductExternalIdSourceOptions,
  getProductManufacturerOptions,
  getProductMovementTimeline,
  getProductPickerItemsByIds,
  getProductsByShortcodes,
  getProductsSharingTags,
  getProductTagOptions,
  getTagSiblingStorage,
  mergeProducts,
  patchProductExternalIds,
  productList as productListRepo,
  productSearch,
  quickCreateProduct,
} from "~/server/repo/product";
import {
  listProductProjectUses,
  setProductProjectUses,
} from "~/server/repo/project";
import { listProductPurchases } from "~/server/repo/purchase-products";
import {
  resolveAllOrThrow,
  resolveLiveShortcode,
  resolveLiveShortcodes,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { shouldUseSemanticComboboxFallback } from "~/server/semantic/combobox-fallback";
import { recomputeRecipesForPriceAffectedProducts } from "~/server/services/expense-pricing.service";
import { deleteStoredObjects } from "~/server/services/image-storage.service";
import { verifyProductImages } from "~/server/services/image-verification.service";
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import {
  createProductWithFood,
  createProductWriteActions,
  getProductSummaries,
  getProductWithFood,
  updateProductWithFood,
} from "~/server/services/product.service";
import {
  applyUpcDataWithSideEffects,
  backfillUPCImages as backfillUPCImagesService,
  createProductWithSideEffects,
  findOrCreateByUPC as findOrCreateByUPCService,
  lookupUPC as lookupUPCService,
  updateProductWithSideEffects,
} from "~/server/services/product-orchestration.service";
import { semanticProductCandidates } from "~/server/services/semantic-search.service";
import {
  createDeleteProcedure,
  createEntityDetailReadProcedures,
  createEntityListProcedure,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

async function resolveProductId(
  db: Parameters<typeof resolveOrThrow>[0],
  shortcode: ProductShortcode,
): Promise<ProductId> {
  return resolveOrThrow(db, "product", shortcode);
}

async function resolveProductIds(
  db: Parameters<typeof resolveAllOrThrow>[0],
  shortcodes: ProductShortcode[],
): Promise<ProductId[]> {
  return resolveAllOrThrow(db, "product", shortcodes);
}

// Product lists are lean DB rows. Detail/create/update are enriched with USDA
// food and recipe usages, so the list contract is split from the detail one.
const { list } = createEntityListProcedure({
  schemas: {
    output: productListItemOut,
    filters: productFiltersSchema,
    sort: {
      sortableFields: productSortableFields,
      defaultSort: "createdAt",
      // Pinned, not derived from sortableFields: `buildOrderBy`'s groupBy
      // branch looks the field up as a real column, so a sort-only key like a
      // joined name would be accepted and then silently emit no grouping.
      groupableFields: ["category"] as const,
    },
  },
  repository: {
    list: async (services, filters, sort, pagination, groupBy) => {
      return await productListRepo(
        services.db,
        filters,
        sort,
        pagination,
        groupBy,
      );
    },
  },
  entityName: "product",
});

/**
 * Every product this router ships changes a costing input — `price`,
 * `ingredientId`, and the `productUnitMappings` costing reads conversions from —
 * so each write path has to recompute the recipes that depend on the product's
 * linked ingredient. This resolves that link for a set of products.
 *
 * Read this BEFORE the mutation runs. `deleteProducts` and `mergeProducts` both
 * soft-delete rows (the deleted products; the merged-away losers), and every
 * repo reader filters `notDeleted`, so afterwards the link is unreadable. For a
 * merge the pre-merge set is also a superset of the post-merge one: the keeper
 * can only ADOPT an `ingredientId` from a loser (CARRIED_COLUMNS, and only when
 * its own is null), never gain an id no input product had.
 */
async function linkedIngredientIds(
  db: Parameters<typeof getProductsByShortcodes>[0],
  shortcodes: ProductShortcode[],
): Promise<IngredientId[]> {
  // `getProductsByShortcodes` is the one batch reader that carries the
  // ingredient relation. Product delete/merge are rare interactive operations,
  // so its extra joins are not worth a second reader.
  const products = await getProductsByShortcodes(db, shortcodes);
  const resolved = await resolveLiveShortcodes(
    db,
    products.flatMap((row) => (row.ingredient ? [row.ingredient.id] : [])),
    "ingredient",
  );
  // Map values are unique per ingredient, so this is already deduped — several
  // products commonly share one ingredient.
  return [...resolved.values()].map((id) => unsafeIngredientId(id));
}

const { getByID, getByShortcode } = createEntityDetailReadProcedures({
  entityName: "product",
  schemas: {
    output: productWithFoodOut,
    idSchema: productShortcode,
  },
  repository: {
    getByID: async (services, shortcode: ProductShortcode) => {
      const id = await resolveProductId(services.db, shortcode);
      return await getProductWithFood(services.db, services.usdaClient, id);
    },
    // Resolves the shortcode itself rather than reusing a plain repo-level
    // reader: `getByID` above returns the USDA-enriched shape
    // (`productWithFoodOut`), and the factory requires both procedures to
    // share one output schema, so this has to go through the same
    // enrichment `getByID` does.
    getByShortcode: async (services, shortcode) => {
      const id = await resolveLiveShortcode(services.db, shortcode, "product");
      return id
        ? await getProductWithFood(
            services.db,
            services.usdaClient,
            unsafeProductId(id),
          )
        : null;
    },
  },
});

// Lightweight typeahead for product-picker comboboxes. Same filters/pagination
// shape as `list`, but the repo skips relation joins AND the per-row USDA food
// enrichment `list` does — pickers only need {id, name, manufacturer}, so the
// cross-Worker USDA batch (list's long pole) has no business on this path.
const { list: search } = createEntityListProcedure({
  schemas: {
    output: productPickerItemOut,
    filters: productFiltersSchema,
    sort: { sortableFields: productSortableFields, defaultSort: "name" },
  },
  repository: {
    list: async (services, filters, sort, pagination) => {
      // Explicit pick, not a spread: `productSearch` ignores the presence
      // filters by design, and its narrowed param type makes that a compile
      // error rather than a silent drop.
      const lexical = await productSearch(
        services.db,
        {
          nameFilter: filters.nameFilter,
          manufacturerFilter: filters.manufacturerFilter,
          upcFilter: filters.upcFilter,
          categoryFilter: filters.categoryFilter,
        },
        sort,
        pagination,
      );

      const nameQuery = filters.nameFilter?.trim() ?? "";
      const shouldUseSemantic = shouldUseSemanticComboboxFallback({
        lexicalCount: lexical.data.length,
        query: nameQuery,
        hasStructuredFilters: Boolean(
          filters.manufacturerFilter ||
            filters.upcFilter ||
            filters.categoryFilter,
        ),
      });
      if (!shouldUseSemantic) return lexical;

      const semantic = await semanticProductCandidates(
        services.db,
        nameQuery,
        5,
      );
      const semanticIds = semantic
        .filter((candidate) => candidate.similarity >= 0.75)
        .map((candidate) => unsafeProductId(candidate.item.entityId));
      const semanticItems = (
        await getProductPickerItemsByIds(services.db, semanticIds)
      ).filter(
        (item) =>
          !lexical.data.some((lexicalItem) => lexicalItem.id === item.id),
      );

      return {
        data: [...lexical.data, ...semanticItems].slice(0, pagination.pageSize),
        count: Math.max(
          lexical.count,
          lexical.data.length + semanticItems.length,
        ),
      };
    },
  },
  entityName: "product",
});

// Custom create procedure: imports UPC images + eagerly recomputes the new
// product's recipes (linking a product makes its ingredient costable). The bulk
// `createMany` path stays deferred (mark-stale → drain) so it doesn't recompute
// shared recipes once per product.
const create = protectedProcedure
  .input(productCreateInput)
  .output(strictOutput(productWithFoodAndSideEffectsOut))
  .mutation(async ({ ctx, input }) => {
    return await createProductWithSideEffects(
      {
        db: ctx.db,
        product: createProductWriteActions(ctx.db, ctx.usdaClient),
        recipeCosting: ctx.services.recipeCosting,
        locationValuation: ctx.services.locationValuation,
        upcLookupClient: ctx.upcLookupClient,
      },
      input,
      ctx.actorContext,
    );
  });

// Custom update: a product's price/USDA link feeds recipe cost via its linked
// ingredient, so recompute every dependent recipe eagerly (covers UI + MCP) and
// report the count. Inventory-valuation recompute is added here too (stage D).
const update = protectedProcedure
  .input(productUpdateInput)
  .output(strictOutput(productWithFoodAndSideEffectsOut))
  .mutation(async ({ ctx, input }) => {
    const id = await resolveProductId(ctx.db, input.id);
    return await updateProductWithSideEffects(
      {
        db: ctx.db,
        product: createProductWriteActions(ctx.db, ctx.usdaClient),
        recipeCosting: ctx.services.recipeCosting,
        locationValuation: ctx.services.locationValuation,
      },
      id,
      input.data,
      ctx.actorContext,
    );
  });

// One-click "Apply" for the Problems page "Better UPC data available" panel:
// pull the (cached) UPC lookup and fill ONLY the fields still empty — never
// clobber a value the user already set. Manufacturer/price go through
// updateProduct (which resyncs inventory valuations and lets us recompute
// dependent recipes, since price feeds cost); the image is imported separately.
// Mirrors the field mapping in findOrCreateByUPC and the recompute in `update`.
const applyUpcData = protectedProcedure
  .input(productApplyUpcInput)
  .output(strictOutput(productWithFoodAndSideEffectsOut))
  .mutation(async ({ ctx, input }) => {
    const id = await resolveProductId(ctx.db, input.id);
    return await applyUpcDataWithSideEffects(
      {
        db: ctx.db,
        product: createProductWriteActions(ctx.db, ctx.usdaClient),
        recipeCosting: ctx.services.recipeCosting,
        locationValuation: ctx.services.locationValuation,
        upcLookupClient: ctx.upcLookupClient,
      },
      { ...input, id },
      ctx.actorContext,
    );
  });

const summaries = protectedProcedure
  .input(productSummariesInput)
  .output(strictOutput(productSummariesOut))
  .query(async ({ ctx, input }) => {
    return await getProductSummaries(
      ctx.db,
      ctx.usdaClient,
      input.ids,
      input.include,
    );
  });

// Quick create a product with minimal data (just name required)
const quickCreate = protectedProcedure
  .input(productQuickCreatePayload)
  .output(strictOutput(productTopLevelOut))
  .mutation(async ({ ctx, input }) => {
    const product = await quickCreateProduct(
      ctx.db,
      {
        name: input.name,
        manufacturer: input.manufacturer ?? UNSPECIFIED_MANUFACTURER,
        upc: input.upc ?? null,
        expectedQuantity: input.expectedQuantity ?? null,
        model: input.model ?? null,
        price: input.price ?? null,
        category: input.category ?? null,
      },
      ctx.actorContext,
    );
    const entityId = await resolveProductId(ctx.db, product.id);
    await runMutationSideEffects(ctx.db, {
      action: "created",
      entity: { entityType: "product", entityId },
      source: "product.quickCreate",
    });
    return product;
  });

// The read-only half of the UPC cascade: what does this barcode name, according
// to the local ledger, USDA, and the UPC service. `upc.lookup` already exposed
// the third of those alone; this is the whole picture, and it creates nothing.
const lookupUpc = protectedProcedure
  .input(productFindOrCreateByUPCInput.pick({ upc: true }))
  .output(strictOutput(productLookupUpcOut))
  .query(({ ctx, input }) =>
    lookupUPCService(ctx.db, ctx.usdaClient, ctx.upcLookupClient, input.upc),
  );

const findOrCreateByUPC = protectedProcedure
  .input(productFindOrCreateByUPCInput)
  .output(strictOutput(productFindOrCreateByUPCOut))
  .mutation(async ({ ctx, input }) => {
    return findOrCreateByUPCService(
      ctx.db,
      ctx.usdaClient,
      ctx.upcLookupClient,
      input.upc,
      input.defaultName,
      ctx.actorContext,
    );
  });

// Backfill UPC images for products that have a UPC but no images — streamed
// (per batch of 10) with a final scalar summary. The per-product `details` array
// the service collects isn't surfaced to the UI, so the streamed result omits it.
const backfillUPCImages = protectedProcedure.mutation(async function* ({
  ctx,
}) {
  yield* streamProgress(
    backfillUPCImagesService(ctx.db, ctx.upcLookupClient),
    ({ found, imported, failed, skipped }) => ({
      found,
      imported,
      failed,
      skipped,
    }),
  );
});

const categoryDistribution = protectedProcedure
  .output(strictOutput(productCategoryDistributionOut))
  .query(async ({ ctx }) => {
    return await getCategoryDistribution(ctx.db);
  });

/**
 * Tag roster for the product list's Tags filter picklist — one grouped query
 * (see `getProductTagOptions`), same "cheap options query" shape as
 * `expense.vendorOptions`.
 */
const tagOptions = protectedProcedure
  .output(strictOutput(productTagOptionsOut))
  .query(async ({ ctx }) => {
    return await getProductTagOptions(ctx.db);
  });

const manufacturerOptions = protectedProcedure
  .output(strictOutput(productManufacturerOptionsOut))
  .query(({ ctx }) => getProductManufacturerOptions(ctx.db));

const movementTimeline = protectedProcedure
  .input(productMovementTimelineInput)
  .output(strictOutput(productMovementTimelineOut))
  .query(({ ctx, input }) => getProductMovementTimeline(ctx.db, input));

/** Source roster for the product list's External IDs filter picklist. */
const externalIdSourceOptions = protectedProcedure
  .output(strictOutput(productExternalIdSourceOptionsOut))
  .query(({ ctx }) => getProductExternalIdSourceOptions(ctx.db));

/**
 * "Fits with this" — every other product sharing a tag, and where each tag's
 * family is stocked. Separate from `getByID` so the detail page's main payload
 * doesn't grow a join that only one section reads, and so it re-fetches on its
 * own when tags change.
 *
 * Both halves in one procedure because they're one panel: the roster and its
 * storage rollup are grouped by the same tags and would otherwise cost two
 * round trips to render a single sidebar section.
 */
const tagSiblings = protectedProcedure
  .input(productShortcode)
  .output(strictOutput(productTagSiblingsOut))
  .query(async ({ ctx, input }) => {
    const id = await resolveProductId(ctx.db, input);
    const [siblings, tagStorage] = await Promise.all([
      getProductsSharingTags(ctx.db, id),
      getTagSiblingStorage(ctx.db, id),
    ]);

    return {
      siblings: siblings.map(
        ({ shortcode, name, manufacturer, category, tags }) => ({
          id: unsafeProductShortcode(shortcode),
          name,
          manufacturer,
          category,
          tags,
        }),
      ),
      tagStorage,
    };
  });

const externalIdCollisions = protectedProcedure
  .input(productExternalIdCollisionInput)
  .output(strictOutput(productExternalIdCollisionsOut))
  .query(async ({ ctx, input }) =>
    productExternalIdCollisionsOut.parse(
      await findProductExternalIdCollisions(ctx.db, input),
    ),
  );

const patchExternalIds = protectedProcedure
  .input(patchProductExternalIdsInput)
  .output(strictOutput(productWithFoodOut))
  .mutation(async ({ ctx, input }) => {
    const id = await resolveProductId(ctx.db, input.id);
    await patchProductExternalIds(ctx.db, id, input, ctx.actorContext);
    return await getProductWithFood(ctx.db, ctx.usdaClient, id);
  });

const verifyImages = protectedProcedure
  .input(productShortcode)
  .output(strictOutput(productWithFoodOut))
  .mutation(async ({ ctx, input }) => {
    const id = await resolveProductId(ctx.db, input);
    await verifyProductImages(ctx.db, id);
    return await getProductWithFood(ctx.db, ctx.usdaClient, id);
  });

// Batch lookup: multiple products by shortcode (e.g. for label printing)
const getByShortcodes = protectedProcedure
  .input(productShortcodesInput)
  .output(strictOutput(productShortcodeListOut))
  .query(async ({ ctx, input }) => {
    return await getProductsByShortcodes(ctx.db, input.shortcodes);
  });

// Batch-create products for the enrichment workbench's "Create products" action,
// streamed with per-row progress. Sequential single-row creates (each its own tx)
// so one bad row doesn't abort the rest; failures are reported per index for the
// client to surface/retry, then ONE deduped recompute over the affected recipes.
type CreateManyResult = {
  created: number;
  sideEffects: { backgroundBatches: BackgroundBatchRef[] };
  failed: { index: number; name: string; error: string }[];
};
const createMany = protectedProcedure
  .input(productCreateManyInput)
  .mutation(async function* ({ ctx, input }) {
    const failed: { index: number; name: string; error: string }[] = [];
    const ingredientIds: IngredientId[] = [];
    yield* streamItems<(typeof input)[number], never, CreateManyResult>(
      input,
      async (item) => {
        const { output: product, entityId } = await createProductWithFood(
          ctx.db,
          ctx.usdaClient,
          item,
          ctx.actorContext,
        );
        await runMutationSideEffects(ctx.db, {
          action: "created",
          entity: { entityType: "product", entityId },
          source: "product.createMany",
        });
        if (product.ingredient?.id) {
          const ingredientId = await resolveLiveShortcode(
            ctx.db,
            product.ingredient.id,
            "ingredient",
          );
          if (ingredientId)
            ingredientIds.push(unsafeIngredientId(ingredientId));
        }
      },
      {
        onError: (item, index, error) => {
          failed.push({
            index,
            name: item.name,
            error: getErrorMessage(error),
          });
        },
        // One deduped recompute over every affected recipe (not per-product),
        // since the bulk create links many products whose recipes overlap.
        finalize: async (summary) => ({
          created: summary.succeeded,
          sideEffects: {
            backgroundBatches:
              await ctx.services.recipeCosting.recomputeForIngredients(
                ingredientIds,
                { source: "product.createMany" },
              ),
          },
          failed,
        }),
      },
    );
  });

// Batch "no USDA food exists" flag for the workbench's "Mark no-USDA" action, so
// those products drop out of the link-USDA worklist and switch to manual entry.
// Streamed with per-id progress; each update is its own tx.
const markUsdaUnavailableMany = protectedProcedure
  .input(productMarkUsdaUnavailableManyInput)
  .mutation(async function* ({ ctx, input }) {
    yield* streamItems<(typeof input.ids)[number], never, { updated: number }>(
      input.ids,
      async (shortcode) => {
        const id = await resolveProductId(ctx.db, shortcode);
        await updateProductWithFood(
          ctx.db,
          ctx.usdaClient,
          id,
          { usdaUnavailable: true },
          ctx.actorContext,
        );
        await runMutationSideEffects(ctx.db, {
          action: "updated",
          entity: { entityType: "product", entityId: id },
          source: "product.markUsdaUnavailableMany",
        });
      },
      { finalize: (summary) => ({ updated: summary.succeeded }) },
    );
  });

/**
 * Deleting a product changes recipe cost: `deleteProducts` soft-deletes the
 * product's `productUnitMappings` (the conversion source costing reads) and
 * removes its price from the linked ingredient. `runMutationSideEffectsForEntities`
 * does NOT cover this — `needsValuationRecompute` is true only for
 * product + `updated`, and only for the location valuation rollup. Nothing else
 * recomputes recipe totals on a schedule, so without this dispatch a stale
 * `Recipe.totals` persists until someone runs the maintenance card by hand.
 */
const deleteItem = createDeleteProcedure<ProductShortcode>(
  async (services, shortcodes) => {
    // Before the delete: the products (and their ingredient links) are
    // unreadable once soft-deleted.
    const ingredientIds = await linkedIngredientIds(services.db, shortcodes);
    const ids = await resolveProductIds(services.db, shortcodes);
    const { detachedImageKeys } = await deleteProducts(
      services.db,
      ids,
      services.actorContext,
    );
    // After the commit, never inside it: an R2 delete has no rollback.
    await deleteStoredObjects(detachedImageKeys);
    const backgroundBatches = await runMutationSideEffectsForEntities(
      services.db,
      ids.map((id) => ({
        action: "deleted" as const,
        entity: { entityType: "product" as const, entityId: id },
        source: "product.delete",
      })),
    );
    // One deduped recompute over every affected recipe, the same shape
    // `createMany` uses — not one dispatch per deleted product.
    const recipeBatches =
      await services.services.recipeCosting.recomputeForIngredients(
        ingredientIds,
        { source: "product.delete" },
      );
    return [...(backgroundBatches ?? []), ...recipeBatches];
  },
  productShortcode,
);

/**
 * Fold duplicate products into one. See `mergeProducts` (repo/product/merge.ts)
 * for the two structural collisions — the per-product `(source, kind)`
 * identifier slot and the `(productId, locationId)` stock slot — and why an
 * identifier conflict discards the loser's value while stock in a shared
 * location is summed rather than dropped.
 *
 * Side effects run for the survivor AND every merged-away product: the survivor
 * absorbed names, aliases, and identifiers (so its embedding is stale), and the
 * losers are gone (so theirs must be cleaned up beyond the in-transaction
 * cascade `finalizeMerge` already did).
 *
 * Recipe totals need their own dispatch on top of that, for the same reason
 * `mergeProducts` ends with `syncInventoryValuationsForProduct`: the merge moves
 * costing inputs (`price` and `ingredientId` are in `CARRIED_COLUMNS`, and
 * `ProductUnitMappings.productId` is re-pointed), and nothing recomputes
 * `Recipe.totals` on a schedule, so a stale cost would persist indefinitely.
 */
const merge = protectedProcedure
  .input(mergeProductsInput)
  .output(strictOutput(mergeProductsOut))
  .mutation(async ({ ctx, input }) => {
    // Before the merge: the losers are soft-deleted by the time it returns, and
    // the keeper's post-merge ingredient can only be one it already had or one
    // adopted from a loser — so the pre-merge set covers every affected link.
    const ingredientIds = await linkedIngredientIds(ctx.db, [
      input.keepId,
      ...input.mergeIds,
    ]);
    // Destructured, not stripped later: the internal uuids are the repo's
    // channel to this dispatch and must never reach the wire (the merged-away
    // rows are already soft-deleted, so their codes can't be re-resolved here).
    const { keepEntityId, deletedEntityIds, ...mergeSummary } =
      await mergeProducts(ctx.db, input, ctx.actorContext);
    await runMutationSideEffectsForEntities(ctx.db, [
      {
        action: "updated" as const,
        entity: { entityType: "product" as const, entityId: keepEntityId },
        source: "product.merge",
      },
      ...deletedEntityIds.map((entityId) => ({
        action: "deleted" as const,
        entity: { entityType: "product" as const, entityId },
        source: "product.merge",
      })),
    ]);
    // `mergeProductsOut` carries no side-effects field, so the batches aren't
    // surfaced — the dispatch itself is what keeps the totals honest.
    await ctx.services.recipeCosting.recomputeForIngredients(ingredientIds, {
      source: "product.merge",
      entity: { entityType: "product", entityId: keepEntityId },
    });
    return {
      product: await getProductWithFood(ctx.db, ctx.usdaClient, keepEntityId),
      mergeSummary,
    };
  });

const projectUses = protectedProcedure
  .input(productProjectUsesInput)
  .output(strictOutput(productProjectUsesOut))
  .query(async ({ ctx, input }) => {
    const id = await resolveProductId(ctx.db, input.productId);
    return listProductProjectUses(ctx.db, id);
  });

/**
 * The Purchases one Product is linked to (the transpose of
 * `purchase.products`). No money and no quantity — see
 * `packages/schemas/src/purchase.ts` for why the link exists.
 */
const purchases = protectedProcedure
  .input(productPurchasesInput)
  .output(strictOutput(productPurchasesOut))
  .query(async ({ ctx, input }) => {
    const id = await resolveProductId(ctx.db, input.productId);
    return listProductPurchases(ctx.db, id);
  });

/**
 * Replace the set of projects this tool was used on, from the tool's own page.
 * Returns only the count that moved — see `productProjectUsesSetOut` for why
 * handing back the refreshed panel would be dead payload.
 */
const setProjectUses = protectedProcedure
  .input(productProjectUsesSetInput)
  .output(strictOutput(productProjectUsesSetOut))
  .mutation(async ({ ctx, input }) => {
    const id = await resolveProductId(ctx.db, input.productId);
    const projectIds = await resolveAllOrThrow(
      ctx.db,
      "project",
      input.projectIds,
    );
    return setProductProjectUses(ctx.db, id, projectIds, ctx.actorContext);
  });

/**
 * Record that units were thrown away / written off, and optionally take them
 * off the shelf in the same transaction. See repo/product/discard.ts for why a
 * discard carries no Purchase and why the inventory half does not breach the
 * no-auto-decrement tenet.
 */
const discard = protectedProcedure
  .input(productDiscardInput)
  .output(strictOutput(productDiscardOut))
  .mutation(async ({ ctx, input }) => {
    const productId = await resolveProductId(ctx.db, input.productId);
    const inventoryEntryId =
      input.adjustInventory && input.inventoryEntryId
        ? await resolveOrThrow(ctx.db, "inventory", input.inventoryEntryId)
        : null;

    const result = await discardProductUnits(
      ctx.db,
      {
        productId,
        quantity: input.quantity,
        date: input.date,
        reason: input.reason,
        inventoryEntryId,
      },
      ctx.actorContext,
    );

    // The inventory event is load-bearing, not symmetry: `needsValuationRecompute`
    // returns true unconditionally for `inventory`, so this is what dispatches
    // the location-valuation recompute the changed shelf requires.
    const backgroundBatches = await runMutationSideEffectsForEntities(ctx.db, [
      {
        action: "created" as const,
        entity: {
          entityType: "expense" as const,
          entityId: result.expenseId,
        },
        source: "product.discard",
      },
      ...(result.inventory
        ? [
            {
              action: result.inventory.removed
                ? ("deleted" as const)
                : ("updated" as const),
              entity: {
                entityType: "inventory" as const,
                entityId: result.inventory.entryId,
              },
              source: "product.discard",
            },
          ]
        : []),
    ]);
    const recipeBatches = await recomputeRecipesForPriceAffectedProducts(
      ctx.db,
      ctx.services.recipeCosting,
      result.priceAffectedProductIds,
      "product.discard",
    );

    return {
      expenseId: unsafeExpenseShortcode(result.expenseShortcode),
      storedQuantity: result.storedQuantity,
      inventory: result.inventory
        ? {
            entryId: unsafeInventoryShortcode(result.inventory.entryShortcode),
            removed: result.inventory.removed,
            remainingValue: result.inventory.remainingValue,
          }
        : null,
      sideEffects: {
        backgroundBatches: [...backgroundBatches, ...recipeBatches],
      },
    };
  });

export const productRouter = createTRPCRouter({
  getByID,
  getByShortcode,
  getByShortcodes,
  list,
  summaries,
  search,
  create,
  createMany,
  markUsdaUnavailableMany,
  update,
  applyUpcData,
  delete: deleteItem,
  discard,
  quickCreate,
  findOrCreateByUPC,
  lookupUpc,
  backfillUPCImages,
  categoryDistribution,
  tagOptions,
  manufacturerOptions,
  movementTimeline,
  externalIdSourceOptions,
  tagSiblings,
  externalIdCollisions,
  patchExternalIds,
  verifyImages,
  projectUses,
  purchases,
  merge,
  setProjectUses,
});
