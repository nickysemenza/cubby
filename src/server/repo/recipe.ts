import { type Prisma, type PrismaClient, RecipeSource } from "@prisma/client";
import { type z } from "zod";
import { type CompactRecipe } from "~/codec/codec";
import { parseCompactRecipe } from "~/codec/parser";
import {
  type RecipeOut,
  type recipeTopLevel,
  type SectionIngredient,
} from "~/schemas/recipe";
import { upsertRecipeFromCompact } from "./compactrecipe";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/util";
import { formatSearchTerm, getSortDirection } from "./util";

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
  // Check if this ingredient refers to a recipe
  if (sectionIngredient.ingredient?.Recipe) {
    // This is a recipe reference
    return {
      ...sectionIngredient,
      type: "recipe",
      recipe: dbRecipeToAPIShallow(sectionIngredient.ingredient.Recipe),
      ingredient: null,
      amounts: sectionIngredient.amounts,
    };
  } else {
    // This is a regular ingredient
    return {
      ...sectionIngredient,
      type: "ingredient",
      recipe: null,
      ingredient: sectionIngredient.ingredient ?? null,
      amounts: sectionIngredient.amounts,
    };
  }
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

export const insertCompactRecipe = async (
  recipe: CompactRecipe,
  prismaClient: PrismaClient,
) => {
  const parsed = await parseCompactRecipe(recipe);
  return await upsertRecipeFromCompact(parsed, prismaClient);
};

export const recipeList = async (
  db: PrismaClient,
  name: string | undefined,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  const orderBy: Prisma.RecipeOrderByWithAggregationInput = {
    createdAt: getSortDirection(sort, "createdAt"),
    name: getSortDirection(sort, "name"),
  };
  const where: Prisma.RecipeWhereInput = {
    name: formatSearchTerm(name),
  };
  const res = await db.recipe.findMany({
    orderBy,
    where,
    ...buildTakeSkip(pagination),
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
  const totalCount = await db.recipe.count({ where });
  const items = res.map(dbRecipeToAPI);
  return { data: items, count: totalCount };
};
