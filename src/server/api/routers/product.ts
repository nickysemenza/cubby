import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";
import {
  createPaginatedResponseSchema,
  IDInput,
  sortPaginationCombo,
  buildPaginatedResponse,
} from "~/schemas/util";
import {
  createProduct,
  getProductByID,
  productList,
  updateProduct,
} from "~/server/repo/product";
import { productInputPayload, productTopLevelOut } from "~/schemas/product";
import { productWithIngredientAndInventoryAndMappingsOut } from "~/schemas/combo";

const getByID = publicProcedure
  .input(IDInput)
  .output(productWithIngredientAndInventoryAndMappingsOut)
  .query(async ({ ctx, input }) => await getProductByID(ctx.db, input.id));

const list = publicProcedure
  .input(
    z
      .object({
        filters: z.object({
          nameFilter: z.string().optional(),
          manufacturerFilter: z.string().optional(),
          upcFilter: z.string().optional(),
        }),
      })
      .merge(sortPaginationCombo),
  )
  .output(
    createPaginatedResponseSchema(
      productWithIngredientAndInventoryAndMappingsOut,
    ),
  )
  .query(async ({ ctx, input }) => {
    const { data, count } = await productList(
      ctx.db,
      input.filters.nameFilter,
      input.filters.manufacturerFilter,
      input.filters.upcFilter,
      input.sort,
      input.pagination,
    );
    return buildPaginatedResponse(input.pagination, data, count);
  });

const create = publicProcedure
  .input(productInputPayload)
  .output(productTopLevelOut)
  .mutation(async ({ ctx, input }) => {
    return await createProduct(ctx.db, input);
  });

const update = publicProcedure
  .input(
    z.object({
      id: z.string().uuid(),
      data: productInputPayload.partial(),
    }),
  )
  .output(productTopLevelOut)
  .mutation(async ({ ctx, input }) => {
    return await updateProduct(ctx.db, input.id, input.data);
  });

export const productRouter = createTRPCRouter({
  getByID,
  list,
  create,
  update,
});
