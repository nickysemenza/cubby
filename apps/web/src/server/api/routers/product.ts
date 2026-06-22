/**
 * Product Router - Uses service layer
 *
 * Products integrate with the USDA external API for nutrition data enrichment,
 * so CRUD operations go through the product service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import { type ProductId, productId } from "@cubby/schemas/identifiers";
import {
  productCategory,
  productCreateInput,
  productFiltersSchema,
  productQuickCreatePayload,
  productTopLevelOut,
  productUpdateData,
} from "@cubby/schemas/product";
import { recomputeSummary } from "@cubby/schemas/recipe";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { getErrorMessage } from "~/lib/error-utils";
import { countActiveInventoryForProduct } from "~/server/repo/inventory/crud";
import {
  backfillFoodCategories,
  deleteProducts,
  getCategoryDistribution,
  getProductByShortcode,
  getProductsByShortcodes,
  quickCreateProduct,
} from "~/server/repo/product";
import { importImageFromUPC } from "~/server/services/image-import";
import { productWithFoodOut } from "~/server/services/product.service";
import {
  backfillUPCImages as backfillUPCImagesService,
  findOrCreateByUPC as findOrCreateByUPCService,
} from "~/server/services/product-orchestration.service";
import {
  createDeleteProcedure,
  createEntityCrudProcedures,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Create standardized CRUD procedures using factory (create + update are
// customized below — create imports UPC images, update eagerly recomputes).
const { getByID, list } = createEntityCrudProcedures({
  schemas: {
    createInput: productCreateInput,
    // Defaults-stripped so a partial update never resets an omitted field (e.g.
    // wiping fdc_id / unitMappings). See productUpdateData.
    updateInput: productUpdateData,
    output: productWithFoodOut,
    filters: productFiltersSchema,
    idSchema: productId,
  },
  repository: {
    getByID: async (services, id: ProductId) => {
      return await services.services.product.getProductByID(id);
    },
    list: async (services, filters, sort, pagination, groupBy) => {
      return await services.services.product.productList(
        filters.nameFilter,
        filters.manufacturerFilter,
        filters.upcFilter,
        filters.categoryFilter,
        sort,
        pagination,
        groupBy,
      );
    },
    create: async (services, data) => {
      return await services.services.product.createProduct(
        data,
        services.actorContext,
      );
    },
    update: async (services, id: ProductId, data) => {
      return await services.services.product.updateProduct(
        id,
        data,
        services.actorContext,
      );
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
  .output(productWithFoodOut.extend({ sideEffects: recomputeSummary }))
  .mutation(async ({ ctx, input }) => {
    // Create the product
    const product = await ctx.services.product.createProduct(
      input,
      ctx.actorContext,
    );

    // If product has a UPC, try to import image from UPC lookup (non-blocking)
    if (input.upc) {
      try {
        await importImageFromUPC(
          ctx.db,
          ctx.upcLookupClient,
          input.upc,
          product.id,
        );
      } catch (error) {
        console.error(`[product.create] Image import failed:`, error);
      }
    }

    const ingredientId = product.ingredient?.id;
    const recipesRecomputed = ingredientId
      ? await ctx.services.recipeCosting.recomputeForIngredient(ingredientId)
      : 0;
    return {
      ...product,
      sideEffects: { recipesRecomputed, inventoryValuationsUpdated: 0 },
    };
  });

// Custom update: a product's price/USDA link feeds recipe cost via its linked
// ingredient, so recompute every dependent recipe eagerly (covers UI + MCP) and
// report the count. Inventory-valuation recompute is added here too (stage D).
const update = protectedProcedure
  .input(z.object({ id: productId, data: productUpdateData }))
  .output(productWithFoodOut.extend({ sideEffects: recomputeSummary }))
  .mutation(async ({ ctx, input }) => {
    const result = await ctx.services.product.updateProduct(
      input.id,
      input.data,
      ctx.actorContext,
    );
    const ingredientId = result.ingredient?.id;
    const recipesRecomputed = ingredientId
      ? await ctx.services.recipeCosting.recomputeForIngredient(ingredientId)
      : 0;
    // updateProduct already resynced inventory valuations in its tx when the
    // price changed (amount × price); report how many entries that covered.
    const inventoryValuationsUpdated =
      input.data.price !== undefined
        ? await countActiveInventoryForProduct(ctx.db, input.id)
        : 0;
    return {
      ...result,
      sideEffects: { recipesRecomputed, inventoryValuationsUpdated },
    };
  });

// Quick create a product with minimal data (just name required)
const quickCreate = protectedProcedure
  .input(productQuickCreatePayload)
  .output(productTopLevelOut)
  .mutation(async ({ ctx, input }) => {
    return await quickCreateProduct(
      ctx.db,
      {
        name: input.name,
        manufacturer: input.manufacturer ?? UNSPECIFIED_MANUFACTURER,
        upc: input.upc ?? null,
        expectedQuantity: input.expectedQuantity ?? null,
        model: input.model ?? null,
        price: input.price ?? null,
      },
      ctx.actorContext,
    );
  });

// Find or create a product by UPC code
// Checks local DB first, then USDA, then UPC worker, then creates with defaults
const findOrCreateByUPC = protectedProcedure
  .input(
    z.object({
      upc: upc,
      defaultName: z.string().optional(),
    }),
  )
  .output(productTopLevelOut)
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

// Backfill UPC images for products that have a UPC but no images
const backfillUPCImages = protectedProcedure
  .output(
    z.object({
      found: z.number(),
      imported: z.number(),
      failed: z.number(),
      skipped: z.number(),
      details: z.array(
        z.object({
          productId: productId,
          productName: z.string(),
          upc: z.string(),
          status: z.enum(["imported", "failed", "skipped"]),
          error: z.string().optional(),
        }),
      ),
    }),
  )
  .mutation(async ({ ctx }) => {
    return backfillUPCImagesService(ctx.db, ctx.upcLookupClient);
  });

// Backfill food category for products with UPC/NDB/ingredient
const backfillFoodCategoriesEndpoint = protectedProcedure
  .output(
    z.object({
      updated: z.number(),
      products: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
        }),
      ),
    }),
  )
  .mutation(async ({ ctx }) => {
    return await backfillFoodCategories(ctx.db, ctx.actorContext);
  });

// Get category distribution for insights visualization
const categoryDistribution = protectedProcedure
  .output(
    z.array(
      z.object({
        category: productCategory.nullable(),
        productCount: z.number(),
        locations: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            count: z.number(),
          }),
        ),
      }),
    ),
  )
  .query(async ({ ctx }) => {
    return await getCategoryDistribution(ctx.db);
  });

// Batch lookup: multiple products by shortcode (e.g. for label printing)
const getByShortcodes = protectedProcedure
  .input(z.object({ shortcodes: z.array(z.string()) }))
  .output(z.array(productTopLevelOut))
  .query(async ({ ctx, input }) => {
    return await getProductsByShortcodes(ctx.db, input.shortcodes);
  });

// Get product by shortcode (e.g., P-X7K9)
const getByShortcode = protectedProcedure
  .input(z.object({ shortcode: z.string() }))
  .output(productTopLevelOut.nullable())
  .query(async ({ ctx, input }) => {
    return await getProductByShortcode(ctx.db, input.shortcode);
  });

// Delete procedure using standalone factory
// Batch-create products for the enrichment workbench's "Create products" action.
// Sequential single-row creates (each its own tx) so one bad row doesn't abort
// the rest; failures are reported per index for the client to surface/retry.
const createMany = protectedProcedure
  .input(z.array(productCreateInput).min(1).max(50))
  .output(
    z.object({
      created: z.number(),
      failed: z.array(
        z.object({
          index: z.number(),
          name: z.string(),
          error: z.string(),
        }),
      ),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const failed: { index: number; name: string; error: string }[] = [];
    let created = 0;
    for (const [index, item] of input.entries()) {
      try {
        await ctx.services.product.createProduct(item, ctx.actorContext);
        created++;
      } catch (error) {
        failed.push({ index, name: item.name, error: getErrorMessage(error) });
      }
    }
    return { created, failed };
  });

// Batch "no USDA food exists" flag for the workbench's "Mark no-USDA" action, so
// those products drop out of the link-USDA worklist and switch to manual entry.
const markUsdaUnavailableMany = protectedProcedure
  .input(z.object({ ids: z.array(productId).min(1).max(100) }))
  .output(z.object({ updated: z.number() }))
  .mutation(async ({ ctx, input }) => {
    let updated = 0;
    for (const id of input.ids) {
      await ctx.services.product.updateProduct(
        id,
        { usdaUnavailable: true },
        ctx.actorContext,
      );
      updated++;
    }
    return { updated };
  });

const deleteItem = createDeleteProcedure<ProductId>(async (services, ids) => {
  await deleteProducts(services.db, ids, services.actorContext);
}, productId);

export const productRouter = createTRPCRouter({
  getByID,
  getByShortcode,
  getByShortcodes,
  list,
  create,
  createMany,
  markUsdaUnavailableMany,
  update,
  delete: deleteItem,
  quickCreate,
  findOrCreateByUPC,
  backfillUPCImages,
  backfillFoodCategories: backfillFoodCategoriesEndpoint,
  categoryDistribution,
});
