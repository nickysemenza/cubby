import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  mergeProductsInput,
  productFiltersSchema,
  productListItemOut,
  productMergeSummaryOut,
  productSortableFields,
  productWithFoodOut,
} from "@cubby/schemas/product";
import { z } from "zod";
import type { Database } from "~/server/db";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";
import { defineEntityAdapter } from "~/server/entity-kernel/adapter";
import {
  bindShortcodeResolver,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";
import { createProductWriteActions } from "~/server/services/product.service";
import {
  createProductWithSideEffects,
  updateProductWithSideEffects,
} from "~/server/services/product-orchestration.service";
import {
  deleteProducts,
  getProductByID,
  getProductByShortcode,
  getProductsByShortcodes,
  productList,
} from "./crud";
import {
  PRODUCT_DETAIL_READER,
  readLegacyProductDetail,
  readProductDetail,
} from "./detail";
import { PRODUCT_DELETE_EDGE_POLICY } from "./edge-roles";
import { mergeProducts, PRODUCT_MERGE_EDGE_POLICY } from "./merge";

const productShortcodes = bindShortcodeResolver("product");
const ingredientShortcodes = bindShortcodeResolver("ingredient");

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
  filters: productFiltersSchema,
  detailOutput: productWithFoodOut,
  listOutput: productListItemOut,
  sort: {
    fields: productSortableFields,
    default: "createdAt",
    groupable: ["category"],
  },
  lifecycle: {
    delete: PRODUCT_DELETE_EDGE_POLICY,
    merge: PRODUCT_MERGE_EDGE_POLICY,
  },
  repository: {
    get: async (ctx, shortcode) => {
      if (PRODUCT_DETAIL_READER === "optimized") {
        return readProductDetail(
          { db: ctx.db, usdaClient: ctx.usdaClient },
          shortcode,
        );
      }
      return readLegacyProductDetail(
        { db: ctx.db, usdaClient: ctx.usdaClient },
        shortcode,
      );
    },
    list: (ctx, filters, sorts, pagination, groupBy) =>
      productList(ctx.db, filters, sorts, pagination, groupBy),
    create: async (ctx, data) => {
      const result = await createProductWithSideEffects(
        {
          db: ctx.db,
          product: createProductWriteActions(ctx.db, ctx.usdaClient),
          recipeCosting: ctx.services.recipeCosting,
          locationValuation: ctx.services.locationValuation,
          upcLookupClient: ctx.upcLookupClient,
        },
        data,
        ctx.actorContext,
      );
      const entityId = await productShortcodes.one(ctx.db, result.id);
      return {
        output: result,
        entityId,
        backgroundBatches: result.sideEffects.backgroundBatches,
      };
    },
    update: async (ctx, shortcode, data) => {
      const entityId = await productShortcodes.one(ctx.db, shortcode);
      const result = await updateProductWithSideEffects(
        {
          db: ctx.db,
          product: createProductWriteActions(ctx.db, ctx.usdaClient),
          recipeCosting: ctx.services.recipeCosting,
          locationValuation: ctx.services.locationValuation,
        },
        entityId,
        data,
        ctx.actorContext,
      );
      return {
        output: result,
        entityId,
        backgroundBatches: result.sideEffects.backgroundBatches,
      };
    },
    delete: async (ctx, shortcodes) => {
      const ids = await productShortcodes.all(ctx.db, shortcodes);
      const ingredientIds = (
        await Promise.all(ids.map((id) => getProductByID(ctx.db, id)))
      ).flatMap((product) => product.ingredient?.id ?? []);
      const resolvedIngredientIds = await Promise.all(
        ingredientIds.map((shortcode) =>
          ingredientShortcodes.one(ctx.db, shortcode),
        ),
      );
      const { deleted, detachedImageKeys } = await deleteProducts(
        ctx.db,
        ids,
        ctx.actorContext,
      );
      const [backgroundBatches, recipeBatches] = await Promise.all([
        runMutationSideEffectsForEntities(
          ctx.db,
          ids.map((entityId) => ({
            action: "deleted" as const,
            entity: { entityType: "product" as const, entityId },
            source: "product.delete",
          })),
        ),
        ctx.services.recipeCosting.recomputeForIngredients(
          resolvedIngredientIds,
          { source: "product.delete" },
        ),
      ]);
      return {
        deleted,
        detachedImageKeys,
        backgroundBatches: [...backgroundBatches, ...recipeBatches],
      };
    },
  },
  merge: {
    input: mergeProductsInput,
    output: z.object({
      product: ENTITY_BINDINGS.product.crud!.output,
      mergeSummary: productMergeSummaryOut,
    }),
    item: (output) => (output as { product: unknown }).product,
    summary: (output) => (output as { mergeSummary: unknown }).mergeSummary,
    execute: async (ctx, value) => {
      const input = mergeProductsInput.parse(value);
      const ingredientIds = await linkedProductIngredientIds(ctx.db, [
        input.keepId,
        ...input.mergeIds,
      ]);
      const summary = await mergeProducts(ctx.db, input, ctx.actorContext);
      const backgroundBatches = [
        ...(await runMutationSideEffectsForEntities(ctx.db, [
          {
            action: "updated" as const,
            entity: {
              entityType: "product" as const,
              entityId: summary.keepEntityId,
            },
            source: "product.merge",
          },
          ...summary.deletedEntityIds.map((entityId) => ({
            action: "deleted" as const,
            entity: { entityType: "product" as const, entityId },
            source: "product.merge",
          })),
        ])),
        ...(await ctx.services.recipeCosting.recomputeForIngredients(
          ingredientIds,
          {
            source: "product.merge",
            entity: { entityType: "product", entityId: summary.keepEntityId },
          },
        )),
      ];
      const product = await getProductByShortcode(ctx.db, input.keepId);
      if (!product) throw new Error("Merged Product keeper disappeared");
      return {
        output: {
          product,
          mergeSummary: productMergeSummaryOut.parse(summary),
        },
        entityId: summary.keepEntityId,
        detachedImageKeys: [],
        backgroundBatches,
      };
    },
  },
});
