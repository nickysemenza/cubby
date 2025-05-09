import { type Prisma, type PrismaClient, RecipeSource } from "@prisma/client";
import { type z } from "zod";
import { type CompactRecipe } from "~/codec/codec";
import { parseCompactRecipe } from "~/codec/parser";
import {
  type RecipeOut,
  type recipeTopLevel,
  type SectionIngredient,
  type RecipeCreateInput,
  type RecipeUpdateInput,
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
        // Map JSON instructions array to the expected format
        instructions: Array.isArray(instructions)
          ? instructions.map((instruction: { text: string }) => {
              return { instruction: instruction.text };
            })
          : [],
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

  // Define query parameters once to avoid duplication
  const findManyParams = {
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
  };

  // Execute both queries in a single transaction for better performance
  const [results, totalCount] = await db.$transaction([
    db.recipe.findMany(findManyParams),
    db.recipe.count({ where }),
  ]);

  const items = results.map(dbRecipeToAPI);
  return { data: items, count: totalCount };
};

export const createRecipe = async (
  recipe: RecipeCreateInput,
  db: PrismaClient,
): Promise<{ id: string }> => {
  const sourceType = recipe.meta?.url
    ? RecipeSource.Website
    : RecipeSource.Other;
  const sourceData = recipe.meta?.url || null;

  // Create the recipe in a transaction
  return await db.$transaction(async (tx) => {
    // Create the main recipe
    const createdRecipe = await tx.recipe.create({
      data: {
        name: recipe.name,
        SourceType: sourceType,
        SourceData: sourceData,
        sections: {
          create: recipe.sections.map((section) => ({
            name: section.name,
            ingredients: {
              create: section.ingredients?.map((ingredient) => ({
                amounts: ingredient.amounts,
                ingredientId: ingredient.ingredientId,
              })),
            },
            instructions: section.instructions?.map((instruction) => ({
              text: instruction.instruction,
            })),
          })),
        },
      },
    });

    return { id: createdRecipe.id };
  });
};

export const updateRecipe = async (
  id: string,
  updates: RecipeUpdateInput["data"],
  db: PrismaClient,
): Promise<{ id: string }> => {
  // Check if recipe exists
  const existingRecipe = await db.recipe.findUnique({
    where: { id },
    include: {
      sections: {
        include: {
          ingredients: true,
        },
      },
    },
  });

  if (!existingRecipe) {
    throw new Error(`Recipe with ID ${id} not found`);
  }

  // Update in a transaction
  return await db.$transaction(async (tx) => {
    // Update basic recipe properties
    if (updates.name || updates.meta !== undefined) {
      const sourceType = updates.meta?.url
        ? RecipeSource.Website
        : existingRecipe.SourceType || RecipeSource.Other;
      const sourceData =
        updates.meta?.url !== undefined
          ? updates.meta.url
          : existingRecipe.SourceData;

      await tx.recipe.update({
        where: { id },
        data: {
          ...(updates.name ? { name: updates.name } : {}),
          ...(updates.meta !== undefined
            ? {
                SourceType: sourceType,
                SourceData: sourceData,
              }
            : {}),
        },
      });
    }

    // Handle section updates if provided
    if (updates.sections) {
      for (const sectionUpdate of updates.sections) {
        // If this is a new section (no ID), create it
        if (!sectionUpdate.id) {
          await tx.recipeSection.create({
            data: {
              recipeId: id,
              name: sectionUpdate.name || null,
              ingredients: sectionUpdate.ingredients
                ? {
                    create: sectionUpdate.ingredients.map((ing) => ({
                      ingredientId: ing.ingredientId,
                      amounts: ing.amounts,
                    })),
                  }
                : undefined,
              instructions: sectionUpdate.instructions
                ? sectionUpdate.instructions.map((inst) => ({
                    text: inst.instruction,
                  }))
                : [],
            },
          });
        } else {
          // This is an existing section, update it
          const existingSection = existingRecipe.sections.find(
            (s) => s.id === sectionUpdate.id,
          );

          if (!existingSection) {
            throw new Error(
              `Section with ID ${sectionUpdate.id} not found in recipe ${id}`,
            );
          }

          // Update section name if provided
          if (sectionUpdate.name !== undefined) {
            await tx.recipeSection.update({
              where: { id: sectionUpdate.id },
              data: { name: sectionUpdate.name },
            });
          }

          // Handle ingredient updates
          if (sectionUpdate.ingredients) {
            // First, get existing ingredients for this section
            const existingIngredients = existingSection.ingredients;

            // Process each ingredient in the update
            for (const ingredientUpdate of sectionUpdate.ingredients) {
              if (!ingredientUpdate.id) {
                // Create new ingredient
                await tx.recipeSectionIngredient.create({
                  data: {
                    recipeSectionId: sectionUpdate.id,
                    ingredientId: ingredientUpdate.ingredientId,
                    amounts: ingredientUpdate.amounts,
                  },
                });
              } else {
                // Update existing ingredient
                await tx.recipeSectionIngredient.update({
                  where: { id: ingredientUpdate.id },
                  data: {
                    ingredientId: ingredientUpdate.ingredientId,
                    amounts: ingredientUpdate.amounts,
                  },
                });
              }
            }

            // Delete ingredients that weren't included in the update
            const updatedIngredientIds = sectionUpdate.ingredients
              .filter((ing) => ing.id)
              .map((ing) => ing.id!);

            const ingredientsToDelete = existingIngredients.filter(
              (ing) => !updatedIngredientIds.includes(ing.id),
            );

            for (const ingToDelete of ingredientsToDelete) {
              await tx.recipeSectionIngredient.delete({
                where: { id: ingToDelete.id },
              });
            }
          }

          // Handle instruction updates
          if (sectionUpdate.instructions) {
            // Since instructions are stored as a JSON array, we update the entire array
            const instructionsJson = sectionUpdate.instructions.map((inst) => ({
              text: inst.instruction,
            }));

            await tx.recipeSection.update({
              where: { id: sectionUpdate.id },
              data: {
                instructions: instructionsJson,
              },
            });
          }
        }
      }
    }

    return { id };
  });
};
