/**
 * Recipe update helper functions.
 * Private helpers used by updateRecipe in crud.ts.
 */

import type { amount } from "@cubby/schemas/codec";
import type {
  CookbookId,
  IngredientId,
  RecipeId,
} from "@cubby/schemas/identifiers";
import type {
  RecipeCreateInput,
  RecipeUpdateInput,
  RecipeYield,
  recipeIngredientInput,
} from "@cubby/schemas/recipe";
import { and, eq, inArray, isNull, ne, notInArray, or } from "drizzle-orm";
import type { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  cookbook,
  ingredient,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  imageJoinBindings,
  insertAndReturn,
  notDeleted,
  syncEntityImages,
  unwrapDb,
} from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { findOrCreateWithShortcode } from "~/server/repo/shortcode-utils";

import type { ExistingRecipeWithSections } from "./internal-types";
import { type RecipeMetaColumns, recipeMetaToColumns } from "./meta";
import { recipeSourceToColumns, webProvenance } from "./source";

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
  //
  // `notDeleted` is what makes the predicate MATCH that partial index rather
  // than merely resemble it. Without it a soft-deleted link row is "found" and
  // reused, re-pointing a live section at a deleted ingredient — a referential
  // liveness violation — even though the index would happily accept a fresh row.
  const { row } = await findOrCreateWithShortcode(db, "ingredient", {
    where: and(eq(ingredient.recipeId, recipeId), notDeleted(ingredient)),
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
 * Resolves an update's `forkedFromRecipeId` shortcode to a live uuid,
 * guarding against a recipe forking from itself. Returns `undefined` when the
 * update didn't touch the field at all — distinct from the `null` that clears
 * it — so the caller can tell "untouched" from "cleared".
 */
async function resolveForkedFromRecipeIdUpdate(
  tx: DrizzleTransaction,
  recipeId: RecipeId,
  forkedFromRecipeId: RecipeUpdateInput["data"]["forkedFromRecipeId"],
): Promise<RecipeId | null | undefined> {
  if (forkedFromRecipeId === null) return null;
  if (forkedFromRecipeId === undefined) return undefined;

  const resolved = await resolveOrThrow(tx, "recipe", forkedFromRecipeId);
  if (resolved === recipeId) {
    throw createAppError(
      "SELF_DEPENDENCY",
      "A recipe cannot be forked from itself.",
    );
  }
  return resolved;
}

/**
 * Update recipe name and source metadata.
 *
 * Returns the resolved `forkedFromRecipeId` (raw uuid) when this call
 * actually touched it, so `updateRecipe`'s audit diff can compare uuids on
 * both sides without a second query.
 */
/** `Recipe.tags` is NOT NULL: a cleared tag list is stored empty. */
const tagsOrEmpty = (tags: string[] | null): string[] => tags ?? [];

/**
 * A `cookbookId` edit re-derives the recipe's provenance the way the importer
 * writes it: a cookbook makes it a Book recipe (the Cookbook row names the
 * book, so the URL and label columns clear); clearing it falls back to a
 * Website recipe when a URL is on file, else Other. Notion recipes are keyed
 * by their page and never belong to a cookbook.
 *
 * Both partial unique indexes are pre-checked so the collision reads as a
 * sentence naming the holder instead of a bare constraint name:
 * `Recipe_cookbookId_name_key` (one title per cookbook) and, once a recipe
 * leaves its cookbook, `Recipe_name_key` (Book and Notion recipes are exempt).
 */
async function resolveCookbookRepoint(
  tx: DrizzleTransaction,
  recipeId: RecipeId,
  updates: RecipeUpdateInput["data"],
  existingRecipe: ExistingRecipeWithSections,
): Promise<ReturnType<typeof recipeSourceToColumns> | undefined> {
  if (updates.cookbookId === undefined) return undefined;
  const cookbookId: CookbookId | null =
    updates.cookbookId === null
      ? null
      : await resolveOrThrow(tx, "cookbook", updates.cookbookId);
  if (cookbookId === existingRecipe.cookbookId) return undefined;
  if (existingRecipe.sourceType === "Notion") {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Recipe ${existingRecipe.shortcode} is synced from Notion, so it cannot be moved into a cookbook.`,
    );
  }
  const name = updates.name || existingRecipe.name;
  if (cookbookId !== null) {
    const holder = await tx.query.recipe.findFirst({
      where: and(
        eq(recipe.cookbookId, cookbookId),
        eq(recipe.name, name),
        ne(recipe.id, recipeId),
        notDeleted(recipe),
      ),
      columns: { shortcode: true },
    });
    if (holder) {
      const book = await tx.query.cookbook.findFirst({
        where: eq(cookbook.id, cookbookId),
        columns: { name: true },
      });
      throw createAppError(
        "DUPLICATE_RECORD",
        `Cookbook "${book?.name ?? cookbookId}" already has a recipe named "${name}" (${holder.shortcode}); rename one of them first.`,
      );
    }
    return recipeSourceToColumns({
      sourceType: "Book",
      sourceData: null,
      cookbookId,
    });
  }
  const holder = await tx.query.recipe.findFirst({
    where: and(
      eq(recipe.name, name),
      ne(recipe.id, recipeId),
      notDeleted(recipe),
      or(
        isNull(recipe.sourceType),
        notInArray(recipe.sourceType, ["Book", "Notion"]),
      ),
    ),
    columns: { shortcode: true },
  });
  if (holder) {
    throw createAppError(
      "DUPLICATE_RECORD",
      `Removing the cookbook would give this recipe the same name as ${holder.shortcode} ("${name}"); rename it first.`,
    );
  }
  return recipeSourceToColumns(
    webProvenance(updates.meta?.url ?? existingRecipe.sourceUrl),
  );
}

const hasBasicUpdates = (updates: RecipeUpdateInput["data"]): boolean =>
  Boolean(updates.name) ||
  [
    updates.meta,
    updates.yield,
    updates.servings,
    updates.tags,
    updates.notes,
    updates.forkedFromRecipeId,
    updates.cookbookId,
  ].some((value) => value !== undefined);

export async function updateRecipeBasicProperties(
  tx: DrizzleTransaction,
  recipeId: RecipeId,
  updates: RecipeUpdateInput["data"],
  existingRecipe: ExistingRecipeWithSections,
): Promise<{ forkedFromRecipeId?: RecipeId | null }> {
  if (!hasBasicUpdates(updates)) return {};

  // Lineage pointer only ("Recipe.forkedFromRecipeId" — see
  // RECIPE_DELETE_EDGE_POLICY in crud.ts).
  const forkedFromRecipeId = await resolveForkedFromRecipeIdUpdate(
    tx,
    recipeId,
    updates.forkedFromRecipeId,
  );

  // A url edit re-derives Website provenance; without one the existing
  // sourceType is preserved (a manual edit must not clobber Book/Notion, whose
  // book and page identity live outside `sourceUrl`).
  const sourceType = updates.meta?.url
    ? webProvenance(updates.meta.url).sourceType
    : existingRecipe.sourceType || "Other";
  const sourceUrl =
    updates.meta?.url !== undefined
      ? updates.meta.url
      : existingRecipe.sourceUrl;

  const cookbookRepoint = await resolveCookbookRepoint(
    tx,
    recipeId,
    updates,
    existingRecipe,
  );

  const updateData: {
    name?: string;
    sourceType?: "Book" | "Website" | "Other" | "Notion";
    sourceUrl?: string | null;
    sourceLabel?: string | null;
    cookbookId?: CookbookId | null;
    yield?: RecipeYield | null;
    servings?: number | null;
    tags?: string[];
    notes?: string | null;
    forkedFromRecipeId?: RecipeId | null;
  } & Partial<RecipeMetaColumns> = {};

  if (updates.name) {
    updateData.name = updates.name;
  }
  if (updates.meta !== undefined) {
    updateData.sourceType = sourceType;
    updateData.sourceUrl = sourceUrl;
    // `meta` is edited as a whole object, so the times/equipment/page columns
    // are rewritten from it wholesale — omitting a time in the submitted meta
    // means "no longer set", exactly like clearing the url.
    Object.assign(updateData, recipeMetaToColumns(updates.meta));
  }
  if (updates.yield !== undefined) {
    updateData.yield = updates.yield;
  }
  if (updates.servings !== undefined) {
    updateData.servings = updates.servings;
  }
  if (updates.tags !== undefined) {
    updateData.tags = tagsOrEmpty(updates.tags);
  }
  if (updates.notes !== undefined) {
    updateData.notes = updates.notes;
  }
  if (forkedFromRecipeId !== undefined) {
    updateData.forkedFromRecipeId = forkedFromRecipeId;
  }
  // After the `meta` branch: an explicit cookbook move owns the provenance.
  if (cookbookRepoint !== undefined) Object.assign(updateData, cookbookRepoint);

  await tx
    .update(recipe)
    .set(updateData)
    .where(and(eq(recipe.id, recipeId), notDeleted(recipe)));

  return { forkedFromRecipeId };
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
  const { detachedImageKeys } = await syncEntityImages(
    tx,
    "recipe",
    imageJoinBindings.recipe,
    recipeId,
    updates,
  );
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
  const values: Partial<typeof recipeSection.$inferInsert> = { sortOrder };
  if (sectionUpdate.name !== undefined) values.name = sectionUpdate.name;
  await tx
    .update(recipeSection)
    .set(values)
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
