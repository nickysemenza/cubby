import { z } from "zod";
import { createTRPCRouter } from "../trpc";
import {
  createProduct,
  getProductByID,
  productList,
  updateProduct,
} from "~/server/repo/product";
import { productInputPayload } from "~/schemas/product";
import { productWithIngredientAndInventoryAndMappingsOut } from "~/schemas/combo";
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
    output: productWithIngredientAndInventoryAndMappingsOut,
    filters: productFiltersSchema,
  },
  repository: {
    getByID: getProductByID,
    list: async (db, filters, sort, pagination) => {
      return await productList(
        db,
        filters.nameFilter,
        filters.manufacturerFilter,
        filters.upcFilter,
        sort,
        pagination,
      );
    },
    create: async (db, data) => {
      const product = await createProduct(db, data);
      return await getProductByID(db, product.id);
    },
    update: async (db, id, data) => {
      await updateProduct(db, id, data);
      return await getProductByID(db, id);
    },
  },
});

export const productRouter = createTRPCRouter({
  getByID,
  list,
  create,
  update,
});
