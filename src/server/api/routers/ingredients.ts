import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";
import { type PrismaClient, type Prisma } from "@prisma/client";
import {
  createPaginatedResponseSchema,
  buildTakeSkip,
  IDInput,
  sortPaginationCombo,
} from "../../../schemas/util";
import { type IngredientOut, ingredientOut } from "~/schemas/ingredient";
import { dbRecipeToAPIShallow } from "./recipe";
import { dedupe } from "~/util";

type IngredientDeepDB = Prisma.IngredientGetPayload<{
  include: {
    Product: true;
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
  Product: true,
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

const dbIngredientToAPI: (ingredient: IngredientDeepDB) => IngredientOut = (
  ingredient,
) => {
  const { Product, Recipe, RecipeSectionIngredient, ...restOfIngredient } =
    ingredient;

  return {
    ...restOfIngredient,
    recipe: Recipe ? dbRecipeToAPIShallow(Recipe) : null,
    product: Product,
    appearsInRecipes: RecipeSectionIngredient.map((section) =>
      dbRecipeToAPIShallow(section.recipeSection.recipe),
    ),
  };
};
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
const merge = publicProcedure
  .input(
    z.object({
      target: z.string().uuid(),
      aliases: z.array(z.string().uuid()).min(1),
    }),
  )
  .output(ingredientOut)
  .mutation(async ({ ctx, input }) => {
    await mergeIngredients(ctx.db, input.target, input.aliases);
    const res = await ctx.db.ingredient.findFirstOrThrow({
      where: {
        id: input.target,
      },
      include: ingredientInclude,
    });
    return dbIngredientToAPI(res);
  });

const getByName = publicProcedure
  .input(
    z.object({
      nameFilter: z.string(),
    }),
  )
  .output(ingredientOut.nullable())
  .query(async ({ ctx, input }) => {
    const res = await ctx.db.ingredient.findFirst({
      where: buildIngredientWhere(true, input.nameFilter),
      include: ingredientInclude,
    });
    return res ? dbIngredientToAPI(res) : null;
  });

const getByID = publicProcedure
  .input(IDInput)
  .output(ingredientOut)
  .query(async ({ ctx, input }) => {
    const res = await ctx.db.ingredient.findFirstOrThrow({
      where: {
        id: input.id,
      },
      include: ingredientInclude,
    });
    return dbIngredientToAPI(res);
  });

export const findOrCreateIngredient = async (
  db: PrismaClient | Prisma.TransactionClient,
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
export const buildIngredientWhere = (
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
        // ingredients only, not recipes? todo: check this
        recipeId: { equals: null },
      },
    ],
  };
  return where;
};

const list = publicProcedure
  .input(
    z
      .object({
        nameFilter: z.string().optional(),
      })
      .merge(sortPaginationCombo),
  )
  .output(createPaginatedResponseSchema(ingredientOut))
  .query(async ({ ctx, input }) => {
    const orderBy: Prisma.IngredientOrderByWithAggregationInput = {
      createdAt:
        input.sort.orderBy === "createdAt" ? input.sort.direction : undefined,
      name: input.sort.orderBy === "name" ? input.sort.direction : undefined,
      aliases:
        input.sort.orderBy === "aliases" ? input.sort.direction : undefined,
    };
    const where = input.nameFilter
      ? buildIngredientWhere(false, input.nameFilter)
      : undefined;
    const res = await ctx.db.ingredient.findMany({
      orderBy,
      where,
      ...buildTakeSkip(input.pagination),
      include: ingredientInclude,
    });
    const totalCount = await ctx.db.ingredient.count({ where });
    const ingredients = res.map(dbIngredientToAPI);
    return {
      meta: {
        pageIndex: input.pagination.pageIndex,
        pageSize: ingredients.length,
        totalCount,
        // totalPages: 1,
      },
      items: ingredients,
    };
  });
export const ingredientRouter = createTRPCRouter({
  getByName,
  getByID,
  list,
  merge,
});
