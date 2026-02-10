/**
 * Product Router - Uses service layer
 *
 * Products integrate with the USDA external API for nutrition data enrichment,
 * so CRUD operations go through the product service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import {
  type ProductId,
  productId,
  unsafeProductId,
} from "@cubby/schemas/identifiers";
import {
  productCategory,
  productCreateInput,
  productQuickCreatePayload,
  productTopLevelOut,
} from "@cubby/schemas/product";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { getErrorMessage } from "~/lib/error-utils";
import {
  backfillFoodCategories,
  backfillProductPrices,
  deleteProducts,
  findProductByUPC,
  findProductsNeedingFoodCategory,
  findProductsWithNoImages,
  findProductsWithStalePrices,
  getCategoryDistribution,
  getProductByShortcode,
  getProductsByShortcodes,
  quickCreateProduct,
} from "~/server/repo/product";
import { importImageFromUPC } from "~/server/services/image-import";
import { productWithFoodOut } from "~/server/services/product.service";
import {
  createDeleteProcedure,
  createEntityCrudProcedures,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Define filters schema for products
const productFiltersSchema = z.object({
  nameFilter: z.string().optional(),
  manufacturerFilter: z.string().optional(),
  upcFilter: z.string().optional(),
  categoryFilter: productCategory.optional(),
});

// Create standardized CRUD procedures using factory (except create, which we customize)
const { getByID, list, update } = createEntityCrudProcedures({
  schemas: {
    createInput: productCreateInput,
    updateInput: productCreateInput.partial(),
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

// Custom create procedure that imports UPC images after product creation
const create = protectedProcedure
  .input(productCreateInput)
  .output(productWithFoodOut)
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
          unsafeProductId(product.id),
        );
      } catch (error) {
        console.error(`[product.create] Image import failed:`, error);
      }
    }

    return product;
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
      defaultName: z.string().optional(), // Fallback if all lookups fail
    }),
  )
  .output(productTopLevelOut)
  .mutation(async ({ ctx, input }) => {
    // 1. Check if product with this UPC already exists
    const existing = await findProductByUPC(ctx.db, input.upc);
    if (existing) {
      return existing;
    }

    // 2. Lookup in USDA database (food items)
    const food = await ctx.usdaClient.findFood({
      kind: "upc",
      gtin_upc: input.upc,
    });

    if (food) {
      // Found in USDA - create product with USDA data
      return await quickCreateProduct(
        ctx.db,
        {
          name: food.foodInfo.description,
          manufacturer:
            food.brandedFoodInfo?.brand_owner ??
            food.brandedFoodInfo?.brand_name ??
            UNSPECIFIED_MANUFACTURER,
          upc: input.upc,
          expectedQuantity: null,
          model: null,
        },
        ctx.actorContext,
      );
    }

    // 3. Lookup in UPC worker (general products - tools, electronics, etc.)
    const upcLookup = await ctx.upcLookupClient.lookup(input.upc);

    if (upcLookup) {
      // Found in UPC worker - create product with UPC lookup data
      const newProduct = await quickCreateProduct(
        ctx.db,
        {
          name: upcLookup.name,
          manufacturer:
            upcLookup.manufacturer ??
            upcLookup.brand ??
            UNSPECIFIED_MANUFACTURER,
          upc: input.upc,
          expectedQuantity: null,
          model: null,
          price: upcLookup.priceDollars ?? null,
        },
        ctx.actorContext,
      );

      // Import image from UPC lookup if available (non-blocking)
      if (upcLookup.imageUrl) {
        try {
          await importImageFromUPC(
            ctx.db,
            ctx.upcLookupClient,
            input.upc,
            unsafeProductId(newProduct.id),
          );
        } catch (error) {
          console.error(`[findOrCreateByUPC] Image import failed:`, error);
        }
      }

      return newProduct;
    }

    // 4. Nothing found anywhere - create with defaults
    return await quickCreateProduct(
      ctx.db,
      {
        name: input.defaultName ?? `Product ${input.upc}`,
        manufacturer: UNSPECIFIED_MANUFACTURER,
        upc: input.upc,
        expectedQuantity: null,
        model: null,
      },
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
    // Find products without images, then filter to those with UPC for backfill
    const allNoImages = await findProductsWithNoImages(ctx.db);
    const productsWithUPC = allNoImages.filter(
      (p): p is typeof p & { upc: string } => p.upc != null,
    );

    const details: Array<{
      productId: string;
      productName: string;
      upc: string;
      status: "imported" | "failed" | "skipped";
      error?: string;
    }> = [];

    let imported = 0;
    let failed = 0;
    let skipped = 0;

    // Process in parallel batches of 10
    const BATCH_SIZE = 10;
    for (let i = 0; i < productsWithUPC.length; i += BATCH_SIZE) {
      const batch = productsWithUPC.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async (p) => {
          try {
            const result = await importImageFromUPC(
              ctx.db,
              ctx.upcLookupClient,
              p.upc,
              unsafeProductId(p.id),
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
    }

    return {
      found: productsWithUPC.length,
      imported,
      failed,
      skipped,
      details,
    };
  });

// Get count of products with UPC but no images (for UI preview)
const getUPCImageBackfillCount = protectedProcedure
  .output(z.object({ count: z.number() }))
  .query(async ({ ctx }) => {
    const products = await findProductsWithNoImages(ctx.db);
    return { count: products.filter((p) => p.upc != null).length };
  });

// Get count of products with food indicators but wrong category
const getFoodCategoryBackfillCount = protectedProcedure
  .output(z.object({ count: z.number() }))
  .query(async ({ ctx }) => {
    const products = await findProductsNeedingFoodCategory(ctx.db);
    return { count: products.length };
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

// Get count of products with stale/missing prices
const getStalePricesCount = protectedProcedure
  .output(z.number())
  .query(async ({ ctx }) => {
    const staleProducts = await findProductsWithStalePrices(ctx.db);
    return staleProducts.length;
  });

// Backfill product prices from unit mappings
const backfillProductPricesEndpoint = protectedProcedure
  .output(
    z.object({
      updated: z.number(),
      products: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          oldPrice: z.number().nullable(),
          newPrice: z.number().nullable(),
        }),
      ),
    }),
  )
  .mutation(async ({ ctx }) => {
    return await backfillProductPrices(ctx.db, ctx.actorContext);
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
const deleteItem = createDeleteProcedure<ProductId>(async (services, ids) => {
  await deleteProducts(services.db, ids, services.actorContext);
}, productId);

export const productRouter = createTRPCRouter({
  getByID,
  getByShortcode,
  getByShortcodes,
  list,
  create,
  update,
  delete: deleteItem,
  quickCreate,
  findOrCreateByUPC,
  backfillUPCImages,
  getUPCImageBackfillCount,
  getFoodCategoryBackfillCount,
  backfillFoodCategories: backfillFoodCategoriesEndpoint,
  getStalePricesCount,
  backfillProductPrices: backfillProductPricesEndpoint,
  categoryDistribution,
});
