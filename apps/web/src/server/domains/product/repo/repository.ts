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
  createProductReceiptActions,
} from "~/server/domains/product/repo/write/product-writes";
import {
  mutationEvents,
  runMutationSideEffectsForEntities,
} from "~/server/entity-kernel/repo/mutation-side-effects";
import { defineRepository } from "~/server/entity-kernel/repo/repository";
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
  updatePolicy: { recordFields: ["price", "fdc_id", "labelNutrition", "kind"] },
  lifecycle: {
    delete: PRODUCT_DELETE_EDGE_POLICY,
    merge: PRODUCT_MERGE_EDGE_POLICY,
  },
  get: (ctx, shortcode) =>
    readProductDetail({ db: ctx.db, usdaClient: ctx.usdaClient }, shortcode),
  list: (ctx, filters, sorts, pagination) =>
    productList(ctx.db, filters, sorts, pagination, "page", ctx.usdaClient),
  listRead: (
    ctx,
    filters,
    sorts,
    pagination,
    projection,
    readIntent = "page",
  ) =>
    listProductsRead(
      ctx.db,
      filters,
      sorts,
      pagination,
      readIntent,
      ctx.usdaClient,
      projection,
    ),
  listSummary: (ctx, filters) => productListSummary(ctx.db, filters),
  create: async (ctx, data) => {
    const { output: result, entityId } = await createProductWithSideEffects(
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
      entityId,
      warnings: result.sideEffects.warnings,
    };
  },
  createRead: async (ctx, data, _fields) => {
    const { output, entityId } = await createProductWithReadSideEffects(
      {
        db: ctx.db,
        product: createProductReceiptActions(ctx.db, ctx.usdaClient),
        recipeCosting: ctx.services.recipeCosting,
        upcLookupClient: ctx.upcLookupClient,
      },
      data,
      ctx.actorContext,
    );
    return { output, entityId, warnings: output.sideEffects.warnings };
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
  updateRead: async (ctx, shortcode, data, _fields) => {
    const entityId = await productShortcodes.one(ctx.db, shortcode);
    const output = await updateProductWithReadSideEffects(
      {
        db: ctx.db,
        product: createProductReceiptActions(ctx.db, ctx.usdaClient),
        recipeCosting: ctx.services.recipeCosting,
      },
      entityId,
      data,
      ctx.actorContext,
    );
    return { output, entityId, warnings: output.sideEffects.warnings };
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
