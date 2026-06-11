/**
 * Recipe update helper functions.
 * Private helpers used by updateRecipe in crud.ts.
 */

import type { amount } from "@cubby/schemas/codec";
import type { RecipeId } from "@cubby/schemas/identifiers";
import type {
  RecipeUpdateInput,
  RecipeYield,
  recipeIngredientInput,
} from "@cubby/schemas/recipe";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { DrizzleTransaction } from "~/server/db";
import {
  image,
  ingredient,
  recipe,
  recipeImage,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { insertAndReturn } from "~/server/repo/database-helpers";

import type { ExistingRecipeWithSections } from "./internal-types";

/**
 * Process a single ingredient input.
 * For regular ingredients, returns the ingredient ID.
 * For recipe references, finds or creates an ingredient pointing to the recipe.
 */
/**
 * Find or create the synthetic `ingredient` row that points at a recipe (the
 * "sub-recipe" link). One per referenced recipe; named `Recipe: <name>`.
 * Rendering auto-detects it as a `type:"recipe"` section ingredient via the
 * `ingredient.recipeId` relation. Shared by `processIngredient` and the cookbook
 * import's reference linking.
 */
export const findOrCreateRecipeLinkIngredient = async (
  tx: DrizzleTransaction,
  recipeId: string,
): Promise<string> => {
  const existing = await tx.query.ingredient.findFirst({
    where: eq(ingredient.recipeId, recipeId),
  });
  if (existing) {
    return existing.id;
  }

  const recipeRecord = await tx.query.recipe.findFirst({
    where: eq(recipe.id, recipeId),
    columns: { name: true },
  });
  if (!recipeRecord) {
    throw new Error(`Recipe with ID ${recipeId} not found`);
  }

  const newIngredient = await insertAndReturn(tx, ingredient, {
    name: `Recipe: ${recipeRecord.name}`,
    aliases: [],
    recipeId,
  });
  return newIngredient.id;
};

type ProcessedIngredient = {
  ingredientId: string;
  amounts: z.infer<typeof amount>[];
  rawLine: string | null;
  modifier: string | null;
};

const processIngredient = async (
  tx: DrizzleTransaction,
  ingredientInput: z.infer<typeof recipeIngredientInput>,
): Promise<ProcessedIngredient> => {
  // Provenance (raw import line + parser modifier) rides along on both branches;
  // null when the input came from a manual/UI edit rather than an import.
  const provenance = {
    rawLine: ingredientInput.rawLine ?? null,
    modifier: ingredientInput.modifier ?? null,
  };

  // For ingredient types, just use the ingredient ID directly
  if (ingredientInput.type === "ingredient") {
    return {
      ingredientId: ingredientInput.ingredientId as string,
      amounts: ingredientInput.amounts,
      ...provenance,
    };
  }

  // For recipe types, find or create an ingredient that points to the recipe
  return {
    ingredientId: await findOrCreateRecipeLinkIngredient(
      tx,
      ingredientInput.recipeId,
    ),
    amounts: ingredientInput.amounts,
    ...provenance,
  };
};

/**
 * Process multiple ingredients.
 */
export const processIngredients = async (
  tx: DrizzleTransaction,
  ingredients: z.infer<typeof recipeIngredientInput>[],
): Promise<ProcessedIngredient[]> => {
  return await Promise.all(
    ingredients.map((ing) => processIngredient(tx, ing)),
  );
};

/**
 * The single source of truth for a `RecipeSectionIngredient` insert row. Every
 * insert site (create, replace-all, section add) goes through here, so the
 * column set — notably the `rawLine`/`modifier` provenance — lives in one place
 * and a new column can't be silently dropped by a missed call site.
 */
export const sectionIngredientValues = (
  recipeSectionId: string,
  ing: {
    ingredientId: string | null;
    amounts: z.infer<typeof amount>[];
    rawLine?: string | null;
    modifier?: string | null;
  },
  sortOrder: number,
) => ({
  recipeSectionId,
  ingredientId: ing.ingredientId as string,
  amounts: ing.amounts,
  rawLine: ing.rawLine ?? null,
  modifier: ing.modifier ?? null,
  sortOrder,
});

/**
 * Update recipe name and source metadata.
 */
export async function updateRecipeBasicProperties(
  tx: DrizzleTransaction,
  recipeId: RecipeId,
  updates: RecipeUpdateInput["data"],
  existingRecipe: ExistingRecipeWithSections,
): Promise<void> {
  const hasBasicUpdates =
    updates.name ||
    updates.meta !== undefined ||
    updates.yield !== undefined ||
    updates.servings !== undefined ||
    updates.tags !== undefined ||
    updates.notes !== undefined;

  if (!hasBasicUpdates) return;

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
    yield?: RecipeYield | null;
    servings?: number | null;
    tags?: string[] | null;
    notes?: string | null;
  } = {};

  if (updates.name) {
    updateData.name = updates.name;
  }
  if (updates.meta !== undefined) {
    updateData.SourceType = sourceType;
    updateData.SourceData = sourceData;
  }
  if (updates.yield !== undefined) {
    updateData.yield = updates.yield;
  }
  if (updates.servings !== undefined) {
    updateData.servings = updates.servings;
  }
  if (updates.tags !== undefined) {
    updateData.tags = updates.tags;
  }
  if (updates.notes !== undefined) {
    updateData.notes = updates.notes;
  }

  await tx.update(recipe).set(updateData).where(eq(recipe.id, recipeId));
}

/**
 * Add new images and remove requested images.
 */
export async function updateRecipeImages(
  tx: DrizzleTransaction,
  recipeId: RecipeId,
  updates: RecipeUpdateInput["data"],
): Promise<void> {
  // Add new images if provided
  if (updates.pendingImageIds && updates.pendingImageIds.length > 0) {
    await tx.insert(recipeImage).values(
      updates.pendingImageIds.map((imageId) => ({
        recipeId,
        imageId,
      })),
    );
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
          eq(recipeImage.recipeId, recipeId),
          inArray(recipeImage.imageId, updates.removeImageIds),
        ),
      );
  }
}

/**
 * Hard-delete the given sections and their ingredients.
 *
 * Section replacement is internal churn, not a user-facing entity deletion, so both
 * recipe-mutation paths (updateRecipe via handleSectionUpdates, and upsertRecipe) use
 * this hard delete to keep their semantics consistent and avoid accumulating dead rows.
 * Ingredients are deleted first to respect the recipeSectionId foreign key.
 */
export async function deleteAllSections(
  tx: DrizzleTransaction,
  sectionIds: string[],
): Promise<void> {
  if (sectionIds.length === 0) return;

  await tx
    .delete(recipeSectionIngredient)
    .where(inArray(recipeSectionIngredient.recipeSectionId, sectionIds));
  await tx.delete(recipeSection).where(inArray(recipeSection.id, sectionIds));
}

/**
 * Create a new recipe section with ingredients.
 */
async function createSectionWithIngredients(
  tx: DrizzleTransaction,
  recipeId: RecipeId,
  sectionInput: NonNullable<RecipeUpdateInput["data"]["sections"]>[number],
  sortOrder: number,
): Promise<void> {
  const processedIngredients = sectionInput.ingredients
    ? await processIngredients(tx, sectionInput.ingredients)
    : [];

  const createdSection = await insertAndReturn(tx, recipeSection, {
    recipeId,
    name: sectionInput.name || null,
    sortOrder,
    instructions: sectionInput.instructions
      ? sectionInput.instructions.map((inst) => ({ text: inst.instruction }))
      : [],
  });

  if (processedIngredients.length > 0) {
    await tx
      .insert(recipeSectionIngredient)
      .values(
        processedIngredients.map((ing, i) =>
          sectionIngredientValues(createdSection.id, ing, i),
        ),
      );
  }
}

/**
 * Update an existing section's ingredients.
 */
async function updateSectionIngredients(
  tx: DrizzleTransaction,
  sectionId: string,
  ingredientUpdates: NonNullable<
    NonNullable<RecipeUpdateInput["data"]["sections"]>[number]["ingredients"]
  >,
  existingIngredients: Array<typeof recipeSectionIngredient.$inferSelect>,
): Promise<void> {
  // Batch process all ingredients in parallel
  const processedIngredients = await processIngredients(tx, ingredientUpdates);

  // Separate new vs existing ingredients for batch operations
  const newIngredients: ReturnType<typeof sectionIngredientValues>[] = [];
  const updatePromises: Promise<unknown>[] = [];

  for (let i = 0; i < ingredientUpdates.length; i++) {
    const ingredientUpdate = ingredientUpdates[i];
    const processedIngredient = processedIngredients[i];

    if (!ingredientUpdate.id) {
      // Collect new ingredients for batch insert
      newIngredients.push(
        sectionIngredientValues(sectionId, processedIngredient, i),
      );
    } else {
      // Queue update for parallel execution
      updatePromises.push(
        tx
          .update(recipeSectionIngredient)
          .set({
            ingredientId: processedIngredient.ingredientId,
            amounts: processedIngredient.amounts,
            // Omit (undefined) rather than null so a manual edit doesn't erase
            // the provenance captured at import time.
            rawLine: processedIngredient.rawLine ?? undefined,
            modifier: processedIngredient.modifier ?? undefined,
            sortOrder: i,
          })
          .where(eq(recipeSectionIngredient.id, ingredientUpdate.id)),
      );
    }
  }

  // Batch insert new ingredients
  if (newIngredients.length > 0) {
    await tx.insert(recipeSectionIngredient).values(newIngredients);
  }

  // Execute updates in parallel
  if (updatePromises.length > 0) {
    await Promise.all(updatePromises);
  }

  // Batch delete ingredients that weren't included in the update
  const updatedIngredientIds = ingredientUpdates
    .filter((ing) => ing.id)
    .map((ing) => ing.id!);

  const ingredientsToDelete = existingIngredients.filter(
    (ing) => !updatedIngredientIds.includes(ing.id),
  );

  if (ingredientsToDelete.length > 0) {
    const idsToDelete = ingredientsToDelete.map((ing) => ing.id);
    await tx
      .delete(recipeSectionIngredient)
      .where(inArray(recipeSectionIngredient.id, idsToDelete));
  }
}

/**
 * Update an existing recipe section.
 */
async function updateExistingSection(
  tx: DrizzleTransaction,
  sectionUpdate: NonNullable<RecipeUpdateInput["data"]["sections"]>[number] & {
    id: string;
  },
  existingSection: ExistingRecipeWithSections["sections"][number],
  sortOrder: number,
): Promise<void> {
  // Always stamp the section's position from its index in the update array —
  // this is what persists reorders (and backfills legacy null rows on edit).
  await tx
    .update(recipeSection)
    .set({
      sortOrder,
      ...(sectionUpdate.name !== undefined ? { name: sectionUpdate.name } : {}),
    })
    .where(eq(recipeSection.id, sectionUpdate.id));

  // Handle ingredient updates
  if (sectionUpdate.ingredients) {
    await updateSectionIngredients(
      tx,
      sectionUpdate.id,
      sectionUpdate.ingredients,
      existingSection.ingredients,
    );
  }

  // Handle instruction updates
  if (sectionUpdate.instructions) {
    const instructionsJson = sectionUpdate.instructions.map((inst) => ({
      text: inst.instruction,
    }));
    await tx
      .update(recipeSection)
      .set({ instructions: instructionsJson })
      .where(eq(recipeSection.id, sectionUpdate.id));
  }
}

/**
 * Handle all section updates (create, update, delete).
 */
export async function handleSectionUpdates(
  tx: DrizzleTransaction,
  recipeId: RecipeId,
  sectionUpdates: NonNullable<RecipeUpdateInput["data"]["sections"]>,
  existingRecipe: ExistingRecipeWithSections,
): Promise<void> {
  const sectionIdsInUpdate = sectionUpdates
    .map((s) => s.id)
    .filter((sectionId): sectionId is string => Boolean(sectionId));

  // If no IDs are provided, treat as full replacement: delete all existing sections first
  if (sectionIdsInUpdate.length === 0) {
    await deleteAllSections(
      tx,
      existingRecipe.sections.map((s) => s.id),
    );
  }

  for (const [i, sectionUpdate] of sectionUpdates.entries()) {
    if (!sectionUpdate.id) {
      // Create new section
      await createSectionWithIngredients(tx, recipeId, sectionUpdate, i);
    } else {
      // Update existing section
      const existingSection = existingRecipe.sections.find(
        (s) => s.id === sectionUpdate.id,
      );

      if (!existingSection) {
        throw new Error(
          `Section with ID ${sectionUpdate.id} not found in recipe ${recipeId}`,
        );
      }

      await updateExistingSection(
        tx,
        { ...sectionUpdate, id: sectionUpdate.id },
        existingSection,
        i,
      );
    }
  }

  // If we are doing partial update with specific section IDs, remove any sections not referenced
  if (sectionIdsInUpdate.length > 0) {
    const sectionsToDelete = existingRecipe.sections
      .map((s) => s.id)
      .filter((sid) => !sectionIdsInUpdate.includes(sid));
    await deleteAllSections(tx, sectionsToDelete);
  }
}
