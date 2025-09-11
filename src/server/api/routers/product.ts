import { z } from "zod";
import { createTRPCRouter } from "../trpc";
import { productWithFoodOut } from "~/server/services/product.service";
import { productInputPayload } from "~/schemas/product";
import { createEntityCrudProcedures } from "../crud-factory";

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
      return await services.services.product.getProductByID(id);
    },
    list: async (services, filters, sort, pagination) => {
      return await services.services.product.productList(
        filters.nameFilter,
        filters.manufacturerFilter,
        filters.upcFilter,
        sort,
        pagination,
      );
    },
    create: async (services, data) => {
      return await services.services.product.createProduct(data);
    },
    update: async (services, id, data) => {
      return await services.services.product.updateProduct(id, data);
    },
  },
});

export const productRouter = createTRPCRouter({
  getByID,
  list,
  create,
  update,
});
