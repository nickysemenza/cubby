import { z } from "zod";
import { createTRPCRouter, protectedProcedure, getUserId } from "../trpc";
import { productWithFoodOut } from "~/server/services/product.service";
import {
  productInputPayload,
  productQuickCreatePayload,
  productTopLevelOut,
} from "~/schemas/product";
import { createEntityCrudProcedures } from "../crud-factory";
import {
  productId,
  type ProductId,
  unsafeProductId,
} from "~/schemas/identifiers";
import { findProductByUPC, quickCreateProduct } from "~/server/repo/product";
import { upc } from "@recipehub/usda-schemas";
import {
  UNSPECIFIED_MANUFACTURER,
  DEFAULT_EXPECTED_QUANTITY,
} from "~/lib/constants";
import { importImageFromUPC } from "~/server/services/image-import";

// Define filters schema for products
const productFiltersSchema = z.object({
  nameFilter: z.string().optional(),
  manufacturerFilter: z.string().optional(),
  upcFilter: z.string().optional(),
});

// Create standardized CRUD procedures using factory (except create, which we customize)
const { getByID, list, update } = createEntityCrudProcedures({
  schemas: {
    createInput: productInputPayload,
    updateInput: productInputPayload.partial(),
    output: productWithFoodOut,
    filters: productFiltersSchema,
    idSchema: productId,
  },
  repository: {
    getByID: async (services, id: ProductId) => {
      // organizationId guaranteed non-null by requireOrganization middleware
      return await services.services.product.getProductByID(
        id,
        services.organizationId!,
      );
    },
    list: async (services, filters, sort, pagination) => {
      // organizationId guaranteed non-null by requireOrganization middleware
      return await services.services.product.productList(
        services.organizationId!,
        filters.nameFilter,
        filters.manufacturerFilter,
        filters.upcFilter,
        sort,
        pagination,
      );
    },
    create: async (services, data) => {
      // organizationId guaranteed non-null by requireOrganization middleware
      return await services.services.product.createProduct(
        data,
        services.organizationId!,
        getUserId(services.auth),
      );
    },
    update: async (services, id: ProductId, data) => {
      // organizationId guaranteed non-null by requireOrganization middleware
      return await services.services.product.updateProduct(
        id,
        services.organizationId!,
        data,
        getUserId(services.auth),
      );
    },
  },
});

// Custom create procedure that imports UPC images after product creation
const create = protectedProcedure
  .input(productInputPayload)
  .output(productWithFoodOut)
  .mutation(async ({ ctx, input }) => {
    // Create the product
    const product = await ctx.services.product.createProduct(
      input,
      ctx.organizationId!,
      ctx.auth.userId ?? undefined,
    );

    // If product has a UPC, try to import image from UPC lookup (non-blocking)
    if (input.upc) {
      try {
        await importImageFromUPC(
          ctx.db,
          ctx.organizationId!,
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
        expectedQuantity: input.expectedQuantity ?? DEFAULT_EXPECTED_QUANTITY,
        model: input.model ?? null,
        price: input.price ?? null,
      },
      ctx.organizationId!,
      ctx.auth.userId ?? undefined,
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
    console.log(`[findOrCreateByUPC] Looking up UPC: ${input.upc}`);

    // 1. Check if product with this UPC already exists in organization
    const existing = await findProductByUPC(
      ctx.db,
      input.upc,
      ctx.organizationId!,
    );
    if (existing) {
      console.log(
        `[findOrCreateByUPC] Found existing product: ${existing.name}`,
      );
      return existing;
    }

    // 2. Lookup in USDA database (food items)
    console.log(`[findOrCreateByUPC] Checking USDA for ${input.upc}`);
    const food = await ctx.usdaClient.findFood({
      kind: "upc",
      gtin_upc: input.upc,
    });

    if (food) {
      console.log(
        `[findOrCreateByUPC] Found in USDA: ${food.foodInfo.description}`,
      );
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
          expectedQuantity: DEFAULT_EXPECTED_QUANTITY,
          model: null,
        },
        ctx.organizationId!,
        ctx.auth.userId ?? undefined,
      );
    }

    // 3. Lookup in UPC worker (general products - tools, electronics, etc.)
    console.log(`[findOrCreateByUPC] Checking UPC worker for ${input.upc}`);
    const upcLookup = await ctx.upcLookupClient.lookup(input.upc);

    if (upcLookup) {
      console.log(`[findOrCreateByUPC] Found in UPC worker: ${upcLookup.name}`);
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
          expectedQuantity: DEFAULT_EXPECTED_QUANTITY,
          model: null,
          price: upcLookup.priceDollars ?? null,
        },
        ctx.organizationId!,
        ctx.auth.userId ?? undefined,
      );

      // Import image from UPC lookup if available (non-blocking)
      if (upcLookup.imageUrl) {
        try {
          await importImageFromUPC(
            ctx.db,
            ctx.organizationId!,
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
    console.log(
      `[findOrCreateByUPC] Not found anywhere, creating with defaults for ${input.upc}`,
    );
    return await quickCreateProduct(
      ctx.db,
      {
        name: input.defaultName ?? `Product ${input.upc}`,
        manufacturer: UNSPECIFIED_MANUFACTURER,
        upc: input.upc,
        expectedQuantity: DEFAULT_EXPECTED_QUANTITY,
        model: null,
      },
      ctx.organizationId!,
      ctx.auth.userId ?? undefined,
    );
  });

export const productRouter = createTRPCRouter({
  getByID,
  list,
  create,
  update,
  quickCreate,
  findOrCreateByUPC,
});
