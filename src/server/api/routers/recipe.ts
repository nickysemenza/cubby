import { TRPCError } from "@trpc/server";
import { createTRPCRouter, publicProcedure } from "../trpc";

import { z } from "zod";
import { compactRecipeSchema } from "~/codec/codec";
import { seedRealRecipes } from "~/testdata/seed";
import { scrapeToCompact } from "./scraper";
import {
  recipeOut,
  recipeCreateInput,
  recipeUpdateInput,
} from "~/schemas/recipe";
import {
  createRecipe,
  getRecipeByID,
  insertCompactRecipe,
  recipeList,
  updateRecipe,
} from "~/server/repo/recipe";
import { createEntityCrudProcedures } from "../crud-factory";

// Define filters schema for recipes
const recipeFiltersSchema = z.object({
  nameFilter: z.string().optional(),
});

// Create standardized CRUD procedures using factory
const { getByID, list, create, update } = createEntityCrudProcedures({
  schemas: {
    createInput: recipeCreateInput,
    updateInput: recipeUpdateInput.shape.data,
    output: recipeOut,
    filters: recipeFiltersSchema,
  },
  repository: {
    getByID: async (db, id) => {
      const res = await getRecipeByID(id, db);
      if (res === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Recipe not found" });
      }
      return res;
    },
    list: async (db, filters, sort, pagination) => {
      return await recipeList(db, filters.nameFilter, sort, pagination);
    },
    create: async (db, data) => {
      return await createRecipe(data, db);
    },
    update: async (db, id, data) => {
      return await updateRecipe(id, data, db);
    },
  },
});

const seed = publicProcedure.mutation(
  async ({ ctx }) => await seedRealRecipes(ctx.db),
);
const scrape = publicProcedure
  .input(z.url())
  .output(compactRecipeSchema)
  .mutation(async ({ input }) => await scrapeToCompact(input));
const insertCompact = publicProcedure
  .input(compactRecipeSchema)
  .output(z.object({ id: z.uuid() }))
  .mutation(async ({ ctx, input }) => await insertCompactRecipe(input, ctx.db));

export const recipeRouter = createTRPCRouter({
  insertCompact,
  scrape,
  seed,
  getByID,
  list,
  create,
  update,
});
