import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";
import { ItemType, type PrismaClient, type Prisma } from "@prisma/client";
import {
  createPaginatedResponseSchema,
  paginationParams,
  sortParams,
  buildTakeSkip,
} from "../../../schemas/util";
import { type ItemOut, itemOut } from "~/schemas/item";

type ItemDeepDB = Prisma.ItemGetPayload<{
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

const itemInclude = {
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

const dbItemToAPI: (item: ItemDeepDB) => ItemOut = (item) => {
  const { Product, Recipe, RecipeSectionIngredient, ...restOfItem } = item;

  return {
    ...restOfItem,
    recipe: Recipe,
    product: Product,
    appearsInRecipes: RecipeSectionIngredient.map(
      (section) => section.recipeSection.recipe,
    ),
  };
};

const getByName = publicProcedure
  .input(
    z.object({
      nameFilter: z.string(),
      itemTypeFilter: z.nativeEnum(ItemType).optional(),
    }),
  )
  .output(itemOut.nullable())
  .query(async ({ ctx, input }) => {
    const res = await ctx.db.item.findFirst({
      where: {
        name: { equals: input.nameFilter, mode: "insensitive" },
        type: input.itemTypeFilter,
      },
      include: itemInclude,
    });
    return res ? dbItemToAPI(res) : null;
  });

const getByID = publicProcedure
  .input(
    z.object({
      id: z.string(),
    }),
  )
  .output(itemOut)
  .query(async ({ ctx, input }) => {
    const res = await ctx.db.item.findFirstOrThrow({
      where: {
        id: input.id,
      },
      include: itemInclude,
    });
    return dbItemToAPI(res);
  });

export const findOrCreateItem = async (
  db: PrismaClient | Prisma.TransactionClient,
  name: string,
  itemType: ItemType,
) => {
  const existing = await db.item.findFirst({
    where: buildItemWhere(true, name, itemType),
  });
  if (existing !== null) {
    return existing;
  }
  const created = await db.item.create({
    data: {
      name: name,
      type: itemType,
    },
  });
  return created;
};

// exact:
//  true -> exact match on name or aliases
//  false -> search on name, exact match on aliases
export const buildItemWhere = (
  exact: boolean,
  name?: string,
  itemType?: ItemType,
) => {
  const where: Prisma.ItemWhereInput = {
    AND: [
      {
        OR: [
          {
            name:
              name != ""
                ? exact
                  ? { equals: name, mode: "insensitive" }
                  : { search: name, mode: "insensitive" }
                : undefined,
          },
          {
            aliases:
              name !== undefined
                ? {
                    has: name,
                  }
                : undefined,
          },
        ],
      },
      {
        type: itemType,
      },
    ],
  };
  return where;
};

const list = publicProcedure
  .input(
    z.object({
      sort: sortParams,
      pagination: paginationParams,
      nameFilter: z.string().optional(),
      itemTypeFilter: z.nativeEnum(ItemType).optional(),
    }),
  )
  .output(createPaginatedResponseSchema(itemOut))
  .query(async ({ ctx, input }) => {
    const orderBy: Prisma.ItemOrderByWithAggregationInput = {
      createdAt:
        input.sort.orderBy === "createdAt" ? input.sort.direction : undefined,
      name: input.sort.orderBy === "name" ? input.sort.direction : undefined,
    };
    const where = buildItemWhere(false, input.nameFilter, input.itemTypeFilter);
    const res = await ctx.db.item.findMany({
      orderBy,
      where,
      ...buildTakeSkip(input.pagination),
      include: itemInclude,
    });
    const totalCount = await ctx.db.item.count({ where });
    const items = res.map(dbItemToAPI);
    return {
      meta: {
        pageIndex: input.pagination.pageIndex,
        pageSize: items.length,
        totalCount,
        // totalPages: 1,
      },
      items,
    };
  });
export const itemRouter = createTRPCRouter({
  getByName,
  getByID,
  list,
});
