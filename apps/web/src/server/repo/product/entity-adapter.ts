import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  mergeProductsInput,
  productMergeSummaryOut,
  productTopLevelOut,
} from "@cubby/schemas/product";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  defineEntityAdapter,
  deletedWithImages,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
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

export const productEntityAdapter = defineEntityAdapter({
  entity: "product",
  sideEffects: false,
  lifecycle: {
    delete: PRODUCT_DELETE_EDGE_POLICY,
    merge: PRODUCT_MERGE_EDGE_POLICY,
  },
  repository: {
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
      const entityId = await productShortcodes.one(ctx.db, result.id);
      return { output: result, entityId };
    },
    update: async (ctx, shortcode, data) => {
      const entityId = await productShortcodes.one(ctx.db, shortcode);
      const result = await updateProductWithSideEffects(
        {
          db: ctx.db,
          product: createProductWriteActions(ctx.db, ctx.usdaClient),
          recipeCosting: ctx.services.recipeCosting,
        },
        entityId,
        data,
        ctx.actorContext,
      );
      return { output: result, entityId };
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
      return {
        deletedReferences: deletedWithImages(
          "product",
          shortcodes,
          deletedImageShortcodes,
        ),
        detachedImageKeys,
      };
    },
    /**
     * The kernel's `bulkUpdate` branch runs no side effects (it is shaped like
     * `delete`, not `update`), so the fan-out that used to live in
     * `bulkSetProductStockTrackedWorkflow` is dispatched here. Deliberately
     * NOT routed through `updateProduct`: `stockTracked` feeds no price, unit
     * mapping or quantity, so none of that recompute cascade has anything to
     * react to over a several-hundred-row sweep.
     */
    bulkUpdate: async (ctx, shortcodes, data) => {
      if (data.stockTracked === undefined) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "A bulk product patch must supply stockTracked.",
        );
      }
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
          entity: { entityType: "product", entityId: summary.keepEntityId },
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
