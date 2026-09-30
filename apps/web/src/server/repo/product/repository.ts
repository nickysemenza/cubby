import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  mergeProductsInput,
  productMergeSummaryOut,
  productTopLevelOut,
} from "@cubby/schemas/product";
import { z } from "zod";

import type { Database } from "~/server/db";
import { entityMutationReferences } from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import { defineRepository } from "~/server/repo/repository";
import {
  bindShortcodeResolver,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";
import {
  mutationEvents,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import {
  createProductWithSideEffects,
  updateProductWithSideEffects,
} from "~/server/services/product-orchestration.service";
import { createProductWriteActions } from "~/server/services/product.service";

import {
  deleteProducts,
  getProductByShortcode,
  getProductsByShortcodes,
  productList,
  listProductsRead,
  productListSummary,
  setProductsStockTracked,
} from "./crud";
import { readProductDetail } from "./detail";
import { PRODUCT_DELETE_EDGE_POLICY } from "./edge-roles";
import { mergeProducts, PRODUCT_MERGE_EDGE_POLICY } from "./merge";

const productShortcodes = bindShortcodeResolver("product");

async function linkedProductIngredientIds(db: Database, shortcodes: string[]) {
  const products = await getProductsByShortcodes(db, shortcodes);
  const resolved = await resolveLiveShortcodes(
    db,
    products.flatMap((row) => (row.ingredient ? [row.ingredient.id] : [])),
    "ingredient",
  );
  return [...resolved.values()].map((id) => parseEntityId("ingredient", id));
}

/**
 * `sideEffects: false`: a product write runs its own orchestration (UPC
 * image import, recipe re-costing) rather than the generic fan-out, and its
 * create reaches the UPC provider, so the kernel does not hold a transaction
 * across it.
 */
export const productRepository = defineRepository("product", {
  sideEffects: false,
  lifecycle: {
    delete: PRODUCT_DELETE_EDGE_POLICY,
    merge: PRODUCT_MERGE_EDGE_POLICY,
  },
  get: (ctx, shortcode) =>
    readProductDetail({ db: ctx.db, usdaClient: ctx.usdaClient }, shortcode),
  list: (ctx, filters, sorts, pagination, groupBy) =>
    productList(
      ctx.db,
      filters,
      sorts,
      pagination,
      groupBy,
      "page",
      ctx.usdaClient,
    ),
  listRead: (ctx, filters, sorts, pagination, projection, groupBy) =>
    listProductsRead(
      ctx.db,
      filters,
      sorts,
      pagination,
      groupBy,
      "page",
      ctx.usdaClient,
      projection,
    ),
  listSummary: (ctx, filters) => productListSummary(ctx.db, filters),
  create: async (ctx, data) => {
    const result = await createProductWithSideEffects(
      {
        db: ctx.db,
        product: createProductWriteActions(ctx.db, ctx.usdaClient),
        recipeCosting: ctx.services.recipeCosting,
        upcLookupClient: ctx.upcLookupClient,
      },
      data,
      ctx.actorContext,
    );
    return {
      output: result,
      entityId: await productShortcodes.one(ctx.db, result.id),
      warnings: result.sideEffects.warnings,
    };
  },
  update: async (ctx, shortcode, data) => {
    const entityId = await productShortcodes.one(ctx.db, shortcode);
    const output = await updateProductWithSideEffects(
      {
        db: ctx.db,
        product: createProductWriteActions(ctx.db, ctx.usdaClient),
        recipeCosting: ctx.services.recipeCosting,
      },
      entityId,
      data,
      ctx.actorContext,
    );
    return { output, entityId };
  },
  delete: async (ctx, shortcodes) => {
    const ids = await productShortcodes.all(ctx.db, shortcodes);
    const { detachedImageKeys, deletedImageShortcodes, ingredientIds } =
      await deleteProducts(ctx.db, ids, ctx.actorContext);
    await Promise.all([
      runMutationSideEffectsForEntities(
        ctx.db,
        mutationEvents("product", "deleted", ids, "product.delete"),
      ),
      ctx.services.recipeCosting.recomputeForIngredients(ingredientIds, {
        source: "product.delete",
      }),
    ]);
    return { detachedImageKeys, deletedImageShortcodes };
  },
  /**
   * The kernel's `bulkUpdate` runs no generic side effects (it is shaped like
   * `delete`), so the fan-out is dispatched here. Deliberately NOT routed
   * through `updateProduct`: `stockTracked` feeds no price, unit mapping or
   * quantity, so that recompute cascade has nothing to react to.
   */
  bulkUpdate: async (ctx, shortcodes, data) => {
    if (data.stockTracked === undefined)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "A bulk product patch must supply stockTracked.",
      );
    const items = await setProductsStockTracked(
      ctx.db,
      { ids: shortcodes, stockTracked: data.stockTracked },
      ctx.actorContext,
    );
    const ids = await productShortcodes.all(
      ctx.db,
      items.map((item) => item.id),
    );
    await runMutationSideEffectsForEntities(
      ctx.db,
      mutationEvents("product", "updated", ids, "product.bulkUpdate"),
    );
    return {
      updatedReferences: entityMutationReferences(
        "product",
        items.map((item) => item.id),
      ),
    };
  },
  merge: {
    input: mergeProductsInput,
    output: z.object({
      product: productTopLevelOut,
      mergeSummary: productMergeSummaryOut,
    }),
    item: (output) => output.product,
    summary: (output) => output.mergeSummary,
    execute: async (ctx, input) => {
      const ingredientIds = await linkedProductIngredientIds(ctx.db, [
        input.keepId,
        ...input.mergeIds,
      ]);
      const summary = await mergeProducts(ctx.db, input, ctx.actorContext);
      await Promise.all([
        runMutationSideEffectsForEntities(ctx.db, [
          ...mutationEvents(
            "product",
            "updated",
            [summary.keepEntityId],
            "product.merge",
          ),
          ...mutationEvents(
            "product",
            "deleted",
            summary.deletedEntityIds,
            "product.merge",
          ),
        ]),
        ctx.services.recipeCosting.recomputeForIngredients(ingredientIds, {
          source: "product.merge",
          entity: { entityKind: "product", entityId: summary.keepEntityId },
        }),
      ]);
      const product = await getProductByShortcode(ctx.db, input.keepId);
      if (!product) throw new Error("Merged Product keeper disappeared");
      return {
        output: {
          product,
          mergeSummary: productMergeSummaryOut.parse(summary),
        },
        entityId: summary.keepEntityId,
        detachedImageKeys: [],
      };
    },
  },
});
