import { TRPCError } from "@trpc/server";
import { createTRPCRouter, publicProcedure } from "../trpc";

import { z } from "zod";
import { type Prisma } from "@prisma/client";
const timestamps = z.object({
  createdAt: z.date(),
  updatedAt: z.date(),
});
const ingredientOut = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
  })
  .merge(timestamps);
const recipeTopLevel = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
  })
  .merge(timestamps);
const sectionIngredientOut = z
  .object({
    id: z.string().uuid(),
    recipe: recipeTopLevel.nullable(),
    ingredient: ingredientOut.nullable(),
  })
  .merge(timestamps);
const recipeSectionOut = z
  .object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    ingredients: z.array(sectionIngredientOut),
  })
  .merge(timestamps);

const recipeOut = z
  .object({
    sections: z.array(recipeSectionOut),
  })
  .merge(recipeTopLevel);

type RecipeOut = z.infer<typeof recipeOut>;

type RecipeDeepDB = Prisma.RecipeGetPayload<{
  include: {
    sections: {
      include: {
        sectionIngredient: {
          include: { recipe: true; ingredient: true };
        };
      };
    };
  };
}>;
const secitonIngredienttoAPI: (
  sectionIngredient: Prisma.RecipeSectionIngredientGetPayload<{
    include: { recipe: true; ingredient: true };
  }>,
) => z.infer<typeof sectionIngredientOut> = (sectionIngredient) => {
  return {
    ...sectionIngredient,
    recipe: sectionIngredient.recipe,
    ingredient: sectionIngredient.ingredient,
  };
};

const dbRecipeToAPI: (recipe: RecipeDeepDB) => RecipeOut = (recipe) => {
  const { sections, ...restOfRecipe } = recipe;

  return {
    ...restOfRecipe,
    sections: sections.map((section) => {
      const { sectionIngredient, ...restOfSection } = section;
      return {
        ...restOfSection,
        ingredients: sectionIngredient.map(secitonIngredienttoAPI),
      };
    }),
  };
};

export const recipeRouter = createTRPCRouter({
  list: publicProcedure.output(z.array(recipeOut)).query(async ({ ctx }) => {
    const res = await ctx.db.recipe.findMany({
      include: {
        sections: {
          include: {
            sectionIngredient: {
              include: { recipe: true, ingredient: true },
            },
          },
        },
      },
    });
    return res.map(dbRecipeToAPI);
  }),
  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .output(recipeOut)
    .query(async ({ ctx, input }) => {
      const res = await ctx.db.recipe.findFirst({
        where: { id: input.id },
        include: {
          sections: {
            include: {
              sectionIngredient: {
                include: { recipe: true, ingredient: true },
              },
            },
          },
        },
      });
      if (res === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Recipe not found" });
      }
      console.log(res);
      return dbRecipeToAPI(res);
    }),
});
