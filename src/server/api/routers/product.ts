import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";
import {
  createPaginatedResponseSchema,
  IDInput,
  sortPaginationCombo,
  buildPaginatedResponse,
} from "~/schemas/util";
import { getProductByID, productList } from "~/server/repo/product";
import { productWithIngredientAndInventoryAndMappingsOut } from "~/schemas/combo";

const getByID = publicProcedure
  .input(IDInput)
  .output(productWithIngredientAndInventoryAndMappingsOut)
  .query(async ({ ctx, input }) => await getProductByID(ctx.db, input.id));

const list = publicProcedure
  .input(
    z
      .object({
        nameFilter: z.string().optional(),
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
      input.nameFilter,
      input.sort,
      input.pagination,
    );
    return buildPaginatedResponse(input.pagination, data, count);
  });

export const productRouter = createTRPCRouter({
  getByID,
  list,
});
