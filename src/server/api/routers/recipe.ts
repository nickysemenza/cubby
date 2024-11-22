import { TRPCError } from "@trpc/server";
import { createTRPCRouter, publicProcedure } from "../trpc";

import { z } from "zod";
import { type PrismaClient, type Prisma, Recipe } from "@prisma/client";
import { amount } from "~/codec/codec";
import {
  createPaginatedResponseSchema,
  dbTimestamps,
  paginationParams,
  sortParams,
  buildTakeSkip,
} from "./util";
import { seedRealRecipes } from "~/testdata/seed";
import { scrapeRecipe } from "./scraper";

const ingredientOut = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
  })
  .merge(dbTimestamps);
const recipeTopLevel = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
  })
  .merge(dbTimestamps);
const sectionIngredientOut = z
  .object({
    id: z.string().uuid(),
    recipe: recipeTopLevel.nullable(),
    ingredient: ingredientOut.nullable(),
    amounts: z.array(amount),
  })
  .merge(dbTimestamps);
export type SectionIngredient = z.infer<typeof sectionIngredientOut>;
const recipeSectionOut = z
  .object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    ingredients: z.array(sectionIngredientOut),
    instructions: z.array(z.object({ instruction: z.string() })),
  })
  .merge(dbTimestamps);

const recipeOut = z
  .object({
    sections: z.array(recipeSectionOut),
  })
  .merge(recipeTopLevel);

export type RecipeOut = z.infer<typeof recipeOut>;

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
) => z.infer<typeof sectionIngredientOut> = (sectionIngredient) => {
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
    .output(z.any())
    .query(async ({ input }) => {
      return await scrapeRecipe(input);
    }),
});
