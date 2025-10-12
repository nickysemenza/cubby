import { type Database, type Transaction } from "~/server/db";
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
  withTransaction,
  getDb,
  unwrapDb,
  relations,
  buildOrderBy,
  insertAndReturn,
  batchInsert,
} from "~/server/repo/database-helpers";
import { type RecipeId, type ProjectId } from "~/schemas/identifiers";
import {
  recipe,
  recipeSection,
  recipeSectionIngredient,
  ingredient,
  recipeImage,
  image,
} from "~/server/db/schema";
import { eq, and, inArray, sql } from "drizzle-orm";

export const getRecipeByID = async (
  id: RecipeId,
  db: Database | Transaction,
  projectId: ProjectId,
): Promise<RecipeOut | null> => {
  const res = await unwrapDb(db).query.recipe.findFirst({
    where: and(eq(recipe.id, id), eq(recipe.projectId, projectId)),
    ...relations.recipe.full,
  });
  return res === null || res === undefined ? null : dbRecipeToAPI(res);
};

type RecipeDeepDB = typeof recipe.$inferSelect & {
  sections: Array<
    typeof recipeSection.$inferSelect & {
      ingredients: Array<
        typeof recipeSectionIngredient.$inferSelect & {
          ingredient: typeof ingredient.$inferSelect & {
            Recipe: typeof recipe.$inferSelect | null;
          };
        }
      >;
    }
  >;
  images: Array<{
    image: typeof image.$inferSelect;
  }>;
};

type SectionIngredientDB = typeof recipeSectionIngredient.$inferSelect & {
  ingredient: typeof ingredient.$inferSelect & {
    Recipe: typeof recipe.$inferSelect | null;
  };
};

const sectionIngredientToAPI: (
  sectionIngredient: SectionIngredientDB,
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
type RecipeSelect = typeof recipe.$inferSelect;

export const dbRecipeToAPIShallow: (
  recipeParam: RecipeSelect,
) => z.infer<typeof recipeTopLevel> = (recipeData) => {
  const { SourceType, SourceData, ...restOfRecipe } = recipeData;
  return {
    meta: {
      url: SourceType === "Website" ? SourceData : null,
    },
    ...restOfRecipe,
  };
};
const dbRecipeToAPI: (recipe: RecipeDeepDB) => RecipeOut = (recipeData) => {
  const { sections, SourceData, SourceType, images, ...restOfRecipe } =
    recipeData;

  // Extract images from the join table records
  const recipeImages = images.map((ri) => ri.image);

  return {
    ...restOfRecipe,
    meta: {
      url: SourceType === "Website" ? SourceData : null,
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
  const dbClient = getDb(db);

  // Build where conditions
  const whereConditions = [
    eq(recipe.projectId, projectId),
    name ? formatSearchTerm(recipe.name, name) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  const whereClause =
    whereConditions.length > 0 ? and(...whereConditions) : undefined;

  // Build orderBy using helper
  const orderByClause = buildOrderBy(recipe, sort, ["createdAt", "name"]);

  const { take, skip } = buildTakeSkip(pagination);

  // Execute both queries
  const [results, countResult] = await Promise.all([
    dbClient.query.recipe.findMany({
      where: whereClause,
      orderBy: orderByClause,
      limit: take,
      offset: skip,
      ...relations.recipe.full,
    }),
    dbClient
      .select({ count: sql<number>`count(*)::int` })
      .from(recipe)
      .where(whereClause),
  ]);

  const totalCount = countResult[0]?.count ?? 0;
  const items = results.map(dbRecipeToAPI);
  return { data: items, count: totalCount };
};

export const createRecipe = async (
  recipeInput: RecipeCreateInput,
  db: Database,
  projectId: ProjectId,
): Promise<RecipeOut> => {
  const sourceType = recipeInput.meta?.url ? "Website" : "Other";
  const sourceData = recipeInput.meta?.url || null;
  const { pendingImageIds } = recipeInput;

  // Create the recipe in a transaction
  return await withTransaction(db, async (tx) => {
    // Process all ingredients first
    const processedSections = await Promise.all(
      recipeInput.sections.map(async (section) => {
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
    const createdRecipe = await insertAndReturn(tx, recipe, {
      projectId: projectId,
      name: recipeInput.name,
      SourceType: sourceType,
      SourceData: sourceData,
    });

    // Create sections and their ingredients
    for (const section of processedSections) {
      const createdSection = await insertAndReturn(tx, recipeSection, {
        recipeId: createdRecipe.id,
        name: section.name,
        instructions:
          section.instructions?.map((instruction) => ({
            text: instruction.instruction,
          })) ?? [],
      });

      // Create ingredients for this section
      if (section.processedIngredients.length > 0) {
        await batchInsert(
          tx,
          recipeSectionIngredient,
          section.processedIngredients.map((ing) => ({
            recipeSectionId: createdSection.id,
            ingredientId: ing.ingredientId as string,
            amounts: ing.amounts,
          })),
        );
      }
    }

    // Associate images if provided
    if (pendingImageIds && pendingImageIds.length > 0) {
      // Create RecipeImage records in batch
      await batchInsert(
        tx,
        recipeImage,
        pendingImageIds.map((imageId) => ({
          recipeId: createdRecipe.id,
          imageId,
        })),
      );

      // Update all image statuses to UPLOADED in batch
      await tx
        .update(image)
        .set({ status: "UPLOADED" })
        .where(inArray(image.id, pendingImageIds));
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
  tx: Transaction,
  ingredientInput: z.infer<typeof recipeIngredientInput>,
  projectId: ProjectId,
): Promise<{
  ingredientId: string;
  amounts: z.infer<typeof amount>[];
}> => {
  // For ingredient types, just use the ingredient ID directly
  if (ingredientInput.type === "ingredient") {
    return {
      ingredientId: ingredientInput.ingredientId as string,
      amounts: ingredientInput.amounts,
    };
  }

  // For recipe types, find or create an ingredient that points to the recipe
  // Find any existing ingredient that already points to this recipe
  const recipeIngredient = await tx.query.ingredient.findFirst({
    where: eq(ingredient.recipeId, ingredientInput.recipeId),
  });

  // If found, use the existing ingredient
  if (recipeIngredient) {
    return {
      ingredientId: recipeIngredient.id,
      amounts: ingredientInput.amounts,
    };
  }

  // Otherwise, create a new ingredient that points to the recipe
  // First get the recipe name
  const recipeRecord = await tx.query.recipe.findFirst({
    where: eq(recipe.id, ingredientInput.recipeId),
    columns: { name: true },
  });

  if (!recipeRecord) {
    throw new Error(`Recipe with ID ${ingredientInput.recipeId} not found`);
  }

  // Create a new ingredient that points to this recipe
  const [newIngredient] = await tx
    .insert(ingredient)
    .values({
      projectId: projectId,
      name: `Recipe: ${recipeRecord.name}`,
      aliases: [],
      recipeId: ingredientInput.recipeId,
    })
    .returning();

  if (!newIngredient) {
    throw new Error("Failed to create ingredient");
  }

  return {
    ingredientId: newIngredient.id,
    amounts: ingredientInput.amounts,
  };
};

// Helper function to process multiple ingredients
const processIngredients = async (
  tx: Transaction,
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
  const dbClient = getDb(db);

  // Check if recipe already exists
  const existingRecipe = await dbClient.query.recipe.findFirst({
    where: and(eq(recipe.projectId, projectId), eq(recipe.name, input.name)),
  });

  if (existingRecipe) {
    // Recipe exists - delete existing sections and recreate with new data
    // First delete ingredients that reference the sections
    const existingSections = await dbClient.query.recipeSection.findMany({
      where: eq(recipeSection.recipeId, existingRecipe.id),
      columns: { id: true },
    });

    if (existingSections.length > 0) {
      const sectionIds = existingSections.map((s) => s.id);
      await dbClient
        .delete(recipeSectionIngredient)
        .where(inArray(recipeSectionIngredient.recipeSectionId, sectionIds));

      // Now safe to delete the sections
      await dbClient
        .delete(recipeSection)
        .where(eq(recipeSection.recipeId, existingRecipe.id));
    }

    // Process ingredients for the update (same as in createRecipe)
    const processedSections = await Promise.all(
      input.sections.map(async (section) => {
        const processedIngredients = (section.ingredients || []).map(
          (ingredientInput) => ({
            ingredientId: ingredientInput.ingredientId,
            amounts: ingredientInput.amounts,
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
    const [updatedRecipe] = await dbClient
      .update(recipe)
      .set({
        SourceType: input.meta?.url ? "Website" : "Other",
        SourceData: input.meta?.url || null,
        updatedAt: new Date(),
      })
      .where(eq(recipe.id, existingRecipe.id))
      .returning();

    if (!updatedRecipe) {
      throw new Error("Failed to update recipe");
    }

    // Create new sections
    for (const section of processedSections) {
      const [createdSection] = await dbClient
        .insert(recipeSection)
        .values({
          recipeId: updatedRecipe.id,
          name: section.name,
          instructions:
            section.instructions?.map((instruction) => ({
              text: instruction.instruction,
            })) ?? [],
        })
        .returning();

      if (!createdSection) {
        throw new Error("Failed to create recipe section");
      }

      // Create ingredients for this section
      if (section.processedIngredients.length > 0) {
        await dbClient.insert(recipeSectionIngredient).values(
          section.processedIngredients.map((ing) => ({
            recipeSectionId: createdSection.id,
            ingredientId: ing.ingredientId as string,
            amounts: ing.amounts,
          })),
        );
      }
    }

    return { id: updatedRecipe.id };
  } else {
    // Recipe doesn't exist - create new one
    const created = await createRecipe(input, db, projectId);
    return { id: created.id };
  }
};

export const updateRecipe = async (
  id: RecipeId,
  updates: RecipeUpdateInput["data"],
  db: Database,
  projectId: ProjectId,
): Promise<RecipeOut> => {
  // Check if recipe exists and belongs to project
  const existingRecipe = await getDb(db).query.recipe.findFirst({
    where: and(eq(recipe.id, id), eq(recipe.projectId, projectId)),
    with: {
      sections: {
        with: {
          ingredients: true,
        },
      },
    },
  });

  if (!existingRecipe) {
    throw new Error(`Recipe with ID ${id} not found`);
  }

  // Update in a transaction
  return await withTransaction(db, async (tx) => {
    // Update basic recipe properties
    if (updates.name || updates.meta !== undefined) {
      const sourceType = updates.meta?.url
        ? "Website"
        : existingRecipe.SourceType || "Other";
      const sourceData =
        updates.meta?.url !== undefined
          ? updates.meta.url
          : existingRecipe.SourceData;

      const updateData: {
        name?: string;
        SourceType?: "Book" | "Website" | "Other";
        SourceData?: string | null;
      } = {};

      if (updates.name) {
        updateData.name = updates.name;
      }
      if (updates.meta !== undefined) {
        updateData.SourceType = sourceType;
        updateData.SourceData = sourceData;
      }

      await tx
        .update(recipe)
        .set(updateData)
        .where(and(eq(recipe.id, id), eq(recipe.projectId, projectId)));
    }

    // Add new images if provided
    if (updates.pendingImageIds && updates.pendingImageIds.length > 0) {
      // Create RecipeImage records in batch
      await tx.insert(recipeImage).values(
        updates.pendingImageIds.map((imageId) => ({
          recipeId: id,
          imageId,
        })),
      );

      // Update all image statuses to UPLOADED in batch
      await tx
        .update(image)
        .set({ status: "UPLOADED" })
        .where(inArray(image.id, updates.pendingImageIds));
    }

    // Remove images if requested
    if (updates.removeImageIds && updates.removeImageIds.length > 0) {
      await tx
        .delete(recipeImage)
        .where(
          and(
            eq(recipeImage.recipeId, id),
            inArray(recipeImage.imageId, updates.removeImageIds),
          ),
        );
    }

    // Handle section updates if provided
    if (updates.sections) {
      const sectionIdsInUpdate = updates.sections
        .map((s) => s.id)
        .filter((sectionId): sectionId is string => Boolean(sectionId));

      // If no IDs are provided, treat as full replacement: delete all existing sections first
      if (sectionIdsInUpdate.length === 0) {
        // Delete all ingredients for existing sections, then delete sections
        const allSectionIds = existingRecipe.sections.map((s) => s.id);
        if (allSectionIds.length > 0) {
          await tx
            .delete(recipeSectionIngredient)
            .where(
              inArray(recipeSectionIngredient.recipeSectionId, allSectionIds),
            );
          await tx
            .delete(recipeSection)
            .where(inArray(recipeSection.id, allSectionIds));
        }
      }

      for (const sectionUpdate of updates.sections) {
        // If this is a new section (no ID), create it
        if (!sectionUpdate.id) {
          const processedIngredients = sectionUpdate.ingredients
            ? await processIngredients(tx, sectionUpdate.ingredients, projectId)
            : [];

          const [createdSection] = await tx
            .insert(recipeSection)
            .values({
              recipeId: id,
              name: sectionUpdate.name || null,
              instructions: sectionUpdate.instructions
                ? sectionUpdate.instructions.map((inst) => ({
                    text: inst.instruction,
                  }))
                : [],
            })
            .returning();

          if (!createdSection) {
            throw new Error("Failed to create recipe section");
          }

          // Create ingredients for this section
          if (processedIngredients.length > 0) {
            await tx.insert(recipeSectionIngredient).values(
              processedIngredients.map((ing) => ({
                recipeSectionId: createdSection.id,
                ingredientId: ing.ingredientId as string,
                amounts: ing.amounts,
              })),
            );
          }
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
            await tx
              .update(recipeSection)
              .set({ name: sectionUpdate.name })
              .where(eq(recipeSection.id, sectionUpdate.id));
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
                await tx.insert(recipeSectionIngredient).values({
                  recipeSectionId: sectionUpdate.id,
                  ingredientId: processedIngredient.ingredientId,
                  amounts: processedIngredient.amounts,
                });
              } else {
                // Process the ingredient and update it
                const processedIngredient = await processIngredient(
                  tx,
                  ingredientUpdate,
                  projectId,
                );
                await tx
                  .update(recipeSectionIngredient)
                  .set({
                    ingredientId: processedIngredient.ingredientId,
                    amounts: processedIngredient.amounts,
                  })
                  .where(eq(recipeSectionIngredient.id, ingredientUpdate.id));
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
              await tx
                .delete(recipeSectionIngredient)
                .where(eq(recipeSectionIngredient.id, ingToDelete.id));
            }
          }

          // Handle instruction updates
          if (sectionUpdate.instructions) {
            // Since instructions are stored as a JSON array, we update the entire array
            const instructionsJson = sectionUpdate.instructions.map((inst) => ({
              text: inst.instruction,
            }));

            await tx
              .update(recipeSection)
              .set({ instructions: instructionsJson })
              .where(eq(recipeSection.id, sectionUpdate.id));
          }
        }

        // If we are doing partial update with specific section IDs, remove any sections not referenced
        if (sectionIdsInUpdate.length > 0) {
          const sectionsToDelete = existingRecipe.sections
            .map((s) => s.id)
            .filter((sid) => !sectionIdsInUpdate.includes(sid));
          if (sectionsToDelete.length > 0) {
            // Delete their ingredients first, then the sections
            await tx
              .delete(recipeSectionIngredient)
              .where(
                inArray(
                  recipeSectionIngredient.recipeSectionId,
                  sectionsToDelete,
                ),
              );
            await tx
              .delete(recipeSection)
              .where(inArray(recipeSection.id, sectionsToDelete));
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
