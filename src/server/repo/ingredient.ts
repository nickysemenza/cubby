import { type Prisma, type PrismaClient } from "@prisma/client";
import { dedupe } from "~/misc/util";
import { dbRecipeToAPIShallow } from "./recipe";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "~/schemas/util";
import { type IngredientOut } from "~/schemas/combo";
import { findFood } from "./usda";
import { foodLookupParamFromProduct } from "./product";

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
) => Promise<IngredientOut> = async (db, ingredient) => {
  const { Product, Recipe, RecipeSectionIngredient, ...restOfIngredient } =
    ingredient;

  const productWithFood = await Promise.all(
    Product.map(async (product) => {
      const lookupParam = foodLookupParamFromProduct(product);
      const food = lookupParam ? await findFood(db, lookupParam) : null;
      return {
        ...product,
        food,
      };
    }),
  );

  return {
    ...restOfIngredient,
    recipe: Recipe ? dbRecipeToAPIShallow(Recipe) : null,
    product: productWithFood,
    appearsInRecipes: RecipeSectionIngredient.map((section) =>
      dbRecipeToAPIShallow(section.recipeSection.recipe),
    ),
  };
};

export const getIngredientByID = async (db: PrismaClient, id: string) => {
  const ingredient = await db.ingredient.findFirstOrThrow({
    where: { id: id },
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

export const findOrCreateIngredient = async (
  db: Prisma.TransactionClient,
  name: string,
  aliases?: string[],
) => {
  const findOrCreate = async () => {
    const existing = await db.ingredient.findFirst({
      where: buildIngredientWhere(true, name, aliases),
    });
    if (existing !== null) {
      return existing;
    }

    return await db.ingredient.create({
      data: {
        name: name,
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
) => {
  const list = [name, ...(otherSearchNames ?? [])];
  const where: Prisma.IngredientWhereInput = {
    AND: [
      {
        OR: [
          {
            name: exact
              ? { in: list, mode: "insensitive" }
              : { search: name, mode: "insensitive" },
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
    ],
  };
  return where;
};
export const ingredientList = async (
  db: PrismaClient,
  name: string | undefined,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  const orderBy: Prisma.IngredientOrderByWithAggregationInput = {
    createdAt: sort.orderBy === "createdAt" ? sort.direction : undefined,
    name: sort.orderBy === "name" ? sort.direction : undefined,
    aliases: sort.orderBy === "aliases" ? sort.direction : undefined,
  };
  const where = name ? buildIngredientWhere(false, name) : undefined;
  const res = await db.ingredient.findMany({
    orderBy,
    where,
    ...buildTakeSkip(pagination),
    include: ingredientInclude,
  });
  const totalCount = await db.ingredient.count({ where });
  const ingredients = await Promise.all(
    res.map((ingredient) => dbIngredientToAPI(db, ingredient)),
  );
  return { data: ingredients, count: totalCount };
};

// export const ingredientsMissingProducts = async (db: PrismaClient) => {};
