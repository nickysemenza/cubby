import { type Prisma, RecipeSource } from "@prisma/client";
import { type Database } from "~/server/db";
import { type z } from "zod";
import { type CompactRecipe, amount } from "~/codec/codec";
import { parseCompactRecipe } from "~/codec/parser";
import {
  type RecipeOut,
  type recipeTopLevel,
  type SectionIngredient,
  type RecipeCreateInput,
  type RecipeUpdateInput,
  recipeIngredientInput,
} from "~/schemas/recipe";
import { upsertRecipeFromCompact } from "./compactrecipe";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/pagination";
import {
  formatSearchTerm,
  getSortDirection,
} from "~/server/repo/database-helpers";
import { type RecipeId, type ProjectId } from "~/schemas/identifiers";

export const getRecipeByID = async (
  id: RecipeId,
  db: Database | Prisma.TransactionClient,
  projectId: ProjectId,
): Promise<RecipeOut | null> => {
  const res: RecipeDeepDB | null = await db.recipe.findFirst({
    where: { id: id, projectId }, // Ensure recipe belongs to project
    include: {
      sections: {
        include: {
          ingredients: {
            include: { ingredient: { include: { Recipe: true } } },
          },
        },
      },
      images: {
        include: {
          image: true,
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
    images: {
      include: {
        image: true;
      };
    };
  };
}>;

const sectionIngredientToAPI: (
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
  const { sections, SourceData, SourceType, images, ...restOfRecipe } = recipe;

  // Extract images from the join table records
  const recipeImages = images.map((ri) => ri.image);

  return {
    ...restOfRecipe,
    meta: {
      url: SourceType === RecipeSource.Website ? SourceData : null,
    },
    images: recipeImages,
    sections: sections.map((section) => {
      const { ingredients, instructions, ...restOfSection } = section;
      return {
        ...restOfSection,
        ingredients: ingredients.map(sectionIngredientToAPI),
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
  db: Database,
  projectId: ProjectId,
) => {
  const parsed = await parseCompactRecipe(recipe);
  return await upsertRecipeFromCompact(parsed, db, projectId);
};

export const recipeList = async (
  db: Database,
  projectId: ProjectId,
  name: string | undefined,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  const orderBy: Prisma.RecipeOrderByWithAggregationInput = {
    createdAt: getSortDirection(sort, "createdAt"),
    name: getSortDirection(sort, "name"),
  };
  const where: Prisma.RecipeWhereInput = {
    projectId, // Filter by project
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
      images: {
        include: {
          image: true,
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
  db: Database,
  projectId: ProjectId,
): Promise<RecipeOut> => {
  const sourceType = recipe.meta?.url
    ? RecipeSource.Website
    : RecipeSource.Other;
  const sourceData = recipe.meta?.url || null;
  const { pendingImageIds } = recipe;

  // Create the recipe in a transaction
  return await db.$transaction(async (tx) => {
    // Process all ingredients first
    const processedSections = await Promise.all(
      recipe.sections.map(async (section) => {
        const processedIngredients = section.ingredients
          ? await processIngredients(tx, section.ingredients, projectId)
          : [];

        return {
          name: section.name,
          processedIngredients,
          instructions: section.instructions,
        };
      }),
    );

    // Create the main recipe
    const createdRecipe = await tx.recipe.create({
      data: {
        projectId: projectId,
        name: recipe.name,
        SourceType: sourceType,
        SourceData: sourceData,
        sections: {
          create: processedSections.map((section) => ({
            name: section.name,
            ingredients: {
              create: section.processedIngredients,
            },
            instructions: section.instructions?.map((instruction) => ({
              text: instruction.instruction,
            })),
          })),
        },
      },
    });

    // Associate images if provided
    if (pendingImageIds && pendingImageIds.length > 0) {
      // Create RecipeImage records in batch
      await tx.recipeImage.createMany({
        data: pendingImageIds.map((imageId) => ({
          recipeId: createdRecipe.id,
          imageId,
        })),
      });

      // Update all image statuses to UPLOADED in batch
      await tx.image.updateMany({
        where: { id: { in: pendingImageIds } },
        data: { status: "UPLOADED" },
      });
    }

    const fullRecipe = await getRecipeByID(
      createdRecipe.id as RecipeId,
      tx,
      projectId,
    );
    if (!fullRecipe) {
      throw new Error("Failed to retrieve created recipe");
    }
    return fullRecipe;
  });
};

// Helper function to process ingredients
const processIngredient = async (
  tx: Prisma.TransactionClient,
  ingredient: z.infer<typeof recipeIngredientInput>,
  projectId: ProjectId,
): Promise<{ ingredientId: string; amounts: z.infer<typeof amount>[] }> => {
  // For ingredient types, just use the ingredient ID directly
  if (ingredient.type === "ingredient") {
    return {
      ingredientId: ingredient.ingredientId,
      amounts: ingredient.amounts,
    };
  }

  // For recipe types, find or create an ingredient that points to the recipe
  // Find any existing ingredient that already points to this recipe
  const recipeIngredient = await tx.ingredient.findFirst({
    where: { recipeId: ingredient.recipeId },
  });

  // If found, use the existing ingredient
  if (recipeIngredient) {
    return {
      ingredientId: recipeIngredient.id,
      amounts: ingredient.amounts,
    };
  }

  // Otherwise, create a new ingredient that points to the recipe
  // First get the recipe name
  const recipe = await tx.recipe.findUnique({
    where: { id: ingredient.recipeId },
    select: { name: true },
  });

  if (!recipe) {
    throw new Error(`Recipe with ID ${ingredient.recipeId} not found`);
  }

  // Create a new ingredient that points to this recipe
  const newIngredient = await tx.ingredient.create({
    data: {
      projectId: projectId,
      name: `Recipe: ${recipe.name}`,
      aliases: [],
      recipeId: ingredient.recipeId,
    },
  });

  return {
    ingredientId: newIngredient.id,
    amounts: ingredient.amounts,
  };
};

// Helper function to process multiple ingredients
const processIngredients = async (
  tx: Prisma.TransactionClient,
  ingredients: z.infer<typeof recipeIngredientInput>[],
  projectId: ProjectId,
): Promise<{ ingredientId: string; amounts: z.infer<typeof amount>[] }[]> => {
  return await Promise.all(
    ingredients.map((ing) => processIngredient(tx, ing, projectId)),
  );
};

export const upsertRecipe = async (
  input: RecipeCreateInput,
  db: Database,
  projectId: ProjectId,
): Promise<{ id: string }> => {
  // Check if recipe already exists
  const existingRecipe = await db.recipe.findUnique({
    where: {
      projectId_name: {
        projectId: projectId,
        name: input.name,
      },
    },
  });

  if (existingRecipe) {
    // Recipe exists - delete existing sections and recreate with new data
    // First delete ingredients that reference the sections
    const existingSections = await db.recipeSection.findMany({
      where: { recipeId: existingRecipe.id },
      select: { id: true },
    });

    if (existingSections.length > 0) {
      await db.recipeSectionIngredient.deleteMany({
        where: {
          recipeSectionId: {
            in: existingSections.map((s) => s.id),
          },
        },
      });

      // Now safe to delete the sections
      await db.recipeSection.deleteMany({
        where: { recipeId: existingRecipe.id },
      });
    }

    // Process ingredients for the update (same as in createRecipe)
    const processedSections = await Promise.all(
      input.sections.map(async (section) => {
        const processedIngredients = (section.ingredients || []).map(
          (ingredient) => ({
            ingredientId: ingredient.ingredientId,
            amounts: ingredient.amounts,
          }),
        );

        return {
          name: section.name,
          processedIngredients,
          instructions: section.instructions,
        };
      }),
    );

    // Update the recipe with new data
    const updatedRecipe = await db.recipe.update({
      where: { id: existingRecipe.id },
      data: {
        SourceType: input.meta?.url ? ("Website" as const) : ("Other" as const),
        SourceData: input.meta?.url || null,
        updatedAt: new Date(),
        sections: {
          create: processedSections.map((section) => ({
            name: section.name,
            ingredients: {
              create: section.processedIngredients,
            },
            instructions: section.instructions?.map((instruction) => ({
              text: instruction.instruction,
            })),
          })),
        },
      },
    });

    return { id: updatedRecipe.id };
  } else {
    // Recipe doesn't exist - create new one
    return await createRecipe(input, db, projectId);
  }
};

export const updateRecipe = async (
  id: RecipeId,
  updates: RecipeUpdateInput["data"],
  db: Database,
  projectId: ProjectId,
): Promise<RecipeOut> => {
  // Check if recipe exists and belongs to project
  const existingRecipe = await db.recipe.findUnique({
    where: { id, projectId },
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
        where: { id, projectId },
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

    // Add new images if provided
    if (updates.pendingImageIds && updates.pendingImageIds.length > 0) {
      // Create RecipeImage records in batch
      await tx.recipeImage.createMany({
        data: updates.pendingImageIds.map((imageId) => ({
          recipeId: id,
          imageId,
        })),
      });

      // Update all image statuses to UPLOADED in batch
      await tx.image.updateMany({
        where: { id: { in: updates.pendingImageIds } },
        data: { status: "UPLOADED" },
      });
    }

    // Remove images if requested
    if (updates.removeImageIds && updates.removeImageIds.length > 0) {
      await tx.recipeImage.deleteMany({
        where: {
          recipeId: id,
          imageId: {
            in: updates.removeImageIds,
          },
        },
      });
    }

    // Handle section updates if provided
    if (updates.sections) {
      const sectionIdsInUpdate = updates.sections
        .map((s) => s.id)
        .filter((id): id is string => Boolean(id));

      // If no IDs are provided, treat as full replacement: delete all existing sections first
      if (sectionIdsInUpdate.length === 0) {
        // Delete all ingredients for existing sections, then delete sections
        const allSectionIds = existingRecipe.sections.map((s) => s.id);
        if (allSectionIds.length > 0) {
          await tx.recipeSectionIngredient.deleteMany({
            where: { recipeSectionId: { in: allSectionIds } },
          });
          await tx.recipeSection.deleteMany({
            where: { id: { in: allSectionIds } },
          });
        }
      }

      for (const sectionUpdate of updates.sections) {
        // If this is a new section (no ID), create it
        if (!sectionUpdate.id) {
          await tx.recipeSection.create({
            data: {
              recipeId: id,
              name: sectionUpdate.name || null,
              ingredients: sectionUpdate.ingredients
                ? {
                    create: await processIngredients(
                      tx,
                      sectionUpdate.ingredients,
                      projectId,
                    ),
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
                // Process the ingredient and create it
                const processedIngredient = await processIngredient(
                  tx,
                  ingredientUpdate,
                  projectId,
                );
                await tx.recipeSectionIngredient.create({
                  data: {
                    recipeSectionId: sectionUpdate.id,
                    ingredientId: processedIngredient.ingredientId,
                    amounts: processedIngredient.amounts,
                  },
                });
              } else {
                // Process the ingredient and update it
                const processedIngredient = await processIngredient(
                  tx,
                  ingredientUpdate,
                  projectId,
                );
                await tx.recipeSectionIngredient.update({
                  where: { id: ingredientUpdate.id },
                  data: {
                    ingredientId: processedIngredient.ingredientId,
                    amounts: processedIngredient.amounts,
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

        // If we are doing partial update with specific section IDs, remove any sections not referenced
        if (sectionIdsInUpdate.length > 0) {
          const sectionsToDelete = existingRecipe.sections
            .map((s) => s.id)
            .filter((sid) => !sectionIdsInUpdate.includes(sid));
          if (sectionsToDelete.length > 0) {
            // Delete their ingredients first, then the sections
            await tx.recipeSectionIngredient.deleteMany({
              where: { recipeSectionId: { in: sectionsToDelete } },
            });
            await tx.recipeSection.deleteMany({
              where: { id: { in: sectionsToDelete } },
            });
          }
        }
      }
    }

    const fullRecipe = await getRecipeByID(id, tx, projectId);
    if (!fullRecipe) {
      throw new Error("Failed to retrieve updated recipe");
    }
    return fullRecipe;
  });
};
