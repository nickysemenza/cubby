import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure, systemProcedure } from "../trpc";

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
    getByID: async (services, id) => {
      const res = await getRecipeByID(id, services.db, services.projectId);
      if (res === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Recipe not found" });
      }
      return res;
    },
    list: async (services, filters, sort, pagination) => {
      return await recipeList(
        services.db,
        services.projectId,
        filters.nameFilter,
        sort,
        pagination,
      );
    },
    create: async (services, data) => {
      if (!services.projectId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Project ID required",
        });
      }
      return await createRecipe(data, services.db, services.projectId);
    },
    update: async (services, id, data) => {
      if (!services.projectId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Project ID required",
        });
      }
      return await updateRecipe(id, data, services.db, services.projectId);
    },
  },
});

const seed = systemProcedure.mutation(
  async ({ ctx }) => await seedRealRecipes(ctx.db, ctx.projectId),
);
const scrape = protectedProcedure
  .input(z.url())
  .output(compactRecipeSchema)
  .mutation(async ({ input }) => await scrapeToCompact(input));
const insertCompact = protectedProcedure
  .input(compactRecipeSchema)
  .output(z.object({ id: z.uuid() }))
  .mutation(async ({ ctx, input }) => {
    return await insertCompactRecipe(input, ctx.db, ctx.projectId);
  });

export const recipeRouter = createTRPCRouter({
  insertCompact,
  scrape,
  seed,
  getByID,
  list,
  create,
  update,
});
