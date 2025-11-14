import { z } from "zod";
import { createTRPCRouter } from "../trpc";
import { productWithFoodOut } from "~/server/services/product.service";
import { productInputPayload } from "~/schemas/product";
import { createEntityCrudProcedures } from "../crud-factory";
import { productId, type ProductId } from "~/schemas/identifiers";

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

export const productRouter = createTRPCRouter({
  getByID,
  list,
  create,
  update,
});
