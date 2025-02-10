import { TRPCError } from "@trpc/server";
import { createTRPCRouter, publicProcedure } from "../trpc";

import { z } from "zod";
import { type PrismaClient, type Prisma, RecipeSource } from "@prisma/client";
import { compactRecipeSchema, type CompactRecipe } from "~/codec/codec";
import {
  createPaginatedResponseSchema,
  buildTakeSkip,
  sortPaginationCombo,
} from "~/schemas/util";
import { seedRealRecipes } from "~/testdata/seed";
import { scrapeToCompact } from "./scraper";
import { upsertRecipeFromCompact } from "~/server/compactrecipe";
import { parseCompactRecipe } from "~/codec/parser";
import {
  recipeOut,
  recipeTopLevel,
  type RecipeOut,
  type SectionIngredient,
} from "~/schemas/recipes";

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
export const dbRecipeToAPIShallow: (
  recipe: Prisma.RecipeGetPayload<object>,
) => z.infer<typeof recipeTopLevel> = (recipe) => {
  const { SourceType, SourceData, ...restOfRecipe } = recipe;
  return {
    meta: {
      url: SourceType === RecipeSource.Website ? SourceData : null,
    },
    ...restOfRecipe,
  };
};
const dbRecipeToAPI: (recipe: RecipeDeepDB) => RecipeOut = (recipe) => {
  const { sections, SourceData, SourceType, ...restOfRecipe } = recipe;

  return {
    ...restOfRecipe,
    meta: {
      url: SourceType === RecipeSource.Website ? SourceData : null,
    },
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
      z
        .object({
          nameFilter: z.string().optional(),
        })
        .merge(sortPaginationCombo),
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
    .mutation(async ({ input }) => {
      return scrapeToCompact(input);
    }),
  insertCompact: publicProcedure
    .input(compactRecipeSchema)
    .output(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const insert = await insertCompactRecipe(input, ctx.db);
      return insert;
    }),
});

const insertCompactRecipe = async (
  recipe: CompactRecipe,
  prismaClient: PrismaClient,
) => {
  const parsed = parseCompactRecipe(recipe);
  return await upsertRecipeFromCompact(parsed, prismaClient);
};
