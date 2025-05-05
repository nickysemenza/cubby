import { TRPCError } from "@trpc/server";
import { createTRPCRouter, publicProcedure } from "../trpc";

import { z } from "zod";
import { compactRecipeSchema } from "~/codec/codec";
import {
  buildPaginatedResponse,
  createPaginatedResponseSchema,
  sortPaginationCombo,
} from "~/schemas/util";
import { seedRealRecipes } from "~/testdata/seed";
import { scrapeToCompact } from "./scraper";
import { recipeOut } from "~/schemas/recipe";
import {
  getRecipeByID,
  insertCompactRecipe,
  recipeList,
} from "~/server/repo/recipe";

const list = publicProcedure
  .input(
    z
      .object({
        filters: z.object({
          nameFilter: z.string().optional(),
        }),
      })
      .merge(sortPaginationCombo),
  )
  .output(createPaginatedResponseSchema(recipeOut))
  .query(async ({ ctx, input }) => {
    const { data, count } = await recipeList(
      ctx.db,
      input.filters.nameFilter,
      input.sort,
      input.pagination,
    );
    return buildPaginatedResponse(input.pagination, data, count);
  });
const get = publicProcedure
  .input(z.object({ id: z.string().uuid() }))
  .output(recipeOut)
  .query(async ({ ctx, input }) => {
    const res = await getRecipeByID(input.id, ctx.db);

    if (res === null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Recipe not found" });
    }
    return res;
  });

const seed = publicProcedure.mutation(
  async ({ ctx }) => await seedRealRecipes(ctx.db),
);
const scrape = publicProcedure
  .input(z.string().url())
  .output(compactRecipeSchema)
  .mutation(async ({ input }) => await scrapeToCompact(input));
const insertCompact = publicProcedure
  .input(compactRecipeSchema)
  .output(z.object({ id: z.string().uuid() }))
  .mutation(async ({ ctx, input }) => await insertCompactRecipe(input, ctx.db));
export const recipeRouter = createTRPCRouter({
  insertCompact,
  scrape,
  seed,
  get,
  list,
});
