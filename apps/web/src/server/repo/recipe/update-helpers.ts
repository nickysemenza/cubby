/**
 * Recipe update helper functions.
 * Private helpers used by updateRecipe in crud.ts.
 */

import type { amount } from "@cubby/schemas/codec";
import type { IngredientId, RecipeId } from "@cubby/schemas/identifiers";
import type {
  RecipeCreateInput,
  RecipeUpdateInput,
  RecipeYield,
  recipeIngredientInput,
} from "@cubby/schemas/recipe";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  ingredient,
  recipe,
  recipeImage,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  applyImageOrder,
  associatePendingImages,
  insertAndReturn,
  nextImageSortOrder,
  notDeleted,
  unwrapDb,
} from "~/server/repo/database-helpers";
import { detachImagesFromEntity } from "~/server/repo/image";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { findOrCreateWithShortcode } from "~/server/repo/shortcode-utils";

import type { ExistingRecipeWithSections } from "./internal-types";
import { webProvenance } from "./source";

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
const findOrCreateRecipeLinkIngredient = async (
  db: Database | DrizzleTransaction,
  recipeId: RecipeId,
): Promise<IngredientId> => {
  // Atomic find-or-create. Identity is recipeId — the `Ingredient_recipeId_key`
  // unique index (partial, WHERE deletedAt IS NULL) backs the race and the match
  // predicate. The name lookup is deferred to the create path via the values
  // thunk. See findOrCreate for the race it closes.
  const { row } = await findOrCreateWithShortcode(db, "ingredient", {
    where: eq(ingredient.recipeId, recipeId),
    values: async () => {
      const recipeRecord = await unwrapDb(db).query.recipe.findFirst({
        where: eq(recipe.id, recipeId),
        columns: { name: true },
      });
      if (!recipeRecord) {
        throw createAppError(
          "RECIPE_NOT_FOUND",
          `Recipe with ID ${recipeId} not found`,
        );
      }
      return {
        name: `Recipe: ${recipeRecord.name}`,
        aliases: [],
        recipeId,
      };
    },
  });
  return row.id;
};

type ProcessedIngredient = {
  ingredientId: IngredientId;
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
    const ingredientId = await resolveOrThrow(
      tx,
      "ingredient",
      ingredientInput.ingredientId,
    );
    return {
      ingredientId,
      amounts: ingredientInput.amounts,
      ...provenance,
    };
  }

  // For recipe types, find or create an ingredient that points to the recipe
  const recipeId = await resolveOrThrow(tx, "recipe", ingredientInput.recipeId);
  return {
    ingredientId: await findOrCreateRecipeLinkIngredient(tx, recipeId),
    amounts: ingredientInput.amounts,
    ...provenance,
  };
};

/**
 * Process multiple ingredients.
 */
const processIngredients = async (
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
const sectionIngredientValues = (
  recipeSectionId: string,
  ing: {
    ingredientId: IngredientId;
    amounts: z.infer<typeof amount>[];
    rawLine?: string | null;
    modifier?: string | null;
  },
  sortOrder: number,
) => ({
  recipeSectionId,
  ingredientId: ing.ingredientId,
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

  // A url edit re-derives Website provenance; without one the existing
  // SourceType is preserved (a manual edit must not clobber Book/Notion).
  const sourceType = updates.meta?.url
    ? webProvenance(updates.meta.url).sourceType
    : existingRecipe.SourceType || "Other";
  const sourceData =
    updates.meta?.url !== undefined
      ? updates.meta.url
      : existingRecipe.SourceData;

  const updateData: {
    name?: string;
    SourceType?: "Book" | "Website" | "Other" | "Notion";
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

  await tx
    .update(recipe)
    .set(updateData)
    .where(and(eq(recipe.id, recipeId), notDeleted(recipe)));
}

/**
 * Add new images, remove requested images, and apply an explicit display
 * order (first = cover). Order is applied before the append so new images
 * always land after the reordered existing set.
 *
 * Returns the R2 keys of images the removal reaped (see
 * {@link detachImagesFromEntity}). They have no rollback, so the caller drops
 * the objects only after its transaction commits.
 */
export async function updateRecipeImages(
  tx: DrizzleTransaction,
  recipeId: RecipeId,
  updates: RecipeUpdateInput["data"],
): Promise<string[]> {
  let detachedImageKeys: string[] = [];

  if (updates.imageOrder && updates.imageOrder.length > 0) {
    await applyImageOrder(
      tx,
      recipeImage,
      recipeImage.recipeId,
      recipeId,
      updates.imageOrder,
    );
  }

  if (updates.removeImageIds && updates.removeImageIds.length > 0) {
    ({ deletedKeys: detachedImageKeys } = await detachImagesFromEntity(
      tx,
      "recipe",
      recipeId,
      updates.removeImageIds,
    ));
  }

  if (updates.pendingImageIds && updates.pendingImageIds.length > 0) {
    const startSortOrder = await nextImageSortOrder(
      tx,
      recipeImage,
      recipeImage.recipeId,
      recipeId,
    );
    await associatePendingImages(
      tx,
      recipeImage,
      "recipeId",
      recipeId,
      updates.pendingImageIds,
      startSortOrder,
    );
  }

  return detachedImageKeys;
}

/**
 * Hard-delete the given sections and their ingredients.
 *
 * Section replacement is internal churn, not a user-facing entity deletion, so both
 * recipe-mutation paths (updateRecipe via handleSectionUpdates, and upsertRecipe) use
 * this hard delete to keep their semantics consistent and avoid accumulating dead rows.
 * Ingredients are deleted first to respect the recipeSectionId foreign key.
 */
async function deleteAllSections(
  tx: DrizzleTransaction,
  sectionIds: string[],
): Promise<void> {
  if (sectionIds.length === 0) return;

  await tx
    .delete(recipeSectionIngredient)
    .where(inArray(recipeSectionIngredient.recipeSectionId, sectionIds));
  await tx.delete(recipeSection).where(inArray(recipeSection.id, sectionIds));
}

export async function createSectionWithIngredients(
  tx: DrizzleTransaction,
  recipeId: RecipeId,
  sectionInput:
    | RecipeCreateInput["sections"][number]
    | NonNullable<RecipeUpdateInput["data"]["sections"]>[number],
  sortOrder: number,
): Promise<void> {
  const processedIngredients = sectionInput.ingredients
    ? await processIngredients(tx, sectionInput.ingredients)
    : [];

  const createdSection = await insertAndReturn(tx, recipeSection, {
    recipeId,
    name: sectionInput.name ?? null,
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
 * Replace a recipe's sections wholesale: hard-delete existing section rows and
 * reinsert the supplied API section shape through the same section-creation path
 * used by create/update. This keeps instruction JSON, ingredient processing, and
 * provenance column handling in one place.
 */
export async function replaceRecipeSections(
  tx: DrizzleTransaction,
  recipeId: RecipeId,
  sections: RecipeCreateInput["sections"],
): Promise<void> {
  const existingSections = await tx.query.recipeSection.findMany({
    where: eq(recipeSection.recipeId, recipeId),
    columns: { id: true },
  });
  await deleteAllSections(
    tx,
    existingSections.map((s) => s.id),
  );

  for (const [i, section] of sections.entries()) {
    await createSectionWithIngredients(tx, recipeId, section, i);
  }
}

async function updateSectionIngredients(
  tx: DrizzleTransaction,
  sectionId: string,
  ingredientUpdates: NonNullable<
    NonNullable<RecipeUpdateInput["data"]["sections"]>[number]["ingredients"]
  >,
  existingIngredients: Array<typeof recipeSectionIngredient.$inferSelect>,
): Promise<void> {
  const processedIngredients = await processIngredients(tx, ingredientUpdates);

  const newIngredients: ReturnType<typeof sectionIngredientValues>[] = [];
  const updatePromises: Promise<unknown>[] = [];

  for (let i = 0; i < ingredientUpdates.length; i++) {
    const ingredientUpdate = ingredientUpdates[i];
    const processedIngredient = processedIngredients[i];
    // Parallel arrays built from the same source; skip rather than risk a
    // partial write if they ever fall out of lockstep.
    if (!ingredientUpdate || !processedIngredient) continue;

    if (!ingredientUpdate.id) {
      newIngredients.push(
        sectionIngredientValues(sectionId, processedIngredient, i),
      );
    } else {
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

  if (newIngredients.length > 0) {
    await tx.insert(recipeSectionIngredient).values(newIngredients);
  }

  if (updatePromises.length > 0) {
    await Promise.all(updatePromises);
  }

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

  if (sectionUpdate.ingredients) {
    await updateSectionIngredients(
      tx,
      sectionUpdate.id,
      sectionUpdate.ingredients,
      existingSection.ingredients,
    );
  }

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
      await createSectionWithIngredients(tx, recipeId, sectionUpdate, i);
    } else {
      const existingSection = existingRecipe.sections.find(
        (s) => s.id === sectionUpdate.id,
      );

      if (!existingSection) {
        throw createAppError(
          "RECIPE_NOT_FOUND",
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
