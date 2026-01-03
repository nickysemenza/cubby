import { and, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import type { amount, CompactRecipe } from "~/codec/codec";
import { parseCompactRecipe } from "~/codec/parser";
import { getSortableFields } from "~/entities/entities";
import { generateRecipeShortcode } from "~/lib/shortcode";
import type { ActorContext } from "~/schemas/context";
import {
  type RecipeId,
  unsafeIngredientId,
  unsafeRecipeId,
} from "~/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "~/schemas/pagination";
import type {
  RecipeCreateInput,
  RecipeOut,
  RecipeUpdateInput,
  RecipeYield,
  recipeIngredientInput,
  recipeTopLevel,
  SectionIngredient,
} from "~/schemas/recipe";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  image,
  ingredient,
  recipe,
  recipeImage,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  associatePendingImages,
  batchInsert,
  buildOrderBy,
  executeListQueryWithCount,
  extractImagesFromJoinTable,
  formatSearchTerm,
  getDb,
  insertAndReturn,
  relations,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { upsertRecipeFromCompact } from "./compactrecipe";

export const getRecipeByID = async (
  db: Database | DrizzleTransaction,
  id: RecipeId,
): Promise<RecipeOut | null> => {
  const res = await unwrapDb(db).query.recipe.findFirst({
    where: eq(recipe.id, id),
    ...relations.recipe.full,
  });
  return res === null || res === undefined ? null : dbRecipeToAPI(res);
};

/**
 * Generate a unique recipe shortcode, with collision retry.
 */
const generateUniqueRecipeShortcode = async (
  db: Database | DrizzleTransaction,
): Promise<string> => {
  const MAX_RETRIES = 10;
  for (let i = 0; i < MAX_RETRIES; i++) {
    const code = generateRecipeShortcode();
    const existing = await unwrapDb(db).query.recipe.findFirst({
      where: eq(recipe.shortcode, code),
      columns: { id: true },
    });
    if (!existing) {
      return code;
    }
  }
  throw new Error(
    "Failed to generate unique recipe shortcode after max retries",
  );
};

/**
 * Find a recipe by shortcode and return its ID.
 */
export const findRecipeByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<RecipeId | null> => {
  const rec = await getDb(db).query.recipe.findFirst({
    where: eq(recipe.shortcode, shortcode.toUpperCase()),
    columns: { id: true },
  });
  return rec ? unsafeRecipeId(rec.id) : null;
};

/**
 * Get a recipe by shortcode.
 */
export const getRecipeByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<RecipeOut | null> => {
  const recipeId = await findRecipeByShortcode(db, shortcode);
  if (!recipeId) {
    return null;
  }
  return getRecipeByID(db, recipeId);
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
  if (sectionIngredient.ingredient?.Recipe) {
    return {
      ...sectionIngredient,
      type: "recipe",
      recipe: dbRecipeToAPIShallow(sectionIngredient.ingredient.Recipe),
      ingredient: null,
      amounts: sectionIngredient.amounts,
    };
  } else {
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

  return {
    ...restOfRecipe,
    meta: {
      url: SourceType === "Website" ? SourceData : null,
    },
    images: extractImagesFromJoinTable(images),
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
  actor: ActorContext,
) => {
  const parsed = parseCompactRecipe(recipe);
  return upsertRecipeFromCompact(parsed, db, actor);
};

/** Filters for recipe list queries */
interface RecipeFilters {
  nameFilter?: string;
}

export const recipeList = async (
  db: Database,
  filters: RecipeFilters,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  const dbClient = getDb(db);

  // Build where conditions
  const whereConditions = [
    filters.nameFilter
      ? formatSearchTerm(recipe.name, filters.nameFilter)
      : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  const whereClause =
    whereConditions.length > 0 ? and(...whereConditions) : undefined;

  // Build orderBy using central sortableFields config
  const orderByClause = buildOrderBy(recipe, sort, [
    ...getSortableFields("recipe"),
  ]);

  const { take, skip } = buildTakeSkip(pagination);

  // Execute both queries and transform results
  const { data: results, count: totalCount } = await executeListQueryWithCount(
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
  );

  const items = results.map(dbRecipeToAPI);
  return { data: items, count: totalCount };
};

export const createRecipe = async (
  db: Database,
  recipeInput: RecipeCreateInput,
  actor: ActorContext,
): Promise<RecipeOut> => {
  const sourceType = recipeInput.meta?.url ? "Website" : "Other";
  const sourceData = recipeInput.meta?.url || null;
  const { pendingImageIds } = recipeInput;

  // Create the recipe in a transaction
  return await withTransaction(db, async (tx) => {
    // Generate unique shortcode
    const shortcode = await generateUniqueRecipeShortcode(tx);

    // Process all ingredients first
    const processedSections = await Promise.all(
      recipeInput.sections.map(async (section) => {
        const processedIngredients = section.ingredients
          ? await processIngredients(tx, section.ingredients)
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
      name: recipeInput.name,
      shortcode,
      SourceType: sourceType,
      SourceData: sourceData,
      yield: recipeInput.yield ?? null,
      servings: recipeInput.servings ?? null,
      tags: recipeInput.tags ?? null,
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
      await associatePendingImages(
        tx,
        recipeImage,
        "recipeId",
        createdRecipe.id,
        pendingImageIds,
      );
    }

    // Log audit entry
    await logAuditEntry(tx, actor, {
      entityType: "recipe",
      entityId: createdRecipe.id,
      action: "create",
    });

    const fullRecipe = await getRecipeByID(tx, createdRecipe.id as RecipeId);
    if (!fullRecipe) {
      throw new Error("Failed to retrieve created recipe");
    }
    return fullRecipe;
  });
};

// Helper function to process ingredients
const processIngredient = async (
  tx: DrizzleTransaction,
  ingredientInput: z.infer<typeof recipeIngredientInput>,
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
  const newIngredient = await insertAndReturn(tx, ingredient, {
    name: `Recipe: ${recipeRecord.name}`,
    aliases: [],
    recipeId: ingredientInput.recipeId,
  });

  return {
    ingredientId: newIngredient.id,
    amounts: ingredientInput.amounts,
  };
};

// Helper function to process multiple ingredients
const processIngredients = async (
  tx: DrizzleTransaction,
  ingredients: z.infer<typeof recipeIngredientInput>[],
): Promise<{ ingredientId: string; amounts: z.infer<typeof amount>[] }[]> => {
  return await Promise.all(
    ingredients.map((ing) => processIngredient(tx, ing)),
  );
};

export const upsertRecipe = async (
  input: RecipeCreateInput,
  db: Database,
  actor: ActorContext,
): Promise<{ id: string }> => {
  const dbClient = getDb(db);

  // Check if recipe already exists by name
  const existingRecipe = await dbClient.query.recipe.findFirst({
    where: eq(recipe.name, input.name),
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
    const created = await createRecipe(db, input, actor);
    return { id: created.id };
  }
};

// ============================================================================
// Helper functions for updateRecipe
// ============================================================================

type ExistingRecipeWithSections = typeof recipe.$inferSelect & {
  sections: Array<
    typeof recipeSection.$inferSelect & {
      ingredients: Array<typeof recipeSectionIngredient.$inferSelect>;
    }
  >;
};

/** Update recipe name and source metadata */
async function updateRecipeBasicProperties(
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
    updates.tags !== undefined;

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

  await tx.update(recipe).set(updateData).where(eq(recipe.id, recipeId));
}

/** Add new images and remove requested images */
async function updateRecipeImages(
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

/** Delete all sections and their ingredients for a recipe */
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

/** Create a new recipe section with ingredients */
async function createSectionWithIngredients(
  tx: DrizzleTransaction,
  recipeId: RecipeId,
  sectionInput: NonNullable<RecipeUpdateInput["data"]["sections"]>[number],
): Promise<void> {
  const processedIngredients = sectionInput.ingredients
    ? await processIngredients(tx, sectionInput.ingredients)
    : [];

  const createdSection = await insertAndReturn(tx, recipeSection, {
    recipeId,
    name: sectionInput.name || null,
    instructions: sectionInput.instructions
      ? sectionInput.instructions.map((inst) => ({ text: inst.instruction }))
      : [],
  });

  if (processedIngredients.length > 0) {
    await tx.insert(recipeSectionIngredient).values(
      processedIngredients.map((ing) => ({
        recipeSectionId: createdSection.id,
        ingredientId: ing.ingredientId as string,
        amounts: ing.amounts,
      })),
    );
  }
}

/** Update an existing section's ingredients */
async function updateSectionIngredients(
  tx: DrizzleTransaction,
  sectionId: string,
  ingredientUpdates: NonNullable<
    NonNullable<RecipeUpdateInput["data"]["sections"]>[number]["ingredients"]
  >,
  existingIngredients: Array<typeof recipeSectionIngredient.$inferSelect>,
): Promise<void> {
  // Process each ingredient in the update
  for (const ingredientUpdate of ingredientUpdates) {
    const processedIngredient = await processIngredient(tx, ingredientUpdate);

    if (!ingredientUpdate.id) {
      // Create new ingredient
      await tx.insert(recipeSectionIngredient).values({
        recipeSectionId: sectionId,
        ingredientId: processedIngredient.ingredientId,
        amounts: processedIngredient.amounts,
      });
    } else {
      // Update existing ingredient
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
  const updatedIngredientIds = ingredientUpdates
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

/** Update an existing recipe section */
async function updateExistingSection(
  tx: DrizzleTransaction,
  sectionUpdate: NonNullable<RecipeUpdateInput["data"]["sections"]>[number] & {
    id: string;
  },
  existingSection: ExistingRecipeWithSections["sections"][number],
): Promise<void> {
  // Update section name if provided
  if (sectionUpdate.name !== undefined) {
    await tx
      .update(recipeSection)
      .set({ name: sectionUpdate.name })
      .where(eq(recipeSection.id, sectionUpdate.id));
  }

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

/** Handle all section updates (create, update, delete) */
async function handleSectionUpdates(
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

  for (const sectionUpdate of sectionUpdates) {
    if (!sectionUpdate.id) {
      // Create new section
      await createSectionWithIngredients(tx, recipeId, sectionUpdate);
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

// ============================================================================
// Main updateRecipe function
// ============================================================================

// ============================================================================
// Ingredient Co-occurrence Query (for network graph)
// ============================================================================

// Import types from shared schema
import type {
  IngredientCooccurrence,
  IngredientEdge,
  IngredientNode,
} from "~/schemas/ingredient-cooccurrence";

/**
 * Get ingredient co-occurrence data for building a network graph.
 * Returns ingredients as nodes and edges between ingredients that appear together in recipes.
 */
export const getIngredientCooccurrence = async (
  db: Database,
  minEdgeWeight: number = 2,
): Promise<IngredientCooccurrence> => {
  const dbClient = getDb(db);

  // Get all recipes with their ingredients
  const recipes = await dbClient.query.recipe.findMany({
    with: {
      sections: {
        with: {
          ingredients: {
            with: {
              ingredient: true,
            },
          },
        },
      },
    },
  });

  // Build ingredient -> recipe count map and recipe -> ingredients map
  const ingredientRecipeCount = new Map<string, number>();
  const ingredientNames = new Map<string, string>();
  const recipeIngredients = new Map<string, Set<string>>();

  for (const r of recipes) {
    const ingredientIds = new Set<string>();

    for (const section of r.sections) {
      for (const si of section.ingredients) {
        if (si.ingredient && !si.ingredient.recipeId) {
          // Only include regular ingredients, not recipe references
          ingredientIds.add(si.ingredient.id);
          ingredientNames.set(si.ingredient.id, si.ingredient.name);
        }
      }
    }

    // Update recipe count for each ingredient
    for (const ingId of ingredientIds) {
      ingredientRecipeCount.set(
        ingId,
        (ingredientRecipeCount.get(ingId) ?? 0) + 1,
      );
    }

    if (ingredientIds.size > 0) {
      recipeIngredients.set(r.id, ingredientIds);
    }
  }

  // Build co-occurrence matrix (count how many recipes each pair appears in together)
  // Also track which recipes contain each pair
  const cooccurrence = new Map<
    string,
    { count: number; recipes: Array<{ id: string; name: string }> }
  >();

  // Need to also track recipe names
  const recipeNames = new Map<string, string>();
  for (const r of recipes) {
    recipeNames.set(r.id, r.name);
  }

  for (const [recipeId, ingredientIds] of recipeIngredients) {
    const ids = Array.from(ingredientIds);
    const recipeName = recipeNames.get(recipeId) ?? "Unknown";
    // For each pair of ingredients in this recipe
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        // Create a canonical key (sorted to avoid duplicates)
        const key = [ids[i], ids[j]].sort().join("|");
        const existing = cooccurrence.get(key) ?? { count: 0, recipes: [] };
        existing.count += 1;
        existing.recipes.push({ id: recipeId, name: recipeName });
        cooccurrence.set(key, existing);
      }
    }
  }

  // Build nodes array (only include ingredients that have at least one edge)
  const ingredientsWithEdges = new Set<string>();
  const edges: IngredientEdge[] = [];

  for (const [key, data] of cooccurrence) {
    if (data.count >= minEdgeWeight) {
      const [source, target] = key.split("|") as [string, string];
      edges.push({
        source: unsafeIngredientId(source),
        target: unsafeIngredientId(target),
        weight: data.count,
        recipes: data.recipes.map((r) => ({
          id: unsafeRecipeId(r.id),
          name: r.name,
        })),
      });
      ingredientsWithEdges.add(source);
      ingredientsWithEdges.add(target);
    }
  }

  const nodes: IngredientNode[] = [];
  for (const id of ingredientsWithEdges) {
    nodes.push({
      id: unsafeIngredientId(id),
      name: ingredientNames.get(id) ?? "Unknown",
      recipeCount: ingredientRecipeCount.get(id) ?? 0,
    });
  }

  // Sort nodes by recipe count (most used first)
  nodes.sort((a, b) => b.recipeCount - a.recipeCount);

  return { nodes, edges };
};

/**
 * Get all unique tags used across recipes.
 * Used for tag autocomplete suggestions.
 */
export const getAllTags = async (db: Database): Promise<string[]> => {
  const dbClient = getDb(db);

  // Get all recipes with tags
  const recipesWithTags = await dbClient.query.recipe.findMany({
    columns: { tags: true },
  });

  // Collect unique tags
  const tagSet = new Set<string>();
  for (const r of recipesWithTags) {
    if (r.tags) {
      for (const tag of r.tags) {
        tagSet.add(tag);
      }
    }
  }

  // Return sorted array of unique tags
  return Array.from(tagSet).sort();
};

export const updateRecipe = async (
  db: Database,
  id: RecipeId,
  updates: RecipeUpdateInput["data"],
  actor: ActorContext,
): Promise<RecipeOut> => {
  // Check if recipe exists
  const existingRecipe = await getDb(db).query.recipe.findFirst({
    where: eq(recipe.id, id),
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

  // Store before state for audit logging
  const beforeState = { name: existingRecipe.name };

  // Update in a transaction
  return await withTransaction(db, async (tx) => {
    await updateRecipeBasicProperties(tx, id, updates, existingRecipe);
    await updateRecipeImages(tx, id, updates);

    if (updates.sections) {
      await handleSectionUpdates(tx, id, updates.sections, existingRecipe);
    }

    const fullRecipe = await getRecipeByID(tx, id);
    if (!fullRecipe) {
      throw new Error("Failed to retrieve updated recipe");
    }

    // Log audit entry with changes
    const afterState = { name: fullRecipe.name };
    const changes = computeChanges(beforeState, afterState, ["name"]);
    if (changes) {
      await logAuditEntry(tx, actor, {
        entityType: "recipe",
        entityId: id,
        action: "update",
        changes,
      });
    }

    return fullRecipe;
  });
};
