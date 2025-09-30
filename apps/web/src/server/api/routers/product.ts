import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { productWithFoodOut } from "~/server/services/product.service";
import { productInputPayload } from "~/schemas/product";
import { createEntityCrudProcedures } from "../crud-factory";
import { findDuplicateUniqueProducts } from "~/server/repo/product";

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
  },
  repository: {
    getByID: async (services, id) => {
      return await services.services.product.getProductByID(
        id,
        services.projectId,
      );
    },
    list: async (services, filters, sort, pagination) => {
      return await services.services.product.productList(
        services.projectId,
        filters.nameFilter,
        filters.manufacturerFilter,
        filters.upcFilter,
        sort,
        pagination,
      );
    },
    create: async (services, data) => {
      return await services.services.product.createProduct(
        data,
        services.projectId || "default-project",
      );
    },
    update: async (services, id, data) => {
      return await services.services.product.updateProduct(
        id,
        services.projectId,
        data,
      );
    },
  },
});

// Price lookup placeholder procedure (for Cloudflare Worker integration)
const priceLookup = protectedProcedure
  .input(
    z.object({
      name: z.string().optional(),
      model: z.string().optional(),
      upc: z.string().optional(),
      manufacturer: z.string().optional(),
    }),
  )
  .output(
    z.object({
      price: z.number().nullable(),
      confidence: z.enum(["high", "medium", "low", "pending"]),
      sources: z.number(),
    }),
  )
  .mutation(async ({ input }) => {
    // TODO: Call Cloudflare Worker for price lookup
    // Placeholder implementation for now
    console.log("Price lookup requested for:", input);
    return {
      price: null,
      confidence: "pending" as const,
      sources: 0,
    };
  });

// Check for duplicate unique products procedure
const findDuplicates = protectedProcedure
  .input(
    z.object({
      productId: z.string().optional(),
    }),
  )
  .output(
    z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        manufacturer: z.string(),
        expectedQuantity: z.number().nullable(),
        locations: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
          }),
        ),
      }),
    ),
  )
  .query(async ({ ctx }) => {
    const duplicates = await findDuplicateUniqueProducts(ctx.db, ctx.projectId);

    return duplicates.map((product) => ({
      id: product.id,
      name: product.name,
      manufacturer: product.manufacturer,
      expectedQuantity: product.expectedQuantity,
      locations: product.InventoryEntry.map((entry) => ({
        id: entry.location.id,
        name: entry.location.name,
      })),
    }));
  });

export const productRouter = createTRPCRouter({
  getByID,
  list,
  create,
  update,
  priceLookup,
  findDuplicates,
});
