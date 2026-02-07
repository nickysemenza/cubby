import type { IngredientWithRecipesAndProductOut } from "@cubby/schemas/combo";
import type { ActorContext } from "@cubby/schemas/context";
import {
  type IngredientId,
  unsafeIngredientId,
  unsafeProductId,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type { ingredientBase } from "@cubby/schemas/ingredient";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import {
  and,
  arrayOverlaps,
  count,
  eq,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { z } from "zod";
import { getSortableFields } from "~/entities/entities";
import { dedupe } from "~/misc/array-helpers";
import { createAppError } from "~/server/api/trpc";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  type image,
  ingredient,
  product,
  type productUnitMappings,
  type recipe,
  type recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import {
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  addProductSourceMetadata,
  buildOrderBy,
  executeListQueryWithCount,
  extractImagesFromJoinTable,
  formatSearchTerm,
  getDb,
  insertAndReturn,
  lockAndValidateForDelete,
  mapRelation,
  notDeleted,
  relations,
  unwrapDb,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { dbRecipeToAPIShallow } from "./recipe";

export const mergeIngredients = async (
  db: Database,
  target: IngredientId,
  aliases: IngredientId[],
) => {
  return await withTransaction(db, async (tx) => {
    const targetRec = await tx.query.ingredient.findFirst({
      where: eq(ingredient.id, target),
    });

    if (!targetRec) {
      throw createAppError(
        "INGREDIENT_NOT_FOUND",
        `Target ingredient ${target} not found`,
      );
    }

    const aliasRecs = await tx.query.ingredient.findMany({
      where: and(inArray(ingredient.id, aliases), notDeleted(ingredient)),
    });

    // update target ingredient to have new aliases
    await tx
      .update(ingredient)
      .set({
        aliases: dedupe([
          ...targetRec.aliases,
          ...aliasRecs.map((a) => a.name),
          ...aliasRecs.flatMap((a) => a.aliases ?? []),
        ]),
      })
      .where(eq(ingredient.id, target));

    // update all recipeSectionIngredients to point to the target
    await tx
      .update(recipeSectionIngredient)
      .set({
        ingredientId: target,
      })
      .where(inArray(recipeSectionIngredient.ingredientId, aliases));

    // delete stale
    await tx.delete(ingredient).where(inArray(ingredient.id, aliases));
  });
};

type IngredientDeepDB = typeof ingredient.$inferSelect & {
  Product: Array<
    typeof product.$inferSelect & {
      unitMappings: Array<typeof productUnitMappings.$inferSelect>;
      images: Array<{
        image: typeof image.$inferSelect;
      }>;
    }
  >;
  Recipe: typeof recipe.$inferSelect | null;
  RecipeSectionIngredient: Array<
    typeof recipeSectionIngredient.$inferSelect & {
      recipeSection: typeof recipeSection.$inferSelect & {
        recipe: typeof recipe.$inferSelect;
      };
    }
  >;
};

const dbIngredientToAPI = async (
  _db: Database | DrizzleTransaction,
  ingredientData: IngredientDeepDB,
): Promise<IngredientWithRecipesAndProductOut> => {
  const { Product, Recipe, RecipeSectionIngredient, ...restOfIngredient } =
    ingredientData;

  const productWithMappings = mapRelation(Product, (prod) => {
    const { ingredientId: _ingredientId, ...prodRest } = prod;
    return {
      ...prodRest,
      id: unsafeProductId(prod.id),
      shortcode: unsafeProductShortcode(prod.shortcode),
      images: extractImagesFromJoinTable(prod.images),
      unitMappings: addProductSourceMetadata(prod.id, prod.unitMappings),
    };
  });

  return {
    ...restOfIngredient,
    id: unsafeIngredientId(restOfIngredient.id),
    recipe: Recipe ? dbRecipeToAPIShallow(Recipe) : null,
    product: productWithMappings,
    appearsInRecipes: mapRelation(RecipeSectionIngredient, (section) =>
      dbRecipeToAPIShallow(section.recipeSection.recipe),
    ),
  };
};

export const getIngredientByID = async (db: Database, id: IngredientId) => {
  const ingredientData = await getDb(db).query.ingredient.findFirst({
    where: and(eq(ingredient.id, id), notDeleted(ingredient)),
    ...relations.ingredient.full,
  });

  if (!ingredientData) {
    throw createAppError("INGREDIENT_NOT_FOUND", `Ingredient ${id} not found`);
  }

  return await dbIngredientToAPI(db, ingredientData);
};

export const getIngredientByName = async (db: Database, name: string) => {
  const res = await getDb(db).query.ingredient.findFirst({
    where: buildIngredientWhere(true, name),
    ...relations.ingredient.full,
  });
  return res ? await dbIngredientToAPI(db, res) : null;
};

export const createIngredient = async (
  db: Database | DrizzleTransaction,
  data: z.infer<typeof ingredientBase>,
  actor: ActorContext,
): Promise<IngredientWithRecipesAndProductOut> => {
  const newIngredient = await insertAndReturn(db, ingredient, {
    name: data.name,
    aliases: data.aliases || [],
  });

  // Log audit entry
  await logAuditEntry(db, actor, {
    entityType: "ingredient",
    entityId: newIngredient.id,
    action: "create",
  });

  const ingredientData = await unwrapDb(db).query.ingredient.findFirst({
    where: eq(ingredient.id, newIngredient.id),
    ...relations.ingredient.full,
  });

  if (!ingredientData) {
    throw new Error("Failed to fetch created ingredient");
  }

  return await dbIngredientToAPI(db, ingredientData);
};

export const updateIngredient = async (
  db: Database,
  id: IngredientId,
  data: Partial<z.infer<typeof ingredientBase>>,
  actor: ActorContext,
): Promise<IngredientWithRecipesAndProductOut> => {
  // Capture before state for audit logging
  const beforeState = await getDb(db).query.ingredient.findFirst({
    where: eq(ingredient.id, id),
  });

  const updated = await updateAndReturn(
    db,
    ingredient,
    data,
    eq(ingredient.id, id),
  );

  // Log audit entry with changes
  if (beforeState) {
    const changes = computeChanges(beforeState, updated, ["name", "aliases"]);
    if (changes) {
      await logAuditEntry(db, actor, {
        entityType: "ingredient",
        entityId: id,
        action: "update",
        changes,
      });
    }
  }

  const ingredientData = await getDb(db).query.ingredient.findFirst({
    where: eq(ingredient.id, updated.id),
    ...relations.ingredient.full,
  });

  if (!ingredientData) {
    throw new Error("Failed to fetch updated ingredient");
  }

  return await dbIngredientToAPI(db, ingredientData);
};

export const findOrCreateIngredient = async (
  db: Database | DrizzleTransaction,
  name: string,
  aliases?: string[],
) => {
  const findOrCreate = async (): Promise<typeof ingredient.$inferSelect> => {
    const existing = await unwrapDb(db).query.ingredient.findFirst({
      where: buildIngredientWhere(true, name, aliases),
    });
    if (existing) {
      return existing;
    }

    return await insertAndReturn(db, ingredient, {
      name: name,
      aliases: aliases || [],
    });
  };

  const entry = await findOrCreate();

  // add in aliases, but dedupe and make sure they don't include the name
  const aliasesToAdd = aliases
    ?.filter((alias) => alias !== name)
    ?.filter((alias) => !entry.aliases.includes(alias));

  if (aliasesToAdd === undefined || aliasesToAdd.length === 0) {
    return entry;
  }

  return await updateAndReturn(
    db,
    ingredient,
    {
      name: name,
      aliases: [...entry.aliases, ...aliasesToAdd],
    },
    eq(ingredient.id, entry.id),
  );
};

// exact:
//  true -> exact match on name or aliases
//  false -> search on name, exact match on aliases
const buildIngredientWhere = (
  exact: boolean,
  name: string,
  otherSearchNames?: string[],
) => {
  const list = [name, ...(otherSearchNames ?? [])];

  const conditions = [];

  // Name or aliases condition
  if (exact) {
    // Exact match: name IN list OR aliases has any of list
    conditions.push(
      or(
        inArray(
          sql`lower(${ingredient.name})`,
          list.map((n) => n.toLowerCase()),
        ),
        arrayOverlaps(ingredient.aliases, list),
      ),
    );
  } else {
    // Search on name (ilike), exact match on aliases
    conditions.push(
      or(
        formatSearchTerm(ingredient.name, name),
        arrayOverlaps(ingredient.aliases, list),
      ),
    );
  }

  // Filter for standalone ingredients only, not recipe ingredients
  conditions.push(isNull(ingredient.recipeId));

  // Filter out deleted items
  conditions.push(notDeleted(ingredient));

  return and(...conditions);
};

export const ingredientList = async (
  db: Database,
  name: string | undefined,
  sort: SortParams,
  pagination: PaginationParams,
  missingProductsOnly: boolean = false,
) => {
  // Always filter out deleted items and recipe ingredients
  const conditions = [isNull(ingredient.recipeId), notDeleted(ingredient)];

  // Add name filter if provided
  if (name) {
    const nameCondition = buildIngredientWhere(false, name);
    if (nameCondition) {
      conditions.push(nameCondition);
    }
  }

  // For missing products filter, we need to use a left join and check for null
  const whereClause = and(...conditions);

  // Build order by using central sortableFields config
  const orderByClause = buildOrderBy(ingredient, sort, [
    ...getSortableFields("ingredient"),
  ]);

  const { take, skip } = buildTakeSkip(pagination);

  if (missingProductsOnly) {
    // Use a subquery to find ingredients with no products
    const ingredientsWithNoProducts = getDb(db)
      .select({ id: ingredient.id })
      .from(ingredient)
      .leftJoin(product, eq(product.ingredientId, ingredient.id))
      .where(and(whereClause, isNull(product.id)))
      .groupBy(ingredient.id)
      .as("filtered");

    const { data: results, count: totalCount } =
      await executeListQueryWithCount(
        getDb(db).query.ingredient.findMany({
          where: inArray(
            ingredient.id,
            getDb(db)
              .select({ id: ingredientsWithNoProducts.id })
              .from(ingredientsWithNoProducts),
          ),
          ...relations.ingredient.full,
          orderBy: orderByClause,
          limit: take,
          offset: skip,
        }),
        getDb(db)
          .select({ count: count() })
          .from(ingredient)
          .leftJoin(product, eq(product.ingredientId, ingredient.id))
          .where(and(whereClause, isNull(product.id))),
      );

    const ingredients = await Promise.all(
      results.map((ing) => dbIngredientToAPI(db, ing)),
    );

    return { data: ingredients, count: totalCount };
  } else {
    // Normal query without missing products filter
    const { data: results, count: totalCount } =
      await executeListQueryWithCount(
        getDb(db).query.ingredient.findMany({
          where: whereClause,
          ...relations.ingredient.full,
          orderBy: orderByClause,
          limit: take,
          offset: skip,
        }),
        getDb(db)
          .select({ count: count() })
          .from(ingredient)
          .where(whereClause),
      );

    const ingredients = await Promise.all(
      results.map((ing) => dbIngredientToAPI(db, ing)),
    );

    return { data: ingredients, count: totalCount };
  }
};

/**
 * Soft delete ingredients by setting deletedAt timestamp.
 * Throws if any ingredient is used in recipes or linked to products.
 */
export const deleteIngredients = async (
  db: Database,
  ids: IngredientId[],
  actor: ActorContext,
): Promise<void> => {
  if (ids.length === 0) return;

  // Perform safety checks and soft delete in a transaction for atomicity
  await withTransaction(db, async (tx) => {
    // Lock ingredients and validate they exist and aren't already deleted
    // Prevents race conditions by acquiring row-level locks
    await lockAndValidateForDelete(tx, ingredient, ids, "Ingredient");

    // Safety check: don't delete if any are used in recipes
    const usedInRecipes = await tx.query.recipeSectionIngredient.findMany({
      where: and(
        inArray(recipeSectionIngredient.ingredientId, ids),
        notDeleted(recipeSectionIngredient),
      ),
      columns: { ingredientId: true },
    });
    if (usedInRecipes.length > 0) {
      const failedIngredientIds = dedupe(
        usedInRecipes.map((r) => r.ingredientId),
      );
      const failedIngredients = await tx.query.ingredient.findMany({
        where: inArray(ingredient.id, failedIngredientIds),
        columns: { id: true, name: true },
      });
      const names = failedIngredients.map((i) => i.name).join(", ");
      const count = failedIngredients.length;
      throw createAppError(
        "INGREDIENT_HAS_RECIPES",
        `Cannot delete ${count} ingredient(s): ${names} are used in recipes.`,
      );
    }

    // Safety check: don't delete if any are linked to products
    const linkedProducts = await tx.query.product.findMany({
      where: and(inArray(product.ingredientId, ids), notDeleted(product)),
      columns: { ingredientId: true },
    });
    if (linkedProducts.length > 0) {
      const failedIngredientIds = dedupe(
        linkedProducts
          .map((p) => p.ingredientId)
          .filter((id): id is string => id !== null),
      );
      const failedIngredients = await tx.query.ingredient.findMany({
        where: inArray(ingredient.id, failedIngredientIds as string[]),
        columns: { id: true, name: true },
      });
      const names = failedIngredients.map((i) => i.name).join(", ");
      const count = failedIngredients.length;
      throw createAppError(
        "INGREDIENT_HAS_PRODUCTS",
        `Cannot delete ${count} ingredient(s): ${names} have linked products.`,
      );
    }

    const now = new Date();

    await tx
      .update(ingredient)
      .set({ deletedAt: now })
      .where(inArray(ingredient.id, ids));

    // Log audit entries - no cascaded items for ingredients (batch operation)
    const auditEntries = ids.map((id) => ({
      entityType: "ingredient" as const,
      entityId: id,
      action: "delete" as const,
    }));

    await logAuditEntries(tx, actor, auditEntries);
  });
};
