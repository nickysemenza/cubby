import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  mergeProductsInput,
  productMergeSummaryOut,
  productTopLevelOut,
} from "@cubby/schemas/product";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  createProductWithSideEffects,
  updateProductWithSideEffects,
  createProductWithReadSideEffects,
  updateProductWithReadSideEffects,
} from "~/server/domains/product/repo/write/product-orchestration";
import {
  createProductWriteActions,
  createProductReadActions,
  readProductMutationFields,
} from "~/server/domains/product/repo/write/product-writes";
import { entityMutationReferences } from "~/server/entity-kernel/adapter";
import {
  mutationEvents,
  runMutationSideEffectsForEntities,
} from "~/server/entity-kernel/repo/mutation-side-effects";
import { defineRepository } from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import {
  bindShortcodeResolver,
  resolveLiveShortcodes,
} from "~/server/generic/shortcode/repo/shortcode-resolver";

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
 * `sideEffects: false` prevents duplicate generic fan-out: Product writes own
 * UPC image import and recipe re-costing. They still receive the kernel's
 * transaction-bound context, and publications wait for its commit.
 */
export const productRepository = defineRepository("product", {
  sideEffects: false,
  lifecycle: {
    delete: PRODUCT_DELETE_EDGE_POLICY,
    merge: PRODUCT_MERGE_EDGE_POLICY,
  },
  get: (ctx, shortcode) =>
    readProductDetail({ db: ctx.db, usdaClient: ctx.usdaClient }, shortcode),
  list: (ctx, filters, sorts, pagination) =>
    productList(ctx.db, filters, sorts, pagination, "page", ctx.usdaClient),
  listRead: (ctx, filters, sorts, pagination, projection) =>
    listProductsRead(
      ctx.db,
      filters,
      sorts,
      pagination,
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
  createRead: async (ctx, data, fields) => {
    const output = await createProductWithReadSideEffects(
      {
        db: ctx.db,
        product: createProductReadActions(
          ctx.db,
          ctx.usdaClient,
          (product, id) =>
            readProductMutationFields(
              ctx.db,
              ctx.usdaClient,
              product,
              id,
              fields,
            ),
        ),
        recipeCosting: ctx.services.recipeCosting,
        upcLookupClient: ctx.upcLookupClient,
      },
      data,
      ctx.actorContext,
    );
    return {
      output,
      entityId: await productShortcodes.one(ctx.db, output.id),
      warnings: output.sideEffects.warnings,
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
  updateRead: async (ctx, shortcode, data, fields) => {
    const entityId = await productShortcodes.one(ctx.db, shortcode);
    const output = await updateProductWithReadSideEffects(
      {
        db: ctx.db,
        product: createProductReadActions(
          ctx.db,
          ctx.usdaClient,
          (product, id) =>
            readProductMutationFields(
              ctx.db,
              ctx.usdaClient,
              product,
              id,
              fields,
            ),
        ),
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
