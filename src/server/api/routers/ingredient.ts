import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";
import {
  buildPaginatedResponse,
  createPaginatedResponseSchema,
  IDInput,
  sortPaginationCombo,
} from "../../../schemas/util";
import {
  getIngredientByID,
  mergeIngredients,
  ingredientList,
  getIngredientByName,
} from "~/server/repo/ingredient";
import { ingredientWithRecipesAndProductOut } from "~/schemas/combo";

const merge = publicProcedure
  .input(
    z.object({
      target: z.string().uuid(),
      aliases: z.array(z.string().uuid()).min(1),
    }),
  )
  .output(ingredientWithRecipesAndProductOut)
  .mutation(async ({ ctx, input }) => {
    await mergeIngredients(ctx.db, input.target, input.aliases);
    return await getIngredientByID(ctx.db, input.target);
  });

const getByID = publicProcedure
  .input(IDInput)
  .output(ingredientWithRecipesAndProductOut)
  .query(async ({ ctx, input }) => await getIngredientByID(ctx.db, input.id));

const list = publicProcedure
  .input(
    z
      .object({
        filters: z.object({
          nameFilter: z.string().optional(),
          missingProductsOnly: z.boolean().optional().default(false),
        }),
      })
      .merge(sortPaginationCombo),
  )
  .output(createPaginatedResponseSchema(ingredientWithRecipesAndProductOut))
  .query(async ({ ctx, input }) => {
    const { data, count } = await ingredientList(
      ctx.db,
      input.filters.nameFilter,
      input.sort,
      input.pagination,
      input.filters.missingProductsOnly,
    );

    return buildPaginatedResponse(input.pagination, data, count);
  });
const getByName = publicProcedure
  .input(
    z.object({
      nameFilter: z.string(),
    }),
  )
  .output(ingredientWithRecipesAndProductOut.nullable())
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
