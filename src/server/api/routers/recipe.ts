import { TRPCError } from "@trpc/server";
import { createTRPCRouter, publicProcedure } from "../trpc";

import { z } from "zod";
import { type PrismaClient, type Prisma } from "@prisma/client";
import { amount, compactRecipeSchema, type CompactRecipe } from "~/codec/codec";
import {
  createPaginatedResponseSchema,
  dbTimestamps,
  paginationParams,
  sortParams,
  buildTakeSkip,
} from "./util";
import { seedRealRecipes } from "~/testdata/seed";
import { scrapeRecipe, scrapeToCompact } from "./scraper";
import { insertRecipeFromCompact } from "~/server/compactrecipe";
import { type WCompactRecipe } from "recipebridge/pkg/recipebridge";
import { parseCompactRecipe } from "~/codec/parser";
import { recipeOut, RecipeOut, SectionIngredient } from "../apiSchema";

type RecipeDeepDB = Prisma.RecipeGetPayload<{
  include: {
    sections: {
      include: {
        ingredients: {
          include: { ingredient: { include: { Recipe: true } } };
        };
      };
    };
  };
}>;
const secitonIngredienttoAPI: (
  sectionIngredient: Prisma.RecipeSectionIngredientGetPayload<{
    include: { ingredient: { include: { Recipe: true } } };
  }>,
) => SectionIngredient = (sectionIngredient) => {
  return {
    ...sectionIngredient,
    recipe: null,
    ingredient: sectionIngredient.ingredient ?? null,
    amounts: sectionIngredient.amounts,
  };
};

const dbRecipeToAPI: (recipe: RecipeDeepDB) => RecipeOut = (recipe) => {
  const { sections, ...restOfRecipe } = recipe;

  return {
    ...restOfRecipe,
    sections: sections.map((section) => {
      const { ingredients, instructions, ...restOfSection } = section;
      return {
        ...restOfSection,
        ingredients: ingredients.map(secitonIngredienttoAPI),
        instructions: instructions.map((instruction) => {
          return { instruction: instruction.text };
        }),
      };
    }),
  };
};

export const getRecipeByID = async (
  id: string,
  prismaClient: PrismaClient,
): Promise<RecipeOut | null> => {
  const res: RecipeDeepDB | null = await prismaClient.recipe.findFirst({
    where: { id: id },
    include: {
      sections: {
        include: {
          ingredients: {
            include: { ingredient: { include: { Recipe: true } } },
          },
        },
      },
    },
  });
  return res === null ? null : dbRecipeToAPI(res);
};

export const recipeRouter = createTRPCRouter({
  list: publicProcedure
    .input(
      z.object({
        sort: sortParams,
        pagination: paginationParams,
        nameFilter: z.string().optional(),
      }),
    )
    .output(createPaginatedResponseSchema(recipeOut))
    .query(async ({ ctx, input }) => {
      const orderBy: Prisma.RecipeOrderByWithAggregationInput = {
        createdAt:
          input.sort.orderBy === "createdAt" ? input.sort.direction : undefined,
        name: input.sort.orderBy === "name" ? input.sort.direction : undefined,
      };
      const where: Prisma.RecipeWhereInput = {
        name: input.nameFilter != "" ? { search: input.nameFilter } : undefined,
      };
      const res = await ctx.db.recipe.findMany({
        orderBy,
        where,
        ...buildTakeSkip(input.pagination),
        include: {
          sections: {
            include: {
              ingredients: {
                include: { ingredient: { include: { Recipe: true } } },
              },
            },
          },
        },
      });
      const totalCount = await ctx.db.recipe.count({ where });
      const items = res.map(dbRecipeToAPI);
      return {
        meta: {
          pageIndex: 0,
          pageSize: items.length,
          totalCount,
          // totalPages: 1,
        },
        items,
      };
    }),
  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(recipeOut)
    .query(async ({ ctx, input }) => {
      const res = await getRecipeByID(input.id, ctx.db);

      if (res === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Recipe not found" });
      }
      return res;
    }),

  seed: publicProcedure.mutation(async ({ ctx }) => {
    await seedRealRecipes(ctx.db);
  }),
  scrape: publicProcedure
    .input(z.string().url())
    .output(compactRecipeSchema)
    .mutation(async ({ ctx, input }) => {
      return scrapeToCompact(input);
    }),
  insertCompact: publicProcedure
    .input(compactRecipeSchema)
    .output(z.any())
    .mutation(async ({ ctx, input }) => {
      const insert = await insertCompactRecipe(input, ctx.db);
      return { insert };
    }),
});

const insertCompactRecipe = async (
  recipe: CompactRecipe,
  prismaClient: PrismaClient,
) => {
  const parsed = parseCompactRecipe(recipe);
  return await insertRecipeFromCompact(parsed, prismaClient);
};
