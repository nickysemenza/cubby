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
  productShortcode,
  unsafeExpenseShortcode,
  unsafeIngredientId,
  unsafeInventoryShortcode,
  unsafeProductId,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import {
  mergeProductsInput,
  patchProductExternalIdsInput,
  productApplyUpcInput,
  productBulkStockTrackedInput,
  productCategoryDistributionOut,
  productCreateManyInput,
  productDiscardInput,
  productDiscardOut,
  productExternalIdCollisionInput,
  productExternalIdCollisionsOut,
  productExternalIdSourceOptionsOut,
  productFiltersSchema,
  productFindOrCreateByCodeInput,
  productFindOrCreateByUPCInput,
  productFindOrCreateByUPCOut,
  productInventoryEntriesBatchInput,
  productInventoryEntriesByIdOut,
  productListItemOut,
  productLookupUpcOut,
  productManufacturerOptionsOut,
  productMarkUsdaUnavailableManyInput,
  productMergeSummaryOut,
  productMovementTimelineInput,
  productMovementTimelineOut,
  productPickerItemOut,
  productQuantitySummariesOut,
  productQuantitySummaryBatchInput,
  productQuickCreatePayload,
  productShortcodeListOut,
  productShortcodesInput,
  productSortableFields,
  productSummariesInput,
  productSummariesOut,
  productTagOptionsOut,
  productTagSiblingsOut,
  productTopLevelOut,
  productWithFoodAndSideEffectsOut,
  productWithFoodOut,
} from "@cubby/schemas/product";
import {
  type AttachProductComponentsInput,
  attachProductComponentsInput,
  detachProductComponentsInput,
  kitComponentRowsInput,
  kitComponentRowsOut,
  kitMembershipsInput,
  kitMembershipsOut,
  productComponentMutationOut,
  productComponentsInput,
  productComponentsOut,
} from "@cubby/schemas/product-components";
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
import { z } from "zod";
import { streamItems, streamProgress } from "~/lib/bulk-progress";
import { getErrorMessage } from "~/lib/error-utils";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";
import { executeEntity } from "~/server/entity-kernel";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import { findProductExternalIdCollisions } from "~/server/repo/data-quality";
import {
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
  patchProductExternalIds,
  productSearch,
  quickCreateProduct,
  setProductsStockTracked,
} from "~/server/repo/product";
import { loadProductInventoryEntries } from "~/server/repo/product/lookup";
import { loadProductQuantitySummaries } from "~/server/repo/product/quantity-ledger";
import {
  attachProductComponents,
  detachProductComponents,
  listKitComponentRows,
  listKitMembership,
  listProductComponents,
} from "~/server/repo/product-components";
import {
  listProductProjectUses,
  setProductProjectUses,
} from "~/server/repo/project";
import { listProductPurchases } from "~/server/repo/purchase-products";
import {
  bindShortcodeResolver,
  resolveLiveShortcode,
} from "~/server/repo/shortcode-resolver";
import { shouldUseSemanticComboboxFallback } from "~/server/semantic/combobox-fallback";
import { recomputeRecipesForPriceAffectedProducts } from "~/server/services/expense-pricing.service";
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
  findOrCreateByCode as findOrCreateByCodeService,
  findOrCreateByUPC as findOrCreateByUPCService,
  lookupUPC as lookupUPCService,
} from "~/server/services/product-orchestration.service";
import { semanticProductCandidates } from "~/server/services/semantic-search.service";
import {
  createBulkUpdatedMutation,
  createEntityListProcedure,
} from "../crud-factory";
import { createEntityListCompatibilityProcedure } from "../entity-compatibility";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const productShortcodes = bindShortcodeResolver("product");
const projectShortcodes = bindShortcodeResolver("project");
const inventoryShortcodes = bindShortcodeResolver("inventory");

const list = createEntityListCompatibilityProcedure(
  ENTITY_KERNEL_BINDINGS.product,
  {
    ...ENTITY_BINDINGS.product.crud,
    listOutput: productListItemOut,
  },
);

// Lightweight typeahead for product-picker comboboxes. Same filters/pagination
// shape as `list`, but the repo replaces the full relation graph and per-row
// USDA enrichment with small batched quantity and cover-photo reads tailored
// to picker rows.
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

/**
 * Bulk stock-tracking write, backing the products list's "Set stock tracking"
 * action — the burn-down lane for the "Not on a shelf" / "Consumed on projects"
 * views, where the answer for a whole selection is the same.
 *
 * `createBulkUpdatedMutation` rather than a loop over `update`: one homogeneous
 * `updated` event wave for the selection instead of N, and the repo write is
 * already a single statement (see `setProductsStockTracked` for why this skips
 * the recompute cascade `update` carries).
 */
const bulkSetStockTracked = createBulkUpdatedMutation({
  input: productBulkStockTrackedInput,
  itemOutput: productTopLevelOut,
  entity: "product",
  source: "product.bulkSetStockTracked",
  mutate: (ctx, input) =>
    setProductsStockTracked(ctx.db, input, ctx.actorContext),
  entityShortcodes: (items) => items.map((item) => item.id),
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
    const id = await productShortcodes.one(ctx.db, input.id);
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

// Recount needs the list's shelf-versus-ledger values, but only for the
// distinct products already in its bounded pass. This is intentionally a
// shortcode-keyed batch rather than a paginated `product.list` read.
const quantitySummaries = protectedProcedure
  .input(productQuantitySummaryBatchInput)
  .output(strictOutput(productQuantitySummariesOut))
  .query(async ({ ctx, input }) => {
    const ids = await productShortcodes.all(ctx.db, input.ids);
    const summariesById = await loadProductQuantitySummaries(ctx.db, ids);
    const summaries: Record<
      string,
      import("@cubby/schemas/product").ProductQuantitySummaryOut
    > = {};
    for (const [index, shortcode] of input.ids.entries()) {
      // `loadProductQuantitySummaries` returns one entry per resolved input id.
      summaries[shortcode] = summariesById.get(ids[index]!)!;
    }
    return summaries;
  });

/**
 * "Where does each of these live" for a bounded set of products.
 *
 * The companion read for a table whose rows only *reference* a product — a
 * task's subject product, say. Same shortcode-keyed batch shape as
 * `quantitySummaries`, and for the same reason: the alternative is threading
 * stock onto a row shape that other producers never load.
 */
const inventoryEntriesByIds = protectedProcedure
  .input(productInventoryEntriesBatchInput)
  .output(strictOutput(productInventoryEntriesByIdOut))
  .query(async ({ ctx, input }) => {
    if (input.ids.length === 0) return {};
    const ids = await productShortcodes.all(ctx.db, input.ids);
    const entriesById = await loadProductInventoryEntries(ctx.db, ids);
    const entries: Record<
      string,
      import("@cubby/schemas/product").ProductListInventoryEntryOut[]
    > = {};
    for (const [index, shortcode] of input.ids.entries()) {
      // A product with no live stock has no map entry, not an error.
      entries[shortcode] = entriesById.get(ids[index]!) ?? [];
    }
    return entries;
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
        isbn: input.isbn ?? null,
        expectedQuantity: input.expectedQuantity ?? null,
        model: input.model ?? null,
        price: input.price ?? null,
        category: input.category ?? null,
      },
      ctx.actorContext,
    );
    const entityId = await productShortcodes.one(ctx.db, product.id);
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

const findOrCreateByCode = protectedProcedure
  .input(productFindOrCreateByCodeInput)
  .output(strictOutput(productFindOrCreateByUPCOut))
  .mutation(({ ctx, input }) =>
    findOrCreateByCodeService(
      ctx.db,
      ctx.usdaClient,
      ctx.upcLookupClient,
      input,
      ctx.actorContext,
    ),
  );

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
    const id = await productShortcodes.one(ctx.db, input);
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
    const id = await productShortcodes.one(ctx.db, input.id);
    await patchProductExternalIds(ctx.db, id, input, ctx.actorContext);
    return await getProductWithFood(ctx.db, ctx.usdaClient, id);
  });

const verifyImages = protectedProcedure
  .input(productShortcode)
  .output(strictOutput(productWithFoodOut))
  .mutation(async ({ ctx, input }) => {
    const id = await productShortcodes.one(ctx.db, input);
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
        const id = await productShortcodes.one(ctx.db, shortcode);
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

const merge = protectedProcedure
  .input(mergeProductsInput)
  .output(
    strictOutput(
      z.object({
        product: productTopLevelOut,
        mergeSummary: productMergeSummaryOut,
      }),
    ),
  )
  .mutation(async ({ ctx, input }) => {
    const result = await executeEntity(ctx, {
      action: "merge",
      entity: "product",
      data: input,
    });
    if (result.action !== "merge")
      throw new Error("Entity kernel returned the wrong action");
    return {
      product: productTopLevelOut.parse(result.item),
      mergeSummary: productMergeSummaryOut.parse(result.mergeSummary),
    };
  });

const projectUses = protectedProcedure
  .input(productProjectUsesInput)
  .output(strictOutput(productProjectUsesOut))
  .query(async ({ ctx, input }) => {
    const id = await productShortcodes.one(ctx.db, input.productId);
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
    const id = await productShortcodes.one(ctx.db, input.productId);
    return listProductPurchases(ctx.db, id);
  });

/** A kit's own component list — what it's made of. See `ProductComponent` in
 * `packages/schemas/src/product-components.ts` for what the edge means. */
const components = protectedProcedure
  .input(productComponentsInput)
  .output(strictOutput(productComponentsOut))
  .query(async ({ ctx, input }) => {
    const id = await productShortcodes.one(ctx.db, input.parentProductId);
    return listProductComponents(ctx.db, id);
  });

/**
 * The same components, but shaped as full product LIST rows, for tables that
 * nest them under their kit as ordinary rows. Batched over kits because the
 * Products list asks once for every kit on the page rather than once per
 * expanded row — see `listKitComponentRows` for why that ordering matters.
 */
const kitComponentRows = protectedProcedure
  .input(kitComponentRowsInput)
  .output(strictOutput(kitComponentRowsOut))
  .query(async ({ ctx, input }) => {
    const ids = await productShortcodes.all(ctx.db, input.parentProductIds);
    return listKitComponentRows(ctx.db, ids);
  });

/** The transpose of `components`: every kit this Product is listed inside. */
const kitMembership = protectedProcedure
  .input(kitMembershipsInput)
  .output(strictOutput(kitMembershipsOut))
  .query(async ({ ctx, input }) => {
    const id = await productShortcodes.one(ctx.db, input.productId);
    return listKitMembership(ctx.db, id);
  });

/**
 * Resolve both the kit's shortcode and every component entry's shortcode in
 * one batched pass, keeping each entry's quantity paired with its resolved id.
 * `productShortcodes.all` returns one id per input code, in the same order, so
 * zipping by index is sound, not a guess.
 */
async function resolveComponentEntries(
  db: Parameters<typeof productShortcodes.one>[0],
  input: AttachProductComponentsInput,
) {
  const [parentProductId, componentIds] = await Promise.all([
    productShortcodes.one(db, input.parentProductId),
    productShortcodes.all(
      db,
      input.components.map((component) => component.productId),
    ),
  ]);
  return {
    parentProductId,
    components: input.components.map((component, i) => ({
      productId: componentIds[i]!,
      quantity: component.quantity,
    })),
  };
}

const attachComponents = protectedProcedure
  .input(attachProductComponentsInput)
  .output(strictOutput(productComponentMutationOut))
  .mutation(async ({ ctx, input }) => {
    const { parentProductId, components } = await resolveComponentEntries(
      ctx.db,
      input,
    );
    return attachProductComponents(
      ctx.db,
      parentProductId,
      components,
      ctx.actorContext,
    );
  });

const detachComponents = protectedProcedure
  .input(detachProductComponentsInput)
  .output(strictOutput(productComponentMutationOut))
  .mutation(async ({ ctx, input }) => {
    const [parentProductId, componentProductIds] = await Promise.all([
      productShortcodes.one(ctx.db, input.parentProductId),
      productShortcodes.all(ctx.db, input.componentProductIds),
    ]);
    return detachProductComponents(
      ctx.db,
      parentProductId,
      componentProductIds,
      ctx.actorContext,
    );
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
    const id = await productShortcodes.one(ctx.db, input.productId);
    const projectIds = await projectShortcodes.all(ctx.db, input.projectIds);
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
    const productId = await productShortcodes.one(ctx.db, input.productId);
    const inventoryEntryId =
      input.adjustInventory && input.inventoryEntryId
        ? await inventoryShortcodes.one(ctx.db, input.inventoryEntryId)
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
  getByShortcodes,
  list,
  summaries,
  inventoryEntriesByIds,
  quantitySummaries,
  search,
  createMany,
  markUsdaUnavailableMany,
  applyUpcData,
  discard,
  quickCreate,
  findOrCreateByCode,
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
  components,
  kitComponentRows,
  kitMembership,
  attachComponents,
  detachComponents,
  merge,
  setProjectUses,
  bulkSetStockTracked,
});
