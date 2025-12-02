import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { productWithFoodOut } from "~/server/services/product.service";
import {
  productInputPayload,
  productQuickCreatePayload,
  productTopLevelOut,
} from "~/schemas/product";
import { createEntityCrudProcedures } from "../crud-factory";
import { productId, type ProductId } from "~/schemas/identifiers";
import { findProductByUPC, quickCreateProduct } from "~/server/repo/product";
import { upc } from "@recipehub/usda-schemas";
import {
  UNSPECIFIED_MANUFACTURER,
  DEFAULT_EXPECTED_QUANTITY,
} from "~/lib/constants";

// Define filters schema for products
const productFiltersSchema = z.object({
  nameFilter: z.string().optional(),
  manufacturerFilter: z.string().optional(),
  upcFilter: z.string().optional(),
});

// Create standardized CRUD procedures using factory
const { getByID, list, create, update } = createEntityCrudProcedures({
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
      );
    },
    update: async (services, id: ProductId, data) => {
      // organizationId guaranteed non-null by requireOrganization middleware
      return await services.services.product.updateProduct(
        id,
        services.organizationId!,
        data,
      );
    },
  },
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
    );
  });

// Find or create a product by UPC code
// Checks local DB first, then USDA, then creates with defaults
const findOrCreateByUPC = protectedProcedure
  .input(
    z.object({
      upc: upc,
      defaultName: z.string().optional(), // Fallback if USDA lookup fails
    }),
  )
  .output(productTopLevelOut)
  .mutation(async ({ ctx, input }) => {
    // 1. Check if product with this UPC already exists in organization
    const existing = await findProductByUPC(
      ctx.db,
      input.upc,
      ctx.organizationId!,
    );
    if (existing) {
      return existing;
    }

    // 2. Lookup in USDA database
    const food = await ctx.usdaClient.findFood({
      kind: "upc",
      gtin_upc: input.upc,
    });

    // 3. Create product with USDA data or defaults
    const name =
      food?.foodInfo.description ?? input.defaultName ?? `Product ${input.upc}`;
    const manufacturer =
      food?.brandedFoodInfo?.brand_owner ??
      food?.brandedFoodInfo?.brand_name ??
      UNSPECIFIED_MANUFACTURER;

    return await quickCreateProduct(
      ctx.db,
      {
        name,
        manufacturer,
        upc: input.upc,
        expectedQuantity: DEFAULT_EXPECTED_QUANTITY,
        model: null,
      },
      ctx.organizationId!,
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
