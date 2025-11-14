import { type Database, type DrizzleTransaction } from "~/server/db";
import { dedupe } from "~/misc/array-helpers";
import { dbRecipeToAPIShallow } from "./recipe";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "~/schemas/pagination";
import { type IngredientWithRecipesAndProductOut } from "~/schemas/combo";
import {
  formatSearchTerm,
  getDb,
  unwrapDb,
  relations,
  buildOrderBy,
  updateAndReturnDb,
} from "~/server/repo/database-helpers";
import { type z } from "zod";
import { ingredientBase } from "~/schemas/ingredient";
import {
  type IngredientId,
  type OrganizationId,
  unsafeProductId,
  unsafeIngredientId,
} from "~/schemas/identifiers";
import {
  ingredient,
  recipeSectionIngredient,
  product,
  productUnitMappings,
  recipe,
  recipeSection,
  image,
} from "~/server/db/schema";
import {
  eq,
  and,
  or,
  inArray,
  isNull,
  sql,
  count,
  arrayOverlaps,
} from "drizzle-orm";

export const mergeIngredients = async (
  db: Database,
  target: IngredientId,
  aliases: IngredientId[],
) => {
  return await getDb(db).transaction(async (tx) => {
    const targetRec = await tx.query.ingredient.findFirst({
      where: eq(ingredient.id, target),
    });

    if (!targetRec) {
      throw new Error(`Target ingredient ${target} not found`);
    }

    const aliasRecs = await tx.query.ingredient.findMany({
      where: inArray(ingredient.id, aliases),
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

/**
 * Type assertion helper for ingredient query results.
 * Safe to use when the query includes relations.ingredient.full,
 * as the runtime shape will match IngredientDeepDB.
 *
 * Accepts a partial ingredient record with at least the id field,
 * which provides some type safety at the call site.
 */
const asIngredientDeepDB = (
  data: typeof ingredient.$inferSelect & Record<string, unknown>,
): IngredientDeepDB => {
  return data as IngredientDeepDB;
};

const dbIngredientToAPI = async (
  db: Database | DrizzleTransaction,
  ingredientData: IngredientDeepDB,
): Promise<IngredientWithRecipesAndProductOut> => {
  const { Product, Recipe, RecipeSectionIngredient, ...restOfIngredient } =
    ingredientData;

  const productWithMappings = Product.map((prod) => {
    return {
      ...prod,
      id: unsafeProductId(prod.id),
      images: prod.images?.map((pi) => pi.image) ?? [],
      unitMappings: prod.unitMappings.map((mapping) => ({
        ...mapping,
        sourceMetadata: {
          type: "product" as const,
          productId: unsafeProductId(prod.id),
        },
      })),
    };
  });

  return {
    ...restOfIngredient,
    id: unsafeIngredientId(restOfIngredient.id),
    recipe: Recipe ? dbRecipeToAPIShallow(Recipe) : null,
    product: productWithMappings,
    appearsInRecipes: RecipeSectionIngredient.map((section) =>
      dbRecipeToAPIShallow(section.recipeSection.recipe),
    ),
  };
};

export const getIngredientByID = async (
  db: Database,
  id: IngredientId,
  organizationId: OrganizationId,
) => {
  const ingredientData = await getDb(db).query.ingredient.findFirst({
    where: and(
      eq(ingredient.id, id),
      eq(ingredient.organizationId, organizationId),
    ),
    ...relations.ingredient.full,
  });

  if (!ingredientData) {
    throw new Error(`Ingredient ${id} not found`);
  }

  return await dbIngredientToAPI(db, asIngredientDeepDB(ingredientData));
};

export const getIngredientByName = async (db: Database, name: string) => {
  const res = await getDb(db).query.ingredient.findFirst({
    where: buildIngredientWhere(true, name),
    ...relations.ingredient.full,
  });
  return res ? await dbIngredientToAPI(db, asIngredientDeepDB(res)) : null;
};

export const createIngredient = async (
  db: Database | DrizzleTransaction,
  data: z.infer<typeof ingredientBase>,
  organizationId: OrganizationId,
): Promise<IngredientWithRecipesAndProductOut> => {
  const [newIngredient] = await unwrapDb(db)
    .insert(ingredient)
    .values({
      organizationId: organizationId,
      name: data.name,
      aliases: data.aliases || [],
    })
    .returning();

  if (!newIngredient) {
    throw new Error("Failed to create ingredient");
  }

  const ingredientData = await unwrapDb(db).query.ingredient.findFirst({
    where: eq(ingredient.id, newIngredient.id),
    ...relations.ingredient.full,
  });

  if (!ingredientData) {
    throw new Error("Failed to fetch created ingredient");
  }

  return await dbIngredientToAPI(db, asIngredientDeepDB(ingredientData));
};

export const updateIngredient = async (
  db: Database,
  id: IngredientId,
  organizationId: OrganizationId,
  data: Partial<z.infer<typeof ingredientBase>>,
): Promise<IngredientWithRecipesAndProductOut> => {
  const updated = await updateAndReturnDb(
    db,
    ingredient,
    data,
    and(eq(ingredient.id, id), eq(ingredient.organizationId, organizationId)),
  );

  const ingredientData = await getDb(db).query.ingredient.findFirst({
    where: eq(ingredient.id, updated.id),
    ...relations.ingredient.full,
  });

  if (!ingredientData) {
    throw new Error("Failed to fetch updated ingredient");
  }

  return await dbIngredientToAPI(db, asIngredientDeepDB(ingredientData));
};

export const findOrCreateIngredient = async (
  db: Database | DrizzleTransaction,
  name: string,
  aliases?: string[],
  organizationId?: string,
) => {
  const findOrCreate = async (): Promise<typeof ingredient.$inferSelect> => {
    const existing = await unwrapDb(db).query.ingredient.findFirst({
      where: buildIngredientWhere(true, name, aliases, organizationId),
    });
    if (existing) {
      return existing;
    }

    const [newIngredient] = await unwrapDb(db)
      .insert(ingredient)
      .values({
        organizationId: organizationId || "default-org",
        name: name,
        aliases: aliases || [],
      })
      .returning();

    if (!newIngredient) {
      throw new Error("Failed to create ingredient");
    }

    return newIngredient;
  };

  const entry = await findOrCreate();

  // add in aliases, but dedupe and make sure they don't include the name
  const aliasesToAdd = aliases
    ?.filter((alias) => alias !== name)
    ?.filter((alias) => !entry.aliases.includes(alias));

  if (aliasesToAdd === undefined || aliasesToAdd.length === 0) {
    return entry;
  }

  const [updated] = await unwrapDb(db)
    .update(ingredient)
    .set({
      name: name,
      aliases: [...entry.aliases, ...aliasesToAdd],
    })
    .where(eq(ingredient.id, entry.id))
    .returning();

  if (!updated) {
    throw new Error("Failed to update ingredient aliases");
  }

  return updated;
};

// exact:
//  true -> exact match on name or aliases
//  false -> search on name, exact match on aliases
const buildIngredientWhere = (
  exact: boolean,
  name: string,
  otherSearchNames?: string[],
  organizationId?: string,
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

  // Add organization filter if provided
  if (organizationId) {
    conditions.push(eq(ingredient.organizationId, organizationId));
  }

  return and(...conditions);
};

export const ingredientList = async (
  db: Database,
  organizationId: OrganizationId,
  name: string | undefined,
  sort: SortParams,
  pagination: PaginationParams,
  missingProductsOnly: boolean = false,
) => {
  const conditions = [
    eq(ingredient.organizationId, organizationId),
    isNull(ingredient.recipeId),
  ];

  // Add name filter if provided
  if (name) {
    const nameCondition = buildIngredientWhere(false, name);
    if (nameCondition) {
      conditions.push(nameCondition);
    }
  }

  // For missing products filter, we need to use a left join and check for null
  const whereClause = and(...conditions);

  // Build order by
  const orderByClause = buildOrderBy(ingredient, sort, [
    "createdAt",
    "name",
    "aliases",
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

    const [results, [countResult]] = await Promise.all([
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
    ]);

    const totalCount = countResult?.count ?? 0;

    const ingredients = await Promise.all(
      results.map((ing) => dbIngredientToAPI(db, asIngredientDeepDB(ing))),
    );

    return { data: ingredients, count: totalCount };
  } else {
    // Normal query without missing products filter
    const [results, [countResult]] = await Promise.all([
      getDb(db).query.ingredient.findMany({
        where: whereClause,
        ...relations.ingredient.full,
        orderBy: orderByClause,
        limit: take,
        offset: skip,
      }),
      getDb(db).select({ count: count() }).from(ingredient).where(whereClause),
    ]);

    const totalCount = countResult?.count ?? 0;

    const ingredients = await Promise.all(
      results.map((ing) => dbIngredientToAPI(db, asIngredientDeepDB(ing))),
    );

    return { data: ingredients, count: totalCount };
  }
};
