import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";
import { productWithIngredientOut } from "~/schemas/ingredient";
import {
  createPaginatedResponseSchema,
  IDInput,
  sortPaginationCombo,
  buildPaginatedResponse,
} from "~/schemas/util";
import { getProductByID, productList } from "~/server/repo/product";

const getByID = publicProcedure
  .input(IDInput)
  .output(productWithIngredientOut)
  .query(async ({ ctx, input }) => await getProductByID(ctx.db, input.id));

const list = publicProcedure
  .input(
    z
      .object({
        nameFilter: z.string().optional(),
      })
      .merge(sortPaginationCombo),
  )
  .output(createPaginatedResponseSchema(productWithIngredientOut))
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
