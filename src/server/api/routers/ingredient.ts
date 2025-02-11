import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";
import {
  buildPaginatedResponse,
  createPaginatedResponseSchema,
  IDInput,
  sortPaginationCombo,
} from "../../../schemas/util";
import { ingredientOut } from "~/schemas/ingredient";
import {
  getIngredientByID,
  mergeIngredients,
  ingredientList,
  getIngredientByName,
} from "~/server/repo/ingredient";

const merge = publicProcedure
  .input(
    z.object({
      target: z.string().uuid(),
      aliases: z.array(z.string().uuid()).min(1),
    }),
  )
  .output(ingredientOut)
  .mutation(async ({ ctx, input }) => {
    await mergeIngredients(ctx.db, input.target, input.aliases);
    return await getIngredientByID(ctx.db, input.target);
  });

const getByID = publicProcedure
  .input(IDInput)
  .output(ingredientOut)
  .query(async ({ ctx, input }) => await getIngredientByID(ctx.db, input.id));

const list = publicProcedure
  .input(
    z
      .object({
        nameFilter: z.string().optional(),
      })
      .merge(sortPaginationCombo),
  )
  .output(createPaginatedResponseSchema(ingredientOut))
  .query(async ({ ctx, input }) => {
    const { data, count } = await ingredientList(
      ctx.db,
      input.nameFilter,
      input.sort,
      input.pagination,
    );

    return buildPaginatedResponse(input.pagination, data, count);
  });
const getByName = publicProcedure
  .input(
    z.object({
      nameFilter: z.string(),
    }),
  )
  .output(ingredientOut.nullable())
  .query(
    async ({ ctx, input }) =>
      await getIngredientByName(ctx.db, input.nameFilter),
  );

export const ingredientRouter = createTRPCRouter({
  getByName,
  getByID,
  list,
  merge,
});
