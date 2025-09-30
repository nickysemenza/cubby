import { type Prisma, type PrismaClient } from "@prisma/client";
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
  getSortDirection,
} from "~/server/repo/database-helpers";
import { type z } from "zod";
import { ingredientBase } from "~/schemas/ingredient";

export const mergeIngredients = async (
  db: PrismaClient,
  target: string,
  aliases: string[],
) => {
  return await db.$transaction(async (tx) => {
    const targetRec = await tx.ingredient.findFirstOrThrow({
      where: { id: target },
    });
    const aliasRecs = await tx.ingredient.findMany({
      where: { id: { in: aliases } },
    });

    // update target ingredient to have new aliases
    await tx.ingredient.update({
      where: { id: target },
      data: {
        aliases: {
          set: dedupe([
            ...targetRec.aliases,
            ...aliasRecs.map((a) => a.name),
            ...aliasRecs.flatMap((a) => a.aliases ?? []),
          ]),
        },
      },
    });

    // update all recipeSectionIngredients to point to the target
    await tx.recipeSectionIngredient.updateMany({
      where: {
        ingredientId: { in: aliases },
      },
      data: {
        ingredientId: target,
      },
    });

    // delete stale
    await tx.ingredient.deleteMany({
      where: {
        id: { in: aliases },
      },
    });
  });
};

type IngredientDeepDB = Prisma.IngredientGetPayload<{
  include: {
    Product: {
      include: {
        unitMappings: true;
      };
    };
    Recipe: true;
    RecipeSectionIngredient: {
      include: {
        recipeSection: {
          include: {
            recipe: true;
          };
        };
      };
    };
  };
}>;

const ingredientInclude = {
  Product: {
    include: {
      unitMappings: true,
    },
  },
  Recipe: true,
  RecipeSectionIngredient: {
    include: {
      recipeSection: {
        include: {
          recipe: true,
        },
      },
    },
  },
};

const dbIngredientToAPI: (
  db: PrismaClient,
  ingredient: IngredientDeepDB,
) => Promise<IngredientWithRecipesAndProductOut> = async (db, ingredient) => {
  const { Product, Recipe, RecipeSectionIngredient, ...restOfIngredient } =
    ingredient;

  const productWithMappings = Product.map((product) => {
    return {
      ...product,
      unitMappings: product.unitMappings.map((mapping) => ({
        ...mapping,
        sourceMetadata: { type: "product" as const, productId: product.id },
      })),
    };
  });

  return {
    ...restOfIngredient,
    recipe: Recipe ? dbRecipeToAPIShallow(Recipe) : null,
    product: productWithMappings,
    appearsInRecipes: RecipeSectionIngredient.map((section) =>
      dbRecipeToAPIShallow(section.recipeSection.recipe),
    ),
  };
};

export const getIngredientByID = async (
  db: PrismaClient,
  id: string,
  projectId: string,
) => {
  const ingredient = await db.ingredient.findFirstOrThrow({
    where: { id: id, projectId }, // Ensure ingredient belongs to project
    include: ingredientInclude,
  });
  return await dbIngredientToAPI(db, ingredient);
};
export const getIngredientByName = async (db: PrismaClient, name: string) => {
  const res = await db.ingredient.findFirst({
    where: buildIngredientWhere(true, name),
    include: ingredientInclude,
  });
  return res ? await dbIngredientToAPI(db, res) : null;
};

export const createIngredient = async (
  db: PrismaClient,
  data: z.infer<typeof ingredientBase>,
  projectId: string,
): Promise<IngredientWithRecipesAndProductOut> => {
  const ingredient = await db.ingredient.create({
    data: {
      projectId: projectId,
      name: data.name,
      aliases: data.aliases || [],
    },
    include: ingredientInclude,
  });

  return await dbIngredientToAPI(db, ingredient);
};

export const updateIngredient = async (
  db: PrismaClient,
  id: string,
  projectId: string,
  data: Partial<z.infer<typeof ingredientBase>>,
): Promise<IngredientWithRecipesAndProductOut> => {
  const ingredient = await db.ingredient.update({
    where: { id, projectId }, // Ensure ingredient belongs to project
    data: data,
    include: ingredientInclude,
  });

  return await dbIngredientToAPI(db, ingredient);
};

export const findOrCreateIngredient = async (
  db: Prisma.TransactionClient,
  name: string,
  aliases?: string[],
  projectId?: string,
) => {
  const findOrCreate = async () => {
    const existing = await db.ingredient.findFirst({
      where: buildIngredientWhere(true, name, aliases, projectId),
    });
    if (existing !== null) {
      return existing;
    }

    return await db.ingredient.create({
      data: {
        projectId: projectId || "default-project",
        name: name,
        aliases: aliases || [],
      },
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

  return await db.ingredient.update({
    where: { id: entry.id },
    data: {
      name: name,
      aliases: {
        set: [...entry.aliases, ...aliasesToAdd],
      },
    },
  });
};

// exact:
//  true -> exact match on name or aliases
//  false -> search on name, exact match on aliases
const buildIngredientWhere = (
  exact: boolean,
  name: string,
  otherSearchNames?: string[],
  projectId?: string,
) => {
  const list = [name, ...(otherSearchNames ?? [])];
  const where: Prisma.IngredientWhereInput = {
    AND: [
      {
        OR: [
          {
            name: exact
              ? { in: list, mode: "insensitive" }
              : formatSearchTerm(name),
          },
          {
            aliases: {
              hasSome: list,
            },
          },
        ],
      },
      {
        // Filter for standalone ingredients only, not recipe ingredients
        recipeId: { equals: null },
      },
      ...(projectId ? [{ projectId: { equals: projectId } }] : []),
    ],
  };
  return where;
};
export const ingredientList = async (
  db: PrismaClient,
  projectId: string,
  name: string | undefined,
  sort: SortParams,
  pagination: PaginationParams,
  missingProductsOnly: boolean = false,
) => {
  const orderBy: Prisma.IngredientOrderByWithAggregationInput = {
    createdAt: getSortDirection(sort, "createdAt"),
    name: getSortDirection(sort, "name"),
    aliases: getSortDirection(sort, "aliases"),
  };

  let where: Prisma.IngredientWhereInput = {
    projectId, // Filter by project
    recipeId: { equals: null }, // Should only include standalone ingredients (not recipe ingredients)
  };

  // Add name filter if provided
  if (name) {
    const nameWhere = buildIngredientWhere(false, name);
    where = {
      ...where,
      ...nameWhere,
    };
  }

  // Add missing products filter if requested
  if (missingProductsOnly) {
    where = {
      ...where,
      Product: {
        none: {}, // This means no products are associated
      },
    };
  }

  // Define query parameters once to avoid duplication
  const findManyParams = {
    orderBy,
    where,
    ...buildTakeSkip(pagination),
    include: ingredientInclude,
  };

  // Execute both queries in a single transaction for better performance
  const [results, totalCount] = await db.$transaction([
    db.ingredient.findMany(findManyParams),
    db.ingredient.count({ where }),
  ]);

  // Process results after receiving both queries
  const ingredients = await Promise.all(
    results.map((ingredient) => dbIngredientToAPI(db, ingredient)),
  );

  return { data: ingredients, count: totalCount };
};
